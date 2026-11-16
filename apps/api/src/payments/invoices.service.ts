import { createHash, randomUUID } from 'node:crypto';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { bkkDate, type Db, nextDocNumber, schema, type Tx } from '@friday/db';
import { bankFromEnv, creditNotePdf, debitNotePdf, invoicePdf, planTitle, quotationPdf, taxDocumentPdf } from '@friday/docs';
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { today } from '../common/dates.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { parse } from '../common/validate.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { BillingService, QuoteQuery } from '../billing/billing.service.js';
import { invoiceDto, PaymentsService } from './payments.service.js';

const s = schema;
const DAY = 86_400_000;
export const SLIP_MAX_BYTES = 5 * 1024 * 1024;
/** 50 ทวิ ต้องส่งภายใน 30 วันหลังชำระ (รอบ 4 · เดิมนับจากวันออกใบแจ้งหนี้ ลูกค้าที่จ่ายช้าเหลือเวลาน้อย) */
export const WHT_DEADLINE_DAYS = 30;
/** กำหนดส่ง 50 ทวิ = วันที่ชำระ + 30 วัน (เวลาไทย) · ยังไม่ชำระ = ยังไม่มีกำหนด */
export const whtDueBy = (i: { whtAmount: number; paidAt: Date | null }) => (i.whtAmount > 0 && i.paidAt ? bkkDate(new Date(i.paidAt.getTime() + WHT_DEADLINE_DAYS * DAY)) : null);
/** หักผ่าน e-Withholding Tax: เลขอ้างอิงที่ธนาคาร / ระบบสรรพากรให้ */
export const EwhtBody = z.object({ reference: z.string().trim().min(3, 'กรอกเลขอ้างอิง e-WHT').max(60) }).strict();

/** ยอดที่ลูกค้าแจ้งตอนแนบสลิป (สตางค์) และเวลาที่โอน (= วันที่ของใบกำกับภาษี) · ไม่บังคับ */
const SlipBody = z.object({ amount: z.coerce.number().int().positive().optional(), paidAt: z.coerce.date().optional() });
/** ใบกำกับภาษีที่ยังมีผลของใบแจ้งหนี้ (ฉบับใหม่แทนฉบับที่ยกเลิก) */
const activeDoc = <T extends { status: string; createdAt: Date }>(docs: T[]) => docs.filter((d) => d.status !== 'cancelled').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? docs[0];
/** ใบเสนอราคายืนราคา 30 วัน */
const QUOTE_VALID_DAYS = 30;
/** ยอดคลาดได้ไม่เกิน 1 บาท (ปัดเศษของธนาคาร) */
const AMOUNT_TOLERANCE = 100;

/**
 * เทียบยอดที่ลูกค้าแจ้งกับใบแจ้งหนี้ (A35a) · null = ตรง
 * ใบไม่มีหัก ณ ที่จ่าย แต่ยอดเท่ากับหัก 3% แล้ว = ลูกค้าหักแต่ไม่ได้แจ้ง (ต้องขอ 50 ทวิ แล้วออกใบใหม่)
 */
export function slipAmountIssue(declared: number, invoice: { amountDue: number; subtotal: number; whtAmount: number }) {
  if (Math.abs(declared - invoice.amountDue) <= AMOUNT_TOLERANCE) return null;
  if (invoice.whtAmount === 0 && Math.abs(declared - (invoice.amountDue - Math.round(invoice.subtotal * 0.03))) <= AMOUNT_TOLERANCE) return 'wht_not_declared' as const;
  return 'amount_mismatch' as const;
}

/** ตรวจชนิดไฟล์จากไบต์แรก ไม่เชื่อ Content-Type ของลูกค้า */
export function sniff(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}


/** ใบแจ้งหนี้, สลิป, 50 ทวิ, PDF และการยกเลิกแพ็กเกจ */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly payments: PaymentsService,
    private readonly analytics: AnalyticsService,
    private readonly billing: BillingService,
  ) {}

  private requireBilling(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.billing');
  }

  async list(auth: AuthInfo, tenant: TenantInfo) {
    this.requireBilling(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx.select().from(s.invoices).orderBy(desc(s.invoices.createdAt));
      const [pays, docs, whts, credits, debits] = await Promise.all([tx.select().from(s.payments), tx.select().from(s.taxDocuments), tx.select().from(s.whtCertificates), tx.select().from(s.creditNotes), tx.select().from(s.debitNotes)]);
      const base = `/api/v1/w/${tenant.slug}/billing`;
      return {
        items: rows.map((i) => {
          const p = pays.filter((x) => x.invoiceId === i.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
          const d = activeDoc(docs.filter((x) => x.invoiceId === i.id));
          const w = whts.filter((x) => x.invoiceId === i.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
          // ใบลด / เพิ่มหนี้ของใบนี้ (ลูกค้าดาวน์โหลดได้จากหน้า Billing)
          const notes = [
            ...credits.filter((c) => c.invoiceId === i.id && c.status !== 'draft').map((c) => ({ kind: 'credit' as const, id: c.id, number: c.number, amount: c.amountSatang + c.vatSatang, issuedAt: c.issuedAt ?? c.createdAt, pdfUrl: `${base}/credit-notes/${c.id}.pdf` })),
            ...debits.filter((x) => x.invoiceId === i.id).map((x) => ({ kind: 'debit' as const, id: x.id, number: x.number, amount: x.amountSatang + x.vatSatang, issuedAt: x.issuedAt ?? x.createdAt, pdfUrl: `${base}/debit-notes/${x.id}.pdf` })),
          ];
          return { ...this.view(tenant, i, p, d, w), notes };
        }),
      };
    });
  }

  /** ใบเดียว = ข้อมูลในรายการ + แพ็กเกจของใบ + บัญชีรับโอน (ถ้าโอนและยังไม่ปิด) */
  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    const { view, i, p } = await this.db.run(auth, tenant, async (tx) => {
      const i = await this.find(tx, id);
      const [p] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, i.id)).orderBy(desc(s.payments.createdAt)).limit(1);
      const d = activeDoc(await tx.select().from(s.taxDocuments).where(eq(s.taxDocuments.invoiceId, i.id)));
      const [w] = await tx.select().from(s.whtCertificates).where(eq(s.whtCertificates.invoiceId, i.id)).orderBy(desc(s.whtCertificates.createdAt));
      return { view: this.view(tenant, i, p, d, w), i, p };
    });
    const meta = await this.payments.meta(i.id).catch(() => null);
    // หน้าชำระใบแจ้งหนี้ (W22b): ลูกค้ากลับมาโอนทีหลังจึงต้องเห็นบัญชีรับโอนอีกครั้ง · ใบที่ปิดแล้วไม่ส่ง
    const transfer = p?.method === 'transfer' && (i.status === 'open' || i.status === 'pending_review') ? { ...bankFromEnv(), reference: i.number, dueDate: i.dueDate, amount: i.amountDue } : null;
    return { ...view, plan: meta?.plan ? { code: meta.plan, name: planTitle(meta.plan), cycle: meta.cycle } : null, transfer };
  }

  private view(tenant: TenantInfo, i: typeof s.invoices.$inferSelect, p?: typeof s.payments.$inferSelect, d?: typeof s.taxDocuments.$inferSelect, w?: typeof s.whtCertificates.$inferSelect) {
    const base = `/api/v1/w/${tenant.slug}/billing`;
    return {
      ...invoiceDto(i),
      method: p?.method ?? null,
      paymentStatus: p?.status ?? null,
      paymentPaidAt: p?.paidAt ?? null,
      hasSlip: !!p?.slipFileKey,
      pdfUrl: `${base}/invoices/${i.id}.pdf`,
      taxDocument: d ? { id: d.id, number: d.number, status: d.status, sentAt: d.sentAt, issuedOn: d.issuedOn, replacesId: d.replacesId, pdfUrl: `${base}/tax-documents/${d.id}.pdf` } : null,
      // ลูกค้าเห็นสาเหตุที่ไม่ผ่าน (E8) และเลขอ้างอิง e-WHT ที่แจ้งไว้
      whtCertificate: w ? { id: w.id, status: w.status, source: w.source, rejectReason: w.status === 'rejected' ? w.rejectReason : null, ewhtRef: w.ewhtRef, uploadedAt: w.createdAt } : null,
      whtDueBy: whtDueBy(i),
      /** เลยกำหนดแล้วยังอัปโหลดได้ (หน้าจอขึ้น "เลยกำหนด") */
      whtOverdue: !!whtDueBy(i) && whtDueBy(i)! < today() && (!w || w.status === 'rejected'),
    };
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  // เอกสารทุกใบสร้างจากแม่แบบเดียวใน @friday/docs · ตรวจว่าเอกสารเป็นของ Workspace นี้ผ่าน RLS ก่อน แล้วให้ตัวสร้างอ่านด้วย SYSTEM_DB
  async invoicePdf(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    const i = await this.db.run(auth, tenant, (tx) => this.find(tx, id));
    return (await invoicePdf(this.sys, i.id, { vatRegistered: config.vatRegistered }))!;
  }

  async taxDocumentPdf(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    await this.owned(auth, tenant, s.taxDocuments, id, 'เอกสารภาษี');
    return (await taxDocumentPdf(this.sys, id))!;
  }

  async creditNotePdf(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    await this.owned(auth, tenant, s.creditNotes, id, 'ใบลดหนี้');
    return (await creditNotePdf(this.sys, id, { vatRegistered: config.vatRegistered }))!;
  }

  async debitNotePdf(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    await this.owned(auth, tenant, s.debitNotes, id, 'ใบเพิ่มหนี้');
    return (await debitNotePdf(this.sys, id, { vatRegistered: config.vatRegistered }))!;
  }

  /** ใบเสนอราคา: คิดราคาแบบเดียวกับหน้าชำระเงิน แล้วเก็บไว้อ้างอิง (เลข QT- ต่อเนื่อง) · ยืนราคา 30 วัน */
  async quotationPdf(auth: AuthInfo, tenant: TenantInfo, query: unknown) {
    this.requireBilling(tenant);
    const q = parse(QuoteQuery, query);
    const { internal, ...quote } = await this.billing.price(auth, tenant, q);
    void internal;
    const date = today();
    const id = await this.db.run(auth, tenant, async (tx) => {
      const number = await nextDocNumber(tx, 'quotation', date, this.sys);
      const [row] = await tx
        .insert(s.quotations)
        .values({ workspaceId: tenant.workspaceId, number, plan: q.plan, cycle: q.cycle, wht: quote.wht, coupon: quote.coupon ?? null, subtotal: quote.subtotal, discount: quote.discount ?? 0, vat: quote.vat, total: quote.total, whtAmount: quote.whtAmount, amountDue: quote.amountDue, validUntil: bkkDate(new Date(Date.parse(`${date}T00:00:00+07:00`) + QUOTE_VALID_DAYS * DAY)), createdBy: auth.userId })
        .returning({ id: s.quotations.id });
      return row.id;
    });
    return (await quotationPdf(this.sys, id, { vatRegistered: config.vatRegistered }))!;
  }

  /** เอกสารนี้อยู่ใน Workspace ของผู้ขอ (RLS ซ่อนของ Workspace อื่น → 404) */
  private async owned(auth: AuthInfo, tenant: TenantInfo, table: typeof s.taxDocuments | typeof s.creditNotes | typeof s.debitNotes, id: string, label: string) {
    await this.db.run(auth, tenant, async (tx) => {
      if (!z.uuid().safeParse(id).success) throw notFound(label);
      const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
      if (!row) throw notFound(label);
    });
  }

  // ---------------------------------------------------------------------------
  // สลิป / 50 ทวิ
  // ---------------------------------------------------------------------------

  private validateUpload(file: { buffer: Buffer; size?: number } | undefined) {
    if (!file?.buffer?.length) throw new AppError(400, 'file_required', 'แนบไฟล์ (รูปภาพ PNG/JPG/WebP หรือ PDF)');
    if (file.buffer.length > SLIP_MAX_BYTES) throw new AppError(413, 'file_too_large', 'ไฟล์ใหญ่เกิน 5 MB');
    const type = sniff(file.buffer);
    if (!type) throw new AppError(400, 'invalid_file', 'รองรับเฉพาะรูปภาพ PNG/JPG/WebP หรือ PDF');
    return type;
  }

  private async save(folder: string, id: string, file: Buffer, ext: string) {
    const key = `${folder}/${id}-${randomUUID()}.${ext}`;
    const path = join(config.uploadDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file);
    return key;
  }

  /** แนบสลิป → ใบแจ้งหนี้ `pending_review` แต่เปิดใช้แพ็กเกจใหม่ได้ทันที (03-api 3.10) */
  async slip(auth: AuthInfo, tenant: TenantInfo, id: string, file: { buffer: Buffer } | undefined, body: unknown = {}) {
    this.requireBilling(tenant);
    const type = this.validateUpload(file);
    const { amount: declared, paidAt: declaredAt } = parse(SlipBody, body ?? {});
    const { invoice, payment } = await this.db.run(auth, tenant, async (tx) => {
      const invoice = await this.find(tx, id);
      if (invoice.status === 'paid' || invoice.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว แนบสลิปไม่ได้', { status: invoice.status });
      const [payment] = await tx.select().from(s.payments).where(and(eq(s.payments.invoiceId, invoice.id), eq(s.payments.method, 'transfer')));
      if (!payment) throw new AppError(409, 'slip_not_applicable', 'แนบสลิปได้เฉพาะใบแจ้งหนี้ที่เลือกชำระด้วยการโอน');
      // เวลาโอนเป็นวันที่ของใบกำกับภาษี: ต้องไม่ล่วงหน้า และไม่ก่อนออกใบแจ้งหนี้ (ต้องได้เลขบัญชีจากใบนี้ก่อน · เผื่อ 1 วัน)
      if (declaredAt && (declaredAt.getTime() > Date.now() + 5 * 60_000 || declaredAt.getTime() < invoice.createdAt.getTime() - DAY)) throw new AppError(400, 'invalid_paid_at', 'เวลาที่โอนต้องอยู่ระหว่างวันที่ออกใบแจ้งหนี้ถึงตอนนี้', { min: invoice.createdAt });
      return { invoice, payment };
    });
    const slipFileKey = await this.save('slips', invoice.id, file!.buffer, type.ext);
    const meta = await this.payments.meta(invoice.id);
    // สลิปซ้ำ: ไฟล์เดียวกันเคยแนบกับใบแจ้งหนี้อื่น (ทุก Workspace จึงใช้ SYSTEM_DB) · Slip API ที่อ่านเลขอ้างอิงธนาคารมาในเฟส 2
    const ref = `slip:${createHash('sha256').update(file!.buffer).digest('hex')}`;
    const [dupe] = await this.sys.select({ invoiceId: s.payments.invoiceId }).from(s.payments).where(and(eq(s.payments.method, 'transfer'), eq(s.payments.providerRef, ref), ne(s.payments.id, payment.id)));
    const exception = dupe ? ('duplicate_slip' as const) : declared === undefined ? null : slipAmountIssue(declared, invoice);
    // payments / invoices / subscriptions แก้ผ่านแอปไม่ได้ (เงิน) จึงเขียนด้วย SYSTEM_DB หลังตรวจเจ้าของใบแจ้งหนี้ด้านบนแล้ว
    await this.sys.transaction(async (tx) => {
      // ช่วงแรกทีมตรวจสลิปเองทุกใบ (pending_review) · exception_reason ทำให้ขึ้นคิวกรณีผิดปกติของ Friday Ops
      await tx.update(s.payments).set({ slipFileKey, providerRef: dupe ? payment.providerRef : ref, exceptionReason: exception, status: 'pending_review', paidAt: declaredAt ?? new Date(), updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
      await tx.update(s.invoices).set({ status: 'pending_review', updatedAt: new Date() }).where(eq(s.invoices.id, invoice.id));
      // เก็บสลิปเสมอ แต่เปิดสิทธิ์ชั่วคราวเฉพาะเมื่อใบนี้ยังไม่ถูกแทนที่ด้วยใบที่ใหม่กว่า (N02) และสลิปไม่ซ้ำ
      const granted = exception === 'duplicate_slip' ? false : await this.payments.activate(tx, invoice, meta);
      const note = exception ? ` · ผิดปกติ: ${exception}${declared !== undefined ? ` (แจ้ง ${declared / 100} บาท)` : ''}` : '';
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.slip_uploaded', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · ${type.mime} · ${granted ? `เปิดแพ็กเกจ ${meta.plan} ระหว่างรอตรวจ` : exception === 'duplicate_slip' ? 'ไม่เปิดแพ็กเกจ (สลิปซ้ำ)' : 'ไม่เปลี่ยนแพ็กเกจ (มีใบที่ใหม่กว่าเปิดสิทธิ์อยู่)'}${note}` });
    });
    return this.get(auth, tenant, id);
  }

  /** ใบที่ส่ง 50 ทวิ ได้: มีหัก ณ ที่จ่าย · ไม่ถูกยกเลิก · ยังไม่ผ่านการตรวจ (เลยกำหนดแล้วยังส่งได้ ไม่ให้ลูกค้าเสียเครดิตภาษี) */
  private async whtInvoice(auth: AuthInfo, tenant: TenantInfo, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const invoice = await this.find(tx, id);
      if (invoice.whtAmount <= 0) throw new AppError(409, 'wht_not_applicable', 'ใบแจ้งหนี้นี้ไม่มีการหักภาษี ณ ที่จ่าย');
      if (invoice.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ถูกยกเลิก');
      const [last] = await tx.select({ status: s.whtCertificates.status }).from(s.whtCertificates).where(eq(s.whtCertificates.invoiceId, invoice.id)).orderBy(desc(s.whtCertificates.createdAt)).limit(1);
      if (last?.status === 'confirmed') throw new AppError(409, 'wht_already_confirmed', 'ทีมได้รับ 50 ทวิ ของใบนี้แล้ว');
      return invoice;
    });
  }

  async whtCertificate(auth: AuthInfo, tenant: TenantInfo, id: string, file: { buffer: Buffer } | undefined) {
    this.requireBilling(tenant);
    const type = this.validateUpload(file);
    const invoice = await this.whtInvoice(auth, tenant, id);
    const fileKey = await this.save('wht', invoice.id, file!.buffer, type.ext);
    const due = whtDueBy(invoice);
    await this.sys.transaction(async (tx) => {
      await tx.insert(s.whtCertificates).values({ workspaceId: tenant.workspaceId, invoiceId: invoice.id, fileKey, uploadedBy: auth.userId, source: 'upload' });
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.wht_uploaded', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · 50 ทวิ ${invoice.whtAmount / 100} บาท${due && due < today() ? ` · เลยกำหนด ${due}` : ''}` });
    });
    return this.get(auth, tenant, id);
  }

  /**
   * หักผ่าน e-Withholding Tax (E11): ไม่มีไฟล์ · ใบขึ้น "รอยืนยันจากกรมสรรพากร" และหยุดอีเมลขอ 50 ทวิ
   * ทีมการเงินปิดรายการเมื่อนำเข้าไฟล์ e-WHT ที่จับคู่ได้ (E9)
   */
  async whtEwht(auth: AuthInfo, tenant: TenantInfo, id: string, body: unknown) {
    this.requireBilling(tenant);
    const { reference } = parse(EwhtBody, body ?? {});
    const invoice = await this.whtInvoice(auth, tenant, id);
    await this.sys.transaction(async (tx) => {
      await tx.insert(s.whtCertificates).values({ workspaceId: tenant.workspaceId, invoiceId: invoice.id, fileKey: null, uploadedBy: auth.userId, source: 'ewht', status: 'pending_ewht', ewhtRef: reference });
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.wht_ewht_declared', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · หักผ่าน e-WHT ${invoice.whtAmount / 100} บาท · อ้างอิง ${reference}` });
    });
    return this.get(auth, tenant, id);
  }

  // ---------------------------------------------------------------------------
  // ยกเลิกแพ็กเกจ · ใช้ต่อได้ถึงสิ้นรอบ
  // ---------------------------------------------------------------------------

  async cancel(auth: AuthInfo, tenant: TenantInfo) {
    if (tenant.role !== 'owner') throw forbidden('ws.owner');
    const sub = await this.db.run(auth, tenant, async (tx) => {
      const [sub] = await tx.select().from(s.subscriptions);
      if (!sub) throw new AppError(409, 'nothing_to_cancel', 'ยังไม่มีแพ็กเกจที่ต้องยกเลิก');
      if (sub.status === 'canceled') throw new AppError(409, 'already_canceled', 'ยกเลิกแพ็กเกจไปแล้ว', { endsAt: sub.currentPeriodEnd });
      return sub;
    });
    // ทดลองใช้: ใช้ได้ถึงวันสิ้นสุดทดลอง · แพ็กเกจที่ชำระ: ถึงสิ้นรอบที่จ่ายแล้ว (effectivePlan ใน billing/catalog.ts เปลี่ยนเป็น Free เมื่อพ้นวันนั้น)
    const endsAt = sub.status === 'trialing' ? (sub.trialEndsAt ?? new Date()) : (sub.currentPeriodEnd ?? new Date());
    await this.sys.transaction(async (tx) => {
      await tx.update(s.subscriptions).set({ status: 'canceled', currentPeriodEnd: endsAt, updatedAt: new Date() }).where(eq(s.subscriptions.id, sub.id));
      // A34: ยกเลิกช่วงทดลองไม่กระทบ MRR · ยกเลิกแพ็กเกจที่จ่ายเงิน MRR เป็น 0 เมื่อสิ้นรอบ
      if (sub.status !== 'trialing') {
        const [plan] = await tx.select({ code: s.plans.code }).from(s.plans).where(eq(s.plans.id, sub.planId));
        await this.analytics.subscriptionChanged(tx, { workspaceId: tenant.workspaceId, kind: 'cancel', planFrom: plan?.code ?? null, planTo: null, mrrAfterSatang: 0, actorKind: 'user', actorId: auth.userId, effectiveAt: endsAt });
      }
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.subscription_canceled', targetType: 'subscription', targetId: sub.id, summary: `ยกเลิกแพ็กเกจ · ใช้ได้ถึง ${endsAt.toISOString().slice(0, 10)}` });
    });
    return { status: 'canceled' as const, endsAt, today: today() };
  }

  private async find(tx: Tx, id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('ใบแจ้งหนี้');
    const [i] = await tx.select().from(s.invoices).where(eq(s.invoices.id, id));
    if (!i) throw notFound('ใบแจ้งหนี้');
    return i;
  }
}
