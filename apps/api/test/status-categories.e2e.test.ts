// หมวดสถานะ review / blocked / cancelled (2026-11-11) · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
});
afterAll(() => t.close());

describe('หมวดสถานะใหม่', () => {
  it('ยกเลิก = ปิดงานแต่ไม่เสร็จ: ไม่เลยกำหนด ไม่เป็นงานค้าง และไม่นับในความคืบหน้า · Blocked ยังเป็นงานค้าง', async () => {
    const { ws, lead, project } = team;
    const p = (path = '') => `${ws}/projects/DP${path}`;
    const wf = project.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === 'To do' && !x.boardColumnId).workflowId;
    // โปรเจกต์ใหม่: Review อยู่หมวด review
    expect(project.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === 'Review' && !x.boardColumnId).category).toBe('review');
    const cancelled = (await lead.post(p(`/workflows/${wf}/statuses`), { name: 'Cancelled', category: 'cancelled', color: '#A9AEB5' })).body;
    const blocked = (await lead.post(p(`/workflows/${wf}/statuses`), { name: 'Blocked', category: 'blocked' })).body;
    const done = project.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === 'Done' && !x.boardColumnId).id;
    const moduleId = project.modules[0].id;

    // งานเลยกำหนด 3 งาน: งานหนึ่งยกเลิก งานหนึ่งติดอยู่ งานหนึ่งเสร็จ
    const mk = async (title: string) => (await lead.post(p('/issues'), { title, moduleId, size: 'S', planStart: '2026-01-05', planEnd: '2026-01-07' })).body;
    const a = await mk('งานที่ยกเลิก');
    const b = await mk('งานที่ติดอยู่');
    const c = await mk('งานที่เสร็จ');
    expect((await lead.post(`${ws}/issues/${a.key}/move`, { statusId: cancelled.id })).status).toBe(200);
    expect((await lead.post(`${ws}/issues/${b.key}/move`, { statusId: blocked.id })).status).toBe(200);
    expect((await lead.post(`${ws}/issues/${c.key}/move`, { statusId: done })).status).toBe(200);

    // ยกเลิกไม่ถือว่าเริ่มทำ · มีเวลาปิดงานแต่ไม่มีวันเสร็จจริง
    const row = (await t.owner.query(`SELECT actual_start, actual_end, completed_at FROM issues WHERE id = $1`, [a.id])).rows[0];
    expect(row).toMatchObject({ actual_start: null, actual_end: null });
    expect(row.completed_at).not.toBeNull();

    // ตัวกรองงานค้าง (status=open) และงานเลยกำหนด: มีแค่งานที่ติดอยู่
    const open = (await lead.get(`${p('/issues')}?status=open`)).body.items.map((i: { key: string }) => i.key);
    expect(open).toContain(b.key);
    expect(open).not.toContain(a.key);
    expect(open).not.toContain(c.key);
    const overdue = (await lead.get(`${p('/issues')}?overdue=true`)).body.items.map((i: { key: string }) => i.key);
    expect(overdue).toEqual([b.key]);

    // ภาพรวม: งานที่ยกเลิกไม่อยู่ในจำนวนงานและไม่เลยกำหนด · เสร็จ 1 จาก 2
    const ov = (await lead.get(p('/overview'))).body;
    expect(ov.kpis).toMatchObject({ total: 2, done: 1, overdue: 1 });
    expect(ov.progress.tasks).toEqual({ done: 1, total: 2 });
  });
});
