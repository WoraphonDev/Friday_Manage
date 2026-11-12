import type ExcelJS from 'exceljs';

/** แถวของชีต Timeline: หัว Module แล้วตามด้วย Task / Sub-task */
export type TimelineRow =
  | { kind: 'module'; name: string; start: string | null; end: string | null }
  | {
      kind: 'task';
      key: string;
      title: string;
      sub: boolean;
      status: string;
      category: string;
      progress: number;
      start: string | null;
      end: string | null;
      /** วันที่ใช้ตัดสินเลยกำหนด ถ้าต่างจาก end (โปรเจกต์แยก Dev / QA งานรอ QA = QA Due) */
      due?: string | null;
    };

export interface TimelineInput {
  projectName: string;
  /** วันนี้ (Asia/Bangkok) · ใช้ระบายเส้นวันนี้และงานที่เลยกำหนด */
  today: string;
  /** ช่วงของโปรเจกต์ ใช้เมื่อไม่มีงานที่ลงวันที่ */
  from: string;
  to: string;
  scale: 'day' | 'week';
  holidays: Set<string>;
  rows: TimelineRow[];
}

const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => toIso(toTime(iso) + n * DAY);
/** จันทร์ของสัปดาห์ (สัปดาห์เริ่มวันจันทร์แบบปฏิทินงานไทย) */
const monday = (iso: string) => addDays(iso, -((new Date(toTime(iso)).getUTCDay() + 6) % 7));
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${(Number(iso.slice(0, 4)) + 543) % 100}`;
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const COLOR = {
  todo: 'FFBFDBFE',
  in_progress: 'FF3B82F6',
  review: 'FFA78BFA',
  blocked: 'FFF59E0B',
  done: 'FF22C55E',
  cancelled: 'FFD1D5DB',
  late: 'FFF87171',
  module: 'FF475569',
  weekend: 'FFF3F4F6',
  head: 'FF1F2937',
  today: 'FFDC2626',
};
/** คอลัมน์ข้อมูลก่อนช่องวันที่ */
const INFO = ['Key', 'Task', 'Status', 'Plan Start', 'Plan End', '%'];
const MAX_DAY_COLUMNS = 370;

/**
 * ชีต Timeline (Gantt) ของแผน ณ วันที่ Export (ผู้ใช้ขอ 2026-11-09: เอาไปทำงานต่อข้างนอก)
 * แต่ละงานระบายช่องตามช่วง Plan Start–End · สีตามสถานะ · เลยกำหนดแล้วยังไม่ Done = แดง · มีเส้นวันนี้
 * scale = day (ช่องละวัน) หรือ week (ช่องละสัปดาห์) · ช่วงยาวเกินปีใช้ week เอง
 */
export function addTimelineSheet(wb: ExcelJS.Workbook, input: TimelineInput) {
  const dated = input.rows.filter((r) => r.start && r.end);
  const starts = dated.map((r) => r.start!).sort();
  const ends = dated.map((r) => r.end!).sort();
  let from = starts[0] ?? input.from;
  let to = ends.at(-1) ?? input.to;
  if (input.today < from) from = input.today;
  if (input.today > to) to = input.today;
  from = monday(from);
  to = addDays(monday(to), 6);
  const days = Math.round((toTime(to) - toTime(from)) / DAY) + 1;
  const scale = input.scale === 'day' && days <= MAX_DAY_COLUMNS ? 'day' : 'week';
  const slots: { start: string; end: string }[] = [];
  for (let d = from; d <= to; d = addDays(d, scale === 'day' ? 1 : 7)) slots.push({ start: d, end: scale === 'day' ? d : addDays(d, 6) });

  const ws = wb.addWorksheet('Timeline', { views: [{ state: 'frozen', xSplit: INFO.length, ySplit: 3 }] });
  const first = INFO.length + 1;
  const col = (i: number) => first + i;

  // แถว 1: ชื่อแผน ณ วันที่ · แถว 2: เดือน (รวมช่อง) · แถว 3: วันที่ / สัปดาห์
  ws.getCell(1, 1).value = `${input.projectName} · Timeline ณ ${input.today} · ${scale === 'day' ? 'ช่องละวัน' : 'ช่องละสัปดาห์'}`;
  ws.getCell(1, 1).font = { bold: true, size: 13 };
  const head = ws.getRow(3);
  INFO.forEach((h, i) => (head.getCell(i + 1).value = h));
  let monthStart = 0;
  slots.forEach((slot, i) => {
    head.getCell(col(i)).value = scale === 'day' ? Number(slot.start.slice(8, 10)) : `${Number(slot.start.slice(8, 10))}/${Number(slot.start.slice(5, 7))}`;
    const nextMonth = i === slots.length - 1 || slots[i + 1].start.slice(0, 7) !== slot.start.slice(0, 7);
    if (nextMonth) {
      ws.getCell(2, col(monthStart)).value = monthLabel(slots[monthStart].start);
      if (i > monthStart) ws.mergeCells(2, col(monthStart), 2, col(i));
      monthStart = i + 1;
    }
  });
  for (const r of [2, 3]) {
    const row = ws.getRow(r);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    row.alignment = { horizontal: 'center', vertical: 'middle' };
    for (let c = 1; c <= INFO.length + slots.length; c++) row.getCell(c).fill = fill(COLOR.head);
  }
  ws.getRow(3).getCell(2).alignment = { horizontal: 'left' };

  const isToday = (slot: { start: string; end: string }) => input.today >= slot.start && input.today <= slot.end;
  const offDay = (slot: { start: string }) => scale === 'day' && (new Date(toTime(slot.start)).getUTCDay() % 6 === 0 || input.holidays.has(slot.start));
  slots.forEach((slot, i) => {
    if (isToday(slot)) head.getCell(col(i)).fill = fill(COLOR.today);
  });

  for (const r of input.rows) {
    const row = ws.addRow(
      r.kind === 'module'
        ? [null, r.name, null, r.start ? new Date(toTime(r.start)) : null, r.end ? new Date(toTime(r.end)) : null, null]
        : [r.key, r.title, r.status, r.start ? new Date(toTime(r.start)) : null, r.end ? new Date(toTime(r.end)) : null, r.progress / 100],
    );
    row.height = 16;
    if (r.kind === 'module') row.font = { bold: true };
    if (r.kind === 'task' && r.sub) row.getCell(2).alignment = { indent: 2 };
    row.getCell(6).numFmt = '0%';
    const due = r.kind === 'task' ? (r.due !== undefined ? r.due : r.end) : null;
    const late = r.kind === 'task' && r.category !== 'done' && r.category !== 'cancelled' && !!due && due < input.today;
    const color = r.kind === 'module' ? COLOR.module : late ? COLOR.late : (COLOR[r.category as keyof typeof COLOR] ?? COLOR.todo);
    slots.forEach((slot, i) => {
      const cell = row.getCell(col(i));
      const inside = !!r.start && !!r.end && r.start <= slot.end && r.end >= slot.start;
      if (inside) cell.fill = fill(color);
      else if (offDay(slot)) cell.fill = fill(COLOR.weekend);
      if (isToday(slot)) cell.border = { left: { style: 'medium', color: { argb: COLOR.today } } };
    });
  }

  for (const c of [4, 5]) ws.getColumn(c).numFmt = 'yyyy-mm-dd';
  [10, 40, 12, 11, 11, 6].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  slots.forEach((_, i) => (ws.getColumn(col(i)).width = scale === 'day' ? 3.2 : 5.5));

  const legendRow = ws.rowCount + 2;
  const legend: [string, string][] = [['To do', COLOR.todo], ['In progress', COLOR.in_progress], ['Review / QA', COLOR.review], ['Blocked / On hold', COLOR.blocked], ['Done', COLOR.done], ['Cancelled', COLOR.cancelled], ['เลยกำหนด', COLOR.late], ['วันนี้', COLOR.today]];
  legend.forEach(([name, argb], i) => {
    const cell = ws.getCell(legendRow + i, 2);
    cell.value = name;
    ws.getCell(legendRow + i, 1).fill = fill(argb);
  });
}
