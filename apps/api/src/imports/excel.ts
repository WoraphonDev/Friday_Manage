import ExcelJS from 'exceljs';

export type Cell = string | number | Date | null;
export interface Sheet {
  name: string;
  headers: string[];
  /** rowNo = แถวใน Excel (นับ 1) · cells เรียงตาม headers */
  rows: { rowNo: number; cells: Cell[] }[];
}
export interface ParsedWorkbook {
  table: Sheet;
  holidays: { date: string; name: string }[];
}

/** ค่าจริงของเซลล์: สูตร → ผลลัพธ์ · ข้อความจัดรูปแบบ / ลิงก์ → ข้อความ */
function plain(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result as ExcelJS.CellValue);
    if ('richText' in v) return plain(v.richText.map((t) => t.text).join(''));
    if ('text' in v) return plain(v.text as ExcelJS.CellValue);
    if ('error' in v) return null;
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');

/**
 * อ่านไฟล์แผนงาน: ชีตตารางงานคือชีตชื่อ "Table" หรือชีตแรกที่แถวหัวมี No. และ Module
 * ชีต "Holidays" (ถ้ามี) = วันหยุดที่ไฟล์ใช้คำนวณ Plan End
 */
export async function readPlanWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const headerOf = (ws: ExcelJS.Worksheet) => {
    const out: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => (out[i - 1] = String(plain(c.value) ?? '')));
    return out;
  };
  const isTable = (ws: ExcelJS.Worksheet) => {
    const h = headerOf(ws).map(norm);
    return h.includes('no') && h.includes('module');
  };
  const ws = wb.worksheets.find((w) => w.name.toLowerCase() === 'table' && isTable(w)) ?? wb.worksheets.find(isTable);
  if (!ws) throw new Error('no_table_sheet');

  const headers = headerOf(ws);
  const rows: Sheet['rows'] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (rowNo === 1) return;
    const cells = headers.map((_, i) => plain(row.getCell(i + 1).value));
    if (cells.some((c) => c !== null)) rows.push({ rowNo, cells });
  });

  const holidays: ParsedWorkbook['holidays'] = [];
  const hs = wb.worksheets.find((w) => w.name.toLowerCase() === 'holidays');
  hs?.eachRow((row, i) => {
    if (i === 1) return;
    const d = toIsoDate(plain(row.getCell(1).value));
    if (d) holidays.push({ date: d, name: String(plain(row.getCell(2).value) ?? 'วันหยุด') });
  });

  return { table: { name: ws.name, headers, rows }, holidays };
}

/** วันที่จาก Excel → YYYY-MM-DD · null = ว่าง · undefined = รูปแบบไม่ถูกต้อง */
export function toIsoDate(v: Cell): string | null | undefined {
  if (v === null || v === '-' || v === '—') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // serial date ของ Excel (นับจาก 1899-12-30)
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
