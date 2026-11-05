import { config } from '../config.js';

/** วันที่ของวันนี้ตามเวลาไทย รูปแบบ YYYY-MM-DD */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}
