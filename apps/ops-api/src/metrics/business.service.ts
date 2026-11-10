import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { desc, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { upgradeSignals } from './economics.js';

const s = schema;
const DAY = 86_400_000;
type Row = Record<string, unknown>;
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'รูปแบบเดือนต้องเป็น YYYY-MM');
const RESOURCES = ['line_message', 'email', 'storage_gb_month', 'payment_fee_card', 'payment_fee_promptpay', 'etax_doc', 'slip_check'] as const;
const PCT_RESOURCES = new Set(['payment_fee_card', 'payment_fee_promptpay']);

export const RatesBody = z
  .object({
    rates: z
      .array(z.object({ resource: z.enum(RESOURCES), unitCostSatang: z.number().min(0).max(1_000_000).optional(), pct: z.number().min(0).max(100).optional(), effectiveFrom: z.iso.date() }).strict())
      .min(1)
      .max(20),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export const InfraBody = z.object({ month: Month, items: z.array(z.object({ category: z.enum(['aws', 'tools', 'other']), amountSatang: z.number().int().min(0) }).strict()).min(1).max(3) }).strict();
export const MarketingQuery = z.object({ month: Month.optional() });
export const MarketingBody = z
  .object({ month: Month, items: z.array(z.object({ source: z.string().trim().toLowerCase().min(1).max(60), amountSatang: z.number().int().min(0), note: z.string().trim().max(200).optional() }).strict()).min(1).max(30) })
  .strict();
export const BUSINESS_PERIODS = { '30d': 30, quarter: 90, '12m': 365 } as const;
/** ช่วงเวลาของ Funnel / ช่องทาง / เหตุผลยกเลิก / churn (ปุ่มบนหัวหน้า Business) · ค่าเริ่มต้น 90 วันตาม O06 */
export const BusinessQuery = z.object({ refresh: z.enum(['true', 'false']).optional(), period: z.enum(['30d', 'quarter', '12m']).default('quarter') });
type Period = keyof typeof BUSINESS_PERIODS;

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const monthStart = (m: string) => `${m}-01`;
const addMonths = (m: string, n: number) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * ภาพรวม (Main) และธุรกิจและกำไร (Business) · ตัวชี้วัดตาม 05-business-metrics › 2 · เงินเป็นสตางค์ ก่อน VAT
 * หน้าธุรกิจคำนวณทุกคืน (02:00) แล้วเก็บใน cache ของ process · Owner / การเงินสั่งคำนวณใหม่ได้ (`?refresh=true`)
 */
@Injectable()
export class BusinessService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsBusiness');
  private readonly cache = new Map<Period, { at: Date; value: Awaited<ReturnType<BusinessService['compute']>> }>();
  private timer?: NodeJS.Timeout;

  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  onModuleInit() {
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      // ตรวจทุกชั่วโมง · ถึง 02:00 (เวลาไทย) และ cache เก่ากว่า 20 ชม. → คำนวณใหม่
      this.timer = setInterval(() => {
        const hour = new Date(Date.now() + 7 * 3_600_000).getUTCHours();
        const c = this.cache.get('quarter');
        if (hour === 2 && (!c || Date.now() - c.at.getTime() > 20 * 3_600_000)) {
          this.cache.clear();
          void this.refresh().catch((e) => this.log.error(String(e)));
        }
      }, 3_600_000);
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

  /** MRR ต่อ Workspace ณ ตอนนี้: subscription_changes ล่าสุด · ไม่มีประวัติใช้ใบแจ้งหนี้ที่ชำระล่าสุด (ข้อมูลก่อน A34) */
  private currentMrr() {
    return this.rows<{ workspaceId: string; mrr: number; plan: string; cycle: string; paymentMethod: string | null }>(sql`
      with latest as (
        select distinct on (workspace_id) workspace_id, mrr_after_satang from subscription_changes order by workspace_id, effective_at desc, created_at desc
      )
      select s.workspace_id as "workspaceId", p.code as plan, s.cycle, s.payment_method as "paymentMethod",
        coalesce(l.mrr_after_satang, (select case when s.cycle = 'yearly' then i.subtotal / 12 else i.subtotal end from invoices i where i.workspace_id = s.workspace_id and i.status = 'paid' order by i.created_at desc limit 1), 0)::float8 as mrr
      from subscriptions s join plans p on p.id = s.plan_id join workspaces w on w.id = s.workspace_id left join latest l on l.workspace_id = s.workspace_id
      where s.status in ('active', 'past_due') and w.deleted_at is null`);
  }

  /** MRR ต่อ Workspace ณ เวลาหนึ่ง (จากประวัติ subscription_changes เท่านั้น) */
  private async mrrAt(at: Date) {
    const rows = await this.rows<{ workspaceId: string; mrr: number }>(sql`
      select distinct on (workspace_id) workspace_id as "workspaceId", mrr_after_satang::float8 as mrr
      from subscription_changes where effective_at < ${at} order by workspace_id, effective_at desc, created_at desc`);
    return new Map(rows.filter((r) => r.mrr > 0).map((r) => [r.workspaceId, r.mrr]));
  }

  // ---------------------------------------------------------------- ภาพรวม (Main)

  async overview(staff: Staff) {
    const money = has(staff, 'owner', 'finance', 'auditor');
    const month = todayBkk().slice(0, 7);
    const start = new Date(`${monthStart(month)}T00:00:00+07:00`);
    const current = await this.currentMrr();
    const mrr = current.reduce((n, r) => n + r.mrr, 0);
    const paying = current.filter((r) => r.mrr > 0);
    const atStart = await this.mrrAt(start);
    const startMrr = [...atStart.values()].reduce((n, v) => n + v, 0);
    const moves = await this.rows<{ kind: string; n: number; delta: number; lost: number }>(sql`
      select kind, count(*)::int as n, coalesce(sum(mrr_after_satang - mrr_before_satang), 0)::float8 as delta, coalesce(sum(mrr_before_satang), 0)::float8 as lost
      from subscription_changes where effective_at >= ${start} group by kind`);
    const churned = moves.filter((m) => m.kind === 'cancel' || m.kind === 'churn_payment');
    const yearAgo = await this.mrrAt(new Date(Date.now() - 365 * DAY));
    const nowMap = new Map(current.map((r) => [r.workspaceId, r.mrr]));
    const base12 = [...yearAgo.values()].reduce((n, v) => n + v, 0);
    const kept12 = [...yearAgo.keys()].reduce((n, id) => n + (nowMap.get(id) ?? 0), 0);
    const [counts] = await this.rows<Row>(sql`
      select
        (select count(*)::int from subscriptions where status = 'trialing' and trial_ends_at > now()) as trialing,
        (select count(*)::int from subscriptions where status = 'trialing' and trial_ends_at between now() and now() + interval '3 days') as "trialEndingSoon",
        (select count(*)::int from payments where status = 'pending_review' and exception_reason is not null) as "paymentExceptions",
        (select count(*)::int from payments where status = 'pending_review' and exception_reason is null and slip_file_key is not null) as "slipsToReview",
        (select count(*)::int from approval_requests where status = 'pending' and expires_at > now()) as approvals,
        (select count(*)::int from support_tickets where status in ('open', 'pending_dev') and ((first_responded_at is null and first_response_due_at < now()) or resolution_due_at < now())) as "ticketsBreached",
        (select count(*)::int from support_tickets where status = 'open' and assignee_id is null) as "ticketsUnassigned",
        (select count(*)::int from incidents where status <> 'resolved') as "incidentsOpen",
        (select count(*)::int from invoices where status in ('open', 'pending_review') and due_date < ${todayBkk()}::date) as "invoicesOverdue",
        (select count(*)::int from privacy_requests where status = 'open' and due_date <= ${todayBkk()}::date + 7) as "privacyDueSoon",
        (select count(*)::int from data_breaches where closed_at is null) as "breachesOpen"`);
    const movement = Object.fromEntries(moves.map((m) => [m.kind, { count: m.n, mrrDelta: m.delta }]));
    // MRR สิ้นเดือนย้อนหลัง 11 เดือน (จากประวัติ subscription_changes) + เดือนนี้ = ตอนนี้ · ไว้วาดกราฟ 12 เดือนหน้าภาพรวม
    const mrrHistory: { month: string; mrrSatang: number }[] = [];
    if (money) {
      for (let n = 11; n >= 1; n--) {
        const m = addMonths(month, -n);
        const end = await this.mrrAt(new Date(`${monthStart(addMonths(m, 1))}T00:00:00+07:00`));
        mrrHistory.push({ month: m, mrrSatang: [...end.values()].reduce((x, v) => x + v, 0) });
      }
      mrrHistory.push({ month, mrrSatang: mrr });
    }
    return {
      month,
      money: money
        ? {
            mrr,
            arr: mrr * 12,
            payingWorkspaces: paying.length,
            arpa: paying.length ? Math.round(mrr / paying.length) : 0,
            movement,
            netNewMrr: moves.reduce((n, m) => n + m.delta, 0),
            churn: { logoPct: pct(churned.reduce((n, m) => n + m.n, 0), atStart.size), revenuePct: pct(churned.reduce((n, m) => n + m.lost, 0), startMrr), paymentFailures: moves.find((m) => m.kind === 'churn_payment')?.n ?? 0 },
            nrrPct: base12 > 0 ? pct(kept12, base12) : null,
            startMrr,
            mrrHistory,
          }
        : null,
      trialing: Number(counts.trialing),
      tasks: {
        paymentExceptions: counts.paymentExceptions, slipsToReview: counts.slipsToReview, approvals: counts.approvals,
        ticketsBreached: counts.ticketsBreached, ticketsUnassigned: counts.ticketsUnassigned, incidentsOpen: counts.incidentsOpen,
        invoicesOverdue: counts.invoicesOverdue, trialEndingSoon: counts.trialEndingSoon, privacyDueSoon: counts.privacyDueSoon, breachesOpen: counts.breachesOpen,
      },
    };
  }

  // ---------------------------------------------------------------- ธุรกิจและกำไร (Business)

  async business(q: z.infer<typeof BusinessQuery>, staff: Staff) {
    if (q.refresh === 'true') {
      if (!has(staff, 'owner', 'finance')) throw new AppError(403, 'forbidden', 'คำนวณใหม่ได้เฉพาะ Owner และการเงิน');
      return this.refresh(q.period);
    }
    const c = this.cache.get(q.period);
    return c ? { computedAt: c.at, ...c.value } : this.refresh(q.period);
  }

  async refresh(period: Period = 'quarter') {
    const value = await this.compute(period);
    const at = new Date();
    this.cache.set(period, { at, value });
    return { computedAt: at, ...value };
  }

  private async compute(period: Period = 'quarter') {
    const days = BUSINESS_PERIODS[period];
    const since = sql`now() - make_interval(days => ${days})`;
    const months = Math.max(1, Math.round(days / 30));
    const today = todayBkk();
    const month = today.slice(0, 7);
    const current = await this.currentMrr();
    const paying = current.filter((r) => r.mrr > 0);
    const mrr = paying.reduce((n, r) => n + r.mrr, 0);

    // ---- ต้นทุนต่อ Workspace (30 วัน) + ส่วนแบ่งค่าเซิร์ฟเวอร์ตามผู้ใช้งาน 30 วัน
    const rates = await this.db.select().from(s.costRates).orderBy(desc(s.costRates.effectiveFrom));
    const rate = (r: string) => rates.find((x) => x.resource === r && x.effectiveFrom <= today);
    const unit = (r: string) => Number(rate(r)?.unitCostSatang ?? 0);
    const fee = (m: string | null) => Number(rate(m === 'card' ? 'payment_fee_card' : m === 'promptpay' ? 'payment_fee_promptpay' : '')?.pct ?? 0);
    const usage = await this.rows<{ workspaceId: string; line: number; emails: number; storage: number; active: number }>(sql`
      select workspace_id as "workspaceId", coalesce(sum(line_messages), 0)::float8 as line, coalesce(sum(emails), 0)::float8 as emails,
        coalesce(avg(storage_bytes), 0)::float8 as storage, coalesce(avg(active_users), 0)::float8 as active
      from daily_usages where date > ${today}::date - 30 group by workspace_id`);
    const [infra] = await this.rows<{ total: number; month: string | null }>(sql`
      select coalesce(sum(amount_satang), 0)::float8 as total, max(to_char(month, 'YYYY-MM')) as month from infra_costs where month = (select max(month) from infra_costs)`);
    const use = new Map(usage.map((u) => [u.workspaceId, u]));
    const totalActive = paying.reduce((n, p) => n + (use.get(p.workspaceId)?.active ?? 0), 0);
    const names = new Map((await this.rows<{ id: string; slug: string; name: string }>(sql`select id, slug, name from workspaces`)).map((w) => [w.id, w]));
    // ต้นทุนแยกตามทรัพยากร (30 วัน · ลูกค้าที่จ่าย) ไว้แสดงการ์ดต้นทุนการให้บริการ
    const breakdown = { line: 0, email: 0, storage: 0, paymentFees: 0, infra: 0 };
    const perCustomer = paying.map((p) => {
      const u = use.get(p.workspaceId);
      const parts = { line: (u?.line ?? 0) * unit('line_message'), email: (u?.emails ?? 0) * unit('email'), storage: ((u?.storage ?? 0) / 1024 ** 3) * unit('storage_gb_month'), paymentFees: (p.mrr * fee(p.paymentMethod)) / 100 };
      const variable = parts.line + parts.email + parts.storage + parts.paymentFees;
      const infraShare = totalActive > 0 ? (Number(infra.total) * (u?.active ?? 0)) / totalActive : 0;
      for (const k of ['line', 'email', 'storage', 'paymentFees'] as const) breakdown[k] += parts[k];
      breakdown.infra += infraShare;
      const cost = Math.round(variable + infraShare);
      return { workspace: names.get(p.workspaceId) ?? { id: p.workspaceId }, plan: p.plan, revenueSatang: p.mrr, costSatang: cost, grossSatang: p.mrr - cost, marginPct: pct(p.mrr - cost, p.mrr) };
    });
    const plans = [...new Set(perCustomer.map((c) => c.plan))].map((plan) => {
      const list = perCustomer.filter((c) => c.plan === plan);
      const rev = list.reduce((n, c) => n + c.revenueSatang, 0);
      const cost = list.reduce((n, c) => n + c.costSatang, 0);
      return { plan, customers: list.length, revenueSatang: rev, costSatang: cost, marginPct: pct(rev - cost, rev) };
    });
    const totalCost = perCustomer.reduce((n, c) => n + c.costSatang, 0);
    const marginPct = pct(mrr - totalCost, mrr);

    // ---- Funnel 90 วัน: สมัคร → ยืนยันอีเมล → โปรเจกต์แรก → สมาชิกคนที่ 2 → เริ่มใช้จริง (≥ 3 คน และ ≥ 10 งานใน 7 วัน) → จ่ายเงิน
    const [funnel] = await this.rows<Row>(sql`
      with ws as (select id, created_at from workspaces where created_at > ${since} and deleted_at is null)
      select count(*)::int as signups,
        count(*) filter (where exists (select 1 from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ws.id and m.role = 'owner' and u.email_verified_at is not null))::int as "emailVerified",
        count(*) filter (where exists (select 1 from projects p where p.workspace_id = ws.id))::int as "firstProject",
        count(*) filter (where (select count(*) from workspace_members m where m.workspace_id = ws.id) >= 2)::int as "secondMember",
        count(*) filter (where (select count(*) from workspace_members m where m.workspace_id = ws.id and m.joined_at <= ws.created_at + interval '7 days') >= 3
          and (select count(*) from issues i where i.workspace_id = ws.id and i.created_at <= ws.created_at + interval '7 days') >= 10)::int as activated,
        count(*) filter (where exists (select 1 from subscription_changes c where c.workspace_id = ws.id and c.kind = 'new'))::int as paid
      from ws`);
    const [trial] = await this.rows<{ ended: number; converted: number }>(sql`
      select count(*)::int as ended,
        count(*) filter (where exists (select 1 from subscription_changes c where c.workspace_id = s.workspace_id and c.kind = 'new' and c.effective_at <= s.trial_ends_at + interval '14 days'))::int as converted
      from subscriptions s where s.trial_ends_at between ${since} and now()`);

    // ---- Cohort ตามเดือนที่เริ่มจ่าย · % ที่ยังจ่ายเมื่อสิ้นเดือนที่ n
    const changes = await this.rows<{ workspaceId: string; kind: string; mrr: number; at: string }>(sql`
      select workspace_id as "workspaceId", kind, mrr_after_satang::float8 as mrr, to_char(effective_at at time zone 'Asia/Bangkok', 'YYYY-MM') as at
      from subscription_changes where effective_at > now() - interval '13 months' order by effective_at, created_at`);
    const firstPaid = new Map<string, string>();
    for (const c of changes) if (c.kind === 'new' && !firstPaid.has(c.workspaceId)) firstPaid.set(c.workspaceId, c.at);
    const payingAtEnd = (id: string, m: string) => {
      let v = 0;
      for (const c of changes) if (c.workspaceId === id && c.at <= m) v = c.mrr;
      return v > 0;
    };
    const cohorts = [...new Set(firstPaid.values())].sort().map((start) => {
      const ids = [...firstPaid].filter(([, m]) => m === start).map(([id]) => id);
      const retention: (number | null)[] = [];
      for (let n = 0; addMonths(start, n) <= month && n < 12; n++) retention.push(pct(ids.filter((id) => payingAtEnd(id, addMonths(start, n))).length, ids.length));
      return { month: start, customers: ids.length, retention };
    });

    // ---- ช่องทาง ค่าหาลูกค้า LTV (90 วัน · ค่าการตลาด 3 เดือนล่าสุด)
    const channels = await this.rows<{ source: string; newPaying: number }>(sql`
      select coalesce(a.source, 'direct') as source, count(*)::int as "newPaying"
      from subscription_changes c left join workspace_acquisitions a on a.workspace_id = c.workspace_id
      where c.kind = 'new' and c.effective_at > ${since} group by 1`);
    // สมัครใหม่ตามช่องทางในช่วงเดียวกัน → อัตราแปลงเป็นลูกค้าที่จ่าย
    const signups = await this.rows<{ source: string; n: number }>(sql`
      select coalesce(a.source, 'direct') as source, count(*)::int as n
      from workspaces w left join workspace_acquisitions a on a.workspace_id = w.id
      where w.created_at > ${since} and w.deleted_at is null group by 1`);
    const spend = await this.rows<{ source: string; amount: number }>(sql`
      select source, sum(amount_satang)::float8 as amount from marketing_costs where month > (date_trunc('month', now()) - make_interval(months => ${months}))::date group by source`);
    const churnRows = await this.rows<{ lost: number; base: number }>(sql`
      select coalesce(sum(mrr_before_satang) filter (where kind in ('cancel', 'churn_payment')), 0)::float8 as lost, 1 as base
      from subscription_changes where effective_at > ${since}`);
    const monthlyRevenueChurn = mrr > 0 ? Number(churnRows[0].lost) / months / mrr : 0;
    const arpa = paying.length ? mrr / paying.length : 0;
    const marginRatio = (marginPct ?? 0) / 100;
    const ltv = monthlyRevenueChurn > 0 ? Math.round((arpa * marginRatio) / monthlyRevenueChurn) : null;
    const sources = [...new Set([...channels.map((c) => c.source), ...spend.map((x) => x.source), ...signups.map((x) => x.source)])];
    const channelRows = sources.map((source) => {
      const n = channels.find((c) => c.source === source)?.newPaying ?? 0;
      const cost = spend.find((x) => x.source === source)?.amount ?? 0;
      const cac = n > 0 ? Math.round(cost / n) : null;
      const su = signups.find((x) => x.source === source)?.n ?? 0;
      return { source, signups: su, conversionPct: pct(n, su), newPaying: n, spendSatang: cost, cacSatang: cac, paybackMonths: cac != null && arpa * marginRatio > 0 ? Math.round((cac / (arpa * marginRatio)) * 10) / 10 : null };
    });

    // ---- เหตุผลที่ยกเลิก การใช้ฟีเจอร์ พร้อมอัปเกรด
    const reasons = await this.rows(sql`
      select reason, count(*)::int as n, count(*) filter (where outcome = 'kept')::int as kept from cancellation_responses where created_at > ${since} group by reason order by n desc`);
    const payingIds = paying.map((p) => p.workspaceId);
    const features = payingIds.length
      ? await this.rows<{ feature: string; workspaces: number }>(sql`
          select props->>'feature' as feature, count(distinct workspace_id)::int as workspaces from product_events
          where name = 'feature.used' and occurred_at > now() - interval '30 days' and workspace_id in (${sql.join(payingIds.map((id) => sql`${id}`), sql`, `)}) group by 1 order by 2 desc`)
      : [];
    const sig = payingIds.length
      ? await this.rows<Row>(sql`
          select w.id, w.slug, w.name, p.code as plan, p.seat_limit as "seatLimit", p.storage_gb_per_member as "storageGbPerMember", s.cycle, s.status as "subStatus",
            (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
            (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role = 'guest') as guests,
            (select coalesce(sum(size_bytes), 0)::float8 from file_versions f where f.workspace_id = w.id) as storage,
            (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid' and (i.paid_at at time zone 'Asia/Bangkok')::date <= i.due_date) as "onTime",
            coalesce((select json_agg(json_build_object('limit', x.l, 'n', x.n)) from (select props->>'limit' as l, count(*)::int as n from product_events e where e.workspace_id = w.id and e.name = 'limit.hit' and e.occurred_at > now() - interval '14 days' group by 1) x), '[]') as hits
          from workspaces w join subscriptions s on s.workspace_id = w.id join plans p on p.id = s.plan_id where w.id in (${sql.join(payingIds.map((id) => sql`${id}`), sql`, `)})`)
      : [];
    const upgradeReady = sig
      .map((r) => ({
        workspace: { id: r.id, slug: r.slug, name: r.name },
        plan: r.plan,
        signals: upgradeSignals({
          plan: r.plan as string, cycle: r.cycle as string, subStatus: r.subStatus as string, seats: Number(r.seats), seatLimit: (r.seatLimit as number | null) ?? null, guests: Number(r.guests),
          storageBytes: Number(r.storage), storageGbPerMember: (r.storageGbPerMember as number | null) ?? null, limitHits14d: r.hits as { limit: string; n: number }[], paidOnTimeMonths: Number(r.onTime),
        }),
      }))
      .filter((r) => r.signals.length)
      .sort((a, b) => b.signals.length - a.signals.length);

    // ---- ค้างรับตามอายุ · รายได้รับล่วงหน้า · คาดการณ์ MRR
    const [aging] = await this.rows<Row>(sql`
      select coalesce(sum(amount_due) filter (where ${today}::date - due_date between 0 and 30), 0)::float8 as "d0_30",
        coalesce(sum(amount_due) filter (where ${today}::date - due_date between 31 and 60), 0)::float8 as "d31_60",
        coalesce(sum(amount_due) filter (where ${today}::date - due_date > 60), 0)::float8 as "d60plus",
        coalesce(sum(amount_due) filter (where due_date > ${today}::date), 0)::float8 as "notDue"
      from invoices where status in ('open', 'pending_review')`);
    const [deferred] = await this.rows<{ amount: number }>(sql`
      select coalesce(sum(subtotal * greatest(0, (period_end - ${today}::date))::float8 / nullif(period_end - period_start + 1, 0)), 0)::float8 as amount
      from invoices where status = 'paid' and period_end - period_start > 40 and period_end >= ${today}::date`);
    const net3 = await this.rows<{ m: string; delta: number }>(sql`
      select to_char(effective_at at time zone 'Asia/Bangkok', 'YYYY-MM') as m, sum(mrr_after_satang - mrr_before_satang)::float8 as delta
      from subscription_changes where effective_at > (date_trunc('month', now()) - interval '3 months') and effective_at < date_trunc('month', now()) group by 1`);
    // เงินสดรับเดือนนี้ (ใบที่ชำระในเดือนตามเวลาไทย · ยอดรับจริงหลังหัก ณ ที่จ่าย)
    const [cash] = await this.rows<{ amount: number; n: number }>(sql`
      select coalesce(sum(amount_due), 0)::float8 as amount, count(*)::int as n from invoices
      where status = 'paid' and to_char(paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${month}`);
    const avgNet = net3.length ? net3.reduce((n, r) => n + Number(r.delta), 0) / 3 : 0;
    const forecast = [1, 2, 3].map((n) => ({ month: addMonths(month, n), mrrSatang: Math.max(0, Math.round(mrr + avgNet * n)) }));

    return {
      mrrSatang: mrr,
      payingWorkspaces: paying.length,
      arpaSatang: Math.round(arpa),
      period,
      margin: {
        marginPct, revenueSatang: mrr, costSatang: totalCost, infraMonth: infra.month, infraSatang: Number(infra.total), byPlan: plans,
        breakdown: { lineSatang: Math.round(breakdown.line), emailSatang: Math.round(breakdown.email), storageSatang: Math.round(breakdown.storage), paymentFeesSatang: Math.round(breakdown.paymentFees), infraSatang: Math.round(breakdown.infra) },
      },
      cashThisMonth: { month, receivedSatang: Number(cash.amount), invoices: Number(cash.n) },
      customers: {
        top: [...perCustomer].sort((a, b) => b.grossSatang - a.grossSatang).slice(0, 10),
        unprofitable: perCustomer.filter((c) => c.costSatang > c.revenueSatang).sort((a, b) => a.grossSatang - b.grossSatang),
      },
      funnel: { windowDays: days, ...funnel },
      trialConversion: { ended: trial.ended, converted: trial.converted, pct: pct(trial.converted, trial.ended) },
      cohorts,
      channels: channelRows,
      ltvSatang: ltv,
      monthlyRevenueChurnPct: Math.round(monthlyRevenueChurn * 1000) / 10,
      cancellationReasons: reasons,
      featureAdoption: features.map((f) => ({ ...f, pct: pct(f.workspaces, paying.length) })),
      upgradeReady,
      arAging: aging,
      deferredRevenueSatang: Math.round(Number(deferred.amount)),
      forecast,
    };
  }

  // ---------------------------------------------------------------- ภาพรวม: การใช้งานของลูกค้า 30 วัน · กิจกรรมล่าสุด

  /** รวมทุก Workspace ที่ยังไม่ถูกลบ · นับจากตารางของแอปลูกค้าโดยตรง (ไม่อ่านเนื้อหางาน) · การใช้ฟีเจอร์คิดเฉพาะลูกค้าที่จ่ายเงิน */
  async usage() {
    const since = sql`now() - interval '30 days'`;
    const live = (alias: string) => sql.raw(`${alias}.workspace_id in (select id from workspaces where deleted_at is null)`);
    const [u] = await this.rows<Record<string, number>>(sql`
      select
        (select count(distinct a.project_id)::int from activities a where a.created_at > ${since} and a.project_id is not null and ${live('a')}) as "activeProjects",
        (select count(*)::int from projects p where p.deleted_at is null and ${live('p')}) as projects,
        (select count(*)::int from issues i where i.created_at > ${since} and i.deleted_at is null and ${live('i')}) as "issuesCreated",
        (select count(*)::int from issues i where i.completed_at > ${since} and i.deleted_at is null and ${live('i')}) as "issuesClosed",
        (select count(*)::int from comments c where c.created_at > ${since} and c.deleted_at is null and ${live('c')}) as comments,
        (select count(*)::int from comment_mentions m join comments c on c.id = m.comment_id where c.created_at > ${since} and ${live('c')}) as mentions,
        (select count(*)::int from file_versions f where f.created_at > ${since} and ${live('f')}) as files,
        (select coalesce(sum(f.size_bytes), 0)::float8 from file_versions f where f.created_at > ${since} and ${live('f')}) as "fileBytes",
        (select count(*)::int from notification_deliveries d where d.channel = 'line' and d.created_at > ${since} and ${live('d')}) as "lineTotal",
        (select count(*)::int from notification_deliveries d where d.channel = 'line' and d.status = 'sent' and d.created_at > ${since} and ${live('d')}) as "lineSent",
        (select count(*)::int from automation_runs r where r.ran_at > ${since} and ${live('r')}) as "automationRuns",
        (select count(distinct r.workspace_id)::int from automation_runs r where r.ran_at > ${since} and ${live('r')}) as "automationWorkspaces",
        (select coalesce(sum(x.api_calls), 0)::float8 from daily_usages x where x.date > current_date - 30 and ${live('x')}) as "apiCalls",
        (select count(*)::int from api_tokens t where t.revoked_at is null and ${live('t')}) as "apiTokens",
        (select count(*)::int from import_jobs j where j.created_at > ${since} and ${live('j')}) as imports,
        (select count(*)::int from import_jobs j where j.created_at > ${since} and j.status = 'failed' and ${live('j')}) as "importsFailed"`);
    const payingIds = (await this.currentMrr()).filter((r) => r.mrr > 0).map((r) => r.workspaceId);
    const features = payingIds.length
      ? await this.rows<{ feature: string; workspaces: number }>(sql`
          select props->>'feature' as feature, count(distinct workspace_id)::int as workspaces from product_events
          where name = 'feature.used' and occurred_at > ${since} and workspace_id in (${sql.join(payingIds.map((id) => sql`${id}`), sql`, `)}) group by 1 order by 2 desc`)
      : [];
    const n = (k: string) => Number(u[k] ?? 0);
    return {
      days: 30,
      projects: { active: n('activeProjects'), total: n('projects') },
      issues: { created: n('issuesCreated'), closed: n('issuesClosed') },
      comments: { total: n('comments'), mentions: n('mentions') },
      files: { uploaded: n('files'), bytes: n('fileBytes') },
      line: { total: n('lineTotal'), sentPct: pct(n('lineSent'), n('lineTotal')) },
      automation: { runs: n('automationRuns'), workspaces: n('automationWorkspaces') },
      api: { calls: n('apiCalls'), tokens: n('apiTokens') },
      imports: { total: n('imports'), failed: n('importsFailed'), failedPct: pct(n('importsFailed'), n('imports')) },
      payingWorkspaces: payingIds.length,
      featureAdoption: features.map((f) => ({ ...f, pct: pct(f.workspaces, payingIds.length) })),
    };
  }

  /**
   * กิจกรรมล่าสุดจากหลายตาราง (ใหม่สุดก่อน) · ไม่มีจำนวนเงิน
   * การชำระเงินเฉพาะคนที่เห็นเงิน · การกระทำของพนักงานเฉพาะ Owner / ผู้ตรวจ (สิทธิ์เดียวกับ Audit log) ไม่เกิน 3 รายการ ไม่ให้บังเหตุการณ์ของลูกค้า
   */
  async feed(staff: Staff, limit = 10) {
    const money = has(staff, 'owner', 'finance', 'auditor');
    const audit = has(staff, 'owner', 'auditor');
    const parts: SQL[] = [
      sql`select 'signup' as kind, w.created_at as at, w.id as "workspaceId", w.name as "workspaceName",
            json_build_object('plan', p.code, 'trial', s.status = 'trialing', 'members', (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest')) as data
          from workspaces w left join subscriptions s on s.workspace_id = w.id left join plans p on p.id = s.plan_id
          where w.deleted_at is null order by w.created_at desc limit ${limit}`,
      sql`select c.kind, c.effective_at as at, w.id, w.name, json_build_object('from', c.plan_from, 'to', c.plan_to, 'seatsFrom', c.seats_from, 'seatsTo', c.seats_to, 'reason', (select r.reason from cancellation_responses r where r.workspace_id = c.workspace_id and r.outcome = 'canceled' and r.created_at between c.effective_at - interval '1 day' and c.effective_at + interval '1 day' order by r.created_at desc limit 1))
          from subscription_changes c join workspaces w on w.id = c.workspace_id
          where c.kind in ('new', 'upgrade', 'downgrade', 'cancel', 'reactivate', 'churn_payment') and c.effective_at <= now() order by c.effective_at desc limit ${limit}`,
      sql`select 'ticket', k.created_at, w.id, w.name, json_build_object('number', k.number, 'subject', left(k.subject, 120), 'priority', k.priority, 'assignee', a.name)
          from support_tickets k left join workspaces w on w.id = k.workspace_id left join staff_users a on a.id = k.assignee_id order by k.created_at desc limit ${limit}`,
    ];
    if (money)
      parts.push(sql`select 'payment', coalesce(p.reviewed_at, p.updated_at), w.id, w.name, json_build_object('method', p.method, 'invoice', i.number, 'verifiedBy', p.verified_by)
          from payments p join workspaces w on w.id = p.workspace_id left join invoices i on i.id = coalesce(p.matched_invoice_id, p.invoice_id)
          where p.status = 'confirmed' order by coalesce(p.reviewed_at, p.updated_at) desc limit ${limit}`);
    if (audit)
      parts.push(sql`select 'staff', l.created_at, w.id, w.name, json_build_object('action', l.action, 'staff', st.name, 'reason', l.reason)
          from staff_audit_logs l left join staff_users st on st.id = l.staff_id left join workspaces w on w.id = l.workspace_id order by l.created_at desc limit 3`);
    const rows = await this.rows<{ kind: string; at: string | Date; workspaceId: string | null; workspaceName: string | null; data: Record<string, unknown> }>(
      sql`select * from (${sql.join(parts.map((p) => sql`(${p})`), sql` union all `)}) x order by at desc limit ${limit}`,
    );
    return {
      items: rows.map((r) => ({ kind: r.kind, at: new Date(r.at).toISOString(), workspace: r.workspaceId ? { id: r.workspaceId, name: r.workspaceName } : null, data: r.data })),
    };
  }

  // ---------------------------------------------------------------- ตั้งค่าต้นทุน (B9) · ค่าการตลาด (B10)

  async costs() {
    const today = todayBkk();
    const rates = await this.db.select().from(s.costRates).orderBy(s.costRates.resource, desc(s.costRates.effectiveFrom));
    const infra = await this.rows(sql`select to_char(month, 'YYYY-MM') as month, category, amount_satang::float8 as "amountSatang" from infra_costs where month > (date_trunc('month', now()) - interval '6 months')::date order by month desc, category`);
    return {
      rates: RESOURCES.map((r) => {
        const list = rates.filter((x) => x.resource === r);
        return { resource: r, kind: PCT_RESOURCES.has(r) ? 'pct' : 'unit', current: list.find((x) => x.effectiveFrom <= today) ?? null, scheduled: list.filter((x) => x.effectiveFrom > today), history: list.filter((x) => x.effectiveFrom <= today).slice(1) };
      }),
      infra,
      allocation: 'แบ่งค่าใช้จ่ายส่วนกลางของเดือนล่าสุดให้ลูกค้าที่จ่ายเงินตามผู้ใช้งานเฉลี่ย 30 วัน',
    };
  }

  /** ต้นทุนต่อหน่วย · ค่าธรรมเนียมรับเงินเป็น % · อื่นเป็นสตางค์ต่อหน่วย (ทศนิยมได้) · มีผลตั้งแต่วันที่กำหนด */
  async setRates(staff: Staff, input: z.infer<typeof RatesBody>) {
    for (const r of input.rates) {
      const wantPct = PCT_RESOURCES.has(r.resource);
      if (wantPct ? r.pct === undefined || r.unitCostSatang !== undefined : r.unitCostSatang === undefined || r.pct !== undefined) {
        throw new AppError(422, 'rate_kind_mismatch', `${r.resource} ต้องกรอก${wantPct ? 'เป็น %' : 'เป็นสตางค์ต่อหน่วย'}`, { resource: r.resource });
      }
    }
    await this.db.transaction(async (tx) => {
      for (const r of input.rates) {
        await tx
          .insert(s.costRates)
          .values({ resource: r.resource, unitCostSatang: r.unitCostSatang ?? null, pct: r.pct ?? null, effectiveFrom: r.effectiveFrom, createdBy: staff.id })
          .onConflictDoUpdate({ target: [s.costRates.resource, s.costRates.effectiveFrom], set: { unitCostSatang: r.unitCostSatang ?? null, pct: r.pct ?? null, createdBy: staff.id } });
      }
      await staffAudit(tx, staff, 'metrics.cost_rates_set', `${input.rates.map((r) => `${r.resource}=${r.pct ?? r.unitCostSatang}${r.pct !== undefined ? '%' : ''} ตั้งแต่ ${r.effectiveFrom}`).join(' · ')} · ${input.reason}`);
    });
    this.cache.clear();
    return this.costs();
  }

  async setInfra(staff: Staff, input: z.infer<typeof InfraBody>) {
    await this.db.transaction(async (tx) => {
      for (const i of input.items) {
        await tx.insert(s.infraCosts).values({ month: monthStart(input.month), category: i.category, amountSatang: i.amountSatang }).onConflictDoUpdate({ target: [s.infraCosts.month, s.infraCosts.category], set: { amountSatang: i.amountSatang } });
      }
      await staffAudit(tx, staff, 'metrics.infra_costs_set', `${input.month} · ${input.items.map((i) => `${i.category} ${i.amountSatang / 100} บาท`).join(' · ')}`);
    });
    this.cache.clear();
    return this.costs();
  }

  async marketing(q: z.infer<typeof MarketingQuery>) {
    const month = q.month ?? todayBkk().slice(0, 7);
    const items = await this.rows(sql`select source, amount_satang::float8 as "amountSatang", note from marketing_costs where month = ${monthStart(month)}::date order by source`);
    // ช่องทางที่มีลูกค้า (utm_source) แต่ยังไม่กรอกค่าใช้จ่าย
    const known = await this.rows<{ source: string }>(sql`select distinct source from workspace_acquisitions where source is not null order by 1`);
    return { month, items, sources: known.map((k) => k.source), totalSatang: items.reduce((n, i) => n + Number(i.amountSatang), 0) };
  }

  async setMarketing(staff: Staff, input: z.infer<typeof MarketingBody>) {
    if (input.month > todayBkk().slice(0, 7)) throw new AppError(422, 'month_in_future', 'กรอกได้ถึงเดือนปัจจุบัน');
    await this.db.transaction(async (tx) => {
      for (const i of input.items) {
        await tx.insert(s.marketingCosts).values({ month: monthStart(input.month), source: i.source, amountSatang: i.amountSatang, note: i.note ?? null }).onConflictDoUpdate({ target: [s.marketingCosts.month, s.marketingCosts.source], set: { amountSatang: i.amountSatang, note: i.note ?? null } });
      }
      await staffAudit(tx, staff, 'metrics.marketing_costs_set', `${input.month} · ${input.items.map((i) => `${i.source} ${i.amountSatang / 100} บาท`).join(' · ')}`);
    });
    this.cache.clear();
    return this.marketing({ month: input.month });
  }
}
