// สร้างไฟล์ iCalendar (RFC 5545) แบบ all-day event · ไม่พึ่ง library
const CRLF = '\r\n';

/** ข้อความใน property ต้อง escape \ ; , และขึ้นบรรทัดใหม่ */
export const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** พับบรรทัดที่ยาวเกิน 75 octets (นับเป็น UTF-8 ไม่ตัดกลางตัวอักษร) · บรรทัดต่อเริ่มด้วยช่องว่าง 1 ตัว */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(CRLF);
}

const compact = (date: string) => date.replaceAll('-', '');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export interface IcsEvent {
  uid: string;
  /** วันเริ่ม–วันจบ (รวมวันจบ) */
  start: string;
  end: string;
  summary: string;
  description?: string;
  url?: string;
  category?: string;
}

export function buildIcs(calName: string, events: IcsEvent[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Friday Manage//Calendar//TH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(calName)}`,
    'X-WR-TIMEZONE:Asia/Bangkok',
    // ให้แอปปฏิทินดึงใหม่ทุก 1 ชั่วโมง
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${compact(e.start)}`,
      // DTEND ของ all-day เป็นวันถัดจากวันสุดท้าย (exclusive)
      `DTEND;VALUE=DATE:${compact(nextDay(e.end))}`,
      `SUMMARY:${icsText(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      ...(e.url ? [`URL:${e.url}`] : []),
      ...(e.category ? [`CATEGORIES:${icsText(e.category)}`] : []),
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}
