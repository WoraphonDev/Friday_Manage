// A30 · หน้าสาธารณะ: แพ็กเกจและเอกสารกฎหมาย · เนื้อหาเอกสารในทุกกรณีเป็นข้อความสมมติ (ไม่ใช่เอกสารกฎหมายจริง)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let outsider: Client;
const anon = () => request(t.app.getHttpServer());

async function doc(type: string, version: string, effective: string, extra: { locale?: string; body?: string } = {}) {
  const r = await t.owner.query(
    `INSERT INTO legal_documents (doc_type, version, effective_at, summary, body, locale) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [type, version, effective, `สรุป ${type} ${version}`, extra.body ?? `เนื้อหาตัวอย่างของ ${type} ${version}`, extra.locale ?? 'th'],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  outsider = await client(t.app);
  await signup(outsider, 'outsider@public.example.com', 'Outsider');
});
afterAll(() => t.close());

describe('GET public/plans', () => {
  it('ไม่ต้องล็อกอิน · ทุกแพ็กเกจพร้อมขีดจำกัด ราคา (สตางค์) และฟีเจอร์', async () => {
    const r = await anon().get('/api/v1/public/plans');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['cache-control']).toContain('public');
    expect(r.body).toMatchObject({ currency: 'THB', vatRate: 0.07, vatIncluded: false, trialDays: 14, yearlyMonths: 10 });
    expect(r.body.items.map((p: { code: string }) => p.code)).toEqual(['free', 'team_s', 'team_m', 'team_l', 'enterprise']);
    const by = Object.fromEntries(r.body.items.map((p: { code: string }) => [p.code, p]));
    expect(by.free).toMatchObject({ seatLimit: 5, projectLimit: 3, storageGbPerMember: 1, priceMonthlySatang: 0, priceYearlySatang: 0, guestsFree: true, contactSales: false });
    expect(by.team_s).toMatchObject({ seatLimit: 10, projectLimit: null, storageGbPerMember: 10, priceMonthlySatang: 150_000, priceYearlySatang: 1_500_000 });
    expect(by.team_m).toMatchObject({ seatLimit: 25, priceMonthlySatang: 300_000, priceYearlySatang: 3_000_000 });
    expect(by.team_l).toMatchObject({ seatLimit: 50, priceMonthlySatang: 550_000 });
    expect(by.enterprise).toMatchObject({ seatLimit: null, priceMonthlySatang: null, priceYearlySatang: null, contactSales: true });
    // Team ทุกขนาดฟีเจอร์เท่ากัน · Free ไม่มี Gantt
    expect(by.team_s.features).toEqual(by.team_l.features);
    expect(by.team_s.features).toContain('gantt');
    expect(by.free.features).not.toContain('gantt');
    expect(by.free.features).toContain('kanban');
  });

  it('ราคาที่ทีม Friday ตั้งในตาราง plans ชนะค่าตั้งต้น', async () => {
    await t.owner.query(`INSERT INTO plans (code, price_monthly_satang, price_yearly_satang, seat_limit) VALUES ('team_s', 123400, 1111100, 12) ON CONFLICT (code) DO UPDATE SET price_monthly_satang = 123400, price_yearly_satang = 1111100, seat_limit = 12`);
    const r = await anon().get('/api/v1/public/plans');
    expect(r.body.items.find((p: { code: string }) => p.code === 'team_s')).toMatchObject({ priceMonthlySatang: 123_400, priceYearlySatang: 1_111_100, seatLimit: 12 });
    await t.owner.query(`UPDATE plans SET price_monthly_satang = NULL, price_yearly_satang = NULL, seat_limit = 10 WHERE code = 'team_s'`);
  });

  it('ตั้งเฉพาะราคาเดือน → ราคาปี = ราคาเดือนที่ตั้ง × 10 · ตั้งเฉพาะราคาปี → ใช้ราคาปีนั้น (BUG-12)', async () => {
    const teamS = async () => (await anon().get('/api/v1/public/plans')).body.items.find((p: { code: string }) => p.code === 'team_s');
    const set = (m: number | null, y: number | null) =>
      t.owner.query(`INSERT INTO plans (code, price_monthly_satang, price_yearly_satang) VALUES ('team_s', $1, $2) ON CONFLICT (code) DO UPDATE SET price_monthly_satang = $1, price_yearly_satang = $2`, [m, y]);
    try {
      await set(200_000, null);
      expect(await teamS()).toMatchObject({ priceMonthlySatang: 200_000, priceYearlySatang: 2_000_000 });
      await set(null, 1_400_000);
      expect(await teamS()).toMatchObject({ priceMonthlySatang: 150_000, priceYearlySatang: 1_400_000 });
      await set(200_000, 1_800_000);
      expect(await teamS()).toMatchObject({ priceMonthlySatang: 200_000, priceYearlySatang: 1_800_000 });
    } finally {
      await set(null, null);
    }
    expect(await teamS()).toMatchObject({ priceMonthlySatang: 150_000, priceYearlySatang: 1_500_000 });
  });
});

describe('GET public/legal', () => {
  it('ยังไม่มีเอกสาร → 404 · ชนิดผิด → 400', async () => {
    const r = await anon().get('/api/v1/public/legal/terms');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('legal_document_not_found');
    expect((await anon().get('/api/v1/public/legal/contract')).status).toBe(400);
    expect((await anon().get('/api/v1/public/legal')).body).toEqual({ items: [] });
  });

  it('ฉบับล่าสุดที่มีผลแล้ว (ไม่เอาฉบับอนาคต) พร้อมประวัติเวอร์ชัน · เลือกภาษาและเวอร์ชันได้', async () => {
    await doc('terms', '1.0', '2026-01-01T00:00:00Z');
    await doc('terms', '1.1', '2026-06-01T00:00:00Z');
    await doc('terms', '2.0', '2999-01-01T00:00:00Z');
    await doc('terms', '1.1', '2026-06-01T00:00:00Z', { locale: 'en', body: 'English body' });
    await doc('privacy', '1.0', '2026-01-01T00:00:00Z');

    const r = await anon().get('/api/v1/public/legal/terms');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ type: 'terms', version: '1.1', locale: 'th', summary: 'สรุป terms 1.1', body: 'เนื้อหาตัวอย่างของ terms 1.1' });
    expect(r.body.versions.map((v: { version: string }) => v.version)).toEqual(['1.1', '1.0']);
    expect((await anon().get('/api/v1/public/legal/terms?version=1.0')).body.version).toBe('1.0');
    expect((await anon().get('/api/v1/public/legal/terms?version=2.0')).status).toBe(404);
    expect((await anon().get('/api/v1/public/legal/terms?locale=en')).body).toMatchObject({ locale: 'en', body: 'English body' });
    expect((await anon().get('/api/v1/public/legal/terms?locale=fr')).status).toBe(400);
    expect((await anon().get('/api/v1/public/legal/dpa')).status).toBe(404);

    const index = await anon().get('/api/v1/public/legal');
    expect(index.body.items.map((d: { type: string; version: string }) => `${d.type}@${d.version}`)).toEqual(['terms@1.1', 'privacy@1.0']);
    expect(JSON.stringify(index.body)).not.toContain('เนื้อหาตัวอย่าง');
  });
});

describe('me/legal-acceptances', () => {
  it('ต้องล็อกอิน', async () => {
    expect((await anon().get('/api/v1/me/legal-acceptances')).status).toBe(401);
    // POST ไม่มี session และไม่มี CSRF token ก็ไม่ผ่านเช่นกัน
    expect([401, 403]).toContain((await anon().post('/api/v1/me/legal-acceptances').send({ type: 'terms', version: '1.1' })).status);
  });

  it('รับทราบด้วย type + version หรือ documentId · ซ้ำไม่เปลี่ยนเวลาเดิม · บันทึก IP', async () => {
    const first = await outsider.post('/me/legal-acceptances', { type: 'terms', version: '1.1' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ alreadyAccepted: false, document: { type: 'terms', version: '1.1' }, workspace: null });
    const row = (await t.owner.query(`SELECT a.ip, a.workspace_id, a.accepted_at FROM legal_acceptances a JOIN users u ON u.id = a.user_id WHERE u.email = 'outsider@public.example.com'`)).rows;
    expect(row).toHaveLength(1);
    expect(row[0].workspace_id).toBeNull();
    expect(row[0].ip).toBeTruthy();

    const again = await outsider.post('/me/legal-acceptances', { type: 'terms', version: '1.1' });
    expect(again.body).toMatchObject({ alreadyAccepted: true, acceptedAt: first.body.acceptedAt });
    const id = (await anon().get('/api/v1/public/legal/privacy')).body.id;
    expect((await outsider.post('/me/legal-acceptances', { documentId: id })).body.document.type).toBe('privacy');
  });

  it('GET: ฉบับล่าสุดของแต่ละชนิดและรับทราบแล้วหรือยัง · ฉบับใหม่ออก → ต้องรับทราบอีก', async () => {
    const before = await outsider.get('/me/legal-acceptances');
    expect(before.body.items.map((d: { type: string; accepted: boolean }) => [d.type, d.accepted])).toEqual([['terms', true], ['privacy', true]]);
    await doc('terms', '1.2', '2026-09-01T00:00:00Z');
    const after = await outsider.get('/me/legal-acceptances');
    expect(after.body.items.find((d: { type: string }) => d.type === 'terms')).toMatchObject({ version: '1.2', accepted: false, acceptedAt: null });
    expect((await team.lead.get('/me/legal-acceptances')).body.items.every((d: { accepted: boolean }) => !d.accepted)).toBe(true);
  });

  it('ในนาม Workspace (เช่น DPA) ต้องเป็นสมาชิก · ฉบับอนาคตและเอกสารที่ไม่มีรับทราบไม่ได้ · ข้อมูลผิด 400', async () => {
    await doc('dpa', '1.0', '2026-01-01T00:00:00Z');
    const ws = await team.lead.post('/me/legal-acceptances', { type: 'dpa', version: '1.0', workspace: team.slug });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    expect(ws.body.workspace).toBe(team.slug);
    expect((await t.owner.query(`SELECT 1 FROM legal_acceptances WHERE workspace_id IS NOT NULL`)).rowCount).toBe(1);
    // ระดับบัญชีกับในนาม Workspace นับแยกกัน
    expect((await team.lead.post('/me/legal-acceptances', { type: 'dpa', version: '1.0' })).body.alreadyAccepted).toBe(false);

    expect((await outsider.post('/me/legal-acceptances', { type: 'dpa', version: '1.0', workspace: team.slug })).status).toBe(404);
    const future = (await t.owner.query(`SELECT id FROM legal_documents WHERE version = '2.0'`)).rows[0].id;
    expect((await outsider.post('/me/legal-acceptances', { documentId: future })).status).toBe(404);
    expect((await outsider.post('/me/legal-acceptances', { type: 'cookie', version: '9' })).status).toBe(404);
    expect((await outsider.post('/me/legal-acceptances', { type: 'terms' })).status).toBe(400);
    expect((await outsider.post('/me/legal-acceptances', {})).status).toBe(400);
    expect((await outsider.post('/me/legal-acceptances', { documentId: 'abc' })).status).toBe(400);
  });
});
