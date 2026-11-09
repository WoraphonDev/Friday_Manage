// Migration ตอน deploy: รันไฟล์ใน packages/db/migrations (ตาราง drizzle.__drizzle_migrations เดียวกับ drizzle-kit migrate)
// แล้วสร้าง / หมุนรหัสผ่านบัญชีล็อกอิน friday_api และ friday_worker จาก Secrets Manager
// ใช้ drizzle-orm (dependency ตอนรัน) แทน drizzle-kit ซึ่งเป็น devDependency ไม่อยู่ใน image
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, 'package.json'));
const pg = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');

const url = process.env.DATABASE_OWNER_URL;
const apiPassword = process.env.DB_API_PASSWORD;
const workerPassword = process.env.DB_WORKER_PASSWORD;
if (!url || !apiPassword || !workerPassword) {
  console.error('ต้องตั้ง DATABASE_OWNER_URL (หรือ DB_HOST + DB_OWNER_PASSWORD), DB_API_PASSWORD และ DB_WORKER_PASSWORD');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await migrate(drizzle(client), { migrationsFolder: join(here, 'migrations') });
  console.log('migrations: ล่าสุดแล้ว');
  // role friday_app / friday_system มาจาก migration · บัญชีล็อกอินไม่อยู่ใน migration เพราะรหัสผ่านต่างกันแต่ละสภาพแวดล้อม
  const roles = [
    ['friday_api', apiPassword, 'IN ROLE friday_app', ''],
    // BYPASSRLS ต้องตั้งที่ตัวบัญชีเอง ไม่ถ่ายทอดผ่านการเป็นสมาชิก role
    ['friday_worker', workerPassword, 'BYPASSRLS IN ROLE friday_system', 'BYPASSRLS'],
  ];
  for (const [name, password, create, alter] of roles) {
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount > 0;
    const secret = client.escapeLiteral(password);
    await client.query(exists ? `ALTER ROLE ${name} LOGIN ${alter} PASSWORD ${secret}` : `CREATE ROLE ${name} LOGIN ${create.replace('IN ROLE', `PASSWORD ${secret} IN ROLE`)}`);
    console.log(`role ${name}: ${exists ? 'อัปเดตรหัสผ่าน' : 'สร้างแล้ว'}`);
  }
} finally {
  await client.end();
}
