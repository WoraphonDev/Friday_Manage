import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { healthScore } from '../metrics/economics.js';
import { TicketsService } from '../support/tickets.service.js';

const s = schema;
const r = s.npsResponses;
const DAY = 86_400_000;
/** เก็บคำตอบ NPS 25 เดือนเท่า product_events (เทียบปีต่อปีได้ · คำตัดสิน O32) แล้วงานเบื้องหลังลบ */
export const NPS_RETENTION_MONTHS = 25;
/** ตรวจลบคำตอบที่ครบระยะเก็บทุก 6 ชั่วโมง (ไม่ต้องตรงเวลา · ลบเป็นชุด) */
const PURGE_EVERY_MS = 6 * 3_600_000;

export const RANGES = { '30d': 30, '90d': 90, '12m': 365 } as const;
export const SummaryQuery = z.object({ range: z.enum(['30d', '90d', '12m']).default('90d') }).strict();
export const ResponsesQuery = z
  .object({
    range: z.enum(['30d', '90d', '12m']).default('90d'),
    group: z.enum(['all', 'detractor', 'passive', 'promoter']).default('all'),
    withComment: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export const FollowUpBody = z
  .object({
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    note: z.string().trim().max(2000).nullish(),
    followUpStatus: z.enum(s.NPS_FOLLOW_UP_STATUSES).optional(),
  })
  .strict();
export const TicketBody = z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(1).max(10_000) }).strict();
const FollowUps = z.object({ detractor: z.string().trim().min(1).max(200), passive: z.string().trim().min(1).max(200), promoter: z.string().trim().min(1).max(200) }).strict();
const FollowUpsEn = z.object({ detractor: z.string().trim().max(200), passive: z.string().trim().max(200), promoter: z.string().trim().max(200) }).strict();
export const SettingsBody = z
  .object({
    enabled: z.boolean(),
    audience: z.enum(['admins', 'members']),
    firstAfterDays: z.number().int().min(0).max(365),
    repeatDays: z.number().int().min(1).max(730),
    samplePct: z.number().int().min(0).max(100),
    excludeTrialDays: z.number().int().min(0).max(90).nullable(),
    excludeTicketDays: z.number().int().min(0).max(90).nullable(),
    excludeSpotlightDay: z.boolean(),
    excludeShortMobile: z.boolean(),
    question: z.string().trim().min(5, 'กรอกคำถาม').max(200),
    questionEn: z.string().trim().max(200).nullish(),
    followUps: FollowUps,
    followUpsEn: FollowUpsEn.nullish(),
    topics: z.array(z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'รหัสหัวข้อใช้ตัวพิมพ์เล็ก ตัวเลข _')).min(1).max(10),
  })
  .strict();

const groupSql = (g: string) => (g === 'detractor' ? sql`r.score between 0 and 6` : g === 'passive' ? sql`r.score between 7 and 8` : g === 'promoter' ? sql`r.score >= 9` : sql`r.score is not null`);
/** NPS = % แนะนำต่อ − % ไม่พอใจ (ปัดเป็นจำนวนเต็ม) · ไม่มีคำตอบ = null */
export function npsOf(promoters: number, detractors: number, answered: number) {
  return answered > 0 ? Math.round(((promoters - detractors) / answered) * 100) : null;
}

/**
 * NPS ใน Friday Ops (O33 · บอร์ด 17 แท็บ NPS · U5 / U6)
 * - ตัวเลขรวม: Owner, Support, การเงิน, ผู้ตรวจ · ความเห็นพร้อมชื่อ Workspace และการติดตาม: Owner, Support (คำตัดสิน O33)
 * - ความเห็นไม่ส่งถึงใครอัตโนมัติ · ทีมตอบลูกค้าผ่าน Ticket (เปิด Ticket ติดตาม) เท่านั้น
 * - ตั้งค่าแบบสำรวจ (U5) Owner เท่านั้น · ลบคำตอบที่เก่ากว่า 25 เดือนด้วยงานเบื้องหลัง
 * - คำตอบตอนยกเลิกแพ็กเกจอยู่ที่ "ธุรกิจและกำไร › เหตุผลที่ยกเลิก" (W22) ไม่ทำซ้ำ
 */
@Injectable()
export class NpsOpsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Nps');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly tickets: TicketsService,
  ) {}

  onModuleInit() {
    // test เรียก purge() เอง · ปิดด้วย OPS_JOBS=off (แบบเดียวกับประกาศ O24)
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.purge().catch((e) => this.log.error(String(e))), PURGE_EVERY_MS);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T>(q: SQL) {
    const res = await this.db.execute(q);
    return ((res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[])) as T[];
  }

  /** ลบคำตอบที่ครบระยะเก็บ (ทั้งที่ตอบและที่ปิดโดยไม่ตอบ) ทีละชุด · คืนจำนวนที่ลบ */
  async purge(now = new Date()) {
    const before = sql`${now}::timestamptz - make_interval(months => ${NPS_RETENTION_MONTHS})`;
    let total = 0;
    for (;;) {
      const gone = await this.rows<{ id: string }>(sql`delete from nps_responses where id in (select id from nps_responses where created_at < ${before} limit 1000) returning id`);
      total += gone.length;
      if (gone.length < 1000) break;
    }
    if (total) await staffAudit(this.db, null, 'ops.nps_purged', `ลบคำตอบ NPS ที่เก่ากว่า ${NPS_RETENTION_MONTHS} เดือน ${total} รายการ (ระยะเก็บตามนโยบาย)`);
    return { deleted: total };
  }

  // ---------------------------------------------------------------- ตัวเลขรวม

  async summary(range: keyof typeof RANGES, now = new Date()) {
    const days = RANGES[range];
    const from = new Date(now.getTime() - days * DAY);
    const prevFrom = new Date(now.getTime() - 2 * days * DAY);
    const agg = (a: Date, b: Date) =>
      this.rows<{ answered: number; promoters: number; passives: number; detractors: number; dismissed: number; open: number }>(sql`
        select count(*) filter (where score is not null)::int as answered,
          count(*) filter (where score >= 9)::int as promoters,
          count(*) filter (where score between 7 and 8)::int as passives,
          count(*) filter (where score <= 6)::int as detractors,
          count(*) filter (where score is null)::int as dismissed,
          count(*) filter (where score <= 6 and follow_up_status = 'open')::int as open
        from nps_responses where created_at >= ${a} and created_at < ${b}`);
    const [cur] = await agg(from, now);
    const [prev] = await agg(prevFrom, from);
    const score = npsOf(cur.promoters, cur.detractors, cur.answered);
    const prevScore = npsOf(prev.promoters, prev.detractors, prev.answered);
    const pct = (n: number) => (cur.answered ? Math.round((n / cur.answered) * 100) : 0);
    // แนวโน้ม 6 เดือนล่าสุดตามเวลาไทย (รวมเดือนที่ไม่มีคำตอบ)
    const monthly = await this.rows<{ month: string; answered: number; promoters: number; detractors: number }>(sql`
      with m as (select to_char(generate_series(date_trunc('month', (${now}::timestamptz at time zone 'Asia/Bangkok')) - interval '5 months', date_trunc('month', (${now}::timestamptz at time zone 'Asia/Bangkok')), interval '1 month'), 'YYYY-MM') as month)
      select m.month, count(r.id) filter (where r.score is not null)::int as answered,
        count(r.id) filter (where r.score >= 9)::int as promoters, count(r.id) filter (where r.score <= 6)::int as detractors
      from m left join nps_responses r on to_char(r.created_at at time zone 'Asia/Bangkok', 'YYYY-MM') = m.month
      group by m.month order by m.month`);
    const byPlan = await this.rows<{ plan: string | null; answered: number; promoters: number; detractors: number }>(sql`
      select plan, count(*)::int as answered, count(*) filter (where score >= 9)::int as promoters, count(*) filter (where score <= 6)::int as detractors
      from nps_responses where score is not null and created_at >= ${from} group by plan order by answered desc`);
    // หัวข้อที่พูดถึงบ่อย: หัวข้อที่ลูกค้าเลือก + หัวข้อที่ทีมใส่ตอนติดตาม (ไม่มีข้อความของลูกค้า)
    const topics = await this.rows<{ topic: string; n: number }>(sql`
      select t as topic, count(*)::int as n from nps_responses, unnest(topics || tags) as t
      where created_at >= ${from} and score is not null group by t order by n desc, t limit 5`);
    return {
      range,
      score,
      delta: score !== null && prevScore !== null ? score - prevScore : null,
      answered: cur.answered,
      asked: cur.answered + cur.dismissed,
      dismissed: cur.dismissed,
      promotersPct: pct(cur.promoters),
      passivesPct: pct(cur.passives),
      detractorsPct: pct(cur.detractors),
      groups: { detractor: cur.detractors, passive: cur.passives, promoter: cur.promoters },
      openDetractors: cur.open,
      monthly: monthly.map((m) => ({ month: m.month, answered: m.answered, score: npsOf(m.promoters, m.detractors, m.answered) })),
      byPlan: byPlan.map((p) => ({ plan: p.plan, answered: p.answered, score: npsOf(p.promoters, p.detractors, p.answered) })),
      topics: topics.map((t) => ({ topic: t.topic, count: t.n })),
    };
  }

  // ---------------------------------------------------------------- ความเห็น (Owner / Support)

  async list(q: z.infer<typeof ResponsesQuery>, now = new Date()) {
    const from = new Date(now.getTime() - RANGES[q.range] * DAY);
    const items = await this.rows<Record<string, unknown>>(sql`
      select r.id, r.score, r.comment, r.topics, r.tags, r.role, r.plan, r.created_at as "createdAt", r.follow_up_status as "followUpStatus",
        r.note, r.followed_up_at as "followedUpAt", f.name as "followedUpBy",
        w.id as "workspaceId", w.name as "workspaceName", w.slug as "workspaceSlug",
        t.id as "ticketId", t.number as "ticketNumber"
      from nps_responses r
      join workspaces w on w.id = r.workspace_id
      left join staff_users f on f.id = r.followed_up_by
      left join support_tickets t on t.id = r.ticket_id
      where r.created_at >= ${from} and ${groupSql(q.group)} ${q.withComment === 'true' ? sql`and r.comment is not null` : sql``}
      order by r.created_at desc, r.id desc limit ${q.limit}`);
    return { items: items.map((x) => this.shapeRow(x)) };
  }

  private shapeRow(x: Record<string, unknown>) {
    return {
      id: x.id as string,
      score: x.score as number,
      comment: x.comment as string | null,
      topics: x.topics as string[],
      tags: x.tags as string[],
      role: x.role as string,
      plan: x.plan as string | null,
      createdAt: x.createdAt as Date,
      followUpStatus: x.followUpStatus as string,
      note: x.note as string | null,
      followedUpAt: x.followedUpAt as Date | null,
      followedUpBy: x.followedUpBy as string | null,
      workspace: { id: x.workspaceId as string, name: x.workspaceName as string, slug: x.workspaceSlug as string },
      ticket: x.ticketId ? { id: x.ticketId as string, number: x.ticketNumber as number } : null,
    };
  }

  private async row(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบคำตอบ');
    const [x] = await this.rows<Record<string, unknown>>(sql`
      select r.id, r.score, r.comment, r.topics, r.tags, r.role, r.plan, r.created_at as "createdAt", r.follow_up_status as "followUpStatus",
        r.note, r.followed_up_at as "followedUpAt", f.name as "followedUpBy", r.user_id as "userId",
        w.id as "workspaceId", w.name as "workspaceName", w.slug as "workspaceSlug", t.id as "ticketId", t.number as "ticketNumber"
      from nps_responses r join workspaces w on w.id = r.workspace_id
      left join staff_users f on f.id = r.followed_up_by left join support_tickets t on t.id = r.ticket_id
      where r.id = ${id}`);
    if (!x) throw new AppError(404, 'not_found', 'ไม่พบคำตอบ');
    return x;
  }

  /** รายละเอียดสำหรับ U6: คะแนนครั้งก่อนของคนเดียวกัน · สุขภาพ · Ticket 90 วันของ Workspace */
  async detail(id: string) {
    const x = await this.row(id);
    const ws = x.workspaceId as string;
    const [prev] = x.userId
      ? await this.rows<{ score: number; createdAt: Date }>(sql`
          select score, created_at as "createdAt" from nps_responses
          where user_id = ${x.userId} and workspace_id = ${ws} and score is not null and created_at < ${x.createdAt} order by created_at desc limit 1`)
      : [];
    const tickets = await this.rows<{ number: number; subject: string; status: string }>(sql`
      select number, subject, status from support_tickets where workspace_id = ${ws} and created_at > now() - interval '90 days' order by created_at desc limit 5`);
    const [h] = await this.rows<Record<string, number>>(sql`
      select (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest' and m.joined_at < now() - interval '30 days') as "seats30dAgo",
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.last_active_at > now() - interval '30 days') as active30,
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status in ('open', 'pending_review') and i.due_date < current_date) as overdue,
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid') as "paidTotal",
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid' and (i.paid_at at time zone 'Asia/Bangkok')::date <= i.due_date) as "paidOnTime",
        (select count(*)::int from support_tickets k where k.workspace_id = w.id and k.status in ('open', 'pending_customer', 'pending_dev')) as "openTickets"
      from workspaces w where w.id = ${ws}`);
    const health = h ? healthScore({ seats: h.seats, active30: h.active30, overdueInvoices: h.overdue, paidOnTime: h.paidOnTime, paidTotal: h.paidTotal, openTickets: h.openTickets, membersNow: h.seats, members30dAgo: h.seats30dAgo }).score : null;
    return {
      ...this.shapeRow(x),
      context: {
        previous: prev ? { score: prev.score, at: prev.createdAt } : null,
        health,
        members: h?.seats ?? 0,
        tickets90: { count: tickets.length, latest: tickets[0] ?? null },
      },
    };
  }

  /** หัวข้อ / บันทึกภายใน / ทำเครื่องหมายว่าติดตามแล้ว (U6) · Audit ของทีม (ไม่ลงบันทึกของลูกค้า เพราะเป็นข้อมูลภายใน) */
  async followUp(staff: Staff, id: string, input: z.infer<typeof FollowUpBody>) {
    const cur = await this.row(id);
    const done = input.followUpStatus === 'done' && cur.followUpStatus !== 'done';
    const tags = input.tags ? [...new Set(input.tags)] : undefined;
    await this.db.transaction(async (tx) => {
      await tx
        .update(r)
        .set({
          ...(tags ? { tags } : {}),
          ...(input.note !== undefined ? { note: input.note || null } : {}),
          ...(input.followUpStatus ? { followUpStatus: input.followUpStatus } : {}),
          ...(done ? { followedUpBy: staff.id, followedUpAt: new Date() } : {}),
        })
        .where(eq(r.id, id));
      const what = [tags && `หัวข้อ ${tags.join(', ') || '—'}`, input.note !== undefined && 'บันทึกภายใน', input.followUpStatus && (input.followUpStatus === 'done' ? 'ติดตามแล้ว' : 'เปิดติดตามอีกครั้ง')].filter(Boolean).join(' · ');
      await staffAudit(tx, staff, 'ops.nps_follow_up', `ความเห็น NPS คะแนน ${cur.score ?? '—'} ของ ${cur.workspaceName} · ${what || 'ไม่มีการเปลี่ยนแปลง'}`, { type: 'nps_response', id }, cur.workspaceId as string);
    });
    return this.detail(id);
  }

  /**
   * เปิด Ticket ติดตาม (T1 ที่เติมข้อความให้) · ผู้แจ้ง = ผู้ตอบ (ลบบัญชีแล้วใช้ Owner ของ Workspace)
   * ไม่ส่งอีเมลอัตโนมัติ ให้ทีมเขียนข้อความตอบลูกค้าเองใน Ticket · ผูก Ticket กับคำตอบและนับว่าติดตามแล้ว
   */
  async openTicket(staff: Staff, id: string, input: z.infer<typeof TicketBody>) {
    const cur = await this.row(id);
    if (cur.ticketId) throw new AppError(409, 'ticket_exists', `ความเห็นนี้มี Ticket #${cur.ticketNumber} อยู่แล้ว`);
    const [who] = await this.rows<{ email: string }>(sql`
      select email from (
        select u.email, 0 as p from users u where u.id = ${cur.userId ?? null}
        union all
        select u.email, 1 as p from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${cur.workspaceId} and m.role = 'owner' and m.status = 'active'
      ) x order by p limit 1`);
    if (!who) throw new AppError(422, 'no_requester', 'ไม่พบอีเมลของผู้ตอบหรือ Owner ของ Workspace');
    const { ticket } = await this.tickets.create(staff, { workspaceId: cur.workspaceId as string, requesterEmail: who.email.toLowerCase(), channel: 'in_app', category: 'other', subject: input.subject, body: input.body, assignToMe: true, notify: false });
    await this.db.transaction(async (tx) => {
      await tx.update(r).set({ ticketId: ticket.id, followedUpBy: staff.id, followedUpAt: new Date() }).where(eq(r.id, id));
      await staffAudit(tx, staff, 'ops.nps_ticket', `เปิด Ticket #${ticket.number} ติดตามความเห็น NPS คะแนน ${cur.score ?? '—'} ของ ${cur.workspaceName}`, { type: 'nps_response', id }, cur.workspaceId as string);
    });
    return this.detail(id);
  }

  // ---------------------------------------------------------------- ตั้งค่า (U5)

  async settings(staff: Staff) {
    const [row] = await this.db.select().from(s.npsSettings).where(eq(s.npsSettings.id, 1));
    const v = row ?? (await this.db.insert(s.npsSettings).values({ id: 1 }).onConflictDoNothing().returning())[0] ?? (await this.db.select().from(s.npsSettings).where(eq(s.npsSettings.id, 1)))[0];
    // จำนวนคนที่เข้าเกณฑ์ (ใช้ประมาณ "ถามประมาณ N คน/เดือน") · Workspace ที่ใช้งานอยู่และบัญชีที่ใช้ครบ N วัน
    const [n] = await this.rows<{ admins: number; members: number }>(sql`
      select count(distinct m.user_id) filter (where m.role in ('owner', 'admin'))::int as admins, count(distinct m.user_id)::int as members
      from workspace_members m join workspaces w on w.id = m.workspace_id join users u on u.id = m.user_id
      where m.status = 'active' and m.role <> 'guest' and w.deleted_at is null and w.status in ('trial', 'active') and u.disabled_at is null
        and u.created_at < now() - make_interval(days => ${v.firstAfterDays})`);
    return { settings: this.shapeSettings(v), eligible: { admins: n?.admins ?? 0, members: n?.members ?? 0 }, canEdit: has(staff, 'owner') };
  }

  private shapeSettings(v: typeof s.npsSettings.$inferSelect) {
    const { id: _id, updatedBy: _by, ...rest } = v;
    return rest;
  }

  async saveSettings(staff: Staff, input: z.infer<typeof SettingsBody>) {
    const values = { ...input, questionEn: input.questionEn || null, followUpsEn: input.followUpsEn ?? null, topics: [...new Set(input.topics)], updatedBy: staff.id };
    await this.db.transaction(async (tx) => {
      await tx.insert(s.npsSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: s.npsSettings.id, set: { ...values, updatedAt: new Date() } });
      const who = input.audience === 'admins' ? 'Owner และ Admin' : 'ทุกคนยกเว้น Guest';
      await staffAudit(tx, staff, 'ops.nps_settings', `${input.enabled ? 'เปิด' : 'ปิด'}แบบสำรวจ NPS · ถาม ${who} หลังใช้ ${input.firstAfterDays} วัน ซ้ำทุก ${input.repeatDays} วัน สุ่ม ${input.samplePct}%`);
    });
    return this.settings(staff);
  }
}
