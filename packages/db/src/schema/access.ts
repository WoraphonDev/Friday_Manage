// A. LINE / Calendar ส่วนตัว · B. SSO และแม่แบบขององค์กร
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, boolean } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { inProject, workspaceId } from './project.ts';
import { ssoType } from './saas-enums.ts';

export const lineBindings = pgTable('line_bindings', {
  id: pk(),
  userId: uuid().notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  lineUserId: text().notNull().unique(),
  lineDisplayName: text(),
  boundAt: tstz().notNull().defaultNow(),
  unboundAt: tstz(),
  unboundBy: uuid().references(() => users.id),
  createdAt: createdAt(),
});

export const lineLinkCodes = pgTable('line_link_codes', {
  id: pk(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  // รหัสใช้ครั้งเดียวเก็บ hash เหมือน auth_tokens เพื่อไม่เปิดเผยรหัสจากฐานข้อมูล
  codeHash: text().notNull().unique(),
  expiresAt: tstz().notNull().default(sql`now() + interval '10 minutes'`),
  usedAt: tstz(),
  createdAt: createdAt(),
}, (t) => [index('line_link_codes_user_idx').on(t.userId)]);

export const calendarFeedTokens = pgTable('calendar_feed_tokens', {
  id: pk(),
  workspaceId: workspaceId(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid(),
  tokenHash: text().notNull().unique(),
  revokedAt: tstz(),
  createdAt: createdAt(),
}, (t) => [inProject('calendar_feed_tokens', t), index('calendar_feed_tokens_user_idx').on(t.workspaceId, t.userId)]);

export const ssoConnections = pgTable('sso_connections', {
  id: pk(),
  workspaceId: workspaceId(),
  type: ssoType().notNull(),
  configEncrypted: text().notNull(),
  configLast4: text(),
  enforced: boolean().notNull().default(false),
  enabledAt: tstz(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('sso_connections_workspace_type_key').on(t.workspaceId, t.type)]);

export const verifiedDomains = pgTable('verified_domains', {
  id: pk(),
  workspaceId: workspaceId(),
  domain: text().notNull(),
  dnsToken: text().notNull(),
  verifiedAt: tstz(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('verified_domains_domain_key').on(sql`lower(${t.domain})`)]);

export const projectTemplates = pgTable('project_templates', {
  id: pk(),
  workspaceId: workspaceId(),
  name: text().notNull(),
  description: text(),
  config: jsonb().notNull().default(sql`'{}'::jsonb`),
  usageCount: integer().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('project_templates_workspace_idx').on(t.workspaceId), check('project_templates_usage_count', sql`${t.usageCount} >= 0`)]);
