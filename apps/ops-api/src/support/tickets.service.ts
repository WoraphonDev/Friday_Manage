import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { buyerKey } from '../workspaces/test-flag.js';
import { audit, staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { BusinessClock } from './clock.js';
import { PresenceService } from './presence.service.js';
import { SLA_WARN_PCT, SupportSettingsService } from './settings.service.js';

const s = schema;
const DAY = 86_400_000;
type Row = Record<string, unknown>;
type Ticket = typeof s.supportTickets.$inferSelect;

const BREACHED = sql`(k.status in ('open', 'pending_dev') and ((k.first_responded_at is null and k.first_response_due_at < now()) or k.resolution_due_at < now()))`;
const ORDERS = {
  sla: sql`${BREACHED} desc, (k.priority = 'urgent') desc, (k.priority = 'high') desc, coalesce(k.first_response_due_at, k.created_at), k.number`,
  newest: sql`k.created_at desc, k.number desc`,
  waiting: sql`k.updated_at asc, k.number`,
  priority: sql`(k.priority = 'urgent') desc, (k.priority = 'high') desc, (k.priority = 'normal') desc, coalesce(k.first_response_due_at, k.created_at), k.number`,
};

/** บวกชั่วโมงทำการตามค่าเริ่มต้น (จ.–ศ. 09:00–18:00 เวลาไทย ไม่นับวันหยุด) · SLA จริงใช้เวลาทำการที่ตั้งใน O22 */
export const addBusinessHours = (start: Date, hours: number) => new BusinessClock().addHours(start, hours);

const Priority = z.enum(['low', 'normal', 'high', 'urgent']);
/** "a,b" → ["a","b"] (ว่าง = ไม่กรอง) */
const list = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item).max(50) as unknown as z.ZodType<z.output<T>[], string[]>)
    .optional();
export const TicketsQuery = z.object({
  status: z.enum(['open', 'pending_customer', 'pending_dev', 'solved', 'closed', 'active']).default('active'),
  /** me = ของฉัน · none = คิวกลาง (ยังไม่มีคนรับ) */
  assignee: z.union([z.enum(['me', 'none']), z.uuid()]).optional(),
  workspaceId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  // ---- ช่วง 3: ตัวกรองเพิ่ม (หลายค่าส่งคั่นด้วยจุลภาค)
  assignees: list(z.uuid()),
  priority: list(Priority),
  category: list(z.string().trim().max(40)),
  channel: list(z.enum(['email', 'phone', 'line', 'in_app'])),
  /** breached = เกิน SLA · soon = เหลือไม่ถึง 1 ชม. · today = ครบกำหนดวันนี้ */
  sla: z.enum(['breached', 'soon', 'today']).optional(),
  plan: list(z.enum(['free', 'team_s', 'team_m', 'team_l', 'enterprise'])),
  buyer: z.string().trim().max(80).optional(),
  account: z.uuid().optional(),
  created: z.coerce.number().pipe(z.union([z.literal(1), z.literal(7), z.literal(30)])).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  /** เงียบนานเกิน (ชั่วโมง): 24 · 72 · 168 */
  quiet: z.coerce.number().pipe(z.union([z.literal(24), z.literal(72), z.literal(168)])).optional(),
  /** ผูกกับเหตุขัดข้อง (รหัส) หรือ none */
  incident: z.union([z.uuid(), z.literal('none')]).optional(),
  /** ความพึงพอใจ (เรื่องที่แก้แล้ว): low 1–2 · high 4–5 · none ยังไม่ตอบ */
  csat: z.enum(['low', 'high', 'none']).optional(),
  /** sla = SLA ใกล้หมดก่อน (ค่าเริ่มต้น) · newest · waiting = รอนานสุด · priority */
  sort: z.enum(['sla', 'newest', 'waiting', 'priority']).default('sla'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const CreateTicketBody = z
  .object({
    workspaceId: z.uuid().optional(),
    requesterEmail: z.email().trim().toLowerCase(),
    channel: z.enum(['email', 'phone', 'line', 'in_app']).default('phone'),
    /** รหัสใน TICKET_CATEGORIES · ข้อความอื่นรับได้ (Ticket เก่า) แต่จะไม่ตรงกฎแยกตามประเภท */
    category: z.string().trim().max(40).optional(),
    /** ไม่ระบุ = ตามกฎการแจกงาน (O22) */
    priority: Priority.optional(),
    subject: z.string().trim().min(3).max(200),
    body: z.string().trim().min(1).max(10_000),
    /** รับเองเลย · ไม่ระบุ = แจกตามกฎ (O22) หรือเข้าคิวกลาง */
    assignToMe: z.boolean().default(false),
    notify: z.boolean().default(true),
  })
  .strict();
export const MessageBody = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    internal: z.boolean().default(false),
    /** บันทึกข้อความที่ลูกค้าส่งมาทางอีเมล / โทร / LINE (ทีมพิมพ์แทน) */
    fromCustomer: z.boolean().default(false),
  })
  .strict()
  .refine((b) => !(b.internal && b.fromCustomer), { message: 'ข้อความของลูกค้าเป็นบันทึกภายในไม่ได้', path: ['internal'] });
export const AssignBody = z.object({ staffId: z.uuid(), note: z.string().trim().max(1000).optional() }).strict();
export const EscalateBody = z
  .object({
    severity: z.enum(['S1', 'S2', 'S3', 'S4']),
    steps: z.string().trim().min(10).max(5000),
    affected: z.string().trim().max(200).optional(),
    requestId: z.string().trim().max(80).optional(),
    notifyCustomer: z.boolean().default(true),
    /** งานในโปรเจกต์ FM ที่สร้าง / ผูกแล้ว (O36 · dev-bridge เรียก) · ใส่ในบันทึกภายใน */
    devIssueKey: z.string().trim().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,9}$/).optional(),
  })
  .strict();
export const SolveBody = z
  .object({
    outcome: z.string().trim().min(3).max(500),
    /** สาเหตุจริง · ใช้ทำรายงานเรื่องที่ถูกถามบ่อย */
    cause: z.string().trim().min(3).max(200),
    sendCsat: z.boolean().default(true),
  })
  .strict();
export const CsatBody = z.object({ score: z.number().int().min(1).max(5) }).strict();

/**
 * Ticket ของ Support (O04) · แจกตามกฎและวิธีแจกที่ตั้งไว้ (O22) · ยังไม่มีคนรับ = อยู่ในคิวกลาง ใครก็ "รับเรื่องนี้" ได้
 * ข้อความถึงลูกค้าส่งทางอีเมล · บันทึกภายในลูกค้าไม่เห็น · การกระทำที่ผูก Workspace ลง audit_logs ของ Workspace นั้นด้วย
 */
@Injectable()
export class TicketsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsTickets');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly settings: SupportSettingsService,
    private readonly presence: PresenceService,
  ) {}

  onModuleInit() {
    // ปิดถาวรเรื่องที่แก้แล้วเกินกำหนด + เตือน SLA ทุก 5 นาที (ทำซ้ำได้) · test เรียกเอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      let n = 0;
      this.timer = setInterval(() => {
        void this.slaTick().catch((e) => this.log.error(String(e)));
        if (n++ % 12 === 0) void this.closeStale().catch((e) => this.log.error(String(e)));
      }, 300_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    const [t] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id));
    if (!t) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    return t;
  }
  private open(t: Ticket) {
    if (t.status === 'closed') throw new AppError(409, 'ticket_closed', 'Ticket นี้ปิดถาวรแล้ว เปิด Ticket ใหม่แทน');
  }
  private requester = (t: Ticket) => t.requesterEmail;
  private async trace(t: Ticket, staff: Staff, action: string, summary: string) {
    if (t.workspaceId) await audit(this.db, staff, t.workspaceId, 'data', action, `#${t.number} · ${summary}`, { type: 'support_ticket', id: t.id });
    else await staffAudit(this.db, staff, action, `#${t.number} · ${summary}`, { type: 'support_ticket', id: t.id });
  }
  private async email(to: string | null, subject: string, text: string) {
    if (!to) return false;
    try {
      await this.mail.send({ to, subject, text });
      return true;
    } catch {
      return false;
    }
  }

  /** สรุปหัวหน้าจอ: เปิดอยู่ / ยังไม่มีคนรับ / เกิน SLA / ตอบครั้งแรกเฉลี่ย 30 วัน / ความพึงพอใจ */
  private async summary() {
    const [r] = await this.rows<Row>(sql`
      select
        count(*) filter (where status in ('open', 'pending_customer', 'pending_dev'))::int as open,
        count(*) filter (where status = 'open' and assignee_id is null)::int as unassigned,
        count(*) filter (where status in ('open', 'pending_dev') and ((first_responded_at is null and first_response_due_at < now()) or resolution_due_at < now()))::int as breached,
        round(avg(extract(epoch from first_responded_at - created_at) / 60) filter (where first_responded_at is not null and created_at > now() - interval '30 days'))::int as "firstResponseMinutes",
        round(avg(csat) filter (where csat is not null and created_at > now() - interval '30 days'), 1)::float8 as csat
      from support_tickets`);
    return r;
  }

  async list(staff: Staff, q: z.infer<typeof TicketsQuery>) {
    // ตัวกรองที่ไม่ใช่ผู้รับ ใช้ร่วมกับตัวเลขบนแท็บ (ของฉัน / คิวกลาง / ทั้งหมด)
    const base: SQL[] = [q.status === 'active' ? sql`k.status in ('open', 'pending_customer', 'pending_dev')` : sql`k.status = ${q.status}`];
    if (q.workspaceId) base.push(sql`k.workspace_id = ${q.workspaceId}`);
    // ค้นหัวข้อ อีเมล เลข Ticket และข้อความในบทสนทนา (ช่วง 3)
    if (q.q) base.push(sql`(k.subject ilike ${`%${q.q}%`} or k.requester_email ilike ${`%${q.q}%`} or k.number::text = ${q.q.replace(/^#/, '')} or exists(select 1 from support_ticket_messages m where m.ticket_id = k.id and m.body ilike ${`%${q.q}%`}))`);
    const inList = (col: SQL, xs: string[]) => sql`${col} in (${sql.join(xs.map((x) => sql`${x}`), sql`, `)})`;
    if (q.assignees?.length) base.push(inList(sql`k.assignee_id`, q.assignees));
    if (q.priority?.length) base.push(inList(sql`k.priority`, q.priority));
    if (q.category?.length) base.push(inList(sql`k.category`, q.category));
    if (q.channel?.length) base.push(inList(sql`k.channel`, q.channel));
    if (q.sla === 'breached') base.push(BREACHED);
    else if (q.sla === 'soon') base.push(sql`(not ${BREACHED} and k.status in ('open', 'pending_dev') and least(case when k.first_responded_at is null then k.first_response_due_at end, k.resolution_due_at) < now() + interval '1 hour')`);
    else if (q.sla === 'today') base.push(sql`(k.status in ('open', 'pending_dev') and (least(case when k.first_responded_at is null then k.first_response_due_at end, k.resolution_due_at) at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date)`);
    if (q.plan?.length) base.push(sql`exists(select 1 from subscriptions sub join plans p on p.id = sub.plan_id where sub.workspace_id = k.workspace_id and ${inList(sql`p.code`, q.plan)})`);
    if (q.buyer) base.push(sql`${buyerKey(sql`k.workspace_id`)} = ${q.buyer}`);
    if (q.created) base.push(sql`k.created_at > now() - make_interval(days => ${q.created})`);
    if (q.createdFrom) base.push(sql`k.created_at >= ${q.createdFrom}::date`);
    if (q.createdTo) base.push(sql`k.created_at < ${q.createdTo}::date + 1`);
    if (q.quiet) base.push(sql`k.updated_at < now() - make_interval(hours => ${q.quiet})`);
    if (q.incident) base.push(q.incident === 'none' ? sql`not exists(select 1 from support_ticket_incidents ti where ti.ticket_id = k.id)` : sql`exists(select 1 from support_ticket_incidents ti where ti.ticket_id = k.id and ti.incident_id = ${q.incident})`);
    if (q.csat === 'low') base.push(sql`k.csat <= 2`);
    else if (q.csat === 'high') base.push(sql`k.csat >= 4`);
    else if (q.csat === 'none') base.push(sql`k.csat is null and k.status in ('solved', 'closed')`);
    const parts = [...base];
    if (q.assignee === 'me') parts.push(sql`k.assignee_id = ${staff.id}`);
    else if (q.assignee === 'none') parts.push(sql`k.assignee_id is null`);
    else if (q.assignee) parts.push(sql`k.assignee_id = ${q.assignee}`);
    const items = await this.rows(sql`
      select k.id, k.number, k.subject, k.status, k.priority, k.channel, k.category, k.requester_email as "requesterEmail", k.created_at as "createdAt", k.updated_at as "updatedAt",
        k.first_response_due_at as "firstResponseDueAt", k.resolution_due_at as "resolutionDueAt", k.first_responded_at as "firstRespondedAt",
        st.id as "assigneeId", st.name as "assigneeName",
        case when w.id is null then null else json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) end as workspace,
        (k.status in ('open', 'pending_dev') and ((k.first_responded_at is null and k.first_response_due_at < now()) or k.resolution_due_at < now())) as "slaBreached"
      from support_tickets k left join staff_users st on st.id = k.assignee_id left join workspaces w on w.id = k.workspace_id
      where ${sql.join(parts, sql` and `)}
      order by ${ORDERS[q.sort]}
      limit ${q.limit} offset ${q.offset}`);
    // ช่วง 1 (ข้อมูลเยอะ): เคยตัดที่ limit โดยไม่บอก · ตอนนี้ส่งจำนวนทั้งหมดและตัวเลขของแต่ละแท็บ
    const [c] = await this.rows(sql`
      select count(*) filter (where ${sql.join(parts, sql` and `)})::int as total,
        count(*) filter (where k.assignee_id = ${staff.id})::int as mine,
        count(*) filter (where k.assignee_id is null)::int as none,
        count(*)::int as "all"
      from support_tickets k where ${sql.join(base, sql` and `)}`);
    return { items, total: c.total as number, counts: { mine: c.mine as number, none: c.none as number, all: c.all as number }, summary: await this.summary() };
  }

  /** รายละเอียด + ข้อความทั้งหมด (รวมบันทึกภายใน) + ข้อมูลลูกค้าด้านข้าง */
  async get(id: string) {
    const t = await this.find(id);
    const messages = await this.rows(sql`
      select m.id, m.author_kind as "authorKind", m.body, m.internal, m.attachments, m.created_at as "createdAt",
        coalesce(st.name, u.display_name) as "authorName"
      from support_ticket_messages m left join staff_users st on st.id = m.author_staff_id left join users u on u.id = m.author_user_id
      where m.ticket_id = ${t.id} order by m.created_at`);
    let customer: Row | null = null;
    if (t.workspaceId) {
      const [c] = await this.rows(sql`
        select w.id, w.slug, w.name, p.code as plan, p.seat_limit as "seatLimit",
          (select st.name from support_account_managers am join staff_users st on st.id = am.staff_id where am.workspace_id = w.id) as "accountManager",
          (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
          (select count(*)::int from support_tickets x where x.workspace_id = w.id and x.created_at > now() - interval '90 days') as "tickets90d",
          (select count(*)::int from support_tickets x where x.workspace_id = w.id and x.created_at > now() - interval '90 days' and x.csat <= 2) as "unhappy90d",
          (select g.until from support_access_grants g where g.workspace_id = w.id and (g.until is null or g.until > now())) as "accessUntil",
          exists(select 1 from support_access_grants g where g.workspace_id = w.id and (g.until is null or g.until > now())) as "accessGranted"
        from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id where w.id = ${t.workspaceId}`);
      const cfg = await this.settings.config();
      customer = c ? { ...c, sla: cfg.sla[((c.plan as string) ?? 'free') as keyof typeof cfg.sla] ?? cfg.sla.free } : null;
    }
    const [assignee] = t.assigneeId ? await this.db.select({ id: s.staffUsers.id, name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, t.assigneeId)) : [];
    const [requester] = t.requesterUserId ? await this.db.select({ name: s.users.displayName }).from(s.users).where(eq(s.users.id, t.requesterUserId)) : [];
    // S6 · ไฟล์แนบและบริบทที่ลูกค้าส่งมา (A44 เก็บใน attachments ของข้อความ) · ไม่ส่ง key ของที่เก็บไฟล์ออกไป ใช้ลิงก์ดาวน์โหลดผ่าน ops-api แทน
    let context: Row | null = null;
    let article: Row | null = null;
    const out = messages.map(({ attachments, ...m }) => {
      const list = Array.isArray(attachments) ? (attachments as Row[]) : [];
      context ??= (list.find((x) => x.kind === 'context') as Row | undefined) ?? null;
      article ??= (list.find((x) => x.kind === 'article') as Row | undefined) ?? null;
      const files = list.flatMap((x, index) => (x.kind === 'file' ? [{ index, name: String(x.name ?? 'file'), size: Number(x.size ?? 0), mime: String(x.mime ?? '') }] : []));
      return { ...m, files };
    });
    const ctx = context as Row | null;
    const art = article as Row | null;
    return {
      ticket: { ...t, assignee: assignee ?? null, requesterName: requester?.name ?? null },
      messages: out,
      customer,
      context: ctx || art ? { page: ctx?.page ?? null, path: ctx?.path ?? null, requestId: ctx?.requestId ?? null, impact: ctx?.impact ?? null, browser: ctx?.browser ?? null, article: art ? { slug: art.slug ?? null, title: art.title ?? null } : null } : null,
    };
  }

  /** ไฟล์แนบของข้อความใน Ticket (S6) · อ่านจากที่เก็บไฟล์ในเครื่องของ API ลูกค้า (แบบเดียวกับสลิปการชำระ · S3 ยังไม่รองรับในหลังบ้าน) */
  async file(id: string, messageId: string, index: number) {
    const t = await this.find(id);
    if (!z.uuid().safeParse(messageId).success) throw new AppError(404, 'not_found', 'ไม่พบไฟล์');
    const [m] = await this.db.select({ attachments: s.supportTicketMessages.attachments }).from(s.supportTicketMessages).where(and(eq(s.supportTicketMessages.id, messageId), eq(s.supportTicketMessages.ticketId, t.id)));
    const f = Array.isArray(m?.attachments) ? ((m.attachments as Row[])[index] as Row | undefined) : undefined;
    if (!f || f.kind !== 'file' || typeof f.key !== 'string') throw new AppError(404, 'not_found', 'ไม่พบไฟล์');
    // A44 เก็บไฟล์ของ Ticket ไว้ใต้ support/<workspace>/ เท่านั้น · กันอ่านไฟล์อื่นในที่เก็บ
    if (!t.workspaceId || !f.key.startsWith(`support/${t.workspaceId}/`)) throw new AppError(404, 'not_found', 'ไม่พบไฟล์');
    const root = resolve(process.env.UPLOAD_DIR ?? '../api/var/uploads', 'files');
    const path = resolve(root, f.key);
    if (!path.startsWith(root + sep)) throw new AppError(400, 'invalid_key', 'ตำแหน่งไฟล์ไม่ถูกต้อง');
    const info = await stat(path).catch(() => null);
    if (!info) throw new AppError(404, 'file_missing', 'ไม่พบไฟล์ในที่เก็บ (ที่เก็บ S3 ยังไม่รองรับในหลังบ้าน)');
    return { stream: createReadStream(path), size: info.size, filename: String(f.name ?? 'file'), mime: String(f.mime ?? '') };
  }

  /** สร้าง Ticket (T1) สำหรับเรื่องที่มาทางโทรศัพท์ / LINE / อีเมล · SLA ตามแพ็กเกจของ Workspace */
  async create(staff: Staff, input: z.infer<typeof CreateTicketBody>) {
    let plan = 'free';
    if (input.workspaceId) {
      const [ws] = await this.rows<{ plan: string | null }>(sql`select p.code as plan from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id where w.id = ${input.workspaceId} and w.deleted_at is null`);
      if (!ws) throw new AppError(404, 'workspace_not_found', 'ไม่พบ Workspace');
      plan = ws.plan ?? 'free';
    }
    const [user] = await this.db.select({ id: s.users.id }).from(s.users).where(sql`lower(${s.users.email}) = ${input.requesterEmail}`);
    const route = await this.settings.route({ plan, category: input.category ?? null, workspaceId: input.workspaceId ?? null, priority: input.priority });
    const assigneeId = input.assignToMe ? staff.id : route.assigneeId;
    const now = new Date();
    const due = await this.settings.due(plan, route.priority, now);
    const t = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(s.supportTickets)
        .values({
          workspaceId: input.workspaceId ?? null, requesterUserId: user?.id ?? null, requesterEmail: input.requesterEmail, channel: input.channel, category: input.category ?? null,
          priority: route.priority, subject: input.subject, assigneeId, ruleId: route.ruleId,
          firstResponseDueAt: due.first, resolutionDueAt: due.resolve,
        })
        .returning();
      await tx.insert(s.supportTicketMessages).values({ ticketId: row.id, authorKind: 'customer', authorUserId: user?.id ?? null, body: input.body });
      return row;
    });
    await this.trace(t, staff, 'support.ticket_created', `เปิด Ticket ทาง${input.channel} · ${input.subject}${assigneeId && !input.assignToMe ? ' · แจกอัตโนมัติตามกฎ' : ''}`);
    const when = !due.sla.first ? '' : due.open ? `\nเราจะตอบกลับภายใน ${due.sla.first.n} ${due.sla.first.unit === 'h' ? 'ชั่วโมง' : 'วัน'}ทำการ` : '\nตอนนี้อยู่นอกเวลาทำการ ทีมจะตอบในวันทำการถัดไป';
    const notified = input.notify ? await this.email(t.requesterEmail, `[#${t.number}] ได้รับเรื่องแล้ว: ${t.subject}`, `ทีม Friday ได้รับเรื่องของคุณแล้ว เลขที่ #${t.number}${when}`) : false;
    return { ticket: t, notified };
  }

  /** รับเรื่องนี้ (หยิบจากคิวกลาง) */
  async claim(staff: Staff, id: string) {
    const t = await this.find(id);
    this.open(t);
    if (t.assigneeId === staff.id) throw new AppError(409, 'already_yours', 'คุณรับเรื่องนี้อยู่แล้ว');
    if (t.assigneeId) throw new AppError(409, 'ticket_assigned', 'มีคนรับเรื่องนี้แล้ว · ให้เจ้าของโอนให้แทน');
    const [r] = await this.db.update(s.supportTickets).set({ assigneeId: staff.id, updatedAt: new Date() }).where(and(eq(s.supportTickets.id, t.id), sql`${s.supportTickets.assigneeId} is null`)).returning();
    if (!r) throw new AppError(409, 'ticket_assigned', 'มีคนรับเรื่องนี้ไปพร้อมกัน');
    await this.trace(t, staff, 'support.ticket_claimed', 'รับเรื่อง');
    return { id: t.id, assigneeId: staff.id };
  }

  /** โอนให้พนักงานอื่น (T2) · ผู้รับต้องมีบทบาท Support และใช้งานอยู่ */
  async assign(staff: Staff, id: string, input: z.infer<typeof AssignBody>) {
    const t = await this.find(id);
    this.open(t);
    if (t.assigneeId && t.assigneeId !== staff.id && !has(staff, 'owner')) throw new AppError(403, 'not_assignee', 'โอนได้เฉพาะเจ้าของเรื่องหรือ Owner');
    const [to] = await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, input.staffId));
    if (!to || to.status !== 'active' || !to.roles.includes('support')) throw new AppError(422, 'assignee_invalid', 'ผู้รับต้องเป็นพนักงาน Support ที่ใช้งานอยู่');
    await this.db.transaction(async (tx) => {
      await tx.update(s.supportTickets).set({ assigneeId: to.id, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
      await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'staff', authorStaffId: staff.id, internal: true, body: `โอนให้ ${to.name}${input.note ? ` · ${input.note}` : ''}` });
    });
    await this.trace(t, staff, 'support.ticket_assigned', `โอนให้ ${to.name}`);
    return { id: t.id, assigneeId: to.id };
  }

  /** คืนเข้าคิวกลาง */
  async release(staff: Staff, id: string) {
    const t = await this.find(id);
    this.open(t);
    if (t.assigneeId !== staff.id && !has(staff, 'owner')) throw new AppError(403, 'not_assignee', 'คืนคิวได้เฉพาะเจ้าของเรื่องหรือ Owner');
    await this.db.update(s.supportTickets).set({ assigneeId: null, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
    await this.trace(t, staff, 'support.ticket_released', 'คืนเข้าคิวกลาง');
    return { id: t.id, assigneeId: null };
  }

  /**
   * ข้อความ: ตอบลูกค้า (ส่งอีเมล · นับเวลาตอบครั้งแรก · รอลูกค้า) / บันทึกภายใน / บันทึกข้อความของลูกค้าที่มาทางช่องทางอื่น
   * ข้อความของลูกค้าหลังแก้แล้วภายใน 7 วัน = เปิดใหม่ (กติกาเดียวกับที่ API ลูกค้าต้องใช้เมื่อลูกค้าตอบในแอป)
   */
  async message(staff: Staff, id: string, input: z.infer<typeof MessageBody>) {
    const t = await this.find(id);
    if (input.fromCustomer) return this.customerReplied(t, input.body, staff);
    this.open(t);
    const now = new Date();
    const [m] = await this.db.transaction(async (tx) => {
      const r = await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'staff', authorStaffId: staff.id, body: input.body, internal: input.internal }).returning();
      if (!input.internal) {
        await tx
          .update(s.supportTickets)
          .set({ firstRespondedAt: t.firstRespondedAt ?? now, status: t.status === 'open' ? 'pending_customer' : t.status, assigneeId: t.assigneeId ?? staff.id, updatedAt: now })
          .where(eq(s.supportTickets.id, t.id));
      }
      return r;
    });
    const sent = input.internal ? false : await this.email(this.requester(t), `[#${t.number}] ${t.subject}`, `${input.body}\n\n— ${staff.name} · ทีม Friday\nตอบกลับอีเมลนี้เพื่อคุยต่อในเรื่องเดิม`);
    return { message: m, sent };
  }

  /**
   * ลูกค้าตอบ: รอลูกค้า → เปิด · แก้แล้วไม่เกิน N วัน (ตั้งค่า O22) → เปิดใหม่ที่คนเดิม · ปิดถาวรแล้ว → 409 ให้เปิดเรื่องใหม่
   * เปิดใหม่แต่คนเดิมออฟไลน์ / ลา → คืนเข้าคิวและแจกใหม่ (รอบ 4 · S4 · ตั้งค่า reopenToQueue)
   */
  async customerReplied(t: Ticket, body: string, staff?: Staff) {
    const { reopenDays } = await this.settings.config();
    if (t.status === 'closed' || (t.status === 'solved' && t.solvedAt && Date.now() - t.solvedAt.getTime() > reopenDays * DAY)) throw new AppError(409, 'ticket_closed', 'Ticket นี้ปิดถาวรแล้ว เปิด Ticket ใหม่แทน');
    const reopened = t.status === 'solved';
    await this.db.transaction(async (tx) => {
      await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'customer', authorUserId: t.requesterUserId, body });
      if (t.status !== 'open' && t.status !== 'pending_dev') await tx.update(s.supportTickets).set({ status: 'open', solvedAt: null, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
    });
    const requeued = reopened ? await this.presence.requeueIfAway(t.id, t.assigneeId) : false;
    if (reopened && staff) await this.trace(t, staff, 'support.ticket_reopened', `ลูกค้าตอบหลังปิดเรื่อง เปิดใหม่${requeued ? ' · คนเดิมไม่อยู่ คืนเข้าคิว' : ''}`);
    return { id: t.id, status: t.status === 'pending_dev' ? 'pending_dev' : 'open', reopened, requeued };
  }

  /** ส่งต่อระดับ 2 (T3): เปลี่ยนเป็นรอทีมพัฒนา · รายละเอียดสำหรับทีมพัฒนาเก็บเป็นบันทึกภายใน */
  async escalate(staff: Staff, id: string, input: z.infer<typeof EscalateBody>) {
    const t = await this.find(id);
    this.open(t);
    if (t.status === 'solved') throw new AppError(409, 'ticket_solved', 'Ticket นี้แก้แล้ว');
    await this.db.transaction(async (tx) => {
      await tx.update(s.supportTickets).set({ status: 'pending_dev', assigneeId: t.assigneeId ?? staff.id, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
      await tx.insert(s.supportTicketMessages).values({
        ticketId: t.id, authorKind: 'staff', authorStaffId: staff.id, internal: true,
        body: [`ส่งต่อทีมพัฒนา · ความรุนแรง ${input.severity}${input.devIssueKey ? ` · งาน ${input.devIssueKey}` : ''}`, input.affected ? `ลูกค้าที่กระทบ: ${input.affected}` : '', input.requestId ? `requestId: ${input.requestId}` : '', `ขั้นตอนทำซ้ำ:\n${input.steps}`].filter(Boolean).join('\n'),
      });
      if (input.notifyCustomer) await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'system', body: 'ส่งเรื่องให้ทีมพัฒนาตรวจแล้ว จะแจ้งความคืบหน้าในเรื่องนี้' });
    });
    await this.trace(t, staff, 'support.ticket_escalated', `ส่งต่อทีมพัฒนา ${input.severity}${input.devIssueKey ? ` · ${input.devIssueKey}` : ''}`);
    const sent = input.notifyCustomer ? await this.email(this.requester(t), `[#${t.number}] ส่งต่อทีมพัฒนาแล้ว`, 'เราส่งเรื่องของคุณให้ทีมพัฒนาตรวจแล้ว และจะแจ้งความคืบหน้าในเรื่องนี้') : false;
    return { id: t.id, status: 'pending_dev' as const, sent };
  }

  /** ปิดเรื่อง (T5) พร้อมสาเหตุจริง · ลูกค้าตอบภายใน N วันเปิดใหม่ได้ · ขอคะแนนความพึงพอใจทางอีเมล */
  async solve(staff: Staff, id: string, input: z.infer<typeof SolveBody>) {
    const t = await this.find(id);
    this.open(t);
    if (t.status === 'solved') throw new AppError(409, 'ticket_solved', 'Ticket นี้แก้แล้ว');
    await this.db.transaction(async (tx) => {
      await tx.update(s.supportTickets).set({ status: 'solved', solvedAt: new Date(), cause: input.cause, assigneeId: t.assigneeId ?? staff.id, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
      await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'staff', authorStaffId: staff.id, internal: true, body: `ปิดเรื่อง · ${input.outcome} · สาเหตุ: ${input.cause}` });
    });
    await this.trace(t, staff, 'support.ticket_solved', `ปิดเรื่อง · ${input.cause}`);
    const { reopenDays } = await this.settings.config();
    const sent = await this.email(
      this.requester(t),
      `[#${t.number}] แก้ไขเรียบร้อย: ${t.subject}`,
      `${input.outcome}\n\nถ้ายังมีปัญหา ตอบกลับอีเมลนี้ภายใน ${reopenDays} วัน เรื่องจะเปิดใหม่ให้อัตโนมัติ${input.sendCsat ? '\nช่วยให้คะแนนความพึงพอใจ 1–5 โดยตอบกลับอีเมลนี้เป็นตัวเลข' : ''}`,
    );
    return { id: t.id, status: 'solved' as const, sent };
  }

  /** บันทึกคะแนนความพึงพอใจที่ลูกค้าตอบกลับ (ช่วงแรกทีมกรอกจากอีเมล) */
  async rate(staff: Staff, id: string, input: z.infer<typeof CsatBody>) {
    const t = await this.find(id);
    if (t.status !== 'solved' && t.status !== 'closed') throw new AppError(409, 'ticket_not_solved', 'ให้คะแนนได้หลังปิดเรื่อง');
    await this.db.update(s.supportTickets).set({ csat: input.score, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
    await this.trace(t, staff, 'support.ticket_rated', `คะแนน ${input.score}/5`);
    return { id: t.id, csat: input.score };
  }

  /** แก้แล้วเกิน N วันโดยลูกค้าไม่ตอบ → ปิดถาวร */
  async closeStale() {
    const { reopenDays } = await this.settings.config();
    const r = await this.db
      .update(s.supportTickets)
      .set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(s.supportTickets.status, 'solved'), sql`${s.supportTickets.solvedAt} < now() - make_interval(days => ${reopenDays})`))
      .returning({ id: s.supportTickets.id });
    return { closed: r.length };
  }

  /**
   * เตือน SLA: เหลือเวลา 25% → อีเมลผู้รับผิดชอบ (ยังไม่มีคนรับ = หัวหน้าทีม) · เกิน → อีเมลหัวหน้าทีม (รายการขึ้นบนสุดของคิวเอง)
   * นับกำหนดตอบครั้งแรกก่อน ตอบแล้วนับกำหนดปิดเรื่อง · บันทึกใน sla_alerts กันส่งซ้ำ
   */
  async slaTick(now = new Date()) {
    const rows = await this.rows<{ id: string; number: number; subject: string; createdAt: Date; firstRespondedAt: Date | null; firstResponseDueAt: Date | null; resolutionDueAt: Date | null; slaAlerts: Record<string, string>; assigneeEmail: string | null; assigneeName: string | null; status: string }>(sql`
      select k.id, k.number, k.subject, k.created_at as "createdAt", k.first_responded_at as "firstRespondedAt", k.first_response_due_at as "firstResponseDueAt", k.resolution_due_at as "resolutionDueAt",
        k.sla_alerts as "slaAlerts", st.email as "assigneeEmail", st.name as "assigneeName", k.status
      from support_tickets k left join staff_users st on st.id = k.assignee_id
      where k.status in ('open', 'pending_dev') and (
        (k.first_responded_at is null and k.first_response_due_at is not null and not (k.sla_alerts ? 'firstBreach'))
        or (k.first_responded_at is not null and k.resolution_due_at is not null and not (k.sla_alerts ? 'resolveBreach')))
      limit 500`);
    let warned = 0;
    let breached = 0;
    for (const k of rows) {
      const stage = k.firstRespondedAt ? 'resolve' : 'first';
      const due = new Date((stage === 'first' ? k.firstResponseDueAt : k.resolutionDueAt)!);
      const start = new Date(stage === 'first' ? k.createdAt : k.firstRespondedAt!);
      const label = stage === 'first' ? 'ตอบครั้งแรก' : 'ปิดเรื่อง';
      const alerts = { ...k.slaAlerts };
      if (now >= due && !alerts[`${stage}Breach`]) {
        alerts[`${stage}Breach`] = now.toISOString();
        alerts[`${stage}Warn`] ??= now.toISOString();
        await this.settings.notifyLeads(`[#${k.number}] เกิน SLA ${label}`, `#${k.number} ${k.subject}\nเกินกำหนด${label}แล้ว · ผู้รับผิดชอบ: ${k.assigneeName ?? 'ยังไม่มีคนรับ'}\nเรื่องนี้ย้ายขึ้นบนสุดของคิว`);
        breached++;
      } else if (now < due && !alerts[`${stage}Warn`] && due.getTime() - now.getTime() <= ((due.getTime() - start.getTime()) * SLA_WARN_PCT) / 100) {
        alerts[`${stage}Warn`] = now.toISOString();
        const subject = `[#${k.number}] ใกล้เกิน SLA ${label}`;
        const text = `#${k.number} ${k.subject}\nเหลือเวลา${label}ไม่ถึง ${SLA_WARN_PCT}% · กำหนด ${due.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`;
        if (k.assigneeEmail) await this.email(k.assigneeEmail, subject, text);
        else await this.settings.notifyLeads(subject, `${text}\nยังไม่มีคนรับเรื่องนี้`);
        warned++;
      } else continue;
      await this.db.update(s.supportTickets).set({ slaAlerts: alerts }).where(eq(s.supportTickets.id, k.id));
    }
    return { warned, breached };
  }

  /** ผลงานรายคน 30 วัน: ปิดเรื่อง · ตอบครั้งแรก / ปิดเรื่องเฉลี่ย · ทันใน SLA · ความพึงพอใจ */
  async stats() {
    const items = await this.rows(sql`
      select st.id, st.name,
        count(k.*) filter (where k.solved_at is not null)::int as solved,
        round(avg(extract(epoch from k.first_responded_at - k.created_at) / 60) filter (where k.first_responded_at is not null))::int as "firstResponseMinutes",
        round(avg(extract(epoch from k.solved_at - k.created_at) / 3600) filter (where k.solved_at is not null), 1)::float8 as "resolutionHours",
        round(100.0 * count(k.*) filter (where k.first_responded_at is not null and k.first_responded_at <= k.first_response_due_at) / nullif(count(k.*) filter (where k.first_responded_at is not null), 0))::int as "withinSlaPct",
        round(avg(k.csat) filter (where k.csat is not null), 1)::float8 as csat
      from staff_users st join support_tickets k on k.assignee_id = st.id and k.created_at > now() - interval '30 days'
      group by st.id, st.name order by solved desc`);
    return { items };
  }
}

