// A27 · เชื่อม GitHub · payload ตัวอย่างของ GitHub (ข้อมูลสมมติ) · GitHub API ปลอม
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken } from '../src/auth/crypto.js';
import { GithubApi } from '../src/git/github-api.js';
import { issueKeysIn } from '../src/git/git-events.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

const SECRET = 'whsec-test-secret';
const INSTALL = '4242';
const REPO = 'friday-org/credit-line';
let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let guest: Client;
let wsId: string;
let projectId: string;
let moduleId: string;
let instId = '';
let repoId = '';
let linkId = '';
const st: Record<string, string> = {};
let ghRepos = [{ fullName: REPO, defaultBranch: 'main' }, { fullName: 'friday-org/portal', defaultBranch: 'develop' }];
const anon = () => request(t.app.getHttpServer());

beforeAll(async () => {
  Object.assign(process.env, { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_ID: '123456', GITHUB_APP_SLUG: 'friday-manage-test', GITHUB_APP_PRIVATE_KEY: 'unused-in-tests', WEB_URL: 'https://app.friday.test' });
  t = await startApp();
  const gh = t.app.get(GithubApi);
  gh.installation = async (id) => ({ accountName: `org-${id}` });
  gh.repositories = async () => ghRepos;
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  projectId = team.project.id;
  moduleId = team.project.modules[0].id;
  guest = await client(t.app);
  await addMember(t.owner, team.slug, await signup(guest, 'guest@git.example.com', 'Guest'), 'guest', { key: team.key, role: 'viewer' });
  for (const name of ['To do', 'In progress', 'Review', 'Done']) st[name] = (await t.owner.query('SELECT id FROM workflow_statuses WHERE project_id = $1 AND name = $2', [projectId, name])).rows[0].id;
});
afterAll(async () => {
  for (const k of ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_PRIVATE_KEY', 'WEB_URL']) delete process.env[k];
  await t.close();
});

const sig = (raw: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
async function hook(event: string, payload: object, o: { signature?: string | null; delivery?: string } = {}) {
  const raw = JSON.stringify(payload);
  const r = anon().post('/api/v1/hooks/github').set('content-type', 'application/json').set('x-github-event', event).set('x-github-delivery', o.delivery ?? `d-${Math.random().toString(16).slice(2)}-delivery`);
  if (o.signature !== null) r.set('x-hub-signature-256', o.signature ?? sig(raw));
  return r.send(raw);
}
async function issue(title: string, assignee?: string) {
  const r = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title, moduleId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (assignee) await t.owner.query('INSERT INTO issue_assignees (workspace_id, issue_id, user_id, sort) VALUES ($1,$2,$3,0)', [wsId, r.body.id, assignee]);
  return r.body as { id: string; key: string };
}
const statusOf = async (id: string) => (await t.owner.query('SELECT s.name FROM issues i JOIN workflow_statuses s ON s.id = i.status_id WHERE i.id = $1', [id])).rows[0].name as string;
const base = { installation: { id: Number(INSTALL) }, repository: { full_name: REPO } };
const commit = (sha: string, message: string) => ({ id: sha, message, timestamp: '2026-12-02T03:00:00Z', url: `https://github.com/${REPO}/commit/${sha}`, author: { name: 'Kaijeaw', username: 'kaijeaw' } });
const push = (branch: string, commits: object[]) => ({ ...base, ref: `refs/heads/${branch}`, commits });

describe('issueKeysIn', () => {
  it('หา Issue key จาก branch / message ไม่สนตัวพิมพ์ ตัดซ้ำ และไม่จับคำที่ติดกับตัวอักษรอื่น', () => {
    expect(issueKeysIn('feature/dp-39-login-form')).toEqual([{ key: 'DP', n: 39 }]);
    expect(issueKeysIn('DP-1 fix, closes dp-1 and CL-22; also UTF-8')).toEqual([{ key: 'DP', n: 1 }, { key: 'CL', n: 22 }, { key: 'UTF', n: 8 }]);
    // คำที่ติดกับตัวอักษรอื่นเป็น key ยาวขึ้น (ABCDP) · DP-5x ไม่นับ · key ต้องยาว ≥ 2 ตัว (x-1 ไม่นับ)
    expect(issueKeysIn('abcDP-5 DP-5x x-1')).toEqual([{ key: 'ABCDP', n: 5 }]);
    expect(issueKeysIn(null)).toEqual([]);
  });
});

describe('ติดตั้ง GitHub App', () => {
  it('install-url: เฉพาะ Admin และต้องตั้งค่า App ของระบบ · state ลงลายมือชื่อ', async () => {
    expect((await team.dev.get(`${team.ws}/integrations/git/install-url`)).status).toBe(403);
    const r = await team.lead.get(`${team.ws}/integrations/git/install-url`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const u = new URL(r.body.url);
    expect(u.origin + u.pathname).toBe('https://github.com/apps/friday-manage-test/installations/new');
    expect(u.searchParams.get('state')).toMatch(/\./);
    const saved = process.env.GITHUB_APP_SLUG;
    delete process.env.GITHUB_APP_SLUG;
    expect((await team.lead.get(`${team.ws}/integrations/git/install-url`)).body.error.code).toBe('github_not_configured');
    process.env.GITHUB_APP_SLUG = saved;
  });

  it('setup: กลับจาก GitHub → บันทึกการติดตั้งและ repository แล้ว redirect ไปหน้า Admin Console · Audit', async () => {
    const state = new URL((await team.lead.get(`${team.ws}/integrations/git/install-url`)).body.url).searchParams.get('state')!;
    const r = await anon().get(`/api/v1/hooks/github/setup?installation_id=${INSTALL}&setup_action=install&state=${encodeURIComponent(state)}`).redirects(0);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`https://app.friday.test/w/${team.slug}/admin/integrations?github=connected`);
    const list = await team.lead.get(`${team.ws}/integrations/git`);
    expect(list.body).toMatchObject({ configured: true, items: [{ provider: 'github', accountName: `org-${INSTALL}`, status: 'active', repositories: [{ fullName: REPO, defaultBranch: 'main', projects: [] }, { fullName: 'friday-org/portal', defaultBranch: 'develop' }] }] });
    instId = list.body.items[0].id;
    repoId = list.body.items[0].repositories.find((x: { fullName: string }) => x.fullName === REPO).id;
    expect((await team.lead.get(`${team.ws}/integrations/git/${instId}/repositories`)).body.items).toHaveLength(2);
    expect((await t.owner.query(`SELECT summary FROM audit_logs WHERE action = 'integration.github_installed'`)).rows[0].summary).toBe(`org-${INSTALL}`);
    expect((await team.dev.get(`${team.ws}/integrations/git`)).status).toBe(403);
  });

  it('setup ไม่ถูกต้อง: state ปลอม / หมดอายุ / ผู้เริ่มไม่ใช่ Admin แล้ว / installation เป็นของ Workspace อื่น → ปฏิเสธ', async () => {
    const go = (installation: string, state: string) => anon().get(`/api/v1/hooks/github/setup?installation_id=${installation}&state=${encodeURIComponent(state)}`).redirects(0);
    expect((await go(INSTALL, 'garbage')).status).toBe(400);
    expect((await go('abc', signToken('github-install', { w: wsId, u: team.leadId }, 900))).status).toBe(400);
    expect((await go(INSTALL, signToken('github-install', { w: wsId, u: team.leadId }, -10))).status).toBe(400);
    const member = await go(INSTALL, signToken('github-install', { w: wsId, u: team.devId }, 900));
    expect(member.status).toBe(403);
    // Workspace อื่นพยายามรับ installation เดียวกัน
    const other = await client(t.app);
    const otherId = await signup(other, 'owner@other-git.example.com', 'Other Owner');
    expect((await other.post('/workspaces', { name: 'OtherGit', slug: 'other-git' })).status).toBe(201);
    const otherWs = (await t.owner.query(`SELECT id FROM workspaces WHERE slug = 'other-git'`)).rows[0].id;
    const taken = await go(INSTALL, signToken('github-install', { w: otherWs, u: otherId }, 900));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('installation_taken');
    const pending = await go(INSTALL, signToken('github-install', { w: wsId, u: team.leadId }, 900) ).catch(() => null);
    expect(pending).not.toBeNull();
    const req = await anon().get(`/api/v1/hooks/github/setup?installation_id=${INSTALL}&setup_action=request&state=${encodeURIComponent(signToken('github-install', { w: wsId, u: team.leadId }, 900))}`).redirects(0);
    expect(req.headers.location).toContain('github=pending');
  });

  it('sync: ดึง repository ใหม่ / เอาที่ App เข้าไม่ถึงออก (การผูกกับโปรเจกต์หายตาม) · DELETE ถอนการเชื่อมต่อ', async () => {
    ghRepos = [{ fullName: REPO, defaultBranch: 'main' }, { fullName: 'friday-org/new-repo', defaultBranch: 'main' }];
    const r = await team.lead.post(`${team.ws}/integrations/git/${instId}/sync`);
    expect(r.body).toEqual({ repositories: 2 });
    const names = (await team.lead.get(`${team.ws}/integrations/git/${instId}/repositories`)).body.items.map((x: { fullName: string }) => x.fullName);
    expect(names).toEqual([REPO, 'friday-org/new-repo']);
    expect((await team.dev.post(`${team.ws}/integrations/git/${instId}/sync`)).status).toBe(403);
    expect((await team.lead.post(`${team.ws}/integrations/git/00000000-0000-4000-8000-000000000000/sync`)).status).toBe(404);
    ghRepos = [{ fullName: REPO, defaultBranch: 'main' }, { fullName: 'friday-org/portal', defaultBranch: 'develop' }];
    await team.lead.post(`${team.ws}/integrations/git/${instId}/sync`);
  });
});

describe('POST hooks/github · ความปลอดภัย', () => {
  it('ลายเซ็นผิด / ไม่มี → 401 · ไม่ตั้ง secret → 503 · ping ผ่านโดยไม่ต้องมี CSRF', async () => {
    expect((await hook('ping', { zen: 'x' }, { signature: sig('{"zen":"x"}', 'wrong') })).status).toBe(401);
    expect((await hook('ping', { zen: 'x' }, { signature: null })).status).toBe(401);
    const ok = await hook('ping', { zen: 'Keep it logically awesome.' });
    expect(ok.status).toBe(202);
    expect(ok.body.queued).toBe(true);
    const saved = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    expect((await hook('ping', {})).status).toBe(503);
    process.env.GITHUB_WEBHOOK_SECRET = saved;
    const raw = 'not json';
    expect((await anon().post('/api/v1/hooks/github').set('content-type', 'application/json').set('x-github-event', 'push').set('x-hub-signature-256', sig(raw)).send(raw)).status).toBe(400);
    const noEvent = JSON.stringify({ a: 1 });
    expect((await anon().post('/api/v1/hooks/github').set('content-type', 'application/json').set('x-hub-signature-256', sig(noEvent)).send(noEvent)).status).toBe(400);
  });
});

describe('p/repositories', () => {
  it('ผูก repository กับโปรเจกต์พร้อมกฎย้ายสถานะ · เลือกสถานะนอก Workflow ไม่ได้ · ผูกซ้ำ 409 · เฉพาะผู้แก้ Settings', async () => {
    const base = `${team.ws}/projects/${team.key}/repositories`;
    const before = await team.lead.get(base);
    expect(before.body.items).toEqual([]);
    expect(before.body.available.map((x: { fullName: string }) => x.fullName)).toContain(REPO);

    const r = await team.lead.post(base, { repositoryId: repoId, onFirstCommitStatusId: st['In progress'], onPrOpenStatusId: st['Review'], onMergeStatusId: st['Done'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ repository: { fullName: REPO }, branchPattern: null, onFirstCommitStatus: { name: 'In progress' }, onPrOpenStatus: { name: 'Review' }, onMergeStatus: { name: 'Done' }, notifyOnCiFail: true });
    linkId = r.body.id;
    expect((await team.lead.post(base, { repositoryId: repoId })).body.error.code).toBe('repository_already_linked');
    expect((await team.lead.post(base, { repositoryId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('repository_not_found');
    const otherProject = await team.lead.post(`${team.ws}/projects`, { key: 'GX', name: 'Other', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['M'], sprintLengthWeeks: null });
    expect(otherProject.status).toBe(201);
    const foreign = await team.lead.post(`${team.ws}/projects/GX/repositories`, { repositoryId: repoId, onMergeStatusId: st['Done'] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('status_not_in_project');
    expect((await team.dev.post(base, { repositoryId: repoId })).status).toBe(403);
    expect((await team.dev.get(base)).status).toBe(200);
    expect((await guest.get(base)).body.error?.code).toBe('guest_view_limited');
    const integ = await team.lead.get(`${team.ws}/integrations/git`);
    expect(integ.body.items[0].repositories.find((x: { fullName: string }) => x.fullName === REPO).projects).toEqual([team.key]);

    const p = await team.lead.patch(`${base}/${linkId}`, { branchPattern: 'feature/*', notifyOnCiFail: true });
    expect(p.body.branchPattern).toBe('feature/*');
    expect((await team.lead.patch(`${base}/${linkId}`, {})).status).toBe(400);
    expect((await team.lead.patch(`${base}/${linkId}`, { branchPattern: null })).body.branchPattern).toBeNull();
  });
});

describe('push → commit', () => {
  it('ผูก Commit กับงานจาก message และ branch · commit แรกย้ายสถานะ · ไม่ย้ายซ้ำ · ส่ง payload ซ้ำไม่เกิดซ้ำ', async () => {
    const a = await issue('ฟอร์มวงเงิน');
    const b = await issue('หน้า Login');
    const payload = push('feature/' + b.key.toLowerCase() + '-login', [commit('a'.repeat(40), `${a.key}: เพิ่มฟอร์ม\n\nรายละเอียด`), commit('b'.repeat(40), 'ปรับ CSS ทั่วไป'), commit('c'.repeat(40), `ZZ-1 ไม่ใช่โปรเจกต์ที่ผูก และ ${a.key} อีกครั้ง`)]);
    const d = 'delivery-push-0001-aaaa';
    expect((await hook('push', payload, { delivery: d })).status).toBe(202);
    expect((await hook('push', payload, { delivery: d })).status).toBe(202);
    expect((await hook('push', payload)).status).toBe(202);

    const gitA = await team.lead.get(`${team.ws}/issues/${a.key}/git`);
    expect(gitA.body.commits.map((c: { shortSha: string }) => c.shortSha).sort()).toEqual(['aaaaaaa', 'ccccccc']);
    expect(gitA.body.commits.find((c: { shortSha: string }) => c.shortSha === 'aaaaaaa')).toMatchObject({ message: `${a.key}: เพิ่มฟอร์ม`, author: 'Kaijeaw', repository: REPO, linkedBy: 'message', url: expect.stringContaining('/commit/') });
    const gitB = await team.lead.get(`${team.ws}/issues/${b.key}/git`);
    expect(gitB.body.commits).toHaveLength(3);
    expect(gitB.body.commits.every((c: { linkedBy: string }) => c.linkedBy === 'branch')).toBe(true);
    expect((await t.owner.query('SELECT count(*) FROM git_commits')).rows[0].count).toBe('3');
    expect((await t.owner.query('SELECT count(*) FROM issue_git_links')).rows[0].count).toBe('5');

    expect(await statusOf(a.id)).toBe('In progress');
    expect(await statusOf(b.id)).toBe('In progress');
    expect((await t.owner.query(`SELECT count(*) FROM activities WHERE issue_id = $1 AND actor_kind = 'git' AND field = 'statusId'`, [a.id])).rows[0].count).toBe('1');
    expect((await t.owner.query('SELECT actual_start FROM issues WHERE id = $1', [a.id])).rows[0].actual_start).not.toBeNull();
  });

  it('งานที่ไปไกลกว่าแล้วไม่ถูกดึงถอยหลัง · repository ที่ไม่ได้ผูก / branch ไม่ตรง pattern / ลบ branch / installation ไม่รู้จัก → ไม่ผูก', async () => {
    const done = await issue('งานที่เสร็จแล้ว');
    await t.owner.query(`UPDATE issues SET status_id = $2 WHERE id = $1`, [done.id, st['Done']]);
    await hook('push', push('main', [commit('d'.repeat(40), `${done.key} hotfix`)]));
    expect(await statusOf(done.id)).toBe('Done');
    expect((await team.lead.get(`${team.ws}/issues/${done.key}/git`)).body.commits).toHaveLength(1);

    const x = await issue('งาน branch pattern');
    await team.lead.patch(`${team.ws}/projects/${team.key}/repositories/${linkId}`, { branchPattern: 'release/*' });
    await hook('push', push('feature/other', [commit('e'.repeat(40), `${x.key} ไม่ควรผูก`)]));
    expect((await team.lead.get(`${team.ws}/issues/${x.key}/git`)).body.commits).toEqual([]);
    await hook('push', push('release/1.0', [commit('f'.repeat(40), `${x.key} ควรผูก`)]));
    expect((await team.lead.get(`${team.ws}/issues/${x.key}/git`)).body.commits).toHaveLength(1);
    await team.lead.patch(`${team.ws}/projects/${team.key}/repositories/${linkId}`, { branchPattern: null });

    const y = await issue('งานอื่น');
    await hook('push', { ...push('main', [commit('1'.repeat(40), `${y.key} x`)]), repository: { full_name: 'friday-org/not-connected' } });
    await hook('push', { ...push('main', [commit('2'.repeat(40), `${y.key} x`)]), installation: { id: 999 } });
    await hook('push', { ...push('main', [commit('3'.repeat(40), `${y.key} x`)]), deleted: true });
    await hook('push', { ...push('main', [commit('4'.repeat(40), `${y.key} x`)]), ref: 'refs/tags/v1' });
    expect((await team.lead.get(`${team.ws}/issues/${y.key}/git`)).body.commits).toEqual([]);
    expect(await statusOf(y.id)).toBe('To do');
  });
});

describe('pull request และ CI', () => {
  const pr = (action: string, n: number, title: string, branch: string, o: { draft?: boolean; merged?: boolean; state?: string } = {}) => ({
    ...base,
    action,
    pull_request: { number: n, title, state: o.state ?? 'open', draft: !!o.draft, merged: !!o.merged, html_url: `https://github.com/${REPO}/pull/${n}`, head: { ref: branch, sha: 'f00dbabe'.repeat(5) }, base: { ref: 'main' } },
  });

  it('เปิด PR → ผูกจาก title/branch + ย้ายเป็น Review · Draft ไม่ย้าย · merge → Done · ดูผ่าน i/git', async () => {
    const a = await issue('PR: ฟอร์ม');
    const draft = await issue('PR: draft');
    await hook('pull_request', pr('opened', 7, `${a.key} เพิ่มฟอร์มวงเงิน`, 'feature/form'));
    expect(await statusOf(a.id)).toBe('Review');
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests).toMatchObject([{ number: 7, title: `${a.key} เพิ่มฟอร์มวงเงิน`, state: 'open', sourceBranch: 'feature/form', targetBranch: 'main', ciStatus: null, reviewStatus: null, repository: REPO, linkedBy: 'title', url: `https://github.com/${REPO}/pull/7` }]);

    await hook('pull_request', pr('opened', 8, 'WIP ยังไม่ระบุงาน', `feature/${draft.key.toLowerCase()}-wip`, { draft: true }));
    expect(await statusOf(draft.id)).toBe('To do');
    expect((await team.lead.get(`${team.ws}/issues/${draft.key}/git`)).body.pullRequests).toMatchObject([{ number: 8, state: 'draft', linkedBy: 'branch' }]);
    await hook('pull_request', pr('ready_for_review', 8, 'WIP ยังไม่ระบุงาน', `feature/${draft.key.toLowerCase()}-wip`));
    expect(await statusOf(draft.id)).toBe('Review');

    await hook('pull_request', pr('closed', 7, `${a.key} เพิ่มฟอร์มวงเงิน`, 'feature/form', { state: 'closed', merged: true }));
    expect(await statusOf(a.id)).toBe('Done');
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].state).toBe('merged');
    expect((await t.owner.query('SELECT completed_at FROM issues WHERE id = $1', [a.id])).rows[0].completed_at).not.toBeNull();
    const closedOnly = await issue('PR: ปิดโดยไม่ merge');
    await hook('pull_request', pr('opened', 9, `${closedOnly.key} x`, 'feature/x'));
    await hook('pull_request', pr('closed', 9, `${closedOnly.key} x`, 'feature/x', { state: 'closed' }));
    expect(await statusOf(closedOnly.id)).toBe('Review');
    expect((await team.lead.get(`${team.ws}/issues/${closedOnly.key}/git`)).body.pullRequests[0].state).toBe('closed');
  });

  it('CI ล้มเหลว → อัปเดต ciStatus + แจ้ง Assignee ครั้งเดียวต่อ commit (Event ci.failed) · ปิดแจ้งเตือนได้ · สำเร็จไม่แจ้ง · Review ถูกเก็บ', async () => {
    const a = await issue('CI: งานของ dev', team.devId);
    await hook('pull_request', pr('opened', 20, `${a.key} เพิ่มรายงาน`, 'feature/report'));
    await t.owner.query('DELETE FROM notifications');
    const sha = '9'.repeat(40);
    const run = (conclusion: string, number = 20, name = 'build') => ({ ...base, action: 'completed', check_run: { name, conclusion, head_sha: sha, pull_requests: [{ number }] } });
    await hook('check_run', run('failure'));
    await hook('check_run', run('failure'));
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].ciStatus).toBe('failure');
    const notes = (await t.owner.query(`SELECT recipient_id, payload FROM notifications WHERE event_type = 'ci.failed'`)).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0].recipient_id).toBe(team.devId);
    expect(notes[0].payload).toMatchObject({ issueKey: a.key, prNumber: 20, prUrl: `https://github.com/${REPO}/pull/20`, repository: REPO, sha, check: 'build', projectKey: team.key });

    await hook('workflow_run', { ...base, action: 'completed', workflow_run: { name: 'CI', conclusion: 'success', head_sha: sha, pull_requests: [{ number: 20 }] } });
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].ciStatus).toBe('success');
    await hook('check_run', { ...base, action: 'completed', check_run: { name: 'lint', conclusion: 'cancelled', head_sha: sha, pull_requests: [{ number: 20 }] } });
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].ciStatus).toBe('success');

    await t.owner.query('DELETE FROM notifications');
    await team.lead.patch(`${team.ws}/projects/${team.key}/repositories/${linkId}`, { notifyOnCiFail: false });
    await hook('check_suite', { ...base, action: 'completed', check_suite: { conclusion: 'timed_out', head_sha: '8'.repeat(40), pull_requests: [{ number: 20 }] } });
    expect((await t.owner.query(`SELECT 1 FROM notifications WHERE event_type = 'ci.failed'`)).rowCount).toBe(0);
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].ciStatus).toBe('failure');
    await team.lead.patch(`${team.ws}/projects/${team.key}/repositories/${linkId}`, { notifyOnCiFail: true });

    await hook('pull_request', pr('synchronize', 20, `${a.key} เพิ่มรายงาน`, 'feature/report'));
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].ciStatus).toBeNull();
    await hook('pull_request_review', { ...base, action: 'submitted', review: { state: 'APPROVED' }, pull_request: { number: 20 } });
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].reviewStatus).toBe('approved');
    await hook('pull_request_review', { ...base, action: 'submitted', review: { state: 'commented' }, pull_request: { number: 20 } });
    expect((await team.lead.get(`${team.ws}/issues/${a.key}/git`)).body.pullRequests[0].reviewStatus).toBe('approved');
  });

  it('งานที่ไม่มี Assignee → แจ้ง PM (Project Owner)', async () => {
    const a = await issue('CI: ไม่มีผู้รับผิดชอบ');
    await hook('pull_request', pr('opened', 30, `${a.key} x`, 'feature/noassignee'));
    await t.owner.query('DELETE FROM notifications');
    await hook('check_run', { ...base, action: 'completed', check_run: { name: 'build', conclusion: 'failure', head_sha: '7'.repeat(40), pull_requests: [{ number: 30 }] } });
    expect((await t.owner.query(`SELECT recipient_id FROM notifications WHERE event_type = 'ci.failed'`)).rows.map((r) => r.recipient_id)).toEqual([team.leadId]);
  });
});

describe('installation events และสิทธิ์ดู', () => {
  it('installation_repositories เพิ่ม / เอาออก repository · suspend แล้วไม่ประมวลผล · deleted ลบการติดตั้งและการผูกโปรเจกต์', async () => {
    await hook('installation_repositories', { ...base, action: 'added', repositories_added: [{ full_name: 'friday-org/added-later' }], repositories_removed: [] });
    expect((await team.lead.get(`${team.ws}/integrations/git/${instId}/repositories`)).body.items.map((x: { fullName: string }) => x.fullName)).toContain('friday-org/added-later');
    await hook('installation_repositories', { ...base, action: 'removed', repositories_added: [], repositories_removed: [{ full_name: 'friday-org/added-later' }] });
    expect((await team.lead.get(`${team.ws}/integrations/git/${instId}/repositories`)).body.items.map((x: { fullName: string }) => x.fullName)).not.toContain('friday-org/added-later');

    const z = await issue('suspend');
    await hook('installation', { ...base, action: 'suspend' });
    expect((await team.lead.get(`${team.ws}/integrations/git`)).body.items[0].status).toBe('suspended');
    await hook('push', push('main', [commit('5'.repeat(40), `${z.key} ระหว่างระงับ`)]));
    expect((await team.lead.get(`${team.ws}/issues/${z.key}/git`)).body.commits).toEqual([]);
    await hook('installation', { ...base, action: 'unsuspend' });
    await hook('push', push('main', [commit('6'.repeat(40), `${z.key} หลังเปิดใช้`)]));
    expect((await team.lead.get(`${team.ws}/issues/${z.key}/git`)).body.commits).toHaveLength(1);

    expect((await t.owner.query('SELECT count(*) FROM project_repositories')).rows[0].count).toBe('1');
    await hook('installation', { ...base, action: 'deleted' });
    expect((await team.lead.get(`${team.ws}/integrations/git`)).body.items).toEqual([]);
    expect((await t.owner.query('SELECT count(*) FROM project_repositories')).rows[0].count).toBe('0');
    expect((await team.lead.get(`${team.ws}/issues/${z.key}/git`)).body.commits).toEqual([]);
  });

  it('DELETE ถอนการเชื่อมต่อ (เฉพาะ Admin) · Guest ดู Git ของงานที่ไม่ได้แชร์ไม่ได้', async () => {
    const state = new URL((await team.lead.get(`${team.ws}/integrations/git/install-url`)).body.url).searchParams.get('state')!;
    await anon().get(`/api/v1/hooks/github/setup?installation_id=${INSTALL}&setup_action=install&state=${encodeURIComponent(state)}`).redirects(0);
    const id = (await team.lead.get(`${team.ws}/integrations/git`)).body.items[0].id;
    expect((await team.dev.delete(`${team.ws}/integrations/git/${id}`)).status).toBe(403);
    expect((await team.lead.delete(`${team.ws}/integrations/git/${id}`)).body).toEqual({ removed: true });
    expect((await team.lead.delete(`${team.ws}/integrations/git/${id}`)).status).toBe(404);
    expect((await team.lead.delete(`${team.ws}/integrations/git/abc`)).status).toBe(404);
    const q = await issue('งานภายใน');
    expect([403, 404]).toContain((await guest.get(`${team.ws}/issues/${q.key}/git`)).status);
    expect((await team.dev.get(`${team.ws}/issues/${q.key}/git`)).body).toEqual({ commits: [], pullRequests: [] });
  });
});
