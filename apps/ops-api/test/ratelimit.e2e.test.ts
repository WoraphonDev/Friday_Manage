// O51 · Rate limit ต่อลูกค้า · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AbuseService } from '../src/abuse/abuse.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let boss: Staff;
let eng: Staff;
let sam: Staff;
let pixel: Customer;
let harbor: Customer;
let lumen: Customer;
let ciBot: string;

async function token(c: Customer, name: string) {
  return (await t.owner.query(`INSERT INTO api_tokens (workspace_id, name, token_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [c.id, name, randomUUID(), c.owner])).rows[0].id as string;
}
/** สถิติรายนาที: นาทีที่ from..to นาทีก่อน (ตัวเลขมาก = เก่ากว่า) */
async function minutes(c: Customer, tok: string, route: string, from: number, to: number, calls: number, rejected: number, limit: number | null) {
  await t.owner.query(
    `INSERT INTO api_usage_minutes (workspace_id, minute, token_id, route, calls, rejected, limit_rpm)
     SELECT $1, date_trunc('minute', now()) - (n || ' minutes')::interval, $2, $3, $4, $5, $6 FROM generate_series($7::int, $8::int) n`,
    [c.id, tok, route, calls, rejected, limit, to, from],
  );
}

beforeAll(async () => {
  t = await startOps();
  boss = await staff(t, 'boss@friday.example.com', 'บอส ตัวอย่าง', ['owner']);
  eng = await staff(t, 'eng@friday.example.com', 'วิศวกร เอ', ['engineer']);
  sam = await staff(t, 'sam@friday.example.com', 'Sam Support', 'support');
  // ชนเพดานต่อเนื่อง 40 นาทีจนถึงตอนนี้ (ระบบวนเรียกซ้ำ)
  pixel = await customer(t, 'pixel-forge', { plan: 'team_m', status: 'active' });
  ciBot = await token(pixel, 'ci-bot');
  await minutes(pixel, ciBot, 'GET /w/:ws/issues', 40, 1, 1790, 1670, 120);
  await minutes(pixel, await token(pixel, 'web-hook-relay'), 'POST /w/:ws/issues/:key/comments', 40, 1, 42, 0, 120);
  // ปรับเฉพาะรายเป็น 300 · ชนเพดานสั้น ๆ เมื่อ 3 ชม. ก่อน
  harbor = await customer(t, 'harbor-logistics', { plan: 'team_m', status: 'active' });
  await t.owner.query(`INSERT INTO entitlement_overrides (workspace_id, key, value, expires_at, reason, created_by) VALUES ($1, 'api_rpm', '300', now() + interval '10 days', 'ย้ายระบบ ERP', $2)`, [harbor.id, boss.id]);
  await minutes(harbor, await token(harbor, 'erp-sync'), 'PUT /w/:ws/issues/:key', 185, 180, 412, 112, 300);
  // ใกล้เพดาน 50/60 แต่ไม่ถูกปฏิเสธ
  lumen = await customer(t, 'lumen-studio', { plan: 'team_s', status: 'active' });
  await minutes(lumen, await token(lumen, 'zapier'), 'GET /w/:ws/projects', 30, 10, 50, 0, 60);
  // ใช้น้อย ไม่ขึ้นแท็บไหน
  const quiet = await customer(t, 'quiet-co', { plan: 'team_s', status: 'active' });
  await minutes(quiet, await token(quiet, 'report'), 'GET /w/:ws/issues', 5, 1, 3, 0, 60);
});
afterAll(() => t.close());

describe('Rate limit ต่อลูกค้า', () => {
  it('สิทธิ์: Owner / วิศวกร · ตัวเลขหัวหน้า · ต้องทำตอนนี้ = ชนเพดานติดกันเกิน 15 นาที · ตัวนับในภาพรวม', async () => {
    expect((await sam.agent.get('/ops/ratelimit/summary')).status).toBe(403);
    const s = (await eng.agent.get('/ops/ratelimit/summary').expect(200)).body;
    expect(s).toMatchObject({ limited24h: 2, rejected24h: 40 * 1670 + 6 * 112, tabs: { limited: 2, near: 1, overrides: 1 }, streakAlert: 15 });
    expect(s.todo).toEqual([expect.objectContaining({ id: pixel.id, plan: 'team_m', limit: 120, curStreak: 40, topToken: 'ci-bot' })]);
    expect((await boss.agent.get('/ops/overview').expect(200)).body.tasks.rateLimitStreak).toBe(1);
  });

  it('แท็บและตัวกรองที่ server', async () => {
    const limited = (await eng.agent.get('/ops/ratelimit/workspaces').expect(200)).body;
    expect(limited.items.map((x: { slug: string }) => x.slug)).toEqual(['pixel-forge', 'harbor-logistics']);
    expect(limited.items[0]).toMatchObject({ peak: 1832, rejected: 66_800, maxStreak: 40, override: null, base: 120 });
    expect(limited.items[1]).toMatchObject({ limit: 300, override: { value: 300 }, maxStreak: 6 });
    expect((await eng.agent.get('/ops/ratelimit/workspaces?q=CI-BOT')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['pixel-forge']);
    expect((await eng.agent.get('/ops/ratelimit/workspaces?overridden=yes')).body.total).toBe(1);
    expect((await eng.agent.get('/ops/ratelimit/workspaces?minStreak=30')).body.total).toBe(1);
    expect((await eng.agent.get('/ops/ratelimit/workspaces?plan=team_s')).body.total).toBe(0);
    expect((await eng.agent.get('/ops/ratelimit/workspaces?tab=near')).body.items).toEqual([expect.objectContaining({ slug: 'lumen-studio', usagePct: 83 })]);
    expect((await eng.agent.get('/ops/ratelimit/workspaces?tab=overrides')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['harbor-logistics']);
    expect((await eng.agent.get('/ops/ratelimit/workspaces?tab=bogus')).status).toBe(400);
  });

  it('แผงขวา: กราฟรายนาที + แยกตาม token / endpoint', async () => {
    const d = (await eng.agent.get(`/ops/ratelimit/workspaces/${pixel.id}`).expect(200)).body;
    expect(d.series).toHaveLength(40);
    expect(d.series[0]).toMatchObject({ calls: 1832, rejected: 1670, limit: 120 });
    expect(d.breakdown.map((b: { token: string; route: string; peak: number }) => [b.token, b.route, b.peak])).toEqual([
      ['ci-bot', 'GET /w/:ws/issues', 1790],
      ['web-hook-relay', 'POST /w/:ws/issues/:key/comments', 42],
    ]);
    expect(d).toMatchObject({ override: null, lastNotifiedAt: null, headroom: 3, stats: { curStreak: 40 } });
    expect((await eng.agent.get(`/ops/ratelimit/workspaces/${randomUUID()}`)).status).toBe(404);
  });

  it('แจ้ง Owner ของลูกค้า · ลูกค้าเห็นใน Audit log · ซ้ำภายใน 1 ชม. ไม่ได้', async () => {
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    expect((await eng.agent.post(`/ops/ratelimit/workspaces/${pixel.id}/notify`).send({ note: 'ดูเหมือน CI วนเรียกซ้ำ' }).expect(201)).body).toEqual({ sent: 1, recipients: 1 });
    expect(mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'owner@pixel-forge.example.com', subject: 'การเรียก API ของ Co pixel-forge ชนเพดาน', text: expect.stringContaining('token "ci-bot"') })]);
    const log = await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.ratelimit_notified'`, [pixel.id]);
    expect(log.rows[0].summary).toContain('[Friday วิศวกร เอ]');
    expect((await eng.agent.post(`/ops/ratelimit/workspaces/${pixel.id}/notify`).send({})).body.error.code).toBe('notified_recently');
  });

  it('ปรับเพดานชั่วคราว: แตะกุญแจ · ไม่เกิน 3 เท่าทำได้เลย (override เดิมของ O21) · เกินขออนุมัติ Owner', async () => {
    const body = { value: 360, days: 7, reason: 'ลูกค้าย้ายข้อมูลครั้งเดียว' };
    expect((await eng.agent.post(`/ops/ratelimit/workspaces/${pixel.id}/limit`).send(body)).body.error.code).toBe('reauth_required');
    await reauth(eng);
    expect((await eng.agent.post(`/ops/ratelimit/workspaces/${pixel.id}/limit`).send({ ...body, days: 60 })).status).toBe(400);
    await eng.agent.post(`/ops/ratelimit/workspaces/${pixel.id}/limit`).send(body).expect(201);
    const ov = await t.owner.query(`SELECT value, reason, expires_at > now() + interval '6 days' AS week FROM entitlement_overrides WHERE workspace_id = $1 AND key = 'api_rpm' AND revoked_at IS NULL`, [pixel.id]);
    expect(ov.rows).toEqual([{ value: 360, reason: expect.stringContaining('ลูกค้าย้ายข้อมูลครั้งเดียว'), week: true }]);
    const d = (await eng.agent.get(`/ops/ratelimit/workspaces/${pixel.id}`)).body;
    expect(d.override).toMatchObject({ value: 360 });
    // หน้าสิทธิ์และขีดจำกัดเห็นค่าเดียวกัน
    expect((await eng.agent.get('/ops/entitlements')).body.overrides.some((o: { workspace: { id: string }; value: number }) => o.workspace.id === pixel.id && o.value === 360)).toBe(true);
    const r = await eng.agent.post(`/ops/ratelimit/workspaces/${pixel.id}/limit`).send({ ...body, value: 400 });
    expect(r.status).toBe(202);
    expect(r.body.pendingApproval).toMatchObject({ kind: 'entitlements.override' });
    const rule = await t.owner.query(`SELECT payload->>'rule' AS rule FROM approval_requests WHERE id = $1`, [r.body.pendingApproval.id]);
    expect(rule.rows[0].rule).toContain('เกิน 3 เท่า');
  });

  it('ตรวจจับการใช้ผิด: กฎชนเพดาน API เกิน 15 นาทีเปิดใช้ได้แล้ว', async () => {
    const rules = (await boss.agent.get('/ops/abuse/rules')).body.rules;
    expect(rules.find((x: { key: string }) => x.key === 'api_ratelimit')).toMatchObject({ on: true, waiting: null, points: 30 });
    await t.owner.query(`INSERT INTO ops_settings (key, value) VALUES ('abuse', '{"review": 25, "autoSuspend": 95}')`);
    await t.app.get(AbuseService).scan();
    const cases = (await boss.agent.get('/ops/abuse/cases?tab=todo')).body.items;
    expect(cases).toEqual([expect.objectContaining({ kind: 'api_abuse', label: 'Co pixel-forge (pixel-forge)', score: 30, signals: [expect.objectContaining({ rule: 'api_ratelimit', detail: 'ชนเพดาน API ติดกัน 40 นาที (token "ci-bot")' })] })]);
  });
});
