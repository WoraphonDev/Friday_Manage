// O23 · ประวัติการส่ง (เนื้อหา คำตอบปลายทาง ลำดับเหตุการณ์) · รายชื่อไม่ส่งอีเมล · bounce / complaint · ส่งซ้ำ · ลบเมื่อครบ 90 วัน
// SMTP ปลอม = transport ใน Mailer · Webhook ปลอม = HTTP server ในเครื่อง · ข้อมูลสมมติเท่านั้น
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChannelDispatcher } from '../src/channels/dispatcher.js';
import { Mailer } from '../src/core/mail.js';
import { Notifier } from '../src/notifications/notifier.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

process.env.SMTP_HOST = 'smtp.test.example.com';
process.env.MAIL_FROM = 'Friday Work Management <notify@friday.test>';
process.env.WEBHOOK_ALLOW_PRIVATE = '1';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let dispatcher: ChannelDispatcher;
let mails: { to: string; subject: string }[] = [];
let hookStatuses: { status: number; body: string }[] = [];
let hookServer: Server;
let hookUrl: string;
const devEmail = () => 'dev@friday-dev.example.com';

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const next = hookStatuses.shift() ?? { status: 200, body: 'ok' };
      res.statusCode = next.status;
      res.end(next.body);
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/api/webhooks/123456789/secret-token-9876?x=1`;
  t = await startApp();
  t.app.get(Mailer).transportFactory = () => ({ sendMail: async (m: Record<string, unknown>) => void mails.push(m as { to: string; subject: string }) });
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  dispatcher = t.app.get(ChannelDispatcher);
  for (const uid of [team.leadId, team.devId]) {
    await t.owner.query('INSERT INTO user_notification_settings (workspace_id, user_id, quiet_start, quiet_end, quiet_on_holidays) VALUES ($1,$2,NULL,NULL,false)', [wsId, uid]);
  }
});
afterAll(async () => {
  await t.close();
  await new Promise((r) => hookServer.close(r));
});
beforeEach(async () => {
  mails = [];
  hookStatuses = [];
  for (const table of ['notification_deliveries', 'notifications', 'project_notification_rules', 'project_notification_settings', 'webhook_endpoints', 'email_feedback_events']) await t.owner.query(`DELETE FROM ${table}`);
  await t.owner.query('UPDATE email_suppressions SET removed_at = now() WHERE removed_at IS NULL');
  await t.owner.query(`INSERT INTO project_notification_settings (workspace_id, project_id, quiet_mode) VALUES ($1,$2,'always_send')`, [wsId, team.project.id]);
});

const notify = (eventType: string, recipients: string[], payload: Record<string, unknown> = {}) =>
  t.app.get(Notifier).notify({
    workspaceId: wsId, recipientIds: recipients, eventType, actorId: team.leadId, projectId: team.project.id,
    payload: { projectKey: team.key, projectName: 'Development Plan', issueKey: 'DP-1', issueTitle: 'งานทดสอบ', actorName: 'Mick', ...payload },
    reason: 'คุณเป็น Assignee ของงานนี้',
  });
const deliveries = async (where = '') => (await t.owner.query(`SELECT * FROM notification_deliveries ${where} ORDER BY created_at`)).rows;
const feedback = (body: unknown, token = 'dev-email-feedback', type = 'text/plain') =>
  request(t.app.getHttpServer()).post(`/api/v1/hooks/email-feedback?token=${token}`).set('content-type', type).send(typeof body === 'string' ? body : JSON.stringify(body));
const sns = (message: unknown) => ({ Type: 'Notification', MessageId: 'sns-demo-1', Message: JSON.stringify(message) });
const bounce = (email: string, bounceType = 'Permanent') => sns({ notificationType: 'Bounce', bounce: { bounceType, bounceSubType: 'General', bouncedRecipients: [{ emailAddress: email, diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] } });

describe('ประวัติการส่ง', () => {
  it('Email: เก็บชื่อปลายทาง เนื้อหาที่ผู้รับเห็น คำตอบ และลำดับเหตุการณ์', async () => {
    await notify('issue.assigned', [team.devId]);
    const [d] = await deliveries();
    expect(d).toMatchObject({ status: 'sent', target_label: devEmail(), response: { status: 250, body: 'SMTP accepted' } });
    expect(d.content.view.subject).toContain('DP-1');
    expect(d.log).toEqual([expect.objectContaining({ kind: 'attempt_ok', attempt: 1, status: 250 })]);
  });

  it('Webhook ล้มครบ: คำตอบปลายทาง, URL ซ่อน token, ปิดชั่วคราวลงในลำดับเหตุการณ์', async () => {
    const hook = await team.lead.post(`${team.ws}/channels/webhooks`, { name: 'Discord dev-alerts', format: 'discord', url: hookUrl });
    expect(hook.status).toBe(201);
    await team.lead.put(`${team.ws}/projects/${team.key}/notification-rules`, { rules: [{ eventType: 'bug.created', webhookId: hook.body.id }] }).expect(200);
    hookStatuses = Array(4).fill({ status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' });
    await notify('bug.created', [team.devId], { severity: 'Major' });
    const [d] = await deliveries(`WHERE channel = 'webhook'`);
    expect(d).toMatchObject({ status: 'failed', attempts: 4, target_label: 'Discord dev-alerts', response: { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' } });
    expect(d.content.request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/webhooks\/••••\/••••$/);
    expect(d.content.request.body).toContain('Friday Work Management');
    expect(d.log.map((e: { kind: string; final?: boolean }) => `${e.kind}${e.final ? '!' : ''}`)).toEqual(['attempt_failed', 'attempt_failed', 'attempt_failed', 'attempt_failed!', 'paused']);
  });

  it('ส่งซ้ำที่ทีม Friday ขอ: งาน scan หยิบไปส่งและล้างธง', async () => {
    mails = [];
    await notify('issue.assigned', [team.devId]);
    const [d] = await deliveries();
    await t.owner.query(`UPDATE notification_deliveries SET status = 'failed', resend_requested_at = now() WHERE id = $1`, [d.id]);
    expect(await dispatcher.resendRequested()).toBe(1);
    const [after] = await deliveries();
    expect(after).toMatchObject({ status: 'sent', attempts: 2, resend_requested_at: null });
    expect(mails).toHaveLength(2);
  });

  it('ลบรายการส่งที่เก่ากว่า 90 วัน', async () => {
    await notify('issue.assigned', [team.devId]);
    await t.owner.query(`UPDATE notification_deliveries SET created_at = now() - interval '91 days'`);
    expect(await dispatcher.purge()).toEqual({ deleted: 1 });
    expect(await deliveries()).toEqual([]);
  });
});

describe('Bounce / complaint และรายชื่อไม่ส่งอีเมล', () => {
  it('token ผิด → 401 · JSON ผิด → 400 · SubscriptionConfirmation ยังไม่ยืนยันเอง', async () => {
    expect((await feedback(bounce(devEmail()), 'wrong')).status).toBe(401);
    expect((await feedback('not json')).status).toBe(400);
    expect((await feedback({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.example.com/confirm' })).body).toEqual({ accepted: 0, subscription: 'pending' });
  });

  it('bounce ถาวร → เพิ่มในรายชื่อไม่ส่ง · ส่งครั้งถัดไปเป็น suppressed ไม่ retry', async () => {
    await notify('issue.assigned', [team.devId]);
    const r = await feedback(bounce('DEV@friday-dev.example.com'));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ accepted: 1, suppressed: 1 });
    const sup = (await t.owner.query(`SELECT email, reason, workspace_id, source FROM email_suppressions WHERE removed_at IS NULL`)).rows;
    expect(sup).toEqual([{ email: devEmail(), reason: 'hard_bounce', workspace_id: wsId, source: 'ses' }]);
    // รายการที่ส่งไปแล้วบันทึกว่าปลายทางตีกลับ
    expect((await deliveries())[0].log.at(-1)).toMatchObject({ kind: 'bounced', message: 'smtp; 550 5.1.1 user unknown' });
    mails = [];
    await notify('issue.mentioned', [team.devId]);
    const [, second] = await deliveries();
    expect(second).toMatchObject({ status: 'suppressed', attempts: 0, last_error: 'อีเมลอยู่ในรายชื่อไม่ส่ง (hard_bounce)' });
    expect(mails).toHaveLength(0);
    // ส่งซ้ำ bounce เดิมไม่เพิ่มแถวซ้ำ
    expect((await feedback(bounce(devEmail()))).body).toEqual({ accepted: 1, suppressed: 0 });
  });

  it('รายงานสแปม (ส่งตรงแบบไม่มีซอง SNS) → complaint', async () => {
    const r = await feedback({ notificationType: 'Complaint', complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'lead@friday-dev.example.com' }] } }, 'dev-email-feedback', 'application/json');
    expect(r.body).toEqual({ accepted: 1, suppressed: 1 });
    expect((await t.owner.query(`SELECT reason FROM email_suppressions WHERE removed_at IS NULL`)).rows).toEqual([{ reason: 'complaint' }]);
  });

  it('bounce ชั่วคราว 5 วันใน 7 วัน → เพิ่มในรายชื่อ · น้อยกว่านั้นยังส่ง', async () => {
    for (let i = 4; i >= 1; i--) await t.owner.query(`INSERT INTO email_feedback_events (email, kind, created_at) VALUES ($1, 'bounce_transient', now() - make_interval(days => $2))`, [devEmail(), i]);
    expect((await feedback(bounce(devEmail(), 'Transient'))).body).toEqual({ accepted: 1, suppressed: 1 });
    expect((await t.owner.query(`SELECT reason FROM email_suppressions WHERE removed_at IS NULL`)).rows).toEqual([{ reason: 'soft_bounce_repeated' }]);
  });

  it('เอาออกจากรายการแล้ว (removed_at) ส่งได้อีก', async () => {
    await feedback(bounce(devEmail()));
    await t.owner.query(`UPDATE email_suppressions SET removed_at = now(), remove_reason = 'ลูกค้ายืนยัน'`);
    await notify('issue.assigned', [team.devId]);
    expect((await deliveries())[0].status).toBe('sent');
  });

  it('Admin ของ Workspace กรองดูรายการที่ไม่ส่งได้', async () => {
    await feedback(bounce(devEmail()));
    await notify('issue.assigned', [team.devId]);
    const r = await team.lead.get(`${team.ws}/channels/deliveries?status=suppressed`);
    expect(r.status).toBe(200);
    expect(r.body.items).toMatchObject([{ channel: 'email', status: 'suppressed' }]);
  });
});
