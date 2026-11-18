// ช่วง 1 · ออกแบบสำหรับข้อมูลเยอะ: ผู้ซื้อ · ป้าย Workspace ทดสอบ · ตัวเลขบนแท็บ · ข้อมูลสมมติเท่านั้น
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let owner: Staff;
let support: Staff;
let finance: Staff;
let a: Customer;
let b: Customer;
let solo: Customer;
let qa: Customer;
type Item = { id: string; slug: string; buyer: { key: string; name: string | null; count: number }; test: { isTest: boolean; suggest: string | null; flag: string | null } };
const list = async (who: Staff, q = '') => (await who.agent.get(`/ops/workspaces${q}`)).body as { items: Item[]; total: number; counts: Record<string, number>; tests: { hidden: number; suggested: number }; buyer: Record<string, unknown> | null };
const slugs = (r: { items: Item[] }) => r.items.map((x) => x.slug).sort();

beforeAll(async () => {
  t = await startOps();
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  a = await customer(t, 'buyer-app', { plan: 'team_m', status: 'active' });
  b = await customer(t, 'buyer-web', { plan: 'team_s', status: 'active' });
  solo = await customer(t, 'solo-trial', { plan: 'team_s', status: 'trialing' });
  qa = await customer(t, 'qa-sprint', { plan: 'team_s', status: 'trialing' });
  // ผู้ซื้อรายเดียวกัน = เลขผู้เสียภาษีเดียวกัน (ชื่อบริษัทพิมพ์ต่างกันได้)
  await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email) VALUES ($1, 'บจก. ผู้ซื้อร่วม', '0105500000009', '1 ถนนสมมติ', 'acc@buyer.example.com'), ($2, 'บริษัท ผู้ซื้อร่วม จำกัด', '0105500000009', '1 ถนนสมมติ', 'acc@buyer.example.com')`, [a.id, b.id]);
  // ชื่อขึ้นต้น QA + เจ้าของใช้อีเมลโดเมนเดียวกับทีม Friday = ระบบเสนอให้ตรวจ
  await t.owner.query(`UPDATE workspaces SET name = 'QA Sprint ทดลอง' WHERE id = $1`, [qa.id]);
  await t.owner.query(`UPDATE users SET email = 'qa14@friday.example.com' WHERE id = $1`, [qa.owner]);
  await t.owner.query(`INSERT INTO subscription_changes (workspace_id, kind, plan_to, mrr_before_satang, mrr_after_satang, actor_kind, effective_at) VALUES ($1, 'new', 'team_m', 0, 300000, 'user', now() - interval '40 days'), ($2, 'new', 'team_s', 0, 150000, 'user', now() - interval '40 days')`, [a.id, b.id]);
});
afterEach(() => {
  process.env.OPS_TEST_EMAIL_DOMAINS = '';
});
afterAll(() => t.close());

describe('ผู้ซื้อ', () => {
  it('Workspace ที่เลขภาษีเดียวกันนับเป็นผู้ซื้อรายเดียว · กรองผู้ซื้อได้ยอดรวมทุก Workspace', async () => {
    const r = await list(finance);
    const app = r.items.find((x) => x.slug === 'buyer-app')!;
    expect(app.buyer).toMatchObject({ key: 't:0105500000009', name: 'บจก. ผู้ซื้อร่วม', count: 2 });
    // ยังไม่กรอกข้อมูลภาษี = ใช้อีเมลเจ้าของ · นับรายเดียว
    expect(r.items.find((x) => x.slug === 'solo-trial')!.buyer).toMatchObject({ name: 'owner@solo-trial.example.com', count: 1 });
    const one = await list(finance, `?buyer=${encodeURIComponent(app.buyer.key)}`);
    expect(slugs(one)).toEqual(['buyer-app', 'buyer-web']);
    expect(one.buyer).toMatchObject({ workspaces: 2, mrr: 450_000 });
    // Support ไม่เห็นยอดเงินรวม
    expect((await list(support, `?buyer=${encodeURIComponent(app.buyer.key)}`)).buyer).toMatchObject({ workspaces: 2, mrr: null });
    // หน้ารายละเอียดบอก Workspace อื่นของผู้ซื้อ
    const d = (await support.agent.get(`/ops/workspaces/${a.id}`)).body;
    expect(d.buyer).toMatchObject({ count: 2, others: [expect.objectContaining({ slug: 'buyer-web' })] });
  });

  it('ค้นด้วยชื่อบริษัทหรือเลขผู้เสียภาษีได้ · ตัวเลขบนแท็บสถานะมาจาก server', async () => {
    expect(slugs(await list(support, '?q=0105500000009'))).toEqual(['buyer-app', 'buyer-web']);
    expect(slugs(await list(support, `?q=${encodeURIComponent('ผู้ซื้อร่วม')}`))).toEqual(['buyer-app', 'buyer-web']);
    const r = await list(support, '?status=trialing');
    expect(r.total).toBe(2);
    expect(r.counts).toMatchObject({ all: 4, trialing: 2 });
  });
});

describe('ป้าย Workspace ทดสอบ', () => {
  it('ระบบเสนอรายการที่น่าจะเป็นทดสอบ · ติดป้ายแล้วซ่อนจากรายการ · Audit log ของทีม', async () => {
    const r = await list(support);
    expect(r.tests.suggested).toBe(1);
    const s = await list(support, '?suggest=any');
    expect(s.items).toEqual([expect.objectContaining({ slug: 'qa-sprint', test: expect.objectContaining({ suggest: 'staff_domain', isTest: false }) })]);
    expect((await finance.agent.post('/ops/workspaces/test-flag').send({ ids: [qa.id], flag: 'test', reason: 'รอบทดสอบ Sprint' })).status).toBe(403);
    // ติดตามตัวกรอง (เลือกทั้งหมดที่ค้นเจอ) ทำที่ server ทั้งชุด
    const done = await support.agent.post('/ops/workspaces/test-flag').send({ filter: { suggest: 'any' }, flag: 'test', reason: 'รอบทดสอบ Sprint' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ updated: 1, paying: 0 });
    const after = await list(support);
    expect(slugs(after)).toEqual(['buyer-app', 'buyer-web', 'solo-trial']);
    expect(after.tests).toEqual({ hidden: 1, suggested: 0 });
    expect(slugs(await list(support, '?test=only'))).toEqual(['qa-sprint']);
    const audit = (await t.owner.query(`SELECT action, reason FROM staff_audit_logs WHERE action = 'workspace.test_flagged'`)).rows;
    expect(audit).toEqual([{ action: 'workspace.test_flagged', reason: 'รอบทดสอบ Sprint · 1 Workspace' }]);
    // เอาป้ายออก = กลับไปตามกฎ
    await support.agent.post('/ops/workspaces/test-flag').send({ ids: [qa.id], flag: 'clear', reason: 'ตรวจใหม่' }).expect(200);
    expect((await list(support)).total).toBe(4);
  });

  it('ชุดที่มีลูกค้าจ่ายเงินต้องยืนยันอีกครั้ง · Workspace ทดสอบไม่นับใน MRR', async () => {
    const before = (await finance.agent.get('/ops/overview')).body.money.mrr;
    expect(before).toBe(450_000);
    const warn = await owner.agent.post('/ops/workspaces/test-flag').send({ ids: [a.id], flag: 'test', reason: 'สาธิตให้ลูกค้าใหม่' });
    expect(warn.status).toBe(409);
    expect(warn.body.error).toMatchObject({ code: 'has_paying', details: { paying: 1 } });
    await owner.agent.post('/ops/workspaces/test-flag').send({ ids: [a.id], flag: 'test', reason: 'สาธิตให้ลูกค้าใหม่', confirmPaying: true }).expect(200);
    expect((await finance.agent.get('/ops/overview')).body.money.mrr).toBe(150_000);
    // ผู้ซื้อนับเฉพาะลูกค้าจริง
    expect((await list(finance)).items.find((x) => x.slug === 'buyer-web')!.buyer.count).toBe(1);
    await owner.agent.post('/ops/workspaces/test-flag').send({ ids: [a.id], flag: 'clear', reason: 'ลูกค้าจริง' }).expect(200);
    expect((await finance.agent.get('/ops/overview')).body.money.mrr).toBe(450_000);
  });

  it('กฎอัตโนมัติ: เจ้าของใช้โดเมนสงวน (รวมโดเมนย่อย) = ทดสอบ · ติด "ลูกค้าจริง" เพื่อยกเว้นได้', async () => {
    process.env.OPS_TEST_EMAIL_DOMAINS = 'example.com';
    const r = await list(support);
    expect(r.total).toBe(0);
    expect(r.tests.hidden).toBe(4);
    await support.agent.post('/ops/workspaces/test-flag').send({ ids: [solo.id], flag: 'not_test', reason: 'ลูกค้าจริงที่ใช้อีเมลสาธิต' }).expect(200);
    const after = await list(support);
    expect(after.items).toEqual([expect.objectContaining({ slug: 'solo-trial', test: expect.objectContaining({ isTest: false, flag: 'not_test' }) })]);
  });
});
