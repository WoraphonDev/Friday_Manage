import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, desc, eq, gt, inArray, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ApprovalContext, ApprovalsService } from '../approvals/approvals.service.js';
import { type Approval, audit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { TicketsService } from '../support/tickets.service.js';

const s = schema;
const DAY = 86_400_000;
/** ระยะผ่อนผันของ Workspace ที่ลบ (03-api › DELETE w/) */
const GRACE_DAYS = 30;
/** ยืดเวลารวมได้เองไม่เกิน 30 วัน · เกินต้องอนุมัติ (G7 · O31) */
export const EXTEND_LIMIT_DAYS = 30;
/** สำรองข้อมูลย้อนหลัง (I01) · กู้จากสำรองต้องให้วิศวกร (เฟส 3) */
export const BACKUP_DAYS = 35;
/** งานที่คนเดียวกันลบภายใน 2 นาทีนับเป็นชุดเดียว (เหมือน A41 · Z1) */
const BATCH_WINDOW_MS = 2 * 60_000;
const KEY = /^[A-Z][A-Z0-9]{1,9}$/;

const TYPES = ['issue', 'project', 'file'] as const;
type TrashType = (typeof TYPES)[number];

export const TrashQuery = z.object({ workspaceId: z.uuid(), ticketId: z.uuid() });
export const TicketsQuery = z.object({ workspaceId: z.uuid() });
export const LookupQuery = z.object({ workspaceId: z.uuid(), q: z.string().trim().min(2).max(40) });
export const RestoreBody = z
  .object({
    workspaceId: z.uuid(),
    ticketId: z.uuid(),
    type: z.enum(TYPES),
    ids: z.array(z.uuid()).min(1).max(500),
    newKey: z.string().trim().toUpperCase().regex(KEY, 'ขึ้นต้นด้วยตัวอักษร ใช้ A–Z และ 0–9 ยาว 2–10 ตัว').optional(),
    reason: z.string().trim().min(5).max(500),
    /** แจ้ง Owner และ Admin ของลูกค้าทางอีเมล */
    notify: z.boolean().default(true),
    /** ตอบ Ticket ว่ากู้คืนแล้วพร้อมรายการ */
    replyTicket: z.boolean().default(true),
  })
  .strict();
export const ExtendBody = z
  .object({
    days: z.number().int().min(1).max(90),
    ticketId: z.uuid(),
    reason: z.string().trim().min(5).max(500),
    notify: z.boolean().default(true),
  })
  .strict();
export const RestoreWorkspaceBody = z.object({ ticketId: z.uuid(), reason: z.string().trim().min(5).max(500) }).strict();

const thaiDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(d);
const approvalOf = (ctx?: ApprovalContext): Approval | undefined => (ctx ? { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved } : undefined);
const purgeOf = (w: { deletedAt: Date | null; purgeAfter: Date | null }) => w.purgeAfter ?? new Date(w.deletedAt!.getTime() + GRACE_DAYS * DAY);
const extendedDaysOf = (w: { deletedAt: Date | null; purgeAfter: Date | null }) => Math.max(0, Math.round((purgeOf(w).getTime() - (w.deletedAt!.getTime() + GRACE_DAYS * DAY)) / DAY));
const daysLeft = (d: Date) => Math.max(0, Math.ceil((d.getTime() - Date.now()) / DAY));

interface Deleter {
  name: string;
  role: string | null;
}

/**
 * O31 · กู้คืนข้อมูลที่ลูกค้าลบผิด และ Workspace ที่รอลบถาวร (บอร์ด 21 · Z6–Z9)
 * ops-api ใช้บัญชี friday_worker (ข้าม RLS) · ทุก query กรอง workspace_id เอง · อ่าน Workspace ที่ลบแล้วได้เฉพาะ module นี้
 * ตรรกะกู้คืนเหมือน A41: งานกลับมาพร้อม Sub-task ที่ลบพร้อมกัน · Key ซ้ำต้องเลือก Key ใหม่ · ไฟล์ที่โฟลเดอร์หายกลับไปที่ราก
 * ทีม Friday เห็นเลข ชื่อโปรเจกต์ จำนวน ผู้ลบ · ไม่เห็นชื่องานหรือชื่อไฟล์ (ชื่องานเห็นเมื่อเข้าบัญชีเพื่อช่วยเหลือ)
 */
@Injectable()
export class RestoreService implements OnModuleInit {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly mail: Mailer,
    private readonly ticketsSvc: TicketsService,
  ) {}

  onModuleInit() {
    this.approvals.register('restore.extend_purge', (p, ctx) => this.applyExtend(ctx.requester, p.workspaceId as string, p.input as z.infer<typeof ExtendBody>, ctx));
    this.approvals.register('restore.workspace', (p, ctx) => this.applyRestoreWorkspace(ctx.requester, p.workspaceId as string, p.input as z.infer<typeof RestoreWorkspaceBody>, ctx));
  }

  // ---------------------------------------------------------------- พื้นฐาน

  private async workspace(id: string) {
    const [w] = await this.db.select().from(s.workspaces).where(eq(s.workspaces.id, id));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    return w;
  }

  private async trashDays(workspaceId: string) {
    const [r] = await this.db.select({ days: s.workspaceSettings.trashDays }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, workspaceId));
    return r?.days ?? 30;
  }

  /**
   * Ticket ต้องเป็นของ Workspace นี้ · ผู้แจ้งต้องเป็น Owner / Admin ที่ใช้งานอยู่ (ตรวจจาก requester_user_id หรืออีเมลผู้แจ้ง)
   * ไม่ใช่ → ยังดูรายการได้ แต่กู้คืนไม่ได้ (eligible = false พร้อมเหตุผล)
   */
  private async ticketFor(workspaceId: string, ticketId: string) {
    const [t] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticketId));
    if (!t) throw new AppError(404, 'ticket_not_found', 'ไม่พบ Ticket');
    if (t.workspaceId !== workspaceId) throw new AppError(422, 'ticket_workspace_mismatch', `Ticket #${t.number} ไม่ได้เป็นของ Workspace นี้`);
    const [m] = await this.db
      .select({ role: s.workspaceMembers.role, email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'),
        t.requesterUserId ? eq(s.workspaceMembers.userId, t.requesterUserId) : sql`lower(${s.users.email}) = lower(${t.requesterEmail ?? ''})`));
    const role = m?.role ?? null;
    const eligible = role === 'owner' || role === 'admin';
    return {
      ticket: t,
      view: {
        id: t.id,
        number: t.number,
        subject: t.subject,
        status: t.status,
        requesterEmail: m?.email ?? t.requesterEmail,
        requesterRole: role,
        eligible,
        reason: eligible ? null : role ? 'ผู้แจ้งไม่ใช่ Owner / Admin ของ Workspace' : 'ผู้แจ้งไม่ได้เป็นสมาชิกของ Workspace นี้',
      },
    };
  }

  private async deleters(workspaceId: string, ids: (string | null)[]) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    const map = new Map<string, Deleter>();
    if (!want.length) return map;
    const rows = await this.db
      .select({ id: s.users.id, name: s.users.displayName, role: s.workspaceMembers.role })
      .from(s.users)
      .leftJoin(s.workspaceMembers, and(eq(s.workspaceMembers.userId, s.users.id), eq(s.workspaceMembers.workspaceId, workspaceId)))
      .where(inArray(s.users.id, want));
    for (const r of rows) map.set(r.id, { name: r.name, role: r.role ?? null });
    return map;
  }

  // ---------------------------------------------------------------- หน้า 21

  /** การ์ดสรุปหัวหน้า */
  async summary() {
    const now = new Date();
    const [pending] = await this.db
      .select({ n: sql<number>`count(*)::int`, soon: sql<number>`count(*) filter (where coalesce(${s.workspaces.purgeAfter}, ${s.workspaces.deletedAt} + interval '30 days') <= now() + interval '7 days')::int` })
      .from(s.workspaces)
      .where(isNotNull(s.workspaces.deletedAt));
    const restored = await this.db
      .select({ action: s.staffAuditLogs.action, n: sql<number>`count(*)::int` })
      .from(s.staffAuditLogs)
      .where(and(like(s.staffAuditLogs.action, 'restore.%'), ne(s.staffAuditLogs.action, 'restore.extended'), gt(s.staffAuditLogs.createdAt, new Date(now.getTime() - 30 * DAY))))
      .groupBy(s.staffAuditLogs.action);
    const by = Object.fromEntries(restored.map((r) => [r.action.replace('restore.', ''), r.n]));
    // รอบลบถาวรถัดไป (คืนนี้): สิ่งที่พ้น trash_days ภายใน 24 ชั่วโมงข้างหน้า
    const due = (table: string) => sql.raw(`(select count(*)::int from ${table} x join workspace_settings ws on ws.workspace_id = x.workspace_id join workspaces w on w.id = x.workspace_id
        where x.deleted_at is not null and w.deleted_at is null and x.deleted_at + make_interval(days => ws.trash_days) <= now() + interval '1 day')`);
    const res = await this.db.execute(sql`select ${due('issues')} as issues, ${due('projects')} as projects`);
    const [tonight] = ((res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as { issues: number; projects: number }[];
    return {
      pendingWorkspaces: pending?.n ?? 0,
      pendingSoon: pending?.soon ?? 0,
      restored30d: { total: Object.values(by).reduce((a, b) => a + b, 0), issue: by.issue ?? 0, project: by.project ?? 0, file: by.file ?? 0, workspace: by.workspace ?? 0 },
      purgeTonight: { issues: tonight?.issues ?? 0, projects: tonight?.projects ?? 0, runsAt: '04:30' },
      backupDays: BACKUP_DAYS,
    };
  }

  /** รายการในถังขยะของ Workspace แบบสรุป (ต้องเลือก Ticket ก่อน) · งาน / ไฟล์ที่คนเดียวกันลบใน 2 นาทีรวมเป็นแถวเดียว */
  async trash(q: z.infer<typeof TrashQuery>) {
    const ws = await this.workspace(q.workspaceId);
    const { view: ticket } = await this.ticketFor(ws.id, q.ticketId);
    const days = await this.trashDays(ws.id);
    const cutoff = new Date(Date.now() - days * DAY);
    const projects = await this.db
      .select({
        id: s.projects.id, key: s.projects.key, name: s.projects.name, deletedAt: s.projects.deletedAt, deletedBy: s.projects.deletedBy,
        // select ตารางเดียว drizzle ไม่ใส่ชื่อตารางหน้าคอลัมน์ จึงอ้าง projects.* ตรง ๆ ใน subquery
        issues: sql<number>`(select count(*)::int from issues i where i.project_id = projects.id and i.deleted_at is null)`,
        files: sql<number>`(select count(*)::int from files f where f.project_id = projects.id and f.deleted_at is null)`,
        keyTaken: sql<boolean>`exists (select 1 from projects p2 where p2.workspace_id = projects.workspace_id and p2.key = projects.key and p2.deleted_at is null)`,
      })
      .from(s.projects)
      .where(and(eq(s.projects.workspaceId, ws.id), isNotNull(s.projects.deletedAt), gt(s.projects.deletedAt, cutoff)));
    const issues = await this.db
      .select({
        id: s.issues.id, number: s.issues.number, deletedAt: s.issues.deletedAt, deletedBy: s.issues.deletedBy, projectKey: s.projects.key, projectName: s.projects.name,
        subtasks: sql<number>`(select count(*)::int from issues c where c.parent_id = ${s.issues.id} and c.deleted_at = ${s.issues.deletedAt})`,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(eq(s.issues.workspaceId, ws.id), isNotNull(s.issues.deletedAt), gt(s.issues.deletedAt, cutoff), isNull(s.projects.deletedAt),
        sql`not exists (select 1 from issues p where p.id = ${s.issues.parentId} and p.deleted_at is not null)`))
      .orderBy(s.issues.deletedAt);
    const files = await this.db
      .select({
        id: s.files.id, deletedAt: s.files.deletedAt, deletedBy: s.files.deletedBy, projectKey: s.projects.key, projectName: s.projects.name,
        folder: sql<string | null>`(select f.name from folders f where f.id = ${s.files.folderId})`,
        sizeBytes: sql<number>`(select coalesce(sum(v.size_bytes), 0)::bigint from file_versions v where v.file_id = ${s.files.id})`,
      })
      .from(s.files)
      .innerJoin(s.projects, eq(s.projects.id, s.files.projectId))
      .where(and(eq(s.files.workspaceId, ws.id), isNotNull(s.files.deletedAt), gt(s.files.deletedAt, cutoff), isNull(s.projects.deletedAt)))
      .orderBy(s.files.deletedAt);
    const people = await this.deleters(ws.id, [...projects, ...issues, ...files].map((r) => r.deletedBy));
    const who = (id: string | null) => (id ? (people.get(id) ?? null) : null);
    const purgeAt = (d: Date) => new Date(d.getTime() + days * DAY);

    const items = [
      ...projects.map((p) => ({ type: 'project' as const, id: p.id, ids: [p.id], count: 1, project: { key: p.key, name: p.name }, counts: { issues: p.issues, files: p.files }, keyTaken: p.keyTaken, deletedBy: who(p.deletedBy), deletedAt: p.deletedAt!, purgeAt: purgeAt(p.deletedAt!) })),
      ...groups(issues).map((g) => ({
        type: 'issue' as const, id: g[0]!.id, ids: g.map((i) => i.id), count: g.length, keys: g.map((i) => `${i.projectKey}-${i.number}`).sort(byKey),
        project: { key: g[0]!.projectKey, name: g[0]!.projectName }, projects: [...new Set(g.map((i) => i.projectKey))], subtasks: g.reduce((n, i) => n + i.subtasks, 0),
        deletedBy: who(g[0]!.deletedBy), deletedAt: g[g.length - 1]!.deletedAt!, purgeAt: purgeAt(g[0]!.deletedAt!),
      })),
      ...groups(files).map((g) => ({
        type: 'file' as const, id: g[0]!.id, ids: g.map((f) => f.id), count: g.length, sizeBytes: g.reduce((n, f) => n + Number(f.sizeBytes), 0),
        project: { key: g[0]!.projectKey, name: g[0]!.projectName }, folder: new Set(g.map((f) => f.folder)).size === 1 ? g[0]!.folder : null,
        deletedBy: who(g[0]!.deletedBy), deletedAt: g[g.length - 1]!.deletedAt!, purgeAt: purgeAt(g[0]!.deletedAt!),
      })),
    ]
      .map((i) => ({ ...i, daysLeft: daysLeft(i.purgeAt) }))
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
    return {
      workspace: { id: ws.id, slug: ws.slug, name: ws.name, deleted: !!ws.deletedAt },
      ticket,
      trashDays: days,
      counts: { all: items.length, project: items.filter((i) => i.type === 'project').length, issue: items.filter((i) => i.type === 'issue').length, file: items.filter((i) => i.type === 'file').length },
      items,
    };
  }

  /** Z9 · ค้นด้วยเลขงาน / Key · พบในถังขยะ / ยังอยู่ / ลบถาวรแล้ว (จาก Audit log) */
  async lookup(q: z.infer<typeof LookupQuery>) {
    const ws = await this.workspace(q.workspaceId);
    const text = q.q.toUpperCase();
    const m = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/.exec(text);
    const days = await this.trashDays(ws.id);
    if (m) {
      const [row] = await this.db
        .select({ id: s.issues.id, deletedAt: s.issues.deletedAt, projectDeletedAt: s.projects.deletedAt })
        .from(s.issues)
        .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
        .where(and(eq(s.issues.workspaceId, ws.id), eq(s.projects.key, m[1]!), eq(s.issues.number, Number(m[2]))))
        .orderBy(sql`${s.projects.deletedAt} desc nulls first`)
        .limit(1);
      if (row) return { q: text, kind: 'issue', status: row.deletedAt || row.projectDeletedAt ? 'in_trash' : 'live', trashDays: days, backupDays: BACKUP_DAYS };
    } else if (KEY.test(text)) {
      const [p] = await this.db.select({ deletedAt: s.projects.deletedAt }).from(s.projects).where(and(eq(s.projects.workspaceId, ws.id), eq(s.projects.key, text))).orderBy(sql`${s.projects.deletedAt} desc nulls first`).limit(1);
      if (p) return { q: text, kind: 'project', status: p.deletedAt ? 'in_trash' : 'live', trashDays: days, backupDays: BACKUP_DAYS };
    }
    // ไม่มีในฐานข้อมูลแล้ว: ดูว่าเคยลบ (ผู้ใช้ลบ / ลบถาวร) ตามประวัติใน audit_logs ของลูกค้า
    const needle = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const [deleted] = await this.db
      .select({ at: s.auditLogs.createdAt })
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.workspaceId, ws.id), inArray(s.auditLogs.action, ['issue.deleted', 'project.deleted']), sql`upper(${s.auditLogs.summary}) like ${needle}`))
      .orderBy(desc(s.auditLogs.createdAt))
      .limit(1);
    const [purged] = await this.db
      .select({ at: s.auditLogs.createdAt })
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.workspaceId, ws.id), eq(s.auditLogs.action, 'trash.purged'),
        deleted ? sql`(upper(${s.auditLogs.summary}) like ${needle} or ${s.auditLogs.createdAt} >= ${deleted.at.toISOString()}::timestamptz)` : sql`upper(${s.auditLogs.summary}) like ${needle}`))
      .orderBy(s.auditLogs.createdAt)
      .limit(1);
    if (!deleted && !purged) return { q: text, kind: m ? 'issue' : 'project', status: 'not_found', trashDays: days, backupDays: BACKUP_DAYS };
    return { q: text, kind: m ? 'issue' : 'project', status: 'purged', deletedAt: deleted?.at ?? null, purgedAt: purged?.at ?? null, trashDays: days, backupDays: BACKUP_DAYS };
  }

  /** Ticket ที่ยังไม่ปิดของ Workspace (ตัวเลือก Ticket ในหน้านี้) · บอกว่าผู้แจ้งเป็น Owner / Admin หรือไม่ */
  async tickets(q: z.infer<typeof TicketsQuery>) {
    const ws = await this.workspace(q.workspaceId);
    const rows = await this.db
      .select({ id: s.supportTickets.id })
      .from(s.supportTickets)
      .where(and(eq(s.supportTickets.workspaceId, ws.id), ne(s.supportTickets.status, 'closed')))
      .orderBy(desc(s.supportTickets.createdAt))
      .limit(50);
    const items = [];
    for (const r of rows) items.push((await this.ticketFor(ws.id, r.id)).view);
    return { workspace: { id: ws.id, slug: ws.slug, name: ws.name, deleted: !!ws.deletedAt }, items };
  }

  /** ประวัติการกู้คืนและยืดเวลาของทีม */
  async history() {
    const rows = await this.db
      .select({ id: s.staffAuditLogs.id, action: s.staffAuditLogs.action, reason: s.staffAuditLogs.reason, workspaceId: s.staffAuditLogs.workspaceId, workspaceName: s.workspaces.name, staffName: s.staffUsers.name, approvedBy: s.staffAuditLogs.approvedBy, selfApproved: s.staffAuditLogs.selfApproved, createdAt: s.staffAuditLogs.createdAt })
      .from(s.staffAuditLogs)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.staffAuditLogs.staffId))
      .leftJoin(s.workspaces, eq(s.workspaces.id, s.staffAuditLogs.workspaceId))
      .where(like(s.staffAuditLogs.action, 'restore.%'))
      .orderBy(desc(s.staffAuditLogs.createdAt))
      .limit(100);
    return { items: rows };
  }

  // ---------------------------------------------------------------- Z6 กู้คืนให้ลูกค้า

  /** กู้คืนงาน / โปรเจกต์ / ไฟล์ · ไม่ต้องอนุมัติคนที่สอง (ไม่ทับข้อมูล ลูกค้าลบซ้ำได้) · Audit ทั้งของลูกค้าและของทีม */
  async restore(staff: Staff, input: z.infer<typeof RestoreBody>) {
    const ws = await this.workspace(input.workspaceId);
    if (ws.deletedAt) throw new AppError(409, 'workspace_deleted', 'Workspace นี้ถูกลบอยู่ · ใช้ "กู้คืน Workspace" แทน');
    const { ticket, view } = await this.ticketFor(ws.id, input.ticketId);
    if (!view.eligible) throw new AppError(403, 'requester_not_admin', `กู้คืนให้ได้เมื่อ Ticket มาจาก Owner หรือ Admin ของ Workspace · ${view.reason}`, { requesterEmail: view.requesterEmail, requesterRole: view.requesterRole });
    const days = await this.trashDays(ws.id);
    const ids = [...new Set(input.ids)];
    const tag = `Ticket #${ticket.number}`;
    const result = await this.db.transaction(async (tx) => {
      const labels =
        input.type === 'issue' ? await this.restoreIssues(tx, ws.id, ids, days)
        : input.type === 'file' ? await this.restoreFiles(tx, ws.id, ids, days)
        : await this.restoreProject(tx, ws.id, ids, days, input.newKey);
      const what = describe(input.type, labels);
      await audit(tx, staff, ws.id, 'data', `restore.${input.type}`, `กู้คืน${what} ให้ลูกค้า · ${tag} · ${input.reason}`, { type: input.type, id: ids[0]! });
      return { labels, what };
    });

    let notified = 0;
    if (input.notify) {
      for (const to of await this.adminEmails(ws.id)) {
        if (await this.send(to, `ทีม Friday กู้คืนข้อมูลใน ${ws.name} แล้ว (${tag})`, [`ทีม Friday กู้คืน${result.what} ใน Workspace ${ws.name} ตามคำขอใน ${tag}`, `เหตุผล: ${input.reason}`, 'ดูรายละเอียดได้ที่ Admin Console › Audit log (ป้าย "ทีม Friday")', `${config.appUrl}/work/${ws.slug}`])) notified++;
      }
    }
    let replied = false;
    if (input.replyTicket) {
      const r = await this.ticketsSvc.message(staff, ticket.id, { body: `กู้คืน${result.what} ให้แล้ว\nรายการ: ${result.labels.slice(0, 50).join(', ')}${result.labels.length > 50 ? ' …' : ''}\nถ้าไม่ต้องการ ลบซ้ำได้จากหน้าเดิม`, internal: false, fromCustomer: false });
      replied = 'message' in r;
    }
    return { type: input.type, restored: result.labels.length, items: result.labels, notified, replied };
  }

  /** งาน: กลับมาพร้อม Sub-task ที่ลบพร้อมแม่ครั้งเดียวกัน (activities.deleted.cascadeRootId · เหมือน A03) */
  private async restoreIssues(tx: Tx, workspaceId: string, ids: string[], days: number) {
    const roots = await tx
      .select({ i: s.issues, key: s.projects.key, projectDeletedAt: s.projects.deletedAt })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(eq(s.issues.workspaceId, workspaceId), inArray(s.issues.id, ids)))
      .for('update', { of: s.issues });
    if (roots.length !== ids.length) throw new AppError(404, 'not_found', 'ไม่พบงานบางรายการในถังขยะของ Workspace นี้');
    const labels: string[] = [];
    // แม่ก่อนลูก
    for (const { i, key, projectDeletedAt } of roots.sort((a, b) => Number(!!a.i.parentId) - Number(!!b.i.parentId))) {
      const label = `${key}-${i.number}`;
      if (!i.deletedAt) throw new AppError(409, 'not_deleted', `${label} ไม่ได้อยู่ในถังขยะ`);
      if (projectDeletedAt) throw new AppError(409, 'project_deleted', `โปรเจกต์ ${key} อยู่ในถังขยะ · กู้คืนโปรเจกต์ก่อน`);
      if (i.deletedAt.getTime() + days * DAY <= Date.now()) throw new AppError(410, 'restore_expired', `${label} เกินกำหนดกู้คืน ${days} วันแล้ว`);
      if (i.parentId) {
        const [parent] = await tx.select({ deletedAt: s.issues.deletedAt }).from(s.issues).where(eq(s.issues.id, i.parentId));
        if (parent?.deletedAt) throw new AppError(409, 'parent_deleted', `ต้องกู้คืนงานแม่ของ ${label} ก่อน`);
      }
      const children = await tx.select().from(s.issues).where(and(eq(s.issues.parentId, i.id), eq(s.issues.deletedAt, i.deletedAt)));
      const deletions = children.length
        ? await tx.select().from(s.activities).where(and(inArray(s.activities.issueId, children.map((c) => c.id)), eq(s.activities.verb, 'deleted'))).orderBy(sql`${s.activities.createdAt} desc`, sql`${s.activities.id} desc`)
        : [];
      const back = children.filter((c) => {
        const d = deletions.find((a) => a.issueId === c.id)?.newValue as { cascadeRootId?: string; deletedAt?: string } | undefined;
        return d?.cascadeRootId === i.id && d.deletedAt === i.deletedAt!.toISOString();
      });
      const rows = [i, ...back];
      await tx.update(s.issues).set({ deletedAt: null, version: sql`${s.issues.version} + 1` }).where(inArray(s.issues.id, rows.map((r) => r.id)));
      // ประวัติของงานแสดงว่าทีม Friday กู้คืน (actor_kind friday_staff · พนักงานไม่ใช่ผู้ใช้ของลูกค้า)
      await tx.insert(s.activities).values(rows.map((r) => ({ workspaceId, projectId: r.projectId, issueId: r.id, actorId: null, actorKind: 'friday_staff' as const, verb: 'restored', field: 'deletedAt', oldValue: r.deletedAt })));
      labels.push(back.length ? `${label} (+ Sub-task ${back.length})` : label);
    }
    return labels;
  }

  private async restoreFiles(tx: Tx, workspaceId: string, ids: string[], days: number) {
    const rows = await tx
      .select({ f: s.files, key: s.projects.key, projectDeletedAt: s.projects.deletedAt })
      .from(s.files)
      .innerJoin(s.projects, eq(s.projects.id, s.files.projectId))
      .where(and(eq(s.files.workspaceId, workspaceId), inArray(s.files.id, ids)));
    if (rows.length !== ids.length) throw new AppError(404, 'not_found', 'ไม่พบไฟล์บางรายการในถังขยะของ Workspace นี้');
    for (const { f, key, projectDeletedAt } of rows) {
      if (!f.deletedAt) throw new AppError(409, 'not_deleted', 'ไฟล์บางรายการไม่ได้อยู่ในถังขยะ');
      if (projectDeletedAt) throw new AppError(409, 'project_deleted', `โปรเจกต์ ${key} อยู่ในถังขยะ · กู้คืนโปรเจกต์ก่อน`);
      if (f.deletedAt.getTime() + days * DAY <= Date.now()) throw new AppError(410, 'restore_expired', `ไฟล์เกินกำหนดกู้คืน ${days} วันแล้ว`);
      const [folder] = f.folderId ? await tx.select({ id: s.folders.id }).from(s.folders).where(eq(s.folders.id, f.folderId)) : [];
      await tx.update(s.files).set({ deletedAt: null, ...(f.folderId && !folder ? { folderId: null } : {}) }).where(eq(s.files.id, f.id));
    }
    // ไม่ส่งชื่อไฟล์กลับ (ทีม Friday ไม่เห็นเนื้อหา) · ใช้โปรเจกต์ + จำนวน
    return rows.map((r) => `${r.key} · ไฟล์`);
  }

  private async restoreProject(tx: Tx, workspaceId: string, ids: string[], days: number, newKey?: string) {
    if (ids.length !== 1) throw new AppError(400, 'one_project', 'กู้คืนโปรเจกต์ได้ครั้งละหนึ่งโปรเจกต์');
    const [p] = await tx.select().from(s.projects).where(and(eq(s.projects.workspaceId, workspaceId), eq(s.projects.id, ids[0]!))).for('update');
    if (!p) throw new AppError(404, 'not_found', 'ไม่พบโปรเจกต์ในถังขยะของ Workspace นี้');
    if (!p.deletedAt) throw new AppError(409, 'not_deleted', 'โปรเจกต์นี้ไม่ได้อยู่ในถังขยะ');
    if (p.deletedAt.getTime() + days * DAY <= Date.now()) throw new AppError(410, 'restore_expired', `เกินกำหนดกู้คืน ${days} วันแล้ว`);
    const free = async (key: string) => {
      const [taken] = await tx.select({ id: s.projects.id }).from(s.projects).where(and(eq(s.projects.workspaceId, workspaceId), eq(s.projects.key, key), isNull(s.projects.deletedAt)));
      const [alias] = await tx.select({ projectId: s.projectKeyAliases.projectId }).from(s.projectKeyAliases).where(and(eq(s.projectKeyAliases.workspaceId, workspaceId), eq(s.projectKeyAliases.oldKey, key)));
      return !taken && (!alias || alias.projectId === p.id);
    };
    const suggest = async (base: string) => {
      for (let n = 2; n < 100; n++) {
        const k = `${base.slice(0, 10 - String(n).length)}${n}`;
        if (await free(k)) return k;
      }
      return null;
    };
    let key = p.key;
    if (newKey && newKey !== p.key) {
      if (!(await free(newKey))) throw new AppError(409, 'key_taken', 'Project Key นี้มีใน Workspace แล้ว', { key: newKey, suggestedKey: await suggest(newKey) });
      key = newKey;
    } else if (!(await free(p.key))) {
      throw new AppError(409, 'project_key_taken', `Key ${p.key} ถูกโปรเจกต์ปัจจุบันใช้แล้ว · เลือก Key ใหม่ก่อนกู้คืน`, { key: p.key, suggestedKey: await suggest(p.key) });
    }
    await tx.update(s.projects).set({ deletedAt: null, key }).where(eq(s.projects.id, p.id));
    if (key !== p.key) {
      await tx.delete(s.projectKeyAliases).where(and(eq(s.projectKeyAliases.workspaceId, workspaceId), eq(s.projectKeyAliases.projectId, p.id), eq(s.projectKeyAliases.oldKey, key)));
      await tx.insert(s.projectKeyAliases).values({ workspaceId, projectId: p.id, oldKey: p.key }).onConflictDoNothing();
    }
    return [key !== p.key ? `${p.key} → ${key} · ${p.name}` : `${p.key} · ${p.name}`];
  }

  // ---------------------------------------------------------------- Workspace ที่รอลบถาวร

  async pendingWorkspaces() {
    const rows = await this.db
      .select({
        id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, deletedAt: s.workspaces.deletedAt, purgeAfter: s.workspaces.purgeAfter, deletedBy: s.workspaces.deletedBy,
        members: sql<number>`(select count(*)::int from workspace_members m where m.workspace_id = workspaces.id and m.status = 'active')`,
        plan: sql<string | null>`(select p.code from subscriptions sub join plans p on p.id = sub.plan_id where sub.workspace_id = workspaces.id)`,
        planStatus: sql<string | null>`(select sub.status from subscriptions sub where sub.workspace_id = workspaces.id)`,
      })
      .from(s.workspaces)
      .where(isNotNull(s.workspaces.deletedAt));
    const people = new Map<string, Deleter>();
    for (const r of rows) for (const [k, v] of await this.deleters(r.id, [r.deletedBy])) people.set(`${r.id}:${k}`, v);
    const ids = rows.map((r) => r.id);
    const tickets = ids.length
      ? await this.db.select({ id: s.supportTickets.id, number: s.supportTickets.number, subject: s.supportTickets.subject, workspaceId: s.supportTickets.workspaceId, status: s.supportTickets.status })
          .from(s.supportTickets).where(and(inArray(s.supportTickets.workspaceId, ids), ne(s.supportTickets.status, 'closed'))).orderBy(desc(s.supportTickets.createdAt))
      : [];
    const approvals = ids.length
      ? await this.db.select({ id: s.approvalRequests.id, kind: s.approvalRequests.kind, workspaceId: s.approvalRequests.workspaceId })
          .from(s.approvalRequests).where(and(inArray(s.approvalRequests.workspaceId, ids), eq(s.approvalRequests.status, 'pending'), like(s.approvalRequests.kind, 'restore.%')))
      : [];
    const items = rows
      .map((r) => {
        const purge = purgeOf(r);
        return {
          id: r.id, slug: r.slug, name: r.name, members: r.members, plan: r.plan, planStatus: r.planStatus,
          deletedAt: r.deletedAt, deletedBy: r.deletedBy ? (people.get(`${r.id}:${r.deletedBy}`) ?? null) : null,
          purgeAfter: purge, daysLeft: daysLeft(purge), extendedDays: extendedDaysOf(r), extendLeft: Math.max(0, EXTEND_LIMIT_DAYS - extendedDaysOf(r)),
          tickets: tickets.filter((t) => t.workspaceId === r.id).map(({ workspaceId: _w, ...t }) => t),
          pendingApprovals: approvals.filter((a) => a.workspaceId === r.id).map((a) => ({ id: a.id, kind: a.kind })),
        };
      })
      .sort((a, b) => a.purgeAfter.getTime() - b.purgeAfter.getTime());
    return { items, extendLimitDays: EXTEND_LIMIT_DAYS };
  }

  private async deletedWorkspace(id: string) {
    const ws = await this.workspace(id);
    if (!ws.deletedAt) throw new AppError(409, 'workspace_not_deleted', 'Workspace นี้ไม่ได้ถูกลบ');
    if (purgeOf(ws).getTime() <= Date.now()) throw new AppError(410, 'purge_due', 'เกินกำหนดแล้ว · Workspace นี้กำลังถูกลบถาวร');
    return ws;
  }

  /** Z7 · ยืดเวลาก่อนลบถาวร · รวม ≤ 30 วันทำเองได้ · เกินนั้นขออนุมัติ (G7) */
  async extend(staff: Staff, id: string, input: z.infer<typeof ExtendBody>) {
    const ws = await this.deletedWorkspace(id);
    const { ticket } = await this.ticketFor(ws.id, input.ticketId);
    const total = extendedDaysOf(ws) + input.days;
    const pending = await this.approvals.gate(staff, {
      kind: 'restore.extend_purge', workspaceId: ws.id, target: { type: 'workspace', id: ws.id }, payload: { workspaceId: ws.id, input },
      reason: `${input.reason} · Ticket #${ticket.number}`, exceeds: total > EXTEND_LIMIT_DAYS,
      rule: `ยืดเวลาก่อนลบถาวรรวม ${total} วัน เกิน ${EXTEND_LIMIT_DAYS} วันต้องอนุมัติ`,
    });
    if (pending) return { pendingApproval: pending };
    return this.applyExtend(staff, ws.id, input);
  }

  private async applyExtend(staff: Staff, id: string, input: z.infer<typeof ExtendBody>, ctx?: ApprovalContext) {
    const ws = await this.deletedWorkspace(id);
    const [ticket] = await this.db.select({ number: s.supportTickets.number }).from(s.supportTickets).where(eq(s.supportTickets.id, input.ticketId));
    const before = purgeOf(ws);
    const after = new Date(before.getTime() + input.days * DAY);
    // trigger soft_delete ไม่ทับ purge_after ของแถวที่ลบอยู่แล้ว · รอบอีเมลเตือน (A41) เลื่อนตามวันใหม่เอง
    await this.db.transaction(async (tx) => {
      await tx.update(s.workspaces).set({ purgeAfter: after }).where(eq(s.workspaces.id, ws.id));
      await audit(tx, staff, ws.id, 'secu', 'restore.extended', `ยืดเวลาก่อนลบถาวร ${input.days} วัน: ${thaiDate(before)} → ${thaiDate(after)} · Ticket #${ticket?.number ?? '-'} · ${input.reason}`, { type: 'workspace', id: ws.id }, approvalOf(ctx));
    });
    let notified = 0;
    if (input.notify) {
      for (const to of await this.ownerEmails(ws.id)) {
        if (await this.send(to, `เลื่อนวันลบถาวรของ ${ws.name} เป็น ${thaiDate(after)}`, [`ทีม Friday เลื่อนวันลบถาวรของ Workspace ${ws.name} ออกไป ${input.days} วัน ตามคำขอใน Ticket #${ticket?.number ?? '-'}`, `ข้อมูลจะถูกลบถาวรวันที่ ${thaiDate(after)} · กู้คืนเองได้ก่อนวันนั้นที่ลิงก์ด้านล่าง`, `${config.appUrl}/work/${ws.slug}`])) notified++;
      }
    }
    return { workspaceId: ws.id, purgeAfter: after, extendedDays: extendedDaysOf({ deletedAt: ws.deletedAt, purgeAfter: after }), notified };
  }

  /** Z8 · กู้ Workspace แทนลูกค้า · ต้องแตะ key (G4 ที่ controller) และอนุมัติทุกครั้งเหมือนโอนความเป็นเจ้าของ (C7) · มี Owner คนเดียวใช้ G12 */
  async requestRestoreWorkspace(staff: Staff, id: string, input: z.infer<typeof RestoreWorkspaceBody>) {
    const ws = await this.deletedWorkspace(id);
    const { ticket } = await this.ticketFor(ws.id, input.ticketId);
    const [open] = await this.db.select({ id: s.approvalRequests.id }).from(s.approvalRequests).where(and(eq(s.approvalRequests.workspaceId, ws.id), eq(s.approvalRequests.kind, 'restore.workspace'), eq(s.approvalRequests.status, 'pending')));
    if (open) throw new AppError(409, 'restore_pending', 'มีคำขอกู้คืน Workspace นี้ที่รออนุมัติอยู่แล้ว', { approvalId: open.id });
    const pending = await this.approvals.gate(staff, {
      kind: 'restore.workspace', workspaceId: ws.id, target: { type: 'workspace', id: ws.id }, payload: { workspaceId: ws.id, input },
      reason: `${input.reason} · Ticket #${ticket.number}`, exceeds: true, rule: 'กู้ Workspace แทนลูกค้าต้องอนุมัติทุกครั้ง (เหมือนโอนความเป็นเจ้าของ)',
    });
    await audit(this.db, staff, ws.id, 'secu', 'ops.workspace_restore_requested', `ขอกู้คืน Workspace แทนลูกค้า · Ticket #${ticket.number} · ${input.reason}`, { type: 'workspace', id: ws.id });
    return { pendingApproval: pending! };
  }

  private async applyRestoreWorkspace(staff: Staff, id: string, input: z.infer<typeof RestoreWorkspaceBody>, ctx: ApprovalContext) {
    const ws = await this.deletedWorkspace(id);
    const [ticket] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, input.ticketId));
    // trigger soft_delete ล้าง deleted_by, purge_after, purge_reminded_at ให้เอง · สถานะเหมือนลูกค้ากู้เอง (A31)
    await this.db.transaction(async (tx) => {
      await tx.update(s.workspaces).set({ deletedAt: null, status: 'active', updatedAt: new Date() }).where(eq(s.workspaces.id, ws.id));
      await audit(tx, staff, ws.id, 'secu', 'restore.workspace', `กู้คืน Workspace ${ws.slug} แทนลูกค้า · Ticket #${ticket?.number ?? '-'} · ${input.reason}`, { type: 'workspace', id: ws.id }, approvalOf(ctx));
    });
    for (const to of await this.ownerEmails(ws.id)) {
      await this.send(to, `ทีม Friday กู้คืน Workspace ${ws.name} แล้ว`, [`ทีม Friday กู้คืน Workspace ${ws.name} ตามคำขอใน Ticket #${ticket?.number ?? '-'}`, 'สมาชิกเข้าใช้งานได้ทันที · แพ็กเกจเป็น Free จนกว่าจะชำระใหม่ (ข้อมูลที่เกินแพ็กเกจเป็นอ่านอย่างเดียว)', `${config.appUrl}/work/${ws.slug}`]);
    }
    if (ticket && ticket.status !== 'closed') {
      await this.ticketsSvc.message(staff, ticket.id, { body: `กู้คืน Workspace ${ws.name} ให้แล้ว · สมาชิกเข้าใช้งานได้ทันที`, internal: false, fromCustomer: false }).catch(() => undefined);
    }
    return { workspaceId: ws.id, restored: true };
  }

  // ---------------------------------------------------------------- อีเมล

  private async ownerEmails(workspaceId: string) {
    return this.memberEmails(workspaceId, ['owner']);
  }
  private async adminEmails(workspaceId: string) {
    return this.memberEmails(workspaceId, ['owner', 'admin']);
  }
  private async memberEmails(workspaceId: string, roles: ('owner' | 'admin')[]) {
    const rows = await this.db
      .select({ email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.role, roles)));
    return rows.map((r) => r.email);
  }
  /** ส่งไม่ได้ไม่ทำให้รายการล้ม (Mailer บันทึก log แล้ว) */
  private async send(to: string, subject: string, lines: string[]) {
    try {
      await this.mail.send({ to, subject, text: lines.join('\n') });
      return true;
    } catch {
      return false;
    }
  }
}

/** รวมรายการที่คนเดียวกันลบห่างจากรายการแรกของกลุ่มไม่เกิน 2 นาที (เรียงตามเวลาลบแล้ว) */
function groups<T extends { deletedBy: string | null; deletedAt: Date | null }>(rows: T[]) {
  const out: T[][] = [];
  const open = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.deletedBy ?? '-';
    const g = open.get(k);
    if (g && r.deletedAt!.getTime() - g[0]!.deletedAt!.getTime() <= BATCH_WINDOW_MS) g.push(r);
    else {
      const ng = [r];
      open.set(k, ng);
      out.push(ng);
    }
  }
  return out;
}

const byKey = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

function describe(type: TrashType, labels: string[]) {
  if (type === 'project') return `โปรเจกต์ ${labels[0]}`;
  if (type === 'file') return `ไฟล์ ${labels.length} ไฟล์`;
  return labels.length === 1 ? `งาน ${labels[0]}` : `งาน ${labels.length} งาน`;
}
