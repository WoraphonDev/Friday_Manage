import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { signEnrollToken, type StoredCredential } from '../auth/auth.service.js';
import { LimitsBody, limitsOf, StaffRoleEnum, type StaffRole } from '../auth/roles.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const roles = z.array(StaffRoleEnum).min(1, 'ต้องมีอย่างน้อย 1 บทบาท').transform((r) => [...new Set(r)]);
const reason = z.string().trim().min(3, 'ระบุเหตุผล').max(300);

export const InviteBody = z.object({ email: z.email(), name: z.string().trim().min(1).max(80), roles, department: z.string().trim().max(60).nullish(), expiresAt: z.iso.datetime({ offset: true }).nullish() }).strict();
export const UpdateStaffBody = z.object({ roles: roles.optional(), department: z.string().trim().max(60).nullish(), limits: LimitsBody.nullish(), expiresAt: z.iso.datetime({ offset: true }).nullish(), reason }).strict();
export const StatusBody = z.object({ status: z.enum(['active', 'suspended', 'disabled']), reason }).strict();
export const ElevateBody = z.object({ role: StaffRoleEnum, minutes: z.union([z.literal(30), z.literal(60)]), reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(300) }).strict();
export const AuditQuery = z.object({
  staffId: z.uuid().optional(),
  action: z.string().trim().max(60).optional(),
  selfApproved: z.enum(['true', 'false']).optional(),
  workspaceId: z.uuid().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** พนักงานทีม Friday (หน้า 8, A1, A2, A12) · จัดการได้เฉพาะ Owner · ทุกการเปลี่ยนลง staff_audit_logs */
@Injectable()
export class StaffService {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly approvals: ApprovalsService,
  ) {}

  async list() {
    const rows = await this.db.select().from(s.staffUsers).orderBy(s.staffUsers.createdAt);
    const elevations = await this.db.select().from(s.staffElevations).where(and(isNull(s.staffElevations.endedAt), gt(s.staffElevations.endsAt, new Date())));
    return {
      items: rows.map((r) => ({ ...this.dto(r), elevations: elevations.filter((e) => e.staffId === r.id).map((e) => ({ id: e.id, role: e.role, endsAt: e.endsAt })) })),
      singleApprover: await this.approvals.singleApprover(),
    };
  }

  async invite(owner: Staff, reauthed: boolean, input: z.infer<typeof InviteBody>) {
    if (input.roles.includes('owner') && !reauthed) throw new AppError(401, 'reauth_required', 'เพิ่มบทบาท Owner ต้องแตะ Security key อีกครั้ง');
    const [dup] = await this.db.select({ id: s.staffUsers.id }).from(s.staffUsers).where(sql`lower(${s.staffUsers.email}) = ${input.email.toLowerCase()}`);
    if (dup) throw new AppError(409, 'staff_exists', 'อีเมลนี้เป็นพนักงานอยู่แล้ว');
    const [row] = await this.db
      .insert(s.staffUsers)
      .values({ email: input.email, name: input.name, roles: input.roles, department: input.department ?? null, status: 'invited', expiresAt: input.expiresAt ? new Date(input.expiresAt) : null })
      .returning();
    const enrollUrl = this.enrollUrl(row.id);
    await staffAudit(this.db, owner, 'staff.invited', `${input.email} · ${input.roles.join(', ')}`, { type: 'staff', id: row.id });
    try {
      await this.mail.send({ to: input.email, subject: 'เชิญเข้าใช้ Friday Ops', text: `${owner.name} เชิญคุณเข้าใช้ Friday Ops\nลงทะเบียน Security key 2 อันภายใน 1 ชั่วโมงที่ ${enrollUrl}` });
    } catch {
      /* Owner ส่งลิงก์ให้เองได้จาก enrollUrl */
    }
    return { staff: this.dto(row), enrollUrl };
  }

  async update(owner: Staff, reauthed: boolean, id: string, input: z.infer<typeof UpdateStaffBody>) {
    const row = await this.get(id);
    const wasOwner = row.roles.includes('owner');
    const nextRoles = input.roles ?? (row.roles as StaffRole[]);
    if (!wasOwner && nextRoles.includes('owner') && !reauthed) throw new AppError(401, 'reauth_required', 'เพิ่มบทบาท Owner ต้องแตะ Security key อีกครั้ง');
    if (wasOwner && !nextRoles.includes('owner')) await this.keepOneOwner(id);
    const patch: Partial<typeof s.staffUsers.$inferInsert> = { roles: nextRoles, updatedAt: new Date() };
    if (input.department !== undefined) patch.department = input.department;
    if (input.limits !== undefined) patch.limits = input.limits;
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const [r] = await this.db.update(s.staffUsers).set(patch).where(eq(s.staffUsers.id, id)).returning();
    const changes = [
      input.roles ? `บทบาท ${row.roles.join(', ')} → ${nextRoles.join(', ')}` : null,
      input.department !== undefined ? `แผนก ${row.department ?? '-'} → ${input.department ?? '-'}` : null,
      input.limits !== undefined ? 'วงเงิน' : null,
      input.expiresAt !== undefined ? 'วันหมดอายุ' : null,
    ].filter(Boolean);
    await staffAudit(this.db, owner, 'staff.updated', `${row.email} · ${changes.join(' · ')} · ${input.reason}`, { type: 'staff', id });
    return { staff: this.dto(r) };
  }

  async setStatus(owner: Staff, id: string, input: z.infer<typeof StatusBody>) {
    const row = await this.get(id);
    if (id === owner.id) throw new AppError(422, 'cannot_change_self', 'เปลี่ยนสถานะบัญชีของตัวเองไม่ได้');
    if (row.status === 'disabled') throw new AppError(409, 'staff_disabled', 'บัญชีนี้ถูกปิดแล้ว เปิดใหม่ไม่ได้ ให้เชิญใหม่');
    if (row.status === input.status) throw new AppError(409, 'no_change', 'สถานะเดิมอยู่แล้ว');
    if (input.status !== 'active' && row.roles.includes('owner')) await this.keepOneOwner(id);
    const [r] = await this.db.update(s.staffUsers).set({ status: input.status, updatedAt: new Date() }).where(eq(s.staffUsers.id, id)).returning();
    if (input.status !== 'active') await this.db.update(s.staffElevations).set({ endedAt: new Date(), endedBy: owner.id }).where(and(eq(s.staffElevations.staffId, id), isNull(s.staffElevations.endedAt)));
    await staffAudit(this.db, owner, `staff.${input.status === 'active' ? 'reactivated' : input.status}`, `${row.email} · ${input.reason}`, { type: 'staff', id });
    return { staff: this.dto(r) };
  }

  /** ลิงก์ลงทะเบียนกุญแจใหม่ (กุญแจหาย) */
  async enrollLink(owner: Staff, id: string) {
    const row = await this.get(id);
    if (row.status === 'disabled') throw new AppError(409, 'staff_disabled', 'บัญชีนี้ถูกปิดแล้ว');
    await staffAudit(this.db, owner, 'staff.enroll_link', row.email, { type: 'staff', id });
    return { enrollUrl: this.enrollUrl(id) };
  }

  async removeKey(owner: Staff, id: string, credentialId: string) {
    const row = await this.get(id);
    const creds = (row.webauthnCredentials ?? []) as StoredCredential[];
    const key = creds.find((c) => c.id === credentialId);
    if (!key) throw new AppError(404, 'not_found', 'ไม่พบ Security key');
    if (creds.length === 1 && row.status === 'active') throw new AppError(422, 'last_key', 'ต้องเหลือ Security key อย่างน้อย 1 อัน · ออกลิงก์ลงทะเบียนใหม่ก่อน');
    await this.db.update(s.staffUsers).set({ webauthnCredentials: creds.filter((c) => c.id !== credentialId), updatedAt: new Date() }).where(eq(s.staffUsers.id, id));
    await staffAudit(this.db, owner, 'staff.key_removed', `${row.email} · ${key.name}`, { type: 'staff', id });
    return { keys: creds.length - 1 };
  }

  /** สิทธิ์ฉุกเฉิน (A12): Owner เปิดบทบาทที่ไม่มีให้ตัวเองชั่วคราว */
  async elevate(owner: Staff, input: z.infer<typeof ElevateBody>) {
    if (owner.roles.includes(input.role)) throw new AppError(409, 'role_already_held', 'มีบทบาทนี้อยู่แล้ว');
    if (owner.elevated.includes(input.role)) throw new AppError(409, 'already_elevated', 'เปิดบทบาทนี้ชั่วคราวอยู่แล้ว');
    const now = new Date();
    const [row] = await this.db.insert(s.staffElevations).values({ staffId: owner.id, role: input.role, reason: input.reason, startedAt: now, endsAt: new Date(now.getTime() + input.minutes * 60_000) }).returning();
    await staffAudit(this.db, owner, 'staff.elevated', `เปิดบทบาท ${input.role} ${input.minutes} นาที · ${input.reason}`, { type: 'staff_elevation', id: row.id });
    // แจ้ง Owner และผู้ตรวจทุกคน (รวมตัวเอง เพื่อให้มีรอยนอกระบบ)
    const watchers = await this.db.select({ email: s.staffUsers.email }).from(s.staffUsers).where(and(eq(s.staffUsers.status, 'active'), sql`${s.staffUsers.roles} && array['owner','auditor']::text[]`));
    for (const w of watchers) {
      try {
        await this.mail.send({ to: w.email, subject: `[Friday Ops] เปิดสิทธิ์ฉุกเฉิน: ${owner.name} · ${input.role}`, text: `${owner.name} เปิดบทบาท ${input.role} ${input.minutes} นาที\nเหตุผล: ${input.reason}\nสิ้นสุด: ${row.endsAt.toISOString()}` });
      } catch {
        /* มีรอยใน staff_audit_logs แล้ว */
      }
    }
    return { elevation: { id: row.id, role: row.role, startedAt: row.startedAt, endsAt: row.endsAt } };
  }

  async endElevation(staff: Staff, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบสิทธิ์ฉุกเฉิน');
    const [row] = await this.db.select().from(s.staffElevations).where(eq(s.staffElevations.id, id));
    if (!row || (row.staffId !== staff.id && !has(staff, 'owner'))) throw new AppError(404, 'not_found', 'ไม่พบสิทธิ์ฉุกเฉิน');
    if (row.endedAt || row.endsAt.getTime() <= Date.now()) throw new AppError(409, 'elevation_ended', 'สิทธิ์ฉุกเฉินนี้สิ้นสุดแล้ว');
    await this.db.update(s.staffElevations).set({ endedAt: new Date(), endedBy: staff.id }).where(eq(s.staffElevations.id, id));
    await staffAudit(this.db, staff, 'staff.elevation_ended', row.role, { type: 'staff_elevation', id });
    return { ended: true };
  }

  /** Audit log ของทีม Friday (หน้า 8) · ใหม่ไปเก่า · แบ่งหน้าด้วย `before` */
  async auditLog(q: z.infer<typeof AuditQuery>) {
    const rows = await this.db
      .select({ a: s.staffAuditLogs, name: s.staffUsers.name })
      .from(s.staffAuditLogs)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.staffAuditLogs.staffId))
      .where(
        and(
          q.staffId ? eq(s.staffAuditLogs.staffId, q.staffId) : undefined,
          q.action ? sql`${s.staffAuditLogs.action} like ${`${q.action.replace(/[%_]/g, '')}%`}` : undefined,
          q.selfApproved ? eq(s.staffAuditLogs.selfApproved, q.selfApproved === 'true') : undefined,
          q.workspaceId ? eq(s.staffAuditLogs.workspaceId, q.workspaceId) : undefined,
          q.before ? lt(s.staffAuditLogs.createdAt, new Date(q.before)) : undefined,
        ),
      )
      .orderBy(desc(s.staffAuditLogs.createdAt))
      .limit(q.limit);
    return { items: rows.map((r) => ({ ...r.a, staffName: r.name ?? 'ระบบ' })) };
  }

  private enrollUrl(id: string) {
    return `${config.origin}/enroll?token=${encodeURIComponent(signEnrollToken(id))}`;
  }

  private async get(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    const [row] = await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบพนักงาน');
    return row;
  }

  /** ต้องเหลือ Owner ที่ใช้งานได้อย่างน้อย 1 คนเสมอ */
  private async keepOneOwner(leavingId: string) {
    const owners = await this.approvals.activeOwners();
    if (owners.filter((o) => o.id !== leavingId).length === 0) throw new AppError(409, 'last_owner', 'ต้องมี Owner อย่างน้อย 1 คน');
  }

  private dto(r: typeof s.staffUsers.$inferSelect) {
    const creds = (r.webauthnCredentials ?? []) as StoredCredential[];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      roles: r.roles,
      department: r.department,
      limits: limitsOf(r.limits),
      customLimits: r.limits,
      status: r.status,
      expiresAt: r.expiresAt,
      keys: creds.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null })),
      createdAt: r.createdAt,
    };
  }
}
