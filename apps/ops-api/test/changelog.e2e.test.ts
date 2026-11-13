// O33 · Changelog และ NPS ในหลังบ้าน: เขียน / เผยแพร่ / ตั้งเวลา / Spotlight ทีละรายการ / ซ่อน · ตัวเลข NPS · ติดตามความเห็น · ตั้งค่า · ลบตามระยะเก็บ
// ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NpsOpsService } from '../src/changelog/nps.service.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let support: Staff;
let finance: Staff;
let engineer: Staff;
let auditor: Staff;
let a: Customer;
let b: Customer;
const DAY = 86_400_000;

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'new',
  title: 'ขอเลื่อน Due ผ่าน LINE ได้แล้ว',
  summary: 'กดอนุมัติ / ปฏิเสธคำขอเลื่อน Due จากข้อความใน LINE ได้ทันที',
  body: '- หัวหน้าทีมได้ข้อความพร้อมปุ่ม\n- ทุกการกดบันทึกใน Audit log',
  mediaUrl: 'https://cdn.example.com/changelog/line-approve.png',
  mediaAlt: 'ข้อความ LINE พร้อมปุ่มอนุมัติ',
  ctaLabel: 'ผูก LINE',
  ctaPath: '/profile?tab=notify',
  audience: 'all',
  spotlight: false,
  showPublic: true,
  action: 'publish',
  ...over,
});
const audit = async (action: string) => (await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows.map((r) => r.reason as string);
async function answer(ws: Customer, o: { score: number | null; comment?: string; daysAgo?: number; plan?: string; role?: string; topics?: string[]; user?: string | null }) {
  return (await t.owner.query(
    `INSERT INTO nps_responses (workspace_id, user_id, role, plan, score, comment, topics, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8)) RETURNING id`,
    [ws.id, o.user === undefined ? ws.owner : o.user, o.role ?? 'owner', o.plan ?? 'team_s', o.score, o.comment ?? null, o.topics ?? [], o.daysAgo ?? 1],
  )).rows[0].id as string;
}

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner']);
  support = await staff(t, 'support@friday.example.com', 'Sue Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'engineer@friday.example.com', 'Eng Engineer', ['engineer']);
  auditor = await staff(t, 'auditor@friday.example.com', 'Aud Auditor', ['auditor']);
  a = await customer(t, 'kanit-labs', { plan: 'team_s', status: 'active', admins: ['admin@kanit-labs.example.com'] });
  b = await customer(t, 'pixel-forge', { plan: 'free', status: 'active' });
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const table of ['nps_responses', 'changelog_stats', 'changelog_entries', 'user_ui_states', 'feature_flag_overrides', 'feature_flags', 'staff_audit_logs']) await t.owner.query(`DELETE FROM ${table}`);
});

describe('Changelog', () => {
  it('Owner เขียนร่าง → เผยแพร่ · ทุกบทบาทอ่านตารางได้ · บทบาทอื่นเขียนไม่ได้ · Audit ทุกครั้ง', async () => {
    const draft = await owner.agent.post('/ops/changelog').send(body({ action: 'draft' }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.item).toMatchObject({ status: 'draft', publishedAt: null, title: 'ขอเลื่อน Due ผ่าน LINE ได้แล้ว', mediaKind: 'image', ctaPath: '/profile?tab=notify' });
    const id = draft.body.item.id;
    const pub = await owner.agent.put(`/ops/changelog/${id}`).send(body({ action: 'publish' }));
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.item).toMatchObject({ status: 'published', publishedAt: expect.any(String) });
    for (const st of [support, finance, engineer, auditor]) {
      const r = await st.agent.get('/ops/changelog');
      expect(r.status, st.email).toBe(200);
      expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
      expect((await st.agent.post('/ops/changelog').send(body())).status, st.email).toBe(403);
      expect((await st.agent.post(`/ops/changelog/${id}/hide`).send({ reason: 'ทดสอบสิทธิ์' })).status, st.email).toBe(403);
    }
    expect(await audit('ops.changelog_created')).toEqual(['บันทึกร่าง "ขอเลื่อน Due ผ่าน LINE ได้แล้ว"']);
    expect(await audit('ops.changelog_published')).toEqual(['เผยแพร่ "ขอเลื่อน Due ผ่าน LINE ได้แล้ว"']);
    // แก้รายการที่เผยแพร่แล้ว: เวลาเผยแพร่คงเดิม · ถอนเป็นร่างไม่ได้ (ใช้ซ่อน)
    const edit = await owner.agent.put(`/ops/changelog/${id}`).send(body({ summary: 'สรุปใหม่', action: 'publish' }));
    expect(edit.body.item).toMatchObject({ summary: 'สรุปใหม่', publishedAt: pub.body.item.publishedAt });
    expect(await audit('ops.changelog_updated')).toEqual(['แก้รายการที่เผยแพร่แล้ว "ขอเลื่อน Due ผ่าน LINE ได้แล้ว"']);
    expect((await owner.agent.put(`/ops/changelog/${id}`).send(body({ action: 'draft' }))).status).toBe(409);
  });

  it('ตรวจข้อมูล: สรุป ≤ 140 · ปุ่มลองใช้ต้องครบคู่ · รูปต้องเป็น https และมีคำอธิบาย · แพ็กเกจ / flag ตามกลุ่มผู้เห็น', async () => {
    const bad = async (over: Record<string, unknown>, field: string) => {
      const r = await owner.agent.post('/ops/changelog').send(body(over));
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body.error.details.map((f: { path: string }) => f.path), JSON.stringify(r.body)).toContain(field);
    };
    await bad({ summary: 'ก'.repeat(141) }, 'summary');
    await bad({ ctaPath: null }, 'ctaPath');
    await bad({ ctaPath: '//evil.example.com' }, 'ctaPath');
    await bad({ mediaUrl: 'http://cdn.example.com/a.png' }, 'mediaUrl');
    await bad({ mediaAlt: '' }, 'mediaAlt');
    await bad({ audience: 'plans', audiencePlans: [] }, 'audiencePlans');
    await bad({ audience: 'flag' }, 'audienceFlag');
    await bad({ action: 'schedule' }, 'publishAt');
    const flag = await owner.agent.post('/ops/changelog').send(body({ audience: 'flag', audienceFlag: 'reports.owner_dashboard' }));
    expect(flag.status).toBe(422);
    expect(flag.body.error.code).toBe('flag_not_found');
  });

  it('ตั้งเวลา: ต้องเป็นอนาคต · ถึงเวลาแล้วแสดงเป็นเผยแพร่ (ไม่มีงานเปลี่ยนสถานะ) · ตามแพ็กเกจ / flag แสดงจำนวน Workspace ที่เปิด flag', async () => {
    const past = await owner.agent.post('/ops/changelog').send(body({ action: 'schedule', publishAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe('scheduled_in_past');
    const at = new Date(Date.now() + 3 * DAY).toISOString();
    const s = await owner.agent.post('/ops/changelog').send(body({ title: 'Gantt ลากหลายงานพร้อมกัน', kind: 'improved', audience: 'plans', audiencePlans: ['team_s', 'team_m', 'team_s'], action: 'schedule', publishAt: at }));
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.item).toMatchObject({ status: 'scheduled', audiencePlans: ['team_s', 'team_m'] });
    expect(new Date(s.body.item.publishedAt).toISOString()).toBe(at);
    expect(await audit('ops.changelog_published')).toEqual([expect.stringMatching(/^ตั้งเวลาเผยแพร่ .+ "Gantt ลากหลายงานพร้อมกัน"$/)]);
    await t.owner.query(`UPDATE changelog_entries SET published_at = now() - interval '1 minute' WHERE id = $1`, [s.body.item.id]);
    const flagId = (await t.owner.query(`INSERT INTO feature_flags (key, default_on) VALUES ('reports.owner_dashboard', false) RETURNING id`)).rows[0].id;
    await t.owner.query('INSERT INTO feature_flag_overrides (flag_id, workspace_id, enabled) VALUES ($1, $2, true)', [flagId, a.id]);
    const f = await owner.agent.post('/ops/changelog').send(body({ title: 'หน้ารวมสำหรับเจ้าของบริษัท', audience: 'flag', audienceFlag: 'reports.owner_dashboard', action: 'draft' }));
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const list = (await owner.agent.get('/ops/changelog')).body;
    const byTitle = (x: string) => list.items.find((i: { title: string }) => i.title === x);
    expect(byTitle('Gantt ลากหลายงานพร้อมกัน').status).toBe('published');
    expect(byTitle('หน้ารวมสำหรับเจ้าของบริษัท')).toMatchObject({ status: 'draft', flagWorkspaces: 1 });
    expect(list.kpis).toMatchObject({ published30: 1, byKind: { new: 0, improved: 1, fixed: 0 } });
  });

  it('Spotlight ได้ทีละ 1 รายการ: เผยแพร่รายการใหม่ที่ติ๊ก Spotlight ปลดรายการเดิม (แจ้งชื่อ) · ร่างไม่แย่ง', async () => {
    const first = (await owner.agent.post('/ops/changelog').send(body({ title: 'รายการแรก', spotlight: true }))).body;
    expect(first.item.spotlight).toBe(true);
    const draft = await owner.agent.post('/ops/changelog').send(body({ title: 'ร่าง Spotlight', spotlight: true, action: 'draft' }));
    expect(draft.body.spotlightMovedFrom).toBeNull();
    const second = await owner.agent.put(`/ops/changelog/${draft.body.item.id}`).send(body({ title: 'ร่าง Spotlight', spotlight: true, action: 'publish' }));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.spotlightMovedFrom).toBe('รายการแรก');
    const rows = (await t.owner.query('SELECT title, spotlight FROM changelog_entries ORDER BY spotlight DESC')).rows;
    expect(rows).toEqual([{ title: 'ร่าง Spotlight', spotlight: true }, { title: 'รายการแรก', spotlight: false }]);
    expect((await audit('ops.changelog_published')).pop()).toBe('เผยแพร่ "ร่าง Spotlight" · ย้าย Spotlight จาก "รายการแรก"');
  });

  it('ซ่อน (U7): ต้องมีเหตุผล · ปลด Spotlight · ซ่อนซ้ำ 409 · เผยแพร่อีกครั้งล้างการซ่อน · ยอดเห็น / คลิกและสัดส่วน', async () => {
    const id = (await owner.agent.post('/ops/changelog').send(body({ spotlight: true }))).body.item.id;
    await t.owner.query('INSERT INTO changelog_stats (entry_id, views, clicks) VALUES ($1, 3, 1)', [id]);
    await t.owner.query(`UPDATE workspace_members SET last_active_at = now() - interval '1 day'`);
    const row = (await owner.agent.get('/ops/changelog')).body.items[0];
    expect(row).toMatchObject({ views: 3, clicks: 1, viewPct: 100, clickPct: 33 });
    expect((await owner.agent.post(`/ops/changelog/${id}/hide`).send({ reason: '' })).status).toBe(400);
    const h = await owner.agent.post(`/ops/changelog/${id}/hide`).send({ reason: 'เลื่อนเปิดฟีเจอร์ รอแก้บั๊ก FM-497' });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body).toMatchObject({ status: 'hidden', spotlight: false, hideReason: 'เลื่อนเปิดฟีเจอร์ รอแก้บั๊ก FM-497', hiddenAt: expect.any(String) });
    expect((await owner.agent.post(`/ops/changelog/${id}/hide`).send({ reason: 'ซ้ำอีกครั้ง' })).status).toBe(409);
    expect(await audit('ops.changelog_hidden')).toEqual(['ซ่อน "ขอเลื่อน Due ผ่าน LINE ได้แล้ว" · เลื่อนเปิดฟีเจอร์ รอแก้บั๊ก FM-497']);
    const again = await owner.agent.put(`/ops/changelog/${id}`).send(body({ action: 'publish' }));
    expect(again.body.item).toMatchObject({ status: 'published', hiddenAt: null, hideReason: null });
    expect((await owner.agent.post('/ops/changelog/not-a-uuid/hide').send({ reason: 'ไม่มีรายการ' })).status).toBe(404);
  });
});

describe('NPS', () => {
  it('ตัวเลขรวม: NPS · สัดส่วน 3 กลุ่ม · ถาม / ตอบ / ปิด · แนวโน้มรายเดือน · แยกแพ็กเกจ · หัวข้อ · เทียบช่วงก่อน · สิทธิ์ตามบทบาท', async () => {
    await answer(a, { score: 10, topics: ['speed'] });
    await answer(a, { score: 9 });
    await answer(a, { score: 7 });
    await answer(b, { score: 3, comment: 'อยากได้แอปมือถือที่ใช้แบบออฟไลน์ได้', plan: 'free', topics: ['mobile', 'speed'] });
    await answer(b, { score: null, plan: 'free' });
    // ช่วงก่อน (91–180 วัน): ไม่พอใจทั้งหมด → NPS −100
    await answer(a, { score: 2, daysAgo: 120 });
    const r = await finance.agent.get('/ops/nps/summary?range=90d');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ score: 25, delta: 125, answered: 4, asked: 5, dismissed: 1, promotersPct: 50, passivesPct: 25, detractorsPct: 25, openDetractors: 1, groups: { detractor: 1, passive: 1, promoter: 2 } });
    expect(r.body.monthly).toHaveLength(6);
    expect(r.body.monthly.at(-1)).toMatchObject({ answered: expect.any(Number) });
    expect(r.body.byPlan).toEqual(expect.arrayContaining([{ plan: 'team_s', answered: 3, score: 67 }, { plan: 'free', answered: 1, score: -100 }]));
    expect(r.body.topics[0]).toEqual({ topic: 'speed', count: 2 });
    expect((await auditor.agent.get('/ops/nps/summary')).status).toBe(200);
    expect((await engineer.agent.get('/ops/nps/summary')).status).toBe(403);
    // การเงิน / ผู้ตรวจเห็นเฉพาะตัวเลขรวม ไม่เห็นความเห็น
    expect((await finance.agent.get('/ops/nps/responses')).status).toBe(403);
    expect((await auditor.agent.get('/ops/nps/responses')).status).toBe(403);
  });

  it('ความเห็น: Support เห็นพร้อมชื่อ Workspace · กรองกลุ่มคะแนน / มีข้อความ · รายละเอียดมีคะแนนครั้งก่อน สุขภาพ Ticket 90 วัน', async () => {
    await answer(a, { score: 7, daysAgo: 95 });
    const id = await answer(a, { score: 3, comment: 'Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน' });
    await answer(b, { score: 10, plan: 'free' });
    await answer(b, { score: null, plan: 'free' });
    const all = await support.agent.get('/ops/nps/responses?range=90d');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.items).toHaveLength(2);
    const det = await support.agent.get('/ops/nps/responses?group=detractor&withComment=true');
    expect(det.body.items).toEqual([expect.objectContaining({ id, score: 3, comment: 'Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน', role: 'owner', plan: 'team_s', followUpStatus: 'open', ticket: null, workspace: { id: a.id, name: 'Co kanit-labs', slug: 'kanit-labs' } })]);
    expect((await support.agent.get('/ops/nps/responses?range=12m')).body.items).toHaveLength(3);
    await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_email, subject, status, created_at) VALUES ($1, 'owner@kanit-labs.example.com', 'Gantt โหลดช้า', 'closed', now() - interval '20 days')`, [a.id]);
    const d = await support.agent.get(`/ops/nps/responses/${id}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.context).toMatchObject({ previous: { score: 7, at: expect.any(String) }, health: expect.any(Number), members: 2, tickets90: { count: 1, latest: { subject: 'Gantt โหลดช้า', status: 'closed' } } });
    expect((await support.agent.get('/ops/nps/responses/not-a-uuid')).status).toBe(404);
  });

  it('ติดตาม (U6): หัวข้อ บันทึกภายใน ทำเครื่องหมายว่าติดตามแล้ว · เปิด Ticket ติดตามที่เติมข้อความ · Audit', async () => {
    const id = await answer(a, { score: 3, comment: 'Gantt ช้ามาก' });
    const p = await support.agent.patch(`/ops/nps/responses/${id}`).send({ tags: ['ความเร็ว', 'Gantt', 'Gantt'], note: 'ส่งต่อทีมพัฒนาแล้วใน FM-455' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ tags: ['ความเร็ว', 'Gantt'], note: 'ส่งต่อทีมพัฒนาแล้วใน FM-455', followUpStatus: 'open', followedUpBy: null });
    const done = await support.agent.patch(`/ops/nps/responses/${id}`).send({ followUpStatus: 'done' });
    expect(done.body).toMatchObject({ followUpStatus: 'done', followedUpBy: 'Sue Support', followedUpAt: expect.any(String) });
    expect((await finance.agent.patch(`/ops/nps/responses/${id}`).send({ note: 'x' })).status).toBe(403);
    const tk = await support.agent.post(`/ops/nps/responses/${id}/ticket`).send({ subject: 'ติดตามความเห็น NPS: Gantt ช้า', body: 'ความเห็นของลูกค้า: "Gantt ช้ามาก"' });
    expect(tk.status, JSON.stringify(tk.body)).toBe(200);
    expect(tk.body.ticket).toEqual({ id: expect.any(String), number: expect.any(Number) });
    const ticket = (await t.owner.query('SELECT workspace_id, requester_email, subject, channel, assignee_id FROM support_tickets WHERE id = $1', [tk.body.ticket.id])).rows[0];
    expect(ticket).toEqual({ workspace_id: a.id, requester_email: 'owner@kanit-labs.example.com', subject: 'ติดตามความเห็น NPS: Gantt ช้า', channel: 'in_app', assignee_id: support.id });
    expect((await support.agent.post(`/ops/nps/responses/${id}/ticket`).send({ subject: 'ซ้ำอีกใบ', body: 'ซ้ำ' })).status).toBe(409);
    const logs = await audit('ops.nps_follow_up');
    expect(logs).toEqual(['ความเห็น NPS คะแนน 3 ของ Co kanit-labs · หัวข้อ ความเร็ว, Gantt · บันทึกภายใน', 'ความเห็น NPS คะแนน 3 ของ Co kanit-labs · ติดตามแล้ว']);
    expect(await audit('ops.nps_ticket')).toEqual([expect.stringMatching(/^เปิด Ticket #\d+ ติดตามความเห็น NPS คะแนน 3 ของ Co kanit-labs$/)]);
    // ผู้ตอบลบบัญชีแล้ว (user_id ว่าง) → ผู้แจ้งเป็น Owner ของ Workspace
    const anon = await answer(b, { score: 5, user: null, plan: 'free' });
    const tk2 = await support.agent.post(`/ops/nps/responses/${anon}/ticket`).send({ subject: 'ติดตามความเห็น NPS', body: 'ไม่มีข้อความ' });
    expect(tk2.status, JSON.stringify(tk2.body)).toBe(200);
    expect((await t.owner.query('SELECT requester_email FROM support_tickets WHERE id = $1', [tk2.body.ticket.id])).rows[0].requester_email).toBe('owner@pixel-forge.example.com');
  });

  it('ตั้งค่า (U5): ทุกคนที่เห็น NPS อ่านได้ (พร้อมจำนวนคนที่เข้าเกณฑ์) · Owner แก้ได้คนเดียว · Audit', async () => {
    await t.owner.query('DELETE FROM nps_settings');
    await t.owner.query(`UPDATE users SET created_at = now() - interval '60 days'`);
    const g = await finance.agent.get('/ops/nps/settings');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body).toMatchObject({ canEdit: false, settings: { enabled: true, audience: 'admins', firstAfterDays: 30, repeatDays: 90, samplePct: 50, excludeTrialDays: 14, excludeTicketDays: 7, topics: ['speed', 'usability', 'missing_feature', 'price', 'mobile'] }, eligible: { admins: 3, members: 3 } });
    expect((await engineer.agent.get('/ops/nps/settings')).status).toBe(403);
    const next = { ...g.body.settings, audience: 'members', samplePct: 30, excludeShortMobile: false, question: 'คุณจะแนะนำ Friday Work Management ให้คนอื่นไหม', followUpsEn: null };
    delete next.updatedAt;
    expect((await finance.agent.put('/ops/nps/settings').send(next)).status).toBe(403);
    const put = await owner.agent.put('/ops/nps/settings').send(next);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ canEdit: true, settings: { audience: 'members', samplePct: 30, excludeShortMobile: false, question: 'คุณจะแนะนำ Friday Work Management ให้คนอื่นไหม' } });
    expect(await audit('ops.nps_settings')).toEqual(['เปิดแบบสำรวจ NPS · ถาม ทุกคนยกเว้น Guest หลังใช้ 30 วัน ซ้ำทุก 90 วัน สุ่ม 30%']);
    expect((await owner.agent.put('/ops/nps/settings').send({ ...next, samplePct: 101 })).status).toBe(400);
  });

  it('ลบคำตอบที่เก่ากว่า 25 เดือน (งานเบื้องหลัง) · คำตอบที่ยังไม่ครบระยะคงอยู่', async () => {
    await answer(a, { score: 8, daysAgo: 800 });
    await answer(a, { score: null, daysAgo: 790 });
    const keep = await answer(a, { score: 9, daysAgo: 700 });
    const res = await t.app.get(NpsOpsService).purge();
    expect(res).toEqual({ deleted: 2 });
    expect((await t.owner.query('SELECT id FROM nps_responses')).rows).toEqual([{ id: keep }]);
    expect(await audit('ops.nps_purged')).toEqual(['ลบคำตอบ NPS ที่เก่ากว่า 25 เดือน 2 รายการ (ระยะเก็บตามนโยบาย)']);
    expect(await t.app.get(NpsOpsService).purge()).toEqual({ deleted: 0 });
  });
});
