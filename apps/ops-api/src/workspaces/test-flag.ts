import { type SQL, sql } from 'drizzle-orm';
import { config } from '../config.js';

/**
 * Workspace ทดสอบ และผู้ซื้อ (ช่วง 1 · ออกแบบสำหรับข้อมูลเยอะ)
 *
 * ทดสอบ = ทีมติดป้าย `test` หรือ (ไม่มีป้าย และเจ้าของใช้โดเมนที่สงวนไว้ทดสอบ)
 * โดเมนสงวน (RFC 2606 / 6761) รับอีเมลจริงไม่ได้ จึงไม่มีทางเป็นลูกค้า · ติดอัตโนมัติได้อย่างปลอดภัย
 * ส่วนที่ "น่าจะเป็น" (โดเมนของทีม Friday, ชื่อขึ้นต้น QA / Demo / Test) ระบบแค่เสนอ คนต้องยืนยัน
 *
 * ผู้ซื้อรายเดียวกัน = เลขผู้เสียภาษีเดียวกัน · ยังไม่กรอกข้อมูลภาษี = เจ้าของคนเดียวกัน
 * ไม่จับคู่ด้วยชื่อบริษัทหรือโดเมนอีเมล (พิมพ์ต่างกัน / ใช้ Gmail ร่วมกัน)
 */

/** อีเมลอยู่ในโดเมนที่สงวนไว้ทดสอบ (รวมโดเมนย่อย) · รายการจาก config.testEmailDomains */
export const reservedEmail = (email: SQL) => {
  const domains = config.testEmailDomains;
  if (!domains.length) return sql`false`;
  const d = sql`lower(split_part(${email}, '@', 2))`;
  const parts = domains.map((x) => (x.startsWith('.') ? sql`${d} like ${`%${x}`}` : sql`(${d} = ${x} or ${d} like ${`%.${x}`})`));
  return sql`(${sql.join(parts, sql` or `)})`;
};

/** เจ้าของ (คนแรกที่ยัง active) ของ Workspace */
export const ownerOf = (wid: SQL) =>
  sql`(select m.user_id from workspace_members m where m.workspace_id = ${wid} and m.role = 'owner' and m.status = 'active' order by m.joined_at, m.user_id limit 1)`;

const ownerEmail = (wid: SQL) => sql`(select u.email from users u where u.id = ${ownerOf(wid)})`;

/** ป้ายที่ทีมตั้งไว้ (test / not_test / null) */
export const flagOf = (wid: SQL) => sql`(select f.test_flag from ops_workspace_flags f where f.workspace_id = ${wid})`;

/** กฎอัตโนมัติ: มีเจ้าของคนใดใช้โดเมนสงวน */
export const autoTest = (wid: SQL) =>
  sql`exists(select 1 from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${wid} and m.role = 'owner' and ${reservedEmail(sql`u.email`)})`;

/** เป็น Workspace ทดสอบจริง ๆ (ใช้ซ่อนจากรายการและตัวเลขธุรกิจ) */
export const isTest = (wid: SQL) => sql`coalesce(${flagOf(wid)} = 'test', ${autoTest(wid)})`;
/** ลูกค้าจริง · ใช้ใน where ของตัวเลขธุรกิจ */
export const isReal = (wid: SQL) => sql`not ${isTest(wid)}`;

/** เหตุผลที่ระบบเสนอให้ตรวจ (null = ไม่เสนอ) · เฉพาะรายการที่ยังไม่มีป้ายและไม่เข้ากฎอัตโนมัติ */
export const suggestReason = (wid: SQL, name: SQL) => sql`(case
  when ${flagOf(wid)} is not null or ${autoTest(wid)} then null
  when lower(split_part(${ownerEmail(wid)}, '@', 2)) in (select distinct lower(split_part(email, '@', 2)) from staff_users) then 'staff_domain'
  when ${name} ~* '^\\s*(qa|demo|test)([^a-z]|$)' then 'name_prefix'
  else null end)`;

/** คีย์ผู้ซื้อ: t:<เลขภาษี> หรือ u:<เจ้าของ> */
export const buyerKey = (wid: SQL) =>
  sql`coalesce('t:' || nullif((select trim(bp.tax_id) from billing_profiles bp where bp.workspace_id = ${wid}), ''), 'u:' || ${ownerOf(wid)}::text)`;
/** ชื่อบริษัทจากข้อมูลภาษี (null = ยังไม่กรอก ใช้อีเมลเจ้าของแทน) */
export const buyerCompany = (wid: SQL) => sql`nullif((select trim(bp.company_name) from billing_profiles bp where bp.workspace_id = ${wid}), '')`;
export const buyerEmail = ownerEmail;
