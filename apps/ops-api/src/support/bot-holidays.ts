import { Injectable } from '@nestjs/common';

/** วันหยุดหนึ่งวันจากประกาศ ธปท. */
export interface BotHoliday {
  date: string;
  name: string;
}

/**
 * ตัวดึง API "วันหยุดสถาบันการเงิน" ของ ธปท. (S1 · BOT API Portal)
 * - Gateway: https://gateway.api.bot.or.th/financial-institutions-holidays/?year=YYYY (listen path จากหน้า Catalogue ของ Portal)
 * - Portal ใหม่ (ตั้งแต่ 17 ก.ย. 2568) ใช้ header `Authorization` ใส่ token จาก Portal · ส่ง `X-IBM-Client-Id` ด้วยเผื่อ Gateway เดิม
 * - รูปข้อมูลอ่าน spec จริงไม่ได้ (ต้องเข้าระบบ Portal) จึงอ่านแบบยืดหยุ่น: `result.data[]` หรือ `data[]`
 *   ที่มี `Date` (YYYY-MM-DD) และ `HolidayDescriptionThai` / `HolidayDescription` · ตรวจกับ spec เมื่อได้ Client ID แล้วแก้ที่ไฟล์นี้ที่เดียว
 * ไม่ตั้ง BOT_API_CLIENT_ID = ปิดตัวดึง (หน้าจอแสดงสถานะ และเพิ่มวันหยุดเองได้)
 */
@Injectable()
export class BotHolidaysClient {
  get configured() {
    return !!process.env.BOT_API_CLIENT_ID;
  }

  private get url() {
    return process.env.BOT_HOLIDAYS_URL || 'https://gateway.api.bot.or.th/financial-institutions-holidays/';
  }

  async fetchYear(year: number): Promise<BotHoliday[]> {
    const id = process.env.BOT_API_CLIENT_ID;
    if (!id) throw new Error('ยังไม่ได้ตั้ง BOT_API_CLIENT_ID');
    const url = new URL(this.url);
    url.searchParams.set('year', String(year));
    const res = await fetch(url, { headers: { Authorization: id, 'X-IBM-Client-Id': id, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ธปท. ตอบ HTTP ${res.status}`);
    return parseBotHolidays(await res.json(), year);
  }
}

/** แปลงคำตอบของ ธปท. เป็นรายการวันหยุดของปีที่ขอ (ตัดแถวที่รูปไม่ถูกและวันที่ซ้ำ) */
export function parseBotHolidays(body: unknown, year: number): BotHoliday[] {
  const root = (body ?? {}) as { result?: { data?: unknown }; data?: unknown };
  const list = Array.isArray(root.result?.data) ? root.result.data : Array.isArray(root.data) ? root.data : Array.isArray(body) ? body : null;
  if (!list) throw new Error('รูปข้อมูลจาก ธปท. ไม่ตรงที่คาดไว้');
  const out = new Map<string, string>();
  for (const raw of list as Record<string, unknown>[]) {
    const date = String(raw.Date ?? raw.date ?? '').slice(0, 10);
    const name = String(raw.HolidayDescriptionThai ?? raw.holidayDescriptionThai ?? raw.HolidayDescription ?? raw.name ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name || Number(date.slice(0, 4)) !== year) continue;
    out.set(date, name.slice(0, 120));
  }
  return [...out].map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date));
}
