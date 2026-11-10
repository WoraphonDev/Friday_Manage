const prod = process.env.NODE_ENV === 'production';
const secret = process.env.OPS_AUTH_SECRET ?? (prod ? '' : 'ops-dev-secret-change-me-0123456789abcdef');
if (prod && secret.length < 32) throw new Error('ตั้ง OPS_AUTH_SECRET (≥ 32 ตัวอักษร) ก่อนเปิด production');

export const config = {
  port: Number(process.env.OPS_PORT ?? 3002),
  /**
   * บัญชีฐานข้อมูลของหลังบ้าน: ต้องเป็น role ที่ข้าม RLS ได้ (BYPASSRLS) เพราะแตะข้อมูลทุก Workspace · ห้ามใช้ friday_app
   * ค่าเริ่มต้น = friday_worker ของ dev (สมาชิก friday_system) · production ควรสร้าง role แยก `friday_ops` ที่ได้สิทธิ์เฉพาะตารางที่ใช้
   */
  dbUrl: process.env.OPS_DATABASE_URL ?? process.env.DATABASE_SYSTEM_URL ?? 'postgres://friday_worker:friday_worker_dev@localhost:54329/friday',
  secret,
  /** WebAuthn: RP ID = โดเมนของหลังบ้าน (ops.friday.app) · origin = หน้าเว็บ W20 */
  rpId: process.env.OPS_RP_ID ?? 'localhost',
  rpName: 'Friday Ops',
  origin: process.env.OPS_WEB_ORIGIN ?? 'http://localhost:3002',
  cookie: 'fm_ops',
  cookieSecure: prod,
  sessionHours: 8,
  /** หน้าลูกค้าสำหรับลิงก์ในอีเมลแจ้งเข้าช่วยเหลือ */
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  /** อีเมลสำนักงานบัญชี (คั่นด้วยจุลภาค) · รับไฟล์ส่งออกรายเดือน (B8) · ไม่ตั้ง = ส่งไม่ได้ ดาวน์โหลดได้อย่างเดียว */
  get accountingEmails() {
    return (process.env.OPS_ACCOUNTING_EMAIL ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  },
  /** วันที่ของเดือนที่ส่งไฟล์ของเดือนก่อนให้สำนักงานบัญชีอัตโนมัติ */
  get accountingSendDay() {
    return Number(process.env.OPS_ACCOUNTING_SEND_DAY ?? 5);
  },
};
