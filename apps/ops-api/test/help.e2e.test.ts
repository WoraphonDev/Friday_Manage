// O35 · จัดการบทความศูนย์ช่วยเหลือ (19 · 19b · X8 · X9) · ข้อมูลสมมติเท่านั้น
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelpService } from '../src/help/help.service.js';
import { customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let support: Staff;
let finance: Staff;
let engineer: Staff;
const cat: Record<string, string> = {};
let articleId: string;

const APP_URL = process.env.DATABASE_APP_URL ?? 'postgres://friday_api:friday_api_dev@localhost:54329/friday';
/** อ่านบทความแบบลูกค้า (friday_app ภายใต้ RLS และ grant รายคอลัมน์) */
async function asCustomer(q: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: APP_URL });
  await c.connect();
  try {
    return (await c.query(q, params)).rows;
  } finally {
    await c.end();
  }
}
const audit = async (action: string) => (await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows.map((r) => r.reason as string);

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  for (const [slug, name, pos] of [['getting-started', 'เริ่มต้นใช้งาน', 1], ['notifications', 'แจ้งเตือน LINE และอีเมล', 2], ['billing', 'แพ็กเกจและการชำระเงิน', 3]] as const) {
    cat[slug] = (await t.owner.query('INSERT INTO help_categories (slug, name, position) VALUES ($1, $2, $3) RETURNING id', [slug, name, pos])).rows[0].id;
  }
});
afterAll(() => t.close());

describe('บทความ: ร่าง → เผยแพร่ → แก้เป็นร่าง → เวอร์ชัน', () => {
  it('Support สร้างร่าง · slug จากหัวข้อภาษาไทยได้ค่าอัตโนมัติ · การเงินเขียนไม่ได้แต่อ่านได้', async () => {
    const r = await support.agent.post('/ops/help/articles').send({ title: 'กู้คืนงานและโปรเจกต์ที่ลบผิด', categoryId: cat['getting-started'], body: '## กู้คืนงาน\n1. เปิด Admin Console' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    articleId = r.body.article.id;
    expect(r.body.article).toMatchObject({ status: 'draft', version: 0, ownerId: support.id, hasDraft: false });
    expect(r.body.article.slug).toMatch(/^article-[0-9a-f]{6}$/);
    const en = await support.agent.post('/ops/help/articles').send({ title: 'Restore deleted work', categoryId: cat['getting-started'] });
    expect(en.body.article.slug).toBe('restore-deleted-work');
    expect((await support.agent.post('/ops/help/articles').send({ title: 'อีกบทความ', categoryId: cat['getting-started'], slug: 'restore-deleted-work' })).status).toBe(409);
    expect((await finance.agent.post('/ops/help/articles').send({ title: 'ไม่ควรได้', categoryId: cat.billing })).status).toBe(403);
    expect((await finance.agent.get('/ops/help/articles')).status).toBe(200);
    const d = await finance.agent.get(`/ops/help/articles/${articleId}`);
    expect(d.body.canEdit).toBe(false);
    expect((await engineer.agent.get('/ops/help/overview')).body.canEdit).toBe(false);
    expect(await audit('help.article_created')).toHaveLength(2);
  });

  it('ร่างลูกค้าไม่เห็น · บันทึกอัตโนมัติแก้ตรง · Audit การแก้ไม่ถี่เกินไป', async () => {
    const p = await support.agent.patch(`/ops/help/articles/${articleId}`).send({ slug: 'restore-deleted', summary: 'งานที่ลบอยู่ในถังขยะ 30 วัน', keywords: 'ลบผิด, trash, เอากลับ', appRoutes: ['admin.trash'], reviewAt: '2027-02-12' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.article).toMatchObject({ slug: 'restore-deleted', keywords: 'ลบผิด, trash, เอากลับ', appRoutes: ['admin.trash'], reviewAt: '2027-02-12' });
    await support.agent.patch(`/ops/help/articles/${articleId}`).send({ body: '## กู้คืนงาน\n1. เปิด Admin Console › ถังขยะ\n:::warning\nเกิน 30 วันแล้ว ติดต่อทีม Support ทันที\n:::' });
    expect(await audit('help.article_edited')).toHaveLength(1);
    expect(await asCustomer(`SELECT id FROM help_articles WHERE slug = 'restore-deleted'`)).toEqual([]);
    expect((await support.agent.patch(`/ops/help/articles/${articleId}`).send({ slug: 'Bad Slug!' })).status).toBe(400);
  });

  it('เผยแพร่ต้องติ๊กตรวจข้อมูลลูกค้า · เก็บเวอร์ชัน · ลูกค้าเห็นแต่ไม่เห็นคอลัมน์ภายใน', async () => {
    const no = await support.agent.post(`/ops/help/articles/${articleId}/publish`).send({ piiChecked: false });
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe('pii_check_required');
    const r = await support.agent.post(`/ops/help/articles/${articleId}:publish`).send({ piiChecked: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.article).toMatchObject({ status: 'published', version: 1, hasDraft: false });
    expect(r.body.article.piiCheckedAt).toBeTruthy();
    expect(await asCustomer(`SELECT slug, title FROM help_articles WHERE slug = 'restore-deleted'`)).toEqual([{ slug: 'restore-deleted', title: 'กู้คืนงานและโปรเจกต์ที่ลบผิด' }]);
    await expect(asCustomer(`SELECT keywords FROM help_articles`)).rejects.toThrow(/permission denied/);
    expect(await audit('help.article_published')).toEqual(['เผยแพร่บทความ "กู้คืนงานและโปรเจกต์ที่ลบผิด" เวอร์ชัน 1 · ทุกคน']);
  });

  it('แก้บทความที่เผยแพร่แล้ว: เก็บเป็นร่าง ลูกค้ายังเห็นฉบับเดิม · ทิ้งร่างได้ · เผยแพร่ใหม่เป็นเวอร์ชัน 2', async () => {
    await support.agent.patch(`/ops/help/articles/${articleId}`).send({ title: 'กู้คืนงานที่ลบผิด (ฉบับใหม่)', visibility: 'signed_in' });
    const d = await support.agent.get(`/ops/help/articles/${articleId}`);
    expect(d.body.article).toMatchObject({ title: 'กู้คืนงานที่ลบผิด (ฉบับใหม่)', visibility: 'signed_in', hasDraft: true, status: 'published' });
    expect(await asCustomer(`SELECT title, visibility FROM help_articles WHERE id = $1`, [articleId])).toEqual([{ title: 'กู้คืนงานและโปรเจกต์ที่ลบผิด', visibility: 'public' }]);
    expect((await support.agent.post(`/ops/help/articles/${articleId}/discard-draft`)).body.article).toMatchObject({ title: 'กู้คืนงานและโปรเจกต์ที่ลบผิด', hasDraft: false });
    await support.agent.patch(`/ops/help/articles/${articleId}`).send({ title: 'กู้คืนงานที่ลบผิด (ฉบับใหม่)' });
    const pub = await owner.agent.post(`/ops/help/articles/${articleId}/publish`).send({ piiChecked: true });
    expect(pub.body.article).toMatchObject({ version: 2, title: 'กู้คืนงานที่ลบผิด (ฉบับใหม่)' });
    const detail = await support.agent.get(`/ops/help/articles/${articleId}`);
    expect(detail.body.versions.map((v: { version: number; publishedBy: string }) => [v.version, v.publishedBy])).toEqual([[2, 'Olive Owner'], [1, 'Sam Support']]);
  });

  it('ย้อนกลับเวอร์ชัน = เผยแพร่เป็นเวอร์ชันใหม่ · เก็บเข้าคลังลูกค้าไม่เห็น · ลบได้และลงประวัติ', async () => {
    const r = await support.agent.post(`/ops/help/articles/${articleId}/versions/1/restore`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.article).toMatchObject({ version: 3, title: 'กู้คืนงานและโปรเจกต์ที่ลบผิด' });
    expect((await support.agent.post(`/ops/help/articles/${articleId}/versions/9/restore`)).status).toBe(404);
    expect((await support.agent.post(`/ops/help/articles/${articleId}/archive`)).body.article.status).toBe('archived');
    expect(await asCustomer(`SELECT id FROM help_articles WHERE id = $1`, [articleId])).toEqual([]);
    const tmp = (await support.agent.post('/ops/help/articles').send({ title: 'ลบทิ้ง', categoryId: cat.billing })).body.article.id;
    expect((await support.agent.delete(`/ops/help/articles/${tmp}`)).body).toEqual({ deleted: true });
    expect((await support.agent.get(`/ops/help/articles/${tmp}`)).status).toBe(404);
    expect(await audit('help.article_deleted')).toHaveLength(1);
    expect(await audit('help.article_restored')).toHaveLength(1);
  });
});

describe('หน้า 19: KPI · ต้องทบทวน · คำค้นที่ไม่พบ', () => {
  it('ต้องทบทวน = เกินวันทบทวน หรือช่วยได้ < 70% จาก ≥ 20 โหวต · KPI ค้นหา / ไม่พบ / ช่วยได้', async () => {
    const mk = async (slug: string, review: string | null) =>
      (await t.owner.query(`INSERT INTO help_articles (slug, category_id, title, body, status, version, published_at, pii_checked_at, review_at) VALUES ($1, $2, $1, 'เนื้อหา', 'published', 1, now(), now(), $3) RETURNING id`, [slug, cat.notifications, review])).rows[0].id as string;
    const low = await mk('line-troubleshoot', null);
    const old = await mk('tax-invoice', '2020-01-01');
    const good = await mk('line-approve', '2099-01-01');
    for (let i = 0; i < 20; i++) await t.owner.query(`INSERT INTO help_feedback (article_id, helpful) VALUES ($1, $2)`, [low, i < 12]);
    for (let i = 0; i < 10; i++) await t.owner.query(`INSERT INTO help_feedback (article_id, helpful) VALUES ($1, true)`, [good]);
    await t.owner.query(`INSERT INTO help_article_views (article_id, day, views) VALUES ($1, current_date, 41), ($1, current_date - 40, 999)`, [good]);
    await t.owner.query(`INSERT INTO help_search_stats (day, searches, misses) VALUES (current_date, 100, 8), (current_date - 40, 500, 50)`);
    await t.owner.query(`INSERT INTO help_search_misses (day, query, searches, tickets) VALUES (current_date, 'ลบ sprint', 41, 6), (current_date - 1, 'ลบ sprint', 3, 0), (current_date, 'export pdf gantt', 33, 4), (current_date - 60, 'เก่ามาก', 99, 0)`);
    const list = (await support.agent.get('/ops/help/articles?review=1')).body.items;
    expect(list.map((r: { slug: string; reviewReason: string }) => [r.slug, r.reviewReason]).sort()).toEqual([['line-troubleshoot', 'low_helpful'], ['tax-invoice', 'overdue']]);
    const row = (await support.agent.get('/ops/help/articles?status=published')).body.items.find((r: { slug: string }) => r.slug === 'line-approve');
    expect(row).toMatchObject({ reads30: 41, votes: 10, helpfulPct: 100, needsReview: false, category: { name: 'แจ้งเตือน LINE และอีเมล' } });
    expect((await support.agent.get('/ops/help/articles?lowHelpful=1')).body.items.map((r: { slug: string }) => r.slug)).toEqual(['line-troubleshoot']);
    const o = await support.agent.get('/ops/help/overview');
    expect(o.body.kpi).toMatchObject({ published: 3, review: 2, searches30: 100, misses30: 8, missPct: 8, votes30: 30, helpfulPct: 73 });
    expect(o.body.topMisses).toEqual([{ query: 'ลบ sprint', searches: 44, tickets: 6, articleId: null }, { query: 'export pdf gantt', searches: 33, tickets: 4, articleId: null }]);
    expect(o.body.tabs).toMatchObject({ misses: 2, review: 2 });
    expect(o.body.canEdit).toBe(true);
  });

  it('เขียนบทความจากคำค้นที่ไม่พบ → ผูกคำค้นกับบทความ (หายจากการ์ด)', async () => {
    const r = await support.agent.post('/ops/help/articles').send({ title: 'ลบ Sprint และย้ายงานกลับ Backlog', categoryId: cat['getting-started'], fromQuery: 'ลบ Sprint' });
    expect(r.status).toBe(201);
    const misses = (await support.agent.get('/ops/help/misses?days=30')).body.items;
    expect(misses.find((m: { query: string }) => m.query === 'ลบ sprint')).toMatchObject({ articleId: r.body.article.id, articleTitle: 'ลบ Sprint และย้ายงานกลับ Backlog', searches: 44 });
    expect((await support.agent.get('/ops/help/overview')).body.topMisses.map((m: { query: string }) => m.query)).toEqual(['export pdf gantt']);
  });

  it('ลบคำค้นที่ไม่พบเกิน 25 เดือน', async () => {
    await t.owner.query(`INSERT INTO help_search_misses (day, query, searches) VALUES (current_date - interval '26 months', 'นานมาก', 1), (current_date - interval '24 months', 'ยังเก็บ', 1)`);
    expect((await t.app.get(HelpService).purgeMisses()).deleted).toBe(1);
    expect((await t.owner.query(`SELECT query FROM help_search_misses WHERE query IN ('นานมาก', 'ยังเก็บ')`)).rows).toEqual([{ query: 'ยังเก็บ' }]);
  });
});

describe('หมวด (X9) และสร้างบทความจาก Ticket (X8)', () => {
  it('จัดหมวด: เรียง · แก้ชื่อ · เพิ่ม · ลบได้เมื่อไม่มีบทความ · การเงินแก้ไม่ได้', async () => {
    const cur = (await support.agent.get('/ops/help/categories')).body.items;
    expect(cur.map((c: { name: string; articles: number }) => [c.name, c.articles])).toEqual([['เริ่มต้นใช้งาน', 3], ['แจ้งเตือน LINE และอีเมล', 3], ['แพ็กเกจและการชำระเงิน', 0]]);
    const blocked = await support.agent.put('/ops/help/categories').send({ items: [{ id: cat.billing, name: 'แพ็กเกจ' }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('category_has_articles');
    const r = await support.agent.put('/ops/help/categories').send({ items: [{ id: cat.notifications, name: 'แจ้งเตือน LINE และอีเมล' }, { id: cat['getting-started'], name: 'เริ่มใช้งาน' }, { name: 'API, Webhook และ GitHub', slug: 'api-integrations' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((c: { slug: string; name: string; position: number }) => [c.slug, c.name, c.position])).toEqual([['notifications', 'แจ้งเตือน LINE และอีเมล', 1], ['getting-started', 'เริ่มใช้งาน', 2], ['api-integrations', 'API, Webhook และ GitHub', 3]]);
    expect((await finance.agent.put('/ops/help/categories').send({ items: [{ name: 'x y' }] })).status).toBe(403);
    expect((await audit('help.categories_updated'))[0]).toContain('ลบ แพ็กเกจและการชำระเงิน');
  });

  it('X8: เติมหัวข้อจากสาเหตุ เนื้อหาจากผลลัพธ์ + คำตอบสุดท้าย · สร้างเป็นร่างผูก Ticket · การเงินเปิด Ticket ไม่ได้', async () => {
    const ws = await customer(t, 'lotus-demo');
    const k = (await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_email, subject, status, category, cause, solved_at) VALUES ($1, 'ops@lotus-demo.example.com', 'LINE OA ไม่แจ้งเตือนในกลุ่ม', 'solved', 'notification', 'ปลายทางถูกลบที่ LINE', now()) RETURNING id, number`, [ws.id])).rows[0];
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, author_staff_id, body) VALUES ($1, 'staff', $2, '1. ตรวจว่ายังเชิญ Friday Manage เป็นสมาชิกกลุ่ม')`, [k.id, support.id]);
    await t.owner.query(`INSERT INTO support_ticket_messages (ticket_id, author_kind, author_staff_id, body, internal) VALUES ($1, 'staff', $2, 'ปิดเรื่อง · เชิญบอทเข้ากลุ่มใหม่แล้วใช้ได้ · สาเหตุ: ปลายทางถูกลบที่ LINE', true)`, [k.id, support.id]);
    await t.owner.query(`INSERT INTO help_categories (slug, name, position) VALUES ('billing', 'แพ็กเกจและการชำระเงิน', 9)`);
    const pre = await support.agent.get(`/ops/help/from-ticket/${k.id}`);
    expect(pre.status).toBe(200);
    expect(pre.body.ticket).toMatchObject({ number: k.number, cause: 'ปลายทางถูกลบที่ LINE' });
    expect(pre.body.draft).toEqual({ title: 'ปลายทางถูกลบที่ LINE', body: 'เชิญบอทเข้ากลุ่มใหม่แล้วใช้ได้\n\n1. ตรวจว่ายังเชิญ Friday Manage เป็นสมาชิกกลุ่ม', categoryId: cat.notifications });
    expect((await finance.agent.get(`/ops/help/from-ticket/${k.id}`)).status).toBe(403);
    const r = await support.agent.post(`/ops/help/from-ticket/${k.id}`).send({ title: 'LINE ไม่แจ้งเตือนในกลุ่ม: ตรวจ 4 จุด', categoryId: cat.notifications, body: pre.body.draft.body, link: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.article.status).toBe('draft');
    const d = await support.agent.get(`/ops/help/articles/${r.body.article.id}`);
    expect(d.body.sourceTicket).toEqual({ id: k.id, number: k.number });
    expect((await t.owner.query(`SELECT source FROM help_article_tickets WHERE ticket_id = $1`, [k.id])).rows).toEqual([{ source: 'created_from' }]);
    const row = (await support.agent.get('/ops/help/articles?status=draft')).body.items.find((x: { id: string }) => x.id === r.body.article.id);
    expect(row.tickets).toBe(1);
  });
});
