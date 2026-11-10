// O23 · ประวัติการส่งแจ้งเตือน และรายชื่อไม่ส่งอีเมล ในหลังบ้าน · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let support: Staff;
let engineer: Staff;
let finance: Staff;
let a: Customer;
const ids: Record<string, string> = {};

/** แจ้งเตือน + รายการส่ง 1 รายการ */
async function delivery(name: string, opts: { channel: string; target: string; label: string; status: string; attempts: number; log: unknown[]; content?: unknown; response?: unknown; minutesAgo?: number; issueKey?: string }) {
  const n = (await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason) VALUES ($1,$2,'issue.assigned',$3,'ทดสอบ') RETURNING id`, [a.id, a.owner, JSON.stringify({ issueKey: opts.issueKey ?? 'DP-1', issueTitle: 'งานลับของลูกค้า' })])).rows[0].id;
  const r = await t.owner.query(
    `INSERT INTO notification_deliveries (workspace_id, notification_id, channel, target_ref, target_label, status, attempts, log, content, response, last_error, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() - make_interval(mins => $12)) RETURNING id`,
    [a.id, n, opts.channel, opts.target, opts.label, opts.status, opts.attempts, JSON.stringify(opts.log), opts.content ? JSON.stringify(opts.content) : null, opts.response ? JSON.stringify(opts.response) : null, opts.status === 'failed' ? 'Webhook ตอบ HTTP 404' : null, opts.minutesAgo ?? 5],
  );
  ids[name] = r.rows[0].id;
}

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  a = await customer(t, 'orbit-demo', { plan: 'team_s', status: 'active' });
  const hook = (await t.owner.query(`INSERT INTO webhook_endpoints (workspace_id, name, url_encrypted, url_last4, status) VALUES ($1, 'Discord dev-alerts', 'enc', 'abcd', 'paused') RETURNING id`, [a.id])).rows[0].id;
  const fail = (n: number, final = false) => ({ at: new Date().toISOString(), kind: 'attempt_failed', attempt: n, status: 404, message: 'Webhook ตอบ HTTP 404', final });
  await delivery('hook', {
    channel: 'webhook', target: hook, label: 'Discord dev-alerts', status: 'failed', attempts: 4, issueKey: 'DP-118',
    log: [fail(1), fail(2), fail(3), fail(4, true), { at: new Date().toISOString(), kind: 'paused' }],
    content: { view: { text: 'Bug ใหม่: งานลับของลูกค้า' }, request: { method: 'POST', url: 'https://discord.com/api/webhooks/••••/••••', headers: { 'content-type': 'application/json' }, body: '{"content":"งานลับของลูกค้า"}' } },
    response: { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' },
  });
  await delivery('mail', { channel: 'email', target: 'ops@orbit.example.com', label: 'ops@orbit.example.com', status: 'sent', attempts: 1, log: [{ at: new Date().toISOString(), kind: 'attempt_ok', attempt: 1, status: 250 }], response: { status: 250, body: 'SMTP accepted' }, minutesAgo: 8 });
  await delivery('blocked', { channel: 'email', target: 'qa@orbit.example.com', label: 'qa@orbit.example.com', status: 'suppressed', attempts: 0, log: [{ at: new Date().toISOString(), kind: 'suppressed', message: 'hard_bounce', final: true }], minutesAgo: 10 });
  await delivery('quiet', { channel: 'line_group', target: hook, label: 'กลุ่ม LINE · Dev', status: 'skipped_quiet_hours', attempts: 0, log: [{ at: new Date().toISOString(), kind: 'quiet' }], minutesAgo: 12 });
  await delivery('retry', { channel: 'webhook', target: hook, label: 'Discord dev-alerts', status: 'failed', attempts: 2, log: [fail(1), fail(2)], minutesAgo: 14 });
  await delivery('old', { channel: 'email', target: 'ops@orbit.example.com', label: 'ops@orbit.example.com', status: 'sent', attempts: 1, log: [], minutesAgo: 60 * 30 });
  ids.sup = (await t.owner.query(`INSERT INTO email_suppressions (email, reason, detail, workspace_id) VALUES ('qa@orbit.example.com', 'hard_bounce', 'smtp; 550 user unknown', $1) RETURNING id`, [a.id])).rows[0].id;
  await t.owner.query(`INSERT INTO email_feedback_events (email, kind) VALUES ('qa@orbit.example.com', 'bounce_permanent')`);
});
afterAll(() => t.close());

describe('ประวัติการส่ง', () => {
  it('ใครเห็น: Owner / Support / วิศวกร · การเงินไม่เห็น', async () => {
    expect((await finance.agent.get('/ops/deliveries')).status).toBe(403);
    expect((await engineer.agent.get('/ops/deliveries')).status).toBe(200);
  });

  it('รายการ + สรุป 24 ชม. · สถานะตามหน้าจอ', async () => {
    const r = await support.agent.get('/ops/deliveries');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((i: { id: string; status: string }) => [i.id, i.status]));
    expect(byId).toMatchObject({ [ids.hook]: 'fail', [ids.mail]: 'ok', [ids.blocked]: 'blocked', [ids.quiet]: 'quiet', [ids.retry]: 'retry', [ids.old]: 'ok' });
    expect(r.body.items[0]).toMatchObject({ id: ids.hook, channel: 'webhook', to: 'Discord dev-alerts', event: { type: 'issue.assigned', issueKey: 'DP-118' }, workspace: { slug: 'orbit-demo' }, attempts: 4 });
    expect(r.body.stats).toMatchObject({ total: 5, byChannel: { email: 2, line: 1, webhook: 2 }, failed: { total: 2, webhook: 2 }, waitingQuiet: 1, suppressed: 1, bouncePct: 100 });
    expect(r.body.stats.deliveredPct).toBeCloseTo(33.3);
  });

  it('ค้นตามผู้รับ / Workspace / Issue key · กรองช่องทางและสถานะ', async () => {
    expect((await support.agent.get('/ops/deliveries?q=ops@orbit')).body.items.map((i: { id: string }) => i.id)).toEqual([ids.mail, ids.old]);
    expect((await support.agent.get('/ops/deliveries?q=DP-118')).body.items.map((i: { id: string }) => i.id)).toEqual([ids.hook]);
    expect((await support.agent.get('/ops/deliveries?channel=line')).body.items.map((i: { id: string }) => i.id)).toEqual([ids.quiet]);
    expect((await support.agent.get('/ops/deliveries?status=blocked')).body.items.map((i: { id: string }) => i.id)).toEqual([ids.blocked]);
    expect((await support.agent.get('/ops/deliveries?status=fail&channel=webhook')).body.items).toHaveLength(2);
    const page = await support.agent.get('/ops/deliveries?limit=2');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextBefore).not.toBeNull();
  });

  it('วิศวกรเห็นอีเมลแบบซ่อน และค้นด้วยอีเมลไม่ได้', async () => {
    const r = await engineer.agent.get(`/ops/deliveries?status=ok`);
    expect(r.body.items.map((i: { to: string }) => i.to)).toContain('o•••@orbit.example.com');
    expect((await engineer.agent.get('/ops/deliveries?q=ops@orbit')).body.items).toEqual([]);
  });

  it('รายละเอียด: คำตอบปลายทาง ลำดับเหตุการณ์ · เนื้อหาซ่อนจนลูกค้าเปิดสิทธิ์', async () => {
    const r = await support.agent.get(`/ops/deliveries/${ids.hook}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'fail', response: { status: 404 }, webhook: { name: 'Discord dev-alerts', status: 'paused' }, contentAccess: { allowed: false, reason: 'no_grant' }, canResend: true });
    expect(r.body.log.at(-1).kind).toBe('paused');
    expect(r.body.content).toEqual({ view: null, request: { method: 'POST', url: 'https://discord.com/api/webhooks/••••/••••', headers: { 'content-type': 'application/json' }, body: null } });
    await t.owner.query(`INSERT INTO support_access_grants (workspace_id, granted_by, until) VALUES ($1, $2, now() + interval '1 day')`, [a.id, a.owner]);
    const open = await support.agent.get(`/ops/deliveries/${ids.hook}`);
    expect(open.body.content.view.text).toContain('งานลับของลูกค้า');
    // วิศวกรไม่เห็นเนื้อหาแม้ลูกค้าเปิดสิทธิ์
    expect((await engineer.agent.get(`/ops/deliveries/${ids.hook}`)).body.contentAccess).toEqual({ allowed: false, reason: 'role' });
    expect((await support.agent.get('/ops/deliveries/not-a-uuid')).status).toBe(404);
  });

  it('ส่งซ้ำ: ตั้งธงให้ API · ซ้ำไม่ได้ · ที่ส่งถึงแล้วส่งซ้ำไม่ได้ · ลง Audit log ของลูกค้า', async () => {
    const r = await engineer.agent.post(`/ops/deliveries/${ids.hook}/resend`).send({ reason: 'ลูกค้าสร้าง Webhook ใหม่แล้ว' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await t.owner.query('SELECT status, resend_requested_at, log FROM notification_deliveries WHERE id = $1', [ids.hook])).rows[0];
    expect(row.status).toBe('queued');
    expect(row.resend_requested_at).not.toBeNull();
    expect(row.log.at(-1)).toMatchObject({ kind: 'resend', message: 'Eve Engineer · ลูกค้าสร้าง Webhook ใหม่แล้ว' });
    expect((await engineer.agent.post(`/ops/deliveries/${ids.hook}/resend`).send({})).status).toBe(409);
    expect((await engineer.agent.post(`/ops/deliveries/${ids.mail}/resend`).send({})).status).toBe(409);
    const auditRows = await t.owner.query(`SELECT actor_kind, category FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.delivery_resend'`, [a.id]);
    expect(auditRows.rows).toEqual([{ actor_kind: 'friday_staff', category: 'notify' }]);
    expect((await support.agent.get('/ops/deliveries')).body.items.find((i: { id: string }) => i.id === ids.hook).status).toBe('retry');
  });

  it('อีเมลที่ยังอยู่ในรายชื่อไม่ส่งต้องเอาออกก่อนส่งซ้ำ', async () => {
    const r = await support.agent.post(`/ops/deliveries/${ids.blocked}/resend`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('email_suppressed');
  });

  it('แนบใน Ticket เป็นข้อความภายใน · วิศวกรแนบไม่ได้', async () => {
    const ticket = (await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_email, channel, category, priority, subject, status) VALUES ($1, 'ops@orbit.example.com', 'email', 'notify', 'normal', 'ไม่ได้รับแจ้งเตือน', 'open') RETURNING id, number`, [a.id])).rows[0];
    expect((await engineer.agent.post(`/ops/deliveries/${ids.mail}/attach`).send({ ticketNumber: ticket.number })).status).toBe(403);
    expect((await support.agent.post(`/ops/deliveries/${ids.mail}/attach`).send({ ticketNumber: 99999 })).status).toBe(404);
    const r = await support.agent.post(`/ops/deliveries/${ids.mail}/attach`).send({ ticketNumber: ticket.number });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const msg = (await t.owner.query('SELECT internal, body FROM support_ticket_messages WHERE ticket_id = $1', [ticket.id])).rows;
    expect(msg).toHaveLength(1);
    expect(msg[0].internal).toBe(true);
    expect(msg[0].body).toContain('HTTP 250 SMTP accepted');
  });
});

describe('รายชื่อไม่ส่งอีเมล', () => {
  it('รายการ · วิศวกรเห็นแบบซ่อน', async () => {
    const r = await support.agent.get('/ops/email-suppressions');
    expect(r.body.items).toEqual([expect.objectContaining({ id: ids.sup, email: 'qa@orbit.example.com', reason: 'hard_bounce', workspace: { id: a.id, name: 'Co orbit-demo' } })]);
    expect((await engineer.agent.get('/ops/email-suppressions')).body.items[0].email).toBe('q•••@orbit.example.com');
  });

  it('Y7 เอาออก: ต้องมีเหตุผล · วิศวกรทำไม่ได้ · ลง Audit log · ซ้ำได้ 404', async () => {
    expect((await engineer.agent.post(`/ops/email-suppressions/${ids.sup}/remove`).send({ reason: 'ลูกค้ายืนยันแล้ว' })).status).toBe(403);
    expect((await support.agent.post(`/ops/email-suppressions/${ids.sup}/remove`).send({ reason: 'สั้น' })).status).toBe(400);
    const r = await support.agent.post(`/ops/email-suppressions/${ids.sup}/remove`).send({ reason: 'ลูกค้ายืนยันใน Ticket ว่าสร้างกล่องใหม่แล้ว' });
    expect(r.status).toBe(200);
    expect((await support.agent.get('/ops/email-suppressions')).body.items).toEqual([]);
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.email_unsuppressed'`, [a.id]);
    expect(audit.rows[0].summary).toContain('qa@orbit.example.com');
    expect((await support.agent.post(`/ops/email-suppressions/${ids.sup}/remove`).send({ reason: 'ลองเอาออกซ้ำ' })).status).toBe(404);
    // เอาออกแล้วส่งซ้ำรายการที่ไม่ได้ส่งได้
    expect((await support.agent.post(`/ops/deliveries/${ids.blocked}/resend`).send({})).status).toBe(200);
  });
});
