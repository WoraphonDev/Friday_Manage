import type { Group } from "./types";

/** วันที่ในแผนเป็น YYYY-MM-DD · คำนวณแบบ UTC เพื่อไม่ให้ timezone ของเครื่องเลื่อนวัน */
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addMonths(date: string, months: number) {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
/** วันจันทร์ของสัปดาห์ (ตรงกับ weekOf ของ API) */
export function mondayOf(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

/**
 * ช่วงที่ขอ Workload ตามมุมมอง · offset = จำนวนช่วงที่เลื่อนด้วยปุ่ม ‹ ›
 * Week 8 สัปดาห์ (ค่าเริ่มต้นของหน้า 7) · Day 2 สัปดาห์ · Month 2 เดือน
 */
export function workloadRange(group: Group, today: string, offset: number) {
  if (group === "month") {
    const from = addMonths(today, offset * 2);
    return { from, to: addDays(addMonths(from, 2), -1) };
  }
  const span = group === "day" ? 14 : 56;
  const from = addDays(mondayOf(today), offset * span);
  return { from, to: addDays(from, span - 1) };
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export const isEmail = (value: string) => EMAIL.test(value);
/** แยกอีเมลที่วางมาหลายรายการ (คั่นด้วย , ; เว้นวรรค หรือขึ้นบรรทัด) และตัดตัวซ้ำ */
export function splitEmails(text: string) {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export async function copyText(text: string) {
  await navigator.clipboard?.writeText(text);
}
