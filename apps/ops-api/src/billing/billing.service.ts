import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, isGrantSource, schema, type Tx } from '@friday/db';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { type Approval, audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { addDays, baht, billingContacts, DAY, type Invoice, mailAll, nextNumber, todayBkk, vatRegistered } from './ledger.js';

const s = schema;
type Row = Record<string, unknown>;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'รูปแบบเดือนต้องเป็น YYYY-MM');
const Reason = z.string().trim().min(3).max(500);

export const InvoicesQuery = z.object({
  status: z.enum(['open', 'pending_review', 'paid', 'void', 'overdue']).optional(),
  month: Month.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const CreateInvoiceBody = z
  .object({
    workspaceId: z.uuid(),
    poNumber: z.string().trim().max(60).optional(),
    dueDays: z.number().int().min(1).max(90).default(30),
    items: z.array(z.object({ description: z.string().trim().min(1).max(200), qty: z.number().int().min(1).max(100_000), unitSatang: z.number().int().min(0) }).strict()).min(1).max(30),
    discountPct: z.number().min(0).max(100).default(0),
    /** ลูกค้าหัก ณ ที่จ่าย 3% */
    wht: z.boolean().default(false),
    /** ใบนี้ต่ออายุแพ็กเกจเมื่อชำระ (สัญญารายปี / Enterprise) · ไม่ระบุ = ค่าบริการเพิ่ม */
    plan: z.object({ code: z.enum(PLAN_CODES), cycle: z.enum(['monthly', 'yearly']), periodStart: z.iso.date(), periodEnd: z.iso.date() }).strict().optional(),
    note: z.string().trim().max(500).optional(),
    send: z.boolean().default(true),
  })
  .strict();
export const VoidBody = z
  .object({
    reason: Reason,
    /** เงินที่ชำระแล้ว (B2): เครดิต / คืนเงิน (ผ่านหน้าคืนเงินและอนุมัติ) / ไม่คืน (ยกเลิกเฉพาะเอกสาร) */
    money: z.enum(['credit', 'refund', 'none']).default('none'),
    refundMethod: z.enum(['original', 'bank_transfer']).default('bank_transfer'),
  })
  .strict();
export const SendLinkBody = z.object({ to: z.email().trim().toLowerCase().optional() }).strict();
export const ContactBody = z
  .object({
    channel: z.enum(['email', 'line', 'phone']),
    message: z.string().trim().max(2000).optional(),
    /** ผลการติดต่อ (บันทึกการโทร / ส่ง LINE เอง) */
    result: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((b) => b.channel !== 'phone' || !!b.result, { message: 'บันทึกผลการโทร', path: ['result'] });
export const ExtendBody = z.object({ dueDate: z.iso.date(), reason: Reason, notify: z.boolean().default(true) }).strict();
export const RefundBody = z
  .object({
    invoiceId: z.uuid(),
    amountSatang: z.number().int().positive(),
    method: z.enum(['original', 'bank_transfer']).default('bank_transfer'),
    reason: Reason,
    /** คืนเงินของรายการที่จ่ายซ้ำ (ปิดรายการในคิวกรณีผิดปกติไปด้วย) */
    paymentId: z.uuid().optional(),
  })
  .strict();
export const CreditGrantBody = z.object({ workspaceId: z.uuid(), amountSatang: z.number().int().positive(), reason: Reason, invoiceId: z.uuid().optional() }).strict();
export const TaxQuery = z.object({ month: Month.optional() });
export const RevenueQuery = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) });
export const CloseBody = z.object({ month: Month }).strict();
export const ExportQuery = z.object({ month: Month, type: z.enum(['sales', 'credit_notes', 'wht']).default('sales') });

/** ขั้นตอนเตือนอัตโนมัติหลังเลยกำหนด (วัน) · วันที่ 14 ระงับ */
export const DUNNING_STEPS = [
  { day: 1, step: 'reminder', key: 'd1' },
  { day: 3, step: 'reminder', key: 'd3' },
  { day: 7, step: 'final_notice', key: 'd7' },
  { day: 14, step: 'suspended', key: 'd14' },
] as const;
/** ขยายเวลาได้ไม่เกิน 30 วันจากวันครบกำหนดเดิม (B4) */
const MAX_EXTEND_DAYS = 30;

interface RefundPayload {
  [k: string]: unknown;
  invoiceId: string;
  amountSatang: number;
  method: 'original' | 'bank_transfer';
  reason: string;
  paymentId?: string;
  voidInvoice?: boolean;
}
interface CreditPayload {
  [k: string]: unknown;
  workspaceId: string;
  amountSatang: number;
  reason: string;
  invoiceId?: string;
  voidInvoice?: boolean;
}

/**
 * งานเงินฝั่งหลังบ้าน (O03): ใบแจ้งหนี้ ค้างชำระ ภาษี คืนเงิน / เครดิต / ใบลดหนี้ และรายงานรายได้
 * เงินของลูกค้าแก้ได้เฉพาะหลังบ้าน (RLS ฝั่งแอปห้าม) · ทุกการกระทำเขียน audit_logs ของ Workspace
 */
@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsBilling');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.register('billing.refund', (p, ctx) => this.applyRefund(ctx.requester, p as RefundPayload, ctx));
    this.approvals.register('billing.credit', (p, ctx) => this.applyCredit(ctx.requester, p as CreditPayload, ctx));
    // เตือนค้างชำระทุกชั่วโมง (ทำซ้ำได้ ไม่ส่งซ้ำ) · test เรียก runDunning เอง · ปิดด้วย OPS_JOBS=off
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.runDunning().catch((e) => this.log.error(`เตือนค้างชำระล้ม: ${String(e)}`)), 3_600_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }
  private async invoice(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบใบแจ้งหนี้');
    const [inv] = await this.db.select().from(s.invoices).where(eq(s.invoices.id, id));
    if (!inv) throw new AppError(404, 'not_found', 'ไม่พบใบแจ้งหนี้');
    return inv;
  }
  private async workspace(id: string) {
    const [ws] = await this.db.select().from(s.workspaces).where(eq(s.workspaces.id, id));
    if (!ws) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    return ws;
  }
  private payLink = (slug: string, invoiceId: string) => `${config.appUrl}/work/${slug}/billing?invoice=${invoiceId}`;

  // ---------------------------------------------------------------- ใบแจ้งหนี้

  async listInvoices(q: z.infer<typeof InvoicesQuery>) {
    const parts: SQL[] = [sql`true`];
    if (q.status === 'overdue') parts.push(sql`i.status in ('open', 'pending_review') and i.due_date < ${todayBkk()}::date`);
    else if (q.status) parts.push(sql`i.status = ${q.status}`);
    if (q.month) parts.push(sql`to_char(i.created_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${q.month}`);
    if (q.q) parts.push(sql`(i.number ilike ${`%${q.q}%`} or w.name ilike ${`%${q.q}%`} or i.po_number ilike ${`%${q.q}%`})`);
    const where = sql.join(parts, sql` and `);
    const items = await this.rows(sql`
      select i.id, i.number, i.status, i.subtotal::float8 as subtotal, i.vat::float8 as vat, i.total::float8 as total, i.wht_amount::float8 as "whtAmount", i.amount_due::float8 as "amountDue",
        i.po_number as "poNumber", i.due_date as "dueDate", i.paid_at as "paidAt", i.created_at as "createdAt",
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace,
        (select d.status from tax_documents d where d.invoice_id = i.id order by d.created_at desc limit 1) as "taxDocumentStatus",
        exists(select 1 from credit_notes c where c.invoice_id = i.id) as "hasCreditNote"
      from invoices i join workspaces w on w.id = i.workspace_id where ${where}
      order by i.created_at desc limit ${q.limit} offset ${q.offset}`);
    const [{ total }] = await this.rows<{ total: number }>(sql`select count(*)::int as total from invoices i join workspaces w on w.id = i.workspace_id where ${where}`);
    return { items, total, limit: q.limit, offset: q.offset };
  }

  /**
   * สร้างใบแจ้งหนี้ด้วยมือ (B1): สัญญารายปี ค่าบริการเพิ่ม หรือลูกค้าที่ใช้ PO · ชำระด้วยการโอน
   * เก็บรายการสินค้าไว้ใน `billing.checkout` แบบเดียวกับ API ลูกค้า (ใช้ต่ออายุแพ็กเกจเมื่อชำระ)
   */
  async createInvoice(staff: Staff, input: z.infer<typeof CreateInvoiceBody>) {
    const ws = await this.workspace(input.workspaceId);
    if (ws.status === 'pending_delete') throw new AppError(409, 'workspace_deleted', 'Workspace นี้ถูกลบแล้ว');
    const [sub] = await this.db.select().from(s.subscriptions).where(eq(s.subscriptions.workspaceId, ws.id));
    if (!sub) throw new AppError(409, 'no_subscription', 'Workspace นี้ยังไม่มีแพ็กเกจ');
    const [profile] = await this.db.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, ws.id));
    if (!profile) throw new AppError(422, 'billing_profile_required', 'ลูกค้ายังไม่ได้กรอกข้อมูลออกใบกำกับภาษี');
    if (input.plan && input.plan.periodEnd < input.plan.periodStart) throw new AppError(400, 'invalid_period', 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
    if (await this.isClosed(todayBkk().slice(0, 7))) throw new AppError(409, 'period_closed', 'งวดเดือนนี้ปิดแล้ว ออกเอกสารใหม่ไม่ได้');
    const gross = input.items.reduce((n, i) => n + i.qty * i.unitSatang, 0);
    const discount = Math.round((gross * input.discountPct) / 100);
    const subtotal = gross - discount;
    const vat = vatRegistered() ? Math.round(subtotal * 0.07) : 0;
    const total = subtotal + vat;
    const whtAmount = input.wht ? Math.round(subtotal * 0.03) : 0;
    const amountDue = total - whtAmount;
    if (amountDue <= 0) throw new AppError(422, 'amount_zero', 'ยอดชำระต้องมากกว่า 0');
    const start = todayBkk();
    const inv = await this.db.transaction(async (tx) => {
      const number = await nextNumber(tx, 'invoice', start);
      const [row] = await tx
        .insert(s.invoices)
        .values({
          workspaceId: ws.id, subscriptionId: sub.id, number,
          periodStart: input.plan?.periodStart ?? start, periodEnd: input.plan?.periodEnd ?? start,
          subtotal, vat, total, whtAmount, amountDue, poNumber: input.poNumber ?? null, status: 'open', dueDate: addDays(start, input.dueDays),
        })
        .returning();
      await tx.insert(s.payments).values({ workspaceId: ws.id, invoiceId: row.id, method: 'transfer', amount: amountDue });
      // รูปแบบเดียวกับ API ลูกค้า: แพ็กเกจ / รอบ / วิธีชำระ เป็น JSON (PDF และการต่ออายุอ่านจากแถวนี้)
      await tx.insert(s.auditLogs).values({
        workspaceId: ws.id, actorId: staff.id, actorKind: 'friday_staff', category: 'plan', action: 'billing.checkout', targetType: 'invoice', targetId: row.id,
        summary: JSON.stringify({ plan: input.plan?.code, cycle: input.plan?.cycle, method: 'transfer', wht: input.wht, manual: true, items: input.items, discountPct: input.discountPct, note: input.note, key: `ops-${randomUUID()}`, payload: '' }),
      });
      await audit(tx, staff, ws.id, 'plan', 'ops.invoice_created', `ออกใบแจ้งหนี้ ${number} ยอดชำระ ${baht(amountDue)}${input.poNumber ? ` · PO ${input.poNumber}` : ''}${input.plan ? ` · ต่ออายุ ${input.plan.code}` : ''}`, { type: 'invoice', id: row.id });
      if (input.send) await tx.insert(s.dunningEvents).values({ workspaceId: ws.id, invoiceId: row.id, step: 'invoice_sent', channel: 'email', byStaff: staff.id });
      return row;
    });
    let sent = 0;
    if (input.send) {
      sent = await mailAll(this.mail, await billingContacts(this.db, ws.id), `ใบแจ้งหนี้ ${inv.number} · Friday Manage`, [
        `ใบแจ้งหนี้ ${inv.number} ยอดชำระ ${baht(amountDue)} ครบกำหนด ${inv.dueDate}`,
        ...(input.poNumber ? [`อ้างอิง PO ${input.poNumber}`] : []),
        ...(input.note ? [input.note] : []),
        `ดูและชำระได้ที่ ${this.payLink(ws.slug, inv.id)}`,
      ].join('\n'));
    }
    return { invoice: { id: inv.id, number: inv.number, subtotal, vat, total, whtAmount, amountDue, dueDate: inv.dueDate, status: inv.status }, sent };
  }

  /**
   * ยกเลิกใบแจ้งหนี้ (B2) · ยังไม่ชำระ = void เฉย ๆ · ชำระแล้ว = ออกใบลดหนี้อ้างใบเดิม (ไม่ลบใบเดิม)
   * แล้วจัดการเงิน: เครดิต (ตามวงเงินเครดิต) / คืนเงิน (ตามวงเงินคืนเงิน) / ไม่คืน (เอกสารซ้ำ)
   */
  async voidInvoice(staff: Staff, id: string, input: z.infer<typeof VoidBody>) {
    const inv = await this.invoice(id);
    if (inv.status === 'void') throw new AppError(409, 'already_void', 'ใบแจ้งหนี้นี้ยกเลิกแล้ว');
    if (inv.status !== 'paid') {
      if (inv.status === 'pending_review' && (await isGrantSource(this.db as unknown as Tx, inv))) throw new AppError(409, 'invoice_in_review', 'ใบนี้เปิดแพ็กเกจระหว่างรอตรวจสลิป · ปฏิเสธสลิปในคิวก่อน');
      await this.db.transaction(async (tx) => {
        await tx.update(s.invoices).set({ status: 'void', updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
        await tx.update(s.payments).set({ status: 'rejected', reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(and(eq(s.payments.invoiceId, inv.id), eq(s.payments.status, 'pending_review')));
        await audit(tx, staff, inv.workspaceId, 'plan', 'ops.invoice_voided', `ยกเลิกใบแจ้งหนี้ ${inv.number} (ยังไม่ชำระ) · ${input.reason}`, { type: 'invoice', id: inv.id });
      });
      return { id: inv.id, status: 'void' as const, creditNote: null };
    }
    const paid = await this.refundable(inv);
    if (input.money === 'refund') return this.requestRefund(staff, { invoiceId: inv.id, amountSatang: paid, method: input.refundMethod, reason: input.reason }, true);
    if (input.money === 'credit') return this.requestCredit(staff, { workspaceId: inv.workspaceId, amountSatang: paid, reason: input.reason, invoiceId: inv.id }, true);
    const note = await this.db.transaction(async (tx) => {
      const cn = await this.creditNote(tx, staff, inv, 'void', inv.amountDue, input.reason);
      await tx.update(s.invoices).set({ status: 'void', updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.invoice_voided', `ยกเลิกใบแจ้งหนี้ ${inv.number} · ออกใบลดหนี้ ${cn.number} (ไม่คืนเงิน) · ${input.reason}`, { type: 'invoice', id: inv.id });
      return cn;
    });
    return { id: inv.id, status: 'void' as const, creditNote: { id: note.id, number: note.number } };
  }

  /** ยอดที่ยังคืน / ลดหนี้ได้ = ยอดที่ลูกค้าจ่าย − ใบลดหนี้ที่ออกไปแล้ว */
  private async refundable(inv: Invoice) {
    const [r] = await this.rows<{ used: number }>(sql`select coalesce(sum(amount_satang + vat_satang), 0)::float8 as used from credit_notes where invoice_id = ${inv.id}`);
    return Math.max(0, inv.amountDue - Number(r.used));
  }

  /** ใบลดหนี้: แยกยอดก่อน VAT / VAT ตามสัดส่วนของใบเดิม · เลข CN- ต่อเนื่องทั้งระบบ */
  private async creditNote(tx: Tx, staff: Staff, inv: Invoice, kind: 'refund' | 'credit' | 'void', cash: number, reason: string, extra: { refundMethod?: string; approvalId?: string } = {}) {
    const ratio = inv.amountDue > 0 ? cash / inv.amountDue : 1;
    const vat = Math.round(inv.vat * ratio);
    const amount = Math.max(1, Math.round(inv.subtotal * ratio));
    const number = await nextNumber(tx, 'credit_note');
    const [cn] = await tx
      .insert(s.creditNotes)
      .values({ workspaceId: inv.workspaceId, invoiceId: inv.id, number, kind, amountSatang: amount, vatSatang: vat, reason, status: 'issued', refundMethod: extra.refundMethod ?? null, createdByStaff: staff.id, approvalRequestId: extra.approvalId ?? null, issuedAt: new Date() })
      .returning();
    return cn;
  }

  /** ส่งลิงก์จ่ายเงิน (B5) · ลิงก์ไปหน้าเรียกเก็บเงินของลูกค้า (จ่าย QR / บัตรเมื่อเปิด Gateway ใน A35b) */
  async sendLink(staff: Staff, id: string, input: z.infer<typeof SendLinkBody>) {
    const inv = await this.invoice(id);
    if (inv.status === 'paid' || inv.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว', { status: inv.status });
    const ws = await this.workspace(inv.workspaceId);
    const contacts = await billingContacts(this.db, ws.id);
    // ส่งได้เฉพาะผู้ติดต่อเรื่องเงินของลูกค้า (กันพิมพ์อีเมลผิดแล้วข้อมูลรั่ว)
    if (input.to && !contacts.includes(input.to)) throw new AppError(422, 'recipient_not_contact', 'ส่งได้เฉพาะ Owner / Admin หรืออีเมลรับใบกำกับภาษีของลูกค้า', { contacts });
    const link = this.payLink(ws.slug, inv.id);
    const sent = await mailAll(this.mail, input.to ? [input.to] : contacts, `ลิงก์ชำระใบแจ้งหนี้ ${inv.number} · Friday Manage`, `ยอดชำระ ${baht(inv.amountDue)} ครบกำหนด ${inv.dueDate}\nชำระได้ที่ ${link}`);
    await this.db.transaction(async (tx) => {
      await tx.insert(s.dunningEvents).values({ workspaceId: ws.id, invoiceId: inv.id, step: 'reminder', channel: 'email', result: 'payment_link', byStaff: staff.id });
      await audit(tx, staff, ws.id, 'plan', 'ops.payment_link_sent', `ส่งลิงก์ชำระ ${inv.number} ถึง ${sent} อีเมล`, { type: 'invoice', id: inv.id });
    });
    return { link, sent };
  }

  // ---------------------------------------------------------------- ค้างชำระ

  /** ใบที่เลยกำหนดและยังไม่ได้รับเงิน (ไม่นับใบที่แนบสลิปรอตรวจ) */
  private overdueRows(extra: SQL = sql`true`) {
    return this.rows<Row>(sql`
      select i.id, i.number, i.workspace_id as "workspaceId", i.amount_due::float8 as "amountDue", i.due_date as "dueDate", i.status,
        (${todayBkk()}::date - i.due_date)::int as "daysOverdue",
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name, 'status', w.status) as workspace,
        sub.cycle, sub.status as "subStatus"
      from invoices i join workspaces w on w.id = i.workspace_id left join subscriptions sub on sub.workspace_id = i.workspace_id
      where i.status in ('open', 'pending_review') and i.due_date < ${todayBkk()}::date and w.deleted_at is null
        and not exists (select 1 from payments p where p.invoice_id = i.id and p.status = 'pending_review' and p.slip_file_key is not null)
        and ${extra}
      order by i.due_date`);
  }

  async overdue() {
    const rows = await this.overdueRows();
    const ids = rows.map((r) => r.id as string);
    const events = ids.length ? await this.db.select().from(s.dunningEvents).where(inArray(s.dunningEvents.invoiceId, ids)).orderBy(s.dunningEvents.createdAt) : [];
    const items = await Promise.all(
      rows.map(async (r) => {
        const days = Number(r.daysOverdue);
        const ev = events.filter((e) => e.invoiceId === r.id);
        const next = DUNNING_STEPS.find((st) => st.day > days || !ev.some((e) => e.result?.split(':')[0] === st.key));
        return {
          ...r,
          events: ev.map((e) => ({ at: e.createdAt, step: e.step, channel: e.channel, result: e.result, byStaff: e.byStaff })),
          reminders: { email: ev.filter((e) => e.channel === 'email').length, line: ev.filter((e) => e.channel === 'line').length, phone: ev.filter((e) => e.channel === 'phone').length },
          nextStep: next ? { day: next.day, step: next.step, on: addDays(String(r.dueDate).slice(0, 10), next.day) } : null,
          /** คนเข้ามาเมื่อเกิน 7 วันหรือเป็นลูกค้ารายปี (หน้าจอ: ค้างชำระ) */
          needsHuman: days > 7 || r.cycle === 'yearly',
          contacts: await billingContacts(this.db, r.workspaceId as string),
        };
      }),
    );
    return { items, totalSatang: rows.reduce((n, r) => n + Number(r.amountDue), 0), steps: DUNNING_STEPS };
  }

  /** ติดต่อลูกค้าค้างชำระ (B3) · อีเมลส่งจริง · LINE / โทร บันทึกผล (หลังบ้านยังส่ง LINE ไม่ได้) */
  async contact(staff: Staff, id: string, input: z.infer<typeof ContactBody>) {
    const inv = await this.invoice(id);
    if (inv.status === 'paid' || inv.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว', { status: inv.status });
    const ws = await this.workspace(inv.workspaceId);
    let result = input.result ?? null;
    if (input.channel === 'email') {
      const sent = await mailAll(this.mail, await billingContacts(this.db, ws.id), `แจ้งเตือนใบแจ้งหนี้ ${inv.number} เลยกำหนดชำระ`, input.message ?? `ใบแจ้งหนี้ ${inv.number} ยอด ${baht(inv.amountDue)} เลยกำหนดชำระ (${inv.dueDate})\nชำระได้ที่ ${this.payLink(ws.slug, inv.id)}\nหากชำระแล้วไม่ต้องทำอะไรเพิ่ม`);
      result = `sent ${sent}`;
    }
    await this.db.transaction(async (tx) => {
      await tx.insert(s.dunningEvents).values({ workspaceId: ws.id, invoiceId: inv.id, step: input.channel === 'phone' ? 'call' : 'reminder', channel: input.channel, result, byStaff: staff.id });
      await audit(tx, staff, ws.id, 'plan', 'ops.dunning_contact', `ติดต่อเรื่องค้างชำระ ${inv.number} ทาง${input.channel === 'email' ? 'อีเมล' : input.channel === 'line' ? ' LINE' : 'โทรศัพท์'}${input.result ? ` · ${input.result}` : ''}`, { type: 'invoice', id: inv.id });
    });
    return { id: inv.id, channel: input.channel, result };
  }

  /** ขยายเวลาชำระ (B4): เลื่อนวันครบกำหนด → หยุดเตือนและเลื่อนวันระงับไปด้วย (นับจากวันครบกำหนดใหม่) */
  async extend(staff: Staff, id: string, input: z.infer<typeof ExtendBody>) {
    const inv = await this.invoice(id);
    if (inv.status === 'paid' || inv.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว', { status: inv.status });
    const [first] = await this.db.select({ result: s.dunningEvents.result }).from(s.dunningEvents).where(and(eq(s.dunningEvents.invoiceId, inv.id), eq(s.dunningEvents.step, 'extended'))).orderBy(s.dunningEvents.createdAt).limit(1);
    const original = first?.result?.slice(0, 10) ?? inv.dueDate;
    if (input.dueDate <= inv.dueDate) throw new AppError(422, 'due_date_not_later', 'วันครบกำหนดใหม่ต้องหลังวันเดิม', { dueDate: inv.dueDate });
    const max = addDays(original, MAX_EXTEND_DAYS);
    if (input.dueDate > max) throw new AppError(422, 'extend_too_long', `ขยายได้ไม่เกิน ${MAX_EXTEND_DAYS} วันจากวันครบกำหนดเดิม (ถึง ${max})`, { max });
    await this.db.transaction(async (tx) => {
      await tx.update(s.invoices).set({ dueDate: input.dueDate, updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      await tx.insert(s.dunningEvents).values({ workspaceId: inv.workspaceId, invoiceId: inv.id, step: 'extended', channel: 'system', result: `${inv.dueDate}→${input.dueDate}`, byStaff: staff.id });
      // ค้างชำระเพราะใบนี้ใบเดียว → กลับเป็นปกติระหว่างรอ
      await tx.execute(sql`
        update subscriptions set status = 'active', updated_at = now()
        where workspace_id = ${inv.workspaceId} and status = 'past_due'
          and not exists (select 1 from invoices i where i.workspace_id = ${inv.workspaceId} and i.id <> ${inv.id} and i.status in ('open', 'pending_review') and i.due_date < ${todayBkk()}::date)`);
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.due_date_extended', `ขยายเวลาชำระ ${inv.number} ${inv.dueDate} → ${input.dueDate} · ${input.reason}`, { type: 'invoice', id: inv.id });
    });
    if (input.notify) await mailAll(this.mail, await billingContacts(this.db, inv.workspaceId), `ขยายเวลาชำระใบแจ้งหนี้ ${inv.number}`, `ครบกำหนดใหม่ ${input.dueDate}`);
    return { id: inv.id, dueDate: input.dueDate, previous: inv.dueDate };
  }

  /**
   * เตือนค้างชำระอัตโนมัติ: วันที่ 1, 3 (เตือน) · 7 (เตือนครั้งสุดท้าย) · 14 (ระงับ Workspace)
   * ทำซ้ำได้: แต่ละขั้นบันทึกใน dunning_events (result = d1/d3/d7/d14) ครั้งเดียว · งานหยุดไปหลายวันจะทำเฉพาะขั้นล่าสุด
   */
  async runDunning() {
    const done: { invoice: string; step: string }[] = [];
    for (const r of await this.overdueRows()) {
      const days = Number(r.daysOverdue);
      const events = await this.db.select({ result: s.dunningEvents.result }).from(s.dunningEvents).where(eq(s.dunningEvents.invoiceId, r.id as string));
      // ขั้นที่ข้ามไปบันทึกเป็น `d1:skipped` เพื่อไม่ส่งย้อนหลัง แต่นับว่าทำแล้ว
      const due = DUNNING_STEPS.filter((st) => st.day <= days && !events.some((e) => e.result?.split(':')[0] === st.key));
      if (!due.length) continue;
      const latest = due[due.length - 1];
      const ws = r.workspace as { id: string; slug: string; name: string; status: string };
      await this.db.transaction(async (tx) => {
        for (const st of due) {
          await tx.insert(s.dunningEvents).values({ workspaceId: ws.id, invoiceId: r.id as string, step: st.step, channel: st === latest ? (st.step === 'suspended' ? 'system' : 'email') : 'system', result: st === latest ? st.key : `${st.key}:skipped` });
        }
        // เลยกำหนด = ค้างชำระ (ฝั่งลูกค้าเห็นแถบเตือน)
        await tx.update(s.subscriptions).set({ status: 'past_due', updatedAt: new Date() }).where(and(eq(s.subscriptions.workspaceId, ws.id), eq(s.subscriptions.status, 'active')));
        if (latest.step === 'suspended' && ws.status !== 'suspended' && ws.status !== 'pending_delete') {
          await tx.update(s.workspaces).set({ status: 'suspended', updatedAt: new Date() }).where(eq(s.workspaces.id, ws.id));
          await tx.insert(s.auditLogs).values({ workspaceId: ws.id, actorKind: 'system', category: 'secu', action: 'billing.suspended_overdue', targetType: 'invoice', targetId: r.id as string, summary: `ระงับเพราะค้างชำระ ${r.number} เกิน 14 วัน` });
        }
      });
      const contacts = await billingContacts(this.db, ws.id);
      const link = this.payLink(ws.slug, r.id as string);
      const text =
        latest.step === 'suspended'
          ? `Workspace ${ws.name} ถูกระงับเพราะใบแจ้งหนี้ ${r.number} เลยกำหนด ${days} วัน\nข้อมูลทั้งหมดยังอยู่ครบ ชำระแล้วทีมจะเปิดให้ใช้งานต่อ: ${link}`
          : `ใบแจ้งหนี้ ${r.number} ยอด ${baht(Number(r.amountDue))} เลยกำหนด ${days} วัน${latest.step === 'final_notice' ? `\nบัญชีจะถูกระงับในวันที่ ${addDays(String(r.dueDate).slice(0, 10), 14)} หากยังไม่ชำระ` : ''}\nชำระได้ที่ ${link}`;
      await mailAll(this.mail, contacts, latest.step === 'suspended' ? `Workspace ${ws.name} ถูกระงับ` : `ใบแจ้งหนี้ ${r.number} เลยกำหนดชำระ`, text);
      done.push({ invoice: r.number as string, step: latest.key });
    }
    if (done.length) this.log.log(`เตือนค้างชำระ ${done.length} รายการ`);
    return { processed: done };
  }

  // ---------------------------------------------------------------- ภาษี

  async tax(q: z.infer<typeof TaxQuery>) {
    const month = q.month ?? todayBkk().slice(0, 7);
    const etax = await this.rows(sql`
      select d.id, d.number, d.doc_type as "docType", d.status, d.provider_ref as "providerRef", d.created_at as "createdAt", i.number as invoice,
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace
      from tax_documents d join invoices i on i.id = d.invoice_id join workspaces w on w.id = d.workspace_id
      where d.status = 'failed' or (d.status = 'pending' and d.created_at < now() - interval '1 hour')
      order by d.created_at`);
    const wht = await this.rows(sql`
      select i.id, i.number, i.wht_amount::float8 as "whtAmount", i.paid_at as "paidAt", (${todayBkk()}::date - (i.paid_at at time zone 'Asia/Bangkok')::date)::int as "daysSincePaid",
        (select c.status from wht_certificates c where c.invoice_id = i.id order by c.created_at desc limit 1) as "certificateStatus",
        (select c.id from wht_certificates c where c.invoice_id = i.id order by c.created_at desc limit 1) as "certificateId",
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace
      from invoices i join workspaces w on w.id = i.workspace_id
      where i.status = 'paid' and i.wht_amount > 0
        and not exists (select 1 from wht_certificates c where c.invoice_id = i.id and c.status = 'confirmed')
      order by i.paid_at`);
    const [sales] = await this.rows<Row>(sql`
      select count(*)::int as invoices, coalesce(sum(subtotal), 0)::float8 as subtotal, coalesce(sum(vat), 0)::float8 as vat, coalesce(sum(wht_amount), 0)::float8 as wht
      from invoices where status = 'paid' and to_char(paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${month}`);
    const [cn] = await this.rows<Row>(sql`
      select count(*)::int as notes, coalesce(sum(amount_satang), 0)::float8 as amount, coalesce(sum(vat_satang), 0)::float8 as vat
      from credit_notes where to_char(issued_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${month}`);
    return {
      etax,
      wht,
      whtPendingSatang: wht.reduce((n, w) => n + Number(w.whtAmount), 0),
      salesVat: { month, vatRegistered: vatRegistered(), invoices: sales.invoices, subtotalSatang: sales.subtotal, vatSatang: sales.vat, whtSatang: sales.wht, creditNotes: cn.notes, creditNoteVatSatang: cn.vat, netVatSatang: Number(sales.vat) - Number(cn.vat) },
    };
  }

  /** ส่ง e-Tax ใหม่: ตั้งกลับเป็น pending ให้งานกวาดของ API ลูกค้าส่งซ้ำ */
  async retryTaxDocument(staff: Staff, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบใบกำกับภาษี');
    const [d] = await this.db.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, id));
    if (!d) throw new AppError(404, 'not_found', 'ไม่พบใบกำกับภาษี');
    if (d.status !== 'failed') throw new AppError(409, 'not_failed', 'ส่งใหม่ได้เฉพาะใบที่ส่งไม่สำเร็จ', { status: d.status });
    await this.db.transaction(async (tx) => {
      await tx.update(s.taxDocuments).set({ status: 'pending', providerRef: null, createdAt: new Date(Date.now() - 2 * 60_000), updatedAt: new Date() }).where(eq(s.taxDocuments.id, id));
      await audit(tx, staff, d.workspaceId, 'plan', 'ops.etax_retry', `ส่ง e-Tax ใหม่ ${d.number}`, { type: 'tax_document', id });
    });
    return { id, status: 'pending' as const };
  }

  // ---------------------------------------------------------------- คืนเงิน / เครดิต

  async refunds() {
    const pending = await this.db
      .select({ r: s.approvalRequests, requester: s.staffUsers.name })
      .from(s.approvalRequests)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.approvalRequests.requestedBy))
      .where(and(inArray(s.approvalRequests.kind, ['billing.refund', 'billing.credit']), eq(s.approvalRequests.status, 'pending')))
      .orderBy(s.approvalRequests.createdAt);
    const history = await this.rows(sql`
      select * from (
        select c.id, c.issued_at as "at", c.kind as type, c.number as ref, c.reason, (c.amount_satang + c.vat_satang)::float8 as "amountSatang", c.refund_method as "refundMethod",
          st.name as "requestedBy", ap.name as "approvedBy", c.status, json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace, i.number as invoice
        from credit_notes c join workspaces w on w.id = c.workspace_id join invoices i on i.id = c.invoice_id
          left join staff_users st on st.id = c.created_by_staff left join approval_requests a on a.id = c.approval_request_id left join staff_users ap on ap.id = a.decided_by
        union all
        select k.id, k.created_at, 'goodwill_credit', null, k.note, k.amount_satang::float8, null, st.name, null, 'issued', json_build_object('id', w.id, 'slug', w.slug, 'name', w.name), null
        from workspace_credits k join workspaces w on w.id = k.workspace_id left join staff_users st on st.id = k.created_by_staff where k.source in ('goodwill', 'overpayment')
      ) x order by "at" desc limit 100`);
    return { pending: pending.map(({ r, requester }) => ({ id: r.id, kind: r.kind, workspaceId: r.workspaceId, amountSatang: r.amountSatang, reason: r.reason, requestedBy: requester, createdAt: r.createdAt, expiresAt: r.expiresAt, payload: r.payload })), history };
  }

  /** ขอคืนเงิน · เกินวงเงินหรือชำระมาเกิน 30 วันต้องอนุมัติ (06 › 3) */
  async requestRefund(staff: Staff, input: z.infer<typeof RefundBody>, voidInvoice = false) {
    const inv = await this.invoice(input.invoiceId);
    if (inv.status !== 'paid') throw new AppError(409, 'invoice_not_paid', 'คืนเงินได้เฉพาะใบแจ้งหนี้ที่ชำระแล้ว', { status: inv.status });
    const max = await this.refundable(inv);
    if (input.amountSatang > max) throw new AppError(422, 'refund_exceeds_paid', `คืนได้ไม่เกิน ${baht(max)}`, { maxSatang: max });
    if (input.paymentId) {
      const [p] = await this.db.select().from(s.payments).where(eq(s.payments.id, input.paymentId));
      if (!p || p.invoiceId !== inv.id || p.exceptionReason !== 'double_payment') throw new AppError(422, 'payment_not_double', 'ใช้ paymentId ได้เฉพาะรายการจ่ายซ้ำของใบแจ้งหนี้นี้');
    }
    const old = !inv.paidAt || Date.now() - inv.paidAt.getTime() > 30 * DAY;
    const payload: RefundPayload = { invoiceId: inv.id, amountSatang: input.amountSatang, method: input.method, reason: input.reason, paymentId: input.paymentId, voidInvoice };
    const pending = await this.approvals.gate(staff, {
      kind: 'billing.refund', workspaceId: inv.workspaceId, target: { type: 'invoice', id: inv.id }, payload, amountSatang: input.amountSatang, reason: input.reason,
      exceeds: input.amountSatang > staff.limits.refundSatang || old,
      rule: `คืนเงินเกิน ${baht(staff.limits.refundSatang)} หรือเกิน 30 วันหลังชำระ`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyRefund(staff, payload);
  }

  private async applyRefund(staff: Staff, p: RefundPayload, ctx?: ApprovalContext) {
    const inv = await this.invoice(p.invoiceId);
    if (inv.status !== 'paid') throw new AppError(409, 'invoice_not_paid', 'ใบแจ้งหนี้นี้ไม่ได้อยู่ในสถานะชำระแล้ว', { status: inv.status });
    if (p.amountSatang > (await this.refundable(inv))) throw new AppError(422, 'refund_exceeds_paid', 'ยอดคืนเกินยอดที่ยังคืนได้');
    const cn = await this.db.transaction(async (tx) => {
      const note = await this.creditNote(tx, staff, inv, 'refund', p.amountSatang, p.reason, { refundMethod: p.method, approvalId: ctx?.requestId });
      if (p.voidInvoice) await tx.update(s.invoices).set({ status: 'void', updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      if (p.paymentId) await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'staff', exceptionReason: null, reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(s.payments.id, p.paymentId));
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.refund_issued', `คืนเงิน ${baht(p.amountSatang)} (${inv.number}) · ใบลดหนี้ ${note.number} · ${p.method === 'original' ? 'คืนช่องทางเดิม' : 'โอนคืน'}${p.voidInvoice ? ' · ยกเลิกใบแจ้งหนี้' : ''} · ${p.reason}`, { type: 'credit_note', id: note.id }, approvalOf(ctx));
      return note;
    });
    await mailAll(this.mail, await billingContacts(this.db, inv.workspaceId), `ใบลดหนี้ ${cn.number} · คืนเงิน ${baht(p.amountSatang)}`, `อ้างถึงใบแจ้งหนี้ ${inv.number}\nเหตุผล: ${p.reason}\nทีมการเงินจะคืนเงิน${p.method === 'original' ? 'ผ่านช่องทางเดิม' : 'ทางการโอน'}ภายใน 7 วันทำการ`);
    return { creditNote: { id: cn.id, number: cn.number, kind: cn.kind, amountSatang: cn.amountSatang, vatSatang: cn.vatSatang }, invoiceStatus: p.voidInvoice ? 'void' : inv.status };
  }

  /** ให้เครดิต · ผูกใบแจ้งหนี้ที่ชำระแล้ว = ออกใบลดหนี้ด้วย · ไม่ผูก = เครดิตน้ำใจ · เกินวงเงินต้องอนุมัติ */
  async requestCredit(staff: Staff, input: z.infer<typeof CreditGrantBody>, voidInvoice = false) {
    await this.workspace(input.workspaceId);
    if (input.invoiceId) {
      const inv = await this.invoice(input.invoiceId);
      if (inv.workspaceId !== input.workspaceId) throw new AppError(422, 'invoice_other_workspace', 'ใบแจ้งหนี้นี้เป็นของ Workspace อื่น');
      if (inv.status !== 'paid') throw new AppError(409, 'invoice_not_paid', 'ออกใบลดหนี้ได้เฉพาะใบที่ชำระแล้ว');
      if (input.amountSatang > (await this.refundable(inv))) throw new AppError(422, 'credit_exceeds_paid', 'ยอดเครดิตเกินยอดที่ชำระ');
    }
    const payload: CreditPayload = { ...input, voidInvoice };
    const pending = await this.approvals.gate(staff, {
      kind: 'billing.credit', workspaceId: input.workspaceId, target: input.invoiceId ? { type: 'invoice', id: input.invoiceId } : { type: 'workspace', id: input.workspaceId }, payload, amountSatang: input.amountSatang, reason: input.reason,
      exceeds: input.amountSatang > staff.limits.creditSatang,
      rule: `ให้เครดิตเกิน ${baht(staff.limits.creditSatang)}`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyCredit(staff, payload);
  }

  private async applyCredit(staff: Staff, p: CreditPayload, ctx?: ApprovalContext) {
    const inv = p.invoiceId ? await this.invoice(p.invoiceId) : null;
    const result = await this.db.transaction(async (tx) => {
      const note = inv ? await this.creditNote(tx, staff, inv, 'credit', p.amountSatang, p.reason, { approvalId: ctx?.requestId }) : null;
      await tx.insert(s.workspaceCredits).values({ workspaceId: p.workspaceId, amountSatang: p.amountSatang, source: note ? 'credit_note' : 'goodwill', creditNoteId: note?.id ?? null, invoiceId: inv?.id ?? null, note: p.reason, createdByStaff: staff.id });
      if (inv && p.voidInvoice) await tx.update(s.invoices).set({ status: 'void', updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      await audit(tx, staff, p.workspaceId, 'plan', 'ops.credit_granted', `ให้เครดิต ${baht(p.amountSatang)}${note ? ` · ใบลดหนี้ ${note.number} (${inv!.number})` : ''}${p.voidInvoice ? ' · ยกเลิกใบแจ้งหนี้' : ''} · ${p.reason}`, note ? { type: 'credit_note', id: note.id } : { type: 'workspace', id: p.workspaceId }, approvalOf(ctx));
      return note;
    });
    const [bal] = await this.rows<{ b: number }>(sql`select coalesce(sum(amount_satang), 0)::float8 as b from workspace_credits where workspace_id = ${p.workspaceId}`);
    await mailAll(this.mail, await billingContacts(this.db, p.workspaceId), `คุณได้รับเครดิต ${baht(p.amountSatang)} · Friday Manage`, `เหตุผล: ${p.reason}\nเครดิตคงเหลือ ${baht(Number(bal.b))} ใช้หักรอบถัดไปอัตโนมัติ`);
    return { creditSatang: p.amountSatang, balanceSatang: Number(bal.b), creditNote: result ? { id: result.id, number: result.number } : null };
  }

  // ---------------------------------------------------------------- รายงานรายได้ / ปิดงวด / ส่งออก

  private async closedMonths() {
    const rows = await this.db.select({ month: s.staffAuditLogs.reason }).from(s.staffAuditLogs).where(eq(s.staffAuditLogs.action, 'billing.period_closed'));
    return new Set(rows.map((r) => r.month ?? ''));
  }
  private async isClosed(month: string) {
    return (await this.closedMonths()).has(month);
  }

  /**
   * รายงานรายได้รายเดือน: รับรู้รายได้ตามเดือนที่ให้บริการ (รายปีกระจาย 12 เดือน) · เงินสดรับ · VAT ขาย · ถูกหัก ณ ที่จ่าย
   * ค่าธรรมเนียมรับเงิน (cost_rates) · คืนเงิน / ลดหนี้ · รายได้รับล่วงหน้าคงเหลือ
   */
  async revenue(q: z.infer<typeof RevenueQuery>) {
    const now = todayBkk().slice(0, 7);
    const months: string[] = [];
    for (let i = q.months - 1; i >= 0; i--) {
      const d = new Date(`${now}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const paid = await this.rows<{ subtotal: number; vat: number; wht: number; due: number; ps: string; pe: string; paidMonth: string; method: string | null }>(sql`
      select i.subtotal::float8 as subtotal, i.vat::float8 as vat, i.wht_amount::float8 as wht, i.amount_due::float8 as due,
        to_char(i.period_start, 'YYYY-MM-DD') as ps, to_char(i.period_end, 'YYYY-MM-DD') as pe, to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') as "paidMonth",
        (select p.method::text from payments p where p.invoice_id = i.id and p.status = 'confirmed' order by p.updated_at desc limit 1) as method
      from invoices i where i.paid_at is not null and i.status in ('paid', 'void')`);
    const notes = await this.rows<{ month: string; total: number }>(sql`select to_char(issued_at at time zone 'Asia/Bangkok', 'YYYY-MM') as month, (amount_satang + vat_satang)::float8 as total from credit_notes where issued_at is not null`);
    const rates = await this.db.select().from(s.costRates).orderBy(desc(s.costRates.effectiveFrom));
    const pct = (resource: string) => Number(rates.find((r) => r.resource === resource)?.pct ?? 0);
    const closed = await this.closedMonths();
    // แต่ละใบกระจายรายได้ตามจำนวนเดือนของรอบ (รายเดือน = 1, รายปี = 12)
    const spread = paid.map((i) => {
      const days = (Date.parse(i.pe) - Date.parse(i.ps)) / DAY + 1;
      const n = Math.max(1, Math.round(days / 30.4));
      const start = i.ps.slice(0, 7);
      const list: string[] = [];
      for (let k = 0; k < n; k++) {
        const d = new Date(`${start}-01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + k);
        list.push(d.toISOString().slice(0, 7));
      }
      return { ...i, per: i.subtotal / n, list };
    });
    const rows = months.map((m) => {
      const recognized = spread.reduce((n, i) => n + (i.list.includes(m) ? i.per : 0), 0);
      const inMonth = paid.filter((i) => i.paidMonth === m);
      // รับล่วงหน้าคงเหลือ ณ สิ้นเดือน = เงินที่รับแล้วแต่ยังไม่ถึงเดือนให้บริการ
      const deferred = spread.filter((i) => i.paidMonth <= m).reduce((n, i) => n + i.per * i.list.filter((x) => x > m).length, 0);
      return {
        month: m,
        recognizedSatang: Math.round(recognized),
        cashSatang: inMonth.reduce((n, i) => n + i.due, 0),
        vatSatang: inMonth.reduce((n, i) => n + i.vat, 0),
        whtSatang: inMonth.reduce((n, i) => n + i.wht, 0),
        feesSatang: Math.round(inMonth.reduce((n, i) => n + (i.method === 'card' ? (i.due * pct('payment_fee_card')) / 100 : i.method === 'promptpay' ? (i.due * pct('payment_fee_promptpay')) / 100 : 0), 0)),
        refundsSatang: notes.filter((c) => c.month === m).reduce((n, c) => n + c.total, 0),
        deferredSatang: Math.round(deferred),
        closed: closed.has(m),
      };
    });
    return { months: rows };
  }

  /** ปิดงวด: เดือนที่จบแล้วเท่านั้น · ปิดแล้วแก้ไม่ได้ (รายการย้อนหลังออกเป็นใบลดหนี้ / เพิ่มหนี้ในเดือนปัจจุบัน) */
  async close(staff: Staff, input: z.infer<typeof CloseBody>) {
    if (input.month >= todayBkk().slice(0, 7)) throw new AppError(422, 'month_not_ended', 'ปิดได้เฉพาะเดือนที่จบแล้ว');
    if (await this.isClosed(input.month)) throw new AppError(409, 'already_closed', 'งวดนี้ปิดแล้ว');
    await staffAudit(this.db, staff, 'billing.period_closed', input.month);
    return { month: input.month, closed: true };
  }

  /** ส่งออกให้สำนักงานบัญชี (B8) เป็น CSV (มี BOM ให้ Excel อ่านภาษาไทยได้) · งวดที่ยังไม่ปิด = ฉบับร่าง */
  async export(q: z.infer<typeof ExportQuery>) {
    const esc = (v: unknown) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const money = (v: unknown) => (Number(v ?? 0) / 100).toFixed(2);
    let header: string[] = [];
    let lines: unknown[][] = [];
    if (q.type === 'sales') {
      header = ['เลขที่ใบแจ้งหนี้', 'เลขที่ใบกำกับ / ใบเสร็จ', 'วันที่ชำระ', 'ลูกค้า', 'เลขผู้เสียภาษี', 'สาขา', 'ก่อน VAT', 'VAT', 'รวม', 'หัก ณ ที่จ่าย', 'รับชำระ', 'ช่องทาง', 'สถานะ'];
      const rows = await this.rows<Row>(sql`
        select i.number, (select d.number from tax_documents d where d.invoice_id = i.id order by d.created_at limit 1) as doc,
          to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as paid, b.company_name, b.tax_id, b.branch_type, b.branch_no,
          i.subtotal, i.vat, i.total, i.wht_amount, i.amount_due, (select p.method::text from payments p where p.invoice_id = i.id and p.status = 'confirmed' limit 1) as method, i.status
        from invoices i left join billing_profiles b on b.workspace_id = i.workspace_id
        where i.paid_at is not null and to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${q.month} order by i.number`);
      lines = rows.map((r) => [r.number, r.doc, r.paid, r.company_name, r.tax_id, r.branch_type === 'head' ? 'สำนักงานใหญ่' : r.branch_no, money(r.subtotal), money(r.vat), money(r.total), money(r.wht_amount), money(r.amount_due), r.method, r.status]);
    } else if (q.type === 'credit_notes') {
      header = ['เลขที่ใบลดหนี้', 'อ้างถึงใบแจ้งหนี้', 'วันที่', 'ลูกค้า', 'เลขผู้เสียภาษี', 'ประเภท', 'ก่อน VAT', 'VAT', 'รวม', 'เหตุผล'];
      const rows = await this.rows<Row>(sql`
        select c.number, i.number as invoice, to_char(c.issued_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as date, b.company_name, b.tax_id, c.kind, c.amount_satang, c.vat_satang, c.reason
        from credit_notes c join invoices i on i.id = c.invoice_id left join billing_profiles b on b.workspace_id = c.workspace_id
        where to_char(c.issued_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${q.month} order by c.number`);
      lines = rows.map((r) => [r.number, r.invoice, r.date, r.company_name, r.tax_id, r.kind, money(r.amount_satang), money(r.vat_satang), money(Number(r.amount_satang) + Number(r.vat_satang)), r.reason]);
    } else {
      header = ['ใบแจ้งหนี้', 'วันที่ชำระ', 'ลูกค้า', 'เลขผู้เสียภาษี', 'ภาษีที่ถูกหัก', 'สถานะ 50 ทวิ'];
      const rows = await this.rows<Row>(sql`
        select i.number, to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as paid, b.company_name, b.tax_id, i.wht_amount,
          coalesce((select c.status from wht_certificates c where c.invoice_id = i.id order by c.created_at desc limit 1), 'missing') as cert
        from invoices i left join billing_profiles b on b.workspace_id = i.workspace_id
        where i.wht_amount > 0 and i.paid_at is not null and to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${q.month} order by i.number`);
      lines = rows.map((r) => [r.number, r.paid, r.company_name, r.tax_id, money(r.wht_amount), r.cert]);
    }
    const draft = !(await this.isClosed(q.month));
    const csv = '﻿' + [header, ...lines].map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
    return { csv, filename: `friday-${q.type}-${q.month}${draft ? '-draft' : ''}.csv`, draft, rows: lines.length };
  }
}

const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);
