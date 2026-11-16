// อ่านข้อมูลเอกสารจากฐานข้อมูลแล้วสร้าง PDF · API ลูกค้า (ดาวน์โหลด) และหลังบ้าน (แนบอีเมล / รายงาน) เรียกตัวเดียวกัน
// `db` ต้องเห็นข้อมูลของ Workspace นั้น: API ตรวจสิทธิ์ผ่าน RLS ก่อนแล้วส่ง SYSTEM_DB มา · หลังบ้านใช้ friday_worker
import { bkkDate, type Db, schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { adjustmentDoc, type Buyer, type Charge, type Edition, invoiceDoc, quotationDoc, receiptDoc } from './documents.ts';
import { branchLabel, thaiDate } from './format.ts';
import { renderDoc, type Seller } from './render.ts';
import type { SalesReportInput, SalesRow } from './report.ts';

type Reader = Db | Tx;
type Invoice = typeof s.invoices.$inferSelect;

/** ผู้ขายจาก env · ไม่ตั้ง = ข้อมูลตัวอย่าง (เอกสารบอกไว้ท้ายหน้า) · SELLER_BRANCH: ว่าง/สำนักงานใหญ่ หรือเลขสาขา 5 หลัก */
export function sellerFromEnv(env: NodeJS.ProcessEnv = process.env): Seller {
  const branch = (env.SELLER_BRANCH ?? '').trim();
  const digits = branch.replace(/\D/g, '');
  return {
    name: env.SELLER_NAME ?? 'บริษัท ฟรายเดย์ จำกัด (ตัวอย่าง)',
    taxId: env.SELLER_TAX_ID ?? '0105500000000',
    address: env.SELLER_ADDRESS ?? '99 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10000',
    // ประกาศอธิบดีฯ ฉบับที่ 199: สาขาเป็นเลข 5 หลัก · ค่าที่ไม่มีตัวเลข (เช่น "สำนักงานใหญ่") = สำนักงานใหญ่
    branch: digits && Number(digits) > 0 ? branchLabel('branch', digits) : 'สำนักงานใหญ่',
    phone: env.SELLER_PHONE || undefined,
    email: env.SELLER_EMAIL || 'billing@example.com',
    sample: !env.SELLER_NAME,
  };
}
export function bankFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return { bank: env.BANK_NAME ?? 'ธนาคารตัวอย่าง', accountNo: env.BANK_ACCOUNT_NO ?? '000-0-00000-0', accountName: env.BANK_ACCOUNT_NAME ?? 'บริษัท ฟรายเดย์ จำกัด (ตัวอย่าง)' };
}

/** ชื่อแพ็กเกจที่พิมพ์: ชื่อที่ทีมตั้ง หรือ `team_m` → "Team M" */
export const planTitle = (code: string, displayName?: string | null) => displayName ?? code.replace(/^team_(\w+)$/, (_, x: string) => `Team ${x.toUpperCase()}`).replace(/^free$/, 'Free');

interface Meta { plan?: string; cycle?: 'monthly' | 'yearly'; coupon?: string | null; items?: { description: string; qty: number; unitSatang: number }[]; discountPct?: number }
async function metaOf(db: Reader, invoiceId: string): Promise<Meta | null> {
  const [row] = await db.select({ summary: s.auditLogs.summary }).from(s.auditLogs).where(and(eq(s.auditLogs.action, 'billing.checkout'), eq(s.auditLogs.targetId, invoiceId)));
  try {
    return row?.summary ? (JSON.parse(row.summary) as Meta) : null;
  } catch {
    return null;
  }
}
async function buyerOf(db: Reader, workspaceId: string, snapshot?: unknown): Promise<Buyer> {
  if (snapshot && typeof snapshot === 'object') return snapshot as Buyer;
  const [p] = await db.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, workspaceId));
  return p ? { companyName: p.companyName, taxId: p.taxId, branchType: p.branchType, branchNo: p.branchNo, address: p.address, email: p.taxEmail } : { companyName: '-', taxId: '-', branchType: 'head', address: '-' };
}
async function chargeOf(db: Reader, inv: Invoice, meta: Meta | null): Promise<Charge> {
  const [plan] = meta?.plan ? await db.select().from(s.plans).where(eq(s.plans.code, meta.plan)) : [];
  return {
    planName: meta?.plan ? planTitle(meta.plan, plan?.displayName) : null,
    cycle: meta?.cycle ?? null,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    seatLimit: plan?.seatLimit ?? null,
    subtotal: inv.subtotal,
    discount: inv.discount,
    discountLabel: meta?.coupon ? `โค้ด ${meta.coupon}` : meta?.discountPct ? `${meta.discountPct}%` : null,
    items: meta?.items ?? null,
  };
}
/** ใบกำกับภาษีที่ยังมีผลของใบแจ้งหนี้ (ไม่นับฉบับที่ยกเลิก) */
async function activeTaxDoc(db: Reader, invoiceId: string) {
  const docs = await db.select().from(s.taxDocuments).where(eq(s.taxDocuments.invoiceId, invoiceId)).orderBy(desc(s.taxDocuments.createdAt));
  return docs.find((d) => d.status !== 'cancelled') ?? docs[0] ?? null;
}
const docDate = (d: { issuedOn: string | null; createdAt: Date }) => d.issuedOn ?? bkkDate(d.createdAt);

// ---------------------------------------------------------------------------

export async function invoicePdf(db: Reader, invoiceId: string, opts: { vatRegistered: boolean }) {
  const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
  if (!inv) return null;
  const meta = await metaOf(db, inv.id);
  const [p] = await db.select().from(s.payments).where(eq(s.payments.invoiceId, inv.id)).orderBy(desc(s.payments.createdAt)).limit(1);
  const [ws] = await db.select({ name: s.workspaces.name }).from(s.workspaces).where(eq(s.workspaces.id, inv.workspaceId));
  const doc = invoiceDoc({
    seller: sellerFromEnv(), buyer: await buyerOf(db, inv.workspaceId), edition: 'original', number: inv.number, date: bkkDate(inv.createdAt), dueDate: inv.dueDate,
    status: inv.status, poNumber: inv.poNumber, workspaceName: ws?.name ?? null, charge: await chargeOf(db, inv, meta),
    vat: inv.vat, total: inv.total, whtAmount: inv.whtAmount, amountDue: inv.amountDue, vatRegistered: opts.vatRegistered, method: p?.method ?? null, bank: bankFromEnv(),
  });
  return { filename: `${inv.number}.pdf`, buffer: await renderDoc(doc) };
}

/**
 * ใบเสร็จรับเงิน / ใบกำกับภาษี · ฉบับใหม่แทนฉบับที่ยกเลิกมีแถบเหตุผล
 * ป้ายฉบับ: ใบกำกับภาษีที่ผู้ให้บริการ e-Tax ออกแล้ว ต้นฉบับคือไฟล์ e-Tax จึงพิมพ์จากระบบเป็น "สำเนา" · นอกนั้นเป็นต้นฉบับ
 */
export async function taxDocumentPdf(db: Reader, docId: string) {
  const [d] = await db.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, docId));
  if (!d) return null;
  const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.id, d.invoiceId));
  const meta = await metaOf(db, inv.id);
  const [p] = await db.select().from(s.payments).where(and(eq(s.payments.invoiceId, inv.id), eq(s.payments.status, 'confirmed'))).orderBy(desc(s.payments.createdAt)).limit(1);
  const [old] = d.replacesId ? await db.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, d.replacesId)) : [];
  const vat = d.docType !== 'receipt';
  const edition: Edition = vat && d.status === 'issued' && d.providerRef ? 'copy' : 'original';
  const doc = receiptDoc({
    seller: sellerFromEnv(), buyer: await buyerOf(db, inv.workspaceId, d.buyer), edition, vatRegistered: vat,
    number: d.number, date: docDate(d), invoiceNumber: inv.number, poNumber: inv.poNumber, charge: await chargeOf(db, inv, meta),
    vat: inv.vat, total: inv.total, whtAmount: inv.whtAmount,
    payment: { paidAt: p?.paidAt ?? inv.paidAt ?? d.createdAt, method: p?.method ?? 'transfer', reference: p && p.method !== 'transfer' ? p.providerRef : inv.number, received: inv.amountDue },
    replaces: old ? { number: old.number, date: docDate(old), reason: old.cancelReason ?? 'ข้อมูลผู้ซื้อในฉบับเดิมไม่ถูกต้อง', issuedOn: bkkDate(d.createdAt) } : null,
  });
  if (d.status === 'cancelled') {
    doc.badge = 'ยกเลิก / CANCELLED';
    doc.stamp = undefined;
    doc.notes = [`ฉบับนี้ยกเลิกแล้ว${d.cancelReason ? ` เนื่องจาก${d.cancelReason}` : ''} · ใช้อ้างอิงภาษีไม่ได้`, ...doc.notes];
  }
  return { filename: `${d.number}.pdf`, buffer: await renderDoc(doc) };
}

const SETTLE: Record<string, string> = { original: 'คืนเข้าช่องทางที่ชำระ', bank_transfer: 'โอนคืนเข้าบัญชีลูกค้า' };
async function adjustmentBase(db: Reader, invoiceId: string) {
  const [inv] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
  const meta = await metaOf(db, inv.id);
  const tax = await activeTaxDoc(db, inv.id);
  const charge = await chargeOf(db, inv, meta);
  const cycle = charge.cycle === 'yearly' ? 'รายปี' : 'รายเดือน';
  return {
    inv,
    tax,
    buyer: await buyerOf(db, inv.workspaceId, tax?.buyer),
    ref: { number: tax?.number ?? inv.number, date: tax ? docDate(tax) : bkkDate(inv.paidAt ?? inv.createdAt) },
    line: { description: charge.planName ? `ค่าบริการ Friday Work Management แพ็กเกจ ${charge.planName} (${cycle})` : charge.items?.[0]?.description ?? `ค่าบริการตามใบแจ้งหนี้ ${inv.number}`, sub: `รอบบริการ ${thaiDate(inv.periodStart)} – ${thaiDate(inv.periodEnd)}${inv.discount > 0 ? ' · หลังหักส่วนลด' : ''}`, original: inv.subtotal },
  };
}

export async function creditNotePdf(db: Reader, id: string, opts: { vatRegistered: boolean }) {
  const [cn] = await db.select().from(s.creditNotes).where(eq(s.creditNotes.id, id));
  if (!cn) return null;
  const b = await adjustmentBase(db, cn.invoiceId);
  const date = bkkDate(cn.issuedAt ?? cn.createdAt);
  const total = cn.amountSatang + cn.vatSatang;
  const how = cn.kind === 'credit' ? 'เครดิตใช้หักรอบถัดไป' : cn.kind === 'void' ? 'ยกเลิกรายการ ไม่มีการคืนเงิน' : (SETTLE[cn.refundMethod ?? ''] ?? 'คืนเงิน');
  const doc = adjustmentDoc({
    kind: 'credit', seller: sellerFromEnv(), buyer: b.buyer, edition: 'original', vatRegistered: opts.vatRegistered && b.tax?.docType !== 'receipt',
    number: cn.number, date, reason: cn.reason, ref: b.ref, line: b.line, difference: cn.amountSatang, vat: cn.vatSatang,
    band: { title: 'การคืนเงิน / Settlement', cells: [['วิธี', how], ['วันที่', thaiDate(date)], ['อ้างอิง', cn.providerRef ?? cn.number], ['จำนวน', `฿${(total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`]] },
  });
  return { filename: `${cn.number}.pdf`, buffer: await renderDoc(doc) };
}

export async function debitNotePdf(db: Reader, id: string, opts: { vatRegistered: boolean }) {
  const [dn] = await db.select().from(s.debitNotes).where(eq(s.debitNotes.id, id));
  if (!dn) return null;
  const b = await adjustmentBase(db, dn.invoiceId);
  const [charge] = dn.chargeInvoiceId ? await db.select().from(s.invoices).where(eq(s.invoices.id, dn.chargeInvoiceId)) : [];
  const total = dn.amountSatang + dn.vatSatang;
  const doc = adjustmentDoc({
    kind: 'debit', seller: sellerFromEnv(), buyer: b.buyer, edition: 'original', vatRegistered: opts.vatRegistered && b.tax?.docType !== 'receipt',
    number: dn.number, date: bkkDate(dn.issuedAt ?? dn.createdAt), reason: dn.reason, ref: b.ref, line: b.line, difference: dn.amountSatang, vat: dn.vatSatang,
    band: { title: 'การชำระ / Payment', cells: [['ครบกำหนด', charge ? thaiDate(charge.dueDate) : '-'], ['ใบแจ้งหนี้', charge?.number ?? '-'], ['ชำระที่', 'แพ็กเกจ & Billing › ชำระ'], ['ยอด', `฿${(total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`]] },
  });
  return { filename: `${dn.number}.pdf`, buffer: await renderDoc(doc) };
}

export async function quotationPdf(db: Reader, id: string, opts: { vatRegistered: boolean; yearlyMonths?: number }) {
  const [q] = await db.select().from(s.quotations).where(eq(s.quotations.id, id));
  if (!q) return null;
  const [plan] = await db.select().from(s.plans).where(eq(s.plans.code, q.plan));
  const [profile] = await db.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, q.workspaceId));
  const doc = quotationDoc({
    seller: sellerFromEnv(), buyer: profile ? { companyName: profile.companyName, taxId: profile.taxId, branchType: profile.branchType, branchNo: profile.branchNo, address: profile.address, email: profile.taxEmail } : null,
    number: q.number, date: bkkDate(q.createdAt), validUntil: q.validUntil, planName: planTitle(q.plan, plan?.displayName), cycle: q.cycle,
    seatLimit: plan?.seatLimit ?? null, storageGbPerMember: plan?.storageGbPerMember ?? null, yearlyPrice: plan?.priceYearlySatang ?? null, yearlyMonths: opts.yearlyMonths ?? 10,
    subtotal: q.subtotal, discount: q.discount, discountLabel: q.coupon ? `โค้ด ${q.coupon}` : null, vat: q.vat, total: q.total, whtAmount: q.whtAmount, amountDue: q.amountDue, vatRegistered: opts.vatRegistered,
  });
  return { filename: `${q.number}.pdf`, buffer: await renderDoc(doc) };
}

// ---------------------------------------------------------------------------
// รายงานภาษีขายรายเดือน
// ---------------------------------------------------------------------------

const CHANNEL: Record<string, string> = { card: 'บัตร', promptpay: 'PromptPay', transfer: 'โอน (สลิป)' };
const ETAX: Record<string, string> = { pending: 'รอส่ง', submitted: 'ส่งแล้ว รอผล', issued: 'ส่งแล้ว', failed: 'ส่งไม่สำเร็จ', cancelled: 'แจ้งยกเลิกแล้ว' };

/** รวบรวมเอกสารภาษีของเดือน (ตามวันที่ของเอกสาร) เป็นแถวของรายงาน + รายการตรวจก่อนปิดเดือน */
export async function salesReportData(db: Reader, year: number, month: number, opts: { closed: boolean }): Promise<SalesReportInput> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const fromTs = new Date(`${from}T00:00:00+07:00`);
  const toTs = new Date(`${to}T00:00:00+07:00`);
  const taxDocs = await db.select().from(s.taxDocuments).where(or(and(gte(s.taxDocuments.issuedOn, from), lt(s.taxDocuments.issuedOn, to)), and(isNull(s.taxDocuments.issuedOn), gte(s.taxDocuments.createdAt, fromTs), lt(s.taxDocuments.createdAt, toTs))));
  const credits = await db.select().from(s.creditNotes).where(and(isNotNull(s.creditNotes.issuedAt), gte(s.creditNotes.issuedAt, fromTs), lt(s.creditNotes.issuedAt, toTs)));
  const debits = await db.select().from(s.debitNotes).where(and(gte(s.debitNotes.createdAt, fromTs), lt(s.debitNotes.createdAt, toTs)));
  const invoiceIds = [...new Set([...taxDocs.map((d) => d.invoiceId), ...credits.map((c) => c.invoiceId), ...debits.map((d) => d.invoiceId), ...debits.flatMap((d) => (d.chargeInvoiceId ? [d.chargeInvoiceId] : []))])];
  const invoices = invoiceIds.length ? await db.select().from(s.invoices).where(inArray(s.invoices.id, invoiceIds)) : [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const pays = invoiceIds.length ? await db.select().from(s.payments).where(inArray(s.payments.invoiceId, invoiceIds)).orderBy(asc(s.payments.createdAt)) : [];
  const payOf = (invoiceId: string) => pays.filter((p) => p.invoiceId === invoiceId).at(-1);
  const whts = invoiceIds.length ? await db.select().from(s.whtCertificates).where(inArray(s.whtCertificates.invoiceId, invoiceIds)) : [];
  const allTax = invoiceIds.length ? await db.select().from(s.taxDocuments).where(inArray(s.taxDocuments.invoiceId, invoiceIds)) : [];
  const metas = new Map(await Promise.all(invoiceIds.map(async (id) => [id, await metaOf(db, id)] as const)));
  const planText = (invoiceId: string) => {
    const m = metas.get(invoiceId);
    return m?.plan ? `${planTitle(m.plan)} · ${m.cycle === 'yearly' ? 'รายปี' : 'รายเดือน'}` : m?.items?.[0]?.description ?? '-';
  };
  const buyerRow = async (workspaceId: string, snapshot?: unknown) => {
    const b = await buyerOf(db, workspaceId, snapshot);
    const label = branchLabel(b.branchType, b.branchNo);
    return { buyerName: b.companyName, buyerTaxId: b.taxId, branch: label === 'สำนักงานใหญ่' ? label : label.replace('สาขาที่ ', '') };
  };

  const rows: SalesRow[] = [];
  for (const d of taxDocs) {
    const inv = invById.get(d.invoiceId)!;
    const p = payOf(inv.id);
    const cancelled = d.status === 'cancelled';
    const replacement = allTax.find((x) => x.replacesId === d.id);
    const original = d.replacesId ? allTax.find((x) => x.id === d.replacesId) : null;
    const wht = inv.whtAmount > 0 && !whts.some((w) => w.invoiceId === inv.id);
    rows.push({
      date: docDate(d), number: d.number, kind: d.docType === 'receipt' ? 'receipt' : 'tax_invoice', cancelled,
      note: cancelled ? `ยกเลิก${replacement ? ` · ออกใหม่เป็น ${replacement.number}` : ''}` : original ? `ออกแทน ${original.number}` : undefined,
      ...(await buyerRow(inv.workspaceId, d.buyer)),
      value: cancelled ? 0 : inv.subtotal, vat: cancelled ? 0 : inv.vat,
      detail: { ref: inv.number, plan: planText(inv.id), whtAmount: cancelled ? null : inv.whtAmount, received: cancelled ? null : inv.amountDue, receivedOn: p?.paidAt ? bkkDate(p.paidAt) : inv.paidAt ? bkkDate(inv.paidAt) : null, channel: cancelled ? '–' : (CHANNEL[p?.method ?? ''] ?? '-'), etax: d.docType === 'receipt' ? 'ไม่ต้องส่ง' : (ETAX[d.status] ?? d.status), flags: wht && !cancelled ? ['wht'] : [] },
    });
  }
  for (const c of credits) {
    const inv = invById.get(c.invoiceId)!;
    const tax = allTax.filter((x) => x.invoiceId === inv.id && x.status !== 'cancelled').at(-1);
    rows.push({
      date: bkkDate(c.issuedAt!), number: c.number, kind: 'credit_note', note: `ใบลดหนี้ อ้างถึง ${tax?.number ?? inv.number}`, ...(await buyerRow(inv.workspaceId, tax?.buyer)),
      value: -c.amountSatang, vat: -c.vatSatang,
      detail: { ref: tax?.number ?? inv.number, plan: planText(inv.id), whtAmount: null, received: c.kind === 'refund' ? -(c.amountSatang + c.vatSatang) : 0, receivedOn: bkkDate(c.issuedAt!), channel: c.kind === 'refund' ? 'คืนเงิน' : c.kind === 'credit' ? 'เครดิต' : 'ยกเลิก', etax: c.status === 'sent' ? 'ส่งแล้ว' : 'ออกแล้ว', flags: [] },
    });
  }
  for (const dn of debits) {
    const inv = invById.get(dn.invoiceId)!;
    const tax = allTax.filter((x) => x.invoiceId === inv.id && x.status !== 'cancelled').at(-1);
    const charge = dn.chargeInvoiceId ? invById.get(dn.chargeInvoiceId) : undefined;
    const paid = charge?.status === 'paid';
    rows.push({
      date: bkkDate(dn.issuedAt ?? dn.createdAt), number: dn.number, kind: 'debit_note', note: `ใบเพิ่มหนี้ อ้างถึง ${tax?.number ?? inv.number}`, ...(await buyerRow(inv.workspaceId, tax?.buyer)),
      value: dn.amountSatang, vat: dn.vatSatang,
      detail: { ref: tax?.number ?? inv.number, plan: planText(inv.id), whtAmount: charge?.whtAmount ?? 0, received: paid ? (charge?.amountDue ?? 0) : 0, receivedOn: paid && charge?.paidAt ? bkkDate(charge.paidAt) : null, channel: paid ? (CHANNEL[payOf(charge!.id)?.method ?? ''] ?? '-') : 'รอชำระ', etax: dn.status === 'sent' ? 'ส่งแล้ว' : 'ออกแล้ว', flags: paid ? [] : ['outstanding'] },
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));

  // ตรวจก่อนปิดเดือน: เลขขาด · e-Tax ยังไม่ครบ · ใบยกเลิกไม่มีฉบับแทน · รอ 50 ทวิ · ค้างรับ
  const checks: SalesReportInput['checks'] = [];
  for (const prefix of ['TX', 'RC', 'CN', 'DN']) {
    const nums = rows.filter((r) => r.number.startsWith(`${prefix}-`)).map((r) => Number(r.number.slice(-4))).sort((a, b) => a - b);
    if (!nums.length) continue;
    const missing = [];
    for (let n = nums[0]; n <= nums[nums.length - 1]; n++) if (!nums.includes(n)) missing.push(n);
    const label = { TX: 'ใบกำกับภาษี', RC: 'ใบเสร็จ', CN: 'ใบลดหนี้', DN: 'ใบเพิ่มหนี้' }[prefix];
    checks.push(missing.length ? { ok: false, text: `${label}เลขขาด ${missing.map((n) => String(n).padStart(4, '0')).join(', ')}` } : { ok: true, text: `เลข${label}ต่อเนื่อง ไม่มีเลขขาด` });
  }
  const notSent = rows.filter((r) => r.kind === 'tax_invoice' && !r.cancelled && r.detail.etax !== 'ส่งแล้ว');
  checks.push(notSent.length ? { ok: false, text: `e-Tax ยังไม่ครบ ${notSent.length} ใบ (${notSent.map((r) => r.number).join(', ')})` } : { ok: true, text: 'ส่ง e-Tax ครบทุกใบกำกับภาษี' });
  const orphan = rows.filter((r) => r.cancelled && !r.note?.includes('ออกใหม่'));
  checks.push(orphan.length ? { ok: false, text: `ใบที่ยกเลิกยังไม่มีฉบับแทน ${orphan.map((r) => r.number).join(', ')}` } : { ok: true, text: 'ใบที่ยกเลิกมีฉบับใหม่ออกแทนครบ' });
  const wht = rows.filter((r) => r.detail.flags.includes('wht'));
  if (wht.length) checks.push({ ok: false, text: `รอ 50 ทวิ ${wht.length} ใบ (${wht.map((r) => r.number).join(', ')})` });
  const outstanding = rows.filter((r) => r.detail.flags.includes('outstanding'));
  if (outstanding.length) checks.push({ ok: false, text: `ค้างรับ ${outstanding.length} ใบ (${outstanding.map((r) => r.number).join(', ')})` });
  return { seller: sellerFromEnv(), year, month, rows, checks, closed: opts.closed, generatedAt: new Date() };
}
