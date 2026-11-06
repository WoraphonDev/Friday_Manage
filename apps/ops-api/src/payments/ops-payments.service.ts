import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { canGrant, type Db, fallbackGrant, isGrantSource, schema, type Tx } from '@friday/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
/** ที่เก็บไฟล์ที่ API ลูกค้าบันทึกสลิป / 50 ทวิ (ตัวแปรเดียวกับ apps/api) · S3 ยังไม่รองรับ */
const uploadDir = () => resolve(process.env.UPLOAD_DIR ?? '../api/var/uploads');

export const PaymentsQuery = z.object({ status: z.enum(['pending_review', 'confirmed', 'rejected']).default('pending_review'), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const ConfirmBody = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const RejectBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

interface CheckoutMeta {
  plan: string;
  cycle: 'monthly' | 'yearly';
  method: 'card' | 'promptpay' | 'transfer';
}
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

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

  async confirm(staff: Staff, id: string, input: z.infer<typeof ConfirmBody>) {
    const { p, inv } = await this.find(id);
    if (p.status === 'confirmed') throw new AppError(409, 'already_confirmed', 'ยืนยันรายการนี้แล้ว');
    const meta = await this.meta(inv.id);
    await this.db.transaction(async (tx) => {
      await tx.update(s.payments).set({ status: 'confirmed', reviewedBy: staff.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(s.payments.id, p.id));
      await tx.update(s.invoices).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() }).where(eq(s.invoices.id, inv.id));
      const granted = await this.activate(tx, inv, meta);
      // ออกใบกำกับภาษีหลังยืนยันชำระ · สถานะ pending จนกว่างาน e-Tax ของ API ลูกค้าจะรับไปส่งต่อ
      await tx.insert(s.taxDocuments).values({ workspaceId: inv.workspaceId, invoiceId: inv.id, docType: 'tax_invoice_receipt', number: `TX-${inv.number.slice(4)}` }).onConflictDoNothing();
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_confirmed', `ยืนยันการชำระ ${inv.number} · ${p.method} · ${p.amount / 100} บาท${granted ? '' : ' · ไม่เปลี่ยนแพ็กเกจ (มีใบที่ใหม่กว่าเปิดสิทธิ์อยู่)'}${input.note ? ` · ${input.note}` : ''}`, { type: 'payment', id: p.id });
    });
    return { id: p.id, status: 'confirmed' as const, invoice: inv.number };
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
        if (back) await this.activate(tx, back, await this.meta(back.id));
        else await tx.update(s.subscriptions).set({ status: 'canceled', currentPeriodEnd: new Date(), updatedAt: new Date() }).where(eq(s.subscriptions.id, inv.subscriptionId));
        revoked = true;
      }
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_rejected', `ปฏิเสธการชำระ ${inv.number} · ${input.reason}${revoked ? ' · เลิกสิทธิ์แพ็กเกจที่เปิดชั่วคราว' : ''}`, { type: 'payment', id: p.id });
    });
    await this.notifyAdmins(inv.workspaceId, `สลิปการโอน ${inv.number} ไม่ผ่านการตรวจ`, `เหตุผล: ${input.reason}\nแนบสลิปใหม่ได้ที่หน้า การเรียกเก็บเงิน${revoked ? '\nแพ็กเกจที่เปิดไว้ชั่วคราวถูกยกเลิก จนกว่าจะยืนยันการชำระ' : ''}`);
    return { id: p.id, status: 'rejected' as const, revoked };
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

  /** แพ็กเกจ / รอบของใบแจ้งหนี้ที่ API ลูกค้าเก็บไว้ใน audit_logs (`billing.checkout`) */
  private async meta(invoiceId: string): Promise<CheckoutMeta> {
    const [row] = await this.db.select({ summary: s.auditLogs.summary }).from(s.auditLogs).where(and(eq(s.auditLogs.action, 'billing.checkout'), eq(s.auditLogs.targetId, invoiceId)));
    if (!row?.summary) throw new AppError(409, 'invoice_meta_missing', 'ไม่พบรายละเอียดแพ็กเกจของใบแจ้งหนี้นี้');
    return JSON.parse(row.summary) as CheckoutMeta;
  }

  /** เปิดแพ็กเกจตามใบแจ้งหนี้ · false = ใบนี้ถูกแทนที่ด้วยใบที่ใหม่กว่าซึ่งยังมีผล (กติกาเดียวกับ apps/api › PaymentsService.activate) */
  private async activate(tx: Tx, inv: typeof s.invoices.$inferSelect, meta: CheckoutMeta): Promise<boolean> {
    if (!(await canGrant(tx, inv))) return false;
    const [plan] = await tx.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.code, meta.plan));
    if (!plan) throw new AppError(409, 'plan_not_found', `ไม่พบแพ็กเกจ ${meta.plan}`);
    await tx
      .update(s.subscriptions)
      .set({ planId: plan.id, cycle: meta.cycle, status: 'active', trialEndsAt: null, currentPeriodStart: new Date(`${inv.periodStart}T00:00:00+07:00`), currentPeriodEnd: new Date(`${addDays(inv.periodEnd, 1)}T00:00:00+07:00`), paymentMethod: meta.method, sourceInvoiceId: inv.id, updatedAt: new Date() })
      .where(eq(s.subscriptions.id, inv.subscriptionId));
    return true;
  }

  private async notifyAdmins(workspaceId: string, subject: string, text: string) {
    const admins = await this.db
      .select({ email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), sql`${s.workspaceMembers.role} in ('owner', 'admin')`));
    for (const a of admins) await this.mail.send({ to: a.email, subject, text }).catch(() => undefined);
  }
}
