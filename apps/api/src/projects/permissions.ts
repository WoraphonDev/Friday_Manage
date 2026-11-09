import { schema, type Tx } from '@friday/db';
import { and, eq } from 'drizzle-orm';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import type { ProjectRole } from '../common/types.js';

const { projectMembers, projectRolePermissions, projects, workspaceMembers } = schema;

/** 10 แถวในหน้า L2 › สิทธิ์ของแต่ละ Role (docs/spec/04-permissions.md ข้อ 3.1) · ค่า = Member, Viewer */
export const L2_PERMISSIONS = {
  'project.view': [true, true],
  'issue.comment': [true, true],
  'issue.create': [true, false],
  'issue.edit': [true, false],
  'issue.delete': [false, false],
  'issue.change_due_directly': [false, false],
  'due_request.approve': [false, false],
  'file.upload': [true, false],
  'file.delete': [true, false],
  'sprint.manage': [false, false],
  'project.invite': [false, false],
  'project.settings': [false, false],
} as const satisfies Record<string, readonly [boolean, boolean]>;

/** ในหน้า L2 บางแถวคุม 2 สิทธิ์พร้อมกัน */
export const L2_GROUPS: Record<string, (keyof typeof L2_PERMISSIONS)[]> = {
  'issue.create': ['issue.create', 'issue.edit'],
  'file.upload': ['file.upload', 'file.delete'],
};

/** ข้อ 3.2: ตายตัวตาม Role */
const FIXED: Record<ProjectRole, string[]> = {
  admin: ['project.workload.view', 'project.reports.view', 'issue.record_test', 'issue.time_log', 'project.baseline', 'project.automation', 'project.views.share', 'project.trash', 'project.archive'],
  member: ['project.workload.view', 'project.reports.view', 'issue.record_test', 'issue.time_log'],
  viewer: ['project.workload.view', 'project.reports.view'],
};

export interface ProjectRef {
  id: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
  /** ไม่ส่งมา = อ่านจากฐานข้อมูลเอง (ผู้เรียกส่วนใหญ่ส่งแถวโปรเจกต์ทั้งแถวอยู่แล้ว) */
  archivedAt?: Date | null;
}

/** สิทธิ์ที่ยังเหลือเมื่อโปรเจกต์ถูก Archive (04-permissions ข้อ 5 › 8) · project.archive ไว้กด Restore */
const ARCHIVED_KEEP = new Set(['project.view', 'project.workload.view', 'project.reports.view', 'project.archive']);

export interface ProjectAccess {
  role: ProjectRole | null;
  isOwner: boolean;
  /** Guest ที่เป็น Viewer: เห็นแค่ Overview, Timeline และงานที่แชร์ · ไม่เห็นชื่อคน */
  guestViewer: boolean;
  perms: Set<string>;
  /** โปรเจกต์ถูก Archive = อ่านอย่างเดียว */
  archived?: boolean;
}

export async function projectAccess(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRef): Promise<ProjectAccess> {
  const isOwner = project.ownerUserId === auth.userId;
  const [m] = await tx
    .select({ role: projectMembers.role, pmDeputy: projectMembers.pmDeputy })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, auth.userId)));

  let role: ProjectRole | null = isOwner ? 'admin' : (m?.role ?? null);
  if (!role && project.visibility === 'workspace' && tenant.role !== 'guest') role = 'viewer';

  const perms = new Set<string>();
  const isGuest = tenant.role === 'guest';
  if (role === 'admin') {
    Object.keys(L2_PERMISSIONS).forEach((p) => perms.add(p));
  } else if (role) {
    const overrides = await tx
      .select({ permission: projectRolePermissions.permission, allowed: projectRolePermissions.allowed })
      .from(projectRolePermissions)
      .where(and(eq(projectRolePermissions.projectId, project.id), eq(projectRolePermissions.role, role)));
    const ov = new Map(overrides.map((o) => [o.permission, o.allowed]));
    const idx = role === 'member' ? 0 : 1;
    for (const [p, defaults] of Object.entries(L2_PERMISSIONS)) {
      if (ov.get(p) ?? defaults[idx]) perms.add(p);
    }
  }
  if (role) FIXED[role].forEach((p) => perms.add(p));
  // ผู้ทำแทน PM อนุมัติคำขอเลื่อน Due ได้แม้ Role ไม่มีสิทธิ์นี้ · Guest เป็นผู้ทำแทนไม่ได้ (ตรวจตอนตั้งค่า)
  if (m?.pmDeputy && !isGuest) perms.add('due_request.approve');

  // ข้อ 4: เพดานของ Guest ที่ปรับในหน้า L2 ไม่ได้
  const guestViewer = isGuest && role === 'viewer';
  if (isGuest) {
    perms.delete('project.invite');
    if (guestViewer) ['project.workload.view', 'project.reports.view'].forEach((p) => perms.delete(p));
  }

  // ข้อ 8: Archive แล้วเหลือสิทธิ์อ่านอย่างเดียว · ตัดที่นี่ที่เดียว ทุก endpoint ที่ใช้ requirePerm จึงได้กติกานี้
  let archivedAt = project.archivedAt;
  if (archivedAt === undefined) {
    const [row] = await tx.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, project.id));
    archivedAt = row?.archivedAt ?? null;
  }
  const archived = !!archivedAt;
  if (archived) [...perms].forEach((p) => !ARCHIVED_KEEP.has(p) && perms.delete(p));
  return { role, isOwner, guestViewer, perms, archived };
}

/**
 * ทุกคนในโปรเจกต์ที่มีสิทธิ์ใน L2 แถวนี้ (เช่น ผู้อนุมัติคำขอเลื่อน Due)
 * = Project Owner + Admin + Role ที่ PM เปิดสิทธิ์นี้ให้ (+ ผู้ทำแทน PM สำหรับคำขอเลื่อน Due) · เฉพาะสมาชิก Workspace ที่ active
 */
export async function usersWithPerm(tx: Tx, project: ProjectRef, permission: keyof typeof L2_PERMISSIONS) {
  const overrides = await tx
    .select({ role: projectRolePermissions.role, allowed: projectRolePermissions.allowed })
    .from(projectRolePermissions)
    .where(and(eq(projectRolePermissions.projectId, project.id), eq(projectRolePermissions.permission, permission)));
  const ov = new Map(overrides.map((o) => [o.role, o.allowed]));
  const [memberDefault, viewerDefault] = L2_PERMISSIONS[permission];
  const roles = new Set<ProjectRole>(['admin']);
  if (ov.get('member') ?? memberDefault) roles.add('member');
  if (ov.get('viewer') ?? viewerDefault) roles.add('viewer');

  const rows = await tx
    .select({ userId: projectMembers.userId, role: projectMembers.role, pmDeputy: projectMembers.pmDeputy })
    .from(projectMembers)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspaceId, projectMembers.workspaceId), eq(workspaceMembers.userId, projectMembers.userId), eq(workspaceMembers.status, 'active')),
    )
    .where(eq(projectMembers.projectId, project.id));
  const deputyPerms = new Set<string>(['due_request.approve']);
  const ids = new Set(rows.filter((r) => roles.has(r.role) || (r.pmDeputy && deputyPerms.has(permission))).map((r) => r.userId));
  ids.add(project.ownerUserId);
  return [...ids];
}

export function requirePerm(access: ProjectAccess, permission: string) {
  if (access.perms.has(permission)) return;
  // บอกเหตุผลให้หน้าจอแสดงแถบ "โปรเจกต์นี้ถูก Archive" แทน 403 ทั่วไป
  if (access.archived && access.role) {
    throw new AppError(403, 'project_archived', 'โปรเจกต์นี้ถูก Archive แล้ว ดูได้อย่างเดียว · Restore ก่อนจึงจะแก้ไขได้', { permission });
  }
  throw forbidden(permission);
}
