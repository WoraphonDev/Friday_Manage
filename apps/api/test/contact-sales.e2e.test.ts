// O54 · ฟอร์มติดต่อฝ่ายขาย → Lead · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactSalesLimit } from '../src/public/contact-sales.js';
import { client, startApp, type TestApp } from './helpers.js';

let t: TestApp;
const q = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows;
const form = { company: 'บริษัท ลานนาเทค จำกัด', contactName: 'คุณวรรณา', contactTitle: 'IT Manager', email: 'Wanna@LannaTech.example', phone: '080-000-0123', teamSize: 150, needs: ['sso', 'annual_contract'], message: 'อยากได้ SSO และสัญญารายปี', consent: true };

beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

describe('ฟอร์มติดต่อฝ่ายขาย', () => {
  it('ส่งแล้วเป็น Lead ใหม่ (ไม่ต้องล็อกอิน) · ต้องยินยอม PDPA · ส่งซ้ำภายใน 30 วันเพิ่มบันทึกในดีลเดิม', async () => {
    const c = await client(t.app);
    expect((await c.post('/public/contact-sales', { ...form, consent: false })).status).toBe(400);
    expect((await c.post('/public/contact-sales', form)).status).toBe(202);
    const [lead] = await q(`SELECT company, contact_name, email, team_size, seats, needs, source, stage, consent_at IS NOT NULL AS consent FROM leads`);
    expect(lead).toEqual({ company: 'บริษัท ลานนาเทค จำกัด', contact_name: 'คุณวรรณา', email: 'wanna@lannatech.example', team_size: 150, seats: 150, needs: ['sso', 'annual_contract'], source: 'form', stage: 'new', consent: true });
    expect((await c.post('/public/contact-sales', { ...form, teamSize: 200, message: 'เพิ่มเป็น 200 คน' })).status).toBe(202);
    expect(await q(`SELECT count(*)::int AS n FROM leads`)).toEqual([{ n: 1 }]);
    expect((await q(`SELECT body FROM lead_notes ORDER BY created_at`)).map((r) => r.body)).toEqual([expect.stringContaining('ขนาดทีม 150 คน'), expect.stringContaining('เพิ่มเป็น 200 คน')]);
  });

  it('บอท (ช่องดัก) ตอบเหมือนสำเร็จแต่ไม่บันทึก · โดเมนที่ถูกบล็อกไม่ได้ · จำกัดต่อ IP', async () => {
    t.app.get(ContactSalesLimit).reset();
    const c = await client(t.app);
    expect((await c.post('/public/contact-sales', { ...form, email: 'bot@spam.example', website: 'http://spam.example' })).status).toBe(202);
    expect(await q(`SELECT count(*)::int AS n FROM leads WHERE email = 'bot@spam.example'`)).toEqual([{ n: 0 }]);
    await t.owner.query(`INSERT INTO abuse_blocks (kind, value, reason) VALUES ('email_domain', 'blocked.example', 'สแปม')`);
    expect((await c.post('/public/contact-sales', { ...form, email: 'x@blocked.example' })).body.error.code).toBe('signup_blocked');
    for (let i = 0; i < 3; i++) await c.post('/public/contact-sales', { ...form, email: `p${i}@other.example` });
    const r = await c.post('/public/contact-sales', { ...form, email: 'p9@other.example' });
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});
