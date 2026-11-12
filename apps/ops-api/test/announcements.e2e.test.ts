// O24 · ส่งประกาศถึงลูกค้าที่เลือก (C8) · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnnouncementsService, BANNER_DAYS } from '../src/announcements/announcements.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let svc: AnnouncementsService;
let owner: Staff;
let support: Staff;
let finance: Staff;
let a: Customer;
let b: Customer;
let c: Customer;

const member = async (ws: Customer, email: string, role: string, opts: { disabled?: boolean; status?: string } = {}) => {
  const u = (await t.owner.query(`INSERT INTO users (email, display_name, disabled_at) VALUES ($1, $2, $3) ON CONFLICT (lower(email)) DO UPDATE SET email = excluded.email RETURNING id`, [email, email.split('@')[0], opts.disabled ? new Date() : null])).rows[0].id as string;
  await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, $3, $4)`, [ws.id, u, role, opts.status ?? 'active']);
  return u;
};
const auditOf = async (ws: string, action: string) => (await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [ws, action])).rows.map((r) => r.summary as string);
const deliveries = async (announcementId: string) =>
  (
    await t.owner.query(
      `SELECT d.workspace_id, d.target_ref, d.status, d.resend_requested_at, d.log, n.in_app, n.event_type, n.payload
       FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE n.payload->>'announcementId' = $1 ORDER BY d.target_ref`,
      [announcementId],
    )
  ).rows;
const targets = async (announcementId: string) => (await t.owner.query(`SELECT * FROM announcement_targets WHERE announcement_id = $1`, [announcementId])).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  svc = t.app.get(AnnouncementsService);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  // a: Owner + Admin 1 คน (อีเมลอยู่ในรายชื่อไม่ส่ง) + สมาชิกธรรมดา + Admin ที่ถูกปิดบัญชี + Admin ที่ออกไปแล้ว
  a = await customer(t, 'lotus-demo', { plan: 'team_m', status: 'active', admins: ['pm@lotus-demo.example.com'] });
  await member(a, 'dev@lotus-demo.example.com', 'member');
  await member(a, 'gone@lotus-demo.example.com', 'admin', { disabled: true });
  await member(a, 'left@lotus-demo.example.com', 'admin', { status: 'deactivated' });
  await t.owner.query(`INSERT INTO email_suppressions (email, reason, workspace_id) VALUES ('PM@lotus-demo.example.com', 'hard_bounce', $1)`, [a.id]);
  // b: เจ้าของคนเดียว และเป็น Admin ของ a ด้วย (นับคนครั้งเดียว)
  b = await customer(t, 'river-demo', { plan: 'team_s', status: 'active' });
  await member(a, 'owner@river-demo.example.com', 'admin');
  c = await customer(t, 'ghost-demo', { plan: 'free', status: 'active' });
  await t.owner.query(`UPDATE workspaces SET deleted_at = now() WHERE id = $1`, [c.id]);
});
afterAll(() => t.close());

describe('สิทธิ์', () => {
  it('เฉพาะ Owner ของทีม Friday · Support / การเงินได้ 403', async () => {
    expect((await support.agent.get('/ops/announcements')).status).toBe(403);
    expect((await finance.agent.post('/ops/announcements/audience').send({ workspaceIds: [a.id] })).status).toBe(403);
    expect((await support.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: 'x', message: 'y', channels: ['email'] })).status).toBe(403);
  });
});

describe('นับผู้รับ (C8 หัว Drawer)', () => {
  it('Owner + Admin ที่ใช้งานอยู่ · คนเดียวหลาย Workspace นับครั้งเดียว · แยกจำนวนที่อยู่ในรายชื่อไม่ส่ง', async () => {
    const r = await owner.agent.post('/ops/announcements/audience').send({ workspaceIds: [a.id, b.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // a: owner, pm (ไม่ส่ง), owner@river (Admin) · b: owner@river → 3 คน 4 ฉบับ (ไม่ส่ง 1)
    expect(r.body).toEqual({ workspaces: 2, people: 3, emails: 3, suppressed: 1, noRecipients: [] });
  });

  it('Workspace ที่ไม่พบหรือถูกลบ → 404 ทั้งคำขอ · ข้อมูลผิดรูป 400', async () => {
    const r = await owner.agent.post('/ops/announcements/audience').send({ workspaceIds: [a.id, c.id] });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'workspace_not_found', details: { missing: [c.id] } });
    expect((await owner.agent.post('/ops/announcements/audience').send({ workspaceIds: [] })).status).toBe(400);
    expect((await owner.agent.post('/ops/announcements/audience').send({ workspaceIds: ['x'] })).status).toBe(400);
  });
});

describe('ส่งตอนนี้', () => {
  it('อีเมล + แบนเนอร์: แทนตัวแปรต่อ Workspace · ลงประวัติการส่ง · ไม่ส่งถึงรายชื่อไม่ส่ง · Audit ทุก Workspace', async () => {
    const r = await owner.agent.post('/ops/announcements').send({
      workspaceIds: [a.id, b.id, a.id],
      title: 'ปรับเวลาปิดปรับปรุงของ {ชื่อ Workspace}',
      message: 'เรียนทีม {ชื่อ Workspace} ระบบจะปิดปรับปรุงคืนวันเสาร์ 22:00–23:00',
      channels: ['banner', 'email'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'sent', channels: ['email', 'banner'], recipients: 4, workspaces: { count: 2, names: ['Co lotus-demo', 'Co river-demo'] }, createdBy: 'Olive Owner', canCancel: true });
    const id = r.body.id as string;

    const rows = await deliveries(id);
    expect(rows.map((d) => [d.target_ref, d.status])).toEqual([
      ['owner@lotus-demo.example.com', 'queued'],
      ['owner@river-demo.example.com', 'queued'],
      ['owner@river-demo.example.com', 'queued'],
      ['pm@lotus-demo.example.com', 'suppressed'],
    ]);
    // ให้งาน scan ของ API ลูกค้าหยิบไปส่ง · รายการที่ไม่ส่งไม่ถูกหยิบ
    expect(rows.filter((d) => d.resend_requested_at).map((d) => d.target_ref)).toHaveLength(3);
    expect(rows.find((d) => d.status === 'suppressed')!.log).toEqual([expect.objectContaining({ kind: 'suppressed', message: 'hard_bounce', final: true })]);
    // ไม่ขึ้น Inbox · ข้อความแทนชื่อ Workspace ของผู้รับ
    expect(rows.every((d) => d.in_app === false && d.event_type === 'ops.announcement')).toBe(true);
    const lotus = rows.find((d) => d.target_ref === 'owner@lotus-demo.example.com')!;
    expect(lotus.payload).toEqual({ announcementId: id, title: 'ปรับเวลาปิดปรับปรุงของ Co lotus-demo', text: 'เรียนทีม Co lotus-demo ระบบจะปิดปรับปรุงคืนวันเสาร์ 22:00–23:00' });

    const tg = await targets(id);
    const ta = tg.find((x) => x.workspace_id === a.id)!;
    expect(ta).toMatchObject({ recipients: 3, banner_title: 'ปรับเวลาปิดปรับปรุงของ Co lotus-demo' });
    expect(ta.banner_until.getTime() - ta.banner_from.getTime()).toBe(BANNER_DAYS * 86_400_000);

    expect(await auditOf(a.id, 'ops.announcement')).toEqual([expect.stringMatching(/^\[Friday Olive Owner\] ประกาศ "ปรับเวลาปิดปรับปรุงของ Co lotus-demo" ถึง Owner \/ Admin · อีเมล \+ แบนเนอร์ในแอป · ส่งทันที$/)]);
    expect(await auditOf(b.id, 'ops.announcement')).toHaveLength(1);
    const staffLog = (await t.owner.query(`SELECT staff_id, action FROM staff_audit_logs WHERE target_id = $1`, [id])).rows;
    expect(staffLog).toEqual([{ staff_id: owner.id, action: 'ops.announcement' }]);

    // ประวัติ: สรุปผลการส่งอีเมล
    const list = await owner.agent.get('/ops/announcements');
    expect(list.body.items[0]).toMatchObject({ id, email: { total: 4, sent: 0, suppressed: 1, failed: 0, waiting: 3 } });
  });

  it('แบนเนอร์อย่างเดียว: ไม่สร้างแจ้งเตือนหรืออีเมล', async () => {
    const r = await owner.agent.post('/ops/announcements').send({ workspaceIds: [b.id], title: 'ฟีเจอร์ใหม่', message: 'ลอง Gantt แบบใหม่ได้แล้ว', channels: ['banner'] });
    expect(r.status).toBe(201);
    expect(await deliveries(r.body.id)).toEqual([]);
    expect((await targets(r.body.id))[0]).toMatchObject({ recipients: 1, banner_title: 'ฟีเจอร์ใหม่', banner_message: 'ลอง Gantt แบบใหม่ได้แล้ว' });
  });

  it('อีเมลอย่างเดียว: ไม่มีแบนเนอร์ · ส่งแล้วยกเลิกไม่ได้', async () => {
    const r = await owner.agent.post('/ops/announcements').send({ workspaceIds: [b.id], title: 'ใบกำกับภาษีพร้อมแล้ว', message: 'ดาวน์โหลดได้ที่หน้าการชำระเงิน', channels: ['email'] });
    expect(r.body.canCancel).toBe(false);
    expect((await targets(r.body.id))[0]).toMatchObject({ banner_from: null, banner_title: null });
    const x = await owner.agent.post(`/ops/announcements/${r.body.id}/cancel`).send({});
    expect(x.status).toBe(409);
    expect(x.body.error.code).toBe('announcement_sent');
  });

  it('ข้อมูลไม่ครบ / ช่องทางไม่รู้จัก → 400', async () => {
    expect((await owner.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: ' ', message: 'x', channels: ['email'] })).status).toBe(400);
    expect((await owner.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: 'x', message: 'x', channels: [] })).status).toBe(400);
    expect((await owner.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: 'x', message: 'x', channels: ['sms'] })).status).toBe(400);
  });
});

describe('ตั้งเวลาส่ง', () => {
  it('ยังไม่ส่งจนถึงเวลา · tick ส่งครั้งเดียว · ต้องเป็นอนาคต', async () => {
    const at = new Date(Date.now() + 3 * 86_400_000);
    expect((await owner.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: 'x', message: 'x', channels: ['email'], scheduledAt: new Date(Date.now() - 60_000).toISOString() })).body.error.code).toBe('scheduled_in_past');
    expect((await owner.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: 'x', message: 'x', channels: ['email'], scheduledAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).body.error.code).toBe('scheduled_too_far');

    const r = await owner.agent.post('/ops/announcements').send({ workspaceIds: [a.id], title: 'ราคารายปีใหม่ เริ่ม 1 ม.ค. 2570', message: 'ลูกค้ารายปีใช้ราคาเดิมจนครบสัญญา', channels: ['banner', 'email'], scheduledAt: at.toISOString() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'scheduled', sentAt: null, recipients: null });
    expect(await deliveries(r.body.id)).toEqual([]);
    expect((await auditOf(a.id, 'ops.announcement')).at(-1)).toContain('ตั้งเวลาส่ง');

    expect(await svc.tick(new Date(at.getTime() - 60_000))).toEqual({ sent: 0 });
    expect(await svc.tick(new Date(at.getTime() + 1000))).toEqual({ sent: 1 });
    expect(await svc.tick(new Date(at.getTime() + 120_000))).toEqual({ sent: 0 });
    expect((await deliveries(r.body.id)).map((d) => d.status)).toEqual(['queued', 'queued', 'suppressed']);
    expect((await owner.agent.get(`/ops/announcements/${r.body.id}`)).body).toMatchObject({ status: 'sent', recipients: 3 });
    const sys = (await t.owner.query(`SELECT staff_id FROM staff_audit_logs WHERE target_id = $1 AND action = 'ops.announcement_sent'`, [r.body.id])).rows;
    expect(sys).toEqual([{ staff_id: null }]);
  });

  it('ยกเลิกก่อนถึงเวลา → ไม่ส่ง · ยกเลิกซ้ำ 409 · Audit', async () => {
    const at = new Date(Date.now() + 86_400_000);
    const r = await owner.agent.post('/ops/announcements').send({ workspaceIds: [b.id], title: 'ยกเลิกได้', message: 'x', channels: ['email'], scheduledAt: at.toISOString() });
    const x = await owner.agent.post(`/ops/announcements/${r.body.id}/cancel`).send({ reason: 'ข้อความยังไม่ถูก' });
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    expect(x.body).toMatchObject({ status: 'cancelled', canCancel: false });
    expect((await owner.agent.post(`/ops/announcements/${r.body.id}/cancel`).send({})).body.error.code).toBe('announcement_cancelled');
    await svc.tick(new Date(at.getTime() + 1000));
    expect(await deliveries(r.body.id)).toEqual([]);
    expect((await auditOf(b.id, 'ops.announcement_cancelled')).at(-1)).toBe('[Friday Olive Owner] ยกเลิกประกาศที่ตั้งเวลาไว้ "ยกเลิกได้" · ข้อความยังไม่ถูก');
  });

  it('หยุดแบนเนอร์หลังส่ง → banner_until = ตอนนี้', async () => {
    const r = await owner.agent.post('/ops/announcements').send({ workspaceIds: [b.id], title: 'หยุดได้', message: 'x', channels: ['banner'] });
    const x = await owner.agent.post(`/ops/announcements/${r.body.id}/cancel`).send({});
    expect(x.body.status).toBe('stopped');
    const [tg] = await targets(r.body.id);
    expect(tg.banner_until.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await auditOf(b.id, 'ops.announcement_cancelled')).at(-1)).toContain('หยุดแสดงแบนเนอร์ประกาศ "หยุดได้"');
  });

  it('Workspace ถูกลบระหว่างรอเวลา → ไม่ได้รับ', async () => {
    const d = await customer(t, 'soon-gone', { status: 'active' });
    const at = new Date(Date.now() + 86_400_000);
    const r = await owner.agent.post('/ops/announcements').send({ workspaceIds: [d.id], title: 'x', message: 'x', channels: ['email', 'banner'], scheduledAt: at.toISOString() });
    await t.owner.query(`UPDATE workspaces SET deleted_at = now() WHERE id = $1`, [d.id]);
    await svc.tick(new Date(at.getTime() + 1000));
    expect(await deliveries(r.body.id)).toEqual([]);
    expect((await targets(r.body.id))[0]).toMatchObject({ recipients: null, banner_from: null });
  });
});

describe('ส่งทดสอบถึงฉัน', () => {
  it('ส่งถึงอีเมลของพนักงานพร้อมแทนตัวแปรด้วย Workspace แรก · ไม่ลงประวัติการส่งของลูกค้า', async () => {
    const before = (await t.owner.query(`SELECT count(*)::int AS n FROM notification_deliveries`)).rows[0].n;
    const r = await owner.agent.post('/ops/announcements/test').send({ title: 'ทดสอบ {ชื่อ Workspace}', message: 'สวัสดี {ชื่อ Workspace}', workspaceId: a.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ to: 'owner@friday.example.com' });
    const m = mail.sent.at(-1)!;
    expect(m).toMatchObject({ to: 'owner@friday.example.com', subject: '[ทดสอบ] [Friday] ประกาศจากทีม Friday: ทดสอบ Co lotus-demo' });
    expect(m.text).toContain('สวัสดี Co lotus-demo');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM notification_deliveries`)).rows[0].n).toBe(before);
    expect((await owner.agent.post('/ops/announcements/test').send({ title: 'x', message: 'y' })).body.to).toBe('owner@friday.example.com');
  });
});

describe('ประวัติ', () => {
  it('ล่าสุดก่อน · ไม่พบ 404', async () => {
    const r = await owner.agent.get('/ops/announcements');
    expect(r.status).toBe(200);
    expect(r.body.bannerDays).toBe(BANNER_DAYS);
    const times = r.body.items.map((i: { createdAt: string }) => i.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect((await owner.agent.get(`/ops/announcements/${randomUUID()}`)).status).toBe(404);
    expect((await owner.agent.get('/ops/announcements/nope')).status).toBe(404);
  });
});
