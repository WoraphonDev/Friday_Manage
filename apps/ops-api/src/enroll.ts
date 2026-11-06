// ออกโทเค็นลงทะเบียน Security key ครั้งแรกของพนักงาน: pnpm --filter @friday/ops-api enroll <email> [ชื่อ] [บทบาท: admin|support|finance]
import { createDb, schema } from '@friday/db';
import { sql } from 'drizzle-orm';
import { signEnrollToken } from './auth/auth.service.js';
import { config } from './config.js';

const [email, name, role = 'admin'] = process.argv.slice(2);
if (!email) {
  console.error('ใช้: enroll <email> [ชื่อ] [admin|support|finance]');
  process.exit(1);
}
if (!['admin', 'support', 'finance'].includes(role)) {
  console.error('บทบาทต้องเป็น admin | support | finance');
  process.exit(1);
}
const db = createDb(config.dbUrl, 1);
let [row] = await db.select().from(schema.staffUsers).where(sql`lower(${schema.staffUsers.email}) = ${email.toLowerCase()}`);
if (!row) [row] = await db.insert(schema.staffUsers).values({ email, name: name ?? email.split('@')[0], role }).returning();
console.log(`พนักงาน: ${row.email} (${row.role})`);
console.log(`โทเค็นลงทะเบียน (ใช้ได้ 1 ชั่วโมง):\n${signEnrollToken(row.id)}`);
await db.$client.end();
