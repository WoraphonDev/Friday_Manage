import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { loadPeople, type Person } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { IssuesService } from '../issues/issues.service.js';
import { type ProjectAccess, requirePerm } from '../projects/permissions.js';

export const CommentBody = z.object({ body: z.string().trim().min(1).max(20000) });
export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(500).optional() });
type Page = z.infer<typeof PageQuery>;
type Comment = typeof s.comments.$inferSelect;
type Loaded = Awaited<ReturnType<IssuesService['loadIssue']>>;
type Cursor = { id: string; time: string; issueId: string; feed: 'comments' | 'activity' };
const CursorBody = z.object({ id: z.uuid(), time: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?[+-]\d\d(?::\d\d)?$/), issueId: z.uuid(), feed: z.enum(['comments', 'activity']) });
const hiddenPerson = { displayName: 'ทีมพัฒนา', initials: '', avatarUrl: null };
const personFields = new Set(['assigneeIds', 'baId', 'reviewerId', 'testerId', 'createdBy', 'deletedBy', 'ownerUserId']);

@Injectable()
export class CommentsService {
  constructor(private readonly db: TenantDb, private readonly issues: IssuesService, private readonly events: EventBus) {}

  async list(auth: AuthInfo, tenant: TenantInfo, key: string, query: Page) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue, access } = await this.load(tx, auth, tenant, key);
      const cursor = this.cursor(query, issue.id, 'comments');
      const rows = await tx.select({ comment: s.comments, time: sql<string>`${s.comments.createdAt}::text` }).from(s.comments)
        .where(and(eq(s.comments.issueId, issue.id), cursor ? sql`(${s.comments.createdAt}, ${s.comments.id}) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)` : undefined))
        .orderBy(asc(s.comments.createdAt), asc(s.comments.id)).limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return { items: await this.commentDtos(tx, page.map((r) => r.comment), auth, access), nextCursor: rows.length > query.limit ? this.encode({ id: page.at(-1)!.comment.id, time: page.at(-1)!.time, issueId: issue.id, feed: 'comments' }) : null };
    });
  }

  async create(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CommentBody>) {
    const result = await this.db.run(auth, tenant, async (tx) => {
      const loaded = await this.load(tx, auth, tenant, key);
      requirePerm(loaded.access, 'issue.comment');
      const mentioned = await this.mentions(tx, loaded.project, input.body);
      const [comment] = await tx.insert(s.comments).values({ workspaceId: tenant.workspaceId, issueId: loaded.issue.id, authorId: auth.userId, body: input.body }).returning();
      await this.setMentions(tx, tenant, comment.id, mentioned);
      await this.autoWatch(tx, tenant, loaded.issue.id, auth.userId, mentioned);
      return { dto: (await this.commentDtos(tx, [comment], auth, loaded.access))[0], events: this.commentEvents(auth, tenant, loaded, comment, mentioned, true) };
    });
    await this.events.publish(result.events);
    return result.dto;
  }

  async edit(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof CommentBody>) {
    const result = await this.db.run(auth, tenant, async (tx) => {
      const loaded = await this.load(tx, auth, tenant, key);
      requirePerm(loaded.access, 'issue.comment');
      const comment = await this.findComment(tx, loaded.issue.id, id);
      if (comment.authorId !== auth.userId) throw forbidden('comment.owner');
      if (comment.deletedAt) throw new AppError(410, 'gone', 'คอมเมนต์นี้ถูกลบแล้ว');
      const mentioned = await this.mentions(tx, loaded.project, input.body);
      const old = await tx.select().from(s.commentMentions).where(eq(s.commentMentions.commentId, id));
      const [updated] = await tx.update(s.comments).set({ body: input.body, editedAt: new Date() }).where(eq(s.comments.id, id)).returning();
      await tx.delete(s.commentMentions).where(eq(s.commentMentions.commentId, id));
      await this.setMentions(tx, tenant, id, mentioned);
      await this.autoWatch(tx, tenant, loaded.issue.id, auth.userId, mentioned);
      const added = mentioned.filter((userId) => !old.some((m) => m.userId === userId));
      return { dto: (await this.commentDtos(tx, [updated], auth, loaded.access))[0], events: this.commentEvents(auth, tenant, loaded, updated, added, false) };
    });
    await this.events.publish(result.events);
    return result.dto;
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const loaded = await this.load(tx, auth, tenant, key);
      requirePerm(loaded.access, 'issue.comment');
      const comment = await this.findComment(tx, loaded.issue.id, id);
      if (comment.authorId !== auth.userId && loaded.access.role !== 'admin') throw forbidden('comment.owner');
      if (!comment.deletedAt) {
        const [updated] = await tx.update(s.comments).set({ body: '', deletedAt: new Date(), deletedBy: auth.userId }).where(eq(s.comments.id, id)).returning();
        await tx.delete(s.commentMentions).where(eq(s.commentMentions.commentId, id));
        return (await this.commentDtos(tx, [updated], auth, loaded.access))[0];
      }
      return (await this.commentDtos(tx, [comment], auth, loaded.access))[0];
    });
  }

  async activity(auth: AuthInfo, tenant: TenantInfo, key: string, query: Page) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue, access } = await this.load(tx, auth, tenant, key);
      const cursor = this.cursor(query, issue.id, 'activity');
      // ใช้เวลาเต็มจาก PostgreSQL เพื่อไม่ตกหล่นเมื่อหลายรายการเกิดในมิลลิวินาทีเดียวกัน
      const feed = await tx.execute<{ id: string; kind: 'comment' | 'activity'; time: string }>(sql`
        select id, kind, created_at::text as time from (
          select id, 'comment' as kind, created_at from ${s.comments} where issue_id = ${issue.id}
          union all
          select id, 'activity' as kind, created_at from ${s.activities} where issue_id = ${issue.id}
        ) feed
        ${cursor ? sql`where (created_at, id) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by created_at asc, id asc limit ${query.limit + 1}
      `);
      const page = feed.rows.slice(0, query.limit);
      const commentIds = page.filter((r) => r.kind === 'comment').map((r) => r.id);
      const activityIds = page.filter((r) => r.kind === 'activity').map((r) => r.id);
      const comments = commentIds.length ? await tx.select().from(s.comments).where(inArray(s.comments.id, commentIds)) : [];
      const acts = activityIds.length ? await tx.select().from(s.activities).where(inArray(s.activities.id, activityIds)) : [];
      const dtos = new Map((await this.commentDtos(tx, comments, auth, access)).map((c) => [c.id, c]));
      const people = await loadPeople(tx, acts.map((a) => a.actorId));
      const activityDtos = new Map(acts.map((a) => [a.id, {
        id: a.id, kind: 'activity' as const, actor: this.person(a.actorId, people, auth, access), actorKind: a.actorKind,
        verb: a.verb, field: a.field, old: access.guestViewer && a.field && personFields.has(a.field) ? null : a.oldValue,
        new: access.guestViewer && a.field && personFields.has(a.field) ? null : a.newValue, createdAt: a.createdAt,
      }]));
      return { items: page.map((r) => r.kind === 'comment' ? { kind: 'comment', ...dtos.get(r.id)! } : activityDtos.get(r.id)!), nextCursor: feed.rows.length > query.limit ? this.encode({ id: page.at(-1)!.id, time: page.at(-1)!.time, issueId: issue.id, feed: 'activity' }) : null };
    });
  }

  async watch(auth: AuthInfo, tenant: TenantInfo, key: string, watching: boolean) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue } = await this.load(tx, auth, tenant, key);
      if (watching) await tx.insert(s.issueWatchers).values({ workspaceId: tenant.workspaceId, issueId: issue.id, userId: auth.userId, source: 'manual' })
        .onConflictDoUpdate({ target: [s.issueWatchers.issueId, s.issueWatchers.userId], set: { source: 'manual' } });
      else await tx.delete(s.issueWatchers).where(and(eq(s.issueWatchers.issueId, issue.id), eq(s.issueWatchers.userId, auth.userId)));
      return { watching };
    });
  }

  async watchers(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue, access } = await this.load(tx, auth, tenant, key);
      const rows = await tx.select().from(s.issueWatchers)
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.issueWatchers.workspaceId), eq(s.workspaceMembers.userId, s.issueWatchers.userId), eq(s.workspaceMembers.status, 'active')))
        .where(eq(s.issueWatchers.issueId, issue.id)).orderBy(asc(s.issueWatchers.userId));
      const people = await loadPeople(tx, rows.map((r) => r.issue_watchers.userId));
      return { items: rows.map(({ issue_watchers: r }) => ({ person: this.person(r.userId, people, auth, access), ...(access.guestViewer ? {} : { source: r.source }) })), watching: rows.some((r) => r.issue_watchers.userId === auth.userId) };
    });
  }

  private async load(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string) {
    const loaded = await this.issues.loadIssue(tx, auth, tenant, key);
    requirePerm(loaded.access, 'project.view');
    if (loaded.access.guestViewer) {
      const [type] = await tx.select({ name: s.issueTypes.name }).from(s.issueTypes).where(eq(s.issueTypes.id, loaded.issue.issueTypeId));
      if (type?.name === 'Bug') throw notFound('งาน');
    }
    return loaded;
  }

  private async findComment(tx: Tx, issueId: string, id: string) {
    const [comment] = await tx.select().from(s.comments).where(and(eq(s.comments.issueId, issueId), eq(s.comments.id, id))).for('update');
    if (!comment) throw notFound('คอมเมนต์');
    return comment;
  }

  private async mentions(tx: Tx, project: Loaded['project'], body: string) {
    if (!body.includes('@')) return [];
    const members = await tx.select({ id: s.users.id, name: s.users.displayName }).from(s.users)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.userId, s.users.id), eq(s.workspaceMembers.status, 'active')))
      .leftJoin(s.projectMembers, and(eq(s.projectMembers.projectId, project.id), eq(s.projectMembers.userId, s.users.id)))
      .where(and(isNull(s.users.disabledAt), or(eq(s.projectMembers.projectId, project.id), eq(s.users.id, project.ownerUserId))));
    return resolveMentions(body, members);
  }

  private async setMentions(tx: Tx, tenant: TenantInfo, commentId: string, ids: string[]) {
    if (ids.length) await tx.insert(s.commentMentions).values(ids.map((userId) => ({ workspaceId: tenant.workspaceId, commentId, userId })));
  }

  private async autoWatch(tx: Tx, tenant: TenantInfo, issueId: string, authorId: string, mentioned: string[]) {
    // ล็อกตามลำดับเดียวกัน ป้องกัน deadlock เมื่อสองคนคอมเมนต์ mention หากันพร้อมกัน
    for (const userId of [...new Set([authorId, ...mentioned])].sort()) {
      await tx.insert(s.issueWatchers).values({ workspaceId: tenant.workspaceId, issueId, userId, source: userId === authorId ? 'auto_comment' : 'auto_mention' }).onConflictDoNothing();
    }
  }

  private commentEvents(auth: AuthInfo, tenant: TenantInfo, loaded: Loaded, comment: Comment, ids: string[], created: boolean): DomainEvent[] {
    const base = { workspaceId: tenant.workspaceId, projectId: loaded.project.id, issueId: loaded.issue.id, actorId: auth.userId, at: comment.editedAt ?? comment.createdAt };
    const data = { issueKey: `${loaded.project.key}-${loaded.issue.number}`, title: loaded.issue.title, commentId: comment.id };
    return [...(created ? [{ ...base, type: 'issue.commented' as const, data: { ...data, excerpt: [...comment.body].slice(0, 140).join('') } }] : []), ...(ids.length ? [{ ...base, type: 'issue.mentioned' as const, data: { ...data, userIds: ids } }] : [])];
  }

  private person(id: string | null, people: Map<string, Person>, auth: AuthInfo, access: ProjectAccess) {
    if (!id) return null;
    if (access.guestViewer && id !== auth.userId) return hiddenPerson;
    return people.get(id) ?? null;
  }

  private async commentDtos(tx: Tx, rows: Comment[], auth: AuthInfo, access: ProjectAccess) {
    const mentions = rows.length ? await tx.select().from(s.commentMentions).where(inArray(s.commentMentions.commentId, rows.map((c) => c.id))) : [];
    const people = await loadPeople(tx, [...rows.flatMap((r) => [r.authorId, r.deletedBy]), ...mentions.map((m) => m.userId)]);
    // ไฟล์ที่แนบกับคอมเมนต์ (ผู้ใช้เพิ่ม 2026-11-08) · Guest Viewer เข้า Files ไม่ได้จึงไม่ส่งรายการไฟล์
    const files = rows.length && !access.guestViewer
      ? await tx.select({ commentId: s.fileAttachments.targetId, id: s.files.id, name: s.files.name, mime: s.files.mime }).from(s.fileAttachments)
        .innerJoin(s.files, eq(s.files.id, s.fileAttachments.fileId))
        .where(and(eq(s.fileAttachments.targetType, 'comment'), inArray(s.fileAttachments.targetId, rows.map((c) => c.id)), isNull(s.files.deletedAt)))
      : [];
    return rows.map((r) => {
      const ids = mentions.filter((m) => m.commentId === r.id).map((m) => m.userId);
      let body: string | null = r.deletedAt ? null : r.body;
      if (body && access.guestViewer) {
        body = body.replace(/@\[([^\]\n]+)\]\(([0-9a-f-]+)\)/gi, (mention, _name: string, id: string) => id.toLowerCase() === auth.userId ? mention : '@ทีมพัฒนา');
        for (const id of ids) {
          const p = people.get(id);
          if (id !== auth.userId && p) body = body.replaceAll(`@[${p.displayName}](${id})`, '@ทีมพัฒนา').replaceAll(`@${p.displayName}`, '@ทีมพัฒนา');
        }
      }
      return { id: r.id, body, author: this.person(r.authorId, people, auth, access), mentions: ids.map((id) => this.person(id, people, auth, access)), createdAt: r.createdAt, editedAt: r.editedAt,
        deletedAt: r.deletedAt, deletedBy: this.person(r.deletedBy, people, auth, access), deletionReason: r.deletedAt ? (r.deletedBy !== r.authorId ? 'admin' : 'author') : null,
        files: r.deletedAt ? [] : files.filter((f) => f.commentId === r.id).map(({ commentId: _, ...f }) => f),
        canEdit: !r.deletedAt && r.authorId === auth.userId && access.perms.has('issue.comment'), canDelete: !r.deletedAt && (r.authorId === auth.userId || access.role === 'admin') && access.perms.has('issue.comment') };
    });
  }

  private cursor(query: Page, issueId: string, feed: Cursor['feed']): Cursor | undefined {
    if (!query.cursor) return;
    try {
      const parsed = CursorBody.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
      if (parsed.issueId !== issueId || parsed.feed !== feed || !z.iso.date().safeParse(parsed.time.slice(0, 10)).success || parsed.time.startsWith('0000') || !Number.isFinite(Date.parse(parsed.time))) throw new Error();
      return parsed;
    } catch {
      throw new AppError(400, 'invalid_cursor', 'ตัวแบ่งหน้าไม่ถูกต้อง');
    }
  }

  private encode(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
}

/** ชื่อเต็มหลายคำเลือกตามชื่อสมาชิกจริง · รูปแบบ @[ชื่อ](UUID) ช่วยแยกสมาชิกชื่อซ้ำ */
function resolveMentions(body: string, members: { id: string; name: string }[]) {
  const ids = new Set<string>();
  const starts = /(?<![\p{L}\p{M}\p{N}_.+\-])@/gu;
  for (const match of body.matchAll(starts)) {
    const tail = body.slice(match.index! + 1);
    const stable = /^\[([^\]\n]+)\]\(([0-9a-f-]+)\)/i.exec(tail);
    let candidates: { id: string; name: string }[];
    if (stable) candidates = members.filter((m) => m.id === stable[2].toLowerCase() && m.name === stable[1]);
    else {
      candidates = members.filter((m) => tail.startsWith(m.name) && !/^[\p{L}\p{M}\p{N}_-]/u.test(tail.slice(m.name.length))).sort((a, b) => b.name.length - a.name.length);
      if (candidates.length) candidates = candidates.filter((m) => m.name.length === candidates[0].name.length);
    }
    if (candidates.length !== 1) throw new AppError(400, 'invalid_mention', 'เลือกคนที่เป็นสมาชิกโปรเจกต์นี้เท่านั้น');
    ids.add(candidates[0].id);
  }
  return [...ids];
}
