// บทบาทและวงเงินของพนักงาน Friday (docs/spec/06-ops-roles.md)
import { schema } from '@friday/db';
import { z } from 'zod';

const { STAFF_ROLES } = schema;

export type StaffRole = (typeof STAFF_ROLES)[number];
export const StaffRoleEnum = z.enum(STAFF_ROLES);

/** วงเงินที่ทำเองได้ · เกินต้องให้ Owner อนุมัติ (06 › 3) · เงินเป็นสตางค์ */
export interface Limits {
  refundSatang: number;
  creditSatang: number;
  discountPct: number;
  discountCycles: number;
  trialDays: number;
  trialTimes: number;
}

export const DEFAULT_LIMITS: Limits = { refundSatang: 1_000_000, creditSatang: 500_000, discountPct: 30, discountCycles: 12, trialDays: 30, trialTimes: 2 };

export const LimitsBody = z
  .object({
    refundSatang: z.number().int().min(0),
    creditSatang: z.number().int().min(0),
    discountPct: z.number().int().min(0).max(100),
    discountCycles: z.number().int().min(0).max(36),
    trialDays: z.number().int().min(0).max(90),
    trialTimes: z.number().int().min(0).max(10),
  })
  .partial()
  .strict();

/** `staff_users.limits` เก็บเฉพาะค่าที่ต่างจากค่าเริ่มต้น */
export function limitsOf(raw: unknown): Limits {
  const parsed = LimitsBody.safeParse(raw ?? {});
  return { ...DEFAULT_LIMITS, ...(parsed.success ? parsed.data : {}) };
}

/** ค่า `role` แบบเดิมสำหรับ ops-web รุ่นก่อน O10 (เลิกใช้แล้ว · ลบเมื่อ O10 merge) · Owner = admin */
export const legacyRole = (roles: readonly string[]) => (roles.includes('owner') ? 'admin' : roles.includes('finance') ? 'finance' : 'support');
