// รอบ 4 · O40 · แท็บภาษี (E1–E4) · ส่งสำนักงานบัญชี (E5–E6) · 50 ทวิ และ e-WHT (E7–E9) · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountingService } from '../src/billing/accounting.service.js';
import { TaxService } from '../src/billing/tax.service.js';
import { WhtService } from '../src/billing/wht.service.js';
import { Mailer } from '../src/mail.js';
import { PushService } from '../src/push/push.service.js';
import { customer, type Customer, reauth, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mail: Mailer;
let finance: Staff;
let owner: Staff;
let auditor: Staff;
let support: Staff;
let c: Customer;
const DAY = 86_400_000;
const bkk = (offsetDays = 0) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * DAY).toISOString().slice(0, 10);
const thisMonth = () => bkk().slice(0, 7);
const lastMonth = () => {
  const d = new Date(`${thisMonth()}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
let seq = 0;
const uid = () => randomUUID().slice(0, 6);

async function invoice(ws: Customer, o: { subtotal?: number; wht?: number; paidDaysAgo?: number; status?: string } = {}) {
  const subtotal = o.subtotal ?? 1_500_000;
  const vat = Math.round(subtotal * 0.07);
  const wht = o.wht ?? 0;
  return (await t.owner.query(
    `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, wht_amount, amount_due, status, due_date, paid_at)
     VALUES ($1,$2,$3,current_date,current_date + 29,$4,$5,$6,$7,$8,$9::invoice_status,current_date, CASE WHEN $9::text = 'paid' THEN now() - make_interval(days => $10) END) RETURNING *`,
    [ws.id, ws.sub, `FRI-W${++seq}-${uid()}`, subtotal, vat, subtotal + vat, wht, subtotal + vat - wht, o.status ?? 'paid', o.paidDaysAgo ?? 1],
  )).rows[0];
}
async function taxDoc(inv: { id: string }, ws: Customer, o: { status?: string; issuedOn?: string; ref?: string | null; number?: string } = {}) {
  return (await t.owner.query(
    `INSERT INTO tax_documents (workspace_id, invoice_id, doc_type, number, status, issued_on, provider_ref, buyer) VALUES ($1,$2,'tax_invoice_receipt',$3,$4,$5::date,$6,$7) RETURNING *`,
    [ws.id, inv.id, o.number ?? `TX-${uid()}`, o.status ?? 'issued', o.issuedOn ?? bkk(), o.ref === undefined ? `etax-${uid()}` : o.ref, JSON.stringify({ companyName: 'บริษัท ภาษีเดโม จำกัด', taxId: '0105561111111', branchType: 'head', branchNo: null, address: '1 ถนนสมมติ', email: 'acc@tax-demo.example.com' })],
  )).rows[0];
}
const jobOf = async (docId: string, action = 'issue') => (await t.owner.query(`SELECT * FROM etax_jobs WHERE doc_id = $1 AND action = $2`, [docId, action])).rows[0];
const auditRows = async (ws: string, action: string) => (await t.owner.query(`SELECT summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at`, [ws, action])).rows;
const binary = (req: import('supertest').Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  }) as unknown as Promise<{ status: number; body: Buffer; headers: Record<string, string> }>;
/** ชื่อไฟล์ใน ZIP (อ่าน central directory) */
function zipNames(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const n = buf.readUInt16LE(p + 28);
    names.push(buf.subarray(p + 46, p + 46 + n).toString('utf8'));
    p += 46 + n + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

beforeAll(async () => {
  t = await startOps();
  mail = t.app.get(Mailer);
  owner = await staff(t, 'owner@friday.example.com', 'Olive Owner', ['owner']);
  finance = await staff(t, 'finance@friday.example.com', 'Fin Finance', 'finance');
  auditor = await staff(t, 'audit@office.example.com', 'Aud Office', ['auditor']);
  support = await staff(t, 'support@friday.example.com', 'Sam Support', 'support');
  c = await customer(t, 'tax-demo', { plan: 'team_m', status: 'active' });
  await t.owner.query(`INSERT INTO billing_profiles (workspace_id, company_name, tax_id, address, tax_email, wht_enabled) VALUES ($1, 'บริษัท ภาษีเดโม จำกัด', '0105561111111', '1 ถนนสมมติ', 'acc@tax-demo.example.com', true)`, [c.id]);
});
afterAll(() => t.close());

describe('E1 · การ์ดสรุปและรายงานภาษีขาย', () => {
  it('ตัวเลขเดียวกับรายงาน PDF / Excel และหน้ารายงานรายได้ · ใบยกเลิกที่ออกแทนนับครั้งเดียว · เลขขาดตรวจแยกตามชุดเลข', async () => {
    const yymm = `${thisMonth().slice(2, 4)}${thisMonth().slice(5, 7)}`;
    const a = await invoice(c);
    const b = await invoice(c);
    await taxDoc(a, c, { number: `TX-${yymm}-0001` });
    const old = await taxDoc(b, c, { number: `TX-${yymm}-0002`, status: 'cancelled' });
    await t.owner.query(`INSERT INTO tax_documents (workspace_id, invoice_id, doc_type, number, status, issued_on, replaces_id, provider_ref) VALUES ($1,$2,'tax_invoice_receipt',$3,'issued',current_date,$4,'etax-r')`, [c.id, b.id, `TX-${yymm}-0003`, old.id]);
    await t.owner.query(`INSERT INTO etax_jobs (workspace_id, doc_kind, doc_id, action, status, provider_ref) VALUES ($1,'tax_document',$2,'cancel','done','cnl-1')`, [c.id, old.id]);
    await t.owner.query(`INSERT INTO credit_notes (workspace_id, invoice_id, number, kind, amount_satang, vat_satang, reason, status, issued_at) VALUES ($1,$2,$3,'refund',100000,7000,'คืนบางส่วน','issued',now())`, [c.id, a.id, `CN-${yymm}-0001`]);
    await t.owner.query(`INSERT INTO debit_notes (workspace_id, invoice_id, number, amount_satang, vat_satang, reason) VALUES ($1,$2,$3,50000,3500,'คิดขาด')`, [c.id, a.id, `DN-${yymm}-0001`]);
    // ใบ ฿0 จากคูปอง ไม่อยู่ในรายงาน แต่เตือน
    await t.owner.query(`INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, discount, vat, total, wht_amount, amount_due, status, due_date, paid_at) VALUES ($1,$2,$3,current_date,current_date,0,300000,0,0,0,0,'paid',current_date,now())`, [c.id, c.sub, `FRI-Z-${uid()}`]);

    const r = await auditor.agent.get(`/ops/tax?month=${thisMonth()}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kpi.sales).toMatchObject({ tx: 2, dn: 1, cn: 1, value: 1_500_000 * 2 + 50_000 - 100_000, vat: 105_000 * 2 + 3_500 - 7_000 });
    const tx = r.body.sales.lines.find((l: { kind: string }) => l.kind === 'tax_invoice');
    expect(tx).toMatchObject({ count: 2, cancelled: 1, replaced: 1, first: `TX-${yymm}-0001`, last: `TX-${yymm}-0003` });
    const codes = Object.fromEntries(r.body.sales.checks.map((x: { code: string; level: string }) => [x.code, x.level]));
    expect(codes).toMatchObject({ numbers: 'ok', replacements: 'ok', zero_invoices: 'warn' });
    // หน้ารายงานรายได้ใช้สูตรเดียวกัน
    const rev = await auditor.agent.get('/ops/revenue?months=1');
    expect(rev.body.months[0].vatSatang).toBe(r.body.kpi.sales.vat);
    expect((await support.agent.get('/ops/tax')).status).toBe(403);
  });
});

describe('E1–E4 · เอกสาร e-Tax ที่ต้องดู', () => {
  let failedDoc: { id: string; number: string };
  let cancelled: { id: string; number: string };
  let waitingDoc: { id: string; number: string };

  it('ตารางเดียว: ล้ม (มีรหัสและจำนวนครั้ง) · รอแจ้งยกเลิก · รอผลเกิน 1 ชม. · ส่งสำเร็จไม่แสดง', async () => {
    const i1 = await invoice(c);
    failedDoc = await taxDoc(i1, c, { status: 'failed', ref: null });
    await t.owner.query(`INSERT INTO etax_jobs (workspace_id, doc_kind, doc_id, action, status, attempts, last_error, last_attempt_at) VALUES ($1,'tax_document',$2,'issue','failed',3,'E-102 · เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก', now())`, [c.id, failedDoc.id]);
    const i2 = await invoice(c);
    cancelled = await taxDoc(i2, c, { status: 'cancelled' });
    await t.owner.query(`INSERT INTO etax_jobs (workspace_id, doc_kind, doc_id, action, status, attempts, last_error, last_attempt_at, next_attempt_at, created_at) VALUES ($1,'tax_document',$2,'cancel','pending',2,'503 · ผู้ให้บริการปิดปรับปรุง', now(), now() + interval '10 minutes', now() - interval '30 minutes')`, [c.id, cancelled.id]);
    const i3 = await invoice(c);
    waitingDoc = await taxDoc(i3, c, { status: 'submitted' });
    await t.owner.query(`INSERT INTO etax_jobs (workspace_id, doc_kind, doc_id, action, status, attempts, provider_ref, last_attempt_at) VALUES ($1,'tax_document',$2,'issue','submitted',1,'etax-w', now() - interval '2 hours')`, [c.id, waitingDoc.id]);
    const ok = await taxDoc(await invoice(c), c);
    await t.owner.query(`INSERT INTO etax_jobs (workspace_id, doc_kind, doc_id, action, status, attempts) VALUES ($1,'tax_document',$2,'issue','done',1)`, [c.id, ok.id]);

    const r = await finance.agent.get('/ops/tax');
    const items = r.body.etax.items as { docId: string; state: string; problem: string | null; attempts: number; maxAttempts: number }[];
    expect(items.find((x) => x.docId === failedDoc.id)).toMatchObject({ state: 'failed', problem: 'E-102 · เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก', attempts: 3, maxAttempts: 3 });
    expect(items.find((x) => x.docId === cancelled.id)).toMatchObject({ state: 'cancel_pending', attempts: 2, problem: '503 · ผู้ให้บริการปิดปรับปรุง' });
    expect(items.find((x) => x.docId === waitingDoc.id)).toMatchObject({ state: 'waiting' });
    expect(items.some((x) => x.docId === ok.id)).toBe(false);
    expect(r.body.etax.counts).toMatchObject({ failed: 1, cancel: 1, waiting: 1 });
    expect(r.body.kpi.etax.failed).toBeGreaterThanOrEqual(1);
  });

  it('E2 รายละเอียด: ผู้ซื้อที่ล็อก · งานในคิว · ลำดับเหตุการณ์ · ผู้ตรวจเปิดได้', async () => {
    const d = await auditor.agent.get(`/ops/etax/tax-document/${cancelled.id}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ number: cancelled.number, cancelled: true, buyer: { companyName: 'บริษัท ภาษีเดโม จำกัด' }, state: { cancel: 'pending' }, jobs: [expect.objectContaining({ action: 'cancel', attempts: 2, maxAttempts: 3 })] });
    expect((await auditor.agent.get(`/ops/etax/receipt/${cancelled.id}`)).status).toBe(404);
    expect((await auditor.agent.get(`/ops/etax/tax-document/${randomUUID()}`)).status).toBe(404);
  });

  it('ส่งใหม่ / แจ้งอีกครั้ง / ตรวจสถานะ · การเงินเท่านั้น', async () => {
    expect((await auditor.agent.post(`/ops/etax/tax-document/${failedDoc.id}/retry`).send({})).status).toBe(403);
    const r = await finance.agent.post(`/ops/etax/tax-document/${failedDoc.id}/retry`).send({});
    expect(r.body).toMatchObject({ status: 'pending', action: 'issue' });
    expect(await jobOf(failedDoc.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await t.owner.query(`SELECT status FROM tax_documents WHERE id = $1`, [failedDoc.id])).rows[0].status).toBe('pending');
    expect((await finance.agent.post(`/ops/etax/tax-document/${failedDoc.id}/retry`).send({})).body.error.code).toBe('not_failed');
    expect((await finance.agent.post(`/ops/etax/tax-document/${cancelled.id}/retry`).send({ action: 'cancel' })).body).toMatchObject({ action: 'cancel', status: 'pending' });
    expect(await jobOf(cancelled.id, 'cancel')).toMatchObject({ attempts: 0 });
    const chk = await finance.agent.post(`/ops/etax/tax-document/${waitingDoc.id}/check`).send({});
    expect(chk.body).toEqual({ id: waitingDoc.id, queued: 1 });
    expect(new Date((await jobOf(waitingDoc.id)).next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await finance.agent.post(`/ops/etax/tax-document/${failedDoc.id}/check`).send({})).body.error.code).toBe('not_waiting');
  });

  it('E4 ยกเลิกที่ผู้ให้บริการแล้ว: แตะกุญแจ · หยุดลองอัตโนมัติ · บันทึกซ้ำไม่ได้', async () => {
    const body = { reference: 'CNL-2611-00418', reason: 'ระบบผู้ให้บริการปิดปรับปรุงนาน ยกเลิกผ่านหน้าเว็บแทน' };
    const fresh = await staff(t, 'finance3@friday.example.com', 'Fah Finance', 'finance');
    expect((await fresh.agent.post(`/ops/etax/tax-document/${cancelled.id}/cancel-manual`).send(body)).body.error.code).toBe('reauth_required');
    await reauth(fresh);
    const r = await fresh.agent.post(`/ops/etax/tax-document/${cancelled.id}/cancel-manual`).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await jobOf(cancelled.id, 'cancel')).toMatchObject({ status: 'manual', provider_ref: 'CNL-2611-00418', note: body.reason, next_attempt_at: null });
    expect((await fresh.agent.post(`/ops/etax/tax-document/${cancelled.id}/cancel-manual`).send(body)).body.error.code).toBe('already_cancelled');
    expect((await auditRows(c.id, 'ops.etax_cancel_manual')).at(-1).summary).toContain('CNL-2611-00418');
    const list = await finance.agent.get('/ops/tax');
    expect(list.body.etax.items.some((x: { docId: string }) => x.docId === cancelled.id)).toBe(false);
  });

  it('ขอข้อมูลใหม่: อีเมลผู้ติดต่อด้านบัญชีพร้อมลิงก์แก้ข้อมูลออกใบกำกับ', async () => {
    const before = mail.sent.length;
    const r = await finance.agent.post(`/ops/tax-documents/${failedDoc.id}/request-info`).send({});
    expect(r.status).toBe(200);
    expect(r.body.to).toContain('acc@tax-demo.example.com');
    const m = mail.sent.slice(before).find((x) => x.to === 'acc@tax-demo.example.com')!;
    expect(m.subject).toContain(failedDoc.number);
    expect(m.text).toContain('/work/tax-demo/billing');
  });

  it('E3 ออกฉบับใหม่แทน: แจ้งยกเลิกฉบับเดิมอัตโนมัติ · ฉบับใหม่เข้าคิว · ผู้ซื้อตามที่แก้', async () => {
    const inv = await invoice(c);
    const doc = await taxDoc(inv, c, { ref: 'etax-orig' });
    const bad = await finance.agent.post(`/ops/tax-documents/${doc.id}/replace`).send({ reason: 'ชื่อบริษัทผิด', buyer: { companyName: 'บริษัท ใหม่ จำกัด', taxId: '123', branchType: 'head', address: 'x' } });
    expect(bad.status).toBe(400);
    const buyer = { companyName: 'บริษัท ภาษีเดโม (ประเทศไทย) จำกัด', taxId: '0105561111111', branchType: 'branch', branchNo: '00002', address: '2 ถนนสมมติ' };
    const r = await finance.agent.post(`/ops/tax-documents/${doc.id}/replace`).send({ reason: 'ชื่อบริษัทผิด', buyer });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await jobOf(doc.id, 'cancel')).toMatchObject({ status: 'pending', by_staff: finance.id });
    expect(await jobOf(r.body.replacement.id)).toMatchObject({ status: 'pending' });
    const fresh = (await t.owner.query(`SELECT buyer FROM tax_documents WHERE id = $1`, [r.body.replacement.id])).rows[0].buyer;
    expect(fresh).toMatchObject({ ...buyer, email: 'acc@tax-demo.example.com' });
  });

  it('ใบลด / เพิ่มหนี้ที่อ้างใบกำกับภาษี เข้าคิว e-Tax', async () => {
    const inv = await invoice(c);
    await taxDoc(inv, c);
    const v = await finance.agent.post(`/ops/invoices/${inv.id}/void`).send({ reason: 'ออกซ้ำ', money: 'none' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(await jobOf(v.body.creditNote.id)).toMatchObject({ doc_kind: 'credit_note', status: 'pending' });
    const inv2 = await invoice(c);
    await taxDoc(inv2, c);
    const d = await finance.agent.post(`/ops/invoices/${inv2.id}/debit-note`).send({ amountSatang: 60_000, reason: 'คิดค่าที่นั่งเพิ่มขาด' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(await jobOf(d.body.debitNote.id)).toMatchObject({ doc_kind: 'debit_note', status: 'pending' });
  });

  it('งานรายชั่วโมงแจ้งการเงินเมื่อล้มครบ 3 ครั้ง (ครั้งเดียว)', async () => {
    await t.owner.query(`UPDATE etax_jobs SET status = 'failed', attempts = 3 WHERE doc_id = $1 AND action = 'issue'`, [failedDoc.id]);
    const push = t.app.get(PushService);
    const before = push.sent.length;
    const svc = t.app.get(TaxService);
    expect(await svc.notifyFailures()).toBeGreaterThanOrEqual(1);
    expect(push.sent.slice(before).some((p) => p.staffId === finance.id && p.message.body.includes(failedDoc.number))).toBe(true);
    expect(await svc.notifyFailures()).toBe(0);
  });

  it('ปิดงวด: e-Tax ยังไม่ครบต้องกรอกเหตุผล', async () => {
    const day = `${lastMonth()}-15`;
    await taxDoc(await invoice(c), c, { status: 'failed', issuedOn: day, ref: null });
    const fresh = await staff(t, 'finance4@friday.example.com', 'Fon Finance', 'finance');
    await reauth(fresh);
    const no = await fresh.agent.post('/ops/revenue/close').send({ month: lastMonth() });
    expect(no.status).toBe(422);
    expect(no.body.error).toMatchObject({ code: 'etax_incomplete', details: { open: 1 } });
    const ok = await fresh.agent.post('/ops/revenue/close').send({ month: lastMonth(), reason: 'ผู้ให้บริการปิดปรับปรุง ตามส่งต่อในเดือนหน้า' });
    expect(ok.body).toMatchObject({ month: lastMonth(), closed: true, etaxOpen: 1 });
    const note = (await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = 'billing.period_closed_note'`)).rows.at(-1).reason;
    expect(note).toContain('ผู้ให้บริการปิดปรับปรุง');
  });
});

describe('E5–E6 · ส่งสำนักงานบัญชี', () => {
  it('ค่าตั้ง: ครั้งแรกอ่านจาก environment · บันทึกในหน้าจอแล้วใช้ค่านั้น · ตรวจข้อมูล · ผู้ตรวจแก้ไม่ได้', async () => {
    process.env.OPS_ACCOUNTING_EMAIL = 'old@office.example.com';
    process.env.OPS_ACCOUNTING_SEND_DAY = '7';
    try {
      const g = await auditor.agent.get('/ops/accounting/settings');
      expect(g.body).toMatchObject({ source: 'env', recipients: ['old@office.example.com'], day: 7, auto: true, time: '09:00', whenOpen: 'wait', files: { salesTax: true, wht: true, zip: false } });
    } finally {
      delete process.env.OPS_ACCOUNTING_EMAIL;
      delete process.env.OPS_ACCOUNTING_SEND_DAY;
    }
    const body = { recipients: ['account@office.example.com', 'tax@office.example.com'], auto: true, day: 5, time: '09:00', whenOpen: 'wait', files: { salesTax: true, wht: true, zip: true } };
    expect((await auditor.agent.put('/ops/accounting/settings').send(body)).status).toBe(403);
    expect((await finance.agent.put('/ops/accounting/settings').send({ ...body, recipients: Array.from({ length: 6 }, (_, i) => `a${i}@office.example.com`) })).status).toBe(400);
    expect((await finance.agent.put('/ops/accounting/settings').send({ ...body, recipients: [] })).status).toBe(400);
    expect((await finance.agent.put('/ops/accounting/settings').send({ ...body, day: 16 })).status).toBe(400);
    const s = await owner.agent.put('/ops/accounting/settings').send(body);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ ...body, source: 'saved', updatedBy: 'Olive Owner' });
    process.env.OPS_ACCOUNTING_EMAIL = 'ignored@office.example.com';
    try {
      expect((await finance.agent.get('/ops/accounting/settings')).body.recipients).toEqual(body.recipients);
    } finally {
      delete process.env.OPS_ACCOUNTING_EMAIL;
    }
  });

  it('ส่ง: แนบ PDF Excel CSV ZIP · ประวัติทุกครั้ง (ส่งแล้ว / ล้ม) · ทดลองส่งถึงอีเมลของฉันไม่ลงประวัติ', async () => {
    const month = thisMonth();
    const before = mail.sent.length;
    const r = await finance.agent.post('/ops/revenue/export/send').send({ month });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ month, sent: 2, draft: true });
    const m = mail.sent[before]!;
    expect(m.attachments!.map((a) => a.filename)).toEqual([`friday-sales-tax-${month}-draft.pdf`, `friday-sales-tax-${month}-draft.xlsx`, `friday-wht-${month}-draft.csv`, `friday-tax-documents-${month}-draft.zip`]);
    const z = m.attachments![3]!.content as Buffer;
    expect(zipNames(z).some((n) => /^TX\/TX-.+\.pdf$/.test(n))).toBe(true);
    expect(zipNames(z).some((n) => /^CN\/CN-.+\.pdf$/.test(n))).toBe(true);
    // อ่านไฟล์แรกใน ZIP ได้จริง (deflate) และเป็น PDF
    const first = z.subarray(30 + z.readUInt16LE(26) + z.readUInt16LE(28), 30 + z.readUInt16LE(26) + z.readUInt16LE(28) + z.readUInt32LE(18));
    expect(inflateRawSync(first).subarray(0, 4).toString('latin1')).toBe('%PDF');

    const original = mail.send.bind(mail);
    mail.send = async () => {
      throw new Error('SMTP 554 rejected');
    };
    try {
      const f = await finance.agent.post('/ops/revenue/export/send').send({ month, types: ['wht'] });
      expect(f.status).toBe(502);
    } finally {
      mail.send = original;
    }
    const t1 = await owner.agent.post('/ops/accounting/settings/test').send({ types: ['wht'] });
    expect(t1.status, JSON.stringify(t1.body)).toBe(200);
    expect(t1.body).toMatchObject({ to: ['owner@friday.example.com'], test: true });
    expect(mail.sent.at(-1)!.subject).toContain('[ทดลองส่ง]');

    const d = await auditor.agent.get('/ops/revenue/export/delivery');
    expect(d.body.history.slice(0, 2)).toEqual([
      expect.objectContaining({ month, result: 'failed', files: ['CSV'], error: expect.stringContaining('SMTP 554'), staffName: 'Fin Finance' }),
      expect.objectContaining({ month, result: 'sent', files: ['PDF', 'Excel', 'CSV', 'ZIP'], draft: true, auto: false }),
    ]);
    expect(d.body.next).toMatchObject({ time: '09:00', date: expect.stringMatching(/-05$/) });
  });

  it('ZIP ดาวน์โหลด: เอกสารทั้งเดือน · ทั้งหมด (รายงาน + CSV + เอกสาร)', async () => {
    const z = await binary(auditor.agent.get(`/ops/revenue/export/zip?month=${thisMonth()}`));
    expect(z.status).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    expect(z.headers['content-disposition']).toContain(`friday-tax-documents-${thisMonth()}-draft.zip`);
    const all = await binary(auditor.agent.get(`/ops/revenue/export/zip?month=${thisMonth()}&scope=all`));
    expect(zipNames(all.body)).toEqual([`friday-sales-tax-${thisMonth()}-draft.pdf`, `friday-sales-tax-${thisMonth()}-draft.xlsx`, `friday-wht-${thisMonth()}-draft.csv`, `friday-tax-documents-${thisMonth()}-draft.zip`]);
  });

  it('อัตโนมัติ: งวดยังไม่ปิด รอปิดงวด (บันทึก "ไม่ได้ส่ง" ครั้งเดียว) · ฉบับร่างตามกำหนดแล้วส่งฉบับจริงเมื่อปิด', async () => {
    const svc = t.app.get(AccountingService);
    // งวดก่อนหน้าของ "เดือนหน้า" = เดือนนี้ (ยังไม่ปิด)
    const d = new Date(`${thisMonth()}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const next = d.toISOString().slice(0, 7);
    expect(await svc.autoSendExport(`${next}-04`)).toBeNull();
    expect(await svc.autoSendExport(`${next}-05`)).toEqual({ month: thisMonth(), skipped: true });
    expect(await svc.autoSendExport(`${next}-06`)).toEqual({ month: thisMonth(), skipped: true });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM staff_audit_logs WHERE action = 'billing.export_skipped'`)).rows[0].n).toBe(1);
    const h = await auditor.agent.get('/ops/revenue/export/delivery');
    expect(h.body.history[0]).toMatchObject({ month: thisMonth(), result: 'skipped', auto: true, files: [] });

    // ส่งฉบับร่างตามกำหนด: เดือนนี้ส่งฉบับร่างด้วยมือไปแล้ว จึงไม่ส่งซ้ำ
    await finance.agent.put('/ops/accounting/settings').send({ recipients: ['account@office.example.com'], auto: true, day: 5, time: '09:00', whenOpen: 'draft', files: { salesTax: false, wht: true, zip: false } });
    expect(await svc.autoSendExport(`${next}-07`)).toBeNull();
    // งวดที่ปิดแล้ว (เดือนก่อน) ส่งฉบับจริงตามไฟล์ที่ตั้งไว้ · ก่อนเวลาที่ตั้งไม่ส่ง
    expect(await svc.autoSendExport(new Date(`${thisMonth()}-05T08:59:00+07:00`))).toBeNull();
    const final = await svc.autoSendExport(new Date(`${thisMonth()}-05T09:01:00+07:00`));
    expect(final).toMatchObject({ month: lastMonth(), draft: false, to: ['account@office.example.com'], files: [{ type: 'wht' }] });
    expect(await svc.autoSendExport(`${thisMonth()}-06`)).toBeNull();
  });
});

describe('E7–E9 · 50 ทวิ', () => {
  let waiting: { id: string; number: string };
  let late: { id: string; number: string };
  let review: { id: string };
  let reviewCert: string;

  it('รายการติดตาม: รอรับ · รอตรวจ · เลยกำหนด (กำหนดส่ง = ชำระ + 30 วัน) · รอ e-WHT', async () => {
    waiting = await invoice(c, { wht: 45_000, paidDaysAgo: 3 });
    late = await invoice(c, { wht: 9_000, subtotal: 300_000, paidDaysAgo: 32 });
    review = await invoice(c, { wht: 27_000, subtotal: 900_000, paidDaysAgo: 10 });
    reviewCert = (await t.owner.query(`INSERT INTO wht_certificates (workspace_id, invoice_id, file_key, status) VALUES ($1,$2,'wht/x.pdf','pending_review') RETURNING id`, [c.id, review.id])).rows[0].id;
    const ew = await invoice(c, { wht: 15_000, subtotal: 500_000, paidDaysAgo: 2 });
    await t.owner.query(`INSERT INTO wht_certificates (workspace_id, invoice_id, source, status, ewht_ref) VALUES ($1,$2,'ewht','pending_ewht','EW-1')`, [c.id, ew.id]);
    const r = await auditor.agent.get('/ops/tax');
    const by = (id: string) => r.body.wht.items.find((w: { invoice: { id: string } }) => w.invoice.id === id);
    expect(by(waiting.id)).toMatchObject({ state: 'waiting', dueBy: bkk(27), daysLeft: 27, nextAuto: bkk(4), requests: { count: 0 } });
    expect(by(late.id)).toMatchObject({ state: 'overdue', daysLeft: -2 });
    expect(by(review.id)).toMatchObject({ state: 'review', certificate: { status: 'pending_review', hasFile: true } });
    expect(by(ew.id)).toMatchObject({ state: 'ewht', certificate: { source: 'ewht', ewhtRef: 'EW-1' } });
    expect(r.body.wht.counts).toMatchObject({ waiting: 1, review: 1, overdue: 1, ewht: 1, follow: 4 });
    expect(r.body.kpi.whtYear.satang).toBeGreaterThanOrEqual(45_000 + 9_000 + 27_000 + 15_000);
  });

  it('E7 ขออีกครั้ง: เฉพาะผู้ติดต่อของลูกค้า · วันละ 1 ครั้งต่อใบ · อีเมลตามแบบ E10', async () => {
    const d = await finance.agent.get(`/ops/wht/${late.id}`);
    expect(d.body.contacts).toEqual([{ email: 'acc@tax-demo.example.com', name: null, role: 'accounting' }, expect.objectContaining({ email: 'owner@tax-demo.example.com', role: 'owner' })]);
    expect((await finance.agent.post(`/ops/wht/${late.id}/request`).send({ recipients: ['stranger@example.com'] })).body.error.code).toBe('recipient_not_contact');
    const before = mail.sent.length;
    const r = await finance.agent.post(`/ops/wht/${late.id}/request`).send({ recipients: ['acc@tax-demo.example.com'], message: 'ทีมบัญชีของเราต้องใช้เอกสารนี้ปิดงวด' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = mail.sent[before]!;
    expect(m.subject).toBe(`ขอหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) · ${late.number} · ส่งภายใน ${bkk(-2)}`);
    expect(m.text).toContain('ภาษีที่หัก 3%: ฿90.00');
    expect(m.text).toContain('ทีมบัญชีของเราต้องใช้เอกสารนี้ปิดงวด');
    expect(m.text).toContain(`/work/tax-demo/billing/invoices/${late.id}`);
    expect((await finance.agent.post(`/ops/wht/${late.id}/request`).send({ recipients: ['acc@tax-demo.example.com'] })).body.error.code).toBe('wht_requested_today');
    expect((await auditor.agent.post(`/ops/wht/${late.id}/request`).send({ recipients: ['acc@tax-demo.example.com'] })).status).toBe(403);
    expect((await finance.agent.get('/ops/tax')).body.wht.items.find((w: { invoice: { id: string } }) => w.invoice.id === late.id).requests).toMatchObject({ count: 1, lastKind: 'manual', today: true });
  });

  it('E8 ไม่ผ่านพร้อมสาเหตุ (ลูกค้าเห็น) · อีเมลบอกกำหนดส่งเดิม', async () => {
    expect((await finance.agent.post(`/ops/wht-certificates/${reviewCert}/reject`).send({ code: 'other' })).status).toBe(400);
    const before = mail.sent.length;
    const r = await finance.agent.post(`/ops/wht-certificates/${reviewCert}/reject`).send({ code: 'amount_mismatch' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await t.owner.query(`SELECT status, reject_reason, decided_at IS NOT NULL AS decided FROM wht_certificates WHERE id = $1`, [reviewCert])).rows[0]).toEqual({ status: 'rejected', reject_reason: 'ยอดเงินได้หรือภาษีที่หักไม่ตรงกับใบแจ้งหนี้', decided: true });
    const m = mail.sent.slice(before).find((x) => x.to === 'acc@tax-demo.example.com')!;
    expect(m.text).toContain('สาเหตุ: ยอดเงินได้หรือภาษีที่หักไม่ตรงกับใบแจ้งหนี้');
    expect(m.text).toContain(`กำหนดส่งเดิม ${bkk(20)}`);
  });

  it('ปิดว่าไม่ได้รับ: ต้องกรอกเหตุผล · ออกจากรายการติดตาม · CSV ระบุ "ไม่ได้รับ"', async () => {
    expect((await finance.agent.post(`/ops/wht/${late.id}/close`).send({ reason: '' })).status).toBe(400);
    const r = await finance.agent.post(`/ops/wht/${late.id}/close`).send({ reason: 'ติดตามแล้ว ลูกค้าไม่ส่ง' });
    expect(r.body).toEqual({ invoiceId: late.id, status: 'uncollected' });
    expect((await finance.agent.post(`/ops/wht/${late.id}/close`).send({ reason: 'ซ้ำ' })).body.error.code).toBe('wht_closed');
    const csv = await finance.agent.get(`/ops/revenue/export?month=${bkk(-32).slice(0, 7)}&type=wht`);
    const line = csv.text.split('\r\n').find((l) => l.startsWith(late.number))!;
    expect(line).toContain('ไม่ได้รับ');
    expect(line).toContain('ติดตามแล้ว ลูกค้าไม่ส่ง');
  });

  it('ขออัตโนมัติวันที่ 7 (ผู้ติดต่อด้านบัญชี) และ 30 (บัญชี + Owner) · ตั้งแต่ 08:00 · ไม่ส่งซ้ำ · เลยกำหนดแจ้งการเงินครั้งเดียว', async () => {
    const d7 = await invoice(c, { wht: 3_000, subtotal: 100_000, paidDaysAgo: 7 });
    const d30 = await invoice(c, { wht: 6_000, subtotal: 200_000, paidDaysAgo: 31 });
    const svc = t.app.get(WhtService);
    const morning = (h: number) => new Date(`${bkk()}T${String(h).padStart(2, '0')}:30:00+07:00`);
    expect((await svc.runRequests(morning(7))).sent).toEqual([]);
    const before = mail.sent.length;
    const push = t.app.get(PushService);
    const pushed = push.sent.length;
    const r = await svc.runRequests(morning(8));
    expect(r.sent).toEqual(expect.arrayContaining([`${d7.number}:auto_7`, `${d30.number}:auto_30`]));
    const sent = mail.sent.slice(before);
    expect(sent.filter((m) => m.subject.includes(d7.number)).map((m) => m.to)).toEqual(['acc@tax-demo.example.com']);
    expect(sent.filter((m) => m.subject.includes(d30.number)).map((m) => m.to).sort()).toEqual(['acc@tax-demo.example.com', 'owner@tax-demo.example.com']);
    expect(sent.find((m) => m.subject.includes(d7.number))!.text).toContain('ครั้งที่ 1 จาก 2');
    expect(push.sent.slice(pushed).some((p) => p.message.title === '50 ทวิ เลยกำหนด' && p.message.body.includes(d30.number))).toBe(true);
    expect((await svc.runRequests(morning(9))).sent).toEqual([]);
    expect(push.sent.slice(pushed).filter((p) => p.message.body.includes(d30.number) && p.staffId === finance.id)).toHaveLength(1);
    expect((await t.owner.query(`SELECT kind, recipients FROM wht_requests WHERE invoice_id = $1`, [d7.id])).rows).toEqual([{ kind: 'auto_7', recipients: ['acc@tax-demo.example.com'] }]);
    // ใบที่รอตรวจ / แจ้ง e-WHT แล้ว ไม่ขอ
    expect(r.sent.some((x) => x.startsWith(`${review.id}`))).toBe(false);
  });

  it('E9 นำเข้าไฟล์ e-WHT: จับคู่เลขผู้เสียภาษี + ยอด (ไม่บังคับ 3%) + วันที่ ±3 วัน · จับคู่เอง · นำเข้าซ้ำไม่ปิดซ้ำ', async () => {
    const a = await invoice(c, { wht: 37_035, subtotal: 1_234_500, paidDaysAgo: 4 });
    const b = await invoice(c, { wht: 6_000, subtotal: 200_000, paidDaysAgo: 5 });
    await t.owner.query(`INSERT INTO wht_certificates (workspace_id, invoice_id, source, status, ewht_ref) VALUES ($1,$2,'ewht','pending_ewht','EW-CUST')`, [c.id, a.id]);
    const date = (n: number) => bkk(-n);
    const csv = ['payer_tax_id,payer_name,tax_amount,date,reference', `0105561111111,บริษัท ภาษีเดโม จำกัด,"123.45",${date(2)},EWHT-A1`, `0105569999999,บริษัท อื่น จำกัด,90.00,${date(5)},EWHT-X`, `0105561111111,บริษัท ภาษีเดโม จำกัด,20,${date(20)},EWHT-B1`, 'abc,ผิด,1,2026-01-01,X'].join('\n');
    expect((await finance.agent.post('/ops/wht-ewht/import').send({ csv: 'a,b\n1,2' })).body.error.code).toBe('ewht_columns');
    const p = await finance.agent.post('/ops/wht-ewht/import').send({ csv, filename: 'ewht-2569-11.csv' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ matched: 1, unmatched: 2, closed: 0, applied: false, errors: [{ line: 5 }] });
    expect(p.body.rows[0]).toMatchObject({ line: 2, status: 'matched', rate: 1, match: { invoiceId: a.id } });
    expect(p.body.rows[2]).toMatchObject({ line: 4, status: 'unmatched' }); // วันที่ห่างเกิน 3 วัน
    const ap = await finance.agent.post('/ops/wht-ewht/import').send({ csv, apply: true, matches: { '4': b.id } });
    expect(ap.body).toMatchObject({ matched: 2, closed: 2 });
    expect((await t.owner.query(`SELECT status, source, ewht_ref FROM wht_certificates WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.id])).rows[0]).toEqual({ status: 'confirmed', source: 'ewht', ewht_ref: 'EWHT-A1' });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM wht_certificates WHERE invoice_id = $1`, [a.id])).rows[0].n).toBe(1); // ปิดแถวที่ลูกค้าแจ้ง ไม่เพิ่มแถว
    expect((await t.owner.query(`SELECT status, source FROM wht_certificates WHERE invoice_id = $1`, [b.id])).rows).toEqual([{ status: 'confirmed', source: 'ewht' }]);
    expect((await auditRows(c.id, 'ops.wht_ewht_matched')).at(-1).summary).toContain('จับคู่เอง');
    const again = await finance.agent.post('/ops/wht-ewht/import').send({ csv, apply: true });
    expect(again.body).toMatchObject({ closed: 0 });
    expect(again.body.rows[0].status).toBe('already');
    const list = await finance.agent.get('/ops/tax');
    expect(list.body.wht.items.find((w: { invoice: { id: string } }) => w.invoice.id === a.id)).toMatchObject({ state: 'received', certificate: { source: 'ewht' } });
    expect((await auditor.agent.post('/ops/wht-ewht/import').send({ csv })).status).toBe(403);
  });
});
