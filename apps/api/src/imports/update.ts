import { schema, type Tx } from '@friday/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import type { DomainEvent } from '../core/events.js';
import { type CustomFieldDef, displayValue, readCustomValues, writeCustomValues } from '../issues/custom-values.js';
import { parseCustomCell } from './custom.js';
import { insertRows } from './insert.js';
import { type Field, personKey, type PlanCheck, type PlanRow } from './plan.js';

const s = schema;

/** ฟิลด์ที่เทียบตอนอัปเดตแผน (Screen / FR ไม่เทียบ: แก้ในระบบได้เองหลังนำเข้า) · เทียบเฉพาะฟิลด์ที่มีคอลัมน์ในไฟล์ */
const LABELS = {
  title: 'ชื่องาน',
  parent: 'Task แม่',
  module: 'Module',
  group: 'กลุ่ม',
  status: 'Status',
  priority: 'Priority',
  size: 'Size',
  estimateMd: 'Man-Day',
  planStart: 'Plan Start',
  planEnd: 'Plan End',
  actualStart: 'Actual Start',
  actualEnd: 'Actual End',
  ba: 'Business Analyst',
  sa: 'System Analyst',
  devs: 'Developer',
  reviewer: 'QA / Reviewer',
  labels: 'Label',
  description: 'Description',
  remark: 'Remark',
} as const;
type DiffField = keyof typeof LABELS;
/** ฟิลด์ใน diff → คอลัมน์ในไฟล์ที่ต้องมีจึงจะเทียบ */
const COLUMN: Record<DiffField, Field> = {
  title: 'title',
  parent: 'parentKey',
  module: 'module',
  group: 'group',
  status: 'status',
  priority: 'priority',
  size: 'size',
  estimateMd: 'estimateMd',
  planStart: 'planStart',
  planEnd: 'planEnd',
  actualStart: 'actualStart',
  actualEnd: 'actualEnd',
  ba: 'ba',
  sa: 'sa',
  devs: 'devs',
  reviewer: 'reviewer',
  labels: 'labels',
  description: 'description',
  remark: 'remark',
};
/** ชื่อฟิลด์ใน activities / plan_changes */
const ACTIVITY_FIELD: Partial<Record<DiffField, string>> = { group: 'phaseId', devs: 'assigneeIds', ba: 'baId', sa: 'saId', reviewer: 'reviewerId', parent: 'parentKey', labels: 'labelIds' };
const PLAN_FIELDS = new Set<DiffField>(['planStart', 'planEnd', 'estimateMd', 'devs']);

export interface FieldChange {
  /** ฟิลด์มาตรฐาน หรือ `cf:<id>` (Custom field) */
  field: DiffField | `cf:${string}`;
  label: string;
  old: unknown;
  new: unknown;
}
export interface UpdateDiff {
  added: { no: number; number: number | null; title: string; module: string }[];
  changed: { no: number; key: string; title: string; fields: FieldChange[] }[];
  /** อยู่ในระบบแต่ไม่อยู่ในไฟล์ · ไม่ลบเอง ให้ผู้ใช้เลือก · no = No. (ไฟล์รูปแบบเดิม) หรือเลขงาน (รูปแบบใหม่) */
  missing: { no: number; key: string; title: string; status: string }[];
  unchanged: number;
}

type Issue = typeof s.issues.$inferSelect;

interface Existing {
  rows: Issue[];
  moduleName: Map<string, string>;
  moduleId: Map<string, string>;
  phases: { id: string; moduleId: string; name: string }[];
  statusName: Map<string, string>;
  statusId: Map<string, string>;
  assignees: Map<string, string[]>;
  labels: Map<string, string[]>;
  labelName: Map<string, string>;
  userName: Map<string, string>;
  taskTypeId: string;
}

async function loadExisting(tx: Tx, projectId: string): Promise<Existing> {
  // รวมงานที่ลบแล้ว: excel_row_no / เลขงาน ซ้ำกันไม่ได้ (unique) จึงต้องรู้ว่าเลขไหนถูกใช้
  const rows = await tx.select().from(s.issues).where(eq(s.issues.projectId, projectId));
  const mods = await tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, projectId));
  const phases = await tx.select({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, projectId));
  const [taskType] = await tx.select().from(s.issueTypes).where(and(eq(s.issueTypes.projectId, projectId), eq(s.issueTypes.name, 'Task')));
  const sts = await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses).where(eq(s.workflowStatuses.workflowId, taskType.workflowId));
  const usedStatus = [...new Set(rows.map((r) => r.statusId))];
  const allStatus = usedStatus.length ? await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses).where(inArray(s.workflowStatuses.id, usedStatus)) : [];
  const liveIds = rows.filter((r) => !r.deletedAt).map((r) => r.id);
  const asg = liveIds.length
    ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId, sort: s.issueAssignees.sort }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, liveIds)).orderBy(s.issueAssignees.sort)
    : [];
  const lbl = liveIds.length ? await tx.select({ issueId: s.issueLabels.issueId, labelId: s.issueLabels.labelId }).from(s.issueLabels).where(inArray(s.issueLabels.issueId, liveIds)) : [];
  const lblNames = await tx.select({ id: s.labels.id, name: s.labels.name }).from(s.labels).where(eq(s.labels.projectId, projectId));
  const group = (list: { issueId: string; v: string }[]) => {
    const out = new Map<string, string[]>();
    for (const a of list) out.set(a.issueId, [...(out.get(a.issueId) ?? []), a.v]);
    return out;
  };
  const userIds = [...new Set([...asg.map((a) => a.userId), ...rows.flatMap((r) => [r.baId, r.saId, r.reviewerId]).filter((x): x is string => !!x)])];
  const users = userIds.length ? await tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users).where(inArray(s.users.id, userIds)) : [];
  return {
    rows,
    moduleName: new Map(mods.map((m) => [m.id, m.name])),
    moduleId: new Map(mods.map((m) => [m.name, m.id])),
    phases,
    statusName: new Map([...sts, ...allStatus].map((x) => [x.id, x.name])),
    statusId: new Map(sts.map((x) => [x.name, x.id])),
    assignees: group(asg.map((a) => ({ issueId: a.issueId, v: a.userId }))),
    labels: group(lbl.map((a) => ({ issueId: a.issueId, v: a.labelId }))),
    labelName: new Map(lblNames.map((l) => [l.id, l.name])),
    userName: new Map(users.map((u) => [u.id, u.name])),
    taskTypeId: taskType.id,
  };
}

/** Task ระดับบนในระบบ (เลขงาน → Module) ให้ Sub-task ในไฟล์อ้างถึง Task แม่ที่ไม่ได้อยู่ในไฟล์ได้ */
export async function parentTasks(tx: Tx, projectId: string): Promise<Map<number, { module: string }>> {
  const rows = await tx
    .select({ number: s.issues.number, module: s.modules.name })
    .from(s.issues)
    .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
    .leftJoin(s.modules, eq(s.modules.id, s.issues.moduleId))
    .where(and(eq(s.issues.projectId, projectId), isNull(s.issues.deletedAt), isNull(s.issues.parentId), eq(s.issueTypes.name, 'Task')));
  return new Map(rows.map((r) => [r.number, { module: r.module ?? '' }]));
}

/** สถานะใน Workflow ของโปรเจกต์ (ใช้ให้ checkPlan จับชื่อสถานะที่ตั้งเอง) */
export async function statusNames(tx: Tx, projectId: string): Promise<string[]> {
  const [taskType] = await tx.select().from(s.issueTypes).where(and(eq(s.issueTypes.projectId, projectId), eq(s.issueTypes.name, 'Task')));
  if (!taskType) return [];
  return (await tx.select({ name: s.workflowStatuses.name }).from(s.workflowStatuses).where(eq(s.workflowStatuses.workflowId, taskType.workflowId))).map((x) => x.name);
}

const eq0 = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const names = (list: string[]) => [...new Set(list.map(personKey))].sort();

export interface UpdatePlan {
  diff: UpdateDiff;
  /** รายการที่ต้องเขียนจริง */
  edits: { issue: Issue; row: PlanRow; fields: FieldChange[]; custom: Record<string, unknown> }[];
  adds: PlanRow[];
  /** ค่า Custom field ที่ตรวจแล้วของงานใหม่ (คนเป็นชื่อ แปลงตอนเขียน) */
  addCustom: Map<PlanRow, Record<string, unknown>>;
  customDefs: CustomFieldDef[];
  /** ค่า Custom field ปัจจุบันของงานในระบบ */
  currentCustom: Map<string, Record<string, unknown>>;
  /** ไฟล์รูปแบบเดิม: งานที่สร้างในระบบ (ยังไม่มี No.) แต่จับคู่ด้วย ID ได้ → บันทึก No. ให้ ครั้งต่อไปจับคู่ด้วย No. */
  assignNos: { issueId: string; no: number }[];
  keyed: boolean;
  /** ไฟล์มีคอลัมน์ Group · ไม่มี = ไม่แตะกลุ่มเดิม (ยกเว้นย้าย Module) */
  groupMapped: boolean;
  existing: Existing;
}

export async function computeUpdate(tx: Tx, project: { id: string; key: string }, check: PlanCheck, matchById: boolean, customDefs: CustomFieldDef[] = []): Promise<UpdatePlan> {
  const ex = await loadExisting(tx, project.id);
  const live = ex.rows.filter((r) => !r.deletedAt);
  const tasks = live.filter((r) => r.issueTypeId === ex.taskTypeId);
  const byId = new Map(live.map((r) => [r.id, r]));
  const hasChildren = new Set(live.filter((r) => r.parentId).map((r) => r.parentId!));
  // รูปแบบใหม่จับคู่ด้วยเลขงาน (Key) ทั้ง Task และ Sub-task · รูปแบบเดิมจับคู่ด้วย No. แล้วจึงใช้ ID กับงานที่ยังไม่มี No.
  const byNo = new Map(check.keyed ? [] : live.filter((r) => r.excelRowNo !== null).map((r) => [r.excelRowNo!, r]));
  const byNumber = new Map((check.keyed ? tasks : live.filter((r) => r.excelRowNo === null && !r.parentId)).map((r) => [r.number, r]));
  const assignNos: UpdatePlan['assignNos'] = [];
  const fileNos = new Set([...check.rows.map((r) => r.no), ...check.skip]);
  const fileNumbers = new Set(check.rows.map((r) => r.number).filter((n): n is number => n !== null));
  const diff: UpdateDiff = { added: [], changed: [], missing: [], unchanged: 0 };
  const edits: UpdatePlan['edits'] = [];
  const adds: PlanRow[] = [];
  const addCustom: UpdatePlan['addCustom'] = new Map();
  // Custom field: ค่าปัจจุบัน + ชื่อคนของฟิลด์ชนิดคน (เทียบด้วยชื่อ เหมือน Developer)
  const defs = customDefs.filter((d) => check.customMapped.includes(d.id));
  const currentCustom = defs.length ? await readCustomValues(tx, live.map((r) => r.id)) : new Map<string, Record<string, unknown>>();
  const cfUserIds = [...new Set([...currentCustom.values()].flatMap((v) => defs.filter((d) => d.fieldType === 'user').map((d) => v[d.id]).filter((x): x is string => typeof x === 'string')))].filter((id) => !ex.userName.has(id));
  if (cfUserIds.length) (await tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users).where(inArray(s.users.id, cfUserIds))).forEach((u) => ex.userName.set(u.id, u.name));
  /** ค่าในไฟล์ของแถวนี้ที่ใช้ได้ · ค่าผิดรูปแบบ = เตือนและไม่แตะฟิลด์นั้น */
  const customOf = (row: PlanRow, level: 'task' | 'subtask') => {
    const out: Record<string, unknown> = {};
    for (const d of defs) {
      const p = parseCustomCell(d, row.custom[d.id] ?? null);
      if (!p.ok) {
        check.findings.push({ level: 'warn', no: check.keyed ? null : row.no, rowNo: row.rowNo, module: row.module, title: row.title, problem: `${d.name}: ${p.problem}`, fix: 'ไม่แก้ฟิลด์นี้ · แก้ใน Excel แล้วนำเข้าใหม่' });
        continue;
      }
      if ((level === 'task' ? d.taskMode : d.subtaskMode) === 'hidden') continue; // ฟิลด์ที่ซ่อนในระดับนี้ไม่แตะ
      out[d.id] = p.value;
    }
    return out;
  };
  const cfShown = (d: CustomFieldDef, v: unknown) => (d.fieldType === 'user' ? (typeof v === 'string' ? (ex.userName.get(v) ?? v) : null) : displayValue(d, v));
  const has = (f: DiffField) => check.mapped.has(COLUMN[f]);
  const userName = (id: string | null) => (id ? (ex.userName.get(id) ?? '') : null);
  const samePerson = (a: string | null, b: string | null) => names(a ? [a] : []).join() === names(b ? [b] : []).join();

  for (const row of check.rows) {
    if (check.skip.has(row.no)) continue;
    let issue = check.keyed ? (row.number !== null ? byNumber.get(row.number) : undefined) : byNo.get(row.no);
    if (!issue && !check.keyed && matchById && row.number !== null) {
      issue = byNumber.get(row.number);
      if (issue) {
        byNumber.delete(row.number);
        assignNos.push({ issueId: issue.id, no: row.no });
        byNo.set(row.no, issue);
      }
    }
    if (!issue) {
      adds.push(row);
      if (defs.length) addCustom.set(row, customOf(row, row.parentNumber === null ? 'task' : 'subtask'));
      diff.added.push({ no: row.no, number: row.number, title: row.title, module: row.module });
      continue;
    }
    const oldParent = issue.parentId ? byId.get(issue.parentId) : undefined;
    if (has('parent') && row.parentNumber !== null && hasChildren.has(issue.id)) {
      check.findings.push({ level: 'err', no: check.keyed ? null : row.no, rowNo: row.rowNo, module: row.module, title: row.title, problem: `${project.key}-${issue.number} มี Sub-task อยู่ จึงเป็น Sub-task ของงานอื่นไม่ได้`, fix: 'ลบ Parent Key ของแถวนี้' });
      check.skip.add(row.no);
      continue;
    }
    const oldDevs = (ex.assignees.get(issue.id) ?? []).map((u) => ex.userName.get(u) ?? '');
    const oldLabels = (ex.labels.get(issue.id) ?? []).map((l) => ex.labelName.get(l) ?? '').sort((a, b) => a.localeCompare(b));
    const fields: FieldChange[] = [];
    const add = (field: DiffField, oldV: unknown, newV: unknown) => has(field) && fields.push({ field, label: LABELS[field], old: oldV ?? null, new: newV ?? null });
    const keyOf = (n: number | null | undefined) => (n ? `${project.key}-${n}` : null);
    if (issue.title !== row.title) add('title', issue.title, row.title);
    if (!eq0(oldParent?.number, row.parentNumber)) add('parent', keyOf(oldParent?.number), keyOf(row.parentNumber));
    if (!eq0(ex.moduleName.get(issue.moduleId ?? ''), row.module) && row.module) add('module', ex.moduleName.get(issue.moduleId ?? '') ?? null, row.module);
    // กลุ่มเทียบเฉพาะ Task (Sub-task ตามกลุ่มของแม่)
    const oldGroup = issue.phaseId ? (ex.phases.find((p) => p.id === issue.phaseId)?.name ?? null) : null;
    if (!issue.parentId && row.parentNumber === null && (oldGroup ?? '').toLowerCase() !== (row.phase ?? '').toLowerCase()) add('group', oldGroup, row.phase);
    if (!eq0(ex.statusName.get(issue.statusId), row.status)) add('status', ex.statusName.get(issue.statusId) ?? null, row.status);
    // Priority ว่างในไฟล์ = คงค่าเดิม (ทุกงานต้องมี Priority)
    if (row.priority && issue.priority !== row.priority) add('priority', issue.priority, row.priority);
    if (!eq0(issue.size, row.size)) add('size', issue.size, row.size);
    if (!eq0(issue.estimateMd === null ? null : Number(issue.estimateMd), row.estimateMd)) add('estimateMd', issue.estimateMd === null ? null : Number(issue.estimateMd), row.estimateMd);
    for (const f of ['planStart', 'planEnd', 'actualStart', 'actualEnd'] as const) if (!eq0(issue[f], row[f])) add(f, issue[f], row[f]);
    if (!samePerson(userName(issue.baId), row.ba)) add('ba', userName(issue.baId), row.ba);
    if (!samePerson(userName(issue.saId), row.sa)) add('sa', userName(issue.saId), row.sa);
    if (names(oldDevs).join('|') !== names(row.devs).join('|')) add('devs', oldDevs, row.devs);
    if (!samePerson(userName(issue.reviewerId), row.reviewer)) add('reviewer', userName(issue.reviewerId), row.reviewer);
    if (names(oldLabels).join('|') !== names(row.labels).join('|')) add('labels', oldLabels, row.labels);
    if (!eq0(issue.description || null, row.description || null)) add('description', issue.description || null, row.description);
    if (!eq0(issue.remark || null, row.remark || null)) add('remark', issue.remark || null, row.remark);
    const custom: Record<string, unknown> = {};
    if (defs.length) {
      const cur = currentCustom.get(issue.id) ?? {};
      for (const [id, v] of Object.entries(customOf(row, (row.parentNumber ?? oldParent?.number ?? null) === null ? 'task' : 'subtask'))) {
        const d = defs.find((x) => x.id === id)!;
        const old = cur[id] ?? null;
        const same = d.fieldType === 'user' ? personKey(String(cfShown(d, old) ?? '')) === personKey(String(v ?? '')) : JSON.stringify(old) === JSON.stringify(v);
        if (same) continue;
        custom[id] = v;
        fields.push({ field: `cf:${id}`, label: d.name, old: cfShown(d, old), new: d.fieldType === 'user' ? v : displayValue(d, v) });
      }
    }
    if (!fields.length) {
      diff.unchanged++;
      continue;
    }
    edits.push({ issue, row, fields, custom });
    diff.changed.push({ no: row.no, key: `${project.key}-${issue.number}`, title: issue.title, fields });
  }

  // งานที่อยู่ในระบบแต่ไม่อยู่ในไฟล์ (ทุกแถวในไฟล์ รวมแถวที่ต้องแก้ ถือว่ายังอยู่)
  if (check.keyed) {
    for (const issue of tasks) {
      if (fileNumbers.has(issue.number)) continue;
      diff.missing.push({ no: issue.number, key: `${project.key}-${issue.number}`, title: issue.title, status: ex.statusName.get(issue.statusId) ?? '' });
    }
  } else {
    for (const issue of live.filter((r) => r.excelRowNo !== null && !r.parentId)) {
      if (fileNos.has(issue.excelRowNo!)) continue;
      diff.missing.push({ no: issue.excelRowNo!, key: `${project.key}-${issue.number}`, title: issue.title, status: ex.statusName.get(issue.statusId) ?? '' });
    }
  }
  diff.missing.sort((a, b) => a.no - b.no);
  return { diff, edits, adds, addCustom, customDefs: defs, currentCustom, assignNos, keyed: check.keyed, groupMapped: check.mapped.has('group'), existing: ex };
}

export interface ApplyInput {
  auth: AuthInfo;
  tenant: TenantInfo;
  project: { id: string; key: string; issueSeq: number };
  fileName: string;
  plan: UpdatePlan;
  /** ชื่อคน (personKey) → userId ที่จับคู่แล้ว */
  userOf: (name: string | null) => string | null;
  /** ชื่อ / อีเมลของสมาชิก → userId · ใช้กับ Custom field ชนิดคน (ชื่อเหล่านี้ไม่อยู่ในขั้นจับคู่คน) */
  memberOf?: (name: string) => string | null;
  /** no ของงานที่หายจากไฟล์ที่ผู้ใช้เลือกลบ */
  deleteNos: Set<number>;
  reason: string;
}

/** เขียนผลอัปเดตแผนทั้งหมดในธุรกรรมเดียว · คืนจำนวนและเหตุการณ์ที่ต้องส่งหลัง commit */
export async function applyUpdate(tx: Tx, input: ApplyInput) {
  const { auth, tenant, project, plan, userOf } = input;
  const ex = plan.existing;
  const base = { workspaceId: tenant.workspaceId, projectId: project.id };
  const w = { workspaceId: tenant.workspaceId };
  const events: DomainEvent[] = [];
  const ev = (type: DomainEvent['type'], issueId: string | undefined, data: Record<string, unknown>): DomainEvent => ({ type, workspaceId: tenant.workspaceId, projectId: project.id, issueId, actorId: auth.userId, data, at: new Date() });

  // Module ที่ยังไม่มี → สร้างตามลำดับที่พบในไฟล์
  const rowsNeeded = [...plan.edits.map((e) => e.row), ...plan.adds];
  const moduleId = new Map(ex.moduleId);
  const newModules = [...new Set(rowsNeeded.map((r) => r.module).filter((m) => m && !moduleId.has(m)))];
  if (newModules.length) {
    const sort0 = ex.moduleName.size;
    const made = await tx.insert(s.modules).values(newModules.map((name, i) => ({ ...base, name, sort: sort0 + i }))).returning({ id: s.modules.id, name: s.modules.name });
    made.forEach((m) => moduleId.set(m.name, m.id));
  }
  const statusIdOf = (name: string) => ex.statusId.get(name) ?? ex.statusId.get('To do')!;
  // ชื่อคนของ Custom field ชนิดคน → userId (ตามการจับคู่คน · ชื่อเดิมของค่าในระบบใช้ id เดิม) · ไม่พบ = ไม่แตะฟิลด์นั้น
  const cfValues = (values: Record<string, unknown>, current: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(values)) {
      const d = plan.customDefs.find((x) => x.id === id);
      if (!d) continue;
      if (d.fieldType !== 'user' || v === null) {
        out[id] = v;
        continue;
      }
      const old = typeof current[id] === 'string' ? (current[id] as string) : null;
      const uid = userOf(String(v)) ?? input.memberOf?.(String(v)) ?? (old && personKey(ex.userName.get(old) ?? '') === personKey(String(v)) ? old : null);
      if (uid) out[id] = uid;
    }
    return out;
  };

  if (plan.assignNos.length) {
    await tx.update(s.issues).set({ excelRowNo: null }).where(and(eq(s.issues.projectId, project.id), sql`${s.issues.deletedAt} is not null`, inArray(s.issues.excelRowNo, plan.assignNos.map((a) => a.no))));
    for (const a of plan.assignNos) await tx.update(s.issues).set({ excelRowNo: a.no }).where(eq(s.issues.id, a.issueId));
  }

  // งานใหม่ในไฟล์ก่อน: งานเดิมที่ย้ายไปอยู่ใต้ Task ใหม่ต้องรู้ id ของแม่
  const live = ex.rows.filter((r) => !r.deletedAt);
  const parents = new Map(live.filter((r) => !r.parentId && r.issueTypeId === ex.taskTypeId).map((r) => [r.number, { id: r.id, phaseId: r.phaseId }]));
  if (plan.adds.length) {
    const made = await insertRows(
      tx,
      {
        workspaceId: tenant.workspaceId,
        projectId: project.id,
        projectKey: project.key,
        actorId: auth.userId,
        taskTypeId: ex.taskTypeId,
        fileName: input.fileName,
        keepRowNo: !plan.keyed,
        moduleId,
        statusIdOf,
        userOf,
        taken: new Set(ex.rows.map((r) => r.number)),
        seq: project.issueSeq,
        parents,
      },
      plan.adds,
    );
    events.push(...made.events);
    for (const [r, values] of plan.addCustom) {
      const id = made.idOf.get(r);
      if (id && Object.values(values).some((v) => v !== null)) await writeCustomValues(tx, tenant.workspaceId, id, cfValues(Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)), {}));
    }
    for (const r of plan.adds) if (r.parentNumber === null && r.number !== null) parents.set(r.number, { id: made.idOf.get(r)!, phaseId: made.phaseIdOf.get(r) ?? null });
  }

  // การแก้ไขแผนเทียบ Baseline ล่าสุด (ถ้ามี) · ไม่มี Baseline = ไม่มีอะไรให้เทียบ ตามกติกาเดียวกับการแก้งานทีละงาน
  const [baseline] = await tx.select({ id: s.planBaselines.id }).from(s.planBaselines).where(eq(s.planBaselines.projectId, project.id)).orderBy(sql`${s.planBaselines.version} desc`).limit(1);
  // กลุ่มตามชื่อใน Module · ที่ยังไม่มีสร้างให้
  const phaseKey = (moduleId: string, name: string) => `${moduleId}\u0000${name.toLowerCase()}`;
  const phaseId = new Map((await tx.select({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, project.id))).map((p) => [phaseKey(p.moduleId, p.name), p.id]));
  const phaseIdOf = async (moduleId: string | null, name: string | null) => {
    if (!moduleId || !name) return null;
    const k = phaseKey(moduleId, name);
    if (!phaseId.has(k)) phaseId.set(k, (await tx.insert(s.phases).values({ ...base, moduleId, name, sort: phaseId.size }).returning({ id: s.phases.id }))[0].id);
    return phaseId.get(k)!;
  };
  const labelId = new Map((await tx.select({ id: s.labels.id, name: s.labels.name }).from(s.labels).where(eq(s.labels.projectId, project.id))).map((l) => [l.name.toLowerCase(), l.id]));
  const labelIdOf = async (name: string) => {
    const k = name.toLowerCase();
    if (!labelId.has(k)) labelId.set(k, (await tx.insert(s.labels).values({ ...base, name }).returning({ id: s.labels.id }))[0].id);
    return labelId.get(k)!;
  };

  let planChangeCount = 0;
  for (const { issue, row, fields, custom } of plan.edits) {
    const has = (f: DiffField) => fields.some((x) => x.field === f);
    const cfChanged = Object.keys(custom).length > 0;
    // ชื่อ → userId ของคนที่อยู่ในงานนี้อยู่แล้ว (เช่น สมาชิกที่ปิดบัญชีไปแล้ว ยังคงอยู่)
    const keepPerson = (name: string | null, old: string | null) => (name ? (userOf(name) ?? (old && personKey(ex.userName.get(old) ?? '') === personKey(name) ? old : null)) : null);
    const oldDevIds = ex.assignees.get(issue.id) ?? [];
    const keep = (name: string, ids: string[]) => ids.find((u) => personKey(ex.userName.get(u) ?? '') === personKey(name)) ?? null;
    const newDevIds = [...new Set(row.devs.map((d) => userOf(d) ?? keep(d, oldDevIds)).filter((u): u is string => !!u))];
    const mid = row.module ? moduleId.get(row.module)! : issue.moduleId;
    const set: Partial<typeof s.issues.$inferInsert> = {};
    if (has('title')) set.title = row.title;
    const newParent = row.parentNumber === null ? null : (parents.get(row.parentNumber) ?? null);
    if (has('parent')) set.parentId = newParent?.id ?? null;
    if (has('module') || has('parent')) set.moduleId = mid;
    // กลุ่ม: Sub-task ตามแม่ · Task ใช้ค่าในคอลัมน์ Group (ไฟล์ไม่มีคอลัมน์ Group แล้วย้าย Module = ไม่มีกลุ่ม)
    if (has('parent') || has('module') || has('group')) {
      const nested = has('parent') ? !!newParent : !!issue.parentId;
      if (nested) { if (has('parent')) set.phaseId = newParent?.phaseId ?? null; }
      else set.phaseId = plan.groupMapped ? await phaseIdOf(mid, row.phase) : null;
    }
    if (has('status')) set.statusId = statusIdOf(row.status);
    if (has('priority')) set.priority = row.priority!;
    if (has('size')) set.size = row.size;
    if (has('estimateMd')) set.estimateMd = row.estimateMd;
    for (const f of ['planStart', 'planEnd', 'actualStart', 'actualEnd'] as const) if (has(f)) set[f] = row[f];
    if (has('ba')) set.baId = keepPerson(row.ba, issue.baId);
    if (has('sa')) set.saId = keepPerson(row.sa, issue.saId);
    if (has('reviewer')) set.reviewerId = keepPerson(row.reviewer, issue.reviewerId);
    if (has('description')) set.description = row.description;
    if (has('remark')) set.remark = row.remark;
    const idsChanged = has('devs') && [...oldDevIds].sort().join() !== [...newDevIds].sort().join();
    if (idsChanged || has('labels') || has('parent')) set.version = issue.version + 1;
    if (cfChanged && set.version === undefined) set.version = issue.version + 1;
    if (Object.keys(set).length) await tx.update(s.issues).set(set).where(eq(s.issues.id, issue.id));
    if (cfChanged) await writeCustomValues(tx, tenant.workspaceId, issue.id, cfValues(custom, plan.currentCustom.get(issue.id) ?? {}), plan.currentCustom.get(issue.id) ?? {});
    if (idsChanged) {
      await tx.delete(s.issueAssignees).where(eq(s.issueAssignees.issueId, issue.id));
      if (newDevIds.length) await tx.insert(s.issueAssignees).values(newDevIds.map((userId, i) => ({ ...w, issueId: issue.id, userId, sort: i })));
    }
    if (has('labels')) {
      await tx.delete(s.issueLabels).where(eq(s.issueLabels.issueId, issue.id));
      const ids = [...new Set(await Promise.all(row.labels.map(labelIdOf)))];
      if (ids.length) await tx.insert(s.issueLabels).values(ids.map((id) => ({ ...w, issueId: issue.id, labelId: id })));
    }
    // ย้าย Module / กลุ่มของ Task แล้ว Sub-task ย้ายตาม
    if ((has('module') || has('group')) && !issue.parentId && set.phaseId !== undefined) await tx.update(s.issues).set({ moduleId: mid, phaseId: set.phaseId }).where(eq(s.issues.parentId, issue.id));

    await tx.insert(s.activities).values(fields.map((f) => ({ ...base, issueId: issue.id, actorId: auth.userId, actorKind: 'import' as const, verb: 'updated', field: ACTIVITY_FIELD[f.field as DiffField] ?? f.field, oldValue: f.old, newValue: f.new })));
    const planFields = fields.filter((f) => PLAN_FIELDS.has(f.field as DiffField) && (f.field !== 'devs' || idsChanged));
    if (baseline && planFields.length) {
      await tx.insert(s.planChanges).values(
        planFields.map((f) => ({
          ...base,
          issueId: issue.id,
          baselineId: baseline.id,
          field: ACTIVITY_FIELD[f.field as DiffField] ?? f.field,
          oldValue: f.field === 'devs' ? oldDevIds : f.old,
          newValue: f.field === 'devs' ? newDevIds : f.new,
          reason: input.reason,
          source: 'import' as const,
          changedBy: auth.userId,
        })),
      );
      planChangeCount += planFields.length;
      events.push(ev('plan.changed', issue.id, { issueKey: `${project.key}-${issue.number}`, fields: planFields.map((f) => ACTIVITY_FIELD[f.field as DiffField] ?? f.field), reason: input.reason, source: 'import' }));
    }
  }

  // งานที่หายจากไฟล์: ลบ (ย้ายถังขยะ 30 วัน) เฉพาะที่ผู้ใช้เลือกเอง · ลบ Task แล้ว Sub-task ไปด้วย
  const toDelete = plan.diff.missing.filter((m) => input.deleteNos.has(m.no));
  if (toDelete.length) {
    const picked = new Set(toDelete.map((m) => m.no));
    const roots = live.filter((r) => (plan.keyed ? r.issueTypeId === ex.taskTypeId && picked.has(r.number) : r.excelRowNo !== null && !r.parentId && picked.has(r.excelRowNo)));
    const children = await tx.select().from(s.issues).where(and(inArray(s.issues.parentId, roots.map((r) => r.id)), isNull(s.issues.deletedAt)));
    const rootIds = new Set(roots.map((r) => r.id));
    const rows = [...new Map([...roots, ...children].map((r) => [r.id, r])).values()];
    const deletedAt = new Date();
    await tx.update(s.issues).set({ deletedAt, version: sql`${s.issues.version} + 1` }).where(inArray(s.issues.id, rows.map((r) => r.id)));
    await tx.insert(s.activities).values(rows.map((r) => ({ ...base, issueId: r.id, actorId: auth.userId, actorKind: 'import' as const, verb: 'deleted', field: 'deletedAt', newValue: { deletedAt: deletedAt.toISOString(), cascadeRootId: rootIds.has(r.id) ? r.id : r.parentId } })));
    rows.forEach((r) => events.push(ev('issue.deleted', r.id, { issueKey: `${project.key}-${r.number}`, source: 'import' })));
  }

  return {
    added: plan.adds.length,
    changed: plan.edits.length,
    unchanged: plan.diff.unchanged,
    deleted: toDelete.length,
    kept: plan.diff.missing.length - toDelete.length,
    planChanges: planChangeCount,
    events,
  };
}
