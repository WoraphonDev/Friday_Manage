import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';
import { type Facts, loadFacts, matches } from './engine.js';
import { type Action, type Condition, describeAction, DryRunBody, PatchRuleBody, RuleBody, RunsQuery, sentence, TEMPLATES, type Trigger, TriggerConfigs } from './rules.js';

const s = schema;
/** จำนวนกฎต่อโปรเจกต์ (กันกฎงอกไม่รู้จบ) */
const MAX_RULES = 50;
/** โควตาการทำงานต่อเดือน (หน้า P2 "ทำงานเดือนนี้ x / 1,000") · แสดงอย่างเดียว ยังไม่บังคับ */
const MONTHLY_RUN_QUOTA = 1000;

type Rule = typeof s.automationRules.$inferSelect;

@Injectable()
export class AutomationService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
  ) {}

  private async context(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    // ตั้ง / แก้ Automation เป็นของ Project Admin (`project.automation` ใน 04-permissions) · Guest ไม่ได้
    requirePerm(access, 'project.automation');
    return { project, access };
  }

  private async findRule(tx: Tx, projectId: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('กฎ Automation');
    const [rule] = await tx.select().from(s.automationRules).where(and(eq(s.automationRules.projectId, projectId), eq(s.automationRules.id, id)));
    if (!rule) throw notFound('กฎ Automation');
    return rule;
  }

  // ---------------------------------------------------------------------------

  async list(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rules = await tx.select().from(s.automationRules).where(eq(s.automationRules.projectId, project.id)).orderBy(asc(s.automationRules.createdAt));
      const since = new Date(Date.now() - 30 * 86_400_000);
      const stats = rules.length
        ? await tx
            .select({
              ruleId: s.automationRuns.ruleId,
              runs: sql<number>`count(*) filter (where ${s.automationRuns.result} in ('success', 'retried'))::int`,
              failed: sql<number>`count(*) filter (where ${s.automationRuns.result} = 'failed')::int`,
              lastAt: sql<Date | null>`max(${s.automationRuns.ranAt})`,
            })
            .from(s.automationRuns)
            .where(and(inArray(s.automationRuns.ruleId, rules.map((r) => r.id)), gte(s.automationRuns.ranAt, since)))
            .groupBy(s.automationRuns.ruleId)
        : [];
      const st = new Map(stats.map((x) => [x.ruleId, x]));
      const people = await loadPeople(tx, rules.map((r) => r.createdBy));
      const [month] = await tx
        .select({ n: sql<number>`count(*) filter (where ${s.automationRuns.result} in ('success', 'retried'))::int` })
        .from(s.automationRuns)
        .innerJoin(s.automationRules, eq(s.automationRules.id, s.automationRuns.ruleId))
        .where(and(eq(s.automationRules.projectId, project.id), gte(s.automationRuns.ranAt, sql`date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'`)));
      return {
        usage: { runsThisMonth: month?.n ?? 0, quota: MONTHLY_RUN_QUOTA },
        items: rules.map((r) => ({ ...this.dto(r), createdBy: people.get(r.createdBy) ?? null, stats30d: { runs: st.get(r.id)?.runs ?? 0, failed: st.get(r.id)?.failed ?? 0, lastRunAt: st.get(r.id)?.lastAt ?? null } })),
      };
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      return this.dto(await this.findRule(tx, project.id, id));
    });
  }

  async create(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof RuleBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.automationRules).where(eq(s.automationRules.projectId, project.id));
      if (count.n >= MAX_RULES) throw new AppError(422, 'automation_limit', `โปรเจกต์หนึ่งมีกฎได้ไม่เกิน ${MAX_RULES} กฎ`);
      await this.validate(tx, project.id, input.actions, input.conditions, input.trigger, input.triggerConfig);
      const [rule] = await tx
        .insert(s.automationRules)
        .values({ workspaceId: tenant.workspaceId, projectId: project.id, name: input.name, trigger: input.trigger, triggerConfig: input.triggerConfig, conditions: input.conditions, actions: input.actions, enabled: input.enabled, createdBy: auth.userId })
        .returning();
      await this.audit(tx, auth, tenant, 'automation.created', `สร้างกฎ "${rule.name}" · ${sentence(this.shape(rule))}`, rule.id);
      return this.dto(rule);
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchRuleBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const cur = await this.findRule(tx, project.id, id);
      const next = { name: input.name ?? cur.name, trigger: input.trigger ?? cur.trigger, triggerConfig: input.triggerConfig ?? (input.trigger ? {} : (cur.triggerConfig as Record<string, unknown>)), conditions: input.conditions ?? (cur.conditions as Condition[]), actions: input.actions ?? (cur.actions as Action[]), enabled: input.enabled ?? cur.enabled };
      // ตรวจทั้งชุดใหม่ด้วย schema เดิม (trigger เปลี่ยน → config ต้องตรงตัวใหม่)
      const checked = RuleBody.parse(next);
      await this.validate(tx, project.id, checked.actions, checked.conditions, checked.trigger, checked.triggerConfig);
      // แก้ผู้สร้าง: การกระทำของกฎใช้สิทธิ์ของผู้แก้ล่าสุดที่แก้ตัวกฎ (ไม่ใช่แค่เปิด/ปิด)
      const contentChanged = input.trigger !== undefined || input.triggerConfig !== undefined || input.conditions !== undefined || input.actions !== undefined;
      const [rule] = await tx
        .update(s.automationRules)
        .set({ name: checked.name, trigger: checked.trigger, triggerConfig: checked.triggerConfig, conditions: checked.conditions, actions: checked.actions, enabled: checked.enabled, ...(contentChanged ? { createdBy: auth.userId } : {}), updatedAt: new Date() })
        .where(eq(s.automationRules.id, cur.id))
        .returning();
      const toggled = input.enabled !== undefined && input.enabled !== cur.enabled && Object.keys(input).length === 1;
      await this.audit(tx, auth, tenant, toggled ? (rule.enabled ? 'automation.enabled' : 'automation.disabled') : 'automation.updated', `${toggled ? (rule.enabled ? 'เปิด' : 'ปิด') : 'แก้'}กฎ "${rule.name}" · ${sentence(this.shape(rule))}`, rule.id);
      return this.dto(rule);
    });
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rule = await this.findRule(tx, project.id, id);
      await tx.delete(s.automationRules).where(eq(s.automationRules.id, rule.id));
      await this.audit(tx, auth, tenant, 'automation.deleted', `ลบกฎ "${rule.name}"`, rule.id);
      return { id: rule.id, deleted: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Dry run · ไม่เขียนอะไรทั้งสิ้น (ไม่ส่งแจ้งเตือน ไม่สร้าง automation_runs)
  // ---------------------------------------------------------------------------

  async dryRun(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof DryRunBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rule = await this.findRule(tx, project.id, id);
      const conditions = rule.conditions as Condition[];
      const actions = rule.actions as Action[];

      let ids: string[];
      if (input.issueKey) {
        const m = /^[A-Za-z][A-Za-z0-9]*-(\d+)$/.exec(input.issueKey.trim());
        const [row] = m ? await tx.select({ id: s.issues.id }).from(s.issues).where(and(eq(s.issues.projectId, project.id), eq(s.issues.number, Number(m[1])), isNull(s.issues.deletedAt))) : [];
        if (!row) throw notFound('งาน');
        ids = [row.id];
      } else {
        // ขอบเขตงานที่ trigger นี้จะแตะ · งานที่เสร็จแล้วไม่นับ ยกเว้น trigger ที่เกิดตอนงานเสร็จ
        const open = and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt), rule.trigger === 'status_changed' || rule.trigger === 'issue_created' || rule.trigger === 'test_attached' ? undefined : ne(s.workflowStatuses.category, 'done'), rule.trigger === 'overdue' ? lt(s.issues.planEnd, today()) : undefined, rule.trigger === 'sprint_started' || rule.trigger === 'sprint_completed' ? sql`${s.issues.sprintId} is not null` : undefined);
        ids = (await tx.select({ id: s.issues.id }).from(s.issues).innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId)).where(open).orderBy(desc(s.issues.number)).limit(500)).map((r) => r.id);
      }
      let facts = await loadFacts(tx, ids);
      if (rule.trigger === 'subtasks_done') {
        const withChildren = new Set((await tx.select({ p: s.issues.parentId }).from(s.issues).where(and(inArray(s.issues.parentId, facts.map((f) => f.id)), isNull(s.issues.deletedAt)))).map((r) => r.p));
        facts = facts.filter((f) => withChildren.has(f.id));
      }
      const checked = facts.length;
      const hit = facts.filter((f) => matches(conditions, f)).slice(0, input.limit);
      const items = [];
      for (const f of hit) items.push({ key: f.key, title: f.title, status: f.status, wouldDo: await this.preview(tx, actions, f) });
      return {
        ruleId: rule.id,
        sentence: sentence(this.shape(rule)),
        dryRun: true,
        checked,
        matched: facts.filter((f) => matches(conditions, f)).length,
        items,
        notes: [
          ...(rule.trigger === 'status_changed' ? ['ตัวกรองสถานะ "จาก/เป็น" ของ trigger ใช้ตอนเกิดเหตุการณ์จริง · ผลนี้ตรวจเฉพาะเงื่อนไขกับงานปัจจุบัน'] : []),
          ...(rule.trigger === 'schedule' ? ['ทำงานกับงานที่ยังไม่เสร็จทั้งหมดที่ตรงเงื่อนไข ณ เวลาที่ตั้ง'] : []),
          'ไม่มีการเปลี่ยนข้อมูลหรือส่งแจ้งเตือนจริง',
        ],
      };
    });
  }

  private async preview(tx: Tx, actions: Action[], f: Facts) {
    const out: { action: string; text: string; warning?: string }[] = [];
    for (const a of actions) {
      let warning: string | undefined;
      if (a.type === 'set_status') {
        const [st] = await tx
          .select({ id: s.workflowStatuses.id })
          .from(s.issues)
          .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
          .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.workflowId, s.issueTypes.workflowId))
          .where(and(eq(s.issues.id, f.id), sql`lower(${s.workflowStatuses.name}) = lower(${a.status})`));
        if (!st) warning = `งานประเภท ${f.type} ไม่มีสถานะ "${a.status}"`;
        else if (f.status.toLowerCase() === a.status.toLowerCase()) warning = 'งานอยู่ในสถานะนี้แล้ว ไม่มีอะไรเปลี่ยน';
      }
      if (a.type === 'create_subtask' && f.parentId) warning = 'Sub-task สร้าง Sub-task ซ้อนไม่ได้';
      out.push({ action: a.type, text: describeAction(a), ...(warning ? { warning } : {}) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // ประวัติ + แม่แบบ
  // ---------------------------------------------------------------------------

  async runs(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof RunsQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.context(tx, auth, tenant, key);
      const rows = await tx
        .select({ run: s.automationRuns, ruleName: s.automationRules.name })
        .from(s.automationRuns)
        .innerJoin(s.automationRules, eq(s.automationRules.id, s.automationRuns.ruleId))
        .where(and(eq(s.automationRules.projectId, project.id), q.ruleId ? eq(s.automationRuns.ruleId, q.ruleId) : undefined, q.result ? eq(s.automationRuns.result, q.result) : undefined, q.before ? lt(s.automationRuns.ranAt, new Date(q.before)) : undefined))
        .orderBy(desc(s.automationRuns.ranAt), desc(s.automationRuns.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const ids = [...new Set(page.flatMap((r) => r.run.issueIds))];
      const keys = new Map(ids.length ? (await tx.select({ id: s.issues.id, number: s.issues.number }).from(s.issues).where(inArray(s.issues.id, ids))).map((i) => [i.id, `${project.key}-${i.number}`]) : []);
      return {
        items: page.map(({ run, ruleName }) => ({ id: run.id, rule: { id: run.ruleId, name: ruleName }, issueKeys: run.issueIds.map((i) => keys.get(i)).filter(Boolean), result: run.result, depth: run.depth, detail: run.detail, ranAt: run.ranAt })),
        nextCursor: rows.length > q.limit ? page[page.length - 1].run.ranAt.toISOString() : null,
      };
    });
  }

  /** แม่แบบสำเร็จรูป · ใช้ผ่าน `POST p/automations` ด้วย `rule` ของแม่แบบ */
  templates(tenant: TenantInfo) {
    if (tenant.role === 'guest') throw new AppError(403, 'forbidden', 'ไม่มีสิทธิ์ทำรายการนี้', { permission: 'project.automation' });
    return { items: TEMPLATES.map((t) => ({ id: t.id, category: t.category, name: t.name, description: t.description, rule: t.rule, sentence: sentence(t.rule as unknown as { trigger: Trigger; triggerConfig: Record<string, unknown>; conditions: Condition[]; actions: Action[] }) })) };
  }

  // ---------------------------------------------------------------------------

  /** ชื่อสถานะต้องมีใน Workflow ของโปรเจกต์ · คนที่อ้างถึงต้องเป็นสมาชิกโปรเจกต์ */
  private async validate(tx: Tx, projectId: string, actions: Action[], conditions: Condition[], trigger: Trigger, triggerConfig: Record<string, unknown>) {
    TriggerConfigs[trigger].parse(triggerConfig);
    const names = new Set(
      (await tx.select({ name: s.workflowStatuses.name }).from(s.workflowStatuses).innerJoin(s.issueTypes, eq(s.issueTypes.workflowId, s.workflowStatuses.workflowId)).where(eq(s.issueTypes.projectId, projectId))).map((r) => r.name.toLowerCase()),
    );
    const bad: string[] = [];
    for (const a of actions) if (a.type === 'set_status' && !names.has(a.status.toLowerCase())) bad.push(a.status);
    if (trigger === 'status_changed') for (const n of [triggerConfig.from, triggerConfig.to]) if (typeof n === 'string' && !names.has(n.toLowerCase())) bad.push(n);
    for (const c of conditions) if (c.field === 'status' && c.op !== 'empty' && c.op !== 'not_empty') for (const v of Array.isArray(c.value) ? c.value : [c.value]) if (typeof v === 'string' && !names.has(v.toLowerCase())) bad.push(v);
    if (bad.length) throw new AppError(422, 'automation_status_not_found', `ไม่พบสถานะใน Workflow ของโปรเจกต์: ${[...new Set(bad)].join(', ')}`, { statuses: [...new Set(bad)] });

    const users = new Set<string>();
    for (const a of actions) {
      if ((a.type === 'assign' || a.type === 'add_watcher' || a.type === 'create_subtask') && 'user' in a && a.user && !['reporter', 'creator'].includes(a.user)) users.add(a.user);
      if (a.type === 'create_subtask' && a.assignee && !['reporter', 'creator'].includes(a.assignee)) users.add(a.assignee);
      if (a.type === 'notify') (a.userIds ?? []).forEach((u) => users.add(u));
      if (a.type === 'notify' && a.to === 'users' && !a.userIds?.length) throw new AppError(422, 'automation_users_required', 'เลือกผู้รับแจ้งเตือนอย่างน้อย 1 คน');
      if (a.type === 'assign' && a.mode !== 'clear' && !a.user) throw new AppError(422, 'automation_users_required', 'ระบุผู้ที่จะมอบหมาย');
    }
    if (users.size) {
      const ok = new Set((await tx.select({ id: s.projectMembers.userId }).from(s.projectMembers).where(and(eq(s.projectMembers.projectId, projectId), inArray(s.projectMembers.userId, [...users])))).map((r) => r.id));
      const missing = [...users].filter((u) => !ok.has(u));
      if (missing.length) throw new AppError(422, 'automation_user_not_member', 'ผู้ใช้ที่อ้างถึงต้องเป็นสมาชิกของโปรเจกต์', { userIds: missing });
    }
  }

  private shape(r: Rule) {
    return { trigger: r.trigger as Trigger, triggerConfig: r.triggerConfig as Record<string, unknown>, conditions: r.conditions as Condition[], actions: r.actions as Action[] };
  }

  private dto(r: Rule) {
    return { id: r.id, name: r.name, trigger: r.trigger, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions, enabled: r.enabled, sentence: sentence(this.shape(r)), createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  private async audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, action: string, summary: string, ruleId: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType: 'automation_rule', targetId: ruleId, summary });
  }
}
