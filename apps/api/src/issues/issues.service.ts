import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import { today } from '../common/dates.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { planEndFor, WorkCalendar } from '../projects/calendar.js';
import { type ProjectAccess, requirePerm, usersWithPerm } from '../projects/permissions.js';
import { loadPeople } from '../common/people.js';
import { type DomainEvent, EventBus, type EventType } from '../core/events.js';
import { isLegacyRank, PLAIN_RANK, rankAfter, rankBetween, spreadRanks } from './rank.js';
import { type ProjectRow, ProjectsService } from '../projects/projects.service.js';
import { listIssues, TableListQuery } from './table.js';
import { enforceWorkflowRules, workflowRuleEnabled } from './rules.js';

const s = schema;
const ISSUE_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;
const isoDate = z.iso.date();
const uuid = z.uuid();
const manDay = z.number().positive().max(9999).multipleOf(0.25);
const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
const DEFAULT_SIZE_MD: Record<string, number> = { XS: 1, S: 3, M: 5, L: 8, XL: 12 };

export const CreateIssueBody = z.object({
  type: z.enum(['Story', 'Task', 'Bug', 'Spike']).default('Task'),
  parentKey: z.string().optional(),
  moduleId: uuid.optional(),
  phaseId: uuid.optional(),
  sprintId: uuid.nullish(),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(50_000).optional(),
  statusId: uuid.optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  assigneeIds: z.array(uuid).max(20).default([]),
  baId: uuid.optional(),
  reviewerId: uuid.optional(),
  testerId: uuid.optional(),
  size: z.enum(SIZES).optional(),
  estimateMd: manDay.optional(),
  planStart: isoDate.optional(),
  planEnd: isoDate.optional(),
  severity: z.enum(['critical', 'major', 'minor']).optional(),
  environment: z.enum(['local', 'sit', 'uat', 'production']).optional(),
  details: z.record(z.string(), z.unknown()).default({}),
  sharedWithGuests: z.boolean().default(false),
});

export const PatchIssueBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(50_000).nullable(),
    statusId: uuid,
    priority: z.enum(['urgent', 'high', 'medium', 'low']),
    moduleId: uuid,
    phaseId: uuid.nullable(),
    sprintId: uuid.nullable(),
    assigneeIds: z.array(uuid).max(20).refine((ids) => new Set(ids).size === ids.length, 'รายชื่อผู้รับผิดชอบซ้ำ'),
    baId: uuid.nullable(),
    reviewerId: uuid.nullable(),
    testerId: uuid.nullable(),
    size: z.enum(SIZES).nullable(),
    estimateMd: manDay.nullable(),
    planStart: isoDate.nullable(),
    planEnd: isoDate.nullable(),
    progressPct: z.number().int().min(0).max(100).nullable(),
    severity: z.enum(['critical', 'major', 'minor']).nullable(),
    environment: z.enum(['local', 'sit', 'uat', 'production']).nullable(),
    details: z.record(z.string(), z.unknown()),
    sharedWithGuests: z.boolean(),
    /** ต้องมีเมื่อแก้แผน (Plan Start / End, Man-Day, Dev) หลังตั้ง Baseline */
    planChangeReason: z.string().trim().min(1).max(1000),
  })
  .partial();

export const ListQuery = TableListQuery;

export const AssigneesBody = z.object({
  assigneeIds: z.array(uuid).max(20).refine((ids) => new Set(ids).size === ids.length, 'รายชื่อผู้รับผิดชอบซ้ำ'),
  planChangeReason: z.string().trim().min(1).max(1000).optional(),
});

export const BulkIssueBody = z.discriminatedUnion('delete', [
  z.object({ keys: z.array(z.string().regex(ISSUE_KEY_PATTERN)).min(1).max(500), delete: z.literal(true), confirmText: z.string() }).strict(),
  z.object({ keys: z.array(z.string().regex(ISSUE_KEY_PATTERN)).min(1).max(500), delete: z.literal(false).optional(), set: PatchIssueBody.pick({ planEnd: true, moduleId: true, sprintId: true, assigneeIds: true, planChangeReason: true }).refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้') }).strict(),
]);

/** ลากการ์ดใน Kanban / Backlog / ปุ่ม ‹ › บนมือถือ (03-api › POST i/move) */
export const MoveIssueBody = z.object({
  /** สถานะใหม่ · ส่งคอลัมน์ของบอร์ดมาตรฐานได้ ระบบเลือกสถานะของ Workflow งานนั้นที่ผูกกับคอลัมน์ให้ (เช่น Bug: Review → Fixed) */
  statusId: uuid.optional(),
  sprintId: uuid.nullable().optional(),
  /** การ์ดที่อยู่เหนือตำแหน่งที่วาง */
  afterKey: z.string().optional(),
  /** การ์ดที่อยู่ใต้ตำแหน่งที่วาง */
  beforeKey: z.string().optional(),
  /** ยืนยันย้ายไปสถานะ Done ทั้งที่ Sub-task ยังไม่ครบ */
  confirm: z.boolean().default(false),
});

type Issue = typeof s.issues.$inferSelect;
type Status = typeof s.workflowStatuses.$inferSelect;
type Warning = { code: string; message: string };
const ISSUE_KEY = ISSUE_KEY_PATTERN;
const PLAN_FIELDS = ['planStart', 'planEnd', 'estimateMd'] as const;

@Injectable()
export class IssuesService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly events: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // สร้าง (หน้า B, K1)
  // ---------------------------------------------------------------------------
  async create(auth: AuthInfo, tenant: TenantInfo, projectKey: string, input: z.infer<typeof CreateIssueBody>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, projectKey);
      requirePerm(access, 'issue.create');
      // ใช้ลำดับเดียวกับ Sprint complete: โปรเจกต์ → แม่ → ลูก และตรวจ Sprint หลังได้ lock
      await this.lockProject(tx, project.id);
      const warnings: Warning[] = [];
      const base = { workspaceId: tenant.workspaceId, projectId: project.id };

      const [type] = await tx
        .select()
        .from(s.issueTypes)
        .where(and(eq(s.issueTypes.projectId, project.id), eq(s.issueTypes.name, input.type), eq(s.issueTypes.enabled, true)));
      if (!type) throw new AppError(400, 'issue_type_disabled', `ประเภทงาน ${input.type} ปิดอยู่ในโปรเจกต์นี้`);

      // Sub-task: งานแม่ต้องเป็นระดับ Task ในโปรเจกต์เดียวกัน และสืบทอด Module / กลุ่มงาน / Sprint
      let parent: Issue | null = null;
      if (input.parentKey) {
        parent = await this.findByKey(tx, project, input.parentKey);
        // ล็อกแม่ร่วมกับการลบ เพื่อไม่สร้างลูกเข้าไปหลังจากแม่ถูกย้ายลงถังขยะ
        await tx.select({ id: s.issues.id }).from(s.issues).where(eq(s.issues.id, parent.id)).for('update');
        parent = await this.findByKey(tx, project, input.parentKey);
        if (parent.parentId) throw new AppError(422, 'issue_depth_exceeded', 'Sub-task ต้องอยู่ใต้งานระดับ Task เท่านั้น');
      }
      const moduleId = parent ? parent.moduleId : input.moduleId;
      const phaseId = parent ? parent.phaseId : input.phaseId;
      const sprintId = parent ? parent.sprintId : (input.sprintId ?? null);

      this.checkRequired(type.requiredFields, { ...input, moduleId: moduleId ?? undefined });
      await this.checkInProject(tx, project.id, { moduleId, phaseId, sprintId });
      await this.checkPeople(tx, [...input.assigneeIds, input.baId, input.reviewerId, input.testerId]);

      const statusId = input.statusId ?? (await this.firstStatus(tx, type.workflowId));
      await this.checkStatus(tx, type.workflowId, statusId);

      // Size → Man-Day ตามค่าของโปรเจกต์ / Workspace · กรอก Man-Day เองได้
      const estimateMd = input.estimateMd ?? (input.size ? await this.sizeToMd(tx, project, input.size) : undefined);

      // วันที่: Plan Start ตรงวันหยุดเลื่อนเป็นวันทำงานถัดไป · Plan End คำนวณจาก Man-Day ÷ จำนวน Dev
      const cal = await WorkCalendar.load(tx, project);
      let planStart = input.planStart;
      if (planStart && !cal.isWorkingDay(planStart)) {
        const moved = cal.onOrAfter(planStart);
        warnings.push({ code: 'plan_start_moved', message: `Plan Start ${planStart} ไม่ใช่วันทำการ เลื่อนเป็น ${moved}` });
        planStart = moved;
      }
      let planEnd = input.planEnd;
      if (!planEnd && planStart && estimateMd) planEnd = planEndFor(cal, planStart, estimateMd);
      if (planStart && planEnd && planEnd < planStart) throw new AppError(400, 'invalid_dates', 'Plan End ต้องไม่ก่อน Plan Start');
      if (parent) warnings.push(...outsideParent(parent, planStart, planEnd));

      const number = await this.nextNumber(tx, project.id);
      const rank = await this.rankAtEnd(tx, project.id);
      const [issue] = await tx
        .insert(s.issues)
        .values({
          ...base,
          number,
          rank,
          issueTypeId: type.id,
          parentId: parent?.id,
          moduleId,
          phaseId,
          sprintId,
          title: input.title,
          description: input.description,
          statusId,
          priority: input.priority,
          baId: input.baId,
          reviewerId: input.reviewerId,
          testerId: input.testerId,
          reporterId: auth.userId,
          createdBy: auth.userId,
          size: input.size,
          estimateMd,
          planStart,
          planEnd,
          severity: input.severity,
          environment: input.environment,
          details: input.details,
          sharedWithGuests: input.sharedWithGuests,
        })
        .returning();

      if (input.assigneeIds.length) {
        await tx.insert(s.issueAssignees).values(input.assigneeIds.map((userId, i) => ({ workspaceId: tenant.workspaceId, issueId: issue.id, userId, sort: i })));
      }
      await tx.insert(s.issueWatchers).values({ workspaceId: tenant.workspaceId, issueId: issue.id, userId: auth.userId, source: 'auto_create' });
      await tx.insert(s.activities).values({ ...base, issueId: issue.id, actorId: auth.userId, verb: 'created' });

      const ev = eventFor(auth, tenant, project, issue);
      events.push(ev('issue.created', { type: type.name, parentKey: parent ? `${project.key}-${parent.number}` : null }));
      if (type.name === 'Bug') events.push(ev('bug.created', { severity: issue.severity }));
      if (input.assigneeIds.length) events.push(ev('issue.assigned', { userIds: input.assigneeIds, removedUserIds: [] }));
      return { ...(await this.dto(tx, project, issue, access)), warnings };
    });
    await this.events.publish(events);
    return result;
  }

  // ---------------------------------------------------------------------------
  // อ่าน
  // ---------------------------------------------------------------------------
  async get(auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.loadIssue(tx, auth, tenant, issueKey);
      const subtasks = await tx
        .select()
        .from(s.issues)
        .where(and(eq(s.issues.parentId, issue.id), isNull(s.issues.deletedAt)))
        .orderBy(asc(s.issues.number));
      const bugTypes = access.guestViewer ? await tx.select({ id: s.issueTypes.id }).from(s.issueTypes).where(and(eq(s.issueTypes.projectId, project.id), eq(s.issueTypes.name, 'Bug'))) : [];
      const visibleSubs = access.guestViewer ? subtasks.filter((x) => x.sharedWithGuests && !bugTypes.some((t) => t.id === x.issueTypeId)) : subtasks;
      // คำขอเลื่อน Due ที่รออยู่ (แถบ "ขอเลื่อนเป็น … · รอ … อนุมัติ" ในหน้า C / K3)
      const [pending] = access.guestViewer
        ? []
        : await tx
            .select()
            .from(s.dueChangeRequests)
            .where(and(eq(s.dueChangeRequests.issueId, issue.id), eq(s.dueChangeRequests.status, 'pending')));
      return {
        ...(await this.dto(tx, project, issue, access)),
        subtasks: await this.dtos(tx, project, visibleSubs, access),
        pendingDueRequest: pending
          ? { id: pending.id, requesterId: pending.requesterId, currentDue: pending.currentDue, requestedDue: pending.requestedDue, reasonCode: pending.reasonCode, createdAt: pending.createdAt }
          : null,
      };
    });
  }

  async list(auth: AuthInfo, tenant: TenantInfo, projectKey: string, q: z.infer<typeof ListQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, projectKey);
      return listIssues(tx, auth, project, access, q, (rows) => this.dtos(tx, project, rows, access));
    });
  }

  async formOptions(auth: AuthInfo, tenant: TenantInfo, projectKey: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, projectKey);
      requirePerm(access, 'issue.create');
      // Guest Member เห็นเฉพาะคนในโปรเจกต์ ไม่เปิด directory ทั้ง Workspace
      if (access.guestViewer) throw new AppError(403, 'forbidden', 'ไม่มีสิทธิ์สร้างงาน');
      const modules = await tx.select().from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort), asc(s.modules.id));
      const phases = await tx.select().from(s.phases).where(eq(s.phases.projectId, project.id)).orderBy(asc(s.phases.sort), asc(s.phases.id));
      const sprints = await tx.select().from(s.sprints).where(eq(s.sprints.projectId, project.id)).orderBy(asc(s.sprints.number));
      const members = await tx.select({ userId: s.projectMembers.userId, role: s.projectMembers.role }).from(s.projectMembers)
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.projectMembers.workspaceId), eq(s.workspaceMembers.userId, s.projectMembers.userId), eq(s.workspaceMembers.status, 'active')))
        .where(eq(s.projectMembers.projectId, project.id));
      const people = await loadPeople(tx, [...members.map((m) => m.userId), project.ownerUserId]);
      const issueTypes = await tx.select().from(s.issueTypes).where(and(eq(s.issueTypes.projectId, project.id), eq(s.issueTypes.enabled, true))).orderBy(asc(s.issueTypes.sort));
      const statuses = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.projectId, project.id)).orderBy(asc(s.workflowStatuses.sort));
      const labels = await tx.select().from(s.labels).where(eq(s.labels.projectId, project.id)).orderBy(asc(s.labels.name));
      return { modules: modules.map((m) => ({ ...m, phases: phases.filter((p) => p.moduleId === m.id) })), phases, sprints,
        members: [...people.values()].map((p) => ({ ...p, role: members.find((m) => m.userId === p.id)?.role ?? 'admin' })),
        sizeMdMap: (project.sizeMdMap as Record<string, number> | null) ?? await this.workspaceSizeMap(tx, project.workspaceId), labels,
        issueTypes: issueTypes.map((type) => ({ ...type, statuses: statuses.filter((st) => st.workflowId === type.workflowId) })) };
    });
  }

  async setAssignees(auth: AuthInfo, tenant: TenantInfo, issueKey: string, ifMatch: string | undefined, input: z.infer<typeof AssigneesBody>) {
    // ใช้ PATCH ทางเดียว เพื่อให้สิทธิ์, Baseline, version และ Event ใช้กติกาเดียวกัน
    return this.patch(auth, tenant, issueKey, ifMatch, input);
  }

  async bulk(auth: AuthInfo, tenant: TenantInfo, projectKey: string, input: z.infer<typeof BulkIssueBody>) {
    const keys = [...new Set(input.keys.map((k) => k.toUpperCase()))];
    await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, projectKey);
      requirePerm(access, input.delete ? 'issue.delete' : 'issue.edit');
      if (keys.some((key) => ISSUE_KEY.exec(key)?.[1] !== project.key)) throw new AppError(400, 'invalid_reference', 'งานทั้งหมดต้องอยู่ในโปรเจกต์นี้');
    });
    if (input.delete && input.confirmText !== `ลบ ${keys.length} งาน`) {
      throw new AppError(400, 'confirmation_required', `พิมพ์ ลบ ${keys.length} งาน เพื่อยืนยัน`, { confirmText: `ลบ ${keys.length} งาน` });
    }
    const results: { key: string; ok: boolean; error?: { code: string; message: string; details: unknown; status: number } }[] = [];
    // แต่ละงานเป็นธุรกรรมอิสระ งานที่ติดกติกาไม่ย้อนงานที่สำเร็จไปแล้ว
    for (const key of keys) {
      try {
        if (input.delete) await this.remove(auth, tenant, key);
        else {
          const issue = await this.get(auth, tenant, key);
          await this.patch(auth, tenant, key, `"${issue.version}"`, input.set);
        }
        results.push({ key, ok: true });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        results.push({ key, ok: false, error: { code: error.code, message: error.message, details: error.details, status: error.getStatus() } });
      }
    }
    return { results };
  }

  async deleteImpact(auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.loadIssue(tx, auth, tenant, issueKey);
      requirePerm(access, 'issue.delete');
      const children = await tx.select().from(s.issues).where(and(eq(s.issues.parentId, issue.id), isNull(s.issues.deletedAt)));
      const ids = [issue.id, ...children.map((c) => c.id)];
      const attachments = await tx.select({ id: s.files.id, name: s.files.name, targetType: s.fileAttachments.targetType, targetId: s.fileAttachments.targetId })
        .from(s.fileAttachments).innerJoin(s.files, eq(s.files.id, s.fileAttachments.fileId))
        .where(and(isNull(s.files.deletedAt), sql`(
          (${s.fileAttachments.targetType} = 'issue' and ${inArray(s.fileAttachments.targetId, ids)}) or
          (${s.fileAttachments.targetType} = 'test_run' and ${s.fileAttachments.targetId} in (select id from ${s.testRuns} where ${inArray(s.testRuns.issueId, ids)})) or
          (${s.fileAttachments.targetType} = 'comment' and ${s.fileAttachments.targetId} in (select id from ${s.comments} where ${inArray(s.comments.issueId, ids)}))
        )`));
      const dependencies = await tx.select().from(s.issueDependencies).where(sql`${inArray(s.issueDependencies.predecessorId, ids)} or ${inArray(s.issueDependencies.successorId, ids)}`);
      const files = [...new Map(attachments.map((f) => [f.id, { id: f.id, name: f.name }])).values()];
      return { subtasks: await this.dtos(tx, project, children, access), files, dependencies,
        counts: { subtasks: children.length, files: files.length, dependencies: dependencies.length } };
    });
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.lifecycleIssue(tx, auth, tenant, issueKey);
      if (issue.deletedAt) return { key: issueKey.toUpperCase(), deletedAt: issue.deletedAt, alreadyDeleted: true };
      const children = await tx.select().from(s.issues).where(and(eq(s.issues.parentId, issue.id), isNull(s.issues.deletedAt))).for('update');
      const rows = [issue, ...children];
      const deletedAt = new Date();
      await tx.update(s.issues).set({ deletedAt, version: sql`${s.issues.version} + 1` }).where(inArray(s.issues.id, rows.map((r) => r.id)));
      await tx.insert(s.activities).values(rows.map((r) => ({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: r.id, actorId: auth.userId,
        verb: 'deleted', field: 'deletedAt', newValue: { deletedAt: deletedAt.toISOString(), cascadeRootId: issue.id } })));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'issue.deleted', targetType: 'issue', targetId: issue.id, summary: `ลบ ${project.key}-${issue.number} พร้อม Sub-task ${children.length} งาน` });
      for (const row of rows) events.push(eventFor(auth, tenant, project, row)('issue.deleted', { cascadeRootId: issue.id }));
      return { key: issueKey.toUpperCase(), deletedAt, restorableUntil: restoreDeadline(deletedAt), subtasks: children.length };
    });
    await this.events.publish(events);
    return result;
  }

  async restore(auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.lifecycleIssue(tx, auth, tenant, issueKey);
      if (!issue.deletedAt) return this.dto(tx, project, issue, access);
      if (restoreDeadline(issue.deletedAt).getTime() <= Date.now()) throw new AppError(410, 'restore_expired', 'เกินกำหนดกู้คืน 30 วันแล้ว', await this.deletedDetails(tx, issue, access));
      if (issue.parentId) {
        const [parent] = await tx.select().from(s.issues).where(eq(s.issues.id, issue.parentId));
        if (parent.deletedAt) throw new AppError(409, 'parent_deleted', 'ต้องกู้คืนงานแม่ก่อน');
      }
      const children = await tx.select().from(s.issues).where(and(eq(s.issues.parentId, issue.id), eq(s.issues.deletedAt, issue.deletedAt))).for('update');
      // คืนเฉพาะลูกที่ลบไปพร้อมแม่ครั้งนี้ ไม่คืนลูกที่ลบไว้ก่อนหน้านั้น
      const deletions = children.length ? await tx.select().from(s.activities).where(and(inArray(s.activities.issueId, children.map((c) => c.id)), eq(s.activities.verb, 'deleted'))).orderBy(sql`${s.activities.createdAt} desc`, sql`${s.activities.id} desc`) : [];
      const restoreChildren = children.filter((child) => {
        const deletion = deletions.find((a) => a.issueId === child.id)?.newValue as { cascadeRootId?: string; deletedAt?: string } | undefined;
        return deletion?.cascadeRootId === issue.id && deletion.deletedAt === issue.deletedAt!.toISOString();
      });
      const rows = [issue, ...restoreChildren];
      const updated = await tx.update(s.issues).set({ deletedAt: null, version: sql`${s.issues.version} + 1` }).where(inArray(s.issues.id, rows.map((r) => r.id))).returning();
      await tx.insert(s.activities).values(rows.map((r) => ({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: r.id, actorId: auth.userId, verb: 'restored', field: 'deletedAt', oldValue: r.deletedAt })));
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'issue.restored', targetType: 'issue', targetId: issue.id, summary: `กู้คืน ${project.key}-${issue.number} พร้อม Sub-task ${restoreChildren.length} งาน` });
      for (const row of updated) events.push(eventFor(auth, tenant, project, row)('issue.updated', { fields: ['deletedAt'] }));
      return this.dto(tx, project, updated.find((r) => r.id === issue.id)!, access);
    });
    await this.events.publish(events);
    return result;
  }

  async reopen(auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const loaded = await this.loadIssue(tx, auth, tenant, issueKey);
      const { project, access } = loaded;
      requirePerm(access, 'issue.edit');
      const [issue] = await tx.select().from(s.issues).where(eq(s.issues.id, loaded.issue.id)).for('update');
      if (issue.deletedAt) throw new AppError(410, 'gone', 'งานถูกลบแล้ว', await this.deletedDetails(tx, issue, access));
      const [type] = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.id, issue.issueTypeId));
      if (type.name !== 'Bug') throw new AppError(422, 'not_a_bug', 'เปิดใหม่ได้เฉพาะ Bug');
      const first = await this.firstStatus(tx, type.workflowId);
      if (issue.statusId === first) throw new AppError(409, 'bug_already_open', 'Bug นี้เปิดอยู่แล้ว');
      const [updated] = await tx.update(s.issues).set({ statusId: first, reopenCount: issue.reopenCount + 1, actualEnd: null, completedAt: null }).where(eq(s.issues.id, issue.id)).returning();
      await tx.insert(s.activities).values([
        { workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, verb: 'reopened', field: 'reopenCount', oldValue: issue.reopenCount, newValue: updated.reopenCount },
        { workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, verb: 'updated', field: 'statusId', oldValue: issue.statusId, newValue: first },
      ]);
      events.push(...await this.changeEvents(tx, auth, tenant, project, issue, updated, null));
      events.push(eventFor(auth, tenant, project, updated)('bug.reopened', { reopenCount: updated.reopenCount }));
      return this.dto(tx, project, updated, access);
    });
    await this.events.publish(events);
    return result;
  }

  private async lifecycleIssue(tx: Tx, auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    const m = ISSUE_KEY.exec(issueKey);
    if (!m) throw notFound('งาน');
    const { project, access } = await this.projects.load(tx, auth, tenant, m[1]);
    requirePerm(access, 'issue.delete');
    const [issue] = await tx.select().from(s.issues).where(and(eq(s.issues.projectId, project.id), eq(s.issues.number, Number(m[2])))).for('update');
    if (!issue) throw notFound('งาน');
    return { project, access, issue };
  }

  private async deletedDetails(tx: Tx, issue: Issue, access: ProjectAccess) {
    const [deletion] = await tx.select({ actorId: s.activities.actorId }).from(s.activities)
      .where(and(eq(s.activities.issueId, issue.id), eq(s.activities.verb, 'deleted'))).orderBy(sql`${s.activities.createdAt} desc`, sql`${s.activities.id} desc`).limit(1);
    const people = access.guestViewer ? new Map() : await loadPeople(tx, [deletion?.actorId]);
    return { deletedBy: access.guestViewer ? { displayName: 'ทีมพัฒนา' } : people.get(deletion?.actorId) ?? null,
      deletedAt: issue.deletedAt, restorableUntil: restoreDeadline(issue.deletedAt!) };
  }

  // ---------------------------------------------------------------------------
  // แก้ไข (PATCH + If-Match)
  // ---------------------------------------------------------------------------
  async patch(auth: AuthInfo, tenant: TenantInfo, issueKey: string, ifMatch: string | undefined, input: z.infer<typeof PatchIssueBody>) {
    const expected = parseIfMatch(ifMatch);
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      if (input.sprintId !== undefined) await this.lockSprintChangeProject(tx, auth, tenant, issueKey);
      const { project, access, issue } = await this.loadIssue(tx, auth, tenant, issueKey);
      requirePerm(access, 'issue.edit');
      if (issue.version !== expected) throw await this.conflict(tx, project, issue, access);

      const warnings: Warning[] = [];
      const [type] = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.id, issue.issueTypeId));
      const set: Partial<typeof s.issues.$inferInsert> = {};
      const copy = ['title', 'description', 'priority', 'baId', 'reviewerId', 'testerId', 'severity', 'environment', 'details', 'sharedWithGuests', 'size'] as const;
      for (const k of copy) if (input[k] !== undefined) (set as Record<string, unknown>)[k] = input[k];

      // Sub-task สืบทอด Module / กลุ่มงาน / Sprint จากงานแม่
      if (issue.parentId && (input.moduleId !== undefined || input.phaseId !== undefined || input.sprintId !== undefined)) {
        throw new AppError(422, 'inherited_field', 'Sub-task ใช้ Module, กลุ่มงาน และ Sprint ตามงานแม่');
      }
      if (input.moduleId !== undefined) set.moduleId = input.moduleId;
      if (input.phaseId !== undefined) set.phaseId = input.phaseId;
      if (input.sprintId !== undefined && input.sprintId !== issue.sprintId) set.sprintId = input.sprintId;
      await this.checkInProject(tx, project.id, { moduleId: set.moduleId, phaseId: set.phaseId, sprintId: set.sprintId });
      await this.checkPeople(tx, [...(input.assigneeIds ?? []), input.baId, input.reviewerId, input.testerId]);

      // ความคืบหน้ากรอกเองได้เฉพาะงานที่ไม่มีลูก
      if (input.progressPct !== undefined) {
        if (await this.hasChildren(tx, issue.id)) throw new AppError(422, 'progress_from_subtasks', 'ความคืบหน้าของ Task คำนวณจาก Sub-task');
        set.progressPct = input.progressPct;
      }

      // สถานะ: ต้องอยู่ใน Workflow ของประเภทงาน · Actual Start / End ตั้งอัตโนมัติ
      if (input.statusId !== undefined && input.statusId !== issue.statusId) {
        const next = await this.checkStatus(tx, type.workflowId, input.statusId);
        await enforceWorkflowRules(tx, auth, issue, type.workflowId, next, { ...issue, ...set }, false);
        Object.assign(set, statusChange(issue, next));
      }

      // แผน: Size → Man-Day · Plan End คำนวณใหม่เมื่อ Man-Day / Plan Start เปลี่ยนและไม่ได้ส่ง Plan End มาเอง (จำนวน Dev ไม่มีผล)
      const oldAssignees = await this.assigneeIds(tx, issue.id);
      const assignees = input.assigneeIds ?? oldAssignees;
      let estimateMd = input.estimateMd !== undefined ? input.estimateMd : issue.estimateMd;
      if (input.size !== undefined && input.estimateMd === undefined) estimateMd = input.size ? await this.sizeToMd(tx, project, input.size) : null;
      const cal = await WorkCalendar.load(tx, project);
      let planStart = input.planStart !== undefined ? input.planStart : issue.planStart;
      if (input.planStart && !cal.isWorkingDay(input.planStart)) {
        planStart = cal.onOrAfter(input.planStart);
        warnings.push({ code: 'plan_start_moved', message: `Plan Start ${input.planStart} ไม่ใช่วันทำการ เลื่อนเป็น ${planStart}` });
      }
      let planEnd = input.planEnd !== undefined ? input.planEnd : issue.planEnd;
      const drivers = input.planStart !== undefined || estimateMd !== issue.estimateMd;
      if (input.planEnd === undefined && drivers && planStart && estimateMd) planEnd = planEndFor(cal, planStart, estimateMd);
      if (planStart && planEnd && planEnd < planStart) throw new AppError(400, 'invalid_dates', 'Plan End ต้องไม่ก่อน Plan Start');

      // กติกาการเปลี่ยน Due (03-api › กติกาการเปลี่ยน Due): เลื่อนออกต้องมีสิทธิ์ · ดึงเข้าแก้ได้เลย
      if (issue.planEnd && planEnd && planEnd > issue.planEnd && !access.perms.has('issue.change_due_directly')) {
        const people = await loadPeople(tx, await usersWithPerm(tx, project, 'due_request.approve'));
        throw new AppError(403, 'due_change_requires_approval', 'ต้องส่งคำขอเลื่อน Due ให้ PM อนุมัติ', {
          currentDue: issue.planEnd,
          requestedDue: planEnd,
          canRequest: access.perms.has('issue.edit'),
          approvers: [...people.values()].filter((p) => p.id !== auth.userId),
        });
      }
      if (issue.parentId) {
        const [parent] = await tx.select().from(s.issues).where(eq(s.issues.id, issue.parentId));
        warnings.push(...outsideParent(parent, planStart ?? undefined, planEnd ?? undefined));
      }

      const before = { planStart: issue.planStart, planEnd: issue.planEnd, estimateMd: issue.estimateMd };
      const after = { planStart, planEnd, estimateMd };
      Object.assign(set, after);
      const planChanged = PLAN_FIELDS.filter((f) => before[f] !== after[f]);
      const assigneesChanged = input.assigneeIds !== undefined && !sameSet(oldAssignees, input.assigneeIds);

      // หลังตั้ง Baseline การแก้แผนต้องมีเหตุผล และบันทึกในแท็บ "การแก้ไขแผน"
      const [baseline] = await tx
        .select({ id: s.planBaselines.id })
        .from(s.planBaselines)
        .where(eq(s.planBaselines.projectId, project.id))
        .orderBy(sql`${s.planBaselines.version} desc`)
        .limit(1);
      if (baseline && (planChanged.length || assigneesChanged) && !input.planChangeReason) {
        throw new AppError(400, 'plan_change_reason_required', 'แก้แผนหลังตั้ง Baseline ต้องใส่เหตุผล', { fields: planChanged });
      }

      // รายชื่อ Dev อยู่อีกตาราง แถวงานไม่เปลี่ยน trigger จึงไม่เพิ่ม version ให้ · ต้องเพิ่มเองเพื่อให้ If-Match ยังจับการแก้ชนกันได้
      if (assigneesChanged) set.version = expected + 1;
      const [updated] = await tx
        .update(s.issues)
        .set(set)
        .where(and(eq(s.issues.id, issue.id), eq(s.issues.version, expected)))
        .returning();
      if (!updated) throw await this.conflict(tx, project, issue, access);

      if (assigneesChanged) {
        await tx.delete(s.issueAssignees).where(eq(s.issueAssignees.issueId, issue.id));
        if (assignees.length) {
          await tx.insert(s.issueAssignees).values(assignees.map((userId, i) => ({ workspaceId: tenant.workspaceId, issueId: issue.id, userId, sort: i })));
        }
      }
      // ย้าย Module / กลุ่มงาน / Sprint ของ Task แล้ว Sub-task ย้ายตาม
      if (!issue.parentId && (set.moduleId !== undefined || set.phaseId !== undefined || set.sprintId !== undefined)) {
        await tx
          .update(s.issues)
          .set({ moduleId: updated.moduleId, phaseId: updated.phaseId, sprintId: updated.sprintId })
          .where(eq(s.issues.parentId, issue.id));
      }

      const base = { workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id };
      const changes = diff(issue, updated);
      if (assigneesChanged) changes.push({ field: 'assigneeIds', oldValue: oldAssignees, newValue: assignees });
      if (changes.length) {
        await tx.insert(s.activities).values(changes.map((c) => ({ ...base, actorId: auth.userId, verb: 'updated', field: c.field, oldValue: c.oldValue, newValue: c.newValue })));
      }
      if (baseline && (planChanged.length || assigneesChanged)) {
        const planRows = changes.filter((c) => (PLAN_FIELDS as readonly string[]).includes(c.field) || c.field === 'assigneeIds');
        await tx.insert(s.planChanges).values(
          planRows.map((c) => ({ ...base, baselineId: baseline.id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, reason: input.planChangeReason, changedBy: auth.userId })),
        );
      }
      events.push(...(await this.changeEvents(tx, auth, tenant, project, issue, updated, assigneesChanged ? { before: oldAssignees, after: assignees } : null)));
      if (baseline && (planChanged.length || assigneesChanged)) {
        events.push(eventFor(auth, tenant, project, updated)('plan.changed', { fields: assigneesChanged ? [...planChanged, 'assigneeIds'] : [...planChanged], reason: input.planChangeReason }));
      }
      return { ...(await this.dto(tx, project, updated, access)), warnings };
    });
    await this.events.publish(events);
    return result;
  }

  // ---------------------------------------------------------------------------
  // ย้ายการ์ด (Kanban, Backlog, Mobile) · If-Match ไม่บังคับ เพราะการลากเป็นการแก้ทีละฟิลด์
  // ---------------------------------------------------------------------------
  async move(auth: AuthInfo, tenant: TenantInfo, issueKey: string, ifMatch: string | undefined, input: z.infer<typeof MoveIssueBody>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      if (input.sprintId !== undefined) await this.lockSprintChangeProject(tx, auth, tenant, issueKey);
      const { project, access, issue } = await this.loadIssue(tx, auth, tenant, issueKey);
      requirePerm(access, 'issue.edit');
      if (ifMatch !== undefined && parseIfMatch(ifMatch) !== issue.version) throw await this.conflict(tx, project, issue, access);

      const warnings: Warning[] = [];
      const set: Partial<typeof s.issues.$inferInsert> = {};
      const [type] = await tx.select().from(s.issueTypes).where(eq(s.issueTypes.id, issue.issueTypeId));
      const [current] = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.id, issue.statusId));
      let target = current;
      if (input.statusId && input.statusId !== issue.statusId) target = await this.dropStatus(tx, type.workflowId, current, input.statusId);

      if (target.id !== current.id) {
        await enforceWorkflowRules(tx, auth, issue, type.workflowId, target, issue, input.confirm);
        // กฎ Workflow: ย้ายไป Done ทั้งที่ Sub-task ยังไม่ครบ ต้องยืนยัน (Kanban แสดงปุ่ม "ยืนยันย้าย")
        if (target.category === 'done' && current.category !== 'done' && await workflowRuleEnabled(tx, type.workflowId, 'subtasks_done')) {
          const [open] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.issues)
            .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
            .where(and(eq(s.issues.parentId, issue.id), isNull(s.issues.deletedAt), ne(s.workflowStatuses.category, 'done')));
          if (open.n > 0 && !input.confirm) {
            throw new AppError(422, 'subtasks_incomplete', `ยังมี Sub-task ที่ไม่เสร็จ ${open.n} งาน`, { open: open.n, confirmable: true });
          }
          if (open.n > 0) warnings.push({ code: 'subtasks_incomplete', message: `ย้ายไป ${target.name} ทั้งที่ Sub-task ยังไม่เสร็จ ${open.n} งาน` });
        }
        Object.assign(set, { statusId: target.id, ...statusChange(issue, target) });
      }

      if (input.sprintId !== undefined && input.sprintId !== issue.sprintId) {
        if (issue.parentId) throw new AppError(422, 'inherited_field', 'Sub-task ใช้ Module, กลุ่มงาน และ Sprint ตามงานแม่');
        await this.checkInProject(tx, project.id, { sprintId: input.sprintId });
        set.sprintId = input.sprintId;
      }

      let updated = issue;
      if (Object.keys(set).length) {
        [updated] = await tx
          .update(s.issues)
          .set(set)
          .where(and(eq(s.issues.id, issue.id), eq(s.issues.version, issue.version)))
          .returning();
        if (!updated) throw await this.conflict(tx, project, issue, access);
        if (set.sprintId !== undefined) await tx.update(s.issues).set({ sprintId: set.sprintId }).where(eq(s.issues.parentId, issue.id));
        const base = { workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id };
        const changes = diff(issue, updated);
        if (changes.length) {
          await tx.insert(s.activities).values(changes.map((c) => ({ ...base, actorId: auth.userId, verb: 'updated', field: c.field, oldValue: c.oldValue, newValue: c.newValue })));
        }
      }

      // ลำดับในคอลัมน์ · แก้แค่ rank ไม่เพิ่ม version (migration 0004)
      if (input.afterKey || input.beforeKey) {
        const rank = await this.rankBetweenKeys(tx, project, issue.id, input.afterKey, input.beforeKey);
        [updated] = await tx.update(s.issues).set({ rank }).where(eq(s.issues.id, issue.id)).returning();
      }

      // WIP limit ของคอลัมน์ปลายทาง: เตือน ไม่บล็อก
      if (target.id !== current.id) {
        const columnId = target.boardColumnId ?? target.id;
        const [col] = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.id, columnId));
        if (col?.wipLimit && await workflowRuleEnabled(tx, type.workflowId, 'wip_warning')) {
          const [cnt] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.issues)
            .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
            .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt), sql`coalesce(${s.workflowStatuses.boardColumnId}, ${s.workflowStatuses.id}) = ${columnId}`));
          if (cnt.n > col.wipLimit) warnings.push({ code: 'wip_exceeded', message: `คอลัมน์ ${col.name} เกิน WIP limit (${cnt.n}/${col.wipLimit})` });
        }
      }
      events.push(...(await this.changeEvents(tx, auth, tenant, project, issue, updated, null)));
      return { ...(await this.dto(tx, project, updated, access)), warnings };
    });
    await this.events.publish(events);
    return result;
  }

  /** สถานะที่วางลงไป: ถ้าเป็นคอลัมน์ของบอร์ดมาตรฐานแต่งานใช้ Workflow อื่น (Bug) ใช้สถานะที่ผูกกับคอลัมน์นั้น */
  private async dropStatus(tx: Tx, workflowId: string, current: Status, statusId: string): Promise<Status> {
    const [st] = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.id, statusId));
    if (!st) throw new AppError(422, 'status_not_in_workflow', 'สถานะนี้ไม่อยู่ใน Workflow ของประเภทงานนี้');
    if (st.workflowId === workflowId) return st;
    // เรียงในคอลัมน์เดิม (เช่น Bug สถานะ Verified อยู่คอลัมน์ Review อยู่แล้ว) ไม่เปลี่ยนสถานะ
    if ((current.boardColumnId ?? current.id) === st.id) return current;
    const [mapped] = await tx
      .select()
      .from(s.workflowStatuses)
      .where(and(eq(s.workflowStatuses.workflowId, workflowId), eq(s.workflowStatuses.boardColumnId, st.id)))
      .orderBy(asc(s.workflowStatuses.sort))
      .limit(1);
    if (!mapped) throw new AppError(422, 'status_not_in_workflow', 'สถานะนี้ไม่อยู่ใน Workflow ของประเภทงานนี้');
    return mapped;
  }

  private async rankBetweenKeys(tx: Tx, project: ProjectRow, selfId: string, afterKey?: string, beforeKey?: string) {
    const load = async (key?: string) => (key ? this.findByKey(tx, project, key) : null);
    let [after, before] = [await load(afterKey), await load(beforeKey)];
    if (after?.id === selfId || before?.id === selfId) throw new AppError(400, 'invalid_neighbor', 'อ้างการ์ดตัวเองเป็นตำแหน่งไม่ได้');
    const usable = (!after || !isLegacyRank(after.rank)) && (!before || !isLegacyRank(before.rank)) && (!after || !before || after.rank < before.rank);
    if (!usable) {
      // ค่าเก่าที่ซ้ำกัน (งานจาก Import) → จัดลำดับทั้งโปรเจกต์ใหม่ตามที่แสดงอยู่ แล้วหาค่ากึ่งกลาง
      await this.rebalanceRanks(tx, project.id);
      [after, before] = [await load(afterKey), await load(beforeKey)];
    }
    if (after && before && after.rank >= before.rank) throw new AppError(400, 'invalid_neighbor', `${afterKey} ต้องอยู่เหนือ ${beforeKey}`);
    return rankBetween(after?.rank ?? null, before?.rank ?? null);
  }

  private async rebalanceRanks(tx: Tx, projectId: string) {
    const rows = await tx
      .select({ id: s.issues.id })
      .from(s.issues)
      .where(eq(s.issues.projectId, projectId))
      .orderBy(sql`${s.issues.rank} collate "C"`, asc(s.issues.number));
    if (!rows.length) return;
    const keys = spreadRanks(rows.length);
    const values = sql.join(
      rows.map((r, i) => sql`(${r.id}::uuid, ${keys[i]})`),
      sql`, `,
    );
    await tx.execute(sql`update ${s.issues} set rank = v.rank from (values ${values}) as v(id, rank) where ${s.issues.id} = v.id`);
  }

  /** งานใหม่ต่อท้ายลำดับ */
  private async rankAtEnd(tx: Tx, projectId: string) {
    const [last] = await tx
      .select({ rank: s.issues.rank })
      .from(s.issues)
      .where(and(eq(s.issues.projectId, projectId), sql`${s.issues.rank} ~ ${PLAIN_RANK.source}`))
      .orderBy(sql`${s.issues.rank} collate "C" desc`)
      .limit(1);
    return rankAfter(last?.rank ?? null);
  }

  // ---------------------------------------------------------------------------
  // ตัวช่วย
  // ---------------------------------------------------------------------------
  /** เหตุการณ์จากการแก้งาน: issue.updated · issue.status_changed · issue.assigned (ส่งหลัง commit) */
  private async changeEvents(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRow, before: Issue, after: Issue, assignees: { before: string[]; after: string[] } | null) {
    const ev = eventFor(auth, tenant, project, after);
    const out: DomainEvent[] = [];
    const fields = diff(before, after).map((c) => c.field);
    if (assignees) fields.push('assigneeIds');
    if (fields.length) out.push(ev('issue.updated', { fields }));
    if (before.statusId !== after.statusId) {
      const rows = await tx.select().from(s.workflowStatuses).where(inArray(s.workflowStatuses.id, [before.statusId, after.statusId]));
      const from = rows.find((r) => r.id === before.statusId)!;
      const to = rows.find((r) => r.id === after.statusId)!;
      out.push(ev('issue.status_changed', { from: { id: from.id, name: from.name, category: from.category }, to: { id: to.id, name: to.name, category: to.category }, parentId: after.parentId }));
    }
    if (assignees) {
      const added = assignees.after.filter((x) => !assignees.before.includes(x));
      const removed = assignees.before.filter((x) => !assignees.after.includes(x));
      if (added.length || removed.length) out.push(ev('issue.assigned', { userIds: added, removedUserIds: removed }));
    }
    return out;
  }

  async loadIssue(tx: Tx, auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    const m = ISSUE_KEY.exec(issueKey);
    if (!m) throw notFound('งาน');
    const { project, access } = await this.projects.load(tx, auth, tenant, m[1]);
    const issue = await this.findByKey(tx, project, issueKey, { includeDeleted: true });
    if (access.guestViewer) {
      const [type] = await tx.select({ name: s.issueTypes.name }).from(s.issueTypes).where(eq(s.issueTypes.id, issue.issueTypeId));
      if (!issue.sharedWithGuests || type.name === 'Bug') throw notFound('งาน');
    }
    if (issue.deletedAt) {
      throw new AppError(410, 'gone', `งาน ${issueKey.toUpperCase()} ถูกลบแล้ว`, await this.deletedDetails(tx, issue, access));
    }
    return { project, access, issue };
  }

  async findByKey(tx: Tx, project: ProjectRow, issueKey: string, opts: { includeDeleted?: boolean } = {}) {
    const m = ISSUE_KEY.exec(issueKey);
    if (!m || m[1].toUpperCase() !== project.key) throw notFound('งาน');
    const [issue] = await tx
      .select()
      .from(s.issues)
      .where(and(eq(s.issues.projectId, project.id), eq(s.issues.number, Number(m[2]))));
    if (!issue || (issue.deletedAt && !opts.includeDeleted)) throw notFound('งาน');
    return issue;
  }

  private async nextNumber(tx: Tx, projectId: string) {
    const [r] = await tx
      .update(s.projects)
      .set({ issueSeq: sql`${s.projects.issueSeq} + 1` })
      .where(eq(s.projects.id, projectId))
      .returning({ n: s.projects.issueSeq });
    return r.n;
  }

  private async firstStatus(tx: Tx, workflowId: string) {
    const [st] = await tx
      .select({ id: s.workflowStatuses.id })
      .from(s.workflowStatuses)
      .where(and(eq(s.workflowStatuses.workflowId, workflowId), eq(s.workflowStatuses.category, 'todo')))
      .orderBy(asc(s.workflowStatuses.sort))
      .limit(1);
    return st.id;
  }

  async checkStatus(tx: Tx, workflowId: string, statusId: string) {
    const [st] = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.id, statusId));
    if (!st || st.workflowId !== workflowId) throw new AppError(422, 'status_not_in_workflow', 'สถานะนี้ไม่อยู่ใน Workflow ของประเภทงานนี้');
    return st;
  }

  private async checkInProject(tx: Tx, projectId: string, ids: { moduleId?: string | null; phaseId?: string | null; sprintId?: string | null }) {
    const checks = [
      [ids.moduleId, s.modules, 'Module'],
      [ids.phaseId, s.phases, 'กลุ่มงาน'],
    ] as const;
    for (const [id, table, label] of checks) {
      if (!id) continue;
      const [row] = await tx.select({ projectId: table.projectId }).from(table).where(eq(table.id, id));
      if (!row || row.projectId !== projectId) throw new AppError(400, 'invalid_reference', `${label} ไม่อยู่ในโปรเจกต์นี้`);
    }
    if (ids.sprintId) {
      const [sprint] = await tx.select({ projectId: s.sprints.projectId, status: s.sprints.status }).from(s.sprints).where(eq(s.sprints.id, ids.sprintId));
      if (!sprint || sprint.projectId !== projectId) throw new AppError(400, 'invalid_reference', 'Sprint ไม่อยู่ในโปรเจกต์นี้');
      if (sprint.status === 'completed') throw new AppError(422, 'sprint_completed', 'Sprint จบแล้ว ไม่สามารถเพิ่มหรือย้ายงานเข้าได้', { sprintId: ids.sprintId });
    }
  }

  private async lockProject(tx: Tx, projectId: string) {
    await tx.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.id, projectId)).for('update');
  }

  private async lockSprintChangeProject(tx: Tx, auth: AuthInfo, tenant: TenantInfo, issueKey: string) {
    const match = ISSUE_KEY.exec(issueKey);
    if (!match) throw notFound('งาน');
    const { project, access } = await this.projects.load(tx, auth, tenant, match[1]);
    requirePerm(access, 'issue.edit');
    // ห้ามอ่าน version/แผนเดิมก่อนรอ complete ไม่เช่นนั้นอาจย้ายทับแผนที่เพิ่งย้ายออกมา
    await this.lockProject(tx, project.id);
  }

  /** คนที่ถูกระบุในงานต้องเป็นสมาชิก active ของ Workspace */
  private async checkPeople(tx: Tx, ids: (string | null | undefined)[]) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return;
    const rows = await tx
      .select({ userId: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .where(and(inArray(s.workspaceMembers.userId, want), eq(s.workspaceMembers.status, 'active')));
    const found = new Set(rows.map((r) => r.userId));
    const missing = want.filter((x) => !found.has(x));
    if (missing.length) throw new AppError(400, 'invalid_people', 'มีคนที่ไม่ได้เป็นสมาชิกของ Workspace', { userIds: missing });
  }

  /** ฟิลด์บังคับตามประเภทงาน (L2 › ประเภทงาน) */
  private checkRequired(required: string[], v: z.infer<typeof CreateIssueBody> & { moduleId?: string | null }) {
    const has: Record<string, boolean> = {
      title: !!v.title,
      module: !!v.moduleId,
      size: !!v.size,
      severity: !!v.severity,
      environment: !!v.environment,
      steps: !!v.details.steps,
      user_story: !!v.details.i_want,
      question: !!v.details.question,
      timebox: !!v.details.timebox_hours,
      // Acceptance criteria เป็น Checklist (kind = acceptance) เพิ่มหลังสร้างงาน
      acceptance_criteria: true,
    };
    const missing = required.filter((f) => has[f] === false);
    if (missing.length) throw new AppError(400, 'missing_required_fields', 'กรอกฟิลด์บังคับของประเภทงานนี้ไม่ครบ', { fields: missing });
  }

  private async sizeToMd(tx: Tx, project: ProjectRow, size: string) {
    const map = (project.sizeMdMap as Record<string, number> | null) ?? (await this.workspaceSizeMap(tx, project.workspaceId));
    return map[size] ?? DEFAULT_SIZE_MD[size];
  }

  private async workspaceSizeMap(tx: Tx, workspaceId: string) {
    const [ws] = await tx.select({ m: s.workspaceSettings.sizeMdMap }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, workspaceId));
    return (ws?.m as Record<string, number> | undefined) ?? DEFAULT_SIZE_MD;
  }

  private async hasChildren(tx: Tx, id: string) {
    const [r] = await tx.select({ id: s.issues.id }).from(s.issues).where(and(eq(s.issues.parentId, id), isNull(s.issues.deletedAt))).limit(1);
    return !!r;
  }

  private async assigneeIds(tx: Tx, issueId: string) {
    const rows = await tx.select({ userId: s.issueAssignees.userId }).from(s.issueAssignees).where(eq(s.issueAssignees.issueId, issueId)).orderBy(asc(s.issueAssignees.sort));
    return rows.map((r) => r.userId);
  }

  private async conflict(tx: Tx, project: ProjectRow, issue: Issue, access: ProjectAccess) {
    const [latest] = await tx.select().from(s.issues).where(eq(s.issues.id, issue.id));
    return new AppError(409, 'conflict', 'งานนี้ถูกแก้โดยคนอื่นระหว่างที่คุณกำลังแก้ · โหลดค่าล่าสุดแล้วลองอีกครั้ง', {
      latest: await this.dto(tx, project, latest, access),
    });
  }

  async dto(tx: Tx, project: ProjectRow, issue: Issue, access: ProjectAccess) {
    const [one] = await this.dtos(tx, project, [issue], access);
    return one;
  }

  /** รูปแบบงานที่ส่งออก · Guest ที่เป็น Viewer ไม่เห็นชื่อ / id ของคน (04-permissions ข้อ 4) */
  async dtos(tx: Tx, project: ProjectRow, issues: Issue[], access: ProjectAccess) {
    if (!issues.length) return [];
    const parent = alias(s.issues, 'parent');
    const ids = issues.map((i) => i.id);
    const meta = await tx
      .select({ id: s.issues.id, type: s.issueTypes.name, statusName: s.workflowStatuses.name, statusCategory: s.workflowStatuses.category, parentNumber: parent.number })
      .from(s.issues)
      .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .leftJoin(parent, eq(parent.id, s.issues.parentId))
      .where(inArray(s.issues.id, ids));
    const byId = new Map(meta.map((m) => [m.id, m]));
    const people = access.guestViewer
      ? []
      : await tx.select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId }).from(s.issueAssignees).where(inArray(s.issueAssignees.issueId, ids)).orderBy(asc(s.issueAssignees.sort));

    return issues.map((i) => {
      const m = byId.get(i.id)!;
      const base = {
        id: i.id,
        key: `${project.key}-${i.number}`,
        number: i.number,
        projectKey: project.key,
        type: m.type,
        parentKey: m.parentNumber ? `${project.key}-${m.parentNumber}` : null,
        title: i.title,
        description: i.description,
        status: { id: i.statusId, name: m.statusName, category: m.statusCategory },
        priority: i.priority,
        moduleId: i.moduleId,
        phaseId: i.phaseId,
        sprintId: i.sprintId,
        size: i.size,
        estimateMd: i.estimateMd,
        progressPct: i.progressPct,
        planStart: i.planStart,
        planEnd: i.planEnd,
        actualStart: i.actualStart,
        actualEnd: i.actualEnd,
        reopenCount: i.reopenCount,
        severity: i.severity,
        environment: i.environment,
        details: i.details,
        sharedWithGuests: i.sharedWithGuests,
        version: i.version,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      };
      if (access.guestViewer) return base;
      return {
        ...base,
        assigneeIds: people.filter((p) => p.issueId === i.id).map((p) => p.userId),
        baId: i.baId,
        reviewerId: i.reviewerId,
        testerId: i.testerId,
        reporterId: i.reporterId,
      };
    });
  }
}

function parseIfMatch(v: string | undefined) {
  if (!v) throw new AppError(428, 'if_match_required', 'ต้องส่ง If-Match ที่ได้จาก ETag ของงาน');
  const n = Number(v.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'invalid_if_match', 'If-Match ไม่ถูกต้อง');
  return n;
}

/** สร้างเหตุการณ์ของงาน · data มี issueKey และ title เสมอ */
function eventFor(auth: AuthInfo, tenant: TenantInfo, project: ProjectRow, issue: Issue) {
  return (type: EventType, data: Record<string, unknown>): DomainEvent => ({
    type,
    workspaceId: tenant.workspaceId,
    projectId: project.id,
    issueId: issue.id,
    actorId: auth.userId,
    data: { issueKey: `${project.key}-${issue.number}`, title: issue.title, ...data },
    at: new Date(),
  });
}

/** Actual Start / End ตั้งอัตโนมัติเมื่อเปลี่ยนสถานะ */
function statusChange(issue: Issue, next: Status): Partial<typeof s.issues.$inferInsert> {
  const set: Partial<typeof s.issues.$inferInsert> = { statusId: next.id };
  const day = today();
  if (next.category !== 'todo' && !issue.actualStart) set.actualStart = day;
  if (next.category === 'done') {
    set.actualEnd = day;
    set.completedAt = new Date();
  } else if (issue.actualEnd) {
    set.actualEnd = null;
    set.completedAt = null;
  }
  return set;
}

/** Sub-task ควรอยู่ในช่วงของ Task แม่ · เตือน ไม่บล็อก */
export function outsideParent(parent: Issue, start?: string | null, end?: string | null): Warning[] {
  const out = (parent.planStart && start && start < parent.planStart) || (parent.planEnd && end && end > parent.planEnd);
  return out ? [{ code: 'outside_parent_range', message: `วันที่อยู่นอกช่วงของงานแม่ (${parent.planStart} – ${parent.planEnd})` }] : [];
}

const DIFF_FIELDS = ['title', 'description', 'statusId', 'priority', 'moduleId', 'phaseId', 'sprintId', 'baId', 'reviewerId', 'testerId', 'size', 'estimateMd', 'planStart', 'planEnd', 'progressPct', 'severity', 'environment', 'sharedWithGuests'] as const;

function diff(a: Issue, b: Issue) {
  return DIFF_FIELDS.filter((f) => a[f] !== b[f]).map((f) => ({ field: f as string, oldValue: a[f] as unknown, newValue: b[f] as unknown }));
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function restoreDeadline(deletedAt: Date) {
  return new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
}
