// A24 · LINE OA · LINE API ปลอม (แทนที่ method ของ LineApi) · ข้อมูลสมมติเท่านั้น
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LineApi, type LineMessage } from '../src/line/line-api.js';
import { postbackData } from '../src/line/line.service.js';
import { Notifier } from '../src/notifications/notifier.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

const SECRET = 'line-channel-secret-for-tests';
const TOKEN = 'line-access-token-for-tests-1234';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let outsider: Client;
let wsId: string;
let projectId: string;
let moduleId: string;
let pushes: Array<{ token: string; to: string; messages: LineMessage[] }> = [];
let replies: Array<{ replyToken: string; text: string }> = [];
let pushFail: number | null = null;

beforeAll(async () => {
  t = await startApp();
  const api = t.app.get(LineApi);
  api.push = async (token, to, messages) => {
    if (pushFail) throw Object.assign(new Error(`LINE ตอบ HTTP ${pushFail}`), { status: pushFail });
    pushes.push({ token, to, messages });
    return {};
  };
  api.reply = async (_token, replyToken, messages) => {
    replies.push({ replyToken, text: (messages[0] as { text: string }).text });
    return {};
  };
  api.profile = async (_t, id) => ({ displayName: `LINE ${id}` });
  api.groupSummary = async (_t, id) => ({ groupName: `กลุ่ม ${id}` });
  api.botInfo = async (token) => {
    if (token !== TOKEN) throw Object.assign(new Error('LINE ตอบ HTTP 401'), { status: 401 });
    return { displayName: 'Friday Bot', basicId: '@fridaybot' };
  };
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  outsider = await client(t.app);
  await signup(outsider, 'outsider@line.example.com', 'Outsider');
  // ไม่ให้ช่วงงดส่งตามเวลาจริงของเครื่องมากระทบ
  for (const uid of [team.leadId, team.devId]) {
    await t.owner.query('INSERT INTO user_notification_settings (workspace_id, user_id, quiet_start, quiet_end, quiet_on_holidays) VALUES ($1,$2,NULL,NULL,false)', [wsId, uid]);
  }
});
afterAll(() => t.close());
beforeEach(() => {
  pushes = [];
  replies = [];
  pushFail = null;
});

const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('base64');
async function hook(events: unknown[], opts: { signature?: string | null; ws?: string } = {}) {
  const raw = JSON.stringify({ destination: 'Ubot', events });
  const r = request(t.app.getHttpServer()).post(`/api/v1/hooks/line/${opts.ws ?? wsId}`).set('content-type', 'application/json');
  if (opts.signature !== null) r.set('x-line-signature', opts.signature ?? sign(raw));
  return r.send(raw);
}
const say = (userId: string, text: string, replyToken = 'rt') => ({ type: 'message', replyToken, source: { type: 'user', userId }, message: { type: 'text', text } });
const press = (userId: string, id: string, d: 'approve' | 'reject') => ({ type: 'postback', replyToken: 'rt', source: { type: 'user', userId }, postback: { data: postbackData(id, d) } });
const lastReply = () => replies.at(-1)?.text ?? '';
async function linkCode(c: Client) {
  const r = await c.post('/me/line/link-code');
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.code as string;
}
async function bind(c: Client, lineUserId: string) {
  await hook([say(lineUserId, await linkCode(c))]);
}

describe('w/channels/line-oa', () => {
  it('ตั้งค่าครั้งแรกต้องมี secret และ token · ตอบกลับเฉพาะ 4 ตัวท้ายพร้อม Webhook URL', async () => {
    const base = `${team.ws}/channels/line-oa`;
    expect((await team.lead.get(base)).body).toMatchObject({ configured: false, config: null, webhookUrl: expect.stringContaining(`/api/v1/hooks/line/${wsId}`) });
    const missing = await team.lead.put(base, { channelId: '1234567890' });
    expect(missing.status).toBe(400);

    const put = await team.lead.put(base, { channelId: '1234567890', channelSecret: SECRET, accessToken: TOKEN, batchDigestMinutes: 10 });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ configured: true, config: { channelId: '1234567890', channelSecretLast4: SECRET.slice(-4), accessTokenLast4: TOKEN.slice(-4), fallbackToEmail: true, batchDigestMinutes: 10 } });
    expect(JSON.stringify(put.body)).not.toContain(TOKEN);
    const row = (await t.owner.query('SELECT channel_secret_encrypted, access_token_encrypted FROM line_oa_configs')).rows[0];
    expect(row.channel_secret_encrypted).not.toContain(SECRET);
    expect(row.access_token_encrypted).not.toContain(TOKEN);

    // แก้ภายหลังโดยไม่ส่ง secret ใช้ค่าเดิม
    const again = await team.lead.put(base, { channelId: '1234567890', fallbackToEmail: false });
    expect(again.body.config).toMatchObject({ fallbackToEmail: false, channelSecretLast4: SECRET.slice(-4) });
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'channel.line_updated'`)).rowCount).toBe(2);
  });

  it(':test ตรวจ token กับ LINE · Member ใช้ไม่ได้', async () => {
    const ok = await team.lead.post(`${team.ws}/channels/line-oa/test`);
    expect(ok.body).toEqual({ ok: true, botName: 'Friday Bot', basicId: '@fridaybot' });
    await team.lead.put(`${team.ws}/channels/line-oa`, { channelId: '1234567890', accessToken: 'wrong-token-value-9999' });
    const bad = await team.lead.post(`${team.ws}/channels/line-oa:test`);
    expect(bad.status).toBe(502);
    expect(bad.body.error.code).toBe('line_test_failed');
    await team.lead.put(`${team.ws}/channels/line-oa`, { channelId: '1234567890', accessToken: TOKEN });
    for (const call of [() => team.dev.get(`${team.ws}/channels/line-oa`), () => team.dev.put(`${team.ws}/channels/line-oa`, { channelId: 'x' }), () => team.dev.get(`${team.ws}/channels/line-groups`)]) {
      expect((await call()).status).toBe(403);
    }
  });
});

describe('POST hooks/line · ลายเซ็น', () => {
  it('ลายเซ็นผิด / ไม่มี → 401 · Workspace ที่ไม่มี OA → 404 · ลายเซ็นถูกตอบ 200 โดยไม่ต้องมี CSRF', async () => {
    expect((await hook([], { signature: sign('x') })).status).toBe(401);
    expect((await hook([], { signature: null })).status).toBe(401);
    expect((await hook([], { signature: sign(JSON.stringify({ destination: 'Ubot', events: [] }), 'other-secret') })).status).toBe(401);
    expect((await hook([], { ws: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await hook([], { ws: 'abc' })).status).toBe(404);
    const ok = await hook([{ type: 'unknown' }]);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });
});

describe('ผูกบัญชีด้วยรหัส 6 หลัก', () => {
  it('ขอรหัส → ส่งในแชต OA → ผูกสำเร็จ · เก็บเฉพาะ hash · ใช้ได้ครั้งเดียว', async () => {
    expect((await team.lead.get('/me/line')).body).toMatchObject({ linked: false });
    const r = await team.lead.post('/me/line/link-code');
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^\d{6}$/);
    expect(r.body.expiresInSeconds).toBe(600);
    const stored = (await t.owner.query('SELECT code_hash FROM line_link_codes')).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].code_hash).not.toContain(r.body.code);

    await hook([say('U-lead', r.body.code, 'rt-link')]);
    expect(replies).toMatchObject([{ replyToken: 'rt-link', text: expect.stringContaining('ผูกบัญชีสำเร็จ') }]);
    expect((await team.lead.get('/me/line')).body).toMatchObject({ linked: true, displayName: 'LINE U-lead' });
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'line.linked'`)).rowCount).toBe(1);

    await hook([say('U-other', r.body.code)]);
    expect(lastReply()).toContain('รหัสไม่ถูกต้องหรือหมดอายุ');
  });

  it('รหัสผิด / หมดอายุ / ขอใหม่แล้วรหัสเก่าใช้ไม่ได้ / ข้อความอื่นไม่ตอบ', async () => {
    await hook([say('U-dev', '000000')]);
    expect(lastReply()).toContain('รหัสไม่ถูกต้อง');
    replies = [];
    await hook([say('U-dev', 'สวัสดี')]);
    expect(replies).toEqual([]);

    const old = await linkCode(team.dev);
    const fresh = await linkCode(team.dev);
    await hook([say('U-dev', old)]);
    expect(lastReply()).toContain('รหัสไม่ถูกต้อง');
    await t.owner.query(`UPDATE line_link_codes SET expires_at = now() - interval '1 minute'`);
    await hook([say('U-dev', fresh)]);
    expect(lastReply()).toContain('รหัสไม่ถูกต้อง');
    expect((await team.dev.get('/me/line')).body.linked).toBe(false);
  });

  it('บัญชีที่ผูกแล้ว / LINE ที่ถูกใช้แล้ว / ผู้ใช้ที่ไม่ใช่สมาชิก Workspace ผูกไม่ได้', async () => {
    await hook([say('U-lead-2', await linkCode(team.lead))]);
    expect(lastReply()).toContain('ผูก LINE ไว้แล้ว');
    await hook([say('U-lead', await linkCode(team.dev))]);
    expect(lastReply()).toContain('ผูกกับผู้ใช้อื่นอยู่แล้ว');
    await hook([say('U-out', await linkCode(outsider))]);
    expect(lastReply()).toContain('รหัสไม่ถูกต้อง');
    expect((await outsider.get('/me/line')).body.linked).toBe(false);
  });

  it('DELETE me/line ยกเลิกการผูก แล้วผูกใหม่ได้', async () => {
    expect((await team.lead.delete('/me/line')).body).toEqual({ unlinked: true });
    expect((await team.lead.delete('/me/line')).body).toEqual({ unlinked: false });
    await bind(team.lead, 'U-lead');
    expect((await team.lead.get('/me/line')).body.linked).toBe(true);
  });

  it('รหัสผิดเกิน 10 ครั้ง LINE เดียวกันถูกเมินชั่วคราว', async () => {
    const real = await linkCode(team.dev);
    for (let i = 0; i < 10; i++) await hook([say('U-guesser', String(100_000 + i))]);
    replies = [];
    await hook([say('U-guesser', real)]);
    expect(replies).toEqual([]);
    expect((await team.dev.get('/me/line')).body.linked).toBe(false);
    await hook([say('U-dev', real)]);
    expect((await team.dev.get('/me/line')).body.linked).toBe(true);
  });

  it('POST me/line:test ส่งข้อความหาตัวเอง · ยังไม่ผูก / ไม่มี OA / ส่งไม่ได้', async () => {
    const ok = await team.lead.post('/me/line/test', { workspace: team.slug });
    expect(ok.body).toEqual({ sent: true });
    expect(pushes).toMatchObject([{ token: TOKEN, to: 'U-lead', messages: [{ type: 'text', text: expect.stringContaining('ทดสอบ') }] }]);
    expect((await outsider.post('/me/line/test', { workspace: team.slug })).status).toBe(404);
    const noLink = await client(t.app);
    const id = await signup(noLink, 'nolink@line.example.com', 'No Link');
    await addMember(t.owner, team.slug, id, 'member');
    const r = await noLink.post('/me/line/test', { workspace: team.slug });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('line_not_linked');
    pushFail = 500;
    expect((await team.lead.post('/me/line:test', { workspace: team.slug })).status).toBe(502);
    expect((await team.lead.post('/me/line/test', {})).status).toBe(400);
  });
});

describe('กลุ่ม LINE', () => {
  it('OA เข้ากลุ่ม → บันทึก · เข้าซ้ำอัปเดตชื่อ · ออกจากกลุ่ม → ลบพร้อมกฎที่อ้างถึง', async () => {
    await hook([{ type: 'join', replyToken: 'x', source: { type: 'group', groupId: 'C-dev-plan' } }]);
    const list = await team.lead.get(`${team.ws}/channels/line-groups`);
    expect(list.body.items).toMatchObject([{ name: 'กลุ่ม C-dev-plan' }]);
    await hook([{ type: 'join', source: { type: 'group', groupId: 'C-dev-plan' } }]);
    expect((await team.lead.get(`${team.ws}/channels/line-groups`)).body.items).toHaveLength(1);

    const groupId = list.body.items[0].id;
    const rule = await team.lead.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules: [{ eventType: 'bug.created', lineGroupId: groupId }] });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    await hook([{ type: 'leave', source: { type: 'group', groupId: 'C-dev-plan' } }]);
    expect((await team.lead.get(`${team.ws}/channels/line-groups`)).body.items).toEqual([]);
    expect((await t.owner.query('SELECT 1 FROM project_notification_rules')).rowCount).toBe(0);
  });
});

describe('ปุ่มอนุมัติ / ปฏิเสธคำขอเลื่อน Due', () => {
  async function dueRequest(title: string) {
    const c = await team.dev.post(`${team.ws}/projects/${team.key}/issues`, { title, moduleId });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await t.owner.query(`UPDATE issues SET plan_start = '2027-01-05', plan_end = '2027-01-12' WHERE id = $1`, [c.body.id]);
    await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, c.body.id, team.devId]);
    const r = await team.dev.post(`${team.ws}/issues/${c.body.key}/due-requests`, { requestedDue: '2027-01-15', reasonCode: 'scope_added', detail: 'ทดสอบ' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.id as string, key: c.body.key as string, issueId: c.body.id as string };
  }
  const status = async (id: string) => (await t.owner.query('SELECT status, decided_via FROM due_change_requests WHERE id = $1', [id])).rows[0];
  const audits = async (id: string) => (await t.owner.query(`SELECT actor_id, actor_kind, summary FROM audit_logs WHERE action = 'due_request.line_postback' AND target_id = $1 ORDER BY created_at`, [id])).rows;

  it('ผู้มีสิทธิ์ที่ผูก LINE กดอนุมัติ → อนุมัติจริง (via line) แก้ Due และ Audit', async () => {
    await bind(team.dev, 'U-dev');
    const req = await dueRequest('งานขอเลื่อน 1');
    await hook([press('U-lead', req.id, 'approve')]);
    expect(await status(req.id)).toEqual({ status: 'approved', decided_via: 'line' });
    expect((await t.owner.query('SELECT plan_end::text FROM issues WHERE id = $1', [req.issueId])).rows[0].plan_end).toBe('2027-01-15');
    expect(lastReply()).toContain('อนุมัติคำขอเลื่อน Due');
    expect(await audits(req.id)).toEqual([{ actor_id: team.leadId, actor_kind: 'user', summary: 'approve ผ่าน LINE · สำเร็จ' }]);
  });

  it('กดปฏิเสธ → ปฏิเสธ · กดซ้ำ → แจ้งว่าตัดสินแล้ว (ไม่เปลี่ยนผล)', async () => {
    const req = await dueRequest('งานขอเลื่อน 2');
    await hook([press('U-lead', req.id, 'reject')]);
    expect(await status(req.id)).toMatchObject({ status: 'rejected' });
    await hook([press('U-lead', req.id, 'approve')]);
    expect(lastReply()).toContain('ตัดสินไปแล้ว');
    expect(await status(req.id)).toMatchObject({ status: 'rejected' });
    expect((await audits(req.id)).map((a: { summary: string }) => a.summary)).toEqual(['reject ผ่าน LINE · สำเร็จ', 'approve ผ่าน LINE · ไม่สำเร็จ: already_decided']);
  });

  it('บัญชี LINE ที่ไม่ได้ผูกกดแล้วถูกปฏิเสธ · คำขอยังรออยู่ · Audit ไม่มีผู้ทำ', async () => {
    const req = await dueRequest('งานขอเลื่อน 3');
    await hook([press('U-stranger', req.id, 'approve')]);
    expect(lastReply()).toContain('ยังไม่ได้ผูก');
    expect(await status(req.id)).toMatchObject({ status: 'pending' });
    expect(await audits(req.id)).toEqual([{ actor_id: null, actor_kind: 'system', summary: expect.stringContaining('ยังไม่ได้ผูก') }]);
  });

  it('ผูกแล้วแต่ไม่มีสิทธิ์อนุมัติ (ผู้ขอเอง / Member) กดไม่ได้', async () => {
    const req = await dueRequest('งานขอเลื่อน 4');
    await hook([press('U-dev', req.id, 'approve')]);
    expect(lastReply()).toContain('ไม่มีสิทธิ์');
    expect(await status(req.id)).toMatchObject({ status: 'pending' });
    expect((await audits(req.id))[0]).toMatchObject({ actor_id: team.devId, summary: expect.stringContaining('ไม่สำเร็จ') });
  });

  it('ไม่ใช่สมาชิก Workspace นี้ · คำขอไม่มีอยู่ · ข้อมูลปุ่มผิดรูปแบบ', async () => {
    const req = await dueRequest('งานขอเลื่อน 5');
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [team.leadId]);
    await hook([press('U-lead', req.id, 'approve')]);
    expect(lastReply()).toContain('ไม่ได้เป็นสมาชิก');
    expect(await status(req.id)).toMatchObject({ status: 'pending' });
    await t.owner.query(`UPDATE workspace_members SET status = 'active' WHERE user_id = $1`, [team.leadId]);

    await hook([press('U-lead', '00000000-0000-4000-8000-000000000000', 'approve')]);
    expect(lastReply()).toContain('ไม่พบคำขอ');
    replies = [];
    await hook([{ type: 'postback', replyToken: 'x', source: { type: 'user', userId: 'U-lead' }, postback: { data: 'a=due&id=zzz&d=approve' } }, { type: 'postback', replyToken: 'x', source: { type: 'user', userId: 'U-lead' }, postback: { data: `a=other&id=${req.id}&d=approve` } }]);
    expect(replies).toEqual([]);
    expect(await status(req.id)).toMatchObject({ status: 'pending' });
  });
});

describe('ส่งแจ้งเตือนผ่านท่อของ A25', () => {
  const notify = (eventType: string, recipients: string[], payload: Record<string, unknown> = {}) =>
    t.app.get(Notifier).notify({
      workspaceId: wsId, recipientIds: recipients, eventType, actorId: team.devId, projectId,
      payload: { projectKey: team.key, projectName: 'Development Plan', issueKey: 'DP-1', issueTitle: 'งานทดสอบ', actorName: 'Kaijeaw', ...payload },
      reason: 'คุณเป็นผู้เกี่ยวข้อง',
    });
  const deliveries = async () => (await t.owner.query(`SELECT channel, status, target_ref FROM notification_deliveries ORDER BY created_at`)).rows;

  beforeEach(async () => {
    await t.owner.query('DELETE FROM notification_deliveries');
    await t.owner.query('DELETE FROM notifications');
    await t.owner.query('DELETE FROM user_notification_prefs');
    await t.owner.query('DELETE FROM project_notification_rules');
    await t.owner.query(`DELETE FROM project_notification_settings`);
    await t.owner.query(`INSERT INTO project_notification_settings (workspace_id, project_id, quiet_mode) VALUES ($1,$2,'always_send')`, [wsId, projectId]);
  });

  it('ผู้รับที่ผูก LINE และเปิดช่อง LINE → ส่งข้อความส่วนตัว · ปิด / ไม่ผูก → ไม่ส่ง', async () => {
    await notify('issue.assigned', [team.leadId]);
    expect(pushes).toEqual([]); // ค่าเริ่มต้นของ LINE ยังปิดอยู่จนกว่าผู้ใช้เปิด (ดูคำขอนอก lane)
    await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'issue.assigned','line',true), ($1,$3,'issue.assigned','line',true)`, [wsId, team.leadId, team.devId]);
    await notify('issue.assigned', [team.leadId, team.devId]);
    expect(pushes).toHaveLength(1); // dev เปิดไว้แต่ยังไม่ได้ผูก LINE (ผูกเมื่อกี้ใน U-dev ถูกยกเลิกแล้ว)
    expect(pushes[0]).toMatchObject({ token: TOKEN, to: 'U-lead', messages: [{ type: 'text', text: expect.stringContaining('/p/DP/table?issue=DP-1') }] });
    expect(await deliveries()).toMatchObject([{ channel: 'line', status: 'sent', target_ref: 'U-lead' }]);
  });

  it('คำขอเลื่อน Due ที่ส่งหาผู้อนุมัติมีปุ่ม อนุมัติ / ปฏิเสธ (postback)', async () => {
    await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'due_request.created','line',true)`, [wsId, team.leadId]);
    const c = await team.dev.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานที่ขอเลื่อน', moduleId });
    await t.owner.query(`UPDATE issues SET plan_start = '2027-02-02', plan_end = '2027-02-09' WHERE id = $1`, [c.body.id]);
    const r = await team.dev.post(`${team.ws}/issues/${c.body.key}/due-requests`, { requestedDue: '2027-02-12', reasonCode: 'scope_added' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const flex = pushes.find((p) => p.messages[0]?.type === 'flex');
    expect(flex?.to).toBe('U-lead');
    const buttons = JSON.stringify(flex!.messages[0]);
    expect(buttons).toContain(postbackData(r.body.id, 'approve'));
    expect(buttons).toContain(postbackData(r.body.id, 'reject'));
    // กดปุ่มที่ส่งไปจริง → อนุมัติ
    await hook([press('U-lead', r.body.id, 'approve')]);
    expect((await t.owner.query('SELECT status FROM due_change_requests WHERE id = $1', [r.body.id])).rows[0].status).toBe('approved');
  });

  it('กฎของโปรเจกต์ส่งเข้า LINE กลุ่มครั้งเดียวต่อเหตุการณ์ · กลุ่มถูกนำ OA ออก → ล้มแบบไม่ลองใหม่', async () => {
    await hook([{ type: 'join', source: { type: 'group', groupId: 'C-alerts' } }]);
    const group = (await team.lead.get(`${team.ws}/channels/line-groups`)).body.items[0];
    await team.lead.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules: [{ eventType: 'bug.created', lineGroupId: group.id }] });
    await notify('bug.created', [team.leadId, team.devId], { severity: 'Major', issueKey: 'DP-9', issueTitle: 'Bug ทดสอบ' });
    expect(pushes.filter((p) => p.to === 'C-alerts')).toHaveLength(1);
    expect(pushes.find((p) => p.to === 'C-alerts')!.messages[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Bug ใหม่ · Major') });

    pushes = [];
    pushFail = 403;
    await notify('bug.created', [team.leadId], { severity: 'Major', issueKey: 'DP-10' });
    const failed = (await t.owner.query(`SELECT status, attempts, last_error FROM notification_deliveries WHERE channel = 'line_group' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, last_error: 'LINE ตอบ HTTP 403' });
  });
});
