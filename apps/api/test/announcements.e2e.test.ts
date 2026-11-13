// O24 · แบนเนอร์ประกาศจากทีม Friday (ปิดได้ต่อคน) และอีเมลประกาศผ่านท่อส่งเดิม (ประวัติการส่ง O23 · รายชื่อไม่ส่ง)
// ตาราง announcement_* เขียนโดย ops-api · test จำลองแถวที่ ops-api เขียนด้วยบัญชีเจ้าของตาราง · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChannelDispatcher } from '../src/channels/dispatcher.js';
import { Mailer } from '../src/core/mail.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

process.env.SMTP_HOST = 'smtp.test.example.com';
process.env.MAIL_FROM = 'Friday Work Management <notify@friday.test>';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let other: Awaited<ReturnType<typeof seedTeam>>;
let admin: Client;
let adminId: string;
let wsId: string;
let otherWs: string;
let mails: Record<string, unknown>[] = [];

/** ประกาศ 1 รายการที่ ops-api ส่งแล้ว · banner = ช่วงเวลาที่แสดง (นาทีจากตอนนี้) */
async function announce(title: string, targets: { ws: string; from?: number; until?: number; banner?: boolean }[]) {
  const id = (await t.owner.query(`INSERT INTO announcements (title, message, audience, channels, sent_at) VALUES ($1, 'ข้อความ', 'owners_admins', '{banner,email}', now()) RETURNING id`, [title])).rows[0].id as string;
  for (const x of targets) {
    const banner = x.banner ?? true;
    await t.owner.query(
      `INSERT INTO announcement_targets (announcement_id, workspace_id, recipients, banner_title, banner_message, banner_from, banner_until)
       VALUES ($1, $2, 2, $3, $4, CASE WHEN $5 THEN now() + make_interval(mins => $6) END, CASE WHEN $5 THEN now() + make_interval(mins => $7) END)`,
      [id, x.ws, banner ? title : null, banner ? `รายละเอียดของ ${title}` : null, banner, x.from ?? -5, x.until ?? 60 * 24 * 30],
    );
  }
  return id;
}

/** อ่าน announcement_targets ในฐานะ friday_app ของผู้ใช้ใน Workspace (ตรวจ RLS ตรง ๆ) */
async function asApp(userId: string, workspaceId: string, q: string, params: unknown[] = []) {
  await t.owner.query('BEGIN');
  try {
    await t.owner.query('SET LOCAL ROLE friday_app');
    await t.owner.query(`SELECT set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)`, [userId, workspaceId]);
    return (await t.owner.query(q, params)).rows;
  } finally {
    await t.owner.query('ROLLBACK');
  }
}

beforeAll(async () => {
  t = await startApp();
  t.app.get(Mailer).transportFactory = () => ({ sendMail: async (m: Record<string, unknown>) => void mails.push(m) });
  team = await seedTeam(t, { slug: 'lotus-demo' });
  admin = await client(t.app);
  adminId = await signup(admin, 'pm@lotus-demo.example.com', 'Ploy');
  await addMember(t.owner, team.slug, adminId, 'admin');
  other = await seedTeam(t, { slug: 'river-demo', key: 'RV' });
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  otherWs = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [other.slug])).rows[0].id;
  // ไม่มีช่วงงดส่ง ให้ test ส่งได้ทุกเวลา
  for (const uid of [team.leadId, adminId]) await t.owner.query('INSERT INTO user_notification_settings (workspace_id, user_id, quiet_start, quiet_end, quiet_on_holidays) VALUES ($1,$2,NULL,NULL,false)', [wsId, uid]);
});
afterAll(() => t.close());
beforeEach(async () => {
  mails = [];
  for (const table of ['announcement_dismissals', 'announcement_targets', 'announcements', 'notification_deliveries', 'notifications']) await t.owner.query(`DELETE FROM ${table}`);
  await t.owner.query('DELETE FROM email_suppressions');
});

describe('แบนเนอร์ประกาศในแอป', () => {
  it('Owner / Admin เห็นเฉพาะที่ส่งแล้วและยังไม่หมดเวลา ของ Workspace ตัวเอง · ล่าสุดก่อน · สมาชิกได้รายการว่าง', async () => {
    const older = await announce('ปิดปรับปรุงคืนวันเสาร์', [{ ws: wsId, from: -60 }]);
    const newer = await announce('ราคารายปีใหม่', [{ ws: wsId }, { ws: otherWs }]);
    await announce('หมดเวลาแล้ว', [{ ws: wsId, from: -100, until: -1 }]);
    await announce('ยังไม่ถึงเวลา', [{ ws: wsId, from: 10 }]);
    await announce('อีเมลอย่างเดียว', [{ ws: wsId, banner: false }]);
    await announce('ของที่อื่น', [{ ws: otherWs }]);

    const r = await team.lead.get(`${team.ws}/announcements`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([newer, older]);
    expect(r.body.items[0]).toEqual({ id: newer, title: 'ราคารายปีใหม่', message: 'รายละเอียดของ ราคารายปีใหม่', sentAt: expect.any(String) });
    expect((await admin.get(`${team.ws}/announcements`)).body.items).toHaveLength(2);
    expect((await team.dev.get(`${team.ws}/announcements`)).body).toEqual({ items: [] });
    // ไม่ใช่สมาชิก Workspace → 404
    expect((await other.dev.get(`${team.ws}/announcements`)).status).toBe(404);
  });

  it('RLS: สมาชิกธรรมดาอ่าน announcement_targets ไม่ได้ · ตาราง announcements ของทีม Friday อ่านไม่ได้เลย', async () => {
    await announce('ทดสอบ RLS', [{ ws: wsId }, { ws: otherWs }]);
    expect(await asApp(team.leadId, wsId, 'SELECT banner_title FROM announcement_targets')).toEqual([{ banner_title: 'ทดสอบ RLS' }]);
    expect(await asApp(team.devId, wsId, 'SELECT banner_title FROM announcement_targets')).toEqual([]);
    await expect(asApp(team.leadId, wsId, 'SELECT * FROM announcements')).rejects.toThrow(/permission denied/);
  });

  it('ปิดได้ต่อคน: คนที่ปิดไม่เห็นอีก · Admin อีกคนยังเห็น · ปิดซ้ำได้ผลเดิม', async () => {
    const id = await announce('แจ้งเปลี่ยนเวลาทำการ Support', [{ ws: wsId }]);
    const d = await team.lead.post(`${team.ws}/announcements/${id}/dismiss`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toEqual({ id, dismissed: true });
    expect((await team.lead.get(`${team.ws}/announcements`)).body.items).toEqual([]);
    expect((await admin.get(`${team.ws}/announcements`)).body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await team.lead.post(`${team.ws}/announcements/${id}/dismiss`)).status).toBe(200);
    const rows = (await t.owner.query('SELECT user_id FROM announcement_dismissals WHERE announcement_id = $1', [id])).rows;
    expect(rows).toEqual([{ user_id: team.leadId }]);
  });

  it('ปิดของที่ไม่มี / ไม่ใช่ของ Workspace นี้ / สมาชิกธรรมดา → 404 · ปิดแทนคนอื่นไม่ได้ (RLS)', async () => {
    const id = await announce('ของ river', [{ ws: otherWs }]);
    expect((await team.lead.post(`${team.ws}/announcements/${id}/dismiss`)).status).toBe(404);
    expect((await team.lead.post(`${team.ws}/announcements/not-a-uuid/dismiss`)).status).toBe(404);
    const mine = await announce('ของ lotus', [{ ws: wsId }]);
    expect((await team.dev.post(`${team.ws}/announcements/${mine}/dismiss`)).status).toBe(404);
    await expect(asApp(team.leadId, wsId, 'INSERT INTO announcement_dismissals (announcement_id, workspace_id, user_id) VALUES ($1, $2, $3)', [mine, wsId, adminId])).rejects.toThrow(/row-level security/);
  });
});

describe('อีเมลประกาศ (ผ่านท่อส่งของ channels)', () => {
  /** แถวที่ ops-api เขียนตอนส่ง: แจ้งเตือน in_app = false + รายการส่งที่ขอให้ส่ง */
  async function queued(userId: string, email: string) {
    const n = (
      await t.owner.query(
        `INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason, in_app) VALUES ($1, $2, 'ops.announcement', $3, 'คุณเป็น Owner / Admin ของ Workspace Friday', false) RETURNING id`,
        [wsId, userId, JSON.stringify({ announcementId: '00000000-0000-4000-8000-000000000001', title: 'ปรับราคารายปีของ Friday', text: 'เรียนทีม Friday\nลูกค้ารายปีใช้ราคาเดิมจนครบสัญญา' })],
      )
    ).rows[0].id;
    return (await t.owner.query(`INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref, target_label, resend_requested_at) VALUES ($1, $2, 'email', $3, $3, now()) RETURNING id`, [wsId, n, email])).rows[0].id as string;
  }

  it('ส่งในนามระบบ (ไม่ใช้ผู้ส่งของ Workspace) · เนื้อความเต็มแม้โหมดปลอดภัย · ลงประวัติการส่ง · ไม่ขึ้น Inbox', async () => {
    await t.owner.query(`INSERT INTO email_sender_configs (workspace_id, from_name, from_email, reply_to) VALUES ($1, 'ทีม Lotus', 'it@lotus-demo.example.com', 'it@lotus-demo.example.com') ON CONFLICT (workspace_id) DO NOTHING`, [wsId]);
    const id = await queued(team.leadId, 'lead@lotus-demo.example.com');
    expect(await t.app.get(ChannelDispatcher).resendRequested()).toBe(1);
    const [d] = (await t.owner.query('SELECT * FROM notification_deliveries WHERE id = $1', [id])).rows;
    expect(d).toMatchObject({ status: 'sent', resend_requested_at: null, response: { status: 250, body: 'SMTP accepted' } });
    expect(d.content.view.subject).toBe('[Friday] ประกาศจากทีม Friday: ปรับราคารายปีของ Friday');
    expect(d.content.view.text).toContain('ลูกค้ารายปีใช้ราคาเดิมจนครบสัญญา');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'lead@lotus-demo.example.com', from: 'Friday Work Management <notify@friday.test>' });
    expect(mails[0].replyTo).toBeUndefined();
    expect(String(mails[0].html)).toContain('เรียนทีม Friday');
    const inbox = await team.lead.get(`/me/notifications?workspace=${team.slug}`);
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).not.toContain('ops.announcement');
  });

  it('อีเมลเข้ารายชื่อไม่ส่งระหว่างรอ → ไม่ส่ง (suppressed)', async () => {
    const id = await queued(adminId, 'pm@lotus-demo.example.com');
    await t.owner.query(`INSERT INTO email_suppressions (email, reason) VALUES ('pm@lotus-demo.example.com', 'complaint')`);
    await t.app.get(ChannelDispatcher).resendRequested();
    const [d] = (await t.owner.query('SELECT status, log FROM notification_deliveries WHERE id = $1', [id])).rows;
    expect(d.status).toBe('suppressed');
    expect(d.log).toEqual([expect.objectContaining({ kind: 'suppressed', message: 'complaint' })]);
    expect(mails).toEqual([]);
  });

  it('ผู้รับไม่เป็นสมาชิกแล้ว → ยกเลิกการส่ง', async () => {
    const id = await queued(adminId, 'pm@lotus-demo.example.com');
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE workspace_id = $1 AND user_id = $2`, [wsId, adminId]);
    try {
      await t.app.get(ChannelDispatcher).resendRequested();
      const [d] = (await t.owner.query('SELECT status, last_error FROM notification_deliveries WHERE id = $1', [id])).rows;
      expect(d.status).toBe('failed');
      expect(d.last_error).toContain('ไม่ได้เป็นสมาชิก');
      expect(mails).toEqual([]);
    } finally {
      await t.owner.query(`UPDATE workspace_members SET status = 'active' WHERE workspace_id = $1 AND user_id = $2`, [wsId, adminId]);
    }
  });
});
