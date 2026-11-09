import { resolve } from 'node:path';

export const config = {
  /**
   * บริษัทจด VAT แล้วหรือยัง (decisions › Friday Ops ข้อ 9 · รอผู้ทำบัญชี) · จดแล้ว = คิด VAT 7% และออกใบกำกับภาษี / e-Tax
   * ยังไม่จด (`VAT_REGISTERED=false`) = ไม่คิด VAT และออกใบเสร็จ · test เปลี่ยนค่าระหว่างรันได้
   */
  vatRegistered: process.env.VAT_REGISTERED !== 'false',
  port: Number(process.env.PORT ?? 3001),
  /** บัญชีที่เป็นสมาชิกของ friday_app (ถูกบังคับด้วย RLS) */
  appDbUrl: process.env.DATABASE_APP_URL ?? 'postgres://friday_api:friday_api_dev@localhost:54329/friday',
  /** บัญชี BYPASSRLS ใช้เฉพาะ Sign up / Login / Session / สร้าง Workspace */
  systemDbUrl: process.env.DATABASE_SYSTEM_URL ?? 'postgres://friday_worker:friday_worker_dev@localhost:54329/friday',
  cookieSecure: process.env.NODE_ENV === 'production',
  rememberDays: 30,
  /** ค่าเริ่มต้นของนโยบายความปลอดภัย (ภายหลังอ่านจาก security_policies ของ Workspace) */
  sessionIdleHours: 8,
  lockoutAttempts: 5,
  lockoutMinutes: 15,
  timezone: 'Asia/Bangkok',
  /** ไฟล์ที่อัปโหลด (ช่วงแรกเก็บในเครื่อง · ย้ายไป S3 ภายหลัง) */
  uploadDir: process.env.UPLOAD_DIR ?? resolve('var/uploads'),
  maxImportBytes: 20 * 1024 * 1024,
};
