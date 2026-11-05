// L. Audit log · append-only (แอปได้แค่ INSERT / SELECT) · แบ่ง partition รายเดือนเมื่อข้อมูลโต
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk } from './_common.ts';
import { actorKind, auditCategory } from './enums.ts';
import { workspaceId } from './project.ts';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    workspaceId: workspaceId(),
    /** ไม่ใส่ FK เพื่อให้ประวัติอยู่ครบแม้ลบผู้ใช้ (PDPA ลบด้วยการทำให้เป็นนิรนามแทน) */
    actorId: uuid(),
    actorKind: actorKind().notNull(),
    category: auditCategory().notNull(),
    action: text().notNull(),
    targetType: text(),
    targetId: uuid(),
    summary: text(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_workspace_idx').on(t.workspaceId, t.createdAt)],
);
