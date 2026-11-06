import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { CommentsService } from '../comments/comments.service.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { IssuesService } from '../issues/issues.service.js';
import { Notifier } from '../notifications/notifier.js';
import { Jobs } from '../queue/jobs.js';
import type { Action, Condition, Trigger } from './rules.js';

const s = schema;
/** กฎที่ถูกเรียกจากการกระทำของกฎอื่นได้สูงสุด 3 ชั้น (หน้า P2, 01-entities › automation_run.depth) */
export const MAX_DEPTH = 3;
const SCAN_LIMIT = 200;
/** โหลดข้อมูลงานทีละชุดตอนสแกน · และอ่านผู้สมัครไม่เกินจำนวนนี้ต่อกฎต่อรอบ (จำกัดทรัพยากร) */
const FACT_CHUNK = 500;
const SCAN_MAX_CANDIDATES = 20_000;

interface Chain {
  depth: number;
  /** `ruleId:issueId` ที่อยู่ในสายนี้แล้ว · กฎเดิมกับงานเดิมไม่ทำซ้ำในสายเดียวกัน */
  seen: Set<string>;
}
/** บริบทต่อสาย async: การกระทำของ Automation ส่ง Event กลับเข้า EventBus ในสายเดียวกัน (publish ถูก await ในคำขอเดิม) จึงรู้ว่า Event มาจากกฎ */
const chainStore = new AsyncLocalStorage<Chain>();

export type Rule = typeof s.automationRules.$inferSelect;
export type RunResult = 'success' | 'skipped' | 'failed' | 'retried';

export interface Facts {
  id: string;
  key: string;
  projectKey: string;
  projectId: string;
  workspaceId: string;
  title: string;
  version: number;
  parentId: string | null;
  type: string;
  status: string;
  statusCategory: 'todo' | 'in_progress' | 'done';
  priority: string;
  severity: string | null;
  estimateMd: number | null;
  planEnd: string | null;
  module: string | null;
  reporterId: string | null;
  assigneeIds: string[];
  labels: string[];
}

interface Actor {
  auth: AuthInfo;
  tenant: TenantInfo;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** ข้อมูลของงานที่ใช้ตรวจเงื่อนไข */
export async function loadFacts(tx: Tx, ids: string[]): Promise<Facts[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select({
      issue: s.issues,
      project: { key: s.projects.key },
      type: s.issueTypes.name,
      status: s.workflowStatuses.name,
      category: s.workflowStatuses.category,
      module: s.modules.name,
    })
    .from(s.issues)
    .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
    .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    .leftJoin(s.modules, eq(s.modules.id, s.issues.moduleId))
    .where(and(inArray(s.issues.id, ids), isNull(s.issues.deletedAt)));
  if (!rows.length) return [];
  const found = rows.map((r) => r.issue.id);
  const asg = await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, found)).orderBy(asc(s.issueAssignees.sort));
  const lbl = await tx.select({ issueId: s.issueLabels.issueId, name: s.labels.name }).from(s.issueLabels).innerJoin(s.labels, eq(s.labels.id, s.issueLabels.labelId)).where(inArray(s.issueLabels.issueId, found));
  return rows.map(({ issue: i, project, type, status, category, module }) => ({
    id: i.id,
    key: `${project.key}-${i.number}`,
    projectKey: project.key,
    projectId: i.projectId,
    workspaceId: i.workspaceId,
    title: i.title,
    version: i.version,
    parentId: i.parentId,
    type,
    status,
    statusCategory: category,
    priority: i.priority,
    severity: i.severity,
    estimateMd: i.estimateMd === null ? null : Number(i.estimateMd),
    planEnd: i.planEnd,
    module,
    reporterId: i.reporterId,
    assigneeIds: asg.filter((a) => a.issueId === i.id).map((a) => a.userId),
    labels: lbl.filter((l) => l.issueId === i.id).map((l) => l.name),
  }));
}

const lower = (v: unknown) => String(v).toLowerCase();

function fieldValue(f: Facts, field: Condition['field']): unknown {
  switch (field) {
    case 'type': return f.type;
    case 'status': return f.status;
    case 'statusCategory': return f.statusCategory;
    case 'priority': return f.priority;
    case 'assignee': return f.assigneeIds;
    case 'label': return f.labels;
    case 'module': return f.module;
    case 'severity': return f.severity;
    case 'estimateMd': return f.estimateMd;
    case 'daysToDue': return f.planEnd ? daysBetween(today(), f.planEnd) : null;
    case 'isSubtask': return f.parentId !== null;
  }
}

/** เงื่อนไขทั้งหมดต้องเป็นจริง (AND) · `not` กลับผล */
export function matches(conditions: Condition[], f: Facts): boolean {
  return conditions.every((c) => {
    const v = fieldValue(f, c.field);
    const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
    const want = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
    let ok: boolean;
    switch (c.op) {
      case 'empty': ok = list.length === 0; break;
      case 'not_empty': ok = list.length > 0; break;
      case 'eq': ok = list.some((x) => lower(x) === lower(want[0])); break;
      case 'in': ok = list.some((x) => want.some((w) => lower(x) === lower(w))); break;
      case 'gt': ok = list.length > 0 && Number(list[0]) > Number(want[0]); break;
      case 'lt': ok = list.length > 0 && Number(list[0]) < Number(want[0]); break;
    }
    return c.not ? !ok : ok;
  });
}

@Injectable()
export class AutomationEngine implements OnModuleInit {
  private readonly log = new Logger('Automation');

  constructor(
    private readonly events: EventBus,
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly issues: IssuesService,
    private readonly comments: CommentsService,
    private readonly notifier: Notifier,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    for (const type of ['issue.created', 'issue.status_changed', 'sprint.started', 'sprint.completed', 'test_run.failed'] as const) this.events.on(type, (e) => this.onEvent(e));
    this.jobs.define('automation.schedule', () => this.runSchedules());
    this.jobs.define('automation.overdue', () => this.scanOverdue());
    await this.jobs.every('automation.schedule', '*/5 * * * *');
    await this.jobs.every('automation.overdue', '10 * * * *');
  }

  // ---------------------------------------------------------------------------
  // Event → กฎ
  // ---------------------------------------------------------------------------

  async onEvent(e: DomainEvent) {
    if (!e.projectId) return;
    const data = e.data as { from?: { name?: string }; to?: { name?: string; category?: string }; parentId?: string | null; sprintId?: string };
    switch (e.type) {
      case 'issue.created':
        if (e.issueId) await this.fire('issue_created', e.projectId, [e.issueId]);
        break;
      case 'issue.status_changed':
        if (!e.issueId) break;
        await this.fire('status_changed', e.projectId, [e.issueId], { from: data.from?.name, to: data.to?.name });
        // งานแม่: ลูกทุกตัวเสร็จแล้ว
        if (data.to?.category === 'done' && data.parentId && (await this.allSubtasksDone(data.parentId))) await this.fire('subtasks_done', e.projectId, [data.parentId]);
        break;
      case 'sprint.started':
      case 'sprint.completed':
        if (data.sprintId) await this.fire(e.type === 'sprint.started' ? 'sprint_started' : 'sprint_completed', e.projectId, await this.sprintIssueIds(data.sprintId));
        break;
      case 'test_run.failed':
        if (e.issueId) await this.fire('test_attached', e.projectId, [e.issueId]);
        break;
      default:
        break;
    }
  }

  // อ่านกฎก่อนรู้ Workspace/ผู้ใช้ที่จะกระทำ จึงใช้ SYSTEM_DB (ข้าม RLS) · การกระทำจริงทำภายใต้ RLS ของผู้สร้างกฎ
  private async rulesFor(projectId: string, trigger: Trigger) {
    return this.sys.select().from(s.automationRules).where(and(eq(s.automationRules.projectId, projectId), eq(s.automationRules.trigger, trigger), eq(s.automationRules.enabled, true))).orderBy(asc(s.automationRules.createdAt));
  }

  private async allSubtasksDone(parentId: string) {
    const [r] = await this.sys
      .select({ open: sql<number>`count(*) filter (where ${s.workflowStatuses.category} <> 'done')::int`, total: sql<number>`count(*)::int` })
      .from(s.issues)
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .where(and(eq(s.issues.parentId, parentId), isNull(s.issues.deletedAt)));
    return r.total > 0 && r.open === 0;
  }

  private async sprintIssueIds(sprintId: string) {
    return (await this.sys.select({ id: s.issues.id }).from(s.issues).where(and(eq(s.issues.sprintId, sprintId), isNull(s.issues.deletedAt)))).slice(0, 500).map((r) => r.id);
  }

  private async fire(trigger: Trigger, projectId: string, issueIds: string[], ctx: { from?: string; to?: string } = {}) {
    const rules = await this.rulesFor(projectId, trigger);
    if (!rules.length || !issueIds.length) return;
    const chain = chainStore.getStore() ?? { depth: 0, seen: new Set<string>() };
    for (const rule of rules) {
      const cfg = rule.triggerConfig as { from?: string | null; to?: string | null };
      if (trigger === 'status_changed') {
        if (cfg.to && lower(cfg.to) !== lower(ctx.to ?? '')) continue;
        if (cfg.from && lower(cfg.from) !== lower(ctx.from ?? '')) continue;
      }
      for (const issueId of issueIds) await this.runRule(rule, issueId, chain, { trigger });
    }
  }

  // ---------------------------------------------------------------------------
  // ตามเวลา
  // ---------------------------------------------------------------------------

  /** กฎ schedule ที่ถึงเวลา (หน้าต่าง 5 นาที ตามรอบ cron) · ทำวันละครั้งต่อกฎ ด้วย slot */
  async runSchedules(now = new Date()) {
    const bkk = new Date(now.getTime() + 7 * 3_600_000);
    const date = bkk.toISOString().slice(0, 10);
    const minutes = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
    const weekday = bkk.getUTCDay() === 0 ? 7 : bkk.getUTCDay();
    const rules = await this.sys.select().from(s.automationRules).where(and(eq(s.automationRules.trigger, 'schedule'), eq(s.automationRules.enabled, true)));
    let ran = 0;
    for (const rule of rules) {
      const cfg = rule.triggerConfig as { frequency: 'daily' | 'weekly'; time: string; weekday?: number };
      const [h, m] = cfg.time.split(':').map(Number);
      const late = minutes - (h * 60 + m);
      if (late < 0 || late >= 5) continue;
      if (cfg.frequency === 'weekly' && cfg.weekday !== weekday) continue;
      const slot = `${date}T${cfg.time}`;
      const [done] = await this.sys.select({ id: s.automationRuns.id }).from(s.automationRuns).where(and(eq(s.automationRuns.ruleId, rule.id), sql`${s.automationRuns.detail}->>'slot' = ${slot}`)).limit(1);
      if (done) continue;
      const ids = (await this.sys
        .select({ id: s.issues.id })
        .from(s.issues)
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .where(and(eq(s.issues.projectId, rule.projectId), isNull(s.issues.deletedAt), ne(s.workflowStatuses.category, 'done')))
        .orderBy(asc(s.issues.number))).map((r) => r.id);
      ran += await this.runBatch(rule, ids, { slot });
    }
    return { ran };
  }

  /** งานเลย Due: ครั้งเดียวต่อกฎต่องานต่อวัน Due (เปลี่ยน Due แล้วเลยอีกครั้งถึงจะทำใหม่) */
  async scanOverdue() {
    const rules = await this.sys.select().from(s.automationRules).where(and(eq(s.automationRules.trigger, 'overdue'), eq(s.automationRules.enabled, true)));
    let ran = 0;
    for (const rule of rules) {
      const issues = await this.sys
        .select({ id: s.issues.id, planEnd: s.issues.planEnd })
        .from(s.issues)
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .where(and(eq(s.issues.projectId, rule.projectId), isNull(s.issues.deletedAt), ne(s.workflowStatuses.category, 'done'), lt(s.issues.planEnd, today())))
        .orderBy(asc(s.issues.number));
      if (!issues.length) continue;
      const seen = new Set((await this.sys.select({ d: sql<string>`${s.automationRuns.detail}->>'dedupe'` }).from(s.automationRuns).where(and(eq(s.automationRuns.ruleId, rule.id), sql`${s.automationRuns.detail} ? 'dedupe'`))).map((r) => r.d));
      // ตัดงานที่เคยทำ และตรวจเงื่อนไขก่อนใช้โควตา SCAN_LIMIT (N03): เดิมตัด 200 งานแรกก่อน
      // งานที่ไม่ตรงเงื่อนไขกินโควตาทุกรอบ งานหลังลำดับ 200 จึงไม่เคยถูกตรวจ
      const pending = issues.filter((i) => !seen.has(`${i.id}:${i.planEnd}`));
      if (!pending.length) continue;
      const actor = await this.actorFor(rule);
      if (!actor) {
        await this.record(rule, [], 'failed', { reason: 'creator_inactive' }, 0);
        continue;
      }
      const planEnd = new Map(pending.map((i) => [i.id, i.planEnd]));
      const matched: Facts[] = [];
      for (let at = 0; at < pending.length && at < SCAN_MAX_CANDIDATES && matched.length < SCAN_LIMIT; at += FACT_CHUNK) {
        const ids = pending.slice(at, at + FACT_CHUNK).map((i) => i.id);
        const facts = await this.db.run(actor.auth, actor.tenant, (tx) => loadFacts(tx, ids));
        matched.push(...facts.filter((f) => matches(rule.conditions as Condition[], f)));
      }
      for (const f of matched.slice(0, SCAN_LIMIT)) {
        await this.runRule(rule, f.id, { depth: 0, seen: new Set() }, { trigger: rule.trigger, extra: { dedupe: `${f.id}:${planEnd.get(f.id)}` }, facts: f, actor });
        ran++;
      }
    }
    return { ran };
  }

  private async runBatch(rule: Rule, ids: string[], extra: Record<string, unknown>) {
    const actor = await this.actorFor(rule);
    if (!actor) {
      await this.record(rule, [], 'failed', { reason: 'creator_inactive', ...extra }, 0);
      return 0;
    }
    const facts = (await this.db.run(actor.auth, actor.tenant, (tx) => loadFacts(tx, ids.slice(0, 1000)))).filter((f) => matches(rule.conditions as Condition[], f)).slice(0, SCAN_LIMIT);
    for (const f of facts) await this.runRule(rule, f.id, { depth: 0, seen: new Set() }, { trigger: rule.trigger, extra, facts: f, actor });
    return facts.length;
  }

  // ---------------------------------------------------------------------------
  // รันกฎกับงานหนึ่งงาน
  // ---------------------------------------------------------------------------

  private async runRule(rule: Rule, issueId: string, chain: Chain, opts: { trigger: Trigger; extra?: Record<string, unknown>; facts?: Facts; actor?: Actor }) {
    const key = `${rule.id}:${issueId}`;
    const base = { trigger: opts.trigger, ...(opts.extra ?? {}) };
    if (chain.depth > MAX_DEPTH) {
      await this.record(rule, [issueId], 'skipped', { ...base, reason: 'depth_exceeded', attemptedDepth: chain.depth }, MAX_DEPTH);
      return;
    }
    if (chain.seen.has(key)) {
      await this.record(rule, [issueId], 'skipped', { ...base, reason: 'loop' }, chain.depth);
      return;
    }
    const actor = opts.actor ?? (await this.actorFor(rule));
    if (!actor) {
      await this.record(rule, [issueId], 'failed', { ...base, reason: 'creator_inactive' }, chain.depth);
      return;
    }
    const facts = opts.facts ?? (await this.db.run(actor.auth, actor.tenant, (tx) => loadFacts(tx, [issueId])))[0];
    // งานไม่อยู่แล้ว / ผู้สร้างกฎมองไม่เห็น / เงื่อนไขไม่ตรง → ไม่ถือว่ากฎทำงาน (ไม่บันทึกประวัติ)
    if (!facts || !matches(rule.conditions as Condition[], facts)) return;

    const started = new Date();
    const touched = new Set<string>([facts.id]);
    const steps: Record<string, unknown>[] = [];
    let result: RunResult = 'success';
    await chainStore.run({ depth: chain.depth + 1, seen: new Set(chain.seen).add(key) }, async () => {
      for (const action of rule.actions as Action[]) {
        try {
          const retried = await this.perform(action, rule, actor, facts.id, touched);
          steps.push({ action: action.type, ok: true, ...(retried ? { retried: true } : {}) });
          if (retried && result === 'success') result = 'retried';
        } catch (err) {
          const e = err as Partial<AppError> & Error;
          steps.push({ action: action.type, ok: false, error: e.message, code: (e as { code?: string }).code ?? null });
          result = 'failed';
          break;
        }
      }
    });
    // กิจกรรมที่เกิดจากการกระทำนี้ ลงชื่อ "Automation" แทนผู้สร้างกฎ (IssuesService บันทึกในนามผู้ใช้ที่เรียก)
    await this.sys
      .update(s.activities)
      .set({ actorKind: 'automation', actorId: null })
      .where(and(inArray(s.activities.issueId, [...touched]), eq(s.activities.actorId, rule.createdBy), eq(s.activities.actorKind, 'user'), gte(s.activities.createdAt, started)));
    await this.record(rule, [...touched], result, { ...base, issueKey: facts.key, steps }, chain.depth);
  }

  /**
   * ผู้กระทำ = ผู้สร้างกฎ (สิทธิ์ของเขาจำกัดสิ่งที่กฎทำได้) · ไม่ใช่สมาชิก active แล้ว หรือบัญชีถูกปิดทั้งระบบ = null
   * งานเบื้องหลังไม่ผ่าน AuthGuard จึงต้องตรวจ users.disabled_at เอง (N04 · เทียบ BUG-03 ของ API token)
   */
  private async actorFor(rule: Rule): Promise<Actor | null> {
    const [row] = await this.sys
      .select({ workspaceId: s.workspaces.id, slug: s.workspaces.slug, role: s.workspaceMembers.role })
      .from(s.workspaces)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, rule.createdBy), eq(s.workspaceMembers.status, 'active')))
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaces.id, rule.workspaceId), isNull(s.workspaces.deletedAt), isNull(s.users.disabledAt)));
    return row ? { auth: { userId: rule.createdBy, sessionId: 'automation' }, tenant: { workspaceId: row.workspaceId, slug: row.slug, role: row.role } } : null;
  }

  // ---------------------------------------------------------------------------
  // การกระทำ · คืน true เมื่อสำเร็จหลัง retry
  // ---------------------------------------------------------------------------

  private async perform(action: Action, rule: Rule, actor: Actor, issueId: string, touched: Set<string>): Promise<boolean> {
    const { auth, tenant } = actor;
    const cur = async () => {
      const [f] = await this.db.run(auth, tenant, (tx) => loadFacts(tx, [issueId]));
      if (!f) throw new AppError(404, 'issue_not_found', 'ไม่พบงาน');
      return f;
    };
    const reason = `Automation: ${rule.name}`;
    /** แก้งานด้วย PATCH · ชนเวอร์ชันกับคนอื่นระหว่างทาง = โหลดใหม่แล้วลองอีกครั้งเดียว */
    const patch = async (build: (f: Facts) => Promise<Record<string, unknown>> | Record<string, unknown>) => {
      for (let attempt = 0; ; attempt++) {
        const f = await cur();
        try {
          await this.issues.patch(auth, tenant, f.key, String(f.version), (await build(f)) as never);
          return attempt > 0;
        } catch (err) {
          if (attempt === 0 && (err as { code?: string }).code === 'conflict') continue;
          throw err;
        }
      }
    };
    const resolveUser = (ref: string | undefined, f: Facts) => (ref === 'reporter' ? f.reporterId : ref === 'creator' ? rule.createdBy : (ref ?? null));

    switch (action.type) {
      case 'set_status':
        return patch(async (f) => ({ statusId: await this.statusId(auth, tenant, f.id, action.status), planChangeReason: reason }));
      case 'set_priority':
        return patch(() => ({ priority: action.priority }));
      case 'assign':
        return patch((f) => {
          const user = resolveUser(action.user, f);
          if (action.mode !== 'clear' && !user) throw new AppError(422, 'automation_user_missing', 'ไม่พบผู้ใช้ที่จะมอบหมาย');
          const next = action.mode === 'clear' ? [] : action.mode === 'set' ? [user!] : [...new Set([...f.assigneeIds, user!])];
          return { assigneeIds: next, planChangeReason: reason };
        });
      case 'add_label':
        await this.db.run(auth, tenant, async (tx) => {
          const f = (await loadFacts(tx, [issueId]))[0];
          if (!f) throw new AppError(404, 'issue_not_found', 'ไม่พบงาน');
          let [label] = await tx.select().from(s.labels).where(and(eq(s.labels.projectId, f.projectId), sql`lower(${s.labels.name}) = lower(${action.label})`));
          label ??= (await tx.insert(s.labels).values({ workspaceId: f.workspaceId, projectId: f.projectId, name: action.label }).returning())[0];
          const added = await tx.insert(s.issueLabels).values({ workspaceId: f.workspaceId, issueId, labelId: label.id }).onConflictDoNothing().returning({ id: s.issueLabels.labelId });
          if (added.length) await tx.insert(s.activities).values({ workspaceId: f.workspaceId, projectId: f.projectId, issueId, actorId: auth.userId, actorKind: 'automation', verb: 'updated', field: 'labels', newValue: { added: label.name } });
        });
        return false;
      case 'add_watcher':
        await this.db.run(auth, tenant, async (tx) => {
          const f = (await loadFacts(tx, [issueId]))[0];
          const user = f ? resolveUser(action.user, f) : null;
          if (!f || !user) throw new AppError(422, 'automation_user_missing', 'ไม่พบผู้ใช้ที่จะเพิ่มเป็น Watcher');
          await tx.insert(s.issueWatchers).values({ workspaceId: f.workspaceId, issueId, userId: user, source: 'manual' }).onConflictDoNothing();
        });
        return false;
      case 'create_subtask': {
        const f = await cur();
        const assignee = resolveUser(action.assignee, f);
        const sub = (await this.issues.create(auth, tenant, f.projectKey, { type: 'Task', parentKey: f.key, title: action.title, priority: 'medium', assigneeIds: assignee ? [assignee] : [], details: {}, sharedWithGuests: false })) as { id: string };
        touched.add(sub.id);
        return false;
      }
      case 'comment': {
        const f = await cur();
        await this.comments.create(auth, tenant, f.key, { body: `[Automation: ${rule.name}] ${action.body}` });
        return false;
      }
      case 'notify': {
        const f = await cur();
        let recipients: string[] = [];
        if (action.to === 'assignees') recipients = f.assigneeIds;
        else if (action.to === 'reporter') recipients = f.reporterId ? [f.reporterId] : [];
        else if (action.to === 'users') recipients = action.userIds ?? [];
        else {
          const [p] = await this.db.run(auth, tenant, (tx) => tx.select({ owner: s.projects.ownerUserId }).from(s.projects).where(eq(s.projects.id, f.projectId)));
          recipients = p?.owner ? [p.owner] : [];
        }
        // ผู้กระทำ = ระบบ จึงไม่ตัดผู้รับคนใดออก (actorId = null)
        await this.notifier.notify({
          workspaceId: f.workspaceId,
          recipientIds: recipients,
          eventType: 'automation.notified',
          actorId: null,
          projectId: f.projectId,
          issueId: f.id,
          payload: { issueKey: f.key, title: f.title, message: action.message, ruleName: rule.name },
          reason: `Automation "${rule.name}"`,
        });
        return false;
      }
    }
  }

  /** สถานะตามชื่อใน Workflow ของงานนั้น */
  private async statusId(auth: AuthInfo, tenant: TenantInfo, issueId: string, name: string) {
    const [row] = await this.db.run(auth, tenant, (tx) =>
      tx
        .select({ id: s.workflowStatuses.id })
        .from(s.issues)
        .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.workflowId, s.issueTypes.workflowId))
        .where(and(eq(s.issues.id, issueId), sql`lower(${s.workflowStatuses.name}) = lower(${name})`)),
    );
    if (!row) throw new AppError(422, 'automation_status_not_found', `ไม่พบสถานะ "${name}" ใน Workflow ของงานนี้`);
    return row.id;
  }

  // ---------------------------------------------------------------------------
  // บันทึกประวัติ (automation_runs + Audit log ในชื่อ "Automation")
  // ---------------------------------------------------------------------------

  private async record(rule: Rule, issueIds: string[], result: RunResult, detail: Record<string, unknown>, depth: number) {
    try {
      await this.sys.insert(s.automationRuns).values({ workspaceId: rule.workspaceId, ruleId: rule.id, issueIds, result, detail, depth: Math.min(Math.max(depth, 0), MAX_DEPTH) });
      await this.sys.insert(s.auditLogs).values({
        workspaceId: rule.workspaceId,
        actorId: null,
        actorKind: 'automation',
        category: 'data',
        action: 'automation.run',
        targetType: 'automation_rule',
        targetId: rule.id,
        summary: `${rule.name} · ${result}${detail.issueKey ? ` · ${detail.issueKey}` : ''}${detail.reason ? ` · ${detail.reason}` : ''}`,
      });
    } catch (err) {
      this.log.error(`บันทึกประวัติ Automation ไม่สำเร็จ: ${(err as Error).message}`);
    }
  }
}
