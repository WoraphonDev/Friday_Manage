import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { today } from '../common/dates.js';
import { addDays } from './calendar.js';
import { L2_GROUPS, L2_PERMISSIONS, projectAccess, type ProjectAccess, requirePerm } from './permissions.js';
import { defaultWorkflowRules } from '../project-structure/rules.js';

const s = schema;

const isoDate = z.iso.date();
export const projectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'ขึ้นต้นด้วยตัวอักษร ใช้ A–Z และ 0–9 ยาว 2–10 ตัว');

const sprintLength = z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]);
const manDay = z.number().positive().max(999).multipleOf(0.25);
/** L2 › Size → Man-Day (01-entities › project.size_md_map) */
export const SizeMdMap = z.object({ XS: manDay, S: manDay, M: manDay, L: manDay, XL: manDay });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'รูปแบบเวลา HH:MM');
const projectRole = z.enum(['admin', 'member', 'viewer']);

/** สถานะใน Workflow มาตรฐาน · ส่งเป็นชื่ออย่างเดียวได้ (หมวดเดาจากตำแหน่ง: แรก = todo, สุดท้าย = done) */
const StatusSpec = z.union([
  z.string().trim().min(1).max(60).transform((name) => ({ name, category: undefined, wipLimit: undefined })),
  z.object({
    name: z.string().trim().min(1).max(60),
    category: z.enum(['todo', 'in_progress', 'done']).optional(),
    wipLimit: z.number().int().positive().max(999).nullish(),
  }),
]);
const WorkflowSpec = z.array(StatusSpec).min(2).max(20);

/**
 * รูปแบบ project_templates.config (A18 สร้าง / แก้ · A04 อ่านตอนสร้างโปรเจกต์)
 * ค่าที่ผู้สร้างส่งมาใน POST w/projects ชนะค่าจาก Template เสมอ
 */
export const TemplateConfig = z.object({
  workflow: WorkflowSpec.optional(),
  issueTypes: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        color: z.string().max(20).optional(),
        requiredFields: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
        enabled: z.boolean().optional(),
        /** ประเภทใหม่ที่ใช้ Workflow ของ Bug */
        bug: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  customFields: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        fieldType: z.enum(['text', 'number', 'select', 'multi_select', 'user', 'date']),
        options: z.unknown().optional(),
      }),
    )
    .max(50)
    .optional(),
  labels: z.array(z.object({ name: z.string().trim().min(1).max(60), color: z.string().max(20).optional() })).max(100).optional(),
  modules: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  sprintLengthWeeks: sprintLength.optional(),
  estimateUnit: z.enum(['man_day', 'hour']).optional(),
  progressMethod: z.enum(['count', 'weighted']).optional(),
  sizeMdMap: SizeMdMap.optional(),
  timeLogEnabled: z.boolean().optional(),
});
export type TemplateConfig = z.infer<typeof TemplateConfig>;

const scopeList = z.array(z.string().trim().min(1).max(500)).max(100);
/** สมาชิกเริ่มต้นของโปรเจกต์ (ขั้นที่ 4 ของ Wizard) */
const InitialMember = z.object({
  userId: z.uuid(),
  role: projectRole.default('member'),
  position: z.string().trim().max(60).optional(),
  capacityHoursWeek: z.number().int().min(0).max(168).optional(),
});

// ฟิลด์ที่ไม่ใส่ค่าเริ่มต้นใน schema เพราะ Template เติมให้ได้ · ค่าเริ่มต้นจริงอยู่ใน createInTx
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
    sprintLengthWeeks: sprintLength.optional(),
    modules: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    milestones: z.array(z.object({ name: z.string().trim().min(1).max(120), date: isoDate })).max(50).default([]),
    estimateUnit: z.enum(['man_day', 'hour']).optional(),
    progressMethod: z.enum(['count', 'weighted']).optional(),
    templateId: z.uuid().optional(),
    holidayCalendarId: z.uuid().optional(),
    extraHolidays: z.array(z.object({ date: isoDate, name: z.string().trim().min(1).max(120) })).max(100).optional(),
    scope: z.object({ in: scopeList, out: scopeList, deliverables: scopeList, acceptance: scopeList, assumptions: scopeList }).partial().optional(),
    members: z.array(InitialMember).max(200).optional(),
    workflow: WorkflowSpec.optional(),
  })
  .refine((v) => v.goliveDate >= v.startDate, { path: ['goliveDate'], message: 'วัน Go-live ต้องไม่ก่อนวันเริ่ม' });

/** L2 › ทั่วไป · ส่งเฉพาะฟิลด์ที่เปลี่ยน + If-Match */
export const PatchProjectBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    key: projectKey,
    clientName: z.string().trim().max(120).nullable(),
    description: z.string().max(5000).nullable(),
    color: z.string().max(20).nullable(),
    icon: z.string().max(40).nullable(),
    startDate: isoDate,
    goliveDate: isoDate,
    timezone: z.string().min(1).max(60),
    visibility: z.enum(['private', 'workspace']),
    sprintLengthWeeks: sprintLength,
    estimateUnit: z.enum(['man_day', 'hour']),
    progressMethod: z.enum(['count', 'weighted']),
    /** null = กลับไปใช้ค่าของ Workspace */
    sizeMdMap: SizeMdMap.nullable(),
    holidayCalendarId: z.uuid().nullable(),
    workStart: clock.nullable(),
    workEnd: clock.nullable(),
    timeLogEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

export const ListProjectsQuery = z.object({ status: z.enum(['planning', 'active', 'archived']).optional() });
export const TransferBody = z.object({ userId: z.uuid() });
export const DeleteProjectBody = z.object({ confirmKey: z.string().trim().min(1) });
export const SampleProjectBody = z.object({ key: projectKey.optional() });

// แถวในหน้า L2 ที่ PM เปิดปิดได้ (แถวที่คุม 2 สิทธิ์ใช้ชื่อแรก)
const L2_ROWS = Object.keys(L2_PERMISSIONS).filter((p) => p !== 'issue.edit' && p !== 'file.delete') as [string, ...string[]];
export const RolePermissionBody = z.object({
  role: z.enum(['member', 'viewer']),
  permission: z.enum(L2_ROWS),
  allowed: z.boolean(),
});

type StatusCategory = 'todo' | 'in_progress' | 'done';
const STANDARD: { name: string; category: StatusCategory; wipLimit?: number | null }[] = [
  { name: 'To do', category: 'todo' },
  { name: 'In progress', category: 'in_progress' },
  { name: 'Review', category: 'in_progress' },
  { name: 'Done', category: 'done' },
];
// Bug: Open → In progress → Fixed → Verified → Closed · ผูกกับคอลัมน์ของบอร์ด (docs/spec/README.md คำตัดสินข้อ 5)
// column = คอลัมน์ของ Workflow มาตรฐาน หาตามหมวด เพื่อให้ใช้ได้กับ Workflow ที่ Template / Wizard ตั้งชื่อเอง
const BUG = [
  { name: 'Open', category: 'todo', column: 'first_todo' },
  { name: 'In progress', category: 'in_progress', column: 'first_in_progress' },
  { name: 'Fixed', category: 'in_progress', column: 'last_in_progress' },
  { name: 'Verified', category: 'in_progress', column: 'last_in_progress' },
  { name: 'Closed', category: 'done', column: 'first_done' },
] as const;
// ฟิลด์บังคับตามหน้า L2 › ประเภทงาน
const TYPES = [
  { name: 'Story', color: '#15803D', bug: false, required: ['title', 'user_story', 'acceptance_criteria', 'size'] },
  { name: 'Task', color: '#1D4ED8', bug: false, required: ['title', 'module'] },
  { name: 'Bug', color: '#DC2626', bug: true, required: ['title', 'severity', 'environment', 'steps'] },
  { name: 'Spike', color: '#7C3AED', bug: false, required: ['title', 'question', 'timebox'] },
];
const SCOPE_KINDS = { in: 'in_scope', out: 'out_scope', deliverables: 'deliverable', acceptance: 'acceptance', assumptions: 'assumption' } as const;

export type ProjectRow = typeof s.projects.$inferSelect;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly limits: PlanLimits,
  ) {}

  /**
   * โหลดโปรเจกต์ด้วย Key (RLS กรองแล้ว) และคำนวณสิทธิ์ · ไม่ใช่สมาชิกตอบ 403 แบบหน้า M1
   * Key เก่าหลังเปลี่ยน Key ตอบ 301 project_moved พร้อม details.key ทุก endpoint ที่เรียกผ่านที่นี่ (รวม Issue key ของ Key เก่า)
   * โปรเจกต์ที่อยู่ในถังขยะตอบ 410
   */
  async load(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, opts: { allowNonMember?: boolean } = {}) {
    const wanted = key.toUpperCase();
    const [project] = await tx.select().from(s.projects).where(eq(s.projects.key, wanted));
    if (!project) {
      // alias ผ่าน RLS เหมือนโปรเจกต์ จึงตอบ 301 เฉพาะคนที่เข้าโปรเจกต์ได้ · คนอื่นได้ 404 เหมือน Key ที่ไม่มีอยู่
      const [moved] = await tx
        .select({ key: s.projects.key })
        .from(s.projectKeyAliases)
        .innerJoin(s.projects, eq(s.projects.id, s.projectKeyAliases.projectId))
        .where(and(eq(s.projectKeyAliases.oldKey, wanted), isNull(s.projects.deletedAt)));
      if (moved) throw new AppError(301, 'project_moved', `โปรเจกต์นี้เปลี่ยน Key เป็น ${moved.key} แล้ว`, { key: moved.key, oldKey: wanted });
      throw new AppError(404, 'project_not_found', 'ไม่พบโปรเจกต์');
    }
    if (project.deletedAt) {
      throw new AppError(410, 'project_deleted', `โปรเจกต์ ${project.key} ถูกลบแล้ว`, {
        deletedAt: project.deletedAt,
        restorableUntil: await this.restorableUntil(tx, tenant, project.deletedAt),
      });
    }
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

  async list(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof ListProjectsQuery> = {}) {
    return this.db.run(auth, tenant, async (tx) => {
      const where = [isNull(s.projects.deletedAt)];
      if (q.status) where.push(eq(s.projects.status, q.status));
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
          archivedAt: s.projects.archivedAt,
          ownerUserId: s.projects.ownerUserId,
          memberCount: sql<number>`(select count(*)::int from ${s.projectMembers} pm where pm.project_id = ${s.projects.id})`,
          myRole: s.projectMembers.role,
        })
        .from(s.projects)
        .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, s.projects.id), eq(s.projectMembers.userId, auth.userId)))
        .where(and(...where))
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
  private async keyFree(workspaceId: string, key: string, exceptProjectId?: string) {
    const [taken] = await this.system
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(and(eq(s.projects.workspaceId, workspaceId), eq(s.projects.key, key)));
    const [alias] = await this.system
      .select({ projectId: s.projectKeyAliases.projectId })
      .from(s.projectKeyAliases)
      .where(and(eq(s.projectKeyAliases.workspaceId, workspaceId), eq(s.projectKeyAliases.oldKey, key)));
    // เปลี่ยนกลับเป็น Key เก่าของตัวเองได้
    return (!taken || taken.id === exceptProjectId) && (!alias || alias.projectId === exceptProjectId);
  }

  /** A · New Project · สร้างทุกอย่างในธุรกรรมเดียว */
  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateProjectBody>) {
    const result = await this.db.run(auth, tenant, (tx) => this.createInTx(tx, auth, tenant, input));
    return { ...this.dto(result.project, 'admin', true), created: result.created };
  }

  /** สร้างโปรเจกต์ในธุรกรรมที่มีอยู่แล้ว (ใช้ร่วมกับ Import Excel) */
  async createInTx(tx: Tx, auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateProjectBody>) {
    if (tenant.role === 'guest') throw forbidden('ws.project.create');
    if (!(await this.keyFree(tenant.workspaceId, input.key))) throw new AppError(409, 'key_taken', 'Project Key นี้มีใน Workspace แล้ว', { key: input.key });
    await this.limits.assert(tx, tenant.workspaceId, 'projects');

    const template = input.templateId ? await this.loadTemplate(tx, input.templateId) : null;
    const cfg: TemplateConfig = template?.config ?? {};
    if (input.holidayCalendarId) await this.assertCalendar(tx, input.holidayCalendarId);
    const seen = new Set([auth.userId]);
    const members = (input.members ?? []).filter((m) => !seen.has(m.userId) && !!seen.add(m.userId));
    await checkNewMembers(tx, members);
    const statuses = normalizeWorkflow(input.workflow ?? cfg.workflow) ?? STANDARD;
    const sprintLengthWeeks = input.sprintLengthWeeks !== undefined ? input.sprintLengthWeeks : cfg.sprintLengthWeeks !== undefined ? cfg.sprintLengthWeeks : 2;

    // ไม่ใช้ RETURNING: policy ฝั่ง SELECT ตรวจด้วย accessible_project_ids() ซึ่งยังไม่เห็นแถวที่กำลัง INSERT ในคำสั่งเดียวกัน
    // Member ของ Workspace (ไม่ใช่ Owner / Admin) จึงโดน RLS ปฏิเสธ · อ่านกลับในคำสั่งถัดไปแทน
    const projectId = randomUUID();
    await tx
      .insert(s.projects)
      .values({
        id: projectId,
        workspaceId: tenant.workspaceId,
        key: input.key,
        name: input.name,
        clientName: input.clientName,
        description: input.description,
        color: input.color,
        templateId: template?.id,
        startDate: input.startDate,
        goliveDate: input.goliveDate,
        timezone: input.timezone,
        visibility: input.visibility,
        ownerUserId: auth.userId,
        sprintLengthWeeks,
        estimateUnit: input.estimateUnit ?? cfg.estimateUnit ?? 'man_day',
        progressMethod: input.progressMethod ?? cfg.progressMethod ?? 'weighted',
        holidayCalendarId: input.holidayCalendarId,
        sizeMdMap: cfg.sizeMdMap,
        timeLogEnabled: cfg.timeLogEnabled ?? false,
      });
    const [project] = await tx.select().from(s.projects).where(eq(s.projects.id, projectId));
    const base = { workspaceId: tenant.workspaceId, projectId: project.id };
    await tx.insert(s.projectMembers).values({ ...base, userId: auth.userId, role: 'admin' });
    if (members.length) {
      await tx.insert(s.projectMembers).values(members.map((m) => ({ ...base, userId: m.userId, role: m.role, position: m.position, capacityHoursWeek: m.capacityHoursWeek })));
    }

    // Workflow มาตรฐาน + Workflow ของ Bug
    const [stdWf] = await tx.insert(s.workflows).values({ ...base, name: 'มาตรฐาน' }).returning();
    const std = await tx
      .insert(s.workflowStatuses)
      .values(statuses.map((st, i) => ({ ...base, workflowId: stdWf.id, name: st.name, category: st.category, wipLimit: st.wipLimit ?? null, sort: i })))
      .returning({ id: s.workflowStatuses.id, category: s.workflowStatuses.category });
    const [bugWf] = await tx.insert(s.workflows).values({ ...base, name: 'Bug' }).returning();
    await tx
      .insert(s.workflowStatuses)
      .values(BUG.map((st, i) => ({ ...base, workflowId: bugWf.id, name: st.name, category: st.category, boardColumnId: boardColumn(std, st.column), sort: i })));
    await tx
      .insert(s.issueTypes)
      .values(issueTypesFor(cfg).map((t, i) => ({ ...base, name: t.name, color: t.color, workflowId: t.bug ? bugWf.id : stdWf.id, requiredFields: t.required, enabled: t.enabled, sort: i })));
    // กฎ Workflow ค่าเริ่มต้นตาม catalog (BUG-10) · บางกฎ implicitEnabled = false จึงไม่มีผลถ้าไม่มีแถว
    // อยู่ในธุรกรรมเดียวกับการสร้าง ครอบคลุม Template / Wizard / Sample / Import เพราะทุกทางสร้างผ่านจุดนี้
    await tx.insert(s.workflowRules).values([
      ...defaultWorkflowRules('standard').map((r) => ({ ...base, workflowId: stdWf.id, ...r })),
      ...defaultWorkflowRules('bug').map((r) => ({ ...base, workflowId: bugWf.id, ...r })),
    ]);
    if (cfg.customFields?.length) {
      await tx.insert(s.customFields).values(cfg.customFields.map((f, i) => ({ ...base, name: f.name, fieldType: f.fieldType, options: f.options ?? null, sort: i })));
    }
    if (cfg.labels?.length) {
      await tx.insert(s.labels).values(cfg.labels.map((l) => ({ ...base, name: l.name, color: l.color }))).onConflictDoNothing();
    }

    // Module จาก Wizard ชนะ Template · ไม่ส่งมาเลยใช้ของ Template
    const modules = input.modules.length ? input.modules : (cfg.modules ?? []);
    if (modules.length) {
      await tx.insert(s.modules).values(modules.map((name, i) => ({ ...base, name, sort: i })));
    }
    if (input.milestones.length) {
      await tx.insert(s.milestones).values(input.milestones.map((m) => ({ ...base, name: m.name, date: m.date })));
    }
    const holidays = input.extraHolidays ?? [];
    if (holidays.length) {
      await tx.insert(s.projectHolidays).values(holidays.map((h) => ({ ...base, date: h.date, name: h.name }))).onConflictDoNothing();
    }
    const scope = Object.entries(input.scope ?? {}).flatMap(([k, items]) =>
      (items ?? []).map((text, i) => ({ ...base, kind: SCOPE_KINDS[k as keyof typeof SCOPE_KINDS], text, sort: i })),
    );
    if (scope.length) await tx.insert(s.projectScopeItems).values(scope);
    const sprints = sprintPlan(input.startDate, input.goliveDate, sprintLengthWeeks);
    if (sprints.length) {
      await tx.insert(s.sprints).values(sprints.map((sp) => ({ ...base, ...sp })));
    }
    if (template) {
      await tx.update(s.projectTemplates).set({ usageCount: sql`${s.projectTemplates.usageCount} + 1` }).where(eq(s.projectTemplates.id, template.id));
    }
    await this.audit(tx, auth, tenant, project, 'data', 'project.created', `${project.key} · ${project.name}${template ? ` · Template ${template.name}` : ''}`);
    return {
      project,
      created: {
        modules: modules.length,
        statuses: statuses.length,
        milestones: input.milestones.length,
        sprints: sprints.length,
        members: members.length + 1,
        holidays: holidays.length,
        scopeItems: scope.length,
        customFields: cfg.customFields?.length ?? 0,
        labels: cfg.labels?.length ?? 0,
      },
    };
  }

  /** Template ของ Workspace (RLS แยก Workspace) · config ที่ผิดรูปแบบตอบ 422 แทนการสร้างโปรเจกต์ครึ่ง ๆ */
  private async loadTemplate(tx: Tx, id: string) {
    const [row] = await tx.select().from(s.projectTemplates).where(eq(s.projectTemplates.id, id));
    if (!row) throw new AppError(404, 'template_not_found', 'ไม่พบ Template');
    const parsed = TemplateConfig.safeParse(row.config ?? {});
    if (!parsed.success) {
      throw new AppError(422, 'template_invalid', 'Template นี้ตั้งค่าไม่ถูกต้อง · ให้ Admin แก้ที่ Admin Console', {
        fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return { id: row.id, name: row.name, config: parsed.data };
  }

  /** ปฏิทินวันหยุดที่ Workspace นี้ใช้ได้ (ปฏิทินกลาง ธปท. หรือของ Workspace เอง · RLS กรองให้) */
  private async assertCalendar(tx: Tx, id: string) {
    const [cal] = await tx.select({ id: s.holidayCalendars.id }).from(s.holidayCalendars).where(eq(s.holidayCalendars.id, id));
    if (!cal) throw new AppError(400, 'holiday_calendar_not_found', 'ไม่พบปฏิทินวันหยุดนี้', { holidayCalendarId: id });
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

  // ---------------------------------------------------------------------------
  // L2 › ทั่วไป (PATCH + If-Match)
  // ---------------------------------------------------------------------------
  async patch(auth: AuthInfo, tenant: TenantInfo, key: string, ifMatch: string | undefined, input: z.infer<typeof PatchProjectBody>) {
    const expected = parseIfMatch(ifMatch);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      requirePerm(access, 'project.settings');
      if (project.version !== expected) throw await this.conflict(tx, project.id, access);

      const warnings: { code: string; message: string }[] = [];
      const startDate = input.startDate ?? project.startDate;
      const goliveDate = input.goliveDate ?? project.goliveDate;
      if (goliveDate < startDate) throw new AppError(400, 'invalid_dates', 'วัน Go-live ต้องไม่ก่อนวันเริ่ม', { fields: ['goliveDate'] });
      const workStart = input.workStart !== undefined ? input.workStart : project.workStart?.slice(0, 5);
      const workEnd = input.workEnd !== undefined ? input.workEnd : project.workEnd?.slice(0, 5);
      if (workStart && workEnd && workEnd <= workStart) throw new AppError(400, 'invalid_work_hours', 'เวลาเลิกงานต้องหลังเวลาเริ่มงาน', { fields: ['workEnd'] });

      // N1 › ปิด "ให้โปรเจกต์ตั้งค่าเองได้" แล้ว โปรเจกต์ใช้ค่าของ Workspace เท่านั้น (ล้างค่ากลับเป็น null ได้เสมอ)
      const overrides = (['sizeMdMap', 'holidayCalendarId', 'workStart', 'workEnd'] as const).filter((k) => input[k] != null);
      if (overrides.length) {
        const [ws] = await tx.select({ allow: s.workspaceSettings.allowProjectOverride }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
        if (ws && !ws.allow) throw new AppError(409, 'project_override_disabled', 'Workspace นี้ไม่ให้โปรเจกต์ตั้งค่าเวลาทำงาน, Size หรือปฏิทินวันหยุดเอง', { fields: overrides });
      }
      if (input.holidayCalendarId) await this.assertCalendar(tx, input.holidayCalendarId);
      if (input.holidayCalendarId !== undefined && input.holidayCalendarId !== project.holidayCalendarId) {
        warnings.push({ code: 'plan_end_not_recalculated', message: 'เปลี่ยนปฏิทินวันหยุดแล้ว · Plan End ของงานเดิมยังไม่ถูกคำนวณใหม่' });
      }

      const set: Partial<typeof s.projects.$inferInsert> = {};
      for (const [k, v] of Object.entries(input)) {
        if (k === 'key' || v === undefined) continue;
        const current = (project as Record<string, unknown>)[k];
        const same = k === 'workStart' || k === 'workEnd' ? (current as string | null)?.slice(0, 5) === v : JSON.stringify(current) === JSON.stringify(v);
        if (!same) (set as Record<string, unknown>)[k] = v;
      }

      // เปลี่ยน Key: เก็บ Key เดิมเป็น alias ให้ลิงก์เก่าได้ 301 · เปลี่ยนกลับเป็น Key เก่าของตัวเองได้ (ลบ alias นั้นทิ้ง)
      const newKey = input.key && input.key !== project.key ? input.key : null;
      if (newKey) {
        if (!(await this.keyFree(tenant.workspaceId, newKey, project.id))) throw new AppError(409, 'key_taken', 'Project Key นี้มีใน Workspace แล้ว', { key: newKey });
        await tx.delete(s.projectKeyAliases).where(and(eq(s.projectKeyAliases.projectId, project.id), eq(s.projectKeyAliases.oldKey, newKey)));
        await tx.insert(s.projectKeyAliases).values({ workspaceId: tenant.workspaceId, projectId: project.id, oldKey: project.key });
        set.key = newKey;
      }
      if (!Object.keys(set).length) return { ...this.dto(project, access.role, true), warnings };

      const [updated] = await tx
        .update(s.projects)
        .set(set)
        .where(and(eq(s.projects.id, project.id), eq(s.projects.version, expected)))
        .returning();
      if (!updated) throw await this.conflict(tx, project.id, access);
      const fields = Object.keys(set);
      await this.audit(tx, auth, tenant, updated, 'data', 'project.updated', `${updated.key} · ${fields.join(', ')}`);
      if (newKey) await this.audit(tx, auth, tenant, updated, 'data', 'project.key_changed', `${project.key} → ${newKey}`);
      return { ...this.dto(updated, access.role, true), warnings };
    });
  }

  private async conflict(tx: Tx, projectId: string, access: ProjectAccess) {
    const [latest] = await tx.select().from(s.projects).where(eq(s.projects.id, projectId));
    return new AppError(409, 'conflict', 'โปรเจกต์นี้ถูกแก้โดยคนอื่นระหว่างที่คุณกำลังแก้ · โหลดค่าล่าสุดแล้วลองอีกครั้ง', {
      latest: this.dto(latest, access.role, true),
    });
  }

  // ---------------------------------------------------------------------------
  // L2 › Danger zone: Archive / Restore / โอน / ลบ
  // ---------------------------------------------------------------------------
  /** Archive = ซ่อนจาก Sidebar และอ่านอย่างเดียว (projectAccess ตัดสิทธิ์เขียน) */
  async archive(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      requirePerm(access, 'project.archive');
      if (project.archivedAt) throw new AppError(409, 'already_archived', 'โปรเจกต์นี้ถูก Archive อยู่แล้ว');
      const [updated] = await tx.update(s.projects).set({ status: 'archived', archivedAt: new Date() }).where(eq(s.projects.id, project.id)).returning();
      await this.audit(tx, auth, tenant, updated, 'data', 'project.archived', `${updated.key} · ${updated.name}`);
      return this.dto(updated, access.role, true);
    });
  }

  /** กลับมาแก้ไขได้ · สถานะตามวันเริ่ม (ยังไม่ถึงวันเริ่ม = planning) เพราะไม่ได้เก็บสถานะก่อน Archive */
  async restore(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      requirePerm(access, 'project.archive');
      if (!project.archivedAt) throw new AppError(409, 'not_archived', 'โปรเจกต์นี้ไม่ได้ถูก Archive');
      const status = today() < project.startDate ? 'planning' : 'active';
      const [updated] = await tx.update(s.projects).set({ status, archivedAt: null }).where(eq(s.projects.id, project.id)).returning();
      await this.audit(tx, auth, tenant, updated, 'data', 'project.restored', `${updated.key} · ${updated.name}`);
      return this.dto(updated, access.role, true);
    });
  }

  /**
   * โอนความเป็น Project Owner ให้สมาชิกโปรเจกต์ (ไม่ใช่ Guest) · ผู้รับเป็น Admin
   * Workspace Owner / Admin ที่เข้าร่วมแล้วโอนแทนได้ (โปรเจกต์กำพร้า, 04-permissions ข้อ 6)
   */
  async transfer(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof TransferBody>) {
    const isWsAdmin = tenant.role === 'owner' || tenant.role === 'admin';
    const { updated, role } = await this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      if (!access.isOwner && !isWsAdmin) throw forbidden('project.owner');
      if (input.userId === project.ownerUserId) throw new AppError(409, 'already_owner', 'คนนี้เป็น Project Owner อยู่แล้ว');
      const [target] = await tx
        .select({ wsRole: s.workspaceMembers.role, name: s.users.displayName })
        .from(s.projectMembers)
        .innerJoin(s.users, eq(s.users.id, s.projectMembers.userId))
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.projectMembers.workspaceId), eq(s.workspaceMembers.userId, s.projectMembers.userId), eq(s.workspaceMembers.status, 'active')))
        .where(and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, input.userId)));
      if (!target) throw new AppError(400, 'transfer_target_invalid', 'โอนได้เฉพาะสมาชิกของโปรเจกต์ที่ยังใช้งานอยู่');
      if (target.wsRole === 'guest') throw new AppError(409, 'guest_cannot_own', 'Guest เป็น Project Owner ไม่ได้');

      await tx.update(s.projectMembers).set({ role: 'admin' }).where(and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, input.userId)));
      // เจ้าของเดิมยังเป็น Admin ต่อ (ถ้ายังอยู่ในโปรเจกต์) เพื่อไม่ให้หลุดออกจากงานที่ทำอยู่
      await tx.update(s.projectMembers).set({ role: 'admin' }).where(and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, project.ownerUserId)));
      const [updated] = await tx.update(s.projects).set({ ownerUserId: input.userId }).where(eq(s.projects.id, project.id)).returning();
      await this.audit(tx, auth, tenant, updated, 'perm', 'project.transferred', `${updated.key} · โอนให้ ${target.name}`);
      const [me] = await tx.select({ role: s.projectMembers.role }).from(s.projectMembers).where(and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, auth.userId)));
      return { updated, role: me?.role ?? null };
    });
    // แจ้งเตือนสร้างโดยระบบ (แอปไม่มีสิทธิ์ INSERT notifications) เหมือน joinAsAdmin
    if (input.userId !== auth.userId) {
      await this.system.insert(s.notifications).values({
        workspaceId: tenant.workspaceId,
        recipientId: input.userId,
        eventType: 'project.transferred',
        actorId: auth.userId,
        projectId: updated.id,
        payload: { projectKey: updated.key, projectName: updated.name },
        reason: 'คุณได้รับโอนเป็น Project Owner',
      });
    }
    return this.dto(updated, role, true);
  }

  /** Project Owner หรือ Workspace Owner / Admin (03-api › 3.4) */
  private canDelete(access: ProjectAccess, tenant: TenantInfo) {
    return access.isOwner || tenant.role === 'owner' || tenant.role === 'admin';
  }

  /** P3 · ตัวเลขใน Dialog ลบโปรเจกต์ */
  async deleteImpact(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      const canDelete = this.canDelete(access, tenant);
      if (!canDelete && !access.perms.has('project.settings')) throw forbidden('project.owner');
      const [issues] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.issues)
        .where(and(eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)));
      const [files] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.files)
        .where(and(eq(s.files.projectId, project.id), isNull(s.files.deletedAt)));
      const [members] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.projectMembers).where(eq(s.projectMembers.projectId, project.id));
      return { key: project.key, name: project.name, issues: issues.n, files: files.n, members: members.n, trashDays: await this.trashDays(tx, tenant), canDelete };
    });
  }

  /** ลบแบบ soft delete · อยู่ในถังขยะตาม trash_days ของ Workspace (ค่าเริ่มต้น 30 วัน) แล้วงานเบื้องหลังลบจริง */
  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof DeleteProjectBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.load(tx, auth, tenant, key);
      if (!this.canDelete(access, tenant)) throw forbidden('project.owner');
      if (input.confirmKey.toUpperCase() !== project.key) throw new AppError(400, 'confirm_key_mismatch', `พิมพ์ ${project.key} ให้ตรงเพื่อยืนยันการลบ`, { fields: ['confirmKey'] });
      const deletedAt = new Date();
      await tx.update(s.projects).set({ deletedAt }).where(eq(s.projects.id, project.id));
      await this.audit(tx, auth, tenant, project, 'data', 'project.deleted', `${project.key} · ${project.name}`);
      return { key: project.key, deletedAt, restorableUntil: await this.restorableUntil(tx, tenant, deletedAt) };
    });
  }

  private async trashDays(tx: Tx, tenant: TenantInfo) {
    const [ws] = await tx.select({ days: s.workspaceSettings.trashDays }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
    return ws?.days ?? 30;
  }

  private async restorableUntil(tx: Tx, tenant: TenantInfo, deletedAt: Date) {
    return new Date(deletedAt.getTime() + (await this.trashDays(tx, tenant)) * 86_400_000);
  }

  private async audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: { id: string }, category: 'perm' | 'data', action: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category, action, targetType: 'project', targetId: project.id, summary });
  }

  dto(p: ProjectRow, role: ProjectAccess['role'], joined: boolean) {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      clientName: p.clientName,
      description: p.description,
      color: p.color,
      icon: p.icon,
      templateId: p.templateId,
      startDate: p.startDate,
      goliveDate: p.goliveDate,
      timezone: p.timezone,
      visibility: p.visibility,
      status: p.status,
      archivedAt: p.archivedAt,
      ownerUserId: p.ownerUserId,
      sprintLengthWeeks: p.sprintLengthWeeks,
      estimateUnit: p.estimateUnit,
      progressMethod: p.progressMethod,
      sizeMdMap: p.sizeMdMap as z.infer<typeof SizeMdMap> | null,
      holidayCalendarId: p.holidayCalendarId,
      workStart: p.workStart?.slice(0, 5) ?? null,
      workEnd: p.workEnd?.slice(0, 5) ?? null,
      timeLogEnabled: p.timeLogEnabled,
      version: p.version,
      myRole: role,
      joined,
    };
  }
}

function parseIfMatch(v: string | undefined) {
  if (!v) throw new AppError(428, 'if_match_required', 'ต้องส่ง If-Match ที่ได้จาก ETag ของโปรเจกต์');
  const n = Number(v.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, 'invalid_if_match', 'If-Match ไม่ถูกต้อง');
  return n;
}

/**
 * คนที่จะใส่เป็นสมาชิกโปรเจกต์ต้องเป็นสมาชิก Workspace ที่ active · Guest เป็น Admin ไม่ได้ (04-permissions ข้อ 4)
 * คืน Role ใน Workspace ของแต่ละคน
 */
export async function checkNewMembers(tx: Tx, members: { userId: string; role?: 'admin' | 'member' | 'viewer' }[]) {
  if (!members.length) return new Map<string, string>();
  const ids = [...new Set(members.map((m) => m.userId))];
  const rows = await tx
    .select({ userId: s.workspaceMembers.userId, role: s.workspaceMembers.role })
    .from(s.workspaceMembers)
    .where(and(inArray(s.workspaceMembers.userId, ids), eq(s.workspaceMembers.status, 'active')));
  const roles = new Map(rows.map((r) => [r.userId, r.role as string]));
  const missing = ids.filter((id) => !roles.has(id));
  if (missing.length) throw new AppError(400, 'not_workspace_member', 'เพิ่มได้เฉพาะสมาชิกของ Workspace ที่ยังใช้งานอยู่', { userIds: missing });
  const guestAdmins = members.filter((m) => m.role === 'admin' && roles.get(m.userId) === 'guest').map((m) => m.userId);
  if (guestAdmins.length) throw new AppError(409, 'guest_role_limit', 'Guest เป็นได้แค่ Member หรือ Viewer ในโปรเจกต์', { userIds: guestAdmins });
  return roles;
}

/** Workflow จาก Wizard / Template → สถานะพร้อมหมวด · ต้องมีหมวด todo และ done อย่างน้อยอย่างละ 1 */
function normalizeWorkflow(spec: z.infer<typeof WorkflowSpec> | undefined) {
  if (!spec) return null;
  const out = spec.map((st, i) => ({
    name: st.name,
    category: (st.category ?? (i === 0 ? 'todo' : i === spec.length - 1 ? 'done' : 'in_progress')) as StatusCategory,
    wipLimit: st.wipLimit ?? null,
  }));
  if (!out.some((x) => x.category === 'todo') || !out.some((x) => x.category === 'done')) {
    throw new AppError(400, 'workflow_invalid', 'Workflow ต้องมีสถานะหมวด To do และ Done อย่างน้อยอย่างละ 1', { fields: ['workflow'] });
  }
  return out;
}

/** คอลัมน์บนบอร์ดของสถานะ Bug = สถานะแรก / สุดท้ายของหมวดนั้นใน Workflow มาตรฐาน */
function boardColumn(std: { id: string; category: string }[], column: (typeof BUG)[number]['column']) {
  const [which, ...rest] = column.split('_');
  const cat = rest.join('_');
  const list = std.filter((x) => x.category === cat);
  const hit = which === 'first' ? list[0] : list[list.length - 1];
  // Workflow ที่ไม่มีหมวด In progress: Fixed / Verified ไปอยู่คอลัมน์ Done
  return hit?.id ?? std.find((x) => x.category === 'done')!.id;
}

/** ประเภทงานมาตรฐาน + ค่าที่ Template ปรับ (สี, ฟิลด์บังคับ, เปิดปิด) และประเภทใหม่ของ Template */
function issueTypesFor(cfg: TemplateConfig) {
  const types = TYPES.map((t) => ({ ...t, enabled: true }));
  for (const ct of cfg.issueTypes ?? []) {
    const hit = types.find((t) => t.name.toLowerCase() === ct.name.toLowerCase());
    if (hit) {
      if (ct.color) hit.color = ct.color;
      if (ct.requiredFields) hit.required = ct.requiredFields;
      if (ct.enabled !== undefined) hit.enabled = ct.enabled;
    } else {
      types.push({ name: ct.name, color: ct.color ?? '#64748B', bug: !!ct.bug, required: ct.requiredFields ?? ['title'], enabled: ct.enabled ?? true });
    }
  }
  return types;
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
