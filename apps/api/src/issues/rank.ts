/**
 * ลำดับการ์ดใน Kanban / Backlog (issues.rank) แบบ fractional index ฐาน 36
 *
 * - เรียงด้วย `rank COLLATE "C"` แล้วตามเลขงาน
 * - ค่าเริ่มต้นเดิมของตาราง ('0|hzzzzz:') และงานที่ Import เข้ามาถือเป็นค่าเก่า (legacy) ที่ซ้ำกันได้
 *   ลากครั้งแรกในโปรเจกต์จึงจัดลำดับใหม่ทั้งโปรเจกต์ให้เป็นค่าที่ไม่ซ้ำก่อน (migration 0004 ทำให้การแก้ rank ไม่เพิ่ม version)
 * - ค่าที่สร้างไม่มีเลข 0 ปิดท้าย เพื่อให้หาค่ากึ่งกลางได้เสมอ
 */
const D = '0123456789abcdefghijklmnopqrstuvwxyz';

/** ค่าที่ใช้หาค่ากึ่งกลางได้: ฐาน 36 และไม่ลงท้ายด้วย 0 */
export const PLAIN_RANK = /^[0-9a-z]*[1-9a-z]$/;
export const isLegacyRank = (r: string) => !PLAIN_RANK.test(r);

/** ค่าระหว่าง a กับ b (null = ไม่มีขอบ) · ต้องได้ a < b */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`rankBetween: ${a} >= ${b}`);
  return mid(a ?? '', b);
}

function mid(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < b.length && (a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const da = a ? D.indexOf(a[0]) : 0;
  const db = b !== null ? D.indexOf(b[0]) : D.length;
  if (db - da > 1) return D[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b[0];
  return D[da] + mid(a.slice(1), null);
}

/**
 * ค่าถัดจาก a สำหรับต่อท้าย (งานใหม่) · บวก 1 ที่ 4 หลักแรกแทนการหาค่ากึ่งกลาง
 * เพื่อไม่ให้ความยาวโตขึ้นเรื่อย ๆ เมื่อต่อท้ายหลายครั้ง
 */
export function rankAfter(a: string | null): string {
  if (!a) return 'i';
  const v = parseInt(a.slice(0, 4).padEnd(4, '0'), 36) + 1;
  if (v >= 36 ** 4) return rankBetween(a, null);
  return v.toString(36).padStart(4, '0').replace(/0+$/, '');
}

/** n ค่าเรียงจากน้อยไปมาก กระจายเท่า ๆ กัน (ใช้ตอนจัดลำดับใหม่) */
export function spreadRanks(n: number): string[] {
  let width = 1;
  while (36 ** width < (n + 1) * 36) width++;
  const step = Math.floor(36 ** width / (n + 1));
  return Array.from({ length: n }, (_, i) => ((i + 1) * step).toString(36).padStart(width, '0').replace(/0+$/, ''));
}
