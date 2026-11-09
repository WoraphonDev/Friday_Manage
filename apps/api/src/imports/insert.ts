import { schema, type Tx } from '@friday/db';
import { eq, inArray, sql } from 'drizzle-orm';
import type { DomainEvent } from '../core/events.js';
import type { PlanRow } from './plan.js';

const s = schema;

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export interface InsertContext {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  actorId: string;
  taskTypeId: string;
  fileName: string;
  /** ไฟล์รูปแบบเดิม: เก็บ No. ไว้ใน excel_row_no เพื่อจับคู่ตอนอัปเดต */
  keepRowNo: boolean;
  /** ชื่อ Module → id (ต้องมีครบทุก Module ของแถว) */
  moduleId: Map<string, string>;
  statusIdOf: (name: string) => string;
  userOf: (name: string | null) => string | null;
  /** เลขงานที่ใช้ไปแล้วในโปรเจกต์ (รวมงานที่ลบ) และเลขล่าสุด */
  taken: Set<number>;
  seq: number;
  /** Task ระดับบนที่มีอยู่ในระบบ (เลขงาน → id และกลุ่ม) ให้ Sub-task ใหม่อ้างถึง */
  parents: Map<number, { id: string; phaseId: string | null }>;
  /** ข้อมูลเพิ่มใน details ของแต่ละแถว (เช่น ชื่อคนที่ยังไม่จับคู่) */
  details?: (row: PlanRow) => Record<string, unknown>;
}

/**
 * สร้างงานใหม่จากแถวในไฟล์: Task ก่อน แล้วจึง Sub-task (ต้องรู้ id ของแม่)
 * เลขงาน = Key ในไฟล์ถ้ายังว่าง ไม่อย่างนั้นออกเลขถัดไป · Requirement / Screen / Label ที่ยังไม่มีสร้างให้
 */
export async function insertRows(tx: Tx, ctx: InsertContext, rows: PlanRow[]) {
  const base = { workspaceId: ctx.workspaceId, projectId: ctx.projectId };
  const ws = { workspaceId: ctx.workspaceId };
  let seq = ctx.seq;
  const taken = new Set(ctx.taken);
  // เลขงานในไฟล์ → เลขที่ได้จริง (Sub-task ใช้หาแม่ที่ถูกออกเลขใหม่)
  const assigned = new Map<PlanRow, number>();
  for (const r of rows) {
    if (r.number !== null && !taken.has(r.number)) {
      assigned.set(r, r.number);
      taken.add(r.number);
    }
  }
  for (const r of rows) {
    if (assigned.has(r)) continue;
    const number = Math.max(seq, 0, ...taken) + 1;
    assigned.set(r, number);
    taken.add(number);
  }
  seq = Math.max(seq, ...assigned.values());

  const [reqId, scrId, labelId] = await Promise.all([
    codes(tx, s.requirements, ctx.projectId),
    codes(tx, s.screens, ctx.projectId),
    tx.select({ id: s.labels.id, name: s.labels.name }).from(s.labels).where(eq(s.labels.projectId, ctx.projectId)).then((x) => new Map(x.map((l) => [l.name.toLowerCase(), l.id]))),
  ]);
  const needReq = [...new Set(rows.flatMap((r) => r.requirements))].filter((c) => !reqId.has(c));
  const needScr = [...new Set(rows.flatMap((r) => r.screens))].filter((c) => !scrId.has(c));
  const needLabel = [...new Map(rows.flatMap((r) => r.labels).map((n) => [n.toLowerCase(), n])).entries()].filter(([k]) => !labelId.has(k));
  if (needReq.length) (await tx.insert(s.requirements).values(needReq.map((code) => ({ ...base, code, kind: code.startsWith('NFR') ? 'NFR' : 'FR' }))).returning({ id: s.requirements.id, code: s.requirements.code })).forEach((x) => reqId.set(x.code, x.id));
  if (needScr.length) (await tx.insert(s.screens).values(needScr.map((code) => ({ ...base, code }))).returning({ id: s.screens.id, code: s.screens.code })).forEach((x) => scrId.set(x.code, x.id));
  if (needLabel.length) (await tx.insert(s.labels).values(needLabel.map(([, name]) => ({ ...base, name }))).returning({ id: s.labels.id, name: s.labels.name })).forEach((x) => labelId.set(x.name.toLowerCase(), x.id));

  // กลุ่ม (ไม่บังคับ) ของ Task: ใช้กลุ่มเดิมใน Module ชื่อเดียวกัน ที่ยังไม่มีสร้างให้ · Sub-task ใช้กลุ่มของแม่
  const phaseKey = (moduleId: string, name: string) => `${moduleId}\u0000${name.toLowerCase()}`;
  const phaseId = new Map((await tx.select({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name }).from(s.phases).where(eq(s.phases.projectId, ctx.projectId))).map((p) => [phaseKey(p.moduleId, p.name), p.id]));
  for (const r of rows.filter((x) => x.parentNumber === null && x.phase)) {
    const mid = ctx.moduleId.get(r.module)!;
    if (phaseId.has(phaseKey(mid, r.phase!))) continue;
    const [made] = await tx.insert(s.phases).values({ ...base, moduleId: mid, name: r.phase!, sort: phaseId.size }).returning({ id: s.phases.id });
    phaseId.set(phaseKey(mid, r.phase!), made.id);
  }
  const phaseOf = (r: PlanRow) => (r.phase ? (phaseId.get(phaseKey(ctx.moduleId.get(r.module)!, r.phase)) ?? null) : null);

  if (ctx.keepRowNo) {
    // No. ที่เคยใช้กับงานที่ลบแล้ว: ปล่อยเลขแถวให้ใช้ซ้ำได้ (unique ต่อโปรเจกต์)
    const nos = rows.map((r) => r.no);
    if (nos.length) await tx.update(s.issues).set({ excelRowNo: null }).where(sql`${s.issues.projectId} = ${ctx.projectId} and ${s.issues.deletedAt} is not null and ${inArray(s.issues.excelRowNo, nos)}`);
  }

  const idOf = new Map<PlanRow, string>();
  // แม่ในไฟล์ใช้เลขงานเดิมในไฟล์อ้างถึง
  const fileParent = new Map(rows.filter((r) => r.number !== null && r.parentNumber === null).map((r) => [r.number!, r]));
  const parentOf = (r: PlanRow): { id: string; phaseId: string | null } | null => {
    const p = fileParent.get(r.parentNumber!);
    if (p && idOf.get(p)) return { id: idOf.get(p)!, phaseId: phaseOf(p) };
    return ctx.parents.get(r.parentNumber!) ?? null;
  };
  const tops = rows.filter((r) => r.parentNumber === null);
  const subs = rows.filter((r) => r.parentNumber !== null);
  for (const level of [tops, subs]) {
    for (const chunk of chunks(level, 200)) {
      const inserted = await tx
        .insert(s.issues)
        .values(
          chunk.map((r) => ({
            ...base,
            number: assigned.get(r)!,
            excelRowNo: ctx.keepRowNo ? r.no : null,
            issueTypeId: ctx.taskTypeId,
            parentId: r.parentNumber === null ? null : (parentOf(r)?.id ?? null),
            moduleId: ctx.moduleId.get(r.module)!,
            phaseId: r.parentNumber === null ? phaseOf(r) : (parentOf(r)?.phaseId ?? null),
            title: r.title,
            description: r.description,
            remark: r.remark,
            statusId: ctx.statusIdOf(r.status),
            priority: r.priority ?? 'medium',
            baId: ctx.userOf(r.ba),
            saId: ctx.userOf(r.sa),
            reviewerId: ctx.userOf(r.reviewer),
            reporterId: ctx.actorId,
            createdBy: ctx.actorId,
            size: r.size,
            estimateMd: r.estimateMd,
            planStart: r.planStart,
            planEnd: r.planEnd,
            actualStart: r.actualStart,
            actualEnd: r.actualEnd,
            details: { ...(r.requirementText ? { requirementText: r.requirementText } : {}), ...(ctx.details?.(r) ?? {}) },
          })),
        )
        .returning({ id: s.issues.id, number: s.issues.number });
      const rowOf = new Map(chunk.map((r) => [assigned.get(r)!, r]));
      inserted.forEach((x) => idOf.set(rowOf.get(x.number)!, x.id));
    }
  }

  const assignees = rows.flatMap((r) => [...new Set(r.devs.map(ctx.userOf).filter((u): u is string => !!u))].map((userId, i) => ({ ...ws, issueId: idOf.get(r)!, userId, sort: i })));
  const reqLinks = rows.flatMap((r) => [...new Set(r.requirements)].map((c) => ({ ...ws, issueId: idOf.get(r)!, requirementId: reqId.get(c)! })));
  const scrLinks = rows.flatMap((r) => [...new Set(r.screens)].map((c) => ({ ...ws, issueId: idOf.get(r)!, screenId: scrId.get(c)! })));
  const labelLinks = rows.flatMap((r) => [...new Set(r.labels.map((n) => labelId.get(n.toLowerCase())!))].map((id) => ({ ...ws, issueId: idOf.get(r)!, labelId: id })));
  for (const c of chunks(assignees, 500)) await tx.insert(s.issueAssignees).values(c);
  for (const c of chunks(reqLinks, 500)) await tx.insert(s.issueRequirements).values(c);
  for (const c of chunks(scrLinks, 500)) await tx.insert(s.issueScreens).values(c);
  for (const c of chunks(labelLinks, 500)) await tx.insert(s.issueLabels).values(c);
  for (const c of chunks(rows, 500)) {
    await tx.insert(s.activities).values(c.map((r) => ({ ...base, issueId: idOf.get(r)!, actorId: ctx.actorId, actorKind: 'import' as const, verb: 'imported', newValue: { fileName: ctx.fileName, ...(ctx.keepRowNo ? { no: r.no } : { row: r.rowNo }) } })));
  }
  const events: DomainEvent[] = rows.map((r) => ({
    type: 'issue.created',
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    issueId: idOf.get(r),
    actorId: ctx.actorId,
    data: { issueKey: `${ctx.projectKey}-${assigned.get(r)}`, type: 'Task', source: 'import' },
    at: new Date(),
  }));
  await tx.update(s.projects).set({ issueSeq: seq }).where(eq(s.projects.id, ctx.projectId));
  const phaseIdOf = new Map(rows.map((r) => [r, r.parentNumber === null ? phaseOf(r) : (parentOf(r)?.phaseId ?? null)]));
  return { idOf, numberOf: assigned, phaseIdOf, assignees, events, seq };
}

async function codes(tx: Tx, table: typeof s.requirements | typeof s.screens, projectId: string) {
  return new Map((await tx.select({ id: table.id, code: table.code }).from(table).where(eq(table.projectId, projectId))).map((x) => [x.code, x.id]));
}
