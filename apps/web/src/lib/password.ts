export type StrengthLevel = "weak" | "fair" | "good" | "strong";
export interface PasswordPolicy {
  minLength: number;
  requireSpecial: boolean;
}
export const DEFAULT_POLICY: PasswordPolicy = { minLength: 8, requireSpecial: false };

/** กติกาเดียวกับ API (J2: อย่างน้อย 8 ตัว มีตัวพิมพ์ใหญ่และตัวเลข · อักขระพิเศษตามนโยบาย Workspace)
 * ใช้ทั้งหน้าสมัคร / ลืมรหัสผ่าน / รับคำเชิญ และหน้าต่างเปลี่ยนรหัสผ่านในโปรไฟล์ */
export function checkPassword(value: string, policy: PasswordPolicy = DEFAULT_POLICY) {
  const rules = {
    length: value.length >= policy.minLength,
    upper: /[A-Z]/.test(value),
    digit: /[0-9]/.test(value),
    special: /[^A-Za-z0-9]/.test(value),
  };
  const valid = rules.length && rules.upper && rules.digit && (!policy.requireSpecial || rules.special);
  const score = Object.values(rules).filter(Boolean).length;
  const level: StrengthLevel = !valid ? (score <= 2 ? "weak" : "fair") : score === 4 && value.length >= 12 ? "strong" : "good";
  return { rules, valid, score, level };
}
