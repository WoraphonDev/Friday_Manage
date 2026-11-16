// ประกอบเอกสารแต่ละชนิดจากข้อมูลธรรมดา (ไม่รู้จักฐานข้อมูล) · API ลูกค้าและหลังบ้านเรียกตัวเดียวกัน ถ้อยคำจึงตรงกันทุกที่
// รายการตามกฎหมายอ้างใน design/proposals/billing/README.md (ม.86/4, 86/9, 86/10, 86/12, ประกาศอธิบดีฯ ฉบับที่ 199)
import { baht, branchLabel, thaiDate, thaiDateTime } from './format.ts';
import type { AdjustLine, FinanceDoc, Party, SaleLine, Seller, TotalRow } from './render.ts';

export type Edition = 'original' | 'copy' | 'replacement';
const EDITION: Record<Edition, string> = { original: 'ต้นฉบับ / ORIGINAL', copy: 'สำเนา / COPY', replacement: 'ใบแทน / REPLACEMENT' };
export const ETAX_NOTE = 'เอกสารนี้ได้จัดทำและส่งข้อมูลให้แก่กรมสรรพากรด้วยวิธีการทางอิเล็กทรอนิกส์ (e-Tax Invoice & e-Receipt)';
const SIGNED = 'ลงลายมือชื่อดิจิทัลแล้ว';
const SYSTEM = 'ออกโดยระบบ Friday';
const METHOD: Record<string, string> = { card: 'บัตรเครดิต / เดบิต', promptpay: 'PromptPay', transfer: 'โอนเข้าบัญชีธนาคาร' };

export interface Buyer { companyName: string; taxId: string; branchType: string; branchNo?: string | null; address: string; email?: string | null }
export const party = (b: Buyer, extra?: string[]): Party => ({ name: b.companyName, branch: branchLabel(b.branchType, b.branchNo), address: b.address, taxId: b.taxId, extra });

/** รายการขายของใบแจ้งหนี้ / ใบเสร็จ: แพ็กเกจ 1 บรรทัด + ส่วนลดแยกบรรทัด · ใบที่ทีมออกเองใช้รายการที่ทีมกรอก */
export interface Charge {
  planName?: string | null;
  cycle?: 'monthly' | 'yearly' | null;
  periodStart: string;
  periodEnd: string;
  seatLimit?: number | null;
  seatsUsed?: number | null;
  /** ราคาหลังหักส่วนลด ก่อน VAT */
  subtotal: number;
  discount: number;
  discountLabel?: string | null;
  items?: { description: string; qty: number; unitSatang: number }[] | null;
}
export function chargeLines(c: Charge, opts: { withUsage?: boolean } = {}): SaleLine[] {
  if (c.items?.length) {
    // ใบที่ทีมออกเอง: ส่วนลดเป็นเปอร์เซ็นต์ของรายการทั้งหมด (ไม่อยู่ในคอลัมน์ discount) → แสดงผลต่างเป็นบรรทัดส่วนลด
    const lines: SaleLine[] = c.items.map((it) => ({ description: it.description, qty: it.qty, unit: 'รายการ', unitPrice: it.unitSatang, amount: it.qty * it.unitSatang }));
    const off = lines.reduce((n, l) => n + l.amount, 0) - c.subtotal;
    if (off > 0) lines.push({ description: `ส่วนลด${c.discountLabel ? ` ${c.discountLabel}` : ''}`, qty: 1, unit: 'รายการ', unitPrice: -off, amount: -off });
    return lines;
  }
  const cycle = c.cycle === 'yearly' ? 'รายปี' : 'รายเดือน';
  const seats = c.seatLimit ? ` · สมาชิกสูงสุด ${c.seatLimit} คน${opts.withUsage && c.seatsUsed ? ` (ใช้อยู่ ${c.seatsUsed} คน)` : ''}` : '';
  const price = c.subtotal + c.discount;
  const lines: SaleLine[] = [{ description: `ค่าบริการ Friday Work Management แพ็กเกจ ${c.planName ?? ''} (${cycle})`.replace('  ', ' '), sub: `รอบบริการ ${thaiDate(c.periodStart)} – ${thaiDate(c.periodEnd)}${seats}`, qty: 1, unit: c.cycle === 'yearly' ? 'ปี' : 'เดือน', unitPrice: price, amount: price }];
  if (c.discount > 0) lines.push({ description: `ส่วนลด${c.discountLabel ? ` ${c.discountLabel}` : ''}`, qty: 1, unit: 'รายการ', unitPrice: -c.discount, amount: -c.discount });
  return lines;
}

const vatTotals = (subtotal: number, vat: number, total: number, vatRegistered: boolean, valueLabel = 'มูลค่าบริการ / Value'): TotalRow[] =>
  vatRegistered
    ? [{ label: valueLabel, value: subtotal }, { label: 'ภาษีมูลค่าเพิ่ม 7% / VAT', value: vat }, { label: 'รวมทั้งสิ้น / Total', value: total, style: 'grand' }]
    : [{ label: 'รวมทั้งสิ้น / Total', value: total, style: 'grand' }];

// ---------------------------------------------------------------------------
// 1. ใบเสนอราคา
// ---------------------------------------------------------------------------
export interface QuotationInput {
  seller: Seller;
  buyer: Buyer | null;
  number: string;
  date: string;
  validUntil: string;
  planName: string;
  cycle: 'monthly' | 'yearly';
  seatLimit?: number | null;
  storageGbPerMember?: number | null;
  yearlyPrice?: number | null;
  yearlyMonths?: number | null;
  subtotal: number;
  discount: number;
  discountLabel?: string | null;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
  vatRegistered: boolean;
}
export function quotationDoc(q: QuotationInput): FinanceDoc {
  const price = q.subtotal + q.discount;
  const lines: SaleLine[] = [{ description: `ค่าบริการ Friday Work Management แพ็กเกจ ${q.planName} (${q.cycle === 'yearly' ? 'รายปี' : 'รายเดือน'})`, sub: 'เริ่มรอบวันที่ชำระ · ต่ออายุทุกรอบ ยกเลิกได้ตลอด', qty: 1, unit: q.cycle === 'yearly' ? 'ปี' : 'เดือน', unitPrice: price, amount: price }];
  if (q.discount > 0) lines.push({ description: `ส่วนลด${q.discountLabel ? ` ${q.discountLabel}` : ''}`, qty: 1, unit: 'รายการ', unitPrice: -q.discount, amount: -q.discount });
  return {
    title: 'ใบเสนอราคา', titleEn: 'QUOTATION', badge: `ใช้ได้ถึง ${thaiDate(q.validUntil)}`, number: q.number, seller: q.seller,
    partyLabel: 'เสนอราคาแก่ / Prepared for',
    party: q.buyer ? party(q.buyer, q.buyer.email ? [`อีเมล ${q.buyer.email}`] : []) : { name: '................................................', branch: 'สำนักงานใหญ่ / สาขาที่ ..........', address: '................................................', taxId: '' },
    meta: [['เลขที่ / No.', q.number], ['วันที่ / Date', thaiDate(q.date)], ['ยืนราคาถึง / Valid until', thaiDate(q.validUntil)], ['ผู้เสนอ / Prepared by', 'ระบบ Friday']],
    table: { kind: 'sale', lines },
    totals: [...vatTotals(q.subtotal, q.vat, q.total, q.vatRegistered), ...(q.whtAmount > 0 ? [{ label: 'ถ้าหัก ณ ที่จ่าย 3% ชำระสุทธิ', value: `฿${baht(q.amountDue)}`, style: 'muted' as const }] : [])],
    words: q.total,
    band: {
      title: 'สิ่งที่ได้ในแพ็กเกจ / Included',
      cells: [
        ['สมาชิก', q.seatLimit ? `สูงสุด ${q.seatLimit} คน` : 'ไม่จำกัด'],
        ['Guest (ลูกค้า)', 'ไม่นับที่นั่ง'],
        ['พื้นที่ไฟล์', q.storageGbPerMember ? `${q.storageGbPerMember} GB ต่อสมาชิก` : 'ไม่จำกัด'],
        ['รายปี', q.yearlyPrice ? `฿${baht(q.yearlyPrice)}${q.yearlyMonths ? ` (จ่าย ${q.yearlyMonths} เดือน)` : ''}` : '-'],
      ],
    },
    notes: [
      'เอกสารนี้ไม่ใช่ใบแจ้งหนี้และไม่ใช่ใบกำกับภาษี',
      'ชำระด้วยบัตร PromptPay หรือโอนเงิน · ออกใบแจ้งหนี้ได้ทันทีที่หน้า แพ็กเกจ & Billing โดยใส่เลข PO',
      'ราคาตามใบเสนอราคานี้ใช้ได้ถึงวันที่ยืนราคาเท่านั้น',
    ],
    sign: [{ line: SYSTEM, role: 'ผู้เสนอราคา / Quoted by', sub: thaiDate(q.date) }, { role: 'ผู้อนุมัติสั่งซื้อ / Accepted by', sub: 'วันที่ ........ / ........ / ........' }],
  };
}

// ---------------------------------------------------------------------------
// 2. ใบแจ้งหนี้ / ใบวางบิล
// ---------------------------------------------------------------------------
export interface InvoiceInput {
  seller: Seller;
  buyer: Buyer;
  edition: Edition;
  number: string;
  date: string;
  dueDate: string;
  status: 'open' | 'pending_review' | 'paid' | 'void';
  poNumber?: string | null;
  workspaceName?: string | null;
  charge: Charge;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
  vatRegistered: boolean;
  method?: string | null;
  bank: { bank: string; accountName: string; accountNo: string };
}
const STATUS: Record<InvoiceInput['status'], string> = { open: 'รอชำระ / Unpaid', pending_review: 'รอตรวจสลิป / Pending review', paid: 'ชำระแล้ว / Paid', void: 'ยกเลิก / Void' };
export function invoiceDoc(i: InvoiceInput): FinanceDoc {
  const wht = i.whtAmount > 0;
  return {
    title: 'ใบแจ้งหนี้ / ใบวางบิล', titleEn: 'INVOICE / BILLING NOTE', badge: EDITION[i.edition], number: i.number, seller: i.seller,
    partyLabel: 'ลูกค้า / Bill to',
    party: party(i.buyer, [[i.buyer.email && `อีเมล ${i.buyer.email}`, i.workspaceName && `Workspace: ${i.workspaceName}`].filter(Boolean).join(' · ')].filter(Boolean)),
    meta: [['เลขที่ / No.', i.number], ['วันที่ / Date', thaiDate(i.date)], ['ครบกำหนด / Due', thaiDate(i.dueDate)], ...(i.poNumber ? [['ใบสั่งซื้อ / PO', i.poNumber] as [string, string]] : []), ['สถานะ / Status', STATUS[i.status]]],
    table: { kind: 'sale', lines: chargeLines(i.charge, { withUsage: true }) },
    totals: [...vatTotals(i.charge.subtotal, i.vat, i.total, i.vatRegistered), ...(wht ? [{ label: 'หัก ณ ที่จ่าย 3% / WHT', value: -i.whtAmount, style: 'muted' as const }, { label: 'ยอดชำระสุทธิ / Net payable', value: `฿${baht(i.amountDue)}`, style: 'net' as const }] : [])],
    words: i.total,
    band: {
      title: 'วิธีชำระ / How to pay',
      cells: [['โอนเข้าบัญชี', `${i.bank.bank} ${i.bank.accountNo}`], ['ชื่อบัญชี', i.bank.accountName], ['เลขอ้างอิง', i.number], ['ชำระออนไลน์', 'แพ็กเกจ & Billing › ชำระ']],
      note: `โอนแล้วแนบสลิปที่หน้าเดียวกัน${wht ? ' · มีหัก ณ ที่จ่ายจึงชำระด้วยบัตรไม่ได้' : ''} · ลิงก์หน้าชำระอยู่ในอีเมลแจ้งหนี้`,
    },
    notes: [
      `เอกสารนี้ไม่ใช่ใบกำกับภาษี · ${i.vatRegistered ? 'ใบเสร็จรับเงิน/ใบกำกับภาษี' : 'ใบเสร็จรับเงิน'}ออกเมื่อได้รับชำระ ลงวันที่ที่ได้รับเงิน`,
      ...(wht ? ['ผู้ซื้อหักภาษี ณ ที่จ่าย 3% ของมูลค่าก่อน VAT กรุณาส่ง 50 ทวิ ภายใน 30 วันที่หน้า แพ็กเกจ & Billing'] : []),
      'ไม่ชำระภายในกำหนด Workspace จะกลับเป็นแพ็กเกจ Free ข้อมูลไม่หาย',
    ],
    sign: [{ role: 'ผู้รับวางบิล / Received by', sub: 'วันที่ ........ / ........ / ........' }, { line: SYSTEM, role: 'ผู้วางบิล / Issued by', sub: thaiDate(i.date) }],
  };
}

// ---------------------------------------------------------------------------
// 3. ใบเสร็จรับเงิน / ใบกำกับภาษี (เต็มรูป) · 4. ฉบับใหม่แทนฉบับที่ยกเลิก (replaces)
// ---------------------------------------------------------------------------
export interface ReceiptInput {
  seller: Seller;
  buyer: Buyer;
  edition: Edition;
  vatRegistered: boolean;
  number: string;
  /** วันที่ของเอกสาร = วันที่ได้รับเงิน */
  date: string;
  invoiceNumber: string;
  poNumber?: string | null;
  charge: Charge;
  vat: number;
  total: number;
  whtAmount: number;
  payment: { paidAt: Date; method: string; reference?: string | null; received: number; cardLast4?: string | null };
  /** ฉบับใหม่แทนฉบับที่ยกเลิก */
  replaces?: { number: string; date: string; reason: string; issuedOn: string } | null;
  /** ใบแทน (ม.86/12) เมื่อใบเดิมหาย */
  reissue?: { date: string; reason: string } | null;
  nextBillingDate?: string | null;
}
export function receiptDoc(r: ReceiptInput): FinanceDoc {
  const title = r.vatRegistered ? 'ใบเสร็จรับเงิน / ใบกำกับภาษี' : 'ใบเสร็จรับเงิน';
  const method = r.payment.cardLast4 ? `บัตร •••• ${r.payment.cardLast4}` : (METHOD[r.payment.method] ?? r.payment.method);
  const paidOn = thaiDate(r.date);
  return {
    title, titleEn: r.vatRegistered ? 'RECEIPT / TAX INVOICE' : 'RECEIPT', badge: EDITION[r.reissue ? 'replacement' : r.edition],
    badgeSub: r.reissue ? `ออกใบแทนเมื่อ ${thaiDate(r.reissue.date)} · ${r.reissue.reason}` : r.vatRegistered ? 'เอกสารออกเป็นชุด' : undefined,
    number: r.number, seller: r.seller,
    remark: r.replaces ? { label: 'ออกแทนฉบับที่ยกเลิก / Replaces cancelled document', text: `ยกเลิก${r.vatRegistered ? 'ใบกำกับภาษี' : 'ใบเสร็จรับเงิน'}เลขที่ ${r.replaces.number} ลงวันที่ ${thaiDate(r.replaces.date)} และออกฉบับนี้แทน เนื่องจาก${r.replaces.reason}` } : undefined,
    partyLabel: 'ผู้ซื้อ / Customer', party: party(r.buyer),
    meta: [
      ['เลขที่ / No.', r.number],
      ['วันที่ / Date', paidOn],
      ...(r.replaces ? [['ออกเมื่อ / Issued', thaiDate(r.replaces.issuedOn)] as [string, string], ['แทนฉบับ', r.replaces.number] as [string, string]] : []),
      ['อ้างอิงใบแจ้งหนี้', r.invoiceNumber],
      ...(r.poNumber ? [['ใบสั่งซื้อ / PO', r.poNumber] as [string, string]] : []),
    ],
    table: { kind: 'sale', lines: chargeLines(r.charge) },
    totals: vatTotals(r.charge.subtotal, r.vat, r.total, r.vatRegistered),
    words: r.total,
    band: {
      title: 'รายละเอียดการรับชำระ / Payment received',
      cells: [[r.payment.method === 'transfer' ? 'วันที่ได้รับเงิน (ตามสลิป)' : 'วันที่ได้รับเงิน', thaiDateTime(r.payment.paidAt)], ['ช่องทาง', method], ['อ้างอิงการชำระ', r.payment.reference || r.invoiceNumber], ['รับชำระ', `฿${baht(r.payment.received)}`]],
      note: r.whtAmount > 0 ? `ยอดรวม ฿${baht(r.total)} = รับชำระ ฿${baht(r.payment.received)} + ผู้ซื้อหัก ณ ที่จ่าย 3% ฿${baht(r.whtAmount)}` : undefined,
    },
    notes: [
      ...(r.vatRegistered ? [ETAX_NOTE + (r.replaces ? ' · แจ้งยกเลิกฉบับเดิมผ่านระบบ e-Tax แล้ว' : '')] : []),
      ...(r.replaces ? [`ฉบับเดิม ${r.replaces.number} ใช้อ้างอิงไม่ได้อีก กรุณาใช้ฉบับนี้แทน`] : []),
      ...(r.nextBillingDate ? [`รอบถัดไปส่งใบแจ้งหนี้ทางอีเมลล่วงหน้า 7 วัน (${thaiDate(r.nextBillingDate)})`] : []),
    ],
    stamp: { text: 'ชำระแล้ว', sub: `PAID · ${paidOn}` },
    sign: [{ role: 'ผู้จ่ายเงิน / Payer', sub: '(ไม่ต้องลงนาม)' }, { line: r.vatRegistered ? SIGNED : SYSTEM, role: 'ผู้รับเงิน / Collector', sub: r.seller.name }],
  };
}

// ---------------------------------------------------------------------------
// 5. ใบลดหนี้ (ม.86/10) · 6. ใบเพิ่มหนี้ (ม.86/9) · โครงเดียวกัน
// ---------------------------------------------------------------------------
export interface AdjustInput {
  kind: 'credit' | 'debit';
  seller: Seller;
  buyer: Buyer;
  edition: Edition;
  vatRegistered: boolean;
  number: string;
  date: string;
  reason: string;
  /** ใบกำกับภาษีเดิม */
  ref: { number: string; date: string };
  line: { description: string; sub?: string; original: number };
  /** ผลต่างก่อน VAT (บวกเสมอ) และ VAT ของผลต่าง */
  difference: number;
  vat: number;
  band: { title: string; cells: [string, string][]; note?: string };
}
export function adjustmentDoc(a: AdjustInput): FinanceDoc {
  const credit = a.kind === 'credit';
  const name = credit ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้';
  const correct = credit ? a.line.original - a.difference : a.line.original + a.difference;
  const line: AdjustLine = { description: a.line.description, sub: a.line.sub, original: a.line.original, correct, difference: a.difference };
  const totals: TotalRow[] = [
    { label: 'มูลค่าตามใบกำกับภาษีเดิม', value: a.line.original },
    { label: 'มูลค่าที่ถูกต้อง', value: correct },
    { label: 'ผลต่าง / Difference', value: a.difference },
    ...(a.vatRegistered ? [{ label: 'ภาษีมูลค่าเพิ่ม 7% ของผลต่าง', value: a.vat }] : []),
    { label: credit ? 'รวมลดหนี้ / Total credit' : 'รวมเพิ่มหนี้ / Total debit', value: a.difference + a.vat, style: 'grand' },
  ];
  return {
    title: name, titleEn: credit ? 'CREDIT NOTE' : 'DEBIT NOTE', badge: EDITION[a.edition], number: a.number, seller: a.seller,
    remark: { label: credit ? 'เหตุที่ลดหนี้ / Reason' : 'เหตุที่เพิ่มหนี้ / Reason', text: a.reason },
    partyLabel: 'ผู้ซื้อ / Customer', party: party(a.buyer),
    meta: [['เลขที่ / No.', a.number], ['วันที่ / Date', thaiDate(a.date)], [a.vatRegistered ? 'อ้างอิงใบกำกับภาษี' : 'อ้างอิงใบเสร็จ', a.ref.number], ['ลงวันที่', thaiDate(a.ref.date)]],
    table: { kind: 'adjust', lines: [line] },
    totals,
    words: a.difference + a.vat,
    band: a.band,
    notes: [
      `${name}นี้${credit ? 'ใช้ลด' : 'เพิ่ม'}ภาษีขายของผู้ขายและภาษีซื้อของผู้ซื้อตาม${a.vatRegistered ? 'ใบกำกับภาษี' : 'ใบเสร็จ'}เลขที่ ${a.ref.number}`,
      ...(a.vatRegistered ? [ETAX_NOTE] : []),
    ],
    sign: [{ role: `ผู้รับ${name} / Received by`, sub: '(ไม่ต้องลงนาม)' }, { line: a.vatRegistered ? SIGNED : SYSTEM, role: `ผู้ออก${name} / Issued by`, sub: a.seller.name }],
  };
}
