import { type AnyPgColumn, foreignKey, unique } from 'drizzle-orm/pg-core';

/** FK ตรวจข้าม RLS จึงต้องผูก tenant ของต้นทางและปลายทางเสมอ */
export const tenantFk = (name: string, workspace: AnyPgColumn, ref: AnyPgColumn, target: { workspaceId: AnyPgColumn; id: AnyPgColumn }) =>
  foreignKey({ name, columns: [workspace, ref], foreignColumns: [target.workspaceId, target.id] });

export const tenantKey = (name: string, t: { workspaceId: AnyPgColumn; id: AnyPgColumn }) =>
  unique(`${name}_workspace_id_key`).on(t.workspaceId, t.id);
