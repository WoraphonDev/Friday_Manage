// D. โปรเจกต์และโครงสร้างแผน · E. ประเภทงาน, Workflow และฟิลด์
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type ForeignKeyBuilder,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, manDay, pk, tstz, updatedAt } from './_common.ts';
import {
  customFieldType,
  estimateUnit,
  progressMethod,
  projectRole,
  projectStatus,
  scopeKind,
  sprintStatus,
  statusCategory,
  visibility,
} from './enums.ts';
import { users } from './identity.ts';
import { holidayCalendars, workspaces } from './workspace.ts';

export const workspaceId = () =>
  uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' });

/**
 * FK แบบ (workspace_id, project_id) → projects(workspace_id, id)
 * FK ตรวจข้าม RLS ได้ จึงต้องรวม workspace_id เพื่อกันการอ้างโปรเจกต์ของ Workspace อื่น
 */
export const inProject = (table: string, t: { workspaceId: AnyPgColumn; projectId: AnyPgColumn }): ForeignKeyBuilder =>
  foreignKey({
    name: `${table}_project_fk`,
    columns: [t.workspaceId, t.projectId],
    foreignColumns: [projects.workspaceId, projects.id],
  }).onDelete('cascade');

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    workspaceId: workspaceId(),
    key: text().notNull(),
    name: text().notNull(),
    clientName: text(),
    description: text(),
    color: text(),
    icon: text(),
    /** FK ไป project_templates เพิ่มใน migration ของ Template */
    templateId: uuid(),
    startDate: date().notNull(),
    goliveDate: date().notNull(),
    timezone: text().notNull().default('Asia/Bangkok'),
    visibility: visibility().notNull().default('private'),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    status: projectStatus().notNull().default('planning'),
    estimateUnit: estimateUnit().notNull().default('man_day'),
    progressMethod: progressMethod().notNull().default('weighted'),
    /** null = ไม่ใช้ Sprint */
    sprintLengthWeeks: smallint(),
    holidayCalendarId: uuid().references(() => holidayCalendars.id),
    /** null = ใช้ค่าของ Workspace */
    workStart: time(),
    workEnd: time(),
    sizeMdMap: jsonb(),
    timeLogEnabled: boolean().notNull().default(false),
    /** เลขงานล่าสุด ออกเลขด้วย UPDATE … RETURNING ในธุรกรรมเดียวกับการสร้างงาน */
    issueSeq: integer().notNull().default(0),
    budgetSatang: bigint({ mode: 'number' }),
    hourlyRateSatang: bigint({ mode: 'number' }),
    archivedAt: tstz(),
    deletedAt: deletedAt(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('projects_workspace_id_key').on(t.workspaceId, t.id),
    uniqueIndex('projects_workspace_key_key').on(t.workspaceId, t.key),
    check('projects_key_format', sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check('projects_dates', sql`${t.goliveDate} >= ${t.startDate}`),
  ],
);

/** Key เดิมหลังเปลี่ยน Key · ใช้ redirect ลิงก์เก่า */
export const projectKeyAliases = pgTable(
  'project_key_aliases',
  {
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    oldKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.oldKey] }), inProject('project_key_aliases', t)],
);

export const projectScopeItems = pgTable(
  'project_scope_items',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    kind: scopeKind().notNull(),
    text: text().notNull(),
    sort: integer().notNull().default(0),
  },
  (t) => [inProject('project_scope_items', t), index('project_scope_items_project_idx').on(t.projectId)],
);

export const projectHolidays = pgTable(
  'project_holidays',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    date: date().notNull(),
    name: text().notNull(),
  },
  (t) => [inProject('project_holidays', t), uniqueIndex('project_holidays_key').on(t.projectId, t.date)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRole().notNull().default('member'),
    position: text(),
    /** ชั่วโมงที่แบ่งให้โปรเจกต์นี้ · แสดงเป็น MD (8 ชม. = 1 MD) */
    capacityHoursWeek: smallint(),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    inProject('project_members', t),
    index('project_members_user_idx').on(t.userId),
  ],
);

/** เก็บเฉพาะช่องที่ต่างจากค่าเริ่มต้นของหน้า L2 · Admin เปิดทุกอย่างเสมอจึงไม่เก็บ */
export const projectRolePermissions = pgTable(
  'project_role_permissions',
  {
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    role: projectRole().notNull(),
    permission: text().notNull(),
    allowed: boolean().notNull(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.role, t.permission] }),
    inProject('project_role_permissions', t),
    check('project_role_permissions_not_admin', sql`${t.role} <> 'admin'`),
  ],
);

export const modules = pgTable(
  'modules',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    color: text(),
    /** Dev หลัก */
    ownerUserId: uuid().references(() => users.id),
    sort: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique('modules_workspace_id_key').on(t.workspaceId, t.id), inProject('modules', t)],
);

/** กลุ่มงาน (Phase) ใน Module · มาจากคอลัมน์ "Sprint" ในไฟล์ Excel */
export const phases = pgTable(
  'phases',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    moduleId: uuid().notNull(),
    name: text().notNull(),
    sort: integer().notNull().default(0),
  },
  (t) => [
    unique('phases_workspace_id_key').on(t.workspaceId, t.id),
    inProject('phases', t),
    foreignKey({
      name: 'phases_module_fk',
      columns: [t.workspaceId, t.moduleId],
      foreignColumns: [modules.workspaceId, modules.id],
    }).onDelete('cascade'),
  ],
);

export const milestones = pgTable(
  'milestones',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    moduleId: uuid(),
    name: text().notNull(),
    date: date().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('milestones_workspace_id_key').on(t.workspaceId, t.id),
    inProject('milestones', t),
    foreignKey({
      name: 'milestones_module_fk',
      columns: [t.workspaceId, t.moduleId],
      foreignColumns: [modules.workspaceId, modules.id],
    }),
  ],
);

export const sprints = pgTable(
  'sprints',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    number: integer().notNull(),
    name: text().notNull(),
    startDate: date().notNull(),
    endDate: date().notNull(),
    goal: text(),
    status: sprintStatus().notNull().default('planning'),
    retrospective: text(),
    completedAt: tstz(),
    completedBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sprints_workspace_id_key').on(t.workspaceId, t.id),
    inProject('sprints', t),
    uniqueIndex('sprints_project_number_key').on(t.projectId, t.number),
    // มี Sprint active ได้ทีละ 1 ต่อโปรเจกต์
    uniqueIndex('sprints_one_active_key')
      .on(t.projectId)
      .where(sql`${t.status} = 'active'`),
    check('sprints_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** ค่าประจำวันสำหรับเส้น "จริง" ของ Burndown */
export const sprintDailySnapshots = pgTable(
  'sprint_daily_snapshots',
  {
    workspaceId: workspaceId(),
    sprintId: uuid().notNull(),
    date: date().notNull(),
    remainingMd: manDay().notNull(),
    doneMd: manDay().notNull(),
    issueCount: integer().notNull(),
    doneCount: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sprintId, t.date] }),
    foreignKey({
      name: 'sprint_daily_snapshots_sprint_fk',
      columns: [t.workspaceId, t.sprintId],
      foreignColumns: [sprints.workspaceId, sprints.id],
    }).onDelete('cascade'),
  ],
);

export const workflows = pgTable(
  'workflows',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
  },
  (t) => [unique('workflows_workspace_id_key').on(t.workspaceId, t.id), inProject('workflows', t)],
);

export const workflowStatuses = pgTable(
  'workflow_statuses',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    workflowId: uuid().notNull(),
    name: text().notNull(),
    category: statusCategory().notNull(),
    /**
     * คอลัมน์บน Kanban: ชี้ไปสถานะของ Workflow มาตรฐาน (null = สถานะนี้เป็นคอลัมน์เอง)
     * เช่น Bug: Fixed, Verified → Review · ตั้งที่ Project Settings › Workflow › Bug
     */
    boardColumnId: uuid(),
    wipLimit: smallint(),
    sort: integer().notNull().default(0),
  },
  (t) => [
    unique('workflow_statuses_workspace_id_key').on(t.workspaceId, t.id),
    inProject('workflow_statuses', t),
    foreignKey({
      name: 'workflow_statuses_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_statuses_board_column_fk',
      columns: [t.workspaceId, t.boardColumnId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    check('workflow_statuses_not_own_column', sql`${t.boardColumnId} <> ${t.id}`),
  ],
);

export const workflowRules = pgTable(
  'workflow_rules',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    workflowId: uuid().notNull(),
    ruleType: text().notNull(),
    config: jsonb().notNull().default(sql`'{}'::jsonb`),
    enabled: boolean().notNull().default(true),
  },
  (t) => [
    inProject('workflow_rules', t),
    foreignKey({
      name: 'workflow_rules_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
  ],
);

export const issueTypes = pgTable(
  'issue_types',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    color: text(),
    icon: text(),
    workflowId: uuid().notNull(),
    requiredFields: text().array().notNull().default(sql`'{}'`),
    enabled: boolean().notNull().default(true),
    sort: integer().notNull().default(0),
  },
  (t) => [
    unique('issue_types_workspace_id_key').on(t.workspaceId, t.id),
    inProject('issue_types', t),
    foreignKey({
      name: 'issue_types_workflow_fk',
      columns: [t.workspaceId, t.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
  ],
);

/** ฟิลด์ที่ทีมเพิ่มเอง · ฟิลด์มาตรฐาน (BA, Dev, FR, Screen, Plan/Actual) อยู่ในตาราง issues */
export const customFields = pgTable(
  'custom_fields',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    fieldType: customFieldType().notNull(),
    options: jsonb(),
    sort: integer().notNull().default(0),
  },
  (t) => [unique('custom_fields_workspace_id_key').on(t.workspaceId, t.id), inProject('custom_fields', t)],
);

export const labels = pgTable(
  'labels',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    color: text(),
  },
  (t) => [
    unique('labels_workspace_id_key').on(t.workspaceId, t.id),
    inProject('labels', t),
    uniqueIndex('labels_project_name_key').on(t.projectId, sql`lower(${t.name})`),
  ],
);
