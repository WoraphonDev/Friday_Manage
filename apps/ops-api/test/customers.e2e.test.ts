// O02 · ลูกค้าและผู้ใช้ในหลังบ้าน · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../src/billing/billing.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let support: Staff;
let finance: Staff;
let engineer: Staff;
let a: Customer;
let b: Customer;
const DAY = 86_400_000;

const member = async (c: Customer, email: string, role: string, opts: { joinedDaysAgo?: number; activeDaysAgo?: number } = {}) => {
  const u = (await t.owner.query(`INSERT INTO users (email, display_name, email_verified_at) VALUES ($1, $2, now()) RETURNING id`, [email, email.split('@')[0]])).rows[0].id as string;
  await t.owner.query(`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at, last_active_at) VALUES ($1, $2, $3, now() - make_interval(days => $4), now() - make_interval(days => $5))`, [c.id, u, role, opts.joinedDaysAgo ?? 60, opts.activeDaysAgo ?? 1]);
  return u;
};
const auditOf = async (ws: string, action: string) => (await t.owner.query(`SELECT actor_kind, summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [ws, action])).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  engineer = await staff(t, 'eng@friday.example.com', 'Eve Engineer', ['engineer']);
  a = await customer(t, 'siam-demo', { plan: 'team_m', status: 'active' });
  b = await customer(t, 'orbit-demo', { plan: 'team_s', status: 'trialing' });
  // ราคาและที่นั่งของแพ็กเกจ (สมมติ)
  await t.owner.query(`UPDATE plans SET price_monthly_satang = 300000, price_yearly_satang = 3000000, seat_limit = 25, storage_gb_per_member = 5 WHERE code = 'team_m'`);
  await t.owner.query(`UPDATE plans SET price_monthly_satang = 150000, price_yearly_satang = 1500000, seat_limit = 3, storage_gb_per_member = 5 WHERE code = 'team_s'`);
  await t.owner.query(`UPDATE plans SET price_monthly_satang = 550000, price_yearly_satang = 5500000, seat_limit = 50, storage_gb_per_member = 5 WHERE code = 'team_l'`);
  for (let i = 0; i < 20; i++) await member(a, `dev${i}@siam-demo.example.com`, 'member', { joinedDaysAgo: i < 15 ? 60 : 5, activeDaysAgo: i < 16 ? 2 : 40 });
  await member(a, 'guest@partner.example.com', 'guest');
  await t.owner.query(`INSERT INTO webhook_endpoints (workspace_id, name, url_encrypted, url_last4) VALUES ($1, 'Discord', 'enc', 'abcd')`, [a.id]);
  await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email) VALUES ($1, 'บริษัท สยามเดโม จำกัด', '0105500000001', '1 ถนนสมมติ', 'acc@siam-demo.example.com')`, [a.id]);
  await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, amount_due, status, due_date, paid_at) VALUES ($1,$2,'FRI-O02-0001',current_date - 30,current_date,300000,21000,321000,321000,'paid',current_date - 25, now() - interval '27 days')`, [a.id, a.sub]);
  await t.owner.query(`INSERT INTO subscription_changes (workspace_id, kind, plan_to, mrr_before_satang, mrr_after_satang, actor_kind, effective_at) VALUES ($1, 'new', 'team_m', 0, 300000, 'user', now() - interval '40 days')`, [a.id]);
  await t.owner.query(`INSERT INTO cost_rates (resource, unit_cost_satang, effective_from) VALUES ('line_message', 4, '2026-01-01'), ('email', 1, '2026-01-01')`);
  await t.owner.query(`INSERT INTO daily_usages (workspace_id, date, line_messages, emails, active_users) VALUES ($1, current_date - 1, 1000, 500, 16), ($1, current_date - 2, 580, 320, 15)`, [a.id]);
  await t.owner.query(`INSERT INTO product_events (workspace_id, name, props) VALUES ($1, 'feature.used', '{"feature":"gantt"}'), ($1, 'limit.hit', '{"limit":"automation"}'), ($1, 'limit.hit', '{"limit":"automation"}'), ($1, 'limit.hit', '{"limit":"automation"}')`, [a.id]);
});
afterAll(() => t.close());

describe('รายชื่อ Workspace', () => {
  it('ค้น กรอง เรียง หน้าละ 50 · มีที่นั่ง ผู้ใช้งาน 30 วัน การเชื่อมต่อ สุขภาพ · Support ไม่เห็น MRR', async () => {
    const r = await support.agent.get('/ops/workspaces');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, limit: 50, offset: 0, sort: 'newest' });
    const siam = r.body.items.find((x: { slug: string }) => x.slug === 'siam-demo');
    expect(siam).toMatchObject({ plan: 'team_m', seats: 21, seatLimit: 25, active30: 17, integrations: ['webhook'], mrr: null, paymentState: 'ok' });
    expect(siam.health).toBeGreaterThan(50);
    const f = await finance.agent.get('/ops/workspaces?sort=mrr');
    expect(f.body.items.map((x: { slug: string; mrr: number }) => [x.slug, x.mrr])).toEqual([['siam-demo', 300_000], ['orbit-demo', 0]]);
    // คนที่ไม่เห็นเงินขอเรียงตาม MRR ได้ลำดับใหม่สุดแทน
    expect((await support.agent.get('/ops/workspaces?sort=mrr')).body.sort).toBe('newest');
    expect((await support.agent.get('/ops/workspaces?feature=webhook')).body.items.map((x: { slug: string }) => x.slug)).toEqual(['siam-demo']);
    expect((await support.agent.get('/ops/workspaces?feature=no_project')).body.total).toBe(2);
    expect((await support.agent.get('/ops/workspaces?sort=health')).body.items[0].slug).toBe('orbit-demo');
    expect((await support.agent.get('/ops/workspaces?limit=1&offset=1')).body).toMatchObject({ total: 2, items: [expect.any(Object)] });
    expect((await support.agent.get('/ops/workspaces?feature=nope')).status).toBe(400);
  });
});

describe('รายละเอียด 9 แท็บ', () => {
  it('ภาพรวม: สุขภาพ กำไร (เฉพาะคนเห็นเงิน) สัญญาณพร้อมอัปเกรด · วิศวกรไม่เห็นอีเมล', async () => {
    const f = (await finance.agent.get(`/ops/workspaces/${a.id}`)).body;
    expect(f.health).toMatchObject({ score: expect.any(Number), parts: { usage: expect.any(Number), payment: 100 } });
    expect(f.economics).toMatchObject({ mrrSatang: 300_000, revenueSatang: 300_000, costs: { lineMessages: { qty: 1580, satang: 6320 }, emails: { qty: 820, satang: 820 } } });
    expect(f.economics.marginPct).toBe(98);
    expect(f.upgradeSignals.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['seats_near_limit', 'limit_hit']));
    expect(f.legalName).toBe('บริษัท สยามเดโม จำกัด');
    expect(f.topFeatures).toEqual(['gantt']);
    const sp = (await support.agent.get(`/ops/workspaces/${a.id}`)).body;
    expect(sp.economics).toBeNull();
    expect(sp.invoices[0]).toMatchObject({ status: 'paid', total: null });
    expect(sp.owners[0].email).toBe('owner@siam-demo.example.com');
    const en = (await engineer.agent.get(`/ops/workspaces/${a.id}`)).body;
    expect(en.owners[0].email).toBeNull();
    expect(en.economics).toBeNull();
  });

  it('แท็บอื่น 8 แท็บตอบได้ · ไม่ส่งเนื้อหางาน · วิศวกรเปิดแท็บการเงินไม่ได้', async () => {
    await t.owner.query(`INSERT INTO invitations (workspace_id, email, workspace_role, token_hash, expires_at, invited_by) VALUES ($1, 'new@siam-demo.example.com', 'member', $2, now() + interval '5 days', $3)`, [a.id, randomUUID(), a.owner]);
    await t.owner.query(`INSERT INTO support_tickets (workspace_id, requester_email, subject, status, csat) VALUES ($1, 'pm@siam-demo.example.com', 'นำเข้า Excel แล้ววันที่เลื่อน', 'solved', 5), ($1, 'pm@siam-demo.example.com', 'Webhook ไม่ส่ง', 'open', null)`, [a.id]);
    const get = (tab: string, who: Staff = owner) => who.agent.get(`/ops/workspaces/${a.id}/${tab}`);
    const usage = await get('usage');
    expect(usage.status).toBe(200);
    expect(usage.body.limits[0]).toEqual({ key: 'seats', used: 21, max: 25 });
    expect(usage.body.averageDailyActive).toBe(16);
    expect(usage.body.features).toEqual([expect.objectContaining({ feature: 'gantt', times: 1 })]);
    expect((await get('projects')).body).toMatchObject({ items: [], active: 0, archived: 0 });
    const members = (await get('members')).body;
    expect(members.seats).toBe(21);
    expect(members.items).toHaveLength(22);
    expect(members.items[0]).toMatchObject({ role: 'owner', login: [], mfaEnabled: false });
    expect(members.invitations).toHaveLength(1);
    expect((await get('members', engineer)).body.invitations[0].email).toBeNull();
    const integ = (await get('integrations')).body;
    expect(integ.webhooks).toEqual([expect.objectContaining({ name: 'Discord', urlLast4: 'abcd' })]);
    expect(JSON.stringify(integ)).not.toContain('url_encrypted');
    expect((await get('security')).status).toBe(200);
    const bill = (await get('billing', finance)).body;
    expect(bill.profile).toMatchObject({ taxId: '0105500000001' });
    expect(bill.onTime).toEqual({ paid: 1, onTime: 1 });
    expect(bill.history[0]).toMatchObject({ kind: 'new', mrrAfter: 300_000 });
    const sb = (await get('billing', support)).body;
    expect(sb.profile).toEqual({ companyName: 'บริษัท สยามเดโม จำกัด' });
    expect(sb.invoices[0].total).toBeNull();
    expect(sb.creditBalanceSatang).toBeNull();
    expect((await get('billing', engineer)).status).toBe(403);
    const sup = (await get('support')).body;
    expect(sup.tickets).toHaveLength(2);
    expect(sup.csatAverage).toBe(5);
    expect((await get('audit')).body.items).toEqual(expect.any(Array));
    expect((await get('audit', engineer)).status).toBe(403);
    expect((await owner.agent.get(`/ops/workspaces/${randomUUID()}/usage`)).status).toBe(404);
  });

  it('บันทึกภายใน: ลูกค้าไม่เห็น · วิศวกรเพิ่มไม่ได้', async () => {
    const r = await support.agent.post(`/ops/workspaces/${a.id}/notes`).send({ text: 'สนใจ Enterprise ไตรมาสหน้า' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ text: 'สนใจ Enterprise ไตรมาสหน้า', staffName: 'Sam Support' });
    expect((await owner.agent.get(`/ops/workspaces/${a.id}`)).body.notes[0]).toMatchObject({ text: 'สนใจ Enterprise ไตรมาสหน้า', staffName: 'Sam Support' });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND summary LIKE '%Enterprise ไตรมาส%'`, [a.id])).rows[0].n).toBe(0);
    expect((await engineer.agent.post(`/ops/workspaces/${a.id}/notes`).send({ text: 'x' })).status).toBe(403);
    expect((await support.agent.post(`/ops/workspaces/${a.id}/notes`).send({ text: '' })).status).toBe(400);
  });
});

describe('เปลี่ยนแพ็กเกจ', () => {
  it('ตัวอย่างยอด: อัปเกรดคิดส่วนต่างตามวัน · ลดแพ็กเกจมีผลรอบถัดไป · ที่นั่งเกินเลือกไม่ได้', async () => {
    const up = await finance.agent.get(`/ops/workspaces/${a.id}/change-plan/preview?plan=team_l`);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body).toMatchObject({ current: { plan: 'team_m', priceSatang: 300_000 }, next: { plan: 'team_l', priceSatang: 550_000 }, seatsInUse: 21, blocked: null, effective: 'now' });
    // รอบ 30 วัน เหลือ 25 วัน → (550,000 − 300,000) × 25 / 30
    expect(up.body.subtotalSatang).toBe(Math.round((250_000 * 25) / 30));
    expect(up.body.vatSatang).toBe(Math.round(up.body.subtotalSatang * 0.07));
    const down = await finance.agent.get(`/ops/workspaces/${a.id}/change-plan/preview?plan=team_s`);
    expect(down.body).toMatchObject({ effective: 'next_cycle', blocked: { code: 'seats_exceed_plan' }, totalSatang: 0 });
    const yearly = await finance.agent.get(`/ops/workspaces/${a.id}/change-plan/preview?plan=team_m&cycle=yearly`);
    expect(yearly.body.lines).toHaveLength(2);
    expect(yearly.body.lines[1].satang).toBeLessThan(0);
    expect((await support.agent.get(`/ops/workspaces/${a.id}/change-plan/preview?plan=team_l`)).status).toBe(403);
  });

  it('เปลี่ยนจริง: ที่นั่งเกิน → 409 · สำเร็จบันทึก subscription_changes ให้ MRR ตรง', async () => {
    const no = await finance.agent.post(`/ops/workspaces/${a.id}/change-plan`).send({ plan: 'team_s', reason: 'ลูกค้าขอลด' });
    expect(no.status).toBe(409);
    expect(no.body.error).toMatchObject({ code: 'seats_exceed_plan', details: { seats: 21, seatLimit: 3 } });
    const ok = await finance.agent.post(`/ops/workspaces/${a.id}/change-plan`).send({ plan: 'team_l', reason: 'ลูกค้าขอทาง Ticket #498' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [ch] = (await t.owner.query(`SELECT kind, plan_from, plan_to, mrr_before_satang::int AS b, mrr_after_satang::int AS a, actor_kind FROM subscription_changes WHERE workspace_id = $1 AND actor_kind = 'staff'`, [a.id])).rows;
    expect(ch).toEqual({ kind: 'upgrade', plan_from: 'team_m', plan_to: 'team_l', b: 300_000, a: 550_000, actor_kind: 'staff' });
    expect((await finance.agent.post(`/ops/workspaces/${a.id}/change-plan`).send({ plan: 'team_l', reason: 'ซ้ำ' })).body.error.code).toBe('no_change');
    expect(await auditOf(a.id, 'ops.plan_changed')).toHaveLength(1);
  });

  it('อัปเกรดออกใบแจ้งหนี้ส่วนต่างตามวันที่เหลือ (ครบกำหนด 7 วัน) · ไม่มีข้อมูลออกใบกำกับ → เปลี่ยนแล้วแต่เตือน', async () => {
    // a: team_l แล้ว (จากข้อก่อน) · เปลี่ยนเป็นรายปี = ใบรายปีหักเครดิตส่วนที่เหลือ
    await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email) VALUES ($1,'บริษัท ตัวอย่างอัปเกรด จำกัด','0105500000001','กรุงเทพฯ','acc@up.example.com') ON CONFLICT (workspace_id) DO NOTHING`, [a.id]);
    const pv = (await finance.agent.get(`/ops/workspaces/${a.id}/change-plan/preview?plan=team_l&cycle=yearly`)).body;
    const r = await finance.agent.post(`/ops/workspaces/${a.id}/change-plan`).send({ plan: 'team_l', cycle: 'yearly', reason: 'ลูกค้าขอเปลี่ยนเป็นรายปี' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ effective: 'now', warnings: [], invoice: { number: expect.any(String) } });
    const inv = (await t.owner.query(`SELECT subtotal::int, status, due_date - current_date AS days FROM invoices WHERE id = $1`, [r.body.invoice.id])).rows[0];
    expect(inv).toMatchObject({ subtotal: pv.subtotalSatang, status: 'open' });
    expect(Number(inv.days)).toBeGreaterThanOrEqual(6);
    // ไม่มีข้อมูลออกใบกำกับ: เปลี่ยนสำเร็จ แต่บอกให้การเงินออกเอง
    const b2 = await customer(t, 'no-profile-up', { plan: 'team_s', status: 'active' });
    const w = await finance.agent.post(`/ops/workspaces/${b2.id}/change-plan`).send({ plan: 'team_m', reason: 'ลูกค้าขออัปเกรด' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body).toMatchObject({ effective: 'now', invoice: null, warnings: [{ code: 'billing_profile_required' }] });
  });

  it('ลดแพ็กเกจ: ตั้งไว้มีผลเมื่อจบรอบ · ยกเลิกได้ · ถึงเวลาแล้วเปลี่ยนให้พร้อม MRR และ Audit', async () => {
    const c2 = await customer(t, 'down-later', { plan: 'team_m', status: 'active' });
    const r = await finance.agent.post(`/ops/workspaces/${c2.id}/change-plan`).send({ plan: 'team_s', reason: 'ทีมเล็กลง' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ effective: 'next_cycle', invoice: null });
    const pending = async () => (await t.owner.query(`SELECT p.code AS plan, q.code AS pending FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN plans q ON q.id = s.pending_plan_id WHERE s.workspace_id = $1`, [c2.id])).rows[0];
    expect(await pending()).toEqual({ plan: 'team_m', pending: 'team_s' });
    // เลือกแพ็กเกจเดิม = ยกเลิกที่ตั้งไว้
    expect((await finance.agent.post(`/ops/workspaces/${c2.id}/change-plan`).send({ plan: 'team_m', reason: 'ลูกค้าเปลี่ยนใจ' })).body.effective).toBe('cancelled');
    expect(await pending()).toEqual({ plan: 'team_m', pending: null });
    await finance.agent.post(`/ops/workspaces/${c2.id}/change-plan`).send({ plan: 'team_s', reason: 'ทีมเล็กลงจริง' });
    const svc = t.app.get(BillingService);
    expect((await svc.applyScheduledPlans()).filter((x) => x.workspaceId === c2.id)).toEqual([]);
    await t.owner.query(`UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute' WHERE workspace_id = $1`, [c2.id]);
    expect((await svc.applyScheduledPlans()).filter((x) => x.workspaceId === c2.id)).toEqual([{ workspaceId: c2.id, from: 'team_m', to: 'team_s' }]);
    expect(await pending()).toEqual({ plan: 'team_s', pending: null });
    const [ch] = (await t.owner.query(`SELECT kind, plan_to, mrr_after_satang::int AS a, actor_kind FROM subscription_changes WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [c2.id])).rows;
    expect(ch).toEqual({ kind: 'downgrade', plan_to: 'team_s', a: 150_000, actor_kind: 'system' });
    expect(await auditOf(c2.id, 'billing.plan_downgraded')).toHaveLength(1);
  });
});

describe('โอนความเป็นเจ้าของ (C7)', () => {
  let newOwner = '';
  let approvalId = '';

  it('ต้องแตะ key ซ้ำ · หลักฐานต้องครบ · Owner ใหม่ต้องเป็นสมาชิก · สร้างคำขอ 202 และแจ้ง Owner เดิม', async () => {
    newOwner = (await t.owner.query(`SELECT user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'dev0@siam-demo.example.com'`)).rows[0].user_id;
    const body = { newOwnerUserId: newOwner, ticketNo: '#503', reason: 'Owner เดิมลาออก บริษัทแจ้งผ่าน Ticket', evidence: { companyLetter: true, legalNameMatches: true } };
    const url = `/ops/workspaces/${a.id}/transfer-owner`;
    expect((await support.agent.post(url).send(body)).body.error.code).toBe('reauth_required');
    await reauth(support);
    expect((await support.agent.post(url).send({ ...body, evidence: { companyLetter: true, legalNameMatches: false } })).body.error).toMatchObject({ code: 'evidence_incomplete', details: { missing: ['legalNameMatches'] } });
    expect((await support.agent.post(url).send({ ...body, newOwnerUserId: b.owner })).body.error.code).toBe('new_owner_not_member');
    const guest = (await t.owner.query(`SELECT id FROM users WHERE email = 'guest@partner.example.com'`)).rows[0].id;
    expect((await support.agent.post(url).send({ ...body, newOwnerUserId: guest })).body.error.code).toBe('new_owner_guest');
    expect((await finance.agent.post(url).send(body)).status).toBe(403);

    const before = mail.sent.length;
    const r = await support.agent.post(url).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ pendingApproval: { kind: 'workspace.transfer_owner', status: 'pending' }, notified: 1 });
    approvalId = r.body.pendingApproval.id;
    const notice = mail.sent.slice(before).find((m) => m.to === 'owner@siam-demo.example.com');
    expect(notice?.text).toContain('7 วัน');
    expect((await support.agent.post(url).send(body)).body.error.code).toBe('transfer_pending');
    expect(await auditOf(a.id, 'ops.owner_transfer_requested')).toHaveLength(1);
  });

  it('อนุมัติก่อนครบ 7 วัน → 409 คำขอยังรออยู่ · ครบแล้ว → Owner ใหม่ / Owner เดิมเป็น Admin', async () => {
    await reauth(owner);
    const early = await owner.agent.post(`/ops/approvals/${approvalId}/approve`).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('objection_window_open');
    expect((await t.owner.query(`SELECT status FROM approval_requests WHERE id = $1`, [approvalId])).rows[0].status).toBe('pending');
    await t.owner.query(`UPDATE approval_requests SET payload = jsonb_set(payload, '{noticeSentAt}', to_jsonb($2::text)) WHERE id = $1`, [approvalId, new Date(Date.now() - 8 * DAY).toISOString()]);
    const ok = await owner.agent.post(`/ops/approvals/${approvalId}/approve`).send({ note: 'ไม่มีการคัดค้าน' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const roles = (await t.owner.query(`SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2)`, [a.id, [newOwner, a.owner]])).rows;
    expect(Object.fromEntries(roles.map((r) => [r.user_id, r.role]))).toEqual({ [newOwner]: 'owner', [a.owner]: 'admin' });
    const [log] = await auditOf(a.id, 'ops.owner_transferred');
    expect(log).toMatchObject({ actor_kind: 'friday_staff' });
  });
});

describe('ขอสิทธิ์เข้าบัญชีจากลูกค้า (C2)', () => {
  it('ยังไม่เปิด → อีเมลถึง Owner + Audit · เปิดอยู่แล้ว → 409 · Support เท่านั้น', async () => {
    const body = { ticketNo: '#509', reason: 'ตรวจ Webhook ที่ไม่ส่งเข้า Discord', hours: 1 };
    const before = mail.sent.length;
    const r = await support.agent.post(`/ops/workspaces/${b.id}/support-access-request`).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ sent: 1, owners: 1 });
    expect(mail.sent.slice(before)[0]).toMatchObject({ to: 'owner@orbit-demo.example.com', subject: expect.stringContaining('#509') });
    expect(await auditOf(b.id, 'support.access_requested')).toHaveLength(1);
    expect((await support.agent.post(`/ops/workspaces/${b.id}/support-access-request`).send({ ...body, mode: 'write' })).status).toBe(400);
    await t.owner.query(`INSERT INTO support_access_grants (workspace_id, granted_by, until) VALUES ($1, $2, now() + interval '1 day')`, [b.id, b.owner]);
    expect((await support.agent.post(`/ops/workspaces/${b.id}/support-access-request`).send(body)).body.error.code).toBe('support_access_already_granted');
    expect((await finance.agent.post(`/ops/workspaces/${b.id}/support-access-request`).send(body)).status).toBe(403);
  });
});

describe('ผู้ใช้ทั้งระบบ', () => {
  let user = '';
  const base = { ticketNo: '#515', reason: 'ผู้ใช้ติดต่อมาทาง Ticket' };

  beforeAll(async () => {
    user = (await t.owner.query(`SELECT id FROM users WHERE email = 'dev1@siam-demo.example.com'`)).rows[0].id;
  });

  it('ค้น / กรองสถานะ · Owner และ Support เท่านั้น', async () => {
    await t.owner.query(`UPDATE users SET locked_until = now() + interval '1 hour', failed_login_count = 5 WHERE id = $1`, [user]);
    const r = await support.agent.get('/ops/users?q=dev1@');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, items: [{ id: user, status: 'locked', workspaces: 1, firstWorkspace: 'Co siam-demo', login: [], mfaEnabled: false, lineBound: false }] });
    expect((await support.agent.get('/ops/users?status=locked')).body.items.map((x: { id: string }) => x.id)).toEqual([user]);
    expect((await owner.agent.get('/ops/users')).status).toBe(200);
    expect((await finance.agent.get('/ops/users')).status).toBe(403);
    expect((await engineer.agent.get('/ops/users')).status).toBe(403);
    const d = await support.agent.get(`/ops/users/${user}`);
    expect(d.body).toMatchObject({ email: 'dev1@siam-demo.example.com', status: 'locked', memberships: [{ slug: 'siam-demo', role: 'member' }], sessions: [], tickets: [] });
    expect((await support.agent.get(`/ops/users/${randomUUID()}`)).status).toBe(404);
  });

  it('ปลดล็อก · ส่งอีเมลยืนยันซ้ำ · ทุกข้อแจ้งผู้ใช้และลง Audit ของ Workspace', async () => {
    const before = mail.sent.length;
    expect((await support.agent.post(`/ops/users/${user}/unlock`).send(base)).body).toEqual({ id: user, status: 'unlocked' });
    expect((await t.owner.query(`SELECT locked_until, failed_login_count FROM users WHERE id = $1`, [user])).rows[0]).toEqual({ locked_until: null, failed_login_count: 0 });
    expect((await support.agent.post(`/ops/users/${user}/unlock`).send(base)).body.error.code).toBe('not_locked');
    expect(mail.sent.slice(before).map((m) => m.to)).toEqual(['dev1@siam-demo.example.com']);
    expect((await auditOf(a.id, 'ops.user_unlocked'))[0]).toMatchObject({ actor_kind: 'friday_staff', summary: expect.stringContaining('#515') });

    expect((await support.agent.post(`/ops/users/${user}/resend-verification`).send(base)).body.error.code).toBe('already_verified');
    await t.owner.query(`UPDATE users SET email_verified_at = NULL WHERE id = $1`, [user]);
    const r = await support.agent.post(`/ops/users/${user}/resend-verification`).send(base);
    expect(r.body).toEqual({ id: user, sent: true });
    expect(mail.sent[mail.sent.length - 1].text).toMatch(/\/signup\?token=/);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL`, [user])).rows[0].n).toBe(1);
    expect((await support.agent.post(`/ops/users/${user}/unlock`).send({ reason: 'ไม่มี Ticket' })).status).toBe(400);
    expect((await finance.agent.post(`/ops/users/${user}/unlock`).send(base)).status).toBe(403);
  });

  it('รีเซ็ต 2FA: แตะ key ซ้ำ + หลักฐานอย่างน้อย 2 ข้อ · บันทึกหลักฐานใน Audit', async () => {
    await t.owner.query(`INSERT INTO mfa_factors (user_id, secret_enc, enabled_at) VALUES ($1, 'enc', now())`, [user]);
    const fresh = await staff(t, 'support2@friday.example.com', 'Sue Support', 'support');
    const body = { ...base, proofs: ['email_reply', 'workspace_owner'] };
    expect((await fresh.agent.post(`/ops/users/${user}/reset-2fa`).send(body)).body.error.code).toBe('reauth_required');
    await reauth(fresh);
    expect((await fresh.agent.post(`/ops/users/${user}/reset-2fa`).send({ ...body, proofs: ['email_reply', 'email_reply'] })).status).toBe(400);
    const r = await fresh.agent.post(`/ops/users/${user}/reset-2fa`).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM mfa_factors WHERE user_id = $1`, [user])).rows[0].n).toBe(0);
    expect((await auditOf(a.id, 'ops.mfa_reset'))[0].summary).toContain('Owner ของ Workspace ยืนยัน');
    expect((await fresh.agent.post(`/ops/users/${user}/reset-2fa`).send(body)).body.error.code).toBe('mfa_not_enabled');
  });

  it('เปลี่ยนอีเมล: ส่งลิงก์ไปอีเมลใหม่ + แจ้งอีเมลเดิม · อีเมลซ้ำ → 409', async () => {
    const body = { ...base, newEmail: 'Dev1.New@siam-demo.example.com', proofs: ['email_reply', 'video_call'] };
    await reauth(support);
    expect((await support.agent.post(`/ops/users/${user}/change-email`).send({ ...body, newEmail: 'dev2@siam-demo.example.com' })).body.error.code).toBe('email_taken');
    const before = mail.sent.length;
    const r = await support.agent.post(`/ops/users/${user}/change-email`).send(body);
    expect(r.body).toEqual({ id: user, pendingEmail: 'dev1.new@siam-demo.example.com' });
    expect(mail.sent.slice(before).map((m) => m.to)).toEqual(['dev1.new@siam-demo.example.com', 'dev1@siam-demo.example.com']);
    expect((await t.owner.query(`SELECT new_email FROM auth_tokens WHERE user_id = $1 AND purpose = 'change_email' AND used_at IS NULL`, [user])).rows).toEqual([{ new_email: 'dev1.new@siam-demo.example.com' }]);
    expect((await t.owner.query(`SELECT email FROM users WHERE id = $1`, [user])).rows[0].email).toBe('dev1@siam-demo.example.com');
  });

  it('ออกจากทุกอุปกรณ์ · ปิดบัญชี (พิมพ์อีเมลยืนยัน · Owner คนเดียวปิดไม่ได้)', async () => {
    await t.owner.query(`INSERT INTO user_sessions (user_id, token_hash) VALUES ($1, $2), ($1, $3)`, [user, randomUUID(), randomUUID()]);
    expect((await support.agent.post(`/ops/users/${user}/sign-out-all`).send(base)).body).toEqual({ id: user, revoked: 2 });
    await reauth(support);
    expect((await support.agent.post(`/ops/users/${user}/close`).send({ ...base, confirmEmail: 'wrong@example.com' })).body.error.code).toBe('confirm_mismatch');
    const sole = await support.agent.post(`/ops/users/${b.owner}/close`).send({ ...base, confirmEmail: 'owner@orbit-demo.example.com' });
    expect(sole.body.error).toMatchObject({ code: 'sole_owner', details: { workspaces: [{ slug: 'orbit-demo' }] } });
    const r = await support.agent.post(`/ops/users/${user}/close`).send({ ...base, confirmEmail: 'DEV1@siam-demo.example.com' });
    expect(r.body).toEqual({ id: user, status: 'disabled' });
    expect((await t.owner.query(`SELECT status FROM workspace_members WHERE user_id = $1`, [user])).rows[0].status).toBe('deactivated');
    expect((await support.agent.get(`/ops/users/${user}`)).body.status).toBe('disabled');
    expect(await auditOf(a.id, 'ops.user_closed')).toHaveLength(1);
    expect((await support.agent.post(`/ops/users/${user}/close`).send({ ...base, confirmEmail: 'dev1@siam-demo.example.com' })).body.error.code).toBe('user_disabled');
  });
});
