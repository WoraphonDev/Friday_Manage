// O55 · หน้าตอบรับใบเสนอราคาของลูกค้า · ข้อมูลสมมติเท่านั้น
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactSalesLimit } from '../src/public/contact-sales.js';
import { client, startApp, type TestApp } from './helpers.js';

let t: TestApp;
const TOKEN = 'TestQuoteToken_0123456789abcdefXYZ';
const OLD = 'OldQuoteToken_0123456789abcdefXYZ';
const q = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rows;
const tomorrow = new Date(Date.now() + 31 * 3_600_000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 17 * 3_600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startApp();
  const acct = (await q(`INSERT INTO customer_accounts (name, contacts) VALUES ('บริษัท ลานนาเทค จำกัด', '[{"name": "คุณวรรณา", "email": "wanna@lannatech.example", "role": "signer"}]') RETURNING id`))[0].id;
  const ins = `INSERT INTO quotes (number, account_id, status, seats, months, price_per_seat_satang, list_per_seat_satang, subtotal_satang, vat_satang, total_satang, entitlements, valid_until, token_hash, sent_at)
    VALUES ($1, $2, 'sent', 150, 12, 33000, 40000, 59400000, 4158000, 63558000, '{"sso": true}', $3, $4, now())`;
  await t.owner.query(ins, ['QT-2611-0007', acct, tomorrow, createHash('sha256').update(TOKEN).digest('hex')]);
  await t.owner.query(ins, ['QT-2610-0004', acct, yesterday, createHash('sha256').update(OLD).digest('hex')]);
});
afterAll(() => t.close());

describe('ใบเสนอราคาสำหรับลูกค้า', () => {
  it('เปิดด้วยลิงก์ (ไม่ต้องล็อกอิน) · นับครั้งที่เปิด · token ผิด = ไม่พบ', async () => {
    const c = await client(t.app);
    const r = (await c.get(`/public/quotes/${TOKEN}`).expect(200)).body;
    expect(r).toMatchObject({ number: 'QT-2611-0007', company: 'บริษัท ลานนาเทค จำกัด', status: 'sent', totalSatang: 63558000, entitlements: { sso: true } });
    expect(r.tokenHash).toBeUndefined();
    await c.get(`/public/quotes/${TOKEN}`);
    expect(await q(`SELECT view_count FROM quotes WHERE number = 'QT-2611-0007'`)).toEqual([{ view_count: 2 }]);
    expect((await c.get('/public/quotes/WrongToken_0123456789abcdefXYZ')).status).toBe(404);
    expect((await c.get(`/public/quotes/${OLD}`)).body.status).toBe('expired');
  });

  it('ขอแก้ไข → Ticket เข้าคิว Support · ตอบรับต้องมีชื่อ ตำแหน่ง และยอมรับ · ตอบซ้ำไม่ได้ · ใบหมดอายุตอบรับไม่ได้', async () => {
    t.app.get(ContactSalesLimit).reset();
    const c = await client(t.app);
    await c.post(`/public/quotes/${TOKEN}/changes`, { message: 'ขอเปลี่ยนเป็นสัญญา 24 เดือน' }).expect(202);
    const tk = await q(`SELECT k.subject, k.requester_email, m.body FROM support_tickets k JOIN support_ticket_messages m ON m.ticket_id = k.id`);
    expect(tk).toEqual([{ subject: 'ขอแก้ไขใบเสนอราคา QT-2611-0007 · บริษัท ลานนาเทค จำกัด', requester_email: 'wanna@lannatech.example', body: 'ขอเปลี่ยนเป็นสัญญา 24 เดือน' }]);
    expect((await c.post(`/public/quotes/${TOKEN}/accept`, { name: 'คุณสมชาย', title: 'CFO', agree: false })).status).toBe(400);
    const r = (await c.post(`/public/quotes/${TOKEN}/accept`, { name: 'คุณสมชาย', title: 'CFO', po: 'PO-88213', agree: true }).expect(200)).body;
    expect(r).toMatchObject({ status: 'accepted', acceptedBy: 'คุณสมชาย' });
    expect((await q(`SELECT acceptance->>'po' AS po, acceptance->>'title' AS title FROM quotes WHERE number = 'QT-2611-0007'`))[0]).toEqual({ po: 'PO-88213', title: 'CFO' });
    expect((await c.post(`/public/quotes/${TOKEN}/accept`, { name: 'คุณสมชาย', title: 'CFO', agree: true })).body.error.code).toBe('quote_accepted');
    expect((await c.post(`/public/quotes/${OLD}/accept`, { name: 'คุณสมชาย', title: 'CFO', agree: true })).body.error.code).toBe('quote_expired');
  });
});
