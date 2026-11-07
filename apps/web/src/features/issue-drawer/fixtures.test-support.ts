import { http, HttpResponse } from 'msw';
import type { Issue, ProjectMeta, FormOptions, Feed, ChecklistItem, Dependencies, DueImpact } from './types';
import type { Permissions } from '@/lib/types';
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const me = { id: uid(1), displayName: 'ผู้ทดสอบหนึ่ง', initials: 'ท1', avatarUrl: null };
export const dev = { id: uid(2), displayName: 'ผู้ทดสอบสอง', initials: 'ท2', avatarUrl: null };
export const statuses = ['To do','In progress','Review','Done'].map((name, index) => ({ id: uid(100+index), name, category: (index === 0 ? 'todo' : index === 3 ? 'done' : 'in_progress') as Issue['status']['category'], workflowId: uid(90) }));
export const bugStatuses = ['Open','In progress','Fixed','Verified','Closed'].map((name, index) => ({ id: uid(110+index), name, category: (index === 0 ? 'todo' : index === 4 ? 'done' : 'in_progress') as Issue['status']['category'], workflowId: uid(91) }));
export const project: ProjectMeta = { id: uid(9), key: 'DE', name: 'แผนตัวอย่าง', status: 'active', modules: [{ id: uid(10), name: 'ระบบตัวอย่าง' }], phases: [{ id: uid(11), name: 'กลุ่มงานตัวอย่าง', moduleId: uid(10) }], sprints: [{ id: uid(12), name: 'Sprint ตัวอย่าง', status: 'active' }], statuses: [...statuses,...bugStatuses], issueTypes: [
  { id: uid(20), name: 'Task', workflowId: uid(90), requiredFields: ['title','module'] },
  { id: uid(21), name: 'Bug', workflowId: uid(91), requiredFields: ['title','severity','environment','steps'] },
  { id: uid(22), name: 'Story', workflowId: uid(90), requiredFields: ['title','user_story','acceptance_criteria','size'] },
  { id: uid(23), name: 'Spike', workflowId: uid(90), requiredFields: ['title','question','timebox'] },
] };
export const formOptions: FormOptions = { modules: project.modules, phases: project.phases, sprints: project.sprints, members: [me,dev], sizeMdMap: { XS:1, S:3, M:5, L:8, XL:12 }, labels: [{ id: uid(80), name: 'backend', color: '#0369a1' }, { id: uid(81), name: 'ตรวจซ้ำ', color: null }], requirements: [{ code: 'FR-02.3', kind: 'FR', title: null }], screens: [{ code: 'SCR-203', name: null }], issueTypes: project.issueTypes.map((type) => ({ ...type, statuses: project.statuses.filter((status) => status.workflowId === type.workflowId) })) };
export const fullAccess: Permissions = { role: 'admin', guestViewer: false, permissions: ['project.view','issue.create','issue.edit','issue.comment','issue.delete','issue.change_due_directly','issue.record_test'] };
export function makeIssue(key = 'DE-1', change: Partial<Issue> = {}): Issue {
  return { id: uid(200+Number(key.split('-')[1])), key, projectKey: 'DE', type: 'Task', parentKey: null, title: `งานตัวอย่าง ${key}`, description: '**รายละเอียด** ของงานตัวอย่าง', status: statuses[1], priority: 'medium', moduleId: uid(10), phaseId: uid(11), sprintId: uid(12), assigneeIds: [me.id], baId: null, reviewerId: dev.id, testerId: null, reporterId: me.id, size: 'M', estimateMd: 5, progressPct: 20, planStart: '2026-11-06', planEnd: '2026-11-09', actualStart: '2026-11-06', actualEnd: null, severity: null, environment: null, details: {}, reopenCount: 0, sharedWithGuests: true, version: 3, createdAt: '2026-11-06T01:00:00Z', updatedAt: '2026-11-06T02:00:00Z', pendingDueRequest: null, ...change };
}
export const failure = (status: number, code: string, details: object = {}) => HttpResponse.json({ error: { code, message: 'ข้อความผิดพลาดตัวอย่าง', details, requestId: 'req_drawer_test' } }, { status });
export interface Mutation { method: string; path: string; body: Record<string, unknown>; etag: string | null }
export function fixture() {
  const state = {
    access: structuredClone(fullAccess), issues: new Map<string,Issue>(), mutations: [] as Mutation[], reads: [] as string[],
    checklist: [{ id: uid(50), text: 'ตรวจสอบข้อมูล', kind: 'checklist', done: false, doneBy: null, doneAt: null }, { id: uid(51), text: 'ยืนยันผลลัพธ์', kind: 'acceptance', done: true, doneBy: me.id, doneAt: '2026-11-06T03:00:00Z' }] as ChecklistItem[],
    dependencies: { blockedBy: [{ id: uid(209), key: 'DE-9', title: 'งานที่ต้องรอ', status: statuses[1], type: 'FS', lagDays: 0, planStart: '2026-11-01', planEnd: '2026-11-05' }], blocking: [] } as Dependencies,
    feed: { items: [{ id: uid(60), kind: 'activity', actor: me, verb: 'created', field: null, old: null, new: null, createdAt: '2026-11-06T02:00:00Z' }], nextCursor: null } as Feed,
    watching: false, deleted: new Set<string>(), next: 20,
  };
  state.issues.set('DE-1', makeIssue());
  state.issues.set('DE-2', makeIssue('DE-2', { parentKey: 'DE-1', title: 'งานย่อยหนึ่ง' }));
  state.issues.set('DE-3', makeIssue('DE-3', { parentKey: 'DE-1', title: 'งานย่อยสอง' }));
  state.issues.set('DE-4', makeIssue('DE-4', { type: 'Bug', status: bugStatuses[4], title: 'Bug ตัวอย่าง', severity: 'major', environment: 'sit', details: { steps: 'เปิดหน้าตัวอย่าง', expected: 'แสดงผล', actual: 'ไม่แสดงผล' } }));
  state.issues.set('DE-9', makeIssue('DE-9'));
  const impact: DueImpact = { currentDue: '2026-11-09', requestedDue: '2026-11-13', addedWorkingDays: 4, workload: [{ person: me, otherWorkMd: 8, capacityMd: 5, overloaded: true, overlapping: [{ key: 'DE-9', title: 'งานตัวอย่างที่ชนกัน' }] }], dependents: [{ key:'DE-9',title:'งานที่รออยู่',affected:true }], milestones: [{ id:uid(70),name:'ส่งมอบตัวอย่าง',date:'2026-11-12',onTime:false }], goLive: { date:'2027-04-21',onTime:true }, parent:null, approvers:[dev], warnings:[] };
  async function mutation(request: Request): Promise<Mutation> {
    const value = { method: request.method, path: new URL(request.url).pathname, body: await request.json().catch(() => ({})), etag: request.headers.get('if-match') };
    state.mutations.push(value); return value;
  }
  function detail(key: string) {
    const issue = state.issues.get(key);
    if (!issue) return failure(404,'not_found');
    if (state.deleted.has(key)) return failure(410,'gone',{ deletedBy: me, deletedAt:'2026-11-06T04:00:00Z',restorableUntil:'2099-12-31T00:00:00Z' });
    return HttpResponse.json({ ...issue, ...(state.access.guestViewer ? { assigneeIds: undefined, baId:undefined,reviewerId:undefined,testerId:undefined,reporterId:undefined } : {}), subtasks: [...state.issues.values()].filter((item) => item.parentKey === key && !state.deleted.has(item.key)) }, { headers: { etag: `"${issue.version}"` } });
  }
  const base = '*/api/v1/w/:ws';
  const handlers = [
    http.get(`${base}/issues/:key/git`, () => HttpResponse.json({ commits: [], pullRequests: [] })),
    http.get(`${base}/projects/:project/files`, () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get(`${base}/issues/:key/test-runs`, () => HttpResponse.json({ items: [], latest: null })),
    http.get(`${base}/projects/:project/my-permissions`, () => HttpResponse.json(state.access)),
    http.get(`${base}/projects/:project`, () => HttpResponse.json(project)),
    http.get(`${base}/projects/:project/members`, ({ request }) => { state.reads.push(new URL(request.url).pathname); return HttpResponse.json({ items:[{...me,userId:me.id},{...dev,userId:dev.id}] }); }),
    http.get(`${base}/projects/:project/form-options`, () => HttpResponse.json(formOptions)),
    http.get(`${base}/projects/:project/labels`, () => HttpResponse.json({ items: formOptions.labels })),
    http.get(`${base}/projects/:project/modules/:module/phases`, () => HttpResponse.json({items:project.phases})),
    http.get(`${base}/projects/:project/issues`, () => HttpResponse.json({items:[...state.issues.values()].filter((issue) => !issue.parentKey)})),
    http.post(`${base}/projects/:project/issues`, async ({ request }) => { const m=await mutation(request); const key=`DE-${state.next++}`; const type = String(m.body.type ?? 'Task') as Issue['type']; const issue=makeIssue(key,{...m.body,type,status:type==='Bug'?bugStatuses[0]:statuses[0],version:1,parentKey:m.body.parentKey as string ?? null} as Partial<Issue>); state.issues.set(key,issue); return HttpResponse.json(issue,{status:201}); }),
    http.get(`${base}/issues/:key`, ({ request, params }) => { state.reads.push(new URL(request.url).pathname); return detail(String(params.key)); }),
    http.patch(`${base}/issues/:key`, async ({request,params}) => { const m=await mutation(request); const issue=state.issues.get(String(params.key))!; if(m.etag!==`"${issue.version}"`)return failure(409,'conflict',{latest:issue}); const {labelIds,...rest}=m.body as {labelIds?:string[]}; Object.assign(issue,rest,{version:issue.version+1}); if(labelIds)issue.labels=formOptions.labels.filter((label)=>labelIds.includes(label.id));return HttpResponse.json(issue); }),
    http.put(`${base}/issues/:key/assignees`, async ({request,params}) => { const m=await mutation(request); const issue=state.issues.get(String(params.key))!; if(m.etag!==`"${issue.version}"`)return failure(409,'conflict',{latest:issue});Object.assign(issue,m.body,{version:issue.version+1});return HttpResponse.json(issue); }),
    http.post(`${base}/issues/:key/move`, async ({request,params}) => { const m=await mutation(request);const issue=state.issues.get(String(params.key))!;issue.status=project.statuses.find((status)=>status.id===m.body.statusId)!;issue.version++;return HttpResponse.json({...issue,warnings:[]}); }),
    http.get(`${base}/issues/:key/watchers`, () => HttpResponse.json({items:state.watching?[{person:me}]:[],watching:state.watching})),
    http.post(`${base}/issues/:key/watch`, async ({request}) => {await mutation(request);state.watching=true;return HttpResponse.json({watching:true});}),
    http.delete(`${base}/issues/:key/watch`, async ({request}) => {await mutation(request);state.watching=false;return HttpResponse.json({watching:false});}),
    http.get(`${base}/issues/:key/activity`, () => HttpResponse.json(state.feed)),
    http.post(`${base}/issues/:key/comments`, async ({request}) => {const m=await mutation(request);state.watching=true;const comment={id:uid(61+state.mutations.length),kind:'comment' as const,body:String(m.body.body),author:me,createdAt:'2026-11-06T04:00:00Z',editedAt:null,deletedAt:null,deletionReason:null,canEdit:true,canDelete:true};state.feed.items.push(comment);return HttpResponse.json(comment,{status:201});}),
    http.patch(`${base}/issues/:key/comments/:id`, async ({request,params}) => {const m=await mutation(request);const comment=state.feed.items.find((item)=>item.id===params.id)!;Object.assign(comment,m.body,{editedAt:'2026-11-06T04:05:00Z'});return HttpResponse.json(comment);}),
    http.delete(`${base}/issues/:key/comments/:id`, async ({request,params}) => {await mutation(request);const comment=state.feed.items.find((item)=>item.id===params.id)!;Object.assign(comment,{body:null,deletedAt:'2026-11-06T04:06:00Z',deletionReason:'author',canEdit:false,canDelete:false});return HttpResponse.json(comment);}),
    http.get(`${base}/issues/:key/checklist`, () => HttpResponse.json({items:state.checklist})),
    http.post(`${base}/issues/:key/checklist/reorder`, async ({request}) => {const m=await mutation(request);state.checklist=(m.body.ids as string[]).map((id)=>state.checklist.find((item)=>item.id===id)!);return HttpResponse.json({items:state.checklist});}),
    http.post(`${base}/issues/:key/checklist`, async ({request}) => {const m=await mutation(request);const item={id:uid(500+state.mutations.length),text:String(m.body.text),kind:m.body.kind as ChecklistItem['kind'],done:false,doneBy:null,doneAt:null};state.checklist.push(item);return HttpResponse.json(item,{status:201});}),
    http.patch(`${base}/issues/:key/checklist/:id`, async ({request,params}) => {const m=await mutation(request);const item=state.checklist.find((item)=>item.id===params.id)!;Object.assign(item,m.body,m.body.done?{doneBy:me.id,doneAt:'2026-11-06T04:00:00Z'}:{});return HttpResponse.json(item);}),
    http.delete(`${base}/issues/:key/checklist/:id`, async ({request,params}) => {await mutation(request);state.checklist=state.checklist.filter((item)=>item.id!==params.id);return new HttpResponse(null,{status:204});}),
    http.get(`${base}/issues/:key/dependencies`, () => HttpResponse.json(state.dependencies)),
    http.post(`${base}/issues/:key/dependencies`, async ({request}) => {await mutation(request);return HttpResponse.json(state.dependencies);}),
    http.delete(`${base}/issues/:key/dependencies`, async ({request}) => {const m=await mutation(request);if(m.body.predecessorKey)state.dependencies.blockedBy=state.dependencies.blockedBy.filter((item)=>item.key!==m.body.predecessorKey);return HttpResponse.json(state.dependencies);}),
    http.get(`${base}/issues/:key/due-requests/preview`, ({request}) => HttpResponse.json({...impact,requestedDue:new URL(request.url).searchParams.get('due')})),
    http.post(`${base}/issues/:key/due-requests`, async ({request,params}) => {const m=await mutation(request);const issue=state.issues.get(String(params.key))!;issue.pendingDueRequest={id:uid(80),requesterId:me.id,requestedDue:String(m.body.requestedDue),currentDue:issue.planEnd!,createdAt:'2026-11-06T04:00:00Z'};return HttpResponse.json({...issue.pendingDueRequest,status:'pending'},{status:201});}),
    http.post(`${base}/due-requests/:id/cancel`, async ({request}) => {await mutation(request);state.issues.get('DE-1')!.pendingDueRequest=null;return HttpResponse.json({status:'cancelled'});}),
    http.get(`${base}/issues/:key/delete-impact`, () => HttpResponse.json({counts:{subtasks:2,files:1,dependencies:1}})),
    http.delete(`${base}/issues/:key`, async ({request,params}) => {await mutation(request);state.deleted.add(String(params.key));return HttpResponse.json({key:params.key});}),
    http.post(`${base}/issues/:key/restore`, async ({request,params}) => {await mutation(request);state.deleted.delete(String(params.key));return detail(String(params.key));}),
    http.post(`${base}/issues/:key/reopen`, async ({request,params}) => {await mutation(request);const issue=state.issues.get(String(params.key))!;issue.status=bugStatuses[0];issue.version++;issue.reopenCount++;return HttpResponse.json(issue);}),
  ];
  return {state,handlers,impact};
}
