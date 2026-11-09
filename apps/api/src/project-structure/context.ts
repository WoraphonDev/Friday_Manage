import { schema as s, type Tx } from '@friday/db';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import type { DomainEvent, EventType } from '../core/events.js';
import { requirePerm } from '../projects/permissions.js';
import type { ProjectRow, ProjectsService } from '../projects/projects.service.js';

/**
 * ระดับการเข้าถึงของหน้า L2
 * - view: ข้อมูลที่หน้าอื่นใช้ด้วย (Milestone บน Overview / Timeline) · ทุกคนที่มี project.view รวม Guest
 * - read: แท็บของ Settings · project.view แต่ Guest ไม่เห็น Settings (04-permissions ข้อ 4)
 * - write: project.settings และโปรเจกต์ต้องไม่ถูกเก็บถาวร
 * - group: สร้างกลุ่มใหม่ตอนสร้าง Task ได้ด้วย issue.create (ผู้ใช้ขอ 2026-11-08) หรือ project.settings
 */
export type Mode = 'view' | 'read' | 'write' | 'group';

export async function loadContext(tx: Tx, projects: ProjectsService, auth: AuthInfo, tenant: TenantInfo, key: string, mode: Mode) {
  const { project, access } = await projects.load(tx, auth, tenant, key);
  requirePerm(access, 'project.view');
  if (mode !== 'view' && tenant.role === 'guest') {
    throw new AppError(403, 'guest_settings_hidden', 'Guest ไม่เห็น Project Settings', { permission: 'project.settings' });
  }
  if (mode === 'write' || mode === 'group') {
    requirePerm(access, mode === 'group' && !access.perms.has('project.settings') ? 'issue.create' : 'project.settings');
    if (project.archivedAt || project.status === 'archived') throw new AppError(403, 'project_archived', 'โปรเจกต์ที่เก็บถาวรแก้ไขไม่ได้');
  }
  return { project, access };
}
export type Context = Awaited<ReturnType<typeof loadContext>>;

/** บันทึกการแก้ตั้งค่าโปรเจกต์ใน Audit log ของ Workspace */
export async function audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRow, action: string, summary: string, category: 'data' | 'plan' = 'data') {
  await tx.insert(s.auditLogs).values({
    workspaceId: tenant.workspaceId,
    actorId: auth.userId,
    actorKind: 'user',
    category,
    action,
    targetType: 'project',
    targetId: project.id,
    summary: `${project.key} · ${summary}`,
  });
}

/** เหตุการณ์ของงานแบบเดียวกับ IssuesService · data มี issueKey และ title เสมอ */
export function issueEvent(tenant: TenantInfo, project: ProjectRow, actorId: string | null, issue: { id: string; number: number; title: string }) {
  return (type: EventType, data: Record<string, unknown>): DomainEvent => ({
    type,
    workspaceId: tenant.workspaceId,
    projectId: project.id,
    issueId: issue.id,
    actorId,
    data: { issueKey: `${project.key}-${issue.number}`, title: issue.title, ...data },
    at: new Date(),
  });
}

/** ตรวจว่ารายการที่ส่งมาเรียงครบทุกตัว ไม่ขาดไม่ซ้ำ */
export function assertFullOrder(current: { id: string }[], ids: string[]) {
  const set = new Set(ids);
  if (set.size !== ids.length || set.size !== current.length || current.some((c) => !set.has(c.id))) {
    throw new AppError(400, 'invalid_reorder', 'ต้องส่งรายการทั้งหมดให้ครบ โดยไม่ซ้ำกัน');
  }
}

export const nextSort = (rows: { sort: number }[]) => rows.reduce((max, r) => Math.max(max, r.sort), -1) + 1;

export const Id = z.uuid();
export const ReorderBody = z.object({ ids: z.array(z.uuid()).max(1000) }).strict();
export const color = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'ใช้รูปแบบสี #RRGGBB');
export const name = z.string().trim().min(1).max(120);
export const nonEmpty = { message: 'ระบุฟิลด์ที่ต้องการแก้ไข' };
