import { schema, type Tx } from '@friday/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import type { DomainEvent } from '../core/events.js';
import { personKey, type PlanCheck, type PlanRow } from './plan.js';

const s = schema;

/** ฟิลด์ที่เทียบตอนอัปเดตแผน (Screen / FR ไม่เทียบ: แก้ในระบบได้เองหลังนำเข้า) */
const LABELS = {
  title: 'ชื่องาน',
  module: 'Module',
  phase: 'กลุ่มงาน',
  status: 'Status',
  size: 'Size',
  estimateMd: 'Man-Day',
  planStart: 'Plan Start',
  planEnd: 'Plan End',
  actualStart: 'Actual Start',
  actualEnd: 'Actual End',
  ba: 'BA',
  devs: 'Dev',
  remark: 'หมายเหตุ',
} as const;
type DiffField = keyof typeof LABELS;
const PLAN_FIELDS = new Set<DiffField>(['planStart', 'planEnd', 'estimateMd', 'devs']);

export interface FieldChange {
  field: DiffField;
  label: string;
  old: unknown;
  new: unknown;
}
export interface UpdateDiff {
  added: { no: number; number: number; title: string; module: string }[];
  changed: { no: number; key: string; title: string; fields: FieldChange[] }[];
  /** อยู่ในระบบ (มี excel_row_no) แต่ไม่อยู่ในไฟล์ · ไม่ลบเอง ให้ผู้ใช้เลือก */
  missing: { no: number; key: string; title: string; status: string }[];
  unchanged: number;
}

type Issue = typeof s.issues.$inferSelect;

interface Existing {
  rows: Issue[];
  moduleName: Map<string, string>;
  moduleId: Map<string, string>;
  phase: Map<string, { moduleId: string; name: string }>;
  statusName: Map<string, string>;
  statusId: Map<string, string>;
  assignees: Map<string, string[]>;
  userName: Map<string, string>;
  taskTypeId: string;
}

async function loadExisting(tx: Tx, projectId: string): Promise<Existing> {
  // รวมงานที่ลบแล้ว: excel_row_no ซ้ำกันไม่ได้ (unique) จึงต้องรู้ว่าเลขไหนถูกใช้
  const rows = await tx.select().from(s.issues).where(eq(s.issues.projectId, projectId));
  const mods = await tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, projectId));
  const phs = await tx.select({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, projectId));
  const [taskType] = await tx.select().from(s.issueTypes).where(and(eq(s.issueTypes.projectId, projectId), eq(s.issueTypes.name, 'Task')));
  const sts = await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses).where(eq(s.workflowStatuses.workflowId, taskType.workflowId));
  const usedStatus = [...new Set(rows.map((r) => r.statusId))];
  const allStatus = usedStatus.length ? await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses).where(inArray(s.workflowStatuses.id, usedStatus)) : [];
  const liveIds = rows.filter((r) => !r.deletedAt).map((r) => r.id);
  const asg = liveIds.length
    ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId, sort: s.issueAssignees.sort }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, liveIds)).orderBy(s.issueAssignees.sort)
    : [];
  const assignees = new Map<string, string[]>();
  for (const a of asg) assignees.set(a.issueId, [...(assignees.get(a.issueId) ?? []), a.userId]);
  const userIds = [...new Set([...asg.map((a) => a.userId), ...rows.map((r) => r.baId).filter((x): x is string => !!x)])];
  const users = userIds.length ? await tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users).where(inArray(s.users.id, userIds)) : [];
  return {
    rows,
    moduleName: new Map(mods.map((m) => [m.id, m.name])),
    moduleId: new Map(mods.map((m) => [m.name, m.id])),
    phase: new Map(phs.map((p) => [p.id, { moduleId: p.moduleId, name: p.name }])),
    statusName: new Map([...sts, ...allStatus].map((x) => [x.id, x.name])),
    statusId: new Map(sts.map((x) => [x.name, x.id])),
    assignees,
    userName: new Map(users.map((u) => [u.id, u.name])),
    taskTypeId: taskType.id,
  };
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
  edits: { issue: Issue; row: PlanRow; fields: FieldChange[] }[];
  adds: PlanRow[];
  /** งานที่สร้างในระบบ (ยังไม่มี No.) แต่จับคู่ด้วย ID ได้ → บันทึก No. ให้ ครั้งต่อไปจับคู่ด้วย No. */
  assignNos: { issueId: string; no: number }[];
  existing: Existing;
}

export async function computeUpdate(tx: Tx, project: { id: string; key: string }, check: PlanCheck, matchById: boolean): Promise<UpdatePlan> {
  const ex = await loadExisting(tx, project.id);
  const byNo = new Map(ex.rows.filter((r) => !r.deletedAt && r.excelRowNo !== null).map((r) => [r.excelRowNo!, r]));
  const byNumber = new Map(ex.rows.filter((r) => !r.deletedAt && r.excelRowNo === null && !r.parentId).map((r) => [r.number, r]));
  const assignNos: UpdatePlan['assignNos'] = [];
  const fileNos = new Set([...check.rows.map((r) => r.no), ...check.skip]);
  const diff: UpdateDiff = { added: [], changed: [], missing: [], unchanged: 0 };
  const edits: UpdatePlan['edits'] = [];
  const adds: PlanRow[] = [];

  for (const row of check.rows) {
    if (check.skip.has(row.no)) continue;
    let issue = byNo.get(row.no);
    if (!issue && matchById) {
      issue = byNumber.get(row.number);
      if (issue) {
        byNumber.delete(row.number);
        assignNos.push({ issueId: issue.id, no: row.no });
        byNo.set(row.no, issue);
      }
    }
    if (!issue) {
      adds.push(row);
      diff.added.push({ no: row.no, number: row.number, title: row.title, module: row.module });
      continue;
    }
    const phase = issue.phaseId ? ex.phase.get(issue.phaseId) : null;
    const oldDevs = (ex.assignees.get(issue.id) ?? []).map((u) => ex.userName.get(u) ?? '');
    const oldBa = issue.baId ? (ex.userName.get(issue.baId) ?? '') : null;
    const fields: FieldChange[] = [];
    const add = (field: DiffField, oldV: unknown, newV: unknown) => fields.push({ field, label: LABELS[field], old: oldV ?? null, new: newV ?? null });
    if (issue.title !== row.title) add('title', issue.title, row.title);
    if (!eq0(ex.moduleName.get(issue.moduleId ?? ''), row.module)) add('module', ex.moduleName.get(issue.moduleId ?? '') ?? null, row.module);
    if (!eq0(phase?.name, row.phase)) add('phase', phase?.name ?? null, row.phase);
    if (!eq0(ex.statusName.get(issue.statusId), row.status)) add('status', ex.statusName.get(issue.statusId) ?? null, row.status);
    if (!eq0(issue.size, row.size)) add('size', issue.size, row.size);
    if (!eq0(issue.estimateMd === null ? null : Number(issue.estimateMd), row.estimateMd)) add('estimateMd', issue.estimateMd === null ? null : Number(issue.estimateMd), row.estimateMd);
    for (const f of ['planStart', 'planEnd', 'actualStart', 'actualEnd'] as const) if (!eq0(issue[f], row[f])) add(f, issue[f], row[f]);
    if (names(oldBa ? [oldBa] : []).join() !== names(row.ba ? [row.ba] : []).join()) add('ba', oldBa, row.ba);
    if (names(oldDevs).join('|') !== names(row.devs).join('|')) add('devs', oldDevs, row.devs);
    if (!eq0(issue.description || null, row.remark || null)) add('remark', issue.description || null, row.remark);
    if (!fields.length) {
      diff.unchanged++;
      continue;
    }
    edits.push({ issue, row, fields });
    diff.changed.push({ no: row.no, key: `${project.key}-${issue.number}`, title: issue.title, fields });
  }

  for (const issue of ex.rows.filter((r) => !r.deletedAt && r.excelRowNo !== null && !r.parentId)) {
    // ทุกงานในไฟล์ (รวมแถวที่ต้องแก้) ถือว่ายังอยู่ · เฉพาะ Task ระดับบน ที่มี No. แล้ว
    if (fileNos.has(issue.excelRowNo!)) continue;
    diff.missing.push({ no: issue.excelRowNo!, key: `${project.key}-${issue.number}`, title: issue.title, status: ex.statusName.get(issue.statusId) ?? '' });
  }
  diff.missing.sort((a, b) => a.no - b.no);
  return { diff, edits, adds, assignNos, existing: ex };
}

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export interface ApplyInput {
  auth: AuthInfo;
  tenant: TenantInfo;
  project: { id: string; key: string; issueSeq: number };
  fileName: string;
  plan: UpdatePlan;
  /** ชื่อคน (personKey) → userId ที่จับคู่แล้ว */
  userOf: (name: string | null) => string | null;
  /** No. → 'delete' เฉพาะที่ผู้ใช้เลือกลบ */
  deleteNos: Set<number>;
  reason: string;
}

/** เขียนผลอัปเดตแผนทั้งหมดในธุรกรรมเดียว · คืนจำนวนและเหตุการณ์ที่ต้องส่งหลัง commit */
export async function applyUpdate(tx: Tx, input: ApplyInput) {
  const { auth, tenant, project, plan, userOf } = input;
  const ex = plan.existing;
  const base = { workspaceId: tenant.workspaceId, projectId: project.id };
  const events: DomainEvent[] = [];
  const ev = (type: DomainEvent['type'], issueId: string | undefined, data: Record<string, unknown>): DomainEvent => ({ type, workspaceId: tenant.workspaceId, projectId: project.id, issueId, actorId: auth.userId, data, at: new Date() });

  // Module / กลุ่มงานที่ยังไม่มี → สร้างตามลำดับที่พบในไฟล์
  const rowsNeeded = [...plan.edits.map((e) => e.row), ...plan.adds];
  const moduleId = new Map(ex.moduleId);
  const newModules = [...new Set(rowsNeeded.map((r) => r.module).filter((m) => !moduleId.has(m)))];
  if (newModules.length) {
    const sort0 = ex.moduleName.size;
    const made = await tx.insert(s.modules).values(newModules.map((name, i) => ({ ...base, name, sort: sort0 + i }))).returning({ id: s.modules.id, name: s.modules.name });
    made.forEach((m) => moduleId.set(m.name, m.id));
  }
  const phaseKey = (mid: string, name: string) => `${mid}\u0000${name}`;
  const phaseId = new Map([...ex.phase].map(([id, p]) => [phaseKey(p.moduleId, p.name), id]));
  const newPhases = new Map<string, { moduleId: string; name: string }>();
  for (const r of rowsNeeded) {
    if (!r.phase) continue;
    const mid = moduleId.get(r.module)!;
    if (!phaseId.has(phaseKey(mid, r.phase))) newPhases.set(phaseKey(mid, r.phase), { moduleId: mid, name: r.phase });
  }
  if (newPhases.size) {
    const made = await tx
      .insert(s.phases)
      .values([...newPhases.values()].map((p, i) => ({ ...base, ...p, sort: ex.phase.size + i })))
      .returning({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name });
    made.forEach((p) => phaseId.set(phaseKey(p.moduleId, p.name), p.id));
  }
  const statusIdOf = (name: string) => ex.statusId.get(name) ?? ex.statusId.get('To do')!;

  if (plan.assignNos.length) {
    await tx.update(s.issues).set({ excelRowNo: null }).where(and(eq(s.issues.projectId, project.id), sql`${s.issues.deletedAt} is not null`, inArray(s.issues.excelRowNo, plan.assignNos.map((a) => a.no))));
    for (const a of plan.assignNos) await tx.update(s.issues).set({ excelRowNo: a.no }).where(eq(s.issues.id, a.issueId));
  }

  // การแก้ไขแผนเทียบ Baseline ล่าสุด (ถ้ามี) · ไม่มี Baseline = ไม่มีอะไรให้เทียบ ตามกติกาเดียวกับการแก้งานทีละงาน
  const [baseline] = await tx.select({ id: s.planBaselines.id }).from(s.planBaselines).where(eq(s.planBaselines.projectId, project.id)).orderBy(sql`${s.planBaselines.version} desc`).limit(1);

  // ชื่อ → userId ของคนที่อยู่ในงานนี้อยู่แล้ว (เช่น สมาชิกที่ปิดบัญชีไปแล้ว ยังคงอยู่)
  let planChangeCount = 0;
  for (const { issue, row, fields } of plan.edits) {
    const has = (f: DiffField) => fields.some((x) => x.field === f);
    const oldDevIds = ex.assignees.get(issue.id) ?? [];
    const keep = (name: string, ids: string[]) => ids.find((u) => personKey(ex.userName.get(u) ?? '') === personKey(name)) ?? null;
    const newDevIds = [...new Set(row.devs.map((d) => userOf(d) ?? keep(d, oldDevIds)).filter((u): u is string => !!u))];
    const newBa = row.ba ? (userOf(row.ba) ?? (issue.baId && personKey(ex.userName.get(issue.baId) ?? '') === personKey(row.ba) ? issue.baId : null)) : null;
    const mid = moduleId.get(row.module)!;
    const pid = row.phase ? (phaseId.get(phaseKey(mid, row.phase)) ?? null) : null;
    const set: Partial<typeof s.issues.$inferInsert> = {};
    if (has('title')) set.title = row.title;
    if (has('module')) set.moduleId = mid;
    if (has('module') || has('phase')) set.phaseId = pid;
    if (has('status')) set.statusId = statusIdOf(row.status);
    if (has('size')) set.size = row.size;
    if (has('estimateMd')) set.estimateMd = row.estimateMd;
    for (const f of ['planStart', 'planEnd', 'actualStart', 'actualEnd'] as const) if (has(f)) set[f] = row[f];
    if (has('ba')) set.baId = newBa;
    if (has('remark')) set.description = row.remark;
    const idsChanged = has('devs') && [...oldDevIds].sort().join() !== [...newDevIds].sort().join();
    if (idsChanged) set.version = issue.version + 1;
    if (Object.keys(set).length) await tx.update(s.issues).set(set).where(eq(s.issues.id, issue.id));
    if (idsChanged) {
      await tx.delete(s.issueAssignees).where(eq(s.issueAssignees.issueId, issue.id));
      if (newDevIds.length) await tx.insert(s.issueAssignees).values(newDevIds.map((userId, i) => ({ workspaceId: tenant.workspaceId, issueId: issue.id, userId, sort: i })));
    }
    // ย้าย Module / กลุ่มงานของ Task แล้ว Sub-task ย้ายตาม
    if (has('module') || has('phase')) await tx.update(s.issues).set({ moduleId: mid, phaseId: pid }).where(eq(s.issues.parentId, issue.id));

    await tx.insert(s.activities).values(fields.map((f) => ({ ...base, issueId: issue.id, actorId: auth.userId, actorKind: 'import' as const, verb: 'updated', field: f.field === 'devs' ? 'assigneeIds' : f.field, oldValue: f.old, newValue: f.new })));
    const planFields = fields.filter((f) => PLAN_FIELDS.has(f.field) && (f.field !== 'devs' || idsChanged));
    if (baseline && planFields.length) {
      await tx.insert(s.planChanges).values(
        planFields.map((f) => ({
          ...base,
          issueId: issue.id,
          baselineId: baseline.id,
          field: f.field === 'devs' ? 'assigneeIds' : f.field,
          oldValue: f.field === 'devs' ? oldDevIds : f.old,
          newValue: f.field === 'devs' ? newDevIds : f.new,
          reason: input.reason,
          source: 'import' as const,
          changedBy: auth.userId,
        })),
      );
      planChangeCount += planFields.length;
      events.push(ev('plan.changed', issue.id, { issueKey: `${project.key}-${issue.number}`, fields: planFields.map((f) => (f.field === 'devs' ? 'assigneeIds' : f.field)), reason: input.reason, source: 'import' }));
    }
  }

  // งานใหม่ในไฟล์
  let seq = project.issueSeq;
  if (plan.adds.length) {
    const taken = new Set(ex.rows.map((r) => r.number));
    // No. ที่เคยใช้กับงานที่ลบแล้ว: ปล่อยเลขแถวให้ใช้ซ้ำได้ (unique ต่อโปรเจกต์)
    const freed = plan.adds.map((r) => r.no);
    await tx.update(s.issues).set({ excelRowNo: null }).where(and(eq(s.issues.projectId, project.id), sql`${s.issues.deletedAt} is not null`, inArray(s.issues.excelRowNo, freed)));
    const numbered = plan.adds.map((r) => {
      let number = r.number;
      if (taken.has(number)) number = Math.max(seq, ...taken) + 1;
      taken.add(number);
      seq = Math.max(seq, number);
      return { row: r, number };
    });
    // Requirement / Screen: ใช้ของเดิมในโปรเจกต์ ที่ยังไม่มีสร้างให้
    const reqCodes = [...new Set(plan.adds.flatMap((r) => r.requirements))];
    const scrCodes = [...new Set(plan.adds.flatMap((r) => r.screens))];
    const reqId = new Map((await tx.select({ id: s.requirements.id, code: s.requirements.code }).from(s.requirements).where(eq(s.requirements.projectId, project.id))).map((x) => [x.code, x.id]));
    const scrId = new Map((await tx.select({ id: s.screens.id, code: s.screens.code }).from(s.screens).where(eq(s.screens.projectId, project.id))).map((x) => [x.code, x.id]));
    const needReq = reqCodes.filter((c) => !reqId.has(c));
    const needScr = scrCodes.filter((c) => !scrId.has(c));
    if (needReq.length) (await tx.insert(s.requirements).values(needReq.map((code) => ({ ...base, code, kind: code.startsWith('NFR') ? 'NFR' : 'FR' }))).returning({ id: s.requirements.id, code: s.requirements.code })).forEach((x) => reqId.set(x.code, x.id));
    if (needScr.length) (await tx.insert(s.screens).values(needScr.map((code) => ({ ...base, code }))).returning({ id: s.screens.id, code: s.screens.code })).forEach((x) => scrId.set(x.code, x.id));

    const idOfNo = new Map<number, string>();
    for (const chunk of chunks(numbered, 200)) {
      const inserted = await tx
        .insert(s.issues)
        .values(
          chunk.map(({ row: r, number }) => {
            const mid = moduleId.get(r.module)!;
            return {
              ...base,
              number,
              excelRowNo: r.no,
              issueTypeId: ex.taskTypeId,
              moduleId: mid,
              phaseId: r.phase ? (phaseId.get(phaseKey(mid, r.phase)) ?? null) : null,
              title: r.title,
              description: r.remark,
              statusId: statusIdOf(r.status),
              baId: userOf(r.ba),
              reporterId: auth.userId,
              createdBy: auth.userId,
              size: r.size,
              estimateMd: r.estimateMd,
              planStart: r.planStart,
              planEnd: r.planEnd,
              actualStart: r.actualStart,
              actualEnd: r.actualEnd,
              details: r.requirementText ? { requirementText: r.requirementText } : {},
            };
          }),
        )
        .returning({ id: s.issues.id, number: s.issues.number });
      const noOfNumber = new Map(chunk.map((c) => [c.number, c.row.no]));
      inserted.forEach((x) => idOfNo.set(noOfNumber.get(x.number)!, x.id));
    }
    const w = { workspaceId: tenant.workspaceId };
    const assignees = numbered.flatMap(({ row: r }) => [...new Set(r.devs.map(userOf).filter((u): u is string => !!u))].map((userId, i) => ({ ...w, issueId: idOfNo.get(r.no)!, userId, sort: i })));
    for (const c of chunks(assignees, 500)) await tx.insert(s.issueAssignees).values(c);
    const reqLinks = numbered.flatMap(({ row: r }) => [...new Set(r.requirements)].map((c) => ({ ...w, issueId: idOfNo.get(r.no)!, requirementId: reqId.get(c)! })));
    const scrLinks = numbered.flatMap(({ row: r }) => [...new Set(r.screens)].map((c) => ({ ...w, issueId: idOfNo.get(r.no)!, screenId: scrId.get(c)! })));
    for (const c of chunks(reqLinks, 500)) await tx.insert(s.issueRequirements).values(c);
    for (const c of chunks(scrLinks, 500)) await tx.insert(s.issueScreens).values(c);
    await tx.insert(s.activities).values(numbered.map(({ row: r }) => ({ ...base, issueId: idOfNo.get(r.no)!, actorId: auth.userId, actorKind: 'import' as const, verb: 'imported', newValue: { fileName: input.fileName, no: r.no } })));
    numbered.forEach(({ row: r, number }) => events.push(ev('issue.created', idOfNo.get(r.no), { issueKey: `${project.key}-${number}`, type: 'Task', source: 'import' })));
    await tx.update(s.projects).set({ issueSeq: seq }).where(eq(s.projects.id, project.id));
  }

  // งานที่หายจากไฟล์: ลบ (ย้ายถังขยะ 30 วัน) เฉพาะที่ผู้ใช้เลือกเอง
  const toDelete = plan.diff.missing.filter((m) => input.deleteNos.has(m.no));
  if (toDelete.length) {
    const roots = ex.rows.filter((r) => !r.deletedAt && r.excelRowNo !== null && toDelete.some((m) => m.no === r.excelRowNo));
    const children = await tx.select().from(s.issues).where(and(inArray(s.issues.parentId, roots.map((r) => r.id)), isNull(s.issues.deletedAt)));
    const rows = [...roots, ...children];
    const deletedAt = new Date();
    await tx.update(s.issues).set({ deletedAt, version: sql`${s.issues.version} + 1` }).where(inArray(s.issues.id, rows.map((r) => r.id)));
    await tx.insert(s.activities).values(rows.map((r) => ({ ...base, issueId: r.id, actorId: auth.userId, actorKind: 'import' as const, verb: 'deleted', field: 'deletedAt', newValue: { deletedAt: deletedAt.toISOString(), cascadeRootId: r.parentId ?? r.id } })));
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
