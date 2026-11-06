// A06 · ข้อมูลสมมติเท่านั้น; แยกโปรเจกต์ในแต่ละกรณีเพื่อไม่ผูกกับลำดับของ test
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { today } from '../src/common/dates.js';
import { EventBus, type DomainEvent } from '../src/core/events.js';
import { Jobs } from '../src/queue/jobs.js';
import { SprintsService } from '../src/sprints/sprints.service.js';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let viewer: Client;
let viewerId: string;
let guest: Client;
let guestId: string;
const events: DomainEvent[] = [];
let sequence = 0;
beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  t.app.get(EventBus).on('*', (event) => { events.push(event); });
  viewer = await client(t.app); viewerId = await signup(viewer, 'viewer@sprints.example.com', 'Viewer');
  guest = await client(t.app); guestId = await signup(guest, 'guest@sprints.example.com', 'Guest');
  await addMember(t.owner, team.slug, viewerId, 'member', { key: team.key, role: 'viewer' });
  await addMember(t.owner, team.slug, guestId, 'guest', { key: team.key, role: 'viewer' });
});
afterAll(() => t.close());

async function fixture() {
  const key = `SP${++sequence}`;
  const response = await team.lead.post(`${team.ws}/projects`, { key, name: `Sprint Test ${sequence}`, startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Demo'], sprintLengthWeeks: null });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const project = (await team.lead.get(`${team.ws}/projects/${key}`)).body;
  project.workspaceId = (await t.owner.query('SELECT workspace_id FROM projects WHERE id=$1', [project.id])).rows[0].workspace_id;
  // โปรเจกต์หลักไม่ต้องมี Sprint ที่สร้างไว้ล่วงหน้า เพื่อทดสอบ empty และเลขลำดับได้ตรง ๆ
  await t.owner.query('DELETE FROM sprints WHERE project_id=$1', [project.id]);
  await t.owner.query('INSERT INTO project_members (workspace_id,project_id,user_id,role) VALUES ($1,$2,$3,$4)', [project.workspaceId,project.id,team.devId,'member']);
  const base = `${team.ws}/projects/${key}`;
  async function sprint(input: Record<string, unknown> = {}) {
    const response = await team.lead.post(`${base}/sprints`, { name: 'Sprint ตัวอย่าง', startDate: '2026-11-30', endDate: '2026-12-11', ...input });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { id: string; number: number; status: string; name: string };
  }
  async function issue(input: Record<string, unknown> = {}) {
    const response = await team.lead.post(`${base}/issues`, { title: 'งานตัวอย่าง', moduleId: project.modules[0].id, size: 'S', ...input });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { id: string; key: string; version: number };
  }
  return { key, project, base, sprint, issue };
}

describe('Sprint lifecycle and consistency', () => {
  it('สร้าง Sprint เรียงเลข, แก้ชื่อ/เป้าหมาย/วันที่ และคืน backlog ว่างได้', async () => {
    const f = await fixture();
    const empty = await team.lead.get(`${f.base}/backlog`); expect(empty.status).toBe(200); expect(empty.body).toMatchObject({ sprints: [], backlog: { issues: [], stats: { totalMd: 0 } }, permissions: { canManageSprints: true } });
    const first = await f.sprint({ goal: 'เป้าหมายแรก' }); const second = await f.sprint(); expect(first.number).toBe(1); expect(second.number).toBe(2);
    const update = await team.lead.patch(`${f.base}/sprints/${first.id}`, { name: 'แก้ชื่อ Sprint', goal: null, endDate: '2026-12-15' });
    expect(update.status, JSON.stringify(update.body)).toBe(200); expect(update.body).toMatchObject({ name: 'แก้ชื่อ Sprint', goal: null, status: 'planning', endDate: '2026-12-15' });
  });

  it('สร้างพร้อมกันไม่ให้เลข Sprint ซ้ำ', async () => {
    const f = await fixture();
    const results = await Promise.all([f.sprint(), f.sprint()]); expect(results.map((r) => r.number).sort()).toEqual([1,2]);
  });

  it('เริ่มได้หนึ่ง Sprint แม้ส่งพร้อมกัน และส่ง Event หลัง commit ครั้งเดียว', async () => {
    const f = await fixture(); const first = await f.sprint(); const second = await f.sprint();
    let committed = false;
    t.app.get(EventBus).on('sprint.started', async (event) => { if (event.projectId === f.project.id) committed = (await t.owner.query('SELECT status FROM sprints WHERE id=$1', [event.data.sprintId])).rows[0].status === 'active'; });
    const results = await Promise.all([team.lead.post(`${f.base}/sprints/${first.id}/start`), team.lead.post(`${f.base}/sprints/${second.id}/start`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200,409]); expect(results.find((r)=>r.status===409)?.body.error.code).toBe('sprint_active_exists'); expect(committed).toBe(true);
    expect(events.filter((event) => event.projectId === f.project.id && event.type === 'sprint.started')).toHaveLength(1);
    const active = results.find((r)=>r.status===200)!.body;
    expect((await team.lead.post(`${f.base}/sprints/${active.id}/start`)).status).toBe(409);
  });

  it('จบ Sprint แล้วย้ายงานค้างพร้อม Sub-task ทุกสถานะไป Sprint ถัดไป, งานเสร็จอยู่ที่เดิม', async () => {
    const f = await fixture(); const first = await f.sprint(); const next = await f.sprint({ name: 'Sprint ถัดไป' });
    const parent = await f.issue({ sprintId: first.id, title: 'งานแม่ค้าง' });
    const child = await f.issue({ parentKey: parent.key, title: 'ลูกค้าง', size: 'XS' });
    const doneChild = await f.issue({ parentKey: parent.key, title: 'ลูกเสร็จ', size: 'XS' });
    const done = await f.issue({ sprintId: first.id, title: 'งานเสร็จแล้ว', size: 'XS' });
    const doneStatus = f.project.statuses.find((status: {name: string;boardColumnId: string|null}) => status.name === 'Done' && !status.boardColumnId).id;
    for (const issue of [done, doneChild]) expect((await team.lead.post(`${team.ws}/issues/${issue.key}/move`, {statusId:doneStatus})).status).toBe(200);
    expect((await team.lead.post(`${f.base}/sprints/${first.id}/start`)).status).toBe(200);
    const response = await team.lead.post(`${f.base}/sprints/${first.id}/complete`, { moveIncompleteTo: next.id, retrospective: 'บทเรียนที่ได้' });
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body).toMatchObject({status:'completed',retrospective:'บทเรียนที่ได้',completedBy:team.leadId,moved:{tasks:1,subtasks:2,destination:next.id}}); expect(response.body.completedAt).toBeTruthy();
    const rows = (await t.owner.query('SELECT id,sprint_id,version FROM issues WHERE id=ANY($1::uuid[])', [[parent.id,child.id,doneChild.id,done.id]])).rows;
    for (const id of [parent.id,child.id,doneChild.id]) expect(rows.find((row)=>row.id===id).sprint_id).toBe(next.id);
    expect(rows.find((row)=>row.id===done.id).sprint_id).toBe(first.id);
    expect(rows.find((row)=>row.id===parent.id).version).toBeGreaterThan(parent.version);
    expect((await t.owner.query("SELECT count(*)::int AS n FROM activities WHERE issue_id=ANY($1::uuid[]) AND field='sprintId'",[[parent.id,child.id,doneChild.id]])).rows[0].n).toBe(3);
    expect(events.filter((event)=>event.projectId===f.project.id&&event.type==='sprint.completed')).toHaveLength(1);
    const backlog = (await team.lead.get(`${f.base}/backlog`)).body; expect(backlog.sprints.map((sprint:{id:string})=>sprint.id)).toEqual([next.id]); expect(backlog.sprints[0].issues[0].subtasks).toHaveLength(2);
    expect((await team.lead.post(`${f.base}/sprints/${next.id}/start`)).status).toBe(200);
    expect((await team.lead.post(`${f.base}/sprints/${first.id}/complete`,{moveIncompleteTo:'backlog'})).status).toBe(409);
    expect((await team.lead.patch(`${f.base}/sprints/${first.id}`,{goal:'เปลี่ยนหลังจบ'})).status).toBe(409);
  });

  it('ย้ายงานค้างกลับ Backlog พร้อมลูก โดยใช้ move เดิมสำหรับการนำงานเข้า Sprint', async () => {
    const f = await fixture(); const sprint = await f.sprint(); const parent = await f.issue(); const child = await f.issue({parentKey:parent.key});
    const move = await team.dev.post(`${team.ws}/issues/${parent.key}/move`,{sprintId:sprint.id}); expect(move.status).toBe(200);
    expect((await team.lead.get(`${team.ws}/issues/${child.key}`)).body.sprintId).toBe(sprint.id);
    await team.lead.post(`${f.base}/sprints/${sprint.id}/start`);
    const completed = await team.lead.post(`${f.base}/sprints/${sprint.id}/complete`,{moveIncompleteTo:'backlog'}); expect(completed.status,JSON.stringify(completed.body)).toBe(200);
    const backlog = (await team.lead.get(`${f.base}/backlog`)).body.backlog; expect(backlog.issues).toHaveLength(1); expect(backlog.issues[0]).toMatchObject({key:parent.key,sprintId:null,subtasks:[{key:child.key,sprintId:null}]});
  });

  it('ปลายทางต้องอยู่โปรเจกต์เดียวกันและยังไม่จบ; ปฏิเสธแล้วไม่เปลี่ยน Sprint/งาน/ส่ง Event', async () => {
    const f = await fixture(); const other = await fixture(); const sprint = await f.sprint(); const outside = await other.sprint(); const task = await f.issue({sprintId:sprint.id});
    expect((await team.lead.post(`${f.base}/sprints/${sprint.id}/complete`,{moveIncompleteTo:'backlog'})).status).toBe(409);
    await team.lead.post(`${f.base}/sprints/${sprint.id}/start`);
    const before = events.length;
    expect((await team.lead.post(`${f.base}/sprints/${sprint.id}/complete`,{moveIncompleteTo:sprint.id})).status).toBe(422);
    expect((await team.lead.post(`${f.base}/sprints/${sprint.id}/complete`,{moveIncompleteTo:outside.id})).status).toBe(404);
    expect(events).toHaveLength(before); expect((await team.lead.get(`${team.ws}/issues/${task.key}`)).body.sprintId).toBe(sprint.id);
    await t.owner.query("UPDATE sprints SET status='completed' WHERE id=$1",[outside.id]);
    expect((await team.lead.post(`${other.base}/sprints/${outside.id}/start`)).status).toBe(409);
  });

  it('completed ปลายทางใช้ไม่ได้ และปิด Sprint ว่างได้',async()=>{
    const f=await fixture(); const old=await f.sprint(); const current=await f.sprint();
    await team.lead.post(`${f.base}/sprints/${old.id}/start`); expect((await team.lead.post(`${f.base}/sprints/${old.id}/complete`,{moveIncompleteTo:'backlog'})).status).toBe(200);
    await team.lead.post(`${f.base}/sprints/${current.id}/start`);expect((await team.lead.post(`${f.base}/sprints/${current.id}/complete`,{moveIncompleteTo:old.id})).status).toBe(422);
  });
});

describe('Backlog, capacity and daily burndown',()=>{
  it('เรียง rank และไม่นับ MD ซ้ำแม่/ลูก, ไม่นับงานที่ลบ',async()=>{
    const f=await fixture(); const first=await f.issue({title:'แรก',size:'XS'}); const second=await f.issue({title:'สอง',size:'M'}); await f.issue({parentKey:second.key,size:'S'}); await f.issue({parentKey:second.key,size:'XS'});const deleted=await f.issue({size:'XL'});await team.lead.delete(`${team.ws}/issues/${deleted.key}`);
    expect((await team.lead.post(`${team.ws}/issues/${second.key}/move`,{beforeKey:first.key})).status).toBe(200);
    const response=await team.lead.get(`${f.base}/backlog`);expect(response.status).toBe(200);expect(response.body.backlog.issues.map((issue:{key:string})=>issue.key)).toEqual([second.key,first.key]);expect(response.body.backlog.stats).toMatchObject({totalMd:5,issueCount:3});
  });

  it('capacity ใช้ชั่วโมงโปรเจกต์/Workspace, หักวันหยุดและ approved leave, แบ่ง MD ระหว่าง Dev',async()=>{
    const f=await fixture();const sprint=await f.sprint();
    await t.owner.query('UPDATE project_members SET capacity_hours_week=CASE WHEN user_id=$1 THEN 20 ELSE 40 END WHERE project_id=$2',[team.leadId,f.project.id]);
    await t.owner.query('INSERT INTO project_holidays (workspace_id,project_id,date,name) VALUES ($1,$2,$3,$4)',[f.project.workspaceId,f.project.id,'2026-12-04','หยุดทีม']);
    await t.owner.query("INSERT INTO leaves (workspace_id,user_id,leave_type,start_date,end_date,half_day,status) VALUES ($1,$2,'vacation','2026-12-01','2026-12-01','pm','approved'),($1,$2,'vacation','2026-12-02','2026-12-02',null,'approved'),($1,$2,'vacation','2026-12-03','2026-12-03',null,'pending'),($1,$2,'vacation','2026-12-07','2026-12-07',null,'approved')",[f.project.workspaceId,team.devId]);
    await f.issue({sprintId:sprint.id,estimateMd:8,assigneeIds:[team.leadId,team.devId]});await f.issue({sprintId:sprint.id,estimateMd:4});
    const cap=(await team.lead.get(`${f.base}/backlog`)).body.sprints[0].capacity;
    expect(cap).toMatchObject({workingDays:7,capacityMd:9,committedMd:12,unassignedMd:4,overloaded:true});
    expect(cap.people.find((person:{person:{id:string}})=>person.person.id===team.leadId)).toMatchObject({capacityMd:3.5,committedMd:4,leaveDays:0,overloaded:true});
    expect(cap.people.find((person:{person:{id:string}})=>person.person.id===team.devId)).toMatchObject({capacityMd:5.5,committedMd:4,leaveDays:1.5,overloaded:false});
  });

  it('ไม่นับ capacity ของสมาชิก deactivated และรายงาน MD ที่มอบหมายให้คนที่ไม่มี capacity',async()=>{
    const f=await fixture();const sprint=await f.sprint();await f.issue({sprintId:sprint.id,assigneeIds:[team.devId],estimateMd:2});
    await t.owner.query("UPDATE workspace_members SET status='deactivated' WHERE user_id=$1",[team.devId]);
    try {const cap=(await team.lead.get(`${f.base}/backlog`)).body.sprints[0].capacity;expect(cap.people).toHaveLength(1);expect(cap.unavailableAssigneeMd).toBe(2);} finally {await t.owner.query("UPDATE workspace_members SET status='active' WHERE user_id=$1",[team.devId]);}
  });

  it('GET upsert snapshot ของวันนี้, คงประวัติ, เส้นอุดมคติไม่ลดวันหยุด และไม่รวมแม่กับลูกซ้ำ',async()=>{
    const f=await fixture();const sprint=await f.sprint();const parent=await f.issue({sprintId:sprint.id});const one=await f.issue({parentKey:parent.key,size:'S'});await f.issue({parentKey:parent.key,size:'XS'});
    await team.lead.post(`${f.base}/sprints/${sprint.id}/start`);
    const yesterday = new Date(`${today()}T00:00:00Z`);yesterday.setUTCDate(yesterday.getUTCDate()-1);const previous=yesterday.toISOString().slice(0,10);
    await t.owner.query('INSERT INTO sprint_daily_snapshots (workspace_id,sprint_id,date,remaining_md,done_md,issue_count,done_count) VALUES ($1,$2,$3,4,0,2,0)',[f.project.workspaceId,sprint.id,previous]);
    const done=f.project.statuses.find((status:{name:string;boardColumnId:string|null})=>status.name==='Done'&&!status.boardColumnId).id;
    expect((await team.lead.post(`${team.ws}/issues/${one.key}/move`,{statusId:done})).status).toBe(200);
    const response=await team.lead.get(`${f.base}/backlog`);expect(response.status,JSON.stringify(response.body)).toBe(200);const burn=response.body.sprints[0].burndown;
    expect(burn.actual).toEqual(expect.arrayContaining([{date:today(),remainingMd:1,doneMd:3,issueCount:2,doneCount:1},{date:previous,remainingMd:4,doneMd:0,issueCount:2,doneCount:0}]));expect(burn.baselineMd).toBe(4);
    const day=(date:string)=>burn.ideal.find((point:{date:string})=>point.date===date).remainingMd;
    expect(burn.ideal[0].remainingMd).toBe(4);expect(burn.ideal.at(-1).remainingMd).toBe(0);expect(day('2026-12-07')).toBe(day('2026-12-06'));expect(day('2026-12-10')).toBe(day('2026-12-09'));
    await team.lead.get(`${f.base}/backlog`);expect((await t.owner.query('SELECT count(*)::int AS n FROM sprint_daily_snapshots WHERE sprint_id=$1 AND date=$2',[sprint.id,today()])).rows[0].n).toBe(1);
  });

  it('snapshotAll และ Jobs ใช้ snapshot เดิมซ้ำได้ และข้ามโปรเจกต์ archived',async()=>{
    const f=await fixture();const sprint=await f.sprint();await f.issue({sprintId:sprint.id});await team.lead.post(`${f.base}/sprints/${sprint.id}/start`);
    const service=t.app.get(SprintsService);expect((await service.snapshotAll()).snapshots).toBeGreaterThan(0);
    const jobs=t.app.get(Jobs);expect(jobs.scheduled.get('sprints.snapshot')).toBe('55 23 * * *');await jobs.enqueue('sprints.snapshot',{});expect((await t.owner.query('SELECT count(*)::int AS n FROM sprint_daily_snapshots WHERE sprint_id=$1 AND date=$2',[sprint.id,today()])).rows[0].n).toBe(1);
    await t.owner.query('DELETE FROM sprint_daily_snapshots WHERE sprint_id=$1',[sprint.id]);await t.owner.query("UPDATE projects SET archived_at=now(),status='archived' WHERE id=$1",[f.project.id]);await service.snapshotAll();expect((await t.owner.query('SELECT count(*)::int AS n FROM sprint_daily_snapshots WHERE sprint_id=$1',[sprint.id])).rows[0].n).toBe(0);
  });

  it('snapshotAll ยังทำงานผ่าน RLS เมื่อ Project Owner ถูกพักใช้งาน แต่ยังมีสมาชิก active',async()=>{
    const f=await fixture();const sprint=await f.sprint();await f.issue({sprintId:sprint.id});await team.lead.post(`${f.base}/sprints/${sprint.id}/start`);await t.owner.query('DELETE FROM sprint_daily_snapshots WHERE sprint_id=$1',[sprint.id]);
    await t.owner.query("UPDATE workspace_members SET status='deactivated' WHERE user_id=$1",[team.leadId]);
    try {await t.app.get(SprintsService).snapshotAll();expect((await t.owner.query('SELECT count(*)::int AS n FROM sprint_daily_snapshots WHERE sprint_id=$1',[sprint.id])).rows[0].n).toBe(1);} finally {await t.owner.query("UPDATE workspace_members SET status='active' WHERE user_id=$1",[team.leadId]);}
  });
});

describe('Permissions, input validation and tenant boundaries',()=>{
  it('Member/Viewer ไม่มี sprint.manage; Viewer อ่านได้; Guest Viewer อ่าน Backlog ไม่ได้',async()=>{
    const base=`${team.ws}/projects/DP`;const sprint=(await team.lead.post(`${base}/sprints`,{name:'สิทธิ์',startDate:'2026-12-01',endDate:'2026-12-11'})).body;
    for(const caller of [team.dev,viewer,guest]) {
      expect((await caller.post(`${base}/sprints`,{name:'ห้ามสร้าง',startDate:'2026-12-01',endDate:'2026-12-11'})).status).toBe(403);
      expect((await caller.patch(`${base}/sprints/${sprint.id}`,{name:'ห้ามแก้'})).status).toBe(403);
      expect((await caller.post(`${base}/sprints/${sprint.id}/start`)).status).toBe(403);
      expect((await caller.post(`${base}/sprints/${sprint.id}/complete`,{moveIncompleteTo:'backlog'})).status).toBe(403);
    }
    const view=await viewer.get(`${base}/backlog`);expect(view.status).toBe(200);expect(view.body.permissions).toEqual({canManageSprints:false,canMoveIssues:false});expect((await guest.get(`${base}/backlog`)).status).toBe(403);
  });

  it('ตรวจ input รวม PATCH ที่แก้วันที่ด้านเดียว; ไม่ให้ตั้ง status ตรง ๆ',async()=>{
    const f=await fixture();const sprint=await f.sprint();
    for(const body of [{name:'',startDate:'2026-12-01',endDate:'2026-12-02'},{name:'x',startDate:'2026-02-30',endDate:'2026-12-01'},{name:'x',startDate:'2026-12-02',endDate:'2026-12-01'},{name:'x',startDate:'2026-01-01',endDate:'2027-01-02'}]) expect((await team.lead.post(`${f.base}/sprints`,body)).status).toBe(400);
    for(const body of [{},{status:'active'},{endDate:'2026-11-01'},{startDate:'2027-12-01'}]) expect((await team.lead.patch(`${f.base}/sprints/${sprint.id}`,body)).status).toBe(400);
    expect((await team.lead.post(`${f.base}/sprints/${sprint.id}/complete`,{})).status).toBe(400);expect((await team.lead.post(`${f.base}/sprints/not-a-uuid/start`)).status).toBe(400);
    expect((await team.lead.post(`${f.base}/sprints/${randomUUID()}/start`)).status).toBe(404);
  });

  it('รองรับ action path แบบ :start/:complete ของเอกสารเดิม',async()=>{
    const f=await fixture();const sprint=await f.sprint();expect((await team.lead.post(`${f.base}/sprints/${sprint.id}:start`)).status).toBe(200);expect((await team.lead.post(`${f.base}/sprints/${sprint.id}:complete`,{moveIncompleteTo:'backlog'})).status).toBe(200);
  });

  it('UUID จากอีก Workspace ไม่เข้าถึงได้ และไม่ย้ายงานข้าม tenant',async()=>{
    const f=await fixture();const sprint=await f.sprint();const other=await client(t.app);await signup(other,'outside@sprints.example.com','Outside');expect((await other.post('/workspaces',{name:'อื่น',slug:'sprints-other'})).status).toBe(201);expect((await other.post('/w/sprints-other/projects',{key:'DP',name:'Other',startDate:'2026-11-05',goliveDate:'2027-04-21'})).status).toBe(201);
    expect((await other.get(`${f.base}/backlog`)).status).toBe(404);expect((await other.post(`/w/sprints-other/projects/DP/sprints/${sprint.id}/start`)).status).toBe(404);expect((await other.patch(`/w/sprints-other/projects/DP/sprints/${sprint.id}`,{name:'ข้าม Workspace'})).status).toBe(404);
  });

  it('โปรเจกต์ Archived อ่านได้แต่เขียน Sprint ไม่ได้',async()=>{
    const f=await fixture();const sprint=await f.sprint();await t.owner.query("UPDATE projects SET status='archived',archived_at=now() WHERE id=$1",[f.project.id]);expect((await team.lead.get(`${f.base}/backlog`)).status).toBe(200);expect((await team.lead.post(`${f.base}/sprints/${sprint.id}/start`)).status).toBe(403);expect((await team.lead.patch(`${f.base}/sprints/${sprint.id}`,{goal:'แก้'})).status).toBe(403);
  });
});
