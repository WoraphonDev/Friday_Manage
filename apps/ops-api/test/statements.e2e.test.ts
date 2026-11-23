// O03 เฟส 2 · นำเข้า statement ธนาคาร (กสิกรไทย) · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeText, parseAmount, parseDate, parseStatement } from '../src/payments/statement-parser.js';
import { customer, type Customer, staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let finance: Staff;
let support: Staff;
let auditor: Staff;
let c: Customer;
let seq = 0;

/** เวลาไทยในรูปแบบไฟล์ของธนาคาร: วันที่ dd/mm/yyyy (ค.ศ.) + เวลา HH:MM */
const bkkParts = (d: Date) => {
  const x = new Date(d.getTime() + 7 * 3_600_000).toISOString();
  return { date: `${x.slice(8, 10)}/${x.slice(5, 7)}/${x.slice(0, 4)}`, time: x.slice(11, 16) };
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const baht = (satang: number) => (satang / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

/** CSV แบบ statement ของ K-BIZ (หัวรายงาน + ตาราง + แถวรวม) */
function csv(lines: { at: Date; deposit?: number; withdrawal?: number; desc?: string; balance?: number }[]) {
  const rows = lines.map((l, i) => {
    const { date, time } = bkkParts(l.at);
    return [date, time, l.deposit ? 'รับโอนเงิน' : 'โอนเงิน', l.withdrawal ? baht(l.withdrawal) : '', l.deposit ? baht(l.deposit) : '', baht(l.balance ?? 1_000_000 + i), 'K PLUS', l.desc ?? ''].map((v) => `"${v}"`).join(',');
  });
  return Buffer.from(['"รายการเดินบัญชี"', '"เลขที่บัญชี","xxx-x-x1234"', '', '"วันที่","เวลา","รายการ","ถอนเงิน","ฝากเงิน","ยอดคงเหลือ","ช่องทาง","รายละเอียด"', ...rows, '"รวม","","","","","","",""'].join('\r\n'), 'utf8');
}

async function invoice(o: { amountDue: number; number?: string; status?: 'open' | 'pending_review' | 'paid'; slip?: { amount?: number; paidAt?: Date; exception?: string; status?: string } }) {
  const inv = (await t.owner.query(
    `INSERT INTO invoices (workspace_id, subscription_id, number, period_start, period_end, subtotal, vat, total, wht_amount, amount_due, status, due_date, created_at)
     VALUES ($1,$2,$3,current_date,current_date + 29,$4,0,$4,0,$4,$5::invoice_status,current_date + 7, now() - interval '3 days') RETURNING *`,
    [c.id, c.sub, o.number ?? `FRI-S${++seq}-${randomUUID().slice(0, 4)}`, o.amountDue, o.status ?? 'open'],
  )).rows[0];
  let payment: string | null = null;
  if (o.slip) {
    payment = (await t.owner.query(`INSERT INTO payments (workspace_id, invoice_id, method, amount, status, exception_reason, slip_file_key, paid_at) VALUES ($1,$2,'transfer',$3,$4,$5,'slips/x.png',$6) RETURNING id`, [c.id, inv.id, o.slip.amount ?? o.amountDue, o.slip.status ?? 'pending_review', o.slip.exception ?? null, o.slip.paidAt ?? hoursAgo(2)])).rows[0].id;
  }
  return { inv, payment };
}
const upload = (who: Staff, path: string, file: Buffer, name = 'statement.csv') => who.agent.post(path).set('Content-Type', 'application/octet-stream').set('X-File-Name', encodeURIComponent(name)).send(file);
const invStatus = async (id: string) => (await t.owner.query('SELECT status FROM invoices WHERE id = $1', [id])).rows[0].status;

beforeAll(async () => {
  t = await startOps();
  finance = await staff(t, 'fin-stmt@friday.example.com', 'Fin Statement', 'finance');
  support = await staff(t, 'sup-stmt@friday.example.com', 'Sup Statement', 'support');
  auditor = await staff(t, 'aud-stmt@office.example.com', 'Aud Statement', ['auditor']);
  c = await customer(t, 'stmt-demo', { plan: 'team_s', status: 'active' });
});
afterAll(() => t.close());

describe('อ่านไฟล์ statement', () => {
  it('วันที่ ค.ศ. / พ.ศ. / ปี 2 หลัก / เดือนไทย · เวลาในช่องเดียวกัน · ยอดมีจุลภาคและวงเล็บ', () => {
    expect(parseDate('17/11/2026', '09:12')?.toISOString()).toBe('2026-11-17T02:12:00.000Z');
    expect(parseDate('17/11/2569 09:12')?.toISOString()).toBe('2026-11-17T02:12:00.000Z');
    expect(parseDate('17-11-26')?.toISOString()).toBe('2026-11-16T17:00:00.000Z');
    expect(parseDate('17/11/69')?.toISOString()).toBe('2026-11-16T17:00:00.000Z');
    expect(parseDate('17 พ.ย. 69', '23:59')?.toISOString()).toBe('2026-11-17T16:59:00.000Z');
    expect(parseDate('2026-11-17 08:00:30')?.toISOString()).toBe('2026-11-17T01:00:30.000Z');
    expect(parseDate('รวม')).toBeNull();
    expect(parseAmount('1,605.00')).toBe(160_500);
    expect(parseAmount('(12.40)')).toBe(-1_240);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBeNull();
  });

  it('CSV ภาษาไทยแบบ Windows-874 อ่านได้ · หาแถวหัวตารางเอง · ข้ามแถวรวม', async () => {
    // "วันที่" ใน TIS-620 / Windows-874
    const tis = Buffer.from([0xc7, 0xd1, 0xb9, 0xb7, 0xd5, 0xe8]);
    expect(decodeText(tis)).toBe('วันที่');
    const p = await parseStatement(csv([{ at: new Date('2026-11-17T02:12:00Z'), deposit: 160_500, desc: 'จาก บจก. ตัวอย่าง' }, { at: new Date('2026-11-18T03:00:00Z'), withdrawal: 5_000 }]));
    expect(p.rows).toEqual([
      expect.objectContaining({ deposit: 160_500, withdrawal: 0, description: 'จาก บจก. ตัวอย่าง', channel: 'K PLUS' }),
      expect.objectContaining({ deposit: 0, withdrawal: 5_000 }),
    ]);
    expect(p).toMatchObject({ skipped: 1, periodFrom: '2026-11-17', periodTo: '2026-11-18' });
  });

  it('Excel (.xlsx) อ่านได้ · คอลัมน์ยอดเดียว (บวก = เข้า) · ไฟล์ที่ไม่มีหัวตาราง / PDF ตอบข้อความไทย', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Account Statement']);
    ws.addRow(['Date', 'Time', 'Description', 'Amount', 'Balance']);
    ws.addRow([new Date(Date.UTC(2026, 10, 17, 9, 12)), '', 'Transfer from ACME', 1605, 10000]);
    ws.addRow(['18/11/2026', '10:00', 'Fee', -15, 9985]);
    const p = await parseStatement(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(p.rows.map((r) => [r.txnAt.toISOString(), r.deposit, r.withdrawal])).toEqual([['2026-11-17T02:12:00.000Z', 160_500, 0], ['2026-11-18T03:00:00.000Z', 0, 1_500]]);
    await expect(parseStatement(Buffer.from('a,b,c\n1,2,3'))).rejects.toMatchObject({ code: 'statement_columns' });
    await expect(parseStatement(Buffer.from('%PDF-1.7'))).rejects.toMatchObject({ code: 'statement_pdf' });
  });
});

describe('นำเข้าและจับคู่', () => {
  it('ดูผลก่อนบันทึกไม่เขียนอะไร · บันทึกแล้ว: เลขใบแจ้งหนี้ในบันทึกช่วยจำ / สลิปรอตรวจ / ใบค้างยอดตรงใบเดียว → ชำระแล้ว · ที่เหลือเข้าคิว', async () => {
    const byRef = await invoice({ amountDue: 111_100, number: 'FRI-2611-9001' });
    const bySlip = await invoice({ amountDue: 222_200, slip: { paidAt: hoursAgo(3) } });
    const byAmount = await invoice({ amountDue: 333_300 });
    const twinA = await invoice({ amountDue: 444_400 });
    const twinB = await invoice({ amountDue: 444_400 });
    const file = csv([
      { at: hoursAgo(5), deposit: 111_100, desc: 'โอนเงิน ref FRI-2611-9001' },
      { at: hoursAgo(4), deposit: 222_200, desc: 'จาก นาย ก.' },
      { at: hoursAgo(3), deposit: 333_300 },
      { at: hoursAgo(2), deposit: 444_400 },
      { at: hoursAgo(1), deposit: 99_900, desc: 'ไม่รู้ที่มา' },
      { at: hoursAgo(1), deposit: 1_240, desc: 'ดอกเบี้ยเงินฝาก' },
      { at: hoursAgo(1), withdrawal: 50_000 },
    ]);
    const pre = await upload(finance, '/ops/bank-statements/preview', file);
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    expect(pre.body).toMatchObject({ deposits: 6, withdrawals: 1, matched: 3, reconciled: 0, review: 2, ignored: 1, duplicates: 0, account: { accountNo: expect.any(String) } });
    expect(pre.body.lines.map((l: { kind: string; reason: string | null }) => [l.kind, l.reason])).toEqual([['invoice', null], ['slip', null], ['invoice', null], ['review', 'many_candidates'], ['review', 'unmatched'], ['ignored', 'not_customer']]);
    expect(await invStatus(byRef.inv.id)).toBe('open');

    const r = await upload(finance, '/ops/bank-statements', file, 'K-BIZ พ.ย.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ matched: 3, review: 2, ignored: 1 });
    for (const x of [byRef, bySlip, byAmount]) expect(await invStatus(x.inv.id)).toBe('paid');
    expect(await invStatus(twinA.inv.id)).toBe('open');
    expect(await invStatus(twinB.inv.id)).toBe('open');
    // สลิปเดิมถูกยืนยันโดยธนาคาร (ไม่สร้างรายการซ้ำ) · โอนโดยไม่แนบสลิปได้รายการใหม่
    expect((await t.owner.query(`SELECT status, verified_by, reviewed_by FROM payments WHERE id = $1`, [bySlip.payment])).rows[0]).toEqual({ status: 'confirmed', verified_by: 'bank', reviewed_by: finance.id });
    expect((await t.owner.query(`SELECT count(*)::int AS n, min(verified_by) AS by FROM payments WHERE invoice_id = $1`, [byAmount.inv.id])).rows[0]).toEqual({ n: 1, by: 'bank' });
    // Audit log ของลูกค้าและของพนักงาน
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'ops.payment_statement'`, [c.id])).rows[0].n).toBe(3);
    expect((await t.owner.query(`SELECT reason FROM staff_audit_logs WHERE action = 'billing.statement_imported'`)).rows[0].reason).toContain('K-BIZ พ.ย.csv');

    // นำเข้าซ้ำ = ข้ามทุกรายการ
    const again = await upload(finance, '/ops/bank-statements', file);
    expect(again.body).toMatchObject({ duplicates: 6, matched: 0, review: 0 });

    // คิวต้องตรวจ: ยอดตรงสองใบมีให้เลือก
    const q = await auditor.agent.get('/ops/bank-statement-lines');
    expect(q.status).toBe(200);
    expect(q.body.total).toBe(2);
    const twin = q.body.items.find((i: { amount: number }) => i.amount === 444_400);
    expect(twin.candidates.map((x: { id: string }) => x.id).sort()).toEqual([twinA.inv.id, twinB.inv.id].sort());
  });

  it('ทีมยืนยันจากสลิปแล้ว → statement กระทบยอดอย่างเดียว · ประวัติเงินเข้าแสดง "ตรง"', async () => {
    const done = await invoice({ amountDue: 555_500, status: 'paid', slip: { status: 'confirmed', paidAt: hoursAgo(30) } });
    await t.owner.query(`UPDATE payments SET verified_by = 'staff', reviewed_at = now() WHERE id = $1`, [done.payment]);
    const before = (await finance.agent.get('/ops/payments/incoming')).body.items.find((i: { id: string }) => i.id === done.payment);
    expect(before.reconciliation).toBe('manual');
    const r = await upload(finance, '/ops/bank-statements', csv([{ at: hoursAgo(29), deposit: 555_500 }]));
    expect(r.body).toMatchObject({ reconciled: 1, matched: 0 });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1`, [done.inv.id])).rows[0].n).toBe(1);
    const after = (await finance.agent.get('/ops/payments/incoming')).body.items.find((i: { id: string }) => i.id === done.payment);
    expect(after.reconciliation).toBe('matched');
  });

  it('สลิปที่ติดเหตุผิดปกติไม่ถูกยืนยันเอง · เลขใบแจ้งหนี้ตรงแต่ยอดไม่ตรง → ต้องตรวจ', async () => {
    // ลูกค้าแนบสลิปแล้ว ใบแจ้งหนี้จึงเป็น pending_review
    await invoice({ amountDue: 666_600, status: 'pending_review', slip: { exception: 'payer_name_mismatch' } });
    await invoice({ amountDue: 777_700, number: 'FRI-2611-9002' });
    const r = await upload(finance, '/ops/bank-statements/preview', csv([{ at: hoursAgo(1), deposit: 666_600 }, { at: hoursAgo(1), deposit: 700_000, desc: 'FRI-2611-9002' }]));
    // สลิปที่รอคนตัดสินไม่ถูกยืนยัน และไม่สร้างรายการชำระซ้ำให้ใบเดียวกัน
    expect(r.body.lines.map((l: { kind: string; reason: string | null }) => [l.kind, l.reason])).toEqual([['review', 'unmatched'], ['review', 'amount_mismatch']]);
  });
});

describe('คิวต้องตรวจ', () => {
  it('ผูกกับใบแจ้งหนี้ที่เลือก: ยอดเกินเป็นเครดิต · ไม่เกี่ยวกับลูกค้า · ตัดสินซ้ำ 409 · สิทธิ์', async () => {
    const target = await invoice({ amountDue: 120_000 });
    await upload(finance, '/ops/bank-statements', csv([{ at: hoursAgo(1), deposit: 150_000, desc: 'โอนเกิน' }, { at: hoursAgo(1), deposit: 80_000, desc: 'โอนระหว่างบัญชีบริษัท' }]));
    const items = (await finance.agent.get('/ops/bank-statement-lines?limit=200')).body.items as { id: string; amount: number }[];
    const over = items.find((i) => i.amount === 150_000)!;
    const internal = items.find((i) => i.amount === 80_000)!;

    expect((await support.agent.post(`/ops/bank-statement-lines/${over.id}/match`).send({ invoiceId: target.inv.id, reason: 'ลูกค้าโทรแจ้ง' })).status).toBe(403);
    expect((await auditor.agent.post(`/ops/bank-statement-lines/${over.id}/match`).send({ invoiceId: target.inv.id, reason: 'ลูกค้าโทรแจ้ง' })).status).toBe(403);
    expect((await finance.agent.post(`/ops/bank-statement-lines/${over.id}/match`).send({ invoiceId: target.inv.id, reason: 'x' })).status).toBe(400);
    const m = await finance.agent.post(`/ops/bank-statement-lines/${over.id}/match`).send({ invoiceId: target.inv.id, reason: 'ลูกค้าโทรแจ้งว่าโอนเกิน (สมมติ)' });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body).toMatchObject({ settled: true, creditSatang: 30_000 });
    expect(await invStatus(target.inv.id)).toBe('paid');
    expect((await t.owner.query(`SELECT amount_satang FROM workspace_credits WHERE invoice_id = $1`, [target.inv.id])).rows[0].amount_satang).toBe('30000');
    expect((await finance.agent.post(`/ops/bank-statement-lines/${over.id}/match`).send({ invoiceId: target.inv.id, reason: 'ซ้ำ ๆ ๆ' })).status).toBe(409);

    const ig = await finance.agent.post(`/ops/bank-statement-lines/${internal.id}/ignore`).send({ reason: 'โอนระหว่างบัญชีของบริษัท' });
    expect(ig.status).toBe(200);
    expect((await finance.agent.get('/ops/bank-statement-lines?status=ignored')).body.items.map((i: { id: string }) => i.id)).toContain(internal.id);
    expect((await finance.agent.get('/ops/bank-statement-lines')).body.items.map((i: { id: string }) => i.id)).not.toContain(internal.id);
  });

  it('ไฟล์ว่าง / ส่งเป็น JSON → 400 · Support นำเข้าไม่ได้ · ประวัติรอบนำเข้า', async () => {
    expect((await finance.agent.post('/ops/bank-statements/preview').send({ file: 'x' })).status).toBe(400);
    expect((await upload(support, '/ops/bank-statements/preview', csv([{ at: hoursAgo(1), deposit: 100 }]))).status).toBe(403);
    const recent = await auditor.agent.get('/ops/bank-statements');
    expect(recent.status).toBe(200);
    expect(recent.body.imports[0]).toMatchObject({ createdBy: 'Fin Statement' });
    expect(recent.body.account).toHaveProperty('accountNo');
  });
});
