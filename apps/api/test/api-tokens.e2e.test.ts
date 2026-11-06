// A28 · API token (Bearer) · ข้อมูลสมมติเท่านั้น
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
let moduleId: string;
let otherSlug: string;
const anon = () => request(t.app.getHttpServer());
const api = (token: string | null) => ({
  get: (path: string) => { const r = anon().get(`/api/v1${path}`); return token ? r.set('authorization', `Bearer ${token}`) : r; },
  post: (path: string, body?: object) => { const r = anon().post(`/api/v1${path}`).send(body ?? {}); return token ? r.set('authorization', `Bearer ${token}`) : r; },
  patch: (path: string, body: object, ifMatch?: string) => { const r = anon().patch(`/api/v1${path}`).send(body); if (ifMatch) r.set('if-match', ifMatch); return token ? r.set('authorization', `Bearer ${token}`) : r; },
  delete: (path: string) => { const r = anon().delete(`/api/v1${path}`); return token ? r.set('authorization', `Bearer ${token}`) : r; },
});

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  moduleId = team.project.modules[0].id;
  otherSlug = 'other-tokens-ws';
  expect((await team.lead.post('/workspaces', { name: 'Other', slug: otherSlug })).status).toBe(201);
});
afterAll(() => t.close());

async function mint(c: Client = team.lead, body: object = { name: 'CI bot', scopes: ['read'] }) {
  const r = await c.post(`${team.ws}/api-tokens`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; token: string; scopes: string[] };
}

describe('จัดการ token', () => {
  it('สร้าง: แสดง token เต็มครั้งเดียว · เก็บเฉพาะ hash · ค่าเริ่มต้น scope = read', async () => {
    const r = await team.lead.post(`${team.ws}/api-tokens`, { name: 'GitHub Action' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ name: 'GitHub Action', scopes: ['read'], revoked: false, lastUsedAt: null, createdBy: { displayName: 'Mick' } });
    expect(r.body.token).toMatch(/^fmt_[A-Za-z0-9_-]{43}$/);
    const row = (await t.owner.query('SELECT token_hash, scopes FROM api_tokens WHERE id = $1', [r.body.id])).rows[0];
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(r.body.token.slice(4, 20));
    const list = await team.lead.get(`${team.ws}/api-tokens`);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(r.body.id);
    expect(JSON.stringify(list.body)).not.toContain(r.body.token);
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'api_token.created' AND target_id = $1`, [r.body.id])).rows[0].summary).toBe('GitHub Action · read');
  });

  it('ตรวจข้อมูล · เฉพาะ Owner / Admin · จำกัดจำนวนที่ใช้งานอยู่ 20 ตัว', async () => {
    for (const body of [{}, { name: '' }, { name: 'x', scopes: [] }, { name: 'x', scopes: ['admin'] }, { name: 'x', scopes: 'read' }]) {
      expect((await team.lead.post(`${team.ws}/api-tokens`, body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const call of [() => team.dev.get(`${team.ws}/api-tokens`), () => team.dev.post(`${team.ws}/api-tokens`, { name: 'x' })]) {
      const r = await call();
      expect(r.status).toBe(403);
      expect(r.body.error.details.permission).toBe('ws.settings');
    }
    const have = Number((await t.owner.query('SELECT count(*) FROM api_tokens WHERE workspace_id = $1 AND revoked_at IS NULL', [wsId])).rows[0].count);
    await t.owner.query(`INSERT INTO api_tokens (workspace_id, name, token_hash, scopes, created_by) SELECT $1, 'filler' || g, 'hash' || g, '{read}', $2 FROM generate_series(1, $3) g`, [wsId, team.leadId, 20 - have]);
    const full = await team.lead.post(`${team.ws}/api-tokens`, { name: 'เกิน' });
    expect(full.status).toBe(422);
    expect(full.body.error.code).toBe('api_token_limit');
    await t.owner.query(`DELETE FROM api_tokens WHERE name LIKE 'filler%'`);
  });

  it('แก้ชื่อ / scope · ยกเลิก (ใช้ไม่ได้ทันที) · ยกเลิกซ้ำ / ไม่มี 404', async () => {
    const tk = await mint();
    const p = await team.lead.patch(`${team.ws}/api-tokens/${tk.id}`, { name: 'เปลี่ยนชื่อ', scopes: ['read', 'write', 'write'] });
    expect(p.body).toMatchObject({ name: 'เปลี่ยนชื่อ', scopes: ['read', 'write'] });
    expect((await team.lead.patch(`${team.ws}/api-tokens/${tk.id}`, {})).status).toBe(400);
    expect((await team.dev.patch(`${team.ws}/api-tokens/${tk.id}`, { name: 'x' })).status).toBe(403);
    expect((await api(tk.token).get(`${team.ws}/projects/${team.key}`)).status).toBe(200);
    expect((await team.dev.delete(`${team.ws}/api-tokens/${tk.id}`)).status).toBe(403);
    expect((await team.lead.delete(`${team.ws}/api-tokens/${tk.id}`)).body).toEqual({ revoked: true });
    const gone = await api(tk.token).get(`${team.ws}/projects/${team.key}`);
    expect(gone.status).toBe(401);
    expect(gone.body.error.code).toBe('invalid_token');
    expect((await team.lead.delete(`${team.ws}/api-tokens/${tk.id}`)).status).toBe(404);
    expect((await team.lead.patch(`${team.ws}/api-tokens/${tk.id}`, { name: 'x' })).status).toBe(404);
    expect((await team.lead.get(`${team.ws}/api-tokens`)).body.items.map((i: { id: string }) => i.id)).not.toContain(tk.id);
    expect((await t.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'api_token.revoked' AND target_id = $1`, [tk.id])).rowCount).toBe(1);
  });
});

describe('Authorization: Bearer', () => {
  it('scope read: อ่านได้ (ไม่ต้องมีคุกกี้) แต่เขียนไม่ได้ · scope write เขียนได้โดยไม่ต้องมี CSRF และผลเป็นของผู้สร้าง token', async () => {
    const ro = await mint(team.lead, { name: 'read only', scopes: ['read'] });
    const issues = await api(ro.token).get(`${team.ws}/projects/${team.key}/issues`);
    expect(issues.status, JSON.stringify(issues.body)).toBe(200);
    const denied = await api(ro.token).post(`${team.ws}/projects/${team.key}/issues`, { title: 'จาก token read', moduleId });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'insufficient_scope', details: { required: 'write', scopes: ['read'] } });
    expect((await api(ro.token).delete(`${team.ws}/issues/DP-1`)).status).toBe(403);

    const rw = await mint(team.lead, { name: 'read write', scopes: ['write'] });
    const made = await api(rw.token).post(`${team.ws}/projects/${team.key}/issues`, { title: 'จาก token write', moduleId });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await t.owner.query('SELECT created_by FROM issues WHERE id = $1', [made.body.id])).rows[0].created_by).toBe(team.leadId);
    // write รวม read
    expect((await api(rw.token).get(`${team.ws}/projects/${team.key}/issues/${made.body.key}`.replace('/projects/DP/issues/', '/issues/'))).status).toBe(200);
    expect((await t.owner.query('SELECT last_used_at FROM api_tokens WHERE id = $1', [rw.id])).rows[0].last_used_at).not.toBeNull();
  });

  it('สิทธิ์ = สิทธิ์ของผู้สร้าง ∩ scopes: ผู้สร้างถูกลดเป็น Member แล้ว token ทำสิ่งที่ Member ทำไม่ได้ไม่ได้ · ปิดการใช้งานผู้สร้าง → token ใช้ไม่ได้', async () => {
    const adminUser = await client(t.app);
    const adminId = await signup(adminUser, 'admin-token@tokens.example.com', 'Token Admin');
    await addMember(t.owner, team.slug, adminId, 'admin', { key: team.key, role: 'member' });
    const tk = await mint(adminUser, { name: 'admin write', scopes: ['write'] });
    const edit = () => api(tk.token).patch(`${team.ws}`, { name: 'Friday renamed' });
    // Admin มี ws.settings
    expect((await edit()).status).toBe(200);
    await t.owner.query(`UPDATE workspace_members SET role = 'member' WHERE user_id = $1 AND workspace_id = $2`, [adminId, wsId]);
    const after = await edit();
    expect(after.status).toBe(403);
    expect(after.body.error.details.permission).toBe('ws.settings');
    await team.lead.patch(team.ws, { name: 'Friday' });

    await t.owner.query(`UPDATE workspace_members SET status = 'deactivated' WHERE user_id = $1 AND workspace_id = $2`, [adminId, wsId]);
    const dead = await api(tk.token).get(`${team.ws}/projects/${team.key}`);
    expect(dead.status).toBe(401);
    expect(dead.body.error.code).toBe('invalid_token');
  });

  it('ใช้กับ Workspace อื่นไม่ได้ · ส่วนอ่อนไหวและ API ระดับบัญชีเข้าไม่ได้ แม้ scope write', async () => {
    const tk = await mint(team.lead, { name: 'limited', scopes: ['write'] });
    const b = api(tk.token);
    const other = await b.get(`/w/${otherSlug}/projects`);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('token_workspace_mismatch');
    expect((await b.get('/w/no-such-ws/projects')).body.error.code).toBe('token_workspace_mismatch');
    for (const path of ['/api-tokens', '/channels/email', '/billing', '/members', '/invitations', '/invite-links', '/access-requests', '/saved-searches', '/leaves', '/me/membership']) {
      const r = await b.get(`${team.ws}${path}`);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code, path).toBe('token_not_allowed');
    }
    expect((await b.post(`${team.ws}/api-tokens`, { name: 'ยกระดับตัวเอง', scopes: ['write'] })).status).toBe(403);
    for (const path of ['/me/workspaces', '/me/sessions', '/workspaces/slug-available?slug=abc']) {
      const r = await b.get(path);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe('token_not_allowed');
    }
    const me = await b.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('lead@friday-dev.example.com');
    expect((await b.get(`${team.ws}/usage`)).status).toBe(200);
  });

  it('Bearer ไม่ถูกต้อง → 401 · ไม่ผสมกับคุกกี้ · route สาธารณะไม่ล้มเพราะ token เสีย', async () => {
    for (const h of ['Bearer fmt_notarealtoken', 'Bearer notprefixed', 'Bearer ', 'Bearer a b']) {
      const r = await anon().get(`/api/v1${team.ws}/projects`).set('authorization', h);
      expect([401], h).toContain(r.status);
    }
    expect((await anon().get(`/api/v1/w/${team.slug}/projects`)).status).toBe(401);
    // มีคุกกี้ session แต่ส่ง Bearer เสียมาด้วย → ยึด Bearer (ไม่ fallback ไปคุกกี้)
    const withCookie = await team.lead.agent.get(`/api/v1${team.ws}/projects`).set('authorization', 'Bearer fmt_bad');
    expect(withCookie.status).toBe(401);
    const pub = await anon().get('/api/v1/public/plans').set('authorization', 'Bearer fmt_bad');
    expect(pub.status).toBe(200);
  });
});
