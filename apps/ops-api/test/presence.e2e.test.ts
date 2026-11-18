// ช่วง 2 · กำลังดูโดย · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staff, type Staff, startOps, type TestOps } from './helpers.js';

let t: TestOps;
let mew: Staff;
let nid: Staff;
const ticket = randomUUID();

beforeAll(async () => {
  t = await startOps();
  mew = await staff(t, 'mew@friday.example.com', 'มิว ศิริ', 'support');
  nid = await staff(t, 'nid@friday.example.com', 'นิด ใจดี', 'support');
});
afterAll(() => t.close());

describe('กำลังดูโดย', () => {
  it('เห็นเพื่อนที่เปิด / พิมพ์อยู่ (ไม่รวมตัวเอง) · ออกแล้วหาย · เงียบเกิน 30 วินาทีหาย', async () => {
    await mew.agent.post('/ops/presence').send({ type: 'ticket', id: ticket, mode: 'typing' }).expect(200);
    const seen = await nid.agent.post('/ops/presence').send({ type: 'ticket', id: ticket });
    expect(seen.body.others).toEqual([expect.objectContaining({ id: ticket, name: 'มิว ศิริ', mode: 'typing' })]);
    expect((await mew.agent.get(`/ops/presence?type=ticket&ids=${ticket}`)).body.items).toEqual([expect.objectContaining({ name: 'นิด ใจดี', mode: 'viewing' })]);
    await mew.agent.post('/ops/presence/leave').send({ type: 'ticket', id: ticket }).expect(200);
    expect((await nid.agent.get(`/ops/presence?type=ticket&ids=${ticket}`)).body.items).toEqual([]);
    await t.owner.query(`UPDATE ops_presence SET seen_at = now() - interval '31 seconds'`);
    expect((await mew.agent.get(`/ops/presence?type=ticket&ids=${ticket}`)).body.items).toEqual([]);
    expect((await mew.agent.get(`/ops/presence?type=nope&ids=${ticket}`)).status).toBe(400);
  });
});
