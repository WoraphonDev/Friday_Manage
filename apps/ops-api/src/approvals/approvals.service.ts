import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { limitsOf, type StaffRole } from '../auth/roles.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const HOUR = 3_600_000;

/** อนุมัติตัวเองไม่ได้เลย แม้มี Owner คนเดียว (06 › 4) */
export const NO_SELF_APPROVAL = new Set(['support.write_session', 'privacy.erase']);
/** อายุคำขอ (ชั่วโมง) ตามหน้าคืนเงินและอนุมัติ · ไม่ระบุ = 48 */
const EXPIRES_HOURS: Record<string, number> = { 'workspace.suspend': 24, 'workspace.discount': 72, 'privacy.erase': 168 };

export const ApprovalsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const DecisionBody = z.object({ note: z.string().trim().max(500).optional() }).strict();

export interface ApprovalContext {
  /** ผู้ขอ (เป็นผู้ทำรายการใน Audit log) */
  requester: Staff;
  approver: Staff;
  selfApproved: boolean;
  requestId: string;
}
type Executor = (payload: Record<string, unknown>, ctx: ApprovalContext) => Promise<unknown>;

export interface GateInput {
  kind: string;
  workspaceId?: string | null;
  target?: { type: string; id: string };
  payload: Record<string, unknown>;
  amountSatang?: number | null;
  reason: string;
  /** ทำเกินวงเงิน / ต้องอนุมัติทุกครั้ง */
  exceeds: boolean;
  /** อธิบายว่าทำไมต้องอนุมัติ (แสดงในคำขอ) */
  rule: string;
}

/**
 * คำขออนุมัติเมื่อทำเกินวงเงิน (G7 / G8 / G12)
 * service เจ้าของรายการลงทะเบียนตัวทำงานด้วย `register(kind, fn)` แล้วเรียก `gate()` ก่อนทำจริง · อนุมัติแล้ว fn ทำงานในนามผู้ขอ
 */
@Injectable()
export class ApprovalsService {
  private readonly executors = new Map<string, Executor>();

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  register(kind: string, fn: Executor) {
    this.executors.set(kind, fn);
  }

  /** Owner ที่ใช้งานอยู่และยังไม่หมดอายุ */
  async activeOwners() {
    return this.db
      .select({ id: s.staffUsers.id, email: s.staffUsers.email, name: s.staffUsers.name })
      .from(s.staffUsers)
      .where(and(sql`'owner' = any(${s.staffUsers.roles})`, eq(s.staffUsers.status, 'active'), or(isNull(s.staffUsers.expiresAt), gt(s.staffUsers.expiresAt, new Date()))));
  }

  /** ช่วงที่มีผู้อนุมัติคนเดียว: Owner อนุมัติคำขอของตัวเองได้ (ติดป้าย) */
  async singleApprover() {
    return (await this.activeOwners()).length <= 1;
  }

  /** null = ทำต่อได้เลย · มีค่า = สร้างคำขออนุมัติแล้ว ให้ตอบ 202 */
  async gate(staff: Staff, input: GateInput) {
    if (!input.exceeds) return null;
    if (!this.executors.has(input.kind)) throw new Error(`ไม่มีตัวทำงานของคำขอ ${input.kind}`);
    const [row] = await this.db
      .insert(s.approvalRequests)
      .values({
        kind: input.kind,
        workspaceId: input.workspaceId ?? null,
        targetType: input.target?.type ?? null,
        targetId: input.target?.id ?? null,
        payload: { ...input.payload, rule: input.rule },
        amountSatang: input.amountSatang ?? null,
        requestedBy: staff.id,
        reason: input.reason,
        expiresAt: new Date(Date.now() + (EXPIRES_HOURS[input.kind] ?? 48) * HOUR),
      })
      .returning();
    await staffAudit(this.db, staff, 'approval.requested', `${input.kind} · ${input.rule} · ${input.reason}`, { type: 'approval_request', id: row.id }, input.workspaceId ?? undefined);
    // แจ้ง Owner คนอื่นทางอีเมล · ส่งไม่ได้ไม่ทำให้คำขอล้ม
    for (const o of (await this.activeOwners()).filter((o) => o.id !== staff.id)) {
      try {
        await this.mail.send({ to: o.email, subject: `[Friday Ops] รออนุมัติ: ${input.kind}`, text: `${staff.name} ขออนุมัติ ${input.kind}\nเหตุผล: ${input.reason}\nกฎ: ${input.rule}\nหมดอายุ: ${row.expiresAt.toISOString()}` });
      } catch {
        /* บันทึกใน mail log แล้ว */
      }
    }
    return this.dto(row, await this.canSelfApprove(staff, row));
  }

  async list(staff: Staff, q: z.infer<typeof ApprovalsQuery>) {
    await this.expireStale();
    const owner = has(staff, 'owner');
    const rows = await this.db
      .select({ r: s.approvalRequests, requester: s.staffUsers.name })
      .from(s.approvalRequests)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.approvalRequests.requestedBy))
      // Owner เห็นทุกคำขอ · คนอื่นเห็นคำขอของตัวเอง
      .where(and(q.status ? eq(s.approvalRequests.status, q.status) : undefined, owner ? undefined : eq(s.approvalRequests.requestedBy, staff.id)))
      .orderBy(desc(s.approvalRequests.createdAt))
      .limit(q.limit);
    const single = await this.singleApprover();
    return { items: rows.map((x) => ({ ...this.dto(x.r, this.selfAllowed(staff, x.r, single)), requesterName: x.requester })), singleApprover: single };
  }

  async approve(staff: Staff, id: string, note?: string) {
    const row = await this.pending(id);
    const self = row.requestedBy === staff.id;
    if (self && !(await this.canSelfApprove(staff, row))) {
      throw new AppError(422, 'self_approval_not_allowed', NO_SELF_APPROVAL.has(row.kind) ? 'รายการนี้ต้องให้คนที่สองอนุมัติเสมอ' : 'ผู้ขออนุมัติคำขอของตัวเองไม่ได้');
    }
    // จองคำขอก่อนทำงาน กันอนุมัติซ้ำพร้อมกัน · ทำงานไม่สำเร็จแล้วคืนสถานะ
    const [claimed] = await this.db
      .update(s.approvalRequests)
      .set({ status: 'approved', decidedBy: staff.id, decidedAt: new Date(), decisionNote: note ?? null, selfApproved: self })
      .where(and(eq(s.approvalRequests.id, id), eq(s.approvalRequests.status, 'pending')))
      .returning();
    if (!claimed) throw new AppError(409, 'approval_not_pending', 'คำขอนี้ถูกตัดสินไปแล้ว');
    const requester = await this.loadStaff(row.requestedBy);
    let result: unknown;
    try {
      result = await this.executors.get(row.kind)!(row.payload as Record<string, unknown>, { requester, approver: staff, selfApproved: self, requestId: id });
    } catch (e) {
      await this.db.update(s.approvalRequests).set({ status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null, selfApproved: false }).where(eq(s.approvalRequests.id, id));
      throw e;
    }
    await staffAudit(this.db, staff, self ? 'approval.self_approved' : 'approval.approved', `${row.kind}${note ? ` · ${note}` : ''}`, { type: 'approval_request', id }, row.workspaceId ?? undefined, { approvedBy: staff.id, selfApproved: self });
    return { approval: this.dto(claimed, false), result };
  }

  async reject(staff: Staff, id: string, note?: string) {
    const row = await this.pending(id);
    if (row.requestedBy === staff.id) throw new AppError(422, 'self_decision_not_allowed', 'ยกเลิกคำขอของตัวเองแทนการไม่อนุมัติ');
    const [r] = await this.db.update(s.approvalRequests).set({ status: 'rejected', decidedBy: staff.id, decidedAt: new Date(), decisionNote: note ?? null }).where(and(eq(s.approvalRequests.id, id), eq(s.approvalRequests.status, 'pending'))).returning();
    if (!r) throw new AppError(409, 'approval_not_pending', 'คำขอนี้ถูกตัดสินไปแล้ว');
    await staffAudit(this.db, staff, 'approval.rejected', `${row.kind}${note ? ` · ${note}` : ''}`, { type: 'approval_request', id }, row.workspaceId ?? undefined);
    return { approval: this.dto(r, false) };
  }

  async cancel(staff: Staff, id: string) {
    const row = await this.pending(id);
    if (row.requestedBy !== staff.id) throw new AppError(403, 'forbidden', 'ยกเลิกได้เฉพาะคำขอของตัวเอง');
    const [r] = await this.db.update(s.approvalRequests).set({ status: 'cancelled' }).where(and(eq(s.approvalRequests.id, id), eq(s.approvalRequests.status, 'pending'))).returning();
    if (!r) throw new AppError(409, 'approval_not_pending', 'คำขอนี้ถูกตัดสินไปแล้ว');
    await staffAudit(this.db, staff, 'approval.cancelled', row.kind, { type: 'approval_request', id }, row.workspaceId ?? undefined);
    return { approval: this.dto(r, false) };
  }

  private async pending(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบคำขออนุมัติ');
    await this.expireStale();
    const [row] = await this.db.select().from(s.approvalRequests).where(eq(s.approvalRequests.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบคำขออนุมัติ');
    if (row.status !== 'pending') throw new AppError(409, 'approval_not_pending', 'คำขอนี้ถูกตัดสินไปแล้ว', { status: row.status });
    return row;
  }

  private async expireStale() {
    await this.db.update(s.approvalRequests).set({ status: 'expired' }).where(and(eq(s.approvalRequests.status, 'pending'), lt(s.approvalRequests.expiresAt, new Date())));
  }

  private selfAllowed(staff: Staff, row: typeof s.approvalRequests.$inferSelect, single: boolean) {
    return row.requestedBy === staff.id && has(staff, 'owner') && single && !NO_SELF_APPROVAL.has(row.kind) && row.status === 'pending';
  }

  private async canSelfApprove(staff: Staff, row: typeof s.approvalRequests.$inferSelect) {
    return this.selfAllowed(staff, row, await this.singleApprover());
  }

  private async loadStaff(id: string): Promise<Staff> {
    const [r] = await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id));
    return { id: r.id, email: r.email, name: r.name, roles: r.roles as StaffRole[], elevated: [], department: r.department, limits: limitsOf(r.limits) };
  }

  private dto(r: typeof s.approvalRequests.$inferSelect, canSelfApprove: boolean) {
    return {
      id: r.id,
      kind: r.kind,
      workspaceId: r.workspaceId,
      target: r.targetType ? { type: r.targetType, id: r.targetId } : null,
      payload: r.payload,
      amountSatang: r.amountSatang,
      requestedBy: r.requestedBy,
      reason: r.reason,
      status: r.status,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      selfApproved: r.selfApproved,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      canSelfApprove,
    };
  }
}
