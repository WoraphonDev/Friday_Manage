// ตัวอย่างไฟล์ test ของงานใหม่: เริ่มจากฐานข้อมูลว่าง + ทีมตัวอย่างจาก seedTeam
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
const seen: DomainEvent[] = [];

beforeAll(async () => {
  t = await startApp();
  t.app.get(EventBus).on('*', (e) => {
    seen.push(e);
  });
  team = await seedTeam(t);
});
afterAll(() => t.close());

describe('EventBus', () => {
  it('สร้าง / แก้ / ย้ายงานแล้วส่งเหตุการณ์หลัง commit', async () => {
    const { ws, lead, devId, project } = team;
    const creditLine = project.modules.find((m: { name: string }) => m.name === 'Credit Line').id;
    const r = await lead.post(`${ws}/projects/DP/issues`, { title: 'ฟอร์มหลักประกัน', moduleId: creditLine, size: 'S', planStart: '2026-12-01' });
    expect(r.status).toBe(201);
    expect(seen.map((e) => e.type)).toEqual(['issue.created']);
    expect(seen[0]).toMatchObject({ projectId: project.id, issueId: r.body.id, data: { issueKey: 'DP-1', title: 'ฟอร์มหลักประกัน', type: 'Task' } });

    seen.length = 0;
    const p = await lead.patch(`${ws}/issues/DP-1`, { assigneeIds: [devId], priority: 'high' }, r.body.version);
    expect(p.status).toBe(200);
    expect(seen.map((e) => e.type)).toEqual(['issue.updated', 'issue.assigned']);
    expect(seen[1].data).toMatchObject({ userIds: [devId], removedUserIds: [] });

    seen.length = 0;
    const review = project.statuses.find((x: { name: string; boardColumnId: string | null }) => x.name === 'Review' && !x.boardColumnId).id;
    await lead.post(`${ws}/issues/DP-1/move`, { statusId: review });
    expect(seen.find((e) => e.type === 'issue.status_changed')?.data).toMatchObject({ from: { name: 'To do' }, to: { name: 'Review', category: 'in_progress' } });

    seen.length = 0;
    const bad = await lead.patch(`${ws}/issues/DP-1`, { title: 'x' }, 1);
    expect(bad.status).toBe(409);
    expect(seen).toEqual([]);
  });
});
