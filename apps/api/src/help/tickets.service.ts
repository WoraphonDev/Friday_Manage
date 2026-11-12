import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { webUrl } from '../auth/auth.config.js';
import { signToken, verifyToken } from '../auth/crypto.js';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { EventBus } from '../core/events.js';
import { Mailer } from '../core/mail.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { finalKeyOf, LocalStorage, S3Storage, StagingGone, stagingKeyFor, type StorageDriver } from '../files/storage.js';
import { HelpArticlesService } from './articles.service.js';
import { dueOf, loadConfig, routeTicket } from './routing.js';

const s = schema;
const k = s.supportTickets;
const DAY = 86_400_000;
const PLAN_NAMES: Record<string, string> = { free: 'Free', team_s: 'Team S', team_m: 'Team M', team_l: 'Team L', enterprise: 'Enterprise' };
/** ไฟล์แนบใน Ticket ไม่เกิน 10 MB ต่อไฟล์ และ 5 ไฟล์ต่อข้อความ (X5) */
export const TICKET_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;
/** หมวดบัญชีส่วนตัว: Owner / Admin ไม่เห็นใน "ทั้ง Workspace" (คำตัดสิน A44) */
export const PRIVATE_CATEGORY = 'account';
/** หมวด Ticket ที่ลูกค้าเลือกได้ (TICKET_CATEGORIES ของ O22) */
const Category = z.enum(s.TICKET_CATEGORIES);
/** ผลกระทบ (X5) · กระทบทั้งทีม / ใช้งานไม่ได้เลย ยกความสำคัญขั้นต่ำเป็นสูง (ด่วนให้ทีม Support ตั้งเอง เพราะเปลี่ยน SLA เป็น 24 ชม.) */
const Impact = z.enum(['me', 'team', 'blocked']);
const Attachment = z.object({ uploadToken: z.string().min(10).max(2000) }).strict();

export const UploadBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    size: z.number().int().min(1),
    mime: z.string().trim().min(1).max(120),
  })
  .strict();
export const CreateTicketBody = z
  .object({
    subject: z.string().trim().min(3, 'หัวข้ออย่างน้อย 3 ตัวอักษร').max(200),
    category: Category,
    impact: Impact.default('me'),
    body: z.string().trim().min(1, 'กรอกรายละเอียด').max(10_000),
    attachments: z.array(Attachment).max(MAX_FILES).default([]),
    /** หน้าที่เปิดอยู่และรหัสคำขอล่าสุด (ติ๊ก "แนบหน้าที่เปิดอยู่") */
    context: z
      .object({
        page: z.string().trim().max(200).optional(),
        path: z.string().trim().max(300).optional(),
        requestId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
      })
      .strict()
      .optional(),
    /** "ติดต่อ Support พร้อมแนบบทความนี้" (X3) */
    articleSlug: z.string().trim().max(80).optional(),
    /** เปิดต่อจากผลค้นหาที่ไม่พบ (X2) · นับใน help_search_misses.tickets */
    searchQuery: z.string().trim().max(200).optional(),
  })
  .strict();
export const TicketsQuery = z.object({
  scope: z.enum(['mine', 'workspace']).default('mine'),
  status: z.enum(['active', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const ReplyBody = z
  .object({
    body: z.string().trim().min(1, 'พิมพ์ข้อความ').max(10_000),
    attachments: z.array(Attachment).max(MAX_FILES).default([]),
  })
  .strict();

type Ticket = typeof k.$inferSelect;
type FileRef = { kind: 'file'; key: string; name: string; size: number; mime: string };
type UploadClaims = { k: string; n: string; s: number; m: string; w: string; u: string };
type Row = Record<string, unknown>;
const rowsOf = <T>(r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as T[];

/**
 * A44 · Ticket ที่ลูกค้าเปิดจากในแอป (X5, X6, T12)
 * support_* เป็นตาราง ops_only (ข้อความภายในของทีมต้องไม่หลุดถึงลูกค้า) จึงอ่าน / เขียนผ่าน SYSTEM_DB
 * โดยกรองด้วยผู้ใช้หรือ Workspace ที่ TenantGuard ตรวจสมาชิกแล้วเสมอ และไม่ select ข้อความ internal
 */
@Injectable()
export class HelpTicketsService {
  constructor(
    // ตาราง Support เป็นของหลังบ้าน (ops_only) · ทุก query ในไฟล์นี้กรอง workspace_id / requester_user_id ของผู้ใช้ที่ตรวจแล้ว
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly events: EventBus,
    private readonly mail: Mailer,
    private readonly articles: HelpArticlesService,
    private readonly local: LocalStorage,
    private readonly s3: S3Storage,
  ) {}

  private get driver(): StorageDriver {
    return process.env.S3_BUCKET ? this.s3 : this.local;
  }

  private assertCanContact(tenant: TenantInfo) {
    if (tenant.role === 'guest') throw new AppError(403, 'guest_cannot_contact_support', 'Guest เปิด Ticket ไม่ได้ · ถาม Owner หรือผู้ที่เชิญคุณเข้า Workspace');
  }
  private isAdmin = (tenant: TenantInfo) => tenant.role === 'owner' || tenant.role === 'admin';

  /** Ticket ที่ผู้ใช้เห็น: ของตัวเอง · Owner / Admin เห็นของทั้ง Workspace ยกเว้นหมวดบัญชีส่วนตัวของคนอื่น */
  private visible(auth: AuthInfo, tenant: TenantInfo, scope: 'mine' | 'workspace' = 'workspace'): SQL {
    const mine = sql`${k.requesterUserId} = ${auth.userId}`;
    if (scope === 'mine' || !this.isAdmin(tenant)) return and(eq(k.workspaceId, tenant.workspaceId), mine)!;
    return and(eq(k.workspaceId, tenant.workspaceId), sql`(${mine} or coalesce(${k.category}, '') <> ${PRIVATE_CATEGORY})`)!;
  }

  private async find(auth: AuthInfo, tenant: TenantInfo, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'ticket_not_found', 'ไม่พบ Ticket');
    const [t] = await this.db.select().from(k).where(and(eq(k.id, id), this.visible(auth, tenant)));
    if (!t) throw new AppError(404, 'ticket_not_found', 'ไม่พบ Ticket');
    return t;
  }

  private async plan(workspaceId: string) {
    const [r] = rowsOf<{ plan: string | null; name: string | null }>(
      await this.db.execute(sql`select p.code as plan, p.display_name as name from subscriptions sub join plans p on p.id = sub.plan_id where sub.workspace_id = ${workspaceId} limit 1`),
    );
    const code = r?.plan ?? 'free';
    return { code, name: r?.name ?? PLAN_NAMES[code] ?? code };
  }

  private async reopenDays() {
    return (await loadConfig(this.db)).reopenDays;
  }

  /** ปิดเรื่องไปแล้วเกิน N วัน (ตั้งค่า O22) = เปิดใหม่ไม่ได้ ต้องเปิด Ticket ใหม่ */
  private reopenable(t: Ticket, days: number) {
    const at = t.solvedAt ?? t.closedAt;
    return !!at && Date.now() - at.getTime() <= days * DAY;
  }

  // ── ไฟล์แนบ ────────────────────────────────────────────

  /** ขอลิงก์อัปโหลด (PUT ไปที่ staging) · ส่ง uploadToken กลับมากับ Ticket / ข้อความเพื่อยืนยันไฟล์ */
  async uploadUrl(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof UploadBody>) {
    this.assertCanContact(tenant);
    if (input.size > TICKET_FILE_BYTES) throw new AppError(413, 'file_too_large', 'ไฟล์ใหญ่เกิน 10 MB', { maxBytes: TICKET_FILE_BYTES, size: input.size });
    const storageKey = stagingKeyFor(`support/${tenant.workspaceId}/${randomUUID()}`);
    const target = await this.driver.presignUpload(storageKey, { size: input.size, mime: input.mime });
    const claims: UploadClaims = { k: storageKey, n: input.name, s: input.size, m: input.mime, w: tenant.workspaceId, u: auth.userId };
    return { ...target, uploadToken: signToken('support-upload', claims, 3600), maxBytes: TICKET_FILE_BYTES };
  }

  /** ยืนยันไฟล์ที่อัปโหลดแล้ว: ย้ายจาก staging ไป key ถาวร · token ใช้ได้ครั้งเดียว (staging หายหลังย้าย) */
  private async commitFiles(auth: AuthInfo, tenant: TenantInfo, list: { uploadToken: string }[]): Promise<FileRef[]> {
    const out: FileRef[] = [];
    for (const { uploadToken } of list) {
      const c = verifyToken<UploadClaims>('support-upload', uploadToken);
      if (!c || c.w !== tenant.workspaceId || c.u !== auth.userId || !finalKeyOf(c.k)) throw new AppError(400, 'invalid_upload_token', 'ลิงก์อัปโหลดไม่ถูกต้องหรือหมดอายุ · แนบไฟล์ใหม่อีกครั้ง');
      const st = await this.driver.stat(c.k);
      if (!st || st.size !== c.s) throw new AppError(409, 'upload_incomplete', 'ยังอัปโหลดไฟล์ไม่เสร็จ · ลองแนบใหม่อีกครั้ง');
      const key = finalKeyOf(c.k)!;
      try {
        await this.driver.commit(c.k, key);
      } catch (err) {
        if (err instanceof StagingGone) throw new AppError(409, 'upload_already_used', 'ไฟล์นี้แนบไปแล้ว · แนบใหม่ถ้าต้องการเพิ่ม');
        throw err;
      }
      out.push({ kind: 'file', key, name: c.n, size: c.s, mime: c.m });
    }
    return out;
  }

  // ── รายการ / รายละเอียด ─────────────────────────────────

  /** สถานะที่ลูกค้าเห็น (X6 · T12) · ส่งทีมพัฒนาแล้วรู้จากการผูกงาน (O36) หรือสถานะ pending_dev */
  private async devInfo(ids: string[]) {
    if (!ids.length) return new Map<string, { at: Date; fixed: boolean }>();
    const d = s.devIssueTickets;
    const rows = await this.db.select({ ticketId: d.ticketId, at: d.linkedAt, fixed: sql<boolean>`(${d.outcome} = 'fixed')` }).from(d).where(inArray(d.ticketId, ids));
    return new Map(rows.map((r) => [r.ticketId, { at: new Date(r.at), fixed: !!r.fixed }]));
  }

  private dto(t: Ticket, auth: AuthInfo, extra: { requesterName?: string | null; lastMessageAt?: Date | null; dev?: { at: Date; fixed: boolean } | null; reopenDays: number }) {
    const closed = t.status === 'solved' || t.status === 'closed';
    return {
      id: t.id,
      number: t.number,
      subject: t.subject,
      category: t.category,
      status: t.status,
      mine: t.requesterUserId === auth.userId,
      requester: t.requesterUserId ? { id: t.requesterUserId, name: extra.requesterName ?? null } : null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      lastMessageAt: extra.lastMessageAt ?? t.updatedAt,
      firstResponseDueAt: t.firstRespondedAt ? null : t.firstResponseDueAt,
      firstRespondedAt: t.firstRespondedAt,
      solvedAt: t.solvedAt,
      closedAt: t.closedAt,
      /** ส่งทีมพัฒนาแล้ว (ไม่บอกเลขงานของทีมพัฒนา) · fixedAt = แจ้งลูกค้าว่าแก้แล้ว */
      dev: extra.dev ? { sentAt: extra.dev.at, fixed: extra.dev.fixed } : t.status === 'pending_dev' ? { sentAt: null, fixed: false } : null,
      canReply: t.status !== 'closed' && (t.status !== 'solved' || this.reopenable(t, extra.reopenDays)),
      canClose: !closed || t.status === 'solved',
      canReopen: closed && this.reopenable(t, extra.reopenDays),
    };
  }

  async list(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof TicketsQuery>) {
    if (q.scope === 'workspace' && !this.isAdmin(tenant)) throw new AppError(403, 'forbidden', 'ดู Ticket ของทั้ง Workspace ได้เฉพาะ Owner และ Admin', { permission: 'ws.settings' });
    const plan = await this.plan(tenant.workspaceId);
    const cfg = await loadConfig(this.db);
    const sla = cfg.sla[plan.code] ?? cfg.sla.free;
    const meta = {
      canContact: tenant.role !== 'guest',
      canViewWorkspace: this.isAdmin(tenant),
      plan: { code: plan.code, name: plan.name },
      sla: { first: sla.first, resolve: sla.resolve },
    };
    if (tenant.role === 'guest') return { items: [], openMine: 0, ...meta };
    const rows = await this.db
      .select({ t: k, requesterName: s.users.displayName, lastMessageAt: sql<Date | null>`(select max(m.created_at) from support_ticket_messages m where m.ticket_id = ${k.id} and not m.internal)` })
      .from(k)
      .leftJoin(s.users, eq(s.users.id, k.requesterUserId))
      .where(and(this.visible(auth, tenant, q.scope), q.status === 'active' ? sql`${k.status} in ('open', 'pending_customer', 'pending_dev')` : undefined))
      .orderBy(sql`(${k.status} in ('open', 'pending_customer', 'pending_dev')) desc`, sql`${k.updatedAt} desc`)
      .limit(q.limit);
    const dev = await this.devInfo(rows.map((r) => r.t.id));
    const [open] = rowsOf<{ n: number }>(
      await this.db.execute(sql`select count(*)::int as n from support_tickets where workspace_id = ${tenant.workspaceId} and requester_user_id = ${auth.userId} and status in ('open', 'pending_customer', 'pending_dev')`),
    );
    return {
      items: rows.map((r) => this.dto(r.t, auth, { requesterName: r.requesterName, lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt) : null, dev: dev.get(r.t.id) ?? null, reopenDays: cfg.reopenDays })),
      openMine: open?.n ?? 0,
      ...meta,
    };
  }

  /** รายละเอียด + ข้อความที่ลูกค้าเห็น (ไม่รวมบันทึกภายใน) · ชื่อพนักงานแสดงเป็น "ทีม Friday" */
  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    const t = await this.find(auth, tenant, id);
    const msgs = await this.db
      .select({ id: s.supportTicketMessages.id, authorKind: s.supportTicketMessages.authorKind, authorUserId: s.supportTicketMessages.authorUserId, body: s.supportTicketMessages.body, attachments: s.supportTicketMessages.attachments, createdAt: s.supportTicketMessages.createdAt, authorName: s.users.displayName })
      .from(s.supportTicketMessages)
      .leftJoin(s.users, eq(s.users.id, s.supportTicketMessages.authorUserId))
      .where(and(eq(s.supportTicketMessages.ticketId, t.id), eq(s.supportTicketMessages.internal, false)))
      .orderBy(asc(s.supportTicketMessages.createdAt));
    const [requester] = t.requesterUserId ? await this.db.select({ name: s.users.displayName }).from(s.users).where(eq(s.users.id, t.requesterUserId)) : [];
    const dev = (await this.devInfo([t.id])).get(t.id) ?? null;
    const messages = [];
    for (const m of msgs) {
      const list = Array.isArray(m.attachments) ? (m.attachments as Row[]) : [];
      const files = [];
      for (const f of list.filter((x) => x.kind === 'file' && typeof x.key === 'string' && String(x.key).startsWith(`support/${tenant.workspaceId}/`))) {
        const url = await this.driver.presignDownload(String(f.key), { filename: String(f.name ?? 'file'), mime: String(f.mime ?? 'application/octet-stream') });
        files.push({ name: f.name, size: f.size, mime: f.mime, url });
      }
      const context = list.find((x) => x.kind === 'context') ?? null;
      const article = list.find((x) => x.kind === 'article') ?? null;
      messages.push({
        id: m.id,
        author: m.authorKind === 'customer' ? (m.authorUserId === auth.userId ? 'me' : 'customer') : m.authorKind,
        // ลูกค้าไม่เห็นชื่อพนักงาน (06-ops-roles) · เห็นเป็น "ทีม Friday"
        authorName: m.authorKind === 'customer' ? (m.authorName ?? null) : null,
        body: m.body,
        createdAt: m.createdAt,
        files,
        context: context ? { page: context.page ?? null, requestId: context.requestId ?? null, impact: context.impact ?? null } : null,
        article: article ? { slug: article.slug, title: article.title } : null,
      });
    }
    return { ticket: this.dto(t, auth, { requesterName: requester?.name ?? null, dev, reopenDays: await this.reopenDays() }), messages };
  }

  // ── สร้าง / ตอบ / ปิด / เปิดใหม่ ─────────────────────────

  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateTicketBody>) {
    this.assertCanContact(tenant);
    const [user] = await this.db.select({ email: s.users.email, name: s.users.displayName }).from(s.users).where(eq(s.users.id, auth.userId));
    const article = input.articleSlug ? await this.articles.find(auth, input.articleSlug) : null;
    if (input.articleSlug && !article) throw new AppError(404, 'help_article_not_found', 'ไม่พบบทความที่แนบ');
    const plan = await this.plan(tenant.workspaceId);
    const cfg = await loadConfig(this.db);
    const route = await routeTicket(this.db, cfg, { plan: plan.code, category: input.category, workspaceId: tenant.workspaceId, minPriority: input.impact === 'me' ? undefined : 'high' });
    const now = new Date();
    const due = await dueOf(this.db, cfg, plan.code, route.priority, now);
    const files = await this.commitFiles(auth, tenant, input.attachments);
    const attachments: Row[] = [...files];
    if (input.context || input.impact !== 'me') attachments.push({ kind: 'context', page: input.context?.page ?? null, path: input.context?.path ?? null, requestId: input.context?.requestId ?? null, impact: input.impact });
    if (article) attachments.push({ kind: 'article', slug: article.slug, title: article.title });
    const t = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(k)
        .values({
          workspaceId: tenant.workspaceId, requesterUserId: auth.userId, requesterEmail: user?.email ?? null, channel: 'in_app', category: input.category,
          priority: route.priority, subject: input.subject, assigneeId: route.assigneeId, ruleId: route.ruleId,
          firstResponseDueAt: due.first, resolutionDueAt: due.resolve,
        })
        .returning();
      await tx.insert(s.supportTicketMessages).values({ ticketId: row.id, authorKind: 'customer', authorUserId: auth.userId, body: input.body, attachments });
      if (article) await tx.insert(s.helpArticleTickets).values({ articleId: article.id, ticketId: row.id, source: 'customer' }).onConflictDoNothing();
      // เปิด Ticket ต่อจากคำค้นที่ไม่พบ: นับในแถวล่าสุดของคำนั้น (การ์ด "คำค้นที่ไม่พบบ่อย" ของ O35)
      if (input.searchQuery) {
        await tx.execute(sql`
          update help_search_misses set tickets = tickets + 1
          where (day, query) = (select day, query from help_search_misses where query = app.help_search_key(${input.searchQuery}) order by day desc limit 1)`);
      }
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'support.ticket_created', targetType: 'support_ticket', targetId: row.id, summary: `เปิด Ticket #${row.number} ถึงทีม Friday · ${input.subject}` });
      return row;
    });
    await this.events.publish({ type: 'support.ticket_created', workspaceId: tenant.workspaceId, actorId: auth.userId, data: { ticketId: t.id, number: t.number, subject: t.subject, category: t.category }, at: now });
    const when = !due.sla.first ? '' : due.open ? `\nทีม Support จะตอบภายใน ${due.sla.first.n} ${due.sla.first.unit === 'h' ? 'ชั่วโมง' : 'วัน'}ทำการ` : '\nตอนนี้อยู่นอกเวลาทำการ ทีมจะตอบในวันทำการถัดไป';
    const link = `${webUrl()}/work/${encodeURIComponent(tenant.slug)}/help/tickets?ticket=${t.id}`;
    let emailed = false;
    if (user?.email) {
      try {
        await this.mail.send({ to: user.email, subject: `[#${t.number}] ได้รับเรื่องแล้ว: ${t.subject}`, text: `สวัสดีคุณ${user.name ?? ''}\nทีม Friday ได้รับเรื่องของคุณแล้ว เลขที่ #${t.number}${when}\n\nดูและตอบได้ที่ ${link}` });
        emailed = true;
      } catch {
        // อีเมลล้มไม่ให้การเปิด Ticket ล้ม (ลูกค้าเห็นเลขในหน้าส่งแล้ว)
      }
    }
    return { ticket: this.dto(t, auth, { requesterName: user?.name ?? null, reopenDays: cfg.reopenDays }), sla: { first: due.sla.first, open: due.open }, emailed };
  }

  /**
   * ลูกค้าตอบในแอป · กติกาเดียวกับ ops-api (TicketsService.customerReplied): รอลูกค้า → เปิด · แก้แล้วไม่เกิน N วัน → เปิดใหม่
   * รอทีมพัฒนาคงสถานะเดิม · ปิดถาวรแล้ว → 409 ให้กดเปิดใหม่หรือเปิด Ticket ใหม่
   */
  async reply(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof ReplyBody>) {
    this.assertCanContact(tenant);
    const t = await this.find(auth, tenant, id);
    const days = await this.reopenDays();
    if (t.status === 'closed' || (t.status === 'solved' && !this.reopenable(t, days))) throw new AppError(409, 'ticket_closed', 'เรื่องนี้ปิดแล้ว · กดเปิดใหม่หรือเปิด Ticket ใหม่');
    const files = await this.commitFiles(auth, tenant, input.attachments);
    const status = t.status === 'pending_dev' || t.status === 'open' ? t.status : 'open';
    const m = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'customer', authorUserId: auth.userId, body: input.body, attachments: files }).returning();
      await tx.update(k).set({ status, solvedAt: status === 'open' ? null : t.solvedAt, updatedAt: new Date() }).where(eq(k.id, t.id));
      return row;
    });
    return { message: { id: m.id, createdAt: m.createdAt }, status, reopened: t.status === 'solved' };
  }

  /** "แก้แล้ว ขอบคุณ" / "ปิดเรื่องนี้" · ปิดเองแล้วเปิดใหม่ได้ภายใน N วัน */
  async close(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.assertCanContact(tenant);
    const t = await this.find(auth, tenant, id);
    if (t.status === 'closed') throw new AppError(409, 'ticket_closed', 'เรื่องนี้ปิดแล้ว');
    const now = new Date();
    await this.db.update(k).set({ status: 'closed', closedAt: now, solvedAt: t.solvedAt ?? now, updatedAt: now }).where(eq(k.id, t.id));
    return { id: t.id, status: 'closed' as const };
  }

  /** "ยังพบปัญหาอยู่" · เปิดใหม่ที่คนเดิมภายใน N วันหลังปิด (ตั้งค่า O22) */
  async reopen(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.assertCanContact(tenant);
    const t = await this.find(auth, tenant, id);
    if (t.status !== 'solved' && t.status !== 'closed') throw new AppError(409, 'ticket_open', 'เรื่องนี้ยังเปิดอยู่');
    if (!this.reopenable(t, await this.reopenDays())) throw new AppError(409, 'ticket_closed', 'ปิดเรื่องนานเกินกำหนดแล้ว · เปิด Ticket ใหม่แทน');
    await this.db.update(k).set({ status: 'open', solvedAt: null, closedAt: null, updatedAt: new Date() }).where(eq(k.id, t.id));
    return { id: t.id, status: 'open' as const };
  }
}
