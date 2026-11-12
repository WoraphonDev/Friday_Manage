// O36 · ส่งบั๊กจาก Ticket ให้ทีมพัฒนา (โปรเจกต์ FM ของ Friday Manage เอง) · ใช้ Friday Manage API จำลองบน HTTP ในเครื่อง · ข้อมูลสมมติเท่านั้น
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevBridgeService } from '../src/dev-bridge/dev-bridge.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let support: Staff;
let engineer: Staff;
let finance: Staff;
let a: Customer;
let b: Customer;
let fmServer: Server;
let base: string;
const SECRET = 'whsec_sample_0123456789abcdef';
const TOKEN = 'fmt_sample_token_for_tests_only_000';

// ── Friday Manage จำลอง (เฉพาะ endpoint ที่ ops-api ใช้) ─────────────
interface FakeIssue { key: string; title: string; description: string; status: { id: string; name: string; category: string }; priority: string; planEnd: string | null; sprintId: string | null; assigneeIds: string[] }
const fake = {
  issues: new Map<string, FakeIssue>(),
  comments: [] as { key: string; body: string }[],
  labels: [] as { id: string; name: string }[],
  created: [] as Record<string, unknown>[],
  next: 482,
  statuses: [{ id: 's1', name: 'To do', category: 'todo' }, { id: 's2', name: 'In progress', category: 'in_progress' }, { id: 's3', name: 'Done', category: 'done' }, { id: 's4', name: 'Released', category: 'done' }, { id: 's5', name: "Won't fix", category: 'cancelled' }, { id: 's6', name: 'Duplicate', category: 'cancelled' }],
  authHeaders: [] as string[],
};
const setStatus = (key: string, name: string) => (fake.issues.get(key)!.status = fake.statuses.find((x) => x.name === name)!);

function fmApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    fake.authHeaders.push(String(req.headers.authorization));
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: 'invalid_token', message: 'API token ไม่ถูกต้อง' } });
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname.replace('/api/v1', '');
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'GET' && p === '/me') return send(200, { id: 'bot', displayName: 'support-bot' });
    if (req.method === 'GET' && p === '/w/friday-dev/projects/FM') return send(200, { id: 'p1', key: 'FM', name: 'Friday Manage' });
    if (req.method === 'GET' && p === '/w/friday-dev/projects/FM/workflows') return send(200, { items: [{ kind: 'bug', statuses: fake.statuses }] });
    if (req.method === 'GET' && p === '/w/friday-dev/projects/FM/labels') return send(200, { items: fake.labels });
    if (req.method === 'POST' && p === '/w/friday-dev/projects/FM/labels') {
      const l = { id: `lb${fake.labels.length + 1}`, name: body.name };
      fake.labels.push(l);
      return send(201, l);
    }
    if (req.method === 'GET' && p === '/w/friday-dev/projects/FM/members') return send(200, { items: [{ userId: 'u-dev-a', user: { id: 'u-dev-a', displayName: 'Dev A' } }] });
    if (req.method === 'GET' && p === '/w/friday-dev/projects/FM/backlog') return send(200, { sprints: [{ id: 'sp24', name: 'Sprint 24' }] });
    if (req.method === 'GET' && p === '/w/friday-dev/projects/FM/issues') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return send(200, { items: [...fake.issues.values()].filter((i) => i.title.toLowerCase().includes(q)) });
    }
    if (req.method === 'POST' && p === '/w/friday-dev/projects/FM/issues') {
      fake.created.push(body);
      const issue: FakeIssue = { key: `FM-${fake.next++}`, title: body.title, description: body.description, status: fake.statuses[0], priority: body.priority, planEnd: null, sprintId: null, assigneeIds: [] };
      fake.issues.set(issue.key, issue);
      return send(201, issue);
    }
    const m = /^\/w\/friday-dev\/issues\/([A-Z]+-\d+)(\/comments)?$/.exec(p);
    if (m && req.method === 'GET' && !m[2]) return fake.issues.has(m[1]) ? send(200, fake.issues.get(m[1])) : send(404, { error: { code: 'not_found', message: 'ไม่พบงาน' } });
    if (m && req.method === 'POST' && m[2]) {
      fake.comments.push({ key: m[1], body: body.body });
      return send(201, { id: 'c1' });
    }
    send(404, { error: { code: 'not_found', message: p } });
  });
}

/** ส่ง Webhook แบบที่ API ลูกค้าส่ง (A25 · รูปแบบ JSON + ลายเซ็น) */
function webhook(payload: object, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return request(t.app.getHttpServer()).post('/ops/hooks/fm').set('content-type', 'application/json').set('x-friday-timestamp', String(ts)).set('x-friday-signature', sig).send(body);
}
async function ticket(ws: Customer, subject: string, email: string) {
  const u = (await t.owner.query(`INSERT INTO users (email, display_name) VALUES ($1, $2) ON CONFLICT (lower(email)) DO UPDATE SET email = excluded.email RETURNING id`, [email, email.split('@')[0]])).rows[0].id;
  return (await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_user_id, requester_email, subject, category, channel) VALUES ($1, $2, $3, $4, 'import', 'in_app') RETURNING id, number`, [ws.id, u, email, subject])).rows[0] as { id: string; number: number };
}
const messages = async (id: string) => (await t.owner.query(`SELECT author_kind, internal, body FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at`, [id])).rows as { author_kind: string; internal: boolean; body: string }[];
const status = async (id: string) => (await t.owner.query(`SELECT status FROM support_tickets WHERE id = $1`, [id])).rows[0].status as string;

let k1: { id: string; number: number };
let k2: { id: string; number: number };
let k3: { id: string; number: number };
let linkId: string;

beforeAll(async () => {
  fmServer = createServer(fmApi);
  await new Promise<void>((r) => fmServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fmServer.address() as AddressInfo).port}`;
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  a = await customer(t, 'orbit-demo');
  b = await customer(t, 'kanit-demo');
  k1 = await ticket(a, 'นำเข้า Excel แล้ว Sub-task หายบางส่วน', 'ops@orbit-demo.example.com');
  k2 = await ticket(b, 'อัปเดตแผนแล้วงานย่อยกลายเป็นงานหลัก', 'lead@kanit-demo.example.com');
  k3 = await ticket(b, 'ไอคอนบางจุดมองไม่เห็นในโหมดมืด', 'lead@kanit-demo.example.com');
  // ลงทะเบียน Security key 4 คน + ล้างตาราง ใช้เวลานานเมื่อเครื่องทำงานหนัก
}, 60_000);
afterAll(async () => {
  await t?.close();
  await new Promise((r) => fmServer.close(r));
});

describe('ตั้งค่าการเชื่อมต่อ (T11)', () => {
  it('ยังไม่ตั้งค่า: ส่งต่อแบบสร้างงานได้ 409 · การเงินไม่เห็นหน้านี้', async () => {
    const r = await support.agent.post(`/ops/dev-bridge/tickets/${k1.id}/escalate`).send({ mode: 'create', severity: 'S2', title: 'นำเข้าโหมดอัปเดต: Sub-task หาย', steps: '1. นำเข้าไฟล์ตัวอย่าง 2. ดูหน้าพรีวิว' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('bridge_not_configured');
    expect((await finance.agent.get('/ops/dev-bridge/overview')).status).toBe(403);
    expect((await support.agent.get('/ops/dev-bridge/settings')).body).toMatchObject({ configured: false, canEdit: false });
  });

  it('เปลี่ยน token ต้องแตะ Security key · เก็บแบบเข้ารหัส ไม่ตอบ token กลับ · Support แก้ไม่ได้ · ทดสอบผ่านพร้อมสร้าง Label', async () => {
    const body = { apiBaseUrl: base, workspaceSlug: 'friday-dev', projectKey: 'fm', token: TOKEN, webhookSecret: SECRET, tokenExpiresAt: '2027-11-09' };
    const no = await engineer.agent.put('/ops/dev-bridge/settings').send(body);
    expect(no.status).toBe(401);
    expect(no.body.error.code).toBe('reauth_required');
    expect((await support.agent.put('/ops/dev-bridge/settings').send(body)).status).toBe(403);
    await reauth(engineer);
    const r = await engineer.agent.put('/ops/dev-bridge/settings').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ configured: true, projectKey: 'FM', tokenHint: '…_000', hasWebhookSecret: true, canEdit: true });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    const row = (await t.owner.query(`SELECT token_enc, webhook_secret_enc FROM dev_bridge_settings`)).rows[0];
    expect(row.token_enc).not.toContain(TOKEN);
    expect(row.webhook_secret_enc).not.toContain(SECRET);
    // แก้อย่างอื่นโดยไม่เปลี่ยน token ไม่ต้องแตะกุญแจ
    expect((await owner.agent.put('/ops/dev-bridge/settings').send({ apiBaseUrl: base, workspaceSlug: 'friday-dev', projectKey: 'FM' })).status).toBe(200);
    const test = await engineer.agent.post('/ops/dev-bridge/settings/test');
    expect(test.body.ok, JSON.stringify(test.body)).toBe(true);
    expect(test.body.checks.map((c: { key: string }) => c.key)).toEqual(['token', 'project', 'released', 'label']);
    expect(fake.labels).toEqual([{ id: 'lb1', name: 'from-support' }]);
    expect((await t.owner.query(`SELECT action FROM staff_audit_logs WHERE action LIKE 'dev_bridge.%' ORDER BY created_at`)).rows.map((x) => x.action)).toEqual(['dev_bridge.settings_updated', 'dev_bridge.settings_updated', 'dev_bridge.tested']);
  });
});

describe('ส่งต่อทีมพัฒนา (T3) · ผูกงานเดิม (T7) · การ์ด T8', () => {
  it('สร้างงาน Bug ใหม่: ป้าย from-support · Priority ตามความรุนแรง · คำอธิบายมีแค่เลข Ticket และรหัส Workspace · Ticket เป็นรอทีมพัฒนา', async () => {
    const r = await support.agent.post(`/ops/dev-bridge/tickets/${k1.id}/escalate`).send({ mode: 'create', severity: 'S2', title: 'นำเข้าโหมดอัปเดต: Sub-task หายเมื่อ Parent Key ว่าง', steps: '1. นำเข้า plan-oct.xlsx โหมดอัปเดต 2. แถวที่ Parent Key ว่างกลายเป็น Task', expected: 'เตือนในหน้าพรีวิว', requestId: 'req_44a1f0', affected: '1 ราย · Team S' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    linkId = r.body.link.id;
    expect(r.body.link).toMatchObject({ issueKey: 'FM-482', severity: 'S2', statusName: 'To do', unnotified: 1 });
    const created = fake.created[0] as { type: string; priority: string; labelIds: string[]; description: string };
    expect(created).toMatchObject({ type: 'Bug', priority: 'high', labelIds: ['lb1'] });
    expect(created.description).toContain(`Ticket #${k1.number} (ws_${a.id.replace(/-/g, '').slice(-4)})`);
    expect(created.description).toContain('req_44a1f0');
    expect(created.description).not.toContain('orbit-demo');
    expect(created.description).not.toContain('@');
    expect(await status(k1.id)).toBe('pending_dev');
    const msgs = await messages(k1.id);
    expect(msgs.find((m) => m.internal)?.body).toContain('งาน FM-482');
    expect(msgs.some((m) => m.author_kind === 'system' && !m.internal)).toBe(true);
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = 'dev.issue_created'`, [a.id])).rows).toHaveLength(1);
  });

  it('งานที่อาจซ้ำจากหัวข้อ (similar) · ผูก Ticket ใหม่กับงานเดิม → เพิ่มคอมเมนต์ในงาน ไม่สร้างงานซ้ำ', async () => {
    const sim = await support.agent.get(`/ops/dev-bridge/issues?q=${encodeURIComponent('นำเข้าโหมดอัปเดต Sub-task หายไป')}&similar=1`);
    expect(sim.status).toBe(200);
    expect(sim.body.items).toEqual([expect.objectContaining({ key: 'FM-482', linkedTickets: 1, status: { name: 'To do', category: 'todo' } })]);
    expect((await engineer.agent.get('/ops/dev-bridge/issues?q=FM-482')).body.items.map((i: { key: string }) => i.key)).toEqual(['FM-482']);
    const r = await support.agent.post(`/ops/dev-bridge/tickets/${k2.id}/escalate`).send({ mode: 'link', issueKey: 'fm-482', severity: 'S2', steps: 'อัปเดตแผนแล้วงานย่อยหลุดจากงานแม่' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fake.created).toHaveLength(1);
    expect(fake.comments.at(-1)).toMatchObject({ key: 'FM-482', body: expect.stringContaining(`Ticket #${k2.number}`) });
    const card = await support.agent.get(`/ops/dev-bridge/tickets/${k2.id}`);
    expect(card.body.link.tickets.map((x: { number: number }) => x.number)).toEqual([k1.number, k2.number]);
    expect(card.body.link.url).toContain('/work/friday-dev/p/FM?issue=FM-482');
    expect((await engineer.agent.post(`/ops/dev-bridge/tickets/${k3.id}/escalate`).send({ mode: 'link', issueKey: 'FM-482', severity: 'S4', steps: 'ทดสอบสิทธิ์วิศวกร' })).status).toBe(403);
    expect((await support.agent.post(`/ops/dev-bridge/tickets/${k3.id}/escalate`).send({ mode: 'link', issueKey: 'FM-999', severity: 'S4', steps: 'งานที่ไม่มีอยู่จริง' })).status).toBe(404);
    expect(await status(k3.id)).toBe('open');
  });

  it('Webhook: ลายเซ็นผิด 401 · ถูกต้อง → ดึงสถานะจริง · บันทึกภายในทุก Ticket · ผู้รับผิดชอบ / Sprint', async () => {
    fake.issues.get('FM-482')!.assigneeIds = ['u-dev-a'];
    fake.issues.get('FM-482')!.sprintId = 'sp24';
    setStatus('FM-482', 'In progress');
    expect((await webhook({ event: 'issue.status_changed', url: 'x?issue=FM-482' }, 'wrong-secret-0000000000')).status).toBe(401);
    expect((await webhook({ event: 'issue.status_changed', url: 'x?issue=FM-482' }, SECRET, Math.floor(Date.now() / 1000) - 3600)).status).toBe(401);
    const r = await webhook({ event: 'issue.status_changed', workspace: 'friday-dev', project: 'Friday Manage', title: 'FM-482 นำเข้าโหมดอัปเดต', url: 'http://app/work/friday-dev/p/FM?issue=FM-482' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, synced: 1 });
    const card = (await support.agent.get(`/ops/dev-bridge/tickets/${k1.id}`)).body.link;
    expect(card).toMatchObject({ statusName: 'In progress', statusCategory: 'in_progress', assigneeName: 'Dev A', sprintName: 'Sprint 24' });
    for (const k of [k1, k2]) expect((await messages(k.id)).some((m) => m.internal && m.body.includes('FM-482 เปลี่ยนเป็น In progress'))).toBe(true);
    expect((await support.agent.get('/ops/dev-bridge/settings')).body.lastWebhookAt).toBeTruthy();
  });

  it('Released (หมวด Done) จากการดึงสำรอง 15 นาที → แถบรอแจ้งในหน้า 20 · แจ้งหัวหน้าทีม', async () => {
    setStatus('FM-482', 'Released');
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    expect((await t.app.get(DevBridgeService).poll()).synced).toBe(1);
    expect(mail.sent.slice(before).some((m) => m.subject.includes('[FM-482] ขึ้น production แล้ว'))).toBe(true);
    const o = await engineer.agent.get('/ops/dev-bridge/overview');
    expect(o.status).toBe(200);
    expect(o.body.released).toEqual([expect.objectContaining({ issueKey: 'FM-482', tickets: 2 })]);
    expect(o.body.kpi).toMatchObject({ toNotify: 2, ticketsWaiting: 2, workspaces: 2 });
    expect(o.body.canNotify).toBe(false);
    const toNotify = await engineer.agent.get('/ops/dev-bridge/links?filter=to_notify');
    expect(toNotify.body.items).toEqual([expect.objectContaining({ issueKey: 'FM-482', unnotified: 2, workspaces: expect.arrayContaining(['Co orbit-demo', 'Co kanit-demo']) })]);
    // วิศวกรไม่เห็นอีเมลลูกค้า
    expect(JSON.stringify(toNotify.body)).not.toContain('@');
    expect((await engineer.agent.get(`/ops/dev-bridge/links/${linkId}/notify`)).status).toBe(403);
  });

  it('แจ้งลูกค้าว่าแก้แล้ว (T9): ทุก Ticket ที่ผูก · ตัวแปรในข้อความ · แก้แล้ว · อีเมล T13 · ร่าง Changelog · แจ้งซ้ำไม่ได้', async () => {
    const pre = await support.agent.get(`/ops/dev-bridge/links/${linkId}/notify`);
    expect(pre.body.tickets.map((x: { email: string }) => x.email)).toEqual(['ops@orbit-demo.example.com', 'lead@kanit-demo.example.com']);
    expect(pre.body.message).toContain('{ชื่อผู้แจ้ง}');
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    const r = await support.agent.post(`/ops/dev-bridge/links/${linkId}/notify`).send({ message: 'สวัสดีครับ คุณ{ชื่อผู้แจ้ง} ปัญหาใน #{เลข Ticket} แก้แล้วครับ', solve: true, csat: true, changelog: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ notified: 2, emailed: 2 });
    expect(r.body.changelogId).toBeTruthy();
    expect(await status(k1.id)).toBe('solved');
    const reply = (await messages(k1.id)).find((m) => m.author_kind === 'staff' && !m.internal);
    expect(reply?.body).toBe(`สวัสดีครับ คุณops ปัญหาใน #${k1.number} แก้แล้วครับ`);
    const sent = mail.sent.slice(before);
    expect(sent.map((m) => m.to)).toEqual(['ops@orbit-demo.example.com', 'lead@kanit-demo.example.com']);
    expect(sent[0].subject).toBe(`[#${k1.number}] แก้แล้ว: นำเข้า Excel แล้ว Sub-task หายบางส่วน`);
    expect(sent[0].text).toContain('/work/orbit-demo/help/tickets?ticket=');
    expect((await t.owner.query(`SELECT kind, status, dev_issue_link_id FROM changelog_entries`)).rows).toEqual([{ kind: 'fixed', status: 'draft', dev_issue_link_id: linkId }]);
    expect((await t.owner.query(`SELECT outcome FROM dev_issue_tickets WHERE link_id = $1`, [linkId])).rows.every((x) => x.outcome === 'fixed')).toBe(true);
    expect((await support.agent.post(`/ops/dev-bridge/links/${linkId}/notify`).send({ message: 'ส่งซ้ำอีกครั้งไม่ควรได้' })).status).toBe(409);
    expect((await t.owner.query(`SELECT action FROM audit_logs WHERE action = 'dev.customer_notified'`)).rows).toHaveLength(2);
  });

  it('ไม่แก้ / ซ้ำ (T10): แจ้งทางเลี่ยง → รอคุณตอบ · ผูกไปงานที่แก้แล้ว · คืนให้ Support · ยกเลิกการผูก', async () => {
    fake.issues.set('FM-466', { key: 'FM-466', title: 'ไอคอนโหมดมืดเดิม', description: '', status: fake.statuses[3], priority: 'low', planEnd: null, sprintId: null, assigneeIds: [] });
    const esc = await support.agent.post(`/ops/dev-bridge/tickets/${k3.id}/escalate`).send({ mode: 'create', severity: 'S4', title: 'ไอคอนบางจุดมองไม่เห็นในโหมดมืด', steps: 'เปิดโหมดมืดแล้วดูแถบเครื่องมือ' });
    const key = esc.body.link.issueKey as string;
    fake.issues.get(key)!.description += '\nซ้ำกับ FM-466';
    setStatus(key, 'Duplicate');
    const mail = t.app.get(Mailer);
    const before = mail.sent.length;
    await t.app.get(DevBridgeService).poll();
    expect(mail.sent.slice(before).some((m) => m.subject.includes(`[${key}] ทีมพัฒนาปิดแบบซ้ำ`))).toBe(true);
    const nf = (await support.agent.get('/ops/dev-bridge/links?filter=not_fixed')).body.items;
    expect(nf).toEqual([expect.objectContaining({ issueKey: key, resolution: 'duplicate', duplicateOfKey: 'FM-466' })]);
    // ผูกไปงานที่แก้แล้ว → Ticket ย้ายไปรอแจ้งในงาน FM-466
    const mv = await support.agent.post(`/ops/dev-bridge/links/${esc.body.link.id}/resolve`).send({ action: 'link_fixed', targetKey: 'FM-466' });
    expect(mv.body).toMatchObject({ moved: 1, issueKey: 'FM-466' });
    expect((await support.agent.get(`/ops/dev-bridge/tickets/${k3.id}`)).body.link.issueKey).toBe('FM-466');
    // แจ้งพร้อมทางเลี่ยง → รอคุณตอบ
    const w = await support.agent.post(`/ops/dev-bridge/links/${mv.body.linkId}/resolve`).send({ action: 'workaround', message: 'ระหว่างนี้รีเฟรชหน้าเว็บ (Ctrl + Shift + R) แล้วจะเห็นไอคอน' });
    expect(w.body).toMatchObject({ notified: 1 });
    expect(await status(k3.id)).toBe('pending_customer');
    expect((await t.owner.query(`SELECT outcome FROM dev_issue_tickets WHERE ticket_id = $1`, [k3.id])).rows[0].outcome).toBe('workaround');
    // คืนให้ Support และยกเลิกการผูก
    const k4 = await ticket(a, 'ปุ่มส่งออกไม่ตอบสนอง', 'ops@orbit-demo.example.com');
    const e4 = await support.agent.post(`/ops/dev-bridge/tickets/${k4.id}/escalate`).send({ mode: 'create', severity: 'S3', title: 'ปุ่มส่งออกไม่ตอบสนองบางเบราว์เซอร์', steps: 'กดปุ่มส่งออกใน Safari' });
    setStatus(e4.body.link.issueKey, "Won't fix");
    await t.app.get(DevBridgeService).poll();
    const ret = await support.agent.post(`/ops/dev-bridge/links/${e4.body.link.id}/resolve`).send({ action: 'return', note: 'ทีมพัฒนาทำซ้ำไม่ได้' });
    expect(ret.body).toEqual({ returned: 1 });
    expect(await status(k4.id)).toBe('open');
    const k5 = await ticket(b, 'หน้า Gantt โหลดช้า', 'lead@kanit-demo.example.com');
    await support.agent.post(`/ops/dev-bridge/tickets/${k5.id}/escalate`).send({ mode: 'link', issueKey: 'FM-466', severity: 'S3', steps: 'เปิด Gantt ที่มี 500 งาน' });
    expect((await support.agent.delete(`/ops/dev-bridge/tickets/${k5.id}/link`)).body).toEqual({ ticketId: k5.id, linked: false });
    expect(await status(k5.id)).toBe('open');
    expect((await support.agent.get(`/ops/dev-bridge/tickets/${k5.id}`)).body.link).toBeNull();
  });

  it('token ถูกยกเลิกใน FM: แจ้งให้ตรวจการตั้งค่า ไม่ทำให้ Ticket เปลี่ยน', async () => {
    await reauth(owner);
    await owner.agent.put('/ops/dev-bridge/settings').send({ apiBaseUrl: base, workspaceSlug: 'friday-dev', projectKey: 'FM', token: 'fmt_revoked_token_sample_0000' });
    const k6 = await ticket(a, 'ทดสอบ token ผิด', 'ops@orbit-demo.example.com');
    const r = await support.agent.post(`/ops/dev-bridge/tickets/${k6.id}/escalate`).send({ mode: 'create', severity: 'S3', title: 'ทดสอบ token ที่ถูกยกเลิก', steps: 'ส่งต่อด้วย token ที่ยกเลิกแล้ว' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('fm_token_rejected');
    expect(await status(k6.id)).toBe('open');
    expect(fake.authHeaders.every((h) => h.startsWith('Bearer fmt_'))).toBe(true);
  });
});
