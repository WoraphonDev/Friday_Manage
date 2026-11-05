export const config = {
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
};
