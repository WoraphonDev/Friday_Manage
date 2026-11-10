import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const DAY = 86_400_000;
const HOUR = 3_600_000;
type Row = Record<string, unknown>;
/** PDPA: ตอบคำขอภายใน 30 วัน · แจ้ง สคส. ภายใน 72 ชม. */
export const DUE_DAYS = 30;
export const BREACH_HOURS = 72;
const ERASED_NAME = 'ผู้ใช้ที่ถูกลบ';
const TYPE_LABEL: Record<string, string> = { access: 'ขอดูข้อมูล', export: 'ขอสำเนาข้อมูล', rectify: 'ขอแก้ไขข้อมูล', erase: 'ขอลบข้อมูล', object: 'คัดค้านการใช้ข้อมูล', restrict: 'ขอระงับการใช้ข้อมูล' };
const STEPS = ['รับคำขอ', 'ยืนยันตัวตน', 'ตรวจขอบเขต', 'ดำเนินการ', 'แจ้งผล'] as const;

export const RequestsQuery = z.object({ status: z.enum(['open', 'completed', 'rejected', 'all']).default('open') });
export const CreateRequestBody = z
  .object({
    requestType: z.enum(schema.PRIVACY_REQUEST_TYPES),
    requesterEmail: z.email().trim().toLowerCase().max(254),
    /** วันที่ได้รับ (เริ่มนับ 30 วัน) · ไม่ระบุ = วันนี้ */
    receivedAt: z.iso.date().optional(),
    /** ขอบเขต · ไม่ระบุ = ทุก Workspace ที่เป็นสมาชิก */
    workspaceIds: z.array(z.uuid()).max(50).default([]),
    identity: z.enum(['unverified', 'email_match', 'link_confirmed']).default('unverified'),
    details: z.string().trim().max(5000).optional(),
    acknowledge: z.boolean().default(true),
  })
  .strict();
export const VerifyBody = z.object({ method: z.enum(['email_match', 'link_confirmed']), note: z.string().trim().max(500).optional() }).strict();
export const AdvanceBody = z.object({ note: z.string().trim().min(3).max(2000), message: z.string().trim().max(5000).optional() }).strict();
export const RejectBody = z.object({ legalBasis: z.string().trim().min(5).max(500), message: z.string().trim().min(5).max(5000) }).strict();
export const EraseBody = z.object({ confirm: z.literal('ลบข้อมูล', { message: 'พิมพ์ "ลบข้อมูล" เพื่อยืนยัน' }), reason: z.string().trim().min(5).max(500) }).strict();
export const BreachBody = z
  .object({
    discoveredAt: z.iso.datetime({ offset: true }),
    description: z.string().trim().min(10).max(5000),
    dataTypes: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
    affectedCount: z.number().int().min(0).optional(),
    workspaceIds: z.array(z.uuid()).max(100).default([]),
    risk: z.enum(['low', 'medium', 'high']).default('medium'),
    containment: z.string().trim().max(2000).optional(),
    containedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export const BreachPatchBody = z
  .object({
    risk: z.enum(['low', 'medium', 'high']).optional(),
    assessment: z.string().trim().max(5000).optional(),
    containment: z.string().trim().max(2000).optional(),
    containedAt: z.iso.datetime({ offset: true }).optional(),
    affectedCount: z.number().int().min(0).optional(),
    note: z.string().trim().min(3).max(1000),
  })
  .strict();
export const BreachMarkBody = z.object({ note: z.string().trim().min(3).max(1000), notifyOwners: z.boolean().default(false) }).strict();

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const todayBkk = () => new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 10);

/**
 * คำขอ PDPA ที่ส่งถึงทีม Friday และเหตุละเมิดข้อมูล (O05 · หน้า Privacy · A3–A6)
 * ประวัติทุกขั้นเขียน staff_audit_logs (แก้ / ลบไม่ได้) · การลบตามคำขอต้องมีคนที่สองอนุมัติเสมอ (NO_SELF_APPROVAL)
 */
@Injectable()
export class PrivacyService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.register('privacy.erase', (p, ctx) => this.applyErase(ctx.requester, p.requestId as string, ctx));
  }

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }
  private async email(to: string, subject: string, text: string) {
    try {
      await this.mail.send({ to, subject, text });
      return true;
    } catch {
      return false;
    }
  }
  private log(staff: Staff, action: string, text: string, target: { type: string; id: string }, ctx?: ApprovalContext) {
    return staffAudit(this.db, staff, action, text, target, undefined, ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);
  }

  // ---------------------------------------------------------------- คำขอจากเจ้าของข้อมูล

  private dto(r: typeof s.privacyRequests.$inferSelect) {
    // นับเป็นวันตามปฏิทินไทย: วันครบกำหนด − วันนี้
    const daysLeft = Math.round((Date.parse(`${r.dueDate}T00:00:00Z`) - Date.parse(`${todayBkk()}T00:00:00Z`)) / DAY);
    return { ...r, typeLabel: TYPE_LABEL[r.requestType], stepLabel: STEPS[r.step - 1], daysLeft, overdue: r.status === 'open' && daysLeft < 0 };
  }

  async list(q: z.infer<typeof RequestsQuery>) {
    const rows = await this.db
      .select()
      .from(s.privacyRequests)
      .where(q.status === 'all' ? undefined : eq(s.privacyRequests.status, q.status))
      .orderBy(s.privacyRequests.dueDate, s.privacyRequests.createdAt);
    const wsIds = [...new Set(rows.flatMap((r) => r.workspaceIds))];
    const ws = wsIds.length ? await this.db.select({ id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug }).from(s.workspaces).where(inArray(s.workspaces.id, wsIds)) : [];
    return { items: rows.map((r) => ({ ...this.dto(r), workspaces: ws.filter((w) => r.workspaceIds.includes(w.id)) })) };
  }

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบคำขอ');
    const [r] = await this.db.select().from(s.privacyRequests).where(eq(s.privacyRequests.id, id));
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบคำขอ');
    return r;
  }
  private open(r: typeof s.privacyRequests.$inferSelect) {
    if (r.status !== 'open') throw new AppError(409, 'request_closed', 'คำขอนี้ปิดแล้ว', { status: r.status });
  }

  /** ขอบเขตจริงของผู้ขอ: Workspace ที่เป็นสมาชิก (กรองตามที่ระบุ) และ Workspace ที่เป็น Owner คนเดียว */
  private async scope(r: typeof s.privacyRequests.$inferSelect) {
    if (!r.userId) return { memberships: [], soleOwner: [], invoicesKept: 0 };
    const memberships = await this.rows<{ id: string; slug: string; name: string; role: string; status: string; soleOwner: boolean }>(sql`
      select w.id, w.slug, w.name, m.role, m.status,
        (m.role = 'owner' and m.status = 'active' and not exists (select 1 from workspace_members o where o.workspace_id = w.id and o.user_id <> m.user_id and o.role = 'owner' and o.status = 'active')) as "soleOwner"
      from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = ${r.userId} and w.deleted_at is null`);
    const inScope = r.workspaceIds.length ? memberships.filter((m) => r.workspaceIds.includes(m.id)) : memberships;
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from invoices i join workspace_members m on m.workspace_id = i.workspace_id where m.user_id = ${r.userId} and m.role = 'owner' and i.status = 'paid'`);
    return { memberships: inScope, soleOwner: inScope.filter((m) => m.soleOwner && m.status === 'active'), invoicesKept: n };
  }

  /** รายละเอียด + ประวัติทุกขั้น + สิ่งที่จะถูกลบ / เก็บต่อตามกฎหมาย (A6) */
  async get(id: string) {
    const r = await this.find(id);
    const history = await this.db
      .select({ at: s.staffAuditLogs.createdAt, action: s.staffAuditLogs.action, text: s.staffAuditLogs.reason, staffName: s.staffUsers.name, approvedBy: s.staffAuditLogs.approvedBy })
      .from(s.staffAuditLogs)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.staffAuditLogs.staffId))
      .where(eq(s.staffAuditLogs.targetId, r.id))
      .orderBy(s.staffAuditLogs.createdAt);
    const scope = await this.scope(r);
    return {
      request: this.dto(r),
      steps: STEPS.map((label, i) => ({ step: i + 1, label, done: r.step > i + 1 || r.status === 'completed' })),
      history,
      scope,
      erasePlan: r.requestType === 'erase'
        ? {
            remove: ['บัญชีผู้ใช้ รูปโปรไฟล์ อีเมล เบอร์โทร การผูก LINE วิธีล็อกอิน 2FA'],
            anonymize: [`งานและคอมเมนต์ที่เคยทำ: เปลี่ยนชื่อเป็น "${ERASED_NAME}" (งานของลูกค้ายังอยู่)`],
            keep: scope.invoicesKept ? [`ใบกำกับภาษีที่ออกในชื่อบริษัท ${scope.invoicesKept} ฉบับ (ประมวลรัษฎากร 5 ปี)`] : [],
            backupDays: 35,
            blockers: scope.soleOwner.map((w) => ({ code: 'sole_owner', workspace: w.slug })),
          }
        : null,
    };
  }

  /** บันทึกคำขอที่มาทางอีเมล (A3) · เริ่มนับ 30 วันจากวันที่ได้รับ */
  async create(staff: Staff, input: z.infer<typeof CreateRequestBody>) {
    const received = input.receivedAt ?? todayBkk();
    if (received > todayBkk()) throw new AppError(422, 'received_in_future', 'วันที่ได้รับต้องไม่เกินวันนี้');
    const [dup] = await this.db.select({ id: s.privacyRequests.id, number: s.privacyRequests.number }).from(s.privacyRequests).where(and(sql`lower(${s.privacyRequests.requesterEmail}) = ${input.requesterEmail}`, eq(s.privacyRequests.requestType, input.requestType), eq(s.privacyRequests.status, 'open')));
    if (dup) throw new AppError(409, 'request_exists', 'มีคำขอประเภทเดียวกันของอีเมลนี้ที่ยังไม่เสร็จ', { id: dup.id, number: dup.number });
    const [user] = await this.db.select({ id: s.users.id }).from(s.users).where(sql`lower(${s.users.email}) = ${input.requesterEmail}`);
    if (input.identity === 'email_match' && !user) throw new AppError(422, 'no_account', 'ไม่พบบัญชีที่ใช้อีเมลนี้ จึงยืนยันด้วยอีเมลตรงกับบัญชีไม่ได้');
    const [row] = await this.db
      .insert(s.privacyRequests)
      .values({
        requestType: input.requestType, requesterEmail: input.requesterEmail, userId: user?.id ?? null, workspaceIds: input.workspaceIds, details: input.details ?? null,
        receivedAt: new Date(`${received}T00:00:00+07:00`), dueDate: addDays(received, DUE_DAYS), identity: input.identity, step: input.identity === 'unverified' ? 1 : 2, handledBy: staff.id,
      })
      .returning();
    await this.log(staff, 'privacy.request_created', `รับคำขอ #${row.number} ${TYPE_LABEL[row.requestType]} จาก ${row.requesterEmail} · ครบกำหนด ${row.dueDate}`, { type: 'privacy_request', id: row.id });
    const acknowledged = input.acknowledge ? await this.email(row.requesterEmail, `ได้รับคำขอ ${TYPE_LABEL[row.requestType]} (#${row.number})`, `ทีม Friday ได้รับคำขอของคุณแล้ว และจะดำเนินการภายใน ${row.dueDate}\nหากต้องยืนยันตัวตนเพิ่ม เราจะติดต่อกลับทางอีเมลนี้`) : false;
    // ไม่มีบัญชีกับ Friday = น่าจะเป็นข้อมูลที่ Workspace ของลูกค้าเป็นผู้ควบคุม → ส่งต่อ Owner ของ Workspace นั้น
    return { request: this.dto(row), acknowledged, forwardToOwner: !user };
  }

  async verify(staff: Staff, id: string, input: z.infer<typeof VerifyBody>) {
    const r = await this.find(id);
    this.open(r);
    if (input.method === 'email_match' && !r.userId) throw new AppError(422, 'no_account', 'ไม่พบบัญชีที่ใช้อีเมลนี้');
    const [row] = await this.db.update(s.privacyRequests).set({ identity: input.method, step: Math.max(r.step, 2), handledBy: staff.id }).where(eq(s.privacyRequests.id, r.id)).returning();
    await this.log(staff, 'privacy.identity_verified', `#${r.number} ยืนยันตัวตนด้วย ${input.method}${input.note ? ` · ${input.note}` : ''}`, { type: 'privacy_request', id: r.id });
    return this.dto(row);
  }

  /**
   * ขั้นถัดไป · 2→3 ต้องยืนยันตัวตนแล้ว · ขอลบ 3→4 ต้องใช้ "ลบตามคำขอ" (อนุมัติ 2 คน) · 4→5 = เสร็จ ส่งผลถึงผู้ขอ
   */
  async advance(staff: Staff, id: string, input: z.infer<typeof AdvanceBody>) {
    const r = await this.find(id);
    this.open(r);
    if (r.step === 1 || r.identity === 'unverified') throw new AppError(409, 'identity_unverified', 'ยืนยันตัวตนผู้ขอก่อน');
    if (r.step === 3 && r.requestType === 'erase') throw new AppError(409, 'use_erase', 'คำขอลบข้อมูลใช้ "ลบตามคำขอ" ซึ่งต้องมีคนที่สองอนุมัติ');
    const next = r.step + 1;
    const done = next > 4;
    const [row] = await this.db
      .update(s.privacyRequests)
      .set({ step: Math.min(next, 5), status: done ? 'completed' : 'open', completedAt: done ? new Date() : null, handledBy: staff.id })
      .where(eq(s.privacyRequests.id, r.id))
      .returning();
    await this.log(staff, done ? 'privacy.request_completed' : 'privacy.request_advanced', `#${r.number} ${STEPS[r.step - 1]} → ${done ? 'เสร็จ' : STEPS[next - 1]} · ${input.note}`, { type: 'privacy_request', id: r.id });
    const sent = done ? await this.email(r.requesterEmail, `ดำเนินการคำขอ #${r.number} เรียบร้อย`, input.message ?? `ทีม Friday ดำเนินการ${TYPE_LABEL[r.requestType]}ของคุณเรียบร้อยแล้ว`) : false;
    return { ...this.dto(row), sent };
  }

  /** ปฏิเสธพร้อมเหตุผลตามกฎหมาย (A5) · ผู้ขอได้รับเหตุผลทางอีเมลและร้องเรียน สคส. ได้ */
  async reject(staff: Staff, id: string, input: z.infer<typeof RejectBody>) {
    const r = await this.find(id);
    this.open(r);
    const [row] = await this.db.update(s.privacyRequests).set({ status: 'rejected', rejectionReason: input.legalBasis, completedAt: new Date(), handledBy: staff.id }).where(eq(s.privacyRequests.id, r.id)).returning();
    await this.log(staff, 'privacy.request_rejected', `#${r.number} ปฏิเสธ · ${input.legalBasis}`, { type: 'privacy_request', id: r.id });
    const sent = await this.email(r.requesterEmail, `ผลคำขอ #${r.number}`, `${input.message}\n\nเหตุผลตามกฎหมาย: ${input.legalBasis}\nหากไม่เห็นด้วย คุณร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล (สคส.) ได้`);
    return { ...this.dto(row), sent };
  }

  /** ลบตามคำขอ (A6): สร้างคำขออนุมัติเสมอ และผู้ขออนุมัติตัวเองไม่ได้ (ช่วงมี Owner คนเดียวให้รอ) */
  async requestErase(staff: Staff, id: string, input: z.infer<typeof EraseBody>) {
    const r = await this.find(id);
    this.open(r);
    if (r.requestType !== 'erase') throw new AppError(409, 'not_erase_request', 'คำขอนี้ไม่ใช่คำขอลบข้อมูล');
    if (r.step < 3 || r.identity === 'unverified') throw new AppError(409, 'not_ready', 'ยืนยันตัวตนและตรวจขอบเขตให้เสร็จก่อน (ขั้นที่ 3)');
    if (!r.userId) throw new AppError(409, 'no_account', 'ไม่พบบัญชีของผู้ขอ จึงไม่มีข้อมูลบัญชีให้ลบ');
    if (r.approvalRequestId) {
      const [a] = await this.db.select({ status: s.approvalRequests.status }).from(s.approvalRequests).where(eq(s.approvalRequests.id, r.approvalRequestId));
      if (a?.status === 'pending') throw new AppError(409, 'erase_pending', 'มีคำขออนุมัติลบที่รออยู่แล้ว', { approvalId: r.approvalRequestId });
    }
    const scope = await this.scope(r);
    if (scope.soleOwner.length) throw new AppError(409, 'sole_owner', 'ผู้ขอเป็น Owner คนเดียวของ Workspace · ให้ลูกค้าโอนความเป็นเจ้าของก่อน', { workspaces: scope.soleOwner.map((w) => w.slug) });
    const pending = await this.approvals.gate(staff, {
      kind: 'privacy.erase', workspaceId: null, target: { type: 'privacy_request', id: r.id }, payload: { requestId: r.id }, reason: `#${r.number} ${r.requesterEmail} · ${input.reason}`,
      exceeds: true, rule: 'ลบข้อมูลตามคำขอ PDPA ต้องมีคนที่สองอนุมัติเสมอ',
    });
    await this.db.update(s.privacyRequests).set({ approvalRequestId: pending!.id }).where(eq(s.privacyRequests.id, r.id));
    await this.log(staff, 'privacy.erase_requested', `#${r.number} ขออนุมัติลบข้อมูลของ ${r.requesterEmail} · ${input.reason}`, { type: 'privacy_request', id: r.id });
    return { pendingApproval: pending! };
  }

  /**
   * ลบจริง (หลังคนที่สองอนุมัติ): ถอนจาก Workspace ในขอบเขต · ถ้าไม่เหลือ Workspace ที่ใช้งาน → ทำบัญชีให้ระบุตัวไม่ได้
   * งาน / คอมเมนต์ของลูกค้ายังอยู่ (ชื่อผู้เขียนเป็น "ผู้ใช้ที่ถูกลบ") · ใบกำกับภาษีเก็บต่อตามกฎหมาย · Backup หมดอายุเองใน 35 วัน
   */
  private async applyErase(staff: Staff, id: string, ctx: ApprovalContext) {
    const r = await this.find(id);
    this.open(r);
    const userId = r.userId!;
    const scope = await this.scope(r);
    if (scope.soleOwner.length) throw new AppError(409, 'sole_owner', 'ผู้ขอเป็น Owner คนเดียวของ Workspace · ให้ลูกค้าโอนความเป็นเจ้าของก่อน', { workspaces: scope.soleOwner.map((w) => w.slug) });
    const wsIds = scope.memberships.map((m) => m.id);
    const anonymized = await this.db.transaction(async (tx) => {
      if (wsIds.length) {
        await tx.delete(s.teamMembers).where(and(eq(s.teamMembers.userId, userId), inArray(s.teamMembers.workspaceId, wsIds)));
        await tx.delete(s.projectMembers).where(and(eq(s.projectMembers.userId, userId), inArray(s.projectMembers.workspaceId, wsIds)));
        await tx.delete(s.issueWatchers).where(and(eq(s.issueWatchers.userId, userId), inArray(s.issueWatchers.workspaceId, wsIds)));
        await tx.delete(s.notifications).where(and(eq(s.notifications.recipientId, userId), inArray(s.notifications.workspaceId, wsIds)));
        await tx.update(s.workspaceMembers).set({ status: 'deactivated', jobTitle: null, department: null }).where(and(eq(s.workspaceMembers.userId, userId), inArray(s.workspaceMembers.workspaceId, wsIds)));
        for (const w of wsIds) {
          await tx.insert(s.auditLogs).values({ workspaceId: w, actorId: staff.id, actorKind: 'friday_staff', category: 'data', action: 'privacy.user_erased', targetType: 'user', targetId: userId, summary: `[Friday ${staff.name}] ลบข้อมูลสมาชิกตามคำขอ PDPA #${r.number}` });
        }
      }
      const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.userId, userId), eq(s.workspaceMembers.status, 'active')));
      if (left.n > 0) return false;
      // ไม่เหลือ Workspace ที่ใช้งาน → ลบข้อมูลส่วนตัวของบัญชี (แบบเดียวกับ apps/api › DataRequestsService.anonymizeIfOrphan)
      await tx.update(s.users).set({ email: `erased-${userId}@invalid.example`, displayName: ERASED_NAME, firstName: null, lastName: null, phone: null, about: null, avatarUrl: null, passwordHash: null, disabledAt: new Date(), updatedAt: new Date() }).where(eq(s.users.id, userId));
      await tx.delete(s.userSessions).where(eq(s.userSessions.userId, userId));
      await tx.delete(s.userIdentities).where(eq(s.userIdentities.userId, userId));
      await tx.delete(s.mfaFactors).where(eq(s.mfaFactors.userId, userId));
      await tx.delete(s.userAvatars).where(eq(s.userAvatars.userId, userId));
      await tx.delete(s.authTokens).where(eq(s.authTokens.userId, userId));
      await tx.delete(s.lineBindings).where(eq(s.lineBindings.userId, userId));
      await tx.delete(s.signupAttributions).where(eq(s.signupAttributions.userId, userId));
      await tx.update(s.productEvents).set({ userId: null }).where(eq(s.productEvents.userId, userId));
      await tx.update(s.cancellationResponses).set({ userId: null }).where(eq(s.cancellationResponses.userId, userId));
      return true;
    });
    await this.db.update(s.privacyRequests).set({ step: 4, handledBy: staff.id }).where(eq(s.privacyRequests.id, r.id));
    await this.log(staff, 'privacy.erased', `#${r.number} ลบข้อมูลของ ${r.requesterEmail} · ถอนจาก ${wsIds.length} Workspace${anonymized ? ' · บัญชีถูกทำให้ระบุตัวไม่ได้' : ''}`, { type: 'privacy_request', id: r.id }, ctx);
    return { requestId: r.id, workspaces: wsIds.length, anonymized };
  }

  // ---------------------------------------------------------------- เหตุละเมิดข้อมูล

  private breachDto(b: typeof s.dataBreaches.$inferSelect) {
    const deadline = new Date(b.discoveredAt.getTime() + BREACH_HOURS * HOUR);
    const mustNotify = b.risk !== 'low';
    return { ...b, pdpcDeadline: deadline, mustNotifyPdpc: mustNotify, hoursLeft: mustNotify && !b.pdpcNotifiedAt ? Math.round(((deadline.getTime() - Date.now()) / HOUR) * 10) / 10 : null, overdue: mustNotify && !b.pdpcNotifiedAt && deadline.getTime() < Date.now() };
  }
  private async breach(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบเหตุละเมิด');
    const [b] = await this.db.select().from(s.dataBreaches).where(eq(s.dataBreaches.id, id));
    if (!b) throw new AppError(404, 'not_found', 'ไม่พบเหตุละเมิด');
    return b;
  }
  private breachOpen(b: typeof s.dataBreaches.$inferSelect) {
    if (b.closedAt) throw new AppError(409, 'breach_closed', 'ปิดเหตุนี้แล้ว');
  }

  async breaches() {
    const rows = await this.db.select().from(s.dataBreaches).orderBy(desc(isNull(s.dataBreaches.closedAt)), desc(s.dataBreaches.discoveredAt)).limit(100);
    return { items: rows.map((b) => this.breachDto(b)) };
  }

  async getBreach(id: string) {
    const b = await this.breach(id);
    const log = await this.db
      .select({ at: s.staffAuditLogs.createdAt, action: s.staffAuditLogs.action, text: s.staffAuditLogs.reason, staffName: s.staffUsers.name })
      .from(s.staffAuditLogs)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.staffAuditLogs.staffId))
      .where(eq(s.staffAuditLogs.targetId, b.id))
      .orderBy(s.staffAuditLogs.createdAt);
    const ws = b.workspaceIds.length ? await this.db.select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name }).from(s.workspaces).where(inArray(s.workspaces.id, b.workspaceIds)) : [];
    return { breach: this.breachDto(b), workspaces: ws, log };
  }

  /** แจ้งเหตุ (A4) · นับ 72 ชม. จากเวลาที่รู้ · ทุกขั้นลงบันทึกที่แก้ไม่ได้ */
  async openBreach(staff: Staff, input: z.infer<typeof BreachBody>) {
    if (Date.parse(input.discoveredAt) > Date.now() + 60_000) throw new AppError(422, 'discovered_in_future', 'เวลาที่รู้ต้องไม่อยู่ในอนาคต');
    const [b] = await this.db
      .insert(s.dataBreaches)
      .values({
        discoveredAt: new Date(input.discoveredAt), ownerId: staff.id, description: input.description, dataTypes: input.dataTypes, affectedCount: input.affectedCount ?? null,
        workspaceIds: input.workspaceIds, risk: input.risk, containment: input.containment ?? null, containedAt: input.containedAt ? new Date(input.containedAt) : null,
      })
      .returning();
    await this.log(staff, 'privacy.breach_opened', `เหตุละเมิด #${b.number} · ความเสี่ยง ${b.risk} · ${b.description.slice(0, 200)}`, { type: 'data_breach', id: b.id });
    return this.breachDto(b);
  }

  async updateBreach(staff: Staff, id: string, input: z.infer<typeof BreachPatchBody>) {
    const b = await this.breach(id);
    this.breachOpen(b);
    const { note, ...patch } = input;
    const [row] = await this.db
      .update(s.dataBreaches)
      .set({ ...patch, containedAt: patch.containedAt ? new Date(patch.containedAt) : b.containedAt })
      .where(eq(s.dataBreaches.id, b.id))
      .returning();
    await this.log(staff, 'privacy.breach_updated', `เหตุละเมิด #${b.number} · ${Object.keys(patch).join(', ') || 'บันทึก'} · ${note}`, { type: 'data_breach', id: b.id });
    return this.breachDto(row);
  }

  /** แจ้ง สคส. แล้ว */
  async markPdpc(staff: Staff, id: string, input: z.infer<typeof BreachMarkBody>) {
    const b = await this.breach(id);
    this.breachOpen(b);
    if (b.pdpcNotifiedAt) throw new AppError(409, 'already_notified', 'บันทึกการแจ้ง สคส. แล้ว');
    const [row] = await this.db.update(s.dataBreaches).set({ pdpcNotifiedAt: new Date() }).where(eq(s.dataBreaches.id, b.id)).returning();
    const late = Date.now() > b.discoveredAt.getTime() + BREACH_HOURS * HOUR;
    await this.log(staff, 'privacy.breach_pdpc_notified', `เหตุละเมิด #${b.number} แจ้ง สคส. แล้ว${late ? ' (เกิน 72 ชม. · ต้องระบุเหตุผลที่ล่าช้า)' : ''} · ${input.note}`, { type: 'data_breach', id: b.id });
    return { ...this.breachDto(row), late };
  }

  /** แจ้ง Owner ของ Workspace ที่กระทบ (และบันทึกว่าแจ้งเจ้าของข้อมูลแล้ว) */
  async markSubjects(staff: Staff, id: string, input: z.infer<typeof BreachMarkBody>) {
    const b = await this.breach(id);
    this.breachOpen(b);
    let sent = 0;
    if (input.notifyOwners && b.workspaceIds.length) {
      const owners = await this.db
        .select({ email: s.users.email, ws: s.workspaces.name })
        .from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
        .innerJoin(s.workspaces, eq(s.workspaces.id, s.workspaceMembers.workspaceId))
        .where(and(inArray(s.workspaceMembers.workspaceId, b.workspaceIds), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')));
      for (const o of owners) if (await this.email(o.email, `แจ้งเหตุละเมิดข้อมูลส่วนบุคคลที่เกี่ยวกับ ${o.ws}`, `${input.note}\n\nข้อมูลที่กระทบ: ${b.dataTypes.join(', ')}\nทีม Friday จะแจ้งความคืบหน้าทางอีเมลนี้`)) sent++;
      for (const w of b.workspaceIds) await this.db.insert(s.auditLogs).values({ workspaceId: w, actorId: staff.id, actorKind: 'friday_staff', category: 'data', action: 'privacy.breach_notified', summary: `[Friday ${staff.name}] แจ้งเหตุละเมิดข้อมูล #${b.number}` });
    }
    const [row] = await this.db.update(s.dataBreaches).set({ subjectsNotifiedAt: new Date() }).where(eq(s.dataBreaches.id, b.id)).returning();
    await this.log(staff, 'privacy.breach_subjects_notified', `เหตุละเมิด #${b.number} แจ้ง Owner / เจ้าของข้อมูล ${sent} อีเมล · ${input.note}`, { type: 'data_breach', id: b.id });
    return { ...this.breachDto(row), sent };
  }

  async closeBreach(staff: Staff, id: string, input: z.infer<typeof BreachMarkBody>) {
    const b = await this.breach(id);
    this.breachOpen(b);
    if (b.risk !== 'low' && !b.pdpcNotifiedAt) throw new AppError(409, 'pdpc_not_notified', 'ความเสี่ยงไม่ต่ำ ต้องแจ้ง สคส. ก่อนปิด');
    if (!b.assessment) throw new AppError(409, 'assessment_required', 'บันทึกการประเมินความเสี่ยงก่อนปิด');
    const [row] = await this.db.update(s.dataBreaches).set({ closedAt: new Date() }).where(eq(s.dataBreaches.id, b.id)).returning();
    await this.log(staff, 'privacy.breach_closed', `ปิดเหตุละเมิด #${b.number} · ${input.note}`, { type: 'data_breach', id: b.id });
    return this.breachDto(row);
  }

  /** ร่างหนังสือแจ้ง สคส. (ตามหัวข้อที่ต้องแจ้ง: เหตุ, ข้อมูลและจำนวนที่กระทบ, ผลที่อาจเกิด, มาตรการ, ผู้ติดต่อ) */
  async pdpcDraft(id: string) {
    const b = await this.breach(id);
    const [owner] = await this.db.select({ name: s.staffUsers.name, email: s.staffUsers.email }).from(s.staffUsers).where(eq(s.staffUsers.id, b.ownerId));
    const fmt = (d: Date | null) => (d ? new Date(d.getTime() + 7 * HOUR).toISOString().replace('T', ' ').slice(0, 16) : '-');
    const company = process.env.SELLER_NAME ?? 'บริษัท ฟรายเดย์ จำกัด (ตัวอย่าง)';
    const text = [
      'เรียน สำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล',
      `เรื่อง แจ้งเหตุการละเมิดข้อมูลส่วนบุคคล (เลขที่อ้างอิงภายใน #${b.number})`,
      '',
      `1. ผู้ควบคุมข้อมูลส่วนบุคคล: ${company}`,
      `2. วันเวลาที่ทราบเหตุ: ${fmt(b.discoveredAt)} (เวลาประเทศไทย)`,
      `3. ลักษณะของเหตุ: ${b.description}`,
      `4. ประเภทข้อมูลที่กระทบ: ${b.dataTypes.join(', ')}`,
      `5. จำนวนเจ้าของข้อมูลที่กระทบ (โดยประมาณ): ${b.affectedCount ?? 'อยู่ระหว่างตรวจสอบ'} ราย`,
      `6. ระดับความเสี่ยงที่ประเมิน: ${{ low: 'ต่ำ', medium: 'ปานกลาง', high: 'สูง' }[b.risk]}${b.assessment ? ` · ${b.assessment}` : ''}`,
      `7. มาตรการที่ดำเนินการแล้ว: ${b.containment ?? 'อยู่ระหว่างดำเนินการ'}${b.containedAt ? ` (ควบคุมเหตุได้เมื่อ ${fmt(b.containedAt)})` : ''}`,
      `8. การแจ้งเจ้าของข้อมูล: ${b.subjectsNotifiedAt ? `แจ้งแล้วเมื่อ ${fmt(b.subjectsNotifiedAt)}` : 'อยู่ระหว่างดำเนินการ'}`,
      `9. ผู้ประสานงาน: ${owner?.name ?? '-'} (${owner?.email ?? '-'})`,
      '',
      Date.now() > b.discoveredAt.getTime() + BREACH_HOURS * HOUR ? 'หมายเหตุ: การแจ้งนี้เกิน 72 ชั่วโมงนับจากทราบเหตุ เนื่องจาก [ระบุเหตุผลความล่าช้า]' : '',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
    return { breachId: b.id, deadline: new Date(b.discoveredAt.getTime() + BREACH_HOURS * HOUR), text: text.join('\n') };
  }

  /** Workspace ที่รอลบ (ระยะผ่อนผัน 30 วัน) สำหรับหน้า Privacy */
  async pendingDeletes() {
    const rows = await this.rows(sql`
      select w.id, w.slug, w.name, w.updated_at as "requestedAt", (w.updated_at + interval '30 days') as "purgeAt",
        (select u.email from audit_logs a left join users u on u.id = a.actor_id where a.workspace_id = w.id and a.action like 'workspace.delete%' order by a.created_at desc limit 1) as "requestedBy"
      from workspaces w where w.status = 'pending_delete' and w.deleted_at is null order by w.updated_at`);
    return { items: rows };
  }
}

