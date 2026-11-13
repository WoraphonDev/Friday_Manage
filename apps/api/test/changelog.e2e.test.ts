// A42 · มีอะไรใหม่ (U1) · Spotlight (U2) · แบบสำรวจ NPS (U3) ของแอปลูกค้า
// changelog_entries / nps_settings เขียนโดย ops-api (O33) · test จำลองแถวด้วยบัญชีเจ้าของตาราง · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sampled } from '../src/changelog/nps.service.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let other: Awaited<ReturnType<typeof seedTeam>>;
let admin: Client;
let adminId: string;
let guest: Client;
let wsId: string;
let otherWs: string;

interface Entry {
  title: string;
  kind?: 'new' | 'improved' | 'fixed';
  status?: 'draft' | 'scheduled' | 'published' | 'hidden';
  /** นาทีจากตอนนี้ (ลบ = ที่ผ่านมา) */
  at?: number;
  audience?: 'all' | 'plans' | 'flag' | 'admins';
  plans?: string[];
  flag?: string;
  spotlight?: boolean;
  cta?: boolean;
}
async function entry(x: Entry) {
  const r = await t.owner.query(
    `INSERT INTO changelog_entries (kind, title, summary, body, status, published_at, audience, audience_plans, audience_flag, spotlight, cta_label, cta_path, hidden_at, hide_reason, media_url, media_kind, media_alt)
     VALUES ($1, $2, $3, '- ข้อแรก\n- ข้อสอง', $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END, $6, $7, $8, $9,
       CASE WHEN $10 THEN 'ลองใช้' END, CASE WHEN $10 THEN '/profile?tab=notify' END,
       CASE WHEN $4 = 'hidden' THEN now() END, CASE WHEN $4 = 'hidden' THEN 'ทดสอบซ่อน' END,
       CASE WHEN $10 THEN 'https://cdn.example.com/changelog/line.png' END, CASE WHEN $10 THEN 'image' END, CASE WHEN $10 THEN 'ภาพตัวอย่าง' END)
     RETURNING id`,
    [x.kind ?? 'new', x.title, `สรุปของ ${x.title}`, x.status ?? 'published', x.status === 'draft' ? null : (x.at ?? -60), x.audience ?? 'all', x.plans ?? [], x.flag ?? null, x.spotlight ?? false, x.cta ?? false],
  );
  return r.rows[0].id as string;
}
const titles = (r: { body: { items: { title: string }[] } }) => r.body.items.map((i) => i.title);
const stats = async (id: string) => (await t.owner.query('SELECT views, clicks FROM changelog_stats WHERE entry_id = $1', [id])).rows[0] ?? { views: 0, clicks: 0 };

/** ตั้งค่า NPS ให้ "ถามได้เสมอ" แล้วให้แต่ละ test เปิดเกณฑ์ที่ต้องการตรวจ */
async function npsSettings(over: Record<string, unknown> = {}) {
  const v = { enabled: true, audience: 'admins', first_after_days: 0, repeat_days: 90, sample_pct: 100, exclude_trial_days: null, exclude_ticket_days: null, exclude_spotlight_day: false, ...over };
  await t.owner.query('DELETE FROM nps_settings');
  await t.owner.query(
    `INSERT INTO nps_settings (id, enabled, audience, first_after_days, repeat_days, sample_pct, exclude_trial_days, exclude_ticket_days, exclude_spotlight_day) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
    [v.enabled, v.audience, v.first_after_days, v.repeat_days, v.sample_pct, v.exclude_trial_days, v.exclude_ticket_days, v.exclude_spotlight_day],
  );
}
const prompt = (c: Client, slug = team.slug) => c.get(`/me/nps-prompt?workspace=${slug}`);

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'nova-demo' });
  admin = await client(t.app);
  adminId = await signup(admin, 'admin@nova-demo.example.com', 'Ploy');
  await addMember(t.owner, team.slug, adminId, 'admin');
  guest = await client(t.app);
  const guestId = await signup(guest, 'guest@nova-demo.example.com', 'Guest');
  await addMember(t.owner, team.slug, guestId, 'guest');
  other = await seedTeam(t, { slug: 'pine-demo', key: 'PN' });
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  otherWs = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [other.slug])).rows[0].id;
  // ให้แพ็กเกจของ Workspace แน่นอน (ไม่พึ่งช่วงทดลอง): nova = Team M ที่จ่ายแล้ว · pine = ทดลอง Team S
  await team.lead.get(`${team.ws}/usage`);
  await other.lead.get(`${other.ws}/usage`);
  await t.owner.query(`INSERT INTO plans (code) VALUES ('free'), ('team_s'), ('team_m'), ('team_l'), ('enterprise') ON CONFLICT (code) DO NOTHING`);
  await t.owner.query(`UPDATE subscriptions SET status = 'active', plan_id = (SELECT id FROM plans WHERE code = 'team_m'), current_period_start = now() - interval '5 days', current_period_end = now() + interval '25 days' WHERE workspace_id = $1`, [wsId]);
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const table of ['nps_responses', 'user_ui_states', 'changelog_stats', 'changelog_entries', 'feature_flag_overrides', 'feature_flags', 'support_tickets']) await t.owner.query(`DELETE FROM ${table}`);
  await t.owner.query(`UPDATE workspaces SET status = 'active', suspension_mode = NULL, suspension_message = NULL`);
  // บัญชีอายุ 60 วัน (ผ่านเกณฑ์ "ใช้งานครบ N วัน" และ "ไม่แสดง Spotlight วันแรก")
  await t.owner.query(`UPDATE users SET created_at = now() - interval '60 days'`);
  await npsSettings();
});

describe('มีอะไรใหม่ (U1)', () => {
  it('เฉพาะที่เผยแพร่ใน 90 วัน ใหม่ไปเก่า · ตั้งเวลาที่ถึงเวลาแล้วนับเป็นเผยแพร่ · ไม่ส่งข้อมูลภายใน', async () => {
    await entry({ title: 'ร่าง', status: 'draft' });
    await entry({ title: 'ซ่อนแล้ว', status: 'hidden', at: -30 });
    await entry({ title: 'ตั้งเวลาอนาคต', status: 'scheduled', at: 60 });
    await entry({ title: 'ตั้งเวลาถึงแล้ว', status: 'scheduled', at: -5 });
    await entry({ title: 'เก่ากว่า 90 วัน', at: -91 * 24 * 60 });
    const line = await entry({ title: 'ขอเลื่อน Due ผ่าน LINE', at: -10, cta: true, kind: 'new' });
    await entry({ title: 'แก้ Parent Key', at: -60 * 24, kind: 'fixed' });

    const r = await team.lead.get(`/me/whats-new?workspace=${team.slug}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(titles(r)).toEqual(['ตั้งเวลาถึงแล้ว', 'ขอเลื่อน Due ผ่าน LINE', 'แก้ Parent Key']);
    expect(r.body).toMatchObject({ unseen: 3, seenAt: null, hidden: false });
    const item = r.body.items[1];
    expect(item).toMatchObject({
      id: line,
      kind: 'new',
      summary: 'สรุปของ ขอเลื่อน Due ผ่าน LINE',
      body: '- ข้อแรก\n- ข้อสอง',
      titleEn: null,
      media: { url: 'https://cdn.example.com/changelog/line.png', kind: 'image', alt: 'ภาพตัวอย่าง' },
      cta: { label: 'ลองใช้', labelEn: null, path: '/profile?tab=notify' },
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      unseen: true,
    });
    for (const k of ['audience', 'audiencePlans', 'audienceFlag', 'hideReason', 'createdBy', 'devIssueLinkId']) expect(item).not.toHaveProperty(k);
    // ไม่ใช่สมาชิก → 404 · ไม่ระบุ Workspace → 400
    expect((await other.dev.get(`/me/whats-new?workspace=${team.slug}`)).status).toBe(404);
    expect((await team.lead.get('/me/whats-new')).status).toBe(400);
  });

  it('กลุ่มผู้เห็น: แพ็กเกจ · Feature flag (override ชนะค่าตั้งต้น · flag ที่ลบแล้วไม่มีใครเห็น) · เฉพาะ Owner / Admin', async () => {
    await entry({ title: 'ทุกคน' });
    await entry({ title: 'Team M ขึ้นไป', audience: 'plans', plans: ['team_m', 'team_l', 'enterprise'] });
    await entry({ title: 'Free เท่านั้น', audience: 'plans', plans: ['free'] });
    await entry({ title: 'flag เปิดให้ nova', audience: 'flag', flag: 'reports.owner_dashboard' });
    await entry({ title: 'flag เปิดทุกคนแต่ปิดให้ nova', audience: 'flag', flag: 'gantt.multi_drag' });
    await entry({ title: 'flag ที่ไม่มีแล้ว', audience: 'flag', flag: 'removed.flag' });
    await entry({ title: 'Owner และ Admin', audience: 'admins' });
    const f1 = (await t.owner.query(`INSERT INTO feature_flags (key, default_on) VALUES ('reports.owner_dashboard', false) RETURNING id`)).rows[0].id;
    const f2 = (await t.owner.query(`INSERT INTO feature_flags (key, default_on) VALUES ('gantt.multi_drag', true) RETURNING id`)).rows[0].id;
    await t.owner.query('INSERT INTO feature_flag_overrides (flag_id, workspace_id, enabled) VALUES ($1, $2, true), ($3, $2, false)', [f1, wsId, f2]);

    const lead = await team.lead.get(`/me/whats-new?workspace=${team.slug}`);
    expect(titles(lead).sort()).toEqual(['Owner และ Admin', 'Team M ขึ้นไป', 'flag เปิดให้ nova', 'ทุกคน'].sort());
    expect(titles(await admin.get(`/me/whats-new?workspace=${team.slug}`))).toContain('Owner และ Admin');
    // สมาชิกธรรมดาไม่เห็นรายการเฉพาะ Owner / Admin
    expect(titles(await team.dev.get(`/me/whats-new?workspace=${team.slug}`)).sort()).toEqual(['Team M ขึ้นไป', 'flag เปิดให้ nova', 'ทุกคน'].sort());
    // Workspace อื่น (ทดลอง Team S · ไม่มี override) เห็นตามค่าของตัวเอง
    expect(titles(await other.lead.get(`/me/whats-new?workspace=${other.slug}`)).sort()).toEqual(['Owner และ Admin', 'flag เปิดทุกคนแต่ปิดให้ nova', 'ทุกคน'].sort());
  });

  it('Guest และ Workspace ที่ถูกระงับ: ไม่ได้รับรายการ (hidden) · Spotlight / NPS ก็ไม่มี', async () => {
    await entry({ title: 'ของใหม่', spotlight: true });
    expect((await guest.get(`/me/whats-new?workspace=${team.slug}`)).body).toEqual({ items: [], unseen: 0, seenAt: null, hidden: true });
    expect((await guest.get(`/me/spotlight?workspace=${team.slug}`)).body).toEqual({ item: null });
    expect((await prompt(guest)).body).toMatchObject({ ask: false });
    await t.owner.query(`UPDATE workspaces SET status = 'suspended', suspension_mode = 'read_only' WHERE id = $1`, [wsId]);
    expect((await team.lead.get(`/me/whats-new?workspace=${team.slug}`)).body).toMatchObject({ items: [], hidden: true });
    expect((await team.lead.get(`/me/spotlight?workspace=${team.slug}`)).body).toEqual({ item: null });
    await t.owner.query(`UPDATE workspaces SET suspension_mode = 'full' WHERE id = $1`, [wsId]);
    const dev = await team.dev.get(`/me/whats-new?workspace=${team.slug}`);
    expect(dev.status).toBe(200);
    expect(dev.body.hidden).toBe(true);
  });

  it('เปิดแผง: จุดเหลืองหาย · นับยอดเห็นครั้งเดียวต่อคนต่อรายการ · รายการใหม่หลังจากนั้นเป็น "ยังไม่เห็น"', async () => {
    const a = await entry({ title: 'เก่า', at: -120 });
    const b = await entry({ title: 'ใหม่', at: -10 });
    const s1 = await team.lead.post('/me/whats-new/seen', { workspace: team.slug });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    expect(s1.body).toMatchObject({ seenAt: expect.any(String), counted: 2 });
    expect(await stats(a)).toMatchObject({ views: 1 });
    // เปิดซ้ำไม่นับซ้ำ · คนอื่นเปิดนับเพิ่ม
    expect((await team.lead.post('/me/whats-new/seen', { workspace: team.slug })).body.counted).toBe(0);
    await team.dev.post('/me/whats-new/seen', { workspace: team.slug });
    expect(await stats(b)).toMatchObject({ views: 2, clicks: 0 });
    const after = await team.lead.get(`/me/whats-new?workspace=${team.slug}`);
    expect(after.body.unseen).toBe(0);
    expect(after.body.items.every((i: { unseen: boolean }) => !i.unseen)).toBe(true);
    await entry({ title: 'ล่าสุด', at: 0 });
    const later = await team.lead.get(`/me/whats-new?workspace=${team.slug}`);
    expect(later.body.unseen).toBe(1);
    expect(later.body.items[0]).toMatchObject({ title: 'ล่าสุด', unseen: true });
    // ตาราง user_ui_states อ่านได้เฉพาะแถวของตัวเอง · ยอดนับลูกค้าอ่านตรงไม่ได้
    const rows = await t.owner.query('SELECT user_id FROM user_ui_states');
    expect(rows.rows).toHaveLength(2);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM product_events')).rows[0].n).toBe(0);
  });

  it('คลิก "ลองใช้": นับคลิก · รายการร่าง / ไม่มี / รหัสผิด → 404', async () => {
    const id = await entry({ title: 'ลองใช้ได้', cta: true });
    const draft = await entry({ title: 'ร่าง', status: 'draft' });
    const r = await team.lead.post(`/me/whats-new/${id}/click`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id, clicked: true });
    await team.dev.post(`/me/whats-new/${id}/click`);
    expect(await stats(id)).toMatchObject({ clicks: 2 });
    expect((await team.lead.post(`/me/whats-new/${draft}/click`)).status).toBe(404);
    expect((await team.lead.post('/me/whats-new/not-a-uuid/click')).status).toBe(404);
    expect(await stats(draft)).toMatchObject({ clicks: 0 });
  });
});

describe('Spotlight (U2)', () => {
  it('ได้ทีละ 1 รายการที่ยังไม่เห็น · ปิดแล้วไม่แสดงอีก · นับเป็นการเห็น 1 ครั้ง', async () => {
    await entry({ title: 'ไม่ใช่ Spotlight' });
    const spot = await entry({ title: 'ขอเลื่อน Due ผ่าน LINE', spotlight: true, cta: true });
    const r = await team.lead.get(`/me/spotlight?workspace=${team.slug}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.item).toMatchObject({ id: spot, title: 'ขอเลื่อน Due ผ่าน LINE', spotlight: true, cta: { path: '/profile?tab=notify' } });
    const d = await team.lead.post(`/me/spotlight/${spot}/dismiss`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toEqual({ id: spot, dismissed: true });
    expect((await team.lead.get(`/me/spotlight?workspace=${team.slug}`)).body).toEqual({ item: null });
    // ปิดซ้ำได้ผลเดิม ไม่นับซ้ำ · คนอื่นยังเห็น
    await team.lead.post(`/me/spotlight/${spot}/dismiss`);
    expect(await stats(spot)).toMatchObject({ views: 1 });
    expect((await team.dev.get(`/me/spotlight?workspace=${team.slug}`)).body.item.id).toBe(spot);
    const st = (await t.owner.query('SELECT spotlight_seen_ids, spotlight_seen_at FROM user_ui_states WHERE user_id = $1', [team.leadId])).rows[0];
    expect(st.spotlight_seen_ids).toEqual([spot]);
    expect(st.spotlight_seen_at).not.toBeNull();
  });

  it('ไม่แสดงในวันแรกที่สมัคร · กลุ่มผู้เห็นเหมือนแผง · ปิดรายการที่ไม่ใช่ Spotlight → 404', async () => {
    const spot = await entry({ title: 'สำหรับ Admin', spotlight: true, audience: 'admins' });
    expect((await team.dev.get(`/me/spotlight?workspace=${team.slug}`)).body.item).toBeNull();
    expect((await admin.get(`/me/spotlight?workspace=${team.slug}`)).body.item.id).toBe(spot);
    await t.owner.query('UPDATE users SET created_at = now() WHERE id = $1', [adminId]);
    expect((await admin.get(`/me/spotlight?workspace=${team.slug}`)).body.item).toBeNull();
    const plain = await entry({ title: 'ธรรมดา' });
    expect((await team.lead.post(`/me/spotlight/${plain}/dismiss`)).status).toBe(404);
  });
});

describe('แบบสำรวจ NPS (U3)', () => {
  it('ถามได้: คืนคำถาม คำถามต่อ หัวข้อ · บันทึกเวลาที่แสดง → วันเดียวกันไม่ถามซ้ำ', async () => {
    const r = await prompt(team.lead);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      ask: true,
      question: 'คุณจะแนะนำ Friday Work Management ให้เพื่อนหรือเพื่อนร่วมงานไหม',
      followUps: { detractor: 'อะไรที่เราควรปรับให้ดีขึ้นที่สุด', passive: 'อะไรที่จะทำให้ให้ 10 คะแนน', promoter: 'ชอบอะไรที่สุด' },
      topics: ['speed', 'usability', 'missing_feature', 'price', 'mobile'],
      excludeShortMobile: true,
    });
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'asked_today' });
  });

  it('มือถือที่ใช้งานไม่ถึง 2 นาที: ไม่ถามและยังไม่นับว่าถาม (ถามได้เมื่อครบเวลา) · ปิดเงื่อนไขแล้วถามได้ทันที', async () => {
    await t.owner.query('UPDATE nps_settings SET exclude_short_mobile = true');
    expect((await team.lead.get(`/me/nps-prompt?workspace=${team.slug}&mobile=true&sessionSeconds=45`)).body).toEqual({ ask: false, reason: 'short_mobile' });
    expect((await t.owner.query('SELECT nps_prompted_at FROM user_ui_states WHERE user_id = $1', [team.leadId])).rows).toEqual([]);
    expect((await team.lead.get(`/me/nps-prompt?workspace=${team.slug}&mobile=true&sessionSeconds=130`)).body.ask).toBe(true);
    await t.owner.query('UPDATE nps_settings SET exclude_short_mobile = false');
    expect((await admin.get(`/me/nps-prompt?workspace=${team.slug}&mobile=true&sessionSeconds=5`)).body.ask).toBe(true);
    expect((await admin.get(`/me/nps-prompt?workspace=${team.slug}&mobile=maybe`)).status).toBe(400);
  });

  it('ถามใคร: Owner / Admin เท่านั้นตามค่าเริ่มต้น · เปิดให้สมาชิกได้ · Guest ไม่เคยถูกถาม · ปิดแบบสำรวจ', async () => {
    expect((await prompt(team.dev)).body).toEqual({ ask: false, reason: 'role' });
    expect((await prompt(admin)).body.ask).toBe(true);
    await npsSettings({ audience: 'members' });
    expect((await prompt(team.dev)).body.ask).toBe(true);
    expect((await prompt(guest)).body).toEqual({ ask: false, reason: 'role' });
    await npsSettings({ enabled: false });
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'disabled' });
  });

  it('ใช้งานยังไม่ครบ N วัน · ทดลองใช้ยังไม่ถึงเกณฑ์ · ไม่มีแถวตั้งค่า = ใช้ค่าเริ่มต้น', async () => {
    await npsSettings({ first_after_days: 90 });
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'too_new' });
    await npsSettings({ exclude_trial_days: 14 });
    // pine ทดลองใช้ และ Workspace เพิ่งสร้าง
    expect((await prompt(other.lead, other.slug)).body).toEqual({ ask: false, reason: 'trial' });
    expect((await prompt(team.lead)).body.ask).toBe(true);
    await t.owner.query('DELETE FROM nps_settings');
    await t.owner.query('DELETE FROM user_ui_states');
    // ค่าเริ่มต้น: ใช้ 30 วัน · ทดลอง 14 วัน · สุ่ม 50% (บัญชีอายุ 60 วัน) → ตัดสินตามการสุ่มของคนนั้น
    const def = (await prompt(team.lead)).body;
    expect(def.ask ? true : def.reason).toBe(sampled(team.leadId, 50, 90) ? true : 'not_sampled');
  });

  it('มี Ticket เปิดอยู่ หรือเพิ่งปิดภายใน 7 วัน (ของตัวเองหรือของ Workspace) → ไม่ถาม · ปิดนานแล้วถามได้', async () => {
    await npsSettings({ exclude_ticket_days: 7 });
    const ticket = (await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_user_id, subject, status) VALUES ($1, $2, 'Gantt โหลดช้า', 'open') RETURNING id`, [wsId, team.devId])).rows[0].id;
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'ticket' });
    await t.owner.query(`UPDATE support_tickets SET status = 'closed', closed_at = now() - interval '3 days', updated_at = now() - interval '3 days' WHERE id = $1`, [ticket]);
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'ticket' });
    await t.owner.query(`UPDATE support_tickets SET closed_at = now() - interval '10 days', updated_at = now() - interval '10 days' WHERE id = $1`, [ticket]);
    expect((await prompt(team.lead)).body.ask).toBe(true);
    // Ticket ของตัวเองใน Workspace อื่นก็นับ
    await t.owner.query('DELETE FROM user_ui_states');
    await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_user_id, subject) VALUES ($1, $2, 'ถามเรื่องใบกำกับ')`, [otherWs, team.leadId]);
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'ticket' });
  });

  it('วันที่เห็น Spotlight แล้วไม่ถาม · สุ่มไม่โดนไม่ถาม (คงที่ต่อคนต่อรอบ)', async () => {
    await npsSettings({ exclude_spotlight_day: true });
    const spot = await entry({ title: 'ฟีเจอร์ใหญ่', spotlight: true });
    await team.lead.post(`/me/spotlight/${spot}/dismiss`);
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'spotlight_today' });
    await npsSettings({ sample_pct: 0 });
    expect((await prompt(admin)).body).toEqual({ ask: false, reason: 'not_sampled' });
    const now = new Date('2026-11-12T03:00:00Z');
    expect(sampled(adminId, 37, 90, now)).toBe(sampled(adminId, 37, 90, new Date(now.getTime() + 3_600_000)));
    // ประมาณสัดส่วนที่ตั้งไว้
    const hits = Array.from({ length: 2000 }, (_, i) => sampled(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 30, 90, now)).filter(Boolean).length;
    expect(hits / 2000).toBeGreaterThan(0.25);
    expect(hits / 2000).toBeLessThan(0.35);
  });

  it('ตอบ: บันทึกคะแนน ความเห็น หัวข้อ บทบาท แพ็กเกจ · ถามซ้ำหลังครบรอบเท่านั้น · ตอบซ้ำ / ไม่ได้ถาม → 409', async () => {
    expect((await team.lead.post('/me/nps', { workspace: team.slug, score: 3 })).status).toBe(409);
    expect((await prompt(team.lead)).body.ask).toBe(true);
    const bad = await team.lead.post('/me/nps', { workspace: team.slug, score: 3, topics: ['speed', 'กาแฟ'] });
    expect(bad.status).toBe(400);
    expect((await team.lead.post('/me/nps', { workspace: team.slug, score: 11 })).status).toBe(400);
    const r = await team.lead.post('/me/nps', { workspace: team.slug, score: 3, comment: '  Gantt ช้ามากเมื่อมีงานเกิน 500 งาน ', topics: ['speed', 'speed'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), score: 3, group: 'detractor' });
    const row = (await t.owner.query('SELECT workspace_id, user_id, role, plan, score, comment, topics, tags, follow_up_status FROM nps_responses')).rows;
    expect(row).toEqual([{ workspace_id: wsId, user_id: team.leadId, role: 'owner', plan: 'team_m', score: 3, comment: 'Gantt ช้ามากเมื่อมีงานเกิน 500 งาน', topics: ['speed'], tags: [], follow_up_status: 'open' }]);
    expect((await team.lead.post('/me/nps', { workspace: team.slug, score: 9 })).status).toBe(409);
    // วันถัดไปยังไม่ถาม (ตอบแล้ว ซ้ำทุก 90 วัน) · ครบรอบแล้วถามได้อีก
    await t.owner.query(`UPDATE user_ui_states SET nps_prompted_at = now() - interval '1 day'`);
    expect((await prompt(team.lead)).body).toEqual({ ask: false, reason: 'answered_recently' });
    await t.owner.query(`UPDATE user_ui_states SET nps_prompted_at = now() - interval '91 days', nps_responded_at = now() - interval '91 days'`);
    expect((await prompt(team.lead)).body.ask).toBe(true);
    // ไม่ส่งเนื้อหาคำตอบไป product_events
    expect((await t.owner.query('SELECT count(*)::int AS n FROM product_events')).rows[0].n).toBe(0);
  });

  it('ปิดโดยไม่ตอบ: บันทึกแถว score ว่าง และไม่ถามจนถึงรอบถัดไป', async () => {
    expect((await prompt(admin)).body.ask).toBe(true);
    const d = await admin.post('/me/nps/dismiss', { workspace: team.slug });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toEqual({ dismissed: true });
    expect((await t.owner.query('SELECT role, score, comment, topics FROM nps_responses')).rows).toEqual([{ role: 'admin', score: null, comment: null, topics: [] }]);
    await t.owner.query(`UPDATE user_ui_states SET nps_prompted_at = now() - interval '2 days'`);
    expect((await prompt(admin)).body).toEqual({ ask: false, reason: 'answered_recently' });
    expect((await admin.post('/me/nps/dismiss', { workspace: team.slug })).status).toBe(409);
  });

  it('RLS: อ่านคำตอบของคนอื่น / Workspace อื่นไม่ได้ · ลูกค้าอ่าน tags / note ไม่ได้ · Guest ส่งคำตอบไม่ได้', async () => {
    await prompt(team.lead);
    await team.lead.post('/me/nps', { workspace: team.slug, score: 10, comment: 'ดีมาก' });
    const asApp = async (userId: string, workspaceId: string, q: string) => {
      await t.owner.query('BEGIN');
      try {
        await t.owner.query('SET LOCAL ROLE friday_app');
        await t.owner.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, [userId, workspaceId]);
        return (await t.owner.query(q)).rows;
      } finally {
        await t.owner.query('ROLLBACK');
      }
    };
    expect(await asApp(team.leadId, wsId, 'SELECT score FROM nps_responses')).toEqual([{ score: 10 }]);
    expect(await asApp(adminId, wsId, 'SELECT score FROM nps_responses')).toEqual([]);
    expect(await asApp(team.leadId, otherWs, 'SELECT score FROM nps_responses')).toEqual([]);
    await expect(asApp(team.leadId, wsId, 'SELECT note FROM nps_responses')).rejects.toThrow(/permission denied/);
    expect((await guest.post('/me/nps', { workspace: team.slug, score: 5 })).status).toBe(403);
  });
});
