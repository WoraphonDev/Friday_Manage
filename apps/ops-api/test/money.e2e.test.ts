// O03 · งานเงินในหลังบ้าน · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../src/billing/billing.service.js';
import { Mailer } from '../src/mail.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let owner: Staff;
let finance: Staff;
let support: Staff;
let auditor: Staff;
let c: Customer;
const DAY = 86_400_000;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 7 * 3_600_000 - n * DAY).toISOString().slice(0, 10);
let seq = 0;

/** ใบแจ้งหนี้ + รายการชำระสมมติ */
async function invoice(ws: Customer, o: { amountDue?: number; subtotal?: number; vat?: number; wht?: number; status?: string; due?: string; paidDaysAgo?: number; pay?: { method?: string; amount?: number; status?: string; exception?: string | null; slip?: boolean } | null; periodEnd?: string } = {}) {
  const subtotal = o.subtotal ?? 300_000;
  const vat = o.vat ?? Math.round(subtotal * 0.07);
  const wht = o.wht ?? 0;
  const due = o.amountDue ?? subtotal + vat - wht;
  const paid = o.status === 'paid';
  const inv = (await t.owner.query(
    `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, wht_amount, amount_due, status, due_date, paid_at)
     VALUES ($1,$2,$3,current_date,$4::date,$5,$6,$7,$8,$9,$10::invoice_status,$11::date, CASE WHEN $10::text = 'paid' THEN now() - make_interval(days => $12) END) RETURNING *`,
    [ws.id, ws.sub, `FRI-T${++seq}-${randomUUID().slice(0, 4)}`, o.periodEnd ?? daysAgo(-29), subtotal, vat, subtotal + vat, wht, due, o.status ?? 'open', o.due ?? daysAgo(-7), o.paidDaysAgo ?? 1],
  )).rows[0];
  let payment: string | null = null;
  if (o.pay !== null) {
    const p = o.pay ?? {};
    payment = (await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, status, exception_reason, slip_file_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ws.id, inv.id, p.method ?? 'transfer', p.amount ?? due, p.status ?? (paid ? 'confirmed' : 'pending_review'), p.exception ?? null, p.slip ? 'slips/x.png' : null])).rows[0].id;
  }
  return { inv, payment: payment! };
}
const audit = async (ws: string, action: string) => (await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [ws, action])).rows;

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', 'admin');
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  auditor = await staff(t, 'audit@office.example.com', 'Aud Office', ['auditor']);
  c = await customer(t, 'money-demo', { plan: 'team_m', status: 'active' });
  await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email, wht_enabled) VALUES ($1, 'บริษัท เงินเดโม จำกัด', '0105500000002', '2 ถนนสมมติ', 'acc@money-demo.example.com', true)`, [c.id]);
});
afterAll(() => t.close());

describe('คิวกรณีผิดปกติ', () => {
  it('แสดงเฉพาะรายการที่ระบบยืนยันเองไม่ได้ พร้อมยอดที่ต้องได้ / ได้รับ และสิ่งที่ระบบแนะนำ · Support เปิดไม่ได้', async () => {
    const a = await invoice(c, { pay: { amount: 312_000, exception: 'wht_not_declared', slip: true } });
    await invoice(c, { pay: { slip: true } }); // ปกติ ไม่เข้าคิว
    const r = await finance.agent.get('/ops/payments/exceptions');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ id: a.payment, reason: 'wht_not_declared', expectedSatang: 321_000, receivedSatang: 312_000, suggestion: expect.stringContaining('50 ทวิ'), workspace: { slug: 'money-demo' } });
    expect((await auditor.agent.get('/ops/payments/exceptions')).status).toBe(200);
    expect((await support.agent.get('/ops/payments/exceptions')).status).toBe(403);
    expect((await finance.agent.get('/ops/payments/exceptions?reason=duplicate_slip')).body.items).toHaveLength(0);
  });

  it('ติดเหตุเอง → ผ่าน: ใบแจ้งหนี้ paid ออกใบกำกับภาษี ล้างเหตุผิดปกติ · ผ่านซ้ำ → 409', async () => {
    const a = await invoice(c, { pay: { slip: true } });
    const f = await finance.agent.post(`/ops/payments/${a.payment}/flag`).send({ reason: 'payer_name_mismatch', note: 'ชื่อผู้โอนเป็นบุคคล' });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect((await finance.agent.get('/ops/payments/exceptions?reason=payer_name_mismatch')).body.items).toHaveLength(1);
    const ok = await finance.agent.post(`/ops/payments/${a.payment}/confirm`).send({ note: 'ลูกค้ายืนยันว่าเป็นกรรมการ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const p = (await t.owner.query(`SELECT status, verified_by, exception_reason FROM payments WHERE id = $1`, [a.payment])).rows[0];
    expect(p).toEqual({ status: 'confirmed', verified_by: 'staff', exception_reason: null });
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [a.inv.id])).rows[0].status).toBe('paid');
    expect((await t.owner.query(`SELECT doc_type FROM tax_documents WHERE invoice_id = $1`, [a.inv.id])).rows).toEqual([{ doc_type: 'tax_invoice_receipt' }]);
    expect((await finance.agent.post(`/ops/payments/${a.payment}/confirm`).send({})).body.error.code).toBe('already_confirmed');
  });

  it('ไม่ผ่าน (B6): ส่งข้อความที่กำหนดถึงลูกค้า', async () => {
    const a = await invoice(c, { pay: { exception: 'duplicate_slip', slip: true } });
    const before = mail.sent.length;
    const r = await finance.agent.post(`/ops/payments/${a.payment}/reject`).send({ reason: 'สลิปซ้ำ', message: 'สลิปนี้เคยใช้ชำระใบแจ้งหนี้อื่นแล้ว กรุณาส่งสลิปใหม่' });
    expect(r.status).toBe(200);
    const sent = mail.sent.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual(['acc@money-demo.example.com', 'owner@money-demo.example.com']);
    expect(sent[0].text).toContain('เคยใช้ชำระใบแจ้งหนี้อื่นแล้ว');
  });

  it('ผูกกับใบแจ้งหนี้อื่น (B7): ยอดเกินเป็นเครดิต · ยอดขาดใบยังค้าง · ต่าง Workspace ไม่ได้', async () => {
    const stray = await invoice(c, { pay: { amount: 400_000, exception: 'unmatched', slip: true } });
    const target = await invoice(c, { pay: null });
    const other = await customer(t, 'money-other', { plan: 'team_s', status: 'active' });
    const foreign = await invoice(other, { pay: null });
    expect((await finance.agent.post(`/ops/payments/${stray.payment}/match`).send({ invoiceId: foreign.inv.id, reason: 'ลองผูก' })).body.error.code).toBe('invoice_not_found');
    const r = await finance.agent.post(`/ops/payments/${stray.payment}/match`).send({ invoiceId: target.inv.id, reason: 'Ref.1 ตรงกับใบนี้' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ settled: true, creditSatang: 400_000 - 321_000, remainingSatang: 0 });
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [target.inv.id])).rows[0].status).toBe('paid');
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [stray.inv.id])).rows[0].status).toBe('open');
    expect((await t.owner.query(`SELECT matched_invoice_id FROM payments WHERE id = $1`, [stray.payment])).rows[0].matched_invoice_id).toBe(target.inv.id);
    expect((await t.owner.query(`SELECT amount_satang::int AS a, source FROM workspace_credits WHERE invoice_id = $1`, [target.inv.id])).rows).toEqual([{ a: 79_000, source: 'overpayment' }]);

    const short = await invoice(c, { pay: { amount: 100_000, exception: 'amount_mismatch', slip: true } });
    const t2 = await invoice(c, { pay: null });
    const s2 = await finance.agent.post(`/ops/payments/${short.payment}/match`).send({ invoiceId: t2.inv.id, reason: 'จ่ายบางส่วน' });
    expect(s2.body).toMatchObject({ settled: false, remainingSatang: 221_000 });
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [t2.inv.id])).rows[0].status).toBe('open');
  });

  it('จ่ายซ้ำ: ผ่านไม่ได้ · เก็บเป็นเครดิตได้', async () => {
    const a = await invoice(c, { status: 'paid' });
    const dup = (await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, provider_ref, exception_reason) VALUES ($1,$2,'promptpay',321000,'pp_fake_dup','double_payment') RETURNING id`, [c.id, a.inv.id])).rows[0].id;
    expect((await finance.agent.post(`/ops/payments/${dup}/confirm`).send({})).body.error.code).toBe('double_payment');
    const r = await finance.agent.post(`/ops/payments/${dup}/to-credit`).send({ reason: 'ลูกค้าจ่ายซ้ำ ขอเก็บไว้รอบหน้า' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: dup, creditSatang: 321_000 });
    expect(await audit(c.id, 'ops.payment_to_credit')).toHaveLength(1);
  });

  it('รายการเงินเข้าวันนี้: ผู้ยืนยันและสถานะกระทบยอด · ไม่แสดงเลขอ้างอิงสลิปภายใน', async () => {
    const r = await finance.agent.get('/ops/payments/incoming');
    expect(r.status).toBe(200);
    expect(r.body.date).toBe(today());
    const confirmed = r.body.items.filter((i: { status: string }) => i.status === 'confirmed');
    expect(confirmed.length).toBeGreaterThan(0);
    expect(confirmed.every((i: { reconciliation: string }) => i.reconciliation === 'manual')).toBe(true);
    expect(r.body.items.some((i: { status: string }) => i.status === 'rejected')).toBe(false);
    expect(r.body.totalSatang).toBeGreaterThan(0);
  });
});

describe('ใบแจ้งหนี้', () => {
  let manual = '';

  it('สร้างด้วยมือ (B1): ส่วนลด หัก ณ ที่จ่าย PO · ออกเลขต่อเนื่อง · ส่งอีเมล · ต้องมีข้อมูลออกใบกำกับ', async () => {
    const before = mail.sent.length;
    const r = await finance.agent.post('/ops/invoices').send({
      workspaceId: c.id, poNumber: 'PO-DEMO-0412', dueDays: 30, discountPct: 10, wht: true,
      items: [{ description: 'Team M รายปี 2570', qty: 1, unitSatang: 3_000_000 }, { description: 'ที่นั่งเพิ่ม', qty: 5, unitSatang: 100_000 }],
      plan: { code: 'team_l', cycle: 'yearly', periodStart: daysAgo(0), periodEnd: daysAgo(-364) },
      note: 'ตามใบเสนอราคา QT-DEMO-088',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // (3,000,000 + 500,000) − 10% = 3,150,000 · VAT 220,500 · หัก 3% 94,500
    expect(r.body.invoice).toMatchObject({ subtotal: 3_150_000, vat: 220_500, total: 3_370_500, whtAmount: 94_500, amountDue: 3_276_000, status: 'open' });
    expect(r.body.invoice.number).toMatch(/^FRI-\d{4}-\d{4}$/);
    expect(r.body.sent).toBe(2);
    expect(mail.sent.slice(before)[0].text).toContain('PO-DEMO-0412');
    manual = r.body.invoice.id;
    const meta = JSON.parse((await t.owner.query(`SELECT summary FROM audit_logs WHERE target_id = $1 AND action = 'billing.checkout'`, [manual])).rows[0].summary);
    expect(meta).toMatchObject({ plan: 'team_l', cycle: 'yearly', manual: true, items: [expect.any(Object), expect.any(Object)] });
    expect((await t.owner.query(`SELECT method, amount::int FROM payments WHERE invoice_id = $1`, [manual])).rows).toEqual([{ method: 'transfer', amount: 3_276_000 }]);
    const next = await finance.agent.post('/ops/invoices').send({ workspaceId: c.id, items: [{ description: 'ค่าอบรม', qty: 1, unitSatang: 500_000 }], send: false });
    expect(Number(next.body.invoice.number.slice(-4))).toBe(Number(r.body.invoice.number.slice(-4)) + 1);

    const other = await customer(t, 'no-profile', { plan: 'team_s', status: 'active' });
    expect((await finance.agent.post('/ops/invoices').send({ workspaceId: other.id, items: [{ description: 'x', qty: 1, unitSatang: 100 }] })).body.error.code).toBe('billing_profile_required');
    expect((await support.agent.post('/ops/invoices').send({ workspaceId: c.id, items: [{ description: 'x', qty: 1, unitSatang: 100 }] })).status).toBe(403);
    expect((await finance.agent.post('/ops/invoices').send({ workspaceId: c.id, items: [] })).status).toBe(400);
  });

  it('ยืนยันชำระใบที่ออกเอง → ต่ออายุแพ็กเกจตามที่ระบุ', async () => {
    const pay = (await t.owner.query(`SELECT id FROM payments WHERE invoice_id = $1`, [manual])).rows[0].id;
    expect((await finance.agent.post(`/ops/payments/${pay}/confirm`).send({})).body).toMatchObject({ status: 'confirmed', granted: true });
    expect((await t.owner.query(`SELECT p.code, s.cycle FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.workspace_id = $1`, [c.id])).rows[0]).toEqual({ code: 'team_l', cycle: 'yearly' });
  });

  it('รายการใบแจ้งหนี้: กรองสถานะ / ค้นเลข PO · ผู้ตรวจดูได้', async () => {
    const r = await auditor.agent.get('/ops/invoices?q=PO-DEMO');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ poNumber: 'PO-DEMO-0412', status: 'paid', taxDocumentStatus: 'pending', workspace: { slug: 'money-demo' } });
    expect((await finance.agent.get('/ops/invoices?status=void')).body.total).toBe(0);
    expect((await support.agent.get('/ops/invoices')).status).toBe(403);
  });

  it('ยกเลิก (B2): ยังไม่ชำระ = void · ชำระแล้วไม่คืนเงิน = ใบลดหนี้ void · เครดิต · คืนเงินเกินวงเงิน → 202', async () => {
    const open = await invoice(c, {});
    const v1 = await finance.agent.post(`/ops/invoices/${open.inv.id}/void`).send({ reason: 'ออกซ้ำ' });
    expect(v1.body).toEqual({ id: open.inv.id, status: 'void', creditNote: null });
    expect((await t.owner.query(`SELECT status FROM payments WHERE id = $1`, [open.payment])).rows[0].status).toBe('rejected');
    expect((await finance.agent.post(`/ops/invoices/${open.inv.id}/void`).send({ reason: 'ซ้ำ' })).body.error.code).toBe('already_void');

    const paid = await invoice(c, { status: 'paid' });
    const v2 = await finance.agent.post(`/ops/invoices/${paid.inv.id}/void`).send({ reason: 'ออกเอกสารซ้ำ', money: 'none' });
    expect(v2.body.creditNote.number).toMatch(/^CN-\d{4}-0001$/);
    expect((await t.owner.query(`SELECT kind, amount_satang::int AS a, vat_satang::int AS v FROM credit_notes WHERE invoice_id = $1`, [paid.inv.id])).rows).toEqual([{ kind: 'void', a: 300_000, v: 21_000 }]);

    const paid2 = await invoice(c, { status: 'paid', subtotal: 40_000 });
    const v3 = await finance.agent.post(`/ops/invoices/${paid2.inv.id}/void`).send({ reason: 'ลดที่นั่งกลางรอบ', money: 'credit' });
    expect(v3.status, JSON.stringify(v3.body)).toBe(200);
    expect(v3.body).toMatchObject({ creditSatang: 42_800, creditNote: { number: expect.stringMatching(/^CN-/) } });
    expect((await t.owner.query(`SELECT status FROM invoices WHERE id = $1`, [paid2.inv.id])).rows[0].status).toBe('void');

    const big = await invoice(c, { status: 'paid', subtotal: 2_000_000 });
    const v4 = await finance.agent.post(`/ops/invoices/${big.inv.id}/void`).send({ reason: 'ยกเลิกสัญญา', money: 'refund' });
    expect(v4.status).toBe(202);
    expect(v4.body.pendingApproval).toMatchObject({ kind: 'billing.refund', amountSatang: 2_140_000 });
    await reauth(owner);
    const ok = await owner.agent.post(`/ops/approvals/${v4.body.pendingApproval.id}/approve`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.result).toMatchObject({ invoiceStatus: 'void', creditNote: { kind: 'refund', amountSatang: 2_000_000, vatSatang: 140_000 } });
  });

  it('ส่งลิงก์จ่าย (B5): เฉพาะผู้ติดต่อของลูกค้า', async () => {
    const open = await invoice(c, {});
    expect((await finance.agent.post(`/ops/invoices/${open.inv.id}/send-link`).send({ to: 'stranger@example.com' })).body.error.code).toBe('recipient_not_contact');
    const r = await finance.agent.post(`/ops/invoices/${open.inv.id}/send-link`).send({ to: 'acc@money-demo.example.com' });
    expect(r.body).toMatchObject({ sent: 1, link: expect.stringContaining('/work/money-demo/billing?invoice=') });
  });
});

describe('ค้างชำระและเตือนอัตโนมัติ', () => {
  let d: Customer;
  let late = '';
  let recent = '';

  beforeAll(async () => {
    d = await customer(t, 'late-demo', { plan: 'team_s', status: 'active' });
    late = (await invoice(d, { due: daysAgo(15) })).inv.id;
    recent = (await invoice(d, { due: daysAgo(2) })).inv.id;
    await invoice(d, { due: daysAgo(10), pay: { slip: true } }); // แนบสลิปรอตรวจ ไม่นับค้าง
  });

  it('งานเตือน: เลย 15 วัน → ระงับ (ขั้นก่อนหน้าบันทึกว่าข้าม) · เลย 2 วัน → เตือนวันที่ 1 · รันซ้ำไม่ส่งซ้ำ', async () => {
    const svc = t.app.get(BillingService);
    const before = mail.sent.length;
    const r = await svc.runDunning();
    const mine = r.processed.filter((p) => p.invoice.startsWith('FRI-T'));
    expect(mine.map((p) => p.step).sort()).toEqual(['d1', 'd14']);
    const ev = (await t.owner.query(`SELECT step, result FROM dunning_events WHERE invoice_id = $1 ORDER BY created_at, result`, [late])).rows;
    expect(ev).toEqual(expect.arrayContaining([{ step: 'suspended', result: 'd14' }, { step: 'reminder', result: 'd1:skipped' }, { step: 'final_notice', result: 'd7:skipped' }]));
    // ค้างชำระ = อ่านอย่างเดียว และเปิดเองเมื่อชำระ
    expect((await t.owner.query(`SELECT status, suspension_mode, suspension_auto_resume FROM workspaces WHERE id = $1`, [d.id])).rows[0]).toEqual({ status: 'suspended', suspension_mode: 'read_only', suspension_auto_resume: true });
    expect((await t.owner.query(`SELECT status FROM subscriptions WHERE workspace_id = $1`, [d.id])).rows[0].status).toBe('past_due');
    expect(mail.sent.slice(before).some((m) => m.subject.includes('ถูกระงับ'))).toBe(true);
    expect(await audit(d.id, 'billing.suspended_overdue')).toHaveLength(1);
    const again = await svc.runDunning();
    expect(again.processed.filter((p) => p.invoice.startsWith('FRI-T'))).toEqual([]);
  });

  it('แท็บค้างชำระ: ประวัติการเตือน ขั้นถัดไป ผู้ติดต่อ · ไม่รวมใบที่แนบสลิปแล้ว', async () => {
    const r = await finance.agent.get('/ops/overdue');
    const mine = r.body.items.filter((i: { workspace: { slug: string } }) => i.workspace.slug === 'late-demo');
    expect(mine.map((i: { id: string }) => i.id)).toEqual([late, recent]);
    expect(mine[1]).toMatchObject({ daysOverdue: 2, nextStep: { day: 3, step: 'reminder' }, needsHuman: false, contacts: ['owner@late-demo.example.com'] });
    expect(mine[0]).toMatchObject({ nextStep: null, needsHuman: true });
  });

  it('ติดต่อ (B3): โทรต้องบันทึกผล · อีเมลส่งจริง · ขยายเวลา (B4) ไม่เกิน 30 วันจากวันเดิม', async () => {
    expect((await finance.agent.post(`/ops/invoices/${recent}/contact`).send({ channel: 'phone' })).status).toBe(400);
    expect((await finance.agent.post(`/ops/invoices/${recent}/contact`).send({ channel: 'phone', result: 'ไม่มีคนรับ' })).body).toMatchObject({ channel: 'phone', result: 'ไม่มีคนรับ' });
    expect((await finance.agent.post(`/ops/invoices/${recent}/contact`).send({ channel: 'email' })).body.result).toBe('sent 1');
    expect((await finance.agent.post(`/ops/invoices/${recent}/extend`).send({ dueDate: daysAgo(-40), reason: 'รอ PO' })).body.error.code).toBe('extend_too_long');
    const ok = await finance.agent.post(`/ops/invoices/${recent}/extend`).send({ dueDate: daysAgo(-10), reason: 'รอ PO จากฝ่ายจัดซื้อ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // ขยายครั้งที่ 2 ยังนับ 30 วันจากวันเดิม
    expect((await finance.agent.post(`/ops/invoices/${recent}/extend`).send({ dueDate: daysAgo(-29), reason: 'ขอเพิ่ม' })).body.error.code).toBe('extend_too_long');
    const ids = (await finance.agent.get('/ops/overdue')).body.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(recent);
    expect(await audit(d.id, 'ops.due_date_extended')).toHaveLength(1);
  });

  it('ชำระใบที่ค้างครบ → เปิดใช้งานเอง (ระงับแบบเปิดเองเมื่อชำระ) · ยังเหลือใบเลยกำหนดไม่เปิด', async () => {
    const ws = async () => (await t.owner.query(`SELECT status, suspension_mode FROM workspaces WHERE id = $1`, [d.id])).rows[0];
    expect(await ws()).toEqual({ status: 'suspended', suspension_mode: 'read_only' });
    const pay = async (inv: string) => (await t.owner.query(`SELECT id FROM payments WHERE invoice_id = $1`, [inv])).rows[0].id;
    // ใบ 10 วัน (แนบสลิปรอตรวจ) ยังไม่ยืนยัน → ใบ late ชำระแล้วก็ยังไม่เปิด
    const other = (await t.owner.query(`SELECT id FROM invoices WHERE workspace_id = $1 AND id NOT IN ($2, $3)`, [d.id, late, recent])).rows[0].id;
    expect((await finance.agent.post(`/ops/payments/${await pay(late)}/confirm`).send({})).status).toBe(200);
    expect((await ws()).status).toBe('suspended');
    expect((await finance.agent.post(`/ops/payments/${await pay(other)}/confirm`).send({})).status).toBe(200);
    expect(await ws()).toEqual({ status: 'active', suspension_mode: null });
    expect(await audit(d.id, 'billing.resumed_paid')).toHaveLength(1);
  });
});

describe('ภาษี', () => {
  it('e-Tax ที่ล้ม ส่งใหม่ได้ · 50 ทวิ ที่รอรับ · สรุปภาษีขายของเดือน', async () => {
    const a = await invoice(c, { status: 'paid', wht: 9_000 });
    const doc = (await t.owner.query(`INSERT INTO tax_documents (workspace_id, invoice_id, doc_type, number, status) VALUES ($1,$2,'tax_invoice_receipt',$3,'failed') RETURNING id`, [c.id, a.inv.id, `TX-${randomUUID().slice(0, 8)}`])).rows[0].id;
    const r = await finance.agent.get('/ops/tax');
    expect(r.status).toBe(200);
    expect(r.body.etax.map((e: { id: string }) => e.id)).toContain(doc);
    expect(r.body.wht.find((w: { id: string }) => w.id === a.inv.id)).toMatchObject({ whtAmount: 9_000, certificateStatus: null });
    expect(r.body.salesVat).toMatchObject({ vatRegistered: true, invoices: expect.any(Number) });
    expect(r.body.salesVat.vatSatang).toBeGreaterThan(0);
    expect((await finance.agent.post(`/ops/tax-documents/${doc}/retry`).send({})).body).toEqual({ id: doc, status: 'pending' });
    expect((await finance.agent.post(`/ops/tax-documents/${doc}/retry`).send({})).body.error.code).toBe('not_failed');
    expect((await support.agent.get('/ops/tax')).status).toBe(403);
  });
});

describe('คืนเงินและเครดิต', () => {
  it('คืนเงินในวงเงินทำได้เลย · เกินยอดที่จ่าย → 422 · เกิน 30 วันหลังชำระ → ต้องอนุมัติ', async () => {
    const a = await invoice(c, { status: 'paid' });
    expect((await finance.agent.post('/ops/refunds').send({ invoiceId: a.inv.id, amountSatang: 400_000, reason: 'ทดสอบเกิน' })).body.error.code).toBe('refund_exceeds_paid');
    const r = await finance.agent.post('/ops/refunds').send({ invoiceId: a.inv.id, amountSatang: 107_000, method: 'bank_transfer', reason: 'ชดเชยนำเข้า Excel ล่ม 2 วัน' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.creditNote).toMatchObject({ kind: 'refund', amountSatang: 100_000, vatSatang: 7_000 });
    expect((await finance.agent.post('/ops/refunds').send({ invoiceId: a.inv.id, amountSatang: 300_000, reason: 'เกินที่เหลือ' })).body.error).toMatchObject({ code: 'refund_exceeds_paid', details: { maxSatang: 214_000 } });
    const old = await invoice(c, { status: 'paid', paidDaysAgo: 45 });
    expect((await finance.agent.post('/ops/refunds').send({ invoiceId: old.inv.id, amountSatang: 10_000, reason: 'ชำระมานาน' })).status).toBe(202);
    expect((await support.agent.post('/ops/refunds').send({ invoiceId: old.inv.id, amountSatang: 10_000, reason: 'x' })).status).toBe(403);
  });

  it('เครดิตน้ำใจ: ในวงเงินทำเลย · เกินวงเงิน → 202 · หน้าคืนเงินมีรายการรออนุมัติและประวัติ', async () => {
    const ok = await finance.agent.post('/ops/credits').send({ workspaceId: c.id, amountSatang: 50_000, reason: 'ขอโทษเรื่องระบบล่ม' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ creditSatang: 50_000, creditNote: null });
    expect((await finance.agent.post('/ops/credits').send({ workspaceId: c.id, amountSatang: 900_000, reason: 'เกินวงเงิน' })).status).toBe(202);
    const r = await auditor.agent.get('/ops/refunds');
    expect(r.status).toBe(200);
    expect(r.body.pending.map((p: { kind: string }) => p.kind).sort()).toEqual(['billing.credit', 'billing.refund']);
    expect(r.body.history.map((h: { type: string }) => h.type)).toEqual(expect.arrayContaining(['refund', 'void', 'credit', 'goodwill_credit']));
  });
});

describe('รายงานรายได้ ปิดงวด และส่งออก', () => {
  it('รายปีกระจายรับรู้ 12 เดือน · มีรายได้รับล่วงหน้า', async () => {
    const r = await auditor.agent.get('/ops/revenue?months=3');
    expect(r.status).toBe(200);
    expect(r.body.months).toHaveLength(3);
    const cur = r.body.months[2];
    expect(cur.month).toBe(today().slice(0, 7));
    expect(cur.cashSatang).toBeGreaterThan(0);
    // ใบรายปีที่ออกเอง (3,150,000) รับรู้เดือนละ 262,500 · ส่วนที่เหลือเป็นรายได้รับล่วงหน้า
    expect(cur.deferredSatang).toBeGreaterThanOrEqual(Math.round(3_150_000 / 12) * 11);
    expect(cur.refundsSatang).toBeGreaterThan(0);
    expect((await support.agent.get('/ops/revenue')).status).toBe(403);
  });

  it('ปิดงวด: แตะ key ซ้ำ · เฉพาะเดือนที่จบแล้ว · ส่งออก CSV (ฉบับร่างก่อนปิด)', async () => {
    const month = today().slice(0, 7);
    const prev = new Date(`${month}-01T00:00:00Z`);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const last = prev.toISOString().slice(0, 7);
    const fresh = await staff(t, 'finance2@friday.example.com', 'Fay Finance', 'finance');
    expect((await fresh.agent.post('/ops/revenue/close').send({ month: last })).body.error.code).toBe('reauth_required');
    await reauth(fresh);
    expect((await fresh.agent.post('/ops/revenue/close').send({ month })).body.error.code).toBe('month_not_ended');
    const csv = await finance.agent.get(`/ops/revenue/export?month=${month}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-report-status']).toBe('draft');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('บริษัท เงินเดโม จำกัด');
    const cn = await finance.agent.get(`/ops/revenue/export?month=${month}&type=credit_notes`);
    expect(cn.text.split('\r\n').filter(Boolean).length).toBeGreaterThan(1);
    expect((await fresh.agent.post('/ops/revenue/close').send({ month: last })).body).toEqual({ month: last, closed: true });
    expect((await fresh.agent.post('/ops/revenue/close').send({ month: last })).body.error.code).toBe('already_closed');
    expect((await finance.agent.get(`/ops/revenue/export?month=${last}&type=wht`)).headers['x-report-status']).toBe('closed');
    expect((await finance.agent.get('/ops/revenue?months=2')).body.months[0]).toMatchObject({ month: last, closed: true });
  });
});
