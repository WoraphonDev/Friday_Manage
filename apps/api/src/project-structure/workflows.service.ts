import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { assertFullOrder, audit, color, type Context, issueEvent, loadContext, name, nextSort, nonEmpty, ReorderBody } from './context.js';
import { RuleConfig, ruleCatalog, ruleType, WORKFLOW_RULES, type WorkflowKind } from './rules.js';
import { STATUS_CATEGORIES } from '../common/status-category.js';
import { DEV_QA_FLOW } from '../projects/field-profile.js';

const category = z.enum(STATUS_CATEGORIES);
const wipLimit = z.number().int().min(1).max(999).nullable();

/** color = สีที่ผู้ใช้เลือก (#RRGGBB) · null = ใช้สีตามหมวด */
export const CreateStatusBody = z.object({ name, category, color: color.nullable().optional(), boardColumnId: z.uuid().nullish(), wipLimit: wipLimit.optional() }).strict();
export const PatchStatusBody = CreateStatusBody.partial().refine((v) => Object.keys(v).length > 0, nonEmpty);
/** moveTo = สถานะปลายทางใน Workflow เดียวกัน (บังคับเมื่อมีงาน) */
export const DeleteStatusBody = z.object({ moveTo: z.uuid().optional() }).strict();
export const CreateRuleBody = z.object({ ruleType, config: RuleConfig.default({}), enabled: z.boolean().default(true) }).strict();
export const PatchRuleBody = z.object({ config: RuleConfig.optional(), enabled: z.boolean().optional() }).strict()
  .refine((v) => Object.keys(v).length > 0, nonEmpty);

/**
 * ฟิลด์บังคับที่ตั้งได้ในหน้า L2 › ประเภทงาน · ต้องตรงกับที่ IssuesService.checkRequired ตรวจ
 * title บังคับเสมอ (ชื่องาน) จึงเติมให้ทุกครั้ง
 */
export const REQUIRED_FIELD_OPTIONS = [
  { key: 'title', label: 'ชื่อ' },
  { key: 'module', label: 'Module' },
  { key: 'size', label: 'Size' },
  { key: 'user_story', label: 'User story' },
  { key: 'acceptance_criteria', label: 'Acceptance criteria' },
  { key: 'severity', label: 'Severity' },
  { key: 'environment', label: 'Environment' },
  { key: 'steps', label: 'ขั้นตอนทำซ้ำ' },
  { key: 'question', label: 'คำถาม' },
  { key: 'timebox', label: 'Timebox' },
] as const;
const requiredField = z.enum(REQUIRED_FIELD_OPTIONS.map((f) => f.key) as [string, ...string[]]);
export const PatchIssueTypeBody = z.object({
  enabled: z.boolean().optional(),
  requiredFields: z.array(requiredField).max(REQUIRED_FIELD_OPTIONS.length).optional(),
  color: color.nullish(),
}).strict().refine((v) => Object.keys(v).length > 0, nonEmpty);
export { ReorderBody };

const devQaKey = z.enum(DEV_QA_FLOW.map((x) => x.key) as [string, ...string[]]);
/** เปลี่ยน Workflow มาตรฐานเป็นชุด Development + QA · mapping = สถานะเดิมทุกตัว → key ของสถานะใหม่ */
export const ApplyDevQaBody = z.object({
  mapping: z.record(z.uuid(), devQaKey),
  progressSplit: z.boolean().default(true),
}).strict();

type Status = typeof s.workflowStatuses.$inferSelect;
type Rule = typeof s.workflowRules.$inferSelect;
type IssueType = typeof s.issueTypes.$inferSelect;

/** Workflow, สถานะ, กฎการย้ายสถานะ และประเภทงาน */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly events: EventBus,
  ) {}

  /** Workflow ทั้งหมดของโปรเจกต์ พร้อมสถานะ, ประเภทงานที่ใช้ และกฎ (หน้า L2 › Workflow) */
  async listWorkflows(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.read(auth, tenant, key, async (tx, { project }) => {
      const workflows = await tx.select().from(s.workflows).where(eq(s.workflows.projectId, project.id)).orderBy(asc(s.workflows.id));
      const types = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.projectId, project.id)).orderBy(asc(s.issueTypes.sort));
      const items = [];
      for (const wf of workflows) {
        const kind = kindOf(types, wf.id);
        const rules = await this.rules(tx, wf.id);
        items.push({
          id: wf.id,
          name: wf.name,
          kind,
          issueTypes: types.filter((t) => t.workflowId === wf.id).map((t) => ({ id: t.id, name: t.name, enabled: t.enabled })),
          statuses: await this.statusDtos(tx, wf.id),
          rules: rules.map(ruleDto),
          catalog: ruleCatalog(kind, rules),
        });
      }
      // Workflow มาตรฐานก่อน Bug เหมือนแท็บในหน้าจอ
      items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'standard' ? -1 : 1));
      return { items };
    });
  }

  // ---------------------------------------------------------------------------
  // สถานะ
  // ---------------------------------------------------------------------------
  async listStatuses(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string) {
    return this.read(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      return { items: await this.statusDtos(tx, workflowId) };
    });
  }

  async createStatus(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, input: z.infer<typeof CreateStatusBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      const current = await this.statuses(tx, workflowId);
      assertUniqueName(current, input.name);
      if (input.boardColumnId) await this.checkBoardColumn(tx, project.id, workflowId, input.boardColumnId);
      const [row] = await tx.insert(s.workflowStatuses).values({
        workspaceId: tenant.workspaceId, projectId: project.id, workflowId,
        name: input.name, category: input.category, color: input.color ?? null, boardColumnId: input.boardColumnId ?? null, wipLimit: input.wipLimit ?? null, sort: nextSort(current),
      }).returning();
      await audit(tx, auth, tenant, project, 'project.status_created', `เพิ่มสถานะ ${row.name}`);
      return { ...statusDto(row), issueCount: 0 };
    });
  }

  async patchStatus(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, id: string, input: z.infer<typeof PatchStatusBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      const current = await this.statuses(tx, workflowId);
      const before = current.find((x) => x.id === id);
      if (!before) throw notFound('สถานะ');
      if (input.name !== undefined) assertUniqueName(current.filter((x) => x.id !== id), input.name);
      if (input.boardColumnId) {
        await this.checkBoardColumn(tx, project.id, workflowId, input.boardColumnId);
        // สถานะที่เป็นคอลัมน์ให้ Workflow อื่นอยู่ จะไปผูกคอลัมน์อื่นซ้อนไม่ได้
        const [used] = await tx.select({ id: s.workflowStatuses.id }).from(s.workflowStatuses).where(eq(s.workflowStatuses.boardColumnId, id)).limit(1);
        if (used) throw new AppError(422, 'status_is_board_column', 'สถานะนี้เป็นคอลัมน์ของ Workflow อื่นอยู่ ผูกกับคอลัมน์อื่นไม่ได้');
      }
      if (input.category !== undefined) assertCategories(current.map((x) => (x.id === id ? { ...x, category: input.category! } : x)));
      const [row] = await tx.update(s.workflowStatuses).set(input).where(eq(s.workflowStatuses.id, id)).returning();
      return { ...statusDto(row), issueCount: await this.statusCount(tx, id) };
    });
  }

  /**
   * ลบสถานะ: งาน (รวมงานในถังขยะ) ย้ายไป moveTo · สถานะของ Workflow อื่นที่ใช้สถานะนี้เป็นคอลัมน์บอร์ดย้ายไปคอลัมน์ใหม่
   * กฎที่อ้างสถานะนี้ใน config ถูกลบ เพราะไม่มีสถานะให้ตรวจแล้ว
   */
  async deleteStatus(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, id: string, input: z.infer<typeof DeleteStatusBody>) {
    return this.write(auth, tenant, key, async (tx, { project }, events) => {
      await this.workflow(tx, project.id, workflowId);
      const current = await this.statuses(tx, workflowId);
      const status = current.find((x) => x.id === id);
      if (!status) throw notFound('สถานะ');
      assertCategories(current.filter((x) => x.id !== id));
      if (input.moveTo === id) throw new AppError(400, 'invalid_move_to', 'ต้องย้ายงานไปสถานะอื่น');
      const live = await this.statusCount(tx, id);
      if (live && !input.moveTo) throw new AppError(409, 'status_has_issues', `สถานะนี้มีงาน ${live} งาน ต้องเลือกสถานะที่จะย้ายงานไป`, { issueCount: live });
      const target = input.moveTo ? current.find((x) => x.id === input.moveTo) : current.find((x) => x.id !== id && x.category === status.category) ?? current.find((x) => x.id !== id)!;
      if (!target) throw new AppError(422, 'status_not_in_workflow', 'สถานะปลายทางต้องอยู่ใน Workflow เดียวกัน');

      // ย้ายงานไปสถานะใหม่ (ไม่แก้ Actual Start / End เพราะเป็นการจัดโครงสร้าง ไม่ใช่งานเดินหน้า)
      const moved = await tx.update(s.issues).set({ statusId: target.id }).where(eq(s.issues.statusId, id)).returning();
      for (const issue of moved) {
        if (issue.deletedAt) continue;
        await tx.insert(s.activities).values({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, verb: 'updated', field: 'statusId', oldValue: id, newValue: target.id });
        const ev = issueEvent(tenant, project, auth.userId, issue);
        events.push(ev('issue.updated', { fields: ['statusId'] }));
        events.push(ev('issue.status_changed', { from: { id, name: status.name, category: status.category }, to: { id: target.id, name: target.name, category: target.category }, parentId: issue.parentId }));
      }
      await tx.update(s.workflowStatuses).set({ boardColumnId: target.boardColumnId ? null : target.id }).where(eq(s.workflowStatuses.boardColumnId, id));
      const removedRules = await tx.delete(s.workflowRules).where(and(
        eq(s.workflowRules.workflowId, workflowId),
        or(sql`${s.workflowRules.config}->>'fromStatusId' = ${id}`, sql`${s.workflowRules.config}->>'toStatusId' = ${id}`),
      )).returning({ id: s.workflowRules.id });
      await tx.delete(s.workflowStatuses).where(eq(s.workflowStatuses.id, id));
      await audit(tx, auth, tenant, project, 'project.status_deleted', `ลบสถานะ ${status.name}${live ? ` ย้ายงาน ${live} งานไป ${target.name}` : ''}`);
      return { id, movedIssues: live, moveTo: live || moved.length ? target.id : null, removedRules: removedRules.map((r) => r.id) };
    });
  }

  /**
   * เปลี่ยน Workflow มาตรฐานของโปรเจกต์ที่เริ่มงานแล้วเป็นชุด Development + QA ในธุรกรรมเดียว (ผู้ใช้ขอ 2026-11-11)
   * - สถานะเดิมตัวแรกที่จับคู่กับสถานะใหม่ถูกเปลี่ยนชื่อ / หมวดแทนการลบ id จึงคงเดิม ประวัติงานและลิงก์ไม่หาย
   * - สถานะเดิมตัวอื่นที่จับคู่ซ้ำ: ย้ายงานไปตัวแรกแล้วลบ (แบบเดียวกับ deleteStatus) · สถานะใหม่ที่ไม่มีคู่สร้างเพิ่ม
   */
  async applyDevQa(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, input: z.infer<typeof ApplyDevQaBody>) {
    return this.write(auth, tenant, key, async (tx, { project }, events) => {
      await this.workflow(tx, project.id, workflowId);
      if ((await this.kind(tx, project.id, workflowId)) !== 'standard') throw new AppError(422, 'workflow_not_standard', 'เปลี่ยนเป็นชุด Development + QA ได้เฉพาะ Workflow มาตรฐาน');
      const current = await this.statuses(tx, workflowId);
      const missing = current.filter((x) => !input.mapping[x.id]).map((x) => x.id);
      const unknown = Object.keys(input.mapping).filter((id) => !current.some((x) => x.id === id));
      if (missing.length || unknown.length) {
        throw new AppError(422, 'mapping_incomplete', 'ต้องเลือกสถานะใหม่ให้สถานะเดิมทุกตัวใน Workflow นี้', { missing, unknown });
      }

      // ชื่อชั่วคราวก่อน เพื่อไม่ให้ชื่อใหม่ชนกับชื่อเดิมของสถานะอื่นระหว่างเปลี่ยน
      for (const st of current) await tx.update(s.workflowStatuses).set({ name: `~${st.id}` }).where(eq(s.workflowStatuses.id, st.id));

      let moved = 0;
      const created: string[] = [];
      for (const [sort, spec] of DEV_QA_FLOW.entries()) {
        const mapped = current.filter((x) => input.mapping[x.id] === spec.key);
        if (!mapped.length) {
          await tx.insert(s.workflowStatuses).values({ workspaceId: tenant.workspaceId, projectId: project.id, workflowId, name: spec.name, category: spec.category, sort });
          created.push(spec.name);
          continue;
        }
        const [keep, ...merge] = mapped;
        const [target] = await tx.update(s.workflowStatuses).set({ name: spec.name, category: spec.category, sort }).where(eq(s.workflowStatuses.id, keep.id)).returning();
        for (const old of merge) {
          // ย้ายงาน (ไม่แก้ Actual Start / End เพราะเป็นการจัดโครงสร้าง ไม่ใช่งานเดินหน้า)
          const issues = await tx.update(s.issues).set({ statusId: target.id }).where(eq(s.issues.statusId, old.id)).returning();
          for (const issue of issues) {
            if (issue.deletedAt) continue;
            moved++;
            await tx.insert(s.activities).values({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, verb: 'updated', field: 'statusId', oldValue: old.id, newValue: target.id });
            const ev = issueEvent(tenant, project, auth.userId, issue);
            events.push(ev('issue.updated', { fields: ['statusId'] }));
            events.push(ev('issue.status_changed', { from: { id: old.id, name: old.name, category: old.category }, to: { id: target.id, name: target.name, category: target.category }, parentId: issue.parentId }));
          }
          // คอลัมน์บอร์ดของ Bug และกฎย้ายสถานะจาก Git ที่ชี้สถานะเดิม → ชี้สถานะที่รวมเข้าไป
          await tx.update(s.workflowStatuses).set({ boardColumnId: target.id }).where(eq(s.workflowStatuses.boardColumnId, old.id));
          await tx.update(s.projectRepositories).set({ onFirstCommitStatusId: target.id }).where(eq(s.projectRepositories.onFirstCommitStatusId, old.id));
          await tx.update(s.projectRepositories).set({ onPrOpenStatusId: target.id }).where(eq(s.projectRepositories.onPrOpenStatusId, old.id));
          await tx.update(s.projectRepositories).set({ onMergeStatusId: target.id }).where(eq(s.projectRepositories.onMergeStatusId, old.id));
          await tx.delete(s.workflowRules).where(and(
            eq(s.workflowRules.workflowId, workflowId),
            or(sql`${s.workflowRules.config}->>'fromStatusId' = ${old.id}`, sql`${s.workflowRules.config}->>'toStatusId' = ${old.id}`),
          ));
          await tx.delete(s.workflowStatuses).where(eq(s.workflowStatuses.id, old.id));
        }
      }
      if (project.progressSplit !== input.progressSplit) await tx.update(s.projects).set({ progressSplit: input.progressSplit }).where(eq(s.projects.id, project.id));
      await audit(tx, auth, tenant, project, 'project.workflow_changed', `เปลี่ยน Workflow เป็นชุด Development + QA${moved ? ` ย้ายงาน ${moved} งาน` : ''}${created.length ? ` เพิ่มสถานะ ${created.join(', ')}` : ''}`);
      return { items: await this.statusDtos(tx, workflowId), movedIssues: moved, created, progressSplit: input.progressSplit };
    });
  }

  async reorderStatuses(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, input: z.infer<typeof ReorderBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      assertFullOrder(await this.statuses(tx, workflowId), input.ids);
      for (const [sort, id] of input.ids.entries()) await tx.update(s.workflowStatuses).set({ sort }).where(eq(s.workflowStatuses.id, id));
      return { items: await this.statusDtos(tx, workflowId) };
    });
  }

  // ---------------------------------------------------------------------------
  // กฎการย้ายสถานะ · ตรวจจริงใน issues/rules.ts (A03)
  // ---------------------------------------------------------------------------
  async listRules(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string) {
    return this.read(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      const rules = await this.rules(tx, workflowId);
      return { items: rules.map(ruleDto), catalog: ruleCatalog(await this.kind(tx, project.id, workflowId), rules) };
    });
  }

  async createRule(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, input: z.infer<typeof CreateRuleBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      await this.checkConfig(tx, workflowId, input.config);
      const same = (await this.rules(tx, workflowId)).find((r) => r.ruleType === input.ruleType && sameConfig(r.config as RuleConfig, input.config));
      if (same) throw new AppError(409, 'rule_exists', 'Workflow นี้มีกฎนี้อยู่แล้ว แก้ไขกฎเดิมแทน', { ruleId: same.id });
      const [row] = await tx.insert(s.workflowRules).values({ workspaceId: tenant.workspaceId, projectId: project.id, workflowId, ruleType: input.ruleType, config: input.config, enabled: input.enabled }).returning();
      await audit(tx, auth, tenant, project, 'project.workflow_rule_changed', `เพิ่มกฎ ${WORKFLOW_RULES[input.ruleType].title} (${input.enabled ? 'เปิด' : 'ปิด'})`);
      return ruleDto(row);
    });
  }

  async patchRule(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, id: string, input: z.infer<typeof PatchRuleBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      const rules = await this.rules(tx, workflowId);
      const rule = rules.find((r) => r.id === id);
      if (!rule) throw notFound('กฎ');
      if (input.config) {
        await this.checkConfig(tx, workflowId, input.config);
        const same = rules.find((r) => r.id !== id && r.ruleType === rule.ruleType && sameConfig(r.config as RuleConfig, input.config!));
        if (same) throw new AppError(409, 'rule_exists', 'Workflow นี้มีกฎนี้อยู่แล้ว แก้ไขกฎเดิมแทน', { ruleId: same.id });
      }
      const [row] = await tx.update(s.workflowRules).set(input).where(eq(s.workflowRules.id, id)).returning();
      if (input.enabled !== undefined && input.enabled !== rule.enabled) {
        await audit(tx, auth, tenant, project, 'project.workflow_rule_changed', `${input.enabled ? 'เปิด' : 'ปิด'}กฎ ${titleOf(rule.ruleType)}`);
      }
      return ruleDto(row);
    });
  }

  async deleteRule(auth: AuthInfo, tenant: TenantInfo, key: string, workflowId: string, id: string) {
    await this.write(auth, tenant, key, async (tx, { project }) => {
      await this.workflow(tx, project.id, workflowId);
      const [row] = await tx.delete(s.workflowRules).where(and(eq(s.workflowRules.workflowId, workflowId), eq(s.workflowRules.id, id))).returning();
      if (!row) throw notFound('กฎ');
      await audit(tx, auth, tenant, project, 'project.workflow_rule_changed', `ลบกฎ ${titleOf(row.ruleType)}`);
    });
  }

  // ---------------------------------------------------------------------------
  // ประเภทงาน
  // ---------------------------------------------------------------------------
  async listIssueTypes(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.read(auth, tenant, key, async (tx, { project }) => ({
      items: await this.issueTypeDtos(tx, project),
      requiredFieldOptions: REQUIRED_FIELD_OPTIONS,
    }));
  }

  async getIssueType(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.read(auth, tenant, key, async (tx, { project }) => {
      const dto = (await this.issueTypeDtos(tx, project)).find((t) => t.id === id);
      if (!dto) throw notFound('ประเภทงาน');
      return dto;
    });
  }

  async patchIssueType(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchIssueTypeBody>) {
    return this.write(auth, tenant, key, async (tx, { project }) => {
      const types = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.projectId, project.id));
      const type = types.find((t) => t.id === id);
      if (!type) throw notFound('ประเภทงาน');
      if (input.enabled === false && !types.some((t) => t.id !== id && t.enabled)) {
        throw new AppError(422, 'last_issue_type', 'ต้องเปิดใช้ประเภทงานอย่างน้อย 1 ประเภท');
      }
      const set: Partial<IssueType> = {};
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.color !== undefined) set.color = input.color;
      // เรียงตามหน้าจอและไม่ซ้ำ · ชื่องานบังคับเสมอ
      if (input.requiredFields) set.requiredFields = REQUIRED_FIELD_OPTIONS.map((f) => f.key as string).filter((k) => k === 'title' || input.requiredFields!.includes(k));
      await tx.update(s.issueTypes).set(set).where(eq(s.issueTypes.id, id));
      if (input.enabled !== undefined && input.enabled !== type.enabled) {
        await audit(tx, auth, tenant, project, 'project.issue_type_changed', `${input.enabled ? 'เปิด' : 'ปิด'}ประเภทงาน ${type.name}`);
      }
      return (await this.issueTypeDtos(tx, project)).find((t) => t.id === id)!;
    });
  }

  // ---------------------------------------------------------------------------
  // ภายใน
  // ---------------------------------------------------------------------------
  private read<T>(auth: AuthInfo, tenant: TenantInfo, key: string, fn: (tx: Tx, ctx: Context) => Promise<T>) {
    return this.db.run(auth, tenant, async (tx) => fn(tx, await loadContext(tx, this.projects, auth, tenant, key, 'read')));
  }

  private async write<T>(auth: AuthInfo, tenant: TenantInfo, key: string, fn: (tx: Tx, ctx: Context, events: DomainEvent[]) => Promise<T>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => fn(tx, await loadContext(tx, this.projects, auth, tenant, key, 'write'), events));
    await this.events.publish(events);
    return result;
  }

  private async workflow(tx: Tx, projectId: string, id: string) {
    const [row] = await tx.select().from(s.workflows).where(and(eq(s.workflows.projectId, projectId), eq(s.workflows.id, id)));
    if (!row) throw notFound('Workflow');
    return row;
  }

  private async kind(tx: Tx, projectId: string, workflowId: string): Promise<WorkflowKind> {
    return kindOf(await tx.select().from(s.issueTypes).where(eq(s.issueTypes.projectId, projectId)), workflowId);
  }

  private statuses(tx: Tx, workflowId: string) {
    return tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.workflowId, workflowId)).orderBy(asc(s.workflowStatuses.sort), asc(s.workflowStatuses.name));
  }

  private rules(tx: Tx, workflowId: string) {
    return tx.select().from(s.workflowRules).where(eq(s.workflowRules.workflowId, workflowId)).orderBy(asc(s.workflowRules.id));
  }

  private async statusCount(tx: Tx, statusId: string) {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.issues).where(and(eq(s.issues.statusId, statusId), isNull(s.issues.deletedAt)));
    return row.n;
  }

  private async statusDtos(tx: Tx, workflowId: string) {
    const rows = await this.statuses(tx, workflowId);
    const counts = rows.length
      ? await tx.select({ id: s.issues.statusId, n: sql<number>`count(*)::int` }).from(s.issues)
        .where(and(inArray(s.issues.statusId, rows.map((r) => r.id)), isNull(s.issues.deletedAt))).groupBy(s.issues.statusId)
      : [];
    const byId = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((r) => ({ ...statusDto(r), issueCount: byId.get(r.id) ?? 0 }));
  }

  /** คอลัมน์บอร์ดต้องเป็นสถานะของ Workflow อื่นในโปรเจกต์ที่เป็นคอลัมน์เอง (เช่น Bug: Fixed → Review ของ Workflow มาตรฐาน) */
  private async checkBoardColumn(tx: Tx, projectId: string, workflowId: string, columnId: string) {
    const [col] = await tx.select().from(s.workflowStatuses).where(and(eq(s.workflowStatuses.projectId, projectId), eq(s.workflowStatuses.id, columnId)));
    if (!col || col.workflowId === workflowId || col.boardColumnId) {
      throw new AppError(422, 'invalid_board_column', 'คอลัมน์บนบอร์ดต้องเป็นสถานะของ Workflow มาตรฐาน', { boardColumnId: columnId });
    }
  }

  private async checkConfig(tx: Tx, workflowId: string, config: RuleConfig) {
    const ids = [config.fromStatusId, config.toStatusId].filter((x): x is string => !!x);
    if (!ids.length) return;
    const found = await tx.select({ id: s.workflowStatuses.id }).from(s.workflowStatuses).where(and(eq(s.workflowStatuses.workflowId, workflowId), inArray(s.workflowStatuses.id, ids)));
    if (found.length !== new Set(ids).size) throw new AppError(422, 'status_not_in_workflow', 'สถานะในกฎต้องอยู่ใน Workflow นี้');
  }

  private async issueTypeDtos(tx: Tx, project: ProjectRow) {
    const types = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.projectId, project.id)).orderBy(asc(s.issueTypes.sort), asc(s.issueTypes.name));
    const workflows = await tx.select().from(s.workflows).where(eq(s.workflows.projectId, project.id));
    const counts = await tx.select({ id: s.issues.issueTypeId, n: sql<number>`count(*)::int` }).from(s.issues)
      .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt))).groupBy(s.issues.issueTypeId);
    const byId = new Map(counts.map((c) => [c.id, c.n]));
    return types.map((t) => {
      const wf = workflows.find((w) => w.id === t.workflowId)!;
      return {
        id: t.id,
        name: t.name,
        color: t.color,
        icon: t.icon,
        workflow: { id: wf.id, name: wf.name },
        requiredFields: t.requiredFields,
        enabled: t.enabled,
        sort: t.sort,
        issueCount: byId.get(t.id) ?? 0,
      };
    });
  }
}

function statusDto(st: Status) {
  return { id: st.id, workflowId: st.workflowId, name: st.name, category: st.category, color: st.color, boardColumnId: st.boardColumnId, wipLimit: st.wipLimit, sort: st.sort };
}

function ruleDto(r: Rule) {
  const spec = WORKFLOW_RULES[r.ruleType as keyof typeof WORKFLOW_RULES];
  return { id: r.id, workflowId: r.workflowId, ruleType: r.ruleType, config: r.config, enabled: r.enabled, kind: spec?.kind ?? null, title: spec?.title ?? r.ruleType, description: spec?.description ?? null };
}

const titleOf = (type: string) => WORKFLOW_RULES[type as keyof typeof WORKFLOW_RULES]?.title ?? type;

/** Workflow ที่ประเภทงาน Bug ใช้ = Workflow ของ Bug · อื่น ๆ = มาตรฐาน */
function kindOf(types: { name: string; workflowId: string }[], workflowId: string): WorkflowKind {
  return types.some((t) => t.workflowId === workflowId && t.name === 'Bug') ? 'bug' : 'standard';
}

function sameConfig(a: RuleConfig, b: RuleConfig) {
  return (a?.fromStatusId ?? null) === (b.fromStatusId ?? null) && (a?.toStatusId ?? null) === (b.toStatusId ?? null);
}

function assertUniqueName(rows: Status[], name: string) {
  if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new AppError(409, 'status_name_taken', `มีสถานะชื่อ ${name} ใน Workflow นี้แล้ว`);
}

/** Workflow ต้องมีสถานะหมวด To do และ Done อย่างน้อยอย่างละ 1 */
function assertCategories(rows: { category: string }[]) {
  const missing = (['todo', 'done'] as const).filter((c) => !rows.some((r) => r.category === c));
  if (missing.length) throw new AppError(422, 'workflow_needs_todo_done', 'Workflow ต้องมีสถานะหมวด To do และ Done อย่างน้อยอย่างละ 1', { missing });
}
