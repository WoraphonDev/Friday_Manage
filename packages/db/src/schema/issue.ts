// F. งาน (Issue) · Task, Sub-task, Story, Bug และ Spike อยู่ในตารางเดียว
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type ForeignKeyBuilder,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, manDay, pk, tstz, updatedAt } from './_common.ts';
import {
  actorKind,
  checklistKind,
  decidedVia,
  dependencyType,
  dueReason,
  environment,
  priority,
  requestStatus,
  severity,
  size,
  testKind,
  testResult,
  watchSource,
} from './enums.ts';
import { users } from './identity.ts';
import {
  customFields,
  inProject,
  issueTypes,
  labels,
  milestones,
  modules,
  phases,
  sprints,
  workflowStatuses,
  workspaceId,
} from './project.ts';

/** FK แบบ (workspace_id, issue_id) → issues(workspace_id, id) */
const inIssue = (table: string, t: { workspaceId: AnyPgColumn; issueId: AnyPgColumn }): ForeignKeyBuilder =>
  foreignKey({
    name: `${table}_issue_fk`,
    columns: [t.workspaceId, t.issueId],
    foreignColumns: [issues.workspaceId, issues.id],
  }).onDelete('cascade');

const sameWs = (
  table: string,
  col: string,
  t: { workspaceId: AnyPgColumn },
  c: AnyPgColumn,
  target: { workspaceId: AnyPgColumn; id: AnyPgColumn },
): ForeignKeyBuilder =>
  foreignKey({ name: `${table}_${col}_fk`, columns: [t.workspaceId, c], foreignColumns: [target.workspaceId, target.id] });

export const issues = pgTable(
  'issues',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    /** DP-**39** */
    number: integer().notNull(),
    issueTypeId: uuid().notNull(),
    /** null = ระดับ Task · ลึกสุด 2 ชั้น (ตรวจด้วย trigger) */
    parentId: uuid(),
    /** No. จากไฟล์ Excel ใช้จับคู่ตอน Import อัปเดต */
    excelRowNo: integer(),

    moduleId: uuid(),
    phaseId: uuid(),
    sprintId: uuid(),
    /** ลำดับใน Backlog / Kanban (LexoRank) */
    rank: text().notNull().default('0|hzzzzz:'),

    title: text().notNull(),
    description: text(),
    /** หมายเหตุ (Remark) ของ Task / Sub-task · แยกจากรายละเอียด (ผู้ใช้เพิ่ม 2026-11-09) */
    remark: text(),
    statusId: uuid().notNull(),
    priority: priority().notNull().default('medium'),

    baId: uuid().references(() => users.id),
    /** System Analyst ของงาน (ผู้ใช้เพิ่ม 2026-11-08) */
    saId: uuid().references(() => users.id),
    reviewerId: uuid().references(() => users.id),
    testerId: uuid().references(() => users.id),
    reporterId: uuid().references(() => users.id),
    createdBy: uuid().references(() => users.id),

    /** null = ยังไม่ประเมิน */
    size: size(),
    /** Man-Day ของทั้งทีม */
    estimateMd: manDay(),
    /** กรอกเองได้เฉพาะงานที่ไม่มีลูก */
    progressPct: smallint(),

    planStart: date(),
    /** = Due · โปรเจกต์ที่แยก Dev / QA (progress_split) = วันที่ Dev ต้องส่งให้ QA */
    planEnd: date(),
    /**
     * วันที่ QA ต้องทดสอบเสร็จ ใช้เฉพาะโปรเจกต์ที่แยก Dev / QA (ผู้ใช้ขอ 2026-11-13)
     * null = Plan End + projects.qa_buffer_days วันทำการ · โปรเจกต์อื่นไม่ใช้ค่านี้
     */
    qaEnd: date(),
    actualStart: date(),
    actualEnd: date(),
    completedAt: tstz(),

    severity: severity(),
    environment: environment(),
    reopenCount: smallint().notNull().default(0),
    foundInTestRunId: uuid(),
    /** ฟิลด์ตามประเภท: Bug (browser, steps, expected, actual) · Story (as_a, i_want, so_that) · Spike (question, deliverables, timebox_hours) */
    details: jsonb().notNull().default(sql`'{}'::jsonb`),

    sharedWithGuests: boolean().notNull().default(false),
    deletedAt: deletedAt(),
    /** ผู้ลบ (O30 · ถังขยะ A41 จัดชุดงานที่คนเดียวกันลบใน 2 นาที) · trigger ตั้งจาก app.user_id · กู้คืนแล้วล้างเป็น null */
    deletedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('issues_workspace_id_key').on(t.workspaceId, t.id),
    uniqueIndex('issues_project_number_key').on(t.projectId, t.number),
    inProject('issues', t),
    sameWs('issues', 'type', t, t.issueTypeId, issueTypes),
    sameWs('issues', 'status', t, t.statusId, workflowStatuses),
    sameWs('issues', 'module', t, t.moduleId, modules),
    sameWs('issues', 'phase', t, t.phaseId, phases),
    sameWs('issues', 'sprint', t, t.sprintId, sprints),
    // ไม่ใช้ ON DELETE SET NULL เพราะจะตั้ง workspace_id เป็น null ด้วย · API ล้างค่าก่อนลบ test_run
    sameWs('issues', 'found_in_test_run', t, t.foundInTestRunId, testRuns),
    foreignKey({
      name: 'issues_parent_fk',
      columns: [t.workspaceId, t.parentId],
      foreignColumns: [t.workspaceId, t.id],
    }).onDelete('cascade'),
    index('issues_project_idx').on(t.projectId).where(sql`${t.deletedAt} is null`),
    index('issues_trash_idx').on(t.workspaceId, t.deletedAt).where(sql`${t.deletedAt} IS NOT NULL`),
    index('issues_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    index('issues_description_trgm_idx').using('gin', t.description.op('gin_trgm_ops')),
    index('issues_parent_idx').on(t.parentId),
    index('issues_sprint_idx').on(t.sprintId),
    index('issues_plan_end_idx').on(t.projectId, t.planEnd),
    uniqueIndex('issues_excel_row_key').on(t.projectId, t.excelRowNo),
    check('issues_progress_range', sql`${t.progressPct} between 0 and 100`),
    check('issues_plan_dates', sql`${t.planEnd} >= ${t.planStart}`),
    check('issues_actual_dates', sql`${t.actualEnd} >= ${t.actualStart}`),
    check('issues_not_own_parent', sql`${t.parentId} <> ${t.id}`),
  ],
);

/** Dev / Assignee หลายคน · Man-Day แบ่งเท่ากันตอนคิด Workload */
export const issueAssignees = pgTable(
  'issue_assignees',
  {
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    sort: smallint().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.userId] }),
    inIssue('issue_assignees', t),
    index('issue_assignees_user_idx').on(t.userId),
  ],
);

export const issueWatchers = pgTable(
  'issue_watchers',
  {
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: watchSource().notNull().default('manual'),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] }), inIssue('issue_watchers', t)],
);

export const issueLabels = pgTable(
  'issue_labels',
  {
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    labelId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    inIssue('issue_labels', t),
    sameWs('issue_labels', 'label', t, t.labelId, labels).onDelete('cascade'),
  ],
);

/** FR / NFR · สร้างอัตโนมัติเมื่อถูกอ้างถึง */
export const requirements = pgTable(
  'requirements',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    code: text().notNull(),
    kind: text().notNull().default('FR'),
    title: text(),
    sourceFileId: uuid(),
  },
  (t) => [
    unique('requirements_workspace_id_key').on(t.workspaceId, t.id),
    inProject('requirements', t),
    uniqueIndex('requirements_project_code_key').on(t.projectId, t.code),
    check('requirements_kind', sql`${t.kind} in ('FR', 'NFR')`),
  ],
);

export const issueRequirements = pgTable(
  'issue_requirements',
  {
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    requirementId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.requirementId] }),
    inIssue('issue_requirements', t),
    sameWs('issue_requirements', 'requirement', t, t.requirementId, requirements).onDelete('cascade'),
  ],
);

/** Screen ID (SCR-107) */
export const screens = pgTable(
  'screens',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    code: text().notNull(),
    name: text(),
  },
  (t) => [
    unique('screens_workspace_id_key').on(t.workspaceId, t.id),
    inProject('screens', t),
    uniqueIndex('screens_project_code_key').on(t.projectId, t.code),
  ],
);

export const issueScreens = pgTable(
  'issue_screens',
  {
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    screenId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.screenId] }),
    inIssue('issue_screens', t),
    sameWs('issue_screens', 'screen', t, t.screenId, screens).onDelete('cascade'),
  ],
);

export const issueDependencies = pgTable(
  'issue_dependencies',
  {
    workspaceId: workspaceId(),
    predecessorId: uuid().notNull(),
    successorId: uuid().notNull(),
    type: dependencyType().notNull().default('FS'),
    lagDays: smallint().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.predecessorId, t.successorId] }),
    sameWs('issue_dependencies', 'predecessor', t, t.predecessorId, issues).onDelete('cascade'),
    sameWs('issue_dependencies', 'successor', t, t.successorId, issues).onDelete('cascade'),
    index('issue_dependencies_successor_idx').on(t.successorId),
    check('issue_dependencies_not_self', sql`${t.predecessorId} <> ${t.successorId}`),
  ],
);

/** Checklist และ Acceptance criteria */
export const checklistItems = pgTable(
  'checklist_items',
  {
    id: pk(),
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    kind: checklistKind().notNull().default('checklist'),
    text: text().notNull(),
    done: boolean().notNull().default(false),
    doneBy: uuid().references(() => users.id),
    doneAt: tstz(),
    sort: integer().notNull().default(0),
  },
  (t) => [inIssue('checklist_items', t), index('checklist_items_issue_idx').on(t.issueId)],
);

export const comments = pgTable(
  'comments',
  {
    id: pk(),
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    body: text().notNull(),
    editedAt: tstz(),
    deletedAt: deletedAt(),
    deletedBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('comments_workspace_id_key').on(t.workspaceId, t.id),
    inIssue('comments', t),
    index('comments_issue_idx').on(t.issueId, t.createdAt),
    index('comments_body_trgm_idx').using('gin', t.body.op('gin_trgm_ops')),
  ],
);

export const commentMentions = pgTable(
  'comment_mentions',
  {
    workspaceId: workspaceId(),
    commentId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.userId] }),
    sameWs('comment_mentions', 'comment', t, t.commentId, comments).onDelete('cascade'),
  ],
);

/** ประวัติทุกการเปลี่ยนแปลง (append-only: แอปได้แค่ INSERT / SELECT) */
export const activities = pgTable(
  'activities',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    issueId: uuid(),
    actorId: uuid().references(() => users.id),
    actorKind: actorKind().notNull().default('user'),
    verb: text().notNull(),
    field: text(),
    oldValue: jsonb(),
    newValue: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    inProject('activities', t),
    inIssue('activities', t),
    index('activities_issue_idx').on(t.issueId, t.createdAt),
    index('activities_project_idx').on(t.projectId, t.createdAt),
  ],
);

/** บันทึกเวลา (เปิดเมื่อโปรเจกต์เปิด Time log) */
export const timeLogs = pgTable(
  'time_logs',
  {
    id: pk(),
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    date: date().notNull(),
    md: manDay().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [inIssue('time_logs', t), check('time_logs_md_positive', sql`${t.md} > 0`)],
);

export const testRuns = pgTable(
  'test_runs',
  {
    id: pk(),
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    kind: testKind().notNull().default('qa'),
    runNo: smallint().notNull(),
    result: testResult().notNull(),
    passedCount: smallint(),
    totalCount: smallint(),
    environment: environment(),
    commitSha: text(),
    /** Coverage % ของผล Unit test (ไม่บังคับ) */
    coveragePct: numeric({ precision: 5, scale: 2, mode: 'number' }),
    note: text(),
    testerId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('test_runs_workspace_id_key').on(t.workspaceId, t.id),
    inIssue('test_runs', t),
    // เลขรอบนับแยกตามประเภท: QA รอบ 1, 2 และ Unit test รอบ 1, 2
    uniqueIndex('test_runs_issue_kind_run_key').on(t.issueId, t.kind, t.runNo),
    check('test_runs_counts', sql`${t.passedCount} <= ${t.totalCount}`),
    check('test_runs_coverage_range', sql`${t.coveragePct} between 0 and 100`),
  ],
);

export const dueChangeRequests = pgTable(
  'due_change_requests',
  {
    id: pk(),
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    requesterId: uuid()
      .notNull()
      .references(() => users.id),
    currentDue: date(),
    requestedDue: date().notNull(),
    reasonCode: dueReason().notNull(),
    detail: text(),
    /** ผลกระทบที่ระบบคำนวณ ณ เวลาที่ส่ง */
    impact: jsonb(),
    status: requestStatus().notNull().default('pending'),
    decidedBy: uuid().references(() => users.id),
    decidedAt: tstz(),
    decidedVia: decidedVia(),
    /** เหตุผลของผู้อนุมัติ / ปฏิเสธ (แสดงใน Inbox ของผู้ขอ) */
    decisionNote: text(),
    createdAt: createdAt(),
  },
  (t) => [
    inIssue('due_change_requests', t),
    // คำขอที่รออยู่ได้ทีละ 1 ต่องาน
    uniqueIndex('due_change_requests_one_pending_key')
      .on(t.issueId)
      .where(sql`${t.status} = 'pending'`),
    // อนุมัติคำขอของตัวเองไม่ได้
    check('due_change_requests_not_self_decided', sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requesterId}`),
  ],
);

export const issueCustomValues = pgTable(
  'issue_custom_values',
  {
    workspaceId: workspaceId(),
    issueId: uuid().notNull(),
    fieldId: uuid().notNull(),
    value: jsonb().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.fieldId] }),
    inIssue('issue_custom_values', t),
    sameWs('issue_custom_values', 'field', t, t.fieldId, customFields).onDelete('cascade'),
  ],
);

export const milestoneIssues = pgTable(
  'milestone_issues',
  {
    workspaceId: workspaceId(),
    milestoneId: uuid().notNull(),
    issueId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.milestoneId, t.issueId] }),
    inIssue('milestone_issues', t),
    sameWs('milestone_issues', 'milestone', t, t.milestoneId, milestones).onDelete('cascade'),
  ],
);

