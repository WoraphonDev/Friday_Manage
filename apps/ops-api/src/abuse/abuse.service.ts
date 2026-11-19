import { isIP } from 'node:net';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { billingContacts, mailAll } from '../billing/ledger.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { sqlRows } from '../sql-rows.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PageQuery } from '../paging.js';
import { PushService } from '../push/push.service.js';
import {
  AbuseSettings, CONFIRM_HOURS, DEFAULT_SETTINGS, DISPOSABLE_DOMAINS, domainOf, HEAVY_INVITES, HEAVY_ISSUES, INVITE_BURST, IP_BURST, kindOf,
  QUIET_DAYS, RATE_STREAK, RULE_KEYS, RULES, type RuleKey, type Signal,
} from './rules.js';

const s = schema;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEY = 'abuse';
/** ลบเคสสมัครปลอมแบบเดียวกับที่ลูกค้าลบ Workspace เอง (กู้คืนได้ 30 วัน แล้วงานลบถาวรของ API ลูกค้าลบต่อ) */
const RESTORE_DAYS = 30;
/** IP ถูกเปลี่ยนมือได้ จึงบล็อกจากเคสแค่ 90 วัน · โดเมนชั่วคราวบล็อกถาวร */
const IP_BLOCK_DAYS = 90;

const KINDS = ['fake_signup', 'invite_spam', 'api_abuse', 'payment'] as const;
const OUTCOMES = ['dismissed', 'verify_identity', 'suspended', 'blocked'] as const;
const BLOCK_KINDS = ['email_domain', 'ip', 'workspace_slug', 'api_token'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CasesQuery = PageQuery.extend({
  tab: z.enum(['todo', 'history']).default('todo'),
  q: z.string().trim().max(100).optional(),
  kind: z.enum(KINDS).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  decidedBy: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  minScore: z.coerce.number().int().min(0).max(999).optional(),
});
export const DecideBody = z
  .object({
    ids: z.array(z.uuid()).min(1).max(200),
    action: z.enum(['dismiss', 'verify_identity', 'suspend', 'block']),
    reason: z.string().trim().min(3, 'ระบุเหตุผลอย่างน้อย 3 ตัวอักษร').max(500),
  })
  .strict();
export const BlocksQuery = PageQuery.extend({ q: z.string().trim().max(100).optional(), kind: z.enum(BLOCK_KINDS).optional() });
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const AddBlockBody = z
  .object({
    kind: z.enum(BLOCK_KINDS),
    value: z.string().trim().min(1).max(253),
    reason: z.string().trim().min(3, 'ระบุเหตุผลอย่างน้อย 3 ตัวอักษร').max(500),
    /** ว่าง = ถาวร */
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .transform((v, ctx) => {
    const value = v.kind === 'api_token' ? v.value : v.value.toLowerCase().replace(/^@/, '');
    const ok =
      v.kind === 'email_domain' ? DOMAIN.test(value) : v.kind === 'ip' ? validIp(value) : v.kind === 'workspace_slug' ? SLUG.test(value) : z.uuid().safeParse(value).success;
    if (!ok) ctx.addIssue({ code: 'custom', path: ['value'], message: { email_domain: 'โดเมนไม่ถูกต้อง เช่น tempmail.example', ip: 'IP หรือช่วง IP ไม่ถูกต้อง เช่น 203.0.113.24 หรือ 203.0.113.0/24', workspace_slug: 'slug ไม่ถูกต้อง', api_token: 'รหัส token ไม่ถูกต้อง' }[v.kind] });
    if (v.expiresAt && Date.parse(v.expiresAt) <= Date.now()) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'วันหมดต้องอยู่ในอนาคต' });
    return { ...v, value };
  });
export const RemoveBlockBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/** IP เดี่ยว หรือช่วง CIDR (IPv4 /8–/32 · IPv6 /32–/128) · กันบล็อกกว้างเกินจนลูกค้าจริงสมัครไม่ได้ */
function validIp(v: string) {
  const [addr, bits, more] = v.split('/');
  if (more !== undefined) return false;
  const fam = isIP(addr);
  if (!fam) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && (fam === 4 ? n >= 8 && n <= 32 : n >= 32 && n <= 128);
}

type CaseRow = typeof s.abuseCases.$inferSelect;
/** เทียบสัญญาณโดยไม่ขึ้นกับลำดับ key (jsonb เรียง key ใหม่ตอนเก็บ) */
const sigKey = (x: Signal[]) => x.map((g) => `${g.rule}|${g.points}|${g.detail}|${(g.values ?? []).join(',')}`).join('\n');
interface WsFacts {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  deleted: boolean;
  plan: string | null;
  subStatus: string | null;
  paying: boolean;
  paidEver: boolean;
  members: number;
  pendingInvites: number;
  projects: number;
  ip: string | null;
  ownerEmail: string | null;
}
interface Candidate {
  subject: string;
  label: string;
  workspaceIds: string[];
  userIds: string[];
  ip: string | null;
  signals: Signal[];
}

/** ข้อความถึงลูกค้า · ไม่บอกรายละเอียดกฎ (กันเลี่ยง) แต่บอกทางขอตรวจใหม่ (ตอบอีเมล = เปิด Ticket เข้าคิว Support) */
const SUSPEND_MSG = 'Workspace นี้ถูกระงับชั่วคราวเพราะระบบพบการใช้งานที่ผิดปกติ · ข้อมูลทั้งหมดยังอยู่ครบ หากเป็นการใช้งานจริง ตอบกลับอีเมลนี้เพื่อขอให้ทีม Friday ตรวจใหม่';
const VERIFY_MSG = 'ทีม Friday ขอยืนยันตัวตนของเจ้าของ Workspace ก่อนเปิดใช้งานต่อ · ระหว่างนี้ดูและส่งออกข้อมูลได้ แต่แก้ไขไม่ได้ ตอบกลับอีเมลนี้พร้อมชื่อบริษัทและเบอร์ติดต่อเพื่อขอให้ตรวจ';

/**
 * ตรวจจับการใช้ผิด (O50 · เฟส 3) · ระบบให้คะแนน คนตัดสิน
 * อ่านข้อมูลลูกค้าทุก Workspace ด้วยบัญชีของหลังบ้าน (ข้าม RLS) · ทุกการแก้ Workspace เขียน audit_logs ของ Workspace นั้น
 */
@Injectable()
export class AbuseService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsAbuse');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly push: PushService,
  ) {}

  /** ตรวจทุก 5 นาที · test เรียก tick() เอง · ปิดด้วย OPS_JOBS=off */
  onModuleInit() {
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 5 * 60_000);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private rows<T>(q: SQL, db: Db | Tx = this.db) {
    return sqlRows<T>(db, q);
  }

  async tick(now = new Date()) {
    const scanned = await this.scan(now);
    const reminded = await this.remind(now);
    return { ...scanned, reminded };
  }

  // ---------------------------------------------------------------- ค่าตั้ง (ปุ่มเฟือง)

  async settings(): Promise<AbuseSettings> {
    const [r] = await this.db.select({ value: s.opsSettings.value }).from(s.opsSettings).where(eq(s.opsSettings.key, KEY));
    const v = (r?.value ?? {}) as Partial<AbuseSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...v, rules: { ...DEFAULT_SETTINGS.rules, ...(v.rules ?? {}) } };
    const ok = AbuseSettings.safeParse(merged);
    const cfg = ok.success ? ok.data : DEFAULT_SETTINGS;
    // กฎที่ยังไม่มีข้อมูลเปิดไม่ได้ แม้ค่าที่บันทึกไว้จะเปิด
    for (const k of RULE_KEYS) if (RULES[k].waiting) cfg.rules[k] = { ...cfg.rules[k], on: false };
    return cfg;
  }

  /** กฎ + จำนวนที่เจอ 7 วัน + % ที่คนตัดสินว่าไม่ใช่การใช้ผิด (90 วัน) · ใช้ดูว่ากฎไหนจับผิดบ่อย */
  async rules() {
    const cfg = await this.settings();
    const stats = await this.rows<{ rule: string; hits: number; decided: number; dismissed: number }>(sql`
      select sig->>'rule' as rule,
        count(*) filter (where c.created_at > now() - interval '7 days')::int as hits,
        count(*) filter (where c.status = 'closed' and c.decided_at > now() - interval '90 days')::int as decided,
        count(*) filter (where c.outcome = 'dismissed' and c.decided_at > now() - interval '90 days')::int as dismissed
      from abuse_cases c cross join lateral jsonb_array_elements(c.signals) sig
      where c.created_at > now() - interval '90 days' or c.decided_at > now() - interval '90 days'
      group by 1`);
    const by = new Map(stats.map((x) => [x.rule, x]));
    return {
      review: cfg.review,
      autoSuspend: cfg.autoSuspend,
      rules: RULE_KEYS.map((key) => {
        const st = by.get(key);
        return { key, points: cfg.rules[key].points, on: cfg.rules[key].on, waiting: RULES[key].waiting ?? null, hits7d: st?.hits ?? 0, falsePositivePct: st?.decided ? Math.round((st.dismissed / st.decided) * 100) : null };
      }),
    };
  }

  async saveRules(staff: Staff, input: AbuseSettings) {
    const before = await this.settings();
    const diff: string[] = [];
    if (before.review !== input.review) diff.push(`เกณฑ์รอตรวจ ${before.review} → ${input.review}`);
    if (before.autoSuspend !== input.autoSuspend) diff.push(`เกณฑ์ระงับอัตโนมัติ ${before.autoSuspend} → ${input.autoSuspend}`);
    for (const k of RULE_KEYS) {
      const a = before.rules[k];
      const b = input.rules[k];
      if (RULES[k].waiting && b.on) throw new AppError(422, 'rule_unavailable', 'กฎนี้ยังเปิดไม่ได้ เพราะยังไม่มีข้อมูลที่ใช้ตรวจ', { rule: k, waiting: RULES[k].waiting });
      if (a.points !== b.points) diff.push(`${k} ${a.points} → ${b.points}`);
      if (a.on !== b.on) diff.push(`${k} ${b.on ? 'เปิด' : 'ปิด'}`);
    }
    if (!diff.length) return { ...(await this.rules()), saved: false };
    await this.db.transaction(async (tx) => {
      await tx.insert(s.opsSettings).values({ key: KEY, value: input, updatedBy: staff.id }).onConflictDoUpdate({ target: s.opsSettings.key, set: { value: input, updatedBy: staff.id, updatedAt: new Date() } });
      await staffAudit(tx, staff, 'abuse.rules_updated', `กฎตรวจจับการใช้ผิด: ${diff.join(' · ')}`);
    });
    return { ...(await this.rules()), saved: true };
  }

  // ---------------------------------------------------------------- ให้คะแนน

  /** โดเมนชั่วคราว = รายชื่อในโค้ด + โดเมนอีเมลที่ทีมบล็อกไว้ */
  private async tempDomains() {
    const blocked = await this.db
      .select({ value: s.abuseBlocks.value })
      .from(s.abuseBlocks)
      .where(and(eq(s.abuseBlocks.kind, 'email_domain'), isNull(s.abuseBlocks.removedAt), sql`(${s.abuseBlocks.expiresAt} is null or ${s.abuseBlocks.expiresAt} > now())`));
    return [...new Set([...DISPOSABLE_DOMAINS, ...blocked.map((b) => b.value.toLowerCase())])];
  }

  /** หาเรื่องที่น่าสงสัยจากสัญญาณทุกกฎที่เปิดอยู่ แล้วเปิด / ปรับเคส · ถึงเกณฑ์ระงับ = ระงับ Workspace ที่ไม่ได้จ่ายเงิน */
  async scan(now = new Date()) {
    const cfg = await this.settings();
    const on = (k: RuleKey) => cfg.rules[k].on && cfg.rules[k].points > 0;
    const pts = (k: RuleKey) => cfg.rules[k].points;
    const temp = await this.tempDomains();
    const ws = new Map<string, Candidate>();
    const wsCand = (id: string, name: string, slug: string) => {
      let c = ws.get(id);
      if (!c) ws.set(id, (c = { subject: `ws:${id}`, label: `${name} (${slug})`, workspaceIds: [id], userIds: [], ip: null, signals: [] }));
      return c;
    };
    // Workspace ที่ทีมยืนยันว่าเป็นทดสอบ ไม่ต้องให้คะแนน
    const live = sql`w.deleted_at is null and w.status not in ('suspended', 'pending_delete') and not exists (select 1 from ops_workspace_flags f where f.workspace_id = w.id and f.test_flag = 'test')`;

    if (on('temp_email')) {
      const rows = await this.rows<{ id: string; name: string; slug: string; user_id: string; domain: string }>(sql`
        select w.id, w.name, w.slug, u.id as user_id, lower(split_part(u.email, '@', 2)) as domain
        from workspaces w
        join workspace_members m on m.workspace_id = w.id and m.role = 'owner' and m.status = 'active'
        join users u on u.id = m.user_id
        where w.created_at > ${new Date(now.getTime() - 7 * DAY)} and ${live}
          and lower(split_part(u.email, '@', 2)) = any(${sql.param(temp)}::text[])`);
      for (const r of rows) {
        const c = wsCand(r.id, r.name, r.slug);
        c.userIds.push(r.user_id);
        c.signals.push({ rule: 'temp_email', points: pts('temp_email'), detail: `อีเมลผู้สมัครเป็นโดเมนชั่วคราว (${r.domain})`, values: [r.domain] });
      }
    }
    if (on('invite_burst')) {
      // "ภายนอก" = โดเมนของผู้รับต่างจากโดเมนของคนเชิญ (ทีมจริงมักเชิญโดเมนบริษัทเดียวกัน)
      const rows = await this.rows<{ id: string; name: string; slug: string; n: number }>(sql`
        select w.id, w.name, w.slug, count(*)::int as n
        from invitations i join workspaces w on w.id = i.workspace_id join users u on u.id = i.invited_by
        where i.created_at > ${new Date(now.getTime() - HOUR)} and ${live}
          and lower(split_part(i.email, '@', 2)) <> lower(split_part(u.email, '@', 2))
        group by w.id having count(*) > ${INVITE_BURST}`);
      for (const r of rows) wsCand(r.id, r.name, r.slug).signals.push({ rule: 'invite_burst', points: pts('invite_burst'), detail: `เชิญอีเมลภายนอกเกิน ${INVITE_BURST} รายการใน 1 ชม. (${r.n.toLocaleString('th-TH')})` });
    }
    if (on('invite_links')) {
      const rows = await this.rows<{ id: string; name: string; slug: string; domains: string[] }>(sql`
        select w.id, w.name, w.slug, array_agg(distinct lower(m[1])) as domains
        from invitations i join workspaces w on w.id = i.workspace_id
        cross join lateral regexp_matches(i.message, 'https?://([^/\\s:?#]+)', 'g') m
        where i.created_at > ${new Date(now.getTime() - DAY)} and i.message is not null and ${live}
        group by w.id`);
      for (const r of rows) wsCand(r.id, r.name, r.slug).signals.push({ rule: 'invite_links', points: pts('invite_links'), detail: `ข้อความเชิญมีลิงก์ภายนอก (${r.domains.length} โดเมน: ${r.domains.slice(0, 3).join(', ')})` });
    }
    if (on('unverified_heavy')) {
      const rows = await this.rows<{ id: string; name: string; slug: string; user_id: string; issues: number; invites: number }>(sql`
        select w.id, w.name, w.slug, u.id as user_id,
          (select count(*)::int from issues x where x.workspace_id = w.id and x.created_at > ${new Date(now.getTime() - DAY)}) as issues,
          (select count(*)::int from invitations x where x.workspace_id = w.id and x.created_at > ${new Date(now.getTime() - DAY)}) as invites
        from workspaces w
        join workspace_members m on m.workspace_id = w.id and m.role = 'owner' and m.status = 'active'
        join users u on u.id = m.user_id
        where u.email_verified_at is null and u.created_at < ${new Date(now.getTime() - DAY)}
          and w.created_at > ${new Date(now.getTime() - 30 * DAY)} and ${live}`);
      for (const r of rows.filter((x) => x.issues >= HEAVY_ISSUES || x.invites >= HEAVY_INVITES)) {
        const c = wsCand(r.id, r.name, r.slug);
        if (!c.userIds.includes(r.user_id)) c.userIds.push(r.user_id);
        c.signals.push({ rule: 'unverified_heavy', points: pts('unverified_heavy'), detail: `ไม่ยืนยันอีเมลเกิน 24 ชม. แต่สร้างงาน ${r.issues.toLocaleString('th-TH')} · เชิญ ${r.invites.toLocaleString('th-TH')} ใน 24 ชม.` });
      }
    }

    if (on('api_ratelimit')) {
      // ช่วงนาทีที่ถูกปฏิเสธ (429) ต่อเนื่อง จาก api_usage_minutes ของ O51 · นับช่วงที่จบภายใน 1 ชม.
      const rows = await this.rows<{ id: string; name: string; slug: string; n: number; token: string | null }>(sql`
        with m as (select workspace_id, minute from api_usage_minutes where minute > ${new Date(now.getTime() - DAY)} group by 1, 2 having sum(rejected) > 0),
        isl as (select workspace_id, count(*)::int as n, max(minute) as e from (select workspace_id, minute, minute - (row_number() over (partition by workspace_id order by minute)) * interval '1 minute' as g from m) x group by workspace_id, g)
        select w.id, w.name, w.slug, max(isl.n)::int as n,
          (select t.name from api_usage_minutes u join api_tokens t on t.id = u.token_id where u.workspace_id = w.id and u.minute > ${new Date(now.getTime() - HOUR)} group by t.id, t.name order by sum(u.rejected) desc limit 1) as token
        from isl join workspaces w on w.id = isl.workspace_id
        where isl.n >= ${RATE_STREAK} and isl.e > ${new Date(now.getTime() - HOUR)} and ${live}
        group by w.id`);
      for (const r of rows) wsCand(r.id, r.name, r.slug).signals.push({ rule: 'api_ratelimit', points: pts('api_ratelimit'), detail: `ชนเพดาน API ติดกัน ${r.n} นาที${r.token ? ` (token "${r.token}")` : ''}` });
    }

    const ips: Candidate[] = [];
    if (on('ip_burst')) {
      const rows = await this.rows<{ ip: string; users: string[]; emails: string[]; verified: number }>(sql`
        select a.signup_ip as ip, array_agg(a.user_id) as users, array_agg(lower(u.email)) as emails, count(u.email_verified_at)::int as verified
        from signup_attributions a join users u on u.id = a.user_id
        where a.signup_ip is not null and a.created_at > ${new Date(now.getTime() - HOUR)}
        group by a.signup_ip having count(*) > ${IP_BURST}`);
      for (const r of rows) {
        const owned = await this.rows<{ workspace_id: string }>(sql`
          select distinct m.workspace_id from workspace_members m join workspaces w on w.id = m.workspace_id
          where m.user_id = any(${sql.param(r.users)}::uuid[]) and m.role = 'owner' and w.deleted_at is null`);
        const c: Candidate = { subject: `ip:${r.ip}`, label: `${r.users.length} บัญชีจาก IP เดียว`, workspaceIds: owned.map((o) => o.workspace_id), userIds: r.users, ip: r.ip, signals: [] };
        c.signals.push({ rule: 'ip_burst', points: pts('ip_burst'), detail: `สมัคร ${r.users.length} บัญชีจาก IP ${r.ip} ใน 1 ชม. (เกณฑ์ ${IP_BURST})` });
        const tempUsed = [...new Set(r.emails.map(domainOf).filter((d) => temp.includes(d)))];
        const tempCount = r.emails.filter((e) => temp.includes(domainOf(e))).length;
        if (on('temp_email') && tempCount * 2 >= r.emails.length) c.signals.push({ rule: 'temp_email', points: pts('temp_email'), detail: `${tempCount}/${r.emails.length} บัญชีใช้โดเมนชั่วคราว (${tempUsed.slice(0, 3).join(', ')})`, values: tempUsed });
        if (on('unverified_heavy') && r.verified === 0) c.signals.push({ rule: 'unverified_heavy', points: pts('unverified_heavy'), detail: `ไม่มีบัญชีไหนยืนยันอีเมล (${r.users.length} บัญชี)` });
        ips.push(c);
      }
    }

    let opened = 0;
    let updated = 0;
    let suspended = 0;
    for (const c of [...ws.values(), ...ips]) {
      const score = c.signals.reduce((n, x) => n + x.points, 0);
      if (score < cfg.review) continue;
      const r = await this.upsert(c, now);
      if (!r) continue;
      if (r.isNew) opened++;
      else if (r.changed) updated++;
      if (r.row.status === 'open' && r.row.score >= cfg.autoSuspend && (await this.autoSuspend(r.row, now))) suspended++;
    }
    return { opened, updated, suspended };
  }

  /**
   * เปิดเคสใหม่ หรือรวมสัญญาณเข้าเคสที่เปิดอยู่ (คะแนนไม่ลดเมื่อหน้าต่างเวลาผ่านไป · คนต้องดูก่อน)
   * เรื่องที่ตัดสินแล้วภายใน 30 วันไม่เปิดซ้ำ
   */
  private async upsert(c: Candidate, now: Date) {
    const [recent] = await this.db
      .select({ id: s.abuseCases.id })
      .from(s.abuseCases)
      .where(and(eq(s.abuseCases.subject, c.subject), eq(s.abuseCases.status, 'closed'), sql`${s.abuseCases.decidedAt} > ${new Date(now.getTime() - QUIET_DAYS * DAY)}`))
      .limit(1);
    if (recent) return null;
    const [cur] = await this.db.select().from(s.abuseCases).where(and(eq(s.abuseCases.subject, c.subject), ne(s.abuseCases.status, 'closed')));
    if (!cur) {
      const score = c.signals.reduce((n, x) => n + x.points, 0);
      const [row] = await this.db
        .insert(s.abuseCases)
        .values({ kind: kindOf(c.signals), subject: c.subject, label: c.label, workspaceIds: c.workspaceIds, userIds: c.userIds, ip: c.ip, score, signals: c.signals })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await this.push.toRoles(['owner', 'engineer'], { title: `เคสใช้ผิดใหม่ · คะแนน ${score}`, body: c.label, url: `/abuse?case=${row.id}`, tag: `abuse-${row.id}` }).catch(() => 0);
      return { row, isNew: true, changed: true };
    }
    const merged = new Map((cur.signals as Signal[]).map((x) => [x.rule, x]));
    for (const x of c.signals) merged.set(x.rule, x);
    const signals = [...merged.values()];
    const score = signals.reduce((n, x) => n + x.points, 0);
    const workspaceIds = [...new Set([...cur.workspaceIds, ...c.workspaceIds])];
    const userIds = [...new Set([...cur.userIds, ...c.userIds])];
    const changed = score !== cur.score || sigKey(signals) !== sigKey(cur.signals as Signal[]) || workspaceIds.length !== cur.workspaceIds.length || userIds.length !== cur.userIds.length;
    if (!changed) return { row: cur, isNew: false, changed: false };
    const label = c.subject.startsWith('ip:') ? `${userIds.length} บัญชีจาก IP เดียว` : c.label;
    const [row] = await this.db.update(s.abuseCases).set({ signals, score, label, kind: kindOf(signals), workspaceIds, userIds }).where(eq(s.abuseCases.id, cur.id)).returning();
    return { row, isNew: false, changed: true };
  }

  /** สถานะแพ็กเกจ / การจ่ายเงินของ Workspace · paying = แพ็กเกจเสียเงินที่ active / ค้างชำระ (ระบบไม่ระงับเอง ต้องผ่านหน้า Workspace ที่มีขั้นอนุมัติ) */
  private async facts(ids: string[], db: Db | Tx = this.db): Promise<WsFacts[]> {
    if (!ids.length) return [];
    const rows = await this.rows<WsFacts & { createdAt: Date }>(
      sql`
      select w.id, w.name, w.slug, w.status, w.created_at as "createdAt", w.deleted_at is not null as deleted, p.code as plan, sub.status as "subStatus",
        (sub.status in ('active', 'past_due') and coalesce(p.code, 'free') <> 'free') as paying,
        exists (select 1 from invoices i where i.workspace_id = w.id and i.status = 'paid') as "paidEver",
        (select count(*)::int from workspace_members x where x.workspace_id = w.id and x.status = 'active') as members,
        (select count(*)::int from invitations x where x.workspace_id = w.id and x.status = 'pending') as "pendingInvites",
        (select count(*)::int from projects x where x.workspace_id = w.id) as projects,
        (select a.signup_ip from workspace_members m join signup_attributions a on a.user_id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.joined_at limit 1) as ip,
        (select u.email from workspace_members m join users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.joined_at limit 1) as "ownerEmail"
      from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id
      where w.id = any(${sql.param(ids)}::uuid[])
      order by w.created_at`,
      db,
    );
    return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString(), paying: !!r.paying }));
  }

  /** ตั้งสถานะระงับ (ระบบหรือพนักงาน) + Audit ของ Workspace · คืน true ถ้าเปลี่ยนจริง */
  private async setSuspended(tx: Tx, staff: Staff | null, id: string, mode: 'full' | 'read_only', message: string, summary: string) {
    const [w] = await tx.select({ status: s.workspaces.status, mode: s.workspaces.suspensionMode, deletedAt: s.workspaces.deletedAt }).from(s.workspaces).where(eq(s.workspaces.id, id));
    if (!w || w.deletedAt || w.status === 'pending_delete') return false;
    if (w.status === 'suspended' && w.mode === mode) return false;
    await tx.update(s.workspaces).set({ status: 'suspended', suspensionMode: mode, suspensionMessage: message, suspensionAutoResume: false, updatedAt: new Date() }).where(eq(s.workspaces.id, id));
    const what = `ระงับ Workspace (${mode === 'full' ? 'ปิดทั้งหมด' : 'อ่านอย่างเดียว'}) · ${summary}`;
    if (staff) await audit(tx, staff, id, 'secu', 'ops.workspace_suspended', what, { type: 'workspace', id });
    else await tx.insert(s.auditLogs).values({ workspaceId: id, actorKind: 'system', category: 'secu', action: 'ops.workspace_suspended', targetType: 'workspace', targetId: id, summary: `[Friday ระบบ] ${what}` });
    return true;
  }

  /** ระงับอัตโนมัติเมื่อคะแนนถึงเกณฑ์ · ข้าม Workspace ที่จ่ายเงิน (เคสยังรอตรวจตามปกติ) */
  private async autoSuspend(row: CaseRow, now: Date) {
    const list = (await this.facts(row.workspaceIds)).filter((w) => !w.paying && !w.deleted && w.status !== 'suspended');
    if (!list.length) return false;
    const done: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const w of list) if (await this.setSuspended(tx, null, w.id, 'full', SUSPEND_MSG, `ระงับอัตโนมัติจากเคสใช้ผิด #${row.number} (คะแนน ${row.score})`)) done.push(w.id);
      if (done.length) await tx.update(s.abuseCases).set({ status: 'auto_suspended', autoSuspendedAt: now, suspendedIds: [...new Set([...row.suspendedIds, ...done])] }).where(eq(s.abuseCases.id, row.id));
    });
    for (const id of done) await this.mailCustomer(id, SUSPEND_MSG);
    if (done.length) await this.push.toRoles(['owner', 'engineer'], { title: `ระงับอัตโนมัติ ${done.length} Workspace · รอยืนยันใน ${CONFIRM_HOURS} ชม.`, body: row.label, url: `/abuse?case=${row.id}`, tag: `abuse-${row.id}` }).catch(() => 0);
    return done.length > 0;
  }

  private async mailCustomer(workspaceId: string, message: string) {
    const [w] = await this.db.select({ name: s.workspaces.name }).from(s.workspaces).where(eq(s.workspaces.id, workspaceId));
    if (!w) return;
    await mailAll(this.mail, await billingContacts(this.db, workspaceId), `Workspace ${w.name} ถูกระงับชั่วคราว`, `${message}\n\nเปิดแอป: ${config.appUrl}`).catch(() => 0);
  }

  /** ระงับอัตโนมัติแล้วยังไม่มีคนยืนยันเกิน 24 ชม. → แจ้ง Owner ทุก 24 ชม. (ไม่ปลดเอง เพราะอาจเป็นการใช้ผิดจริง) */
  async remind(now = new Date()) {
    const due = await this.db
      .select()
      .from(s.abuseCases)
      .where(and(eq(s.abuseCases.status, 'auto_suspended'), sql`${s.abuseCases.autoSuspendedAt} < ${new Date(now.getTime() - CONFIRM_HOURS * HOUR)}`, sql`(${s.abuseCases.remindedAt} is null or ${s.abuseCases.remindedAt} < ${new Date(now.getTime() - CONFIRM_HOURS * HOUR)})`));
    if (!due.length) return 0;
    const owners = await this.db
      .select({ id: s.staffUsers.id, email: s.staffUsers.email })
      .from(s.staffUsers)
      .where(sql`${s.staffUsers.status} = 'active' and 'owner' = any(${s.staffUsers.roles}) and (${s.staffUsers.expiresAt} is null or ${s.staffUsers.expiresAt} > now())`);
    const list = due.map((c) => `#${c.number} ${c.label} · คะแนน ${c.score} · ระงับเมื่อ ${c.autoSuspendedAt?.toISOString()}`).join('\n');
    for (const o of owners) {
      await this.mail.send({ to: o.email, subject: `[Friday Ops] ระงับอัตโนมัติ ${due.length} เคส ยังไม่มีคนยืนยันเกิน ${CONFIRM_HOURS} ชม.`, text: `เคสต่อไปนี้ระบบระงับไว้ก่อนและยังรอคนยืนยันหรือปลด:\n${list}\n\nเปิด: ${config.origin}/abuse` }).catch(() => 0);
    }
    await this.push.toRoles(['owner'], { title: `ระงับอัตโนมัติรอยืนยันเกิน ${CONFIRM_HOURS} ชม. (${due.length})`, body: due[0].label, url: '/abuse', tag: 'abuse-remind' }).catch(() => 0);
    await this.db.update(s.abuseCases).set({ remindedAt: now }).where(inArray(s.abuseCases.id, due.map((c) => c.id)));
    return due.length;
  }

  // ---------------------------------------------------------------- หน้าจอ

  /** ตัวเลขหัวหน้า + แถบต้องทำ + จำนวนในแท็บ */
  async summary() {
    const [r] = await this.rows<{ signups7d: number; auto7d: number; decided90: number; dismissed90: number; open: number; auto: number; oldest: Date | null; history30: number; blocks: number }>(sql`
      select
        (select count(*)::int from users where created_at > now() - interval '7 days') as "signups7d",
        (select count(*)::int from abuse_cases where auto_suspended_at > now() - interval '7 days') as "auto7d",
        (select count(*)::int from abuse_cases where status = 'closed' and decided_at > now() - interval '90 days') as "decided90",
        (select count(*)::int from abuse_cases where outcome = 'dismissed' and decided_at > now() - interval '90 days') as "dismissed90",
        (select count(*)::int from abuse_cases where status = 'open') as open,
        (select count(*)::int from abuse_cases where status = 'auto_suspended') as auto,
        (select min(created_at) from abuse_cases where status <> 'closed') as oldest,
        (select count(*)::int from abuse_cases where status = 'closed' and decided_at > now() - interval '30 days') as "history30",
        (select count(*)::int from abuse_blocks where removed_at is null and (expires_at is null or expires_at > now())) as blocks`);
    // คนตัดสินใน 90 วัน · ใช้เป็นตัวเลือกของตัวกรองแท็บประวัติ
    const deciders = await this.rows<{ id: string; name: string }>(sql`
      select distinct st.id, st.name from abuse_cases c join staff_users st on st.id = c.decided_by where c.decided_at > now() - interval '90 days' order by st.name`);
    return {
      deciders,
      signups7d: r.signups7d,
      autoSuspended7d: r.auto7d,
      falsePositivePct: r.decided90 ? Math.round((r.dismissed90 / r.decided90) * 100) : null,
      todo: { open: r.open, autoSuspended: r.auto, oldestAt: r.oldest ? new Date(r.oldest).toISOString() : null },
      tabs: { history: r.history30, blocks: r.blocks },
    };
  }

  async cases(q: z.infer<typeof CasesQuery>) {
    const where: SQL[] = [];
    if (q.tab === 'todo') where.push(sql`c.status <> 'closed'`);
    else {
      where.push(sql`c.status = 'closed'`);
      // ค่าเริ่มต้นของแท็บประวัติ = 30 วันล่าสุด (ตามป้ายแท็บ) · ระบุช่วงวันแล้วใช้ช่วงนั้น
      if (!q.from && !q.to) where.push(sql`c.decided_at > now() - interval '30 days'`);
      if (q.from) where.push(sql`c.decided_at >= ${q.from}::date::timestamp at time zone 'Asia/Bangkok'`);
      if (q.to) where.push(sql`c.decided_at < (${q.to}::date + 1)::timestamp at time zone 'Asia/Bangkok'`);
      if (q.outcome) where.push(sql`c.outcome = ${q.outcome}`);
      if (q.decidedBy) where.push(sql`c.decided_by = ${q.decidedBy}`);
    }
    if (q.kind) where.push(sql`c.kind = ${q.kind}`);
    if (q.minScore != null) where.push(sql`c.score >= ${q.minScore}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`).toLowerCase()}%`;
      where.push(sql`(lower(c.label) like ${like} or c.ip like ${like} or exists (select 1 from workspaces w where w.id = any(c.workspace_ids) and (lower(w.name) like ${like} or lower(w.slug) like ${like}))
        or exists (select 1 from users u where u.id = any(c.user_ids) and lower(u.email) like ${like}))`);
    }
    const cond = sql.join(where, sql` and `);
    const order = q.tab === 'todo' ? sql`c.score desc, c.created_at` : sql`c.decided_at desc`;
    const items = await this.rows<Record<string, unknown>>(sql`
      select c.id, c.number, c.kind, c.label, c.score, c.status, c.outcome, c.reason, c.signals, c.ip,
        c.created_at as "createdAt", c.auto_suspended_at as "autoSuspendedAt", c.decided_at as "decidedAt", st.name as "decidedBy",
        cardinality(c.workspace_ids) as workspaces, cardinality(c.user_ids) as users
      from abuse_cases c left join staff_users st on st.id = c.decided_by
      where ${cond} order by ${order} limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from abuse_cases c where ${cond}`);
    return {
      items: items.map((c) => ({
        ...c,
        signals: c.signals as Signal[],
        confirmBy: c.autoSuspendedAt ? new Date(new Date(c.autoSuspendedAt as string).getTime() + CONFIRM_HOURS * HOUR).toISOString() : null,
      })),
      total: n,
    };
  }

  /** แผงขวา: ที่มาของคะแนน + ข้อมูล Workspace ที่ใช้ตัดสิน (สูงสุด 20 Workspace · เคสจาก IP อาจมีมาก) */
  async get(id: string) {
    const c = await this.caseOf(id);
    const [by] = c.decidedBy ? await this.db.select({ name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, c.decidedBy)) : [];
    const users = c.userIds.length
      ? await this.db.select({ id: s.users.id, email: s.users.email, verified: sql<boolean>`${s.users.emailVerifiedAt} is not null`, createdAt: s.users.createdAt }).from(s.users).where(inArray(s.users.id, c.userIds.slice(0, 20)))
      : [];
    return {
      id: c.id, number: c.number, kind: c.kind, label: c.label, score: c.score, status: c.status, ip: c.ip,
      signals: c.signals as Signal[], createdAt: c.createdAt, autoSuspendedAt: c.autoSuspendedAt,
      confirmBy: c.autoSuspendedAt ? new Date(c.autoSuspendedAt.getTime() + CONFIRM_HOURS * HOUR) : null,
      outcome: c.outcome, reason: c.reason, decidedAt: c.decidedAt, decidedBy: by?.name ?? null,
      workspaces: await this.facts(c.workspaceIds.slice(0, 20)),
      workspaceTotal: c.workspaceIds.length,
      users,
      userTotal: c.userIds.length,
      blockable: this.blockable(c),
    };
  }

  private async caseOf(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบเคส');
    const [c] = await this.db.select().from(s.abuseCases).where(eq(s.abuseCases.id, id));
    if (!c) throw new AppError(404, 'not_found', 'ไม่พบเคส');
    return c;
  }

  /** สิ่งที่ "ลบและบล็อก" จะบล็อก: IP ของเคสสมัครถี่ + โดเมนชั่วคราวที่เจอ (ไม่บล็อก IP ของเคส Workspace เดี่ยว เพราะอาจเป็น IP ออฟฟิศที่ใช้ร่วมกัน) */
  private blockable(c: CaseRow) {
    const domains = [...new Set((c.signals as Signal[]).filter((x) => x.rule === 'temp_email').flatMap((x) => x.values ?? []))];
    return { ip: c.subject.startsWith('ip:') ? c.ip : null, domains };
  }

  // ---------------------------------------------------------------- ตัดสิน

  /** ตัดสินทีละหลายเคส · ทุกเคสต้องยังไม่ปิด · Workspace ที่จ่ายเงินอยู่ระงับ / ลบจากที่นี่ไม่ได้ */
  async decide(staff: Staff, input: z.infer<typeof DecideBody>) {
    const ids = [...new Set(input.ids)];
    const list = await this.db.select().from(s.abuseCases).where(inArray(s.abuseCases.id, ids));
    if (list.length !== ids.length) throw new AppError(404, 'not_found', 'ไม่พบบางเคส · โหลดหน้าใหม่แล้วลองอีกครั้ง');
    const closed = list.filter((c) => c.status === 'closed');
    if (closed.length) throw new AppError(409, 'case_closed', `มีคนตัดสินเคส #${closed[0].number} ไปแล้ว · โหลดหน้าใหม่`, { ids: closed.map((c) => c.id) });
    const all = await this.facts([...new Set(list.flatMap((c) => c.workspaceIds))]);
    const byId = new Map(all.map((w) => [w.id, w]));
    if (input.action !== 'dismiss') {
      const paying = all.find((w) => w.paying && !w.deleted);
      if (paying) throw new AppError(409, 'paying_workspace', `${paying.name} จ่ายเงินอยู่ · ระงับจากหน้า Workspace (มีขั้นอนุมัติ)`, { workspaceId: paying.id });
    }
    const outcome = ({ dismiss: 'dismissed', verify_identity: 'verify_identity', suspend: 'suspended', block: 'blocked' } as const)[input.action];
    const mails: { id: string; message: string }[] = [];
    const blocks: { kind: string; value: string }[] = [];
    const now = new Date();
    await this.db.transaction(async (tx) => {
      for (const c of list) {
        const wsList = c.workspaceIds.map((id) => byId.get(id)).filter((w): w is WsFacts => !!w && !w.deleted);
        let suspendedIds = c.suspendedIds;
        const tag = `เคสใช้ผิด #${c.number} · ${input.reason}`;
        if (input.action === 'dismiss') {
          // ปลดเฉพาะที่ระบบ / เคสนี้ระงับ · Workspace ที่ถูกระงับด้วยเหตุอื่น (เช่น ค้างชำระ) ไม่แตะ
          for (const id of c.suspendedIds) {
            const [w] = await tx.select({ status: s.workspaces.status, sub: s.subscriptions.status }).from(s.workspaces).leftJoin(s.subscriptions, eq(s.subscriptions.workspaceId, s.workspaces.id)).where(eq(s.workspaces.id, id));
            if (w?.status !== 'suspended') continue;
            await tx.update(s.workspaces).set({ status: w.sub === 'trialing' ? 'trial' : 'active', suspensionMode: null, suspensionMessage: null, suspensionAutoResume: false, updatedAt: now }).where(eq(s.workspaces.id, id));
            await audit(tx, staff, id, 'secu', 'ops.workspace_resumed', `เปิดใช้งาน Workspace อีกครั้ง · ไม่ใช่การใช้ผิด (${tag})`, { type: 'workspace', id });
          }
        } else if (input.action === 'verify_identity' || input.action === 'suspend') {
          const mode = input.action === 'verify_identity' ? 'read_only' : 'full';
          const message = input.action === 'verify_identity' ? VERIFY_MSG : SUSPEND_MSG;
          for (const w of wsList) {
            if (await this.setSuspended(tx, staff, w.id, mode, message, tag)) {
              suspendedIds = [...new Set([...suspendedIds, w.id])];
              // ระบบระงับไว้แล้วและส่งอีเมลไปแล้ว ไม่ส่งข้อความเดิมซ้ำ
              if (!(c.suspendedIds.includes(w.id) && mode === 'full')) mails.push({ id: w.id, message });
            }
            if (input.action === 'suspend' && c.kind === 'invite_spam') {
              const revoked = await tx.update(s.invitations).set({ status: 'revoked' }).where(and(eq(s.invitations.workspaceId, w.id), eq(s.invitations.status, 'pending'))).returning({ id: s.invitations.id });
              if (revoked.length) await audit(tx, staff, w.id, 'perm', 'ops.invitations_revoked', `ยกเลิกคำเชิญที่ค้าง ${revoked.length} รายการ · ${tag}`, { type: 'workspace', id: w.id });
            }
          }
        } else {
          // ลบแบบเดียวกับที่ลูกค้าลบเอง: กู้คืนได้ 30 วัน (หน้ากู้คืนข้อมูลลูกค้า) แล้วงานลบถาวรของ API ลูกค้าลบต่อ (ข้าม Legal hold)
          const purgeAfter = new Date(now.getTime() + RESTORE_DAYS * DAY);
          for (const w of wsList) {
            await tx.update(s.workspaces).set({ deletedAt: now, purgeAfter, status: 'pending_delete', updatedAt: now }).where(eq(s.workspaces.id, w.id));
            await audit(tx, staff, w.id, 'secu', 'ops.workspace_deleted', `ลบ Workspace ${w.slug} (สมัครปลอม) · กู้คืนได้ถึง ${purgeAfter.toISOString().slice(0, 10)} · ${tag}`, { type: 'workspace', id: w.id });
          }
          const b = this.blockable(c);
          const add = [
            ...(b.ip ? [{ kind: 'ip' as const, value: b.ip, expiresAt: new Date(now.getTime() + IP_BLOCK_DAYS * DAY) }] : []),
            ...b.domains.map((d) => ({ kind: 'email_domain' as const, value: d, expiresAt: null })),
          ];
          for (const x of add) {
            const [row] = await tx
              .insert(s.abuseBlocks)
              .values({ kind: x.kind, value: x.value, reason: tag, caseId: c.id, expiresAt: x.expiresAt, createdBy: staff.id })
              .onConflictDoNothing()
              .returning({ id: s.abuseBlocks.id });
            if (row) blocks.push({ kind: x.kind, value: x.value });
          }
        }
        await tx.update(s.abuseCases).set({ status: 'closed', outcome, reason: input.reason, decidedBy: staff.id, decidedAt: now, suspendedIds }).where(eq(s.abuseCases.id, c.id));
        await staffAudit(tx, staff, `abuse.${outcome}`, `เคส #${c.number} ${c.label} (คะแนน ${c.score}) · ${input.reason}`, { type: 'abuse_case', id: c.id });
      }
    });
    for (const m of mails) await this.mailCustomer(m.id, m.message);
    const [next] = await this.db.select({ id: s.abuseCases.id }).from(s.abuseCases).where(ne(s.abuseCases.status, 'closed')).orderBy(sql`${s.abuseCases.score} desc`, s.abuseCases.createdAt).limit(1);
    return { decided: list.length, outcome, blocks, next: next?.id ?? null };
  }

  // ---------------------------------------------------------------- รายชื่อที่ถูกบล็อก

  async blocks(q: z.infer<typeof BlocksQuery>) {
    const where: SQL[] = [sql`b.removed_at is null`, sql`(b.expires_at is null or b.expires_at > now())`];
    if (q.kind) where.push(sql`b.kind = ${q.kind}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`).toLowerCase()}%`;
      where.push(sql`(lower(b.value) like ${like} or lower(coalesce(b.label, '')) like ${like} or lower(b.reason) like ${like})`);
    }
    const cond = sql.join(where, sql` and `);
    const items = await this.rows<Record<string, unknown>>(sql`
      select b.id, b.kind, b.value, b.label, b.reason, b.expires_at as "expiresAt", b.created_at as "createdAt", coalesce(st.name, 'ระบบ') as "createdBy", c.number as "caseNumber"
      from abuse_blocks b left join staff_users st on st.id = b.created_by left join abuse_cases c on c.id = b.case_id
      where ${cond} order by b.created_at desc limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from abuse_blocks b where ${cond}`);
    return { items, total: n };
  }

  /** เพิ่มเอง · api_token = ยกเลิก token นั้นทันที (ลูกค้าเห็นใน Audit log ของ Workspace) */
  async addBlock(staff: Staff, input: z.output<typeof AddBlockBody>) {
    return this.db.transaction(async (tx) => {
      let label: string | null = null;
      let workspaceId: string | null = null;
      if (input.kind === 'api_token') {
        const [t] = await tx.select({ name: s.apiTokens.name, ws: s.apiTokens.workspaceId, wsName: s.workspaces.name }).from(s.apiTokens).innerJoin(s.workspaces, eq(s.workspaces.id, s.apiTokens.workspaceId)).where(eq(s.apiTokens.id, input.value));
        if (!t) throw new AppError(404, 'not_found', 'ไม่พบ token');
        label = `${t.wsName} · ${t.name}`;
        workspaceId = t.ws;
        await tx.update(s.apiTokens).set({ revokedAt: sql`coalesce(${s.apiTokens.revokedAt}, now())` }).where(eq(s.apiTokens.id, input.value));
      }
      const [row] = await tx
        .insert(s.abuseBlocks)
        .values({ kind: input.kind, value: input.value, label, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: staff.id })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new AppError(409, 'already_blocked', 'รายการนี้ถูกบล็อกอยู่แล้ว');
      const text = `บล็อก ${input.kind} ${label ?? input.value}${input.expiresAt ? ` ถึง ${input.expiresAt.slice(0, 10)}` : ' ถาวร'} · ${input.reason}`;
      if (workspaceId) await audit(tx, staff, workspaceId, 'secu', 'ops.api_token_blocked', text, { type: 'api_token', id: input.value });
      else await staffAudit(tx, staff, 'abuse.block_added', text, { type: 'abuse_block', id: row.id });
      return row;
    });
  }

  async removeBlock(staff: Staff, id: string, reason: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการ');
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(s.abuseBlocks).set({ removedAt: new Date(), removedBy: staff.id }).where(and(eq(s.abuseBlocks.id, id), isNull(s.abuseBlocks.removedAt))).returning();
      if (!row) throw new AppError(404, 'not_found', 'ไม่พบรายการ หรือเลิกบล็อกไปแล้ว');
      await staffAudit(tx, staff, 'abuse.block_removed', `เลิกบล็อก ${row.kind} ${row.label ?? row.value} · ${reason}`, { type: 'abuse_block', id });
      return { id, removed: true };
    });
  }
}
