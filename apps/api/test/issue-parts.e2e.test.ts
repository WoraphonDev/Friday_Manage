import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DomainEvent, EventBus } from '../src/core/events.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client;
let guest: Client;
let outsider: Client;
let guestId: string;
let moduleId: string;
const seen: DomainEvent[] = [];
const committed: boolean[] = [];
const eventCounts = new Map<string, number>();

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  moduleId = team.project.modules[0].id;
  viewer = await client(t.app);
  guest = await client(t.app);
  outsider = await client(t.app);
  const viewerId = await signup(viewer, 'viewer@parts.example.com', 'Test Viewer');
  guestId = await signup(guest, 'guest@parts.example.com', 'Test Guest');
  await signup(outsider, 'outsider@parts.example.com', 'Test Outsider');
  await addMember(t.owner, team.slug, viewerId, 'member', { key: 'DP', role: 'viewer' });
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'DP', role: 'viewer' });
  t.app.get(EventBus).on('issue.updated', async (event) => {
    if (!(event.data.fields as string[]).some((f) => f === 'checklist' || f === 'dependencies')) return;
    seen.push(event);
    // connection ของ Owner แยกจากธุรกรรมคำขอ จึงเห็นประวัติได้เมื่อ commit แล้วเท่านั้น
    const field = (event.data.fields as string[])[0];
    const key = `${event.issueId}:${field}`;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
    const result = await t.owner.query('SELECT count(*) FROM activities WHERE issue_id = $1 AND field = $2', [event.issueId, field]);
    committed.push(Number(result.rows[0].count) >= eventCounts.get(key)!);
  });
});
afterAll(() => t.close());

async function issue(overrides: Record<string, unknown> = {}) {
  const r = await team.lead.post(`${team.ws}/projects/DP/issues`, { title: 'งานทดสอบส่วนย่อย', moduleId, ...overrides });
  expect(r.status).toBe(201);
  return r.body as { id: string; key: string; version: number };
}

const path = (key: string) => `${team.ws}/issues/${key}`;
async function checklist(key: string, body: object) {
  const r = await team.lead.post(`${path(key)}/checklist`, body);
  expect(r.status).toBe(201);
  return r.body as { id: string; text: string; sort: number; kind: string };
}
async function activityCount() {
  return Number((await t.owner.query('SELECT count(*) FROM activities WHERE field IN (\'checklist\', \'dependencies\')')).rows[0].count);
}

describe('Checklist และ Acceptance criteria', () => {
  it('สร้าง อ่าน แก้ ลบรายการในงานและ Sub-task พร้อมชนิด ลำดับ และข้อมูลผู้ติ๊ก', async () => {
    const parent = await issue();
    const sub = await issue({ parentKey: parent.key });
    expect((await team.lead.get(`${path(sub.key)}/checklist`)).body).toEqual({ items: [] });
    const before = await activityCount();
    seen.length = 0;
    committed.length = 0;
    const first = await checklist(sub.key, { text: '  ตรวจรูปแบบข้อมูล  ' });
    expect(first).toMatchObject({ text: 'ตรวจรูปแบบข้อมูล', kind: 'checklist', sort: 0, done: false, doneBy: null, doneAt: null });
    const second = await checklist(sub.key, { text: 'บันทึกสำเร็จ', kind: 'acceptance', done: true });
    expect(second).toMatchObject({ kind: 'acceptance', done: true, doneBy: team.leadId, doneAt: expect.any(String) });
    expect((await team.lead.get(`${path(sub.key)}/checklist/${first.id}`)).body).toEqual(first);
    expect((await team.dev.get(`${path(sub.key)}/checklist?kind=acceptance`)).body.items).toEqual([second]);

    const done = await team.dev.patch(`${path(sub.key)}/checklist/${first.id}`, { text: 'ตรวจครบ', done: true });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ text: 'ตรวจครบ', done: true, doneBy: team.devId, doneAt: expect.any(String) });
    const repeat = await team.lead.patch(`${path(sub.key)}/checklist/${first.id}`, { done: true });
    expect(repeat.body.doneAt).toBe(done.body.doneAt);
    expect(repeat.body.doneBy).toBe(team.devId);
    const undone = await team.lead.patch(`${path(sub.key)}/checklist/${first.id}`, { done: false, kind: 'acceptance' });
    expect(undone.body).toMatchObject({ done: false, doneAt: null, doneBy: null, kind: 'acceptance', sort: 1 });
    expect((await team.lead.get(`${path(sub.key)}/checklist?kind=checklist`)).body.items).toEqual([]);

    const removed = await team.dev.delete(`${path(sub.key)}/checklist/${first.id}`);
    expect(removed.status).toBe(204);
    expect((await team.lead.get(`${path(sub.key)}/checklist/${first.id}`)).status).toBe(404);
    expect((await team.lead.get(`${path(parent.key)}/checklist`)).body.items).toEqual([]);
    expect(await activityCount()).toBe(before + 6);
    expect(seen).toHaveLength(6);
    expect(seen.every((e) => e.issueId === sub.id && e.data.issueKey === sub.key && JSON.stringify(e.data.fields) === '["checklist"]')).toBe(true);
    expect(committed).toEqual(Array(6).fill(true));
    const audit = await t.owner.query('SELECT old_value, new_value FROM activities WHERE issue_id=$1 AND field=\'checklist\' ORDER BY created_at', [sub.id]);
    expect(audit.rows[0]).toMatchObject({ old_value: null, new_value: { text: 'ตรวจรูปแบบข้อมูล' } });
    expect(audit.rows.at(-1)).toMatchObject({ old_value: { id: first.id }, new_value: null });
  });

  it('จัดลำดับทั้งรายการหรือเฉพาะชนิด และรองรับ action route ตามสเปก', async () => {
    const i = await issue();
    const a = await checklist(i.key, { text: 'A' });
    const b = await checklist(i.key, { text: 'B' });
    const ac = await checklist(i.key, { text: 'C', kind: 'acceptance' });
    const r = await team.dev.post(`${path(i.key)}/checklist/reorder`, { kind: 'checklist', ids: [b.id, a.id] });
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { id: string; sort: number }) => [x.id, x.sort])).toEqual([[b.id, 0], [a.id, 1]]);
    expect((await team.lead.get(`${path(i.key)}/checklist?kind=acceptance`)).body.items[0]).toEqual(ac);
    const all = await team.lead.post(`${path(i.key)}/checklist:reorder`, { ids: [ac.id, a.id, b.id] });
    expect(all.status).toBe(200);
    expect(all.body.items.map((x: { id: string }) => x.id)).toEqual([ac.id, a.id, b.id]);
  });

  it('กัน id ของงานอื่น รายการขาด/ซ้ำ และข้อมูลขาเข้าที่ไม่ถูกต้องโดยไม่เขียนประวัติหรือส่ง Event', async () => {
    const i = await issue();
    const other = await issue();
    const a = await checklist(i.key, { text: 'A' });
    const foreign = await checklist(other.key, { text: 'B' });
    const before = await activityCount();
    seen.length = 0;
    for (const body of [{ ids: [] }, { ids: [a.id, a.id] }, { ids: [foreign.id] }]) {
      const r = await team.lead.post(`${path(i.key)}/checklist/reorder`, body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_reorder');
    }
    expect((await team.lead.get(`${path(i.key)}/checklist/${foreign.id}`)).status).toBe(404);
    expect((await team.lead.patch(`${path(i.key)}/checklist/${foreign.id}`, { done: true })).status).toBe(404);
    expect((await team.lead.delete(`${path(i.key)}/checklist/${foreign.id}`)).status).toBe(404);
    for (const body of [{ text: '' }, { text: 'x', kind: 'unknown' }, { text: 'x', done: 'yes' }, { text: 'x', sort: -1 }]) {
      expect((await team.lead.post(`${path(i.key)}/checklist`, body)).status).toBe(400);
    }
    expect((await team.lead.patch(`${path(i.key)}/checklist/${a.id}`, {})).status).toBe(400);
    expect((await team.lead.get(`${path(i.key)}/checklist?kind=invalid`)).status).toBe(400);
    expect((await team.lead.delete(`${path(i.key)}/checklist/not-a-uuid`)).status).toBe(400);
    expect(await activityCount()).toBe(before);
    expect(seen).toEqual([]);
  });

  it('เพิ่มพร้อมกันได้ลำดับไม่ซ้ำ และไม่ทำรายการหายเมื่อจัดลำดับชนกับการเพิ่ม', async () => {
    const i = await issue();
    const responses = await Promise.all(Array.from({ length: 4 }, (_, n) => team.lead.post(`${path(i.key)}/checklist`, { text: `รายการ ${n}` })));
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const ids = responses.map((r) => r.body.id);
    expect(new Set(responses.map((r) => r.body.sort)).size).toBe(4);
    const [reorder, add] = await Promise.all([
      team.lead.post(`${path(i.key)}/checklist/reorder`, { ids: ids.reverse() }),
      team.lead.post(`${path(i.key)}/checklist`, { text: 'รายการใหม่' }),
    ]);
    expect([200, 400]).toContain(reorder.status);
    expect(add.status).toBe(201);
    const items = (await team.lead.get(`${path(i.key)}/checklist`)).body.items;
    expect(items).toHaveLength(5);
    expect(new Set(items.map((x: { sort: number }) => x.sort)).size).toBe(5);
  });
});

describe('Dependency', () => {
  it('สร้างได้ทั้งสองทิศทางและทุกชนิด ส่งสถานะ/วันที่ พร้อมประวัติและ Event ของทั้งสองฝั่ง', async () => {
    const a = await issue({ title: 'ต้นทาง', planStart: '2026-12-01', planEnd: '2026-12-02' });
    const b = await issue({ title: 'ปลายทาง', planStart: '2026-12-03', planEnd: '2026-12-04' });
    expect((await team.dev.get(`${path(a.key)}/dependencies`)).body).toEqual({ blockedBy: [], blocking: [] });
    const before = await activityCount();
    seen.length = 0;
    committed.length = 0;
    const r = await team.dev.post(`${path(b.key)}/dependencies`, { predecessorKey: a.key });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ blocking: [], warnings: [], blockedBy: [{ key: a.key, title: 'ต้นทาง', type: 'FS', lagDays: 0, predecessorKey: a.key, successorKey: b.key, planStart: '2026-12-01', planEnd: '2026-12-02', status: { name: 'To do', category: 'todo' } }] });
    expect((await team.lead.get(`${path(a.key)}/dependencies`)).body.blocking[0]).toMatchObject({ key: b.key, planStart: '2026-12-03' });
    expect(seen.map((e) => e.issueId).sort()).toEqual([a.id, b.id].sort());
    expect(seen.every((e) => JSON.stringify(e.data.fields) === '["dependencies"]')).toBe(true);
    expect(committed).toEqual([true, true]);
    expect(await activityCount()).toBe(before + 2);
    const deleted = await team.lead.delete(`${path(a.key)}/dependencies`, { successorKey: b.key });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ blockedBy: [], blocking: [] });
    expect((await team.lead.get(`${path(b.key)}/dependencies`)).body.blockedBy).toEqual([]);
    expect(await activityCount()).toBe(before + 4);
    expect((await team.lead.delete(`${path(a.key)}/dependencies`, { successorKey: b.key })).status).toBe(404);

    for (const [type, lagDays] of [['FS', 0], ['SS', 2], ['FF', -2], ['SF', 0]] as const) {
      const child = await issue();
      const created = await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: child.key, type, lagDays });
      expect(created.status).toBe(201);
      expect(created.body.blocking.find((x: { key: string }) => x.key === child.key)).toMatchObject({ type, lagDays });
      const removed = await team.dev.delete(`${path(child.key)}/dependencies`, { predecessorKey: a.key, type, lagDays });
      expect(removed.status).toBe(200);
    }
  });

  it('เตือน FS ตามวันจบและ lag วันทำการ รวมวันหยุด โดยบันทึกเส้นเชื่อมตามที่ผู้ใช้ขอ', async () => {
    const a = await issue({ planStart: '2026-12-01', planEnd: '2026-12-04' });
    const b = await issue({ planStart: '2026-12-03', planEnd: '2026-12-04' });
    const conflict = await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key });
    expect(conflict.status).toBe(201);
    expect(conflict.body.warnings).toEqual([{ code: 'dependency_date_conflict', message: expect.any(String) }]);
    const c = await issue({ planStart: '2026-12-08' });
    const lag = await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: c.key, lagDays: 2 });
    // ศ. 4 + 2 วันทำการ = พ. 9 (7 ธ.ค. เป็นวันหยุด)
    expect(lag.body.warnings[0].code).toBe('dependency_date_conflict');
    const d = await issue({ planStart: '2026-12-09' });
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: d.key, lagDays: 2 })).body.warnings).toEqual([]);
    const e = await issue({ planStart: '2026-12-03' });
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: e.key, lagDays: -1 })).body.warnings).toEqual([]);
    const f = await issue({ planStart: '2026-12-01' });
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: f.key, type: 'SS' })).body.warnings).toEqual([]);
  });

  it('กันวงรอบหนึ่ง สอง และสามงาน รวมกราฟหลายแขน โดยไม่เขียนประวัติหรือส่ง Event ของคำขอที่ถูกปฏิเสธ', async () => {
    const [a, b, c, d] = await Promise.all([issue(), issue(), issue(), issue()]);
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key })).status).toBe(201);
    expect((await team.lead.post(`${path(b.key)}/dependencies`, { successorKey: c.key })).status).toBe(201);
    expect((await team.lead.post(`${path(b.key)}/dependencies`, { successorKey: d.key })).status).toBe(201);
    const before = await activityCount();
    seen.length = 0;
    for (const [from, to] of [[a.key, a.key], [b.key, a.key], [c.key, a.key], [d.key, a.key]]) {
      const r = await team.lead.post(`${path(from)}/dependencies`, { successorKey: to });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('dependency_cycle');
    }
    const duplicate = await team.lead.post(`${path(b.key)}/dependencies`, { predecessorKey: a.key, type: 'SS' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('dependency_exists');
    expect(await activityCount()).toBe(before);
    expect(seen).toEqual([]);
  });

  it('เมื่อปฏิทินผิดกติกา rollback ทั้งเส้นเชื่อมและประวัติ โดยไม่ส่ง Event', async () => {
    const a = await issue({ planStart: '2026-12-01', planEnd: '2026-12-04' });
    const b = await issue({ planStart: '2026-12-08' });
    const before = await activityCount();
    seen.length = 0;
    const workspaceId = (await t.owner.query('SELECT workspace_id FROM projects WHERE id=$1', [team.project.id])).rows[0].workspace_id;
    const previous = (await t.owner.query('SELECT work_days FROM workspace_settings WHERE workspace_id=$1', [workspaceId])).rows[0].work_days;
    await t.owner.query('UPDATE workspace_settings SET work_days=\'{}\' WHERE workspace_id=$1', [workspaceId]);
    try {
      const r = await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key, lagDays: 1 });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('invalid_work_calendar');
      expect((await team.lead.get(`${path(a.key)}/dependencies`)).body.blocking).toEqual([]);
      expect(await activityCount()).toBe(before);
      expect(seen).toEqual([]);
    } finally {
      await t.owner.query('UPDATE workspace_settings SET work_days=$1 WHERE workspace_id=$2', [previous, workspaceId]);
    }
  });

  it('คำขอเพิ่มพร้อมกันไม่ทำให้เกิดวงรอบสามงาน', async () => {
    const [a, b, c] = await Promise.all([issue(), issue(), issue()]);
    const responses = await Promise.all([
      team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key }),
      team.dev.post(`${path(b.key)}/dependencies`, { successorKey: c.key }),
      team.lead.post(`${path(c.key)}/dependencies`, { successorKey: a.key }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(responses.find((r) => r.status === 409)?.body.error.code).toBe('dependency_cycle');
  });

  it('รับปลายทางเพียงหนึ่งงาน กันข้ามโปรเจกต์/Workspace งานที่ลบ และข้อมูลชนิด/lag ผิด', async () => {
    const a = await issue();
    const b = await issue();
    const p = await team.lead.post(`${team.ws}/projects`, { name: 'โครงการทดสอบอีกชุด', key: 'OTHER', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['ตัวอย่าง'] });
    expect(p.status).toBe(201);
    const project = (await team.lead.get(`${team.ws}/projects/OTHER`)).body;
    const foreign = await team.lead.post(`${team.ws}/projects/OTHER/issues`, { title: 'งานต่างโปรเจกต์', moduleId: project.modules[0].id });
    expect(foreign.status).toBe(201);
    const before = await activityCount();
    seen.length = 0;
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: foreign.body.key })).status).toBe(404);
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { predecessorKey: 'DP-999999' })).status).toBe(404);
    for (const body of [{}, { predecessorKey: a.key, successorKey: b.key }, { successorKey: b.key, type: 'invalid' }, { successorKey: b.key, lagDays: 0.5 }, { successorKey: b.key, lagDays: 32768 }]) {
      expect((await team.lead.post(`${path(a.key)}/dependencies`, body)).status).toBe(400);
    }
    expect((await team.lead.delete(`${path(a.key)}/dependencies`, {})).status).toBe(400);
    await t.owner.query('UPDATE issues SET deleted_at=now() WHERE id=$1', [b.id]);
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key })).status).toBe(404);
    expect(await activityCount()).toBe(before);
    expect(seen).toEqual([]);

    const otherTeam = await seedTeam(t, { slug: 'parts-other', key: 'DP' });
    const cross = await otherTeam.lead.post(`${otherTeam.ws}/projects/DP/issues`, { title: 'งานต่าง Workspace', moduleId: otherTeam.project.modules[0].id });
    expect(cross.status).toBe(201);
    const result = await team.lead.get(`${path(cross.body.key)}/dependencies`);
    // key เดียวกันต้องอ้างงานใน Workspace ปัจจุบัน ไม่เปิดข้อมูลของอีกองค์กร
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain(cross.body.id);
    expect((await otherTeam.lead.get(`${path(a.key)}/dependencies`)).status).toBe(404);
  });

  it('ซ่อนปลายทางที่ถูกลบจากรายการ Dependency', async () => {
    const a = await issue();
    const b = await issue();
    await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key });
    await t.owner.query('UPDATE issues SET deleted_at=now() WHERE id=$1', [b.id]);
    expect((await team.lead.get(`${path(a.key)}/dependencies`)).body).toEqual({ blockedBy: [], blocking: [] });
  });
});

describe('สิทธิ์และขอบเขตข้อมูล', () => {
  it('ทุก endpoint ต้องมี issue.edit และตรวจสมาชิก Workspace ก่อนอ่าน/เขียน', async () => {
    const a = await issue({ sharedWithGuests: true });
    const b = await issue();
    const item = await checklist(a.key, { text: 'รายการตรวจสิทธิ์' });
    for (const c of [viewer, guest]) {
      for (const response of [
        await c.get(`${path(a.key)}/checklist`), await c.get(`${path(a.key)}/checklist/${item.id}`),
        await c.post(`${path(a.key)}/checklist`, { text: 'ไม่มีสิทธิ์' }),
        await c.patch(`${path(a.key)}/checklist/${item.id}`, { done: true }),
        await c.delete(`${path(a.key)}/checklist/${item.id}`),
        await c.post(`${path(a.key)}/checklist/reorder`, { ids: [item.id] }),
        await c.get(`${path(a.key)}/dependencies`),
        await c.post(`${path(a.key)}/dependencies`, { successorKey: b.key }),
        await c.delete(`${path(a.key)}/dependencies`, { successorKey: b.key }),
      ]) expect(response.status).toBe(403);
    }
    expect((await guest.get(`${path(b.key)}/checklist`)).status).toBe(404);
    expect((await outsider.get(`${path(a.key)}/checklist`)).status).toBe(404);
    expect((await outsider.post(`${path(a.key)}/dependencies`, { successorKey: b.key })).status).toBe(404);
    const anonymous = await client(t.app);
    expect((await anonymous.get(`${path(a.key)}/checklist`)).status).toBe(401);
  });

  it('Guest Viewer มีเพดานแก้งานไม่ได้ แม้ปรับ L2 และ Guest Member ใช้งานตามสิทธิ์ได้', async () => {
    const i = await issue({ sharedWithGuests: true });
    await t.owner.query('INSERT INTO project_role_permissions (workspace_id, project_id, role, permission, allowed) SELECT workspace_id, id, \'viewer\', \'issue.edit\', true FROM projects WHERE id=$1', [team.project.id]);
    expect((await guest.post(`${path(i.key)}/checklist`, { text: 'ยังแก้ไม่ได้' })).status).toBe(403);
    await t.owner.query('UPDATE project_members SET role=\'member\' WHERE project_id=$1 AND user_id=$2', [team.project.id, guestId]);
    expect((await guest.post(`${path(i.key)}/checklist`, { text: 'ผู้ร่วมงานภายนอก' })).status).toBe(201);
    await t.owner.query('DELETE FROM project_role_permissions WHERE project_id=$1 AND role=\'viewer\' AND permission=\'issue.edit\'', [team.project.id]);
  });

  it('โปรเจกต์ที่เก็บถาวรอ่านได้แต่เปลี่ยนข้อมูลไม่ได้ งานที่ลบตอบ 410', async () => {
    const a = await issue();
    const b = await issue();
    const item = await checklist(a.key, { text: 'ก่อนเก็บถาวร' });
    await t.owner.query('UPDATE projects SET status=\'archived\' WHERE id=$1', [team.project.id]);
    try {
      expect((await team.lead.get(`${path(a.key)}/checklist`)).status).toBe(200);
      expect((await team.lead.get(`${path(a.key)}/dependencies`)).status).toBe(200);
      for (const response of [
        await team.lead.post(`${path(a.key)}/checklist`, { text: 'ห้ามแก้' }),
        await team.lead.patch(`${path(a.key)}/checklist/${item.id}`, { done: true }),
        await team.lead.delete(`${path(a.key)}/checklist/${item.id}`),
        await team.lead.post(`${path(a.key)}/checklist/reorder`, { ids: [item.id] }),
        await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key }),
        await team.lead.delete(`${path(a.key)}/dependencies`, { successorKey: b.key }),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('project_archived');
      }
    } finally {
      await t.owner.query('UPDATE projects SET status=\'planning\' WHERE id=$1', [team.project.id]);
    }
    await t.owner.query('UPDATE issues SET deleted_at=now() WHERE id=$1', [a.id]);
    expect((await team.lead.get(`${path(a.key)}/checklist`)).status).toBe(410);
    expect((await team.lead.post(`${path(a.key)}/dependencies`, { successorKey: b.key })).status).toBe(410);
  });
});
