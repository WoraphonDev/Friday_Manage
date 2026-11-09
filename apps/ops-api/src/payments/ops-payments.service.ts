import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, fallbackGrant, isGrantSource, schema } from '@friday/db';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { activate, billingContacts, mailAll, metaOf, settleInvoice, todayBkk } from '../billing/ledger.js';

const s = schema;
/** ที่เก็บไฟล์ที่ API ลูกค้าบันทึกสลิป / 50 ทวิ (ตัวแปรเดียวกับ apps/api) · S3 ยังไม่รองรับ */
const uploadDir = () => resolve(process.env.UPLOAD_DIR ?? '../api/var/uploads');

/** เหตุผิดปกติ 8 แบบตามหน้าจอ (check ใน payments_exception_reason_valid) */
export const EXCEPTION_REASONS = ['amount_mismatch', 'wht_not_declared', 'duplicate_slip', 'payer_name_mismatch', 'unmatched', 'double_payment', 'wht_certificate', 'unreadable_slip'] as const;
const SUGGEST: Record<(typeof EXCEPTION_REASONS)[number], string> = {
  amount_mismatch: 'เทียบยอดกับสลิป · ยอดเกินเก็บเป็นเครดิต · ยอดขาดให้ใบแจ้งหนี้ค้างส่วนที่เหลือ',
  wht_not_declared: 'ขอ 50 ทวิ จากลูกค้า แล้วผ่าน (ออกใบแจ้งหนี้ใหม่แบบหัก ณ ที่จ่าย)',
  duplicate_slip: 'ไม่ผ่าน · สลิปนี้เคยใช้กับใบแจ้งหนี้อื่น',
  payer_name_mismatch: 'ถามลูกค้าว่าโอนในนามใคร แล้วผ่านถ้ายืนยันได้',
  unmatched: 'ผูกกับใบแจ้งหนี้ที่ยอดตรง',
  double_payment: 'เก็บเป็นเครดิต หรือคืนเงิน',
  wht_certificate: 'ตรวจ 50 ทวิ',
  unreadable_slip: 'ไม่ผ่าน · ขอสลิปใหม่',
};

export const PaymentsQuery = z.object({ status: z.enum(['pending_review', 'confirmed', 'rejected']).default('pending_review'), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const ConfirmBody = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const RejectBody = z
  .object({
    reason: z.string().trim().min(3).max(300),
    /** ข้อความถึงลูกค้า (B6) · ไม่ระบุ = ใช้เหตุผล */
    message: z.string().trim().max(2000).optional(),
  })
  .strict();
export const ExceptionsQuery = z.object({ reason: z.enum(EXCEPTION_REASONS).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const FlagBody = z.object({ reason: z.enum(EXCEPTION_REASONS), note: z.string().trim().min(3).max(300) }).strict();
export const MatchBody = z.object({ invoiceId: z.uuid(), reason: z.string().trim().min(3).max(300) }).strict();
export const CreditBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const IncomingQuery = z.object({
  date: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** ตรวจสลิปและ 50 ทวิ (3.12) · ฝั่งลูกค้า (A33) เปิดแพ็กเกจให้ก่อนตั้งแต่แนบสลิป */
@Injectable()
export class OpsPaymentsService {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  async list(q: z.infer<typeof PaymentsQuery>) {
    const rows = await this.db
      .select({ p: s.payments, inv: s.invoices, ws: { id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name } })
      .from(s.payments)
      .innerJoin(s.invoices, eq(s.invoices.id, s.payments.invoiceId))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.payments.workspaceId))
      .where(eq(s.payments.status, q.status))
      .orderBy(desc(s.payments.createdAt))
      .limit(q.limit);
    const wht = rows.length ? await this.db.select().from(s.whtCertificates).where(inArray(s.whtCertificates.invoiceId, rows.map((r) => r.inv.id))) : [];
    return {
      items: rows.map(({ p, inv, ws }) => ({
        id: p.id,
        method: p.method,
        amount: p.amount,
        status: p.status,
        hasSlip: !!p.slipFileKey,
        verifiedBy: p.verifiedBy,
        exceptionReason: p.exceptionReason,
        providerRef: p.providerRef?.startsWith('slip:') ? null : p.providerRef,
        createdAt: p.createdAt,
        reviewedAt: p.reviewedAt,
        invoice: { id: inv.id, number: inv.number, status: inv.status, total: inv.total, whtAmount: inv.whtAmount, amountDue: inv.amountDue, dueDate: inv.dueDate },
        workspace: ws,
        whtCertificates: wht.filter((w) => w.invoiceId === inv.id).map((w) => ({ id: w.id, status: w.status, createdAt: w.createdAt })),
      })),
    };
  }

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการชำระเงิน');
    const [p] = await this.db.select().from(s.payments).where(eq(s.payments.id, id));
    if (!p) throw new AppError(404, 'not_found', 'ไม่พบรายการชำระเงิน');
    const [inv] = await this.db.select().from(s.invoices).where(eq(s.invoices.id, p.invoiceId));
    return { p, inv };
  }

  /** ดาวน์โหลดสลิปหรือ 50 ทวิ (ตรวจกับไฟล์ในที่เก็บ) */
  private async file(key: string | null) {
    if (!key) throw new AppError(404, 'not_found', 'ไม่มีไฟล์แนบ');
    const root = join(uploadDir());
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new AppError(400, 'invalid_key', 'ตำแหน่งไฟล์ไม่ถูกต้อง');
    const info = await stat(path).catch(() => null);
    if (!info) throw new AppError(404, 'file_missing', 'ไม่พบไฟล์ในที่เก็บ (ที่เก็บ S3 ยังไม่รองรับในหลังบ้าน)');
    return { stream: createReadStream(path), size: info.size, filename: key.split('/').pop() ?? 'file' };
  }
  async slip(id: string) {
    return this.file((await this.find(id)).p.slipFileKey);
  }
  async whtFile(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ 50 ทวิ');
    const [w] = await this.db.select().from(s.whtCertificates).where(eq(s.whtCertificates.id, id));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ 50 ทวิ');
    return this.file(w.fileKey);
  }

  /** ผ่าน: ยืนยันเงินเข้า → ใบแจ้งหนี้ paid → ต่ออายุ → ออกใบกำกับภาษี · ล้างเหตุผิดปกติ */
  async confirm(staff: Staff, id: string, input: z.infer<typeof ConfirmBody>) {
    const { p, inv } = await this.find(id);
    if (p.status === 'confirmed') throw new AppError(409, 'already_confirmed', 'ยืนยันรายการนี้แล้ว');
    if (p.exceptionReason === 'double_payment') throw new AppError(409, 'double_payment', 'ใบแจ้งหนี้นี้ชำระแล้ว ใช้ "เก็บเป็นเครดิต" หรือคืนเงินแทน');
    if (inv.status === 'paid' || inv.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว', { status: inv.status });
    let granted = false;
    await this.db.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'staff', exceptionReason: null, reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(s.payments.id, p.id));
      granted = await settleInvoice(tx, inv);
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_confirmed', `ยืนยันการชำระ ${inv.number} · ${p.method} · ${p.amount / 100} บาท${p.exceptionReason ? ` · กรณี ${p.exceptionReason}` : ''}${granted ? '' : ' · ไม่เปลี่ยนแพ็กเกจ'}${input.note ? ` · ${input.note}` : ''}`, { type: 'payment', id: p.id });
    });
    return { id: p.id, status: 'confirmed' as const, invoice: inv.number, granted };
  }

  /** ปฏิเสธสลิป: ใบแจ้งหนี้กลับเป็น open ให้แนบใหม่ได้ · ถ้าแพ็กเกจถูกเปิดด้วยใบนี้ ให้เลิกสิทธิ์ทันที (กลับเป็น Free) */
  async reject(staff: Staff, id: string, input: z.infer<typeof RejectBody>) {
    const { p, inv } = await this.find(id);
    if (p.status === 'confirmed') throw new AppError(409, 'already_confirmed', 'ยืนยันไปแล้ว ปฏิเสธไม่ได้');
    if (p.status === 'rejected') throw new AppError(409, 'already_rejected', 'ปฏิเสธรายการนี้แล้ว');
    let revoked = false;
    await this.db.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'rejected', reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(s.payments.id, p.id));
      await tx.update(s.invoices).set({ status: 'open', updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      // เลิกสิทธิ์เฉพาะเมื่อใบนี้เป็นแหล่งสิทธิ์ปัจจุบันจริง (N01): เดิมเทียบแค่วันเริ่มรอบ ใบอื่นที่ชำระแล้วในวันเดียวกันจึงถูกยกเลิกไปด้วย
      if (await isGrantSource(tx, inv)) {
        // มีใบอื่นที่ชำระแล้วและรอบยังไม่จบ → คืนสิทธิ์ของใบนั้น · ไม่มี → ยกเลิก
        const back = await fallbackGrant(tx, inv.subscriptionId, inv.id);
        const meta = back ? await metaOf(tx, back.id) : null;
        if (back && meta) await activate(tx, back, meta);
        else await tx.update(s.subscriptions).set({ status: 'canceled', currentPeriodEnd: new Date(), updatedAt: new Date() }).where(eq(s.subscriptions.id, inv.subscriptionId));
        revoked = true;
      }
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_rejected', `ปฏิเสธการชำระ ${inv.number} · ${input.reason}${revoked ? ' · เลิกสิทธิ์แพ็กเกจที่เปิดชั่วคราว' : ''}`, { type: 'payment', id: p.id });
    });
    await this.notifyAdmins(inv.workspaceId, `สลิปการโอน ${inv.number} ไม่ผ่านการตรวจ`, `${input.message ?? `เหตุผล: ${input.reason}`}\nแนบสลิปใหม่ได้ที่หน้า การเรียกเก็บเงิน${revoked ? '\nแพ็กเกจที่เปิดไว้ชั่วคราวถูกยกเลิก จนกว่าจะยืนยันการชำระ' : ''}`);
    return { id: p.id, status: 'rejected' as const, revoked };
  }

  /**
   * คิวกรณีผิดปกติ: เฉพาะรายการที่ระบบยืนยันเองไม่ได้ (A35a) · เรียงจากรอนานสุด · มีหลักฐาน ลำดับเหตุการณ์ และสิ่งที่ระบบแนะนำ
   */
  async exceptions(q: z.infer<typeof ExceptionsQuery>) {
    const rows = await this.db
      .select({ p: s.payments, inv: s.invoices, ws: { id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name } })
      .from(s.payments)
      .innerJoin(s.invoices, eq(s.invoices.id, s.payments.invoiceId))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.payments.workspaceId))
      .where(and(eq(s.payments.status, 'pending_review'), isNotNull(s.payments.exceptionReason), q.reason ? eq(s.payments.exceptionReason, q.reason) : undefined))
      .orderBy(s.payments.updatedAt)
      .limit(q.limit);
    const ids = rows.map((r) => r.inv.id);
    const timeline = ids.length
      ? await this.db
          .select({ invoiceId: s.auditLogs.targetId, at: s.auditLogs.createdAt, action: s.auditLogs.action, actorKind: s.auditLogs.actorKind, summary: s.auditLogs.summary })
          .from(s.auditLogs)
          .where(and(inArray(s.auditLogs.targetId, ids), ne(s.auditLogs.action, 'billing.checkout')))
          .orderBy(s.auditLogs.createdAt)
      : [];
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(s.payments).where(sql`${s.payments.createdAt} > now() - interval '30 days'`);
    return {
      items: rows.map(({ p, inv, ws }) => ({
        id: p.id,
        reason: p.exceptionReason,
        suggestion: SUGGEST[p.exceptionReason as (typeof EXCEPTION_REASONS)[number]],
        method: p.method,
        expectedSatang: inv.amountDue,
        receivedSatang: p.amount,
        hasSlip: !!p.slipFileKey,
        waitingSince: p.updatedAt,
        invoice: { id: inv.id, number: inv.number, status: inv.status, subtotal: inv.subtotal, whtAmount: inv.whtAmount, amountDue: inv.amountDue, dueDate: inv.dueDate },
        workspace: ws,
        timeline: timeline.filter((t) => t.invoiceId === inv.id).map(({ invoiceId, ...t }) => t),
      })),
      /** ยอดรวม 30 วันเทียบกับที่เหลือในคิว (หน้าจอ: "จาก N รายการ ยืนยันเอง") */
      payments30d: total,
    };
  }

  /** พนักงานติดเหตุผิดปกติเอง (ชื่อผู้โอนไม่ตรง, ตรวจสลิปไม่ได้ ฯลฯ) · เฉพาะรายการที่ยังไม่ยืนยัน */
  async flag(staff: Staff, id: string, input: z.infer<typeof FlagBody>) {
    const { p, inv } = await this.find(id);
    if (p.status !== 'pending_review') throw new AppError(409, 'payment_closed', 'ตัดสินรายการนี้แล้ว', { status: p.status });
    await this.db.transaction(async (tx) => {
      await tx.update(s.payments).set({ exceptionReason: input.reason, updatedAt: new Date() }).where(eq(s.payments.id, p.id));
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_flagged', `ตั้งเป็นกรณีผิดปกติ ${input.reason} · ${inv.number} · ${input.note}`, { type: 'payment', id: p.id });
    });
    return { id: p.id, reason: input.reason };
  }

  /**
   * ผูกเงินเข้ากับใบแจ้งหนี้อื่นของ Workspace เดียวกัน (B7) แล้วผ่าน
   * ยอดเกินใบแจ้งหนี้ → ส่วนเกินเป็นเครดิต · ยอดขาด → ใบแจ้งหนี้ยังค้าง (ยังไม่รองรับชำระบางส่วน จึงไม่ปิดใบ)
   */
  async match(staff: Staff, id: string, input: z.infer<typeof MatchBody>) {
    const { p, inv } = await this.find(id);
    if (p.status === 'confirmed') throw new AppError(409, 'already_confirmed', 'ยืนยันรายการนี้แล้ว');
    const [target] = await this.db.select().from(s.invoices).where(eq(s.invoices.id, input.invoiceId));
    if (!target || target.workspaceId !== p.workspaceId) throw new AppError(404, 'invoice_not_found', 'ไม่พบใบแจ้งหนี้นี้ใน Workspace เดียวกัน');
    if (target.status === 'paid' || target.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว', { status: target.status });
    const over = p.amount - target.amountDue;
    let result: { settled: boolean; creditSatang: number; remainingSatang: number } = { settled: false, creditSatang: 0, remainingSatang: 0 };
    await this.db.transaction(async (tx) => {
      await tx.update(s.payments).set({ matchedInvoiceId: target.id, status: 'confirmed', verifiedBy: 'staff', exceptionReason: null, reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(s.payments.id, p.id));
      // ใบเดิมที่ถูกตั้งเป็นรอตรวจเพราะรายการนี้ กลับเป็นค้างชำระ
      if (inv.id !== target.id && inv.status === 'pending_review') await tx.update(s.invoices).set({ status: 'open', updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      if (over >= 0) {
        await settleInvoice(tx, target);
        if (over > 0) await tx.insert(s.workspaceCredits).values({ workspaceId: p.workspaceId, amountSatang: over, source: 'overpayment', invoiceId: target.id, note: `ส่วนเกินจากเงินเข้า ${p.amount / 100} บาท`, createdByStaff: staff.id });
        result = { settled: true, creditSatang: over, remainingSatang: 0 };
      } else result = { settled: false, creditSatang: 0, remainingSatang: -over };
      await audit(tx, staff, p.workspaceId, 'plan', 'ops.payment_matched', `ผูกเงินเข้า ${p.amount / 100} บาทกับ ${target.number}${over > 0 ? ` · ส่วนเกิน ${over / 100} บาทเป็นเครดิต` : over < 0 ? ` · ยังค้าง ${-over / 100} บาท` : ''} · ${input.reason}`, { type: 'payment', id: p.id });
    });
    return { id: p.id, invoice: target.number, ...result };
  }

  /** เก็บเงินเป็นเครดิต (จ่ายซ้ำ / จ่ายเกิน) · ใบแจ้งหนี้เดิมไม่เปลี่ยน · หักรอบถัดไป */
  async toCredit(staff: Staff, id: string, input: z.infer<typeof CreditBody>) {
    const { p, inv } = await this.find(id);
    if (p.status !== 'pending_review') throw new AppError(409, 'payment_closed', 'ตัดสินรายการนี้แล้ว', { status: p.status });
    if (inv.status !== 'paid') throw new AppError(409, 'invoice_not_paid', 'ใบแจ้งหนี้ยังไม่ได้ชำระ ใช้ "ผ่าน" หรือผูกกับใบแจ้งหนี้แทน');
    await this.db.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'staff', exceptionReason: null, reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(s.payments.id, p.id));
      await tx.insert(s.workspaceCredits).values({ workspaceId: p.workspaceId, amountSatang: p.amount, source: 'overpayment', invoiceId: inv.id, note: input.reason, createdByStaff: staff.id });
      await audit(tx, staff, p.workspaceId, 'plan', 'ops.payment_to_credit', `เก็บเงินเข้า ${p.amount / 100} บาท (${inv.number}) เป็นเครดิต · ${input.reason}`, { type: 'payment', id: p.id });
    });
    await this.notifyAdmins(p.workspaceId, `ได้รับเงิน ${p.amount / 100} บาทเกินใบแจ้งหนี้ ${inv.number}`, `ทีม Friday เก็บยอดนี้เป็นเครดิต ใช้หักรอบถัดไปอัตโนมัติ\nถ้าต้องการรับเงินคืน ตอบกลับอีเมลนี้`);
    return { id: p.id, creditSatang: p.amount };
  }

  /** รายการเงินเข้า (วันเดียว · ค่าเริ่มต้นวันนี้) พร้อมผู้ยืนยันและสถานะกระทบยอด */
  async incoming(q: z.infer<typeof IncomingQuery>) {
    const day = q.date ?? todayBkk();
    const rows = await this.db
      .select({ p: s.payments, inv: { id: s.invoices.id, number: s.invoices.number, status: s.invoices.status }, ws: { id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name } })
      .from(s.payments)
      .innerJoin(s.invoices, eq(s.invoices.id, s.payments.invoiceId))
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.payments.workspaceId))
      .where(and(ne(s.payments.status, 'rejected'), sql`(coalesce(${s.payments.reviewedAt}, ${s.payments.updatedAt}) at time zone 'Asia/Bangkok')::date = ${day}::date`, sql`(${s.payments.status} = 'confirmed' or ${s.payments.slipFileKey} is not null or ${s.payments.exceptionReason} is not null)`))
      .orderBy(desc(s.payments.updatedAt))
      .limit(q.limit);
    const items = rows.map(({ p, inv, ws }) => ({
      id: p.id,
      at: p.reviewedAt ?? p.updatedAt,
      amount: p.amount,
      method: p.method,
      verifiedBy: p.verifiedBy,
      providerRef: p.providerRef?.startsWith('slip:') ? null : p.providerRef,
      status: p.status,
      exceptionReason: p.exceptionReason,
      /** ระบบผู้ให้บริการยืนยัน = กระทบยอดแล้ว · ทีมยืนยันจากสลิป = รอเทียบ statement ธนาคาร (Bill Payment / statement เข้าเฟส 2) */
      reconciliation: p.status !== 'confirmed' ? 'pending' : p.verifiedBy === 'webhook' || p.verifiedBy === 'bank' ? 'matched' : 'manual',
      invoice: inv,
      workspace: ws,
    }));
    return { date: day, items, totalSatang: items.filter((i) => i.status === 'confirmed').reduce((n, i) => n + i.amount, 0) };
  }

  async reviewWht(staff: Staff, id: string, decision: 'confirmed' | 'rejected', note?: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ 50 ทวิ');
    const [w] = await this.db.select().from(s.whtCertificates).where(eq(s.whtCertificates.id, id));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ 50 ทวิ');
    if (w.status !== 'pending_review') throw new AppError(409, 'already_reviewed', 'ตรวจ 50 ทวิ ฉบับนี้แล้ว', { status: w.status });
    await this.db.transaction(async (tx) => {
      await tx.update(s.whtCertificates).set({ status: decision, reviewedBy: staff.id, updatedAt: new Date() }).where(eq(s.whtCertificates.id, id));
      await audit(tx, staff, w.workspaceId, 'plan', decision === 'confirmed' ? 'ops.wht_confirmed' : 'ops.wht_rejected', `${decision === 'confirmed' ? 'ยืนยัน' : 'ปฏิเสธ'} 50 ทวิ${note ? ` · ${note}` : ''}`, { type: 'wht_certificate', id });
    });
    if (decision === 'rejected') await this.notifyAdmins(w.workspaceId, 'หนังสือรับรองการหักภาษี (50 ทวิ) ไม่ผ่านการตรวจ', `เหตุผล: ${note ?? '-'}\nส่งใหม่ภายใน 30 วันนับจากออกใบแจ้งหนี้`);
    return { id, status: decision };
  }

  // ---------------------------------------------------------------------------

  private async notifyAdmins(workspaceId: string, subject: string, text: string) {
    return mailAll(this.mail, await billingContacts(this.db, workspaceId), subject, text);
  }
}
