// H. ไฟล์
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, pk } from './_common.ts';
import { attachmentTarget, fileKind } from './enums.ts';
import { users } from './identity.ts';
import { inProject, workspaceId } from './project.ts';

export const folders = pgTable(
  'folders',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    parentId: uuid(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('folders_workspace_id_key').on(t.workspaceId, t.id),
    inProject('folders', t),
    foreignKey({
      name: 'folders_parent_fk',
      columns: [t.workspaceId, t.parentId],
      foreignColumns: [t.workspaceId, t.id],
    }).onDelete('cascade'),
  ],
);

export const files = pgTable(
  'files',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    folderId: uuid(),
    kind: fileKind().notNull().default('upload'),
    name: text().notNull(),
    mime: text(),
    /** ลิงก์ Figma / Google Drive / Notion เมื่อ kind = link */
    linkUrl: text(),
    linkProvider: text(),
    currentVersionId: uuid().references((): AnyPgColumn => fileVersions.id),
    uploadedBy: uuid()
      .notNull()
      .references(() => users.id),
    deletedAt: deletedAt(),
    /** ผู้ลบ (O30 · ถังขยะ A41) · trigger ตั้งจาก app.user_id · กู้คืนแล้วล้างเป็น null */
    deletedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('files_workspace_id_key').on(t.workspaceId, t.id),
    inProject('files', t),
    foreignKey({
      name: 'files_folder_fk',
      columns: [t.workspaceId, t.folderId],
      foreignColumns: [folders.workspaceId, folders.id],
    }),
    index('files_project_idx').on(t.projectId, t.folderId),
    index('files_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('files_trash_idx').on(t.workspaceId, t.deletedAt).where(sql`${t.deletedAt} IS NOT NULL`),
  ],
);

export const fileVersions = pgTable(
  'file_versions',
  {
    id: pk(),
    workspaceId: workspaceId(),
    fileId: uuid().notNull(),
    versionNo: integer().notNull(),
    storageKey: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    note: text(),
    uploadedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'file_versions_file_fk',
      columns: [t.workspaceId, t.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete('cascade'),
    uniqueIndex('file_versions_file_version_key').on(t.fileId, t.versionNo),
  ],
);

/** 1 ไฟล์ผูกได้หลายที่ (งาน, ผลทดสอบ, คอมเมนต์, โปรเจกต์, Requirement) */
export const fileAttachments = pgTable(
  'file_attachments',
  {
    id: pk(),
    workspaceId: workspaceId(),
    fileId: uuid().notNull(),
    targetType: attachmentTarget().notNull(),
    targetId: uuid().notNull(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'file_attachments_file_fk',
      columns: [t.workspaceId, t.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete('cascade'),
    uniqueIndex('file_attachments_key').on(t.fileId, t.targetType, t.targetId),
    index('file_attachments_target_idx').on(t.targetType, t.targetId),
  ],
);
