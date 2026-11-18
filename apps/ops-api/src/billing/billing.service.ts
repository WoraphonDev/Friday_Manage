import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { applyCreditToInvoice, creditBalance, type Db, downgradeBlockers, isGrantSource, queueETax, replaceTaxDocument, reverseCreditOfInvoice, schema, type Tx } from '@friday/db';
import { creditNotePdf, debitNotePdf, invoicePdf, renderSalesReport, salesReportData, salesReportXlsx, salesTaxSummary, taxDocumentPdf } from '@friday/docs';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { type Approval, audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { addDays, baht, billingContacts, DAY, type Invoice, mailAll, nextNumber, settleInvoice, todayBkk, vatRegistered } from './ledger.js';

const s = schema;
type Row = Record<string, unknown>;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'รูปแบบเดือนต้องเป็น YYYY-MM');
const Reason = z.string().trim().min(3).max(500);

export const RefundsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const OverdueQuery = z.object({
  q: z.string().trim().max(100).optional(),
  // ---- ช่วง 3: ค้างมา · ยอด · แพ็กเกจ · รอบบิล · ติดต่อแล้ว · ต้องให้คนดู · ผู้ดูแล
  age: z.enum(['1-7', '8-30', '31+']).optional(),
  amountMin: z.coerce.number().int().min(0).optional(),
  amountMax: z.coerce.number().int().min(0).optional(),
  plan: z.enum(['free', 'team_s', 'team_m', 'team_l', 'enterprise']).optional(),
  cycle: z.enum(['monthly', 'yearly']).optional(),
  contacted: z.enum(['yes', 'no']).optional(),
  human: z.enum(['yes']).optional(),
  manager: z.union([z.uuid(), z.literal('none')]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const InvoicesQuery = z.object({
  status: z.enum(['open', 'pending_review', 'paid', 'void', 'overdue']).optional(),
  month: Month.optional(),
  q: z.string().trim().max(100).optional(),
  // ---- ช่วง 3: ครบกำหนด · วิธีชำระ · มี 50 ทวิ · ยอด (สตางค์)
  dueFrom: z.iso.date().optional(),
  dueTo: z.iso.date().optional(),
  method: z.enum(['card', 'promptpay', 'transfer']).optional(),
  wht: z.enum(['yes']).optional(),
  amountMin: z.coerce.number().int().min(0).optional(),
  amountMax: z.coerce.number().int().min(0).optional(),
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
/** คืนเครดิตคงเหลือเป็นเงิน (O41 · R1) · เกินวงเงินคืนเงินต้องอนุมัติ */
export const CreditRefundBody = z.object({ workspaceId: z.uuid(), amountSatang: z.number().int().positive(), reason: Reason }).strict();
export const CreditLedgerQuery = z.object({ workspaceId: z.uuid() });
export const RevenueQuery = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) });
/** ปิดงวด · e-Tax ของเดือนยังไม่ครบก็ปิดได้ แต่ต้องกรอกเหตุผล (E1) */
export const CloseBody = z.object({ month: Month, reason: z.string().trim().min(3).max(500).optional() }).strict();
/** 50 ทวิ ของงวดเป็น CSV (รายงานภาษีขายแยกเป็น PDF / Excel) */
export const ExportQuery = z.object({ month: Month, type: z.enum(['wht']).default('wht') });
export const SalesReportQuery = z.object({ month: Month, format: z.enum(['pdf', 'xlsx']).default('pdf') });
/** ใบเพิ่มหนี้ (ม.86/9): ยอดที่คิดขาดก่อน VAT · ออกใบแจ้งหนี้ส่วนเพิ่มให้ลูกค้าจ่าย */
export const DebitNoteBody = z.object({ amountSatang: z.number().int().positive().max(100_000_000), reason: Reason, dueDays: z.number().int().min(1).max(90).default(7) }).strict();
/** ออกใบกำกับภาษีฉบับใหม่แทนฉบับที่ยกเลิก (ข้อมูลผู้ซื้อผิด) · buyer = ข้อมูลผู้ซื้อที่แก้ในหน้าจอ (E3) ไม่ส่ง = ข้อมูลภาษีปัจจุบันของลูกค้า */
export const ReplaceTaxDocBody = z
  .object({
    reason: Reason,
    buyer: z
      .object({
        companyName: z.string().trim().min(1).max(200),
        taxId: z.string().trim().regex(/^\d{13}$/, 'เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก'),
        branchType: z.enum(['head', 'branch']),
        branchNo: z.string().trim().regex(/^\d{5}$/, 'เลขสาขา 5 หลัก').nullable().optional(),
        address: z.string().trim().min(1).max(500),
        email: z.email().trim().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
    this.approvals.register('billing.credit_refund', (p, ctx) => this.applyCreditRefund(ctx.requester, p as z.infer<typeof CreditRefundBody>, ctx));
    // เตือนค้างชำระทุกชั่วโมง (ทำซ้ำได้ ไม่ส่งซ้ำ) · test เรียก runDunning เอง · ปิดด้วย OPS_JOBS=off
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => {
        void this.runDunning().catch((e) => this.log.error(`เตือนค้างชำระล้ม: ${String(e)}`));
        void this.applyScheduledPlans().catch((e) => this.log.error(`เปลี่ยนแพ็กเกจตามที่ตั้งไว้ล้ม: ${String(e)}`));
      }, 3_600_000);
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
  /** หน้าชำระใบแจ้งหนี้ของลูกค้า (W22b · โอน / บัตร / PromptPay ของใบนั้น) */
  private payLink = (slug: string, invoiceId: string) => `${config.appUrl}/work/${slug}/billing/invoices/${invoiceId}`;

  // ---------------------------------------------------------------- ใบแจ้งหนี้

  async listInvoices(q: z.infer<typeof InvoicesQuery>) {
    const parts: SQL[] = [sql`true`];
    if (q.status === 'overdue') parts.push(sql`i.status in ('open', 'pending_review') and i.due_date < ${todayBkk()}::date`);
    else if (q.status) parts.push(sql`i.status = ${q.status}`);
    if (q.month) parts.push(sql`to_char(i.created_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${q.month}`);
    if (q.q) parts.push(sql`(i.number ilike ${`%${q.q}%`} or w.name ilike ${`%${q.q}%`} or i.po_number ilike ${`%${q.q}%`})`);
    if (q.dueFrom) parts.push(sql`i.due_date >= ${q.dueFrom}::date`);
    if (q.dueTo) parts.push(sql`i.due_date <= ${q.dueTo}::date`);
    if (q.method) parts.push(sql`exists(select 1 from payments p where p.invoice_id = i.id and p.method = ${q.method})`);
    if (q.wht) parts.push(sql`i.wht_amount > 0`);
    if (q.amountMin != null) parts.push(sql`i.amount_due >= ${q.amountMin}`);
    if (q.amountMax != null) parts.push(sql`i.amount_due <= ${q.amountMax}`);
    const where = sql.join(parts, sql` and `);
    const items = await this.rows(sql`
      select i.id, i.number, i.status, i.subtotal::float8 as subtotal, i.vat::float8 as vat, i.total::float8 as total, i.wht_amount::float8 as "whtAmount", i.amount_due::float8 as "amountDue",
        i.po_number as "poNumber", i.due_date as "dueDate", i.paid_at as "paidAt", i.created_at as "createdAt",
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace,
        (select d.status from tax_documents d where d.invoice_id = i.id order by d.created_at desc limit 1) as "taxDocumentStatus",
        (select json_build_object('id', d.id, 'number', d.number, 'status', d.status, 'docType', d.doc_type) from tax_documents d where d.invoice_id = i.id and d.status <> 'cancelled' order by d.created_at desc limit 1) as "taxDocument",
        coalesce((select json_agg(json_build_object('id', c.id, 'number', c.number) order by c.created_at) from credit_notes c where c.invoice_id = i.id), '[]') as "creditNotes",
        coalesce((select json_agg(json_build_object('id', x.id, 'number', x.number) order by x.created_at) from debit_notes x where x.invoice_id = i.id), '[]') as "debitNotes",
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
    const { inv, credit } = await this.db.transaction(async (tx) => {
      const number = await nextNumber(tx, 'invoice', start);
      const [row] = await tx
        .insert(s.invoices)
        .values({
          workspaceId: ws.id, subscriptionId: sub.id, number,
          periodStart: input.plan?.periodStart ?? start, periodEnd: input.plan?.periodEnd ?? start,
          subtotal, vat, total, whtAmount, amountDue, poNumber: input.poNumber ?? null, status: 'open', dueDate: addDays(start, input.dueDays),
        })
        .returning();
      // รูปแบบเดียวกับ API ลูกค้า: แพ็กเกจ / รอบ / วิธีชำระ เป็น JSON (PDF และการต่ออายุอ่านจากแถวนี้)
      await tx.insert(s.auditLogs).values({
        workspaceId: ws.id, actorId: staff.id, actorKind: 'friday_staff', category: 'plan', action: 'billing.checkout', targetType: 'invoice', targetId: row.id,
        summary: JSON.stringify({ plan: input.plan?.code, cycle: input.plan?.cycle, method: 'transfer', wht: input.wht, manual: true, items: input.items, discountPct: input.discountPct, note: input.note, key: `ops-${randomUUID()}`, payload: '' }),
      });
      const used = await this.creditOrPay(tx, row);
      await audit(tx, staff, ws.id, 'plan', 'ops.invoice_created', `ออกใบแจ้งหนี้ ${number} ยอด ${baht(amountDue)}${used ? ` · หักเครดิต ${baht(used)}${used === amountDue ? ' (ชำระครบด้วยเครดิต)' : ''}` : ''}${input.poNumber ? ` · PO ${input.poNumber}` : ''}${input.plan ? ` · ต่ออายุ ${input.plan.code}` : ''}`, { type: 'invoice', id: row.id });
      if (input.send && used < amountDue) await tx.insert(s.dunningEvents).values({ workspaceId: ws.id, invoiceId: row.id, step: 'invoice_sent', channel: 'email', byStaff: staff.id });
      const [fresh] = await tx.select().from(s.invoices).where(eq(s.invoices.id, row.id));
      return { inv: fresh, credit: used };
    });
    let sent = 0;
    if (input.send && inv.status === 'paid') {
      sent = await mailAll(this.mail, await billingContacts(this.db, ws.id), `ใบแจ้งหนี้ ${inv.number} ชำระด้วยเครดิตแล้ว · Friday Work Management`, [
        `ใบแจ้งหนี้ ${inv.number} ยอด ${baht(amountDue)} ชำระครบด้วยเครดิตคงเหลือในบัญชี`,
        `เอกสารภาษีดาวน์โหลดได้ที่ ${config.appUrl}/work/${ws.slug}/billing`,
      ].join('\n'));
    } else if (input.send) {
      sent = await mailAll(this.mail, await billingContacts(this.db, ws.id), `ใบแจ้งหนี้ ${inv.number} · Friday Work Management`, [
        `ใบแจ้งหนี้ ${inv.number} ยอดชำระ ${baht(inv.amountDue)}${credit ? ` (หักเครดิต ${baht(credit)} แล้ว)` : ''} ครบกำหนด ${inv.dueDate}`,
        ...(input.poNumber ? [`อ้างอิง PO ${input.poNumber}`] : []),
        ...(input.note ? [input.note] : []),
        `ดูและชำระได้ที่ ${this.payLink(ws.slug, inv.id)}`,
      ].join('\n'));
    }
    return { invoice: { id: inv.id, number: inv.number, subtotal, vat, total, whtAmount, creditApplied: credit, amountDue: inv.amountDue, dueDate: inv.dueDate, status: inv.status }, sent };
  }

  /**
   * หักเครดิตคงเหลือจากใบที่เพิ่งออก (O41 · กติกาเดียวกับ checkout ของลูกค้า) · เครดิตพอทั้งใบ → ชำระแล้วทันที ออกเอกสารภาษีวันนี้
   * ไม่พอ / ไม่มีเครดิต → สร้างรายการรอโอนตามยอดที่เหลือ · คืนยอดที่หัก
   */
  private async creditOrPay(tx: Tx, row: Invoice) {
    const used = await applyCreditToInvoice(tx, row.id);
    const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, row.id));
    if (inv.amountDue > 0) await tx.insert(s.payments).values({ workspaceId: inv.workspaceId, invoiceId: inv.id, method: 'transfer', amount: inv.amountDue });
    else await settleInvoice(tx, inv, new Date());
    return used;
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
        // ใบนี้หักเครดิตไปแล้ว → คืนเครดิต (O41)
        const back = await reverseCreditOfInvoice(tx, inv.id, `คืนจากใบที่ยกเลิก ${inv.number}`);
        await audit(tx, staff, inv.workspaceId, 'plan', 'ops.invoice_voided', `ยกเลิกใบแจ้งหนี้ ${inv.number} (ยังไม่ชำระ)${back ? ` · คืนเครดิต ${baht(back)}` : ''} · ${input.reason}`, { type: 'invoice', id: inv.id });
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
    await this.sendNote('credit', note.id, inv.workspaceId, `ใบลดหนี้ ${note.number} · ยกเลิกใบแจ้งหนี้ ${inv.number}`, `อ้างถึงใบแจ้งหนี้ ${inv.number}\nเหตุผล: ${input.reason}`);
    return { id: inv.id, status: 'void' as const, creditNote: { id: note.id, number: note.number } };
  }

  /** ยอดที่ยังคืน / ลดหนี้ได้ = ยอดที่ลูกค้าจ่าย − ใบลดหนี้ที่ออกไปแล้ว */
  private async refundable(inv: Invoice) {
    const [r] = await this.rows<{ used: number }>(sql`select coalesce(sum(amount_satang + vat_satang), 0)::float8 as used from credit_notes where invoice_id = ${inv.id}`);
    // ยอดที่ลูกค้าจ่ายจริง = เงิน + เครดิตที่ใช้ชำระ (O41) · เครดิตเป็นวิธีชำระ จึงคืน / ลดหนี้ได้เท่ากัน
    return Math.max(0, inv.amountDue + inv.creditApplied - Number(r.used));
  }

  /** ใบลดหนี้: แยกยอดก่อน VAT / VAT ตามสัดส่วนของใบเดิม · เลข CN- ต่อเนื่องทั้งระบบ */
  private async creditNote(tx: Tx, staff: Staff, inv: Invoice, kind: 'refund' | 'credit' | 'void', cash: number, reason: string, extra: { refundMethod?: string; approvalId?: string } = {}) {
    const paid = inv.amountDue + inv.creditApplied;
    const ratio = paid > 0 ? cash / paid : 1;
    const vat = Math.round(inv.vat * ratio);
    const amount = Math.max(1, Math.round(inv.subtotal * ratio));
    const number = await nextNumber(tx, 'credit_note');
    const [cn] = await tx
      .insert(s.creditNotes)
      .values({ workspaceId: inv.workspaceId, invoiceId: inv.id, number, kind, amountSatang: amount, vatSatang: vat, reason, status: 'issued', refundMethod: extra.refundMethod ?? null, createdByStaff: staff.id, approvalRequestId: extra.approvalId ?? null, issuedAt: new Date() })
      .returning();
    await this.queueNoteETax(tx, staff, inv, 'credit_note', cn.id);
    return cn;
  }

  /** ใบลด / เพิ่มหนี้ที่อ้างใบกำกับภาษี (จด VAT) ส่ง e-Tax ด้วย (คิวเดียวกับใบกำกับภาษี) · อ้างใบเสร็จ (ยังไม่จด) ไม่ต้องส่ง */
  private async queueNoteETax(tx: Tx, staff: Staff, inv: Invoice, kind: 'credit_note' | 'debit_note', id: string) {
    if (!vatRegistered()) return;
    const [doc] = await tx.select({ docType: s.taxDocuments.docType }).from(s.taxDocuments).where(and(eq(s.taxDocuments.invoiceId, inv.id), sql`${s.taxDocuments.status} <> 'cancelled'`)).orderBy(desc(s.taxDocuments.createdAt)).limit(1);
    if (doc?.docType === 'tax_invoice_receipt') await queueETax(tx, { workspaceId: inv.workspaceId, docKind: kind, docId: id, action: 'issue', byStaff: staff.id });
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
    const sent = await mailAll(this.mail, input.to ? [input.to] : contacts, `ลิงก์ชำระใบแจ้งหนี้ ${inv.number} · Friday Work Management`, `ยอดชำระ ${baht(inv.amountDue)} ครบกำหนด ${inv.dueDate}\nชำระได้ที่ ${link}`);
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

  async overdue(q: z.infer<typeof OverdueQuery> = { limit: 50, offset: 0 }) {
    const days = sql`(${todayBkk()}::date - i.due_date)`;
    const extra: SQL[] = [sql`true`];
    if (q.q) extra.push(sql`(w.name ilike ${`%${q.q}%`} or w.slug ilike ${`%${q.q}%`} or i.number ilike ${`%${q.q}%`})`);
    if (q.age === '1-7') extra.push(sql`${days} between 1 and 7`);
    else if (q.age === '8-30') extra.push(sql`${days} between 8 and 30`);
    else if (q.age === '31+') extra.push(sql`${days} > 30`);
    if (q.amountMin != null) extra.push(sql`i.amount_due >= ${q.amountMin}`);
    if (q.amountMax != null) extra.push(sql`i.amount_due <= ${q.amountMax}`);
    if (q.plan) extra.push(sql`exists(select 1 from plans p where p.id = sub.plan_id and p.code = ${q.plan})`);
    if (q.cycle) extra.push(sql`sub.cycle = ${q.cycle}`);
    if (q.contacted) extra.push(sql`${q.contacted === 'yes' ? sql`` : sql`not`} exists(select 1 from dunning_events e where e.invoice_id = i.id and e.by_staff is not null)`);
    if (q.human) extra.push(sql`(${days} > 7 or sub.cycle = 'yearly')`);
    if (q.manager) extra.push(q.manager === 'none' ? sql`not exists(select 1 from support_account_managers am where am.workspace_id = i.workspace_id)` : sql`exists(select 1 from support_account_managers am where am.workspace_id = i.workspace_id and am.staff_id = ${q.manager})`);
    const all = await this.overdueRows(sql.join(extra, sql` and `));
    // ช่วง 1 (ข้อมูลเยอะ): เรียงตามความเสี่ยง = ยอด × วันที่ค้าง · ดึงผู้ติดต่อ/ประวัติเฉพาะหน้าที่แสดง (เดิมทำทุกแถว)
    const ranked = [...all].sort((a, b) => Number(b.amountDue) * Number(b.daysOverdue) - Number(a.amountDue) * Number(a.daysOverdue));
    const rows = ranked.slice(q.offset, q.offset + q.limit);
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
    return { items, total: all.length, totalSatang: all.reduce((n, r) => n + Number(r.amountDue), 0), steps: DUNNING_STEPS };
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
          // ค้างชำระ = อ่านอย่างเดียว (ยังส่งออกและชำระได้) และเปิดเองเมื่อชำระครบ
          await tx
            .update(s.workspaces)
            .set({ status: 'suspended', suspensionMode: 'read_only', suspensionMessage: `บัญชีถูกระงับเพราะค้างชำระ ${r.number} กรุณาชำระเพื่อใช้งานต่อ ข้อมูลทั้งหมดยังอยู่ครบ`, suspensionAutoResume: true, updatedAt: new Date() })
            .where(eq(s.workspaces.id, ws.id));
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

  // ---------------------------------------------------------------- คืนเงิน / เครดิต

  async refunds(q: z.infer<typeof RefundsQuery> = { limit: 50, offset: 0 }) {
    const pending = await this.db
      .select({ r: s.approvalRequests, requester: s.staffUsers.name })
      .from(s.approvalRequests)
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.approvalRequests.requestedBy))
      .where(and(inArray(s.approvalRequests.kind, ['billing.refund', 'billing.credit']), eq(s.approvalRequests.status, 'pending')))
      .orderBy(s.approvalRequests.createdAt);
    const term = q.q ? `%${q.q}%` : null;
    const match = term ? sql`((x.workspace->>'name') ilike ${term} or (x.workspace->>'slug') ilike ${term} or x.ref ilike ${term} or x.invoice ilike ${term})` : sql`true`;
    const HISTORY = sql`
        select c.id, c.issued_at as "at", c.kind as type, c.number as ref, c.reason, (c.amount_satang + c.vat_satang)::float8 as "amountSatang", c.refund_method as "refundMethod",
          st.name as "requestedBy", ap.name as "approvedBy", c.status, json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace, i.number as invoice
        from credit_notes c join workspaces w on w.id = c.workspace_id join invoices i on i.id = c.invoice_id
          left join staff_users st on st.id = c.created_by_staff left join approval_requests a on a.id = c.approval_request_id left join staff_users ap on ap.id = a.decided_by
        union all
        select k.id, k.created_at, 'goodwill_credit', null, k.note, k.amount_satang::float8, null, st.name, null, 'issued', json_build_object('id', w.id, 'slug', w.slug, 'name', w.name), null
        from workspace_credits k join workspaces w on w.id = k.workspace_id left join staff_users st on st.id = k.created_by_staff where k.source in ('goodwill', 'overpayment')
`;
    const history = await this.rows(sql`
      select * from (${HISTORY}) x where ${match} order by "at" desc limit ${q.limit} offset ${q.offset}`);
    // ช่วง 1 (ข้อมูลเยอะ): เดิมตัดที่ 100 รายการโดยไม่บอก · ค้นด้วย Workspace / เลขเอกสาร / ใบแจ้งหนี้ได้
    const [{ n }] = await this.rows(sql`select count(*)::int as n from (${HISTORY}) x where ${match}`);
    return { pending: pending.map(({ r, requester }) => ({ id: r.id, kind: r.kind, workspaceId: r.workspaceId, amountSatang: r.amountSatang, reason: r.reason, requestedBy: requester, createdAt: r.createdAt, expiresAt: r.expiresAt, payload: r.payload })), history, historyTotal: n as number };
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
    await this.sendNote('credit', cn.id, inv.workspaceId, `ใบลดหนี้ ${cn.number} · คืนเงิน ${baht(p.amountSatang)}`, `อ้างถึงใบแจ้งหนี้ ${inv.number}\nเหตุผล: ${p.reason}\nทีมการเงินจะคืนเงิน${p.method === 'original' ? 'ผ่านช่องทางเดิม' : 'ทางการโอน'}ภายใน 7 วันทำการ`);
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
    const subject = `คุณได้รับเครดิต ${baht(p.amountSatang)} · Friday Work Management`;
    const text = `เหตุผล: ${p.reason}\nเครดิตคงเหลือ ${baht(Number(bal.b))} ใช้หักรอบถัดไปอัตโนมัติ`;
    if (result) await this.sendNote('credit', result.id, p.workspaceId, subject, `${text}\nแนบใบลดหนี้ ${result.number}`);
    else await mailAll(this.mail, await billingContacts(this.db, p.workspaceId), subject, text);
    return { creditSatang: p.amountSatang, balanceSatang: Number(bal.b), creditNote: result ? { id: result.id, number: result.number } : null };
  }

  // ---------------------------------------------------------------- ใบลด / เพิ่มหนี้ · ใบกำกับภาษีฉบับแทน

  /**
   * ส่งใบลด / เพิ่มหนี้ให้ผู้ติดต่อเรื่องเงินของลูกค้า แนบ PDF (แม่แบบเดียวกับที่ลูกค้าดาวน์โหลดในหน้า Billing)
   * ส่งได้อย่างน้อย 1 อีเมล → สถานะ sent · ส่งไม่ได้ไม่ทำให้รายการล้ม (ลูกค้ายังดาวน์โหลดเองได้)
   */
  private async sendNote(kind: 'credit' | 'debit', id: string, workspaceId: string, subject: string, text: string) {
    const file = kind === 'credit' ? await creditNotePdf(this.db, id, { vatRegistered: vatRegistered() }) : await debitNotePdf(this.db, id, { vatRegistered: vatRegistered() });
    if (!file) return 0;
    const ws = await this.workspace(workspaceId);
    let sent = 0;
    for (const to of await billingContacts(this.db, workspaceId)) {
      try {
        await this.mail.send({ to, subject, text: `${text}\nดาวน์โหลดเอกสารได้ที่ ${config.appUrl}/work/${ws.slug}/billing`, attachments: [{ filename: file.filename, content: file.buffer, contentType: 'application/pdf' }] });
        sent++;
      } catch {
        /* Mailer บันทึก log แล้ว */
      }
    }
    if (sent) {
      const table = kind === 'credit' ? s.creditNotes : s.debitNotes;
      await this.db.update(table).set({ status: 'sent', updatedAt: new Date() }).where(eq(table.id, id));
    }
    return sent;
  }

  /**
   * ใบเพิ่มหนี้ (ม.86/9): เก็บเงินขาดในใบที่ออกใบกำกับภาษีแล้ว · อ้างใบกำกับภาษีเดิม
   * ออกใบแจ้งหนี้ส่วนเพิ่ม (โอน · ลูกค้าจ่ายที่หน้าชำระใบแจ้งหนี้) แล้วผูกกับใบเพิ่มหนี้
   */
  async issueDebitNote(staff: Staff, id: string, input: z.infer<typeof DebitNoteBody>) {
    const inv = await this.invoice(id);
    if (inv.status !== 'paid') throw new AppError(409, 'invoice_not_paid', 'ออกใบเพิ่มหนี้ได้เฉพาะใบที่ชำระแล้ว (มีใบกำกับภาษี)', { status: inv.status });
    const [doc] = await this.db.select().from(s.taxDocuments).where(and(eq(s.taxDocuments.invoiceId, inv.id), sql`${s.taxDocuments.status} <> 'cancelled'`)).orderBy(desc(s.taxDocuments.createdAt)).limit(1);
    if (!doc) throw new AppError(409, 'no_tax_document', 'ใบนี้ยังไม่มีใบกำกับภาษี / ใบเสร็จให้อ้างอิง');
    if (await this.isClosed(todayBkk().slice(0, 7))) throw new AppError(409, 'period_closed', 'งวดเดือนนี้ปิดแล้ว ออกเอกสารใหม่ไม่ได้');
    const [sub] = await this.db.select().from(s.subscriptions).where(eq(s.subscriptions.workspaceId, inv.workspaceId));
    const ws = await this.workspace(inv.workspaceId);
    const amount = input.amountSatang;
    const vat = vatRegistered() && doc.docType !== 'receipt' ? Math.round(amount * 0.07) : 0;
    // ลูกค้าหัก ณ ที่จ่ายในใบเดิม → ส่วนเพิ่มก็หักแบบเดียวกัน
    const whtAmount = inv.whtAmount > 0 ? Math.round(amount * 0.03) : 0;
    const amountDue = amount + vat - whtAmount;
    const start = todayBkk();
    const result = await this.db.transaction(async (tx) => {
      const number = await nextNumber(tx, 'debit_note');
      const invoiceNumber = await nextNumber(tx, 'invoice', start);
      const [charge] = await tx
        .insert(s.invoices)
        .values({ workspaceId: inv.workspaceId, subscriptionId: sub?.id ?? inv.subscriptionId, number: invoiceNumber, periodStart: start, periodEnd: start, subtotal: amount, vat, total: amount + vat, whtAmount, amountDue, poNumber: inv.poNumber, status: 'open', dueDate: addDays(start, input.dueDays) })
        .returning();
      await tx.insert(s.auditLogs).values({
        workspaceId: inv.workspaceId, actorId: staff.id, actorKind: 'friday_staff', category: 'plan', action: 'billing.checkout', targetType: 'invoice', targetId: charge.id,
        summary: JSON.stringify({ method: 'transfer', wht: whtAmount > 0, manual: true, items: [{ description: `ส่วนเพิ่มตามใบเพิ่มหนี้ ${number}`, qty: 1, unitSatang: amount }], note: input.reason, key: `ops-${randomUUID()}`, payload: '' }),
      });
      // เครดิตคงเหลือหักใบส่วนเพิ่มด้วย (O41)
      await this.creditOrPay(tx, charge);
      const [dn] = await tx
        .insert(s.debitNotes)
        .values({ workspaceId: inv.workspaceId, invoiceId: inv.id, number, amountSatang: amount, vatSatang: vat, reason: input.reason, status: 'issued', chargeInvoiceId: charge.id, createdByStaff: staff.id, issuedAt: new Date() })
        .returning();
      await this.queueNoteETax(tx, staff, inv, 'debit_note', dn.id);
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.debit_note_issued', `ใบเพิ่มหนี้ ${number} อ้าง ${doc.number} (${inv.number}) · เพิ่ม ${baht(amount + vat)} · ใบแจ้งหนี้ ${invoiceNumber} · ${input.reason}`, { type: 'debit_note', id: dn.id });
      return { dn, charge };
    });
    const sent = await this.sendNote('debit', result.dn.id, inv.workspaceId, `ใบเพิ่มหนี้ ${result.dn.number} · Friday Work Management`, [
      `อ้างถึง${doc.docType === 'receipt' ? 'ใบเสร็จ' : 'ใบกำกับภาษี'} ${doc.number} (ใบแจ้งหนี้ ${inv.number})`,
      `เหตุผล: ${input.reason}`,
      `ยอดเพิ่ม ${baht(amount + vat)} · ชำระ ${baht(amountDue)} ภายใน ${result.charge.dueDate}`,
      `ชำระได้ที่ ${this.payLink(ws.slug, result.charge.id)}`,
    ].join('\n'));
    return {
      debitNote: { id: result.dn.id, number: result.dn.number, amountSatang: amount, vatSatang: vat },
      invoice: { id: result.charge.id, number: result.charge.number, amountDue, dueDate: result.charge.dueDate },
      sent,
    };
  }

  /**
   * E3 · ใบกำกับภาษีฉบับใหม่แทนฉบับที่ยกเลิก: ฉบับเดิม cancelled · ฉบับใหม่เลขถัดไป ลงวันที่ตามฉบับเดิม · ผู้ซื้อตามที่แก้ในหน้าจอ (หรือข้อมูลปัจจุบัน)
   * e-Tax: แจ้งยกเลิกฉบับเดิมที่ผู้ให้บริการอัตโนมัติ และส่งฉบับใหม่โดยอ้างฉบับเดิม (คิว etax_jobs) · งวดของฉบับเดิมปิดแล้วทำไม่ได้
   */
  async replaceTaxDocument(staff: Staff, id: string, input: z.infer<typeof ReplaceTaxDocBody>) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบใบกำกับภาษี');
    const [d] = await this.db.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, id));
    if (!d) throw new AppError(404, 'not_found', 'ไม่พบใบกำกับภาษี');
    if (d.status === 'cancelled') throw new AppError(409, 'already_cancelled', 'ใบนี้ยกเลิกแล้ว');
    const inv = await this.invoice(d.invoiceId);
    if (inv.status !== 'paid') throw new AppError(409, 'invoice_not_paid', 'ใบแจ้งหนี้ของเอกสารนี้ไม่ได้อยู่ในสถานะชำระแล้ว', { status: inv.status });
    const docMonth = (d.issuedOn ?? todayBkk()).slice(0, 7);
    if (await this.isClosed(docMonth)) throw new AppError(409, 'period_closed', `งวด ${docMonth} ปิดแล้ว ยกเลิกเอกสารของงวดนี้ไม่ได้`);
    const r = await this.db.transaction(async (tx) => {
      const out = await replaceTaxDocument(tx, id, input.reason, { buyer: input.buyer ? { ...input.buyer, branchNo: input.buyer.branchType === 'head' ? null : (input.buyer.branchNo ?? null), email: input.buyer.email ?? (d.buyer as { email?: string | null } | null)?.email ?? null } : null, byStaff: staff.id });
      if (!out || out.alreadyCancelled || !out.replacement) throw new AppError(409, 'already_cancelled', 'ใบนี้ยกเลิกแล้ว');
      await audit(tx, staff, d.workspaceId, 'plan', 'ops.tax_document_replaced', `ยกเลิก ${d.number} · ออกฉบับใหม่ ${out.replacement.number} แทน · ${input.reason}`, { type: 'tax_document', id: out.replacement.id });
      return out.replacement;
    });
    const file = await taxDocumentPdf(this.db, r.id);
    if (file) {
      await mailAll(this.mail, await billingContacts(this.db, d.workspaceId), `${d.docType === 'receipt' ? 'ใบเสร็จ' : 'ใบกำกับภาษี'}ฉบับใหม่ ${r.number} แทน ${d.number}`, `ยกเลิก ${d.number} และออก ${r.number} แทน เนื่องจาก${input.reason}\nฉบับเดิมใช้อ้างอิงไม่ได้อีก`);
    }
    return { cancelled: { id: d.id, number: d.number }, replacement: { id: r.id, number: r.number, status: r.status, issuedOn: r.issuedOn } };
  }

  /** PDF ของเอกสารให้ทีมดู / ส่งต่อ (แม่แบบเดียวกับลูกค้า) */
  async documentPdf(kind: 'invoice' | 'tax_document' | 'credit_note' | 'debit_note', id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบเอกสาร');
    const opts = { vatRegistered: vatRegistered() };
    const file = kind === 'invoice' ? await invoicePdf(this.db, id, opts) : kind === 'tax_document' ? await taxDocumentPdf(this.db, id) : kind === 'credit_note' ? await creditNotePdf(this.db, id, opts) : await debitNotePdf(this.db, id, opts);
    if (!file) throw new AppError(404, 'not_found', 'ไม่พบเอกสาร');
    return file;
  }

  /** รายงานภาษีขายรายเดือน (ม.87) · PDF 2 หน้า (ตามแบบ + รายละเอียด) หรือ Excel 2 แท็บ · งวดที่ยังไม่ปิด = ฉบับร่าง */
  async salesReport(q: z.infer<typeof SalesReportQuery>) {
    const [year, month] = q.month.split('-').map(Number);
    const closed = await this.isClosed(q.month);
    const data = await salesReportData(this.db, year, month, { closed });
    const buffer = q.format === 'xlsx' ? await salesReportXlsx(data) : await renderSalesReport(data);
    return { buffer, filename: `friday-sales-tax-${q.month}${closed ? '' : '-draft'}.${q.format}`, draft: !closed, rows: data.rows.length };
  }

  // ---------------------------------------------------------------- รายงานรายได้ / ปิดงวด / ส่งออก

  async closedMonths() {
    const rows = await this.db.select({ month: s.staffAuditLogs.reason }).from(s.staffAuditLogs).where(eq(s.staffAuditLogs.action, 'billing.period_closed'));
    return new Set(rows.map((r) => r.month ?? ''));
  }
  async isClosed(month: string) {
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
    // VAT ขายสุทธิของแต่ละเดือน: สูตรเดียวกับการ์ดภาษีและรายงาน PDF / Excel (ตามวันที่ของเอกสารภาษี)
    const salesVat = new Map<string, number>();
    for (const m of months) salesVat.set(m, salesTaxSummary((await salesReportData(this.db, Number(m.slice(0, 4)), Number(m.slice(5, 7)), { closed: closed.has(m) })).rows).net.vat);
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
        vatSatang: salesVat.get(m) ?? 0,
        whtSatang: inMonth.reduce((n, i) => n + i.wht, 0),
        feesSatang: Math.round(inMonth.reduce((n, i) => n + (i.method === 'card' ? (i.due * pct('payment_fee_card')) / 100 : i.method === 'promptpay' ? (i.due * pct('payment_fee_promptpay')) / 100 : 0), 0)),
        refundsSatang: notes.filter((c) => c.month === m).reduce((n, c) => n + c.total, 0),
        deferredSatang: Math.round(deferred),
        closed: closed.has(m),
      };
    });
    return { months: rows };
  }

  /**
   * ปิดงวด: เดือนที่จบแล้วเท่านั้น · ปิดแล้วแก้ไม่ได้ (รายการย้อนหลังออกเป็นใบลดหนี้ / เพิ่มหนี้ในเดือนปัจจุบัน)
   * e-Tax ยังไม่ครบก็ปิดได้ แต่ต้องกรอกเหตุผล (บันทึกคู่กับการปิด) · reason ของ billing.period_closed เก็บงวดไว้ให้ระบบอ่าน
   */
  async close(staff: Staff, input: z.infer<typeof CloseBody>) {
    if (input.month >= todayBkk().slice(0, 7)) throw new AppError(422, 'month_not_ended', 'ปิดได้เฉพาะเดือนที่จบแล้ว');
    if (await this.isClosed(input.month)) throw new AppError(409, 'already_closed', 'งวดนี้ปิดแล้ว');
    const data = await salesReportData(this.db, Number(input.month.slice(0, 4)), Number(input.month.slice(5, 7)), { closed: false });
    const etax = salesTaxSummary(data.rows).etax;
    const open = etax.total - etax.done;
    if (open && !input.reason) throw new AppError(422, 'etax_incomplete', `e-Tax ของงวดนี้ยังไม่ครบ ${open} ฉบับ กรอกเหตุผลเพื่อปิดงวด`, { open, numbers: etax.numbers });
    await this.db.transaction(async (tx) => {
      await staffAudit(tx, staff, 'billing.period_closed', input.month);
      if (input.reason) await staffAudit(tx, staff, 'billing.period_closed_note', `${input.month} · ${open ? `e-Tax ยังไม่ครบ ${open} ฉบับ (${etax.numbers.join(', ')}) · ` : ''}${input.reason}`);
    });
    return { month: input.month, closed: true, etaxOpen: open };
  }

  /** 50 ทวิ ที่ได้รับของงวดเป็น CSV (มี BOM ให้ Excel อ่านภาษาไทยได้) · รายการขาย / ใบลดหนี้ย้ายไปอยู่ในรายงานภาษีขาย */
  async export(q: z.infer<typeof ExportQuery>) {
    const esc = (v: unknown) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const money = (v: unknown) => (Number(v ?? 0) / 100).toFixed(2);
    const header = ['ใบแจ้งหนี้', 'วันที่ชำระ', 'ลูกค้า', 'เลขผู้เสียภาษี', 'ภาษีที่ถูกหัก', 'สถานะ 50 ทวิ', 'ที่มา', 'เลขอ้างอิง e-WHT', 'หมายเหตุ'];
    const rows = await this.rows<Row>(sql`
      select i.number, to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as paid, b.company_name, b.tax_id, i.wht_amount,
        coalesce(c.status, 'missing') as cert, c.source, c.ewht_ref, c.reject_reason
      from invoices i left join billing_profiles b on b.workspace_id = i.workspace_id
        left join lateral (select * from wht_certificates c where c.invoice_id = i.id order by c.created_at desc limit 1) c on true
      where i.wht_amount > 0 and i.paid_at is not null and to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${q.month} order by i.number`);
    // ไม่ได้รับ (ปิดแล้ว) ใช้เป็นเครดิตภาษีไม่ได้ · e-WHT ไม่มีไฟล์แต่ตรงกับข้อมูลสรรพากรแล้ว
    const STATUS: Record<string, string> = { confirmed: 'ได้รับแล้ว', pending_review: 'รอตรวจ', rejected: 'ไม่ผ่าน · รอส่งใหม่', pending_ewht: 'รอยืนยัน e-WHT', uncollected: 'ไม่ได้รับ', missing: 'ยังไม่ได้รับ' };
    const SOURCE: Record<string, string> = { upload: 'ไฟล์', ewht: 'e-WHT', ops: 'ทีมบันทึก' };
    const lines = rows.map((r) => [r.number, r.paid, r.company_name, r.tax_id, money(r.wht_amount), STATUS[String(r.cert)] ?? r.cert, r.source ? (SOURCE[String(r.source)] ?? r.source) : '', r.ewht_ref ?? '', r.cert === 'uncollected' || r.cert === 'rejected' ? (r.reject_reason ?? '') : '']);
    const draft = !(await this.isClosed(q.month));
    const csv = '\ufeff' + [header, ...lines].map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
    return { csv, filename: `friday-${q.type}-${q.month}${draft ? '-draft' : ''}.csv`, draft, rows: lines.length };
  }

  // ---------------------------------------------------------------- ลดแพ็กเกจที่ตั้งไว้ (C4)

  /** จบรอบบิลแล้ว → เปลี่ยนเป็นแพ็กเกจที่ตั้งไว้ · บันทึก MRR movement และ Audit ของลูกค้า (ระบบทำ) · เรียกซ้ำได้ */
  // ---------------------------------------------------------------- บัญชีเครดิต (O41 · R1)

  /** ประวัติเครดิตของลูกค้า ใหม่สุดก่อน พร้อมยอดคงเหลือหลังแต่ละบรรทัด และใบถัดไปที่จะหักเครดิต */
  async creditLedger(q: z.infer<typeof CreditLedgerQuery>) {
    const rows = await this.rows<{ id: string; created_at: Date; amount: number; source: string; note: string | null; invoice_id: string | null; invoice: string | null; credit_note_id: string | null; credit_note: string | null; staff: string | null }>(sql`
      select k.id, k.created_at, k.amount_satang::float8 as amount, k.source, k.note, k.invoice_id, i.number as invoice, k.credit_note_id, c.number as credit_note, st.name as staff
      from workspace_credits k left join invoices i on i.id = k.invoice_id left join credit_notes c on c.id = k.credit_note_id left join staff_users st on st.id = k.created_by_staff
      where k.workspace_id = ${q.workspaceId} order by k.created_at asc, k.id asc`);
    let run = 0;
    const items = rows.map((r) => ((run += Number(r.amount)), { id: r.id, at: r.created_at, amountSatang: Number(r.amount), balanceSatang: run, source: r.source, note: r.note, invoice: r.invoice_id ? { id: r.invoice_id, number: r.invoice } : null, creditNote: r.credit_note_id ? { id: r.credit_note_id, number: r.credit_note } : null, staff: r.staff }));
    const balance = await creditBalance(this.db, q.workspaceId);
    const [sub] = await this.db.select().from(s.subscriptions).where(eq(s.subscriptions.workspaceId, q.workspaceId));
    const [plan] = sub ? await this.db.select().from(s.plans).where(eq(s.plans.id, sub.pendingPlanId ?? sub.planId)) : [];
    const cycle = sub?.pendingCycle ?? sub?.cycle ?? 'monthly';
    const price = plan ? (cycle === 'yearly' ? plan.priceYearlySatang : plan.priceMonthlySatang) : null;
    const total = price == null ? null : price + (vatRegistered() ? Math.round(price * 0.07) : 0);
    return {
      balanceSatang: balance,
      items: items.reverse(),
      next: sub?.currentPeriodEnd && total != null && sub.status === 'active' ? { date: sub.currentPeriodEnd, plan: plan!.code, totalSatang: total, creditSatang: Math.min(balance, total), payableSatang: total - Math.min(balance, total) } : null,
    };
  }

  /** คืนเครดิตคงเหลือเป็นเงิน (R1 "คืนเป็นเงิน") · เกินวงเงินคืนเงินของพนักงานต้องอนุมัติ */
  async requestCreditRefund(staff: Staff, input: z.infer<typeof CreditRefundBody>) {
    await this.workspace(input.workspaceId);
    const balance = await creditBalance(this.db, input.workspaceId);
    if (input.amountSatang > balance) throw new AppError(422, 'credit_exceeds_balance', `คืนได้ไม่เกินเครดิตคงเหลือ ${baht(balance)}`, { balanceSatang: balance });
    const pending = await this.approvals.gate(staff, {
      kind: 'billing.credit_refund', workspaceId: input.workspaceId, target: { type: 'workspace', id: input.workspaceId }, payload: input, amountSatang: input.amountSatang, reason: input.reason,
      exceeds: input.amountSatang > staff.limits.refundSatang,
      rule: `คืนเงินเกิน ${baht(staff.limits.refundSatang)}`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyCreditRefund(staff, input);
  }

  private async applyCreditRefund(staff: Staff, p: z.infer<typeof CreditRefundBody>, ctx?: ApprovalContext) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'credit:' + p.workspaceId}, 0))`);
      if (p.amountSatang > (await creditBalance(tx, p.workspaceId))) throw new AppError(422, 'credit_exceeds_balance', 'เครดิตคงเหลือไม่พอ (อาจถูกใช้ไปแล้ว)');
      await tx.insert(s.workspaceCredits).values({ workspaceId: p.workspaceId, amountSatang: -p.amountSatang, source: 'refunded', note: p.reason, createdByStaff: staff.id });
      await audit(tx, staff, p.workspaceId, 'plan', 'ops.credit_refunded', `คืนเครดิตเป็นเงิน ${baht(p.amountSatang)} · ${p.reason}`, { type: 'workspace', id: p.workspaceId }, approvalOf(ctx));
    });
    const balance = await creditBalance(this.db, p.workspaceId);
    await mailAll(this.mail, await billingContacts(this.db, p.workspaceId), `คืนเครดิตเป็นเงิน ${baht(p.amountSatang)} · Friday Work Management`, `ทีมการเงินจะโอนคืน ${baht(p.amountSatang)} ภายใน 7 วันทำการ\nเหตุผล: ${p.reason}\nเครดิตคงเหลือ ${baht(balance)}`);
    return { refundedSatang: p.amountSatang, balanceSatang: balance };
  }

  /**
   * ส่วนที่ยังไม่ได้ใช้ของรอบที่จ่ายแล้ว (เปลี่ยนรอบบิล / ส่วนต่างติดลบ · O41 · R3) → ใบลดหนี้อ้างใบที่เปิดรอบนี้ แล้วเข้าเครดิต
   * ยอดคิดจากที่จ่ายจริงของใบนั้นตามสัดส่วนวันที่เหลือ · ไม่ต้องอนุมัติ (ระบบคำนวณ ไม่ใช่การให้เครดิตตามดุลยพินิจ)
   */
  async creditUnused(staff: Staff, invoiceId: string, ratio: number, reason: string) {
    const inv = await this.invoice(invoiceId);
    if (inv.status !== 'paid' || ratio <= 0) return null;
    const cash = Math.min(await this.refundable(inv), Math.round((inv.amountDue + inv.creditApplied) * Math.min(1, ratio)));
    if (cash <= 0) return null;
    return this.db.transaction(async (tx) => {
      const note = await this.creditNote(tx, staff, inv, 'credit', cash, reason);
      await tx.insert(s.workspaceCredits).values({ workspaceId: inv.workspaceId, amountSatang: cash, source: 'credit_note', creditNoteId: note.id, invoiceId: inv.id, note: reason, createdByStaff: staff.id });
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.credit_granted', `เครดิตส่วนที่ยังไม่ได้ใช้ ${baht(cash)} · ใบลดหนี้ ${note.number} (${inv.number}) · ${reason}`, { type: 'credit_note', id: note.id });
      return { creditNote: { id: note.id, number: note.number }, creditSatang: cash };
    });
  }

  /** อีเมล Owner ของ Workspace (แจ้งเรื่องแพ็กเกจที่เจ้าของต้องตัดสิน) */
  private async owners(workspaceId: string) {
    const rows = await this.db
      .select({ email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), eq(s.workspaceMembers.role, 'owner')));
    return rows.map((r) => r.email);
  }

  async applyScheduledPlans(now = new Date()) {
    const due = await this.db
      .select({ sub: s.subscriptions, from: s.plans.code })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(and(sql`${s.subscriptions.pendingPlanId} is not null`, sql`${s.subscriptions.currentPeriodEnd} <= ${now}`));
    const done: { workspaceId: string; from: string; to: string }[] = [];
    for (const { sub, from } of due) {
      const [to] = await this.db.select().from(s.plans).where(eq(s.plans.id, sub.pendingPlanId!));
      if (!to) continue;
      // วันที่มีผลยังใช้เกินขีดจำกัดของแพ็กเกจใหม่ → คงแพ็กเกจเดิมอีก 1 รอบ และอีเมล Owner (คำตัดสิน 16 พ.ย. 2569 ข้อ 2)
      const blockers = await downgradeBlockers(this.db, sub.workspaceId, to.code, now);
      if (blockers.length) {
        const key = `downgrade-held:${sub.id}:${sub.currentPeriodEnd?.toISOString().slice(0, 10)}`;
        const [first] = await this.db.insert(s.staffPushNotices).values({ key }).onConflictDoNothing().returning();
        if (first) {
          await this.db.insert(s.auditLogs).values({ workspaceId: sub.workspaceId, actorKind: 'system', category: 'plan', action: 'billing.downgrade_held', targetType: 'subscription', targetId: sub.id, summary: `ยังไม่ลดเป็น ${to.code}: ${blockers.map((b) => `${b.key === 'seats' ? 'สมาชิก' : 'โปรเจกต์'} ${b.used}/${b.limit}`).join(' · ')} · ใช้ ${from} ต่ออีก 1 รอบ` });
          await mailAll(this.mail, await this.owners(sub.workspaceId), `ยังไม่ได้ลดเป็น ${to.code} · Friday Work Management`, `ถึงวันลดแพ็กเกจแล้ว แต่ Workspace ยังใช้เกินขีดจำกัดของ ${to.code}\n${blockers.map((b) => `- ${b.key === 'seats' ? 'สมาชิก' : 'โปรเจกต์'} ${b.used} จากที่รับได้ ${b.limit}`).join('\n')}\nระบบใช้ ${from} ต่ออีก 1 รอบ · ลดให้ไม่เกินขีดจำกัดแล้วระบบจะเปลี่ยนให้ในรอบถัดไป หรือยกเลิกการลดแพ็กเกจได้ที่หน้า แพ็กเกจ & Billing`);
        }
        continue;
      }
      const cycle = sub.pendingCycle ?? sub.cycle;
      const price = (p: { priceMonthlySatang: number | null; priceYearlySatang: number | null }, c: string) => (c === 'yearly' ? Math.round((p.priceYearlySatang ?? 0) / 12) : (p.priceMonthlySatang ?? 0));
      const [last] = await this.rows<{ mrr: number }>(sql`select mrr_after_satang::float8 as mrr from subscription_changes where workspace_id = ${sub.workspaceId} order by effective_at desc, created_at desc limit 1`);
      await this.db.transaction(async (tx) => {
        await tx.update(s.subscriptions).set({ planId: to.id, cycle, pendingPlanId: null, pendingCycle: null, updatedAt: new Date() }).where(eq(s.subscriptions.id, sub.id));
        await tx.insert(s.subscriptionChanges).values({ workspaceId: sub.workspaceId, kind: 'downgrade', planFrom: from, planTo: to.code, mrrBeforeSatang: Math.max(0, Number(last?.mrr ?? 0)), mrrAfterSatang: price(to, cycle), actorKind: 'system', effectiveAt: now });
        await tx.insert(s.auditLogs).values({ workspaceId: sub.workspaceId, actorKind: 'system', category: 'plan', action: 'billing.plan_downgraded', targetType: 'subscription', targetId: sub.id, summary: `ลดแพ็กเกจ ${from} → ${to.code} ตามที่ตั้งไว้ (จบรอบบิล)` });
      });
      done.push({ workspaceId: sub.workspaceId, from, to: to.code });
    }
    return done;
  }
}

const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);
