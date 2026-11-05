// K. Automation, มุมมอง และการค้นหา
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { inProject, workspaceId } from './project.ts';
import { tenantFk, tenantKey } from './saas-common.ts';
import { automationResult, automationTrigger } from './saas-enums.ts';

export const automationRules = pgTable('automation_rules', {
  id: pk(), workspaceId: workspaceId(), projectId: uuid().notNull(), name: text().notNull(),
  trigger: automationTrigger().notNull(), triggerConfig: jsonb().notNull().default(sql`'{}'::jsonb`),
  conditions: jsonb().notNull().default(sql`'[]'::jsonb`), actions: jsonb().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean().notNull().default(true), createdBy: uuid().notNull().references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantKey('automation_rules', t), inProject('automation_rules', t), index('automation_rules_trigger_idx').on(t.projectId, t.trigger, t.enabled)]);

export const automationRuns = pgTable('automation_runs', {
  id: pk(), workspaceId: workspaceId(), ruleId: uuid().notNull(),
  // Snapshot ของงานยังเก็บได้แม้งานนั้นถูกลบไปแล้ว
  issueIds: uuid().array().notNull().default(sql`'{}'`), result: automationResult().notNull(),
  detail: jsonb().notNull().default(sql`'{}'::jsonb`), depth: integer().notNull().default(0),
  ranAt: tstz().notNull().defaultNow(), createdAt: createdAt(),
}, (t) => [tenantFk('automation_runs_rule_fk', t.workspaceId, t.ruleId, automationRules).onDelete('cascade'),
  index('automation_runs_rule_idx').on(t.ruleId, t.ranAt), check('automation_runs_depth', sql`${t.depth} BETWEEN 0 AND 3`)]);

export const savedViews = pgTable('saved_views', {
  id: pk(), workspaceId: workspaceId(), projectId: uuid().notNull(),
  ownerId: uuid().references(() => users.id, { onDelete: 'cascade' }), name: text().notNull(), viewType: text().notNull().default('table'),
  filters: jsonb().notNull().default(sql`'{}'::jsonb`), groupBy: text(),
  sort: jsonb().notNull().default(sql`'[]'::jsonb`), columns: jsonb().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [inProject('saved_views', t), index('saved_views_project_owner_idx').on(t.projectId, t.ownerId)]);

export const savedSearches = pgTable('saved_searches', {
  id: pk(), workspaceId: workspaceId(), userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(), query: text().notNull(), filters: jsonb().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('saved_searches_user_idx').on(t.workspaceId, t.userId)]);

export const apiTokens = pgTable('api_tokens', {
  id: pk(), workspaceId: workspaceId(), name: text().notNull(), tokenHash: text().notNull().unique(),
  scopes: text().array().notNull().default(sql`'{}'`), createdBy: uuid().notNull().references(() => users.id),
  lastUsedAt: tstz(), revokedAt: tstz(), createdAt: createdAt(),
}, (t) => [index('api_tokens_workspace_idx').on(t.workspaceId)]);
