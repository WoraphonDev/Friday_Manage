// O43 · S7 เก็บ requestId ของคำขอ HTTP ไว้กับแจ้งเตือน เพื่อค้นในประวัติการส่งของ Friday Ops · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus, requestContext } from '../src/core/events.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let creditLine: string;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'reqid-co' });
  creditLine = team.project.modules.find((m: { name: string }) => m.name === 'Credit Line').id;
});
afterAll(() => t.close());

describe('requestId ไปกับ Event → notifications.request_id', () => {
  it('มอบหมายงานผ่าน API: แจ้งเตือนของผู้รับมี requestId เดียวกับ X-Request-Id ของคำขอ', async () => {
    const r = await team.lead.post(`${team.ws}/projects/DP/issues`, { moduleId: creditLine, size: 'S', planStart: '2026-12-01', title: 'หน้าสรุปวงเงิน', assigneeIds: [team.devId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const reqId = r.headers['x-request-id'];
    expect(reqId).toMatch(/^req_[0-9a-f]{8}$/);
    const rows = (await t.owner.query(`SELECT event_type, request_id FROM notifications WHERE recipient_id = $1 AND issue_id = $2`, [team.devId, r.body.id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.request_id === reqId)).toBe(true);
  });

  it('Event จาก Job (ไม่มีคำขอ HTTP) ไม่มี requestId · ส่ง requestId มากับ Event ตรง ๆ ได้', async () => {
    const ws = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
    const issue = (await t.owner.query(`SELECT id FROM issues WHERE project_id = $1 LIMIT 1`, [team.project.id])).rows[0];
    const bus = t.app.get(EventBus);
    const base = { type: 'issue.assigned', workspaceId: ws, projectId: team.project.id, issueId: issue.id, actorId: team.leadId, data: { userIds: [team.devId], issueKey: 'DP-1', title: 'x' }, at: new Date() } as DomainEvent;
    await bus.publish({ ...base });
    const ev = { ...base };
    await requestContext.run({ req: { id: 'req_0000beef' } }, () => bus.publish(ev));
    expect(ev.requestId).toBe('req_0000beef');
    const rows = (await t.owner.query(`SELECT request_id FROM notifications WHERE recipient_id = $1 AND issue_id = $2 AND event_type = 'issue.assigned' ORDER BY created_at`, [team.devId, issue.id])).rows.map((x) => x.request_id);
    expect(rows.slice(-2)).toEqual([null, 'req_0000beef']);
  });
});
