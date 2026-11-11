import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { IssuesService } from '../issues/issues.service.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { assertFullOrder, audit, color, type Context, issueEvent, loadContext, type Mode, name, nextSort, nonEmpty, ReorderBody } from './context.js';

const isoDate = z.iso.date();

export const CreateModuleBody = z.object({ name, color: color.nullish(), ownerUserId: z.uuid().nullish() }).strict();
export const PatchModuleBody = CreateModuleBody.partial().refine((v) => Object.keys(v).length > 0, nonEmpty);
/** moveTo = Module ปลายทางของงานทั้งหมด (บังคับเมื่อมีงาน) · moveToPhase = กลุ่มงานใน Module ปลายทาง (ไม่ส่ง = ไม่ระบุกลุ่มงาน) */
export const DeleteModuleBody = z.object({ moveTo: z.uuid().optional(), moveToPhase: z.uuid().optional() }).strict();
export const CreatePhaseBody = z.object({ name }).strict();
export const PatchPhaseBody = CreatePhaseBody;
/** moveTo = กลุ่มงานอื่นใน Module เดียวกัน หรือ "none" = ไม่ระบุกลุ่มงาน */
export const DeletePhaseBody = z.object({ moveTo: z.union([z.uuid(), z.literal('none')]).optional() }).strict();
export const CreateMilestoneBody = z.object({ name, date: isoDate, moduleId: z.uuid().nullish() }).strict();
export const PatchMilestoneBody = CreateMilestoneBody.partial().refine((v) => Object.keys(v).length > 0, nonEmpty);
export const MilestoneIssuesBody = z.object({ keys: z.array(z.string().trim().min(1).max(30)).min(1).max(500) }).strict();
export { ReorderBody };

type Module = typeof s.modules.$inferSelect;
type Phase = typeof s.phases.$inferSelect;
type Milestone = typeof s.milestones.$inferSelect;

/** Module, กลุ่มงาน (Phase) และ Milestone ของโปรเจกต์ */
@Injectable()
export class ModulesService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly issues: IssuesService,
    private readonly events: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  async listModules(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.read(auth, tenant, key, 'read', async (tx, { project }) => ({ items: await this.moduleDtos(tx, project) }));
  }

  async createModule(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateModuleBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      if (input.ownerUserId) await assertProjectMember(tx, project.id, input.ownerUserId);
      const current = await this.modules(tx, project.id);
      const [row] = await tx.insert(s.modules).values({ workspaceId: tenant.workspaceId, projectId: project.id, name: input.name, color: input.color ?? null, ownerUserId: input.ownerUserId ?? null, sort: nextSort(current) }).returning();
      await audit(tx, auth, tenant, project, 'project.module_created', `เพิ่ม Module ${row.name}`);
      return this.moduleDto(tx, project, row);
    });
  }

  async patchModule(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchModuleBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.module(tx, project.id, id);
      if (input.ownerUserId) await assertProjectMember(tx, project.id, input.ownerUserId);
      const [row] = await tx.update(s.modules).set(input).where(eq(s.modules.id, id)).returning();
      return this.moduleDto(tx, project, row);
    });
  }

  /**
   * ลบ Module: งาน (รวมงานในถังขยะ) ย้ายไป moveTo และเข้ากลุ่มงาน moveToPhase ของ Module นั้น (ไม่ส่ง = ไม่ระบุกลุ่มงาน)
   * กลุ่มงานของ Module ที่ลบถูกลบตาม · Milestone ไม่ผูก Module
   */
  async deleteModule(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof DeleteModuleBody>) {
    return this.write(auth, tenant, key, async (tx, { project }, events) => {
      const mod = await this.module(tx, project.id, id);
      const live = await countIssues(tx, eq(s.issues.moduleId, id));
      if (input.moveTo === id) throw new AppError(400, 'invalid_move_to', 'ต้องย้ายงานไป Module อื่น');
      if (live && !input.moveTo) throw new AppError(409, 'module_has_issues', `Module นี้มีงาน ${live} งาน ต้องเลือก Module ที่จะย้ายงานไป`, { issueCount: live });
      const target = input.moveTo ? await this.module(tx, project.id, input.moveTo) : null;
      if (input.moveToPhase && !target) throw new AppError(400, 'invalid_move_to', 'ต้องเลือก Module ปลายทางก่อนเลือกกลุ่มงาน');
      const phase = input.moveToPhase && target ? await this.phase(tx, project.id, target.id, input.moveToPhase) : null;

      // ต้องอ่านกลุ่มงานเดิมก่อนแก้ เพื่อเขียนประวัติได้ถูก
      const before = await tx.select().from(s.issues).where(eq(s.issues.moduleId, id)).orderBy(asc(s.issues.number));
      // งานในถังขยะไม่มี Module ปลายทางเมื่อไม่มีงานที่ยังอยู่ จึงไม่มีกลุ่มงานด้วย
      const phaseId = target ? (phase?.id ?? null) : null;
      await tx.update(s.issues).set({ moduleId: target?.id ?? null, phaseId }).where(eq(s.issues.moduleId, id));
      await this.recordMoves(tx, tenant, auth, project, before, events, (i) => [
        { field: 'moduleId', oldValue: id, newValue: target?.id ?? null },
        ...(before[i].phaseId !== phaseId ? [{ field: 'phaseId', oldValue: before[i].phaseId, newValue: phaseId }] : []),
      ]);
      await tx.update(s.milestones).set({ moduleId: null }).where(eq(s.milestones.moduleId, id));
      await tx.delete(s.modules).where(eq(s.modules.id, id));
      await audit(tx, auth, tenant, project, 'project.module_deleted', `ลบ Module ${mod.name}${target ? ` ย้ายงาน ${live} งานไป ${target.name}${phase ? ` › ${phase.name}` : ''}` : ''}`);
      return { id, movedIssues: live, moveTo: target?.id ?? null, moveToPhase: phase?.id ?? null };
    });
  }

  async reorderModules(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof ReorderBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      assertFullOrder(await this.modules(tx, project.id), input.ids);
      for (const [sort, id] of input.ids.entries()) await tx.update(s.modules).set({ sort }).where(eq(s.modules.id, id));
      return { items: await this.moduleDtos(tx, project) };
    });
  }

  // ---------------------------------------------------------------------------
  // กลุ่มงาน (Phase)
  // ---------------------------------------------------------------------------
  async listPhases(auth: AuthInfo, tenant: TenantInfo, key: string, moduleId: string) {
    return this.read(auth, tenant, key, 'read', async (tx, { project }) => {
      await this.module(tx, project.id, moduleId);
      return { items: await this.phaseDtos(tx, moduleId) };
    });
  }

  async createPhase(auth: AuthInfo, tenant: TenantInfo, key: string, moduleId: string, input: z.infer<typeof CreatePhaseBody>) {
    return this.write(auth, tenant, key, 'group', async (tx, { project }) => {
      await this.module(tx, project.id, moduleId);
      const current = await this.phases(tx, moduleId);
      const [row] = await tx.insert(s.phases).values({ workspaceId: tenant.workspaceId, projectId: project.id, moduleId, name: input.name, sort: nextSort(current) }).returning();
      return { ...phaseDto(row), issueCount: 0 };
    });
  }

  async patchPhase(auth: AuthInfo, tenant: TenantInfo, key: string, moduleId: string, id: string, input: z.infer<typeof PatchPhaseBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.phase(tx, project.id, moduleId, id);
      const [row] = await tx.update(s.phases).set({ name: input.name }).where(eq(s.phases.id, id)).returning();
      return { ...phaseDto(row), issueCount: await countIssues(tx, eq(s.issues.phaseId, id)) };
    });
  }

  async deletePhase(auth: AuthInfo, tenant: TenantInfo, key: string, moduleId: string, id: string, input: z.infer<typeof DeletePhaseBody>) {
    return this.write(auth, tenant, key, async (tx, { project }, events) => {
      const phase = await this.phase(tx, project.id, moduleId, id);
      const live = await countIssues(tx, eq(s.issues.phaseId, id));
      if (input.moveTo === id) throw new AppError(400, 'invalid_move_to', 'ต้องย้ายงานไปกลุ่มงานอื่น');
      if (live && !input.moveTo) throw new AppError(409, 'phase_has_issues', `กลุ่มงานนี้มีงาน ${live} งาน ต้องเลือกกลุ่มงานที่จะย้ายงานไป`, { issueCount: live });
      // ย้ายข้าม Module ไม่ได้ เพราะ Sub-task และตัวกรองของ Table อ้าง Module เดิม
      const target = input.moveTo && input.moveTo !== 'none' ? await this.phase(tx, project.id, moduleId, input.moveTo) : null;
      const moved = await tx.update(s.issues).set({ phaseId: target?.id ?? null }).where(eq(s.issues.phaseId, id)).returning();
      await this.recordMoves(tx, tenant, auth, project, moved, events, () => [{ field: 'phaseId', oldValue: id, newValue: target?.id ?? null }]);
      await tx.delete(s.phases).where(eq(s.phases.id, id));
      await audit(tx, auth, tenant, project, 'project.phase_deleted', `ลบกลุ่มงาน ${phase.name}`);
      return { id, movedIssues: live, moveTo: target?.id ?? null };
    });
  }

  async reorderPhases(auth: AuthInfo, tenant: TenantInfo, key: string, moduleId: string, input: z.infer<typeof ReorderBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.module(tx, project.id, moduleId);
      assertFullOrder(await this.phases(tx, moduleId), input.ids);
      for (const [sort, id] of input.ids.entries()) await tx.update(s.phases).set({ sort }).where(eq(s.phases.id, id));
      return { items: await this.phaseDtos(tx, moduleId) };
    });
  }

  // ---------------------------------------------------------------------------
  // Milestone · อ่านได้ทุกคนที่เห็นโปรเจกต์ เพราะ Overview / Timeline ใช้ด้วย
  // ---------------------------------------------------------------------------
  async listMilestones(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.read(auth, tenant, key, 'view', async (tx, ctx) => {
      const rows = await tx.select().from(s.milestones).where(eq(s.milestones.projectId, ctx.project.id)).orderBy(asc(s.milestones.date), asc(s.milestones.name));
      return { items: await this.milestoneDtos(tx, ctx, rows) };
    });
  }

  async createMilestone(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateMilestoneBody>) {
    return this.write(auth, tenant, key, async (tx, ctx) => {
      if (input.moduleId) await this.module(tx, ctx.project.id, input.moduleId);
      const [row] = await tx.insert(s.milestones).values({ workspaceId: tenant.workspaceId, projectId: ctx.project.id, name: input.name, date: input.date, moduleId: input.moduleId ?? null }).returning();
      await audit(tx, auth, tenant, ctx.project, 'project.milestone_created', `เพิ่ม Milestone ${row.name} (${row.date})`, 'plan');
      return (await this.milestoneDtos(tx, ctx, [row]))[0];
    });
  }

  async patchMilestone(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchMilestoneBody>) {
    return this.write(auth, tenant, key, async (tx, ctx) => {
      const before = await this.milestone(tx, ctx.project.id, id);
      if (input.moduleId) await this.module(tx, ctx.project.id, input.moduleId);
      const [row] = await tx.update(s.milestones).set(input).where(eq(s.milestones.id, id)).returning();
      if (input.date && input.date !== before.date) await audit(tx, auth, tenant, ctx.project, 'project.milestone_moved', `เลื่อน Milestone ${row.name} ${before.date} → ${row.date}`, 'plan');
      return (await this.milestoneDtos(tx, ctx, [row]))[0];
    });
  }

  async deleteMilestone(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.write(auth, tenant, key, async (tx, ctx) => {
      const row = await this.milestone(tx, ctx.project.id, id);
      await tx.delete(s.milestones).where(eq(s.milestones.id, id));
      await audit(tx, auth, tenant, ctx.project, 'project.milestone_deleted', `ลบ Milestone ${row.name}`, 'plan');
    });
  }

  async milestoneIssues(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.read(auth, tenant, key, 'view', async (tx, ctx) => {
      await this.milestone(tx, ctx.project.id, id);
      return { items: await this.milestoneIssueDtos(tx, ctx, id) };
    });
  }

  async addMilestoneIssues(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof MilestoneIssuesBody>) {
    return this.write(auth, tenant, key, async (tx, ctx) => {
      await this.milestone(tx, ctx.project.id, id);
      const ids = new Set<string>();
      for (const k of input.keys) ids.add((await this.issues.findByKey(tx, ctx.project, k)).id);
      await tx.insert(s.milestoneIssues).values([...ids].map((issueId) => ({ workspaceId: tenant.workspaceId, milestoneId: id, issueId }))).onConflictDoNothing();
      return { items: await this.milestoneIssueDtos(tx, ctx, id) };
    });
  }

  async removeMilestoneIssue(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, issueKey: string) {
    await this.write(auth, tenant, key, async (tx, ctx) => {
      await this.milestone(tx, ctx.project.id, id);
      const issue = await this.issues.findByKey(tx, ctx.project, issueKey, { includeDeleted: true });
      const removed = await tx.delete(s.milestoneIssues).where(and(eq(s.milestoneIssues.milestoneId, id), eq(s.milestoneIssues.issueId, issue.id))).returning();
      if (!removed.length) throw notFound('งานนี้ใน Milestone');
    });
  }

  // ---------------------------------------------------------------------------
  // ภายใน
  // ---------------------------------------------------------------------------
  private read<T>(auth: AuthInfo, tenant: TenantInfo, key: string, mode: Mode, fn: (tx: Tx, ctx: Context) => Promise<T>) {
    return this.db.run(auth, tenant, async (tx) => fn(tx, await loadContext(tx, this.projects, auth, tenant, key, mode)));
  }

  private async write<T>(auth: AuthInfo, tenant: TenantInfo, key: string, modeOrFn: 'group' | ((tx: Tx, ctx: Context, events: DomainEvent[]) => Promise<T>), maybeFn?: (tx: Tx, ctx: Context, events: DomainEvent[]) => Promise<T>) {
    const events: DomainEvent[] = [];
    const [mode, fn] = typeof modeOrFn === 'string' ? [modeOrFn, maybeFn!] : ['write' as const, modeOrFn];
    const result = await this.db.run(auth, tenant, async (tx) => fn(tx, await loadContext(tx, this.projects, auth, tenant, key, mode), events));
    await this.events.publish(events);
    return result;
  }

  /** ประวัติของงานที่ถูกย้ายเพราะลบ Module / กลุ่มงาน · ส่ง issue.updated เฉพาะงานที่ยังไม่อยู่ในถังขยะ */
  private async recordMoves(
    tx: Tx, tenant: TenantInfo, auth: AuthInfo, project: ProjectRow, moved: (typeof s.issues.$inferSelect)[], events: DomainEvent[],
    fields: (i: number) => { field: string; oldValue: unknown; newValue: unknown }[],
  ) {
    for (const [i, issue] of moved.entries()) {
      if (issue.deletedAt) continue;
      const changes = fields(i);
      await tx.insert(s.activities).values(changes.map((c) => ({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, verb: 'updated', ...c })));
      events.push(issueEvent(tenant, project, auth.userId, issue)('issue.updated', { fields: changes.map((c) => c.field) }));
    }
  }

  private modules(tx: Tx, projectId: string) {
    return tx.select().from(s.modules).where(eq(s.modules.projectId, projectId)).orderBy(asc(s.modules.sort), asc(s.modules.name));
  }

  private phases(tx: Tx, moduleId: string) {
    return tx.select().from(s.phases).where(eq(s.phases.moduleId, moduleId)).orderBy(asc(s.phases.sort), asc(s.phases.name));
  }

  private async module(tx: Tx, projectId: string, id: string) {
    const [row] = await tx.select().from(s.modules).where(and(eq(s.modules.projectId, projectId), eq(s.modules.id, id)));
    if (!row) throw notFound('Module');
    return row;
  }

  private async phase(tx: Tx, projectId: string, moduleId: string, id: string) {
    const [row] = await tx.select().from(s.phases).where(and(eq(s.phases.projectId, projectId), eq(s.phases.moduleId, moduleId), eq(s.phases.id, id)));
    if (!row) throw notFound('กลุ่มงาน');
    return row;
  }

  private async milestone(tx: Tx, projectId: string, id: string) {
    const [row] = await tx.select().from(s.milestones).where(and(eq(s.milestones.projectId, projectId), eq(s.milestones.id, id)));
    if (!row) throw notFound('Milestone');
    return row;
  }

  private async moduleDtos(tx: Tx, project: ProjectRow) {
    const mods = await this.modules(tx, project.id);
    const phases = await tx.select().from(s.phases).where(eq(s.phases.projectId, project.id)).orderBy(asc(s.phases.sort), asc(s.phases.name));
    const counts = await issueCounts(tx, project.id);
    const people = await loadPeople(tx, mods.map((m) => m.ownerUserId));
    return mods.map((m) => ({
      ...moduleDto(m),
      owner: m.ownerUserId ? (people.get(m.ownerUserId) ?? null) : null,
      issueCount: counts.modules.get(m.id) ?? 0,
      phases: phases.filter((p) => p.moduleId === m.id).map((p) => ({ ...phaseDto(p), issueCount: counts.phases.get(p.id) ?? 0 })),
    }));
  }

  private async moduleDto(tx: Tx, project: ProjectRow, m: Module) {
    return (await this.moduleDtos(tx, project)).find((x) => x.id === m.id)!;
  }

  private async phaseDtos(tx: Tx, moduleId: string) {
    const rows = await this.phases(tx, moduleId);
    const counts = await tx
      .select({ id: s.issues.phaseId, n: sql<number>`count(*)::int` })
      .from(s.issues)
      .where(and(eq(s.issues.moduleId, moduleId), isNull(s.issues.deletedAt)))
      .groupBy(s.issues.phaseId);
    const byId = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((p) => ({ ...phaseDto(p), issueCount: byId.get(p.id) ?? 0 }));
  }

  /**
   * % ของ Milestone ถ่วงด้วย Man-Day ของงานที่ผูก (ผู้ใช้ตัดสิน 9 พ.ย. 2026) · Task ที่มี Sub-task ใช้ MD และความคืบหน้ารวมของ Sub-task
   * ถ้างานที่ผูกไม่มี MD เลย ใช้ค่าเฉลี่ยแทน · Guest ที่เป็น Viewer ไม่นับ Bug
   */
  private async milestoneDtos(tx: Tx, ctx: Context, rows: Milestone[]) {
    if (!rows.length) return [];
    const cols = {
      id: s.issues.id,
      parentId: s.issues.parentId,
      estimateMd: s.issues.estimateMd,
      progressPct: s.issues.progressPct,
      category: s.workflowStatuses.category,
      type: s.issueTypes.name,
    };
    const linked = await tx
      .select({ milestoneId: s.milestoneIssues.milestoneId, ...cols })
      .from(s.milestoneIssues)
      .innerJoin(s.issues, eq(s.issues.id, s.milestoneIssues.issueId))
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
      .where(and(inArray(s.milestoneIssues.milestoneId, rows.map((r) => r.id)), isNull(s.issues.deletedAt)));
    const parentIds = [...new Set(linked.map((l) => l.id))];
    const kids = parentIds.length
      ? await tx
          .select(cols)
          .from(s.issues)
          .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
          .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
          .where(and(inArray(s.issues.parentId, parentIds), isNull(s.issues.deletedAt), ne(s.issueTypes.name, 'Bug')))
      : [];
    const childrenOf = new Map<string, typeof kids>();
    for (const k of kids) childrenOf.set(k.parentId!, [...(childrenOf.get(k.parentId!) ?? []), k]);
    type Row = (typeof kids)[number];
    const mdOf = (i: Row): number => {
      const c = childrenOf.get(i.id);
      return c?.length ? c.reduce((n, k) => n + mdOf(k), 0) : Number(i.estimateMd ?? 0);
    };
    const pctOf = (i: Row): number => {
      if (i.category === 'done') return 100;
      const c = childrenOf.get(i.id)?.filter((k) => k.category !== 'cancelled');
      return c?.length ? weightedPct(c.map((k) => ({ md: mdOf(k), pct: pctOf(k) }))) : (i.progressPct ?? 0);
    };
    const mods = await tx.select({ id: s.modules.id, name: s.modules.name, color: s.modules.color }).from(s.modules).where(eq(s.modules.projectId, ctx.project.id));
    return rows.map((m) => {
      // งานที่ยกเลิกไม่นับใน Milestone
      const mine = linked.filter((l) => l.milestoneId === m.id && l.category !== 'cancelled' && !(ctx.access.guestViewer && l.type === 'Bug'));
      const done = mine.filter((l) => l.category === 'done').length;
      // ผูกทั้ง Task และ Sub-task ของมัน: นับที่ Task (ลูกคิดผ่านแม่แล้ว) ไม่ให้ MD ซ้ำ
      const ids = new Set(mine.map((l) => l.id));
      const roots = mine.filter((l) => !l.parentId || !ids.has(l.parentId));
      return {
        id: m.id,
        name: m.name,
        date: m.date,
        moduleId: m.moduleId,
        module: mods.find((x) => x.id === m.moduleId) ?? null,
        issueCount: mine.length,
        doneCount: done,
        progressPct: weightedPct(roots.map((l) => ({ md: mdOf(l), pct: pctOf(l) }))),
      };
    });
  }

  private async milestoneIssueDtos(tx: Tx, ctx: Context, milestoneId: string) {
    const rows = await tx
      .select({ issue: s.issues, status: s.workflowStatuses, type: s.issueTypes })
      .from(s.milestoneIssues)
      .innerJoin(s.issues, eq(s.issues.id, s.milestoneIssues.issueId))
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
      .where(and(eq(s.milestoneIssues.milestoneId, milestoneId), isNull(s.issues.deletedAt)))
      .orderBy(asc(s.issues.number));
    // Guest ที่เป็น Viewer: ไม่เห็น Bug และเปิดได้เฉพาะงานที่แชร์ (04-permissions ข้อ 4)
    const visible = ctx.access.guestViewer ? rows.filter((r) => r.type.name !== 'Bug') : rows;
    return visible.map(({ issue, status, type }) => ({
      key: `${ctx.project.key}-${issue.number}`,
      title: issue.title,
      type: { name: type.name, color: type.color },
      status: { id: status.id, name: status.name, category: status.category },
      planEnd: issue.planEnd,
      ...(ctx.access.guestViewer ? { canOpen: issue.sharedWithGuests } : {}),
    }));
  }
}

function moduleDto(m: Module) {
  return { id: m.id, name: m.name, color: m.color, ownerUserId: m.ownerUserId, sort: m.sort };
}

function phaseDto(p: Phase) {
  return { id: p.id, moduleId: p.moduleId, name: p.name, sort: p.sort };
}

/** จำนวนงานที่ยังไม่อยู่ในถังขยะ */
async function countIssues(tx: Tx, where: ReturnType<typeof eq>) {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.issues).where(and(where, isNull(s.issues.deletedAt)));
  return row.n;
}

async function issueCounts(tx: Tx, projectId: string) {
  const rows = await tx
    .select({ moduleId: s.issues.moduleId, phaseId: s.issues.phaseId, n: sql<number>`count(*)::int` })
    .from(s.issues)
    .where(and(eq(s.issues.projectId, projectId), isNull(s.issues.deletedAt)))
    .groupBy(s.issues.moduleId, s.issues.phaseId);
  const modules = new Map<string, number>();
  const phases = new Map<string, number>();
  for (const r of rows) {
    if (r.moduleId) modules.set(r.moduleId, (modules.get(r.moduleId) ?? 0) + r.n);
    if (r.phaseId) phases.set(r.phaseId, (phases.get(r.phaseId) ?? 0) + r.n);
  }
  return { modules, phases };
}

/** เจ้าของ Module (Dev หลัก) ต้องเป็นสมาชิกโปรเจกต์ */
async function assertProjectMember(tx: Tx, projectId: string, userId: string) {
  const [m] = await tx.select({ userId: s.projectMembers.userId }).from(s.projectMembers).where(and(eq(s.projectMembers.projectId, projectId), eq(s.projectMembers.userId, userId)));
  if (!m) throw new AppError(400, 'invalid_people', 'เจ้าของ Module ต้องเป็นสมาชิกของโปรเจกต์', { userIds: [userId] });
}

/** ค่าเฉลี่ยถ่วง Man-Day · ไม่มี MD เลยใช้ค่าเฉลี่ยธรรมดา */
function weightedPct(items: { md: number; pct: number }[]) {
  if (!items.length) return 0;
  const total = items.reduce((n, x) => n + x.md, 0);
  if (!total) return Math.round(items.reduce((n, x) => n + x.pct, 0) / items.length);
  return Math.round(items.reduce((n, x) => n + x.pct * x.md, 0) / total);
}
