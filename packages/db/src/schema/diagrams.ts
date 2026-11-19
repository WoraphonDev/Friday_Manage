// แท็บ Diagram ของโปรเจกต์ (ผู้ใช้อนุมัติ storyboard 2026-11-19)
// Flowchart / ER / สถาปัตยกรรม / ไวท์บอร์ด เก็บกล่องและเส้นเป็น JSON ก้อนเดียว · แก้ได้ทีละคนด้วยล็อก ไม่มีประวัติเวอร์ชัน
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, tstz, updatedAt, pk } from './_common.ts';
import { users } from './identity.ts';
import { inProject, workspaceId } from './project.ts';

export const DIAGRAM_TEMPLATES = ['blank', 'flowchart', 'er', 'architecture', 'whiteboard'] as const;
export type DiagramTemplate = (typeof DIAGRAM_TEMPLATES)[number];

export const diagrams = pgTable(
  'diagrams',
  {
    id: pk(),
    workspaceId: workspaceId(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    description: text(),
    /** แบบเริ่มต้นตอนสร้าง · ใช้กรองในรายการ ไม่จำกัดรูปทรงที่ใช้ได้ */
    template: text().$type<DiagramTemplate>().notNull().default('blank'),
    /** `{ nodes, edges, viewport }` ของ React Flow ที่ API ตรวจรูปแบบแล้ว */
    content: jsonb().notNull().default(sql`'{"nodes":[],"edges":[]}'::jsonb`),
    /** งานที่กล่องผูกไว้ (สรุปจาก content ตอนบันทึก) · ใช้หา "อยู่ใน Diagram" จากหน้างานโดยไม่ต้องค้นใน JSON */
    issueIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** เพิ่มทุกครั้งที่บันทึก · บันทึกด้วย revision เก่า (เช่น ถูก Admin แก้ไขแทนแล้ว) → 409 */
    revision: integer().notNull().default(0),
    /** ผู้ถือสิทธิ์แก้ไข · หมดเมื่อเลย lockedUntil (ต่ออายุทุกครั้งที่บันทึกหรือส่ง heartbeat) */
    lockedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    lockedUntil: tstz(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
    /** ผู้ลบ · trigger soft_delete ตั้งจาก app.user_id เหมือนไฟล์และงาน */
    deletedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('diagrams_workspace_id_key').on(t.workspaceId, t.id),
    inProject('diagrams', t),
    check('diagrams_template', sql`${t.template} IN ('blank', 'flowchart', 'er', 'architecture', 'whiteboard')`),
    index('diagrams_project_idx').on(t.projectId, t.updatedAt),
    index('diagrams_issue_ids_idx').using('gin', t.issueIds),
    index('diagrams_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('diagrams_trash_idx').on(t.workspaceId, t.deletedAt).where(sql`${t.deletedAt} IS NOT NULL`),
  ],
);
