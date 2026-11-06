// A31 · PDPA, Export ข้อมูล Workspace, สิทธิ์ทีม Friday, ลบ Workspace · ข้อมูลสมมติเท่านั้น
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { ExportsService } from '../src/privacy/exports.service.js';
import { WorkspaceLifecycleService } from '../src/privacy/lifecycle.service.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let ws: string;
let wsId: string;
let moduleId: string;

const audit = async (action: string, id = wsId) => (await t.owner.query(`SELECT category, summary FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at DESC`, [id, action])).rows;
async function download(c: Client, url: string) {
  const res = await c.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (x: Buffer) => chunks.push(x));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return res as typeof res & { body: Buffer };
}

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  ws = team.ws;
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  moduleId = team.project.modules[0].id;
});
afterAll(() => t.close());

describe('สิทธิ์', () => {
  it('Member ใช้ endpoint ของหมวดนี้ไม่ได้ · support-access แก้ได้เฉพาะ Owner', async () => {
    for (const u of ['exports', 'data-requests', 'support-access']) expect((await team.dev.get(`${ws}/${u}`)).status, u).toBe(403);
    expect((await team.dev.post(`${ws}/exports`)).status).toBe(403);
    expect((await team.dev.delete(ws, { confirmSlug: team.slug })).status).toBe(403);
    const a = await client(t.app);
    const adminId = await signup(a, 'admin@privacy.example.com', 'Admin');
    await addMember(t.owner, team.slug, adminId, 'admin');
    expect((await a.get(`${ws}/support-access`)).status).toBe(200);
    const put = await a.put(`${ws}/support-access`, { enabled: true });
    expect(put.status).toBe(403);
    expect(put.body.error.details.permission).toBe('ws.owner');
    expect((await a.delete(ws, { confirmSlug: team.slug })).status).toBe(403);
  });
});

describe('Export ทั้ง Workspace', () => {
  it('POST exports → 202 · คิวทำเสร็จแล้วดาวน์โหลด zip (JSON + CSV + ไฟล์แนบ) ได้', async () => {
    const hidden = await team.lead.post(`${ws}/projects`, { key: 'PRV', name: 'Private Plan', startDate: '2026-11-05', goliveDate: '2027-03-01', modules: ['M'], visibility: 'private' });
    expect(hidden.status).toBe(201);
    const issue = (await team.lead.post(`${ws}/projects/${team.key}/issues`, { title: '=cmd|calc', moduleId, assigneeIds: [team.devId] })).body;
    await team.dev.post(`${ws}/issues/${issue.key}/comments`, { body: 'คอมเมนต์ทดสอบ Export' });

    // ไฟล์แนบ 1 ไฟล์ (เขียนตรงลงที่เก็บในเครื่อง)
    const key = `ws/${randomUUID()}/note.txt`;
    const path = join(config.uploadDir, 'files', key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'เนื้อหาไฟล์แนบ');
    const projectId = team.project.id;
    const file = await t.owner.query(`INSERT INTO files (workspace_id, project_id, kind, name, mime, uploaded_by) VALUES ($1,$2,'upload','note.txt','text/plain',$3) RETURNING id`, [wsId, projectId, team.leadId]);
    const ver = await t.owner.query(`INSERT INTO file_versions (workspace_id, file_id, version_no, storage_key, size_bytes, uploaded_by) VALUES ($1,$2,1,$3,$4,$5) RETURNING id`, [wsId, file.rows[0].id, key, 30, team.leadId]);
    await t.owner.query(`UPDATE files SET current_version_id = $1 WHERE id = $2`, [ver.rows[0].id, file.rows[0].id]);

    const r = await team.lead.post(`${ws}/exports`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ requestedBy: { displayName: 'Mick' } });
    const got = await team.lead.get(`${ws}/exports/${r.body.id}`);
    expect(got.body).toMatchObject({ status: 'ready', downloadUrl: `/api/v1/w/${team.slug}/exports/${r.body.id}/download` });
    expect(got.body.sizeBytes).toBeGreaterThan(200);
    expect(new Date(got.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await team.lead.get(`${ws}/exports`)).body.items.map((x: { id: string }) => x.id)).toContain(r.body.id);

    const dl = await download(team.lead, `${ws}/exports/${r.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/zip');
    expect(dl.headers['content-disposition']).toContain(`${team.slug}-export-`);
    const files = unzipSync(new Uint8Array(dl.body));
    expect(Object.keys(files).sort()).toEqual(expect.arrayContaining(['README.txt', 'workspace.json', 'members.csv', 'files-manifest.json', 'projects/DP/project.json', 'projects/DP/issues.json', 'projects/DP/issues.csv', 'projects/PRV/project.json']));
    const wsJson = JSON.parse(strFromU8(files['workspace.json']));
    expect(wsJson.workspace.slug).toBe(team.slug);
    expect(wsJson.members.map((m: { email: string }) => m.email).sort()).toEqual(['admin@privacy.example.com', `dev@${team.slug}.example.com`, `lead@${team.slug}.example.com`]);
    expect(strFromU8(files['workspace.json'])).not.toMatch(/passwordHash|password_hash|secret/i);
    const issues = JSON.parse(strFromU8(files['projects/DP/issues.json']));
    const exported = issues.find((i: { key: string }) => i.key === issue.key);
    expect(exported).toMatchObject({ title: '=cmd|calc', assigneeIds: [team.devId], comments: [{ body: 'คอมเมนต์ทดสอบ Export' }] });
    const csv = strFromU8(files['projects/DP/issues.csv']);
    expect([...files['projects/DP/issues.csv'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM ให้ Excel อ่านภาษาไทยถูก
    expect(csv).toContain(`'=cmd|calc`); // กัน CSV injection
    const manifest = JSON.parse(strFromU8(files['files-manifest.json']));
    expect(manifest).toEqual([expect.objectContaining({ name: 'note.txt', included: true })]);
    expect(strFromU8(files[manifest[0].path])).toBe('เนื้อหาไฟล์แนบ');

    expect((await audit('export.requested')).length).toBe(1);
    expect((await audit('export.completed')).length).toBe(1);
    expect((await audit('export.downloaded')).length).toBe(1);
    expect((await team.dev.get(`${ws}/exports/${r.body.id}/download`)).status).toBe(403);
  });

  it('ครั้งละหนึ่งงาน · ยังไม่เสร็จ / หมดอายุ / ผู้ขอไม่ใช่ Admin แล้ว', async () => {
    const queued = await t.owner.query(`INSERT INTO workspace_exports (workspace_id, requested_by) VALUES ($1, $2) RETURNING id`, [wsId, team.leadId]);
    const busy = await team.lead.post(`${ws}/exports`);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({ code: 'export_in_progress', details: { exportId: queued.rows[0].id } });
    const nr = await team.lead.get(`${ws}/exports/${queued.rows[0].id}/download`);
    expect(nr.body.error.code).toBe('export_not_ready');
    expect((await team.lead.get(`${ws}/exports/not-a-uuid`)).status).toBe(404);

    // ผู้ขอถูกลดเป็น Member ก่อนงานรัน → งานล้ม ไม่สร้างไฟล์
    const demoted = await t.owner.query(`INSERT INTO workspace_exports (workspace_id, requested_by) VALUES ($1, $2) RETURNING id`, [wsId, team.devId]);
    await t.app.get(ExportsService).run(demoted.rows[0].id);
    expect((await t.owner.query(`SELECT status FROM workspace_exports WHERE id = $1`, [demoted.rows[0].id])).rows[0].status).toBe('failed');
    await t.owner.query(`UPDATE workspace_exports SET status = 'failed' WHERE id = $1`, [queued.rows[0].id]);

    const fresh = await team.lead.post(`${ws}/exports`);
    expect(fresh.status).toBe(202);
    await t.owner.query(`UPDATE workspace_exports SET expires_at = now() - interval '1 hour' WHERE id = $1`, [fresh.body.id]);
    const gone = await team.lead.get(`${ws}/exports/${fresh.body.id}/download`);
    expect(gone.status).toBe(410);
    expect((await team.lead.get(`${ws}/exports/${fresh.body.id}`)).body).toMatchObject({ status: 'expired', downloadUrl: null });
    const cleaned = await t.app.get(ExportsService).cleanup();
    expect(cleaned.expired).toBeGreaterThanOrEqual(1);
    expect(await stat(join(config.uploadDir, 'exports', `${fresh.body.id}.zip`)).catch(() => null)).toBeNull();
  });
});

describe('คำขอจากเจ้าของข้อมูล (PDPA)', () => {
  let bobId = '';
  const email = (n: string) => `${n}@privacy.example.com`;

  it('บันทึกคำขอ ครบกำหนด 30 วัน · ซ้ำไม่ได้ · กรองตามสถานะ · เปลี่ยนสถานะ', async () => {
    const r = await team.lead.post(`${ws}/data-requests`, { requesterEmail: 'Jane@Privacy.Example.com', requestType: 'erase' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ requesterEmail: 'jane@privacy.example.com', requestType: 'erase', status: 'pending', daysLeft: 30, overdue: false, hasResult: false });
    expect((await team.lead.post(`${ws}/data-requests`, { requesterEmail: 'jane@privacy.example.com', requestType: 'erase' })).body.error.code).toBe('data_request_exists');
    expect((await team.lead.post(`${ws}/data-requests`, { requesterEmail: 'jane@privacy.example.com', requestType: 'export' })).status).toBe(201);
    expect((await team.lead.post(`${ws}/data-requests`, { requesterEmail: 'not-an-email', requestType: 'erase' })).status).toBe(400);

    const p = await team.lead.patch(`${ws}/data-requests/${r.body.id}`, { status: 'in_progress' });
    expect(p.body).toMatchObject({ status: 'in_progress', handledBy: { displayName: 'Mick' } });
    expect((await team.lead.patch(`${ws}/data-requests/${r.body.id}`, { status: 'completed' })).status).toBe(400);
    expect((await team.lead.get(`${ws}/data-requests?status=in_progress`)).body.items).toHaveLength(1);
    expect((await team.lead.get(`${ws}/data-requests?status=open`)).body.items).toHaveLength(2);
    expect((await team.lead.get(`${ws}/data-requests?status=bogus`)).status).toBe(400);
    await t.owner.query(`UPDATE data_subject_requests SET due_date = current_date - 3 WHERE id = $1`, [r.body.id]);
    const late = (await team.lead.get(`${ws}/data-requests`)).body.items[0];
    expect(late).toMatchObject({ id: r.body.id, overdue: true });
    expect(late.daysLeft).toBeLessThan(0);
    await t.owner.query(`DELETE FROM data_subject_requests WHERE workspace_id = $1`, [wsId]);
  });

  it('ขอสำเนาข้อมูล: ปิดคำขอแล้วได้ไฟล์ JSON ของเจ้าของข้อมูลเอง', async () => {
    const r = (await team.lead.post(`${ws}/data-requests`, { requesterEmail: `dev@${team.slug}.example.com`, requestType: 'export' })).body;
    expect((await team.lead.get(`${ws}/data-requests/${r.id}/result`)).status).toBe(409);
    const done = await team.lead.post(`${ws}/data-requests/${r.id}:complete`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', hasResult: true, result: { found: true, file: true }, handledBy: { displayName: 'Mick' } });
    const res = await download(team.lead, `${ws}/data-requests/${r.id}/result`);
    expect(res.status).toBe(200);
    const bundle = JSON.parse(res.body.toString('utf8'));
    expect(bundle.user).toMatchObject({ id: team.devId, email: `dev@${team.slug}.example.com`, displayName: 'Kaijeaw' });
    expect(bundle.issuesAssigned.map((i: { number: number }) => i.number)).toContain(1);
    expect(bundle.comments.map((c: { body: string }) => c.body)).toContain('คอมเมนต์ทดสอบ Export');
    expect(JSON.stringify(bundle)).not.toContain('passwordHash');
    expect((await team.lead.post(`${ws}/data-requests/${r.id}/complete`, {})).body.error.code).toBe('data_request_completed');
    expect((await team.lead.patch(`${ws}/data-requests/${r.id}`, { status: 'pending' })).status).toBe(409);
    expect(await audit('data_request.exported')).toHaveLength(1);
    // ไม่พบผู้ขอใน Workspace → ปิดได้ แต่ไม่มีไฟล์
    const none = (await team.lead.post(`${ws}/data-requests`, { requesterEmail: 'nobody@privacy.example.com', requestType: 'export' })).body;
    expect((await team.lead.post(`${ws}/data-requests/${none.id}:complete`, {})).body.result).toEqual({ found: false });
    expect((await team.lead.get(`${ws}/data-requests/${none.id}/result`)).status).toBe(409);
  });

  it('ขอลบข้อมูล: ต้องยืนยันอีเมล · Owner คนเดียวลบไม่ได้ · ถอนจาก Workspace และทำเป็นนิรนามเมื่อไม่มี Workspace อื่น', async () => {
    const bob = await client(t.app);
    bobId = await signup(bob, email('bob'), 'Bob');
    await addMember(t.owner, team.slug, bobId, 'member', { key: team.key, role: 'member' });
    await t.owner.query(`INSERT INTO team_members (workspace_id, team_id, user_id) SELECT $1, id, $2 FROM (SELECT id FROM teams LIMIT 1) x`, [wsId, bobId]).catch(() => undefined);
    await team.dev.post(`${ws}/projects/${team.key}/issues`, { title: 'ของ Bob', moduleId }).catch(() => undefined);
    expect((await bob.get(`/me`)).status).toBe(200);

    const req = (await team.lead.post(`${ws}/data-requests`, { requesterEmail: email('bob'), requestType: 'erase' })).body;
    const noConfirm = await team.lead.post(`${ws}/data-requests/${req.id}:complete`, {});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('confirm_required');
    expect((await team.lead.post(`${ws}/data-requests/${req.id}:complete`, { confirmEmail: 'wrong@privacy.example.com' })).status).toBe(400);

    const done = await team.lead.post(`${ws}/data-requests/${req.id}:complete`, { confirmEmail: email('BOB') });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.result).toEqual({ found: true, removedFromWorkspace: true, anonymized: true });
    const u = (await t.owner.query(`SELECT email, display_name, password_hash, disabled_at FROM users WHERE id = $1`, [bobId])).rows[0];
    expect(u).toMatchObject({ email: `erased-${bobId}@invalid.example`, display_name: 'ผู้ใช้ที่ถูกลบ', password_hash: null });
    expect(u.disabled_at).not.toBeNull();
    expect((await t.owner.query(`SELECT status FROM workspace_members WHERE user_id = $1`, [bobId])).rows[0].status).toBe('deactivated');
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM project_members WHERE user_id = $1`, [bobId])).rows[0].n).toBe(0);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1`, [bobId])).rows[0].n).toBe(0);
    expect((await bob.get('/me')).status).toBe(401);
    expect((await audit('data_request.erased'))[0].summary).toContain(email('bob'));
  });

  it('ผู้ขอที่อยู่หลาย Workspace: ถอนจาก Workspace นี้ แต่บัญชียังอยู่ · Owner คนเดียวลบไม่ได้', async () => {
    const other = await team.dev.post('/workspaces', { name: 'Dev Own', slug: 'dev-own' });
    expect(other.status).toBe(201);
    const req = (await team.lead.post(`${ws}/data-requests`, { requesterEmail: `dev@${team.slug}.example.com`, requestType: 'erase' })).body;
    const done = await team.lead.post(`${ws}/data-requests/${req.id}:complete`, { confirmEmail: `dev@${team.slug}.example.com` });
    expect(done.body.result).toEqual({ found: true, removedFromWorkspace: true, anonymized: false });
    expect((await t.owner.query(`SELECT display_name FROM users WHERE id = $1`, [team.devId])).rows[0].display_name).toBe('Kaijeaw');
    expect((await team.dev.get('/me')).status).toBe(200);
    expect((await team.dev.get(`${ws}/projects`)).status).toBe(404); // ไม่ใช่สมาชิก Workspace นี้แล้ว

    const lastOwner = (await team.lead.post(`${ws}/data-requests`, { requesterEmail: `lead@${team.slug}.example.com`, requestType: 'erase' })).body;
    const blocked = await team.lead.post(`${ws}/data-requests/${lastOwner.id}:complete`, { confirmEmail: `lead@${team.slug}.example.com` });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('last_owner');
    expect((await t.owner.query(`SELECT status FROM data_subject_requests WHERE id = $1`, [lastOwner.id])).rows[0].status).toBe('pending');
  });
});

describe('สิทธิ์ทีม Friday (support access)', () => {
  it('ค่าเริ่มต้นปิด · Owner เปิด / แก้ / ปิด พร้อม Audit · หมดอายุแล้วถือว่าปิด', async () => {
    const g = await team.lead.get(`${ws}/support-access`);
    expect(g.body).toMatchObject({ enabled: false, expired: false, until: null, maxMode: 'read', notifyAdmins: true, sessions: [] });

    const on = await team.lead.put(`${ws}/support-access`, { enabled: true, duration: '7d' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, maxMode: 'read', grantedBy: { displayName: 'Mick' } });
    const days = (new Date(on.body.until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const write = await team.lead.put(`${ws}/support-access`, { enabled: true, duration: 'forever', maxMode: 'write', notifyAdmins: false });
    expect(write.body).toMatchObject({ enabled: true, until: null, maxMode: 'write', notifyAdmins: false });
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM support_access_grants WHERE workspace_id = $1`, [wsId])).rows[0].n).toBe(1);
    expect((await team.lead.put(`${ws}/support-access`, { enabled: true, duration: '1y' })).status).toBe(400);

    await t.owner.query(`UPDATE support_access_grants SET until = now() - interval '1 minute' WHERE workspace_id = $1`, [wsId]);
    expect((await team.lead.get(`${ws}/support-access`)).body).toMatchObject({ enabled: false, expired: true });

    const off = await team.lead.put(`${ws}/support-access`, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, expired: false });
    expect((await team.lead.put(`${ws}/support-access`, { enabled: false })).status).toBe(200); // ปิดซ้ำได้
    expect((await audit('support_access.granted')).length).toBe(1);
    expect((await audit('support_access.updated')).length).toBe(1);
    expect((await audit('support_access.revoked')).length).toBe(1);
    expect((await audit('support_access.granted'))[0].category).toBe('secu');
  });

  it('ประวัติการเข้า: เห็นเฉพาะของ Workspace ตัวเอง พร้อม Ticket และระยะเวลา', async () => {
    const staff = await t.owner.query(`INSERT INTO staff_users (email, name, role) VALUES ('staff@friday.example.com', 'Support Staff', 'support') RETURNING id`);
    const other = await t.owner.query(`INSERT INTO workspaces (slug, name) VALUES ('someone-else', 'Other') RETURNING id`);
    await t.owner.query(`INSERT INTO support_sessions (workspace_id, staff_id, ticket_no, reason, mode, started_at, ended_at) VALUES ($1, $2, '#4702', 'ช่วยกู้ข้อมูล', 'read', now() - interval '20 minutes', now() - interval '6 minutes')`, [wsId, staff.rows[0].id]);
    await t.owner.query(`INSERT INTO support_sessions (workspace_id, staff_id, ticket_no, reason, mode) VALUES ($1, $2, '#9999', 'ของคนอื่น', 'read')`, [other.rows[0].id, staff.rows[0].id]);
    const g = await team.lead.get(`${ws}/support-access`);
    expect(g.body.sessions).toEqual([expect.objectContaining({ ticketNo: '#4702', mode: 'read', staffName: 'Support Staff', durationMinutes: 14, reason: 'ช่วยกู้ข้อมูล' })]);
  });
});

describe('ลบ / กู้คืน Workspace', () => {
  let slug = 'to-delete';
  let id = '';
  let owner: Client;
  let member: Client;

  it('เตรียม Workspace แยกสำหรับลบ', async () => {
    owner = await client(t.app);
    await signup(owner, 'owner2@privacy.example.com', 'Owner2');
    member = await client(t.app);
    const memberId = await signup(member, 'member2@privacy.example.com', 'Member2');
    expect((await owner.post('/workspaces', { name: 'To Delete', slug })).status).toBe(201);
    id = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [slug])).rows[0].id;
    await addMember(t.owner, slug, memberId, 'member');
    expect((await owner.post(`/w/${slug}/projects`, { key: 'TD', name: 'ลบทิ้ง', startDate: '2026-11-05', goliveDate: '2027-03-01', modules: ['M'] })).status).toBe(201);
  });

  it('ต้องเป็น Owner · พิมพ์ slug ยืนยัน · แพ็กเกจที่ชำระอยู่ต้องยกเลิกก่อน', async () => {
    expect((await member.delete(`/w/${slug}`, { confirmSlug: slug })).status).toBe(403);
    const bad = await owner.delete(`/w/${slug}`, { confirmSlug: 'wrong' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('confirm_required');
    expect((await owner.delete(`/w/${slug}`, {})).status).toBe(400);

    await owner.get(`/w/${slug}/billing`); // สร้าง subscription (ทดลอง) ถ้ายังไม่มี
    await t.owner.query(`UPDATE subscriptions SET status = 'active' WHERE workspace_id = $1`, [id]);
    const active = await owner.delete(`/w/${slug}`, { confirmSlug: slug });
    expect(active.status).toBe(409);
    expect(active.body.error).toMatchObject({ code: 'subscription_active', details: { status: 'active' } });
    await t.owner.query(`UPDATE subscriptions SET status = 'past_due' WHERE workspace_id = $1`, [id]);
    expect((await owner.delete(`/w/${slug}`, { confirmSlug: slug })).body.error.code).toBe('subscription_active');
    await t.owner.query(`UPDATE subscriptions SET status = 'canceled' WHERE workspace_id = $1`, [id]);
  });

  it('ลบแล้วเข้าไม่ได้ · เห็นในรายการที่กู้คืนได้ · เฉพาะ Owner กู้คืนได้', async () => {
    const r = await owner.delete(`/w/${slug}`, { confirmSlug: slug.toUpperCase() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ slug, deleted: true });
    const days = (new Date(r.body.restorableUntil).getTime() - new Date(r.body.deletedAt).getTime()) / 86_400_000;
    expect(days).toBe(30);
    expect((await owner.get(`/w/${slug}/projects`)).status).toBe(404);
    expect((await member.get(`/w/${slug}/projects`)).status).toBe(404);
    expect((await t.owner.query(`SELECT status FROM workspaces WHERE id = $1`, [id])).rows[0].status).toBe('pending_delete');
    expect((await audit('workspace.deleted', id))[0].summary).toContain('กู้คืนได้ถึง');

    expect((await owner.get('/workspaces/deleted')).body.items).toEqual([expect.objectContaining({ slug, name: 'To Delete' })]);
    expect((await member.get('/workspaces/deleted')).body.items).toEqual([]);
    expect((await member.post(`/workspaces/${slug}/restore`)).status).toBe(404);
    expect((await owner.post('/workspaces/not-here/restore')).status).toBe(404);

    const back = await owner.post(`/workspaces/${slug}:restore`);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toEqual({ slug, restored: true });
    expect((await owner.get(`/w/${slug}/projects`)).status).toBe(200);
    expect((await owner.get('/workspaces/deleted')).body.items).toEqual([]);
    expect((await audit('workspace.restored', id)).length).toBe(1);
  });

  it('เกิน 30 วันกู้คืนไม่ได้ · งานเบื้องหลังลบถาวรพร้อมข้อมูลทั้งหมด (แต่ไม่แตะที่ยังไม่ครบ 30 วัน)', async () => {
    await owner.delete(`/w/${slug}`, { confirmSlug: slug });
    const svc = t.app.get(WorkspaceLifecycleService);
    expect((await svc.purge()).purged).toBe(0);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM workspaces WHERE id = $1`, [id])).rows[0].n).toBe(1);

    await t.owner.query(`UPDATE workspaces SET deleted_at = now() - interval '31 days' WHERE id = $1`, [id]);
    const late = await owner.post(`/workspaces/${slug}/restore`);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('restore_expired');
    expect((await owner.get('/workspaces/deleted')).body.items).toEqual([]);

    expect((await svc.purge()).purged).toBe(1);
    for (const table of ['workspaces', 'projects', 'workspace_members', 'workspace_settings', 'audit_logs']) {
      const col = table === 'workspaces' ? 'id' : 'workspace_id';
      expect((await t.owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n, table).toBe(0);
    }
    // Workspace อื่นไม่กระทบ
    expect((await team.lead.get(`${ws}/projects`)).status).toBe(200);
  });
});
