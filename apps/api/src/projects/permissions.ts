import { schema, type Tx } from '@friday/db';
import { and, eq } from 'drizzle-orm';
import { forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import type { ProjectRole } from '../common/types.js';

const { projectMembers, projectRolePermissions } = schema;

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
}

export interface ProjectAccess {
  role: ProjectRole | null;
  isOwner: boolean;
  /** Guest ที่เป็น Viewer: เห็นแค่ Overview, Timeline และงานที่แชร์ · ไม่เห็นชื่อคน */
  guestViewer: boolean;
  perms: Set<string>;
}

export async function projectAccess(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRef): Promise<ProjectAccess> {
  const isOwner = project.ownerUserId === auth.userId;
  const [m] = await tx
    .select({ role: projectMembers.role })
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

  // ข้อ 4: เพดานของ Guest ที่ปรับในหน้า L2 ไม่ได้
  const guestViewer = isGuest && role === 'viewer';
  if (isGuest) {
    perms.delete('project.invite');
    if (guestViewer) ['project.workload.view', 'project.reports.view'].forEach((p) => perms.delete(p));
  }
  return { role, isOwner, guestViewer, perms };
}

export function requirePerm(access: ProjectAccess, permission: string) {
  if (!access.perms.has(permission)) throw forbidden(permission);
}
