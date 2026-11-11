import { Inject, Injectable } from '@nestjs/common';
import { schema as s, type Db, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { EventBus, type DomainEvent } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { WorkCalendar } from '../projects/calendar.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';
import { CompleteSprintBody, CreateSprintBody, PatchSprintBody } from './sprint-input.js';
import { burndown, capacity, issueDto, loadIssues, saveSnapshot, totals, type SprintRow } from './sprint-metrics.js';

@Injectable()
export class SprintsService {
  constructor(private readonly db: TenantDb, private readonly projects: ProjectsService, private readonly events: EventBus, @Inject(SYSTEM_DB) private readonly system: Db) {}

  async create(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateSprintBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'sprint.manage');
      await this.lockProject(tx, project.id);
      const [last] = await tx.select({ number: sql<number>`coalesce(max(${s.sprints.number}), 0)::int` }).from(s.sprints).where(eq(s.sprints.projectId, project.id));
      const [sprint] = await tx.insert(s.sprints).values({ ...input, workspaceId: tenant.workspaceId, projectId: project.id, number: last.number + 1 }).returning();
      await this.audit(tx, auth, sprint, 'sprint.created');
      return sprint;
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchSprintBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'sprint.manage');
      await this.lockProject(tx, project.id);
      const current = await this.load(tx, project.id, id);
      if (current.status === 'completed') throw new AppError(409, 'sprint_completed', 'Sprint จบแล้ว แก้ไขไม่ได้');
      // PATCH ต้องตรวจคู่วันที่หลังรวมกับค่าเดิมด้วย
      const valid = parse(CreateSprintBody, { name: current.name, startDate: current.startDate, endDate: current.endDate, goal: current.goal, ...input });
      const [updated] = await tx.update(s.sprints).set(valid).where(eq(s.sprints.id, id)).returning();
      await this.audit(tx, auth, updated, 'sprint.updated');
      return updated;
    });
  }

  async start(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'sprint.manage');
      // ล็อกโปรเจกต์ก่อน Sprint เสมอ เพื่อให้คำขอเริ่มพร้อมกันมีผู้ชนะคนเดียว
      await this.lockProject(tx, project.id);
      const current = await this.load(tx, project.id, id);
      if (current.status !== 'planning') throw new AppError(409, 'sprint_not_planning', 'เริ่มได้เฉพาะ Sprint ที่กำลังวางแผน');
      const [active] = await tx.select({ id: s.sprints.id, name: s.sprints.name }).from(s.sprints).where(and(eq(s.sprints.projectId, project.id), eq(s.sprints.status, 'active')));
      if (active) throw new AppError(409, 'sprint_active_exists', 'มี Sprint ที่กำลังทำอยู่แล้ว ต้องจบ Sprint นั้นก่อน', { activeSprint: active });
      const [sprint] = await tx.update(s.sprints).set({ status: 'active' }).where(eq(s.sprints.id, id)).returning();
      const rows = (await loadIssues(tx, project.id)).filter((issue) => issue.sprintId === id);
      await saveSnapshot(tx, sprint, rows, today());
      await this.audit(tx, auth, sprint, 'sprint.started');
      events.push(this.event(auth, sprint, 'sprint.started', { totalMd: totals(rows).totalMd }));
      return sprint;
    });
    await this.events.publish(events);
    return result;
  }

  async complete(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof CompleteSprintBody>) {
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'sprint.manage');
      await this.lockProject(tx, project.id);
      const current = await this.load(tx, project.id, id);
      if (current.status !== 'active') throw new AppError(409, 'sprint_not_active', 'จบได้เฉพาะ Sprint ที่กำลังทำอยู่');
      const destination = input.moveIncompleteTo === 'backlog' ? null : input.moveIncompleteTo;
      if (destination === id) throw new AppError(422, 'invalid_sprint_destination', 'Sprint ปลายทางต้องต่างจาก Sprint ที่กำลังจบ');
      if (destination) {
        const target = await this.load(tx, project.id, destination);
        if (target.status !== 'planning') throw new AppError(422, 'invalid_sprint_destination', 'ย้ายงานค้างได้เฉพาะ Sprint ที่ยังวางแผนอยู่');
      }
      // ล็อกแม่ก่อนลูกเหมือน IssuesService.move เพื่อไม่ย้ายแผนทับคำขอที่ทำพร้อมกัน
      await tx.select({ id: s.issues.id }).from(s.issues).where(and(eq(s.issues.projectId, project.id), eq(s.issues.sprintId, id), isNull(s.issues.parentId))).orderBy(asc(s.issues.id)).for('update');
      const rows = await loadIssues(tx, project.id);
      const sprintRows = rows.filter((issue) => issue.sprintId === id);
      await saveSnapshot(tx, current, sprintRows, today());
      // งานที่ยังไม่ปิด (ไม่ใช่เสร็จหรือยกเลิก) ย้ายไป Sprint ถัดไป
      const parentIds = sprintRows.filter((issue) => !issue.parentId && issue.category !== 'done' && issue.category !== 'cancelled').map((issue) => issue.id);
      const moving = parentIds.length ? await tx.select().from(s.issues).where(and(eq(s.issues.projectId, project.id), or(inArray(s.issues.id, parentIds), inArray(s.issues.parentId, parentIds)))).orderBy(asc(s.issues.id)).for('update') : [];
      if (moving.length) {
        await tx.update(s.issues).set({ sprintId: destination }).where(inArray(s.issues.id, moving.map((issue) => issue.id)));
        const visible = moving.filter((issue) => !issue.deletedAt && issue.sprintId !== destination);
        if (visible.length) await tx.insert(s.activities).values(visible.map((issue) => ({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, verb: 'updated', field: 'sprintId', oldValue: issue.sprintId, newValue: destination })));
      }
      const [sprint] = await tx.update(s.sprints).set({ status: 'completed', retrospective: input.retrospective ?? null, completedAt: new Date(), completedBy: auth.userId }).where(eq(s.sprints.id, id)).returning();
      await this.audit(tx, auth, sprint, 'sprint.completed');
      const moved = { tasks: parentIds.length, subtasks: moving.filter((issue) => issue.parentId && !issue.deletedAt).length, destination };
      events.push(this.event(auth, sprint, 'sprint.completed', { ...moved, ...totals(sprintRows), issueIds: moving.filter((issue) => !issue.deletedAt).map((issue) => issue.id) }));
      return { ...sprint, moved };
    });
    await this.events.publish(events);
    return result;
  }

  async backlog(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.view');
      if (access.guestViewer) throw forbidden('project.backlog.view');
      await this.lockProject(tx, project.id);
      const sprints = await tx.select().from(s.sprints).where(and(eq(s.sprints.projectId, project.id), ne(s.sprints.status, 'completed'))).orderBy(asc(s.sprints.number));
      const rows = await loadIssues(tx, project.id);
      const date = today();
      const result = [];
      for (const sprint of sprints) {
        const assigned = rows.filter((issue) => issue.sprintId === sprint.id);
        const cal = await WorkCalendar.load(tx, project, sprint.startDate);
        if (sprint.status === 'active' && !access.archived) await saveSnapshot(tx, sprint, assigned, date);
        result.push({ ...sprint, issues: assigned.filter((issue) => !issue.parentId).map((issue) => ({ ...issueDto(issue, project.key), subtasks: assigned.filter((child) => child.parentId === issue.id).map((child) => issueDto(child, project.key)) })), stats: totals(assigned), capacity: await capacity(tx, project, sprint, assigned, cal), burndown: sprint.status === 'active' ? await burndown(tx, sprint, assigned, cal, date) : null });
      }
      const unsprinted = rows.filter((issue) => !issue.sprintId);
      return { projectKey: project.key, asOf: date, permissions: { canManageSprints: access.perms.has('sprint.manage'), canMoveIssues: access.perms.has('issue.edit') }, sprints: result, backlog: { issues: unsprinted.filter((issue) => !issue.parentId).map((issue) => ({ ...issueDto(issue, project.key), subtasks: unsprinted.filter((child) => child.parentId === issue.id).map((child) => issueDto(child, project.key)) })), stats: totals(unsprinted) } };
    });
  }

  /** งานตามเวลา: SYSTEM_DB ใช้ค้นหา Workspace/โปรเจกต์ที่ยังไม่รู้เท่านั้น; ข้อมูลลูกค้าและ snapshot ผ่าน TenantDb */
  async snapshotAll() {
    const contexts = await this.system.selectDistinct({ id: s.projects.id, workspaceId: s.projects.workspaceId, ownerId: s.projects.ownerUserId, slug: s.workspaces.slug, userId: s.workspaceMembers.userId, role: s.workspaceMembers.role }).from(s.projects)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.projects.workspaceId)).innerJoin(s.sprints, and(eq(s.sprints.projectId, s.projects.id), eq(s.sprints.status, 'active')))
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.projects.workspaceId), eq(s.workspaceMembers.status, 'active')))
      .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, s.projects.id), eq(s.projectMembers.userId, s.workspaceMembers.userId)))
      .where(and(isNull(s.projects.deletedAt), isNull(s.projects.archivedAt), isNull(s.workspaces.deletedAt), or(eq(s.workspaceMembers.userId, s.projects.ownerUserId), and(isNotNull(s.projectMembers.userId), or(ne(s.workspaceMembers.role, 'guest'), ne(s.projectMembers.role, 'viewer'))))));
    // เจ้าของอาจถูกพักใช้งานแล้ว จึงเลือกสมาชิก active ที่ RLS เปิดโปรเจกต์นี้ได้แทน
    const projects = new Map<string, typeof contexts[number]>();
    for (const context of contexts) if (!projects.has(context.id) || context.userId === context.ownerId) projects.set(context.id, context);
    let count = 0;
    for (const project of projects.values()) {
      count += await this.db.run({ userId: project.userId, sessionId: 'sprint-snapshot-job' }, { workspaceId: project.workspaceId, slug: project.slug, role: project.role }, async (tx) => {
        await this.lockProject(tx, project.id);
        const active = await tx.select().from(s.sprints).where(and(eq(s.sprints.projectId, project.id), eq(s.sprints.status, 'active')));
        if (!active.length) return 0;
        const rows = await loadIssues(tx, project.id);
        for (const sprint of active) await saveSnapshot(tx, sprint, rows.filter((issue) => issue.sprintId === sprint.id), today());
        return active.length;
      });
    }
    return { snapshots: count };
  }

  private async lockProject(tx: Tx, id: string) { await tx.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.id, id)).for('update'); }
  private async load(tx: Tx, projectId: string, id: string) {
    const [sprint] = await tx.select().from(s.sprints).where(and(eq(s.sprints.projectId, projectId), eq(s.sprints.id, id))).for('update');
    if (!sprint) throw new AppError(404, 'sprint_not_found', 'ไม่พบ Sprint ในโปรเจกต์นี้');
    return sprint;
  }
  private async audit(tx: Tx, auth: AuthInfo, sprint: SprintRow, action: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: sprint.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType: 'sprint', targetId: sprint.id, summary: sprint.name });
  }
  private event(auth: AuthInfo, sprint: SprintRow, type: 'sprint.started' | 'sprint.completed', data: Record<string, unknown>): DomainEvent {
    return { type, workspaceId: sprint.workspaceId, projectId: sprint.projectId, actorId: auth.userId, at: new Date(), data: { sprintId: sprint.id, name: sprint.name, number: sprint.number, ...data } };
  }
}
