import { type Db, schema } from '@friday/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { IN_APP_CHANNEL } from './rules.js';

const s = schema;

export interface ProjectCtx {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
  deleted: boolean;
}
export interface IssueCtx {
  id: string;
  key: string;
  title: string;
  parentId: string | null;
  reviewerId: string | null;
  baId: string | null;
  sharedWithGuests: boolean;
  isBug: boolean;
  deleted: boolean;
}

/**
 * อ่านผู้รับและกรองคนที่ยังเห็นข้อมูลได้
 * ใช้ friday_system เพราะงานกระจายแจ้งเตือนรันนอกคำขอของผู้ใช้ (ไม่มี app.user_id ให้ RLS) และต้องเขียน notifications ของผู้อื่น
 * จึงตรวจสิทธิ์อ่านเองตาม 04-permissions ข้อ 5 ก่อนส่งทุกครั้ง
 */
export class Audience {
  constructor(private readonly db: Db) {}

  async project(projectId: string): Promise<ProjectCtx | null> {
    const [p] = await this.db
      .select({
        id: s.projects.id,
        workspaceId: s.projects.workspaceId,
        key: s.projects.key,
        name: s.projects.name,
        ownerUserId: s.projects.ownerUserId,
        visibility: s.projects.visibility,
        deletedAt: s.projects.deletedAt,
      })
      .from(s.projects)
      .where(eq(s.projects.id, projectId));
    return p ? { ...p, deleted: !!p.deletedAt } : null;
  }

  async issue(issueId: string, projectKey: string): Promise<IssueCtx | null> {
    const [i] = await this.db
      .select({
        id: s.issues.id,
        number: s.issues.number,
        title: s.issues.title,
        parentId: s.issues.parentId,
        reviewerId: s.issues.reviewerId,
        baId: s.issues.baId,
        sharedWithGuests: s.issues.sharedWithGuests,
        deletedAt: s.issues.deletedAt,
        type: s.issueTypes.name,
      })
      .from(s.issues)
      .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
      .where(eq(s.issues.id, issueId));
    if (!i) return null;
    return {
      id: i.id,
      key: `${projectKey}-${i.number}`,
      title: i.title,
      parentId: i.parentId,
      reviewerId: i.reviewerId,
      baId: i.baId,
      sharedWithGuests: i.sharedWithGuests,
      isBug: i.type === 'Bug',
      deleted: !!i.deletedAt,
    };
  }

  async assignees(issueIds: string[]) {
    const out = new Map<string, string[]>();
    if (!issueIds.length) return out;
    const rows = await this.db
      .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
      .from(s.issueAssignees)
      .where(inArray(s.issueAssignees.issueId, issueIds));
    for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), r.userId]);
    return out;
  }

  async watchers(issueId: string) {
    const rows = await this.db.select({ userId: s.issueWatchers.userId }).from(s.issueWatchers).where(eq(s.issueWatchers.issueId, issueId));
    return rows.map((r) => r.userId);
  }

  async mentionedIn(commentId: string) {
    const rows = await this.db.select({ userId: s.commentMentions.userId }).from(s.commentMentions).where(eq(s.commentMentions.commentId, commentId));
    return rows.map((r) => r.userId);
  }

  /** สมาชิกโปรเจกต์ทั้งหมด (รวม Project Owner) */
  async projectMembers(project: ProjectCtx) {
    const rows = await this.db.select({ userId: s.projectMembers.userId }).from(s.projectMembers).where(eq(s.projectMembers.projectId, project.id));
    return [...new Set([project.ownerUserId, ...rows.map((r) => r.userId)])];
  }

  /**
   * ผู้รับแจ้งเตือนแบบ PM = Project Owner + Admin ของโปรเจกต์ + สมาชิกที่ตั้งให้ทำแทน PM (ผู้ใช้ตัดสิน 9 พ.ย. 2026)
   * คืนเหตุผลต่อคนให้ "ทำไมฉันได้รับแจ้ง" ตรงกับบทบาท · การตรวจว่ายังเห็นโปรเจกต์ได้อยู่ที่ visible()
   */
  async pmRecipients(project: ProjectCtx) {
    const rows = await this.db
      .select({ userId: s.projectMembers.userId, role: s.projectMembers.role, pmDeputy: s.projectMembers.pmDeputy })
      .from(s.projectMembers)
      .where(and(eq(s.projectMembers.projectId, project.id), sql`(${s.projectMembers.role} = 'admin' OR ${s.projectMembers.pmDeputy})`));
    const out = new Map<string, 'owner' | 'admin' | 'deputy'>([[project.ownerUserId, 'owner']]);
    for (const r of rows) if (!out.has(r.userId)) out.set(r.userId, r.role === 'admin' ? 'admin' : 'deputy');
    return out;
  }

  async names(ids: string[]) {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.db.select({ id: s.users.id, name: s.users.displayName }).from(s.users).where(inArray(s.users.id, ids));
    rows.forEach((r) => out.set(r.id, r.name));
    return out;
  }

  /**
   * คนที่ยังเปิดโปรเจกต์ / งานนี้ได้ (04-permissions ข้อ 5):
   * สมาชิก Workspace ที่ active · เป็น Project Owner, สมาชิกโปรเจกต์ หรือโปรเจกต์เปิดทั้ง Workspace (ไม่ใช่ Guest)
   * Guest ที่เป็น Viewer เห็นเฉพาะงานที่แชร์และไม่ใช่ Bug
   */
  async visible(userIds: string[], project: ProjectCtx, issue?: IssueCtx | null) {
    const ids = [...new Set(userIds)];
    if (!ids.length || project.deleted || issue?.deleted) return new Set<string>();
    const ws = await this.db
      .select({ userId: s.workspaceMembers.userId, role: s.workspaceMembers.role })
      .from(s.workspaceMembers)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.workspaceMembers.workspaceId))
      // บัญชีที่ถูกปิดทั้งระบบไม่รับแจ้งเตือน แม้สมาชิก Workspace ยัง active
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(
        and(
          eq(s.workspaceMembers.workspaceId, project.workspaceId),
          inArray(s.workspaceMembers.userId, ids),
          eq(s.workspaceMembers.status, 'active'),
          isNull(s.workspaces.deletedAt),
          isNull(s.users.disabledAt),
        ),
      );
    const pm = await this.db
      .select({ userId: s.projectMembers.userId, role: s.projectMembers.role })
      .from(s.projectMembers)
      .where(and(eq(s.projectMembers.projectId, project.id), inArray(s.projectMembers.userId, ids)));
    const projectRole = new Map(pm.map((r) => [r.userId, r.role]));
    const out = new Set<string>();
    for (const { userId, role } of ws) {
      const isOwner = userId === project.ownerUserId;
      const member = projectRole.get(userId);
      const canOpen = isOwner || !!member || (project.visibility === 'workspace' && role !== 'guest');
      if (!canOpen) continue;
      const guestViewer = role === 'guest' && !isOwner && (member ?? 'viewer') === 'viewer';
      if (guestViewer && issue && (!issue.sharedWithGuests || issue.isBug)) continue;
      out.add(userId);
    }
    return out;
  }

  /**
   * ผู้ที่ปิด In-app ของเหตุการณ์นี้ไว้ใน Profile
   * อ่านเป็นข้อความ (channel::text) เพราะ enum notification_channel ยังไม่มีค่า in_app (คำขอนอก lane ถึงงาน DB)
   */
  async inAppDisabled(workspaceId: string, userIds: string[], eventType: string) {
    if (!userIds.length) return new Set<string>();
    const p = s.userNotificationPrefs;
    const rows = await this.db
      .select({ userId: p.userId })
      .from(p)
      .where(
        and(
          eq(p.workspaceId, workspaceId),
          inArray(p.userId, userIds),
          eq(p.eventType, eventType),
          eq(p.enabled, false),
          sql`${p.channel}::text = ${IN_APP_CHANNEL}`,
        ),
      );
    return new Set(rows.map((r) => r.userId));
  }

  /** ผู้ที่เปิด In-app ของเหตุการณ์นี้ไว้เอง (ใช้กับเหตุการณ์ที่ค่าเริ่มต้นปิด เช่น Daily digest) */
  async inAppEnabled(eventType: string) {
    const p = s.userNotificationPrefs;
    return this.db
      .select({ workspaceId: p.workspaceId, userId: p.userId })
      .from(p)
      .where(and(eq(p.eventType, eventType), eq(p.enabled, true), sql`${p.channel}::text = ${IN_APP_CHANNEL}`));
  }
}
