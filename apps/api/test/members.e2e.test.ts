// A14 · สมาชิก Workspace, ลิงก์เชิญ และคำขอเข้าร่วม · ข้อมูลสมมติเท่านั้น
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { Mailer } from '../src/core/mail.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let moduleId: string;
let seq = 0;
let plain: { c: Client; id: string };
const events: DomainEvent[] = [];
const anon = () => request(t.app.getHttpServer());

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  moduleId = team.project.modules[0].id;
  t.app.get(EventBus).on('*', (e) => { events.push(e); });
  plain = await person('member', 'Plain');
});
afterAll(() => t.close());

/** ผู้ใช้ใหม่ที่เข้า Workspace ด้วย Role ที่ระบุ (ข้ามขั้นเชิญ) */
async function person(role: 'owner' | 'admin' | 'member' | 'guest' | null, name = `P${++seq}`) {
  const c = await client(t.app);
  const email = `${name.toLowerCase()}@members.example.com`;
  const id = await signup(c, email, name);
  if (role) await addMember(t.owner, team.slug, id, role);
  return { c, id, email };
}
async function setPlan(code: string) {
  await team.lead.get(`${team.ws}/usage`);
  await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = $2), status = 'active', trial_ends_at = NULL WHERE workspace_id = $1`, [wsId, code]);
}
const seatsUsed = async () => Number((await t.owner.query(`SELECT count(*) FROM workspace_members WHERE workspace_id = $1 AND status = 'active' AND role <> 'guest'`, [wsId])).rows[0].count);
/** ล้างสมาชิกส่วนเกินจากกรณีก่อนหน้า (ปิดใช้งาน) เหลือแค่ lead, dev และ plain เพื่อให้นับ Seat ได้ตรง */
async function resetSeats() {
  await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE workspace_id = $1 AND user_id NOT IN ($2, $3, $4)`, [wsId, team.leadId, team.devId, plain.id]);
}
const roleOf = async (id: string) => (await t.owner.query('SELECT role, status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, id])).rows[0];

describe('GET / PATCH w/', () => {
  it('สมาชิกทุกคนรวม Guest ดูได้ · แก้เฉพาะ ws.settings · คนนอก 404', async () => {
    const g = await person('guest');
    const r = await team.dev.get(team.ws);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ slug: team.slug, name: 'Friday', role: 'member', defaultLocale: 'th', allowDomainJoin: false });
    expect((await g.c.get(team.ws)).body.role).toBe('guest');
    const out = await person(null);
    expect((await out.c.get(team.ws)).status).toBe(404);

    const patched = await team.lead.patch(team.ws, { name: 'Friday Software', defaultLocale: 'en', allowDomainJoin: true });
    expect(patched.body).toMatchObject({ name: 'Friday Software', defaultLocale: 'en', allowDomainJoin: true });
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'workspace.updated'`)).rowCount).toBe(1);
    expect((await team.dev.patch(team.ws, { name: 'x' })).status).toBe(403);
    expect((await team.lead.patch(team.ws, {})).status).toBe(400);
    expect((await team.lead.patch(team.ws, { defaultLocale: 'fr' })).status).toBe(400);
    await team.lead.patch(team.ws, { name: 'Friday', defaultLocale: 'th', allowDomainJoin: false });
  });
});

describe('PATCH w/members/{userId} · Role', () => {
  it('Owner เปลี่ยน Role ได้ พร้อม Audit perm.role_changed · Member เปลี่ยนไม่ได้', async () => {
    const p = await person('member');
    const r = await team.lead.patch(`${team.ws}/members/${p.id}`, { role: 'admin', jobTitle: 'Tech Lead' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ role: 'admin', jobTitle: 'Tech Lead' });
    const log = await t.owner.query(`SELECT summary, category FROM audit_logs WHERE action = 'perm.role_changed' AND target_id = $1`, [p.id]);
    expect(log.rows).toEqual([{ summary: `${p.email}: member → admin`, category: 'perm' }]);
    expect((await team.dev.patch(`${team.ws}/members/${p.id}`, { role: 'member' })).status).toBe(403);
    expect((await team.lead.patch(`${team.ws}/members/${p.id}`, {})).status).toBe(400);
    expect((await team.lead.patch(`${team.ws}/members/${p.id}`, { role: 'boss' })).status).toBe(400);
    expect((await team.lead.patch(`${team.ws}/members/00000000-0000-4000-8000-000000000000`, { role: 'member' })).status).toBe(404);
    expect((await team.lead.patch(`${team.ws}/members/abc`, { role: 'member' })).status).toBe(400);
  });

  it('Admin ตั้งคนอื่นเป็น Admin ได้ แต่ตั้ง Owner หรือแก้ Role ของ Owner ไม่ได้', async () => {
    const admin = await person('admin');
    const m = await person('member');
    expect((await admin.c.patch(`${team.ws}/members/${m.id}`, { role: 'admin' })).status).toBe(200);
    const toOwner = await admin.c.patch(`${team.ws}/members/${m.id}`, { role: 'owner' });
    expect(toOwner.status).toBe(403);
    expect(toOwner.body.error.details.permission).toBe('ws.owner');
    expect((await admin.c.patch(`${team.ws}/members/${team.leadId}`, { role: 'member' })).status).toBe(403);
  });

  it('Owner คนสุดท้ายลดสิทธิ์ไม่ได้ · มี Owner ใหม่แล้วลดตัวเองได้', async () => {
    const last = await team.lead.patch(`${team.ws}/members/${team.leadId}`, { role: 'admin' });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('last_owner');
    const second = await person('member');
    expect((await team.lead.patch(`${team.ws}/members/${second.id}`, { role: 'owner' })).status).toBe(200);
    expect((await team.lead.patch(`${team.ws}/members/${team.leadId}`, { role: 'admin' })).status).toBe(200);
    expect((await second.c.patch(`${team.ws}/members/${team.leadId}`, { role: 'owner' })).status).toBe(200);
    expect((await roleOf(team.leadId)).role).toBe('owner');
  });

  it('Guest → Member ต้องมี Seat ว่าง (402) · Guest ไม่นับ Seat', async () => {
    await setPlan('free');
    await resetSeats();
    const g = await person('guest');
    const used = await seatsUsed();
    for (let i = used; i < 5; i++) await person('member');
    expect(await seatsUsed()).toBe(5);
    const full = await team.lead.patch(`${team.ws}/members/${g.id}`, { role: 'member' });
    expect(full.status).toBe(402);
    expect(full.body.error.details).toMatchObject({ kind: 'seats', limit: 5, current: 5 });
    expect((await roleOf(g.id)).role).toBe('guest');
    await person('guest'); // เพิ่ม Guest ได้ไม่จำกัด
    expect(await seatsUsed()).toBe(5);
  });
});

describe('ปิด / เปิดการใช้งานสมาชิก', () => {
  it('ปิดแล้วยกเลิก Session + LINE binding และคืนรายการงานค้างให้หน้าโอนงาน', async () => {
    await setPlan('team_l');
    const solo = await person('member', 'Solo');
    const issue = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานค้างของ Solo', moduleId });
    await t.owner.query(`UPDATE issues SET plan_end = '2026-12-20' WHERE id = $1`, [issue.body.id]);
    await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, issue.body.id, solo.id]);
    await t.owner.query(`INSERT INTO line_bindings (user_id, line_user_id) VALUES ($1, 'U-solo')`, [solo.id]);
    expect((await solo.c.get('/me')).status).toBe(200);

    const pre = await team.lead.get(`${team.ws}/members/${solo.id}/handover`);
    expect(pre.body).toMatchObject({ member: { displayName: 'Solo' }, assignedIssues: { total: 1, items: [{ key: issue.body.key, title: 'งานค้างของ Solo', planEnd: '2026-12-20' }] }, ownedProjects: [] });

    const r = await team.lead.post(`${team.ws}/members/${solo.id}/deactivate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'deactivated', signedOut: true, handover: { assignedIssues: { total: 1 } } });
    expect((await roleOf(solo.id)).status).toBe('deactivated');
    expect((await solo.c.get('/me')).status).toBe(401);
    expect((await t.owner.query('SELECT 1 FROM line_bindings WHERE user_id = $1', [solo.id])).rowCount).toBe(0);
    expect((await solo.c.get(team.ws)).status).toBeGreaterThanOrEqual(401);
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'perm.member_deactivated' AND target_id = $1`, [solo.id])).rowCount).toBe(1);
    expect((await team.lead.post(`${team.ws}/members/${solo.id}:deactivate`)).body.error.code).toBe('already_deactivated');
  });

  it('มี Workspace อื่นที่ยัง active อยู่ → ไม่ยกเลิก Session และ LINE (เป็นของบัญชี)', async () => {
    const multi = await person('member', 'Multi');
    const other = await client(t.app);
    await signup(other, 'otherowner@members.example.com', 'Other Owner');
    expect((await other.post('/workspaces', { name: 'Other', slug: 'other-ws' })).status).toBe(201);
    await addMember(t.owner, 'other-ws', multi.id, 'member');
    await t.owner.query(`INSERT INTO line_bindings (user_id, line_user_id) VALUES ($1, 'U-multi')`, [multi.id]);
    const r = await team.lead.post(`${team.ws}/members/${multi.id}/deactivate`);
    expect(r.body.signedOut).toBe(false);
    expect((await multi.c.get('/me')).status).toBe(200);
    expect((await t.owner.query('SELECT 1 FROM line_bindings WHERE user_id = $1', [multi.id])).rowCount).toBe(1);
  });

  it('ข้อจำกัด: ปิดตัวเองไม่ได้ · Admin ปิด Owner ไม่ได้ · Owner คนสุดท้ายปิดไม่ได้ · Member ใช้ไม่ได้', async () => {
    expect((await team.lead.post(`${team.ws}/members/${team.leadId}/deactivate`)).body.error.code).toBe('cannot_deactivate_self');
    const admin = await person('admin');
    expect((await admin.c.post(`${team.ws}/members/${team.leadId}/deactivate`)).status).toBe(403);
    expect((await team.dev.post(`${team.ws}/members/${admin.id}/deactivate`)).status).toBe(403);
    expect((await team.dev.get(`${team.ws}/members/${admin.id}/handover`)).status).toBe(403);
    const o2 = await person('owner');
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [team.leadId]);
    const lastOwner = await o2.c.post(`${team.ws}/members/${o2.id}/deactivate`);
    expect(lastOwner.status).toBe(409);
    await t.owner.query(`UPDATE workspace_members SET status = 'active' WHERE user_id = $1`, [team.leadId]);
    await t.owner.query(`UPDATE workspace_members SET role = 'member' WHERE user_id = $1`, [o2.id]);
    const lastO = await team.lead.post(`${team.ws}/members/${o2.id}/deactivate`);
    expect(lastO.status).toBe(200);
  });

  it('เปิดใช้งานอีกครั้งต้องมี Seat ว่าง (402) · Guest ไม่ใช้ Seat', async () => {
    const m = await person('member', 'Back');
    await team.lead.post(`${team.ws}/members/${m.id}/deactivate`);
    await setPlan('free');
    await resetSeats();
    const used = await seatsUsed();
    for (let i = used; i < 5; i++) await person('member');
    const full = await team.lead.post(`${team.ws}/members/${m.id}/reactivate`);
    expect(full.status).toBe(402);
    await setPlan('team_l');
    expect((await team.lead.post(`${team.ws}/members/${m.id}:reactivate`)).body).toEqual({ userId: m.id, status: 'active' });
    expect((await team.lead.post(`${team.ws}/members/${m.id}/reactivate`)).body.error.code).toBe('already_active');
    expect((await roleOf(m.id)).status).toBe('active');
  });
});

describe('คำเชิญ · ส่งซ้ำ, Seat, Event', () => {
  it('เชิญตรวจ Seat ล่วงหน้า (402) แต่เชิญ Guest ไม่ใช้ Seat', async () => {
    await setPlan('free');
    await resetSeats();
    const used = await seatsUsed();
    const room = Math.max(0, 5 - used);
    const emails = Array.from({ length: room + 1 }, (_, i) => `seat${i}@invite.example.com`);
    const full = await team.lead.post(`${team.ws}/invitations`, { emails });
    expect(full.status, JSON.stringify(full.body)).toBe(402);
    expect(full.body.error.details).toMatchObject({ kind: 'seats', increment: room + 1 });
    expect((await team.lead.post(`${team.ws}/invitations`, { emails, workspaceRole: 'guest' })).status).toBe(201);
    await setPlan('team_l');
  });

  it('ส่งซ้ำออก token ใหม่ ของเดิมใช้ไม่ได้ · ผู้ส่งหรือ Admin เท่านั้น · ส่งเหตุการณ์ member.invited / member.joined', async () => {
    events.length = 0;
    const inv = await team.lead.post(`${team.ws}/invitations`, { emails: ['resend@invite.example.com'], projectKey: team.key, projectRole: 'member' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const first = inv.body.items[0];
    const oldToken = first.inviteUrl.split('/join/')[1];
    expect(events.filter((e) => e.type === 'member.invited')).toMatchObject([{ projectId: team.project.id, actorId: team.leadId, data: { email: 'resend@invite.example.com', invitationId: first.invitationId } }]);

    expect((await team.dev.post(`${team.ws}/invitations/${first.invitationId}/resend`)).status).toBe(403);
    const re = await team.lead.post(`${team.ws}/invitations/${first.invitationId}/resend`);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    const newToken = re.body.inviteUrl.split('/join/')[1];
    expect(newToken).not.toBe(oldToken);
    expect((await anon().get(`/api/v1/invitations/${oldToken}`)).status).toBe(404);
    expect((await anon().get(`/api/v1/invitations/${newToken}`)).body).toMatchObject({ status: 'pending', email: 'resend@invite.example.com' });
    expect((await team.lead.post(`${team.ws}/invitations/${first.invitationId}:resend`)).status).toBe(200);
    expect((await team.lead.post(`${team.ws}/invitations/nope/resend`)).status).toBe(404);

    const joiner = await client(t.app);
    await signup(joiner, 'resend@invite.example.com', 'Resend');
    events.length = 0;
    const token = (await team.lead.post(`${team.ws}/invitations/${first.invitationId}/resend`)).body.inviteUrl.split('/join/')[1];
    expect((await joiner.post(`/invitations/${token}/accept`)).status).toBe(200);
    expect(events.filter((e) => e.type === 'member.joined')).toMatchObject([{ projectId: team.project.id, data: { via: 'invitation' } }]);
    expect((await team.lead.post(`${team.ws}/invitations/${first.invitationId}/resend`)).body.error.code).toBe('invitation_not_pending');
  });

  it('ส่งอีเมลคำเชิญเมื่อตั้ง SMTP · ตอบกลับหาผู้เชิญ · ภาษาตาม Workspace · ส่งไม่ได้คำเชิญยังอยู่ · ส่งซ้ำส่งอีเมลใหม่', async () => {
    const mailer = t.app.get(Mailer);
    const original = mailer.transportFactory;
    const prevHost = process.env.SMTP_HOST;
    const prev = (await t.owner.query('SELECT name, default_locale FROM workspaces WHERE id = $1', [wsId])).rows[0];
    const mails: Array<{ to: string; subject: string; text: string; html: string; replyTo?: string }> = [];
    let failFor: string | null = null;
    try {
      // ยังไม่ตั้ง SMTP = ไม่ส่ง แต่ได้ลิงก์ไปส่งเอง
      delete process.env.SMTP_HOST;
      const off = await team.lead.post(`${team.ws}/invitations`, { emails: ['nomail@invite.example.com'] });
      expect(off.body.items[0]).toMatchObject({ status: 'invited', emailSent: false });

      process.env.SMTP_HOST = 'smtp.test.example.com';
      mailer.transportFactory = () => ({
        sendMail: async (m: Record<string, unknown>) => {
          if (m.to === failFor) throw new Error('smtp down');
          mails.push(m as (typeof mails)[number]);
        },
      });
      await t.owner.query(`UPDATE workspaces SET name = 'ทีมสมมติ', default_locale = 'th' WHERE id = $1`, [wsId]);
      failFor = 'bounce@invite.example.com';
      const r = await team.lead.post(`${team.ws}/invitations`, { emails: ['mail@invite.example.com', 'bounce@invite.example.com'], projectKey: team.key, message: 'มาช่วยกันนะ' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const byEmail = Object.fromEntries(r.body.items.map((i: { email: string }) => [i.email, i]));
      expect(byEmail['mail@invite.example.com']).toMatchObject({ status: 'invited', emailSent: true });
      expect(byEmail['bounce@invite.example.com']).toMatchObject({ status: 'invited', emailSent: false });
      expect((await t.owner.query(`SELECT 1 FROM invitations WHERE email = 'bounce@invite.example.com' AND status = 'pending'`)).rowCount).toBe(1);
      expect(mails).toHaveLength(1);
      const [m] = mails;
      expect(m).toMatchObject({ to: 'mail@invite.example.com', replyTo: `lead@${team.slug}.example.com` });
      expect(m.subject).toBe('Mick เชิญคุณเข้าร่วม ทีมสมมติ บน Friday Work Management');
      expect(m.text).toContain(byEmail['mail@invite.example.com'].inviteUrl);
      expect(m.text).toContain('มาช่วยกันนะ');
      expect(m.text).toContain(`โปรเจกต์: ${team.project.name}`);
      expect(m.html).toContain(`href="${byEmail['mail@invite.example.com'].inviteUrl}"`);

      // ส่งซ้ำ = อีเมลใหม่ที่มีลิงก์ใหม่ · Workspace ภาษาอังกฤษได้อีเมลอังกฤษ · ข้อความกันการแทรก HTML
      await t.owner.query(`UPDATE workspaces SET name = '<b>Acme</b>', default_locale = 'en' WHERE id = $1`, [wsId]);
      const re = await team.lead.post(`${team.ws}/invitations/${byEmail['mail@invite.example.com'].invitationId}/resend`);
      expect(re.body).toMatchObject({ emailSent: true });
      expect(mails).toHaveLength(2);
      expect(mails[1].subject).toBe('Mick invited you to <b>Acme</b> on Friday Work Management');
      expect(mails[1].text).toContain(re.body.inviteUrl);
      expect(mails[1].html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
      expect(mails[1].html).not.toContain('<b>Acme</b>');
    } finally {
      mailer.transportFactory = original;
      if (prevHost === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = prevHost;
      await t.owner.query('UPDATE workspaces SET name = $2, default_locale = $3 WHERE id = $1', [wsId, prev.name, prev.default_locale]);
    }
  });

  it('PM ได้แจ้ง member.joined ครั้งเดียว (ผู้เชิญเป็น Owner หรือ Admin ของโปรเจกต์ ซึ่งนับเป็น PM) · ไม่ได้ซ้ำในฐานะผู้เชิญ', async () => {
    const ask = async (email: string, inviter: Client) => {
      const inv = await inviter.post(`${team.ws}/invitations`, { emails: [email], projectKey: team.key });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const c = await client(t.app);
      await signup(c, email, email.split('@')[0]!);
      await c.post(`/invitations/${inv.body.items[0].inviteUrl.split('/join/')[1]}/accept`);
    };
    await t.owner.query('DELETE FROM notifications');
    await ask('pm-inviter@invite.example.com', team.lead);
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'member.joined' AND recipient_id = $1`, [team.leadId])).rowCount).toBe(1);
    await t.owner.query('DELETE FROM notifications');
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1,$2,$3,'admin') ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'admin'`, [wsId, team.project.id, team.devId]);
    await ask('dev-inviter@invite.example.com', team.dev);
    expect((await t.owner.query(`SELECT recipient_id FROM notifications WHERE event_type = 'member.joined' ORDER BY recipient_id`)).rows.map((r) => r.recipient_id).sort()).toEqual([team.devId, team.leadId].sort());
  });
});

describe('ลิงก์เชิญ', () => {
  const token = (url: string) => url.split('/join/')[1]!;

  it('สร้าง / ดู / เพิกถอน · token แสดงครั้งเดียว · สร้างได้เฉพาะ Owner / Admin · Role Admin ผ่านลิงก์ไม่ได้', async () => {
    const r = await team.lead.post(`${team.ws}/invite-links`, { role: 'member', expiresInDays: 7 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ role: 'member', url: expect.stringContaining('/join/lnk_') });
    const list = await team.lead.get(`${team.ws}/invite-links`);
    expect(list.body.items).toMatchObject([{ id: r.body.id, role: 'member', createdBy: { displayName: 'Mick' } }]);
    expect(JSON.stringify(list.body)).not.toContain(token(r.body.url));
    expect((await t.owner.query('SELECT token_hash FROM invite_links WHERE id = $1', [r.body.id])).rows[0].token_hash).not.toContain(token(r.body.url));
    expect((await team.dev.post(`${team.ws}/invite-links`, {})).status).toBe(403);
    expect((await team.dev.get(`${team.ws}/invite-links`)).status).toBe(403);
    expect((await team.lead.post(`${team.ws}/invite-links`, { role: 'admin' })).status).toBe(400);
    expect((await team.lead.post(`${team.ws}/invite-links`, { expiresInDays: 3 })).status).toBe(400);
    expect((await team.dev.delete(`${team.ws}/invite-links/${r.body.id}`)).status).toBe(403);
    expect((await team.lead.delete(`${team.ws}/invite-links/${r.body.id}`)).body).toEqual({ revoked: true });
    expect((await team.lead.delete(`${team.ws}/invite-links/${r.body.id}`)).status).toBe(404);
    expect((await team.lead.get(`${team.ws}/invite-links`)).body.items).toEqual([]);
  });

  it('GET join/{token} สาธารณะ · POST join/{token} เข้าร่วมเป็นสมาชิก · เข้าซ้ำไม่เป็นไร · Audit', async () => {
    const link = (await team.lead.post(`${team.ws}/invite-links`, { role: 'member' })).body;
    const pre = await anon().get(`/api/v1/join/${token(link.url)}`);
    expect(pre.body).toMatchObject({ workspace: { slug: team.slug, name: 'Friday' }, role: 'member', status: 'valid' });
    const p = await person(null, 'LinkJoin');
    const joined = await p.c.post(`/join/${token(link.url)}`);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body).toMatchObject({ workspace: { slug: team.slug }, role: 'member', alreadyMember: false });
    expect((await roleOf(p.id)).role).toBe('member');
    expect((await p.c.post(`/join/${token(link.url)}`)).body.alreadyMember).toBe(true);
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'member.joined' AND target_id = $1`, [link.id])).rowCount).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'member.joined', data: { userId: p.id, via: 'invite_link' } });
    expect((await anon().post(`/api/v1/join/${token(link.url)}`)).status).toBeGreaterThanOrEqual(401);
  });

  it('หมดอายุ / ถูกเพิกถอน → 410 · token มั่ว 404 · ถูกปิดการใช้งานในนี้แล้วเข้าไม่ได้ · Seat เต็ม 402 แต่ Guest ผ่าน', async () => {
    const link = (await team.lead.post(`${team.ws}/invite-links`, { role: 'member' })).body;
    await t.owner.query(`UPDATE invite_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [link.id]);
    const p = await person(null);
    const expired = await p.c.post(`/join/${token(link.url)}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('invite_link_expired');
    expect((await anon().get(`/api/v1/join/${token(link.url)}`)).body.status).toBe('expired');
    expect((await p.c.post('/join/lnk_nope')).status).toBe(404);
    expect((await p.c.post('/join/not-a-link-token')).status).toBe(404);

    const revoked = (await team.lead.post(`${team.ws}/invite-links`, {})).body;
    await team.lead.delete(`${team.ws}/invite-links/${revoked.id}`);
    expect((await p.c.post(`/join/${token(revoked.url)}`)).status).toBe(410);

    const gone = await person('member');
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1 AND workspace_id = $2`, [gone.id, wsId]);
    const fresh = (await team.lead.post(`${team.ws}/invite-links`, {})).body;
    expect((await gone.c.post(`/join/${token(fresh.url)}`)).body.error.code).toBe('member_deactivated');

    await setPlan('free');
    await resetSeats();
    const used = await seatsUsed();
    for (let i = used; i < 5; i++) await person('member');
    expect((await p.c.post(`/join/${token(fresh.url)}`)).status).toBe(402);
    const guestLink = (await team.lead.post(`${team.ws}/invite-links`, { role: 'guest' })).body;
    expect((await p.c.post(`/join/${token(guestLink.url)}`)).body).toMatchObject({ role: 'guest', alreadyMember: false });
    await setPlan('team_l');
  });
});

describe('คำขอเข้าร่วม Workspace (โดเมนเดียวกัน)', () => {
  it('ต้องเปิดใช้และอีเมลอยู่ในโดเมนที่ยืนยันแล้ว · Admin อนุมัติแล้วเป็น Member · ปฏิเสธ · ซ้ำ', async () => {
    const same = await client(t.app);
    const sameId = await signup(same, 'newbie@corp.example.net', 'Newbie');
    const other = await person(null);
    await t.owner.query(`INSERT INTO verified_domains (workspace_id, domain, dns_token, verified_at) VALUES ($1,'corp.example.net','tok', now())`, [wsId]);
    // ยังไม่เปิดให้เข้าร่วมด้วยโดเมน
    const closed = await same.post(`${team.ws}/access-requests`);
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('domain_join_not_allowed');
    await team.lead.patch(team.ws, { allowDomainJoin: true });
    expect((await other.c.post(`${team.ws}/access-requests`)).body.error.code).toBe('domain_join_not_allowed');
    expect((await same.post('/w/no-such-ws/access-requests')).status).toBe(404);

    const req = await same.post(`${team.ws}/access-requests`);
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body).toMatchObject({ status: 'pending', workspace: { slug: team.slug }, alreadyPending: false });
    expect((await same.post(`${team.ws}/access-requests`)).body).toMatchObject({ id: req.body.id, alreadyPending: true });
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'access_request.created' AND recipient_id = $1`, [team.leadId])).rowCount).toBe(1);

    const list = await team.lead.get(`${team.ws}/access-requests`);
    expect(list.body.items).toMatchObject([{ id: req.body.id, kind: 'workspace', status: 'pending', requester: { email: 'newbie@corp.example.net' } }]);
    expect((await plain.c.get(`${team.ws}/access-requests`)).status).toBe(403);
    expect((await team.dev.post(`${team.ws}/access-requests/${req.body.id}/approve`)).status).toBe(403);

    const ok = await team.lead.post(`${team.ws}/access-requests/${req.body.id}/approve`);
    expect(ok.body).toEqual({ id: req.body.id, status: 'approved' });
    expect((await roleOf(sameId)).role).toBe('member');
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'access_request.decided' AND recipient_id = $1`, [sameId])).rowCount).toBe(1);
    expect((await team.lead.post(`${team.ws}/access-requests/${req.body.id}:reject`)).body.error.code).toBe('already_decided');
    expect((await same.post(`${team.ws}/access-requests`)).body.error.code).toBe('already_member');

    const rej = await client(t.app);
    await signup(rej, 'rejectme@corp.example.net', 'Rejectme');
    const r2 = await rej.post(`${team.ws}/access-requests`);
    expect((await team.lead.post(`${team.ws}/access-requests/${r2.body.id}/reject`)).body.status).toBe('rejected');
    expect((await team.lead.get(`${team.ws}/access-requests?status=all`)).body.items.map((i: { status: string }) => i.status).sort()).toEqual(['approved', 'rejected']);
    expect((await team.lead.get(`${team.ws}/access-requests`)).body.items).toEqual([]);
    expect((await rej.get(team.ws)).status).toBe(404);
    await team.lead.patch(team.ws, { allowDomainJoin: false });
  });

  it('Seat เต็มอนุมัติไม่ได้ (402) · โดเมนที่ยังไม่ยืนยัน DNS ใช้ไม่ได้', async () => {
    await team.lead.patch(team.ws, { allowDomainJoin: true });
    await t.owner.query(`INSERT INTO verified_domains (workspace_id, domain, dns_token) VALUES ($1,'pending.example.net','tok2')`, [wsId]);
    const c = await client(t.app);
    await signup(c, 'x@pending.example.net', 'Pending');
    expect((await c.post(`${team.ws}/access-requests`)).body.error.code).toBe('domain_join_not_allowed');
    const d = await client(t.app);
    await signup(d, 'seat@corp.example.net', 'Seat');
    const req = await d.post(`${team.ws}/access-requests`);
    await setPlan('free');
    await resetSeats();
    const used = await seatsUsed();
    for (let i = used; i < 5; i++) await person('member');
    expect((await team.lead.post(`${team.ws}/access-requests/${req.body.id}/approve`)).status).toBe(402);
    expect((await t.owner.query('SELECT status FROM access_requests WHERE id = $1', [req.body.id])).rows[0].status).toBe('pending');
    await setPlan('team_l');
    await team.lead.patch(team.ws, { allowDomainJoin: false });
  });
});

describe('ขอสิทธิ์เข้าโปรเจกต์ (M1 403)', () => {
  async function privateProject() {
    const key = `AR${++seq}`;
    const r = await team.lead.post(`${team.ws}/projects`, { key, name: `Private ${key}`, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null, visibility: 'private' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return key;
  }

  it('สมาชิก Workspace ขอเข้าโปรเจกต์ Private → Project Owner อนุมัติพร้อมเลือก Role', async () => {
    const key = await privateProject();
    const m = await person('member', 'Asker');
    expect((await m.c.get(`${team.ws}/projects/${key}`)).status).toBeGreaterThanOrEqual(403);
    const req = await m.c.post(`${team.ws}/projects/${key}/access-requests`);
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect(req.body).toMatchObject({ status: 'pending', project: { key }, alreadyPending: false });
    expect((await m.c.post(`${team.ws}/projects/${key}/access-requests`)).body.alreadyPending).toBe(true);
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'access_request.created' AND recipient_id = $1 AND project_id IS NOT NULL`, [team.leadId])).rowCount).toBeGreaterThan(0);

    // คนที่ไม่เกี่ยว (Member ธรรมดา) เห็นรายการไม่ได้ / ตัดสินไม่ได้
    expect((await plain.c.get(`${team.ws}/access-requests`)).status).toBe(403);
    expect((await plain.c.post(`${team.ws}/access-requests/${req.body.id}/approve`)).status).toBe(403);
    const list = await team.lead.get(`${team.ws}/access-requests`);
    expect(list.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: req.body.id, kind: 'project', project: { key, name: `Private ${key}` } })]));

    const ok = await team.lead.post(`${team.ws}/access-requests/${req.body.id}/approve`, { role: 'viewer' });
    expect(ok.body.status).toBe('approved');
    expect((await t.owner.query('SELECT role FROM project_members WHERE user_id = $1 AND project_id = (SELECT id FROM projects WHERE key = $2)', [m.id, key])).rows[0].role).toBe('viewer');
    expect((await m.c.get(`${team.ws}/projects/${key}`)).status).toBe(200);
    expect((await m.c.post(`${team.ws}/projects/${key}/access-requests`)).body.error.code).toBe('already_member');
  });

  it('Admin ของโปรเจกต์ตัดสินคำขอของโปรเจกต์ตัวเองได้ แต่ไม่เห็นคำขอของโปรเจกต์อื่น', async () => {
    const mine = await privateProject();
    const theirs = await privateProject();
    const padmin = await person('member', 'PAdmin');
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT $1, id, $2, 'admin' FROM projects WHERE key = $3`, [wsId, padmin.id, mine]);
    const a = await person('member', 'AskerA');
    const b = await person('member', 'AskerB');
    const ra = await a.c.post(`${team.ws}/projects/${mine}/access-requests`);
    const rb = await b.c.post(`${team.ws}/projects/${theirs}/access-requests`);
    const seen = await padmin.c.get(`${team.ws}/access-requests`);
    expect(seen.body.items.map((i: { id: string }) => i.id)).toEqual([ra.body.id]);
    expect((await padmin.c.post(`${team.ws}/access-requests/${rb.body.id}/approve`)).status).toBe(403);
    expect((await padmin.c.post(`${team.ws}/access-requests/${ra.body.id}/approve`, {})).body.status).toBe('approved');
    expect((await t.owner.query('SELECT role FROM project_members WHERE user_id = $1 AND project_id = (SELECT id FROM projects WHERE key = $2)', [a.id, mine])).rows[0].role).toBe('member');
    expect((await team.lead.post(`${team.ws}/access-requests/${rb.body.id}/reject`)).body.status).toBe('rejected');
  });

  it('Guest ขอไม่ได้ · โปรเจกต์ที่ไม่มี 404 · Guest ที่ถูกอนุมัติได้เป็น Viewer เท่านั้น', async () => {
    const key = await privateProject();
    const g = await person('guest', 'GuestAsker');
    expect((await g.c.post(`${team.ws}/projects/${key}/access-requests`)).status).toBe(403);
    expect((await team.dev.post(`${team.ws}/projects/NOPE/access-requests`)).status).toBe(404);
    await t.owner.query(`INSERT INTO access_requests (workspace_id, user_id, project_id) SELECT $1, $2, id FROM projects WHERE key = $3`, [wsId, g.id, key]);
    const id = (await t.owner.query('SELECT id FROM access_requests WHERE user_id = $1', [g.id])).rows[0].id;
    await team.lead.post(`${team.ws}/access-requests/${id}/approve`, { role: 'admin' });
    expect((await t.owner.query('SELECT role FROM project_members WHERE user_id = $1 AND project_id = (SELECT id FROM projects WHERE key = $2)', [g.id, key])).rows[0].role).toBe('viewer');
  });
});
