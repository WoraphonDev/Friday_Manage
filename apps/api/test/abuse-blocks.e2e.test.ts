// O50 · รายชื่อที่ทีม Friday บล็อก: ปฏิเสธการสมัคร / slug · เก็บ IP ตอนสมัคร · ข้อมูลสมมติเท่านั้น (IP ช่วงเอกสาร)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientIp } from '../src/auth/abuse-blocks.js';
import { client, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
const q = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows;

/** สมัครจาก IP ที่กำหนด (bootstrap ตั้ง trust proxy 1 จึงอ่าน X-Forwarded-For) */
async function signupFrom(ip: string, email: string) {
  const agent = request.agent(t.app.getHttpServer());
  const { body } = await agent.get('/api/v1/auth/csrf');
  return agent.post('/api/v1/auth/signup').set({ 'x-csrf-token': body.csrfToken, 'x-forwarded-for': ip }).send({ email, password: 'Friday2026', displayName: 'ทดสอบ', acceptTerms: true });
}

beforeAll(async () => {
  t = await startApp();
  await t.owner.query(`INSERT INTO abuse_blocks (kind, value, reason) VALUES ('email_domain', 'tempmail.example', 'โดเมนชั่วคราว'), ('ip', '198.51.100.0/24', 'บอทสมัครเป็นชุด'), ('workspace_slug', 'free-money', 'ชื่อหลอกลวง')`);
  // บล็อกที่หมดอายุแล้ว / เลิกบล็อกแล้ว ไม่มีผล
  await t.owner.query(`INSERT INTO abuse_blocks (kind, value, reason, expires_at) VALUES ('ip', '192.0.2.10', 'หมดแล้ว', now() - interval '1 day')`);
  await t.owner.query(`INSERT INTO abuse_blocks (kind, value, reason, removed_at) VALUES ('email_domain', 'old-block.example', 'เลิกแล้ว', now())`);
});
afterAll(() => t.close());

describe('รายชื่อที่ถูกบล็อก (O50)', () => {
  it('IPv4 ในรูป IPv6 แปลงกลับ · ค่าที่ไม่ใช่ IP = null', () => {
    expect(clientIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp('unknown')).toBeNull();
    expect(clientIp(undefined)).toBeNull();
  });

  it('สมัครด้วยโดเมนหรือ IP ที่ถูกบล็อกไม่ได้ · ไม่สร้างบัญชี', async () => {
    const byDomain = await signupFrom('203.0.113.7', 'spam@TempMail.example');
    expect(byDomain.status).toBe(403);
    expect(byDomain.body.error.code).toBe('signup_blocked');
    const byIp = await signupFrom('198.51.100.42', 'real@blocked-ip.example.com');
    expect(byIp.body.error.code).toBe('signup_blocked');
    expect(await q(`SELECT 1 FROM users WHERE email IN ('spam@tempmail.example', 'real@blocked-ip.example.com')`)).toEqual([]);
  });

  it('บล็อกที่หมดอายุ / เลิกแล้วไม่มีผล · เก็บ IP ตอนสมัคร', async () => {
    const ok = await signupFrom('192.0.2.10', 'fine@old-block.example');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await q('SELECT signup_ip FROM signup_attributions WHERE user_id = $1', [ok.body.id])).toEqual([{ signup_ip: '192.0.2.10' }]);
  });

  it('slug ที่ถูกบล็อกตอบเหมือนมีคนใช้แล้ว', async () => {
    const c = await client(t.app);
    await signup(c, 'maker@slug-test.example.com', 'คนสร้าง');
    expect((await c.get('/workspaces/slug-available?slug=free-money')).body.available).toBe(false);
    const r = await c.post('/workspaces', { name: 'Free Money', slug: 'free-money' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('slug_taken');
    expect((await c.post('/workspaces', { name: 'Honest Co', slug: 'honest-co' })).status).toBe(201);
  });
});
