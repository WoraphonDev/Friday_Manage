// A17 · Realtime (WebSocket) · ใช้ client `ws` จริงกับเซิร์ฟเวอร์ที่ listen บนพอร์ตสุ่ม · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SessionService } from '../src/auth/sessions.js';
import { Notifier } from '../src/notifications/notifier.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

process.env.REALTIME_POLL_MS = '150';
let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let port: number;
let wsId: string;
let projectId: string;
let moduleId: string;
let rt: RealtimeService;
let guestId: string;
let outsiderId: string;
const open: Wire[] = [];

type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class Wire {
  readonly messages: Msg[] = [];
  closed: { code: number } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
    ws.on('close', (code) => (this.closed = { code }));
    open.push(this);
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timeout waiting for message · got ${JSON.stringify(this.messages)}`);
  }
  /** ไม่ควรมีข้อความที่ตรงเงื่อนไขภายในช่วงที่รอ */
  async expectNone(pred: (m: Msg) => boolean, ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.messages.filter(pred)).toEqual([]);
  }
  async request(m: Msg) {
    const id = randomUUID();
    this.send({ ...m, id });
    return this.waitFor((x) => x.id === id);
  }
  close() {
    this.ws.close();
  }
}

async function session(userId: string) {
  const s = await t.app.get(SessionService).create(userId, { remember: false });
  return { cookie: `fm_session=${s.token}`, sessionId: s.sessionId };
}
async function connect(userId: string, opts: { cookie?: string; origin?: string; path?: string } = {}): Promise<Wire> {
  const cookie = opts.cookie ?? (await session(userId)).cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/realtime'}`, { headers: { cookie, ...(opts.origin ? { origin: opts.origin } : {}) } });
  const wire = new Wire(ws);
  await new Promise<void>((ok, fail) => {
    ws.once('open', () => ok());
    ws.once('unexpected-response', (_req, res) => fail(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', fail);
  });
  await wire.waitFor((m) => m.op === 'ready');
  return wire;
}
const rejected = (userId: string | null, opts: { cookie?: string; origin?: string; path?: string } = {}) =>
  (userId ? connect(userId, opts) : connect('x', { cookie: 'fm_session=bad', ...opts })).then(() => 0, (e: { status?: number }) => e.status ?? -1);

beforeAll(async () => {
  t = await startApp();
  await t.app.listen(0);
  port = (t.app.getHttpServer().address() as AddressInfo).port;
  team = await seedTeam(t);
  rt = t.app.get(RealtimeService);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  const guest = await client(t.app);
  guestId = await signup(guest, 'guest@rt.example.com', 'Guest');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
  const outsider = await client(t.app);
  outsiderId = await signup(outsider, 'outsider@rt.example.com', 'Outsider');
});
afterAll(async () => {
  open.forEach((w) => w.ws.terminate());
  await t.close();
});

async function issue(title: string, extra: Record<string, unknown> = {}, c: Client = team.lead) {
  const r = await c.post(`${team.ws}/projects/${team.key}/issues`, { title, moduleId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; key: string; version: number };
}

describe('เชื่อมต่อ', () => {
  it('ยืนยันตัวตนด้วยคุกกี้ session ตอน upgrade: ไม่มี / ผิด → 401 · เส้นทางที่ไม่ใช่ /realtime ไม่รับ', async () => {
    expect(await rejected(null)).toBe(401);
    expect(await rejected(team.leadId, { cookie: '' })).toBe(401);
    const w = await connect(team.leadId);
    expect(w.messages[0]).toEqual({ op: 'ready', userId: team.leadId });
    const alt = await connect(team.devId, { path: '/api/v1/realtime' });
    expect(alt.messages[0]).toMatchObject({ op: 'ready', userId: team.devId });
    expect(rt.connections).toBeGreaterThanOrEqual(2);
  });

  it('ตรวจ Origin (กัน Cross-Site WebSocket Hijacking): Origin แปลก → 403 · Origin ของเว็บเราและ client ที่ไม่ส่ง Origin ผ่าน', async () => {
    expect(await rejected(team.leadId, { origin: 'https://evil.example.com' })).toBe(403);
    expect(await rejected(team.leadId, { origin: 'http://localhost:3000.evil.com' })).toBe(403);
    const ok = await connect(team.leadId, { origin: 'http://localhost:3000' });
    expect(ok.messages[0].op).toBe('ready');
    process.env.REALTIME_ALLOWED_ORIGINS = 'https://app.friday.test';
    expect((await connect(team.leadId, { origin: 'https://app.friday.test' })).messages[0].op).toBe('ready');
    delete process.env.REALTIME_ALLOWED_ORIGINS;
  });

  it('ping/pong · ข้อความผิดรูปแบบ · op ที่ไม่รู้จัก ไม่ทำให้การเชื่อมต่อหลุด', async () => {
    const w = await connect(team.leadId);
    expect(await w.request({ op: 'ping' })).toMatchObject({ op: 'pong' });
    w.ws.send('not json');
    await w.waitFor((m) => m.code === 'invalid_message');
    expect(await w.request({ op: 'explode' })).toMatchObject({ op: 'error', code: 'unknown_op' });
    expect(w.closed).toBeNull();
  });

  it('JSON ที่ไม่ใช่ object (null · array · ตัวเลข · ข้อความ) และ cookie encode ผิด ไม่ทำให้เกิด unhandled rejection (BUG-02)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const w = await connect(team.leadId);
      for (const raw of ['null', '[]', '[1,2]', '42', '"subscribe"', 'true']) {
        w.messages.length = 0;
        w.ws.send(raw);
        expect(await w.waitFor((m) => m.code === 'invalid_message')).toMatchObject({ op: 'error' });
      }
      // cookie ผิดรูปแบบไม่ต้องมี session ที่ถูกต้อง → ต้องได้ 401 ไม่ใช่โปรเซสล่ม
      expect(await rejected(null, { cookie: 'fm_session=%' })).toBe(401);
      expect(await rejected(null, { cookie: 'fm_session=%E0%A4%A' })).toBe(401);
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
      // การเชื่อมต่อเดิมและการเชื่อมต่อใหม่ยังใช้ได้
      expect(await w.request({ op: 'ping' })).toMatchObject({ op: 'pong' });
      expect(w.closed).toBeNull();
      expect((await connect(team.devId)).messages[0].op).toBe('ready');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('ฐานข้อมูลล้มระหว่าง subscribe / poll / recheck ไม่ทำให้เกิด unhandled rejection (BUG-02)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const svc = rt as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const orig = { authorize: svc.authorize, sendUnread: svc.sendUnread };
    try {
      const w = await connect(team.leadId);
      svc.authorize = async () => {
        throw new Error('db down (ทดสอบ)');
      };
      expect(await w.request({ op: 'subscribe', channel: `project:${projectId}` })).toMatchObject({ op: 'error', code: 'forbidden' });
      svc.authorize = orig.authorize;
      await w.request({ op: 'subscribe', channel: `user:${team.leadId}` });
      svc.sendUnread = async () => {
        throw new Error('db down (ทดสอบ)');
      };
      await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason) VALUES ($1,$2,'issue.mentioned','{}','db ล้ม')`, [wsId, team.leadId]);
      await new Promise((r) => setTimeout(r, 500));
      expect(unhandled).toEqual([]);
      expect(await w.request({ op: 'ping' })).toMatchObject({ op: 'pong' });
    } finally {
      svc.authorize = orig.authorize;
      svc.sendUnread = orig.sendUnread;
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('subscribe · ตรวจสิทธิ์ทุกช่อง', () => {
  it('user:{id} ได้เฉพาะของตัวเอง · ชื่อช่องผิดรูปแบบ / ไม่มี → ปฏิเสธ', async () => {
    const w = await connect(team.leadId);
    expect(await w.request({ op: 'subscribe', channel: `user:${team.leadId}` })).toMatchObject({ op: 'subscribed', channel: `user:${team.leadId}` });
    expect(await w.request({ op: 'subscribe', channel: `user:${team.devId}` })).toMatchObject({ op: 'error', code: 'forbidden' });
    for (const bad of ['', 'user', 'user:abc', 'team:' + randomUUID(), `project:${'z'.repeat(36)}`]) {
      expect(await w.request({ op: 'subscribe', channel: bad }), bad).toMatchObject({ op: 'error', code: 'invalid_channel' });
    }
    expect(await w.request({ op: 'subscribe', channel: `project:${randomUUID()}` })).toMatchObject({ op: 'error', code: 'forbidden' });
  });

  it('project:{id}: สมาชิกได้ · คนนอก Workspace / โปรเจกต์ Private ที่ไม่ได้เป็นสมาชิก / Guest Viewer ไม่ได้', async () => {
    const lead = await connect(team.leadId);
    const dev = await connect(team.devId);
    const out = await connect(outsiderId);
    const guest = await connect(guestId);
    const ch = `project:${projectId}`;
    expect(await lead.request({ op: 'subscribe', channel: ch })).toMatchObject({ op: 'subscribed' });
    expect(await dev.request({ op: 'subscribe', channel: ch })).toMatchObject({ op: 'subscribed' });
    expect(await out.request({ op: 'subscribe', channel: ch })).toMatchObject({ op: 'error', code: 'forbidden' });
    expect(await guest.request({ op: 'subscribe', channel: ch })).toMatchObject({ op: 'error', code: 'forbidden' });

    const r = await team.lead.post(`${team.ws}/projects`, { key: 'RT2', name: 'Private', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null, visibility: 'private' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const priv = (await t.owner.query(`SELECT id FROM projects WHERE key = 'RT2'`)).rows[0].id;
    expect(await lead.request({ op: 'subscribe', channel: `project:${priv}` })).toMatchObject({ op: 'subscribed' });
    expect(await dev.request({ op: 'subscribe', channel: `project:${priv}` })).toMatchObject({ op: 'error', code: 'forbidden' });
  });

  it('issue:{id}: Guest Viewer ได้เฉพาะงานที่แชร์ (ไม่ใช่ Bug)', async () => {
    const shared = await issue('งานที่แชร์', { sharedWithGuests: true });
    const hidden = await issue('งานภายใน');
    const guest = await connect(guestId);
    expect(await guest.request({ op: 'subscribe', channel: `issue:${shared.id}` })).toMatchObject({ op: 'subscribed' });
    expect(await guest.request({ op: 'subscribe', channel: `issue:${hidden.id}` })).toMatchObject({ op: 'error', code: 'forbidden' });
    await t.owner.query(`UPDATE issues SET issue_type_id = (SELECT id FROM issue_types WHERE project_id = $2 AND name = 'Bug') WHERE id = $1`, [shared.id, projectId]);
    expect(await guest.request({ op: 'subscribe', channel: `issue:${shared.id}` })).toMatchObject({ op: 'subscribed' }); // subscribe เดิมยังค้าง
    const g2 = await connect(guestId);
    expect(await g2.request({ op: 'subscribe', channel: `issue:${shared.id}` })).toMatchObject({ op: 'error', code: 'forbidden' });
  });

  it('import:{jobId}: เฉพาะผู้สร้างงานนำเข้า · publish() ส่งความคืบหน้า', async () => {
    const job = await t.owner.query(`INSERT INTO import_jobs (workspace_id, mode, file_name, storage_key, created_by) VALUES ($1,'create','plan.xlsx','k',$2) RETURNING id`, [wsId, team.leadId]);
    const lead = await connect(team.leadId);
    const dev = await connect(team.devId);
    const ch = `import:${job.rows[0].id}`;
    expect(await dev.request({ op: 'subscribe', channel: ch })).toMatchObject({ op: 'error', code: 'forbidden' });
    expect(await lead.request({ op: 'subscribe', channel: ch })).toMatchObject({ op: 'subscribed' });
    rt.publish(ch as `import:${string}`, { type: 'import.progress', done: 120, total: 334 });
    expect(await lead.waitFor((m) => m.type === 'import.progress')).toMatchObject({ channel: ch, done: 120, total: 334 });
    await dev.expectNone((m) => m.type === 'import.progress');
  });

  it('จำกัด 50 ช่องต่อการเชื่อมต่อ · subscribe ซ้ำไม่นับเพิ่ม', async () => {
    const w = await connect(team.leadId);
    expect(await w.request({ op: 'subscribe', channel: `user:${team.leadId}` })).toMatchObject({ op: 'subscribed' });
    expect(await w.request({ op: 'subscribe', channel: `user:${team.leadId}` })).toMatchObject({ op: 'subscribed' });
    const ids: string[] = [];
    for (let i = 0; i < 49; i++) ids.push((await issue(`ช่อง ${i}`, {}, team.lead)).id);
    for (const id of ids) expect(await w.request({ op: 'subscribe', channel: `issue:${id}` })).toMatchObject({ op: 'subscribed' });
    const extra = await issue('ช่องที่ 51');
    expect(await w.request({ op: 'subscribe', channel: `issue:${extra.id}` })).toMatchObject({ op: 'error', code: 'too_many_subscriptions' });
  }, 60_000);
});

describe('สัญญาณงานเปลี่ยน', () => {
  it('แก้งาน → ช่องโปรเจกต์ได้ { type, issueKey, id, version } · ช่องงานได้คอมเมนต์ · ยกเลิก subscribe แล้วเงียบ', async () => {
    const proj = await connect(team.leadId);
    const dev = await connect(team.devId);
    await proj.request({ op: 'subscribe', channel: `project:${projectId}` });
    const created = await issue('งานเรียลไทม์', {}, team.dev);
    const sig = await proj.waitFor((m) => m.type === 'issue.created' && m.issueKey === created.key);
    expect(sig).toMatchObject({ channel: `project:${projectId}`, id: created.id, version: created.version, actorId: team.devId });
    expect(Object.keys(sig).sort()).toEqual(['actorId', 'at', 'channel', 'id', 'issueKey', 'type', 'version']);

    const patched = await team.dev.patch(`${team.ws}/issues/${created.key}`, { priority: 'high' }, created.version);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const upd = await proj.waitFor((m) => m.type === 'issue.updated' && m.issueKey === created.key);
    expect(upd.version).toBeGreaterThan(created.version);

    await dev.request({ op: 'subscribe', channel: `issue:${created.id}` });
    const c = await team.lead.post(`${team.ws}/issues/${created.key}/comments`, { body: 'ทดสอบคอมเมนต์เรียลไทม์' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await dev.waitFor((m) => m.type === 'issue.commented')).toMatchObject({ channel: `issue:${created.id}`, issueKey: created.key, id: created.id });
    // คนที่ไม่ได้ subscribe ช่องงานไม่ได้รับ
    await proj.expectNone((m) => m.channel === `issue:${created.id}`);

    await proj.request({ op: 'unsubscribe', channel: `project:${projectId}` });
    proj.messages.length = 0;
    await issue('หลังยกเลิก subscribe');
    await proj.expectNone((m) => m.type === 'issue.created');
  });

  it('ข้อความเป็นสัญญาณล้วน ไม่มีชื่องาน ชื่อคน หรือข้อมูลที่ต้องตรวจสิทธิ์', async () => {
    const proj = await connect(team.leadId);
    await proj.request({ op: 'subscribe', channel: `project:${projectId}` });
    const secret = await issue('ชื่อลับ: งบประมาณธนาคาร');
    const sig = await proj.waitFor((m) => m.type === 'issue.created' && m.issueKey === secret.key);
    expect(JSON.stringify(sig)).not.toContain('ลับ');
    expect(JSON.stringify(sig)).not.toContain('Mick');
  });
});

describe('presence (ใคร กำลังดู / พิมพ์)', () => {
  it('subscribe ช่องงานได้รายชื่อคนที่อยู่แล้ว · สถานะพิมพ์ถึงคนอื่นไม่ถึงตัวเอง · ออกแล้วแจ้ง left', async () => {
    const a = await issue('ห้อง presence');
    const lead = await connect(team.leadId);
    const dev = await connect(team.devId);
    const ch = `issue:${a.id}`;
    expect((await lead.request({ op: 'subscribe', channel: ch })).op).toBe('subscribed');
    expect(await lead.waitFor((m) => m.op === 'presence_list')).toMatchObject({ channel: ch, users: [] });
    await dev.request({ op: 'subscribe', channel: ch });
    expect(await dev.waitFor((m) => m.op === 'presence_list')).toMatchObject({ users: [{ userId: team.leadId, state: 'viewing' }] });

    lead.send({ op: 'presence', channel: ch, state: 'typing' });
    expect(await dev.waitFor((m) => m.type === 'presence' && m.state === 'typing')).toMatchObject({ channel: ch, userId: team.leadId });
    await lead.expectNone((m) => m.type === 'presence');
    dev.close();
    expect(await lead.waitFor((m) => m.type === 'presence' && m.state === 'left')).toMatchObject({ userId: team.devId });
  });

  it('state ผิด / ไม่ได้ subscribe / ช่องที่ไม่ใช่งาน → error · ส่งถี่เกิน 10 ครั้ง/วินาทีถูกตัด', async () => {
    const a = await issue('presence rate');
    const lead = await connect(team.leadId);
    const dev = await connect(team.devId);
    const ch = `issue:${a.id}`;
    expect(await lead.request({ op: 'presence', channel: ch, state: 'typing' })).toMatchObject({ code: 'not_subscribed' });
    await lead.request({ op: 'subscribe', channel: ch });
    await dev.request({ op: 'subscribe', channel: ch });
    expect(await lead.request({ op: 'presence', channel: ch, state: 'dancing' })).toMatchObject({ code: 'invalid_message' });
    await lead.request({ op: 'subscribe', channel: `project:${projectId}` });
    expect(await lead.request({ op: 'presence', channel: `project:${projectId}`, state: 'typing' })).toMatchObject({ code: 'not_subscribed' });
    for (let i = 0; i < 15; i++) lead.send({ op: 'presence', channel: ch, state: i % 2 ? 'typing' : 'viewing' });
    await new Promise((r) => setTimeout(r, 400));
    expect(dev.messages.filter((m) => m.type === 'presence').length).toBe(10);
  });
});

describe('แจ้งเตือนใหม่ → user:{id}', () => {
  it('ได้จำนวนยังไม่อ่านแยกตาม Workspace · ครอบคลุมแจ้งเตือนที่เขียนตรงลงตารางด้วย', async () => {
    await t.owner.query('DELETE FROM notifications');
    const lead = await connect(team.leadId);
    await lead.request({ op: 'subscribe', channel: `user:${team.leadId}` });
    await t.app.get(Notifier).notify({ workspaceId: wsId, recipientIds: [team.leadId], eventType: 'issue.assigned', actorId: team.devId, payload: { issueKey: 'DP-1' }, reason: 'ทดสอบ' });
    const first = await lead.waitFor((m) => m.type === 'notification');
    expect(first).toMatchObject({ channel: `user:${team.leadId}`, unread: { total: 1, byWorkspace: { [wsId]: 1 } } });
    lead.messages.length = 0;
    await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason) VALUES ($1,$2,'issue.mentioned','{}','เขียนตรง')`, [wsId, team.leadId]);
    expect(await lead.waitFor((m) => m.type === 'notification')).toMatchObject({ unread: { total: 2, byWorkspace: { [wsId]: 2 } } });
    // อ่านแล้วไม่นับ
    lead.messages.length = 0;
    await t.owner.query(`UPDATE notifications SET read_at = now() WHERE event_type = 'issue.assigned'`);
    await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason) VALUES ($1,$2,'issue.commented','{}','อีกอัน')`, [wsId, team.leadId]);
    expect(await lead.waitFor((m) => m.type === 'notification')).toMatchObject({ unread: { total: 2 } });
  });

  it('ธุรกรรมที่เริ่มก่อนรอบ poll แต่ commit ทีหลังก็ยังส่ง (created_at = เวลาเริ่มธุรกรรม) · ไม่ส่งซ้ำ', async () => {
    const lead = await connect(team.leadId);
    await lead.request({ op: 'subscribe', channel: `user:${team.leadId}` });
    await t.owner.query('BEGIN');
    await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason) VALUES ($1,$2,'issue.mentioned','{}','ธุรกรรมยาว')`, [wsId, team.leadId]);
    // ให้ poll วิ่งผ่านไปหลายรอบระหว่างที่ธุรกรรมยังไม่ commit (cursor เลย created_at ไปแล้ว)
    await new Promise((r) => setTimeout(r, 600));
    await t.owner.query('COMMIT');
    await lead.waitFor((m) => m.type === 'notification');
    lead.messages.length = 0;
    await lead.expectNone((m) => m.type === 'notification', 600);
  });

  it('แจ้งเตือนของคนอื่นไม่ถึงเรา', async () => {
    const lead = await connect(team.leadId);
    await lead.request({ op: 'subscribe', channel: `user:${team.leadId}` });
    await t.app.get(Notifier).notify({ workspaceId: wsId, recipientIds: [team.devId], eventType: 'issue.assigned', actorId: team.leadId, payload: {}, reason: 'ของ dev' });
    await lead.expectNone((m) => m.type === 'notification', 600);
  });

  it('อ่าน / ยังไม่อ่าน / เสร็จ / เลื่อน / อ่านทั้งหมด → ทุก session ของผู้รับได้ { type: unread } (ไม่ใช่แจ้งเตือนใหม่) · ไม่ข้ามผู้รับ (UI-06)', async () => {
    await t.owner.query('DELETE FROM notifications');
    const insert = async (recipient: string) =>
      (await t.owner.query(`INSERT INTO notifications (workspace_id, recipient_id, event_type, payload, reason) VALUES ($1,$2,'issue.mentioned','{}','ทดสอบตัวนับ') RETURNING id`, [wsId, recipient])).rows[0].id as string;
    const [a, b, c] = [await insert(team.leadId), await insert(team.leadId), await insert(team.leadId)];
    await insert(team.devId);
    const tabs = [await connect(team.leadId), await connect(team.leadId)];
    for (const w of tabs) await w.request({ op: 'subscribe', channel: `user:${team.leadId}` });
    const dev = await connect(team.devId);
    await dev.request({ op: 'subscribe', channel: `user:${team.devId}` });
    const expectCount = async (total: number) => {
      for (const w of tabs) {
        expect(await w.waitFor((m) => m.type === 'unread')).toMatchObject({ channel: `user:${team.leadId}`, unread: { total, byWorkspace: total ? { [wsId]: total } : {} } });
        w.messages.length = 0;
      }
    };
    const steps: [string, object | undefined, number][] = [
      [`/me/notifications/${a}/read`, undefined, 2],
      [`/me/notifications/${a}/unread`, undefined, 3],
      [`/me/notifications/${b}/done`, undefined, 2],
      [`/me/notifications/${c}/snooze`, { preset: 'tomorrow' }, 1],
      ['/me/notifications/read-all', {}, 0],
    ];
    for (const [path, body, total] of steps) {
      expect((await team.lead.post(path, body)).status, path).toBeLessThan(300);
      await expectCount(total);
    }
    for (const w of tabs) await w.expectNone((m) => m.type === 'notification', 300);
    await dev.expectNone((m) => m.type === 'unread' || m.type === 'notification', 300);
  });
});

describe('ตรวจซ้ำสิทธิ์และ Session', () => {
  it('ถูกถอนสิทธิ์โปรเจกต์ → recheck ถอด subscription · Session ถูกยกเลิก → ปิดการเชื่อมต่อ', async () => {
    const member = await client(t.app);
    const memberId = await signup(member, 'temp-member@rt.example.com', 'Temp');
    await addMember(t.owner, team.slug, memberId, 'member', { key: team.key, role: 'member' });
    const s = await session(memberId);
    const w = await connect(memberId, { cookie: s.cookie });
    const ch = `project:${projectId}`;
    await w.request({ op: 'subscribe', channel: ch });
    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1`, [memberId]);
    await rt.recheck();
    expect(await w.waitFor((m) => m.op === 'unsubscribed' && m.reason === 'forbidden')).toMatchObject({ channel: ch });
    await issue('หลังถูกถอนสิทธิ์');
    await w.expectNone((m) => m.type === 'issue.created');

    await t.app.get(SessionService).revoke(s.sessionId);
    await rt.recheck();
    await w.waitFor(() => w.closed !== null, 2000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(w.closed?.code).toBe(4401);
  });
});
