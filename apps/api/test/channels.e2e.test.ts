// A25 · Email / Webhook / กฎของโปรเจกต์ · SMTP ปลอมคือ transport ที่แทนที่ได้ใน Mailer, Webhook ปลอมคือ HTTP server ในเครื่อง
// ข้อมูลสมมติเท่านั้น
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelDispatcher } from '../src/channels/dispatcher.js';
import { DnsChecker } from '../src/channels/channels.service.js';
import { ProjectNotifyService } from '../src/channels/project-notify.service.js';
import { sign } from '../src/channels/render.js';
import { EventBus } from '../src/core/events.js';
import { Mailer, type SmtpConfig } from '../src/core/mail.js';
import { Notifier } from '../src/notifications/notifier.js';
import { Reminders } from '../src/notifications/reminders.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

process.env.SMTP_HOST = 'smtp.test.example.com';
process.env.MAIL_FROM = 'Friday Manage <notify@friday.test>';
// Webhook ปลายทางเป็น 127.0.0.1 ในเครื่อง (ปกติถูกกัน SSRF)
process.env.WEBHOOK_ALLOW_PRIVATE = '1';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let projectId: string;
let outsider: Client;
let dispatcher: ChannelDispatcher;

interface Mail { cfg: SmtpConfig; from: string; to: string; subject: string; text: string; html?: string; replyTo?: string }
let mails: Mail[] = [];
let mailFails = 0;

interface Hit { path: string; headers: IncomingMessage['headers']; raw: string; body: Record<string, unknown> }
let hits: Hit[] = [];
let hookStatuses: number[] = [];
let hookServer: Server;
let hookUrl: string;

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, raw, body: raw ? JSON.parse(raw) : {} });
      res.statusCode = hookStatuses.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook/secret-token-9876`;

  t = await startApp();
  // ต้องแทนที่ transport ก่อน seedTeam เพราะสมัครสมาชิกส่งอีเมลยืนยัน (มี SMTP_HOST แล้ว)
  t.app.get(Mailer).transportFactory = (cfg) => ({
    sendMail: async (m: Record<string, unknown>) => {
      if (mailFails > 0) { mailFails--; throw new Error('smtp down'); }
      mails.push({ cfg, ...(m as Omit<Mail, 'cfg'>) });
    },
  });
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  dispatcher = t.app.get(ChannelDispatcher);
  outsider = await client(t.app);
  await signup(outsider, 'viewer@channels.example.com', 'Viewer');
  // ไม่ให้ช่วงงดส่งตามเวลาจริงของเครื่องที่รัน test มากระทบ: ทุกคนไม่มีช่วงงดส่ง
  for (const uid of [team.leadId, team.devId]) {
    await t.owner.query('INSERT INTO user_notification_settings (workspace_id, user_id, quiet_start, quiet_end, quiet_on_holidays) VALUES ($1,$2,NULL,NULL,false)', [wsId, uid]);
  }
});
afterAll(async () => {
  await t.close();
  await new Promise((r) => hookServer.close(r));
});

beforeEach(async () => {
  mails = []; hits = []; hookStatuses = []; mailFails = 0;
  process.env.SMTP_HOST = 'smtp.test.example.com';
  await t.owner.query('DELETE FROM notification_deliveries');
  await t.owner.query('DELETE FROM notifications');
  await t.owner.query('DELETE FROM project_notification_rules');
  await t.owner.query('DELETE FROM project_notification_settings');
  await t.owner.query('DELETE FROM user_notification_prefs');
  await t.owner.query('DELETE FROM webhook_endpoints');
  await t.owner.query('DELETE FROM email_sender_configs');
  await t.owner.query('UPDATE workspace_settings SET safe_mode = true WHERE workspace_id = $1', [wsId]);
  // กฎกลุ่มเริ่มจาก "ส่งตลอดเวลา" เพื่อไม่ขึ้นกับนาฬิกาจริง
  await t.owner.query(`INSERT INTO project_notification_settings (workspace_id, project_id, quiet_mode) VALUES ($1,$2,'always_send')`, [wsId, projectId]);
});
afterEach(() => vi.useRealTimers());

const notify = (eventType: string, recipients: string[], payload: Record<string, unknown> = {}) =>
  t.app.get(Notifier).notify({
    workspaceId: wsId, recipientIds: recipients, eventType, actorId: team.leadId, projectId,
    payload: { projectKey: team.key, projectName: 'Development Plan', issueKey: 'DP-1', issueTitle: 'งานทดสอบ', actorName: 'Mick', ...payload },
    reason: 'คุณเป็น Assignee ของงานนี้',
  });
const deliveries = async (where = '') => (await t.owner.query(`SELECT * FROM notification_deliveries ${where} ORDER BY created_at`)).rows;

async function createHook(body: Record<string, unknown> = {}) {
  const r = await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'Discord dev-alerts', format: 'discord', url: hookUrl, signingSecret: 'signing-secret-1234', ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}
async function ruleFor(hookId: string, eventType = 'bug.created') {
  const r = await team.lead.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules: [{ eventType, webhookId: hookId }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('ท่อส่ง Email ตาม pref', () => {
  it('เหตุการณ์ที่เปิด Email เป็นค่าเริ่มต้น → ส่งให้ผู้รับพร้อมบันทึก delivery', async () => {
    await notify('issue.assigned', [team.devId]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: `dev@${team.slug}.example.com`, from: 'Friday Manage <notify@friday.test>' });
    expect(mails[0].subject).toBe('[Friday] Mick มอบหมายงานให้คุณ: DP-1 งานทดสอบ');
    expect(mails[0].text).toContain(`/work/${team.slug}/p/DP/table?issue=DP-1`);
    expect(mails[0].text).toContain('คุณเป็น Assignee ของงานนี้');
    expect(await deliveries()).toMatchObject([{ channel: 'email', status: 'sent', attempts: 1, last_error: null }]);
  });

  it('ผู้รับเลือกภาษาอังกฤษ → หัวข้อ ปุ่ม และเหตุผลเป็นภาษาอังกฤษ (W21)', async () => {
    await t.owner.query(`UPDATE users SET locale = 'en' WHERE id = $1`, [team.devId]);
    try {
      await t.app.get(Notifier).notify({
        workspaceId: wsId, recipientIds: [team.devId], eventType: 'issue.assigned', actorId: team.leadId, projectId,
        payload: { projectKey: team.key, projectName: 'Development Plan', issueKey: 'DP-1', issueTitle: 'งานทดสอบ', actorName: 'Mick' },
        reason: 'คุณได้รับมอบหมายงานนี้',
      });
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe('[Friday] Mick assigned you a task: DP-1 งานทดสอบ');
      expect(mails[0].text).toContain('Open in app: ');
      expect(mails[0].text).toContain('You received this email because: you are assigned to this task');
      expect(mails[0].html).toContain('Notification settings');
    } finally {
      await t.owner.query(`UPDATE users SET locale = 'th' WHERE id = $1`, [team.devId]);
    }
  });

  it('เหตุการณ์ที่ปิด Email เป็นค่าเริ่มต้น → ไม่ส่ง จนกว่าผู้ใช้เปิดเอง', async () => {
    await notify('issue.commented', [team.devId]);
    expect(mails).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
    await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'issue.commented','email',true)`, [wsId, team.devId]);
    await notify('issue.commented', [team.devId]);
    expect(mails).toHaveLength(1);
  });

  it('ผู้ใช้ปิด Email ของเหตุการณ์นั้น → ไม่ส่งและไม่มี delivery', async () => {
    await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'issue.assigned','email',false)`, [wsId, team.devId]);
    await notify('issue.assigned', [team.devId]);
    expect(mails).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
  });

  it('ไม่ได้ตั้ง SMTP → ไม่สร้าง delivery (ไม่แสดงว่าส่งแล้วทั้งที่ไม่ได้ส่ง)', async () => {
    delete process.env.SMTP_HOST;
    await notify('issue.assigned', [team.devId]);
    expect(await deliveries()).toHaveLength(0);
  });

  it('งานที่ไม่ผ่าน Notifier (เขียนตรง) ถูกงาน scan เก็บ', async () => {
    await t.owner.query(
      `INSERT INTO notifications (workspace_id, recipient_id, event_type, project_id, payload, reason) VALUES ($1,$2,'issue.assigned',$3,$4,'ทดสอบ')`,
      [wsId, team.devId, projectId, JSON.stringify({ projectKey: team.key, projectName: 'Development Plan', issueKey: 'DP-2', issueTitle: 'เขียนตรง', actorName: 'Mick' })],
    );
    await dispatcher.scan();
    expect(mails).toHaveLength(1);
    await dispatcher.scan();
    expect(mails).toHaveLength(1);
  });

  it('SMTP ล้ม → retry จนสำเร็จ · ล้มครบ → failed พร้อมเหตุผล', async () => {
    mailFails = 2;
    await notify('issue.assigned', [team.devId]);
    expect(mails).toHaveLength(1);
    expect(await deliveries()).toMatchObject([{ status: 'sent', attempts: 3 }]);

    mailFails = 99;
    await notify('issue.mentioned', [team.devId]);
    expect(mails).toHaveLength(1);
    expect(await deliveries(`WHERE status = 'failed'`)).toMatchObject([{ channel: 'email', attempts: 4, last_error: 'smtp down' }]);
    const failed = await team.lead.get(`${team.ws}/channels/deliveries?status=failed`);
    expect(failed.body.items).toMatchObject([{ channel: 'email', status: 'failed', eventType: 'issue.mentioned', lastError: 'smtp down' }]);
  });
});

describe('โหมดปลอดภัย (Safe mode)', () => {
  const detail = { from: { name: 'To Do' }, to: { name: 'In Progress' }, planEnd: '2026-12-11', excerpt: 'รายละเอียดลับของงาน' };

  it('เปิด: ส่งเฉพาะหัวข้อ + ลิงก์ ไม่มีรายละเอียดและคอมเมนต์', async () => {
    await notify('issue.assigned', [team.devId], detail);
    expect(mails[0].text).toContain('DP-1 งานทดสอบ');
    expect(mails[0].text).toContain('/p/DP/table?issue=DP-1');
    expect(mails[0].text).not.toContain('2026-12-11');
    expect(mails[0].text).not.toContain('รายละเอียดลับ');
  });

  it('ปิด: ส่งรายละเอียดด้วย', async () => {
    await t.owner.query('UPDATE workspace_settings SET safe_mode = false WHERE workspace_id = $1', [wsId]);
    await notify('issue.assigned', [team.devId], detail);
    expect(mails[0].text).toContain('2026-12-11');
    expect(mails[0].text).toContain('To Do → In Progress');
    expect(mails[0].html).toContain('2026-12-11');
  });
});

describe('Webhook และกฎของโปรเจกต์', () => {
  it('CRUD: เก็บ URL / secret แบบเข้ารหัส ตอบกลับเฉพาะ 4 ตัวท้าย · สร้าง secret ให้แสดงครั้งเดียว', async () => {
    const created = await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'Slack pm', format: 'slack', url: hookUrl, generateSecret: true });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Slack pm', format: 'slack', urlLast4: '9876', signed: true, status: 'active' });
    expect(created.body.signingSecret).toHaveLength(32);
    expect(created.body.signingSecretLast4).toBe(created.body.signingSecret.slice(-4));
    expect(JSON.stringify(created.body)).not.toContain('secret-token');

    const row = (await t.owner.query('SELECT url_encrypted, signing_secret_encrypted FROM webhook_endpoints WHERE id = $1', [created.body.id])).rows[0];
    expect(row.url_encrypted).not.toContain('secret-token');
    expect(row.signing_secret_encrypted).not.toContain(created.body.signingSecret);

    const list = await team.lead.get(`${team.ws}/channels/webhooks`);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.body.signingSecret);
    const patched = await team.lead.patch(`${team.ws}/channels/webhooks/${created.body.id}`, { name: 'Slack pm weekly' });
    expect(patched.body.name).toBe('Slack pm weekly');
    expect((await team.lead.delete(`${team.ws}/channels/webhooks/${created.body.id}`)).status).toBe(200);
    expect((await team.lead.delete(`${team.ws}/channels/webhooks/${created.body.id}`)).status).toBe(404);
  });

  it('ปลายทางภายในเครือข่าย / ไม่ใช่ URL ถูกปฏิเสธ (SSRF)', async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    try {
      const priv = await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'x', url: 'http://127.0.0.1:9/hook' });
      expect(priv.status).toBe(400);
      expect(priv.body.error.code).toBe('webhook_url_invalid');
      expect((await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'x', url: 'http://169.254.169.254/latest/meta-data' })).status).toBe(400);
      expect((await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'x', url: 'http://[::1]/hook' })).status).toBe(400);
      expect((await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'x', url: 'not-a-url' })).status).toBe(400);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    }
  });

  it(':test ส่งข้อความตัวอย่างพร้อมลายเซ็น HMAC ที่ตรวจได้', async () => {
    const hook = await createHook({ format: 'json' });
    const r = await team.lead.post(`${team.ws}/channels/webhooks/${hook.id}/test`);
    expect(r.status).toBe(200);
    expect(hits).toHaveLength(1);
    const { headers, raw } = hits[0];
    expect(headers['x-friday-signature']).toBe(sign('signing-secret-1234', String(headers['x-friday-timestamp']), raw));
    expect(hits[0].body).toMatchObject({ event: 'issue.assigned', workspace: team.slug });
    expect(hits[0].path).toBe('/hook/secret-token-9876');
  });

  it('ส่งตามกฎของโปรเจกต์ครั้งเดียวต่อเหตุการณ์ แม้มีหลายผู้รับ · รูปแบบ Discord', async () => {
    const hook = await createHook();
    await ruleFor(hook.id);
    await notify('bug.created', [team.devId, outsider ? team.leadId : team.leadId], { severity: 'Critical', issueKey: 'DP-525', issueTitle: 'ส่งกลับแก้ไขแล้วสถานะไม่กลับ' });
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toMatchObject({ embeds: [{ title: 'Bug ใหม่ · Critical', url: expect.stringContaining('issue=DP-525') }] });
    expect(await deliveries(`WHERE channel = 'webhook'`)).toMatchObject([{ status: 'sent', target_ref: hook.id }]);
  });

  it('Bug Minor ไม่ส่งเข้ากลุ่ม · เหตุการณ์ที่ไม่มีกฎไม่ส่ง · กฎที่ปิดไม่ส่ง', async () => {
    const hook = await createHook();
    await ruleFor(hook.id);
    await notify('bug.created', [team.devId], { severity: 'Minor' });
    await notify('issue.commented', [team.devId]);
    expect(hits).toHaveLength(0);
    await team.lead.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules: [{ eventType: 'bug.created', webhookId: hook.id, enabled: false }] });
    await notify('bug.created', [team.devId], { severity: 'Major' });
    expect(hits).toHaveLength(0);
  });

  it('Webhook ล้ม → ลองใหม่จนสำเร็จ', async () => {
    const hook = await createHook({ format: 'teams' });
    await ruleFor(hook.id);
    hookStatuses = [500, 502];
    await notify('bug.created', [team.devId], { severity: 'Major' });
    expect(hits).toHaveLength(3);
    expect(hits[2].body).toMatchObject({ '@type': 'MessageCard' });
    expect(await deliveries(`WHERE channel = 'webhook'`)).toMatchObject([{ status: 'sent', attempts: 3 }]);
  });

  it('ล้มครบ → failed, ปิด Webhook ชั่วคราว, แจ้ง Admin · เปิดกลับได้', async () => {
    const hook = await createHook({ format: 'telegram', url: `${hookUrl}?chat_id=-100200` });
    await ruleFor(hook.id);
    hookStatuses = [500, 500, 500, 500];
    await notify('bug.created', [team.devId], { severity: 'Major' });
    expect(hits).toHaveLength(4);
    expect(hits[0].body).toMatchObject({ chat_id: '-100200', parse_mode: 'HTML' });
    expect(await deliveries(`WHERE channel = 'webhook'`)).toMatchObject([{ status: 'failed', attempts: 4, last_error: 'Webhook ตอบ HTTP 500' }]);
    expect((await t.owner.query('SELECT status, consecutive_failures FROM webhook_endpoints WHERE id = $1', [hook.id])).rows[0]).toEqual({ status: 'paused', consecutive_failures: 1 });
    const adminNote = await t.owner.query(`SELECT payload FROM notifications WHERE event_type = 'channel.webhook_paused' AND recipient_id = $1`, [team.leadId]);
    expect(adminNote.rows).toHaveLength(1);
    expect(adminNote.rows[0].payload.title).toBe('Discord dev-alerts');
    expect(mails.some((m) => m.to.startsWith('lead@') && m.subject.includes('Webhook ถูกปิดชั่วคราว'))).toBe(true);

    hits = [];
    await notify('bug.created', [team.devId], { severity: 'Major' });
    expect(hits).toHaveLength(0);

    const resumed = await team.lead.patch(`${team.ws}/channels/webhooks/${hook.id}`, { status: 'active' });
    expect(resumed.body).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    await notify('bug.created', [team.devId], { severity: 'Major' });
    expect(hits).toHaveLength(1);
  });

  it('กฎ: ตรวจข้อมูลและสิทธิ์', async () => {
    const hook = await createHook();
    const put = (rules: unknown[]) => team.lead.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules });
    expect((await put([{ eventType: 'due_request.created', webhookId: hook.id }])).status).toBe(400);
    expect((await put([{ eventType: 'bug.created' }])).status).toBe(400);
    expect((await put([{ eventType: 'bug.created', webhookId: hook.id, lineGroupId: hook.id }])).status).toBe(400);
    expect((await put([{ eventType: 'bug.created', webhookId: hook.id }, { eventType: 'bug.created', webhookId: hook.id }])).status).toBe(400);
    expect((await put([{ eventType: 'bug.created', webhookId: '00000000-0000-4000-8000-000000000000' }])).status).toBe(422);

    expect((await put([{ eventType: 'bug.created', webhookId: hook.id }, { eventType: 'sprint.started', webhookId: hook.id }])).status).toBe(200);
    const got = await team.dev.get(`${team.ws}/projects/${team.key}/notification-rules`);
    expect(got.status).toBe(200);
    expect(got.body.rules).toHaveLength(2);
    expect(got.body.targets.webhooks).toMatchObject([{ id: hook.id, name: 'Discord dev-alerts' }]);
    const denied = await team.dev.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules: [] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('project.settings');
  });
});

describe('ช่วงงดส่ง (Quiet hours)', () => {
  // 4 พ.ย. 2569 = วันพุธ · 22:00 เวลาไทย = 15:00Z
  const NIGHT = new Date('2026-11-04T15:00:00Z');
  const NEXT_MORNING = new Date('2026-11-05T01:30:00Z'); // 08:30 พฤหัส
  const SATURDAY_NOON = new Date('2026-11-07T05:00:00Z');
  const MONDAY_9 = new Date('2026-11-09T02:00:00Z');
  const setQuiet = (uid: string, start: string | null, end: string | null, holidays: boolean) =>
    t.owner.query('UPDATE user_notification_settings SET quiet_start=$3, quiet_end=$4, quiet_on_holidays=$5 WHERE workspace_id=$1 AND user_id=$2', [wsId, uid, start, end, holidays]);
  afterEach(async () => { await setQuiet(team.devId, null, null, false); });

  it('ส่วนตัว: ช่วง 20:00–08:00 ไม่ส่ง เก็บไว้ แล้วส่งเมื่อพ้นช่วง', async () => {
    await setQuiet(team.devId, '20:00', '08:00', false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NIGHT);
    await notify('issue.assigned', [team.devId]);
    expect(mails).toHaveLength(0);
    expect(await deliveries()).toMatchObject([{ status: 'skipped_quiet_hours', attempts: 0 }]);
    expect(await dispatcher.flushQuiet()).toEqual({ checked: 1, sent: 0 });

    vi.setSystemTime(NEXT_MORNING);
    expect(await dispatcher.flushQuiet()).toEqual({ checked: 1, sent: 1 });
    expect(mails).toHaveLength(1);
    expect(await deliveries()).toMatchObject([{ status: 'sent', attempts: 1 }]);
    expect(await dispatcher.flushQuiet()).toEqual({ checked: 0, sent: 0 });
  });

  it('ส่วนตัว: วันหยุดงดทั้งวัน ส่งเช้าวันทำการถัดไป', async () => {
    await setQuiet(team.devId, '20:00', '08:00', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SATURDAY_NOON);
    await notify('issue.assigned', [team.devId]);
    expect(mails).toHaveLength(0);
    vi.setSystemTime(new Date('2026-11-08T05:00:00Z'));
    await dispatcher.flushQuiet();
    expect(mails).toHaveLength(0);
    vi.setSystemTime(MONDAY_9);
    await dispatcher.flushQuiet();
    expect(mails).toHaveLength(1);
  });

  it('ส่วนตัว: Bug Critical และงาน Urgent ข้ามช่วงงดส่ง', async () => {
    await setQuiet(team.devId, '20:00', '08:00', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NIGHT);
    await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'bug.created','email',true)`, [wsId, team.devId]);
    await notify('bug.created', [team.devId], { severity: 'Critical' });
    await notify('issue.assigned', [team.devId], { priority: 'Urgent', issueKey: 'DP-9' });
    expect(mails).toHaveLength(2);
  });

  it('กลุ่ม / Webhook: หลัง 19:00 ไม่ส่ง รวมส่งเช้าวันทำการถัดไป · Critical ข้ามได้ · always_send ส่งตลอด', async () => {
    const hook = await createHook();
    await ruleFor(hook.id);
    await t.owner.query(`UPDATE project_notification_settings SET quiet_mode = 'after_hours' WHERE project_id = $1`, [projectId]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NIGHT);
    await notify('bug.created', [team.devId], { severity: 'Major' });
    expect(hits).toHaveLength(0);
    expect(await deliveries(`WHERE channel = 'webhook'`)).toMatchObject([{ status: 'skipped_quiet_hours' }]);

    await notify('bug.created', [team.devId], { severity: 'Critical', issueKey: 'DP-77' });
    expect(hits).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-05T01:00:00Z')); // 08:00 ยังไม่ถึงเวลาเริ่มงาน 09:30
    await dispatcher.flushQuiet();
    expect(hits).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-05T03:00:00Z')); // 10:00
    await dispatcher.flushQuiet();
    expect(hits).toHaveLength(2);

    await t.owner.query(`UPDATE project_notification_settings SET quiet_mode = 'always_send' WHERE project_id = $1`, [projectId]);
    vi.setSystemTime(NIGHT);
    await notify('bug.created', [team.devId], { severity: 'Major', issueKey: 'DP-78' });
    expect(hits).toHaveLength(3);
  });

  it('ตั้ง Critical bypass ปิด → Critical ก็งดส่งช่วงหลังเลิกงาน', async () => {
    const hook = await createHook();
    await ruleFor(hook.id);
    await t.owner.query(`UPDATE project_notification_settings SET quiet_mode = 'after_hours', critical_bug_bypass = false WHERE project_id = $1`, [projectId]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NIGHT);
    await notify('bug.created', [team.devId], { severity: 'Critical' });
    expect(hits).toHaveLength(0);
  });
});

describe('ตรวจผู้รับซ้ำตอนส่ง (BUG-05)', () => {
  const NIGHT = new Date('2026-11-04T15:00:00Z');
  const NEXT_MORNING = new Date('2026-11-05T01:30:00Z');
  /** แจ้งเตือน + รายการส่ง Email ที่ค้างอยู่ (เหมือนรอ retry) */
  async function pending(eventType = 'issue.assigned', issueId: string | null = null) {
    const n = (await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, project_id, issue_id, payload, reason) VALUES ($1,$2,$3,$4,$5,'{}','ทดสอบ') RETURNING id`, [wsId, team.devId, eventType, projectId, issueId])).rows[0].id;
    return (await t.owner.query(`INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref) VALUES ($1,$2,'email',$3) RETURNING id`, [wsId, n, `dev@${team.slug}.example.com`])).rows[0].id as string;
  }
  const status = async (id: string) => (await t.owner.query('SELECT status, last_error FROM notification_deliveries WHERE id = $1', [id])).rows[0];

  it('รอช่วงงดส่งอยู่แล้วผู้รับถูกปิดการใช้งานใน Workspace → พ้นช่วงแล้วไม่ส่ง และไม่ retry', async () => {
    await t.owner.query('UPDATE user_notification_settings SET quiet_start=$3, quiet_end=$4 WHERE workspace_id=$1 AND user_id=$2', [wsId, team.devId, '20:00', '08:00']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NIGHT);
      await notify('issue.assigned', [team.devId]);
      expect(await deliveries()).toMatchObject([{ status: 'skipped_quiet_hours' }]);
      await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE workspace_id = $1 AND user_id = $2`, [wsId, team.devId]);
      vi.setSystemTime(NEXT_MORNING);
      await dispatcher.flushQuiet();
      expect(mails).toHaveLength(0);
      const [d] = await deliveries();
      expect(d.status).toBe('failed');
      expect(d.last_error).toContain('ยกเลิกการส่ง');
      // รันซ้ำก็ไม่ส่ง
      await dispatcher.flushQuiet();
      expect(mails).toHaveLength(0);
    } finally {
      await t.owner.query(`UPDATE workspace_members SET status = 'active' WHERE workspace_id = $1 AND user_id = $2`, [wsId, team.devId]);
      await t.owner.query('UPDATE user_notification_settings SET quiet_start=NULL, quiet_end=NULL WHERE workspace_id=$1 AND user_id=$2', [wsId, team.devId]);
    }
  });

  it('บัญชีถูกปิด · ออกจากโปรเจกต์ Private · ปิด pref ระหว่างรอ → ไม่ส่ง · ผู้รับที่ยังมีสิทธิ์ส่งได้', async () => {
    // บัญชีถูกปิดทั้งระบบ
    let d = await pending();
    await t.owner.query('UPDATE users SET disabled_at = now() WHERE id = $1', [team.devId]);
    await dispatcher.deliver(d);
    await t.owner.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [team.devId]);
    expect(mails).toHaveLength(0);
    expect((await status(d)).last_error).toContain('ไม่มีสิทธิ์');

    // โปรเจกต์เป็น Private แล้วผู้รับถูกนำออก
    const pm = (await t.owner.query('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, team.devId])).rows[0];
    d = await pending();
    await t.owner.query(`UPDATE projects SET visibility = 'private' WHERE id = $1`, [projectId]);
    await t.owner.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, team.devId]);
    await dispatcher.deliver(d);
    await t.owner.query(`UPDATE projects SET visibility = 'workspace' WHERE id = $1`, [projectId]);
    if (pm) await t.owner.query('INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES ($1,$2,$3,$4)', [wsId, projectId, team.devId, pm.role]);
    expect(mails).toHaveLength(0);
    expect((await status(d)).status).toBe('failed');

    // ปิด Email ของเหตุการณ์นี้หลังเข้าคิว
    d = await pending();
    await t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'issue.assigned','email',false)`, [wsId, team.devId]);
    await dispatcher.deliver(d);
    await t.owner.query('DELETE FROM user_notification_prefs');
    expect(mails).toHaveLength(0);
    expect((await status(d)).last_error).toContain('ปิดช่องทาง');

    // ยังมีสิทธิ์ → ส่งได้
    d = await pending();
    await dispatcher.deliver(d);
    expect(mails).toHaveLength(1);
    expect((await status(d)).status).toBe('sent');
  });

  it('งานเลิกแชร์ให้ Guest ระหว่างรอ → Guest Viewer ไม่ได้ Email', async () => {
    const g = await client(t.app);
    const gid = await signup(g, 'guest-mail@channels.example.com', 'Guest Mail');
    await addMember(t.owner, team.slug, gid, 'guest', { key: team.key, role: 'viewer' });
    await t.owner.query('INSERT INTO user_notification_settings (workspace_id, user_id, quiet_start, quiet_end, quiet_on_holidays) VALUES ($1,$2,NULL,NULL,false)', [wsId, gid]);
    const task = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานที่แชร์ชั่วคราว', moduleId: team.project.modules[0].id });
    await t.owner.query('UPDATE issues SET shared_with_guests = true WHERE id = $1', [task.body.id]);
    const n = (await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, project_id, issue_id, payload, reason) VALUES ($1,$2,'issue.assigned',$3,$4,'{}','ทดสอบ') RETURNING id`, [wsId, gid, projectId, task.body.id])).rows[0].id;
    const d = (await t.owner.query(`INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref) VALUES ($1,$2,'email','guest-mail@channels.example.com') RETURNING id`, [wsId, n])).rows[0].id;
    await t.owner.query('UPDATE issues SET shared_with_guests = false WHERE id = $1', [task.body.id]);
    mails = [];
    await dispatcher.deliver(d);
    expect(mails.map((m) => m.to)).toEqual([]);
    expect((await status(d)).status).toBe('failed');
  });
});

describe('In-app กับ Email แยกกัน (BUG-13)', () => {
  async function watched() {
    const task = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานที่ Dev ติดตาม', moduleId: team.project.modules[0].id });
    expect(task.status).toBe(201);
    await t.owner.query('INSERT INTO issue_watchers (workspace_id, issue_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [wsId, task.body.id, team.devId]);
    return task.body as { id: string; key: string };
  }
  const comment = (issueId: string) =>
    t.app.get(EventBus).publish({ type: 'issue.commented', workspaceId: wsId, projectId, issueId, actorId: team.leadId, data: { excerpt: 'คอมเมนต์ใหม่' }, at: new Date() });
  const pref = (eventType: string, channel: string, enabled: boolean) =>
    t.owner.query('INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,$3,$4,$5)', [wsId, team.devId, eventType, channel, enabled]);
  const inbox = async () => (await team.dev.get('/me/notifications?filter=all')).body.items as Array<{ eventType: string }>;

  it('In-app ปิด / Email เปิด → ส่ง Email แต่ไม่เข้า Inbox และไม่นับในตัวเลขยังไม่อ่าน', async () => {
    const task = await watched();
    await pref('issue.commented', 'in_app', false);
    await pref('issue.commented', 'email', true);
    await comment(task.id);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(`dev@${team.slug}.example.com`);
    expect((await inbox()).filter((i) => i.eventType === 'issue.commented')).toEqual([]);
    const summary = await team.dev.get('/me/notifications/summary');
    expect(JSON.stringify(summary.body)).not.toContain('issue.commented');
  });

  it('In-app เปิด / Email ปิด → เข้า Inbox อย่างเดียว', async () => {
    const task = await watched();
    await pref('issue.commented', 'email', false);
    await comment(task.id);
    expect(mails).toHaveLength(0);
    expect((await inbox()).some((i) => i.eventType === 'issue.commented')).toBe(true);
  });

  it('ทุกผู้รับปิด In-app → กฎ Webhook ของโปรเจกต์ยังส่ง', async () => {
    const hook = await createHook();
    await ruleFor(hook.id, 'issue.commented');
    const task = await watched();
    await pref('issue.commented', 'in_app', false);
    await comment(task.id);
    expect(hits).toHaveLength(1);
  });
});

describe('Daily digest ทาง Email โดยไม่เปิด In-app (K01)', () => {
  async function overdueTask() {
    const task = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานเลยกำหนดของ Dev', moduleId: team.project.modules[0].id, assigneeIds: [team.devId] });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    await t.owner.query(`UPDATE issues SET plan_end = '2026-11-02' WHERE id = $1`, [task.body.id]);
    return task.body as { id: string };
  }
  const digestRows = async () => (await t.owner.query(`SELECT in_app FROM notifications WHERE event_type = 'digest.daily' AND recipient_id = $1`, [team.devId])).rows;
  const pref = (channel: string, enabled: boolean) =>
    t.owner.query(`INSERT INTO user_notification_prefs (workspace_id, user_id, event_type, channel, enabled) VALUES ($1,$2,'digest.daily',$3,$4)`, [wsId, team.devId, channel, enabled]);

  it('Email เปิด / In-app ปิด → ได้ Email และแถว in_app = false ที่ไม่เข้า Inbox', async () => {
    const task = await overdueTask();
    await pref('email', true);
    await pref('in_app', false);
    mails = [];
    await t.app.get(Reminders).digest('2026-11-06');
    expect(await digestRows()).toEqual([{ in_app: false }]);
    expect(mails.filter((m) => m.to === `dev@${team.slug}.example.com`)).toHaveLength(1);
    const inbox = (await team.dev.get('/me/notifications?filter=all')).body.items as Array<{ eventType: string }>;
    expect(inbox.some((i) => i.eventType === 'digest.daily')).toBe(false);
    await t.owner.query('DELETE FROM issues WHERE id = $1', [task.id]);
  });

  it('ปิดทุกช่องทาง → ไม่สร้างแถว · เปิด In-app → เข้า Inbox', async () => {
    const task = await overdueTask();
    await pref('email', false);
    await t.app.get(Reminders).digest('2026-11-06');
    expect(await digestRows()).toEqual([]);
    await pref('in_app', true);
    await t.app.get(Reminders).digest('2026-11-06');
    expect(await digestRows()).toEqual([{ in_app: true }]);
    await t.owner.query('DELETE FROM issues WHERE id = $1', [task.id]);
  });
});

describe('Email ของ Workspace', () => {
  const dns = (records: Record<string, string[]>) => {
    t.app.get(DnsChecker).txt = async (name: string) => records[name] ?? [];
  };

  it('ยังไม่ตั้งค่า → ใช้ระบบส่งของ Friday', async () => {
    const r = await team.lead.get(`${team.ws}/channels/email`);
    expect(r.body).toEqual({ configured: false, mode: 'friday', config: null });
  });

  it('ตั้งค่าผู้ส่ง: ยังไม่ยืนยันโดเมนส่งผ่านระบบ แต่ใช้ชื่อและ Reply-To ของ Workspace', async () => {
    const put = await team.lead.put(`${team.ws}/channels/email`, { fromName: 'Friday Dev', fromEmail: 'Notify@Corp.example.com', smtpHost: 'smtp.corp.example.com', smtpPort: 587, smtpUser: 'mailer', smtpPassword: 'p@ssw0rd-1234' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ configured: true, mode: 'friday', config: { fromEmail: 'notify@corp.example.com', smtpPasswordLast4: '1234', dns: { spf: false, dkim: false, dmarc: false }, verifiedAt: null } });
    expect(JSON.stringify(put.body)).not.toContain('p@ssw0rd');
    expect((await t.owner.query('SELECT smtp_password_encrypted FROM email_sender_configs')).rows[0].smtp_password_encrypted).not.toContain('p@ssw0rd');

    await notify('issue.assigned', [team.devId]);
    expect(mails[0]).toMatchObject({ from: 'Friday Dev <notify@friday.test>', replyTo: 'notify@corp.example.com' });
    expect(mails[0].cfg.host).toBe('smtp.test.example.com');
  });

  it(':verify-dns ผ่านครบจึงยืนยัน แล้วส่งผ่าน SMTP ขององค์กร (ใช้รหัสผ่านที่เก็บไว้)', async () => {
    await team.lead.put(`${team.ws}/channels/email`, { fromName: 'Friday Dev', fromEmail: 'notify@corp.example.com', smtpHost: 'smtp.corp.example.com', smtpPort: 587, smtpUser: 'mailer', smtpPassword: 'p@ssw0rd-1234' });
    dns({ 'corp.example.com': ['v=spf1 include:_spf.corp.example.com ~all'], '_dmarc.corp.example.com': ['v=DMARC1; p=none'] });
    const partial = await team.lead.post(`${team.ws}/channels/email/verify-dns`);
    expect(partial.body.config).toMatchObject({ dns: { spf: true, dkim: false, dmarc: true }, verifiedAt: null });

    dns({ 'corp.example.com': ['v=spf1 -all'], 'friday._domainkey.corp.example.com': ['v=DKIM1; k=rsa; p=abc'], '_dmarc.corp.example.com': ['v=DMARC1; p=none'] });
    const ok = await team.lead.post(`${team.ws}/channels/email:verify-dns`);
    expect(ok.body).toMatchObject({ mode: 'custom', config: { dns: { spf: true, dkim: true, dmarc: true } } });
    expect(ok.body.config.verifiedAt).toBeTruthy();

    await notify('issue.assigned', [team.devId]);
    expect(mails[0]).toMatchObject({ from: 'Friday Dev <notify@corp.example.com>' });
    expect(mails[0].cfg).toMatchObject({ host: 'smtp.corp.example.com', port: 587, user: 'mailer', pass: 'p@ssw0rd-1234' });

    // เปลี่ยนโดเมนผู้ส่ง → ต้องตรวจใหม่
    const changed = await team.lead.put(`${team.ws}/channels/email`, { fromName: 'Friday Dev', fromEmail: 'notify@other.example.com', smtpHost: 'smtp.corp.example.com', smtpPort: 587 });
    expect(changed.body).toMatchObject({ mode: 'friday', config: { verifiedAt: null, smtpPasswordLast4: '1234' } });
  });

  it(':test ส่งอีเมลทดสอบถึงผู้เรียก · ส่งไม่ได้ตอบ 502', async () => {
    await team.lead.put(`${team.ws}/channels/email`, { fromName: 'Friday Dev', fromEmail: 'notify@corp.example.com' });
    const ok = await team.lead.post(`${team.ws}/channels/email/test`);
    expect(ok.body).toEqual({ sent: true, to: `lead@${team.slug}.example.com` });
    expect(mails.at(-1)?.subject).toBe('[Friday] อีเมลทดสอบ');
    mailFails = 1;
    const bad = await team.lead.post(`${team.ws}/channels/email:test`);
    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatchObject({ code: 'email_send_failed', details: { reason: 'smtp down' } });
  });

  it('ข้อมูลผิด / ไม่ใช่ Admin', async () => {
    expect((await team.lead.put(`${team.ws}/channels/email`, { fromName: 'x', fromEmail: 'not-email' })).status).toBe(400);
    expect((await team.lead.put(`${team.ws}/channels/email`, { fromName: 'x', fromEmail: 'a@b.example.com', smtpHost: 'smtp.example.com' })).status).toBe(400);
    const denied = [
      () => team.dev.get(`${team.ws}/channels/email`),
      () => team.dev.put(`${team.ws}/channels/email`, { fromName: 'x', fromEmail: 'a@b.example.com' }),
      () => team.dev.get(`${team.ws}/channels/webhooks`),
      () => team.dev.get(`${team.ws}/channels/deliveries`),
      () => team.dev.get(`${team.ws}/notification-templates/issue.assigned/preview`),
    ];
    for (const call of denied) expect((await call()).status).toBe(403);
  });
});

describe('ประวัติการส่งและตัวอย่างข้อความ (N2)', () => {
  it('deliveries: กรองตามสถานะ / ช่องทาง และแบ่งหน้า', async () => {
    await notify('issue.assigned', [team.devId]);
    await notify('issue.mentioned', [team.devId]);
    await notify('issue.review_requested', [team.devId]);
    const all = await team.lead.get(`${team.ws}/channels/deliveries?limit=2`);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).toBeTruthy();
    const next = await team.lead.get(`${team.ws}/channels/deliveries?limit=2&before=${encodeURIComponent(all.body.nextCursor)}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.nextCursor).toBeNull();
    expect((await team.lead.get(`${team.ws}/channels/deliveries?status=failed`)).body.items).toHaveLength(0);
    expect((await team.lead.get(`${team.ws}/channels/deliveries?channel=webhook`)).body.items).toHaveLength(0);
    expect((await team.lead.get(`${team.ws}/channels/deliveries?status=bogus`)).status).toBe(400);
  });

  it('preview: อีเมล / Webhook ทุกรูปแบบ และโหมดปลอดภัย', async () => {
    const email = await team.lead.get(`${team.ws}/notification-templates/due_request.created/preview?channel=email&safe=false`);
    expect(email.status).toBe(200);
    expect(email.body).toMatchObject({ event: 'due_request.created', channel: 'email', safeMode: false, message: { head: 'Kaijeaw ขอเลื่อนวันครบกำหนด' } });
    expect(email.body.rendered.subject).toBe('[Friday] Kaijeaw ขอเลื่อนวันครบกำหนด: DP-30 Curtailment Information');
    expect(email.body.message.rows.length).toBeGreaterThan(0);

    const safe = await team.lead.get(`${team.ws}/notification-templates/due_request.created/preview?channel=email`);
    expect(safe.body).toMatchObject({ safeMode: true, message: { rows: [], note: '' } });

    for (const [format, key] of [['discord', 'embeds'], ['slack', 'blocks'], ['teams', '@type'], ['telegram', 'text'], ['json', 'event']] as const) {
      const r = await team.lead.get(`${team.ws}/notification-templates/bug.created/preview?channel=webhook&format=${format}`);
      expect(r.body.rendered, format).toHaveProperty(key);
    }
    expect((await team.lead.get(`${team.ws}/notification-templates/bug.created/preview?channel=fax`)).status).toBe(400);
  });
});

describe('รายงานรายสัปดาห์', () => {
  const sched = { weekday: 3, time: '09:00', channels: ['email'] };

  it('PUT / GET report-schedule · เฉพาะผู้มีสิทธิ์แก้ Settings', async () => {
    expect((await team.lead.get(`${team.ws}/projects/${team.key}/report-schedule`)).body).toEqual({ schedule: null });
    const put = await team.lead.put(`${team.ws}/projects/${team.key}/report-schedule`, { ...sched, recipients: [team.leadId] });
    expect(put.body.schedule).toEqual({ reportType: 'weekly', weekday: 3, time: '09:00', channels: ['email'], recipients: [team.leadId] });
    expect((await team.lead.put(`${team.ws}/projects/${team.key}/report-schedule`, { ...sched, weekday: 8 })).status).toBe(400);
    expect((await team.lead.put(`${team.ws}/projects/${team.key}/report-schedule`, { ...sched, time: '9am' })).status).toBe(400);
    expect((await team.dev.put(`${team.ws}/projects/${team.key}/report-schedule`, sched)).status).toBe(403);
  });

  it('weekly:send ส่งทันที (Email + Webhook ตามกฎ)', async () => {
    await team.lead.put(`${team.ws}/projects/${team.key}/report-schedule`, { ...sched, recipients: [team.leadId] });
    const hook = await createHook({ format: 'slack' });
    await ruleFor(hook.id, 'report.weekly');
    await t.owner.query('UPDATE workspace_settings SET safe_mode = false WHERE workspace_id = $1', [wsId]);
    const r = await team.lead.post(`${team.ws}/projects/${team.key}/reports/weekly:send`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: 1 });
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'report.weekly' AND recipient_id = $1`, [team.leadId])).rowCount).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe(`[Friday] รายงานสรุปรายสัปดาห์: รายงานสรุปสัปดาห์ ${team.key}`);
    expect(mails[0].text).toContain('เสร็จใน 7 วัน: 0');
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toHaveProperty('blocks');
  });

  it('งานตามเวลา: ส่งวันละครั้งเมื่อถึงวัน / เวลาที่ตั้ง', async () => {
    await team.lead.put(`${team.ws}/projects/${team.key}/report-schedule`, { weekday: 3, time: '09:00', channels: ['email'], recipients: [team.devId] });
    const svc = t.app.get(ProjectNotifyService);
    // พุธ 4 พ.ย. 2569 08:00 ยังไม่ถึงเวลา
    expect(await svc.runDueSchedules(new Date('2026-11-04T01:00:00Z'))).toEqual({ date: '2026-11-04', sent: 0 });
    expect(await svc.runDueSchedules(new Date('2026-11-04T03:00:00Z'))).toEqual({ date: '2026-11-04', sent: 1 });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(`dev@${team.slug}.example.com`);
    // วันอื่นไม่ส่ง · วันเดิมรันซ้ำไม่ส่งซ้ำ
    expect(await svc.runDueSchedules(new Date('2026-11-05T03:00:00Z'))).toMatchObject({ sent: 0 });
    await svc.runDueSchedules(new Date('2026-11-04T04:00:00Z'));
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'report.weekly' AND recipient_id = $1`, [team.devId])).rowCount).toBe(1);
    expect(mails).toHaveLength(1);
  });
});
