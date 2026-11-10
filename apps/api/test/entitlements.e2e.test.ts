// O21 · สิทธิ์ตามแพ็กเกจแบบมีเวอร์ชัน + ปรับเฉพาะราย ที่ API ลูกค้าบังคับ (402 / 429) · ข้อมูลสมมติเท่านั้น
import { DEFAULT_MATRIX } from '@friday/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlanLimits } from '../src/core/plan-limits.js';
import { addMember, client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let staffId: string;

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

/** เวอร์ชันใหม่ที่แก้บางช่องจากค่าตั้งต้น */
async function version(n: number, effectiveAt: string, patch: Record<string, Record<string, unknown>>) {
  const matrix = structuredClone(DEFAULT_MATRIX) as Record<string, Record<string, unknown>>;
  for (const [plan, values] of Object.entries(patch)) Object.assign(matrix[plan], values);
  await t.owner.query('INSERT INTO entitlement_versions (version, matrix, effective_at, reason) VALUES ($1, $2, $3, $4)', [n, JSON.stringify(matrix), effectiveAt, 'ทดสอบ']);
}
async function override(key: string, value: unknown, expiresAt: string | null = iso(30)) {
  await t.owner.query('INSERT INTO entitlement_overrides (workspace_id, key, value, expires_at, contract_ref, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    wsId, key, JSON.stringify(value), expiresAt, expiresAt ? null : 'ENT-TEST-001', 'ทดสอบ', staffId,
  ]);
}
async function setPlan(code: string, status: string, periodStart: string | null) {
  await team.lead.get(`${team.ws}/usage`);
  await t.owner.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = $2), status = $3, trial_ends_at = NULL,
       current_period_start = $4, current_period_end = $5 WHERE workspace_id = $1`,
    [wsId, code, status, periodStart, iso(20)],
  );
}
const reset = async () => {
  await t.owner.query('DELETE FROM entitlement_overrides');
  await t.owner.query('TRUNCATE entitlement_versions CASCADE');
};

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  staffId = (await t.owner.query(`INSERT INTO staff_users (email, name, roles) VALUES ('ent-owner@friday.test', 'Owner ทดสอบ', '{owner}') RETURNING id`)).rows[0].id;
});
afterAll(() => t.close());

describe('ขีดจำกัดจากเวอร์ชันสิทธิ์', () => {
  it('ไม่มีเวอร์ชันเลย ใช้ค่าตั้งต้นเหมือนเดิม', async () => {
    await reset();
    const r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ plan: { code: 'team_s' }, seats: { limit: 10 }, entitlements: { version: 0 } });
  });

  it('เวอร์ชันใหม่มีผลทันทีกับทดลองใช้ · ลดที่นั่งแล้วเพิ่มคนเกินได้ 402', async () => {
    await reset();
    await version(1, iso(-60), {});
    await version(2, iso(-1), { team_s: { seats: 2 } });
    const r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ seats: { used: 2, limit: 2 }, entitlements: { version: 2, grace: [] } });
    const res = await team.lead.post(`${team.ws}/invitations`, { emails: ['new@ent.example.com'], workspaceRole: 'member' });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'plan_limit_reached', details: { kind: 'seats', limit: 2 } });
  });

  it('เวอร์ชันที่ยังไม่ถึงวันมีผลยังไม่ใช้', async () => {
    await reset();
    await version(1, iso(-60), {});
    await version(2, iso(5), { team_s: { seats: 2 } });
    expect((await team.lead.get(`${team.ws}/usage`)).body).toMatchObject({ seats: { limit: 10 }, entitlements: { version: 1 } });
  });

  it('ลูกค้าที่จ่ายแล้วถูกลดสิทธิ์ใช้ค่าเดิมจนจบรอบบิล · รอบใหม่ใช้ค่าใหม่', async () => {
    await reset();
    await version(1, iso(-60), {});
    await version(2, iso(-1), { team_s: { seats: 2, projects: 1 } });
    await setPlan('team_s', 'active', iso(-10));
    let r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ seats: { limit: 10 }, projects: { limit: null }, entitlements: { version: 2 } });
    expect(r.body.entitlements.grace.sort()).toEqual(['projects', 'seats']);
    await setPlan('team_s', 'active', iso(0));
    r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ seats: { limit: 2 }, projects: { limit: 1 }, entitlements: { grace: [] } });
  });

  it('เพิ่มสิทธิ์มีผลทันทีแม้อยู่กลางรอบ', async () => {
    await reset();
    await version(1, iso(-60), {});
    await version(2, iso(-1), { team_s: { seats: 12 } });
    await setPlan('team_s', 'active', iso(-10));
    expect((await team.lead.get(`${team.ws}/usage`)).body.seats.limit).toBe(12);
  });
});

describe('ปรับเฉพาะราย', () => {
  it('override ที่นั่งและพื้นที่รวมชนะค่าของแพ็กเกจ · หมดอายุแล้วไม่มีผล', async () => {
    await reset();
    await version(1, iso(-60), {});
    await setPlan('team_s', 'active', iso(-10));
    await override('seats', 30);
    await override('storage_gb', 200);
    let r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ seats: { limit: 30 }, storage: { limitGb: 200 } });
    await t.owner.query(`UPDATE entitlement_overrides SET expires_at = now() - interval '1 minute'`);
    r = await team.lead.get(`${team.ws}/usage`);
    expect(r.body).toMatchObject({ seats: { limit: 10 }, storage: { limitGb: 20 } });
  });

  it('override ตามสัญญาไม่มีวันหมดอายุ และถูกยกเลิกแล้วไม่มีผล', async () => {
    await reset();
    await setPlan('team_s', 'active', iso(-10));
    await override('seats', 40, null);
    expect((await team.lead.get(`${team.ws}/usage`)).body.seats.limit).toBe(40);
    await t.owner.query('UPDATE entitlement_overrides SET revoked_at = now()');
    expect((await team.lead.get(`${team.ws}/usage`)).body.seats.limit).toBe(10);
  });
});

describe('ฟีเจอร์ตามแพ็กเกจ', () => {
  it('Free ใช้ Webhook, Automation, API token และ Import โหมดอัปเดตไม่ได้ → 402 plan_feature_unavailable', async () => {
    await reset();
    await setPlan('free', 'active', null);
    const hook = await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'Slack', format: 'slack', url: 'https://hooks.example.com/x', generateSecret: true });
    expect(hook.status).toBe(402);
    expect(hook.body.error).toMatchObject({ code: 'plan_feature_unavailable', details: { kind: 'feature', feature: 'channels', plan: 'free', suggestedPlan: 'team_s' } });
    const rule = await team.lead.post(`${team.ws}/projects/${team.key}/automations`, { name: 'x', trigger: 'issue_created', actions: [{ type: 'set_priority', priority: 'low' }] });
    expect(rule.status).toBe(402);
    expect(rule.body.error.details.feature).toBe('automation');
    const token = await team.lead.post(`${team.ws}/api-tokens`, { name: 'CI', scopes: ['read'] });
    expect(token.status).toBe(402);
    // Guest ยังใช้ได้ใน Free (หน้าราคา: Guest ไม่นับที่นั่ง)
    expect((await team.lead.post(`${team.ws}/invitations`, { emails: ['guest@ent.example.com'], workspaceRole: 'guest' })).status).toBe(201);
  });

  it('override เปิดฟีเจอร์ให้รายเดียว · เวอร์ชันปิด Guest แล้วเชิญ Guest ไม่ได้', async () => {
    await reset();
    await version(1, iso(-60), { free: { guests: false } });
    await setPlan('free', 'active', null);
    const g = await team.lead.post(`${team.ws}/invite-links`, { role: 'guest' });
    expect(g.status).toBe(402);
    expect(g.body.error.details.feature).toBe('guests');
    await t.owner.query(`INSERT INTO entitlement_overrides (workspace_id, key, value, expires_at, reason, created_by) VALUES ($1, 'automation', 'true', now() + interval '7 days', 'ทดลอง', $2)`, [wsId, staffId]);
    const rule = await team.lead.post(`${team.ws}/projects/${team.key}/automations`, { name: 'x', trigger: 'issue_created', actions: [{ type: 'set_priority', priority: 'low' }] });
    expect(rule.status).toBe(201);
  });
});

describe('API ต่อนาที และ Automation ต่อเดือน', () => {
  it('คำขอผ่าน API token เกินโควตาต่อนาทีได้ 429 พร้อม Retry-After', async () => {
    await reset();
    await version(1, iso(-60), { team_s: { api_rpm: 2 } });
    await setPlan('team_s', 'active', iso(-10));
    const minted = await team.lead.post(`${team.ws}/api-tokens`, { name: 'CI', scopes: ['read'] });
    expect(minted.status).toBe(201);
    const call = () => request(t.app.getHttpServer()).get(`/api/v1${team.ws}/projects`).set('authorization', `Bearer ${minted.body.token}`);
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('Automation ครบโควตาเดือนนี้แล้วถูกข้าม', async () => {
    await reset();
    await version(1, iso(-60), { team_s: { automation_runs: 1 } });
    await setPlan('team_s', 'active', iso(-10));
    const limits = t.app.get(PlanLimits);
    expect(await limits.automationAllowed(wsId)).toEqual({ ok: true, limit: 1, used: 0 });
    const rule = (await t.owner.query(`INSERT INTO automation_rules (workspace_id, project_id, name, trigger, actions, created_by) VALUES ($1, $2, 'r', 'issue_created', '[]', $3) RETURNING id`, [wsId, team.project.id, team.leadId])).rows[0].id;
    await t.owner.query(`INSERT INTO automation_runs (workspace_id, rule_id, result) VALUES ($1, $2, 'success'), ($1, $2, 'skipped')`, [wsId, rule]);
    expect(await limits.automationAllowed(wsId)).toEqual({ ok: false, limit: 1, used: 1 });
  });

  it('สมาชิกใหม่ของ Workspace ที่ไม่ใช่ Guest ยังตรวจที่นั่งเหมือนเดิม', async () => {
    await reset();
    await setPlan('team_s', 'active', iso(-10));
    const c = await client(t.app);
    const id = await signup(c, 'extra@ent.example.com', 'Extra');
    await addMember(t.owner, team.slug, id, 'member');
    expect((await team.lead.get(`${team.ws}/usage`)).body.seats.used).toBe(3);
  });
});
