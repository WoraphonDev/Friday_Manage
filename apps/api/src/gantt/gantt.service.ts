import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { WorkCalendar } from '../projects/calendar.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ViewsService } from '../views/views.service.js';
import { Axis, autoSchedule, criticalPath, DependencyCycleError, edgeKey, type Edge, type Node } from './cpm.js';

const s = schema;
const isoDate = z.iso.date();

/** `v2` หรือ `2` → 2 */
const Version = z.string().regex(/^v?\d+$/, 'baseline ต้องเป็น v1, v2 …').transform((v) => Number(v.replace('v', '')));

export const GanttQuery = z
  .object({ from: isoDate.optional(), to: isoDate.optional(), baseline: Version.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'to ต้องไม่ก่อน from' });
export const CreateBaselineBody = z.object({ name: z.string().trim().min(1).max(100).optional() });
export const PlanChangesQuery = z.object({
  baseline: Version.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  before: z.iso.datetime().optional(),
});
export const XlsxQuery = z.object({ baseline: Version.optional() });

type Issue = typeof s.issues.$inferSelect;
const FIELD_LABELS: Record<string, string> = { planStart: 'Plan Start', planEnd: 'Plan End', estimateMd: 'Man-Day', assignees: 'Dev', assigneeIds: 'Dev' };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

interface PlanData {
  issues: Issue[];
  keyOf: Map<string, string>;
  doneIds: Set<string>;
  /** งานที่มี Sub-task: เป็นตัวสรุป ไม่ใช้เป็นโหนดคำนวณ */
  summaryIds: Set<string>;
  edges: Array<Edge & { type: Edge['type'] }>;
  ignoredEdges: number;
  cal: WorkCalendar;
}

/** Gantt, Baseline, การแก้ไขแผน และ Auto-schedule (หน้า 5, L3) */
@Injectable()
export class GanttService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly views: ViewsService,
  ) {}

  /** อ่านแผนของโปรเจกต์ครั้งเดียว: งาน, สถานะเสร็จ, Dependency และปฏิทินวันทำการ */
  private async loadPlan(tx: Tx, project: { id: string; key: string; workspaceId: string; holidayCalendarId: string | null }): Promise<PlanData> {
    const issues = await tx.select().from(s.issues).where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt))).orderBy(asc(s.issues.number));
    const statuses = await tx.select({ id: s.workflowStatuses.id, category: s.workflowStatuses.category }).from(s.workflowStatuses).where(eq(s.workflowStatuses.projectId, project.id));
    const done = new Set(statuses.filter((x) => x.category === 'done').map((x) => x.id));
    const ids = new Set(issues.map((i) => i.id));
    const deps = issues.length
      ? await tx.select().from(s.issueDependencies).where(inArray(s.issueDependencies.predecessorId, issues.map((i) => i.id)))
      : [];
    const summaryIds = new Set(issues.filter((i) => i.parentId).map((i) => i.parentId!));
    const edges: PlanData['edges'] = [];
    let ignored = 0;
    for (const d of deps) {
      if (!ids.has(d.successorId)) continue;
      // Dependency ที่ปลายใดปลายหนึ่งเป็นงานแม่ (มี Sub-task) ไม่นำมาคำนวณ: วันของงานแม่ตามงานย่อย
      if (summaryIds.has(d.predecessorId) || summaryIds.has(d.successorId)) {
        ignored++;
        continue;
      }
      edges.push({ pred: d.predecessorId, succ: d.successorId, type: d.type, lag: d.lagDays });
    }
    return {
      issues,
      keyOf: new Map(issues.map((i) => [i.id, `${project.key}-${i.number}`])),
      doneIds: new Set(issues.filter((i) => done.has(i.statusId)).map((i) => i.id)),
      summaryIds,
      edges,
      ignoredEdges: ignored,
      cal: await WorkCalendar.load(tx, project),
    };
  }

  private scheduledNodes(p: PlanData, includeDone: boolean): Node[] {
    return p.issues
      .filter((i) => i.planStart && i.planEnd && !p.summaryIds.has(i.id) && (includeDone || !p.doneIds.has(i.id)))
      .map((i) => ({ id: i.id, start: i.planStart!, end: i.planEnd! }));
  }

  private axisFor(p: PlanData, nodes: Node[]) {
    const base = nodes.reduce((m, n) => (n.start < m ? n.start : m), nodes[0]?.start ?? '2000-01-01');
    return new Axis(p.cal, base);
  }

  private async context(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    // Guest Viewer เห็นแค่ Overview และ Timeline · Guest Member เห็นเหมือน Member (04-permissions ข้อ 4)
    if (access.guestViewer) {
      throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });
    }
    return { project, access };
  }

  // ---------------------------------------------------------------------------
  // 5 · Gantt
  // ---------------------------------------------------------------------------
  async gantt(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof GanttQuery>) {
    const extra = await this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const plan = await this.loadPlan(tx, project);
      const baselines = await tx.select().from(s.planBaselines).where(eq(s.planBaselines.projectId, project.id)).orderBy(asc(s.planBaselines.version));
      let baselineDates = new Map<string, { start: string | null; end: string | null }>();
      let picked: (typeof baselines)[number] | null = null;
      if (q.baseline !== undefined) {
        picked = baselines.find((b) => b.version === q.baseline) ?? null;
        if (!picked) throw new AppError(404, 'baseline_not_found', `ไม่พบ Baseline v${q.baseline}`, { versions: baselines.map((b) => b.version) });
        const items = await tx.select().from(s.baselineItems).where(eq(s.baselineItems.baselineId, picked.id));
        baselineDates = new Map(items.map((i) => [i.issueId, { start: i.planStart, end: i.planEnd }]));
      }
      const nodes = this.scheduledNodes(plan, false);
      let cp;
      try {
        cp = criticalPath(this.axisFor(plan, nodes), nodes, plan.edges);
      } catch (err) {
        if (err instanceof DependencyCycleError) throw this.cycle(plan, err);
        throw err;
      }
      return { project, plan, baselines, picked, baselineDates, cp, nodes };
    });

    const timeline = await this.views.timeline(auth, tenant, key, { from: q.from, to: q.to });
    const { plan, cp } = extra;
    const byKey = new Map(plan.issues.map((i) => [plan.keyOf.get(i.id)!, i]));

    // วิ่งตามโครงสร้าง Module › กลุ่มงาน › Task › Sub-task แล้วเติมข้อมูลของ Gantt ลงแต่ละแถว
    type Row = { key: string; end: string; subtasks: Row[] } & Record<string, unknown>;
    const enrich = (row: Row) => {
      const issue = byKey.get(row.key);
      if (issue) {
        const slack = cp.slack.get(issue.id);
        const b = extra.baselineDates.get(issue.id);
        row.slackDays = slack ?? null;
        row.critical = cp.critical.has(issue.id);
        if (extra.picked) {
          row.baseline = b ? { start: b.start, end: b.end } : null;
          // เลื่อนจาก Baseline กี่วัน (วันปฏิทิน · บวก = ช้ากว่าแผนเดิม)
          row.slipDays = b?.end && issue.planEnd ? daysBetween(b.end, issue.planEnd) : null;
        }
      }
      row.subtasks.forEach(enrich);
    };
    for (const m of timeline.modules) for (const g of m.groups) (g.tasks as unknown as Row[]).forEach(enrich);

    const dependencies = plan.edges.map((e) => ({
      from: plan.keyOf.get(e.pred)!,
      to: plan.keyOf.get(e.succ)!,
      type: e.type,
      lagDays: e.lag,
      critical: cp.criticalEdges.has(edgeKey(e)),
    }));
    const pathIssues = cp.path.map((id) => plan.issues.find((i) => i.id === id)!);
    return {
      ...timeline,
      baselines: extra.baselines.map((b) => ({ version: b.version, name: b.name, source: b.source, createdAt: b.createdAt })),
      baseline: extra.picked ? { version: extra.picked.version, name: extra.picked.name, createdAt: extra.picked.createdAt } : null,
      dependencies,
      criticalPath: {
        keys: pathIssues.map((i) => plan.keyOf.get(i.id)!),
        startDate: pathIssues.reduce<string | null>((m, i) => (!m || i.planStart! < m ? i.planStart! : m), null),
        endDate: pathIssues.reduce<string | null>((m, i) => (!m || i.planEnd! > m ? i.planEnd! : m), null),
      },
      ignoredDependencies: plan.ignoredEdges,
    };
  }

  private cycle(plan: PlanData, err: DependencyCycleError) {
    return new AppError(422, 'dependency_cycle', 'Dependency วนเป็นวง คำนวณไม่ได้ · แก้ Dependency ของงานเหล่านี้ก่อน', { keys: err.ids.map((id) => plan.keyOf.get(id)).filter(Boolean) });
  }

  // ---------------------------------------------------------------------------
  // Baseline
  // ---------------------------------------------------------------------------
  async listBaselines(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rows = await tx
        .select({ b: s.planBaselines, items: sql<number>`(select count(*)::int from baseline_items i where i.baseline_id = ${s.planBaselines.id})` })
        .from(s.planBaselines)
        .where(eq(s.planBaselines.projectId, project.id))
        .orderBy(desc(s.planBaselines.version));
      const people = await loadPeople(tx, rows.map((r) => r.b.createdBy));
      return { items: rows.map(({ b, items }) => this.baselineDto(b, items, b.createdBy ? (people.get(b.createdBy) ?? null) : null)) };
    });
  }

  private baselineDto(b: typeof s.planBaselines.$inferSelect, items: number, createdBy: unknown) {
    return { id: b.id, version: b.version, name: b.name, source: b.source, itemCount: items, createdAt: b.createdAt, createdBy };
  }

  /** ตั้งแผนปัจจุบันเป็น Baseline ถัดไป (version + 1) · เก็บวัน Plan, Man-Day และ Dev ของทุกงาน */
  async createBaseline(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof CreateBaselineBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.view');
      requirePerm(access, 'project.baseline');
      // ตั้งพร้อมกันสองคำขอจะได้เลขซ้ำ จึงล็อกต่อโปรเจกต์
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'baseline:' + project.id}, 0))`);
      const [last] = await tx.select({ v: sql<number>`coalesce(max(${s.planBaselines.version}), 0)::int` }).from(s.planBaselines).where(eq(s.planBaselines.projectId, project.id));
      const version = (last?.v ?? 0) + 1;
      const [bl] = await tx
        .insert(s.planBaselines)
        .values({ workspaceId: tenant.workspaceId, projectId: project.id, version, name: body.name ?? `Baseline v${version}`, source: 'manual', createdBy: auth.userId })
        .returning();
      const issues = await tx.select({ id: s.issues.id, planStart: s.issues.planStart, planEnd: s.issues.planEnd, estimateMd: s.issues.estimateMd }).from(s.issues).where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)));
      const assignees = issues.length
        ? await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId)).where(eq(s.issues.projectId, project.id)).orderBy(asc(s.issueAssignees.sort))
        : [];
      const devs = new Map<string, string[]>();
      for (const a of assignees) devs.set(a.issueId, [...(devs.get(a.issueId) ?? []), a.userId]);
      for (let i = 0; i < issues.length; i += 500) {
        await tx.insert(s.baselineItems).values(
          issues.slice(i, i + 500).map((x) => ({ workspaceId: tenant.workspaceId, baselineId: bl.id, issueId: x.id, planStart: x.planStart, planEnd: x.planEnd, estimateMd: x.estimateMd, assigneeIds: devs.get(x.id) ?? [] })),
        );
      }
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'plan', action: 'baseline.created', targetType: 'project', targetId: project.id, summary: `${project.key} · ${bl.name}` });
      return this.baselineDto(bl, issues.length, null);
    });
  }

  // ---------------------------------------------------------------------------
  // การแก้ไขแผน (L3 › Plan vs Baseline)
  // ---------------------------------------------------------------------------
  private async changeRows(tx: Tx, projectId: string, baseline: number | undefined, opts: { limit: number; before?: string }) {
    let baselineId: string | undefined;
    if (baseline !== undefined) {
      const [b] = await tx.select({ id: s.planBaselines.id }).from(s.planBaselines).where(and(eq(s.planBaselines.projectId, projectId), eq(s.planBaselines.version, baseline)));
      if (!b) throw new AppError(404, 'baseline_not_found', `ไม่พบ Baseline v${baseline}`);
      baselineId = b.id;
    }
    return tx
      .select({ c: s.planChanges, number: s.issues.number, title: s.issues.title, version: s.planBaselines.version })
      .from(s.planChanges)
      .innerJoin(s.issues, eq(s.issues.id, s.planChanges.issueId))
      .leftJoin(s.planBaselines, eq(s.planBaselines.id, s.planChanges.baselineId))
      .where(and(eq(s.planChanges.projectId, projectId), baselineId ? eq(s.planChanges.baselineId, baselineId) : undefined, opts.before ? lt(s.planChanges.changedAt, new Date(opts.before)) : undefined))
      .orderBy(desc(s.planChanges.changedAt), desc(s.planChanges.id))
      .limit(opts.limit + 1);
  }

  async planChanges(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof PlanChangesQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rows = await this.changeRows(tx, project.id, q.baseline, { limit: q.limit, before: q.before });
      const page = rows.slice(0, q.limit);
      const people = await loadPeople(tx, page.map((r) => r.c.changedBy));
      const items = page.map((r) => ({
        id: r.c.id,
        issueKey: `${project.key}-${r.number}`,
        title: r.title,
        field: r.c.field,
        fieldLabel: FIELD_LABELS[r.c.field] ?? r.c.field,
        oldValue: r.c.oldValue,
        newValue: r.c.newValue,
        reason: r.c.reason,
        impact: r.c.impact,
        source: r.c.source,
        baselineVersion: r.version,
        changedBy: r.c.changedBy ? (people.get(r.c.changedBy) ?? null) : null,
        changedAt: r.c.changedAt,
      }));
      return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.changedAt.toISOString() : null };
    });
  }

  /** Export การแก้ไขแผนเป็น .xlsx · ไฮไลต์ค่าเดิม (แดงอ่อน) และค่าใหม่ (เหลือง) */
  async planChangesXlsx(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof XlsxQuery>) {
    const { projectKey, rows, people } = await this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rows = await this.changeRows(tx, project.id, q.baseline, { limit: 20_000 });
      return { projectKey: project.key, rows: rows.slice(0, 20_000), people: await loadPeople(tx, rows.map((r) => r.c.changedBy)) };
    });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('การแก้ไขแผน');
    ws.columns = [
      { header: 'No.', key: 'no', width: 12 },
      { header: 'งาน', key: 'title', width: 48 },
      { header: 'ฟิลด์', key: 'field', width: 14 },
      { header: 'เดิม', key: 'old', width: 22 },
      { header: 'ใหม่', key: 'new', width: 22 },
      { header: 'เหตุผล', key: 'reason', width: 40 },
      { header: 'ผลกระทบ', key: 'impact', width: 24 },
      { header: 'โดย', key: 'by', width: 18 },
      { header: 'เมื่อ', key: 'at', width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (const r of rows) {
      const row = ws.addRow({
        no: `${projectKey}-${r.number}`,
        title: r.title,
        field: FIELD_LABELS[r.c.field] ?? r.c.field,
        old: show(r.c.oldValue),
        new: show(r.c.newValue),
        reason: r.c.reason ?? '',
        impact: r.c.impact ?? '',
        by: r.c.changedBy ? (people.get(r.c.changedBy)?.displayName ?? '') : '',
        at: r.c.changedAt.toISOString(),
      });
      row.getCell('old').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      row.getCell('new').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } };
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return { filename: `${projectKey}-plan-changes${q.baseline ? `-v${q.baseline}` : ''}.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  // ---------------------------------------------------------------------------
  // Auto-schedule (ดูตัวอย่าง · ไม่บันทึก)
  // ---------------------------------------------------------------------------
  async schedulePreview(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.view');
      requirePerm(access, 'issue.edit');
      if (access.guestViewer) throw new AppError(403, 'guest_view_limited', 'Guest ใช้ Auto-schedule ไม่ได้');
      const plan = await this.loadPlan(tx, project);
      const nodes = this.scheduledNodes(plan, true);
      const axis = this.axisFor(plan, nodes);
      let shifts;
      try {
        shifts = autoSchedule(axis, nodes, plan.edges, plan.doneIds);
      } catch (err) {
        if (err instanceof DependencyCycleError) throw this.cycle(plan, err);
        throw err;
      }
      const byId = new Map(plan.issues.map((i) => [i.id, i]));
      const items = shifts.map((sh) => {
        const i = byId.get(sh.id)!;
        return {
          key: plan.keyOf.get(sh.id)!,
          title: i.title,
          planStart: sh.start,
          planEnd: sh.end,
          previousStart: i.planStart,
          previousEnd: i.planEnd,
          shiftDays: sh.shiftDays,
          because: sh.because.map((p) => plan.keyOf.get(p)!),
        };
      });
      const lastEnd = (list: Array<{ end: string }>) => list.reduce<string | null>((m, n) => (!m || n.end > m ? n.end : m), null);
      const after = new Map(shifts.map((sh) => [sh.id, sh.end]));
      const before = lastEnd(nodes);
      const afterEnd = lastEnd(nodes.map((n) => ({ end: after.get(n.id) ?? n.end })));
      const warnings: Array<{ code: string; message: string }> = [];
      if (afterEnd && project.goliveDate && afterEnd > project.goliveDate && (!before || before <= project.goliveDate || afterEnd > before)) {
        warnings.push({ code: 'golive_exceeded', message: `หลังเลื่อน งานสุดท้ายจบ ${afterEnd} เลยวัน Go-live ${project.goliveDate}` });
      }
      if (plan.ignoredEdges) warnings.push({ code: 'summary_dependency_ignored', message: `ข้าม Dependency ${plan.ignoredEdges} รายการที่ผูกกับงานแม่ (วันของงานแม่ตามงานย่อย)` });
      return { items, summary: { moved: items.length, checked: nodes.length }, projectEnd: { before, after: afterEnd }, warnings };
    });
  }
}
