import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, gt, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { staffAudit } from '../audit.js';
import { has, type Staff, type StaffRole } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { PageQuery } from '../paging.js';
import { PushService } from '../push/push.service.js';

const s = schema;
const MINUTE = 60_000;
/** ระยะเวลาที่ขอได้ (นาที) · สูงสุด 8 ชม. (storyboard ขั้น 1) */
export const JIT_MINUTES = [30, 60, 240, 480] as const;
/** ขอได้ทุกบทบาทยกเว้น Owner */
const REQUESTABLE = ['finance', 'support', 'engineer', 'auditor'] as const;
const WARN_MIN = 5;
export const KIND = 'staff.elevate';

export const RequestBody = z
  .object({
    role: z.enum(REQUESTABLE),
    minutes: z.union(JIT_MINUTES.map((m) => z.literal(m)) as [z.ZodLiteral<30>, z.ZodLiteral<60>, z.ZodLiteral<240>, z.ZodLiteral<480>]),
    reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500),
    ticketRef: z.string().trim().max(40).optional(),
  })
  .strict();
export const HistoryQuery = PageQuery.extend({ q: z.string().trim().max(100).optional(), tab: z.enum(['active', 'history']).default('active') });
type Req = z.infer<typeof RequestBody>;

/**
 * ขอสิทธิ์ชั่วคราว (O52 · เฟส 3) · พนักงานขอบทบาทที่ไม่มี → Owner อนุมัติผ่านระบบอนุมัติเดิม (ชนิด staff.elevate · หมดอายุ 1 ชม.)
 * อนุมัติแล้วสร้าง staff_elevations (kind = approved) ที่ AuthGuard อ่านอยู่แล้ว · ทุกบรรทัดใน Audit log ระหว่างนั้นติด elevation_id
 * สิทธิ์ฉุกเฉินของ Owner (break_glass) ยังเป็น staff/me/elevations เดิม แต่ประวัติแสดงในหน้านี้ด้วย
 */
@Injectable()
export class JitService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsJit');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    this.approvals.register(KIND, (p, ctx) => this.grant(p as unknown as Req, ctx));
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.warnEnding().catch((e) => this.log.error(String(e))), MINUTE);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  private async assertCanHave(staffId: string, role: StaffRole) {
    const [u] = await this.db.select({ roles: s.staffUsers.roles, status: s.staffUsers.status }).from(s.staffUsers).where(eq(s.staffUsers.id, staffId));
    if (!u || u.status !== 'active') throw new AppError(409, 'staff_inactive', 'บัญชีพนักงานนี้ไม่ได้ใช้งานอยู่');
    if (u.roles.includes(role)) throw new AppError(409, 'role_already_held', 'มีบทบาทนี้อยู่แล้ว');
    const [open] = await this.db
      .select({ id: s.staffElevations.id })
      .from(s.staffElevations)
      .where(and(eq(s.staffElevations.staffId, staffId), eq(s.staffElevations.role, role), isNull(s.staffElevations.endedAt), gt(s.staffElevations.endsAt, new Date())));
    if (open) throw new AppError(409, 'already_elevated', 'เปิดบทบาทนี้ชั่วคราวอยู่แล้ว');
  }

  /** ขอสิทธิ์: Owner ใช้สิทธิ์ฉุกเฉินแทน (ไม่ต้องรอใคร) · ขอซ้ำบทบาทที่รออนุมัติอยู่ไม่ได้ */
  async request(staff: Staff, input: Req) {
    if (staff.roles.includes('owner')) throw new AppError(422, 'use_break_glass', 'Owner เปิดสิทธิ์ฉุกเฉินให้ตัวเองได้เลย ไม่ต้องขออนุมัติ');
    await this.assertCanHave(staff.id, input.role);
    const [dup] = await this.db
      .select({ id: s.approvalRequests.id })
      .from(s.approvalRequests)
      .where(and(eq(s.approvalRequests.kind, KIND), eq(s.approvalRequests.status, 'pending'), eq(s.approvalRequests.requestedBy, staff.id), gt(s.approvalRequests.expiresAt, new Date()), sql`${s.approvalRequests.payload}->>'role' = ${input.role}`));
    if (dup) throw new AppError(409, 'request_pending', 'มีคำขอบทบาทนี้รออนุมัติอยู่แล้ว');
    const hours = input.minutes >= 60 ? `${input.minutes / 60} ชม.` : `${input.minutes} นาที`;
    const pending = await this.approvals.gate(staff, {
      kind: KIND,
      target: { type: 'staff', id: staff.id },
      payload: { ...input },
      reason: input.reason,
      exceeds: true,
      rule: `${staff.name} ขอบทบาท ${input.role} ${hours}${input.ticketRef ? ` · Ticket ${input.ticketRef}` : ''}`,
    });
    return { pendingApproval: pending! };
  }

  /** อนุมัติแล้ว: เริ่มนับเวลาตอนอนุมัติ (ไม่ใช่ตอนขอ) · ตรวจซ้ำเผื่อได้บทบาทไปแล้วระหว่างรอ */
  private async grant(input: Req, ctx: ApprovalContext) {
    await this.assertCanHave(ctx.requester.id, input.role);
    const now = new Date();
    const [row] = await this.db
      .insert(s.staffElevations)
      .values({ staffId: ctx.requester.id, role: input.role, reason: input.reason, startedAt: now, endsAt: new Date(now.getTime() + input.minutes * MINUTE), kind: 'approved', approvalRequestId: ctx.requestId, ticketRef: input.ticketRef ?? null })
      .returning();
    await staffAudit(this.db, { ...ctx.requester, elevationId: row.id }, 'staff.elevated', `ได้สิทธิ์ ${input.role} ชั่วคราว ${input.minutes} นาที · ${input.reason}`, { type: 'staff_elevation', id: row.id }, undefined, { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved });
    await this.push.toStaff([ctx.requester.id], { title: `ได้รับสิทธิ์ ${input.role} ชั่วคราวแล้ว`, body: `อนุมัติโดย ${ctx.approver.name} · หมดเวลา ${row.endsAt.toISOString().slice(11, 16)} UTC`, url: '/jit', tag: `jit-${row.id}` }).catch(() => 0);
    return { elevation: { id: row.id, role: row.role, endsAt: row.endsAt } };
  }

  /** เหลือ 5 นาทีแจ้งผู้ใช้สิทธิ์ครั้งเดียว (หน้าเว็บนับถอยหลังเองด้วย) */
  async warnEnding(now = new Date()) {
    const due = await this.db
      .select({ id: s.staffElevations.id, staffId: s.staffElevations.staffId, role: s.staffElevations.role })
      .from(s.staffElevations)
      .where(and(isNull(s.staffElevations.endedAt), isNull(s.staffElevations.warnedAt), gt(s.staffElevations.endsAt, now), lt(s.staffElevations.endsAt, new Date(now.getTime() + WARN_MIN * MINUTE))));
    for (const e of due) {
      await this.push.toStaff([e.staffId], { title: `สิทธิ์ ${e.role} ชั่วคราวเหลือ ${WARN_MIN} นาที`, body: 'ขอใหม่ได้จากหน้าขอสิทธิ์ชั่วคราว', url: '/jit', tag: `jit-${e.id}` }).catch(() => 0);
      await this.db.update(s.staffElevations).set({ warnedAt: now }).where(eq(s.staffElevations.id, e.id));
    }
    return due.length;
  }

  /** ของฉัน: สิทธิ์ที่เปิดอยู่ + คำขอที่รอ (ใช้ทำแถบนับถอยหลังทุกหน้า) */
  async mine(staff: Staff) {
    const active = await this.rows<Record<string, unknown>>(sql`
      select e.id, e.role, e.kind, e.started_at as "startedAt", e.ends_at as "endsAt", e.ticket_ref as "ticketRef", ap.name as "approvedBy"
      from staff_elevations e left join approval_requests r on r.id = e.approval_request_id left join staff_users ap on ap.id = r.decided_by
      where e.staff_id = ${staff.id} and e.ended_at is null and e.ends_at > now() order by e.ends_at`);
    const pending = await this.rows<Record<string, unknown>>(sql`
      select r.id, r.payload->>'role' as role, (r.payload->>'minutes')::int as minutes, r.payload->>'ticketRef' as "ticketRef", r.reason, r.created_at as "createdAt", r.expires_at as "expiresAt"
      from approval_requests r where r.kind = ${KIND} and r.status = 'pending' and r.expires_at > now() and r.requested_by = ${staff.id} order by r.created_at`);
    return { active, pending };
  }

  /** หน้า: คำขอที่รอ (Owner อนุมัติ) + ตัวเลข 30 วัน (Owner / ผู้ตรวจ) */
  async overview(staff: Staff) {
    const team = has(staff, 'owner', 'auditor');
    const pending = team
      ? await this.rows<Record<string, unknown>>(sql`
        select r.id, r.payload->>'role' as role, (r.payload->>'minutes')::int as minutes, r.payload->>'ticketRef' as "ticketRef", r.reason, r.created_at as "createdAt", r.expires_at as "expiresAt",
          st.id as "staffId", st.name as "staffName", st.roles as "staffRoles"
        from approval_requests r join staff_users st on st.id = r.requested_by
        where r.kind = ${KIND} and r.status = 'pending' and r.expires_at > now() order by r.created_at`)
      : [];
    const [stats] = team
      ? await this.rows<{ requested: number; approved: number; rejected: number; waitMin: number | null; active: number }>(sql`
        select count(*)::int as requested, count(*) filter (where status = 'approved')::int as approved, count(*) filter (where status = 'rejected')::int as rejected,
          round(avg(extract(epoch from decided_at - created_at) / 60) filter (where status = 'approved'))::int as "waitMin",
          (select count(*)::int from staff_elevations where ended_at is null and ends_at > now()) as active
        from approval_requests where kind = ${KIND} and created_at > now() - interval '30 days'`)
      : [null];
    return { mine: await this.mine(staff), pending, stats, canApprove: has(staff, 'owner'), singleApprover: await this.approvals.singleApprover() };
  }

  /** ตารางเปิดอยู่ / ประวัติ (รวมสิทธิ์ฉุกเฉินของ Owner) · คนทั่วไปเห็นของตัวเอง · Owner / ผู้ตรวจเห็นทุกคน */
  async list(staff: Staff, q: z.infer<typeof HistoryQuery>) {
    const where: SQL[] = [q.tab === 'active' ? sql`e.ended_at is null and e.ends_at > now()` : sql`(e.ended_at is not null or e.ends_at <= now())`];
    if (!has(staff, 'owner', 'auditor')) where.push(sql`e.staff_id = ${staff.id}`);
    if (q.q) where.push(sql`lower(st.name) like ${`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`).toLowerCase()}%`}`);
    const cond = sql.join(where, sql` and `);
    const items = await this.rows<Record<string, unknown>>(sql`
      select e.id, e.role, e.kind, e.reason, e.ticket_ref as "ticketRef", e.started_at as "startedAt", e.ends_at as "endsAt", e.ended_at as "endedAt",
        st.id as "staffId", st.name as "staffName", ap.name as "approvedBy", en.name as "endedBy", e.approval_request_id as "requestId",
        (select count(*)::int from staff_audit_logs a where a.elevation_id = e.id) as actions
      from staff_elevations e join staff_users st on st.id = e.staff_id
      left join approval_requests r on r.id = e.approval_request_id left join staff_users ap on ap.id = r.decided_by left join staff_users en on en.id = e.ended_by
      where ${cond} order by ${q.tab === 'active' ? sql`e.ends_at` : sql`e.started_at desc`} limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from staff_elevations e join staff_users st on st.id = e.staff_id where ${cond}`);
    return { items, total: n };
  }
}
