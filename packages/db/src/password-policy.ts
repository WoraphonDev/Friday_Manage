// ความยาวรหัสผ่านขั้นต่ำที่ทีม Friday ตั้งจาก Ops (แบบ A: แยกพนักงาน Ops กับลูกค้า · 19 พ.ย.)
// ใช้ร่วมกันระหว่าง apps/ops-api (ตั้งค่า + ตรวจรหัสพนักงาน) และ apps/api (ขั้นต่ำของทุก Workspace)
import { eq } from 'drizzle-orm';
import type { Db, Tx } from './client.ts';
import { opsSettings } from './schema/ops.ts';

/** คีย์ใน ops_settings */
export const PASSWORD_POLICY_KEY = 'password_policy';
/** ค่าที่ให้เลือกใน Ops */
export const PASSWORD_LENGTH_CHOICES = [8, 12] as const;
export type PasswordLengthChoice = (typeof PASSWORD_LENGTH_CHOICES)[number];
export interface PasswordPolicySettings {
  /** พนักงาน Ops (ตั้งรหัสผ่าน + แอป Authenticator) */
  staffMinLength: PasswordLengthChoice;
  /** ขั้นต่ำของลูกค้าทุก Workspace · Admin ของ Workspace ตั้งให้เข้มกว่านี้ได้ แต่ต่ำกว่าไม่ได้ */
  customerMinLength: PasswordLengthChoice;
}
/** ค่าเดิมก่อนมีหน้าตั้งค่า: พนักงาน 12 · ลูกค้า 8 (J2) */
export const PASSWORD_POLICY_DEFAULTS: PasswordPolicySettings = { staffMinLength: 12, customerMinLength: 8 };

/** ค่าที่ใช้จริง · ค่าที่ไม่อยู่ในตัวเลือกไม่ใช้ (กันค่าเสียทำให้ตั้งรหัสสั้นเกินได้) */
export function passwordPolicyOf(raw: unknown): PasswordPolicySettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (n: unknown, fallback: PasswordLengthChoice) => ((PASSWORD_LENGTH_CHOICES as readonly unknown[]).includes(n) ? (n as PasswordLengthChoice) : fallback);
  return {
    staffMinLength: pick(v.staffMinLength, PASSWORD_POLICY_DEFAULTS.staffMinLength),
    customerMinLength: pick(v.customerMinLength, PASSWORD_POLICY_DEFAULTS.customerMinLength),
  };
}

/** อ่านค่าตั้ง · ต้องเป็นการเชื่อมต่อที่ข้าม RLS (ops_settings เป็นของทีม Friday) */
export async function readPasswordPolicy(db: Db | Tx): Promise<PasswordPolicySettings> {
  const [row] = await db.select({ value: opsSettings.value }).from(opsSettings).where(eq(opsSettings.key, PASSWORD_POLICY_KEY));
  return passwordPolicyOf(row?.value);
}
