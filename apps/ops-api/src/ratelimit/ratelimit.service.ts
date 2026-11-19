import { Inject, Injectable } from '@nestjs/common';
import { type Db, type EntitlementPlan, ENTITLEMENT_PLANS, schema, type Tx, versionAt } from '@friday/db';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { billingContacts, mailAll } from '../billing/ledger.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { EntitlementsService, type Gated } from '../entitlements/entitlements.service.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PageQuery } from '../paging.js';

const s = schema;
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** ชนเพดานติดกันกี่นาทีจึงขึ้น "ต้องทำตอนนี้" (มักแปลว่าระบบของลูกค้าวนเรียกซ้ำ) */
export const STREAK_ALERT = 15;
/** เรียกถึงกี่ % ของเพดานนับเป็น "ใกล้เพดาน" */
const NEAR = 0.8;
/** ปรับเพดานชั่วคราวได้ถึง 3 เท่าของแพ็กเกจโดยไม่ต้องอนุมัติ · เกินต้องให้ Owner อนุมัติ (storyboard ขั้น 2) */
const HEADROOM = 3;
const NOTIFY_GAP_MS = HOUR;

export const ListQuery = PageQuery.extend({
  tab: z.enum(['limited', 'near', 'overrides']).default('limited'),
  q: z.string().trim().max(100).optional(),
  plan: z.enum(ENTITLEMENT_PLANS).optional(),
  overridden: z.enum(['yes', 'no']).optional(),
  minStreak: z.coerce.number().int().min(1).max(1440).optional(),
});
export const NotifyBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();
export const TempLimitBody = z
  .object({
    value: z.number().int().min(1, 'เพดานต้องอย่างน้อย 1').max(100_000),
    days: z.number().int().min(1).max(30, 'ปรับชั่วคราวได้ไม่เกิน 30 วัน'),
    reason: z.string().trim().min(3, 'ระบุเหตุผลอย่างน้อย 3 ตัวอักษร').max(500),
  })
  .strict();

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`).toLowerCase()}%`;
/** แพ็กเกจที่ใช้จริง (เหมือน entitlements.service › usage): ทดลองหมด / ยกเลิกครบรอบ = Free */
const planExpr = sql`case when sub.status = 'trialing' and (sub.trial_ends_at is null or sub.trial_ends_at <= now()) then 'free'
  when sub.status = 'canceled' and (sub.current_period_end is null or sub.current_period_end <= now()) then 'free' else coalesce(p.code, 'free') end`;

/**
 * สถิติ 24 ชม. ต่อ Workspace จาก api_usage_minutes (O51):
 * pm = รวมทุก token / route ต่อนาที · isl = ช่วงนาทีที่ถูกปฏิเสธต่อเนื่อง (gaps and islands) · ช่วงปัจจุบัน = จบไม่เกิน 2 นาทีก่อน (นาทีนี้ยังเขียนไม่ครบ)
 */
const BASE = sql`
  with pm as (
    select workspace_id, minute, sum(calls)::int as c, sum(rejected)::int as r, max(limit_rpm) as l
    from api_usage_minutes where minute > now() - interval '24 hours' group by 1, 2
  ),
  isl as (
    select workspace_id, min(minute) as s, max(minute) as e, count(*)::int as n
    from (select workspace_id, minute, minute - (row_number() over (partition by workspace_id order by minute)) * interval '1 minute' as g from pm where r > 0) x
    group by workspace_id, g
  ),
  st as (
    select workspace_id, max(n) as max_streak,
      max(n) filter (where e >= date_trunc('minute', now()) - interval '2 minutes') as cur_streak,
      max(s) filter (where e >= date_trunc('minute', now()) - interval '2 minutes') as cur_since
    from isl group by 1
  ),
  agg as (
    select workspace_id, max(c)::int as peak, sum(c)::int as calls, sum(r)::int as rejected, (array_agg(l order by minute desc))[1] as lim
    from pm group by 1
  ),
  ov as (
    select distinct on (workspace_id) workspace_id, value, expires_at, contract_ref from entitlement_overrides
    where key = 'api_rpm' and revoked_at is null and (expires_at is null or expires_at > now()) order by workspace_id, created_at desc
  ),
  rows as (
    select w.id, w.name, w.slug, ${planExpr} as plan,
      coalesce(a.peak, 0) as peak, coalesce(a.calls, 0) as calls, coalesce(a.rejected, 0) as rejected, a.lim,
      coalesce(st.max_streak, 0) as "maxStreak", coalesce(st.cur_streak, 0) as "curStreak", st.cur_since as "curSince",
      ov.value as "ovValue", ov.expires_at as "ovExpires", ov.workspace_id is not null as overridden,
      (select t.name from api_usage_minutes u join api_tokens t on t.id = u.token_id
        where u.workspace_id = w.id and u.minute > now() - interval '24 hours' group by t.id, t.name order by sum(u.calls) desc limit 1) as "topToken"
    from workspaces w
    left join agg a on a.workspace_id = w.id
    left join st on st.workspace_id = w.id
    left join ov on ov.workspace_id = w.id
    left join subscriptions sub on sub.workspace_id = w.id
    left join plans p on p.id = sub.plan_id
    where w.deleted_at is null and (a.workspace_id is not null or ov.workspace_id is not null)
  )`;

interface Row {
  id: string;
  name: string;
  slug: string;
  plan: string;
  peak: number;
  calls: number;
  rejected: number;
  lim: number | null;
  maxStreak: number;
  curStreak: number;
  curSince: string | null;
  ovValue: unknown;
  ovExpires: string | null;
  overridden: boolean;
  topToken: string | null;
}

/** Rate limit ต่อลูกค้า (O51 · เฟส 3) · Owner และวิศวกร · เพดานจริงอยู่ที่ API ลูกค้า (PlanLimits.rateLimit) หน้านี้ดูสถิติและปรับผ่าน entitlement_overrides เดิม */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly ent: EntitlementsService,
    private readonly mail: Mailer,
  ) {}

  private async rows<T>(q: SQL, db: Db | Tx = this.db) {
    const r = await db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** เพดานที่ใช้อยู่: ค่าล่าสุดที่ API บันทึก → override → ค่าของแพ็กเกจ (ยังไม่มีสถิติ) */
  private async shape(rows: Row[]) {
    const { matrix } = await versionAt(this.db, new Date());
    return rows.map((r) => {
      const plan = ((ENTITLEMENT_PLANS as readonly string[]).includes(r.plan) ? r.plan : 'free') as EntitlementPlan;
      const base = matrix[plan].api_rpm as number | null;
      const limit = r.lim ?? (r.overridden ? (r.ovValue as number | null) : base);
      return {
        id: r.id, name: r.name, slug: r.slug, plan, base, limit,
        peak: r.peak, calls: r.calls, rejected: r.rejected, usagePct: limit ? Math.round((r.peak / limit) * 100) : null,
        maxStreak: r.maxStreak, curStreak: r.curStreak, curSince: r.curSince,
        override: r.overridden ? { value: r.ovValue as number | null, expiresAt: r.ovExpires } : null,
        topToken: r.topToken,
      };
    });
  }

  private tabWhere(tab: z.infer<typeof ListQuery>['tab']) {
    if (tab === 'limited') return sql`rejected > 0`;
    if (tab === 'near') return sql`rejected = 0 and lim > 0 and peak >= lim * ${NEAR}::float8`;
    return sql`overridden`;
  }

  async summary() {
    const [c] = await this.rows<{ limited: number; rejected: number; near: number; overrides: number }>(sql`${BASE}
      select count(*) filter (where rejected > 0)::int as limited, coalesce(sum(rejected), 0)::int as rejected,
        count(*) filter (where rejected = 0 and lim > 0 and peak >= lim * ${NEAR}::float8)::int as near, count(*) filter (where overridden)::int as overrides
      from rows`);
    const todo = await this.rows<Row>(sql`${BASE} select * from rows where "curStreak" >= ${STREAK_ALERT} order by "curStreak" desc limit 50`);
    return { limited24h: c.limited, rejected24h: c.rejected, tabs: { limited: c.limited, near: c.near, overrides: c.overrides }, todo: await this.shape(todo), streakAlert: STREAK_ALERT };
  }

  async list(q: z.infer<typeof ListQuery>) {
    const where: SQL[] = [this.tabWhere(q.tab)];
    if (q.plan) where.push(sql`plan = ${q.plan}`);
    if (q.overridden) where.push(q.overridden === 'yes' ? sql`overridden` : sql`not overridden`);
    if (q.minStreak) where.push(sql`"maxStreak" >= ${q.minStreak}`);
    if (q.q) {
      const l = like(q.q);
      where.push(sql`(lower(name) like ${l} or lower(slug) like ${l} or exists (select 1 from api_usage_minutes u join api_tokens t on t.id = u.token_id
        where u.workspace_id = rows.id and u.minute > now() - interval '24 hours' and lower(t.name) like ${l}))`);
    }
    const cond = sql.join(where, sql` and `);
    const order = q.tab === 'limited' ? sql`rejected desc, peak desc` : q.tab === 'near' ? sql`peak::float / nullif(lim, 0) desc` : sql`"ovExpires" nulls last`;
    const items = await this.rows<Row>(sql`${BASE} select * from rows where ${cond} order by ${order}, id limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`${BASE} select count(*)::int as n from rows where ${cond}`);
    return { items: await this.shape(items), total: n };
  }

  /** แผงขวา: กราฟรายนาที 24 ชม. + แยกตาม token / endpoint */
  async detail(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [row] = await this.rows<Row>(sql`${BASE} select * from rows where id = ${id}`);
    const [ws] = await this.db.select({ id: s.workspaces.id, name: s.workspaces.name, slug: s.workspaces.slug }).from(s.workspaces).where(eq(s.workspaces.id, id));
    if (!ws) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [shaped] = row ? await this.shape([row]) : [null];
    const series = await this.rows<{ minute: string; calls: number; rejected: number; limit: number | null }>(sql`
      select minute, sum(calls)::int as calls, sum(rejected)::int as rejected, max(limit_rpm) as limit
      from api_usage_minutes where workspace_id = ${id} and minute > now() - interval '24 hours' group by minute order by minute`);
    const breakdown = await this.rows<{ tokenId: string; token: string | null; revoked: boolean; route: string; calls: number; rejected: number; peak: number }>(sql`
      select u.token_id as "tokenId", t.name as token, t.revoked_at is not null as revoked, u.route, sum(u.calls)::int as calls, sum(u.rejected)::int as rejected, max(u.calls)::int as peak
      from api_usage_minutes u left join api_tokens t on t.id = u.token_id
      where u.workspace_id = ${id} and u.minute > now() - interval '24 hours'
      group by u.token_id, t.name, t.revoked_at, u.route order by sum(u.calls) desc limit 50`);
    const [ov] = await this.db
      .select({ value: s.entitlementOverrides.value, expiresAt: s.entitlementOverrides.expiresAt, reason: s.entitlementOverrides.reason })
      .from(s.entitlementOverrides)
      .where(and(eq(s.entitlementOverrides.workspaceId, id), eq(s.entitlementOverrides.key, 'api_rpm'), sql`${s.entitlementOverrides.revokedAt} is null and (${s.entitlementOverrides.expiresAt} is null or ${s.entitlementOverrides.expiresAt} > now())`))
      .orderBy(desc(s.entitlementOverrides.createdAt))
      .limit(1);
    return {
      ...ws,
      stats: shaped,
      override: ov ?? null,
      series: series.map((p) => ({ ...p, minute: new Date(p.minute).toISOString() })),
      breakdown,
      lastNotifiedAt: await this.lastNotified(id),
      headroom: HEADROOM,
    };
  }

  private async lastNotified(id: string) {
    const [r] = await this.db
      .select({ at: s.auditLogs.createdAt })
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.workspaceId, id), eq(s.auditLogs.action, 'ops.ratelimit_notified')))
      .orderBy(desc(s.auditLogs.createdAt))
      .limit(1);
    return r?.at ?? null;
  }

  /** แจ้ง Owner / Admin ของลูกค้าว่าระบบของเขาชนเพดาน · กันส่งซ้ำภายใน 1 ชม. · ลูกค้าเห็นใน Audit log */
  async notify(staff: Staff, id: string, note?: string) {
    const d = await this.detail(id);
    const last = d.lastNotifiedAt;
    if (last && Date.now() - last.getTime() < NOTIFY_GAP_MS) throw new AppError(409, 'notified_recently', 'แจ้งลูกค้ารายนี้ไปแล้วภายใน 1 ชั่วโมง', { lastNotifiedAt: last });
    const to = await billingContacts(this.db, id);
    if (!to.length) throw new AppError(422, 'no_recipient', 'Workspace นี้ไม่มี Owner / Admin ที่รับอีเมลได้');
    const st = d.stats;
    const top = d.breakdown[0];
    const lines = [
      `ระบบที่เชื่อมกับ Workspace ${d.name} เรียก API ถึงเพดาน ${st?.limit ?? '-'} ครั้งต่อนาทีของแพ็กเกจ`,
      st ? `24 ชั่วโมงที่ผ่านมา: สูงสุด ${st.peak.toLocaleString('th-TH')} ครั้ง/นาที · ถูกปฏิเสธ (429) ${st.rejected.toLocaleString('th-TH')} ครั้ง${st.curStreak ? ` · ชนเพดานต่อเนื่อง ${st.curStreak} นาที` : ''}` : '',
      top ? `เรียกมากที่สุด: token "${top.token ?? '-'}" ที่ ${top.route}` : '',
      'แนะนำให้ตรวจว่าระบบวนเรียกซ้ำหรือไม่ และรอตามค่า Retry-After ก่อนเรียกใหม่ · ถ้าต้องการเพดานสูงขึ้นตอบกลับอีเมลนี้ได้',
      note ? `\nหมายเหตุจากทีม Friday: ${note}` : '',
      `\nเปิดแอป: ${config.appUrl}`,
    ].filter(Boolean);
    const sent = await mailAll(this.mail, to, `การเรียก API ของ ${d.name} ชนเพดาน`, lines.join('\n'));
    await audit(this.db, staff, id, 'notify', 'ops.ratelimit_notified', `แจ้งลูกค้าเรื่องเรียก API ชนเพดาน (${sent}/${to.length} อีเมล)${note ? ` · ${note}` : ''}`, { type: 'workspace', id });
    return { sent, recipients: to.length };
  }

  /** ปรับเพดานชั่วคราว: เขียน override api_rpm เดิมของ O21 (มีวันหมดเสมอ) · เกิน 3 เท่าของแพ็กเกจ = ขออนุมัติ Owner */
  async tempLimit(staff: Staff, id: string, input: z.infer<typeof TempLimitBody>): Promise<Gated<{ id: string }>> {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const expiresAt = new Date(Date.now() + input.days * DAY).toISOString();
    return this.ent.createOverride(staff, { workspaceId: id, key: 'api_rpm', value: input.value, expiresAt, reason: `ปรับเพดานชั่วคราวจากหน้า Rate limit · ${input.reason}` }, HEADROOM);
  }
}
