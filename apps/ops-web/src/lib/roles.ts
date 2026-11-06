import type { StaffRole } from "./types";

/**
 * สิทธิ์ตามบทบาทของ ops-api (`@Roles` ใน ops.controller.ts): admin ผ่านทุกข้อ ·
 * support = เข้าช่วยเหลือ + ต่อทดลอง · finance = ชำระเงิน + ส่วนลด + แพ็กเกจ · admin อย่างเดียว = ระงับ, flag, ประกาศ
 * ใช้ซ่อนปุ่มเท่านั้น — ops-api ตรวจซ้ำและตอบ 403 `forbidden` เสมอ
 */
export type Need = StaffRole;
export const can = (role: StaffRole | undefined, need: Need) => role === "admin" || (!!role && role === need);
