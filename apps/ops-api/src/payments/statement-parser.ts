import ExcelJS from 'exceljs';
import { AppError } from '../errors.js';

/**
 * อ่านไฟล์ statement จากระบบธนาคารออนไลน์ (O03 เฟส 2 · บัญชีรับเงินของบริษัทอยู่กสิกรไทย)
 * ไม่ผูกกับลำดับคอลัมน์: หาแถวหัวตารางจากชื่อคอลัมน์ไทย / อังกฤษ เพราะแต่ละช่องทาง (K-BIZ, K PLUS, เว็บ) ส่งออกต่างกันเล็กน้อย
 * รับ CSV (UTF-8 หรือ Windows-874 ที่ธนาคารไทยใช้บ่อย) และ Excel (.xlsx)
 */

export interface StatementRow {
  /** เวลาทำรายการ (เวลาไทย) */
  txnAt: Date;
  /** เงินเข้า · สตางค์ (0 = ไม่ใช่เงินเข้า) */
  deposit: number;
  /** เงินออก · สตางค์ */
  withdrawal: number;
  balance: number | null;
  description: string;
  channel: string | null;
}

export interface ParsedStatement {
  rows: StatementRow[];
  /** แถวในตารางที่อ่านวันที่หรือยอดไม่ได้ (เช่น แถวรวมท้ายไฟล์) */
  skipped: number;
  periodFrom: string | null;
  periodTo: string | null;
}

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

/** ชื่อคอลัมน์ที่รู้จัก (ตัดช่องว่าง · ตัวเล็ก) · ตัวแรกที่ตรงชนะ */
const COLUMNS = {
  date: ['วันที่ทำรายการ', 'วันที่', 'transactiondate', 'date', 'วันเวลา', 'datetime'],
  time: ['เวลา', 'time'],
  deposit: ['ฝากเงิน', 'เงินฝาก', 'ฝาก', 'เงินเข้า', 'deposit', 'deposits', 'credit', 'cr'],
  withdrawal: ['ถอนเงิน', 'เงินถอน', 'ถอน', 'เงินออก', 'withdrawal', 'withdrawals', 'debit', 'dr'],
  amount: ['จำนวนเงิน', 'amount'],
  balance: ['ยอดคงเหลือ', 'คงเหลือ', 'outstandingbalance', 'balance', 'ledgerbalance'],
  description: ['รายละเอียด', 'บันทึกช่วยจำ', 'details', 'description', 'memo', 'รายการ', 'transaction'],
  channel: ['ช่องทาง', 'channel'],
} as const;
type Key = keyof typeof COLUMNS;

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, '').toLowerCase();

/** คอลัมน์ของแต่ละความหมาย · หัวตาราง = แถวแรกใน 30 แถวที่มีวันที่และยอด */
function findHeader(rows: unknown[][]) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = rows[r].map(norm);
    const col: Partial<Record<Key, number>> = {};
    for (const key of Object.keys(COLUMNS) as Key[]) {
      for (const name of COLUMNS[key]) {
        const i = cells.findIndex((c, idx) => c === name && !Object.values(col).includes(idx));
        if (i >= 0) {
          col[key] = i;
          break;
        }
      }
    }
    // "รายการ" เป็นได้ทั้งชนิดรายการและรายละเอียด · มีคอลัมน์รายละเอียดแยกแล้วใช้ตัวนั้น
    if (col.date !== undefined && (col.deposit !== undefined || col.amount !== undefined)) return { row: r, col };
  }
  return null;
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** ปี: พ.ศ. 4 หลัก → ค.ศ. · 2 หลัก ≥ 43 ถือเป็น พ.ศ. (2543+) ไม่งั้น ค.ศ. 20xx */
function fullYear(y: number) {
  if (y >= 2400) return y - 543;
  if (y >= 100) return y;
  return y >= 43 ? 2500 + y - 543 : 2000 + y;
}

const pad = (n: number) => String(n).padStart(2, '0');
const bkk = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  const t = new Date(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}+07:00`);
  return Number.isNaN(t.getTime()) ? null : t;
};

function parseTime(v: unknown): [number, number, number] | null {
  if (v instanceof Date) return [v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds()];
  const m = /(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** วันที่ (และเวลาถ้าอยู่ในช่องเดียวกัน) · ช่อง Date ของ Excel ถือเป็นเวลาไทยตามที่เห็นในไฟล์ */
export function parseDate(v: unknown, time?: unknown): Date | null {
  let y: number, mo: number, d: number;
  let t = parseTime(time);
  if (v instanceof Date) {
    // exceljs คืนวันที่ของ Excel เป็น UTC ตามตัวเลขในช่อง (ไม่มี timezone)
    y = v.getUTCFullYear();
    mo = v.getUTCMonth() + 1;
    d = v.getUTCDate();
    if (!t && (v.getUTCHours() || v.getUTCMinutes())) t = [v.getUTCHours(), v.getUTCMinutes(), v.getUTCSeconds()];
  } else {
    const s = String(v ?? '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) [y, mo, d] = [fullYear(Number(m[1])), Number(m[2]), Number(m[3])];
    else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), fullYear(Number(m[3]))];
    else {
      m = /^(\d{1,2})\s*([ก-๙.]+)\s*(\d{2,4})/.exec(s);
      const th = m;
      const idx = th ? THAI_MONTHS.findIndex((x) => x.replace(/\./g, '') === th[2].replace(/\./g, '')) : -1;
      if (!th || idx < 0) return null;
      [d, mo, y] = [Number(th[1]), idx + 1, fullYear(Number(th[3]))];
    }
    // เวลาที่อยู่ในช่องเดียวกับวันที่ ("17/11/2026 09:12")
    t ??= parseTime(s.slice(m?.[0].length ?? 0));
  }
  return bkk(y, mo, d, ...(t ?? [0, 0, 0]));
}

/** ยอดเงิน → สตางค์ · "1,605.00" · "(12.40)" = ติดลบ · ช่องว่าง = 0 · อ่านไม่ได้ = null */
export function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v ?? '').replace(/[,\s฿]|THB|บาท/gi, '');
  if (!s || s === '-') return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = Number(s.replace(/[()+-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) * (neg ? -1 : 1) : null;
}

/** CSV แบบมีเครื่องหมายคำพูด · ตัวคั่น , หรือ tab (เดาจากบรรทัดที่มีตัวคั่นมากสุดใน 30 บรรทัดแรก) */
export function parseCsv(text: string): string[][] {
  const lines = text.split(/\r?\n/).slice(0, 30);
  const count = (ch: string) => Math.max(...lines.map((l) => l.split(ch).length));
  const sep = count('\t') > count(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** UTF-8 ก่อน · ถอดไม่ได้ (ไฟล์จากโปรแกรมของธนาคาร / Excel ภาษาไทยรุ่นเก่า) ใช้ Windows-874 */
export function decodeText(buf: Buffer) {
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-874').decode(body);
  }
}

async function xlsxRows(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as never);
  } catch {
    throw new AppError(422, 'statement_unreadable', 'เปิดไฟล์ Excel ไม่ได้ · ส่งออกจากระบบธนาคารใหม่เป็น .xlsx หรือ .csv');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = (r.values as unknown[]).slice(1).map((v) => (v && typeof v === 'object' && !(v instanceof Date) && 'text' in (v as object) ? (v as { text: unknown }).text : v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v));
    rows.push(vals);
  });
  return rows;
}

export async function parseStatement(buf: Buffer): Promise<ParsedStatement> {
  if (!buf.length) throw new AppError(400, 'file_required', 'แนบไฟล์ statement');
  if (buf.length > MAX_STATEMENT_BYTES) throw new AppError(413, 'file_too_large', 'ไฟล์ statement ต้องไม่เกิน 5 MB');
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') throw new AppError(415, 'statement_pdf', 'ยังอ่าน statement แบบ PDF ไม่ได้ · ส่งออกจากระบบธนาคารเป็น Excel หรือ CSV');
  const table = isZip ? await xlsxRows(buf) : parseCsv(decodeText(buf));
  const header = findHeader(table);
  if (!header) throw new AppError(422, 'statement_columns', 'ไม่พบหัวตารางที่มีวันที่และยอดเงินเข้า · ใช้ไฟล์ statement ที่ส่งออกจากระบบธนาคารออนไลน์ (Excel หรือ CSV)');
  const { col } = header;
  const at = (r: unknown[], k: Key) => (col[k] === undefined ? undefined : r[col[k]!]);
  const rows: StatementRow[] = [];
  let skipped = 0;
  for (const r of table.slice(header.row + 1)) {
    const txnAt = parseDate(at(r, 'date'), at(r, 'time'));
    let deposit = col.deposit !== undefined ? parseAmount(at(r, 'deposit')) : null;
    let withdrawal = col.withdrawal !== undefined ? parseAmount(at(r, 'withdrawal')) : 0;
    if (col.deposit === undefined) {
      // คอลัมน์ยอดเดียว: บวก = เข้า · ลบ = ออก
      const amt = parseAmount(at(r, 'amount'));
      deposit = amt === null ? null : Math.max(amt, 0);
      withdrawal = amt === null ? null : Math.max(-amt, 0);
    }
    if (!txnAt || deposit === null || withdrawal === null || (!deposit && !withdrawal)) {
      skipped++;
      continue;
    }
    const desc = String(at(r, 'description') ?? '').trim();
    const balance = col.balance !== undefined ? parseAmount(at(r, 'balance')) : null;
    rows.push({ txnAt, deposit: Math.abs(deposit), withdrawal: Math.abs(withdrawal), balance, description: desc.slice(0, 500), channel: at(r, 'channel') ? String(at(r, 'channel')).trim().slice(0, 100) : null });
  }
  rows.sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());
  const day = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return { rows, skipped, periodFrom: rows.length ? day(rows[0].txnAt) : null, periodTo: rows.length ? day(rows[rows.length - 1].txnAt) : null };
}
