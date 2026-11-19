// แท็บ Diagram · สร้าง / บันทึก / แก้ทีละคน / ผูกงาน / ลบและกู้คืน / แพ็กเกจ Free · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client;
let guest: Client;
let wsId: string;
let base: string;
let issueId: string;
let issueKey: string;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  base = `${team.ws}/projects/${team.key}`;
  viewer = await client(t.app);
  await addMember(t.owner, team.slug, await signup(viewer, 'viewer@diagrams.example.com', 'Viewer'), 'member', { key: team.key, role: 'viewer' });
  guest = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guest, 'guest@diagrams.example.com', 'Guest'), 'guest', { key: team.key, role: 'viewer' });
  const issue = await team.lead.post(`${base}/issues`, { title: 'ฟอร์มหลักประกัน 5 ประเภท', moduleId: team.project.modules[0].id, planEnd: '2026-01-05' });
  expect(issue.status, JSON.stringify(issue.body)).toBe(201);
  issueId = issue.body.id;
  issueKey = issue.body.key;
});
afterAll(() => t.close());

const node = (id: string, type: string, x: number, y: number, label: string, issue: string | null = null) => ({ id, type, position: { x, y }, data: { label, color: 'default', issueId: issue } });

describe('สร้างและอ่าน', () => {
  it('สร้างจากแบบ Flowchart ได้กล่องตัวอย่าง และคนสร้างถือสิทธิ์แก้ทันที', async () => {
    const r = await team.lead.post(`${base}/diagrams`, { name: 'Workflow อนุมัติวงเงิน', template: 'flowchart' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.content.nodes.map((n: { type: string }) => n.type)).toEqual(['terminator', 'process', 'terminator']);
    expect(r.body.content.edges).toHaveLength(2);
    expect(r.body.lock.userId).toBe(team.leadId);
    expect(r.body.permissions).toEqual({ edit: true, takeover: true, delete: true });
    const list = await team.dev.get(`${base}/diagrams`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ name: 'Workflow อนุมัติวงเงิน', template: 'flowchart', issueCount: 0, lock: { userId: team.leadId } });
    expect(list.body.items[0].preview.nodes).toHaveLength(3);
    expect(list.body.permissions).toMatchObject({ edit: true, takeover: false });
  });

  it('ชื่อว่างหรือแบบเริ่มต้นที่ไม่รู้จัก → 400', async () => {
    expect((await team.lead.post(`${base}/diagrams`, { name: '  ' })).status).toBe(400);
    expect((await team.lead.post(`${base}/diagrams`, { name: 'x', template: 'mindmap' })).status).toBe(400);
  });

  it('Viewer ดูได้แต่สร้างไม่ได้ · Guest Viewer เข้าไม่ได้', async () => {
    expect((await viewer.get(`${base}/diagrams`)).status).toBe(200);
    const r = await viewer.post(`${base}/diagrams`, { name: 'ของ Viewer' });
    expect(r.status).toBe(403);
    expect(r.body.error.details.permission).toBe('diagram.edit');
    expect((await guest.get(`${base}/diagrams`)).body.error.code).toBe('guest_view_limited');
  });

  it('กรองตามประเภทและค้นชื่อ', async () => {
    await team.lead.post(`${base}/diagrams`, { name: 'ER Credit Line', template: 'er' });
    expect((await team.lead.get(`${base}/diagrams?template=er`)).body.items.map((d: { name: string }) => d.name)).toEqual(['ER Credit Line']);
    expect((await team.lead.get(`${base}/diagrams?q=วงเงิน`)).body.items.map((d: { name: string }) => d.name)).toEqual(['Workflow อนุมัติวงเงิน']);
  });
});

describe('บันทึกและแก้ทีละคน', () => {
  let id: string;
  let revision: number;
  beforeAll(async () => {
    const r = await team.lead.post(`${base}/diagrams`, { name: 'แก้ทีละคน', template: 'blank' });
    id = r.body.id;
    revision = r.body.revision;
  });

  it('คนถือสิทธิ์บันทึกได้ · ผูกงานแล้วได้ชิปสถานะ (เลยกำหนด) · revision เพิ่ม', async () => {
    const content = { nodes: [node('a', 'process', 0, 0, 'ตรวจหลักประกัน', issueId), node('b', 'decision', 0, 120, 'ผ่าน?')], edges: [{ id: 'e1', source: 'a', target: 'b', label: 'ต่อ' }] };
    const r = await team.lead.put(`${base}/diagrams/${id}/content`, { revision, content });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.revision).toBe(revision + 1);
    expect(r.body.issues[issueId]).toMatchObject({ key: issueKey, tone: 'overdue', deleted: false });
    revision = r.body.revision;
    const got = await team.dev.get(`${base}/diagrams/${id}`);
    expect(got.body.content.nodes[0].data.issueId).toBe(issueId);
    expect((await team.dev.get(`${base}/diagrams?issue=${issueId}`)).body.items.map((d: { id: string }) => d.id)).toEqual([id]);
  });

  it('คนอื่นขอสิทธิ์แก้ระหว่างที่มีคนถืออยู่ → 409 diagram_locked พร้อมชื่อคนถือ · บันทึกไม่ได้', async () => {
    const lock = await team.dev.post(`${base}/diagrams/${id}/lock`, {});
    expect(lock.status).toBe(409);
    expect(lock.body.error).toMatchObject({ code: 'diagram_locked', details: { lock: { userId: team.leadId, user: { displayName: 'Mick' } } } });
    const save = await team.dev.put(`${base}/diagrams/${id}/content`, { revision, content: { nodes: [], edges: [] } });
    expect(save.status).toBe(409);
    expect(save.body.error.code).toBe('diagram_locked');
  });

  it('Member แก้ไขแทนไม่ได้ · Admin แก้ไขแทนได้ แล้วคนเดิมบันทึกต่อไม่ได้ (งานเดิมยังอยู่)', async () => {
    // ให้ dev ถือสิทธิ์ก่อน แล้ว lead (Admin) แก้ไขแทน
    await team.lead.delete(`${base}/diagrams/${id}/lock`);
    expect((await team.dev.post(`${base}/diagrams/${id}/lock`, {})).status).toBe(200);
    const denied = await team.dev.post(`${base}/diagrams/${id}/lock`, { takeover: true });
    expect(denied.status).toBe(200); // ของตัวเองอยู่แล้ว ต่ออายุได้
    const viewerTake = await viewer.post(`${base}/diagrams/${id}/lock`, { takeover: true });
    expect(viewerTake.status).toBe(403);
    const take = await team.lead.post(`${base}/diagrams/${id}/lock`, { takeover: true });
    expect(take.status).toBe(200);
    expect(take.body.lock.userId).toBe(team.leadId);
    expect(take.body.content.nodes).toHaveLength(2);
    const late = await team.dev.put(`${base}/diagrams/${id}/content`, { revision, content: { nodes: [], edges: [] } });
    expect(late.body.error.code).toBe('diagram_locked');
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'diagram.takeover' AND target_id = $1`, [id]);
    expect(audit.rows[0].summary).toContain('แก้ไขแทน Kaijeaw');
  });

  it('member ทั่วไปขอ takeover ขณะที่คนอื่นถือ → 403', async () => {
    const r = await team.dev.post(`${base}/diagrams/${id}/lock`, { takeover: true });
    expect(r.status).toBe(403);
    expect(r.body.error.details.permission).toBe('diagram.takeover');
  });

  it('revision เก่า → 409 diagram_conflict', async () => {
    const r = await team.lead.put(`${base}/diagrams/${id}/content`, { revision: revision - 1, content: { nodes: [], edges: [] } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('diagram_conflict');
  });

  it('สิทธิ์หมดอายุแล้ว คนอื่นรับต่อได้เอง', async () => {
    await t.owner.query(`UPDATE diagrams SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const r = await team.dev.post(`${base}/diagrams/${id}/lock`, {});
    expect(r.status).toBe(200);
    expect(r.body.lock.userId).toBe(team.devId);
  });

  it('ข้อมูลผิดรูปแบบ: เส้นต่อกับกล่องที่ไม่มี / รูปทรงที่ไม่รู้จัก → 400 · งานนอกโปรเจกต์ → 422', async () => {
    const rev = (await team.dev.get(`${base}/diagrams/${id}`)).body.revision;
    const bad = async (content: unknown) => (await team.dev.put(`${base}/diagrams/${id}/content`, { revision: rev, content })).body.error.code;
    expect(await bad({ nodes: [node('a', 'process', 0, 0, 'x')], edges: [{ id: 'e', source: 'a', target: 'zz' }] })).toBe('invalid_input');
    expect(await bad({ nodes: [{ ...node('a', 'process', 0, 0, 'x'), type: 'star' }], edges: [] })).toBe('invalid_input');
    expect(await bad({ nodes: [node('a', 'process', 0, 0, 'x', '00000000-0000-4000-8000-000000000000')], edges: [] })).toBe('diagram_issue_not_found');
  });
});

describe('ลบและกู้คืน', () => {
  it('Member ลบได้เฉพาะที่ตัวเองสร้าง · Admin ลบได้ทุกอัน · กู้คืนได้ด้วยสิทธิ์ถังขยะ', async () => {
    const mine = (await team.dev.post(`${base}/diagrams`, { name: 'ของ Dev' })).body.id;
    const lead = (await team.lead.post(`${base}/diagrams`, { name: 'ของ Lead' })).body.id;
    await team.lead.delete(`${base}/diagrams/${lead}/lock`);
    const denied = await team.dev.delete(`${base}/diagrams/${lead}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('diagram_delete_own_only');
    expect((await team.dev.delete(`${base}/diagrams/${mine}`)).status).toBe(200);
    expect((await team.dev.get(`${base}/diagrams/${mine}`)).status).toBe(404);
    const row = await t.owner.query('SELECT deleted_by FROM diagrams WHERE id = $1', [mine]);
    expect(row.rows[0].deleted_by).toBe(team.devId);
    expect((await team.dev.post(`${base}/diagrams/${mine}/restore`)).status).toBe(403);
    const restored = await team.lead.post(`${base}/diagrams/${mine}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.name).toBe('ของ Dev');
  });
});

describe('ตัวเลือกงาน', () => {
  it('ค้นด้วยเลขงานหรือชื่อ', async () => {
    const byKey = await team.lead.get(`${base}/diagram-issue-options?q=${issueKey}`);
    expect(byKey.body.items[0]).toMatchObject({ id: issueId, key: issueKey, tone: 'overdue' });
    expect((await team.lead.get(`${base}/diagram-issue-options?q=หลักประกัน`)).body.items[0].id).toBe(issueId);
    expect((await viewer.get(`${base}/diagram-issue-options?q=1`)).status).toBe(403);
  });
});

describe('แพ็กเกจ Free', () => {
  it('Free ใช้ Diagram ไม่ได้ → 402 plan_feature_unavailable', async () => {
    await team.lead.get(`${team.ws}/usage`);
    await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free'), status = 'active', trial_ends_at = NULL WHERE workspace_id = $1`, [wsId]);
    const r = await team.lead.get(`${base}/diagrams`);
    expect(r.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: 'plan_feature_unavailable', details: { feature: 'diagrams', plan: 'free' } });
    expect((await team.lead.post(`${base}/diagrams`, { name: 'x' })).status).toBe(402);
  });
});
