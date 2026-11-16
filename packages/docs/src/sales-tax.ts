// สรุปภาษีขายรายเดือน · สูตรเดียวที่ใช้ทั้งการ์ดในแท็บภาษี (Ops E1) รายงาน PDF / Excel และหน้ารายงานรายได้
// คิดจากเอกสารภาษีตามวันที่ของเอกสาร (ไม่ใช่ใบแจ้งหนี้ตามวันที่จ่าย) จึงตัวเลขตรงกันทุกที่
import type { SalesDocKind, SalesRow } from './report.ts';

/** สถานะ e-Tax ของแถวในรายงาน · not_required = ใบเสร็จ (ยังไม่จด VAT) หรือฉบับที่ยกเลิกก่อนส่ง */
export type ETaxState = 'done' | 'not_required' | 'pending' | 'waiting' | 'failed' | 'cancel_pending';
export const ETAX_STATE_LABEL: Record<ETaxState, string> = {
  done: 'ส่งแล้ว',
  not_required: 'ไม่ต้องส่ง',
  pending: 'รอส่ง',
  waiting: 'ส่งแล้ว รอผล',
  failed: 'ส่งไม่สำเร็จ',
  cancel_pending: 'ยกเลิก · รอแจ้งผู้ให้บริการ',
};

export interface SalesCheck {
  ok: boolean;
  /** warn = เตือนแต่ไม่บล็อกการปิดงวด */
  level?: 'ok' | 'bad' | 'warn';
  /** รหัสให้หน้าเว็บแปลข้อความเอง (ข้อความไทยใน `text` ใช้ใน PDF / Excel) */
  code?: 'numbers' | 'etax' | 'replacements' | 'wht' | 'outstanding' | 'zero_invoices';
  params?: Record<string, string | number>;
  text: string;
}

export interface NumberSeries {
  /** `TX-2611` */
  series: string;
  prefix: string;
  first: number;
  last: number;
  missing: number[];
}

const SERIES = /^([A-Z]+)-(\d{4})-(\d+)$/;
const pad = (n: number) => String(n).padStart(4, '0');

/**
 * ตรวจเลขขาดแยกตามชุดเลข (คำนำหน้า + ปีเดือนของเลข เช่น TX-2611) · ฉบับที่ออกแทนได้เลขของเดือนที่ออกจริงแต่ลงวันที่เดือนเดิม
 * จึงต้องตรวจทั้งชุด ไม่ใช่แค่เลขที่อยู่ในรายงานเดือนนั้น (`numbers` = ทุกเลขของชุดที่เกี่ยวข้อง ไม่ว่าลงวันที่เดือนไหน)
 * เลขที่ไม่ตรงรูปแบบ (เอกสารเก่า) ไม่นำมาตรวจ · ตรวจจากเลขแรกที่พบ (เอกสารเก่าเคยใช้เลขตามใบแจ้งหนี้)
 */
export function numberSeries(numbers: string[]): NumberSeries[] {
  const by = new Map<string, Set<number>>();
  for (const n of numbers) {
    const m = SERIES.exec(n);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    if (!by.has(key)) by.set(key, new Set());
    by.get(key)!.add(Number(m[3]));
  }
  return [...by.entries()]
    .map(([series, set]) => {
      const list = [...set].sort((a, b) => a - b);
      const missing: number[] = [];
      for (let n = list[0]; n <= list[list.length - 1]; n++) if (!set.has(n)) missing.push(n);
      return { series, prefix: series.split('-')[0], first: list[0], last: list[list.length - 1], missing };
    })
    .sort((a, b) => a.series.localeCompare(b.series));
}

const KIND_LABEL: Record<SalesDocKind, string> = { tax_invoice: 'ใบกำกับภาษี/ใบเสร็จ', receipt: 'ใบเสร็จรับเงิน', credit_note: 'ใบลดหนี้', debit_note: 'ใบเพิ่มหนี้' };
const ORDER: SalesDocKind[] = ['tax_invoice', 'receipt', 'debit_note', 'credit_note'];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface SalesTaxLine {
  kind: SalesDocKind;
  label: string;
  /** ฉบับที่มีผล (ไม่นับฉบับที่ยกเลิก · คู่ยกเลิก / ออกแทนนับครั้งเดียว) */
  count: number;
  cancelled: number;
  /** คู่ที่ยกเลิกแล้วออกฉบับใหม่แทน */
  replaced: number;
  first: string | null;
  last: string | null;
  value: number;
  vat: number;
}
export interface SalesTaxSummary {
  lines: SalesTaxLine[];
  net: { value: number; vat: number; total: number };
  etax: { total: number; done: number; failed: number; waiting: number; pending: number; cancelPending: number; numbers: string[] };
  /** ใบที่ลูกค้าหัก ณ ที่จ่ายแต่ยังไม่ได้รับ 50 ทวิ ที่ผ่าน */
  wht: { count: number; amount: number };
  outstanding: number;
}

/** ตัวเลขสรุป (ภ.พ.30 ใช้ยอดสุทธิ) · ใบลดหนี้ติดลบ ใบเพิ่มหนี้บวก ฉบับที่ยกเลิกเป็น 0 */
export function salesTaxSummary(rows: SalesRow[]): SalesTaxSummary {
  const lines = ORDER.map((kind) => {
    const list = rows.filter((r) => r.kind === kind).sort((a, b) => a.number.localeCompare(b.number));
    return {
      kind,
      label: KIND_LABEL[kind],
      count: list.filter((r) => !r.cancelled).length,
      cancelled: list.filter((r) => r.cancelled).length,
      replaced: list.filter((r) => r.cancelled && r.note?.includes('ออกใหม่')).length,
      first: list[0]?.number ?? null,
      last: list.at(-1)?.number ?? null,
      value: sum(list.map((r) => r.value)),
      vat: sum(list.map((r) => r.vat)),
    };
  }).filter((l) => l.count + l.cancelled > 0);
  const state = (r: SalesRow) => r.detail.etaxState ?? 'not_required';
  const needs = rows.filter((r) => state(r) !== 'not_required');
  const open = needs.filter((r) => state(r) !== 'done');
  const missingWht = rows.filter((r) => r.detail.flags.includes('wht'));
  return {
    lines,
    net: { value: sum(rows.map((r) => r.value)), vat: sum(rows.map((r) => r.vat)), total: sum(rows.map((r) => r.value + r.vat)) },
    etax: {
      total: needs.length,
      done: needs.length - open.length,
      failed: open.filter((r) => state(r) === 'failed').length,
      waiting: open.filter((r) => state(r) === 'waiting').length,
      pending: open.filter((r) => state(r) === 'pending').length,
      cancelPending: open.filter((r) => state(r) === 'cancel_pending').length,
      numbers: open.map((r) => r.number),
    },
    wht: { count: missingWht.length, amount: sum(missingWht.map((r) => r.detail.whtAmount ?? 0)) },
    outstanding: rows.filter((r) => r.detail.flags.includes('outstanding')).length,
  };
}

const PREFIX_ORDER = ['TX', 'RC', 'CN', 'DN'];

/**
 * รายการตรวจก่อนปิดงวด · e-Tax ไม่ครบ / เลขขาด = ต้องดู (ปิดได้แต่ต้องกรอกเหตุผล) · 50 ทวิ / ใบ ฿0 = เตือน ไม่บล็อก
 * `series` = ผลของ numberSeries จากทุกเลขในชุดที่เกี่ยวข้องกับเดือนนี้ · `zeroInvoices` = ใบแจ้งหนี้ ฿0 (คูปอง) ที่ชำระในเดือน
 */
export function salesTaxChecks(rows: SalesRow[], opts: { series: NumberSeries[]; zeroInvoices?: number }): SalesCheck[] {
  const s = salesTaxSummary(rows);
  const checks: SalesCheck[] = [];
  const baht = (n: number) => `฿${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  if (opts.series.length) {
    const rank = (p: string) => (PREFIX_ORDER.indexOf(p) + 1 || 99);
    const sorted = [...opts.series].sort((a, b) => rank(a.prefix) - rank(b.prefix) || a.series.localeCompare(b.series));
    // ชุดเดียวต่อคำนำหน้า (ปกติ) แสดงแค่ TX · ข้ามเดือน (ฉบับออกแทน) แสดง TX-2612 ให้แยกออก
    const label = (x: NumberSeries) => (opts.series.filter((y) => y.prefix === x.prefix).length > 1 ? x.series : x.prefix);
    const range = sorted.map((x) => `${label(x)} ${x.first === x.last ? pad(x.first) : `${pad(x.first)}–${pad(x.last)}`}`).join(' · ');
    const gaps = opts.series.filter((x) => x.missing.length).map((x) => `${x.series}-${x.missing.map(pad).join(', ')}`);
    checks.push(gaps.length
      ? { ok: false, level: 'bad', code: 'numbers', params: { missing: gaps.join(' · ') }, text: `เลขเอกสารขาด ${gaps.join(' · ')}` }
      : { ok: true, level: 'ok', code: 'numbers', params: { range }, text: `เลขเอกสารต่อเนื่อง · ${range}` });
  }
  if (s.etax.total) {
    const open = s.etax.total - s.etax.done;
    checks.push(open
      ? { ok: false, level: 'bad', code: 'etax', params: { n: open, numbers: s.etax.numbers.join(', ') }, text: `e-Tax ยังไม่ครบ ${open} ฉบับ (${s.etax.numbers.join(', ')})` }
      : { ok: true, level: 'ok', code: 'etax', params: { n: s.etax.total }, text: `ส่ง e-Tax ครบ ${s.etax.total} ฉบับ` });
  }
  const cancelled = rows.filter((r) => r.cancelled);
  if (cancelled.length) {
    const orphan = cancelled.filter((r) => !r.note?.includes('ออกใหม่'));
    checks.push(orphan.length
      ? { ok: false, level: 'bad', code: 'replacements', params: { n: orphan.length, numbers: orphan.map((r) => r.number).join(', ') }, text: `ใบที่ยกเลิกยังไม่มีฉบับแทน ${orphan.map((r) => r.number).join(', ')}` }
      : { ok: true, level: 'ok', code: 'replacements', params: { n: cancelled.length }, text: `ฉบับที่ยกเลิกมีฉบับออกแทนครบ (${cancelled.length})` });
  }
  if (s.wht.count) checks.push({ ok: false, level: 'warn', code: 'wht', params: { n: s.wht.count, amount: s.wht.amount }, text: `50 ทวิ ยังไม่ได้รับ ${s.wht.count} ใบ ${baht(s.wht.amount)} (ไม่บล็อกการปิดงวด)` });
  if (s.outstanding) checks.push({ ok: false, level: 'warn', code: 'outstanding', params: { n: s.outstanding }, text: `ใบเพิ่มหนี้ค้างรับ ${s.outstanding} ใบ` });
  if (opts.zeroInvoices) checks.push({ ok: false, level: 'warn', code: 'zero_invoices', params: { n: opts.zeroInvoices }, text: `ใบแจ้งหนี้ ฿0 จากคูปอง ${opts.zeroInvoices} ใบ ไม่ออกเอกสารภาษี จึงไม่อยู่ในรายงาน` });
  return checks;
}
