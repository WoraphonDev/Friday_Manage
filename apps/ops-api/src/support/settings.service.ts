import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { BusinessClock, DEFAULT_HOURS, type Dur } from './clock.js';

const s = schema;
const { SUPPORT_GROUPS, SUPPORT_PRESENCE, SUPPORT_RULE_TARGETS, TICKET_CATEGORIES } = schema;
type Row = Record<string, unknown>;
const PLANS = ['free', 'team_s', 'team_m', 'team_l', 'enterprise'] as const;
const PLAN_NAMES: Record<string, string> = { free: 'Free', team_s: 'Team S', team_m: 'Team M', team_l: 'Team L', enterprise: 'Enterprise' };
const ACTIVE = sql.raw(`('open', 'pending_customer', 'pending_dev')`);
/** เตือนผู้รับผิดชอบเมื่อเหลือเวลา 25% (Canvas · ค่าคงที่) */
export const SLA_WARN_PCT = 25;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'เวลาต้องเป็น HH:MM');
const DurSchema = z.object({ n: z.number().int().min(1).max(999), unit: z.enum(['h', 'd']) }).strict();
const PlanSla = z.object({ first: DurSchema.nullable(), resolve: DurSchema.nullable() }).strict();
export const SupportConfig = z
  .object({
    /** least = งานน้อยที่สุดก่อน · round = วนตามลำดับ · manual = ไม่แจกอัตโนมัติ */
    mode: z.enum(['least', 'round', 'manual']),
    defaultCap: z.number().int().min(1).max(99),
    skipUnavailable: z.boolean(),
    reopenDays: z.number().int().min(1).max(30),
    /** ผู้รับผิดชอบออฟไลน์/ลา: queue = คืนงานเข้าคิวกลาง · ask_lead = แจ้งหัวหน้าทีม · keep = คงไว้ที่คนเดิม */
    onAway: z.enum(['queue', 'ask_lead', 'keep']),
    sla: z.object(Object.fromEntries(PLANS.map((p) => [p, PlanSla])) as Record<(typeof PLANS)[number], typeof PlanSla>).strict(),
    hours: z.array(z.object({ open: z.boolean(), from: HHMM, to: HHMM }).strict()).length(7),
    thaiHolidays: z.boolean(),
  })
  .strict()
  .superRefine((c, ctx) => {
    c.hours.forEach((h, i) => h.open && h.to <= h.from && ctx.addIssue({ code: 'custom', path: ['hours', i, 'to'], message: 'เวลาปิดต้องหลังเวลาเปิด' }));
    if (!c.hours.some((h) => h.open)) ctx.addIssue({ code: 'custom', path: ['hours'], message: 'ต้องเปิดทำการอย่างน้อย 1 วัน' });
  });
export type SupportConfig = z.infer<typeof SupportConfig>;

/** ค่าเริ่มต้นตาม Canvas (SupportSettings) · แถวในฐานเก็บเฉพาะค่าที่ Owner บันทึก */
export const DEFAULT_CONFIG: SupportConfig = {
  mode: 'least',
  defaultCap: 8,
  skipUnavailable: true,
  reopenDays: 7,
  onAway: 'queue',
  sla: {
    free: { first: { n: 2, unit: 'd' }, resolve: null },
    team_s: { first: { n: 4, unit: 'h' }, resolve: { n: 3, unit: 'd' } },
    team_m: { first: { n: 4, unit: 'h' }, resolve: { n: 3, unit: 'd' } },
    team_l: { first: { n: 2, unit: 'h' }, resolve: { n: 2, unit: 'd' } },
    enterprise: { first: { n: 1, unit: 'h' }, resolve: { n: 1, unit: 'd' } },
  },
  hours: DEFAULT_HOURS,
  thaiHolidays: true,
};

const AgentInput = z.object({ staffId: z.uuid(), groups: z.array(z.enum(SUPPORT_GROUPS)).max(4), cap: z.number().int().min(1).max(99).nullable() }).strict();
export const SaveSettingsBody = z.object({ config: SupportConfig, agents: z.array(AgentInput).max(200).default([]) }).strict();
const Priority = z.enum(['low', 'normal', 'high', 'urgent']);
export const RuleBody = z
  .object({
    plans: z.array(z.enum(PLANS)).max(5).default([]),
    categories: z.array(z.enum(TICKET_CATEGORIES)).max(TICKET_CATEGORIES.length).default([]),
    target: z.enum(SUPPORT_RULE_TARGETS),
    priority: Priority.default('normal'),
    enabled: z.boolean().default(true),
  })
  .strict();
export const RulePatch = z.object({ enabled: z.boolean() }).strict();
export const ReorderBody = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();
export const PresenceBody = z.object({ presence: z.enum(SUPPORT_PRESENCE), note: z.string().trim().max(80).optional() }).strict();
export const AccountsBody = z.object({ workspaceIds: z.array(z.uuid()).max(200) }).strict();
export const CannedBody = z
  .object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(5000), tag: z.string().trim().max(30).optional() })
  .strict();

const TARGET_NAMES: Record<string, string> = { l1: 'ระดับ 1', l2: 'ระดับ 2', fin: 'การเงิน', acct: 'ผู้ดูแลประจำบัญชี', all: 'ทุกคน' };
const MODE_NAMES: Record<SupportConfig['mode'], string> = { least: 'งานน้อยที่สุดก่อน', round: 'วนตามลำดับ', manual: 'ไม่แจกอัตโนมัติ' };
const durText = (d: Dur | null) => (d ? `${d.n} ${d.unit === 'h' ? 'ชม.' : 'วัน'}ทำการ` : 'ไม่กำหนด');

export interface Route {
  ruleId: string | null;
  target: string;
  priority: string;
  assigneeId: string | null;
}

/**
 * ตั้งค่าการแจกงาน Support (O22): วิธีแจก · กฎแยกตามประเภท · SLA ตามแพ็กเกจ · เวลาทำการ · กลุ่มและสถานะพนักงาน · ข้อความสำเร็จรูป
 * แก้ได้เฉพาะ Owner · ทุกการเปลี่ยนลง staff_audit_logs
 */
@Injectable()
export class SupportSettingsService {
  private holidayCache?: { at: number; days: Set<string>; upcoming: { date: string; name: string }[] };

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** ค่าที่ใช้อยู่ = ค่าเริ่มต้นทับด้วยค่าที่บันทึก (ค่าที่บันทึกไม่ครบหรือรูปผิดใช้ค่าเริ่มต้นแทนทั้งชุด) */
  async config(): Promise<SupportConfig> {
    const [r] = await this.db.select({ config: s.supportSettings.config }).from(s.supportSettings).where(eq(s.supportSettings.id, 1));
    const saved = (r?.config ?? {}) as Partial<SupportConfig>;
    const merged = { ...DEFAULT_CONFIG, ...saved, sla: { ...DEFAULT_CONFIG.sla, ...(saved.sla ?? {}) } };
    const ok = SupportConfig.safeParse(merged);
    return ok.success ? ok.data : DEFAULT_CONFIG;
  }

  /** วันหยุดราชการไทย = ปฏิทินของระบบ (holiday_calendars ที่ workspace_id ว่าง) · จำไว้ 10 นาที */
  async holidays() {
    if (this.holidayCache && Date.now() - this.holidayCache.at < 600_000) return this.holidayCache;
    const list = await this.rows<{ date: string; name: string }>(sql`
      select distinct on (h.date) h.date::text as date, h.name from holidays h join holiday_calendars c on c.id = h.calendar_id
      where c.workspace_id is null and h.date >= current_date - 30 and h.date <= current_date + 400 order by h.date`);
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    this.holidayCache = { at: Date.now(), days: new Set(list.map((h) => h.date)), upcoming: list.filter((h) => h.date >= today).slice(0, 3) };
    return this.holidayCache;
  }

  async clock(cfg?: SupportConfig) {
    const c = cfg ?? (await this.config());
    return new BusinessClock(c.hours, c.thaiHolidays ? (await this.holidays()).days : new Set());
  }

  /** กำหนด SLA ของ Ticket ใหม่ · ด่วนนับ 24 ชม. ทุกวัน ตอบครั้งแรกไม่เกิน 1 ชม. */
  async due(plan: string, priority: string, from: Date) {
    const cfg = await this.config();
    const sla = cfg.sla[plan as keyof SupportConfig['sla']] ?? cfg.sla.free;
    if (priority === 'urgent') {
      const h = (d: Dur | null) => (d ? d.n * (d.unit === 'd' ? 24 : 1) : null);
      const first = Math.min(h(sla.first) ?? 1, 1);
      const resolve = h(sla.resolve);
      return { first: new Date(from.getTime() + first * 3_600_000), resolve: resolve ? new Date(from.getTime() + resolve * 3_600_000) : null, sla, open: true };
    }
    const clock = await this.clock(cfg);
    return { first: sla.first ? clock.add(from, sla.first) : null, resolve: sla.resolve ? clock.add(from, sla.resolve) : null, sla, open: clock.isOpen(from) };
  }

  // ── หน้าตั้งค่า ──────────────────────────────────────────

  private async agents() {
    return this.rows<{ staffId: string; name: string; email: string; groups: string[]; cap: number | null; presence: string; presenceNote: string | null; presenceAt: string | null; load: number; accounts: { id: string; name: string }[] }>(sql`
      select st.id as "staffId", st.name, st.email, coalesce(a.groups, '{}') as groups, a.cap, coalesce(a.presence, 'online') as presence, a.presence_note as "presenceNote", a.presence_at as "presenceAt",
        (select count(*)::int from support_tickets k where k.assignee_id = st.id and k.status in ${ACTIVE}) as load,
        coalesce((select json_agg(json_build_object('id', w.id, 'name', w.name) order by w.name) from support_account_managers m join workspaces w on w.id = m.workspace_id where m.staff_id = st.id), '[]') as accounts
      from staff_users st left join support_agents a on a.staff_id = st.id
      where st.status = 'active' and 'support' = any(st.roles) and (st.expires_at is null or st.expires_at > now())
      order by st.name`);
  }

  private async ruleList() {
    return this.db.select().from(s.supportRules).orderBy(asc(s.supportRules.position), asc(s.supportRules.createdAt));
  }

  async view(staff: Staff) {
    const [config, rules, agents, hol, [meta]] = await Promise.all([
      this.config(),
      this.ruleList(),
      this.agents(),
      this.holidays(),
      this.rows<{ updatedAt: string | null; updatedBy: string | null }>(sql`select ss.updated_at as "updatedAt", st.name as "updatedBy" from support_settings ss left join staff_users st on st.id = ss.updated_by where ss.id = 1`),
    ]);
    return {
      config, rules, agents, warnPct: SLA_WARN_PCT,
      holidays: { count: hol.days.size, upcoming: hol.upcoming },
      updatedAt: meta?.updatedBy ? meta.updatedAt : null, updatedBy: meta?.updatedBy ?? null,
      canEdit: staff.roles.includes('owner'),
    };
  }

  /** บันทึกหน้า (ปุ่ม "บันทึก"): ค่าตั้ง + กลุ่ม / เพดานรายคน · Audit สรุปสิ่งที่เปลี่ยน */
  async save(staff: Staff, input: z.infer<typeof SaveSettingsBody>) {
    const before = await this.config();
    const next = input.config;
    const diff: string[] = [];
    if (before.mode !== next.mode) diff.push(`วิธีแจก ${MODE_NAMES[before.mode]} → ${MODE_NAMES[next.mode]}`);
    if (before.defaultCap !== next.defaultCap) diff.push(`เพดานค่าเริ่มต้น ${before.defaultCap} → ${next.defaultCap}`);
    if (before.skipUnavailable !== next.skipUnavailable) diff.push(next.skipUnavailable ? 'ไม่แจกให้คนไม่ว่าง/ออฟไลน์' : 'แจกให้คนไม่ว่าง/ออฟไลน์ด้วย');
    if (before.reopenDays !== next.reopenDays) diff.push(`เปิดใหม่ภายใน ${before.reopenDays} → ${next.reopenDays} วัน`);
    if (before.onAway !== next.onAway) diff.push(`คนออฟไลน์/ลา: ${next.onAway}`);
    for (const p of PLANS) {
      const a = before.sla[p];
      const b = next.sla[p];
      if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(`SLA ${PLAN_NAMES[p]}: ตอบ ${durText(a.first)} → ${durText(b.first)} · ปิด ${durText(a.resolve)} → ${durText(b.resolve)}`);
    }
    if (JSON.stringify(before.hours) !== JSON.stringify(next.hours)) diff.push('เวลาทำการ');
    if (before.thaiHolidays !== next.thaiHolidays) diff.push(next.thaiHolidays ? 'ใช้วันหยุดราชการไทย' : 'ไม่ใช้วันหยุดราชการไทย');

    const current = new Map((await this.agents()).map((a) => [a.staffId, a]));
    const agentChanges = input.agents.filter((a) => {
      const c = current.get(a.staffId);
      if (!c) throw new AppError(422, 'agent_invalid', 'ตั้งกลุ่มได้เฉพาะพนักงาน Support ที่ใช้งานอยู่');
      return [...c.groups].sort().join() !== [...new Set(a.groups)].sort().join() || c.cap !== a.cap;
    });
    for (const a of agentChanges) diff.push(`${current.get(a.staffId)!.name}: กลุ่ม ${a.groups.map((g) => TARGET_NAMES[g] ?? 'หัวหน้าทีม').join(', ') || '—'} · เพดาน ${a.cap ?? 'ค่าเริ่มต้น'}`);
    if (!diff.length) return { saved: false, changes: [] };

    await this.db.transaction(async (tx) => {
      await tx
        .insert(s.supportSettings)
        .values({ id: 1, config: next, updatedBy: staff.id })
        .onConflictDoUpdate({ target: s.supportSettings.id, set: { config: next, updatedBy: staff.id } });
      for (const a of agentChanges) {
        const groups = [...new Set(a.groups)];
        await tx
          .insert(s.supportAgents)
          .values({ staffId: a.staffId, groups, cap: a.cap })
          .onConflictDoUpdate({ target: s.supportAgents.staffId, set: { groups, cap: a.cap } });
      }
      await staffAudit(tx, staff, 'support.settings_updated', diff.join(' · '));
    });
    return { saved: true, changes: diff };
  }

  // ── กฎแยกตามประเภท (T6) ─────────────────────────────────

  private ruleText(r: { plans: string[]; categories: string[]; target: string; priority: string }) {
    const when = [r.plans.length ? `แพ็กเกจ ${r.plans.map((p) => PLAN_NAMES[p] ?? p).join('/')}` : '', r.categories.length ? `หมวด ${r.categories.join('/')}` : ''].filter(Boolean).join(' และ ') || 'เรื่องอื่นทั้งหมด';
    return `${when} → ${TARGET_NAMES[r.target]} · ${r.priority}`;
  }

  /** จำนวน Ticket ที่เปิดอยู่ที่ตรงเงื่อนไข (T6 แสดงก่อนบันทึก) */
  async preview(input: z.infer<typeof RuleBody>) {
    const parts: SQL[] = [sql`k.status in ${ACTIVE}`];
    if (input.plans.length) parts.push(sql`coalesce(p.code, 'free') in ${sql.raw(`(${input.plans.map((x) => `'${x}'`).join(', ')})`)}`);
    if (input.categories.length) parts.push(sql`k.category in ${sql.raw(`(${input.categories.map((x) => `'${x}'`).join(', ')})`)}`);
    const [r] = await this.rows<{ n: number }>(sql`
      select count(*)::int as n from support_tickets k left join subscriptions sub on sub.workspace_id = k.workspace_id left join plans p on p.id = sub.plan_id
      where ${sql.join(parts, sql` and `)}`);
    return { matches: r?.n ?? 0 };
  }

  async createRule(staff: Staff, input: z.infer<typeof RuleBody>) {
    const rule = await this.db.transaction(async (tx) => {
      // กฎใหม่ใส่ก่อนข้อ "เรื่องอื่นทั้งหมด" ข้อสุดท้าย (ถ้ามี) เพื่อไม่ให้ถูกบัง
      const list = await tx.select().from(s.supportRules).orderBy(asc(s.supportRules.position));
      const last = list.at(-1);
      const catchAll = last && !last.plans.length && !last.categories.length;
      const position = catchAll ? last.position : (last?.position ?? 0) + 1;
      if (catchAll) await tx.update(s.supportRules).set({ position: last.position + 1 }).where(eq(s.supportRules.id, last.id));
      const [r] = await tx.insert(s.supportRules).values({ ...input, position, createdBy: staff.id }).returning();
      await staffAudit(tx, staff, 'support.rule_created', `เพิ่มกฎ: ${this.ruleText(r)}`, { type: 'support_rule', id: r.id });
      return r;
    });
    return { rule };
  }

  async patchRule(staff: Staff, id: string, input: z.infer<typeof RulePatch>) {
    const rule = await this.findRule(id);
    if (rule.enabled === input.enabled) return { rule };
    const [r] = await this.db.update(s.supportRules).set({ enabled: input.enabled }).where(eq(s.supportRules.id, id)).returning();
    await staffAudit(this.db, staff, 'support.rule_toggled', `${input.enabled ? 'เปิด' : 'ปิด'}กฎ: ${this.ruleText(r)}`, { type: 'support_rule', id });
    return { rule: r };
  }

  async deleteRule(staff: Staff, id: string) {
    const rule = await this.findRule(id);
    await this.db.delete(s.supportRules).where(eq(s.supportRules.id, id));
    await staffAudit(this.db, staff, 'support.rule_deleted', `ลบกฎ: ${this.ruleText(rule)}`, { type: 'support_rule', id });
    return { deleted: true };
  }

  /** เรียงลำดับใหม่ · ต้องส่งกฎครบทุกข้อ */
  async reorder(staff: Staff, input: z.infer<typeof ReorderBody>) {
    const list = await this.ruleList();
    if (input.ids.length !== list.length || new Set(input.ids).size !== list.length || !list.every((r) => input.ids.includes(r.id))) throw new AppError(422, 'rules_mismatch', 'ลำดับกฎไม่ครบหรือไม่ตรงกับที่มีอยู่ · โหลดหน้าใหม่แล้วลองอีกครั้ง');
    await this.db.transaction(async (tx) => {
      for (const [i, id] of input.ids.entries()) await tx.update(s.supportRules).set({ position: i + 1 }).where(eq(s.supportRules.id, id));
      await staffAudit(tx, staff, 'support.rules_reordered', 'เรียงลำดับกฎการแจกงานใหม่', { type: 'support_rule', id: input.ids[0] });
    });
    return { rules: await this.ruleList() };
  }

  private async findRule(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบกฎ');
    const [r] = await this.db.select().from(s.supportRules).where(eq(s.supportRules.id, id));
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบกฎ');
    return r;
  }

  /** ผู้ดูแลประจำบัญชีของพนักงานคนนี้ (แทนรายการเดิมทั้งหมด) · Workspace ที่มีผู้ดูแลอื่นอยู่ย้ายมาเป็นคนนี้ */
  async setAccounts(staff: Staff, staffId: string, input: z.infer<typeof AccountsBody>) {
    const agent = (await this.agents()).find((a) => a.staffId === staffId);
    if (!agent) throw new AppError(422, 'agent_invalid', 'ผู้ดูแลประจำบัญชีต้องเป็นพนักงาน Support ที่ใช้งานอยู่');
    const ids = [...new Set(input.workspaceIds)];
    const ws = ids.length ? await this.db.select({ id: s.workspaces.id, name: s.workspaces.name }).from(s.workspaces).where(and(inArray(s.workspaces.id, ids), isNull(s.workspaces.deletedAt))) : [];
    if (ws.length !== ids.length) throw new AppError(404, 'workspace_not_found', 'ไม่พบบาง Workspace');
    await this.db.transaction(async (tx) => {
      await tx.delete(s.supportAccountManagers).where(eq(s.supportAccountManagers.staffId, staffId));
      if (ids.length) {
        await tx.delete(s.supportAccountManagers).where(inArray(s.supportAccountManagers.workspaceId, ids));
        await tx.insert(s.supportAccountManagers).values(ids.map((workspaceId) => ({ workspaceId, staffId })));
      }
      await staffAudit(tx, staff, 'support.accounts_updated', `ผู้ดูแลประจำบัญชีของ ${agent.name}: ${ws.map((w) => w.name).join(', ') || '—'}`, { type: 'staff_user', id: staffId });
    });
    return { accounts: ws };
  }

  // ── สถานะพนักงานและการแจกงาน ──────────────────────────────

  /** ทีมตอนนี้ (หน้า Support) */
  async team() {
    const [cfg, agents] = await Promise.all([this.config(), this.agents()]);
    return { mode: cfg.mode, defaultCap: cfg.defaultCap, items: agents.map(({ accounts: _a, email: _e, ...a }) => ({ ...a, cap: a.cap ?? cfg.defaultCap })) };
  }

  /** เปลี่ยนสถานะของตัวเอง · ออฟไลน์/ลา ทำตามที่ตั้งไว้ (คืนงานเข้าคิว / แจ้งหัวหน้าทีม / คงไว้) */
  async setPresence(staff: Staff, input: z.infer<typeof PresenceBody>) {
    const before = (await this.agents()).find((a) => a.staffId === staff.id);
    if (!before) throw new AppError(403, 'not_support_agent', 'ตั้งสถานะได้เฉพาะพนักงาน Support');
    const note = input.note || null;
    await this.db
      .insert(s.supportAgents)
      .values({ staffId: staff.id, presence: input.presence, presenceNote: note, presenceAt: new Date() })
      .onConflictDoUpdate({ target: s.supportAgents.staffId, set: { presence: input.presence, presenceNote: note, presenceAt: new Date() } });
    let released = 0;
    let leadsNotified = 0;
    const away = (p: string) => p === 'offline' || p === 'leave';
    if (away(input.presence) && !away(before.presence) && before.load > 0) {
      const cfg = await this.config();
      if (cfg.onAway === 'queue') {
        // คืนเฉพาะเรื่องที่รอทีม Friday ตอบ · เรื่องที่รอลูกค้า/ทีมพัฒนายังอยู่กับคนเดิม
        const r = await this.db
          .update(s.supportTickets)
          .set({ assigneeId: null, updatedAt: new Date() })
          .where(and(eq(s.supportTickets.assigneeId, staff.id), eq(s.supportTickets.status, 'open')))
          .returning({ id: s.supportTickets.id });
        released = r.length;
      } else if (cfg.onAway === 'ask_lead') {
        leadsNotified = await this.notifyLeads(`[Support] ${staff.name} ${input.presence === 'leave' ? 'ลา' : 'ออฟไลน์'} · มีงานค้าง ${before.load} เรื่อง`, `${staff.name} เปลี่ยนสถานะเป็น${input.presence === 'leave' ? 'ลา' : 'ออฟไลน์'} และยังมีงานค้าง ${before.load} เรื่อง\nตรวจและโอนงานได้ที่หน้า Support`, staff.id);
      }
    }
    await staffAudit(this.db, staff, 'support.presence_changed', `สถานะ ${before.presence} → ${input.presence}${note ? ` · ${note}` : ''}${released ? ` · คืนงานเข้าคิว ${released} เรื่อง` : ''}`, { type: 'staff_user', id: staff.id });
    return { presence: input.presence, note, released, leadsNotified };
  }

  /** อีเมลถึงหัวหน้าทีม (กลุ่ม lead) · ไม่มีหัวหน้าทีม = Owner */
  async notifyLeads(subject: string, text: string, except?: string) {
    let to = (await this.agents()).filter((a) => a.groups.includes('lead') && a.staffId !== except).map((a) => a.email);
    if (!to.length) to = (await this.rows<{ email: string }>(sql`select email from staff_users where status = 'active' and 'owner' = any(roles)`)).map((r) => r.email);
    let n = 0;
    for (const email of to) {
      try {
        await this.mail.send({ to: email, subject, text });
        n++;
      } catch {
        // ส่งไม่ได้ไม่ให้งานหลักล้ม
      }
    }
    return n;
  }

  /**
   * หาคนรับ Ticket ใหม่: กฎแรกที่ตรง → กลุ่ม + ความสำคัญเริ่มต้น → เลือกคนตามวิธีแจก
   * กลุ่มที่ยังไม่มีสมาชิกเลยใช้ทุกคนแทน (ทีมเล็กยังไม่แบ่งกลุ่ม) · acct ไม่มีผู้ดูแลหรือไม่ว่าง = คิวกลาง (T6 "ถ้าไม่อยู่")
   */
  async route(ctx: { plan: string; category: string | null; workspaceId: string | null; priority?: string }): Promise<Route> {
    const [cfg, rules] = await Promise.all([this.config(), this.ruleList()]);
    const rule = rules.find((r) => r.enabled && (!r.plans.length || r.plans.includes(ctx.plan)) && (!r.categories.length || (!!ctx.category && r.categories.includes(ctx.category))));
    const target = rule?.target ?? 'all';
    const priority = ctx.priority ?? rule?.priority ?? 'normal';
    const out = { ruleId: rule?.id ?? null, target, priority, assigneeId: null as string | null };
    if (cfg.mode === 'manual') return out;
    const agents = await this.agents();
    const free = (a: (typeof agents)[number]) => a.load < (a.cap ?? cfg.defaultCap) && (!cfg.skipUnavailable || a.presence === 'online');
    let pool: typeof agents;
    if (target === 'acct') {
      if (!ctx.workspaceId) return out;
      const [m] = await this.db.select({ staffId: s.supportAccountManagers.staffId }).from(s.supportAccountManagers).where(eq(s.supportAccountManagers.workspaceId, ctx.workspaceId));
      pool = agents.filter((a) => a.staffId === m?.staffId);
    } else {
      const members = target === 'all' ? agents : agents.filter((a) => a.groups.includes(target));
      pool = members.length ? members : agents;
    }
    const candidates = pool.filter(free);
    if (!candidates.length) return out;
    if (cfg.mode === 'least') {
      out.assigneeId = [...candidates].sort((a, b) => a.load - b.load || a.name.localeCompare(b.name, 'th'))[0].staffId;
      return out;
    }
    // วนตามลำดับ: คนถัดจากคนล่าสุดที่ได้งาน (เรียงตาม id ให้คงที่) · ล็อกแถวตั้งค่ากันแจกซ้อน
    return this.db.transaction(async (tx) => {
      const [row] = await tx.execute(sql`select round_robin_last from support_settings where id = 1 for update`).then((r) => ((r as unknown as { rows?: Row[] }).rows ?? (r as unknown as Row[])));
      const order = [...candidates].sort((a, b) => a.staffId.localeCompare(b.staffId));
      const last = (row?.round_robin_last as string | null) ?? null;
      const next = order.find((a) => last !== null && a.staffId > last) ?? order[0];
      await tx.insert(s.supportSettings).values({ id: 1, roundRobinLast: next.staffId }).onConflictDoUpdate({ target: s.supportSettings.id, set: { roundRobinLast: next.staffId } });
      return { ...out, assigneeId: next.staffId };
    });
  }

  // ── ข้อความสำเร็จรูป (T4) ────────────────────────────────

  async canned(includeArchived = false) {
    const items = await this.rows(sql`
      select c.id, c.title, c.body, c.tag, c.uses, c.archived_at as "archivedAt", c.updated_at as "updatedAt", st.name as "updatedBy"
      from support_canned_replies c left join staff_users st on st.id = coalesce(c.updated_by, c.created_by)
      where ${includeArchived ? sql`true` : sql`c.archived_at is null`}
      order by c.archived_at nulls first, c.uses desc, c.title`);
    return { items };
  }

  async createCanned(staff: Staff, input: z.infer<typeof CannedBody>) {
    const [r] = await this.db.insert(s.supportCannedReplies).values({ ...input, tag: input.tag || null, createdBy: staff.id }).returning();
    await staffAudit(this.db, staff, 'support.canned_created', `เพิ่มข้อความสำเร็จรูป "${r.title}"`, { type: 'support_canned_reply', id: r.id });
    return { item: r };
  }

  async updateCanned(staff: Staff, id: string, input: z.infer<typeof CannedBody>) {
    await this.findCanned(id);
    const [r] = await this.db.update(s.supportCannedReplies).set({ ...input, tag: input.tag || null, updatedBy: staff.id }).where(eq(s.supportCannedReplies.id, id)).returning();
    await staffAudit(this.db, staff, 'support.canned_updated', `แก้ข้อความสำเร็จรูป "${r.title}"`, { type: 'support_canned_reply', id });
    return { item: r };
  }

  async archiveCanned(staff: Staff, id: string, archived: boolean) {
    const c = await this.findCanned(id);
    if (!!c.archivedAt === archived) return { item: c };
    const [r] = await this.db.update(s.supportCannedReplies).set({ archivedAt: archived ? new Date() : null, updatedBy: staff.id }).where(eq(s.supportCannedReplies.id, id)).returning();
    await staffAudit(this.db, staff, archived ? 'support.canned_archived' : 'support.canned_restored', `${archived ? 'เลิกใช้' : 'กลับมาใช้'}ข้อความสำเร็จรูป "${r.title}"`, { type: 'support_canned_reply', id });
    return { item: r };
  }

  /** นับการใช้ (ตัวเลข "ใช้ 41" ใน T4) · ไม่ลง Audit เพราะไม่ใช่การแก้ · updated_at ขยับตาม (trigger ข้ามเฉพาะ issue_seq) */
  async useCanned(id: string) {
    const c = await this.findCanned(id);
    if (c.archivedAt) throw new AppError(409, 'canned_archived', 'ข้อความนี้เลิกใช้แล้ว');
    const [r] = await this.db.update(s.supportCannedReplies).set({ uses: sql`${s.supportCannedReplies.uses} + 1` }).where(eq(s.supportCannedReplies.id, id)).returning({ uses: s.supportCannedReplies.uses });
    return { uses: r.uses };
  }

  private async findCanned(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบข้อความ');
    const [c] = await this.db.select().from(s.supportCannedReplies).where(eq(s.supportCannedReplies.id, id));
    if (!c) throw new AppError(404, 'not_found', 'ไม่พบข้อความ');
    return c;
  }
}
