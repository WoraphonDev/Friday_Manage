// รายงานภาษีขายรายเดือน (ม.87) · หน้า 1 ตามแบบ (คอลัมน์ที่ใช้ตอนสรรพากรตรวจ) · หน้า 2 รายละเอียดประกอบสำหรับกระทบยอด
// PDF แนวนอน + Excel 2 แท็บ · ข้อมูลเดียวกัน
import ExcelJS from 'exceljs';
import { baht, monthName, thaiDateTime, thaiNumericDate } from './format.ts';
import { C, footers, heightOf, lh, pdf, text, type Seller } from './render.ts';

export type SalesDocKind = 'tax_invoice' | 'receipt' | 'credit_note' | 'debit_note';
export interface SalesRow {
  /** วันที่ของเอกสาร (YYYY-MM-DD) */
  date: string;
  number: string;
  kind: SalesDocKind;
  cancelled?: boolean;
  /** บรรทัดเล็กใต้ชื่อผู้ซื้อ เช่น "ใบลดหนี้ อ้างถึง TX-…" */
  note?: string;
  buyerName: string;
  buyerTaxId: string;
  /** "สำนักงานใหญ่" หรือเลขสาขา 5 หลัก */
  branch: string;
  /** มูลค่าก่อน VAT และ VAT (ใบลดหนี้ติดลบ · ใบที่ยกเลิก = 0) */
  value: number;
  vat: number;
  detail: {
    ref: string;
    plan: string;
    whtAmount: number | null;
    received: number | null;
    receivedOn: string | null;
    channel: string;
    etax: string;
    flags: ('wht' | 'outstanding')[];
  };
}
export interface SalesReportInput {
  seller: Seller;
  year: number;
  month: number;
  rows: SalesRow[];
  checks: { ok: boolean; text: string }[];
  closed: boolean;
  generatedAt: Date;
}

const KIND_LABEL: Record<SalesDocKind, string> = { tax_invoice: 'ใบกำกับภาษี', receipt: 'ใบเสร็จรับเงิน', credit_note: 'ใบลดหนี้', debit_note: 'ใบเพิ่มหนี้' };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** สรุปแยกตามประเภท + ยอดสุทธิ (ใช้กรอก ภ.พ.30) */
export function summarize(rows: SalesRow[]) {
  const kinds: SalesDocKind[] = ['tax_invoice', 'receipt', 'credit_note', 'debit_note'];
  const byKind = kinds
    .map((k) => {
      const list = rows.filter((r) => r.kind === k);
      return { kind: k, label: KIND_LABEL[k], count: list.length, cancelled: list.filter((r) => r.cancelled).length, value: sum(list.map((r) => r.value)), vat: sum(list.map((r) => r.vat)) };
    })
    .filter((k) => k.count > 0);
  return { byKind, value: sum(rows.map((r) => r.value)), vat: sum(rows.map((r) => r.vat)), total: sum(rows.map((r) => r.value + r.vat)), wht: sum(rows.map((r) => r.detail.whtAmount ?? 0)), received: sum(rows.map((r) => r.detail.received ?? 0)) };
}

// ฟอนต์ IBM Plex Sans Thai ไม่มี ✓ ☑ ☐ จึงวาดเครื่องหมายเอง
function tick(doc: PDFKit.PDFDocument, x: number, y: number, color: string) {
  doc.save().moveTo(x, y + 4).lineTo(x + 2.6, y + 6.6).lineTo(x + 7, y + 1).lineWidth(1.4).strokeColor(color).stroke().restore();
}
function checkbox(doc: PDFKit.PDFDocument, x: number, y: number, checked: boolean) {
  doc.rect(x, y, 8, 8).lineWidth(0.8).strokeColor(C.ink).stroke();
  if (checked) tick(doc, x + 0.5, y + 0.5, C.ink);
}

type Col<T> = { th: string; w: number; align?: 'left' | 'right' | 'center'; get: (r: T) => string; sub?: (r: T) => string | undefined };

export function renderSalesReport(input: SalesReportInput): Promise<Buffer> {
  const period = `${monthName(input.month)} ${input.year + 543}`;
  const s = summarize(input.rows);
  return pdf({ title: `รายงานภาษีขาย ${period}`, author: input.seller.name }, 'landscape', (doc) => {
    const M = 34;
    const L = M;
    const R = doc.page.width - M;
    const W = R - L;
    const limit = () => doc.page.height - M - 18;
    let y = 30;

    const table = <T,>(cols: Col<T>[], rows: T[], muted: (r: T) => boolean, totalRow?: string[]) => {
      const flex = cols.find((c) => c.w === 0)!;
      flex.w = W - sum(cols.map((c) => c.w));
      const xs = cols.reduce<number[]>((acc, c, i) => [...acc, i ? acc[i - 1] + cols[i - 1].w : L], []);
      const headH = Math.max(...cols.map((c) => heightOf(doc, c.th, { width: c.w - 8, size: 7.5, weight: 700 }))) + 10;
      const head = () => {
        doc.rect(L, y, W, headH).fill(C.tint);
        cols.forEach((c, i) => {
          doc.rect(xs[i], y, c.w, headH).lineWidth(0.5).strokeColor(C.rule).stroke();
          text(doc, c.th, { x: xs[i] + 4, y: y + 5, width: c.w - 8, size: 7.5, weight: 700, align: 'center' });
        });
        y += headH;
      };
      head();
      for (const r of rows) {
        const h = Math.max(...cols.map((c) => heightOf(doc, c.get(r), { width: c.w - 8, size: 8 }) + (c.sub?.(r) ? heightOf(doc, c.sub(r)!, { width: c.w - 8, size: 6.5 }) : 0))) + 8;
        if (y + h > limit()) {
          doc.addPage();
          y = 30;
          head();
        }
        const color = muted(r) ? C.ink3 : C.ink;
        cols.forEach((c, i) => {
          doc.rect(xs[i], y, c.w, h).lineWidth(0.5).strokeColor(C.rule).stroke();
          const v = c.get(r);
          const th = text(doc, v, { x: xs[i] + 4, y: y + 4, width: c.w - 8, size: 8, align: c.align, color: v.startsWith('-') && !muted(r) ? C.ink2 : color });
          const sub = c.sub?.(r);
          if (sub) text(doc, sub, { x: xs[i] + 4, y: y + 4 + th, width: c.w - 8, size: 6.5, color: C.ink3 });
        });
        y += h;
      }
      if (totalRow) {
        const h = lh(8.5) + 8;
        doc.rect(L, y, W, h).fill(C.tint);
        cols.forEach((c, i) => {
          doc.rect(xs[i], y, c.w, h).lineWidth(0.5).strokeColor(C.rule).stroke();
          if (totalRow[i]) text(doc, totalRow[i], { x: xs[i] + 4, y: y + 4, width: c.w - 8, size: 8.5, weight: 700, align: c.align ?? 'right' });
        });
        y += h;
      }
    };

    // ---------------- หน้า 1: ตามแบบ ----------------
    text(doc, 'รายงานภาษีขาย', { x: L, y, width: W, size: 16, weight: 700, align: 'center' });
    y += lh(16);
    text(doc, `เดือนภาษี ${monthName(input.month)} ปี ${input.year + 543}${input.closed ? '' : ' · ฉบับร่าง (ยังไม่ปิดเดือน)'}`, { x: L, y, width: W, size: 9, align: 'center' });
    y += lh(9) + 6;
    const boxTop = y;
    const half = W / 2;
    text(doc, `ชื่อผู้ประกอบการ ${input.seller.name}`, { x: L + 10, y: y + 6, width: half - 20, size: 8.5 });
    text(doc, `เลขประจำตัวผู้เสียภาษีอากร ${input.seller.taxId}`, { x: L + half, y: y + 6, width: half - 10, size: 8.5 });
    text(doc, `ชื่อสถานประกอบการ ${input.seller.name}`, { x: L + 10, y: y + 6 + lh(8.5), width: half - 20, size: 8.5 });
    const hq = input.seller.branch === 'สำนักงานใหญ่';
    const by = y + 6 + lh(8.5);
    checkbox(doc, L + half, by + 3, hq);
    text(doc, 'สำนักงานใหญ่', { x: L + half + 12, y: by, width: 90, size: 8.5, weight: 700 });
    checkbox(doc, L + half + 100, by + 3, !hq);
    text(doc, hq ? 'สาขาที่ .....' : input.seller.branch, { x: L + half + 112, y: by, width: half - 122, size: 8.5, weight: 700 });
    y += lh(8.5) * 2 + 12;
    doc.roundedRect(L, boxTop, W, y - boxTop, 4).lineWidth(0.75).strokeColor(C.rule).stroke();
    y += 8;
    const statutory: Col<SalesRow & { i: number }>[] = [
      { th: 'ลำดับ', w: 34, align: 'center', get: (r) => String(r.i) },
      { th: 'วัน เดือน ปี', w: 62, align: 'center', get: (r) => thaiNumericDate(r.date) },
      { th: 'เลขที่ใบกำกับภาษี', w: 92, get: (r) => r.number },
      { th: 'ชื่อผู้ซื้อสินค้า/ผู้รับบริการ', w: 0, get: (r) => r.buyerName, sub: (r) => r.note },
      { th: 'เลขประจำตัวผู้เสียภาษีอากรของผู้ซื้อ', w: 104, get: (r) => r.buyerTaxId },
      { th: 'สถานประกอบการ (สำนักงานใหญ่ / สาขาที่)', w: 96, align: 'center', get: (r) => r.branch },
      { th: 'มูลค่าสินค้าหรือบริการ', w: 92, align: 'right', get: (r) => baht(r.value) },
      { th: 'จำนวนเงินภาษีมูลค่าเพิ่ม', w: 88, align: 'right', get: (r) => baht(r.vat) },
    ];
    const indexed = input.rows.map((r, i) => ({ ...r, i: i + 1 }));
    table(statutory, indexed, (r) => !!r.cancelled, ['', '', '', '', '', 'รวม', baht(s.value), baht(s.vat)]);
    y += 10;
    if (y + 50 > limit()) {
      doc.addPage();
      y = 30;
    }
    const cells: [string, string][] = [['ยอดขาย (หลังลด/เพิ่มหนี้)', baht(s.value)], ['ภาษีขาย', baht(s.vat)], ['เอกสารที่ยกเลิก', `${input.rows.filter((r) => r.cancelled).length} ใบ`], ['จัดทำเมื่อ', thaiDateTime(input.generatedAt)]];
    doc.roundedRect(L, y, W, 44, 4).lineWidth(0.75).strokeColor(C.rule).stroke();
    text(doc, 'ใช้ยื่น ภ.พ.30', { x: L + 10, y: y + 6, width: 200, size: 8.5, weight: 700 });
    cells.forEach(([k, v], i) => {
      text(doc, k, { x: L + 10 + (i * (W - 20)) / 4, y: y + 6 + lh(8.5), width: (W - 20) / 4, size: 7.5, color: C.ink3 });
      text(doc, v, { x: L + 10 + (i * (W - 20)) / 4, y: y + 6 + lh(8.5) + lh(7.5), width: (W - 20) / 4, size: 9, weight: 700 });
    });

    // ---------------- หน้า 2: รายละเอียดประกอบ ----------------
    doc.addPage();
    y = 30;
    text(doc, 'รายละเอียดประกอบรายงานภาษีขาย', { x: L, y, width: W, size: 14, weight: 700, align: 'center' });
    y += lh(14);
    text(doc, `เดือนภาษี ${period} · สำหรับกระทบยอดภายใน ไม่ต้องยื่น`, { x: L, y, width: W, size: 8.5, align: 'center' });
    y += lh(8.5) + 8;
    const flag = (r: SalesRow) => [r.detail.flags.includes('wht') ? 'รอ 50 ทวิ' : '', r.detail.flags.includes('outstanding') ? 'ค้างรับ' : ''].filter(Boolean).join(' · ') || undefined;
    const dash = (v: number | null) => (v === null ? '–' : baht(v));
    const detail: Col<SalesRow>[] = [
      { th: 'เลขที่เอกสาร', w: 76, get: (r) => r.number },
      { th: 'ประเภท', w: 74, get: (r) => (r.cancelled ? 'ยกเลิก' : KIND_LABEL[r.kind]) },
      { th: 'อ้างอิง', w: 76, get: (r) => r.detail.ref },
      { th: 'แพ็กเกจ · รอบ', w: 0, get: (r) => r.detail.plan },
      { th: 'ก่อน VAT', w: 62, align: 'right', get: (r) => baht(r.value) },
      { th: 'VAT', w: 50, align: 'right', get: (r) => baht(r.vat) },
      { th: 'รวม', w: 62, align: 'right', get: (r) => baht(r.value + r.vat) },
      { th: 'หัก ณ ที่จ่าย', w: 52, align: 'right', get: (r) => dash(r.detail.whtAmount) },
      { th: 'รับจริง', w: 62, align: 'right', get: (r) => dash(r.detail.received) },
      { th: 'วันที่ได้รับเงิน', w: 54, align: 'center', get: (r) => (r.detail.receivedOn ? thaiNumericDate(r.detail.receivedOn) : '–') },
      { th: 'ช่องทาง', w: 82, get: (r) => r.detail.channel, sub: flag },
      { th: 'e-Tax', w: 60, get: (r) => r.detail.etax },
    ];
    table(detail, input.rows, (r) => !!r.cancelled, ['', '', '', 'รวม', baht(s.value), baht(s.vat), baht(s.total), baht(s.wht), baht(s.received), '', '', '']);
    y += 10;
    const boxH = Math.max(lh(8.5) + 8 + (s.byKind.length + 2) * lh(8.5), lh(8.5) + 8 + input.checks.length * lh(8.5)) + 12;
    if (y + boxH > limit()) {
      doc.addPage();
      y = 30;
    }
    const bw = (W - 12) / 2;
    doc.roundedRect(L, y, bw, boxH, 4).lineWidth(0.75).strokeColor(C.rule).stroke();
    doc.roundedRect(L + bw + 12, y, bw, boxH, 4).lineWidth(0.75).strokeColor(C.rule).stroke();
    let ly = y + 6;
    text(doc, 'แยกตามประเภทเอกสาร', { x: L + 10, y: ly, width: bw - 20, size: 8.5, weight: 700 });
    ly += lh(8.5) + 4;
    const colX = [L + 10, L + bw * 0.42, L + bw * 0.62, L + bw * 0.82];
    const row = (vals: string[], bold = false) => {
      vals.forEach((v, i) => text(doc, v, { x: colX[i], y: ly, width: i ? bw * 0.18 - 4 : bw * 0.32, size: 8, weight: bold ? 700 : 400, align: i ? 'right' : 'left' }));
      ly += lh(8.5);
    };
    row(['ประเภท', 'จำนวน', 'มูลค่า', 'VAT'], true);
    for (const k of s.byKind) row([k.label, `${k.count} ใบ${k.cancelled ? ` (ยกเลิก ${k.cancelled})` : ''}`, baht(k.value), baht(k.vat)]);
    row(['สุทธิ (กรอก ภ.พ.30)', '', baht(s.value), baht(s.vat)], true);
    let cy = y + 6;
    text(doc, 'ตรวจอัตโนมัติก่อนปิดเดือน', { x: L + bw + 22, y: cy, width: bw - 20, size: 8.5, weight: 700 });
    cy += lh(8.5) + 4;
    for (const c of input.checks) {
      if (c.ok) tick(doc, L + bw + 22, cy + 3, C.paid);
      else text(doc, '!', { x: L + bw + 24, y: cy, width: 8, size: 8, weight: 700, color: C.warnInk });
      cy += text(doc, c.text, { x: L + bw + 34, y: cy, width: bw - 44, size: 8, color: c.ok ? C.paid : C.warnInk });
    }

    footers(doc, `จัดทำโดยระบบ Friday Ops เมื่อ ${thaiDateTime(input.generatedAt)} · ลำดับตามวันที่และเลขที่เอกสาร`, `รายงานภาษีขาย ${period}`, M);
  });
}

/** Excel 2 แท็บ: ตามแบบ + รายละเอียด (ตัวเลขเป็นบาท ทศนิยม 2 ตำแหน่ง) */
export async function salesReportXlsx(input: SalesReportInput): Promise<Buffer> {
  const s = summarize(input.rows);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Friday Ops';
  const money = '#,##0.00';
  const a = wb.addWorksheet('รายงานภาษีขาย');
  a.addRow(['รายงานภาษีขาย']).font = { bold: true, size: 14 };
  a.addRow([`เดือนภาษี ${monthName(input.month)} ปี ${input.year + 543}${input.closed ? '' : ' (ฉบับร่าง)'}`]);
  a.addRow([`ชื่อผู้ประกอบการ ${input.seller.name}`, '', '', '', `เลขประจำตัวผู้เสียภาษีอากร ${input.seller.taxId}`]);
  a.addRow([`ชื่อสถานประกอบการ ${input.seller.name}`, '', '', '', input.seller.branch]);
  a.addRow([]);
  const h1 = a.addRow(['ลำดับ', 'วัน เดือน ปี', 'เลขที่ใบกำกับภาษี', 'ชื่อผู้ซื้อสินค้า/ผู้รับบริการ', 'เลขประจำตัวผู้เสียภาษีอากรของผู้ซื้อ', 'สถานประกอบการ', 'มูลค่าสินค้าหรือบริการ', 'จำนวนเงินภาษีมูลค่าเพิ่ม']);
  h1.font = { bold: true };
  input.rows.forEach((r, i) => a.addRow([i + 1, thaiNumericDate(r.date), r.number, r.note ? `${r.buyerName} (${r.note})` : r.buyerName, r.buyerTaxId, r.branch, r.value / 100, r.vat / 100]));
  const t1 = a.addRow(['', '', '', '', '', 'รวม', s.value / 100, s.vat / 100]);
  t1.font = { bold: true };
  a.columns = [{ width: 7 }, { width: 12 }, { width: 16 }, { width: 44 }, { width: 22 }, { width: 16 }, { width: 18, style: { numFmt: money } }, { width: 18, style: { numFmt: money } }];
  const b = wb.addWorksheet('รายละเอียด');
  const h2 = b.addRow(['เลขที่เอกสาร', 'ประเภท', 'อ้างอิง', 'แพ็กเกจ · รอบ', 'ก่อน VAT', 'VAT', 'รวม', 'หัก ณ ที่จ่าย', 'รับจริง', 'วันที่ได้รับเงิน', 'ช่องทาง', 'e-Tax', 'ติดตาม']);
  h2.font = { bold: true };
  for (const r of input.rows)
    b.addRow([r.number, r.cancelled ? 'ยกเลิก' : KIND_LABEL[r.kind], r.detail.ref, r.detail.plan, r.value / 100, r.vat / 100, (r.value + r.vat) / 100, r.detail.whtAmount === null ? null : r.detail.whtAmount / 100, r.detail.received === null ? null : r.detail.received / 100, r.detail.receivedOn ? thaiNumericDate(r.detail.receivedOn) : '', r.detail.channel, r.detail.etax, [r.detail.flags.includes('wht') ? 'รอ 50 ทวิ' : '', r.detail.flags.includes('outstanding') ? 'ค้างรับ' : ''].filter(Boolean).join(', ')]);
  const t2 = b.addRow(['', '', '', 'รวม', s.value / 100, s.vat / 100, s.total / 100, s.wht / 100, s.received / 100]);
  t2.font = { bold: true };
  b.columns = [{ width: 16 }, { width: 16 }, { width: 16 }, { width: 24 }, ...Array.from({ length: 5 }, () => ({ width: 14, style: { numFmt: money } })), { width: 14 }, { width: 18 }, { width: 14 }, { width: 18 }];
  b.addRow([]);
  for (const c of input.checks) b.addRow([c.ok ? 'ผ่าน' : 'ตรวจ', c.text]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
