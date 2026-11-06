import { CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Db, schema } from '@friday/db';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { verify } from './tokens.js';

export type StaffRole = 'admin' | 'support' | 'finance';
export interface Staff {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
}
export type OpsRequest = Request & { staff?: Staff };

export const PUBLIC = 'ops:public';
export const ROLES = 'ops:roles';
/** ไม่ต้องล็อกอิน (เฉพาะขั้นตอน WebAuthn) */
export const Public = () => SetMetadata(PUBLIC, true);
/** จำกัดตามบทบาท · `admin` ผ่านทุกข้อ · ไม่ระบุ = ทีมที่ล็อกอินแล้วทุกคน */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES, roles);

export const SESSION_PURPOSE = 'ops-session';

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
    if (!session) throw new AppError(401, 'unauthorized', 'ต้องเข้าสู่ระบบด้วย Security key');
    // ตรวจกับฐานข้อมูลทุกครั้ง: ถอดสิทธิ์ / ลบพนักงานแล้วใช้ session เดิมต่อไม่ได้
    const [row] = await this.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, session.sid));
    if (!row) throw new AppError(401, 'unauthorized', 'ต้องเข้าสู่ระบบด้วย Security key');
    const staff: Staff = { id: row.id, email: row.email, name: row.name, role: row.role as StaffRole };
    req.staff = staff;

    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles && staff.role !== 'admin' && !roles.includes(staff.role)) throw new AppError(403, 'forbidden', 'ไม่มีสิทธิ์ทำรายการนี้', { role: staff.role, need: roles });
    return true;
  }
}
