import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const FONT_DIR = join(dirname(require.resolve('@fontsource/ibm-plex-sans-thai/package.json')), 'files');
type Weight = 400 | 600;
const font = (subset: 'thai' | 'latin', w: Weight) => join(FONT_DIR, `ibm-plex-sans-thai-${subset}-${w}-normal.woff`);

export interface DocLine {
  description: string;
  amount: number;
}
export interface BillDoc {
  title: string;
  subtitle: string;
  number: string;
  /** YYYY-MM-DD */
  date: string;
  /** YYYY-MM-DD · แสดงเฉพาะใบแจ้งหนี้ที่ยังไม่ชำระ */
  dueDate?: string | null;
  seller: { name: string; taxId: string; branch: string; address: string };
  buyer: { companyName: string; taxId: string; branch: string; address: string; email: string };
  lines: DocLine[];
  subtotal: number;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
  status: string;
  /** หมายเหตุท้ายเอกสาร (ช่องทางชำระ, PO, หัก ณ ที่จ่าย) */
  notes: string[];
  /** ข้อความเล็กท้ายหน้า */
  footer: string[];
}

export const baht = (satang: number) => `${(satang / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** วันที่บนเอกสารภาษีใช้ พ.ศ. แบบที่ลูกค้าไทยคุ้น · `short` สำหรับช่วงรอบบิลในตาราง */
export function thaiDate(iso: string, short = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${(short ? SHORT_MONTHS : MONTHS)[m - 1]} ${y + 543}`;
}

const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
/** อ่านเลขไม่เกิน 6 หลัก · `higher` = มีหลักล้านนำหน้า (หลักหน่วยเป็น 1 ต้องอ่าน "เอ็ด") */
function readSix(n: number, higher: boolean) {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const digit = Number(s[i]);
    const place = s.length - 1 - i;
    if (digit === 0) continue;
    if (place === 1 && digit === 1) out += 'สิบ';
    else if (place === 1 && digit === 2) out += 'ยี่สิบ';
    else if (place === 0 && digit === 1 && (s.length > 1 || higher)) out += 'เอ็ด';
    else out += DIGITS[digit] + PLACES[place];
  }
  return out;
}
function readInt(n: number, higher = false): string {
  if (n >= 1_000_000) return readInt(Math.floor(n / 1_000_000), higher) + 'ล้าน' + readSix(n % 1_000_000, true);
  return readSix(n, higher);
}
/** จำนวนเงินเป็นตัวอักษร (ธรรมเนียมเอกสารการเงินไทย) เช่น 321000 สตางค์ → "สามพันสองร้อยสิบบาทถ้วน" */
export function bahtText(satang: number) {
  const value = Math.abs(Math.round(satang));
  const whole = Math.floor(value / 100);
  const cents = value % 100;
  if (!whole && !cents) return 'ศูนย์บาทถ้วน';
  return `${whole ? `${readInt(whole)}บาท` : ''}${cents ? `${readInt(cents)}สตางค์` : 'ถ้วน'}`;
}

// ---------------------------------------------------------------------------
// วาดข้อความผสมไทย / ละติน
// ฟอนต์ IBM Plex Sans Thai แยกไฟล์ไทยกับละติน จึงต้องวาดทีละช่วง · เดิมใช้ continued + align ของ pdfkit
// ซึ่งจัดชิดขวาแยกทีละช่วงแล้วเขียนทับกัน (ผู้ใช้ทัก 2026-11-12) จึงวัดความกว้างทั้งบรรทัดเองแล้ววางทีละช่วง
// ---------------------------------------------------------------------------
const isThai = (ch: string) => /[฀-๿]/.test(ch);
type Run = { thai: boolean; text: string };
function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    // ช่องว่างติดกับช่วงเดิม เพื่อไม่ให้สลับฟอนต์บ่อย
    const thai = isThai(ch) ? true : /\s/.test(ch) && runs.length ? runs[runs.length - 1].thai : false;
    if (runs.length && runs[runs.length - 1].thai === thai) runs[runs.length - 1].text += ch;
    else runs.push({ thai, text: ch });
  }
  return runs;
}

interface Style { size: number; weight?: Weight; color?: string }
interface Box extends Style { x: number; y: number; width: number; align?: 'left' | 'right' | 'center' }

function measure(doc: PDFKit.PDFDocument, text: string, st: Style) {
  doc.fontSize(st.size);
  return runsOf(text).reduce((sum, run) => sum + doc.font(font(run.thai ? 'thai' : 'latin', st.weight ?? 400)).widthOfString(run.text), 0);
}
const lineHeight = (size: number) => size * 1.55;

/** ตัดบรรทัดตามคำ (ช่องว่าง) · คำที่ยาวเกินกว้างตัดทีละตัวอักษร */
function wrap(doc: PDFKit.PDFDocument, text: string, width: number, st: Style) {
  const lines: string[] = [];
  let line = '';
  for (const token of text.split(/(?<=\s)/)) {
    if (measure(doc, line + token, st) <= width) { line += token; continue; }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    if (measure(doc, token, st) <= width) { line = token; continue; }
    for (const ch of token) {
      if (measure(doc, line + ch, st) > width && line) { lines.push(line); line = ''; }
      line += ch;
    }
  }
  if (line.trim() || !lines.length) lines.push(line.trimEnd());
  return lines;
}

/** วาดข้อความในกล่อง (ตัดบรรทัดได้) · คืนความสูงที่ใช้ */
function text(doc: PDFKit.PDFDocument, value: string, box: Box) {
  const lines = value.split('\n').flatMap((part) => wrap(doc, part, box.width, box));
  doc.fillColor(box.color ?? INK);
  lines.forEach((line, i) => {
    const w = measure(doc, line, box);
    let x = box.align === 'right' ? box.x + box.width - w : box.align === 'center' ? box.x + (box.width - w) / 2 : box.x;
    const y = box.y + i * lineHeight(box.size);
    for (const run of runsOf(line)) {
      doc.font(font(run.thai ? 'thai' : 'latin', box.weight ?? 400)).fontSize(box.size);
      doc.text(run.text, x, y, { lineBreak: false });
      x += doc.widthOfString(run.text);
    }
  });
  return lines.length * lineHeight(box.size);
}

// สีของเอกสาร PDF (ไม่ได้อยู่ในหน้าเว็บ จึงไม่ใช้ token ของ CSS)
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const SHADE = '#f3f4f6';
const ACCENT = '#1f2937';

/** ใบแจ้งหนี้ / ใบเสร็จรับเงิน-ใบกำกับภาษี เป็น PDF (A4) · ข้อมูลผู้ขายมาจาก env (ตัวอย่างสมมติเมื่อไม่ได้ตั้ง) */
export function renderBill(d: BillDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, left: 48, right: 48, bottom: 0 }, info: { Title: `${d.title} ${d.number}`, Author: d.seller.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = 48;
    // ขอบล่าง 0: ให้วางข้อความท้ายหน้าเองได้โดย pdfkit ไม่ขึ้นหน้าใหม่
    const right = doc.page.width - 48;
    const full = right - left;

    // หัวกระดาษ: ผู้ขาย (ซ้าย) · ชื่อเอกสาร (ขวา)
    let y = 44;
    const sellerW = 290;
    let sy = y + text(doc, d.seller.name, { x: left, y, width: sellerW, size: 13, weight: 600 });
    sy += text(doc, d.seller.address, { x: left, y: sy + 2, width: sellerW, size: 8.5, color: MUTED });
    sy += text(doc, `เลขประจำตัวผู้เสียภาษี ${d.seller.taxId} · ${d.seller.branch}`, { x: left, y: sy + 2, width: sellerW, size: 8.5, color: MUTED });
    let ty = y + text(doc, d.title, { x: right - 220, y, width: 220, size: 17, weight: 600, align: 'right' });
    ty += text(doc, d.subtitle, { x: right - 220, y: ty, width: 220, size: 9.5, color: MUTED, align: 'right' });
    y = Math.max(sy, ty) + 12;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(ACCENT).stroke();
    y += 16;

    // ลูกค้า (ซ้าย) · ข้อมูลเอกสาร (ขวา)
    const metaW = 200;
    const buyerW = full - metaW - 16;
    const top = y;
    let by = y + 10;
    by += text(doc, 'ลูกค้า / Customer', { x: left + 12, y: by, width: buyerW - 24, size: 8.5, color: MUTED });
    by += text(doc, d.buyer.companyName, { x: left + 12, y: by + 2, width: buyerW - 24, size: 11, weight: 600 }) + 2;
    by += text(doc, d.buyer.address, { x: left + 12, y: by, width: buyerW - 24, size: 9 });
    by += text(doc, `เลขประจำตัวผู้เสียภาษี ${d.buyer.taxId}${d.buyer.branch ? ` · ${d.buyer.branch}` : ''}`, { x: left + 12, y: by, width: buyerW - 24, size: 9 });
    if (d.buyer.email) by += text(doc, `อีเมล ${d.buyer.email}`, { x: left + 12, y: by, width: buyerW - 24, size: 9 });

    const meta: [string, string][] = [['เลขที่ / No.', d.number], ['วันที่ / Date', thaiDate(d.date)], ...(d.dueDate ? [['ครบกำหนด / Due', thaiDate(d.dueDate)] as [string, string]] : []), ['สถานะ / Status', d.status]];
    const mx = right - metaW;
    let my = y + 10;
    for (const [label, value] of meta) {
      const h = Math.max(text(doc, label, { x: mx + 10, y: my, width: 82, size: 8.5, color: MUTED }), text(doc, value, { x: mx + 92, y: my, width: metaW - 102, size: 9, weight: 600, align: 'right' }));
      my += h + 3;
    }
    const boxH = Math.max(by, my) + 8 - top;
    doc.lineWidth(0.75).strokeColor(RULE);
    doc.roundedRect(left, top, buyerW, boxH, 4).stroke();
    doc.roundedRect(mx, top, metaW, boxH, 4).stroke();
    y = top + boxH + 20;

    // ตารางรายการ
    const noW = 36;
    const amtW = 130;
    const descW = full - noW - amtW;
    const head = (h: number) => {
      doc.rect(left, y, full, h).fill(SHADE);
      text(doc, 'ลำดับ', { x: left, y: y + 6, width: noW, size: 8.5, weight: 600, align: 'center' });
      text(doc, 'รายการ / Description', { x: left + noW + 8, y: y + 6, width: descW - 16, size: 8.5, weight: 600 });
      text(doc, 'จำนวนเงิน (บาท) / Amount', { x: right - amtW, y: y + 6, width: amtW - 10, size: 8.5, weight: 600, align: 'right' });
    };
    head(24);
    y += 24;
    d.lines.forEach((l, i) => {
      const h = Math.max(text(doc, l.description, { x: left + noW + 8, y: y + 8, width: descW - 16, size: 9.5 }), lineHeight(9.5)) + 14;
      text(doc, String(i + 1), { x: left, y: y + 8, width: noW, size: 9.5, align: 'center' });
      text(doc, l.amount < 0 ? `-${baht(-l.amount)}` : baht(l.amount), { x: right - amtW, y: y + 8, width: amtW - 10, size: 9.5, align: 'right' });
      y += h;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
    });
    y += 12;

    // สรุปยอด (ขวา) · จำนวนเงินตัวอักษร (ซ้าย)
    const sumX = right - 250;
    const sumTop = y;
    const row = (label: string, value: string, strong = false) => {
      if (strong) doc.rect(sumX, y - 4, 250, lineHeight(10) + 8).fill(SHADE);
      text(doc, label, { x: sumX + 10, y, width: 130, size: strong ? 10 : 9, weight: strong ? 600 : 400, color: strong ? INK : MUTED });
      text(doc, value, { x: right - amtW, y, width: amtW - 10, size: strong ? 10 : 9.5, weight: strong ? 600 : 400, align: 'right' });
      y += lineHeight(10) + (strong ? 8 : 2);
    };
    row('รวมเป็นเงิน / Subtotal', baht(d.subtotal));
    row('ภาษีมูลค่าเพิ่ม 7% / VAT', baht(d.vat));
    row('จำนวนเงินรวมทั้งสิ้น / Total', baht(d.total), true);
    if (d.whtAmount > 0) {
      row('หัก ณ ที่จ่าย 3% / WHT', `-${baht(d.whtAmount)}`);
      row('ยอดชำระ / Amount due', baht(d.amountDue), true);
    }
    const wordsY = sumTop;
    // ตัวอักษรของ "จำนวนเงินรวมทั้งสิ้น" ตามธรรมเนียมใบกำกับภาษี (ไม่หักภาษี ณ ที่จ่าย)
    text(doc, 'จำนวนเงินตัวอักษร', { x: left, y: wordsY, width: sumX - left - 24, size: 8.5, color: MUTED });
    text(doc, `(${bahtText(d.total)})`, { x: left, y: wordsY + lineHeight(8.5), width: sumX - left - 24, size: 10, weight: 600 });
    y += 16;

    // หมายเหตุ
    if (d.notes.length) {
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
      y += 10;
      y += text(doc, 'หมายเหตุ / Notes', { x: left, y, width: full, size: 8.5, weight: 600 });
      for (const n of d.notes) y += text(doc, `• ${n}`, { x: left, y, width: full, size: 8.5, color: MUTED });
    }

    // ท้ายหน้า
    let fy = doc.page.height - 48 - d.footer.length * lineHeight(8);
    doc.moveTo(left, fy - 8).lineTo(right, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
    for (const f of d.footer) fy += text(doc, f, { x: left, y: fy, width: full, size: 8, color: MUTED, align: 'center' });
    doc.end();
  });
}
