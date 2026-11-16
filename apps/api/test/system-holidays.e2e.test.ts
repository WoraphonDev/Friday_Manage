// Friday Ops รอบ 4 · S2–S6 ฝั่ง API ลูกค้า: คำนวณ Plan End ใหม่เมื่อปฏิทินของระบบเปลี่ยน · คืนเรื่องเข้าคิวเมื่อคนเดิมออฟไลน์ · บริบทเบราว์เซอร์
// ฝั่ง ops-api เขียนวันหยุด + คิว holiday_recalc · test จำลองแถวด้วยบัญชีเจ้าของตาราง · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { Mailer } from '../src/core/mail.js';
import { HelpRateLimit } from '../src/help/rate-limit.js';
import { SystemHolidaysJob } from '../src/help/system-calendar.js';
import { browserOf } from '../src/help/tickets.service.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

process.env.SMTP_HOST = 'smtp.test.example.com';
process.env.MAIL_FROM = 'Friday Work Management <notify@friday.test>';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let calendarId: string;
let wsId: string;
const events: DomainEvent[] = [];

const createIssue = async (body: Record<string, unknown>) => {
  const r = await team.lead.post(`${team.ws}/projects/DP/issues`, { title: 'งานทดสอบวันหยุดของระบบ', moduleId: team.project.modules[0].id, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; key: string; planStart: string; planEnd: string };
};
const planOf = async (id: string) => (await t.owner.query('SELECT plan_start::text AS s, plan_end::text AS e FROM issues WHERE id = $1', [id])).rows[0] as { s: string; e: string };
/** สิ่งที่ ops-api เขียนเมื่อแก้ปฏิทินของระบบ (HolidaysService.enqueueRecalc) */
const enqueue = async (added: string[], removed: string[]) => {
  const entry = JSON.stringify({ id: crypto.randomUUID(), calendarId, added, removed, at: new Date().toISOString(), by: 'Olive Owner', done: [] });
  await t.owner.query(
    `INSERT INTO ops_settings (key, value) VALUES ('holiday_recalc', jsonb_build_object('pending', jsonb_build_array($1::jsonb)))
     ON CONFLICT (key) DO UPDATE SET value = jsonb_set(ops_settings.value, '{pending}', coalesce(ops_settings.value->'pending', '[]'::jsonb) || jsonb_build_array($1::jsonb))`,
    [entry],
  );
};

beforeAll(async () => {
  t = await startApp();
  t.app.get(Mailer).transportFactory = () => ({ sendMail: async () => undefined });
  t.app.get(EventBus).on('*', (e) => void events.push(e));
  team = await seedTeam(t, { slug: 'lumen-demo', key: 'DP' });
  calendarId = (await t.owner.query(`SELECT id FROM holiday_calendars WHERE workspace_id IS NULL LIMIT 1`)).rows[0].id;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
});
afterAll(() => t.close());

describe('ปฏิทินของระบบเปลี่ยน → Plan End ใหม่ (S2)', () => {
  it('วันหยุดใหม่ในช่วงงาน: เลื่อนวันจบ 1 วันทำการ · งานนอกช่วงไม่เปลี่ยน · คิวถูกล้าง · รันซ้ำไม่เลื่อนซ้ำ', async () => {
    // จ. 14 – ศ. 18 ธ.ค. 2569 = 5 วันทำการ
    const spanning = await createIssue({ planStart: '2026-12-14', estimateMd: 5 });
    const outside = await createIssue({ planStart: '2026-12-21', estimateMd: 2 });
    expect(await planOf(spanning.id)).toEqual({ s: '2026-12-14', e: '2026-12-18' });
    // ทีม Friday เพิ่มวันหยุดพิเศษ พ. 16 ธ.ค. (ops-api เขียนวันหยุดและคิวในธุรกรรมเดียวกัน)
    await t.owner.query(`INSERT INTO holidays (calendar_id, date, name, origin) VALUES ($1, '2026-12-16', 'หยุดพิเศษสมมติ', 'manual')`, [calendarId]);
    await enqueue(['2026-12-16'], []);
    events.length = 0;
    const job = t.app.get(SystemHolidaysJob);
    const r = await job.run();
    expect(r).toMatchObject({ entries: 1, projects: 1, issues: 1 });
    expect(await planOf(spanning.id)).toEqual({ s: '2026-12-14', e: '2026-12-21' });
    expect(await planOf(outside.id)).toEqual({ s: '2026-12-21', e: '2026-12-22' });
    expect(events.some((e) => e.type === 'issue.updated' && e.issueId === spanning.id && (e.data as { source: string }).source === 'holiday')).toBe(true);
    expect((await t.owner.query(`SELECT value->'pending' AS p FROM ops_settings WHERE key = 'holiday_recalc'`)).rows[0].p).toEqual([]);
    expect(await job.run()).toMatchObject({ entries: 0, issues: 0 });
    expect(await planOf(spanning.id)).toEqual({ s: '2026-12-14', e: '2026-12-21' });
  });

  it('ลบวันหยุดเอง: งานที่คร่อมวันนั้นกลับมาจบเร็วขึ้น · หลายคิวค้างคิดรวมครั้งเดียว', async () => {
    const spanning = await createIssue({ planStart: '2026-12-15', estimateMd: 3 });
    // 15 (อ.) 16 (หยุด) 17 18 → 3 วันทำการจบ 18
    expect(await planOf(spanning.id)).toEqual({ s: '2026-12-15', e: '2026-12-18' });
    await t.owner.query(`DELETE FROM holidays WHERE calendar_id = $1 AND date = '2026-12-16'`, [calendarId]);
    await enqueue([], ['2026-12-16']);
    await t.owner.query(`INSERT INTO holidays (calendar_id, date, name, origin) VALUES ($1, '2026-12-17', 'หยุดพิเศษสมมติอีกวัน', 'manual')`, [calendarId]);
    await enqueue(['2026-12-17'], []);
    const r = await t.app.get(SystemHolidaysJob).run();
    expect(r.entries).toBe(2);
    // ก่อนทั้งสองรายการ: 15, 17, 18 · หลัง: 15, 16, 18 → จบ 18 เหมือนเดิม (วันทำการเท่าเดิม)
    expect(await planOf(spanning.id)).toEqual({ s: '2026-12-15', e: '2026-12-18' });
    // ปฏิทินที่ลูกค้าคัดลอกเป็นของตัวเองไม่อยู่ในขอบเขต (โปรเจกต์ใช้ปฏิทินอื่น)
    const own = (await t.owner.query(`INSERT INTO holiday_calendars (workspace_id, name, source) VALUES ($1, 'ปฏิทินบริษัท', 'custom') RETURNING id`, [wsId])).rows[0].id;
    await t.owner.query(`UPDATE projects SET holiday_calendar_id = $1 WHERE workspace_id = $2`, [own, wsId]);
    const before = await planOf(spanning.id);
    await t.owner.query(`INSERT INTO holidays (calendar_id, date, name, origin) VALUES ($1, '2026-12-15', 'หยุดพิเศษ', 'manual')`, [calendarId]);
    await enqueue(['2026-12-15'], []);
    expect(await t.app.get(SystemHolidaysJob).run()).toMatchObject({ entries: 1, projects: 0 });
    expect(await planOf(spanning.id)).toEqual(before);
    await t.owner.query(`UPDATE projects SET holiday_calendar_id = NULL WHERE workspace_id = $1`, [wsId]);
  });
});

describe('ลูกค้าตอบเรื่องที่ปิดแล้ว แต่คนเดิมออฟไลน์ (S4)', () => {
  let away: string;
  let online: string;
  const ticket = async (assignee: string) =>
    (
      await t.owner.query(
        `INSERT INTO support_tickets (workspace_id, requester_user_id, requester_email, channel, category, priority, subject, assignee_id, status, solved_at)
         VALUES ($1, $2, 'lead@lumen-demo.example.com', 'in_app', 'bug', 'normal', 'บันทึกงานไม่ได้', $3, 'solved', now() - interval '1 day') RETURNING id`,
        [wsId, team.leadId, assignee],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    away = (await t.owner.query(`INSERT INTO staff_users (email, name, roles) VALUES ('nid@friday.test', 'Nid Support', '{support}') RETURNING id`)).rows[0].id;
    online = (await t.owner.query(`INSERT INTO staff_users (email, name, roles) VALUES ('mew@friday.test', 'Mew Support', '{support}') RETURNING id`)).rows[0].id;
    await t.owner.query(`INSERT INTO support_agents (staff_id, presence, presence_reason) VALUES ($1, 'offline', 'idle'), ($2, 'online', 'manual')`, [away, online]);
  });

  it('ตอบ → เปิดใหม่และแจกให้คนที่ออนไลน์ทันที · บันทึกภายในบอกเหตุ', async () => {
    const id = await ticket(away);
    const r = await team.lead.post(`${team.ws}/support/tickets/${id}/messages`, { body: 'ยังบันทึกไม่ได้อยู่ครับ' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'open', reopened: true });
    const row = (await t.owner.query('SELECT assignee_id, status FROM support_tickets WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ assignee_id: online, status: 'open' });
    const note = (await t.owner.query(`SELECT body FROM support_ticket_messages WHERE ticket_id = $1 AND internal`, [id])).rows.map((m) => m.body);
    expect(note).toEqual(['ลูกค้าตอบหลังปิดเรื่อง · Nid Support ออฟไลน์ จึงคืนเข้าคิวกลาง']);
    // ลูกค้าไม่เห็นบันทึกภายใน
    const view = await team.lead.get(`${team.ws}/support/tickets/${id}`);
    expect(view.body.messages.map((m: { body: string }) => m.body)).not.toContain(note[0]);
  });

  it('ไม่มีใครว่าง → คิวกลาง · "ยังพบปัญหาอยู่" ใช้กติกาเดียวกัน · คนเดิมออนไลน์อยู่ = คนเดิม · ปิดในตั้งค่า = คนเดิม', async () => {
    await t.owner.query(`UPDATE support_agents SET presence = 'leave' WHERE staff_id = $1`, [online]);
    const id = await ticket(away);
    expect((await team.lead.post(`${team.ws}/support/tickets/${id}/reopen`, {})).status).toBe(200);
    expect((await t.owner.query('SELECT assignee_id FROM support_tickets WHERE id = $1', [id])).rows[0].assignee_id).toBeNull();

    await t.owner.query(`UPDATE support_agents SET presence = 'online' WHERE staff_id = $1`, [away]);
    const same = await ticket(away);
    await team.lead.post(`${team.ws}/support/tickets/${same}/messages`, { body: 'ขอถามเพิ่ม' });
    expect((await t.owner.query('SELECT assignee_id FROM support_tickets WHERE id = $1', [same])).rows[0].assignee_id).toBe(away);

    await t.owner.query(`UPDATE support_agents SET presence = 'offline' WHERE staff_id = $1`, [away]);
    await t.owner.query(`INSERT INTO support_settings (id, config) VALUES (1, '{"reopenToQueue": false}') ON CONFLICT (id) DO UPDATE SET config = excluded.config`);
    const keep = await ticket(away);
    await team.lead.post(`${team.ws}/support/tickets/${keep}/messages`, { body: 'ยังไม่หาย' });
    expect((await t.owner.query('SELECT assignee_id FROM support_tickets WHERE id = $1', [keep])).rows[0].assignee_id).toBe(away);
    await t.owner.query(`DELETE FROM support_settings`);
  });
});

describe('บริบทเบราว์เซอร์ใน Ticket (S6)', () => {
  it('เก็บเบราว์เซอร์แบบย่อกับบริบทที่ลูกค้าแนบ', async () => {
    t.app.get(HelpRateLimit).reset();
    const r = await team.lead
      .post(`${team.ws}/support/tickets`, { subject: 'กดบันทึกงานแล้วขึ้นข้อผิดพลาด', category: 'bug', impact: 'blocked', body: 'ลองหลายรอบแล้ว', context: { page: 'บอร์ด', path: '/work/lumen-demo/p/DP/board', requestId: 'req_7f3a9c2e' } })
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [m] = (await t.owner.query('SELECT attachments FROM support_ticket_messages WHERE ticket_id = $1', [r.body.ticket.id])).rows;
    expect(m.attachments).toContainEqual(expect.objectContaining({ kind: 'context', requestId: 'req_7f3a9c2e', impact: 'blocked', browser: 'Chrome 131 · macOS' }));
    expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari 18 · iOS');
    expect(browserOf(undefined)).toBeNull();
  });
});
