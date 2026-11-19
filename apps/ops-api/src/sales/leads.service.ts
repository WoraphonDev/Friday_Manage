import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { todayBkk } from '../billing/ledger.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { PageQuery } from '../paging.js';
import { sqlRows } from '../sql-rows.js';

const s = schema;
const { LEAD_STAGES, LEAD_LOST_REASONS } = schema;
const HOUR = 3_600_000;
const KEY = 'leads';
const OPEN = ['new', 'contacted', 'demo', 'proposal'] as const;
/** แพ้แล้วเก็บ 2 ปี (นโยบายการเก็บข้อมูล) */
const LOST_KEEP_DAYS = 730;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NEEDS = ['sso', 'annual_contract', 'tax_invoice', 'onboarding', 'api', 'security_review', 'other'] as const;

export const LeadSettings = z.object({ trialSeats: z.number().int().min(1).max(10_000) }).strict();
export type LeadSettings = z.infer<typeof LeadSettings>;
const DEFAULTS: LeadSettings = { trialSeats: 20 };

export const LeadsQuery = PageQuery.extend({
  stage: z.enum(LEAD_STAGES).optional(),
  q: z.string().trim().max(100).optional(),
  source: z.enum(['form', 'trial', 'manual']).optional(),
  owner: z.union([z.uuid(), z.literal('me')]).optional(),
  minValue: z.coerce.number().int().min(0).optional(),
  overdue: z.enum(['true']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export const CreateLeadBody = z
  .object({
    company: z.string().trim().min(2).max(200),
    contactName: z.string().trim().max(120).optional(),
    email: z.email().trim().toLowerCase().max(254).optional(),
    phone: z.string().trim().max(40).optional(),
    seats: z.number().int().min(1).max(100_000).optional(),
    valueSatang: z.number().int().min(0).optional(),
    needs: z.array(z.enum(NEEDS)).default([]),
    nextAction: z.string().trim().min(2).max(200),
    nextAt: isoDate,
  })
  .strict();
export const UpdateLeadBody = z
  .object({
    stage: z.enum(LEAD_STAGES).optional(),
    lostReason: z.enum(LEAD_LOST_REASONS).optional(),
    ownerId: z.uuid().nullable().optional(),
    valueSatang: z.number().int().min(0).nullable().optional(),
    seats: z.number().int().min(1).max(100_000).nullable().optional(),
    /** ชนะ: ผูกบัญชีลูกค้าเดิม · ไม่ระบุ = สร้างบัญชีใหม่จากชื่อบริษัท */
    accountId: z.uuid().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.stage !== 'lost' || v.lostReason, { path: ['lostReason'], message: 'แพ้ต้องระบุเหตุผล' });
export const NoteBody = z
  .object({
    kind: z.enum(['call', 'email', 'meeting', 'note']),
    body: z.string().trim().min(2).max(4000),
    /** ต้องกำหนดทำต่อทุกครั้ง ดีลจะได้ไม่ค้างเงียบ (storyboard ขั้น 2) */
    nextAction: z.string().trim().min(2).max(200),
    nextAt: isoDate,
  })
  .strict();

/** เลย 1 วันทำการ (ไม่นับเสาร์-อาทิตย์) นับจากสร้าง */
function businessHoursSince(created: Date, now = new Date()) {
  let h = 0;
  for (let t = created.getTime(); t < now.getTime(); t += HOUR) {
    const d = new Date(t + 7 * HOUR).getUTCDay();
    if (d !== 0 && d !== 6) h++;
  }
  return h;
}

/**
 * Lead และดีล (O54 · เฟส 3) · Owner (ภายหลังเพิ่มบทบาทฝ่ายขายได้)
 * ที่มา: ฟอร์มติดต่อฝ่ายขาย (API ลูกค้า) · ลูกค้าทดลองที่ที่นั่งใช้งานจริงถึงเกณฑ์ (งานรายวัน) · เพิ่มเอง
 */
@Injectable()
export class LeadsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsLeads');
  private timer?: NodeJS.Timeout;

  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  onModuleInit() {
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.daily().catch((e) => this.log.error(String(e))), 6 * HOUR);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private rows<T>(q: SQL, db: Db | Tx = this.db) {
    return sqlRows<T>(db, q);
  }

  async settings(): Promise<LeadSettings> {
    const [r] = await this.db.select({ value: s.opsSettings.value }).from(s.opsSettings).where(eq(s.opsSettings.key, KEY));
    const ok = LeadSettings.safeParse({ ...DEFAULTS, ...((r?.value ?? {}) as object) });
    return ok.success ? ok.data : DEFAULTS;
  }
  async saveSettings(staff: Staff, input: LeadSettings) {
    await this.db.insert(s.opsSettings).values({ key: KEY, value: input, updatedBy: staff.id }).onConflictDoUpdate({ target: s.opsSettings.key, set: { value: input, updatedBy: staff.id, updatedAt: new Date() } });
    await staffAudit(this.db, staff, 'leads.settings_updated', `Lead จากลูกค้าทดลองเมื่อที่นั่งใช้งานจริง ≥ ${input.trialSeats}`);
    return input;
  }

  /** งานรายวัน: Lead จากลูกค้าทดลองที่เข้าเกณฑ์ (ไม่สร้างซ้ำ) · ลบ Lead ที่แพ้เกิน 2 ปี */
  async daily(today = todayBkk()) {
    const { trialSeats } = await this.settings();
    const found = await this.rows<{ id: string; name: string; seats: number; email: string | null }>(sql`
      select w.id, w.name,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest' and m.last_active_at > now() - interval '14 days') as seats,
        (select u.email from workspace_members m join users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.joined_at limit 1) as email
      from workspaces w join subscriptions sub on sub.workspace_id = w.id
      where w.deleted_at is null and sub.status = 'trialing'
        and not exists (select 1 from leads l where l.workspace_id = w.id)
        and not exists (select 1 from ops_workspace_flags f where f.workspace_id = w.id and f.test_flag = 'test')`);
    let created = 0;
    for (const w of found.filter((x) => x.seats >= trialSeats)) {
      const [lead] = await this.db
        .insert(s.leads)
        .values({ company: w.name, email: w.email, seats: w.seats, teamSize: w.seats, source: 'trial', workspaceId: w.id })
        .onConflictDoNothing()
        .returning({ id: s.leads.id });
      if (!lead) continue;
      await this.db.insert(s.leadNotes).values({ leadId: lead.id, kind: 'system', body: `ลูกค้าทดลองใช้งานจริง ${w.seats} ที่นั่ง (เกณฑ์ ${trialSeats})` });
      created++;
    }
    const purged = await this.db.delete(s.leads).where(and(eq(s.leads.stage, 'lost'), sql`${s.leads.closedAt} < ${today}::date - ${LOST_KEEP_DAYS}::int`)).returning({ id: s.leads.id });
    return { created, purged: purged.length };
  }

  private readonly COLS = sql`l.id, l.number, l.company, l.contact_name as "contactName", l.contact_title as "contactTitle", l.email, l.phone, l.team_size as "teamSize", l.needs, l.message,
    l.source, l.stage, l.lost_reason as "lostReason", l.value_satang::float8 as "valueSatang", l.seats, l.owner_id as "ownerId", st.name as owner,
    l.next_action as "nextAction", to_char(l.next_at, 'YYYY-MM-DD') as "nextAt", l.workspace_id as "workspaceId", l.account_id as "accountId",
    l.contacted_at as "contactedAt", l.closed_at as "closedAt", l.created_at as "createdAt"`;

  /** ตัวเลขหัวหน้า + ต้องทำตอนนี้ (ยังไม่ติดต่อ · นัดถึงวันนี้) + จำนวน / มูลค่าต่อขั้น */
  async summary(today = todayBkk()) {
    const [n] = await this.rows<{ open: number; pipeline: number; won: number; lost: number }>(sql`
      select count(*) filter (where stage in ('new', 'contacted', 'demo', 'proposal'))::int as open,
        coalesce(sum(value_satang) filter (where stage in ('new', 'contacted', 'demo', 'proposal')), 0)::float8 as pipeline,
        count(*) filter (where stage = 'won' and closed_at > now() - interval '90 days')::int as won,
        count(*) filter (where stage = 'lost' and closed_at > now() - interval '90 days')::int as lost
      from leads`);
    const stages = await this.rows<{ stage: string; n: number; value: number }>(sql`select stage, count(*)::int as n, coalesce(sum(value_satang), 0)::float8 as value from leads group by stage`);
    const todo = await this.rows<Record<string, unknown> & { createdAt: string; stage: string; nextAt: string | null }>(sql`
      select ${this.COLS} from leads l left join staff_users st on st.id = l.owner_id
      where l.stage = 'new' or (l.stage in ('contacted', 'demo', 'proposal') and l.next_at <= ${today}::date)
      order by (l.stage = 'new') desc, l.created_at limit 50`);
    const now = new Date();
    const items = todo.map((x) => ({ ...x, late: x.stage === 'new' ? businessHoursSince(new Date(x.createdAt), now) > 24 : !!x.nextAt && x.nextAt < today }));
    return {
      open: n.open, pipelineSatang: n.pipeline, won90: n.won, lost90: n.lost,
      stages: Object.fromEntries(LEAD_STAGES.map((st) => [st, stages.find((x) => x.stage === st) ?? { stage: st, n: 0, value: 0 }])),
      todo: { items, uncontacted: items.filter((x) => x.stage === 'new').length, late: items.filter((x) => x.stage === 'new' && x.late).length, due: items.filter((x) => x.stage !== 'new').length },
    };
  }

  private where(staff: Staff, q: z.infer<typeof LeadsQuery>, today: string) {
    const w: SQL[] = [q.stage ? sql`l.stage = ${q.stage}` : sql`l.stage in ('new', 'contacted', 'demo', 'proposal')`];
    if (q.q) {
      const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      w.push(sql`(lower(l.company) like ${like} or lower(coalesce(l.email, '')) like ${like} or lower(coalesce(l.contact_name, '')) like ${like})`);
    }
    if (q.source) w.push(sql`l.source = ${q.source}`);
    if (q.owner) w.push(sql`l.owner_id = ${q.owner === 'me' ? staff.id : q.owner}`);
    if (q.minValue) w.push(sql`coalesce(l.value_satang, 0) >= ${q.minValue}`);
    if (q.overdue) w.push(sql`l.next_at < ${today}::date and l.stage in ('contacted', 'demo', 'proposal')`);
    if (q.from) w.push(sql`l.created_at >= ${q.from}::date::timestamp at time zone 'Asia/Bangkok'`);
    if (q.to) w.push(sql`l.created_at < (${q.to}::date + 1)::timestamp at time zone 'Asia/Bangkok'`);
    return sql.join(w, sql` and `);
  }

  async list(staff: Staff, q: z.infer<typeof LeadsQuery>, today = todayBkk()) {
    const cond = this.where(staff, q, today);
    const items = await this.rows<Record<string, unknown>>(sql`
      select ${this.COLS} from leads l left join staff_users st on st.id = l.owner_id where ${cond}
      order by ${q.stage === 'won' || q.stage === 'lost' ? sql`l.closed_at desc` : sql`l.next_at nulls first, l.created_at`} limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from leads l where ${cond}`);
    return { items, total: n };
  }

  async csv(staff: Staff, q: z.infer<typeof LeadsQuery>) {
    const { items } = await this.list(staff, { ...q, limit: 200, offset: 0 });
    const head = ['number', 'company', 'contact', 'email', 'phone', 'source', 'stage', 'seats', 'value_baht', 'owner', 'next_action', 'next_at', 'created_at'];
    const esc = (v: unknown) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = items.map((r) => [r.number, r.company, r.contactName, r.email, r.phone, r.source, r.stage, r.seats, r.valueSatang == null ? '' : Number(r.valueSatang) / 100, r.owner, r.nextAction, r.nextAt, r.createdAt].map(esc).join(','));
    return `﻿${[head.join(','), ...lines].join('\n')}\n`;
  }

  private async lead(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Lead');
    const [l] = await this.rows<Record<string, unknown> & { workspaceId: string | null; stage: string }>(sql`select ${this.COLS} from leads l left join staff_users st on st.id = l.owner_id where l.id = ${id}`);
    if (!l) throw new AppError(404, 'not_found', 'ไม่พบ Lead');
    return l;
  }

  /** แผงขวา: ผู้ติดต่อ · การใช้งาน Workspace ทดลอง (ถ้ามี) · บันทึกการคุย */
  async detail(id: string) {
    const l = await this.lead(id);
    const notes = await this.rows<Record<string, unknown>>(sql`
      select n.id, n.kind, n.body, n.next_action as "nextAction", to_char(n.next_at, 'YYYY-MM-DD') as "nextAt", n.created_at as "createdAt", st.name as by
      from lead_notes n left join staff_users st on st.id = n.created_by where n.lead_id = ${id} order by n.created_at desc`);
    const [trial] = l.workspaceId
      ? await this.rows<Record<string, unknown>>(sql`
        select w.id, w.name, w.slug, p.code as plan, sub.status, sub.trial_ends_at as "trialEndsAt",
          (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
          (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.last_active_at > now() - interval '14 days') as active14,
          (select count(*)::int from projects x where x.workspace_id = w.id and x.deleted_at is null) as projects
        from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id where w.id = ${l.workspaceId}`)
      : [];
    return { ...l, notes, trial: trial ?? null };
  }

  async create(staff: Staff, input: z.infer<typeof CreateLeadBody>) {
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(s.leads)
        .values({ company: input.company, contactName: input.contactName ?? null, email: input.email ?? null, phone: input.phone ?? null, seats: input.seats ?? null, teamSize: input.seats ?? null, valueSatang: input.valueSatang ?? null, needs: input.needs, source: 'manual', ownerId: staff.id, nextAction: input.nextAction, nextAt: input.nextAt })
        .returning({ id: s.leads.id });
      await tx.insert(s.leadNotes).values({ leadId: row.id, kind: 'system', body: `${staff.name} เพิ่ม Lead`, nextAction: input.nextAction, nextAt: input.nextAt, createdBy: staff.id });
      await staffAudit(tx, staff, 'leads.created', input.company, { type: 'lead', id: row.id });
      return row.id;
    });
    return this.detail(id);
  }

  /** รับเรื่อง: เป็นคนดูแล */
  async claim(staff: Staff, id: string) {
    await this.lead(id);
    await this.db.update(s.leads).set({ ownerId: staff.id }).where(eq(s.leads.id, id));
    await this.db.insert(s.leadNotes).values({ leadId: id, kind: 'system', body: `${staff.name} รับเรื่อง`, createdBy: staff.id });
    return this.detail(id);
  }

  /** บันทึกการคุย · ต้องกำหนดทำต่อ · Lead ใหม่ที่ถูกติดต่อแล้วขยับเป็น "ติดต่อแล้ว" เอง */
  async note(staff: Staff, id: string, input: z.infer<typeof NoteBody>) {
    const l = await this.lead(id);
    if (l.stage === 'won' || l.stage === 'lost') throw new AppError(409, 'lead_closed', 'ดีลนี้ปิดแล้ว');
    await this.db.transaction(async (tx) => {
      await tx.insert(s.leadNotes).values({ leadId: id, kind: input.kind, body: input.body, nextAction: input.nextAction, nextAt: input.nextAt, createdBy: staff.id });
      await tx
        .update(s.leads)
        .set({ nextAction: input.nextAction, nextAt: input.nextAt, ownerId: sql`coalesce(${s.leads.ownerId}, ${staff.id}::uuid)`, ...(l.stage === 'new' ? { stage: 'contacted', contactedAt: new Date() } : {}) })
        .where(eq(s.leads.id, id));
    });
    return this.detail(id);
  }

  /** เปลี่ยนขั้น / มูลค่า / คนดูแล · ชนะ = ผูกหรือสร้างบัญชีลูกค้า (ไปต่อที่ใบเสนอราคา) · แพ้ต้องมีเหตุผล */
  async update(staff: Staff, id: string, input: z.infer<typeof UpdateLeadBody>) {
    const l = await this.lead(id);
    const closing = input.stage === 'won' || input.stage === 'lost';
    await this.db.transaction(async (tx) => {
      let accountId = (l.accountId as string | null) ?? null;
      if (input.stage === 'won' && !accountId) {
        if (input.accountId) accountId = input.accountId;
        else {
          const [acct] = await tx.insert(s.customerAccounts).values({ name: l.company as string, kind: 'enterprise', managerId: (l.ownerId as string | null) ?? staff.id, createdBy: staff.id, contacts: l.email ? [{ name: l.contactName ?? '', email: l.email, phone: l.phone ?? '', role: 'signer' }] : [] }).returning({ id: s.customerAccounts.id });
          accountId = acct.id;
          await staffAudit(tx, staff, 'account.created', `${l.company} (จาก Lead #${l.number})`, { type: 'customer_account', id: acct.id });
        }
        if (l.workspaceId) await tx.insert(s.customerAccountWorkspaces).values({ workspaceId: l.workspaceId, accountId, addedBy: staff.id }).onConflictDoNothing();
      }
      await tx
        .update(s.leads)
        .set({
          ...(input.stage ? { stage: input.stage, lostReason: input.stage === 'lost' ? input.lostReason : null, closedAt: closing ? new Date() : null } : {}),
          ...(input.stage && input.stage !== 'new' && !l.contactedAt ? { contactedAt: new Date() } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          ...(input.valueSatang !== undefined ? { valueSatang: input.valueSatang } : {}),
          ...(input.seats !== undefined ? { seats: input.seats } : {}),
          ...(accountId ? { accountId } : {}),
        })
        .where(eq(s.leads.id, id));
      if (input.stage && input.stage !== l.stage) {
        await tx.insert(s.leadNotes).values({ leadId: id, kind: 'system', body: `${l.stage} → ${input.stage}${input.lostReason ? ` (${input.lostReason})` : ''}${input.note ? ` · ${input.note}` : ''}`, createdBy: staff.id });
        await staffAudit(tx, staff, `leads.${input.stage}`, `${l.company}${input.note ? ` · ${input.note}` : ''}`, { type: 'lead', id });
      }
    });
    return this.detail(id);
  }

  /** ใช้ในหน้าใบเสนอราคา (O55) และค้นหา */
  async open() {
    return this.rows<{ id: string; company: string }>(sql`select id, company from leads where stage in (${sql.join(OPEN.map((o) => sql`${o}`), sql`, `)}) order by company limit 200`);
  }
}
