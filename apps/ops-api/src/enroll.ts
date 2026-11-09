// ออกโทเค็นลงทะเบียน Security key ครั้งแรกของพนักงาน: pnpm --filter @friday/ops-api enroll <email> [ชื่อ] [บทบาท คั่นด้วย , เช่น owner,finance]
// ใช้ตั้ง Owner คนแรก · พนักงานคนต่อไปเชิญจากหน้าพนักงาน (POST ops/staff)
import { createDb, schema } from '@friday/db';

const { STAFF_ROLES } = schema;
import { sql } from 'drizzle-orm';
import { signEnrollToken } from './auth/auth.service.js';
import { config } from './config.js';

const [email, name, roleArg = 'owner'] = process.argv.slice(2);
const roles = roleArg.split(',').map((r) => r.trim());
if (!email) {
  console.error('ใช้: enroll <email> [ชื่อ] [owner,finance,support,engineer,auditor]');
  process.exit(1);
}
if (!roles.length || !roles.every((r) => (STAFF_ROLES as readonly string[]).includes(r))) {
  console.error(`บทบาทต้องเป็น ${STAFF_ROLES.join(' | ')}`);
  process.exit(1);
}
const db = createDb(config.dbUrl, 1);
let [row] = await db.select().from(schema.staffUsers).where(sql`lower(${schema.staffUsers.email}) = ${email.toLowerCase()}`);
if (!row) [row] = await db.insert(schema.staffUsers).values({ email, name: name ?? email.split('@')[0], roles }).returning();
console.log(`พนักงาน: ${row.email} (${row.roles.join(', ')})`);
console.log(`โทเค็นลงทะเบียน (ใช้ได้ 1 ชั่วโมง):\n${signEnrollToken(row.id)}`);
await db.$client.end();
