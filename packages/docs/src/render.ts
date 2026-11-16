// แม่แบบเอกสารการเงินชุดเดียว (design/proposals/billing/03-billing-documents.html) · ทุกใบวาดส่วนประกอบเดียวกันตามลำดับ:
// หัวกระดาษ → แถบเหตุผล → กล่องลูกค้า/ข้อมูลเอกสาร → ตาราง → สรุปยอด → แถบข้อมูล → หมายเหตุ → ลงนาม → ท้ายหน้า
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import PDFDocument from 'pdfkit';
import { baht, bahtText } from './format.ts';

const require = createRequire(import.meta.url);
const FONT_DIR = join(dirname(require.resolve('@fontsource/ibm-plex-sans-thai/package.json')), 'files');
type Weight = 400 | 600 | 700;
const font = (subset: 'thai' | 'latin', w: Weight) => join(FONT_DIR, `ibm-plex-sans-thai-${subset}-${w}-normal.woff`);

// สีของกระดาษ (ไม่ใช่หน้าเว็บ จึงไม่ใช้ token ของ CSS) · ตรงกับ mockup
export const C = { ink: '#1d2025', ink2: '#4a5058', ink3: '#7a8088', rule: '#d9dde2', tint: '#f4f2fb', brand: '#5b3fc4', paid: '#157a46', warnBg: '#fdf3dc', warnInk: '#8a5a00', logo: ['#f59e0b', '#ef4444', '#22c55e', '#3b82f6'] };

export interface Seller { name: string; taxId: string; address: string; branch: string; phone?: string; email?: string; sample?: boolean }
export interface Party { name: string; branch: string; address: string; taxId: string; extra?: string[] }
export interface SaleLine { description: string; sub?: string; qty: number; unit: string; unitPrice: number; amount: number }
export interface AdjustLine { description: string; sub?: string; original: number; correct: number; difference: number }
export interface TotalRow { label: string; value: number | string; style?: 'grand' | 'muted' | 'net' }
export interface Sign { line?: string; role: string; sub: string }
export interface FinanceDoc {
  title: string;
  titleEn: string;
  /** ป้ายใต้ชื่อเอกสาร: ต้นฉบับ / สำเนา / ใบแทน / ยืนราคาถึง … */
  badge: string;
  badgeSub?: string;
  number: string;
  seller: Seller;
  partyLabel: string;
  party: Party;
  meta: [string, string][];
  remark?: { label: string; text: string };
  table: { kind: 'sale'; lines: SaleLine[] } | { kind: 'adjust'; lines: AdjustLine[] };
  totals: TotalRow[];
  /** สตางค์ของ "จำนวนเงินตัวอักษร" */
  words: number;
  band?: { title: string; cells: [string, string][]; note?: string };
  notes: string[];
  stamp?: { text: string; sub: string };
  sign: [Sign, Sign];
}

// ---------------------------------------------------------------------------
// ข้อความผสมไทย / ละติน: ฟอนต์แยกไฟล์ จึงวัดความกว้างทั้งบรรทัดเองแล้ววางทีละช่วง (เดิม continued + align ทับกัน · ทัก 2026-11-12)
// ---------------------------------------------------------------------------
const isThai = (ch: string) => /[฀-๿]/.test(ch);
type Run = { thai: boolean; text: string };
function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const thai = isThai(ch) ? true : /\s/.test(ch) && runs.length ? runs[runs.length - 1].thai : false;
    if (runs.length && runs[runs.length - 1].thai === thai) runs[runs.length - 1].text += ch;
    else runs.push({ thai, text: ch });
  }
  return runs;
}
export interface Style { size: number; weight?: Weight; color?: string; spacing?: number }
export interface Box extends Style { x: number; y: number; width: number; align?: 'left' | 'right' | 'center' }

export function measure(doc: PDFKit.PDFDocument, text: string, st: Style) {
  doc.fontSize(st.size);
  const chars = st.spacing ? [...text].length * st.spacing : 0;
  return runsOf(text).reduce((sum, run) => sum + doc.font(font(run.thai ? 'thai' : 'latin', st.weight ?? 400)).widthOfString(run.text), 0) + chars;
}
export const lh = (size: number) => size * 1.5;

function wrap(doc: PDFKit.PDFDocument, text: string, width: number, st: Style) {
  const lines: string[] = [];
  let line = '';
  for (const token of text.split(/(?<=\s)/)) {
    if (measure(doc, line + token, st) <= width) {
      line += token;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    if (measure(doc, token, st) <= width) {
      line = token;
      continue;
    }
    for (const ch of token) {
      if (measure(doc, line + ch, st) > width && line) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  if (line.trim() || !lines.length) lines.push(line.trimEnd());
  return lines;
}
/** ความสูงที่ข้อความจะใช้ (ไม่วาด) */
export function heightOf(doc: PDFKit.PDFDocument, value: string, box: Omit<Box, 'x' | 'y'>) {
  return value.split('\n').flatMap((part) => wrap(doc, part, box.width, box)).length * lh(box.size);
}
/** วาดข้อความในกล่อง (ตัดบรรทัดได้) · คืนความสูงที่ใช้ */
export function text(doc: PDFKit.PDFDocument, value: string, box: Box) {
  const lines = value.split('\n').flatMap((part) => wrap(doc, part, box.width, box));
  doc.fillColor(box.color ?? C.ink);
  lines.forEach((line, i) => {
    const w = measure(doc, line, box);
    let x = box.align === 'right' ? box.x + box.width - w : box.align === 'center' ? box.x + (box.width - w) / 2 : box.x;
    const y = box.y + i * lh(box.size);
    for (const run of runsOf(line)) {
      doc.font(font(run.thai ? 'thai' : 'latin', box.weight ?? 400)).fontSize(box.size);
      doc.text(run.text, x, y, { lineBreak: false, characterSpacing: box.spacing ?? 0 });
      x += doc.widthOfString(run.text) + (box.spacing ? [...run.text].length * box.spacing : 0);
    }
  });
  return lines.length * lh(box.size);
}

/** สร้าง PDF แล้วคืน Buffer · `draw` วาดเนื้อหา · หน้ากระดาษ A4 */
export function pdf(info: { title: string; author: string }, layout: 'portrait' | 'landscape', draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout, margins: { top: 0, left: 0, right: 0, bottom: 0 }, bufferPages: true, info: { Title: info.title, Author: info.author } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** ท้ายหน้าทุกหน้า: ข้อความติดต่อ (ซ้าย) · เลขเอกสาร + หน้า x/y (ขวา) */
export function footers(doc: PDFKit.PDFDocument, left: string, right: string, margin: number) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - margin + 8;
    doc.moveTo(margin, y - 8).lineTo(doc.page.width - margin, y - 8).lineWidth(0.5).strokeColor(C.rule).stroke();
    text(doc, left, { x: margin, y, width: doc.page.width - margin * 2 - 150, size: 7, color: C.ink3 });
    text(doc, `${right} · หน้า ${i - range.start + 1}/${range.count}`, { x: doc.page.width - margin - 150, y, width: 150, size: 7, color: C.ink3, align: 'right' });
  }
}

const M = 40; // ขอบกระดาษ
const BOTTOM = 40; // พื้นที่ท้ายหน้า

/** วาดเอกสาร 1 ใบตามแม่แบบมาตรฐาน */
export function renderDoc(d: FinanceDoc): Promise<Buffer> {
  return pdf({ title: `${d.title} ${d.number}`, author: d.seller.name }, 'portrait', (doc) => {
    const L = M;
    const R = doc.page.width - M;
    const W = R - L;
    const limit = () => doc.page.height - BOTTOM - 16;
    let y = 36;
    const ensure = (h: number, onBreak?: () => void) => {
      if (y + h <= limit()) return;
      doc.addPage();
      y = 36;
      onBreak?.();
    };

    // 1. หัวกระดาษ: โลโก้ + ผู้ขาย (ซ้าย) · ชื่อเอกสาร + ป้าย (ขวา)
    C.logo.forEach((color, i) => doc.roundedRect(L + (i % 2) * 11, y + 4 + Math.floor(i / 2) * 11, 9, 9, 2).fill(color));
    const sx = L + 30;
    const sw = W - 30 - 210;
    let sy = y;
    sy += text(doc, 'Friday Work Management', { x: sx, y: sy, width: sw, size: 8, weight: 700, color: C.brand });
    sy += text(doc, `${d.seller.name} (${d.seller.branch})`, { x: sx, y: sy, width: sw, size: 10.5, weight: 700 });
    sy += text(doc, d.seller.address, { x: sx, y: sy, width: sw, size: 8, color: C.ink2 });
    sy += text(doc, `เลขประจำตัวผู้เสียภาษี ${d.seller.taxId}`, { x: sx, y: sy, width: sw, size: 8, color: C.ink2 });
    const contact = [d.seller.phone && `โทร ${d.seller.phone}`, d.seller.email].filter(Boolean).join(' · ');
    if (contact) sy += text(doc, contact, { x: sx, y: sy, width: sw, size: 8, color: C.ink2 });
    let ty = y;
    ty += text(doc, d.title, { x: R - 260, y: ty, width: 260, size: 17, weight: 700, align: 'right' });
    ty += text(doc, d.titleEn, { x: R - 260, y: ty, width: 260, size: 7.5, weight: 600, color: C.ink3, align: 'right', spacing: 1.2 }) + 3;
    const bw = measure(doc, d.badge, { size: 7.5, weight: 700 }) + 14;
    doc.roundedRect(R - bw, ty, bw, 13, 3).lineWidth(1).strokeColor(C.ink).stroke();
    text(doc, d.badge, { x: R - bw, y: ty + 1.5, width: bw, size: 7.5, weight: 700, align: 'center' });
    ty += 16;
    if (d.badgeSub) ty += text(doc, d.badgeSub, { x: R - 260, y: ty, width: 260, size: 7, color: C.ink3, align: 'right' });
    y = Math.max(sy, ty) + 8;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1.5).strokeColor(C.ink).stroke();
    y += 12;

    // 2. แถบเหตุผล (ใบที่แก้เอกสารเดิม)
    if (d.remark) {
      const h = heightOf(doc, d.remark.text, { width: W - 24, size: 9, weight: 600 }) + lh(7.5) + 12;
      doc.rect(L, y, W, h).fill(C.tint);
      doc.rect(L, y, 2.5, h).fill(C.ink);
      let ry = y + 6;
      ry += text(doc, d.remark.label, { x: L + 12, y: ry, width: W - 24, size: 7.5, color: C.ink3 });
      text(doc, d.remark.text, { x: L + 12, y: ry, width: W - 24, size: 9, weight: 600 });
      y += h + 10;
    }

    // 3. กล่องคู่: ลูกค้า (ซ้าย) · ข้อมูลเอกสาร (ขวา)
    const metaW = 200;
    const partyW = W - metaW - 10;
    const top = y;
    let py = y + 8;
    const px = L + 10;
    const pw = partyW - 20;
    py += text(doc, d.partyLabel, { x: px, y: py, width: pw, size: 7.5, color: C.ink3 });
    py += text(doc, d.party.name, { x: px, y: py, width: pw, size: 10, weight: 700 });
    py += text(doc, `${d.party.branch} · ${d.party.address}`, { x: px, y: py, width: pw, size: 8.5 });
    if (d.party.taxId) py += text(doc, `เลขประจำตัวผู้เสียภาษี ${d.party.taxId}`, { x: px, y: py, width: pw, size: 8.5 });
    for (const e of d.party.extra ?? []) py += text(doc, e, { x: px, y: py, width: pw, size: 8.5 });
    const mx = R - metaW;
    let my = y + 8;
    for (const [label, value] of d.meta) {
      const h = Math.max(text(doc, label, { x: mx + 10, y: my, width: 90, size: 8, color: C.ink3 }), text(doc, value, { x: mx + 100, y: my, width: metaW - 110, size: 8.5, weight: 700, align: 'right' }));
      my += h + 2;
    }
    const boxH = Math.max(py, my) + 6 - top;
    doc.lineWidth(0.75).strokeColor(C.rule);
    doc.roundedRect(L, top, partyW, boxH, 4).stroke();
    doc.roundedRect(mx, top, metaW, boxH, 4).stroke();
    y = top + boxH + 12;

    // 4. ตาราง: แบบขาย (จำนวน หน่วย ราคาต่อหน่วย) · แบบปรับยอด (มูลค่าเดิม / ที่ถูกต้อง / ผลต่าง)
    type Col = { th: string; en: string; w: number; align: 'left' | 'right' | 'center' };
    const cols: Col[] = d.table.kind === 'sale'
      ? [{ th: 'ลำดับ', en: 'No.', w: 30, align: 'center' }, { th: 'รายการ', en: 'Description', w: 0, align: 'left' }, { th: 'จำนวน', en: 'Qty', w: 40, align: 'right' }, { th: 'หน่วย', en: 'Unit', w: 44, align: 'center' }, { th: 'ราคาต่อหน่วย', en: 'Unit price', w: 74, align: 'right' }, { th: 'จำนวนเงิน', en: 'Amount', w: 74, align: 'right' }]
      : [{ th: 'ลำดับ', en: 'No.', w: 30, align: 'center' }, { th: 'รายการ', en: 'Description', w: 0, align: 'left' }, { th: 'มูลค่าเดิม', en: 'Original', w: 78, align: 'right' }, { th: 'มูลค่าที่ถูกต้อง', en: 'Correct', w: 82, align: 'right' }, { th: 'ผลต่าง', en: 'Difference', w: 74, align: 'right' }];
    cols[1].w = W - cols.reduce((s, c) => s + c.w, 0);
    const xs = cols.reduce<number[]>((acc, c, i) => [...acc, i ? acc[i - 1] + cols[i - 1].w : L], []);
    const head = () => {
      doc.rect(L, y, W, 26).fill(C.tint);
      doc.moveTo(L, y + 26).lineTo(R, y + 26).lineWidth(0.5).strokeColor(C.rule).stroke();
      cols.forEach((c, i) => {
        text(doc, c.th, { x: xs[i] + 5, y: y + 4, width: c.w - 10, size: 7.5, weight: 700, align: c.align });
        text(doc, c.en, { x: xs[i] + 5, y: y + 14, width: c.w - 10, size: 6.5, color: C.ink3, align: c.align });
      });
      y += 26;
    };
    head();
    const rows: string[][] = d.table.kind === 'sale'
      ? d.table.lines.map((l, i) => [String(i + 1), '', String(l.qty), l.unit, baht(l.unitPrice), baht(l.amount)])
      : d.table.lines.map((l, i) => [String(i + 1), '', baht(l.original), baht(l.correct), baht(l.difference)]);
    d.table.lines.forEach((line, r) => {
      const dw = cols[1].w - 10;
      const h = Math.max(heightOf(doc, line.description, { width: dw, size: 8.5, weight: 700 }) + (line.sub ? heightOf(doc, line.sub, { width: dw, size: 7.5 }) : 0), lh(8.5)) + 12;
      ensure(h, head);
      let dy = y + 6;
      dy += text(doc, line.description, { x: xs[1] + 5, y: dy, width: dw, size: 8.5, weight: 700 });
      if (line.sub) text(doc, line.sub, { x: xs[1] + 5, y: dy, width: dw, size: 7.5, color: C.ink2 });
      rows[r].forEach((v, i) => {
        if (i === 1) return;
        text(doc, v, { x: xs[i] + 5, y: y + 6, width: cols[i].w - 10, size: 8.5, align: cols[i].align, color: v.startsWith('-') ? C.ink2 : C.ink });
      });
      y += h;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(C.rule).stroke();
    });
    y += 12;

    // 5. สรุปยอด (ขวา) + จำนวนเงินตัวอักษร (ซ้าย)
    const sumW = 230;
    const sumX = R - sumW;
    const totalsH = d.totals.reduce((s, t) => s + (t.style === 'grand' ? 22 : 17), 0) + 6;
    ensure(totalsH);
    const wordsW = sumX - L - 14;
    const wordsH = heightOf(doc, `(${bahtText(d.words)})`, { width: wordsW - 20, size: 9, weight: 700 }) + lh(7.5) + 14;
    doc.roundedRect(L, y, wordsW, wordsH, 4).fill(C.tint);
    text(doc, 'จำนวนเงินตัวอักษร / Amount in words', { x: L + 10, y: y + 7, width: wordsW - 20, size: 7.5, color: C.ink3 });
    text(doc, `(${bahtText(d.words)})`, { x: L + 10, y: y + 7 + lh(7.5), width: wordsW - 20, size: 9, weight: 700 });
    let ty2 = y;
    for (const t of d.totals) {
      const value = typeof t.value === 'number' ? baht(t.value) : t.value;
      if (t.style === 'grand') {
        doc.roundedRect(sumX, ty2 + 2, sumW, 20, 3).fill(C.ink);
        text(doc, t.label, { x: sumX + 8, y: ty2 + 6, width: sumW - 90, size: 9.5, weight: 700, color: '#ffffff' });
        text(doc, value, { x: sumX + sumW - 90, y: ty2 + 6, width: 82, size: 9.5, weight: 700, color: '#ffffff', align: 'right' });
        ty2 += 24;
        continue;
      }
      if (t.style === 'net') doc.moveTo(sumX, ty2 + 1).lineTo(R, ty2 + 1).lineWidth(1.2).strokeColor(C.ink).stroke();
      const strong = t.style === 'net';
      text(doc, t.label, { x: sumX + 8, y: ty2 + 3, width: sumW - 96, size: strong ? 9.5 : 8.5, weight: strong ? 700 : 400, color: t.style === 'muted' ? C.ink2 : C.ink });
      text(doc, value, { x: sumX + sumW - 90, y: ty2 + 3, width: 82, size: strong ? 9.5 : 8.5, weight: strong ? 700 : 400, color: t.style === 'muted' ? C.ink2 : C.ink, align: 'right' });
      ty2 += 17;
    }
    y = Math.max(y + wordsH, ty2) + 12;

    // 6. แถบข้อมูล 4 ช่อง (สิ่งที่ได้ / วิธีชำระ / การรับเงิน / การคืนเงิน)
    if (d.band) {
      const cw = (W - 24) / 4;
      const cellH = Math.max(...d.band.cells.map(([k, v]) => heightOf(doc, k, { width: cw - 8, size: 7.5 }) + heightOf(doc, v, { width: cw - 8, size: 9, weight: 700 })));
      const noteH = d.band.note ? heightOf(doc, d.band.note, { width: W - 24, size: 7.5 }) + 8 : 0;
      const h = lh(8.5) + 6 + cellH + noteH + 14;
      ensure(h);
      doc.roundedRect(L, y, W, h, 4).lineWidth(0.75).strokeColor(C.rule).stroke();
      let by = y + 7;
      by += text(doc, d.band.title, { x: L + 12, y: by, width: W - 24, size: 8.5, weight: 700 }) + 4;
      d.band.cells.forEach(([k, v], i) => {
        const cx = L + 12 + i * cw;
        const kh = text(doc, k, { x: cx, y: by, width: cw - 8, size: 7.5, color: C.ink3 });
        text(doc, v, { x: cx, y: by + kh, width: cw - 8, size: 9, weight: 700 });
      });
      if (d.band.note) {
        const ny = by + cellH + 4;
        doc.moveTo(L + 12, ny).lineTo(R - 12, ny).dash(2, { space: 2 }).lineWidth(0.5).strokeColor(C.rule).stroke().undash();
        text(doc, d.band.note, { x: L + 12, y: ny + 4, width: W - 24, size: 7.5, color: C.ink2 });
      }
      y += h + 12;
    }

    // 7. หมายเหตุ (+ ตราชำระแล้ว)
    if (d.notes.length) {
      const noteW = d.stamp ? W - 150 : W;
      const h = lh(8.5) + d.notes.reduce((s, n) => s + heightOf(doc, `• ${n}`, { width: noteW, size: 8 }), 0);
      ensure(Math.max(h, d.stamp ? 50 : 0));
      const top7 = y;
      y += text(doc, 'หมายเหตุ / Notes', { x: L, y, width: noteW, size: 8.5, weight: 700 });
      for (const n of d.notes) y += text(doc, `• ${n}`, { x: L, y, width: noteW, size: 8, color: C.ink2 });
      if (d.stamp) {
        doc.save().rotate(-12, { origin: [R - 70, top7 + 22] });
        doc.roundedRect(R - 128, top7 + 4, 116, 38, 6).lineWidth(2).strokeColor(C.paid).stroke();
        text(doc, d.stamp.text, { x: R - 128, y: top7 + 7, width: 116, size: 14, weight: 700, color: C.paid, align: 'center' });
        text(doc, d.stamp.sub, { x: R - 128, y: top7 + 27, width: 116, size: 7, weight: 700, color: C.paid, align: 'center' });
        doc.restore();
        y = Math.max(y, top7 + 50);
      }
      y += 8;
    }

    // 8. ลงนาม: ชิดล่างของหน้าสุดท้าย (เหมือน margin-top: auto ใน mockup)
    const signH = 52;
    ensure(signH);
    const sy2 = Math.max(y + 8, limit() - signH);
    const half = (W - 30) / 2;
    d.sign.forEach((s, i) => {
      const x = L + i * (half + 30);
      if (s.line) text(doc, s.line, { x, y: sy2 + 4, width: half, size: 8.5, weight: 700, color: C.brand, align: 'center' });
      doc.moveTo(x, sy2 + 20).lineTo(x + half, sy2 + 20).dash(1, { space: 2 }).lineWidth(0.6).strokeColor(C.ink3).stroke().undash();
      text(doc, s.role, { x, y: sy2 + 24, width: half, size: 8, color: C.ink2, align: 'center' });
      text(doc, s.sub, { x, y: sy2 + 24 + lh(8), width: half, size: 8, color: C.ink2, align: 'center' });
    });

    // 9. ท้ายหน้า (ทุกหน้า)
    const sample = d.seller.sample ? ' · ข้อมูลผู้ขายเป็นตัวอย่าง (ยังไม่ได้ตั้งค่า SELLER_NAME)' : '';
    footers(doc, `เอกสารนี้ออกโดยระบบคอมพิวเตอร์${d.seller.email ? ` · สอบถาม ${d.seller.email}` : ''}${d.seller.phone ? ` · ${d.seller.phone}` : ''}${sample}`, d.number, BOTTOM);
  });
}
