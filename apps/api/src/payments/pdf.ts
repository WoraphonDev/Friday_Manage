import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const FONT_DIR = join(dirname(require.resolve('@fontsource/ibm-plex-sans-thai/package.json')), 'files');
const font = (subset: 'thai' | 'latin', w: 400 | 600) => join(FONT_DIR, `ibm-plex-sans-thai-${subset}-${w}-normal.woff`);

export interface DocLine {
  description: string;
  amount: number;
}
export interface BillDoc {
  title: string;
  subtitle: string;
  number: string;
  date: string;
  seller: { name: string; taxId: string; address: string };
  buyer: { companyName: string; taxId: string; branch: string; address: string; email: string };
  lines: DocLine[];
  subtotal: number;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
  status: string;
  footer: string[];
}

export const baht = (satang: number) => `${(satang / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isThai = (ch: string) => /[฀-๿]/.test(ch);

/** ข้อความผสมไทย / ละติน: แบ่งเป็นช่วงตามอักษรแล้วเลือกฟอนต์ที่มีกลิฟของชุดนั้น */
function write(doc: PDFKit.PDFDocument, text: string, w: 400 | 600, opts: PDFKit.Mixins.TextOptions & { x?: number; y?: number } = {}) {
  const runs: { thai: boolean; text: string }[] = [];
  for (const ch of text) {
    // ช่องว่างและเครื่องหมายติดกับช่วงเดิม (ฟอนต์ละตินมีเครื่องหมายวรรคตอนครบ)
    const thai = isThai(ch) ? true : /\s/.test(ch) && runs.length ? runs[runs.length - 1].thai : false;
    if (runs.length && runs[runs.length - 1].thai === thai) runs[runs.length - 1].text += ch;
    else runs.push({ thai, text: ch });
  }
  if (!runs.length) return;
  runs.forEach((run, i) => {
    doc.font(font(run.thai ? 'thai' : 'latin', w));
    const last = i === runs.length - 1;
    const o = i === 0 ? { ...opts, continued: !last } : { continued: !last, lineBreak: opts.lineBreak };
    if (i === 0 && opts.x !== undefined && opts.y !== undefined) doc.text(run.text, opts.x, opts.y, o);
    else doc.text(run.text, o);
  });
}

/** ใบแจ้งหนี้ / ใบเสร็จรับเงิน-ใบกำกับภาษี เป็น PDF (A4) · ข้อมูลผู้ขายมาจาก env (ตัวอย่างสมมติเมื่อไม่ได้ตั้ง) */
export function renderBill(d: BillDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${d.title} ${d.number}`, Author: d.seller.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = 48;
    const right = doc.page.width - 48;

    doc.fontSize(20).fillColor('#111');
    write(doc, d.title, 600, { x: left, y: 48 });
    doc.fontSize(10).fillColor('#555');
    write(doc, d.subtitle, 400);
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#111');
    write(doc, `เลขที่ / No. ${d.number}`, 600, { x: right - 220, y: 52, width: 220, align: 'right' });
    write(doc, `วันที่ / Date ${d.date}`, 400, { x: right - 220, y: 68, width: 220, align: 'right' });
    write(doc, `สถานะ / Status ${d.status}`, 400, { x: right - 220, y: 84, width: 220, align: 'right' });

    let y = 130;
    const block = (label: string, lines: string[], x: number) => {
      doc.fontSize(9).fillColor('#777');
      write(doc, label, 400, { x, y, width: 230 });
      doc.fontSize(10).fillColor('#111');
      write(doc, lines[0], 600, { x, y: y + 14, width: 230 });
      lines.slice(1).forEach((l) => write(doc, l, 400, { width: 230 }));
    };
    block('ผู้ขาย / Seller', [d.seller.name, `เลขประจำตัวผู้เสียภาษี ${d.seller.taxId}`, d.seller.address], left);
    block('ผู้ซื้อ / Buyer', [d.buyer.companyName, `เลขประจำตัวผู้เสียภาษี ${d.buyer.taxId} ${d.buyer.branch}`, d.buyer.address, d.buyer.email], left + 270);

    y = 280;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').stroke();
    doc.fontSize(9).fillColor('#777');
    write(doc, 'รายการ / Description', 600, { x: left, y: y + 8, width: 360 });
    write(doc, 'จำนวนเงิน (บาท) / Amount', 600, { x: right - 140, y: y + 8, width: 140, align: 'right' });
    y += 28;
    doc.fontSize(10).fillColor('#111');
    for (const l of d.lines) {
      write(doc, l.description, 400, { x: left, y, width: 360 });
      write(doc, baht(l.amount), 400, { x: right - 140, y, width: 140, align: 'right' });
      y += 20;
    }
    doc.moveTo(left, y + 4).lineTo(right, y + 4).strokeColor('#ccc').stroke();
    y += 16;
    const row = (label: string, value: string, strong = false) => {
      write(doc, label, strong ? 600 : 400, { x: right - 300, y, width: 150, align: 'right' });
      write(doc, value, strong ? 600 : 400, { x: right - 140, y, width: 140, align: 'right' });
      y += 18;
    };
    row('ยอดก่อนภาษี / Subtotal', baht(d.subtotal));
    row('ภาษีมูลค่าเพิ่ม 7% / VAT', baht(d.vat));
    row('รวม / Total', baht(d.total), true);
    if (d.whtAmount > 0) row('หัก ณ ที่จ่าย 3% / WHT', `-${baht(d.whtAmount)}`);
    row('ยอดชำระ / Amount due', baht(d.amountDue), true);

    y += 24;
    doc.fontSize(9).fillColor('#555');
    for (const f of d.footer) {
      write(doc, f, 400, { x: left, y, width: right - left });
      y += 14;
    }
    doc.end();
  });
}
