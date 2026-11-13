// A44 · ศูนย์ช่วยเหลือ (บทความ ค้นหา โหวต) และ Ticket จากในแอปลูกค้า (X1–X6 · T12)
// บทความ / Ticket ฝั่งทีมเขียนโดย ops-api · test จำลองแถวด้วยบัญชีเจ้าของตาราง · ข้อมูลสมมติเท่านั้น
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Mailer } from '../src/core/mail.js';
import { HelpRateLimit } from '../src/help/rate-limit.js';
import { SupportRepliesJob } from '../src/help/replies.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

process.env.SMTP_HOST = 'smtp.test.example.com';
process.env.MAIL_FROM = 'Friday Work Management <notify@friday.test>';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let other: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let wsId: string;
let staffId: string;
const mails: Record<string, unknown>[] = [];
const anon = () => client(t.app);
const cat: Record<string, string> = {};

async function article(slug: string, o: { title: string; body: string; category?: string; status?: string; visibility?: string; routes?: string[]; keywords?: string; summary?: string }) {
  const published = (o.status ?? 'published') === 'published';
  const { rows } = await t.owner.query(
    `INSERT INTO help_articles (slug, category_id, title, summary, body, status, visibility, app_routes, keywords, version, published_at, pii_checked_at, draft)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12) RETURNING id`,
    [slug, cat[o.category ?? 'notifications'], o.title, o.summary ?? null, o.body, o.status ?? 'published', o.visibility ?? 'public', o.routes ?? [], o.keywords ?? null, published ? 1 : 0, published ? new Date() : null, JSON.stringify({ title: 'ร่างลับที่ยังไม่เผยแพร่' })],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  t = await startApp();
  t.app.get(Mailer).transportFactory = () => ({ sendMail: async (m: Record<string, unknown>) => void mails.push(m) });
  team = await seedTeam(t, { slug: 'orbit-demo' });
  other = await seedTeam(t, { slug: 'river-demo', key: 'RV' });
  guest = await client(t.app);
  const guestId = await signup(guest, 'guest@orbit-demo.example.com', 'Guest Sample');
  await addMember(t.owner, team.slug, guestId, 'guest');
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  staffId = (await t.owner.query(`INSERT INTO staff_users (email, name, roles) VALUES ('support-a@friday.test', 'Support A', '{support}') RETURNING id`)).rows[0].id;
  for (const [slug, name, pos] of [['getting-started', 'เริ่มต้นใช้งาน', 1], ['notifications', 'แจ้งเตือน LINE และอีเมล', 2], ['import-export', 'นำเข้า / ส่งออก Excel', 3]] as const) {
    cat[slug] = (await t.owner.query('INSERT INTO help_categories (slug, name, position) VALUES ($1, $2, $3) RETURNING id', [slug, name, pos])).rows[0].id;
  }
  await article('line-approve', { title: 'ผูก LINE เพื่อรับแจ้งเตือนและอนุมัติคำขอเลื่อน Due', body: '## ขั้นตอน\nหัวหน้าทีมกด **อนุมัติ** / ปฏิเสธ จากข้อความใน LINE ได้ทันที', routes: ['profile'] });
  await article('due-request', { title: 'ขอเลื่อน Due และใครเป็นผู้อนุมัติ', body: 'คำขอส่งถึง Project Owner หรือผู้ที่ได้รับสิทธิ์อนุมัติ', category: 'getting-started', routes: ['gantt'] });
  await article('import-excel-update', { title: 'นำเข้าแผนงานจาก Excel แบบอัปเดต', body: '## ก่อนเริ่ม\nใช้ไฟล์ที่ส่งออกจาก Friday Work Management\n## ขั้นตอน\nอัปโหลดไฟล์แล้วตรวจหน้าพรีวิว', category: 'import-export', keywords: 'xlsx, spreadsheet', routes: ['import', 'gantt'] });
  await article('internal-sso', { title: 'ตั้งค่า SSO สำหรับองค์กร', body: 'ขั้นตอนที่มีข้อมูลภายใน', visibility: 'signed_in', category: 'getting-started' });
  await article('draft-restore', { title: 'กู้คืนงานที่ลบผิด', body: 'ร่าง', status: 'draft', category: 'getting-started' });
});
afterAll(() => t.close());
beforeEach(() => t.app.get(HelpRateLimit).reset());

describe('บทความ (ไม่ต้องเข้าสู่ระบบ)', () => {
  it('หมวดนับเฉพาะบทความที่เผยแพร่และผู้อ่านเห็น · ร่างไม่หลุด', async () => {
    const pub = await (await anon()).get('/help/categories');
    expect(pub.status).toBe(200);
    const count = (body: { items: { slug: string; articles: number }[] }, slug: string) => body.items.find((c) => c.slug === slug)!.articles;
    expect(count(pub.body, 'getting-started')).toBe(1);
    const signedIn = await team.dev.get('/help/categories');
    expect(count(signedIn.body, 'getting-started')).toBe(2);
    const list = await (await anon()).get('/help/articles?limit=50');
    expect(list.body.items.map((a: { slug: string }) => a.slug).sort()).toEqual(['due-request', 'import-excel-update', 'line-approve']);
    expect(JSON.stringify(list.body)).not.toContain('ร่างลับ');
    expect(list.body.items[0]).not.toHaveProperty('keywords');
  });

  it('บทความเฉพาะผู้เข้าสู่ระบบ: คนที่ไม่ล็อกอินได้ 404 · ล็อกอินแล้วอ่านได้ · ร่าง 404 ทุกคน', async () => {
    expect((await (await anon()).get('/help/articles/internal-sso')).status).toBe(404);
    const r = await team.dev.get('/help/articles/internal-sso');
    expect(r.status).toBe(200);
    expect(r.body.article).toMatchObject({ slug: 'internal-sso', visibility: 'signed_in', body: 'ขั้นตอนที่มีข้อมูลภายใน' });
    expect((await team.lead.get('/help/articles/draft-restore')).status).toBe(404);
    expect((await (await anon()).get('/help/articles?category=getting-started')).body.items.map((a: { slug: string }) => a.slug)).toEqual(['due-request']);
  });

  it('ค้นภาษาไทยหลายคำ: ทุกคำต้องตรง · ข้อความตัวอย่าง · คำค้นเพิ่มของทีม (xlsx) · บันทึกสถิติโดยไม่เก็บผู้ค้น', async () => {
    const c = await anon();
    const r = await c.get(`/help/articles?q=${encodeURIComponent('อนุมัติ เลื่อน due')}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((a: { slug: string }) => a.slug).sort()).toEqual(['due-request', 'line-approve']);
    expect(r.body.terms).toEqual(['อนุมัติ', 'เลื่อน', 'due']);
    expect(r.body.partial).toBe(false);
    const xlsx = await c.get('/help/articles?q=XLSX');
    expect(xlsx.body.items.map((a: { slug: string }) => a.slug)).toEqual(['import-excel-update']);
    const miss = await c.get(`/help/articles?q=${encodeURIComponent('ลบ sprint ติดต่อ someone@example.com')}`);
    expect(miss.body).toMatchObject({ items: [], total: 0 });
    // พิมพ์ระหว่างกรอกฟอร์ม (suggest) ไม่นับเป็นการค้นหา
    await c.get(`/help/articles?q=${encodeURIComponent('ลบ sprint')}&suggest=1`);
    const stats = (await t.owner.query('SELECT searches, misses FROM help_search_stats')).rows[0];
    expect(stats).toEqual({ searches: 3, misses: 1 });
    const misses = (await t.owner.query('SELECT query, searches FROM help_search_misses')).rows;
    expect(misses).toEqual([{ query: 'ลบ sprint ติดต่อ', searches: 1 }]);
  });

  it('ค้นได้บางส่วน: ไม่มีบทความที่ตรงครบทุกคำ ใช้ที่ตรงอย่างน้อยครึ่งหนึ่ง (partial)', async () => {
    const r = await (await anon()).get(`/help/articles?q=${encodeURIComponent('excel ไม่มีคำนี้')}`);
    expect(r.body.items.map((a: { slug: string }) => a.slug)).toEqual(['import-excel-update']);
    expect(r.body.partial).toBe(true);
    expect(r.body.items[0].snippet).toContain('ก่อนเริ่ม');
  });

  it('แนะนำตามหน้า (X4): บทความที่ผูกหน้านั้น · หน้าที่ไม่มีบทความใช้ยอดนิยมแทน', async () => {
    const g = await team.dev.get('/help/articles?route=gantt');
    expect(g.body.items.map((a: { slug: string }) => a.slug).sort()).toEqual(['due-request', 'import-excel-update']);
    expect(g.body.fallback).toBe(false);
    const none = await team.dev.get('/help/articles?route=calendar&limit=2');
    expect(none.body).toMatchObject({ fallback: true });
    expect(none.body.items).toHaveLength(2);
    expect((await team.dev.get('/help/articles?route=../etc')).status).toBe(400);
  });

  it('หน้าบทความ: นับยอดอ่าน · บทความที่เกี่ยวข้องในหมวดเดียวกัน · ยอดนิยมเรียงตามยอดอ่าน', async () => {
    const c = await anon();
    for (let i = 0; i < 3; i++) await c.get('/help/articles/import-excel-update');
    const r = await c.get('/help/articles/due-request');
    expect(r.body.article).toMatchObject({ slug: 'due-request', category: { slug: 'getting-started' }, readMinutes: 1 });
    expect(r.body.related).toEqual([]);
    expect((await team.dev.get('/help/articles/due-request')).body.related.map((a: { slug: string }) => a.slug)).toEqual(['internal-sso']);
    const views = (await t.owner.query(`SELECT a.slug, v.views FROM help_article_views v JOIN help_articles a ON a.id = v.article_id ORDER BY a.slug`)).rows;
    expect(views).toContainEqual({ slug: 'import-excel-update', views: 3 });
    const popular = await c.get('/help/articles?sort=popular&limit=1');
    expect(popular.body.items[0].slug).toBe('import-excel-update');
    // track=0 ไม่นับ (หน้าตัวอย่าง / prefetch)
    await c.get('/help/articles/due-request?track=0');
    expect((await t.owner.query(`SELECT sum(views)::int AS n FROM help_article_views v JOIN help_articles a ON a.id = v.article_id WHERE a.slug = 'due-request'`)).rows[0].n).toBe(2);
  });

  it('โหวตช่วยได้ / ไม่ช่วย พร้อมความเห็น · ไม่เก็บผู้โหวต · บทความที่มองไม่เห็นโหวตไม่ได้', async () => {
    const c = await anon();
    expect((await c.post('/help/articles/line-approve:feedback', { helpful: false, comment: 'ยังไม่รู้ว่าต้องเชิญบอทเข้ากลุ่ม' })).status).toBe(200);
    expect((await c.post('/help/articles/line-approve/feedback', { helpful: true, comment: 'ไม่เก็บ' })).status).toBe(200);
    const rows = (await t.owner.query(`SELECT helpful, comment FROM help_feedback ORDER BY created_at`)).rows;
    expect(rows).toEqual([{ helpful: false, comment: 'ยังไม่รู้ว่าต้องเชิญบอทเข้ากลุ่ม' }, { helpful: true, comment: null }]);
    expect((await c.post('/help/articles/internal-sso:feedback', { helpful: true })).status).toBe(404);
    expect((await team.dev.post('/help/articles/internal-sso:feedback', { helpful: true })).status).toBe(200);
    expect((await c.post('/help/articles/draft-restore:feedback', { helpful: true })).status).toBe(404);
  });

  it('จำกัดอัตราเรียกต่อ IP: โหวตเกิน 20 ครั้งต่อนาทีได้ 429 พร้อม Retry-After', async () => {
    const c = await anon();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await c.post('/help/articles/line-approve:feedback', { helpful: true })).status;
    expect(last).toBe(429);
    const r = await c.post('/help/articles/line-approve:feedback', { helpful: true });
    expect(r.headers['retry-after']).toBeTruthy();
    expect(r.body.error.code).toBe('rate_limited');
    // อ่านยังได้ (นับแยก)
    expect((await c.get('/help/categories')).status).toBe(200);
  });
});

describe('Ticket จากในแอป', () => {
  let ticketId: string;

  it('Guest เปิด Ticket ไม่ได้ (ให้ถามผู้เชิญ) แต่อ่านศูนย์ช่วยเหลือได้', async () => {
    const r = await guest.post(`${team.ws}/support/tickets`, { subject: 'ขอสิทธิ์เพิ่ม', category: 'account', body: 'ทดสอบ' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('guest_cannot_contact_support');
    expect((await guest.get(`${team.ws}/support/tickets`)).body).toMatchObject({ items: [], canContact: false });
    expect((await guest.get('/help/articles/line-approve')).status).toBe(200);
  });

  it('เปิด Ticket: ช่องทาง in_app · SLA ตามแพ็กเกจ · ผลกระทบยกความสำคัญ · แนบหน้า + requestId + บทความ + ไฟล์ · อีเมลยืนยันพร้อมเลข', async () => {
    mails.length = 0;
    // ไฟล์แนบ: ขอลิงก์ → PUT → ส่ง uploadToken มากับ Ticket
    const u = await team.dev.post(`${team.ws}/support/attachments`, { name: 'screen.png', size: 5, mime: 'image/png' });
    expect(u.status).toBe(201);
    expect((await team.dev.post(`${team.ws}/support/attachments`, { name: 'big.mov', size: 11 * 1024 * 1024, mime: 'video/quicktime' })).status).toBe(413);
    expect((await request(t.app.getHttpServer()).put(new URL(u.body.url).pathname).set('content-type', 'application/octet-stream').send(Buffer.from('12345'))).status).toBeLessThan(300);
    const before = (await t.owner.query('SELECT tickets FROM help_search_misses')).rows[0].tickets;
    const r = await team.dev.post(`${team.ws}/support/tickets`, {
      subject: 'LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์',
      category: 'notification',
      impact: 'team',
      body: 'ตั้งแต่เมื่อวานกลุ่ม LINE ทีมตัวอย่างไม่ได้รับแจ้งเตือนงานใหม่',
      attachments: [{ uploadToken: u.body.uploadToken }],
      context: { page: 'Development Plan › Gantt', path: '/work/orbit-demo/p/DP/gantt', requestId: 'req_9c41e2' },
      articleSlug: 'line-approve',
      searchQuery: 'ลบ sprint ติดต่อ',
    });
    expect(r.status).toBe(201);
    ticketId = r.body.ticket.id;
    expect(r.body.ticket).toMatchObject({ status: 'open', mine: true, subject: 'LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์', dev: null, canReply: true });
    expect(r.body.ticket.number).toBeGreaterThan(0);
    expect(r.body.sla.first).toEqual({ n: 4, unit: 'h' });
    const row = (await t.owner.query('SELECT channel, priority, category, requester_email, workspace_id, first_response_due_at FROM support_tickets WHERE id = $1', [ticketId])).rows[0];
    expect(row).toMatchObject({ channel: 'in_app', priority: 'high', category: 'notification', requester_email: 'dev@orbit-demo.example.com', workspace_id: wsId });
    expect(row.first_response_due_at).toBeTruthy();
    const linked = (await t.owner.query('SELECT source FROM help_article_tickets WHERE ticket_id = $1', [ticketId])).rows;
    expect(linked).toEqual([{ source: 'customer' }]);
    expect((await t.owner.query('SELECT tickets FROM help_search_misses')).rows[0].tickets).toBe(before + 1);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'dev@orbit-demo.example.com', subject: `[#${r.body.ticket.number}] ได้รับเรื่องแล้ว: LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์` });
    // token ใช้ซ้ำไม่ได้
    expect((await team.dev.post(`${team.ws}/support/tickets`, { subject: 'ซ้ำ', category: 'other', body: 'x', attachments: [{ uploadToken: u.body.uploadToken }] })).status).toBe(409);
    const audit = (await t.owner.query(`SELECT action FROM audit_logs WHERE workspace_id = $1 AND action = 'support.ticket_created'`, [wsId])).rows;
    expect(audit).toHaveLength(1);
  });

  it('รายละเอียด: ไม่มีบันทึกภายใน · พนักงานแสดงเป็นทีม Friday · ไฟล์แนบมีลิงก์ดาวน์โหลด', async () => {
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, author_staff_id, body, internal) VALUES ($1, 'staff', $2, 'บันทึกภายใน: ลูกค้ารายนี้ใช้แพ็กเกจเก่า', true)`, [ticketId, staffId]);
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, author_staff_id, body) VALUES ($1, 'staff', $2, 'ได้รับเรื่องแล้วครับ กำลังตรวจประวัติการส่ง')`, [ticketId, staffId]);
    await t.owner.query(`UPDATE support_tickets SET status = 'pending_customer', first_responded_at = now() WHERE id = $1`, [ticketId]);
    const r = await team.dev.get(`${team.ws}/support/tickets/${ticketId}`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('บันทึกภายใน');
    expect(JSON.stringify(r.body)).not.toContain('Support A');
    expect(r.body.messages.map((m: { author: string }) => m.author)).toEqual(['me', 'staff']);
    expect(r.body.messages[0]).toMatchObject({ context: { page: 'Development Plan › Gantt', requestId: 'req_9c41e2', impact: 'team' }, article: { slug: 'line-approve' } });
    expect(r.body.messages[0].files).toEqual([expect.objectContaining({ name: 'screen.png', size: 5, url: expect.stringContaining('/api/v1/storage/download/') })]);
    expect(r.body.ticket).toMatchObject({ status: 'pending_customer', firstResponseDueAt: null });
  });

  it('ไม่หลุดข้าม Workspace และข้ามคน: สมาชิกอื่นไม่เห็น · Owner เห็นทั้ง Workspace ยกเว้นหมวดบัญชีส่วนตัว', async () => {
    expect((await other.lead.get(`${other.ws}/support/tickets/${ticketId}`)).status).toBe(404);
    expect((await other.lead.get(`${team.ws}/support/tickets/${ticketId}`)).status).toBe(404);
    const priv = await team.dev.post(`${team.ws}/support/tickets`, { subject: 'เปลี่ยนอีเมลบัญชีของฉัน', category: 'account', body: 'อีเมลเดิมใช้ไม่ได้แล้ว' });
    expect(priv.status).toBe(201);
    const ownerMine = await team.lead.get(`${team.ws}/support/tickets`);
    expect(ownerMine.body.items).toEqual([]);
    const all = await team.lead.get(`${team.ws}/support/tickets?scope=workspace`);
    expect(all.body.items.map((x: { id: string }) => x.id)).toEqual([ticketId]);
    expect(all.body.items[0]).toMatchObject({ mine: false, requester: { name: 'Kaijeaw' } });
    expect((await team.lead.get(`${team.ws}/support/tickets/${priv.body.ticket.id}`)).status).toBe(404);
    expect((await team.dev.get(`${team.ws}/support/tickets?scope=workspace`)).status).toBe(403);
    const mine = await team.dev.get(`${team.ws}/support/tickets`);
    expect(mine.body).toMatchObject({ openMine: 2, canContact: true, canViewWorkspace: false, plan: { code: 'team_s', name: 'Team S' }, sla: { first: { n: 4, unit: 'h' } } });
    expect(mine.body.items).toHaveLength(2);
  });

  it('ตอบในแอป: รอคุณตอบ → รอทีมตอบ · Owner ตอบแทนได้ · ข้อความว่างไม่ได้', async () => {
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}/messages`, { body: ' ' })).status).toBe(400);
    const r = await team.dev.post(`${team.ws}/support/tickets/${ticketId}/messages`, { body: 'ลองเชิญบอทใหม่แล้วยังไม่ได้' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('open');
    expect((await team.lead.post(`${team.ws}/support/tickets/${ticketId}/messages`, { body: 'Owner เสริมข้อมูล' })).status).toBe(201);
    const msgs = (await team.dev.get(`${team.ws}/support/tickets/${ticketId}`)).body.messages;
    expect(msgs.map((m: { author: string }) => m.author)).toEqual(['me', 'staff', 'me', 'customer']);
  });

  it('ส่งทีมพัฒนาแล้ว (pending_dev) ลูกค้าเห็นสถานะ ไม่เห็นเลขงานของทีมพัฒนา · ตอบแล้วคงสถานะเดิม', async () => {
    const link = (await t.owner.query(`INSERT INTO dev_issue_links (issue_key, title, severity) VALUES ('FM-482', 'งานลับของทีมพัฒนา', 'S2') RETURNING id`)).rows[0].id;
    await t.owner.query(`INSERT INTO dev_issue_tickets (ticket_id, link_id) VALUES ($1, $2)`, [ticketId, link]);
    await t.owner.query(`UPDATE support_tickets SET status = 'pending_dev' WHERE id = $1`, [ticketId]);
    const r = await team.dev.get(`${team.ws}/support/tickets/${ticketId}`);
    expect(r.body.ticket).toMatchObject({ status: 'pending_dev', dev: { fixed: false } });
    expect(r.body.ticket.dev.sentAt).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain('FM-482');
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}/messages`, { body: 'ขอบคุณครับ' })).body.status).toBe('pending_dev');
  });

  it('แก้แล้ว: ปิดเรื่อง (แก้แล้ว ขอบคุณ) · เปิดใหม่ (ยังพบปัญหา) ภายในกำหนด · เกินกำหนดเปิดใหม่ไม่ได้', async () => {
    await t.owner.query(`UPDATE dev_issue_tickets SET outcome = 'fixed', notified_at = now() WHERE ticket_id = $1`, [ticketId]);
    await t.owner.query(`UPDATE support_tickets SET status = 'solved', solved_at = now() WHERE id = $1`, [ticketId]);
    let r = await team.dev.get(`${team.ws}/support/tickets/${ticketId}`);
    expect(r.body.ticket).toMatchObject({ status: 'solved', dev: { fixed: true }, canReopen: true, canClose: true });
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}:reopen`)).body).toMatchObject({ status: 'open' });
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}:reopen`)).status).toBe(409);
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}:close`)).body).toMatchObject({ status: 'closed' });
    r = await team.dev.get(`${team.ws}/support/tickets/${ticketId}`);
    expect(r.body.ticket).toMatchObject({ status: 'closed', canReply: false, canReopen: true });
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}/messages`, { body: 'ยังมีปัญหา' })).status).toBe(409);
    await t.owner.query(`UPDATE support_tickets SET solved_at = now() - interval '8 days', closed_at = now() - interval '8 days' WHERE id = $1`, [ticketId]);
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}/reopen`)).status).toBe(409);
    // แก้แล้วเกินกำหนดตอบไม่ได้
    await t.owner.query(`UPDATE support_tickets SET status = 'solved' WHERE id = $1`, [ticketId]);
    expect((await team.dev.post(`${team.ws}/support/tickets/${ticketId}/messages`, { body: 'ยังมีปัญหา' })).status).toBe(409);
  });

  it('ทีม Friday ตอบ (ops-api) → แจ้งเตือนในกระดิ่งของผู้แจ้งครั้งเดียว (support.replied) · บันทึกภายในไม่แจ้ง', async () => {
    const job = t.app.get(SupportRepliesJob);
    await job.scan();
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, author_staff_id, body) VALUES ($1, 'staff', $2, 'แก้แล้วครับ ลองใหม่อีกครั้ง')`, [ticketId, staffId]);
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, author_staff_id, body, internal) VALUES ($1, 'staff', $2, 'ภายในเท่านั้น', true)`, [ticketId, staffId]);
    expect((await job.scan()).notified).toBe(1);
    expect((await job.scan()).notified).toBe(0);
    const n = await team.dev.get('/me/notifications?limit=5');
    expect(n.status).toBe(200);
    const item = n.body.items.find((x: { eventType: string }) => x.eventType === 'support.replied');
    expect(item.payload).toMatchObject({ ticketNumber: expect.any(Number), message: 'แก้แล้วครับ ลองใหม่อีกครั้ง' });
    expect(item.payload.title).toContain('ทีม Friday');
    expect((await team.lead.get('/me/notifications?limit=5')).body.items.some((x: { eventType: string }) => x.eventType === 'support.replied')).toBe(false);
  });
});
