import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { BusinessClock } from './clock.js';
import { SLA_WARN_PCT, SupportSettingsService } from './settings.service.js';

const s = schema;
const DAY = 86_400_000;
type Row = Record<string, unknown>;
type Ticket = typeof s.supportTickets.$inferSelect;

/** บวกชั่วโมงทำการตามค่าเริ่มต้น (จ.–ศ. 09:00–18:00 เวลาไทย ไม่นับวันหยุด) · SLA จริงใช้เวลาทำการที่ตั้งใน O22 */
export const addBusinessHours = (start: Date, hours: number) => new BusinessClock().addHours(start, hours);

const Priority = z.enum(['low', 'normal', 'high', 'urgent']);
export const TicketsQuery = z.object({
  status: z.enum(['open', 'pending_customer', 'pending_dev', 'solved', 'closed', 'active']).default('active'),
  /** me = ของฉัน · none = คิวกลาง (ยังไม่มีคนรับ) */
  assignee: z.union([z.enum(['me', 'none']), z.uuid()]).optional(),
  workspaceId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
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
    const parts: SQL[] = [q.status === 'active' ? sql`k.status in ('open', 'pending_customer', 'pending_dev')` : sql`k.status = ${q.status}`];
    if (q.assignee === 'me') parts.push(sql`k.assignee_id = ${staff.id}`);
    else if (q.assignee === 'none') parts.push(sql`k.assignee_id is null`);
    else if (q.assignee) parts.push(sql`k.assignee_id = ${q.assignee}`);
    if (q.workspaceId) parts.push(sql`k.workspace_id = ${q.workspaceId}`);
    if (q.q) parts.push(sql`(k.subject ilike ${`%${q.q}%`} or k.requester_email ilike ${`%${q.q}%`} or k.number::text = ${q.q.replace(/^#/, '')})`);
    const items = await this.rows(sql`
      select k.id, k.number, k.subject, k.status, k.priority, k.channel, k.category, k.requester_email as "requesterEmail", k.created_at as "createdAt", k.updated_at as "updatedAt",
        k.first_response_due_at as "firstResponseDueAt", k.resolution_due_at as "resolutionDueAt", k.first_responded_at as "firstRespondedAt",
        st.id as "assigneeId", st.name as "assigneeName",
        case when w.id is null then null else json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) end as workspace,
        (k.status in ('open', 'pending_dev') and ((k.first_responded_at is null and k.first_response_due_at < now()) or k.resolution_due_at < now())) as "slaBreached"
      from support_tickets k left join staff_users st on st.id = k.assignee_id left join workspaces w on w.id = k.workspace_id
      where ${sql.join(parts, sql` and `)}
      order by (k.status in ('open', 'pending_dev') and ((k.first_responded_at is null and k.first_response_due_at < now()) or k.resolution_due_at < now())) desc,
        (k.priority = 'urgent') desc, (k.priority = 'high') desc, coalesce(k.first_response_due_at, k.created_at)
      limit ${q.limit}`);
    return { items, summary: await this.summary() };
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
    return { ticket: { ...t, assignee: assignee ?? null, requesterName: requester?.name ?? null }, messages, customer };
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

  /** ลูกค้าตอบ: รอลูกค้า → เปิด · แก้แล้วไม่เกิน N วัน (ตั้งค่า O22) → เปิดใหม่ที่คนเดิม · ปิดถาวรแล้ว → 409 ให้เปิดเรื่องใหม่ */
  async customerReplied(t: Ticket, body: string, staff?: Staff) {
    const { reopenDays } = await this.settings.config();
    if (t.status === 'closed' || (t.status === 'solved' && t.solvedAt && Date.now() - t.solvedAt.getTime() > reopenDays * DAY)) throw new AppError(409, 'ticket_closed', 'Ticket นี้ปิดถาวรแล้ว เปิด Ticket ใหม่แทน');
    const reopened = t.status === 'solved';
    await this.db.transaction(async (tx) => {
      await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'customer', authorUserId: t.requesterUserId, body });
      if (t.status !== 'open' && t.status !== 'pending_dev') await tx.update(s.supportTickets).set({ status: 'open', solvedAt: null, updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
    });
    if (reopened && staff) await this.trace(t, staff, 'support.ticket_reopened', 'ลูกค้าตอบหลังปิดเรื่อง เปิดใหม่');
    return { id: t.id, status: t.status === 'pending_dev' ? 'pending_dev' : 'open', reopened };
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

