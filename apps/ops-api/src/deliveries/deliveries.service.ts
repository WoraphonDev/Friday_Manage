import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const d = s.notificationDeliveries;
const HOUR = 3_600_000;
/** API ลูกค้าลองส่งรวมกี่ครั้ง (JOB_ATTEMPTS ใน apps/api/src/queue/jobs.ts) */
const ATTEMPTS = 4;

export const STATUSES = ['ok', 'fail', 'retry', 'quiet', 'blocked', 'queued'] as const;
export type UiStatus = (typeof STATUSES)[number];
export const CHANNELS = ['email', 'line', 'webhook'] as const;

export const ListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(['ok', 'fail', 'quiet', 'blocked']).optional(),
  workspaceId: z.uuid().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const ResendBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();
export const AttachBody = z.object({ ticketNumber: z.coerce.number().int().positive() }).strict();
export const SuppressionQuery = z.object({ q: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const RemoveBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

interface LogEntry {
  at: string;
  kind: string;
  attempt?: number;
  status?: number | null;
  message?: string;
  final?: boolean;
}
type Row = typeof d.$inferSelect;

/** สถานะที่หน้าจอใช้ (Canvas: ส่งถึง / ล้ม / กำลังลองใหม่ / รอช่วงงดส่ง / ถูกบล็อก) */
export function uiStatus(r: Pick<Row, 'status' | 'attempts' | 'log' | 'resendRequestedAt'>): UiStatus {
  const log = (r.log ?? []) as LogEntry[];
  switch (r.status) {
    case 'sent':
      return 'ok';
    case 'skipped_quiet_hours':
      return 'quiet';
    case 'suppressed':
      return 'blocked';
    case 'queued':
      return r.attempts > 0 || r.resendRequestedAt ? 'retry' : 'queued';
    default: {
      const last = [...log].reverse().find((e) => e.kind === 'attempt_failed' || e.kind === 'cancelled');
      if (last?.kind === 'cancelled') return 'blocked';
      return !last || last.final || r.attempts >= ATTEMPTS ? 'fail' : 'retry';
    }
  }
}

/** เงื่อนไข SQL ของสถานะที่หน้าจอกรอง */
function statusWhere(st: z.infer<typeof ListQuery>['status']): SQL | undefined {
  switch (st) {
    case 'ok':
      return eq(d.status, 'sent');
    case 'quiet':
      return eq(d.status, 'skipped_quiet_hours');
    case 'blocked':
      return or(eq(d.status, 'suppressed'), and(eq(d.status, 'failed'), sql`${d.log} @> '[{"kind":"cancelled"}]'::jsonb`));
    case 'fail':
      return and(eq(d.status, 'failed'), sql`NOT (${d.log} @> '[{"kind":"cancelled"}]'::jsonb)`);
    default:
      return undefined;
  }
}

/** อีเมลลูกค้า: วิศวกรเห็นแบบซ่อน (06 › 2 · วิศวกรไม่เห็นอีเมลลูกค้า) */
export const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1•••$2');
const seesEmail = (staff: Staff) => has(staff, 'owner', 'support');

/**
 * ประวัติการส่งแจ้งเตือนออกนอกแอป และรายชื่อไม่ส่งอีเมล (O23 · Canvas › Deliveries, Y6, Y7)
 * อ่านได้: Owner, Support, วิศวกร · เนื้อหาที่ส่ง (Y6) เห็นเฉพาะ Owner / Support และเมื่อลูกค้าเปิดสิทธิ์ให้ทีม Friday เข้าช่วยเหลือ
 */
@Injectable()
export class DeliveriesService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  async list(staff: Staff, q: z.infer<typeof ListQuery>) {
    const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const where = and(
      q.channel ? (q.channel === 'line' ? inArray(d.channel, ['line', 'line_group']) : eq(d.channel, q.channel)) : undefined,
      statusWhere(q.status),
      q.workspaceId ? eq(d.workspaceId, q.workspaceId) : undefined,
      q.before ? lt(d.createdAt, new Date(q.before)) : undefined,
      like
        ? or(
            // ชื่อปลายทางของอีเมลคืออีเมลเอง · วิศวกรค้นด้วยอีเมลไม่ได้
            seesEmail(staff) ? ilike(d.targetLabel, like) : and(ilike(d.targetLabel, like), sql`${d.channel} <> 'email'`),
            seesEmail(staff) ? ilike(d.targetRef, like) : undefined,
            ilike(s.workspaces.name, like),
            ilike(s.workspaces.slug, like),
            sql`${s.notifications.payload}->>'issueKey' ILIKE ${like}`,
            sql`${d.id}::text ILIKE ${like}`,
          )
        : undefined,
    );
    const rows = await this.db
      .select({ d, ws: { id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug }, eventType: s.notifications.eventType, issueKey: sql<string | null>`${s.notifications.payload}->>'issueKey'` })
      .from(d)
      .innerJoin(s.workspaces, eq(s.workspaces.id, d.workspaceId))
      .innerJoin(s.notifications, eq(s.notifications.id, d.notificationId))
      .where(where)
      .orderBy(desc(d.createdAt), desc(d.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      stats: await this.stats(),
      items: page.map((r) => ({
        id: r.d.id,
        createdAt: r.d.createdAt,
        channel: r.d.channel,
        to: this.label(staff, r.d),
        workspace: r.ws,
        event: { type: r.eventType, issueKey: r.issueKey },
        status: uiStatus(r.d),
        attempts: r.d.attempts,
      })),
      nextBefore: rows.length > q.limit ? page.at(-1)!.d.createdAt : null,
    };
  }

  private label(staff: Staff, r: Pick<Row, 'channel' | 'targetLabel' | 'targetRef'>) {
    const label = r.targetLabel ?? (r.channel === 'email' ? r.targetRef : r.channel);
    return r.channel === 'email' && !seesEmail(staff) ? maskEmail(label) : label;
  }

  /** สรุป 24 ชั่วโมง (การ์ดด้านบน) */
  async stats(now = new Date()) {
    const since = new Date(now.getTime() - 24 * HOUR);
    const r = await this.db.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where channel = 'email')::int as email,
        count(*) filter (where channel in ('line', 'line_group'))::int as line,
        count(*) filter (where channel = 'webhook')::int as webhook,
        count(*) filter (where status = 'sent')::int as sent,
        count(*) filter (where status = 'sent' and channel = 'email')::int as "emailSent",
        count(*) filter (where status = 'failed' and not (log @> '[{"kind":"cancelled"}]'::jsonb))::int as failed,
        count(*) filter (where status = 'failed' and channel = 'email' and not (log @> '[{"kind":"cancelled"}]'::jsonb))::int as "failedEmail",
        count(*) filter (where status = 'failed' and channel in ('line', 'line_group') and not (log @> '[{"kind":"cancelled"}]'::jsonb))::int as "failedLine",
        count(*) filter (where status = 'failed' and channel = 'webhook')::int as "failedWebhook",
        count(*) filter (where status = 'suppressed')::int as suppressed
      from notification_deliveries where created_at >= ${since}`);
    const x = r.rows[0] as Record<string, number>;
    const [q] = (await this.db.execute(sql`select count(*)::int as n from notification_deliveries where status = 'skipped_quiet_hours'`)).rows as { n: number }[];
    const [fb] = (await this.db.execute(sql`select count(*)::int as n from email_feedback_events where kind in ('bounce_permanent', 'complaint') and created_at >= ${since}`)).rows as { n: number }[];
    const done = x.sent + x.failed;
    return {
      total: x.total,
      byChannel: { email: x.email, line: x.line, webhook: x.webhook },
      deliveredPct: done ? Math.round((x.sent / done) * 1000) / 10 : null,
      failed: { total: x.failed, email: x.failedEmail, line: x.failedLine, webhook: x.failedWebhook },
      waitingQuiet: q.n,
      suppressed: x.suppressed,
      /** bounce ถาวร + รายงานสแปม ต่ออีเมลที่ส่ง · ผู้ให้บริการเริ่มเตือนราว 2% (Canvas) */
      bouncePct: x.emailSent ? Math.round((fb.n / x.emailSent) * 1000) / 10 : null,
    };
  }

  async detail(staff: Staff, id: string) {
    const row = await this.load(id);
    const [ws] = await this.db.select({ id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug }).from(s.workspaces).where(eq(s.workspaces.id, row.workspaceId));
    const [n] = await this.db.select({ eventType: s.notifications.eventType, payload: s.notifications.payload, projectId: s.notifications.projectId }).from(s.notifications).where(eq(s.notifications.id, row.notificationId));
    const [project] = n?.projectId ? await this.db.select({ key: s.projects.key }).from(s.projects).where(eq(s.projects.id, n.projectId)) : [];
    const hook = row.channel === 'webhook' ? (await this.db.select({ id: s.webhookEndpoints.id, name: s.webhookEndpoints.name, status: s.webhookEndpoints.status }).from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, row.targetRef)))[0] ?? null : null;
    const access = await this.contentAccess(staff, row.workspaceId);
    const content = row.content as { view?: unknown; request?: { body?: string } & Record<string, unknown> } | null;
    const suppression = row.channel === 'email' ? await this.activeSuppression(row.targetRef) : null;
    return {
      id: row.id,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      channel: row.channel,
      to: this.label(staff, row),
      workspace: ws ?? null,
      event: { type: n?.eventType ?? null, issueKey: ((n?.payload ?? {}) as Record<string, unknown>).issueKey ?? null, projectKey: project?.key ?? null },
      status: uiStatus(row),
      attempts: row.attempts,
      lastError: row.lastError,
      response: row.response,
      log: row.log,
      webhook: hook,
      suppression: suppression ? { id: suppression.id, reason: suppression.reason, since: suppression.createdAt } : null,
      // เนื้อหางานของลูกค้า: แสดงเฉพาะเมื่อมีสิทธิ์เข้าบัญชี (Y6) · ส่วนหัวคำขอแสดงได้เสมอ (URL ซ่อน token แล้ว)
      content: content
        ? access.allowed
          ? content
          : { view: null, request: content.request ? { ...content.request, body: null } : undefined }
        : null,
      contentAccess: access,
      canResend: (row.status === 'failed' || row.status === 'suppressed') && !suppression && !row.resendRequestedAt,
      resendRequested: !!row.resendRequestedAt,
    };
  }

  /** เห็นเนื้อหาที่ส่งได้ไหม: Owner / Support และลูกค้าเปิดสิทธิ์ช่วยเหลือที่ยังไม่หมดอายุ */
  private async contentAccess(staff: Staff, workspaceId: string): Promise<{ allowed: boolean; reason: 'role' | 'no_grant' | null }> {
    if (!has(staff, 'owner', 'support')) return { allowed: false, reason: 'role' };
    const [g] = await this.db.select({ until: s.supportAccessGrants.until }).from(s.supportAccessGrants).where(eq(s.supportAccessGrants.workspaceId, workspaceId));
    if (!g || (g.until && g.until.getTime() < Date.now())) return { allowed: false, reason: 'no_grant' };
    return { allowed: true, reason: null };
  }

  /** ขอให้ API ลูกค้าส่งซ้ำ (งาน scan หยิบภายใน 1 นาที) · เฉพาะที่ล้ม / ไม่ได้ส่งเพราะรายชื่อไม่ส่ง และอีเมลไม่อยู่ในรายชื่อแล้ว */
  async resend(staff: Staff, id: string, input: z.infer<typeof ResendBody>) {
    const row = await this.load(id);
    if (row.status !== 'failed' && row.status !== 'suppressed') throw new AppError(409, 'not_resendable', 'ส่งซ้ำได้เฉพาะรายการที่ล้มหรือไม่ได้ส่ง', { status: row.status });
    if (row.channel === 'email' && (await this.activeSuppression(row.targetRef))) throw new AppError(409, 'email_suppressed', 'อีเมลนี้ยังอยู่ในรายชื่อไม่ส่ง · เอาออกจากรายการก่อน');
    const entry: LogEntry = { at: new Date().toISOString(), kind: 'resend', message: `${staff.name}${input.reason ? ` · ${input.reason}` : ''}` };
    await this.db.transaction(async (tx) => {
      const [u] = await tx
        .update(d)
        .set({ status: 'queued', resendRequestedAt: new Date(), log: sql`${d.log} || ${JSON.stringify([entry])}::jsonb` })
        .where(and(eq(d.id, id), isNull(d.resendRequestedAt), inArray(d.status, ['failed', 'suppressed'])))
        .returning({ id: d.id });
      if (!u) throw new AppError(409, 'resend_pending', 'มีคำขอส่งซ้ำอยู่แล้ว');
      await audit(tx, staff, row.workspaceId, 'notify', 'ops.delivery_resend', `ขอส่งแจ้งเตือนซ้ำ (${row.channel})${input.reason ? ` · ${input.reason}` : ''}`, { type: 'notification_delivery', id });
    });
    return { id, status: 'retry' as const, resendRequested: true };
  }

  /** แนบสรุปการส่งเป็นข้อความภายในของ Ticket (ลูกค้าไม่เห็น) */
  async attach(staff: Staff, id: string, input: z.infer<typeof AttachBody>) {
    const row = await this.load(id);
    const [t] = await this.db.select({ id: s.supportTickets.id, number: s.supportTickets.number }).from(s.supportTickets).where(eq(s.supportTickets.number, input.ticketNumber));
    if (!t) throw new AppError(404, 'not_found', `ไม่พบ Ticket #${input.ticketNumber}`);
    const res = row.response as { status?: number | null; body?: string | null } | null;
    const body = [
      `แนบประวัติการส่ง ${row.id}`,
      `${row.channel} ถึง ${this.label(staff, row)} · สถานะ ${uiStatus(row)} · ลอง ${row.attempts} ครั้ง`,
      res ? `คำตอบจากปลายทาง: HTTP ${res.status ?? '—'} ${res.body ?? ''}`.trim() : null,
      row.lastError ? `เหตุผล: ${row.lastError}` : null,
      `ดูต่อ: /deliveries?id=${row.id}`,
    ]
      .filter(Boolean)
      .join('\n');
    await this.db.transaction(async (tx) => {
      await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'staff', authorStaffId: staff.id, internal: true, body });
      await staffAudit(tx, staff, 'deliveries.attached_to_ticket', `แนบการส่ง ${row.id} ใน Ticket #${t.number}`, { type: 'support_ticket', id: t.id }, row.workspaceId);
    });
    return { ticketId: t.id, ticketNumber: t.number };
  }

  // ---------------------------------------------------------------------------
  // รายชื่อไม่ส่งอีเมล

  async suppressions(staff: Staff, q: z.infer<typeof SuppressionQuery>) {
    const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.db
      .select({ x: s.emailSuppressions, ws: { id: s.workspaces.id, name: s.workspaces.name } })
      .from(s.emailSuppressions)
      .leftJoin(s.workspaces, eq(s.workspaces.id, s.emailSuppressions.workspaceId))
      .where(and(isNull(s.emailSuppressions.removedAt), like ? or(seesEmail(staff) ? ilike(s.emailSuppressions.email, like) : undefined, ilike(s.workspaces.name, like)) : undefined))
      .orderBy(desc(s.emailSuppressions.createdAt))
      .limit(q.limit);
    return {
      items: rows.map((r) => ({
        id: r.x.id,
        email: seesEmail(staff) ? r.x.email : maskEmail(r.x.email),
        reason: r.x.reason,
        detail: r.x.detail,
        source: r.x.source,
        workspace: r.ws?.id ? r.ws : null,
        since: r.x.createdAt,
      })),
    };
  }

  /** Y7 · เอาออกเมื่อลูกค้ายืนยันว่าแก้แล้ว · เก็บแถวไว้พร้อมเหตุผล */
  async removeSuppression(staff: Staff, id: string, input: z.infer<typeof RemoveBody>) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการ');
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .update(s.emailSuppressions)
        .set({ removedAt: new Date(), removedBy: staff.id, removeReason: input.reason })
        .where(and(eq(s.emailSuppressions.id, id), isNull(s.emailSuppressions.removedAt)))
        .returning();
      if (!r) throw new AppError(404, 'not_found', 'ไม่พบรายการ หรือเอาออกไปแล้ว');
      // ลูกค้าเห็นใน Audit log ว่าทีม Friday เปิดส่งอีเมลถึงสมาชิกคนนี้อีกครั้ง
      if (r.workspaceId) await audit(tx, staff, r.workspaceId, 'notify', 'ops.email_unsuppressed', `เอา ${r.email} ออกจากรายชื่อไม่ส่งอีเมล · ${input.reason}`, { type: 'email_suppression', id });
      else await staffAudit(tx, staff, 'ops.email_unsuppressed', `เอา ${r.email} ออกจากรายชื่อไม่ส่งอีเมล · ${input.reason}`, { type: 'email_suppression', id });
      return { id, removed: true };
    });
  }

  private async activeSuppression(email: string) {
    const [r] = await this.db.select().from(s.emailSuppressions).where(and(sql`lower(${s.emailSuppressions.email}) = lower(${email})`, isNull(s.emailSuppressions.removedAt)));
    return r ?? null;
  }

  private async load(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการส่ง');
    const [row] = await this.db.select().from(d).where(eq(d.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบรายการส่ง (อาจเก่ากว่า 90 วันและถูกลบแล้ว)');
    return row;
  }
}
