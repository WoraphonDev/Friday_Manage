import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { healthScore, mrrOf, profitOf, upgradeSignals } from './economics.js';

const s = schema;
const PLAN_CODES = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
export const FEATURES = ['line', 'webhook', 'github', 'api_token', 'automation', 'import', 'no_project'] as const;

export const ListQuery = z.object({
  plan: z.enum(PLAN_CODES).optional(),
  status: z.enum(['trial', 'active', 'suspended', 'pending_delete', 'trialing', 'canceled', 'past_due']).optional(),
  q: z.string().trim().max(100).optional(),
  /** ใช้ฟีเจอร์ / การเชื่อมต่อ (หน้าจอ: ตัวกรอง "ใช้ฟีเจอร์") */
  feature: z.enum(FEATURES).optional(),
  sort: z.enum(['newest', 'recent_activity', 'mrr', 'health']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const AuditQuery = z.object({
  category: z.string().trim().max(20).optional(),
  fridayOnly: z.enum(['true', 'false']).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** เห็นยอดเงินรายลูกค้า: Owner การเงิน ผู้ตรวจ · Support เห็นแค่สถานะ · วิศวกรไม่เห็นเลย (06 › 2) */
export const seesMoney = (st: Staff) => has(st, 'owner', 'finance', 'auditor');
/** วิศวกรเห็นรหัสและชื่อ Workspace แต่ไม่เห็นอีเมลลูกค้า */
export const seesEmail = (st: Staff) => has(st, 'owner', 'finance', 'support', 'auditor');

type Row = Record<string, unknown>;

/**
 * อ่านข้อมูลลูกค้าสำหรับหน้า Workspaces และรายละเอียด 9 แท็บ (O02)
 * ส่งเฉพาะข้อมูลสรุป ไม่ส่งเนื้อหางาน (ชื่องาน คอมเมนต์ ไฟล์) · ดูงานจริงต้องเข้าบัญชีเพื่อช่วยเหลือ
 */
@Injectable()
export class CustomersService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** ตัวเลขสรุปต่อ Workspace ที่ทั้งรายการและหน้ารายละเอียดใช้ */
  private summary(where: SQL) {
    return this.rows<Row>(sql`
      select w.id, w.slug, w.name, w.status, w.data_region as "dataRegion", w.created_at as "createdAt",
        p.code as plan, p.seat_limit as "seatLimit", p.storage_gb_per_member as "storageGbPerMember",
        p.price_monthly_satang::float8 as "priceMonthlySatang", p.price_yearly_satang::float8 as "priceYearlySatang",
        sub.status as "subStatus", sub.cycle, sub.trial_ends_at as "trialEndsAt", sub.current_period_end as "periodEnd", sub.discount, sub.payment_method as "paymentMethod",
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role = 'guest') as guests,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest' and m.joined_at < now() - interval '30 days') as "seats30dAgo",
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.last_active_at > now() - interval '30 days') as active30,
        (select max(m.last_active_at) from workspace_members m where m.workspace_id = w.id) as "lastActiveAt",
        (select count(*)::int from projects x where x.workspace_id = w.id and x.deleted_at is null and x.archived_at is null) as projects,
        (select coalesce(sum(x.size_bytes), 0)::float8 from file_versions x where x.workspace_id = w.id) as "storageBytes",
        exists(select 1 from line_oa_configs x where x.workspace_id = w.id) as line,
        exists(select 1 from webhook_endpoints x where x.workspace_id = w.id and x.status = 'active') as webhook,
        exists(select 1 from git_installations x where x.workspace_id = w.id and x.status = 'active') as github,
        exists(select 1 from api_tokens x where x.workspace_id = w.id and x.revoked_at is null) as "apiToken",
        exists(select 1 from automation_rules x where x.workspace_id = w.id and x.enabled) as automation,
        exists(select 1 from import_jobs x where x.workspace_id = w.id) as "import",
        (select c.mrr_after_satang::float8 from subscription_changes c where c.workspace_id = w.id order by c.effective_at desc, c.created_at desc limit 1) as "lastMrr",
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status in ('open', 'pending_review') and i.due_date < current_date) as overdue,
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid') as "paidTotal",
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid' and (i.paid_at at time zone 'Asia/Bangkok')::date <= i.due_date) as "paidOnTime",
        (select count(*)::int from support_tickets k where k.workspace_id = w.id and k.status in ('open', 'pending_customer', 'pending_dev')) as "openTickets"
      from workspaces w
      left join subscriptions sub on sub.workspace_id = w.id
      left join plans p on p.id = sub.plan_id
      where ${where}`);
  }

  private shape(r: Row, staff: Staff) {
    const n = (k: string) => Number(r[k] ?? 0);
    const health = healthScore({ seats: n('seats'), active30: n('active30'), overdueInvoices: n('overdue'), paidOnTime: n('paidOnTime'), paidTotal: n('paidTotal'), openTickets: n('openTickets'), membersNow: n('seats'), members30dAgo: n('seats30dAgo') });
    const mrr = mrrOf(
      r.subStatus ? { status: r.subStatus as string, cycle: r.cycle as string, discount: r.discount } : null,
      r.plan ? { priceMonthlySatang: (r.priceMonthlySatang as number | null) ?? null, priceYearlySatang: (r.priceYearlySatang as number | null) ?? null } : null,
      r.lastMrr == null ? null : Number(r.lastMrr),
    );
    const integrations = (['line', 'webhook', 'github', 'apiToken', 'automation', 'import'] as const).filter((k) => r[k]);
    return {
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      status: r.status as string,
      createdAt: r.createdAt,
      plan: (r.plan as string | null) ?? null,
      subStatus: (r.subStatus as string | null) ?? null,
      cycle: (r.cycle as string | null) ?? null,
      trialEndsAt: r.trialEndsAt ?? null,
      periodEnd: r.periodEnd ?? null,
      seats: n('seats'),
      seatLimit: (r.seatLimit as number | null) ?? null,
      projects: n('projects'),
      active30: n('active30'),
      lastActiveAt: r.lastActiveAt ?? null,
      storageBytes: n('storageBytes'),
      integrations,
      health: health.score,
      /** Support / วิศวกรไม่เห็นยอดเงิน */
      mrr: seesMoney(staff) ? mrr : null,
      paymentState: n('overdue') > 0 ? 'overdue' : 'ok',
      _mrr: mrr,
      _health: health,
    };
  }

  async list(staff: Staff, q: z.infer<typeof ListQuery>) {
    const parts: SQL[] = [sql`w.deleted_at is null`];
    if (q.q) parts.push(sql`(w.name ilike ${`%${q.q}%`} or w.slug ilike ${`%${q.q}%`})`);
    if (q.plan) parts.push(sql`p.code = ${q.plan}`);
    if (q.status) parts.push(['trialing', 'canceled', 'past_due'].includes(q.status) ? sql`sub.status = ${q.status}` : sql`w.status = ${q.status}`);
    const feature: Record<(typeof FEATURES)[number], SQL> = {
      line: sql`exists(select 1 from line_oa_configs x where x.workspace_id = w.id)`,
      webhook: sql`exists(select 1 from webhook_endpoints x where x.workspace_id = w.id and x.status = 'active')`,
      github: sql`exists(select 1 from git_installations x where x.workspace_id = w.id and x.status = 'active')`,
      api_token: sql`exists(select 1 from api_tokens x where x.workspace_id = w.id and x.revoked_at is null)`,
      automation: sql`exists(select 1 from automation_rules x where x.workspace_id = w.id and x.enabled)`,
      import: sql`exists(select 1 from import_jobs x where x.workspace_id = w.id)`,
      no_project: sql`not exists(select 1 from projects x where x.workspace_id = w.id and x.deleted_at is null)`,
    };
    if (q.feature) parts.push(feature[q.feature]);
    // เรียงด้วยคะแนนที่คำนวณใน JS จึงดึงทั้งชุดที่ผ่านตัวกรองก่อน (ลูกค้าระดับหลักพันยังเร็วพอ)
    const all = (await this.summary(sql.join(parts, sql` and `))).map((r) => this.shape(r, staff));
    const time = (v: unknown) => (v ? new Date(v as string).getTime() : 0);
    const by: Record<typeof q.sort, (a: (typeof all)[number], b: (typeof all)[number]) => number> = {
      newest: (a, b) => time(b.createdAt) - time(a.createdAt),
      recent_activity: (a, b) => time(b.lastActiveAt) - time(a.lastActiveAt),
      mrr: (a, b) => b._mrr - a._mrr,
      health: (a, b) => a.health - b.health,
    };
    // เรียงตาม MRR ใช้ยอดเงิน · คนที่ไม่เห็นเงินได้ลำดับใหม่สุดแทน (ไม่ให้เดายอดจากลำดับได้)
    const sort = q.sort === 'mrr' && !seesMoney(staff) ? 'newest' : q.sort;
    all.sort(by[sort]);
    const items = all.slice(q.offset, q.offset + q.limit).map(({ _mrr, _health, ...x }) => x);
    return { items, total: all.length, limit: q.limit, offset: q.offset, sort };
  }

  private async one(staff: Staff, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [r] = await this.summary(sql`w.id = ${id}`);
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    return { raw: r, x: this.shape(r, staff) };
  }

  /** แท็บภาพรวม · คงรูปแบบเดิมของ A32 (subscription / usage / owners / supportAccess / supportSessions / invoices) แล้วเพิ่มของ O02 */
  async overview(staff: Staff, id: string) {
    const { raw, x } = await this.one(staff, id);
    const owners = await this.db
      .select({ id: s.users.id, email: s.users.email, displayName: s.users.displayName, role: s.workspaceMembers.role })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, id), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.role, ['owner', 'admin'])));
    const [counts] = await this.rows<{ issues: number; projectsAll: number }>(sql`
      select (select count(*)::int from issues where workspace_id = ${id} and deleted_at is null) as issues,
             (select count(*)::int from projects where workspace_id = ${id} and deleted_at is null) as "projectsAll"`);
    const [grant] = await this.db.select().from(s.supportAccessGrants).where(eq(s.supportAccessGrants.workspaceId, id));
    const sessions = await this.db.select().from(s.supportSessions).where(eq(s.supportSessions.workspaceId, id)).orderBy(desc(s.supportSessions.startedAt)).limit(10);
    const invoices = await this.db
      .select({ id: s.invoices.id, number: s.invoices.number, status: s.invoices.status, total: s.invoices.total, amountDue: s.invoices.amountDue, dueDate: s.invoices.dueDate, paidAt: s.invoices.paidAt, createdAt: s.invoices.createdAt })
      .from(s.invoices)
      .where(eq(s.invoices.workspaceId, id))
      .orderBy(desc(s.invoices.createdAt))
      .limit(10);
    const [sub] = await this.db.select().from(s.subscriptions).where(eq(s.subscriptions.workspaceId, id));
    const [profile] = await this.db.select({ companyName: s.billingProfiles.companyName }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, id));
    const [acq] = await this.rows<Row>(sql`select * from workspace_acquisitions where workspace_id = ${id} limit 1`);
    const hits = await this.rows<{ limit: string; n: number }>(sql`
      select props->>'limit' as "limit", count(*)::int as n from product_events
      where workspace_id = ${id} and name = 'limit.hit' and occurred_at > now() - interval '14 days' group by 1`);
    const used = await this.rows<{ feature: string; n: number }>(sql`
      select props->>'feature' as feature, count(*)::int as n from product_events
      where workspace_id = ${id} and name = 'feature.used' and occurred_at > now() - interval '30 days' group by 1 order by 2 desc`);
    const notes = await this.db
      .select({ id: s.staffAuditLogs.id, text: s.staffAuditLogs.reason, staffId: s.staffAuditLogs.staffId, staffName: s.staffUsers.name, createdAt: s.staffAuditLogs.createdAt })
      .from(s.staffAuditLogs)
      .leftJoin(s.staffUsers, eq(s.staffUsers.id, s.staffAuditLogs.staffId))
      .where(and(eq(s.staffAuditLogs.workspaceId, id), eq(s.staffAuditLogs.action, 'ops.note')))
      .orderBy(desc(s.staffAuditLogs.createdAt))
      .limit(20);
    const money = seesMoney(staff);
    const paidMonths = Number(raw.paidTotal ?? 0) * (raw.cycle === 'yearly' ? 12 : 1);
    const signals = upgradeSignals({
      plan: x.plan, cycle: x.cycle, subStatus: x.subStatus, seats: x.seats, seatLimit: x.seatLimit, storageBytes: x.storageBytes,
      storageGbPerMember: (raw.storageGbPerMember as number | null) ?? null, limitHits14d: hits, paidMonths,
    });
    return {
      id: x.id,
      slug: x.slug,
      name: x.name,
      status: x.status,
      createdAt: x.createdAt,
      dataRegion: raw.dataRegion,
      legalName: profile?.companyName ?? null,
      subscription: sub
        ? { plan: x.plan, status: sub.status, cycle: sub.cycle, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, paymentMethod: sub.paymentMethod, discount: money ? sub.discount : sub.discount ? { active: true } : null, seatLimit: x.seatLimit }
        : null,
      usage: { members: x.seats, guests: Number(raw.guests ?? 0), projects: counts.projectsAll, issues: counts.issues, storageBytes: x.storageBytes, active30: x.active30, lastActiveAt: x.lastActiveAt },
      owners: owners.map((o) => ({ ...o, email: seesEmail(staff) ? o.email : null })),
      supportAccess: grant ? { until: grant.until, maxMode: grant.maxMode, notifyAdmins: grant.notifyAdmins, active: !grant.until || grant.until.getTime() > Date.now() } : null,
      supportSessions: sessions,
      invoices: invoices.map((i) => (money ? i : { ...i, total: null, amountDue: null })),
      health: x._health,
      integrations: x.integrations,
      topFeatures: used.slice(0, 3).map((u) => u.feature),
      unusedFeatures: (['line', 'automation', 'webhook', 'github', 'import'] as const).filter((f) => !used.some((u) => u.feature === f) && !x.integrations.includes(f as never)),
      acquisition: acq ? { source: acq.source ?? null, medium: acq.medium ?? null, campaign: acq.campaign ?? null, referrerHost: acq.referrer_host ?? null, via: acq.via } : null,
      economics: money ? { mrrSatang: x._mrr, ...(await profitOf(this.db, id, x._mrr, sub?.paymentMethod ?? null)) } : null,
      upgradeSignals: signals,
      notes,
    };
  }

  /** แท็บการใช้งาน: ขีดจำกัดแพ็กเกจ ผู้ใช้รายวัน การใช้ฟีเจอร์ และการนำเข้า / ส่งออกล่าสุด */
  async usage(staff: Staff, id: string) {
    const { raw, x } = await this.one(staff, id);
    const daily = await this.rows<{ date: string; activeUsers: number }>(sql`
      select to_char(date, 'YYYY-MM-DD') as date, active_users as "activeUsers" from daily_usages
      where workspace_id = ${id} and date > current_date - 30 order by date`);
    const features = await this.rows<Row>(sql`
      select props->>'feature' as feature, count(distinct user_id)::int as users, count(*)::int as times, max(occurred_at) as "lastUsedAt"
      from product_events where workspace_id = ${id} and name = 'feature.used' and occurred_at > now() - interval '30 days' group by 1 order by times desc`);
    const imports = await this.rows<Row>(sql`
      select i.id, 'import' as kind, i.created_at as "at", pr.key as project, i.file_name as file, i.status, i.row_imported as rows, u.display_name as "by"
      from import_jobs i left join projects pr on pr.id = i.project_id left join users u on u.id = i.created_by
      where i.workspace_id = ${id} order by i.created_at desc limit 10`);
    const storageCap = raw.storageGbPerMember ? Number(raw.storageGbPerMember) * Math.max(x.seats, 1) * 1024 ** 3 : null;
    return {
      limits: [
        { key: 'seats', used: x.seats, max: x.seatLimit },
        { key: 'storage_bytes', used: x.storageBytes, max: storageCap },
        { key: 'projects', used: x.projects, max: null },
      ],
      dailyActiveUsers: daily,
      averageDailyActive: daily.length ? Math.round(daily.reduce((n, d) => n + d.activeUsers, 0) / daily.length) : 0,
      features,
      imports,
    };
  }

  /** แท็บโปรเจกต์: สรุปเท่านั้น (ชื่อ จำนวน ความคืบหน้า) ไม่ส่งชื่องาน */
  async projects(staff: Staff, id: string) {
    await this.one(staff, id);
    const items = await this.rows<Row>(sql`
      select p.id, p.key, p.name, p.status, p.golive_date as "goliveDate", p.archived_at as "archivedAt", p.updated_at as "updatedAt",
        t.name as template,
        (select count(*)::int from project_members m where m.project_id = p.id) as members,
        (select count(*)::int from issues i where i.project_id = p.id and i.deleted_at is null) as "issuesTotal",
        (select count(*)::int from issues i where i.project_id = p.id and i.deleted_at is null and i.completed_at is null) as "issuesOpen",
        (select max(i.updated_at) from issues i where i.project_id = p.id) as "lastActivityAt"
      from projects p left join project_templates t on t.id = p.template_id
      where p.workspace_id = ${id} and p.deleted_at is null order by p.archived_at nulls first, p.updated_at desc`);
    return {
      items: items.map((p) => ({ ...p, progress: Number(p.issuesTotal) > 0 ? Math.round(((Number(p.issuesTotal) - Number(p.issuesOpen)) / Number(p.issuesTotal)) * 100) : 0 })),
      active: items.filter((p) => !p.archivedAt).length,
      archived: items.filter((p) => p.archivedAt).length,
    };
  }

  /** แท็บผู้ใช้: สมาชิก วิธีล็อกอิน 2FA คำเชิญที่ค้าง · ที่นั่งนับเฉพาะสมาชิก (Guest ไม่นับ) */
  async members(staff: Staff, id: string) {
    const { x } = await this.one(staff, id);
    const email = seesEmail(staff);
    const items = await this.rows<Row>(sql`
      select u.id, u.email, u.display_name as "displayName", m.role, m.job_title as "jobTitle", m.status, m.last_active_at as "lastActiveAt", m.joined_at as "joinedAt",
        (u.password_hash is not null) as "hasPassword",
        coalesce((select array_agg(distinct i.provider::text) from user_identities i where i.user_id = u.id), '{}') as providers,
        exists(select 1 from mfa_factors f where f.user_id = u.id and f.enabled_at is not null) as "mfaEnabled",
        (u.locked_until is not null and u.locked_until > now()) as locked, (u.disabled_at is not null) as disabled
      from workspace_members m join users u on u.id = m.user_id
      where m.workspace_id = ${id} order by (m.role = 'owner') desc, m.status, u.display_name`);
    const invitations = await this.rows<Row>(sql`
      select id, email, workspace_role as role, created_at as "sentAt", expires_at as "expiresAt" from invitations
      where workspace_id = ${id} and status = 'pending' and expires_at > now() order by created_at desc`);
    const [links] = await this.rows<{ n: number; nextExpiry: string | null }>(sql`
      select count(*)::int as n, min(expires_at) as "nextExpiry" from invite_links where workspace_id = ${id} and revoked_at is null and (expires_at is null or expires_at > now())`);
    const login = (r: Row) => [...(r.hasPassword ? ['password'] : []), ...((r.providers as string[]) ?? [])];
    return {
      seats: x.seats,
      items: items.map((r) => ({ id: r.id, email: email ? r.email : null, displayName: r.displayName, role: r.role, jobTitle: r.jobTitle, status: r.status, lastActiveAt: r.lastActiveAt, joinedAt: r.joinedAt, login: login(r), mfaEnabled: r.mfaEnabled, locked: r.locked, disabled: r.disabled })),
      invitations: invitations.map((i) => ({ ...i, email: email ? i.email : null })),
      inviteLinks: { active: links?.n ?? 0, nextExpiry: links?.nextExpiry ?? null },
    };
  }

  /** แท็บการเชื่อมต่อ: เห็นแค่ชื่อ สิทธิ์ และ 4 ตัวท้าย ไม่เห็นค่า token / URL เต็ม */
  async integrations(staff: Staff, id: string) {
    await this.one(staff, id);
    const webhooks = await this.rows<Row>(sql`
      select id, name, format, status, url_last4 as "urlLast4", consecutive_failures as failures, paused_until as "pausedUntil", created_at as "createdAt"
      from webhook_endpoints where workspace_id = ${id} order by created_at`);
    const deliveries = await this.rows<Row>(sql`
      select channel::text as channel, count(*) filter (where status::text = 'sent')::int as sent, count(*)::int as total
      from notification_deliveries where workspace_id = ${id} and created_at > now() - interval '7 days' group by 1`);
    const tokens = await this.rows<Row>(sql`
      select t.id, t.name, t.scopes, t.last_used_at as "lastUsedAt", t.revoked_at as "revokedAt", t.created_at as "createdAt", u.display_name as "createdBy"
      from api_tokens t left join users u on u.id = t.created_by where t.workspace_id = ${id} order by t.created_at desc`);
    const [line] = await this.rows<Row>(sql`select channel_id as "channelId", fallback_to_email as "fallbackToEmail", created_at as "createdAt" from line_oa_configs where workspace_id = ${id}`);
    const git = await this.rows<Row>(sql`select id, provider::text as provider, account_name as "accountName", status, created_at as "createdAt" from git_installations where workspace_id = ${id}`);
    const [automation] = await this.rows<{ enabled: number; total: number }>(sql`select count(*) filter (where enabled)::int as enabled, count(*)::int as total from automation_rules where workspace_id = ${id}`);
    return { webhooks, deliveries7d: deliveries, apiTokens: tokens, line: line ?? null, git, automation };
  }

  /** แท็บความปลอดภัย: การตั้งค่าของลูกค้า + เหตุการณ์ด้านความปลอดภัย 30 วัน */
  async security(staff: Staff, id: string) {
    await this.one(staff, id);
    const [policy] = await this.db.select().from(s.securityPolicies).where(eq(s.securityPolicies.workspaceId, id));
    const [settings] = await this.db.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, id));
    const events = await this.db
      .select({ id: s.auditLogs.id, at: s.auditLogs.createdAt, action: s.auditLogs.action, actorKind: s.auditLogs.actorKind, summary: s.auditLogs.summary, ip: s.auditLogs.ip })
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.workspaceId, id), eq(s.auditLogs.category, 'secu'), sql`${s.auditLogs.createdAt} > now() - interval '30 days'`))
      .orderBy(desc(s.auditLogs.createdAt))
      .limit(50);
    const { ipAllowlist, allowedEmailDomains, ...rest } = policy ?? ({} as Partial<typeof s.securityPolicies.$inferSelect>);
    return {
      policy: policy ? { ...rest, ipAllowlistCount: ipAllowlist?.length ?? 0, allowedEmailDomains: seesEmail(staff) ? allowedEmailDomains : null } : null,
      settings: settings ? { workStart: settings.workStart, workEnd: settings.workEnd, workDays: settings.workDays, holidayCalendarId: settings.holidayCalendarId, safeMode: settings.safeMode, trashDays: settings.trashDays } : null,
      events: events.map((e) => ({ ...e, ip: seesEmail(staff) ? e.ip : null })),
    };
  }

  /** แท็บการเงิน · Support เห็นแค่สถานะจ่ายแล้ว / ค้าง ไม่เห็นยอด */
  async billing(staff: Staff, id: string) {
    const { x } = await this.one(staff, id);
    const money = seesMoney(staff);
    const [profile] = await this.db.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, id));
    const invoices = await this.rows<Row>(sql`
      select i.id, i.number, i.period_start as "periodStart", i.period_end as "periodEnd", i.status, i.total::float8 as total, i.amount_due::float8 as "amountDue", i.due_date as "dueDate", i.paid_at as "paidAt",
        (select p.method::text from payments p where p.invoice_id = i.id order by p.created_at desc limit 1) as method,
        exists(select 1 from tax_documents d where d.invoice_id = i.id) as "hasTaxDocument"
      from invoices i where i.workspace_id = ${id} order by i.created_at desc limit 50`);
    const history = await this.rows<Row>(sql`
      select effective_at as "at", kind, plan_from as "planFrom", plan_to as "planTo", mrr_before_satang::float8 as "mrrBefore", mrr_after_satang::float8 as "mrrAfter", actor_kind as "actorKind"
      from subscription_changes where workspace_id = ${id} order by effective_at desc limit 50`);
    const [credit] = await this.rows<{ balance: number }>(sql`select coalesce(sum(amount_satang), 0)::float8 as balance from workspace_credits where workspace_id = ${id}`);
    const paid = invoices.filter((i) => i.status === 'paid');
    const onTime = paid.filter((i) => i.paidAt && new Date(i.paidAt as string).toISOString().slice(0, 10) <= String(i.dueDate).slice(0, 10)).length;
    return {
      profile: profile && money ? { companyName: profile.companyName, taxId: profile.taxId, branchType: profile.branchType, branchNo: profile.branchNo, address: profile.address, taxEmail: profile.taxEmail, whtEnabled: profile.whtEnabled } : profile ? { companyName: profile.companyName } : null,
      paymentState: x.paymentState,
      onTime: { paid: paid.length, onTime },
      invoices: invoices.map((i) => (money ? i : { ...i, total: null, amountDue: null })),
      history: money ? history : history.map(({ mrrBefore, mrrAfter, ...h }) => h),
      creditBalanceSatang: money ? Number(credit?.balance ?? 0) : null,
    };
  }

  /** แท็บ Support: Ticket ของลูกค้านี้ (หัวข้อ สถานะ คะแนน) และประวัติการเข้าบัญชี · ไม่ส่งข้อความใน Ticket */
  async support(staff: Staff, id: string) {
    await this.one(staff, id);
    const tickets = await this.rows<Row>(sql`
      select k.id, k.number, k.subject, k.status, k.priority, k.created_at as "createdAt", k.csat, st.name as assignee
      from support_tickets k left join staff_users st on st.id = k.assignee_id where k.workspace_id = ${id} order by k.created_at desc limit 50`);
    const rated = tickets.filter((k) => k.csat != null);
    const sessions = await this.rows<Row>(sql`
      select x.id, x.ticket_no as "ticketNo", x.mode, x.reason, x.started_at as "startedAt", x.ended_at as "endedAt", st.name as "staffName"
      from support_sessions x join staff_users st on st.id = x.staff_id where x.workspace_id = ${id} order by x.started_at desc limit 20`);
    return { tickets, csatAverage: rated.length ? Math.round((rated.reduce((n, k) => n + Number(k.csat), 0) / rated.length) * 10) / 10 : null, sessions };
  }

  /** แท็บ Audit log: ชุดเดียวกับที่ Owner / Admin ของลูกค้าเห็น · รายการของทีม Friday มีป้าย */
  async audit(staff: Staff, id: string, q: z.infer<typeof AuditQuery>) {
    await this.one(staff, id);
    const rows = await this.db
      .select({ id: s.auditLogs.id, at: s.auditLogs.createdAt, actorKind: s.auditLogs.actorKind, actorName: s.users.displayName, category: s.auditLogs.category, action: s.auditLogs.action, summary: s.auditLogs.summary, ip: s.auditLogs.ip })
      .from(s.auditLogs)
      .leftJoin(s.users, eq(s.users.id, s.auditLogs.actorId))
      .where(
        and(
          eq(s.auditLogs.workspaceId, id),
          q.category ? sql`${s.auditLogs.category}::text = ${q.category}` : undefined,
          q.fridayOnly === 'true' ? eq(s.auditLogs.actorKind, 'friday_staff') : undefined,
          q.before ? lt(s.auditLogs.createdAt, new Date(q.before)) : undefined,
        ),
      )
      .orderBy(desc(s.auditLogs.createdAt))
      .limit(q.limit);
    const items = rows.map((r) => ({ ...r, friday: r.actorKind === 'friday_staff', actorName: r.actorKind === 'friday_staff' ? null : r.actorName, ip: seesEmail(staff) ? r.ip : null }));
    return { items, nextBefore: rows.length === q.limit ? (rows[rows.length - 1].at as Date).toISOString() : null };
  }
}
