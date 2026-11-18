import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Logger, Module, type OnModuleDestroy, type OnModuleInit, Param, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Db } from '@friday/db';
import { sql, type SQL } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { has, type OpsRequest, Roles, type Staff } from '../auth/auth.guard.js';
import { todayBkk } from '../billing/ledger.js';
import { OPS_DB } from '../db.js';
import { AppError, parse } from '../errors.js';
import { Mailer } from '../mail.js';
import { PlanSla } from '../support/settings.service.js';
import { CustomersService, seesMoney } from '../workspaces/customers.service.js';
import { isReal } from '../workspaces/test-flag.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';

/**
 * บัญชีลูกค้าระดับบริษัท (ช่วง 3) · รวม Workspace ของผู้ซื้อเดียวกันและบริษัทในเครือ
 * ระบบเสนอจากเลขภาษีเดียวกันที่มีตั้งแต่ 2 Workspace · คนยืนยัน (ระบบไม่สร้างเอง เหมือนป้ายทดสอบ)
 * สิทธิ์: ทุกคนอ่านได้ (Support / วิศวกรไม่เห็นยอดเงิน) · สร้างและผูก Workspace: Owner, Support · สัญญาและมูลค่า: Owner, การเงิน
 */
export const RENEWAL_STEPS = [90, 60, 30] as const;
const MAX_PDF = 10 * 1024 * 1024;
const W = sql`w.id`;
const TaxId = z.string().trim().regex(/^\d{13}$/, 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
const Contact = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email().trim().toLowerCase().optional().or(z.literal('')),
    phone: z.string().trim().max(40).optional(),
    role: z.enum(['signer', 'billing', 'it', 'other']),
  })
  .strict();
export const AccountsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  manager: z.union([z.uuid(), z.literal('none')]).optional(),
  kind: z.enum(['standard', 'enterprise']).optional(),
  health: z.enum(['low']).optional(),
  renew: z.coerce.number().pipe(z.union([z.literal(30), z.literal(60), z.literal(90)])).optional(),
  overdue: z.enum(['yes']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const CreateAccountBody = z
  .object({
    name: z.string().trim().min(2).max(160),
    taxIds: z.array(TaxId).max(20).default([]),
    managerId: z.uuid().nullable().optional(),
    kind: z.enum(['standard', 'enterprise']).default('standard'),
    workspaceIds: z.array(z.uuid()).min(1).max(500),
  })
  .strict();
export const UpdateAccountBody = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    taxIds: z.array(TaxId).max(20).optional(),
    managerId: z.uuid().nullable().optional(),
    kind: z.enum(['standard', 'enterprise']).optional(),
    contacts: z.array(Contact).max(30).optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();
export const ContractBody = z
  .object({
    start: z.iso.date().nullable(),
    end: z.iso.date().nullable(),
    /** สตางค์ต่อปี */
    value: z.number().int().min(0).max(1e13).nullable(),
    seats: z.number().int().min(1).max(100_000).nullable(),
    /** null = ใช้ SLA ของแพ็กเกจ */
    sla: PlanSla.nullable(),
  })
  .strict()
  .refine((b) => !b.start || !b.end || b.end >= b.start, { message: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม', path: ['end'] });
export const LinkBody = z.object({ workspaceIds: z.array(z.uuid()).min(1).max(500) }).strict();
export const RenewalsQuery = z.object({
  within: z.coerce.number().pipe(z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180), z.literal(365)])).default(90),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type Row = Record<string, unknown>;
interface AccountRow {
  id: string;
  name: string;
  taxIds: string[];
  kind: string;
  managerId: string | null;
  managerName: string | null;
  contacts: unknown;
  notes: string | null;
  contractStart: string | null;
  contractEnd: string | null;
  contractValue: number | null;
  contractSeats: number | null;
  contractSla: unknown;
  createdAt: string;
  updatedAt: string;
  workspaceIds: string[];
  overdueSatang: number;
  lastContactAt: string | null;
  file: unknown;
}
const ids = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
const textArr = (xs: string[]) => sql`array[${xs.length ? ids(xs) : sql``}]::text[]`;

@Injectable()
export class AccountsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsAccounts');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly customers: CustomersService,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    // เตือนผู้ดูแลก่อนหมดสัญญา 90 / 60 / 30 วัน · ทุก 6 ชั่วโมง (ทำซ้ำได้ เพราะจำว่าเตือนขั้นไหนไปแล้ว) · test เรียกเอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.remindRenewals().catch((e) => this.log.error(String(e))), 6 * 3_600_000);
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

  private async base(where: SQL) {
    return this.rows<AccountRow>(sql`
      select a.id, a.name, a.tax_ids as "taxIds", a.kind, a.manager_id as "managerId", st.name as "managerName",
        a.contacts, a.notes, a.contract_start as "contractStart", a.contract_end as "contractEnd", a.contract_value::float8 as "contractValue",
        a.contract_seats as "contractSeats", a.contract_sla as "contractSla", a.created_at as "createdAt", a.updated_at as "updatedAt",
        (select coalesce(array_agg(aw.workspace_id), '{}') from customer_account_workspaces aw join workspaces w on w.id = aw.workspace_id where aw.account_id = a.id and w.deleted_at is null) as "workspaceIds",
        (select coalesce(sum(i.amount_due), 0)::float8 from invoices i join customer_account_workspaces aw on aw.workspace_id = i.workspace_id
          where aw.account_id = a.id and i.status in ('open', 'pending_review') and i.due_date < current_date) as "overdueSatang",
        (select max(m.created_at) from support_ticket_messages m join support_tickets k on k.id = m.ticket_id join customer_account_workspaces aw on aw.workspace_id = k.workspace_id
          where aw.account_id = a.id and m.author_kind = 'staff' and not m.internal) as "lastContactAt",
        (select json_build_object('name', f.name, 'size', f.size, 'at', f.created_at) from customer_account_files f where f.account_id = a.id) as file
      from customer_accounts a left join staff_users st on st.id = a.manager_id
      where ${where}`);
  }

  /** รวมตัวเลขของทุก Workspace ในบัญชี · สุขภาพต่ำสุด = ตัวที่ต้องดูก่อน */
  private async withNumbers(staff: Staff, list: AccountRow[]) {
    const all = [...new Set(list.flatMap((a) => a.workspaceIds))];
    const snap = new Map((await this.customers.snapshot(staff, all)).map((x) => [x.id, x]));
    const money = seesMoney(staff);
    return list.map((a) => {
      const ws = a.workspaceIds.map((id) => snap.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
      const worst = ws.reduce<(typeof ws)[number] | null>((m, x) => (!m || x.health < m.health ? x : m), null);
      const { workspaceIds: _ids, contractValue, overdueSatang, contractSla, ...rest } = a;
      void _ids;
      return {
        ...rest,
        contractSla: contractSla ?? null,
        contractValue: money ? (contractValue ?? null) : null,
        numbers: {
          workspaces: ws.length,
          seats: ws.reduce((n, x) => n + x.seats, 0),
          seatLimit: ws.reduce((n, x) => n + (x.seatLimit ?? 0), 0),
          mrr: money ? ws.reduce((n, x) => n + x._mrr, 0) : null,
          minHealth: worst ? { score: worst.health, workspace: { id: worst.id, name: worst.name } } : null,
          openTickets: ws.reduce((n, x) => n + x.openTickets, 0),
          overdue: money ? Number(overdueSatang ?? 0) : null,
          overdueAny: Number(overdueSatang ?? 0) > 0,
          active30: ws.reduce((n, x) => n + x.active30, 0),
        },
      };
    });
  }

  private filters(q: z.infer<typeof AccountsQuery>) {
    const parts: SQL[] = [sql`true`];
    if (q.q) parts.push(sql`(a.name ilike ${`%${q.q}%`} or ${q.q.replace(/\D/g, '') || '-'} = any(a.tax_ids) or exists(select 1 from customer_account_workspaces aw join workspaces w on w.id = aw.workspace_id where aw.account_id = a.id and (w.name ilike ${`%${q.q}%`} or w.slug ilike ${`%${q.q}%`})))`);
    if (q.manager) parts.push(q.manager === 'none' ? sql`a.manager_id is null` : sql`a.manager_id = ${q.manager}`);
    if (q.kind) parts.push(sql`a.kind = ${q.kind}`);
    if (q.renew) parts.push(sql`a.contract_end between ${todayBkk()}::date and ${todayBkk()}::date + ${q.renew}::int`);
    if (q.overdue) parts.push(sql`exists(select 1 from invoices i join customer_account_workspaces aw on aw.workspace_id = i.workspace_id where aw.account_id = a.id and i.status in ('open', 'pending_review') and i.due_date < current_date)`);
    return sql.join(parts, sql` and `);
  }

  async list(staff: Staff, q: z.infer<typeof AccountsQuery>) {
    const where = this.filters(q);
    if (q.health) {
      // สุขภาพคำนวณในโค้ด: ดึงทั้งชุดที่ผ่านเงื่อนไขอื่นก่อน (จำนวนบัญชีน้อยกว่า Workspace มาก)
      const all = (await this.withNumbers(staff, await this.base(sql`${where} order by a.name`))).filter((a) => (a.numbers.minHealth?.score ?? 100) < 40);
      return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, limit: q.limit, offset: q.offset };
    }
    const page = await this.base(sql`${where} order by a.name, a.id limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from customer_accounts a where ${where}`);
    return { items: await this.withNumbers(staff, page), total: n, limit: q.limit, offset: q.offset };
  }

  async get(staff: Staff, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบบัญชีลูกค้า');
    const [a] = await this.withNumbers(staff, await this.base(sql`a.id = ${id}`));
    if (!a) throw new AppError(404, 'not_found', 'ไม่พบบัญชีลูกค้า');
    return { ...a, can: { edit: has(staff, 'owner', 'support'), contract: has(staff, 'owner', 'finance'), remove: has(staff, 'owner') } };
  }

  /** ผู้ซื้อ (เลขภาษีเดียวกัน) ที่มีตั้งแต่ 2 Workspace และยังไม่อยู่ในบัญชีใด · ระบบเสนอ คนยืนยัน */
  async suggestions(limit = 50) {
    const rows = await this.rows<Row>(sql`
      select trim(bp.tax_id) as "taxId", max(nullif(trim(bp.company_name), '')) as name, count(*)::int as count,
        json_agg(json_build_object('id', w.id, 'name', w.name, 'slug', w.slug) order by w.created_at) as workspaces
      from workspaces w join billing_profiles bp on bp.workspace_id = w.id
      where w.deleted_at is null and ${isReal(W)} and nullif(trim(bp.tax_id), '') is not null
        and not exists(select 1 from customer_account_workspaces aw where aw.workspace_id = w.id)
      group by trim(bp.tax_id) having count(*) >= 2
      order by count(*) desc, max(nullif(trim(bp.company_name), '')) limit ${limit}`);
    return { items: rows.map((r) => ({ ...r, key: `t:${r.taxId}` })) };
  }

  /** Workspace ที่อยู่บัญชีอื่นแล้วย้ายไม่ได้เงียบ ๆ (ต้องเอาออกจากบัญชีเดิมก่อน) */
  private async assertFree(workspaceIds: string[], except?: string) {
    const taken = await this.rows<{ id: string; name: string; account: string }>(sql`
      select w.id, w.name, a.name as account from customer_account_workspaces aw join workspaces w on w.id = aw.workspace_id join customer_accounts a on a.id = aw.account_id
      where aw.workspace_id in (${ids(workspaceIds)}) ${except ? sql`and aw.account_id <> ${except}` : sql``}`);
    if (taken.length) throw new AppError(409, 'workspace_in_account', `${taken.map((x) => `${x.name} อยู่ในบัญชี ${x.account}`).join(' · ')} · เอาออกจากบัญชีเดิมก่อน`, { workspaces: taken });
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from workspaces where id in (${ids(workspaceIds)}) and deleted_at is null`);
    if (n !== new Set(workspaceIds).size) throw new AppError(404, 'workspace_not_found', 'ไม่พบ Workspace บางรายการ');
  }

  async create(staff: Staff, input: z.infer<typeof CreateAccountBody>) {
    await this.assertFree(input.workspaceIds);
    const id = await this.db.transaction(async (tx) => {
      const r = await tx.execute(sql`
        insert into customer_accounts (name, tax_ids, manager_id, kind, created_by)
        values (${input.name}, ${textArr([...new Set(input.taxIds)])}, ${input.managerId ?? null}, ${input.kind}, ${staff.id}) returning id`);
      const [a] = ((r as unknown as { rows?: { id: string }[] }).rows ?? (r as unknown as { id: string }[]));
      await tx.execute(sql`insert into customer_account_workspaces (workspace_id, account_id, added_by) select x, ${a.id}::uuid, ${staff.id}::uuid from unnest(array[${ids(input.workspaceIds)}]::uuid[]) x on conflict do nothing`);
      return a.id;
    });
    await staffAudit(this.db, staff, 'account.created', `สร้างบัญชีลูกค้า "${input.name}" รวม ${input.workspaceIds.length} Workspace`, { type: 'customer_account', id });
    return this.get(staff, id);
  }

  async update(staff: Staff, id: string, input: z.infer<typeof UpdateAccountBody>) {
    const before = await this.get(staff, id);
    const set: SQL[] = [];
    if (input.name !== undefined) set.push(sql`name = ${input.name}`);
    if (input.taxIds !== undefined) set.push(sql`tax_ids = ${textArr([...new Set(input.taxIds)])}`);
    if (input.managerId !== undefined) set.push(sql`manager_id = ${input.managerId}`);
    if (input.kind !== undefined) set.push(sql`kind = ${input.kind}`);
    if (input.contacts !== undefined) set.push(sql`contacts = ${JSON.stringify(input.contacts)}::jsonb`);
    if (input.notes !== undefined) set.push(sql`notes = ${input.notes}`);
    if (!set.length) return before;
    await this.db.execute(sql`update customer_accounts set ${sql.join(set, sql`, `)} where id = ${id}`);
    await staffAudit(this.db, staff, 'account.updated', `แก้บัญชีลูกค้า "${input.name ?? before.name}" (${Object.keys(input).join(', ')})`, { type: 'customer_account', id });
    return this.get(staff, id);
  }

  async setContract(staff: Staff, id: string, input: z.infer<typeof ContractBody>) {
    const before = await this.get(staff, id);
    // วันหมดเปลี่ยน = เริ่มนับเตือนต่อสัญญาใหม่
    await this.db.execute(sql`
      update customer_accounts set contract_start = ${input.start}, contract_end = ${input.end}, contract_value = ${input.value}, contract_seats = ${input.seats},
        contract_sla = ${input.sla ? JSON.stringify(input.sla) : null}::jsonb, kind = case when ${input.end}::date is not null then 'enterprise' else kind end,
        renewal_reminded = case when contract_end is distinct from ${input.end}::date then null else renewal_reminded end
      where id = ${id}`);
    await staffAudit(this.db, staff, 'account.contract', `แก้สัญญาบัญชี "${before.name}" · ${input.start ?? '—'} ถึง ${input.end ?? '—'}`, { type: 'customer_account', id });
    return this.get(staff, id);
  }

  async link(staff: Staff, id: string, input: z.infer<typeof LinkBody>) {
    const a = await this.get(staff, id);
    await this.assertFree(input.workspaceIds, id);
    await this.db.execute(sql`insert into customer_account_workspaces (workspace_id, account_id, added_by) select x, ${id}::uuid, ${staff.id}::uuid from unnest(array[${ids(input.workspaceIds)}]::uuid[]) x on conflict do nothing`);
    await staffAudit(this.db, staff, 'account.linked', `เพิ่ม ${input.workspaceIds.length} Workspace เข้าบัญชี "${a.name}"`, { type: 'customer_account', id });
    return this.get(staff, id);
  }

  async unlink(staff: Staff, id: string, workspaceId: string) {
    const a = await this.get(staff, id);
    const r = await this.rows(sql`delete from customer_account_workspaces where account_id = ${id} and workspace_id = ${workspaceId} returning workspace_id`);
    if (!r.length) throw new AppError(404, 'not_found', 'Workspace นี้ไม่ได้อยู่ในบัญชีนี้');
    await staffAudit(this.db, staff, 'account.unlinked', `เอา Workspace ออกจากบัญชี "${a.name}"`, { type: 'customer_account', id }, workspaceId);
    return this.get(staff, id);
  }

  async remove(staff: Staff, id: string) {
    const a = await this.get(staff, id);
    await this.db.execute(sql`delete from customer_accounts where id = ${id}`);
    await staffAudit(this.db, staff, 'account.deleted', `ลบบัญชีลูกค้า "${a.name}" (Workspace ไม่ถูกแตะ)`, { type: 'customer_account', id });
    return { ok: true };
  }

  async putFile(staff: Staff, id: string, body: unknown, name: string) {
    const a = await this.get(staff, id);
    if (!Buffer.isBuffer(body) || !body.length) throw new AppError(400, 'file_required', 'แนบไฟล์สัญญา (PDF)');
    if (body.length > MAX_PDF) throw new AppError(413, 'file_too_large', 'ไฟล์สัญญาต้องไม่เกิน 10 MB');
    if (body.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError(415, 'file_not_pdf', 'รับเฉพาะไฟล์ PDF');
    const safe = name.replace(/[\\/\r\n"]/g, '_').slice(0, 160) || 'contract.pdf';
    await this.db.execute(sql`
      insert into customer_account_files (account_id, name, mime, size, data, uploaded_by) values (${id}, ${safe}, 'application/pdf', ${body.length}, ${body}, ${staff.id})
      on conflict (account_id) do update set name = excluded.name, size = excluded.size, data = excluded.data, uploaded_by = excluded.uploaded_by, created_at = now()`);
    await staffAudit(this.db, staff, 'account.contract_file', `แนบไฟล์สัญญา "${safe}" ของบัญชี "${a.name}"`, { type: 'customer_account', id });
    return this.get(staff, id);
  }

  async file(id: string) {
    const [f] = await this.rows<{ name: string; size: number; data: Buffer }>(sql`select name, size, data from customer_account_files where account_id = ${id}`);
    if (!f) throw new AppError(404, 'not_found', 'ยังไม่มีไฟล์สัญญา');
    return f;
  }

  /** วันต่อสัญญา: บัญชีที่สัญญาจะหมดภายใน N วัน (รวมที่เพิ่งหมดไม่เกิน 30 วัน) · ใกล้หมดก่อน */
  async renewals(staff: Staff, q: z.infer<typeof RenewalsQuery>) {
    const where = sql`a.contract_end is not null and a.contract_end between ${todayBkk()}::date - 30 and ${todayBkk()}::date + ${q.within}::int`;
    const page = await this.base(sql`${where} order by a.contract_end, a.name limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n from customer_accounts a where ${where}`);
    const today = Date.parse(todayBkk());
    const items = (await this.withNumbers(staff, page)).map((a) => ({ ...a, daysLeft: Math.round((Date.parse(String(a.contractEnd)) - today) / 86_400_000) }));
    return { items, total: n, limit: q.limit, offset: q.offset };
  }

  /**
   * เตือนผู้ดูแลก่อนหมดสัญญา 90 / 60 / 30 วัน (ครั้งละขั้น · ข้ามขั้นที่ผ่านไปแล้ว) · ไม่มีผู้ดูแลส่งหา Owner
   * renewal_reminded จำขั้นล่าสุดของวันหมดปัจจุบัน จึงรันซ้ำได้ไม่ส่งซ้ำ
   */
  async remindRenewals(today = todayBkk()) {
    const due = await this.rows<{ id: string; name: string; end: string; days: number; reminded: number | null; email: string | null }>(sql`
      select a.id, a.name, a.contract_end::text as end, (a.contract_end - ${today}::date)::int as days, a.renewal_reminded as reminded, st.email
      from customer_accounts a left join staff_users st on st.id = a.manager_id and st.status = 'active'
      where a.contract_end between ${today}::date and ${today}::date + 90`);
    let sent = 0;
    for (const a of due) {
      const step = RENEWAL_STEPS.filter((s) => a.days <= s).at(-1)!;
      if (a.reminded != null && a.reminded <= step) continue;
      const to = a.email ? [a.email] : (await this.rows<{ email: string }>(sql`select email from staff_users where 'owner' = any(roles) and status = 'active'`)).map((x) => x.email);
      for (const email of to) await this.mail.send({ to: email, subject: `[Friday Ops] สัญญา ${a.name} จะหมดใน ${a.days} วัน`, text: `บัญชี ${a.name} สัญญาหมด ${a.end} (อีก ${a.days} วัน)\nเปิดหน้าวันต่อสัญญาเพื่อนัดคุยต่อสัญญา` }).catch((e) => this.log.error(String(e)));
      await this.db.execute(sql`update customer_accounts set renewal_reminded = ${step} where id = ${a.id}`);
      sent++;
    }
    return { sent };
  }
}

@Controller('ops')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('accounts')
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.accounts.list(req.staff!, parse(AccountsQuery, q));
  }
  @Roles('owner', 'support', 'finance', 'auditor')
  @Get('accounts/suggestions')
  suggestions() {
    return this.accounts.suggestions();
  }
  @Roles('owner', 'finance', 'support', 'auditor')
  @Get('renewals')
  renewals(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.accounts.renewals(req.staff!, parse(RenewalsQuery, q));
  }
  @Get('accounts/:id')
  get(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.accounts.get(req.staff!, id);
  }
  @Roles('owner', 'support')
  @Post('accounts')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.accounts.create(req.staff!, parse(CreateAccountBody, body));
  }
  @Roles('owner', 'support')
  @Patch('accounts/:id')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.update(req.staff!, id, parse(UpdateAccountBody, body));
  }
  @Roles('owner', 'finance')
  @Put('accounts/:id/contract')
  contract(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.setContract(req.staff!, id, parse(ContractBody, body));
  }
  @Roles('owner', 'support')
  @Post('accounts/:id/workspaces')
  @HttpCode(200)
  link(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.link(req.staff!, id, parse(LinkBody, body));
  }
  @Roles('owner', 'support')
  @Delete('accounts/:id/workspaces/:workspaceId')
  unlink(@Req() req: OpsRequest, @Param('id') id: string, @Param('workspaceId') workspaceId: string) {
    return this.accounts.unlink(req.staff!, id, parse(z.uuid(), workspaceId));
  }
  @Roles('owner')
  @Delete('accounts/:id')
  remove(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.accounts.remove(req.staff!, id);
  }
  /** ไฟล์สัญญา · ส่งเป็น application/pdf ตรง ๆ (ชื่อไฟล์ใน X-File-Name แบบ encodeURIComponent) */
  @Roles('owner', 'finance')
  @Put('accounts/:id/contract-file')
  putFile(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    const raw = req.headers['x-file-name'];
    const name = typeof raw === 'string' ? decodeURIComponent(raw) : 'contract.pdf';
    return this.accounts.putFile(req.staff!, id, body, name);
  }
  @Roles('owner', 'finance', 'auditor')
  @Get('accounts/:id/contract-file')
  async file(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.accounts.file(id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(f.size),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(f.data);
  }
}

@Module({ imports: [WorkspacesModule], controllers: [AccountsController], providers: [AccountsService], exports: [AccountsService] })
export class AccountsModule {}
