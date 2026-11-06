// BUG-10 · โปรเจกต์ใหม่ได้กฎ Workflow ค่าเริ่มต้นตาม catalog และกฎมีผลจริง · ข้อมูลสมมติเท่านั้น
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let statuses: Array<{ id: string; name: string; boardColumnId: string | null }>;
let workflows: Array<{ id: string; name: string }>;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t, { withDefaultRules: true });
  statuses = team.project.statuses;
  workflows = (await t.owner.query('SELECT id, name FROM workflows WHERE project_id = $1', [team.project.id])).rows;
});
afterAll(() => t.close());

const status = (name: string, bug = false) => statuses.find((s) => s.name === name && (bug ? !!s.boardColumnId || name === 'Open' : !s.boardColumnId))!.id;
const url = (key: string) => `${team.ws}/issues/${key}`;
async function create(body: Record<string, unknown> = {}) {
  const r = await team.lead.post(`${team.ws}/projects/${team.key}/issues`, { title: 'งานสมมติ', moduleId: team.project.modules[0].id, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { key: string; version: number };
}

describe('กฎ Workflow ค่าเริ่มต้นของโปรเจกต์ใหม่', () => {
  it('มีแถวกฎครบตาม catalog ของทั้ง Workflow มาตรฐานและ Bug · หน้า rules แสดงว่าตั้งค่าแล้ว', async () => {
    const std = workflows.find((w) => w.name === 'มาตรฐาน')!;
    const r = await team.lead.get(`${team.ws}/projects/${team.key}/workflows/${std.id}/rules`);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).toContain('reviewer_required');
    const count = (await t.owner.query('SELECT count(*)::int AS n FROM workflow_rules WHERE project_id = $1', [team.project.id])).rows[0].n;
    expect(count).toBe(8);
  });

  it('ย้ายไป Review โดยไม่มี Reviewer → 422 · มี Reviewer ผ่าน', async () => {
    const issue = await create();
    const r = await team.lead.post(`${url(issue.key)}/move`, { statusId: status('Review') });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('reviewer_required');
    const ok = await team.lead.patch(url(issue.key), { statusId: status('Review'), reviewerId: team.devId }, issue.version);
    expect(ok.status).toBe(200);
  });

  it('Bug ส่ง Fixed โดยไม่มี Commit/PR → 422', async () => {
    const bug = await create({ type: 'Bug', severity: 'major', environment: 'sit', details: { steps: 'สมมติ' } });
    const r = await team.lead.post(`${url(bug.key)}/move`, { statusId: status('Fixed', true) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('fix_reference_required');
  });

  it('ปิดกฎเองแล้วมีผล: ย้ายไป Review ได้โดยไม่มี Reviewer', async () => {
    const std = workflows.find((w) => w.name === 'มาตรฐาน')!;
    const rule = (await t.owner.query(`SELECT id FROM workflow_rules WHERE workflow_id = $1 AND rule_type = 'reviewer_required'`, [std.id])).rows[0].id;
    const off = await team.lead.patch(`${team.ws}/projects/${team.key}/workflows/${std.id}/rules/${rule}`, { enabled: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const issue = await create();
    expect((await team.lead.post(`${url(issue.key)}/move`, { statusId: status('Review') })).status).toBe(200);
  });
});
