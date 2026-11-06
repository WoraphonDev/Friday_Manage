import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { today } from '../common/dates.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { type BillDoc, renderBill } from './pdf.js';
import { type CheckoutMeta, invoiceDto, PaymentsService } from './payments.service.js';

const s = schema;
const DAY = 86_400_000;
export const SLIP_MAX_BYTES = 5 * 1024 * 1024;
/** 50 ทวิ ต้องส่งภายใน 30 วัน */
export const WHT_DEADLINE_DAYS = 30;
const PLAN_NAMES: Record<string, string> = { team_s: 'Team S', team_m: 'Team M', team_l: 'Team L' };

/** ตรวจชนิดไฟล์จากไบต์แรก ไม่เชื่อ Content-Type ของลูกค้า */
export function sniff(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

const seller = () => ({
  name: process.env.SELLER_NAME ?? 'บริษัท ฟรายเดย์ จำกัด (ตัวอย่าง)',
  taxId: process.env.SELLER_TAX_ID ?? '0105500000000',
  address: process.env.SELLER_ADDRESS ?? '99 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10000',
});

/** ใบแจ้งหนี้, สลิป, 50 ทวิ, PDF และการยกเลิกแพ็กเกจ */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly payments: PaymentsService,
  ) {}

  private requireBilling(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.billing');
  }

  async list(auth: AuthInfo, tenant: TenantInfo) {
    this.requireBilling(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx.select().from(s.invoices).orderBy(desc(s.invoices.createdAt));
      const [pays, docs, whts] = await Promise.all([tx.select().from(s.payments), tx.select().from(s.taxDocuments), tx.select().from(s.whtCertificates)]);
      return {
        items: rows.map((i) => {
          const p = pays.find((x) => x.invoiceId === i.id);
          const d = docs.find((x) => x.invoiceId === i.id);
          const w = whts.filter((x) => x.invoiceId === i.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
          return this.view(tenant, i, p, d, w);
        }),
      };
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const i = await this.find(tx, id);
      const [p] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, i.id));
      const [d] = await tx.select().from(s.taxDocuments).where(eq(s.taxDocuments.invoiceId, i.id));
      const [w] = await tx.select().from(s.whtCertificates).where(eq(s.whtCertificates.invoiceId, i.id)).orderBy(desc(s.whtCertificates.createdAt));
      return this.view(tenant, i, p, d, w);
    });
  }

  private view(tenant: TenantInfo, i: typeof s.invoices.$inferSelect, p?: typeof s.payments.$inferSelect, d?: typeof s.taxDocuments.$inferSelect, w?: typeof s.whtCertificates.$inferSelect) {
    const base = `/api/v1/w/${tenant.slug}/billing`;
    return {
      ...invoiceDto(i),
      method: p?.method ?? null,
      paymentStatus: p?.status ?? null,
      hasSlip: !!p?.slipFileKey,
      pdfUrl: `${base}/invoices/${i.id}.pdf`,
      taxDocument: d ? { id: d.id, number: d.number, status: d.status, sentAt: d.sentAt, pdfUrl: `${base}/tax-documents/${d.id}.pdf` } : null,
      whtCertificate: w ? { id: w.id, status: w.status, uploadedAt: w.createdAt } : null,
      whtDueBy: i.whtAmount > 0 ? new Date(i.createdAt.getTime() + WHT_DEADLINE_DAYS * DAY).toISOString().slice(0, 10) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  async invoicePdf(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    const { i, profile, meta, p } = await this.db.run(auth, tenant, async (tx) => {
      const i = await this.find(tx, id);
      const [profile] = await tx.select().from(s.billingProfiles);
      const [p] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, i.id));
      return { i, profile, p, meta: await this.payments.meta(i.id).catch(() => null) };
    });
    return { filename: `${i.number}.pdf`, buffer: await renderBill(this.doc(i, profile, meta, p, false, i.number)) };
  }

  async taxDocumentPdf(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.requireBilling(tenant);
    const { d, i, profile, meta, p } = await this.db.run(auth, tenant, async (tx) => {
      if (!z.uuid().safeParse(id).success) throw notFound('เอกสารภาษี');
      const [d] = await tx.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, id));
      if (!d) throw notFound('เอกสารภาษี');
      const i = await this.find(tx, d.invoiceId);
      const [profile] = await tx.select().from(s.billingProfiles);
      const [p] = await tx.select().from(s.payments).where(eq(s.payments.invoiceId, i.id));
      return { d, i, profile, p, meta: await this.payments.meta(i.id).catch(() => null) };
    });
    return { filename: `${d.number}.pdf`, buffer: await renderBill(this.doc(i, profile, meta, p, true, d.number)) };
  }

  private doc(i: typeof s.invoices.$inferSelect, profile: typeof s.billingProfiles.$inferSelect | undefined, meta: CheckoutMeta | null, p: typeof s.payments.$inferSelect | undefined, tax: boolean, number: string): BillDoc {
    const planName = meta ? (PLAN_NAMES[meta.plan] ?? meta.plan) : 'Friday Manage';
    const cycle = meta?.cycle === 'yearly' ? 'รายปี' : 'รายเดือน';
    return {
      title: tax ? 'ใบเสร็จรับเงิน / ใบกำกับภาษี' : 'ใบแจ้งหนี้',
      subtitle: tax ? 'Receipt / Tax Invoice' : 'Invoice',
      number,
      date: (tax ? (i.paidAt ?? i.createdAt) : i.createdAt).toISOString().slice(0, 10),
      seller: seller(),
      buyer: {
        companyName: profile?.companyName ?? '-',
        taxId: profile?.taxId ?? '-',
        branch: profile ? (profile.branchType === 'head' ? '(สำนักงานใหญ่)' : `(สาขา ${profile.branchNo})`) : '',
        address: profile?.address ?? '-',
        email: profile?.taxEmail ?? '',
      },
      lines: [{ description: `Friday Manage ${planName} · ${cycle} · ${i.periodStart} ถึง ${i.periodEnd}`, amount: i.subtotal }],
      subtotal: i.subtotal,
      vat: i.vat,
      total: i.total,
      whtAmount: i.whtAmount,
      amountDue: i.amountDue,
      status: i.status === 'paid' ? 'ชำระแล้ว / Paid' : i.status === 'pending_review' ? 'รอตรวจสลิป / Pending review' : i.status === 'void' ? 'ยกเลิก / Void' : 'รอชำระ / Open',
      footer: [
        ...(i.poNumber ? [`เลขที่ PO: ${i.poNumber}`] : []),
        ...(p ? [`ช่องทางชำระ: ${p.method === 'card' ? 'บัตรเครดิต/เดบิต' : p.method === 'promptpay' ? 'PromptPay' : 'โอนเงิน'}`] : []),
        ...(i.whtAmount > 0 ? ['ผู้ซื้อหักภาษี ณ ที่จ่าย 3% · ส่งหนังสือรับรองการหักภาษี (50 ทวิ) ภายใน 30 วัน'] : []),
        'เอกสารนี้สร้างโดยระบบ Friday Manage · ข้อมูลผู้ขายเป็นตัวอย่างเมื่อยังไม่ได้ตั้งค่า',
      ],
    };
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
  async slip(auth: AuthInfo, tenant: TenantInfo, id: string, file: { buffer: Buffer } | undefined) {
    this.requireBilling(tenant);
    const type = this.validateUpload(file);
    const { invoice, payment } = await this.db.run(auth, tenant, async (tx) => {
      const invoice = await this.find(tx, id);
      if (invoice.status === 'paid' || invoice.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว แนบสลิปไม่ได้', { status: invoice.status });
      const [payment] = await tx.select().from(s.payments).where(and(eq(s.payments.invoiceId, invoice.id), eq(s.payments.method, 'transfer')));
      if (!payment) throw new AppError(409, 'slip_not_applicable', 'แนบสลิปได้เฉพาะใบแจ้งหนี้ที่เลือกชำระด้วยการโอน');
      return { invoice, payment };
    });
    const slipFileKey = await this.save('slips', invoice.id, file!.buffer, type.ext);
    const meta = await this.payments.meta(invoice.id);
    // payments / invoices / subscriptions แก้ผ่านแอปไม่ได้ (เงิน) จึงเขียนด้วย SYSTEM_DB หลังตรวจเจ้าของใบแจ้งหนี้ด้านบนแล้ว
    await this.sys.transaction(async (tx) => {
      await tx.update(s.payments).set({ slipFileKey, status: 'pending_review', updatedAt: new Date() }).where(eq(s.payments.id, payment.id));
      await tx.update(s.invoices).set({ status: 'pending_review', updatedAt: new Date() }).where(eq(s.invoices.id, invoice.id));
      // เก็บสลิปเสมอ แต่เปิดสิทธิ์ชั่วคราวเฉพาะเมื่อใบนี้ยังไม่ถูกแทนที่ด้วยใบที่ใหม่กว่า (N02)
      const granted = await this.payments.activate(tx, invoice, meta);
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.slip_uploaded', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · ${type.mime} · ${granted ? `เปิดแพ็กเกจ ${meta.plan} ระหว่างรอตรวจ` : 'ไม่เปลี่ยนแพ็กเกจ (มีใบที่ใหม่กว่าเปิดสิทธิ์อยู่)'}` });
    });
    return this.get(auth, tenant, id);
  }

  async whtCertificate(auth: AuthInfo, tenant: TenantInfo, id: string, file: { buffer: Buffer } | undefined) {
    this.requireBilling(tenant);
    const type = this.validateUpload(file);
    const invoice = await this.db.run(auth, tenant, async (tx) => {
      const invoice = await this.find(tx, id);
      if (invoice.whtAmount <= 0) throw new AppError(409, 'wht_not_applicable', 'ใบแจ้งหนี้นี้ไม่มีการหักภาษี ณ ที่จ่าย');
      if (invoice.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ถูกยกเลิก');
      const deadline = new Date(invoice.createdAt.getTime() + WHT_DEADLINE_DAYS * DAY);
      if (Date.now() > deadline.getTime()) throw new AppError(409, 'wht_deadline_passed', `ส่ง 50 ทวิ ได้ภายใน ${WHT_DEADLINE_DAYS} วันนับจากออกใบแจ้งหนี้`, { dueBy: deadline.toISOString().slice(0, 10) });
      return invoice;
    });
    const fileKey = await this.save('wht', invoice.id, file!.buffer, type.ext);
    await this.sys.transaction(async (tx) => {
      await tx.insert(s.whtCertificates).values({ workspaceId: tenant.workspaceId, invoiceId: invoice.id, fileKey, uploadedBy: auth.userId });
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'billing.wht_uploaded', targetType: 'invoice', targetId: invoice.id, summary: `${invoice.number} · 50 ทวิ ${invoice.whtAmount / 100} บาท` });
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
