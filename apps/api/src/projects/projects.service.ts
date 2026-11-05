import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SYSTEM_DB } from '../db/db.module.js';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { addDays } from './calendar.js';
import { L2_GROUPS, L2_PERMISSIONS, projectAccess, type ProjectAccess, requirePerm } from './permissions.js';

const s = schema;

const isoDate = z.iso.date();
export const projectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'ขึ้นต้นด้วยตัวอักษร ใช้ A–Z และ 0–9 ยาว 2–10 ตัว');

export const CreateProjectBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    key: projectKey,
    clientName: z.string().trim().max(120).optional(),
    description: z.string().max(5000).optional(),
    color: z.string().max(20).optional(),
    startDate: isoDate,
    goliveDate: isoDate,
    timezone: z.string().default('Asia/Bangkok'),
    visibility: z.enum(['private', 'workspace']).default('private'),
    sprintLengthWeeks: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]).default(2),
    modules: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    milestones: z.array(z.object({ name: z.string().trim().min(1).max(120), date: isoDate })).max(50).default([]),
    estimateUnit: z.enum(['man_day', 'hour']).default('man_day'),
    progressMethod: z.enum(['count', 'weighted']).default('weighted'),
  })
  .refine((v) => v.goliveDate >= v.startDate, { path: ['goliveDate'], message: 'วัน Go-live ต้องไม่ก่อนวันเริ่ม' });

// แถวในหน้า L2 ที่ PM เปิดปิดได้ (แถวที่คุม 2 สิทธิ์ใช้ชื่อแรก)
const L2_ROWS = Object.keys(L2_PERMISSIONS).filter((p) => p !== 'issue.edit' && p !== 'file.delete') as [string, ...string[]];
export const RolePermissionBody = z.object({
  role: z.enum(['member', 'viewer']),
  permission: z.enum(L2_ROWS),
  allowed: z.boolean(),
});

const STANDARD = [
  { name: 'To do', category: 'todo' },
  { name: 'In progress', category: 'in_progress' },
  { name: 'Review', category: 'in_progress' },
  { name: 'Done', category: 'done' },
] as const;
// Bug: Open → In progress → Fixed → Verified → Closed · ผูกกับคอลัมน์ของบอร์ด (docs/spec/README.md คำตัดสินข้อ 5)
const BUG = [
  { name: 'Open', category: 'todo', column: 'To do' },
  { name: 'In progress', category: 'in_progress', column: 'In progress' },
  { name: 'Fixed', category: 'in_progress', column: 'Review' },
  { name: 'Verified', category: 'in_progress', column: 'Review' },
  { name: 'Closed', category: 'done', column: 'Done' },
] as const;
// ฟิลด์บังคับตามหน้า L2 › ประเภทงาน
const TYPES = [
  { name: 'Story', color: '#15803D', bug: false, required: ['title', 'user_story', 'acceptance_criteria', 'size'] },
  { name: 'Task', color: '#1D4ED8', bug: false, required: ['title', 'module'] },
  { name: 'Bug', color: '#DC2626', bug: true, required: ['title', 'severity', 'environment', 'steps'] },
  { name: 'Spike', color: '#7C3AED', bug: false, required: ['title', 'question', 'timebox'] },
];

export type ProjectRow = typeof s.projects.$inferSelect;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  /** โหลดโปรเจกต์ด้วย Key (RLS กรองแล้ว) และคำนวณสิทธิ์ · ไม่ใช่สมาชิกตอบ 403 แบบหน้า M1 */
  async load(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, opts: { allowNonMember?: boolean } = {}) {
    const [project] = await tx
      .select()
      .from(s.projects)
      .where(and(eq(s.projects.key, key.toUpperCase()), isNull(s.projects.deletedAt)));
    if (!project) throw new AppError(404, 'project_not_found', 'ไม่พบโปรเจกต์');
    const access = await projectAccess(tx, auth, tenant, project);
    if (!access.role && !opts.allowNonMember) {
      const isWsAdmin = tenant.role === 'owner' || tenant.role === 'admin';
      throw new AppError(403, 'not_project_member', 'คุณยังไม่ได้เป็นสมาชิกโปรเจกต์นี้', {
        requestAccess: !isWsAdmin,
        canJoinAsAdmin: isWsAdmin,
      });
    }
    return { project, access };
  }

  async list(auth: AuthInfo, tenant: TenantInfo) {
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx
        .select({
          id: s.projects.id,
          key: s.projects.key,
          name: s.projects.name,
          color: s.projects.color,
          status: s.projects.status,
          visibility: s.projects.visibility,
          startDate: s.projects.startDate,
          goliveDate: s.projects.goliveDate,
          ownerUserId: s.projects.ownerUserId,
          memberCount: sql<number>`(select count(*)::int from ${s.projectMembers} pm where pm.project_id = ${s.projects.id})`,
          myRole: s.projectMembers.role,
        })
        .from(s.projects)
        .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, s.projects.id), eq(s.projectMembers.userId, auth.userId)))
        .where(isNull(s.projects.deletedAt))
        .orderBy(asc(s.projects.name));
      // Workspace Owner / Admin เห็นโปรเจกต์ Private ที่ยังไม่ได้เข้าร่วมด้วย (joined: false)
      return {
        items: rows.map((r) => ({
          ...r,
          joined: r.ownerUserId === auth.userId || !!r.myRole || (r.visibility === 'workspace' && tenant.role !== 'guest'),
        })),
      };
    });
  }

  async keyAvailable(tenant: TenantInfo, key: string) {
    return { key, available: await this.keyFree(tenant.workspaceId, key) };
  }

  /** Key ต้องไม่ซ้ำทั้งโปรเจกต์ที่มองไม่เห็น (RLS) และ Key เก่า · จึงถามผ่าน friday_system เฉพาะเรื่องนี้ */
  private async keyFree(workspaceId: string, key: string) {
    const [taken] = await this.system
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(eq(s.projects.workspaceId, workspaceId), eq(s.projects.key, key)));
    const [alias] = await this.system
      .select({ k: s.projectKeyAliases.oldKey })
      .from(s.projectKeyAliases)
      .where(and(eq(s.projectKeyAliases.workspaceId, workspaceId), eq(s.projectKeyAliases.oldKey, key)));
    return !taken && !alias;
  }

  /** A · New Project · สร้างทุกอย่างในธุรกรรมเดียว */
  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateProjectBody>) {
    if (tenant.role === 'guest') throw forbidden('ws.project.create');
    const result = await this.db.run(auth, tenant, async (tx) => {
      if (!(await this.keyFree(tenant.workspaceId, input.key))) throw new AppError(409, 'key_taken', 'Project Key นี้มีใน Workspace แล้ว', { key: input.key });

      const [project] = await tx
        .insert(s.projects)
        .values({
          workspaceId: tenant.workspaceId,
          key: input.key,
          name: input.name,
          clientName: input.clientName,
          description: input.description,
          color: input.color,
          startDate: input.startDate,
          goliveDate: input.goliveDate,
          timezone: input.timezone,
          visibility: input.visibility,
          ownerUserId: auth.userId,
          sprintLengthWeeks: input.sprintLengthWeeks,
          estimateUnit: input.estimateUnit,
          progressMethod: input.progressMethod,
        })
        .returning();
      const base = { workspaceId: tenant.workspaceId, projectId: project.id };
      await tx.insert(s.projectMembers).values({ ...base, userId: auth.userId, role: 'admin' });

      // Workflow มาตรฐาน + Workflow ของ Bug
      const [stdWf] = await tx.insert(s.workflows).values({ ...base, name: 'มาตรฐาน' }).returning();
      const std = await tx
        .insert(s.workflowStatuses)
        .values(STANDARD.map((st, i) => ({ ...base, workflowId: stdWf.id, name: st.name, category: st.category, sort: i })))
        .returning({ id: s.workflowStatuses.id, name: s.workflowStatuses.name });
      const col = new Map(std.map((x) => [x.name, x.id]));
      const [bugWf] = await tx.insert(s.workflows).values({ ...base, name: 'Bug' }).returning();
      await tx
        .insert(s.workflowStatuses)
        .values(BUG.map((st, i) => ({ ...base, workflowId: bugWf.id, name: st.name, category: st.category, boardColumnId: col.get(st.column), sort: i })));
      await tx
        .insert(s.issueTypes)
        .values(TYPES.map((t, i) => ({ ...base, name: t.name, color: t.color, workflowId: t.bug ? bugWf.id : stdWf.id, requiredFields: t.required, sort: i })));

      if (input.modules.length) {
        await tx.insert(s.modules).values(input.modules.map((name, i) => ({ ...base, name, sort: i })));
      }
      if (input.milestones.length) {
        await tx.insert(s.milestones).values(input.milestones.map((m) => ({ ...base, name: m.name, date: m.date })));
      }
      const sprints = sprintPlan(input.startDate, input.goliveDate, input.sprintLengthWeeks);
      if (sprints.length) {
        await tx.insert(s.sprints).values(sprints.map((sp) => ({ ...base, ...sp })));
      }
      await tx.insert(s.auditLogs).values({
        workspaceId: tenant.workspaceId,
        actorId: auth.userId,
        actorKind: 'user',
        category: 'data',
        action: 'project.created',
        targetType: 'project',
        targetId: project.id,
        summary: `${project.key} · ${project.name}`,
      });
      return { project, created: { modules: input.modules.length, statuses: STANDARD.length, milestones: input.milestones.length, sprints: sprints.length } };
    });
    return { ...this.dto(result.project, 'admin', true), created: result.created };
  }

  async get(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      // ธุรกรรมเดียวใช้ connection เดียว จึงรันทีละคำสั่ง
      const modules = await tx.select({ id: s.modules.id, name: s.modules.name, color: s.modules.color, sort: s.modules.sort }).from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort));
      const statuses = await tx
          .select({ id: s.workflowStatuses.id, workflowId: s.workflowStatuses.workflowId, name: s.workflowStatuses.name, category: s.workflowStatuses.category, boardColumnId: s.workflowStatuses.boardColumnId, wipLimit: s.workflowStatuses.wipLimit, sort: s.workflowStatuses.sort })
          .from(s.workflowStatuses)
          .where(eq(s.workflowStatuses.projectId, project.id))
          .orderBy(asc(s.workflowStatuses.sort));
      const issueTypes = await tx
          .select({ id: s.issueTypes.id, name: s.issueTypes.name, color: s.issueTypes.color, workflowId: s.issueTypes.workflowId, requiredFields: s.issueTypes.requiredFields, enabled: s.issueTypes.enabled })
          .from(s.issueTypes)
          .where(eq(s.issueTypes.projectId, project.id))
          .orderBy(asc(s.issueTypes.sort));
      const sprints = await tx
          .select({ id: s.sprints.id, number: s.sprints.number, name: s.sprints.name, startDate: s.sprints.startDate, endDate: s.sprints.endDate, status: s.sprints.status })
          .from(s.sprints)
          .where(eq(s.sprints.projectId, project.id))
          .orderBy(asc(s.sprints.number));
      return { ...this.dto(project, access.role, true), modules, statuses, issueTypes, sprints, permissions: [...access.perms].sort() };
    });
  }

  async myPermissions(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { access } = await this.load(tx, auth, tenant, key);
      return { role: access.role, guestViewer: access.guestViewer, permissions: [...access.perms].sort() };
    });
  }

  /** L2 › สิทธิ์ของแต่ละ Role · เช่น PM เปิด "เปลี่ยน Due โดยไม่ต้องขออนุมัติ" ให้ Member */
  async setRolePermission(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof RolePermissionBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      requirePerm(access, 'project.settings');
      const keys = L2_GROUPS[input.permission] ?? [input.permission];
      for (const permission of keys) {
        await tx
          .insert(s.projectRolePermissions)
          .values({ workspaceId: tenant.workspaceId, projectId: project.id, role: input.role, permission, allowed: input.allowed, updatedBy: auth.userId })
          .onConflictDoUpdate({
            target: [s.projectRolePermissions.projectId, s.projectRolePermissions.role, s.projectRolePermissions.permission],
            set: { allowed: input.allowed, updatedBy: auth.userId },
          });
      }
      await tx.insert(s.auditLogs).values({
        workspaceId: tenant.workspaceId,
        actorId: auth.userId,
        actorKind: 'user',
        category: 'perm',
        action: 'project.role_permission_changed',
        targetType: 'project',
        targetId: project.id,
        summary: `${project.key} · ${input.role} · ${input.permission} = ${input.allowed ? 'เปิด' : 'ปิด'}`,
      });
      return { role: input.role, permission: input.permission, allowed: input.allowed };
    });
  }

  /** 04-permissions ข้อ 6 · Workspace Owner / Admin เข้าร่วมโปรเจกต์ Private เป็น Admin · บันทึก Audit และแจ้ง Project Owner */
  async joinAsAdmin(auth: AuthInfo, tenant: TenantInfo, key: string) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.admin');
    const project = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key, { allowNonMember: true });
      if (access.role === 'admin') throw new AppError(409, 'already_admin', 'คุณเป็น Admin ของโปรเจกต์นี้อยู่แล้ว');
      await tx
        .insert(s.projectMembers)
        .values({ workspaceId: tenant.workspaceId, projectId: project.id, userId: auth.userId, role: 'admin' })
        .onConflictDoUpdate({ target: [s.projectMembers.projectId, s.projectMembers.userId], set: { role: 'admin' } });
      await tx.insert(s.auditLogs).values({
        workspaceId: tenant.workspaceId,
        actorId: auth.userId,
        actorKind: 'user',
        category: 'perm',
        action: 'project.joined_as_admin',
        targetType: 'project',
        targetId: project.id,
        summary: `${project.key} · ${project.name}`,
      });
      return project;
    });
    // แจ้งเตือนสร้างโดยระบบ (แอปไม่มีสิทธิ์ INSERT notifications) · ภายหลังย้ายเข้าคิว BullMQ
    if (project.ownerUserId !== auth.userId) {
      await this.system.insert(s.notifications).values({
        workspaceId: tenant.workspaceId,
        recipientId: project.ownerUserId,
        eventType: 'project.admin_joined',
        actorId: auth.userId,
        projectId: project.id,
        payload: { projectKey: project.key, projectName: project.name },
        reason: 'คุณเป็น Project Owner',
      });
    }
    return { key: project.key, role: 'admin' };
  }

  dto(p: ProjectRow, role: ProjectAccess['role'], joined: boolean) {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      clientName: p.clientName,
      description: p.description,
      color: p.color,
      startDate: p.startDate,
      goliveDate: p.goliveDate,
      timezone: p.timezone,
      visibility: p.visibility,
      status: p.status,
      ownerUserId: p.ownerUserId,
      sprintLengthWeeks: p.sprintLengthWeeks,
      estimateUnit: p.estimateUnit,
      progressMethod: p.progressMethod,
      timeLogEnabled: p.timeLogEnabled,
      version: p.version,
      myRole: role,
      joined,
    };
  }
}

/** Sprint ระดับโปรเจกต์: เริ่มจันทร์แรกตั้งแต่วันเริ่มโปรเจกต์ จบวันศุกร์ของสัปดาห์สุดท้าย จนถึง Go-live */
export function sprintPlan(start: string, golive: string, weeks: number | null) {
  if (!weeks) return [];
  let d = start;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  const out: { number: number; name: string; startDate: string; endDate: string }[] = [];
  for (let n = 1; d <= golive && n <= 200; n++) {
    out.push({ number: n, name: `Sprint ${n}`, startDate: d, endDate: addDays(d, weeks * 7 - 3) });
    d = addDays(d, weeks * 7);
  }
  return out;
}
