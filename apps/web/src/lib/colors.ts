/*
 * สีที่ผู้ใช้เลือกเอง (โมดูล ประเภทงาน ป้าย ทีม โปรเจกต์) เป็นค่า hex ในฐานข้อมูล
 * จึงไม่ได้ปรับตามโหมดสว่าง/มืดเหมือน token ใน tokens.css
 * ใช้ตัวช่วยเหล่านี้เมื่อเอาสีนั้นไปเป็นสีตัวอักษรหรือพื้นจาง เพื่อให้อ่านออกทั้งสองโหมด
 */

/** สีเริ่มต้นของโมดูล/ป้ายใหม่: ม่วงหลักของแบรนด์ (ตัวอักษรขาวบนสีนี้ผ่าน AA) */
export const DEFAULT_ITEM_COLOR = "#5b3fc4";

/** สีโปรเจกต์เมื่อยังไม่ได้เลือก: ตัวอักษรขาวอ่านได้ และยังเห็นเป็นแถบบนพื้นมืด */
export const FALLBACK_PROJECT_COLOR = "#5f656d";

/**
 * สีตัวอักษรจากสีข้อมูล: ผสมกับสีตัวอักษรของธีม ให้เข้มขึ้นในโหมดสว่างและอ่อนลงในโหมดมืด
 * 40% ผ่าน AA แม้สีที่ผู้ใช้เลือกจะสว่างมาก (เช่น เหลือง) หรือเข้มมาก (เช่น น้ำเงินเข้มบนพื้นมืด)
 */
export function readableColor(color: string): string {
  return `color-mix(in srgb, ${color} 40%, var(--foreground))`;
}

/** พื้นจางจากสีข้อมูล (แทนการต่อท้าย hex แบบ `${color}1a` ซึ่งใช้กับ var() ไม่ได้) */
export function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/**
 * ชุดสี Module 12 สี (ผู้ใช้เลือกจาก mockup 2026-11-14) · ไม่มีโทนแดง/ชมพูเข้ม จึงไม่กลืนกับส่วนแดงของงานที่เลยกำหนดบน Timeline / Gantt
 * ทุกสีเข้มพอให้ตัวอักษรขาวบนแถบอ่านออก
 */
export const MODULE_COLORS = [
  "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#0891b2", "#0d9488",
  "#059669", "#65a30d", "#ca8a04", "#d97706", "#475569", "#78716c",
] as const;

/** สีถัดไปในชุดที่ยังไม่มี Module ใช้ · ใช้ครบแล้ววนใหม่ */
export function nextModuleColor(used: readonly (string | null | undefined)[]): string {
  const taken = new Set(used.filter(Boolean).map((c) => c!.toLowerCase()));
  return MODULE_COLORS.find((c) => !taken.has(c)) ?? MODULE_COLORS[used.length % MODULE_COLORS.length]!;
}

/** สีใกล้สีแดงของงานเลยกำหนด: โทนแดง/ชมพูเข้ม (hue 325–20°) และสดพอ · ใช้เตือนตอนเลือกสี Module */
export function isNearLateRed(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return false;
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return (h >= 325 || h <= 20) && s > 0.35;
}
