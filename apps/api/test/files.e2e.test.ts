// A11 · ไฟล์, โฟลเดอร์, เวอร์ชัน และไฟล์แนบ · ที่เก็บในเครื่อง (ไม่แตะ S3 จริง) · ข้อมูลสมมติเท่านั้น
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/files/storage.js';
import { FilesService } from '../src/files/files.service.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client;
let guest: Client;
let outsider: Client;
let wsId: string;
let projectId: string;
let moduleId: string;
let base: string;
const anon = () => request(t.app.getHttpServer());

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  base = `${team.ws}/projects/${team.key}`;
  viewer = await client(t.app);
  await addMember(t.owner, team.slug, await signup(viewer, 'viewer@files.example.com', 'Viewer'), 'member', { key: team.key, role: 'viewer' });
  guest = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guest, 'guest@files.example.com', 'Guest'), 'guest', { key: team.key, role: 'viewer' });
  outsider = await client(t.app);
  await signup(outsider, 'outsider@files.example.com', 'Outsider');
});
afterAll(() => t.close());

/** อัปโหลดครบขั้น: ขอ URL → PUT → ยืนยัน */
async function upload(c: Client, name: string, content: string | Buffer, extra: { folderId?: string; fileId?: string; note?: string } = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const u = await c.post(`${base}/files/upload-url`, { name, size: buf.length, mime: 'text/plain', ...(extra.folderId ? { folderId: extra.folderId } : {}), ...(extra.fileId ? { fileId: extra.fileId } : {}) });
  expect(u.status, JSON.stringify(u.body)).toBe(200);
  const put = await anon().put(new URL(u.body.url).pathname).set('content-type', 'application/octet-stream').send(buf);
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return extra.fileId
    ? c.post(`${base}/files/${extra.fileId}/versions`, { uploadToken: u.body.uploadToken, note: extra.note })
    : c.post(`${base}/files`, { uploadToken: u.body.uploadToken, note: extra.note });
}
const body = async (path: string) => (await anon().get(path)).text;

describe('อัปโหลด → ยืนยัน → ดาวน์โหลด', () => {
  it('ขอ URL (PUT) → ส่งไฟล์ → ยืนยัน แล้วดาวน์โหลดผ่าน redirect ที่หมดอายุ', async () => {
    const u = await team.dev.post(`${base}/files/upload-url`, { name: 'สเปกวงเงิน.txt', size: 11, mime: 'text/plain' });
    expect(u.body).toMatchObject({ method: 'PUT', storage: 'local', maxBytes: 100 * 1024 * 1024, uploadToken: expect.any(String), url: expect.stringContaining('/api/v1/storage/upload/') });
    expect(new Date(u.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // ยังไม่ได้ส่งไฟล์ → ยืนยันไม่ได้
    const early = await team.dev.post(`${base}/files`, { uploadToken: u.body.uploadToken });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('upload_incomplete');

    await anon().put(new URL(u.body.url).pathname).send(Buffer.from('hello world'));
    const created = await team.dev.post(`${base}/files`, { uploadToken: u.body.uploadToken, note: 'ฉบับแรก' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name: 'สเปกวงเงิน.txt', kind: 'upload', mime: 'text/plain', size: 11, versionNo: 1, versionCount: 1, folderId: null, uploader: { displayName: 'Kaijeaw' }, attachments: 0, evidence: false });

    const dl = await team.lead.get(`${base}/files/${created.body.id}/download`).redirects(0);
    expect(dl.status).toBe(302);
    const url = new URL(dl.headers.location!);
    expect(url.pathname).toMatch(/^\/api\/v1\/storage\/download\//);
    const file = await anon().get(url.pathname);
    expect(file.status).toBe(200);
    expect(file.text).toBe('hello world');
    expect(file.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('สเปกวงเงิน.txt')}`);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'file.uploaded' AND target_id = $1`, [created.body.id])).rowCount).toBe(1);
  });

  it('ขนาดไฟล์: เกิน 100 MB → 413 · ส่งมากกว่าหรือน้อยกว่าที่แจ้ง → ปฏิเสธ · token ปลอม / ของคนอื่น / ของโปรเจกต์อื่นใช้ไม่ได้', async () => {
    const big = await team.dev.post(`${base}/files/upload-url`, { name: 'big.bin', size: 100 * 1024 * 1024 + 1 });
    expect(big.status).toBe(413);
    expect(big.body.error).toMatchObject({ code: 'file_too_large', details: { maxBytes: 100 * 1024 * 1024 } });
    expect((await team.dev.post(`${base}/files/upload-url`, { name: 'ok.bin', size: 100 * 1024 * 1024 })).status).toBe(200);

    const u = await team.dev.post(`${base}/files/upload-url`, { name: 'a.txt', size: 5 });
    const path = new URL(u.body.url).pathname;
    expect((await anon().put(path).send(Buffer.from('1234567'))).status).toBe(413);
    expect((await anon().put(path).send(Buffer.from('123'))).status).toBe(400);
    expect((await anon().put(`${path}x`).send(Buffer.from('12345'))).status).toBe(403);
    expect((await anon().put('/api/v1/storage/upload/not.a.token').send(Buffer.from('12345'))).status).toBe(403);
    expect((await team.dev.post(`${base}/files`, { uploadToken: u.body.uploadToken })).body.error.code).toBe('upload_incomplete');

    await anon().put(path).send(Buffer.from('12345'));
    const stolen = await team.lead.post(`${base}/files`, { uploadToken: u.body.uploadToken });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error.code).toBe('invalid_upload_token');
    expect((await team.dev.post(`${base}/files`, { uploadToken: 'garbage-token-value' })).status).toBe(400);
    expect((await team.dev.post(`${base}/files`, { uploadToken: u.body.uploadToken })).status).toBe(201);
    expect((await team.dev.post(`${base}/files/upload-url`, { name: 'bad/name.txt', size: 1 })).status).toBe(400);
    expect((await team.dev.post(`${base}/files/upload-url`, { name: 'x', size: -1 })).status).toBe(400);
  });

  it('เวอร์ชัน 2: ไฟล์เดิมเก็บไว้ ดาวน์โหลดย้อนหลังได้ · token ต้องออกให้ไฟล์นี้', async () => {
    const f = await upload(team.lead, 'แผน.txt', 'เวอร์ชันหนึ่ง');
    const v2 = await upload(team.dev, 'ignored-name.txt', 'v2 เนื้อหาใหม่ยาวขึ้น', { fileId: f.body.id, note: 'แก้ตาม BA' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body).toMatchObject({ id: f.body.id, name: 'แผน.txt', versionNo: 2, versionCount: 2, size: Buffer.byteLength('v2 เนื้อหาใหม่ยาวขึ้น') });

    const detail = await team.lead.get(`${base}/files/${f.body.id}`);
    expect(detail.body.versions).toMatchObject([
      { versionNo: 2, note: 'แก้ตาม BA', current: true, uploader: { displayName: 'Kaijeaw' } },
      { versionNo: 1, note: null, current: false, uploader: { displayName: 'Mick' } },
    ]);
    const cur = await team.lead.get(`${base}/files/${f.body.id}/download`).redirects(0);
    expect(await body(new URL(cur.headers.location!).pathname)).toBe('v2 เนื้อหาใหม่ยาวขึ้น');
    const old = await team.lead.get(`${base}/files/${f.body.id}/download?version=1`).redirects(0);
    expect(await body(new URL(old.headers.location!).pathname)).toBe('เวอร์ชันหนึ่ง');
    expect((await team.lead.get(`${base}/files/${f.body.id}/download?version=9`)).status).toBe(404);

    // token ของไฟล์ใหม่ใช้เป็นเวอร์ชันของไฟล์อื่นไม่ได้ และ token ของเวอร์ชันใช้สร้างไฟล์ใหม่ไม่ได้
    const other = await upload(team.lead, 'อีกไฟล์.txt', 'x');
    const u = await team.lead.post(`${base}/files/upload-url`, { name: 'n', size: 1, fileId: f.body.id });
    await anon().put(new URL(u.body.url).pathname).send(Buffer.from('y'));
    expect((await team.lead.post(`${base}/files/${other.body.id}/versions`, { uploadToken: u.body.uploadToken })).body.error.code).toBe('invalid_upload_token');
    expect((await team.lead.post(`${base}/files`, { uploadToken: u.body.uploadToken })).body.error.code).toBe('invalid_upload_token');
    expect((await team.lead.post(`${base}/files/upload-url`, { name: 'n', size: 1, fileId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('พื้นที่ไฟล์ตามแพ็กเกจเต็ม → 402 plan_limit_reached ก่อนออก URL', async () => {
    await team.lead.get(`${team.ws}/usage`);
    await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free'), status = 'active', trial_ends_at = NULL WHERE workspace_id = $1`, [wsId]);
    const used = Number((await t.owner.query('SELECT coalesce(sum(size_bytes),0) AS n FROM file_versions WHERE workspace_id = $1', [wsId])).rows[0].n);
    const members = Number((await t.owner.query(`SELECT count(*) FROM workspace_members WHERE workspace_id = $1 AND status = 'active' AND role <> 'guest'`, [wsId])).rows[0].count);
    const capacity = members * 1024 ** 3;
    await t.owner.query(`INSERT INTO file_versions (workspace_id, file_id, version_no, storage_key, size_bytes, uploaded_by) SELECT workspace_id, id, 99, 'filler', $2, uploaded_by FROM files WHERE workspace_id = $1 LIMIT 1`, [wsId, capacity - used - 10]);
    const r = await team.dev.post(`${base}/files/upload-url`, { name: 'เกิน.bin', size: 11 });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatchObject({ code: 'plan_limit_reached', details: { kind: 'storage_bytes', plan: 'free' } });
    expect((await team.dev.post(`${base}/files/upload-url`, { name: 'พอดี.bin', size: 10 })).status).toBe(200);
    await t.owner.query(`DELETE FROM file_versions WHERE storage_key = 'filler'`);
    await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'team_l') WHERE workspace_id = $1`, [wsId]);
  });
});

describe('ลิงก์ภายนอก', () => {
  it('แนบลิงก์ Figma / Drive / Notion ตรวจผู้ให้บริการ · ต้องเป็น https · ดาวน์โหลดไม่ได้', async () => {
    const mk = (linkUrl: string, name?: string) => team.lead.post(`${base}/files`, { linkUrl, ...(name ? { name } : {}) });
    const figma = await mk('https://www.figma.com/file/abc/Design', 'Design System');
    expect(figma.status, JSON.stringify(figma.body)).toBe(201);
    expect(figma.body).toMatchObject({ kind: 'link', name: 'Design System', linkProvider: 'figma', size: null, versionNo: null, linkUrl: 'https://www.figma.com/file/abc/Design' });
    expect((await mk('https://docs.google.com/document/d/1')).body).toMatchObject({ linkProvider: 'google_drive', name: 'docs.google.com' });
    expect((await mk('https://www.notion.so/page-1', 'Notion')).body.linkProvider).toBe('notion');
    expect((await mk('https://example.com/x', 'อื่น ๆ')).body.linkProvider).toBe('other');
    expect((await mk('http://www.figma.com/file/abc')).status).toBe(400);
    expect((await mk('javascript:alert(1)')).status).toBe(400);
    const dl = await team.lead.get(`${base}/files/${figma.body.id}/download`);
    expect(dl.status).toBe(400);
    expect(dl.body.error).toMatchObject({ code: 'link_file', details: { linkUrl: 'https://www.figma.com/file/abc/Design' } });
    expect((await team.lead.post(`${base}/files/${figma.body.id}/versions`, { uploadToken: 'x'.repeat(20) })).status).toBe(400);
  });
});

describe('โฟลเดอร์', () => {
  it('สร้างซ้อน / ย้ายไฟล์ / เปลี่ยนชื่อ / breadcrumb / จำนวนไฟล์ · ลบได้เฉพาะโฟลเดอร์ว่าง · ย้ายเข้าตัวเองไม่ได้', async () => {
    const docs = (await team.lead.post(`${base}/folders`, { name: 'เอกสาร' })).body;
    const specs = (await team.lead.post(`${base}/folders`, { name: 'สเปก', parentId: docs.id })).body;
    expect(specs).toMatchObject({ name: 'สเปก', parentId: docs.id, fileCount: 0 });
    const f = await upload(team.lead, 'ใน-สเปก.txt', 'abc', { folderId: specs.id });
    expect(f.body.folderId).toBe(specs.id);

    const list = await team.lead.get(`${base}/files?folder=${specs.id}`);
    expect(list.body.items.map((i: { name: string }) => i.name)).toEqual(['ใน-สเปก.txt']);
    expect(list.body.breadcrumb).toEqual([{ id: docs.id, name: 'เอกสาร' }, { id: specs.id, name: 'สเปก' }]);
    expect(list.body.totalBytes).toBe(3);
    expect((await team.lead.get(`${base}/files?folder=root`)).body.items.map((i: { name: string }) => i.name)).not.toContain('ใน-สเปก.txt');

    const tree = await team.lead.get(`${base}/folders`);
    expect(tree.body.items.find((x: { id: string }) => x.id === specs.id)).toMatchObject({ fileCount: 1, parentId: docs.id });
    expect(tree.body.rootFileCount).toBeGreaterThan(0);

    expect((await team.lead.patch(`${base}/folders/${docs.id}`, { parentId: specs.id })).body.error.code).toBe('folder_cycle');
    expect((await team.lead.patch(`${base}/folders/${docs.id}`, { parentId: docs.id })).body.error.code).toBe('folder_cycle');
    expect((await team.lead.patch(`${base}/folders/${specs.id}`, { name: 'สเปกระบบ' })).body.name).toBe('สเปกระบบ');
    const nonEmpty = await team.lead.delete(`${base}/folders/${specs.id}`);
    expect(nonEmpty.status).toBe(409);
    expect(nonEmpty.body.error).toMatchObject({ code: 'folder_not_empty', details: { files: 1, folders: 0 } });
    expect((await team.lead.delete(`${base}/folders/${docs.id}`)).body.error.details).toMatchObject({ folders: 1 });

    // ย้ายไฟล์ออกมาที่รากแล้วลบโฟลเดอร์ได้
    expect((await team.lead.patch(`${base}/files/${f.body.id}`, { folderId: null, name: 'ย้ายแล้ว.txt' })).body).toMatchObject({ folderId: null, name: 'ย้ายแล้ว.txt' });
    expect((await team.lead.delete(`${base}/folders/${specs.id}`)).body).toEqual({ deleted: true });
    expect((await team.lead.delete(`${base}/folders/${docs.id}`)).body).toEqual({ deleted: true });
    expect((await team.lead.post(`${base}/folders`, { name: 'x', parentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await team.lead.get(`${base}/files?folder=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('ค้นหาชื่อ กรองผู้อัปโหลด เรียงลำดับ', async () => {
    await upload(team.lead, 'Alpha-report.txt', 'aaaa');
    await upload(team.dev, 'Beta-report.txt', 'b');
    const q = await team.lead.get(`${base}/files?q=report`);
    expect(q.body.items.map((i: { name: string }) => i.name).sort()).toEqual(['Alpha-report.txt', 'Beta-report.txt']);
    expect((await team.lead.get(`${base}/files?q=report&uploader=${team.devId}`)).body.items.map((i: { name: string }) => i.name)).toEqual(['Beta-report.txt']);
    expect((await team.lead.get(`${base}/files?q=report&sort=name`)).body.items[0].name).toBe('Alpha-report.txt');
    expect((await team.lead.get(`${base}/files?q=report&sort=size`)).body.items[0].name).toBe('Alpha-report.txt');
    expect((await team.lead.get(`${base}/files?q=%25`)).body.items).toEqual([]);
    expect((await team.lead.get(`${base}/files?sort=biggest`)).status).toBe(400);
  });
});

describe('ไฟล์แนบกับงาน / ผลทดสอบ / โปรเจกต์ / Requirement', () => {
  async function task(title: string, type?: string) {
    const r = await team.lead.post(`${base}/issues`, { title, moduleId });
    if (type) await t.owner.query(`UPDATE issues SET issue_type_id = (SELECT id FROM issue_types WHERE project_id = $2 AND name = $3) WHERE id = $1`, [r.body.id, projectId, type]);
    return r.body as { id: string; key: string };
  }

  it('แนบ / เอาออก / ดูไฟล์ของงาน · แนบซ้ำไม่เป็นไร · เป้าหมายผิดโปรเจกต์ 404', async () => {
    const issue = await task('งานมีไฟล์แนบ');
    const f = await upload(team.lead, 'แนบ.txt', 'x');
    const a = await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'issue', target: issue.key });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ attached: true, file: { attachments: 1, evidence: false } });
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'issue', target: issue.key })).body.attached).toBe(false);
    const byIssue = await team.lead.get(`${base}/files?target=issue:${issue.key}`);
    expect(byIssue.body.items.map((i: { id: string }) => i.id)).toEqual([f.body.id]);
    expect((await team.lead.get(`${base}/files/${f.body.id}`)).body.attachmentList).toMatchObject([{ targetType: 'issue', target: issue.key }]);

    await t.owner.query(`INSERT INTO requirements (workspace_id, project_id, code, kind) VALUES ($1,$2,'FR-9','FR')`, [wsId, projectId]);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'requirement', target: 'FR-9' })).body.attached).toBe(true);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'project' })).body.attached).toBe(true);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'issue', target: 'ZZ-1' })).status).toBe(404);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'issue' })).status).toBe(400);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'requirement', target: 'FR-404' })).status).toBe(404);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'test_run', target: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await team.lead.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'comment', target: 'nope' })).status).toBe(404);

    expect((await team.lead.delete(`${base}/files/${f.body.id}/attachments`, { targetType: 'issue', target: issue.key })).body).toEqual({ detached: true });
    expect((await team.lead.delete(`${base}/files/${f.body.id}/attachments`, { targetType: 'issue', target: issue.key })).status).toBe(404);
    expect((await team.lead.get(`${base}/files?target=issue:${issue.key}`)).body.items).toEqual([]);
  });

  it('ไฟล์ที่เป็นหลักฐาน (ผลทดสอบ / Bug) ลบต้อง confirm · ไม่ใช่หลักฐานลบได้เลย', async () => {
    const story = await task('งานที่ทดสอบ');
    const run = await t.owner.query(`INSERT INTO test_runs (workspace_id, issue_id, run_no, result, passed_count, total_count) VALUES ($1,$2,1,'failed',3,5) RETURNING id`, [wsId, story.id]);
    const evidence = await upload(team.lead, 'TestReport_run1.pdf', 'pdf');
    await team.lead.post(`${base}/files/${evidence.body.id}/attachments`, { targetType: 'test_run', target: run.rows[0].id });
    const asBug = await task('Bug จากผลทดสอบ', 'Bug');
    const bugFile = await upload(team.lead, 'screenshot.png', 'png');
    await team.lead.post(`${base}/files/${bugFile.body.id}/attachments`, { targetType: 'issue', target: asBug.key });
    expect((await team.lead.get(`${base}/files/${evidence.body.id}`)).body.evidence).toBe(true);

    const refused = await team.lead.delete(`${base}/files/${evidence.body.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'file_is_evidence', details: { requiresConfirm: true, evidence: [{ targetType: 'test_run', ref: expect.stringContaining('run 1') }] } });
    expect((await team.lead.delete(`${base}/files/${evidence.body.id}`, { confirm: false })).status).toBe(409);
    const bugRefused = await team.lead.delete(`${base}/files/${bugFile.body.id}`);
    expect(bugRefused.body.error.details.evidence).toMatchObject([{ targetType: 'bug', ref: asBug.key }]);

    const ok = await team.lead.delete(`${base}/files/${evidence.body.id}`, { confirm: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ deleted: true, evidence: [{ targetType: 'test_run' }] });
    expect(new Date(ok.body.restorableUntil).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await team.lead.delete(`${base}/files/${bugFile.body.id}?confirm=true`)).status).toBe(200);

    const plain = await upload(team.lead, 'ธรรมดา.txt', 'p');
    await team.lead.post(`${base}/files/${plain.body.id}/attachments`, { targetType: 'issue', target: story.key });
    expect((await team.lead.delete(`${base}/files/${plain.body.id}`)).status).toBe(200);
  });
});

describe('ถังขยะและกู้คืน', () => {
  it('ลบแล้วหายจากรายการ ดาวน์โหลดไม่ได้ · Admin ดูถังขยะและกู้คืนได้ · เลยกำหนดกู้ไม่ได้', async () => {
    const f = await upload(team.lead, 'จะลบ.txt', 'zzz');
    expect((await team.lead.delete(`${base}/files/${f.body.id}`)).status).toBe(200);
    expect((await team.lead.get(`${base}/files?q=จะลบ`)).body.items).toEqual([]);
    expect((await team.dev.get(`${base}/files/${f.body.id}`)).status).toBe(404);
    expect((await team.dev.get(`${base}/files/${f.body.id}/download`)).status).toBe(404);

    expect((await team.dev.get(`${base}/files?trashed=true`)).status).toBe(403);
    const trash = await team.lead.get(`${base}/files?trashed=true`);
    expect(trash.body.items.map((i: { id: string }) => i.id)).toContain(f.body.id);
    expect(trash.body.items.find((i: { id: string }) => i.id === f.body.id).deletedAt).toBeTruthy();

    expect((await team.dev.post(`${base}/files/${f.body.id}/restore`)).status).toBe(403);
    const back = await team.lead.post(`${base}/files/${f.body.id}:restore`);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ name: 'จะลบ.txt', deletedAt: null });
    expect((await team.lead.post(`${base}/files/${f.body.id}/restore`)).body.error.code).toBe('not_deleted');
    expect((await team.dev.get(`${base}/files/${f.body.id}`)).status).toBe(200);

    await team.lead.delete(`${base}/files/${f.body.id}`);
    await t.owner.query(`UPDATE files SET deleted_at = now() - interval '31 days' WHERE id = $1`, [f.body.id]);
    const expired = await team.lead.post(`${base}/files/${f.body.id}/restore`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('restore_expired');
  });

  it('โฟลเดอร์เดิมถูกลบไปแล้ว → กู้กลับมาที่ราก', async () => {
    const folder = (await team.lead.post(`${base}/folders`, { name: 'ชั่วคราว' })).body;
    const f = await upload(team.lead, 'ในโฟลเดอร์.txt', 'q', { folderId: folder.id });
    await team.lead.delete(`${base}/files/${f.body.id}`);
    // โฟลเดอร์ที่ยังมีไฟล์ในถังขยะลบไม่ได้ (ไม่ให้ไฟล์กำพร้า)
    expect((await team.lead.delete(`${base}/folders/${folder.id}`)).body.error.code).toBe('folder_not_empty');
    await t.owner.query('UPDATE files SET folder_id = NULL WHERE id = $1', [f.body.id]);
    await t.owner.query('UPDATE files SET folder_id = $2 WHERE id = $1', [f.body.id, null]);
    expect((await team.lead.post(`${base}/files/${f.body.id}/restore`)).body.folderId).toBeNull();
  });
});

describe('สิทธิ์', () => {
  it('Viewer ดู / ดาวน์โหลดได้ แต่อัปโหลด แก้ ลบ สร้างโฟลเดอร์ไม่ได้ · Guest และคนนอกเข้าไม่ได้', async () => {
    const f = await upload(team.lead, 'ทุกคนอ่านได้.txt', 'read');
    expect((await viewer.get(`${base}/files`)).status).toBe(200);
    expect((await viewer.get(`${base}/files/${f.body.id}/download`).redirects(0)).status).toBe(302);
    for (const call of [
      () => viewer.post(`${base}/files/upload-url`, { name: 'x', size: 1 }),
      () => viewer.post(`${base}/files`, { linkUrl: 'https://www.figma.com/file/1' }),
      () => viewer.patch(`${base}/files/${f.body.id}`, { name: 'y' }),
      () => viewer.delete(`${base}/files/${f.body.id}`),
      () => viewer.post(`${base}/folders`, { name: 'z' }),
      () => viewer.post(`${base}/files/${f.body.id}/attachments`, { targetType: 'project' }),
    ]) {
      const r = await call();
      expect(r.status).toBe(403);
    }
    expect((await viewer.post(`${base}/files/upload-url`, { name: 'x', size: 1 })).body.error.details.permission).toBe('file.upload');

    for (const c of [guest, outsider]) {
      expect([403, 404]).toContain((await c.get(`${base}/files`)).status);
      expect([403, 404]).toContain((await c.get(`${base}/files/${f.body.id}/download`)).status);
    }
    expect((await guest.get(`${base}/files`)).body.error?.code).toBe('guest_view_limited');
  });

  it('ไฟล์ของโปรเจกต์อื่นเปิดผ่านโปรเจกต์นี้ไม่ได้', async () => {
    const f = await upload(team.lead, 'ของโปรเจกต์นี้.txt', 'mine');
    const r = await team.lead.post(`${team.ws}/projects`, { key: 'FZ', name: 'Other', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null });
    expect(r.status).toBe(201);
    expect((await team.lead.get(`${team.ws}/projects/FZ/files/${f.body.id}`)).status).toBe(404);
    expect((await team.lead.get(`${team.ws}/projects/FZ/files/${f.body.id}/download`)).status).toBe(404);
    expect((await team.lead.delete(`${team.ws}/projects/FZ/files/${f.body.id}`)).status).toBe(404);
  });
});

describe('ความถูกต้องของการยืนยัน upload (BUG-06 · 07 · 08)', () => {
  async function staged(content: string, extra: { fileId?: string } = {}) {
    const u = await team.dev.post(`${base}/files/upload-url`, { name: 'หลักฐาน.txt', size: Buffer.byteLength(content), mime: 'text/plain', ...extra });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect((await anon().put(new URL(u.body.url).pathname).set('content-type', 'application/octet-stream').send(Buffer.from(content))).status).toBe(200);
    return u.body as { url: string; uploadToken: string };
  }
  const download = async (fileId: string, version?: number) => {
    const dl = await team.dev.get(`${base}/files/${fileId}/download${version ? `?version=${version}` : ''}`).redirects(0);
    return body(new URL(dl.headers.location).pathname);
  };
  const sizeOf = async () => Number((await t.owner.query('SELECT coalesce(sum(size_bytes),0) AS n FROM file_versions WHERE workspace_id = $1', [wsId])).rows[0].n);

  it('PUT ซ้ำไป URL เดิมหลังยืนยัน → เนื้อหาเวอร์ชันที่ยืนยันแล้วไม่เปลี่ยน (ทั้งไฟล์ใหม่และเวอร์ชันใหม่)', async () => {
    const u = await staged('old');
    const f = await team.dev.post(`${base}/files`, { uploadToken: u.uploadToken });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    await anon().put(new URL(u.url).pathname).set('content-type', 'application/octet-stream').send(Buffer.from('NEW'));
    expect(await download(f.body.id)).toBe('old');
    const key = (await t.owner.query('SELECT storage_key FROM file_versions WHERE file_id = $1', [f.body.id])).rows[0].storage_key as string;
    expect(key.startsWith('staging/')).toBe(false);

    const v = await staged('v2!', { fileId: f.body.id });
    expect((await team.dev.post(`${base}/files/${f.body.id}/versions`, { uploadToken: v.uploadToken })).status).toBe(201);
    await anon().put(new URL(v.url).pathname).set('content-type', 'application/octet-stream').send(Buffer.from('BAD'));
    expect(await download(f.body.id)).toBe('v2!');
    expect(await download(f.body.id, 1)).toBe('old');
  });

  it('uploadToken ใช้ได้ครั้งเดียว · ส่งพร้อมกันได้ไฟล์เดียวและนับพื้นที่ครั้งเดียว', async () => {
    const u = await staged('once');
    const ok = await team.dev.post(`${base}/files`, { uploadToken: u.uploadToken });
    expect(ok.status).toBe(201);
    const again = await team.dev.post(`${base}/files`, { uploadToken: u.uploadToken });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('upload_already_used');

    const p = await staged('pair');
    const before = await sizeOf();
    const files = Number((await t.owner.query('SELECT count(*) FROM files WHERE workspace_id = $1', [wsId])).rows[0].count);
    const results = await Promise.all([1, 2, 3].map(() => team.dev.post(`${base}/files`, { uploadToken: p.uploadToken })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(Number((await t.owner.query('SELECT count(*) FROM files WHERE workspace_id = $1', [wsId])).rows[0].count)).toBe(files + 1);
    expect(await sizeOf()).toBe(before + 4);

    // เวอร์ชันใหม่ก็ใช้ token ครั้งเดียวเช่นกัน
    const v = await staged('ver2', { fileId: ok.body.id });
    expect((await team.dev.post(`${base}/files/${ok.body.id}/versions`, { uploadToken: v.uploadToken })).status).toBe(201);
    expect((await team.dev.post(`${base}/files/${ok.body.id}/versions`, { uploadToken: v.uploadToken })).status).toBe(409);
  });

  it('ตรวจโควตาซ้ำตอนยืนยัน: URL ที่ออกก่อนพื้นที่เต็มยืนยันไม่ได้ · เหลือที่พอไฟล์เดียว ยืนยันพร้อมกันสำเร็จได้ไม่เกินหนึ่ง', async () => {
    await team.lead.get(`${team.ws}/usage`);
    await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'free'), status = 'active', trial_ends_at = NULL WHERE workspace_id = $1`, [wsId]);
    const members = Number((await t.owner.query(`SELECT count(*) FROM workspace_members WHERE workspace_id = $1 AND status = 'active' AND role <> 'guest'`, [wsId])).rows[0].count);
    const capacity = members * 1024 ** 3;
    const fill = (left: number) =>
      t.owner.query(`INSERT INTO file_versions (workspace_id, file_id, version_no, storage_key, size_bytes, uploaded_by) SELECT workspace_id, id, 98, 'filler-quota', $2, uploaded_by FROM files WHERE workspace_id = $1 LIMIT 1`, [wsId, capacity - left]);
    const clear = () => t.owner.query(`DELETE FROM file_versions WHERE storage_key = 'filler-quota'`);
    try {
      const early = await staged('abc');
      await fill((await sizeOf()) + 2);
      expect((await team.dev.post(`${base}/files/upload-url`, { name: 'x.txt', size: 3 })).status).toBe(402);
      const late = await team.dev.post(`${base}/files`, { uploadToken: early.uploadToken });
      expect(late.status).toBe(402);
      expect(late.body.error).toMatchObject({ code: 'plan_limit_reached', details: { kind: 'storage_bytes' } });
      await clear();

      const a = await staged('aaaa');
      const b = await staged('bbbb');
      await fill((await sizeOf()) + 6); // พอสำหรับ 4 bytes เพียงไฟล์เดียว
      const both = await Promise.all([a, b].map((u) => team.dev.post(`${base}/files`, { uploadToken: u.uploadToken })));
      expect(both.map((r) => r.status).sort()).toEqual([201, 402]);
    } finally {
      await clear();
      await t.owner.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'team_l') WHERE workspace_id = $1`, [wsId]);
    }
  });
});

describe('ที่เก็บ S3 (presigned URL · ไม่ยิงเครือข่ายจริง)', () => {
  it('ตั้ง S3_BUCKET แล้วออก URL ของ S3 ที่ผูกขนาดและชนิดไฟล์ไว้ใน signature', async () => {
    Object.assign(process.env, { S3_BUCKET: 'friday-test-bucket', S3_REGION: 'ap-southeast-1', AWS_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST', AWS_SECRET_ACCESS_KEY: 'test-secret-access-key-for-presign-only' });
    try {
      expect(t.app.get(FilesService).driver.kind).toBe('s3');
      const r = await team.dev.post(`${base}/files/upload-url`, { name: 'สเปก.pdf', size: 1234, mime: 'application/pdf' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ method: 'PUT', storage: 's3', headers: { 'content-type': 'application/pdf' } });
      const u = new URL(r.body.url);
      expect(u.hostname).toContain('friday-test-bucket');
      expect(u.pathname).toContain(`/staging/${wsId}/${projectId}/`);
      expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      // ยืนยันไม่ได้จนกว่าจะมีไฟล์ใน bucket (HeadObject ล้ม = ยังไม่มี) · ที่นี่ไม่มีเครือข่ายจึงถือว่าไม่พบ
      const dl = await t.app.get(S3Storage).presignDownload('k/1', { filename: 'ไฟล์.pdf', mime: 'application/pdf' });
      expect(new URL(dl).searchParams.get('X-Amz-Expires')).toBe('300');
      expect(new URL(dl).searchParams.get('response-content-disposition')).toContain(encodeURIComponent('ไฟล์.pdf'));
    } finally {
      for (const k of ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) delete process.env[k];
    }
    expect(t.app.get(FilesService).driver.kind).toBe('local');
  });

  it('S3: ลิงก์ PUT ชี้ staging/ · commit คัดลอกเฉพาะเนื้อหาที่ตรวจแล้ว (CopySourceIfMatch) ไป key ถาวร แล้วลบ staging', async () => {
    process.env.S3_BUCKET = 'friday-test-bucket';
    const s3 = t.app.get(S3Storage) as unknown as { client: { send: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> } | null };
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const prev = s3.client;
    s3.client = { send: async (cmd) => (sent.push({ name: cmd.constructor.name, input: cmd.input }), cmd.constructor.name === 'HeadObjectCommand' ? { ETag: '"etag-1"' } : {}) };
    try {
      await t.app.get(S3Storage).commit('staging/ws/p/abc', 'ws/p/abc');
      expect(sent.map((x) => x.name)).toEqual(['HeadObjectCommand', 'CopyObjectCommand', 'DeleteObjectCommand']);
      expect(sent[1].input).toMatchObject({ Bucket: 'friday-test-bucket', Key: 'ws/p/abc', CopySource: 'friday-test-bucket/staging/ws/p/abc', CopySourceIfMatch: '"etag-1"' });
      expect(sent[2].input).toMatchObject({ Key: 'staging/ws/p/abc' });
    } finally {
      s3.client = prev;
      delete process.env.S3_BUCKET;
    }
  });
});
