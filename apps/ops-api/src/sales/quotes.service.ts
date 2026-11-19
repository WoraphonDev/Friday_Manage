import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { staffAudit } from '../audit.js';
import type { Staff, StaffRole } from '../auth/auth.guard.js';
import { limitsOf } from '../auth/roles.js';
import { BillingService } from '../billing/billing.service.js';
import { addDays, mailAll, todayBkk, vatRegistered } from '../billing/ledger.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PageQuery } from '../paging.js';
import { sqlRows } from '../sql-rows.js';

const s = schema;
const MINUTE = 60_000;
const KEY = 'quotes';
export const SETUP_STEPS = ['contract', 'entitlements', 'sla', 'invoice', 'renewal', 'lead'] as const;
type SetupStep = (typeof SETUP_STEPS)[number];
type StepState = { status: 'done' | 'failed' | 'waiting'; at: string; error?: string };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const QuoteSettings = z
  .object({
    /** ราคาปกติต่อที่นั่งต่อเดือน (สตางค์) · ใช้คิด % ส่วนลด */
    listPerSeatSatang: z.number().int().min(100).max(10_000_000),
    validDays: z.number().int().min(7).max(90),
  })
  .strict();
type QuoteSettings = z.infer<typeof QuoteSettings>;
const DEFAULTS: QuoteSettings = { listPerSeatSatang: 40_000, validDays: 30 };

const Entitlements = z
  .object({ sso: z.boolean().optional(), api_rpm: z.number().int().min(1).max(100_000).nullable().optional(), storage_gb: z.number().int().min(1).max(1_000_000).nullable().optional() })
  .strict();
const Sla = z.object({ first: z.object({ n: z.number().int().min(1).max(72), unit: z.enum(['h', 'd']) }).strict(), resolve: z.object({ n: z.number().int().min(1).max(30), unit: z.enum(['h', 'd']) }).strict() }).strict();
export const QuoteBody = z
  .object({
    /** บัญชีลูกค้าเดิม · หรือ leadId (ไม่มีบัญชี = สร้างบัญชีจากชื่อบริษัทให้) */
    accountId: z.uuid().optional(),
    leadId: z.uuid().optional(),
    seats: z.number().int().min(1).max(100_000),
    months: z.union([z.literal(12), z.literal(24), z.literal(36)]),
    pricePerSeatSatang: z.number().int().min(0).max(10_000_000),
    entitlements: Entitlements.default({}),
    sla: Sla.nullable().default(null),
    contractStart: isoDate.nullable().optional(),
    validUntil: isoDate.optional(),
  })
  .strict()
  .refine((v) => v.accountId || v.leadId, { path: ['accountId'], message: 'เลือกบัญชีลูกค้าหรือ Lead' });
export const QuotesQuery = PageQuery.extend({ tab: z.enum(['draft', 'sent', 'accepted', 'closed']).default('sent'), q: z.string().trim().max(100).optional() });
export const ExtendBody = z.object({ days: z.number().int().min(1).max(60) }).strict();
export const LinkWorkspaceBody = z.object({ workspaceId: z.uuid() }).strict();

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type QuoteRow = typeof s.quotes.$inferSelect;

/** ยอดเงินของใบเสนอราคา · ส่วนลด % เทียบราคาปกติ */
export function priceOf(seats: number, months: number, price: number, list: number) {
  const subtotal = seats * months * price;
  const vat = vatRegistered() ? Math.round(subtotal * 0.07) : 0;
  return { subtotal, vat, total: subtotal + vat, discountPct: list > 0 ? Math.max(0, Math.round((1 - price / list) * 1000) / 10) : 0 };
}

/**
 * ใบเสนอราคาและสัญญา (O55 · เฟส 3) · Owner และการเงิน
 * ส่วนลดเกินวงเงินของคนทำ → ขออนุมัติ (ชนิด quote.discount) ก่อนส่ง · ส่งแล้วลูกค้าเปิดลิงก์ / ตอบรับเองที่ API ลูกค้า
 * ตอบรับแล้วงานทุกนาทีทำขั้นตั้งค่าให้: สัญญาในบัญชีลูกค้า → สิทธิ์ตามสัญญา → SLA → ใบแจ้งหนี้ → เตือนต่อสัญญา → Lead ชนะ (ล้มขั้นไหนลองใหม่ได้)
 */
@Injectable()
export class QuotesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsQuotes');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly billing: BillingService,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    this.approvals.register('quote.discount', (p, ctx) => this.approve(p.quoteId as string, ctx));
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), MINUTE);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private rows<T>(q: SQL, db: Db | Tx = this.db) {
    return sqlRows<T>(db, q);
  }

  async settings(): Promise<QuoteSettings> {
    const [r] = await this.db.select({ value: s.opsSettings.value }).from(s.opsSettings).where(eq(s.opsSettings.key, KEY));
    const ok = QuoteSettings.safeParse({ ...DEFAULTS, ...((r?.value ?? {}) as object) });
    return ok.success ? ok.data : DEFAULTS;
  }
  async saveSettings(staff: Staff, input: QuoteSettings) {
    await this.db.insert(s.opsSettings).values({ key: KEY, value: input, updatedBy: staff.id }).onConflictDoUpdate({ target: s.opsSettings.key, set: { value: input, updatedBy: staff.id, updatedAt: new Date() } });
    await staffAudit(this.db, staff, 'quotes.settings_updated', `ราคาปกติ ${input.listPerSeatSatang / 100} บาท/ที่นั่ง/เดือน · ใช้ได้ ${input.validDays} วัน`);
    return input;
  }

  /** งานทุกนาที: หมดอายุ · ทำขั้นตั้งค่าของใบที่ตอบรับแล้วแต่ยังไม่ครบ */
  async tick(today = todayBkk()) {
    const expired = await this.db.update(s.quotes).set({ status: 'expired' }).where(and(eq(s.quotes.status, 'sent'), sql`${s.quotes.validUntil} < ${today}::date`)).returning({ id: s.quotes.id });
    const pending = await this.rows<{ id: string }>(sql`
      select id from quotes where status = 'accepted'
        and exists (select 1 from unnest(array[${sql.raw(SETUP_STEPS.map((x) => `'${x}'`).join(', '))}]) k where coalesce(setup->k->>'status', '') <> 'done')
        and coalesce((select max((v->>'at')::timestamptz) from jsonb_each(setup) e(k, v) where v->>'status' = 'failed'), 'epoch') < now() - interval '10 minutes'`);
    for (const q of pending) await this.setup(q.id).catch((e) => this.log.error(String(e)));
    return { expired: expired.length, setup: pending.length };
  }

  // ---------------------------------------------------------------- ร่าง / แก้

  private async nextNumber(tx: Tx, date = todayBkk()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('quote-number', 0))`);
    const prefix = `QT-${date.slice(2, 4)}${date.slice(5, 7)}-`;
    const [row] = await this.rows<{ n: number }>(sql`select coalesce(max(substring(number from ${sql.raw(String(prefix.length + 1))})::int), 0) as n from quotes where number like ${`${prefix}%`}`, tx);
    return `${prefix}${String(Number(row?.n ?? 0) + 1).padStart(4, '0')}`;
  }

  /** บัญชีลูกค้าของใบเสนอราคา · มาจาก Lead ที่ยังไม่มีบัญชี = สร้างให้แล้วผูก Lead */
  private async accountFor(tx: Tx, staff: Staff, input: { accountId?: string; leadId?: string }) {
    if (input.accountId) {
      const [a] = await tx.select({ id: s.customerAccounts.id }).from(s.customerAccounts).where(eq(s.customerAccounts.id, input.accountId));
      if (!a) throw new AppError(404, 'not_found', 'ไม่พบบัญชีลูกค้า');
      return a.id;
    }
    const [lead] = await tx.select().from(s.leads).where(eq(s.leads.id, input.leadId!));
    if (!lead) throw new AppError(404, 'not_found', 'ไม่พบ Lead');
    if (lead.accountId) return lead.accountId;
    const [a] = await tx
      .insert(s.customerAccounts)
      .values({ name: lead.company, kind: 'standard', managerId: lead.ownerId ?? staff.id, createdBy: staff.id, contacts: lead.email ? [{ name: lead.contactName ?? '', email: lead.email, phone: lead.phone ?? '', role: 'signer' }] : [] })
      .returning({ id: s.customerAccounts.id });
    await tx.update(s.leads).set({ accountId: a.id }).where(eq(s.leads.id, lead.id));
    if (lead.workspaceId) await tx.insert(s.customerAccountWorkspaces).values({ workspaceId: lead.workspaceId, accountId: a.id, addedBy: staff.id }).onConflictDoNothing();
    await staffAudit(tx, staff, 'account.created', `${lead.company} (จาก Lead #${lead.number})`, { type: 'customer_account', id: a.id });
    return a.id;
  }

  private async values(input: z.infer<typeof QuoteBody>) {
    const cfg = await this.settings();
    const p = priceOf(input.seats, input.months, input.pricePerSeatSatang, cfg.listPerSeatSatang);
    return {
      seats: input.seats, months: input.months, pricePerSeatSatang: input.pricePerSeatSatang, listPerSeatSatang: cfg.listPerSeatSatang,
      subtotalSatang: p.subtotal, vatSatang: p.vat, totalSatang: p.total, entitlements: input.entitlements, sla: input.sla,
      contractStart: input.contractStart ?? null, validUntil: input.validUntil ?? addDays(todayBkk(), cfg.validDays),
    };
  }

  async create(staff: Staff, input: z.infer<typeof QuoteBody>) {
    const v = await this.values(input);
    const id = await this.db.transaction(async (tx) => {
      const accountId = await this.accountFor(tx, staff, input);
      const [lead] = input.leadId ? [{ id: input.leadId }] : await tx.select({ id: s.leads.id }).from(s.leads).where(and(eq(s.leads.accountId, accountId), sql`${s.leads.stage} not in ('won', 'lost')`)).limit(1);
      const [ws] = await tx.select({ id: s.customerAccountWorkspaces.workspaceId }).from(s.customerAccountWorkspaces).where(eq(s.customerAccountWorkspaces.accountId, accountId)).limit(1);
      const [row] = await tx
        .insert(s.quotes)
        .values({ ...v, number: await this.nextNumber(tx), accountId, leadId: lead?.id ?? null, workspaceId: ws?.id ?? null, createdBy: staff.id })
        .returning({ id: s.quotes.id, number: s.quotes.number });
      if (lead) await tx.update(s.leads).set({ stage: 'proposal' }).where(and(eq(s.leads.id, lead.id), sql`${s.leads.stage} in ('new', 'contacted', 'demo')`));
      await staffAudit(tx, staff, 'quotes.created', `${row.number} · ${v.seats} ที่นั่ง ${v.months} เดือน`, { type: 'quote', id: row.id });
      return row.id;
    });
    return this.detail(id);
  }

  /** แก้ได้เฉพาะร่าง · เปลี่ยนราคา / ที่นั่ง / ระยะสัญญาหลังอนุมัติแล้วต้องขอใหม่ */
  async update(staff: Staff, id: string, input: z.infer<typeof QuoteBody>) {
    const q = await this.quote(id);
    if (q.status !== 'draft') throw new AppError(409, 'quote_not_draft', 'แก้ได้เฉพาะใบที่ยังเป็นร่าง · ทำสำเนาเพื่อแก้');
    const v = await this.values(input);
    const repriced = v.pricePerSeatSatang !== q.pricePerSeatSatang || v.seats !== q.seats || v.months !== q.months;
    await this.db.update(s.quotes).set({ ...v, ...(repriced ? { approvedAt: null, approvedBy: null, approvalRequestId: null } : {}) }).where(eq(s.quotes.id, id));
    await staffAudit(this.db, staff, 'quotes.updated', `${q.number}${repriced && q.approvedAt ? ' · แก้ราคาหลังอนุมัติ ต้องขอใหม่' : ''}`, { type: 'quote', id });
    return this.detail(id);
  }

  /** ทำสำเนาเป็นร่างใหม่ (ใบที่หมดอายุ / ถูกปฏิเสธ) */
  async copy(staff: Staff, id: string) {
    const q = await this.quote(id);
    return this.create(staff, { accountId: q.accountId, leadId: q.leadId ?? undefined, seats: q.seats, months: q.months as 12 | 24 | 36, pricePerSeatSatang: q.pricePerSeatSatang, entitlements: q.entitlements as z.infer<typeof Entitlements>, sla: (q.sla as z.infer<typeof Sla> | null) ?? null, contractStart: null });
  }

  async extend(staff: Staff, id: string, days: number) {
    const q = await this.quote(id);
    if (q.status !== 'sent' && q.status !== 'expired') throw new AppError(409, 'quote_not_sent', 'ต่ออายุได้เฉพาะใบที่ส่งแล้ว');
    const until = addDays(q.validUntil > todayBkk() ? q.validUntil : todayBkk(), days);
    await this.db.update(s.quotes).set({ validUntil: until, status: 'sent' }).where(eq(s.quotes.id, id));
    await staffAudit(this.db, staff, 'quotes.extended', `${q.number} ใช้ได้ถึง ${until}`, { type: 'quote', id });
    return this.detail(id);
  }

  // ---------------------------------------------------------------- ส่ง

  /** ส่วนลดเกินวงเงิน (limits.discountPct ของคนทำ) และยังไม่อนุมัติ → สร้างคำขออนุมัติ (202) · ผ่านแล้วสร้างลิงก์ใหม่และอีเมลผู้ลงนาม */
  async send(staff: Staff, id: string) {
    const q = await this.quote(id);
    if (q.status !== 'draft' && q.status !== 'sent') throw new AppError(409, 'quote_not_draft', 'ส่งได้เฉพาะร่างหรือใบที่ส่งแล้ว (ส่งลิงก์ใหม่)');
    const { discountPct } = priceOf(q.seats, q.months, q.pricePerSeatSatang, q.listPerSeatSatang);
    if (!q.approvedAt && discountPct > staff.limits.discountPct) {
      const pending = await this.approvals.gate(staff, {
        kind: 'quote.discount', target: { type: 'quote', id }, payload: { quoteId: id }, reason: `${q.number} ส่วนลด ${discountPct}%`,
        amountSatang: q.totalSatang, exceeds: true, rule: `ส่วนลด ${discountPct}% เกินวงเงิน ${staff.limits.discountPct}% ของ ${staff.name}`,
      });
      if (pending) {
        await this.db.update(s.quotes).set({ approvalRequestId: pending.id }).where(eq(s.quotes.id, id));
        return { pendingApproval: pending };
      }
    }
    const token = randomBytes(24).toString('base64url');
    const link = `${config.appUrl}/quote/${token}`;
    await this.db.update(s.quotes).set({ status: 'sent', tokenHash: hash(token), sentAt: new Date() }).where(eq(s.quotes.id, id));
    const to = await this.signers(q.accountId);
    const [acct] = await this.db.select({ name: s.customerAccounts.name }).from(s.customerAccounts).where(eq(s.customerAccounts.id, q.accountId));
    const sent = await mailAll(this.mail, to, `ใบเสนอราคา ${q.number} จาก Friday Work Management`, `เรียน ${acct?.name ?? ''}\n\nใบเสนอราคา ${q.number} สำหรับ ${q.seats} ที่นั่ง ${q.months} เดือน ยอดรวม ${(q.totalSatang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 })} บาท ใช้ได้ถึง ${q.validUntil}\nดูรายละเอียดและตอบรับ: ${link}`);
    await staffAudit(this.db, staff, 'quotes.sent', `${q.number} · อีเมล ${sent}/${to.length}`, { type: 'quote', id });
    return { ...(await this.detail(id)), link, emailed: sent };
  }

  private async signers(accountId: string) {
    const [a] = await this.db.select({ contacts: s.customerAccounts.contacts }).from(s.customerAccounts).where(eq(s.customerAccounts.id, accountId));
    const contacts = ((a?.contacts ?? []) as { email?: string; role?: string }[]).filter((c) => c.email);
    const signer = contacts.filter((c) => c.role === 'signer');
    return [...new Set((signer.length ? signer : contacts).map((c) => c.email!.toLowerCase()))];
  }

  /** อนุมัติส่วนลดแล้ว · ส่งจริงยังเป็นปุ่มของคนทำ (เห็นลิงก์และผลอีเมล) */
  private async approve(quoteId: string, ctx: ApprovalContext) {
    await this.db.update(s.quotes).set({ approvedAt: new Date(), approvedBy: ctx.approver.id, approvalRequestId: ctx.requestId }).where(eq(s.quotes.id, quoteId));
    await staffAudit(this.db, ctx.requester, 'quotes.discount_approved', quoteId, { type: 'quote', id: quoteId }, undefined, { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved });
    return { id: quoteId };
  }

  // ---------------------------------------------------------------- หลังตอบรับ

  async linkWorkspace(staff: Staff, id: string, workspaceId: string) {
    const q = await this.quote(id);
    await this.db.transaction(async (tx) => {
      await tx.update(s.quotes).set({ workspaceId }).where(eq(s.quotes.id, id));
      await tx.insert(s.customerAccountWorkspaces).values({ workspaceId, accountId: q.accountId, addedBy: staff.id }).onConflictDoNothing();
    });
    await staffAudit(this.db, staff, 'quotes.workspace_linked', q.number, { type: 'quote', id }, workspaceId);
    if (q.status === 'accepted') await this.setup(id);
    return this.detail(id);
  }

  /** พนักงานที่ทำรายการแทน (ผู้สร้างใบ) · ใช้กับใบแจ้งหนี้และ Audit */
  private async actor(q: QuoteRow): Promise<Staff> {
    const [r] = q.createdBy ? await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, q.createdBy)) : [];
    if (!r) throw new AppError(409, 'creator_missing', 'ไม่พบพนักงานที่สร้างใบเสนอราคา');
    return { id: r.id, email: r.email, name: r.name, roles: r.roles as StaffRole[], elevated: [], department: r.department, limits: limitsOf(r.limits) };
  }

  /** ทำขั้นที่ยังไม่เสร็จ · ขั้นที่ต้องใช้ Workspace รอจนกว่าจะผูก · ล้มแล้วเก็บข้อความ ลองใหม่ได้ */
  async setup(id: string, today = todayBkk()) {
    const q = await this.quote(id);
    if (q.status !== 'accepted') throw new AppError(409, 'quote_not_accepted', 'ลูกค้ายังไม่ได้ตอบรับ');
    const state = { ...(q.setup as Partial<Record<SetupStep, StepState>>) };
    const staff = await this.actor(q);
    // วันเริ่มสัญญา = ที่ระบุในใบ · ไม่ระบุ = วันที่ลูกค้าตอบรับ (เวลาไทย) ให้รันซ้ำวันอื่นได้ค่าเดิม
    const start = q.contractStart ?? (q.acceptedAt ? new Date(q.acceptedAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 10) : today);
    const contractEnd = (() => {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + q.months);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const workspaces = await this.db.select({ id: s.customerAccountWorkspaces.workspaceId }).from(s.customerAccountWorkspaces).where(eq(s.customerAccountWorkspaces.accountId, q.accountId));
    const wsIds = [...new Set([...(q.workspaceId ? [q.workspaceId] : []), ...workspaces.map((w) => w.id)])];
    const run = async (step: SetupStep, fn: () => Promise<'done' | 'waiting'>, waitMsg = 'รอผูก Workspace ของลูกค้า') => {
      if (state[step]?.status === 'done') return;
      try {
        const r = await fn();
        state[step] = { status: r, at: new Date().toISOString(), ...(r === 'waiting' ? { error: waitMsg } : {}) };
      } catch (e) {
        state[step] = { status: 'failed', at: new Date().toISOString(), error: (e as Error).message.slice(0, 300) };
      }
    };
    await run('contract', async () => {
      await this.db
        .update(s.customerAccounts)
        .set({ kind: 'enterprise', contractStart: start, contractEnd, contractValue: Math.round(q.subtotalSatang / (q.months / 12)), contractSeats: q.seats, contractSla: q.sla, renewalReminded: null })
        .where(eq(s.customerAccounts.id, q.accountId));
      await staffAudit(this.db, staff, 'account.contract', `${q.number} · ${start} – ${contractEnd} · ${q.seats} ที่นั่ง`, { type: 'customer_account', id: q.accountId });
      return 'done';
    });
    await run('entitlements', async () => {
      if (!wsIds.length) return 'waiting';
      const ent = { ...(q.entitlements as Record<string, unknown>), seats: q.seats };
      for (const ws of wsIds) {
        for (const [key, value] of Object.entries(ent)) {
          if (value === undefined) continue;
          await this.db.transaction(async (tx) => {
            await tx.update(s.entitlementOverrides).set({ revokedAt: new Date(), revokedBy: staff.id, revokeReason: `แทนด้วยสัญญา ${q.number}` }).where(and(eq(s.entitlementOverrides.workspaceId, ws), eq(s.entitlementOverrides.key, key), isNull(s.entitlementOverrides.revokedAt)));
            await tx.insert(s.entitlementOverrides).values({ workspaceId: ws, key, value: value as never, contractRef: q.number, reason: `สิทธิ์ตามสัญญา ${q.number}`, createdBy: staff.id, approvedBy: q.approvedBy });
          });
        }
        await staffAudit(this.db, staff, 'entitlements.override', `สิทธิ์ตามสัญญา ${q.number}: ${Object.keys(ent).join(', ')}`, { type: 'quote', id }, ws);
      }
      return 'done';
    });
    // SLA ตามสัญญาบันทึกในบัญชีลูกค้า (contract_sla) พร้อมขั้นสัญญา · Ticket ใหม่ใช้ค่านี้แทนของแพ็กเกจ
    await run('sla', async () => (state.contract?.status === 'done' ? 'done' : 'waiting'), 'รอบันทึกสัญญา');
    await run('invoice', async () => {
      if (!wsIds.length) return 'waiting';
      const acc = q.acceptance as { po?: string } | null;
      await this.billing.createInvoice(staff, {
        workspaceId: wsIds[0], poNumber: acc?.po || undefined, dueDays: 30, discountPct: 0, wht: false, send: true,
        items: [{ description: `Friday Work Management Enterprise ${q.months} เดือน · ${q.seats} ที่นั่ง (${q.number})`, qty: q.seats * q.months, unitSatang: q.pricePerSeatSatang }],
        plan: { code: 'enterprise', cycle: 'yearly', periodStart: start, periodEnd: contractEnd },
        note: `ตามใบเสนอราคา ${q.number}`,
      });
      return 'done';
    });
    // เตือนต่อสัญญา 90 / 60 / 30 วัน: ขั้นสัญญาล้าง renewal_reminded แล้ว งานเตือนของหน้าวันต่อสัญญาทำต่อเอง
    await run('renewal', async () => (state.contract?.status === 'done' ? 'done' : 'waiting'), 'รอบันทึกสัญญา');
    await run('lead', async () => {
      if (q.leadId) await this.db.update(s.leads).set({ stage: 'won', closedAt: new Date(), lostReason: null }).where(and(eq(s.leads.id, q.leadId), sql`${s.leads.stage} <> 'won'`));
      return 'done';
    });
    await this.db.update(s.quotes).set({ setup: state }).where(eq(s.quotes.id, id));
    return this.detail(id);
  }

  // ---------------------------------------------------------------- หน้าจอ

  private async quote(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบใบเสนอราคา');
    const [q] = await this.db.select().from(s.quotes).where(eq(s.quotes.id, id));
    if (!q) throw new AppError(404, 'not_found', 'ไม่พบใบเสนอราคา');
    return q;
  }

  private readonly COLS = sql`q.id, q.number, q.status, q.seats, q.months, q.price_per_seat_satang::float8 as "pricePerSeatSatang", q.list_per_seat_satang::float8 as "listPerSeatSatang",
    q.subtotal_satang::float8 as "subtotalSatang", q.vat_satang::float8 as "vatSatang", q.total_satang::float8 as "totalSatang", q.entitlements, q.sla,
    to_char(q.contract_start, 'YYYY-MM-DD') as "contractStart", to_char(q.valid_until, 'YYYY-MM-DD') as "validUntil", q.approved_at as "approvedAt", ap.name as "approvedBy",
    q.approval_request_id as "approvalRequestId", (select r.status from approval_requests r where r.id = q.approval_request_id) as "approvalStatus",
    q.sent_at as "sentAt", q.view_count as "viewCount", q.last_viewed_at as "lastViewedAt", q.accepted_at as "acceptedAt", q.acceptance, q.change_request as "changeRequest", q.setup,
    q.account_id as "accountId", a.name as company, q.lead_id as "leadId", q.workspace_id as "workspaceId", w.name as "workspaceName", st.name as "createdBy", q.created_at as "createdAt"`;
  private readonly FROM = sql`from quotes q join customer_accounts a on a.id = q.account_id left join staff_users st on st.id = q.created_by left join staff_users ap on ap.id = q.approved_by left join workspaces w on w.id = q.workspace_id`;

  private shape<T extends { listPerSeatSatang: number; pricePerSeatSatang: number; seats: number; months: number }>(r: T) {
    return { ...r, discountPct: priceOf(r.seats, r.months, r.pricePerSeatSatang, r.listPerSeatSatang).discountPct };
  }

  async detail(id: string) {
    const [r] = await this.rows<Record<string, unknown> & { listPerSeatSatang: number; pricePerSeatSatang: number; seats: number; months: number }>(sql`select ${this.COLS} ${this.FROM} where q.id = ${id}`);
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบใบเสนอราคา');
    return this.shape(r);
  }

  async summary(staff: Staff, today = todayBkk()) {
    const [n] = await this.rows<{ sent: number; sentValue: number; accepted90: number; contracts: number }>(sql`
      select count(*) filter (where status = 'sent')::int as sent, coalesce(sum(total_satang) filter (where status = 'sent'), 0)::float8 as "sentValue",
        count(*) filter (where status = 'accepted' and accepted_at > now() - interval '90 days')::int as accepted90,
        (select count(*)::int from customer_accounts where contract_end >= ${today}::date) as contracts
      from quotes`);
    const todo = await this.rows<Record<string, unknown> & { listPerSeatSatang: number; pricePerSeatSatang: number; seats: number; months: number }>(sql`
      select ${this.COLS}, case when q.status = 'draft' then 'approval' when q.status = 'accepted' then 'setup' else 'expiring' end as reason ${this.FROM}
      where (q.status = 'draft' and exists (select 1 from approval_requests r where r.id = q.approval_request_id and r.status = 'pending'))
         or (q.status = 'sent' and q.valid_until <= ${today}::date + 3)
         or (q.status = 'accepted' and exists (select 1 from jsonb_each(q.setup) e(k, v) where v->>'status' in ('failed', 'waiting')))
      order by q.valid_until limit 50`);
    const tabs = await this.rows<{ tab: string; n: number }>(sql`select case when status in ('declined', 'expired') then 'closed' else status end as tab, count(*)::int as n from quotes group by 1`);
    return {
      sent: n.sent, sentValueSatang: n.sentValue, accepted90: n.accepted90, contracts: n.contracts,
      todo: todo.map((x) => this.shape(x)), canApprove: staff.roles.includes('owner'),
      tabs: Object.fromEntries(['draft', 'sent', 'accepted', 'closed'].map((t) => [t, tabs.find((x) => x.tab === t)?.n ?? 0])),
    };
  }

  async list(q: z.infer<typeof QuotesQuery>) {
    const w: SQL[] = [q.tab === 'closed' ? sql`q.status in ('declined', 'expired')` : sql`q.status = ${q.tab}`];
    if (q.q) {
      const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      w.push(sql`(lower(q.number) like ${like} or lower(a.name) like ${like})`);
    }
    const cond = sql.join(w, sql` and `);
    const items = await this.rows<Record<string, unknown> & { listPerSeatSatang: number; pricePerSeatSatang: number; seats: number; months: number }>(sql`
      select ${this.COLS} ${this.FROM} where ${cond} order by ${q.tab === 'sent' ? sql`q.valid_until` : sql`q.created_at desc`} limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from quotes q join customer_accounts a on a.id = q.account_id where ${cond}`);
    return { items: items.map((x) => this.shape(x)), total: n };
  }
}
