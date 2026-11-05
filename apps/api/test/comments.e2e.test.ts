import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let guestId: string;
let guestMember: Client;
let outsider: Client;
let outsiderId: string;
let viewer: Client;
let viewerId: string;
let workspaceId: string;
const seen: DomainEvent[] = [];
const committed: boolean[] = [];

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  workspaceId = (await t.owner.query('select workspace_id from projects where id=$1', [team.project.id])).rows[0].workspace_id;
  guest = await client(t.app);
  guestId = await signup(guest, 'customer@comments.example.com', 'ลูกค้าทดลอง');
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
  guestMember = await client(t.app);
  const contractorId = await signup(guestMember, 'contractor@comments.example.com', 'Contractor Test');
  await addMember(t.owner, team.slug, contractorId, 'guest', { key: team.key, role: 'member' });
  outsider = await client(t.app);
  outsiderId = await signup(outsider, 'outside@comments.example.com', 'Outside User');
  await addMember(t.owner, team.slug, outsiderId, 'member');
  viewer = await client(t.app);
  viewerId = await signup(viewer, 'viewer@comments.example.com', 'Viewer Test');
  await addMember(t.owner, team.slug, viewerId, 'member', { key: team.key, role: 'viewer' });
  t.app.get(EventBus).on('*', async (e) => {
    if (e.type !== 'issue.commented' && e.type !== 'issue.mentioned') return;
    seen.push(e);
    const { rows } = await t.owner.query('select body from comments where id=$1', [e.data.commentId]);
    committed.push(rows.length === 1);
  });
});
afterAll(async () => { if (t) await t.close(); });

async function issue(sharedWithGuests = false, user = team.lead) {
  const r = await user.post(`${team.ws}/projects/${team.key}/issues`, { title: 'ตรวจสอบคอมเมนต์', moduleId: team.project.modules[0].id, sharedWithGuests });
  expect(r.status).toBe(201);
  return r.body as { id: string; key: string; version: number };
}
const path = (key: string) => `${team.ws}/issues/${key}`;

describe('Comments / mentions / watchers', () => {
  it('สร้างคอมเมนต์ แยก mention ซ้ำ และส่งเหตุการณ์หลัง commit พร้อมข้อความย่อ 140 ตัว', async () => {
    const i = await issue(false, team.dev);
    seen.length = 0;
    committed.length = 0;
    const body = '@Kaijeaw @Kaijeaw ' + 'ก'.repeat(160);
    const r = await team.lead.post(`${path(i.key)}/comments`, { body });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ body, author: { id: team.leadId, displayName: 'Mick', initials: 'MI', avatarUrl: null }, mentions: [{ id: team.devId, displayName: 'Kaijeaw' }], canEdit: true, canDelete: true, editedAt: null, deletedAt: null });
    expect((await t.owner.query('select user_id from comment_mentions where comment_id=$1', [r.body.id])).rows).toEqual([{ user_id: team.devId }]);
    expect(seen.map((e) => e.type)).toEqual(['issue.commented', 'issue.mentioned']);
    expect(seen[0]).toMatchObject({ workspaceId, projectId: team.project.id, issueId: i.id, actorId: team.leadId, data: { commentId: r.body.id, excerpt: [...body].slice(0, 140).join('') } });
    expect(seen[1].data).toMatchObject({ userIds: [team.devId] });
    expect(committed).toEqual([true, true]);
    const watchers = await team.lead.get(`${path(i.key)}/watchers`);
    expect(watchers.status).toBe(200);
    expect(watchers.body.items).toEqual(expect.arrayContaining([{ person: expect.objectContaining({ id: team.leadId }), source: 'auto_comment' }, { person: expect.objectContaining({ id: team.devId }), source: 'auto_create' }]));
    // ไม่เปลี่ยน source เดิมของผู้สร้าง และสมาชิกที่เพิ่งถูก mention ถูก Watch ด้วย auto_mention
    const other = await issue();
    await team.lead.post(`${path(other.key)}/comments`, { body: '@Kaijeaw' });
    expect((await t.owner.query('select source from issue_watchers where issue_id=$1 and user_id=$2', [other.id, team.devId])).rows[0].source).toBe('auto_mention');
  });

  it('ปฏิเสธ mention คนนอกโปรเจกต์ ชื่อกำกวม และสมาชิกที่ถูกปิดใช้งานโดยไม่เขียนข้อมูลหรือส่ง Event', async () => {
    const i = await issue();
    seen.length = 0;
    for (const body of ['@Outside User', `@[Outside User](${outsiderId})`, '@Nobody', '@KaijeawSuffix']) {
      const r = await team.lead.post(`${path(i.key)}/comments`, { body });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_mention');
    }
    await t.owner.query("update users set display_name='Kaijeaw' where id=$1", [viewerId]);
    expect((await team.lead.post(`${path(i.key)}/comments`, { body: '@Kaijeaw' })).body.error.code).toBe('invalid_mention');
    const stable = await team.lead.post(`${path(i.key)}/comments`, { body: `@[Kaijeaw](${team.devId})` });
    expect(stable.status).toBe(201);
    await t.owner.query("update users set display_name='Viewer Test' where id=$1", [viewerId]);
    await t.owner.query("update workspace_members set status='deactivated' where user_id=$1", [team.devId]);
    expect((await team.lead.post(`${path(i.key)}/comments`, { body: '@Kaijeaw' })).body.error.code).toBe('invalid_mention');
    await t.owner.query("update workspace_members set status='active' where user_id=$1", [team.devId]);
    expect((await t.owner.query('select count(*)::int as n from comments where issue_id=$1', [i.id])).rows[0].n).toBe(1);
    expect(seen.map((e) => e.type)).toEqual(['issue.commented', 'issue.mentioned']);
  });

  it('รองรับชื่อหลายคำและภาษาไทย ข้ามอีเมล และจำกัดรูปแบบข้อมูล', async () => {
    const i = await issue();
    const r = await team.lead.post(`${path(i.key)}/comments`, { body: '@Viewer Test ช่วยตรวจ @ลูกค้าทดลอง ติดต่อ user@example.com' });
    expect(r.status).toBe(201);
    expect(r.body.mentions.map((p: { id: string }) => p.id).sort()).toEqual([viewerId, guestId].sort());
    for (const body of ['', '  ', 'x'.repeat(20001)]) expect((await team.lead.post(`${path(i.key)}/comments`, { body })).status).toBe(400);
    expect((await team.lead.patch(`${path(i.key)}/comments/not-a-uuid`, { body: 'ใหม่' })).status).toBe(400);
  });

  it('แบ่งหน้าด้วย cursor ตามเวลาและ id แม้รายการเกิดในไมโครวินาทีเดียวกัน', async () => {
    const i = await issue();
    const ids: string[] = [];
    for (const body of ['หนึ่ง', 'สอง', 'สาม']) ids.push((await team.lead.post(`${path(i.key)}/comments`, { body })).body.id);
    await t.owner.query("update comments set created_at='2026-11-05 10:00:00.123456+00' where issue_id=$1", [i.id]);
    const first = await team.dev.get(`${path(i.key)}/comments?limit=1`);
    expect(first.body.items.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
    expect(first.body.items[0].canEdit).toBe(false);
    const second = await team.dev.get(`${path(i.key)}/comments?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((r: { id: string }) => r.id)).toEqual([ids[1]]);
    const third = await team.dev.get(`${path(i.key)}/comments?limit=1&cursor=${second.body.nextCursor}`);
    expect(third.body.items.map((r: { id: string }) => r.id)).toEqual([ids[2]]);
    expect(third.body.nextCursor).toBeNull();
    expect((await team.lead.get(`${path(i.key)}/comments?cursor=broken`)).body.error.code).toBe('invalid_cursor');
    const other = await issue();
    expect((await team.lead.get(`${path(other.key)}/comments?cursor=${first.body.nextCursor}`)).status).toBe(400);
    expect((await team.lead.get(`${path(i.key)}/comments?limit=101`)).status).toBe(400);
    expect((await team.lead.get(`${path(other.key)}/comments`)).body).toEqual({ items: [], nextCursor: null });
  });

  it('แก้ได้เฉพาะผู้เขียน ปรับ mention และแจ้งเฉพาะคนที่เพิ่มเข้ามา', async () => {
    const i = await issue();
    const created = await team.dev.post(`${path(i.key)}/comments`, { body: 'ก่อนแก้' });
    seen.length = 0;
    const denied = await team.lead.patch(`${path(i.key)}/comments/${created.body.id}`, { body: 'Admin แก้ไม่ได้' });
    expect(denied.status).toBe(403);
    const r = await team.dev.patch(`${path(i.key)}/comments/${created.body.id}`, { body: 'แก้แล้ว @Viewer Test' });
    expect(r.status).toBe(200);
    expect(r.body.editedAt).toEqual(expect.any(String));
    expect(r.body.mentions).toEqual([expect.objectContaining({ id: viewerId })]);
    expect(seen.map((e) => e.type)).toEqual(['issue.mentioned']);
    expect(seen[0].data.userIds).toEqual([viewerId]);
    seen.length = 0;
    await team.dev.patch(`${path(i.key)}/comments/${created.body.id}`, { body: 'เหมือนเดิม @Viewer Test' });
    expect(seen).toEqual([]);
    await team.dev.patch(`${path(i.key)}/comments/${created.body.id}`, { body: 'เอา mention ออก' });
    expect((await t.owner.query('select * from comment_mentions where comment_id=$1', [created.body.id])).rows).toEqual([]);
    expect((await t.owner.query('select * from issue_watchers where issue_id=$1 and user_id=$2', [i.id, viewerId])).rowCount).toBe(1);
  });

  it('ลบของตัวเองหรือให้ Admin ลบของคนอื่น ซ่อนข้อความและคืน tombstone', async () => {
    const i = await issue();
    const created = await team.dev.post(`${path(i.key)}/comments`, { body: 'ข้อความลับ @Viewer Test' });
    expect((await viewer.delete(`${path(i.key)}/comments/${created.body.id}`)).status).toBe(403);
    const removed = await team.lead.delete(`${path(i.key)}/comments/${created.body.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ body: null, deletionReason: 'admin', deletedBy: { id: team.leadId }, canEdit: false, canDelete: false, mentions: [] });
    expect(removed.body.deletedAt).toEqual(expect.any(String));
    expect((await t.owner.query('select body, deleted_by from comments where id=$1', [created.body.id])).rows[0]).toEqual({ body: '', deleted_by: team.leadId });
    expect((await team.dev.patch(`${path(i.key)}/comments/${created.body.id}`, { body: 'กู้ข้อความ' })).status).toBe(410);
    expect((await team.lead.delete(`${path(i.key)}/comments/${created.body.id}`)).body.deletedAt).toBe(removed.body.deletedAt);
    const self = await team.dev.post(`${path(i.key)}/comments`, { body: 'ลบเอง' });
    expect((await team.dev.delete(`${path(i.key)}/comments/${self.body.id}`)).body.deletionReason).toBe('author');
    const list = await team.lead.get(`${path(i.key)}/comments`);
    expect(list.body.items.every((c: { body: string | null }) => c.body === null)).toBe(true);
  });

  it('Watch/Unwatch เฉพาะตัวเอง ทำซ้ำได้และรักษา manual source เมื่อคอมเมนต์', async () => {
    const i = await issue();
    expect((await team.dev.get(`${path(i.key)}/watchers`)).body.watching).toBe(false);
    for (let n = 0; n < 2; n++) expect((await team.dev.post(`${path(i.key)}/watch`)).body).toEqual({ watching: true });
    await team.lead.post(`${path(i.key)}/comments`, { body: '@Kaijeaw' });
    const r = await team.dev.get(`${path(i.key)}/watchers`);
    expect(r.body.watching).toBe(true);
    expect(r.body.items.find((x: { person: { id: string } }) => x.person.id === team.devId).source).toBe('manual');
    for (let n = 0; n < 2; n++) expect((await team.dev.delete(`${path(i.key)}/watch`, { userId: team.leadId })).body).toEqual({ watching: false });
    expect((await t.owner.query('select user_id from issue_watchers where issue_id=$1', [i.id])).rows).toEqual([{ user_id: team.leadId }]);
  });

  it('รวมกิจกรรมกับคอมเมนต์ตามเวลา คืนค่าดิบและข้อมูลคน พร้อม cursor คนละชนิดกับ comments', async () => {
    const i = await issue();
    await team.lead.patch(path(i.key), { priority: 'high' }, i.version);
    const comment = await team.dev.post(`${path(i.key)}/comments`, { body: 'คุยในกิจกรรม' });
    const full = await team.lead.get(`${path(i.key)}/activity`);
    expect(full.status).toBe(200);
    expect(full.body.items).toEqual([
      expect.objectContaining({ kind: 'activity', verb: 'created', field: null, actor: expect.objectContaining({ id: team.leadId }), old: null, new: null }),
      expect.objectContaining({ kind: 'activity', verb: 'updated', field: 'priority', old: 'medium', new: 'high' }),
      expect.objectContaining({ kind: 'comment', id: comment.body.id, body: 'คุยในกิจกรรม', author: expect.objectContaining({ id: team.devId }) }),
    ]);
    const first = await team.lead.get(`${path(i.key)}/activity?limit=2`);
    expect(first.body.items).toHaveLength(2);
    const next = await team.lead.get(`${path(i.key)}/activity?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].kind).toBe('comment');
    expect(next.body.nextCursor).toBeNull();
    expect((await team.lead.get(`${path(i.key)}/comments?cursor=${first.body.nextCursor}`)).status).toBe(400);
  });

  it('Guest Viewer คุยได้เฉพาะงานที่แชร์และไม่เห็นชื่อ/id ของทีมในคอมเมนต์หรือกิจกรรม', async () => {
    const i = await issue(true);
    await team.lead.patch(path(i.key), { assigneeIds: [team.devId] }, i.version);
    const teamComment = await team.lead.post(`${path(i.key)}/comments`, { body: `สอบถาม @Kaijeaw และ @[Viewer Test](${viewerId})` });
    const own = await guest.post(`${path(i.key)}/comments`, { body: 'ลูกค้าตอบกลับ' });
    expect(own.status).toBe(201);
    expect(own.body.author.id).toBe(guestId);
    const list = await guest.get(`${path(i.key)}/comments`);
    expect(list.body.items[0]).toMatchObject({ author: { displayName: 'ทีมพัฒนา', avatarUrl: null }, body: 'สอบถาม @ทีมพัฒนา และ @ทีมพัฒนา', canEdit: false, canDelete: false });
    const activities = await guest.get(`${path(i.key)}/activity`);
    const assignees = activities.body.items.find((a: { field?: string }) => a.field === 'assigneeIds');
    expect(assignees).toMatchObject({ old: null, new: null });
    const watchers = await guest.get(`${path(i.key)}/watchers`);
    for (const response of [list, activities, watchers]) {
      const text = JSON.stringify(response.body);
      for (const secret of [team.leadId, team.devId, viewerId, 'Mick', 'Kaijeaw', 'Viewer Test']) expect(text).not.toContain(secret);
    }
    await team.lead.delete(`${path(i.key)}/comments/${teamComment.body.id}`);
    const deleted = (await guest.get(`${path(i.key)}/comments`)).body.items[0];
    expect(deleted).toMatchObject({ body: null, deletionReason: 'author', deletedBy: { displayName: 'ทีมพัฒนา' } });
    expect((await guest.post(`${path(i.key)}/watch`)).status).toBe(200);
    expect((await guest.delete(`${path(i.key)}/watch`)).status).toBe(200);
    const hidden = await issue(false);
    for (const endpoint of ['comments', 'activity', 'watchers']) expect((await guest.get(`${path(hidden.key)}/${endpoint}`)).status).toBe(404);
    expect((await guest.post(`${path(hidden.key)}/comments`, { body: 'ไม่ได้แชร์' })).status).toBe(404);
    expect((await guest.post(`${path(hidden.key)}/watch`)).status).toBe(404);
    const contractor = await guestMember.post(`${path(hidden.key)}/comments`, { body: '@Kaijeaw' });
    expect(contractor.status).toBe(201);
    expect(contractor.body.mentions[0].id).toBe(team.devId);
  });

  it('Guest Viewer ไม่เห็น Bug แม้แชร์ และไม่รั่วคอมเมนต์ข้ามงานหรือ Workspace', async () => {
    const bug = await team.lead.post(`${team.ws}/projects/DP/issues`, { title: 'บั๊กทดสอบ', type: 'Bug', severity: 'minor', environment: 'sit', details: { steps: 'จำลองขั้นตอน' }, sharedWithGuests: true });
    expect(bug.status).toBe(201);
    expect((await guest.get(`${path(bug.body.key)}/comments`)).status).toBe(404);
    const a = await issue();
    const b = await issue();
    const c = await team.lead.post(`${path(a.key)}/comments`, { body: 'เฉพาะงานแรก' });
    expect((await team.lead.patch(`${path(b.key)}/comments/${c.body.id}`, { body: 'ข้ามงาน' })).status).toBe(404);
    expect((await team.lead.delete(`${path(b.key)}/comments/${c.body.id}`)).status).toBe(404);
    const stranger = await client(t.app);
    await signup(stranger, 'tenant@comments.example.com', 'Other Tenant');
    await stranger.post('/workspaces', { name: 'Workspace สมมติ', slug: 'comments-other' });
    for (const endpoint of ['comments', 'activity', 'watchers']) expect((await stranger.get(`${path(a.key)}/${endpoint}`)).status).toBe(404);
    expect((await stranger.get(`/w/comments-other/issues/${a.key}/comments`)).status).toBe(404);
  });

  it('ตรวจ project.view และ issue.comment ทุกเส้นทาง รวมผู้เขียนที่สิทธิ์ถูกปิด', async () => {
    const i = await issue();
    const own = await team.dev.post(`${path(i.key)}/comments`, { body: 'ก่อนปิดสิทธิ์' });
    await t.owner.query("insert into project_role_permissions (workspace_id,project_id,role,permission,allowed) values ($1,$2,'member','issue.comment',false)", [workspaceId, team.project.id]);
    expect((await team.dev.post(`${path(i.key)}/comments`, { body: 'ใหม่' })).status).toBe(403);
    expect((await team.dev.patch(`${path(i.key)}/comments/${own.body.id}`, { body: 'แก้' })).status).toBe(403);
    expect((await team.dev.delete(`${path(i.key)}/comments/${own.body.id}`)).status).toBe(403);
    expect((await team.dev.get(`${path(i.key)}/comments`)).status).toBe(200);
    expect((await team.dev.post(`${path(i.key)}/watch`)).status).toBe(200);
    await t.owner.query("delete from project_role_permissions where project_id=$1 and permission='issue.comment'", [team.project.id]);
    for (const endpoint of ['comments', 'activity', 'watchers']) expect((await outsider.get(`${path(i.key)}/${endpoint}`)).status).toBe(404);
    expect((await outsider.post(`${path(i.key)}/watch`)).status).toBe(404);
    expect((await outsider.delete(`${path(i.key)}/watch`)).status).toBe(404);
    await t.owner.query("insert into project_role_permissions (workspace_id,project_id,role,permission,allowed) values ($1,$2,'viewer','project.view',false)", [workspaceId, team.project.id]);
    expect((await viewer.get(`${path(i.key)}/comments`)).status).toBe(403);
    await t.owner.query("delete from project_role_permissions where project_id=$1 and permission='project.view'", [team.project.id]);
  });
});
