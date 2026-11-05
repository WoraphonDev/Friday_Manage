// L. คำขอข้อมูลส่วนบุคคลและ Export
import { index, pgTable, text, uuid, date } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { files } from './files.ts';
import { users } from './identity.ts';
import { workspaceId } from './project.ts';
import { tenantFk } from './saas-common.ts';
import { dataRequestType } from './saas-enums.ts';

export const dataSubjectRequests = pgTable('data_subject_requests', {
  id: pk(), workspaceId: workspaceId(), requesterEmail: text().notNull(), requestType: dataRequestType().notNull(),
  dueDate: date().notNull(), status: text().notNull().default('pending'), handledBy: uuid().references(() => users.id),
  completedAt: tstz(), resultFileId: uuid(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [tenantFk('data_subject_requests_file_fk', t.workspaceId, t.resultFileId, files), index('data_subject_requests_status_idx').on(t.workspaceId, t.status, t.dueDate)]);

export const workspaceExports = pgTable('workspace_exports', {
  id: pk(), workspaceId: workspaceId(), requestedBy: uuid().notNull().references(() => users.id),
  status: text().notNull().default('queued'), fileKey: text(), expiresAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('workspace_exports_workspace_idx').on(t.workspaceId, t.createdAt)]);
