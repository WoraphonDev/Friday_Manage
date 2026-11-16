// รูปแบบตัวเลข / วันที่ / จำนวนเงินตัวอักษร ตามธรรมเนียมเอกสารการเงินไทย · ใช้ทั้ง PDF และ Excel

/** สตางค์ → "3,210.00" · ติดลบใส่เครื่องหมายหน้า */
export const baht = (satang: number) => `${satang < 0 ? '-' : ''}${(Math.abs(satang) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const monthName = (m: number) => MONTHS[m - 1];

/** `2026-11-17` → "17 พ.ย. 2569" (short) หรือ "17 พฤศจิกายน 2569" · เอกสารภาษีใช้ พ.ศ. */
export function thaiDate(iso: string, short = true) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${(short ? SHORT_MONTHS : MONTHS)[m - 1]} ${y + 543}`;
}
/** `2026-11-17` → "17/11/69" (คอลัมน์วันที่ในรายงานภาษีขาย) */
export function thaiNumericDate(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${String((y + 543) % 100).padStart(2, '0')}`;
}
/** เวลาไทยของ timestamp → "17 พ.ย. 2569 10:42" */
export function thaiDateTime(at: Date) {
  const bkk = new Date(at.getTime() + 7 * 3_600_000).toISOString();
  return `${thaiDate(bkk.slice(0, 10))} ${bkk.slice(11, 16)}`;
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
/** จำนวนเงินเป็นตัวอักษร เช่น 321000 สตางค์ → "สามพันสองร้อยสิบบาทถ้วน" */
export function bahtText(satang: number) {
  const value = Math.abs(Math.round(satang));
  const whole = Math.floor(value / 100);
  const cents = value % 100;
  if (!whole && !cents) return 'ศูนย์บาทถ้วน';
  return `${whole ? `${readInt(whole)}บาท` : ''}${cents ? `${readInt(cents)}สตางค์` : 'ถ้วน'}`;
}

/** สถานประกอบการตามประกาศอธิบดีฯ ฉบับที่ 199: "สำนักงานใหญ่" หรือ "สาขาที่ 00002" (เลข 5 หลัก) */
export function branchLabel(branchType: 'head' | 'branch' | string, branchNo?: string | null) {
  if (branchType !== 'branch') return 'สำนักงานใหญ่';
  const digits = (branchNo ?? '').replace(/\D/g, '');
  return `สาขาที่ ${digits.padStart(5, '0')}`;
}
