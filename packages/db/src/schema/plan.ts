// G. แผนและการแก้ไขแผน
import { sql } from 'drizzle-orm';
import { date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, manDay, pk, tstz } from './_common.ts';
import { baselineSource, importMode, importStatus, planChangeSource } from './enums.ts';
import { users } from './identity.ts';
import { issues } from './issue.ts';
import { inProject, workspaceId } from './project.ts';

export const planBaselines = pgTable(
  'plan_baselines',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    version: integer().notNull(),
    name: text(),
    source: baselineSource().notNull(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('plan_baselines_workspace_id_key').on(t.workspaceId, t.id),
    inProject('plan_baselines', t),
    uniqueIndex('plan_baselines_project_version_key').on(t.projectId, t.version),
  ],
);

export const baselineItems = pgTable(
  'baseline_items',
  {
    workspaceId: workspaceId(),
    baselineId: uuid().notNull(),
    issueId: uuid().notNull(),
    planStart: date(),
    planEnd: date(),
    estimateMd: manDay(),
    assigneeIds: uuid().array().notNull().default(sql`'{}'`),
  },
  (t) => [
    primaryKey({ columns: [t.baselineId, t.issueId] }),
    foreignKey({
      name: 'baseline_items_baseline_fk',
      columns: [t.workspaceId, t.baselineId],
      foreignColumns: [planBaselines.workspaceId, planBaselines.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'baseline_items_issue_fk',
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
  ],
);

/** แท็บ "การแก้ไขแผน" · การแก้หลังมี Baseline ต้องมีเหตุผล (ตรวจที่ API) */
export const planChanges = pgTable(
  'plan_changes',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    issueId: uuid().notNull(),
    baselineId: uuid(),
    field: text().notNull(),
    oldValue: jsonb(),
    newValue: jsonb(),
    reason: text(),
    impact: text(),
    source: planChangeSource().notNull().default('manual'),
    changedBy: uuid().references(() => users.id),
    changedAt: createdAt(),
  },
  (t) => [
    inProject('plan_changes', t),
    foreignKey({
      name: 'plan_changes_issue_fk',
      columns: [t.workspaceId, t.issueId],
      foreignColumns: [issues.workspaceId, issues.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'plan_changes_baseline_fk',
      columns: [t.workspaceId, t.baselineId],
      foreignColumns: [planBaselines.workspaceId, planBaselines.id],
    }),
    index('plan_changes_project_idx').on(t.projectId, t.changedAt),
  ],
);

/** งานนำเข้า Excel · project_id = null เมื่อนำเข้าเป็นโปรเจกต์ใหม่ */
export const importJobs = pgTable(
  'import_jobs',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid(),
    mode: importMode().notNull(),
    fileName: text().notNull(),
    storageKey: text().notNull(),
    columnMapping: jsonb(),
    personMapping: jsonb(),
    /** ผลตรวจรายแถว (แถวที่ต้องแก้) */
    validation: jsonb(),
    status: importStatus().notNull().default('uploaded'),
    rowTotal: integer(),
    rowImported: integer(),
    rowSkipped: integer(),
    error: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    completedAt: tstz(),
  },
  (t) => [inProject('import_jobs', t)],
);
