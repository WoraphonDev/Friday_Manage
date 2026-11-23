import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { bankFromEnv } from '@friday/docs';
import { type Db, schema, type Tx } from '@friday/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { settleInvoice } from '../billing/ledger.js';
import { parseStatement, type StatementRow } from './statement-parser.js';

const s = schema;
const DAY = 86_400_000;
/** ธนาคารของบัญชีรับเงิน (ผู้ใช้เลือก 23 พ.ย. 2569) · รูปแบบไฟล์อ่านจากชื่อคอลัมน์ จึงไม่ผูกกับธนาคาร */
const BANK = 'kbank';
/** เลขใบแจ้งหนี้ / เลขอ้างอิงที่ลูกค้าใส่ในบันทึกช่วยจำ (`FRI-2611-0005`) */
const INVOICE_REF = /\b[A-Z]{2,5}-\d{4}-\d{3,6}\b/g;
/** เงินเข้าที่ไม่ใช่จากลูกค้า */
const NOT_CUSTOMER = /ดอกเบี้ย|interest/i;

export const LineActionBody = z.object({ reason: z.string().trim().min(3, 'ใส่เหตุผลอย่างน้อย 3 ตัวอักษร').max(300) }).strict();
export const LineMatchBody = LineActionBody.extend({ invoiceId: z.uuid() }).strict();
export const LinesQuery = z.object({ status: z.enum(['review', 'matched', 'reconciled', 'ignored']).default('review'), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

type Invoice = typeof s.invoices.$inferSelect;
type Payment = typeof s.payments.$inferSelect;
type Kind = 'slip' | 'invoice' | 'reconcile' | 'review' | 'ignored' | 'duplicate';
interface Planned {
  row: StatementRow;
  fingerprint: string;
  kind: Kind;
  /** เหตุที่ต้องให้คนตรวจ / ไม่นำเข้า */
  reason?: 'unmatched' | 'many_candidates' | 'amount_mismatch' | 'already_paid' | 'not_customer';
  invoice?: Invoice;
  payment?: Payment;
  candidates?: Invoice[];
}

const near = (a: Date | null | undefined, b: Date, days: number) => !!a && Math.abs(a.getTime() - b.getTime()) <= days * DAY;

/**
 * นำเข้า statement ธนาคาร (O03 เฟส 2) · จับคู่เงินเข้ากับใบแจ้งหนี้ให้ เหลือให้คนตรวจเฉพาะที่จับคู่ไม่ได้
 * ลำดับ: เลขใบแจ้งหนี้ในบันทึกช่วยจำ → สลิปรอตรวจที่ยอดและเวลาตรง → รายการที่ทีมยืนยันจากสลิปแล้ว (กระทบยอดอย่างเดียว) → ใบค้างจ่ายที่ยอดตรงใบเดียว
 * ยังไม่มี Bill Payment (ผู้ใช้ยังไม่เปิดบริการ) · เพิ่ม Ref.1 / Ref.2 ที่ขั้นแรกเมื่อเปิด
 */
@Injectable()
export class StatementsService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  account() {
    const b = bankFromEnv();
    return { bank: b.bank, accountNo: b.accountNo, accountName: b.accountName };
  }

  /** รอบนำเข้าล่าสุด (แสดงในหน้าต่างนำเข้า) */
  async recent() {
    const rows = await this.db
      .select({ i: s.bankStatementImports, by: s.staffUsers.name })
      .from(s.bankStatementImports)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.bankStatementImports.createdBy))
      .orderBy(desc(s.bankStatementImports.createdAt))
      .limit(5);
    return { account: this.account(), imports: rows.map(({ i, by }) => ({ id: i.id, fileName: i.fileName, periodFrom: i.periodFrom, periodTo: i.periodTo, matched: i.matched, reconciled: i.reconciled, review: i.review, createdAt: i.createdAt, createdBy: by })) };
  }

  /** ดูผลจับคู่ก่อนบันทึก · ไม่เขียนอะไร */
  async preview(file: Buffer) {
    const parsed = await parseStatement(file);
    const plan = await this.plan(this.db, parsed.rows);
    return { account: this.account(), periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, ...this.summary(parsed, plan), lines: plan.map((p) => this.lineDto(p)) };
  }

  /** บันทึก: ยืนยันเงินเข้า / กระทบยอด / ส่งเข้าคิวต้องตรวจ ในรายการเดียว (จับคู่ใหม่ใน transaction เพราะสถานะอาจเปลี่ยนหลังดูผล) */
  async commit(staff: Staff, file: Buffer, fileName: string) {
    const parsed = await parseStatement(file);
    const sha = createHash('sha256').update(file).digest('hex');
    const acct = this.account();
    return this.db.transaction(async (tx) => {
      // นำเข้าพร้อมกันสองคน → คนที่สองรอ แล้วเห็นรายการของคนแรกเป็นรายการซ้ำ
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bank_statement_import'))`);
      const plan = await this.plan(tx, parsed.rows);
      const sum = this.summary(parsed, plan);
      const [imp] = await tx
        .insert(s.bankStatementImports)
        .values({ bank: BANK, accountNo: acct.accountNo, fileName: fileName.replace(/[\\/\r\n"]/g, '_').slice(0, 160) || 'statement', fileSha256: sha, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, deposits: sum.deposits, withdrawals: sum.withdrawals, duplicates: sum.duplicates, matched: sum.matched, reconciled: sum.reconciled, review: sum.review, ignored: sum.ignored, createdBy: staff.id })
        .returning({ id: s.bankStatementImports.id });
      for (const p of plan) {
        if (p.kind === 'duplicate') continue;
        let paymentId = p.payment?.id ?? null;
        if (p.kind === 'slip' && p.payment && p.invoice) await this.confirmSlip(tx, staff, p.payment, p.invoice, p.row);
        if (p.kind === 'invoice' && p.invoice) paymentId = await this.payInvoice(tx, staff, p.invoice, p.row, p.fingerprint);
        await tx.insert(s.bankStatementLines).values({
          importId: imp.id,
          txnAt: p.row.txnAt,
          amount: p.row.deposit,
          balance: p.row.balance,
          description: p.row.description || null,
          channel: p.row.channel,
          fingerprint: p.fingerprint,
          status: p.kind === 'slip' || p.kind === 'invoice' ? 'matched' : p.kind === 'reconcile' ? 'reconciled' : p.kind,
          reason: p.reason ?? null,
          workspaceId: p.invoice?.workspaceId ?? null,
          invoiceId: p.invoice?.id ?? null,
          paymentId,
        });
      }
      await staffAudit(tx, staff, 'billing.statement_imported', `นำเข้า statement ${fileName} (${parsed.periodFrom ?? '—'} ถึง ${parsed.periodTo ?? '—'}) · ยืนยันเงินเข้า ${sum.matched} · กระทบยอด ${sum.reconciled} · ต้องตรวจ ${sum.review} · ซ้ำ ${sum.duplicates}`, { type: 'bank_statement_import', id: imp.id });
      return { id: imp.id, ...sum };
    });
  }

  /** คิวต้องตรวจ (และประวัติตามสถานะ) · พร้อมใบค้างจ่ายที่ยอดตรงให้เลือก */
  async lines(q: z.infer<typeof LinesQuery>) {
    const where = eq(s.bankStatementLines.status, q.status);
    const rows = await this.db.select().from(s.bankStatementLines).where(where).orderBy(q.status === 'review' ? s.bankStatementLines.txnAt : desc(s.bankStatementLines.txnAt)).limit(q.limit).offset(q.offset);
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` }).from(s.bankStatementLines).where(where);
    const amounts = [...new Set(rows.map((r) => r.amount))];
    const open = amounts.length
      ? await this.db
          .select({ i: s.invoices, ws: { id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name } })
          .from(s.invoices)
          .innerJoin(s.workspaces, eq(s.workspaces.id, s.invoices.workspaceId))
          .where(and(inArray(s.invoices.status, ['open', 'pending_review']), inArray(s.invoices.amountDue, amounts)))
          .orderBy(s.invoices.dueDate)
      : [];
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        txnAt: r.txnAt,
        amount: r.amount,
        description: r.description,
        channel: r.channel,
        status: r.status,
        reason: r.reason,
        note: r.note,
        candidates: open.filter((o) => o.i.amountDue === r.amount).slice(0, 5).map((o) => ({ id: o.i.id, number: o.i.number, amountDue: o.i.amountDue, dueDate: o.i.dueDate, status: o.i.status, workspace: o.ws })),
      })),
    };
  }

  /** ผูกเงินเข้ากับใบแจ้งหนี้ที่พนักงานเลือก · ยอดเกินเป็นเครดิต · ยอดขาด ใบแจ้งหนี้ยังค้าง (แบบเดียวกับ B7) */
  async matchLine(staff: Staff, id: string, input: z.infer<typeof LineMatchBody>) {
    const line = await this.findLine(id);
    const [inv] = await this.db.select().from(s.invoices).where(eq(s.invoices.id, input.invoiceId));
    if (!inv) throw new AppError(404, 'invoice_not_found', 'ไม่พบใบแจ้งหนี้');
    if (inv.status === 'paid' || inv.status === 'void') throw new AppError(409, 'invoice_closed', 'ใบแจ้งหนี้นี้ปิดแล้ว', { status: inv.status });
    const row: StatementRow = { txnAt: line.txnAt, deposit: line.amount, withdrawal: 0, balance: line.balance, description: line.description ?? '', channel: line.channel };
    return this.db.transaction(async (tx) => {
      const [slip] = await tx.select().from(s.payments).where(and(eq(s.payments.invoiceId, inv.id), eq(s.payments.status, 'pending_review'))).orderBy(desc(s.payments.createdAt)).limit(1);
      const over = line.amount - inv.amountDue;
      let paymentId: string;
      if (slip) {
        // ลูกค้าแนบสลิปไว้แล้ว: ยืนยันรายการเดิม ไม่สร้างซ้ำ
        await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'bank', exceptionReason: null, reviewedBy: staff.id, reviewedAt: new Date(), paidAt: line.txnAt, updatedAt: new Date() }).where(eq(s.payments.id, slip.id));
        paymentId = slip.id;
      } else paymentId = await this.insertPayment(tx, staff, inv, row, line.fingerprint);
      if (over >= 0) {
        await settleInvoice(tx, inv, line.txnAt);
        if (over > 0) await tx.insert(s.workspaceCredits).values({ workspaceId: inv.workspaceId, amountSatang: over, source: 'overpayment', invoiceId: inv.id, note: `ส่วนเกินจากเงินเข้า ${line.amount / 100} บาท (statement)`, createdByStaff: staff.id });
      }
      await tx.update(s.bankStatementLines).set({ status: 'matched', workspaceId: inv.workspaceId, invoiceId: inv.id, paymentId, resolvedBy: staff.id, resolvedAt: new Date(), note: input.reason }).where(eq(s.bankStatementLines.id, line.id));
      await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_statement', `ผูกเงินเข้าจาก statement ${line.amount / 100} บาทกับ ${inv.number}${over > 0 ? ` · ส่วนเกิน ${over / 100} บาทเป็นเครดิต` : over < 0 ? ` · ยังค้าง ${-over / 100} บาท` : ''} · ${input.reason}`, { type: 'payment', id: paymentId });
      return { id: line.id, invoice: inv.number, settled: over >= 0, creditSatang: Math.max(over, 0), remainingSatang: Math.max(-over, 0) };
    });
  }

  /** ไม่เกี่ยวกับลูกค้า (เงินโอนระหว่างบัญชีของบริษัท ฯลฯ) */
  async ignoreLine(staff: Staff, id: string, input: z.infer<typeof LineActionBody>) {
    const line = await this.findLine(id);
    await this.db.transaction(async (tx) => {
      await tx.update(s.bankStatementLines).set({ status: 'ignored', reason: 'not_customer', resolvedBy: staff.id, resolvedAt: new Date(), note: input.reason }).where(eq(s.bankStatementLines.id, line.id));
      await staffAudit(tx, staff, 'billing.statement_line_ignored', `เงินเข้า ${line.amount / 100} บาท (statement) ไม่เกี่ยวกับลูกค้า · ${input.reason}`, { type: 'bank_statement_line', id: line.id });
    });
    return { id: line.id, status: 'ignored' as const };
  }

  // ------------------------------------------------------------------ ภายใน

  private async findLine(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการเงินเข้า');
    const [line] = await this.db.select().from(s.bankStatementLines).where(eq(s.bankStatementLines.id, id));
    if (!line) throw new AppError(404, 'not_found', 'ไม่พบรายการเงินเข้า');
    if (line.status !== 'review') throw new AppError(409, 'line_closed', 'ตัดสินรายการนี้แล้ว', { status: line.status });
    return line;
  }

  private fingerprint(row: StatementRow) {
    return createHash('sha256').update([BANK, this.account().accountNo, row.txnAt.toISOString(), row.deposit, row.balance ?? '', row.description].join('|')).digest('hex');
  }

  /** จับคู่ทุกรายการเงินเข้า · ใบ / รายการที่ใช้แล้วในไฟล์เดียวกันไม่ถูกใช้ซ้ำ */
  private async plan(db: Db | Tx, rows: StatementRow[]): Promise<Planned[]> {
    const deposits = rows.filter((r) => r.deposit > 0);
    if (!deposits.length) return [];
    const fps = deposits.map((r) => this.fingerprint(r));
    const seen = new Set((await db.select({ f: s.bankStatementLines.fingerprint }).from(s.bankStatementLines).where(inArray(s.bankStatementLines.fingerprint, fps))).map((x) => x.f));
    const amounts = [...new Set(deposits.map((r) => r.deposit))];
    const refs = [...new Set(deposits.flatMap((r) => r.description.toUpperCase().match(INVOICE_REF) ?? []))];
    const from = new Date(Math.min(...deposits.map((r) => r.txnAt.getTime())) - 4 * DAY);
    const to = new Date(Math.max(...deposits.map((r) => r.txnAt.getTime())) + 4 * DAY);

    const byRef = refs.length ? await db.select().from(s.invoices).where(inArray(s.invoices.number, refs)) : [];
    const openInvoices = await db.select().from(s.invoices).where(and(eq(s.invoices.status, 'open'), inArray(s.invoices.amountDue, amounts)));
    const slips = await db
      .select({ p: s.payments, inv: s.invoices })
      .from(s.payments)
      .innerJoin(s.invoices, eq(s.invoices.id, s.payments.invoiceId))
      // เฉพาะสลิปที่ยังไม่ติดเหตุผิดปกติและยอดเท่าใบแจ้งหนี้ · สลิปที่มีปัญหาอยู่แล้วให้คนตัดสินในคิวเดิม
      .where(and(eq(s.payments.status, 'pending_review'), eq(s.payments.method, 'transfer'), isNull(s.payments.exceptionReason), inArray(s.payments.amount, amounts), sql`${s.payments.amount} = ${s.invoices.amountDue}`, inArray(s.invoices.status, ['open', 'pending_review'])));
    // ทีมยืนยันจากสลิปแล้วแต่ยังไม่เคยเทียบ statement
    const confirmed = await db
      .select({ p: s.payments, inv: s.invoices })
      .from(s.payments)
      .innerJoin(s.invoices, eq(s.invoices.id, s.payments.invoiceId))
      .leftJoin(s.bankStatementLines, eq(s.bankStatementLines.paymentId, s.payments.id))
      .where(and(eq(s.payments.status, 'confirmed'), eq(s.payments.method, 'transfer'), inArray(s.payments.amount, amounts), isNull(s.bankStatementLines.id), sql`coalesce(${s.payments.paidAt}, ${s.payments.reviewedAt}, ${s.payments.createdAt}) between ${from} and ${to}`));
    // รายการที่ตรวจแล้วจาก statement (ยืนยันสลิปผ่าน statement) ไม่ต้องกระทบยอดซ้ำ
    const paymentsByInvoice = async (invoiceIds: string[]) => (invoiceIds.length ? db.select().from(s.payments).where(inArray(s.payments.invoiceId, invoiceIds)) : []);
    const refPayments = await paymentsByInvoice(byRef.map((i) => i.id));
    const linkedRefs = new Set(refPayments.length ? (await db.select({ p: s.bankStatementLines.paymentId }).from(s.bankStatementLines).where(inArray(s.bankStatementLines.paymentId, refPayments.map((p) => p.id)))).map((x) => x.p) : []);

    const usedInvoices = new Set<string>();
    const usedPayments = new Set<string>();
    const inFile = new Set<string>();
    const out: Planned[] = [];
    for (let i = 0; i < deposits.length; i++) {
      const row = deposits[i];
      const fingerprint = fps[i];
      const base = { row, fingerprint };
      if (seen.has(fingerprint) || inFile.has(fingerprint)) {
        out.push({ ...base, kind: 'duplicate' });
        continue;
      }
      inFile.add(fingerprint);
      if (NOT_CUSTOMER.test(row.description)) {
        out.push({ ...base, kind: 'ignored', reason: 'not_customer' });
        continue;
      }
      const take = (p: Planned) => {
        if (p.invoice) usedInvoices.add(p.invoice.id);
        if (p.payment) usedPayments.add(p.payment.id);
        out.push(p);
      };

      // 1) เลขใบแจ้งหนี้ในบันทึกช่วยจำ
      const ref = (row.description.toUpperCase().match(INVOICE_REF) ?? []).map((n) => byRef.find((x) => x.number === n)).find((x) => x && x.status !== 'void' && !usedInvoices.has(x.id));
      if (ref) {
        if (ref.status === 'paid') {
          const p = refPayments.find((x) => x.invoiceId === ref.id && x.status === 'confirmed' && x.amount === row.deposit && !linkedRefs.has(x.id) && !usedPayments.has(x.id));
          take(p ? { ...base, kind: 'reconcile', invoice: ref, payment: p } : { ...base, kind: 'review', reason: 'already_paid', invoice: ref });
        } else if (row.deposit !== ref.amountDue) take({ ...base, kind: 'review', reason: 'amount_mismatch', invoice: ref });
        else {
          const slip = refPayments.find((x) => x.invoiceId === ref.id && x.status === 'pending_review' && !x.exceptionReason && !usedPayments.has(x.id));
          take(slip ? { ...base, kind: 'slip', invoice: ref, payment: slip } : { ...base, kind: 'invoice', invoice: ref });
        }
        continue;
      }

      // 2) สลิปรอตรวจที่ยอดตรงและเวลาโอนที่ลูกค้าแจ้งห่างไม่เกิน 2 วัน
      const slip = slips.filter(({ p, inv }) => p.amount === row.deposit && near(p.paidAt ?? p.createdAt, row.txnAt, 2) && !usedPayments.has(p.id) && !usedInvoices.has(inv.id));
      if (slip.length === 1) {
        take({ ...base, kind: 'slip', invoice: slip[0].inv, payment: slip[0].p });
        continue;
      }
      if (slip.length > 1) {
        take({ ...base, kind: 'review', reason: 'many_candidates', candidates: slip.map((x) => x.inv) });
        continue;
      }

      // 3) ทีมยืนยันจากสลิปไปแล้ว: กระทบยอดอย่างเดียว (ไม่แตะใบแจ้งหนี้)
      const done = confirmed.filter(({ p }) => p.amount === row.deposit && near(p.paidAt ?? p.reviewedAt ?? p.createdAt, row.txnAt, 3) && !usedPayments.has(p.id));
      if (done.length === 1) {
        take({ ...base, kind: 'reconcile', invoice: done[0].inv, payment: done[0].p });
        continue;
      }

      // 4) ใบค้างจ่ายที่ยอดตรงใบเดียว (ออกก่อนเงินเข้า)
      const open = openInvoices.filter((inv) => inv.amountDue === row.deposit && inv.createdAt.getTime() <= row.txnAt.getTime() + DAY && !usedInvoices.has(inv.id));
      if (open.length === 1 && done.length === 0) take({ ...base, kind: 'invoice', invoice: open[0] });
      else take({ ...base, kind: 'review', reason: open.length > 1 || done.length > 1 ? 'many_candidates' : 'unmatched', candidates: open });
    }
    return out;
  }

  private summary(parsed: { rows: StatementRow[]; skipped: number }, plan: Planned[]) {
    const n = (k: Kind) => plan.filter((p) => p.kind === k).length;
    return {
      deposits: plan.length,
      withdrawals: parsed.rows.filter((r) => r.withdrawal > 0 && !r.deposit).length,
      skipped: parsed.skipped,
      duplicates: n('duplicate'),
      matched: n('slip') + n('invoice'),
      reconciled: n('reconcile'),
      review: n('review'),
      ignored: n('ignored'),
    };
  }

  private lineDto(p: Planned) {
    return {
      txnAt: p.row.txnAt,
      amount: p.row.deposit,
      description: p.row.description,
      channel: p.row.channel,
      kind: p.kind,
      reason: p.reason ?? null,
      invoice: p.invoice ? { id: p.invoice.id, number: p.invoice.number, amountDue: p.invoice.amountDue, status: p.invoice.status, workspaceId: p.invoice.workspaceId } : null,
      hasSlip: p.kind === 'slip',
      candidates: (p.candidates ?? []).slice(0, 5).map((c) => ({ id: c.id, number: c.number, amountDue: c.amountDue })),
    };
  }

  /** สลิปรอตรวจตรงกับเงินเข้าจริง: ยืนยันแทนทีม (เวลาเงินเข้า = เวลาใน statement) */
  private async confirmSlip(tx: Tx, staff: Staff, p: Payment, inv: Invoice, row: StatementRow) {
    await tx.update(s.payments).set({ status: 'confirmed', verifiedBy: 'bank', exceptionReason: null, reviewedBy: staff.id, reviewedAt: new Date(), paidAt: row.txnAt, updatedAt: new Date() }).where(eq(s.payments.id, p.id));
    const granted = await settleInvoice(tx, inv, row.txnAt);
    await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_statement', `ยืนยันการชำระ ${inv.number} จาก statement ธนาคาร · ${row.deposit / 100} บาท (สลิปที่ลูกค้าแนบ)${granted ? '' : ' · ไม่เปลี่ยนแพ็กเกจ'}`, { type: 'payment', id: p.id });
  }

  /** เงินโอนเข้าโดยไม่แนบสลิป: สร้างรายการชำระแล้วปิดใบแจ้งหนี้ */
  private async payInvoice(tx: Tx, staff: Staff, inv: Invoice, row: StatementRow, fingerprint: string) {
    const id = await this.insertPayment(tx, staff, inv, row, fingerprint);
    const granted = await settleInvoice(tx, inv, row.txnAt);
    await audit(tx, staff, inv.workspaceId, 'plan', 'ops.payment_statement', `ยืนยันการชำระ ${inv.number} จาก statement ธนาคาร · ${row.deposit / 100} บาท (โอนโดยไม่แนบสลิป)${granted ? '' : ' · ไม่เปลี่ยนแพ็กเกจ'}`, { type: 'payment', id });
    return id;
  }

  private async insertPayment(tx: Tx, staff: Staff, inv: Invoice, row: StatementRow, fingerprint: string) {
    const [p] = await tx
      .insert(s.payments)
      .values({ workspaceId: inv.workspaceId, invoiceId: inv.id, method: 'transfer', amount: row.deposit, providerRef: `stmt:${fingerprint.slice(0, 32)}`, status: 'confirmed', verifiedBy: 'bank', reviewedBy: staff.id, reviewedAt: new Date(), paidAt: row.txnAt })
      .returning({ id: s.payments.id });
    return p.id;
  }
}
