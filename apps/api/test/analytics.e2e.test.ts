// A34 · เก็บข้อมูลธุรกิจตั้งแต่วันแรก (05-business-metrics › 1) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@friday/db';
import { AnalyticsService, classifyChange, referrerHost } from '../src/analytics/analytics.service.js';
import { SYSTEM_DB } from '../src/db/db.module.js';
import { client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let analytics: AnalyticsService;
let sys: Db;
let wsId: string;
const q = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows;

beforeAll(async () => {
  t = await startApp();
  analytics = t.app.get(AnalyticsService);
  sys = t.app.get(SYSTEM_DB);
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
});
afterAll(() => t.close());

describe('ที่มาของผู้ใช้และ Workspace', () => {
  it('สมัครพร้อม UTM → เก็บเฉพาะ host ของ referrer และ path ที่ไม่มี query · สร้าง Workspace แล้วคัดลอกที่มา', async () => {
    const c = await client(t.app);
    const r = await c.post('/auth/signup', {
      email: 'ads@a34.example.com', password: 'Friday2026', displayName: 'จากโฆษณา', acceptTerms: true,
      attribution: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'pm-tool', referrer: 'https://www.google.com/search?q=secret', landingPath: '/pricing?ref=abc', firstSeenAt: '2026-11-01T10:00:00+07:00' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await q('SELECT utm_source, referrer_host, landing_path, via FROM signup_attributions WHERE user_id = $1', [r.body.id]))[0]).toEqual({ utm_source: 'google', referrer_host: 'www.google.com', landing_path: '/pricing', via: 'direct' });
    expect((await c.post('/workspaces', { name: 'Ads Co', slug: 'ads-co' })).status).toBe(201);
    expect((await q(`SELECT a.source, a.medium, a.via, a.referring_workspace_id FROM workspace_acquisitions a JOIN workspaces w ON w.id = a.workspace_id WHERE w.slug = 'ads-co'`))[0]).toEqual({ source: 'google', medium: 'cpc', via: 'signup', referring_workspace_id: null });
  });

  it('สมัครโดยไม่มีข้อมูลที่มา → แถวว่างแต่มี · ข้อมูลแปลกถูกปฏิเสธ', async () => {
    const c = await client(t.app);
    const id = await signup(c, 'plain@a34.example.com', 'ไม่มีที่มา');
    expect(await q('SELECT utm_source FROM signup_attributions WHERE user_id = $1', [id])).toEqual([{ utm_source: null }]);
    const bad = await (await client(t.app)).post('/auth/signup', { email: 'bad@a34.example.com', password: 'Friday2026', displayName: 'x', acceptTerms: true, attribution: { email: 'leak@example.com' } });
    expect(bad.status).toBe(400);
  });

  it('คนที่ถูกชวนเข้า Workspace อื่นแล้วสร้างของตัวเอง → via = invited_user พร้อม Workspace ต้นทาง', async () => {
    expect((await team.dev.post('/workspaces', { name: 'Dev Side', slug: 'dev-side' })).status).toBe(201);
    const [row] = await q(`SELECT a.via, a.referring_workspace_id FROM workspace_acquisitions a JOIN workspaces w ON w.id = a.workspace_id WHERE w.slug = 'dev-side'`);
    expect(row).toEqual({ via: 'invited_user', referring_workspace_id: wsId });
  });

  it('referrerHost รับได้ทั้ง URL และ host · ค่าเสียคืน null', () => {
    expect(referrerHost('https://Facebook.com/x?y=1')).toBe('facebook.com');
    expect(referrerHost('t.co')).toBe('t.co');
    expect(referrerHost('::::')).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
  });
});

describe('เหตุการณ์ในแอป (POST w/{ws}/events)', () => {
  const ws = () => `/w/${team.slug}`;

  it('feature.used นับครั้งแรกของวันต่อคนต่อฟีเจอร์ · limit.hit บันทึกทุกครั้ง', async () => {
    const a = await team.lead.post(`${ws()}/events`, { events: [{ name: 'feature.used', props: { feature: 'gantt' } }, { name: 'feature.used', props: { feature: 'gantt' } }, { name: 'limit.hit', props: { limit: 'seats', current: 10, max: 10 } }] });
    expect(a.status, JSON.stringify(a.body)).toBe(202);
    expect(a.body).toEqual({ accepted: 2 });
    expect((await team.lead.post(`${ws()}/events`, { events: [{ name: 'feature.used', props: { feature: 'gantt' } }] })).body).toEqual({ accepted: 0 });
    expect((await team.dev.post(`${ws()}/events`, { events: [{ name: 'feature.used', props: { feature: 'gantt' } }] })).body).toEqual({ accepted: 1 });
    const rows = await q(`SELECT name, props, user_id FROM product_events WHERE workspace_id = $1 ORDER BY occurred_at`, [wsId]);
    expect(rows.map((r) => r.name)).toEqual(['feature.used', 'limit.hit', 'feature.used']);
  });

  it('props ห้ามมีข้อมูลอื่น · ชื่อเหตุการณ์ต้องอยู่ในรายการ · ส่งได้ไม่เกิน 50', async () => {
    expect((await team.lead.post(`${ws()}/events`, { events: [{ name: 'feature.used', props: { feature: 'gantt', title: 'ชื่องานลับ' } }] })).status).toBe(400);
    expect((await team.lead.post(`${ws()}/events`, { events: [{ name: 'issue.viewed', props: {} }] })).status).toBe(400);
    expect((await team.lead.post(`${ws()}/events`, { events: Array.from({ length: 51 }, () => ({ name: 'onboarding.step_done', props: { step: 'x' } })) })).status).toBe(400);
    const stranger = await client(t.app);
    await signup(stranger, 'stranger@a34.example.com', 'คนนอก');
    expect((await stranger.post(`${ws()}/events`, { events: [{ name: 'feature.used', props: { feature: 'table' } }] })).status).toBe(404);
  });
});

describe('แพ็กเกจและการยกเลิก', () => {
  it('classifyChange: ใหม่ อัปเกรด ลดแพ็กเกจ เปลี่ยนรอบ กลับมาใช้ และต่ออายุเหมือนเดิม', () => {
    expect(classifyChange({ plan: 'team_s', status: 'trialing', cycle: 'monthly' }, { plan: 'team_s', cycle: 'monthly' })).toBe('new');
    expect(classifyChange({ plan: 'team_s', status: 'active', cycle: 'monthly' }, { plan: 'team_m', cycle: 'monthly' })).toBe('upgrade');
    expect(classifyChange({ plan: 'team_l', status: 'active', cycle: 'monthly' }, { plan: 'team_m', cycle: 'monthly' })).toBe('downgrade');
    expect(classifyChange({ plan: 'team_m', status: 'active', cycle: 'monthly' }, { plan: 'team_m', cycle: 'yearly' })).toBe('cycle_change');
    expect(classifyChange({ plan: 'team_m', status: 'canceled', cycle: 'monthly' }, { plan: 'team_m', cycle: 'monthly' })).toBe('reactivate');
    expect(classifyChange({ plan: 'team_m', status: 'active', cycle: 'monthly' }, { plan: 'team_m', cycle: 'monthly' })).toBeNull();
  });

  it('MRR ก่อนเปลี่ยนต่อจากรายการล่าสุดของ Workspace', async () => {
    await analytics.subscriptionChanged(sys, { workspaceId: wsId, kind: 'new', planFrom: null, planTo: 'team_s', mrrAfterSatang: 100_000, actorKind: 'system', actorId: null, effectiveAt: new Date('2026-10-01') });
    await analytics.subscriptionChanged(sys, { workspaceId: wsId, kind: 'upgrade', planFrom: 'team_s', planTo: 'team_m', mrrAfterSatang: 260_000.4, actorKind: 'system', actorId: null, effectiveAt: new Date('2026-11-01') });
    expect(await q(`SELECT kind, mrr_before_satang::int AS b, mrr_after_satang::int AS a FROM subscription_changes WHERE workspace_id = $1 ORDER BY effective_at`, [wsId])).toEqual([
      { kind: 'new', b: 0, a: 100_000 },
      { kind: 'upgrade', b: 100_000, a: 260_000 },
    ]);
  });

  it('แบบสอบถามตอนยกเลิกตอบได้เฉพาะ Owner · ยกเลิกแพ็กเกจที่จ่ายเงินบันทึก MRR เป็น 0 ณ สิ้นรอบ', async () => {
    const ws = `/w/${team.slug}`;
    const body = { reason: 'missing_feature', missingFeature: 'บันทึกเวลา', outcome: 'canceled' };
    expect((await team.dev.post(`${ws}/cancellation-feedback`, body)).status).toBe(403);
    const f = await team.lead.post(`${ws}/cancellation-feedback`, body);
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect((await q('SELECT reason, missing_feature, offer_shown FROM cancellation_responses WHERE workspace_id = $1', [wsId]))[0]).toEqual({ reason: 'missing_feature', missing_feature: 'บันทึกเวลา', offer_shown: 'none' });

    await t.owner.query(`UPDATE subscriptions SET status = 'active', current_period_end = now() + interval '20 days', plan_id = (SELECT id FROM plans WHERE code = 'team_m') WHERE workspace_id = $1`, [wsId]);
    const c = await team.lead.post(`${ws}/billing/subscription:cancel`, {});
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const [last] = await q(`SELECT kind, plan_from, mrr_before_satang::int AS b, mrr_after_satang::int AS a, actor_kind FROM subscription_changes WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [wsId]);
    expect(last).toEqual({ kind: 'cancel', plan_from: 'team_m', b: 260_000, a: 0, actor_kind: 'user' });
  });
});

describe('ยอดใช้รายวันและ PDPA', () => {
  it('สรุปยอดส่ง LINE / อีเมล / Webhook ของวันนั้น (เวลาไทย) · รันซ้ำได้ค่าเดิม', async () => {
    const [n] = await q(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload) VALUES ($1, $2, 'issue.created', '{}') RETURNING id`, [wsId, team.leadId]);
    const at = '2026-11-08T10:00:00+07:00';
    for (const [i, [channel, status]] of [['line', 'sent'], ['line_group', 'sent'], ['email', 'sent'], ['email', 'failed'], ['webhook', 'sent']].entries()) {
      await t.owner.query(`INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [wsId, n.id, channel, `target-${i}`, status, at]);
    }
    // ข้ามเที่ยงคืนเวลาไทยไปแล้ว ไม่นับในวันที่ 8
    await t.owner.query(`INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref, status, created_at) VALUES ($1, $2, 'line', 'target-next', 'sent', '2026-11-09T00:30:00+07:00')`, [wsId, n.id]);
    await analytics.rollupDailyUsage('2026-11-08');
    await analytics.rollupDailyUsage('2026-11-08');
    expect(await q(`SELECT line_messages, emails, webhook_calls FROM daily_usages WHERE workspace_id = $1 AND date = '2026-11-08'`, [wsId])).toEqual([{ line_messages: 2, emails: 1, webhook_calls: 1 }]);
  });

  it('ลืมผู้ใช้: ลบที่มา และทำให้เหตุการณ์ / แบบสอบถามระบุตัวไม่ได้ แต่ตัวเลขรวมยังอยู่', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM product_events WHERE workspace_id = $1`, [wsId]))[0].n;
    await analytics.forgetUser(team.leadId);
    expect(await q('SELECT 1 FROM signup_attributions WHERE user_id = $1', [team.leadId])).toEqual([]);
    expect((await q(`SELECT count(*)::int AS n FROM product_events WHERE user_id = $1`, [team.leadId]))[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM product_events WHERE workspace_id = $1`, [wsId]))[0].n).toBe(before);
    expect((await q('SELECT user_id FROM cancellation_responses WHERE workspace_id = $1', [wsId]))[0].user_id).toBeNull();
  });
});
