// พักโปรเจกต์ (ผู้ใช้ขอ 2026-11-15) · ระหว่างพักเห็นได้เฉพาะ Owner / Admin ของโปรเจกต์, Owner / Admin ของ Workspace
// และสมาชิกที่ PM เลือก · Inbox ซ่อนแจ้งเตือนของโปรเจกต์ที่พักและที่ลบ · ข้อมูลสมมติทั้งหมด
import type { Db } from '@friday/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_DB } from '../src/db/db.module.js';
import { Audience } from '../src/notifications/audience.js';
import { addMember, client, seedTeam, signup, startApp, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let ba: Client;
let baId: string;
let pmAdmin: Client;
let pmAdminId: string;
let guest: Client;
let guestId: string;
let wsAdmin: Client;
let wsAdminId: string;
let issueKey: string;
let wsId: string;
let projectId: string;

const p = (key: string, rest = '') => `${team.ws}/projects/${key}${rest}`;
const keys = async (c: Client) => ((await c.get(`${team.ws}/projects`)).body.items as { key: string }[]).map((x) => x.key);
const inbox = async (c: Client) => (await c.get(`/me/notifications?workspace=${team.slug}`)).body as { items: { eventType: string; payload: Record<string, unknown> }[]; counts: { all: number; unread: number } };

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { slug: 'pause-ws', key: 'KL' });
  ba = await client(t.app);
  pmAdmin = await client(t.app);
  guest = await client(t.app);
  wsAdmin = await client(t.app);
  baId = await signup(ba, 'ba@pause.example.com', 'Preecha BA');
  pmAdminId = await signup(pmAdmin, 'admin@pause.example.com', 'Wanna Admin');
  guestId = await signup(guest, 'guest@pause.example.com', 'KL Client');
  wsAdminId = await signup(wsAdmin, 'wsadmin@pause.example.com', 'Ws Admin');
  await addMember(t.owner, team.slug, baId, 'member', { key: 'KL', role: 'member' });
  await addMember(t.owner, team.slug, pmAdminId, 'member', { key: 'KL', role: 'admin' });
  await addMember(t.owner, team.slug, guestId, 'guest', { key: 'KL', role: 'viewer' });
  await addMember(t.owner, team.slug, wsAdminId, 'admin');
  projectId = team.project.id;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;

  const created = await team.lead.post(p('KL', '/issues'), { title: 'วางผังห้องประชุมชั้น 3', moduleId: team.project.modules[0].id, assigneeIds: [team.devId] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  issueKey = created.body.key;
  // แจ้งเตือนเก่าของโปรเจกต์ใน Inbox ของ dev
  await t.owner.query('DELETE FROM notifications');
  await t.owner.query(
    `INSERT INTO notifications (workspace_id, recipient_id, event_type, project_id, payload, reason)
     VALUES ($1, $2, 'issue.assigned', $3, '{"projectKey":"KL","issueTitle":"วางผังห้องประชุมชั้น 3"}'::jsonb, 'ทดสอบ')`,
    [wsId, team.devId, projectId],
  );
});
afterAll(() => t.close());

describe('พักโปรเจกต์', () => {
  it('ใช้สิทธิ์เดียวกับ Archive: Member พักไม่ได้', async () => {
    const r = await team.dev.post(p('KL', '/pause'), {});
    expect(r.status).toBe(403);
    expect(r.body.error.details.permission).toBe('project.archive');
  });

  it('PM พักพร้อมเลือกคนที่ยังเห็น · คนที่มองไม่เห็นได้แจ้งเตือนพร้อมข้อความ', async () => {
    expect((await inbox(team.dev)).items.map((n) => n.eventType)).toEqual(['issue.assigned']);
    const r = await team.lead.post(p('KL', '/pause'), { viewerIds: [baId], notify: true, message: 'รอลูกค้ายืนยันแบบชั้น 3' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pausedAt).toEqual(expect.any(String));
    expect((await team.lead.post(p('KL', '/pause'), {})).body.error.code).toBe('already_paused');

    const dev = await inbox(team.dev);
    // แจ้งเตือนเก่าของโปรเจกต์ถูกซ่อน เหลือแต่ข้อความพักโปรเจกต์
    expect(dev.items.map((n) => n.eventType)).toEqual(['project.paused']);
    expect(dev.items[0].payload).toMatchObject({ projectKey: 'KL', message: 'รอลูกค้ายืนยันแบบชั้น 3', actorName: 'Mick' });
    expect(dev.counts.unread).toBe(1);
    expect((await team.dev.get('/me/notifications/summary')).body.total).toBe(1);
    expect((await inbox(guest)).items.map((n) => n.eventType)).toEqual(['project.paused']);
    // คนที่ยังเห็นไม่ได้รับแจ้ง
    for (const c of [ba, pmAdmin, wsAdmin, team.lead]) expect((await inbox(c)).items.filter((n) => n.eventType === 'project.paused')).toEqual([]);
    const audit = await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'project.paused'`);
    expect(audit.rows[0].summary).toContain('ซ่อนจากสมาชิก 2 คน');
  });

  it('Member ที่ไม่ได้เลือกมองไม่เห็นโปรเจกต์และงาน · เปิดลิงก์ได้ 403 project_paused', async () => {
    expect(await keys(team.dev)).not.toContain('KL');
    const r = await team.dev.get(p('KL'));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'project_paused', details: { key: 'KL', name: 'Development Plan', pausedBy: 'Mick' } });
    expect((await team.dev.get(`${team.ws}/issues/${issueKey}`)).body.error.code).toBe('project_paused');
    expect(JSON.stringify((await team.dev.get(`${team.ws}/my-issues?tab=assigned`)).body)).not.toContain('วางผังห้องประชุม');
    expect(JSON.stringify((await team.dev.get(`${team.ws}/home`)).body)).not.toContain('วางผังห้องประชุม');
    expect(JSON.stringify((await team.dev.get(`${team.ws}/search?q=${encodeURIComponent('วางผัง')}`)).body)).not.toContain('วางผังห้องประชุม');
    // Guest ก็เหมือนกัน · คนนอกโปรเจกต์ยังได้ 404 เหมือนเดิม
    expect((await guest.get(p('KL'))).body.error.code).toBe('project_paused');
    expect((await team.dev.get(p('NOPE'))).body.error.code).toBe('project_not_found');
  });

  it('Owner, Admin ของโปรเจกต์, สมาชิกที่เลือก และ Workspace Admin ยังเห็น · ทำงานได้ตาม Role เดิม', async () => {
    for (const c of [team.lead, pmAdmin, ba]) {
      expect(await keys(c)).toContain('KL');
      expect((await c.get(p('KL'))).status).toBe(200);
    }
    expect(await keys(wsAdmin)).toContain('KL');
    const edit = await ba.post(p('KL', '/issues'), { title: 'ขอบเขตงานระยะที่ 2', moduleId: team.project.modules[0].id });
    expect(edit.status, JSON.stringify(edit.body)).toBe(201);
    const members = (await team.lead.get(p('KL', '/members'))).body.items as { userId: string; visibleWhilePaused: boolean }[];
    expect(members.filter((m) => m.visibleWhilePaused).map((m) => m.userId)).toEqual([baId]);
  });

  it('งานเบื้องหลังไม่แจ้งคนที่มองไม่เห็น (Inbox / LINE ใช้รายชื่อเดียวกัน)', async () => {
    const audience = new Audience(t.app.get<Db>(SYSTEM_DB));
    const project = await audience.project(projectId);
    const visible = await audience.visible([team.devId, baId, pmAdminId, guestId, team.leadId], project!);
    expect([...visible].sort()).toEqual([baId, pmAdminId, team.leadId].sort());
  });

  it('Archive ระหว่างพักไม่ได้', async () => {
    expect((await team.lead.post(p('KL', '/archive'))).body.error.code).toBe('project_paused');
  });

  it('เปลี่ยนคนที่เห็นระหว่างพัก', async () => {
    expect((await ba.put(p('KL', '/pause/viewers'), { viewerIds: [] })).status).toBe(403);
    const r = await team.lead.put(p('KL', '/pause/viewers'), { viewerIds: [team.devId] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.viewerIds).toEqual([team.devId]);
    expect((await ba.get(p('KL'))).body.error.code).toBe('project_paused');
    expect((await team.dev.get(p('KL'))).status).toBe(200);
    // คนที่ได้เห็นแล้ว แจ้งเตือนเก่ากลับมาใน Inbox
    expect((await inbox(team.dev)).items.map((n) => n.eventType).sort()).toEqual(['issue.assigned', 'project.paused']);
    await team.lead.put(p('KL', '/pause/viewers'), { viewerIds: [baId] });
  });

  it('เปิดใช้งานต่อ: ทุกคนเห็นเหมือนเดิม แจ้งเตือนเก่ากลับมา และแจ้งคนที่เคยมองไม่เห็น', async () => {
    const r = await team.lead.post(p('KL', '/resume'), { notify: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pausedAt).toBeNull();
    expect((await team.lead.post(p('KL', '/resume'), {})).body.error.code).toBe('not_paused');
    expect((await team.dev.get(p('KL'))).status).toBe(200);
    expect(await keys(team.dev)).toContain('KL');
    expect((await inbox(team.dev)).items.map((n) => n.eventType).sort()).toEqual(['issue.assigned', 'project.paused', 'project.resumed']);
    expect((await inbox(ba)).items.filter((n) => n.eventType === 'project.resumed')).toEqual([]);
    const members = (await team.lead.get(p('KL', '/members'))).body.items as { visibleWhilePaused: boolean }[];
    expect(members.every((m) => !m.visibleWhilePaused)).toBe(true);
  });

  it('พักโดยไม่แจ้ง: ไม่มีข้อความเพิ่มใน Inbox', async () => {
    await t.owner.query(`DELETE FROM notifications WHERE event_type LIKE 'project.%'`);
    expect((await team.lead.post(p('KL', '/pause'), { notify: false })).status).toBe(200);
    expect((await inbox(team.dev)).items).toEqual([]);
    expect((await team.lead.post(p('KL', '/resume'), { notify: false })).status).toBe(200);
    expect((await inbox(team.dev)).items.map((n) => n.eventType)).toEqual(['issue.assigned']);
  });
});

describe('Inbox ของโปรเจกต์ที่ลบ', () => {
  it('ลบโปรเจกต์แล้วแจ้งเตือนของโปรเจกต์หายจาก Inbox · ลบถาวรแล้วลบแจ้งเตือนทิ้ง', async () => {
    expect((await inbox(team.dev)).items.map((n) => n.eventType)).toEqual(['issue.assigned']);
    const del = await team.lead.delete(p('KL'), { confirmKey: 'KL' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await inbox(team.dev)).items).toEqual([]);
    expect((await team.dev.get('/me/notifications/summary')).body.total).toBe(0);

    // Workspace Owner ลบถาวรจากถังขยะ
    const purge = await team.lead.delete(`${team.ws}/trash/project/${projectId}`, { confirm: 'ลบถาวร' });
    expect(purge.status, JSON.stringify(purge.body)).toBe(200);
    const left = await t.owner.query('SELECT count(*)::int AS n FROM notifications WHERE project_id = $1', [projectId]);
    expect(left.rows[0].n).toBe(0);
  });
});
