import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type Db, heldScope, readRetention, RETENTION_DEFAULTS, RETENTION_KEY, RETENTION_KEYS, RETENTION_LIMITS, type RetentionKey, schema, TAX_RETENTION_YEARS } from '@friday/db';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { type ApprovalContext, ApprovalsService } from '../approvals/approvals.service.js';
import { type Approval, audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
const DAY = 86_400_000;
/** ระยะผ่อนผันของ Workspace ที่ลบ (03-api › DELETE w/) · ตรงกับหน้ากู้คืน (restore.service) */
const GRACE_DAYS = 30;
type Row = Record<string, unknown>;

export const HoldBody = z
  .object({
    workspaceId: z.uuid(),
    scope: z.enum(['workspace', 'users']).default('workspace'),
    /** เฉพาะผู้ใช้บางคน: อีเมลสมาชิกของ Workspace นี้ */
    userEmails: z.array(z.email().trim().toLowerCase()).max(50).default([]),
    reason: z.string().trim().min(3).max(200),
    reference: z.string().trim().min(2).max(120),
    /** วันทบทวน · ไม่ระบุ = จนกว่าจะยกเลิก (ทบทวนทุก 90 วัน) */
    reviewOn: z.iso.date().optional(),
    /** ค่าเริ่มต้นไม่แจ้งลูกค้า (คำตัดสินข้อ 3) เพราะบางกรณีแจ้งแล้วกระทบการสอบสวน */
    notifyCustomer: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.scope === 'workspace' || b.userEmails.length > 0, { message: 'เลือกผู้ใช้อย่างน้อย 1 คน', path: ['userEmails'] });
export const ReleaseBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
export const RetentionBody = z.object({ key: z.enum(RETENTION_KEYS as [RetentionKey, ...RetentionKey[]]), days: z.number().int(), reason: z.string().trim().min(5).max(500) }).strict();
export const RetentionEstimateQuery = z.object({ key: z.enum(RETENTION_KEYS as [RetentionKey, ...RetentionKey[]]), days: z.coerce.number().int() });
export const PurgeNowBody = z
  .object({
    ticketId: z.uuid(),
    /** พิมพ์ slug ของ Workspace เพื่อยืนยัน (G6) */
    confirmSlug: z.string().trim().min(1).max(63),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

/** ชื่อแถวนโยบาย · enforced = มีงานลบอัตโนมัติที่อ่านค่านี้จริง */
const RETENTION_ROWS: { key: RetentionKey; label: string; enforced: boolean; note: string | null }[] = [
  { key: 'workspaceDataDays', label: 'ข้อมูลงานของ Workspace ที่ยกเลิก', enforced: false, note: 'ยังไม่มีงานลบอัตโนมัติ · ใช้เป็นนโยบายที่ประกาศ' },
  { key: 'trashDays', label: 'ถังขยะ (งาน / ไฟล์ที่ลบ)', enforced: true, note: 'ค่าเริ่มต้นของ Workspace ที่ไม่ได้ตั้งเอง · ลูกค้าตั้ง 90 ได้' },
  { key: 'systemLogDays', label: 'Log ระบบ (IP, User agent)', enforced: true, note: 'งานตี 4:15 ลบ IP / User agent ใน Audit log และเซสชันที่หมดอายุ' },
  { key: 'staffAuditDays', label: 'Audit log ของทีม Friday', enforced: false, note: 'แก้ / ลบไม่ได้ในฐานข้อมูล (append-only) · ใช้เป็นนโยบายที่ประกาศ' },
];

const purgeOf = (w: { deletedAt: Date | null; purgeAfter: Date | null }) => w.purgeAfter ?? new Date(w.deletedAt!.getTime() + GRACE_DAYS * DAY);
const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);
const thaiDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(d);

/**
 * Legal hold นโยบายการเก็บข้อมูล และ Workspace ที่รอลบ (รอบ 4 · H10–H13 · O05)
 * - Legal hold: ตั้ง = Owner + แตะกุญแจ · ยกเลิก = ขออนุมัติ (G7) · งานลบถาวรทุกชนิดอ่าน heldScope() ใน packages/db แล้วข้าม
 * - ระยะเก็บ: ops_settings key `retention` · ยาวขึ้นบันทึกได้เลย · สั้นลงต้องขออนุมัติ · ภาษี 5 ปีล็อก
 * - ลบถาวรทันที: ตรวจ Ticket / hold / ค้างชำระ / slug แล้วขออนุมัติ (คนที่สองเสมอ · NO_SELF_APPROVAL)
 *   อนุมัติแล้วตั้ง purge_after = ตอนนี้ + ลง Audit `ops.workspace_purge_approved` ให้งาน privacy.purge-approved ของ API ลูกค้าลบด้วย logic เดียวกับงานตี 4 (ทุก 5 นาที)
 */
@Injectable()
export class HoldsService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    this.approvals.register('privacy.release_hold', (p, ctx) => this.applyRelease(ctx.requester, p.holdId as string, p.reason as string, ctx));
    this.approvals.register('privacy.retention_shorten', (p, ctx) => this.applyRetention(ctx.requester, p.key as RetentionKey, p.days as number, p.reason as string, ctx));
    this.approvals.register('privacy.purge_now', (p, ctx) => this.applyPurgeNow(ctx.requester, p.workspaceId as string, p.ticketNo as string, p.reason as string, ctx));
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

  // ---------------------------------------------------------------- Workspace ที่รอลบ (H10)

  /**
   * แหล่งเดียวกับหน้ากู้คืน (restore.service › pendingWorkspaces): deleted_at ไม่ว่าง + purge_after (แถวเก่าใช้ deleted_at + 30 วัน)
   * เดิมค้น status = pending_delete AND deleted_at IS NULL ซึ่งไม่มีวันตรง การ์ดจึงว่างตลอด
   */
  async pendingDeletes() {
    const ws = await this.db
      .select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, deletedAt: s.workspaces.deletedAt, purgeAfter: s.workspaces.purgeAfter, deletedBy: s.workspaces.deletedBy })
      .from(s.workspaces)
      .where(isNotNull(s.workspaces.deletedAt));
    const ids = ws.map((w) => w.id);
    const held = await heldScope(this.db);
    const people = ids.length
      ? await this.db
          .select({ workspaceId: s.workspaceMembers.workspaceId, userId: s.users.id, email: s.users.email, name: s.users.displayName, role: s.workspaceMembers.role })
          .from(s.workspaceMembers)
          .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
          .where(inArray(s.workspaceMembers.workspaceId, ids))
      : [];
    const unpaid = ids.length
      ? await this.db.select({ id: s.invoices.workspaceId, n: sql<number>`count(*)::int` }).from(s.invoices).where(and(inArray(s.invoices.workspaceId, ids), inArray(s.invoices.status, ['open', 'pending_review']))).groupBy(s.invoices.workspaceId)
      : [];
    const pending = ids.length
      ? await this.db.select({ id: s.approvalRequests.id, workspaceId: s.approvalRequests.workspaceId }).from(s.approvalRequests).where(and(inArray(s.approvalRequests.workspaceId, ids), eq(s.approvalRequests.kind, 'privacy.purge_now'), eq(s.approvalRequests.status, 'pending')))
      : [];
    const approved = ids.length
      ? await this.db.selectDistinct({ id: s.auditLogs.workspaceId }).from(s.auditLogs).where(and(inArray(s.auditLogs.workspaceId, ids), eq(s.auditLogs.action, 'ops.workspace_purge_approved')))
      : [];
    const items = ws
      .map((w) => {
        const purgeAt = purgeOf(w);
        const by = people.find((p) => p.workspaceId === w.id && p.userId === w.deletedBy);
        return {
          id: w.id, slug: w.slug, name: w.name,
          requestedAt: w.deletedAt, purgeAt,
          daysLeft: Math.max(0, Math.ceil((purgeAt.getTime() - Date.now()) / DAY)),
          requestedBy: by ? { name: by.name, email: by.email, role: by.role } : null,
          /** ระบบลบเอง (ไม่มีผู้ลบ) */
          system: !w.deletedBy,
          legalHold: held.anyHold.has(w.id),
          unpaidInvoices: unpaid.find((u) => u.id === w.id)?.n ?? 0,
          purgeApproval: pending.find((p) => p.workspaceId === w.id)?.id ?? null,
          purgeApproved: approved.some((a) => a.id === w.id),
        };
      })
      .sort((a, b) => a.purgeAt.getTime() - b.purgeAt.getTime());
    return { items, graceDays: GRACE_DAYS };
  }

  /** สิ่งที่จะลบ / เก็บต่อ (H13) */
  async purgePreview(id: string) {
    const w = await this.deleted(id);
    const [c] = await this.rows<{ projects: number; issues: number; bytes: number; members: number; tickets: number }>(sql`
      select (select count(*)::int from projects where workspace_id = ${w.id}) as projects,
             (select count(*)::int from issues where workspace_id = ${w.id}) as issues,
             (select coalesce(sum(size_bytes), 0)::float8 from file_versions where workspace_id = ${w.id}) as bytes,
             (select count(*)::int from workspace_members m where m.workspace_id = ${w.id}
                and not exists (select 1 from workspace_members o join workspaces x on x.id = o.workspace_id where o.user_id = m.user_id and o.workspace_id <> m.workspace_id and x.deleted_at is null)) as members,
             0 as tickets`);
    const tickets = await this.db
      .select({ id: s.supportTickets.id, number: s.supportTickets.number, subject: s.supportTickets.subject, status: s.supportTickets.status, requesterUserId: s.supportTickets.requesterUserId })
      .from(s.supportTickets)
      .where(eq(s.supportTickets.workspaceId, w.id))
      .orderBy(desc(s.supportTickets.createdAt))
      .limit(20);
    const owners = await this.db.select({ userId: s.workspaceMembers.userId }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, w.id), eq(s.workspaceMembers.role, 'owner')));
    const held = await heldScope(this.db);
    const [unpaid] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.invoices).where(and(eq(s.invoices.workspaceId, w.id), inArray(s.invoices.status, ['open', 'pending_review'])));
    return {
      workspace: { id: w.id, slug: w.slug, name: w.name, purgeAt: purgeOf(w) },
      remove: { projects: c.projects, issues: c.issues, bytes: Number(c.bytes), members: c.members },
      keepYears: TAX_RETENTION_YEARS,
      tickets: tickets.map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, fromOwner: owners.some((o) => o.userId === t.requesterUserId) })),
      checks: { legalHold: held.anyHold.has(w.id), unpaidInvoices: unpaid.n },
    };
  }

  private async deleted(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [w] = await this.db.select().from(s.workspaces).where(eq(s.workspaces.id, id));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    if (!w.deletedAt) throw new AppError(409, 'workspace_not_deleted', 'Workspace นี้ไม่ได้อยู่ในรายการรอลบ');
    return w;
  }

  /** เงื่อนไขของลบทันทีที่ต้องผ่านทั้งตอนขอและตอนอนุมัติ */
  private async purgeBlockers(workspaceId: string) {
    const held = await heldScope(this.db);
    if (held.anyHold.has(workspaceId)) throw new AppError(409, 'legal_hold', 'Workspace นี้ติด Legal hold · ลบถาวรไม่ได้จนกว่าจะยกเลิก');
    const [unpaid] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.invoices).where(and(eq(s.invoices.workspaceId, workspaceId), inArray(s.invoices.status, ['open', 'pending_review'])));
    if (unpaid.n > 0) throw new AppError(409, 'unpaid_invoices', `ยังมีใบแจ้งหนี้ค้างชำระ ${unpaid.n} ใบ · ปิดยอดก่อนลบ`, { count: unpaid.n });
  }

  /**
   * ลบถาวรทันที (H13): ใช้เมื่อลูกค้าขอให้ลบก่อนครบ 30 วัน · Ticket ของ Workspace นี้ (จาก Owner) + ไม่มี hold + ไม่ค้างชำระ + พิมพ์ slug
   * สร้างคำขออนุมัติเสมอ และผู้ขออนุมัติเองไม่ได้ (ช่วงมี Owner คนเดียวจึงใช้ไม่ได้ ต้องรอครบ 30 วัน · คำตัดสินข้อ 4)
   */
  async requestPurgeNow(staff: Staff, id: string, input: z.infer<typeof PurgeNowBody>) {
    const w = await this.deleted(id);
    if (input.confirmSlug.toLowerCase() !== w.slug.toLowerCase()) throw new AppError(422, 'confirm_required', 'พิมพ์ slug ของ Workspace ให้ตรงเพื่อยืนยัน', { slug: w.slug });
    const [t] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, input.ticketId));
    if (!t || t.workspaceId !== w.id) throw new AppError(422, 'ticket_other_workspace', 'Ticket นี้ไม่ใช่ของ Workspace นี้');
    const [owner] = t.requesterUserId
      ? await this.db.select({ id: s.workspaceMembers.userId }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, w.id), eq(s.workspaceMembers.userId, t.requesterUserId), eq(s.workspaceMembers.role, 'owner')))
      : [];
    if (!owner) throw new AppError(422, 'ticket_not_from_owner', 'Ticket ต้องมาจาก Owner ของ Workspace');
    await this.purgeBlockers(w.id);
    const [open] = await this.db.select({ id: s.approvalRequests.id }).from(s.approvalRequests).where(and(eq(s.approvalRequests.workspaceId, w.id), eq(s.approvalRequests.kind, 'privacy.purge_now'), eq(s.approvalRequests.status, 'pending')));
    if (open) throw new AppError(409, 'purge_pending', 'มีคำขอลบถาวรที่รออนุมัติอยู่แล้ว', { approvalId: open.id });
    const ticketNo = `#${t.number}`;
    const pending = await this.approvals.gate(staff, {
      kind: 'privacy.purge_now', workspaceId: w.id, target: { type: 'workspace', id: w.id }, payload: { workspaceId: w.id, ticketNo, reason: input.reason },
      reason: `ลบ ${w.slug} ถาวรทันที · Ticket ${ticketNo} · ${input.reason}`, exceeds: true, rule: 'ลบถาวรทันทีต้องมีคนที่สองอนุมัติเสมอ',
    });
    await staffAudit(this.db, staff, 'privacy.purge_now_requested', `ขอลบ ${w.slug} ถาวรทันที · Ticket ${ticketNo} · ${input.reason}`, { type: 'workspace', id: w.id }, w.id);
    return { pendingApproval: pending! };
  }

  private async applyPurgeNow(staff: Staff, workspaceId: string, ticketNo: string, reason: string, ctx: ApprovalContext) {
    const w = await this.deleted(workspaceId);
    await this.purgeBlockers(w.id);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(s.workspaces).set({ purgeAfter: now }).where(and(eq(s.workspaces.id, w.id), isNotNull(s.workspaces.deletedAt)));
      // งาน privacy.purge-approved ของ API ลูกค้า (ทุก 5 นาที) ลบเฉพาะ Workspace ที่มีแถวนี้ · ใช้ logic เดียวกับงานตี 4 (ข้าม Legal hold)
      await audit(tx, staff, w.id, 'secu', 'ops.workspace_purge_approved', `อนุมัติลบ Workspace ${w.slug} ถาวรทันทีตามคำขอของ Owner · Ticket ${ticketNo} · ${reason}`, { type: 'workspace', id: w.id }, approvalOf(ctx));
    });
    return { workspaceId: w.id, purgeAfter: now, purgeWithinMinutes: 10 };
  }

  // ---------------------------------------------------------------- Legal hold (H11)

  async holds() {
    const rows = await this.db
      .select({ h: s.legalHolds, ws: s.workspaces.name, slug: s.workspaces.slug, by: s.staffUsers.name })
      .from(s.legalHolds)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.legalHolds.workspaceId))
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.legalHolds.createdBy))
      .where(or(isNull(s.legalHolds.releasedAt), sql`${s.legalHolds.releasedAt} > now() - interval '90 days'`))
      .orderBy(desc(isNull(s.legalHolds.releasedAt)), desc(s.legalHolds.createdAt));
    const users = [...new Set(rows.flatMap((r) => r.h.userIds))];
    const emails = users.length ? await this.db.select({ id: s.users.id, email: s.users.email }).from(s.users).where(inArray(s.users.id, users)) : [];
    const pending = await this.db
      .select({ id: s.approvalRequests.id, holdId: sql<string>`${s.approvalRequests.payload} ->> 'holdId'` })
      .from(s.approvalRequests)
      .where(and(eq(s.approvalRequests.kind, 'privacy.release_hold'), eq(s.approvalRequests.status, 'pending')));
    return {
      items: rows.map((r) => ({
        ...r.h,
        workspace: { id: r.h.workspaceId, name: r.ws, slug: r.slug },
        createdByName: r.by,
        userEmails: r.h.userIds.map((u) => emails.find((e) => e.id === u)?.email ?? u),
        active: !r.h.releasedAt,
        releaseApproval: pending.find((p) => p.holdId === r.h.id)?.id ?? null,
      })),
    };
  }

  /** ตั้ง Legal hold · Owner + แตะกุญแจ (controller) · ไม่แจ้งลูกค้าเป็นค่าเริ่มต้น จึงไม่เขียน Audit ที่ลูกค้าเห็น */
  async createHold(staff: Staff, input: z.infer<typeof HoldBody>) {
    const [w] = await this.db.select().from(s.workspaces).where(eq(s.workspaces.id, input.workspaceId));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    let userIds: string[] = [];
    if (input.scope === 'users') {
      const found = await this.db
        .select({ id: s.users.id, email: s.users.email })
        .from(s.users)
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.userId, s.users.id), eq(s.workspaceMembers.workspaceId, w.id)))
        .where(sql`lower(${s.users.email}) = any(${sql.param(input.userEmails)}::text[])`);
      const missing = input.userEmails.filter((e) => !found.some((f) => f.email.toLowerCase() === e));
      if (missing.length) throw new AppError(422, 'not_member', 'อีเมลบางรายการไม่ใช่สมาชิกของ Workspace นี้', { missing });
      userIds = found.map((f) => f.id);
    }
    const [dup] = await this.db.select({ id: s.legalHolds.id }).from(s.legalHolds).where(and(eq(s.legalHolds.workspaceId, w.id), eq(s.legalHolds.scope, 'workspace'), isNull(s.legalHolds.releasedAt)));
    if (dup && input.scope === 'workspace') throw new AppError(409, 'hold_exists', 'Workspace นี้มี Legal hold ทั้ง Workspace อยู่แล้ว', { holdId: dup.id });
    const reviewOn = input.reviewOn ?? new Date(Date.now() + 7 * 3_600_000 + 90 * DAY).toISOString().slice(0, 10);
    const hold = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(s.legalHolds)
        .values({ workspaceId: w.id, scope: input.scope, userIds, reason: input.reason, reference: input.reference, reviewOn, notifyCustomer: input.notifyCustomer, createdBy: staff.id })
        .returning();
      const what = `ตั้ง Legal hold ${input.scope === 'workspace' ? 'ทั้ง Workspace' : `ผู้ใช้ ${userIds.length} คน`} · ${input.reason} · อ้างอิง ${input.reference}`;
      if (input.notifyCustomer) await audit(tx, staff, w.id, 'secu', 'privacy.legal_hold_set', what, { type: 'legal_hold', id: row.id });
      else await staffAudit(tx, staff, 'privacy.legal_hold_set', what, { type: 'legal_hold', id: row.id }, w.id);
      return row;
    });
    let notified = 0;
    if (input.notifyCustomer) {
      const owners = await this.ownerEmails(w.id);
      for (const o of owners) if (await this.email(o, `ข้อมูลของ ${w.name} ถูกเก็บไว้ตามกฎหมาย`, `ทีม Friday ต้องเก็บข้อมูลของ Workspace ${w.name} ไว้ตามกฎหมาย (อ้างอิง ${input.reference})\nระหว่างนี้คุณใช้งานได้ตามปกติ แต่ข้อมูลที่ลบจะยังไม่ถูกลบถาวรจนกว่าจะสิ้นสุด\n\nFriday Work Management`)) notified++;
    }
    const heldRequests = await this.holdErasureRequests();
    return { hold, notified, heldRequests };
  }

  private async ownerEmails(workspaceId: string) {
    const rows = await this.db
      .select({ email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')));
    return rows.map((r) => r.email);
  }

  /** ผู้ขอที่ข้อมูลติด hold (ผู้ใช้ในขอบเขต หรือเป็นสมาชิก Workspace ที่ hold ทั้งก้อน) */
  async heldUsers(userIds: string[]) {
    if (!userIds.length) return new Set<string>();
    const held = await heldScope(this.db);
    const out = new Set(userIds.filter((u) => held.users.has(u)));
    if (held.wholeWorkspace.size) {
      const m = await this.db.select({ userId: s.workspaceMembers.userId }).from(s.workspaceMembers).where(and(inArray(s.workspaceMembers.userId, userIds), inArray(s.workspaceMembers.workspaceId, [...held.wholeWorkspace])));
      for (const r of m) out.add(r.userId);
    }
    return out;
  }

  /**
   * คำขอลบ PDPA ที่เปิดอยู่ของผู้ใช้ในขอบเขต hold → "รอ Legal hold" และแจ้งผู้ขอครั้งเดียวว่าเก็บไว้ตามกฎหมาย
   * กันแจ้งซ้ำด้วย Audit `privacy.erase_held` ของคำขอนั้น
   */
  async holdErasureRequests() {
    const open = await this.db.select().from(s.privacyRequests).where(and(eq(s.privacyRequests.status, 'open'), eq(s.privacyRequests.requestType, 'erase'), isNotNull(s.privacyRequests.userId)));
    const held = await this.heldUsers(open.map((r) => r.userId!));
    let n = 0;
    for (const r of open.filter((x) => held.has(x.userId!))) {
      const [done] = await this.db.select({ id: s.staffAuditLogs.id }).from(s.staffAuditLogs).where(and(eq(s.staffAuditLogs.targetId, r.id), eq(s.staffAuditLogs.action, 'privacy.erase_held'))).limit(1);
      if (done) continue;
      const sent = await this.email(r.requesterEmail, `คำขอ #${r.number}: ข้อมูลบางส่วนต้องเก็บไว้ตามกฎหมาย`, `ทีม Friday ได้รับคำขอลบข้อมูลของคุณแล้ว แต่ขณะนี้ข้อมูลบางส่วนต้องเก็บไว้ตามกฎหมาย จึงยังลบไม่ได้\nเมื่อหมดเหตุที่ต้องเก็บ เราจะดำเนินการลบและแจ้งผลทางอีเมลนี้\nหากไม่เห็นด้วย คุณร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล (สคส.) ได้`);
      await staffAudit(this.db, null, 'privacy.erase_held', `#${r.number} รอ Legal hold · ${sent ? 'แจ้งผู้ขอแล้ว' : 'ส่งอีเมลแจ้งผู้ขอไม่สำเร็จ'}`, { type: 'privacy_request', id: r.id });
      n++;
    }
    return n;
  }

  /** ยกเลิก Legal hold: ต้องมีคนที่สองอนุมัติ (G7) · ช่วงมี Owner คนเดียวอนุมัติตัวเองได้แบบติดป้าย */
  async requestRelease(staff: Staff, id: string, input: z.infer<typeof ReleaseBody>) {
    const h = await this.hold(id);
    if (h.releasedAt) throw new AppError(409, 'hold_released', 'Legal hold นี้ยกเลิกแล้ว');
    const [open] = await this.db.select({ id: s.approvalRequests.id }).from(s.approvalRequests).where(and(eq(s.approvalRequests.kind, 'privacy.release_hold'), eq(s.approvalRequests.status, 'pending'), sql`${s.approvalRequests.payload} ->> 'holdId' = ${h.id}`));
    if (open) throw new AppError(409, 'release_pending', 'มีคำขอยกเลิกที่รออนุมัติอยู่แล้ว', { approvalId: open.id });
    const pending = await this.approvals.gate(staff, {
      kind: 'privacy.release_hold', workspaceId: h.workspaceId, target: { type: 'legal_hold', id: h.id }, payload: { holdId: h.id, reason: input.reason },
      reason: `ยกเลิก Legal hold (${h.reference}) · ${input.reason}`, exceeds: true, rule: 'ยกเลิก Legal hold ต้องมีคนที่สองอนุมัติ',
    });
    return { pendingApproval: pending! };
  }

  private async hold(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Legal hold');
    const [h] = await this.db.select().from(s.legalHolds).where(eq(s.legalHolds.id, id));
    if (!h) throw new AppError(404, 'not_found', 'ไม่พบ Legal hold');
    return h;
  }

  private async applyRelease(staff: Staff, id: string, reason: string, ctx: ApprovalContext) {
    const h = await this.hold(id);
    if (h.releasedAt) throw new AppError(409, 'hold_released', 'Legal hold นี้ยกเลิกแล้ว');
    const [row] = await this.db.update(s.legalHolds).set({ releasedAt: new Date(), releasedBy: ctx.approver.id, releaseReason: reason }).where(and(eq(s.legalHolds.id, id), isNull(s.legalHolds.releasedAt))).returning();
    const what = `ยกเลิก Legal hold (${h.reference}) · ${reason}`;
    if (h.notifyCustomer) await audit(this.db, staff, h.workspaceId, 'secu', 'privacy.legal_hold_released', what, { type: 'legal_hold', id }, approvalOf(ctx));
    else await staffAudit(this.db, staff, 'privacy.legal_hold_released', what, { type: 'legal_hold', id }, h.workspaceId, approvalOf(ctx));
    return { hold: row };
  }

  // ---------------------------------------------------------------- นโยบายการเก็บข้อมูล (H12)

  async retention() {
    const values = await readRetention(this.db);
    const [last] = await this.db.select({ value: s.opsSettings.value }).from(s.opsSettings).where(eq(s.opsSettings.key, 'retention_last_run'));
    const pending = await this.db
      .select({ id: s.approvalRequests.id, key: sql<string>`${s.approvalRequests.payload} ->> 'key'`, days: sql<number>`(${s.approvalRequests.payload} ->> 'days')::int` })
      .from(s.approvalRequests)
      .where(and(eq(s.approvalRequests.kind, 'privacy.retention_shorten'), eq(s.approvalRequests.status, 'pending')));
    return {
      rows: RETENTION_ROWS.map((r) => ({ ...r, days: values[r.key], defaultDays: RETENTION_DEFAULTS[r.key], ...RETENTION_LIMITS[r.key], pendingApproval: pending.find((p) => p.key === r.key) ?? null })),
      taxYears: TAX_RETENTION_YEARS,
      lastRun: (last?.value as Record<string, unknown> | undefined) ?? null,
    };
  }

  /** ประมาณจำนวนแถวที่จะถูกลบเมื่อสั้นลง (ไม่รวมข้อมูลที่ติด Legal hold) */
  async estimate(q: z.infer<typeof RetentionEstimateQuery>) {
    this.checkDays(q.key, q.days);
    const cutoff = new Date(Date.now() - q.days * DAY);
    const held = [...(await heldScope(this.db)).anyHold];
    const notHeld = held.length ? sql`and not (workspace_id = any(${sql.param(held)}::uuid[]))` : sql``;
    if (q.key === 'systemLogDays') {
      const [r] = await this.rows<{ n: number }>(sql`select (select count(*)::int from audit_logs where created_at < ${cutoff} and (ip is not null or user_agent is not null) ${notHeld})
        + (select count(*)::int from user_sessions where coalesce(revoked_at, last_seen_at) < ${cutoff}) as n`);
      return { key: q.key, days: q.days, rows: r.n };
    }
    if (q.key === 'trashDays') {
      const [r] = await this.rows<{ n: number }>(sql`select (select count(*)::int from issues where deleted_at < ${cutoff} ${notHeld})
        + (select count(*)::int from files where deleted_at < ${cutoff} ${notHeld}) + (select count(*)::int from projects where deleted_at < ${cutoff} ${notHeld}) as n`);
      return { key: q.key, days: q.days, rows: r.n };
    }
    return { key: q.key, days: q.days, rows: null };
  }

  private checkDays(key: RetentionKey, days: number) {
    const L = RETENTION_LIMITS[key];
    if (days < L.min || days > L.max) throw new AppError(422, 'retention_out_of_range', `ตั้งได้ ${L.min}–${L.max} วัน`, L);
  }

  /** ยาวขึ้น = บันทึกได้เลย · สั้นลง = ขออนุมัติ (ลบข้อมูลเร็วขึ้น กู้คืนไม่ได้) */
  async setRetention(staff: Staff, input: z.infer<typeof RetentionBody>) {
    this.checkDays(input.key, input.days);
    const current = (await readRetention(this.db))[input.key];
    if (input.days === current) throw new AppError(409, 'no_change', 'ค่าเดิมอยู่แล้ว');
    if (input.days < current) {
      const pending = await this.approvals.gate(staff, {
        kind: 'privacy.retention_shorten', workspaceId: null, target: undefined, payload: { key: input.key, days: input.days, from: current, reason: input.reason },
        reason: `${RETENTION_ROWS.find((r) => r.key === input.key)!.label} ${current} → ${input.days} วัน · ${input.reason}`, exceeds: true, rule: 'ลดระยะเก็บข้อมูลต้องมีคนที่สองอนุมัติ',
      });
      return { pendingApproval: pending! };
    }
    return this.applyRetention(staff, input.key, input.days, input.reason);
  }

  private async applyRetention(staff: Staff, key: RetentionKey, days: number, reason: string, ctx?: ApprovalContext) {
    this.checkDays(key, days);
    const before = await readRetention(this.db);
    const value = { ...before, [key]: days };
    await this.db
      .insert(s.opsSettings)
      .values({ key: RETENTION_KEY, value, updatedBy: staff.id })
      .onConflictDoUpdate({ target: s.opsSettings.key, set: { value, updatedBy: staff.id } });
    await staffAudit(this.db, staff, 'privacy.retention_changed', `${RETENTION_ROWS.find((r) => r.key === key)!.label} ${before[key]} → ${days} วัน · ${reason}`, undefined, undefined, approvalOf(ctx));
    return { key, days, retention: value, effectiveFrom: thaiDate(new Date()) };
  }
}
