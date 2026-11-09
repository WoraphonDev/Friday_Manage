import { CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Db, schema } from '@friday/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { limitsOf, type Limits, type StaffRole } from './roles.js';
import { verify } from './tokens.js';

export type { StaffRole } from './roles.js';
export interface Staff {
  id: string;
  email: string;
  name: string;
  /** บทบาทที่ได้รับ */
  roles: StaffRole[];
  /** บทบาทที่เปิดชั่วคราวด้วยสิทธิ์ฉุกเฉิน (ยังไม่หมดเวลา) */
  elevated: StaffRole[];
  department: string | null;
  limits: Limits;
}
export type OpsRequest = Request & { staff?: Staff; reauthed?: boolean };

/** มีบทบาทใดบทบาทหนึ่ง (นับสิทธิ์ฉุกเฉินด้วย) */
export const has = (staff: Staff, ...roles: StaffRole[]) => roles.some((r) => staff.roles.includes(r) || staff.elevated.includes(r));
export const effectiveRoles = (staff: Staff) => [...new Set([...staff.roles, ...staff.elevated])];

export const PUBLIC = 'ops:public';
export const ROLES = 'ops:roles';
export const REAUTH = 'ops:reauth';
/** ไม่ต้องล็อกอิน (เฉพาะขั้นตอน WebAuthn) */
export const Public = () => SetMetadata(PUBLIC, true);
/**
 * จำกัดตามบทบาท · ผ่านเมื่อมีบทบาทใดบทบาทหนึ่ง · ไม่มี role ไหนผ่านทุกข้ออัตโนมัติ (Owner ก็ต้องมีบทบาทนั้น)
 * ไม่ใส่ decorator = พนักงานที่ล็อกอินแล้วทุกคน · `@Roles()` ว่าง = เฉพาะ Owner
 */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES, roles);
/** ต้องยืนยันตัวตนซ้ำด้วย Security key ภายใน 15 นาที (G4) */
export const Reauth = () => SetMetadata(REAUTH, true);

export const SESSION_PURPOSE = 'ops-session';
export const REAUTH_PURPOSE = 'ops-reauth';
export const REAUTH_COOKIE = 'fm_ops_re';
export const REAUTH_SECONDS = 15 * 60;

/** ยืนยันตัวตนซ้ำยังไม่หมดอายุ และเป็นของพนักงานคนนี้ */
export const reauthFresh = (req: OpsRequest, staffId: string) =>
  verify<{ sid: string }>(REAUTH_PURPOSE, (req.cookies as Record<string, string> | undefined)?.[REAUTH_COOKIE])?.sid === staffId;

/** ตรวจ session ของทีม Friday ทุกคำขอ (global) + กัน CSRF ด้วย SameSite=Strict และตรวจ Origin ของคำขอที่เขียน */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(OPS_DB) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<OpsRequest>();
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = req.headers.origin;
    if (write && origin && origin !== config.origin) throw new AppError(403, 'bad_origin', 'Origin ไม่ได้รับอนุญาต');

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const token = (req.cookies as Record<string, string> | undefined)?.[config.cookie];
    const session = verify<{ sid: string }>(SESSION_PURPOSE, token);
    const unauthorized = () => new AppError(401, 'unauthorized', 'ต้องเข้าสู่ระบบด้วย Security key');
    if (!session) throw unauthorized();
    // ตรวจกับฐานข้อมูลทุกครั้ง: ถอดสิทธิ์ / ระงับ / ปิดบัญชีแล้วใช้ session เดิมต่อไม่ได้
    const [row] = await this.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, session.sid));
    if (!row || row.status !== 'active' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw unauthorized();
    const elevations = await this.db
      .select({ role: schema.staffElevations.role })
      .from(schema.staffElevations)
      .where(and(eq(schema.staffElevations.staffId, row.id), isNull(schema.staffElevations.endedAt), gt(schema.staffElevations.endsAt, new Date())));
    const staff: Staff = {
      id: row.id,
      email: row.email,
      name: row.name,
      roles: row.roles as StaffRole[],
      elevated: elevations.map((e) => e.role as StaffRole),
      department: row.department,
      limits: limitsOf(row.limits),
    };
    req.staff = staff;
    req.reauthed = reauthFresh(req, staff.id);

    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    const need = roles && roles.length === 0 ? (['owner'] as StaffRole[]) : roles;
    if (need && !has(staff, ...need)) throw new AppError(403, 'forbidden', 'ไม่มีสิทธิ์ทำรายการนี้', { roles: staff.roles, need });
    if (this.reflector.getAllAndOverride<boolean>(REAUTH, [ctx.getHandler(), ctx.getClass()]) && !req.reauthed) {
      throw new AppError(401, 'reauth_required', 'แตะ Security key เพื่อยืนยันตัวตนอีกครั้ง');
    }
    return true;
  }
}
