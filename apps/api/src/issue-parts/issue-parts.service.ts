import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { IssuesService } from '../issues/issues.service.js';
import { addDays, WorkCalendar } from '../projects/calendar.js';
import { requirePerm } from '../projects/permissions.js';

const kind = z.enum(['checklist', 'acceptance']);
const text = z.string().trim().min(1).max(5000);
export const ChecklistId = z.uuid();
export const ChecklistQuery = z.object({ kind: kind.optional() });
export const CreateChecklistBody = z.object({ text, kind: kind.default('checklist'), done: z.boolean().default(false) }).strict();
export const PatchChecklistBody = z.object({ text: text.optional(), kind: kind.optional(), done: z.boolean().optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'ระบุฟิลด์ที่ต้องการแก้ไข' });
export const ReorderChecklistBody = z.object({ ids: z.array(z.uuid()).max(1000), kind: kind.optional() }).strict();

const peer = {
  predecessorKey: z.string().trim().min(1).max(30).optional(),
  successorKey: z.string().trim().min(1).max(30).optional(),
};
const onePeer = (v: { predecessorKey?: string; successorKey?: string }) => !!v.predecessorKey !== !!v.successorKey;
const dependencyType = z.enum(['FS', 'SS', 'FF', 'SF']);
const lagDays = z.number().int().min(-32768).max(32767);
export const DependencyPeerBody = z.object({ ...peer, type: dependencyType.optional(), lagDays: lagDays.optional() }).strict()
  .refine(onePeer, { message: 'ระบุ predecessorKey หรือ successorKey อย่างใดอย่างหนึ่ง' });
export const CreateDependencyBody = z.object({
  ...peer,
  type: dependencyType.default('FS'),
  lagDays: lagDays.default(0),
}).strict().refine(onePeer, { message: 'ระบุ predecessorKey หรือ successorKey อย่างใดอย่างหนึ่ง' });

type Context = Awaited<ReturnType<IssuesService['loadIssue']>>;
type Item = typeof s.checklistItems.$inferSelect;
type Dependency = typeof s.issueDependencies.$inferSelect;
type Warning = { code: string; message: string };

@Injectable()
export class IssuePartsService {
  constructor(private readonly db: TenantDb, private readonly issues: IssuesService, private readonly events: EventBus) {}

  async checklist(auth: AuthInfo, tenant: TenantInfo, key: string, filter?: Item['kind']) {
    return this.db.run(auth, tenant, async (tx) => {
      const ctx = await this.load(tx, auth, tenant, key);
      return { items: await this.items(tx, ctx.issue.id, filter) };
    });
  }

  async checklistItem(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const ctx = await this.load(tx, auth, tenant, key);
      return this.item(tx, ctx.issue.id, id);
    });
  }

  async createChecklist(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateChecklistBody>) {
    return this.mutate(auth, tenant, key, async (tx, ctx, events) => {
      const current = await this.items(tx, ctx.issue.id, input.kind);
      const [item] = await tx.insert(s.checklistItems).values({
        workspaceId: tenant.workspaceId, issueId: ctx.issue.id, ...input,
        sort: current.reduce((max, i) => Math.max(max, i.sort), -1) + 1,
        doneBy: input.done ? auth.userId : null,
        doneAt: input.done ? new Date() : null,
      }).returning();
      await this.record(tx, auth, tenant, ctx, events, 'checklist', null, item);
      return item;
    });
  }

  async patchChecklist(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchChecklistBody>) {
    return this.mutate(auth, tenant, key, async (tx, ctx, events) => {
      const before = await this.item(tx, ctx.issue.id, id);
      const set: Partial<typeof s.checklistItems.$inferInsert> = { ...input };
      // ติ๊กซ้ำไม่เปลี่ยนผู้ทำและเวลาของการทำเสร็จครั้งเดิม
      if (input.done !== undefined && input.done !== before.done) {
        set.doneBy = input.done ? auth.userId : null;
        set.doneAt = input.done ? new Date() : null;
      }
      if (input.kind && input.kind !== before.kind) {
        const target = await this.items(tx, ctx.issue.id, input.kind);
        set.sort = target.reduce((max, i) => Math.max(max, i.sort), -1) + 1;
      }
      const [item] = await tx.update(s.checklistItems).set(set).where(and(eq(s.checklistItems.id, id), eq(s.checklistItems.issueId, ctx.issue.id))).returning();
      await this.record(tx, auth, tenant, ctx, events, 'checklist', before, item);
      return item;
    });
  }

  async deleteChecklist(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.mutate(auth, tenant, key, async (tx, ctx, events) => {
      const before = await this.item(tx, ctx.issue.id, id);
      await tx.delete(s.checklistItems).where(and(eq(s.checklistItems.id, id), eq(s.checklistItems.issueId, ctx.issue.id)));
      await this.record(tx, auth, tenant, ctx, events, 'checklist', before, null);
    });
  }

  async reorderChecklist(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof ReorderChecklistBody>) {
    return this.mutate(auth, tenant, key, async (tx, ctx, events) => {
      const current = await this.items(tx, ctx.issue.id, input.kind);
      const ids = new Set(input.ids);
      if (ids.size !== input.ids.length || ids.size !== current.length || current.some((i) => !ids.has(i.id))) {
        throw new AppError(400, 'invalid_reorder', 'ต้องส่งรายการของงานและหมวดนี้ให้ครบ โดยไม่ซ้ำกัน');
      }
      for (const [sort, id] of input.ids.entries()) {
        await tx.update(s.checklistItems).set({ sort }).where(and(eq(s.checklistItems.id, id), eq(s.checklistItems.issueId, ctx.issue.id)));
      }
      await this.record(tx, auth, tenant, ctx, events, 'checklist', { ids: current.map((i) => i.id), kind: input.kind }, input);
      return { items: await this.items(tx, ctx.issue.id, input.kind) };
    });
  }

  async dependencies(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const ctx = await this.load(tx, auth, tenant, key);
      return this.dependencyDto(tx, ctx);
    });
  }

  async createDependency(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateDependencyBody>) {
    return this.mutateDependency(auth, tenant, key, input, async (tx, ctx, other, pair, events) => {
      const edges = await tx.select({ from: s.issueDependencies.predecessorId, to: s.issueDependencies.successorId })
        .from(s.issueDependencies).innerJoin(s.issues, eq(s.issues.id, s.issueDependencies.predecessorId))
        .where(eq(s.issues.projectId, ctx.project.id));
      if (pair.predecessorId === pair.successorId || reachable(edges, pair.successorId, pair.predecessorId)) {
        throw new AppError(409, 'dependency_cycle', 'Dependency นี้ทำให้เกิดการวนรอบ');
      }
      if (edges.some((e) => e.from === pair.predecessorId && e.to === pair.successorId)) {
        throw new AppError(409, 'dependency_exists', 'มี Dependency ระหว่างสองงานนี้แล้ว');
      }
      const [edge] = await tx.insert(s.issueDependencies).values({ workspaceId: tenant.workspaceId, ...pair, type: input.type, lagDays: input.lagDays }).returning();
      await this.recordDependency(tx, auth, tenant, ctx, other, events, null, edge);
      const predecessor = input.predecessorKey ? other.issue : ctx.issue;
      const successor = input.predecessorKey ? ctx.issue : other.issue;
      const warnings: Warning[] = [];
      if (input.type === 'FS' && predecessor.planEnd && successor.planStart) {
        const calendar = await WorkCalendar.load(tx, ctx.project);
        let earliest = predecessor.planEnd;
        const step = Math.sign(input.lagDays);
        for (let remaining = Math.abs(input.lagDays), scanned = 0; remaining > 0;) {
          if (++scanned > 366 + Math.abs(input.lagDays) * 14) throw new AppError(422, 'invalid_work_calendar', 'ปฏิทินไม่มีวันทำการเพียงพอสำหรับระยะรอนี้');
          earliest = addDays(earliest, step);
          if (calendar.isWorkingDay(earliest)) remaining--;
        }
        if (successor.planStart < earliest) warnings.push({ code: 'dependency_date_conflict', message: `งาน ${ctx.project.key}-${successor.number} เริ่มก่อนวันจบและระยะรอของงาน ${ctx.project.key}-${predecessor.number}` });
      }
      return { ...(await this.dependencyDto(tx, ctx)), warnings };
    });
  }

  async deleteDependency(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof DependencyPeerBody>) {
    return this.mutateDependency(auth, tenant, key, input, async (tx, ctx, other, pair, events) => {
      const [edge] = await tx.delete(s.issueDependencies).where(and(eq(s.issueDependencies.predecessorId, pair.predecessorId), eq(s.issueDependencies.successorId, pair.successorId))).returning();
      if (!edge) throw notFound('Dependency');
      await this.recordDependency(tx, auth, tenant, ctx, other, events, edge, null);
      return this.dependencyDto(tx, ctx);
    });
  }

  private async load(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, write = false) {
    const ctx = await this.issues.loadIssue(tx, auth, tenant, key);
    requirePerm(ctx.access, 'issue.edit');
    if (ctx.access.guestViewer) throw new AppError(403, 'forbidden', 'Guest ที่เป็น Viewer แก้ไขงานไม่ได้', { permission: 'issue.edit' });
    if (write && (ctx.project.archivedAt || ctx.project.status === 'archived')) throw new AppError(403, 'project_archived', 'โปรเจกต์ที่เก็บถาวรแก้ไขไม่ได้');
    return ctx;
  }

  private async items(tx: Tx, issueId: string, filter?: Item['kind']) {
    return tx.select().from(s.checklistItems).where(and(eq(s.checklistItems.issueId, issueId), filter ? eq(s.checklistItems.kind, filter) : undefined))
      .orderBy(asc(s.checklistItems.sort), asc(s.checklistItems.id));
  }

  private async item(tx: Tx, issueId: string, id: string) {
    const [item] = await tx.select().from(s.checklistItems).where(and(eq(s.checklistItems.issueId, issueId), eq(s.checklistItems.id, id)));
    if (!item) throw notFound('รายการ Checklist');
    return item;
  }

  private async mutate<T>(auth: AuthInfo, tenant: TenantInfo, key: string, fn: (tx: Tx, ctx: Context, events: DomainEvent[]) => Promise<T>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const ctx = await this.load(tx, auth, tenant, key, true);
      // ให้การเพิ่ม / ลบ / จัดลำดับของงานเดียวกันเห็นผลที่ commit ล่าสุด
      await tx.select({ id: s.issues.id }).from(s.issues).where(eq(s.issues.id, ctx.issue.id)).for('update');
      const fresh = await this.load(tx, auth, tenant, key, true);
      return fn(tx, fresh, events);
    });
    await this.events.publish(events);
    return result;
  }

  private async mutateDependency<T>(
    auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof DependencyPeerBody>,
    fn: (tx: Tx, ctx: Context, other: Context, pair: Pick<Dependency, 'predecessorId' | 'successorId'>, events: DomainEvent[]) => Promise<T>,
  ) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      let ctx = await this.load(tx, auth, tenant, key, true);
      // ล็อกกราฟทั้งโปรเจกต์ก่อนตรวจเส้นทาง ป้องกันคำขอสองชุดสร้างวงรอบพร้อมกัน
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-dependencies:' + ctx.project.id}, 0))`);
      ctx = await this.load(tx, auth, tenant, key, true);
      const otherKey = input.predecessorKey ?? input.successorKey!;
      const otherIssue = await this.issues.findByKey(tx, ctx.project, otherKey);
      const other: Context = { ...ctx, issue: otherIssue };
      const pair = input.predecessorKey
        ? { predecessorId: otherIssue.id, successorId: ctx.issue.id }
        : { predecessorId: ctx.issue.id, successorId: otherIssue.id };
      return fn(tx, ctx, other, pair, events);
    });
    await this.events.publish(events);
    return result;
  }

  private async dependencyDto(tx: Tx, ctx: Context) {
    const rows = await tx.select({ edge: s.issueDependencies }).from(s.issueDependencies)
      .where(or(eq(s.issueDependencies.predecessorId, ctx.issue.id), eq(s.issueDependencies.successorId, ctx.issue.id)));
    const ids = [...new Set(rows.flatMap(({ edge }) => [edge.predecessorId, edge.successorId]))];
    const issues = ids.length ? await tx.select({
      id: s.issues.id, number: s.issues.number, title: s.issues.title, planStart: s.issues.planStart, planEnd: s.issues.planEnd,
      actualStart: s.issues.actualStart, actualEnd: s.issues.actualEnd,
      status: { id: s.workflowStatuses.id, name: s.workflowStatuses.name, category: s.workflowStatuses.category },
    }).from(s.issues).innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .where(and(inArray(s.issues.id, ids), eq(s.issues.projectId, ctx.project.id), isNull(s.issues.deletedAt))).orderBy(asc(s.issues.number)) : [];
    const byId = new Map(issues.map((i) => [i.id, i]));
    type Link = (typeof issues)[number] & { key: string; predecessorKey: string; successorKey: string; type: Dependency['type']; lagDays: number };
    const blockedBy: Link[] = [];
    const blocking: Link[] = [];
    for (const { edge } of rows) {
      const predecessor = byId.get(edge.predecessorId);
      const successor = byId.get(edge.successorId);
      if (!predecessor || !successor) continue;
      const before = edge.successorId === ctx.issue.id;
      const other = before ? predecessor : successor;
      const dto = {
        ...other, key: `${ctx.project.key}-${other.number}`,
        predecessorKey: `${ctx.project.key}-${predecessor.number}`, successorKey: `${ctx.project.key}-${successor.number}`,
        type: edge.type, lagDays: edge.lagDays,
      };
      (before ? blockedBy : blocking).push(dto);
    }
    blockedBy.sort((a, b) => a.number - b.number);
    blocking.sort((a, b) => a.number - b.number);
    return { blockedBy, blocking };
  }

  private async record(tx: Tx, auth: AuthInfo, tenant: TenantInfo, ctx: Context, events: DomainEvent[], field: 'checklist' | 'dependencies', oldValue: unknown, newValue: unknown) {
    await tx.insert(s.activities).values({ workspaceId: tenant.workspaceId, projectId: ctx.project.id, issueId: ctx.issue.id, actorId: auth.userId, verb: 'updated', field, oldValue, newValue });
    events.push({
      type: 'issue.updated', workspaceId: tenant.workspaceId, projectId: ctx.project.id, issueId: ctx.issue.id, actorId: auth.userId,
      data: { issueKey: `${ctx.project.key}-${ctx.issue.number}`, title: ctx.issue.title, fields: [field] }, at: new Date(),
    });
  }

  private async recordDependency(tx: Tx, auth: AuthInfo, tenant: TenantInfo, ctx: Context, other: Context, events: DomainEvent[], before: Dependency | null, after: Dependency | null) {
    await this.record(tx, auth, tenant, ctx, events, 'dependencies', before, after);
    await this.record(tx, auth, tenant, other, events, 'dependencies', before, after);
  }
}

function reachable(edges: { from: string; to: string }[], start: string, target: string) {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!next.has(edge.from)) next.set(edge.from, []);
    next.get(edge.from)!.push(edge.to);
  }
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(next.get(id) ?? []));
  }
  return false;
}
