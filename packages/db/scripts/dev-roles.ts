// สร้างบัญชีล็อกอินสำหรับเครื่องที่ใช้พัฒนาเท่านั้น (production สร้างโดย infra พร้อมรหัสผ่านจาก secret manager)
//   friday_api    : สมาชิกของ friday_app → ถูกบังคับด้วย RLS
//   friday_worker : ต้องมี BYPASSRLS ที่ตัวเอง เพราะ attribute นี้ไม่ถ่ายทอดผ่านการเป็นสมาชิก role
import pg from 'pg';

const url = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'friday_api') THEN
    CREATE ROLE friday_api LOGIN PASSWORD 'friday_api_dev' IN ROLE friday_app;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'friday_worker') THEN
    CREATE ROLE friday_worker LOGIN BYPASSRLS PASSWORD 'friday_worker_dev' IN ROLE friday_system;
  END IF;
END $$`);
await client.end();
console.log('dev roles ready: friday_api, friday_worker');
