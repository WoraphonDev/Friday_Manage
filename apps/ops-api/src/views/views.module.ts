import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Db } from '@friday/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import { effectiveRoles, has, type OpsRequest, type Staff, type StaffRole } from '../auth/auth.guard.js';
import { BillingModule } from '../billing/billing.module.js';
import { BillingService, InvoicesQuery, OverdueQuery } from '../billing/billing.service.js';
import { OPS_DB } from '../db.js';
import { AppError, parse } from '../errors.js';
import { PrivacyModule } from '../privacy/privacy.module.js';
import { PrivacyService, RequestsQuery } from '../privacy/privacy.service.js';
import { SupportModule } from '../support/support.module.js';
import { TicketsQuery, TicketsService } from '../support/tickets.service.js';
import { UsersModule } from '../users/users.module.js';
import { UsersQuery, UsersService } from '../users/users.service.js';
import { CustomersService, ListQuery } from '../workspaces/customers.service.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';

/**
 * มุมมองที่บันทึก (ช่วง 3) · ตัวกรองชุดเดียวกับใน URL ของแต่ละหน้า
 * ส่วนตัว (roles ว่าง) = เห็นคนเดียว · ของทีม (roles มีค่า) = เห็นทุกคนที่มีบทบาทนั้น
 * สร้าง / แก้มุมมองของทีมได้เฉพาะ Owner และหัวหน้าทีม Support (กันมุมมองรกจนหาไม่เจอ)
 */
export const VIEW_PAGES = ['workspaces', 'tickets', 'overdue', 'users', 'privacy', 'deliveries', 'invoices'] as const;
type Page = (typeof VIEW_PAGES)[number];
const ROLES = ['owner', 'finance', 'support', 'engineer', 'auditor'] as const;
/** ปักที่เมนูซ้ายได้ไม่เกิน 5 (เมนูยาวแล้วหาไม่เจอ) */
export const MAX_PINNED = 5;
/** บทบาทที่เปิดหน้านั้นได้ (ตรงกับ @Roles ของ endpoint รายการ) · ใช้ตัดสินว่านับจำนวนให้ได้ไหม */
const PAGE_ROLES: Record<Page, StaffRole[] | null> = {
  workspaces: null,
  tickets: ['support', 'owner'],
  overdue: ['finance', 'owner', 'auditor'],
  invoices: ['finance', 'owner', 'auditor'],
  users: ['owner', 'support'],
  privacy: ['owner', 'support', 'auditor'],
  deliveries: ['owner', 'support', 'engineer'],
};

const Filters = z
  .record(z.string().regex(/^[a-zA-Z]{1,30}$/), z.string().max(300))
  .refine((r) => Object.keys(r).length <= 40, 'ตัวกรองมากเกินไป')
  // เก็บเฉพาะค่าที่ใช้ · หน้า (page) และแถวที่เปิดอยู่ไม่ใช่ส่วนของมุมมอง
  .transform((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== '' && !['page', 'ticket', 'id', 'request', 'breach'].includes(k))));
export const CreateViewBody = z
  .object({
    page: z.enum(VIEW_PAGES),
    name: z.string().trim().min(1).max(60),
    filters: Filters,
    /** ว่าง = ส่วนตัว */
    roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  })
  .strict();
export const UpdateViewBody = z
  .object({ name: z.string().trim().min(1).max(60).optional(), filters: Filters.optional(), roles: z.array(z.enum(ROLES)).max(ROLES.length).optional() })
  .strict();
export const PrefsBody = z
  .object({ pinned: z.boolean().optional(), hidden: z.boolean().optional(), isDefault: z.boolean().optional(), position: z.number().int().min(0).max(1000).optional() })
  .strict();
export const ViewsQuery = z.object({ page: z.enum(VIEW_PAGES).optional() });

export interface ViewRow {
  id: string;
  page: Page;
  name: string;
  filters: Record<string, string>;
  roles: string[];
  ownerId: string;
  ownerName: string;
  pinned: boolean;
  hidden: boolean;
  position: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ViewsService {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly customers: CustomersService,
    private readonly tickets: TicketsService,
    private readonly billing: BillingService,
    private readonly users: UsersService,
    private readonly privacy: PrivacyService,
  ) {}

  private async rows<T>(q: ReturnType<typeof sql>) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** Owner หรือหัวหน้าทีม Support (support_agents.groups มี lead) */
  async canManageTeam(staff: Staff) {
    if (has(staff, 'owner')) return true;
    if (!has(staff, 'support')) return false;
    const [r] = await this.rows<{ lead: boolean }>(sql`select 'lead' = any(groups) as lead from support_agents where staff_id = ${staff.id}`);
    return !!r?.lead;
  }

  /** มุมมองที่คนนี้เห็น: ของตัวเอง + ของทีมที่บทบาทตรง · Owner เห็นของทีมทั้งหมด (ดูแลและลบได้) */
  private visible(staff: Staff, page?: Page, id?: string) {
    const roles = effectiveRoles(staff);
    return this.rows<ViewRow>(sql`
      select v.id, v.page, v.name, v.filters, v.roles, v.owner_id as "ownerId", st.name as "ownerName",
        coalesce(p.pinned, false) as pinned, coalesce(p.hidden, false) as hidden, coalesce(p.position, 0) as position,
        coalesce(p.is_default, false) as "isDefault", v.created_at as "createdAt", v.updated_at as "updatedAt"
      from ops_saved_views v
      join staff_users st on st.id = v.owner_id
      left join ops_view_prefs p on p.view_id = v.id and p.staff_id = ${staff.id}
      where (v.owner_id = ${staff.id} and cardinality(v.roles) = 0
        or cardinality(v.roles) > 0 and (v.roles && ${sql`array[${sql.join(roles.map((r) => sql`${r}`), sql`, `)}]::text[]`} or ${has(staff, 'owner')}))
        ${page ? sql`and v.page = ${page}` : sql``}
        ${id ? sql`and v.id = ${id}` : sql``}
      order by (cardinality(v.roles) > 0), coalesce(p.position, 0), v.created_at`);
  }

  async list(staff: Staff, q: z.infer<typeof ViewsQuery>) {
    const team = await this.canManageTeam(staff);
    const items = (await this.visible(staff, q.page)).map((v) => this.shape(staff, v, team));
    return { items, canManageTeam: team, maxPinned: MAX_PINNED };
  }

  private shape(staff: Staff, v: ViewRow, team: boolean) {
    const isTeam = v.roles.length > 0;
    return { ...v, team: isTeam, mine: v.ownerId === staff.id, canEdit: isTeam ? team : v.ownerId === staff.id };
  }

  private async one(staff: Staff, id: string) {
    const [v] = await this.visible(staff, undefined, id);
    if (!v) throw new AppError(404, 'not_found', 'ไม่พบมุมมองนี้');
    return v;
  }
  private async assertEdit(staff: Staff, v: ViewRow) {
    const ok = v.roles.length ? await this.canManageTeam(staff) : v.ownerId === staff.id;
    if (!ok) throw new AppError(403, 'forbidden', v.roles.length ? 'มุมมองของทีมแก้ได้เฉพาะ Owner และหัวหน้าทีม Support' : 'แก้ได้เฉพาะมุมมองของตัวเอง');
  }

  async create(staff: Staff, input: z.infer<typeof CreateViewBody>) {
    if (input.roles.length && !(await this.canManageTeam(staff))) throw new AppError(403, 'forbidden', 'มุมมองของทีมสร้างได้เฉพาะ Owner และหัวหน้าทีม Support · บันทึกเป็นมุมมองส่วนตัวแทนได้');
    const [dup] = await this.rows<{ id: string }>(sql`
      select id from ops_saved_views where page = ${input.page} and lower(name) = lower(${input.name})
        and (${input.roles.length > 0} and cardinality(roles) > 0 or owner_id = ${staff.id} and cardinality(roles) = 0)`);
    if (dup) throw new AppError(409, 'duplicate_name', 'มีมุมมองชื่อนี้ในหน้านี้แล้ว · ใช้ "บันทึกทับ" หรือเปลี่ยนชื่อ');
    const [row] = await this.rows<{ id: string }>(sql`
      insert into ops_saved_views (owner_id, page, name, filters, roles)
      values (${staff.id}, ${input.page}, ${input.name}, ${JSON.stringify(input.filters)}::jsonb, ${sql`array[${sql.join(input.roles.map((r) => sql`${r}`), sql`, `)}]::text[]`})
      returning id`);
    if (input.roles.length) await staffAudit(this.db, staff, 'view.team_created', `สร้างมุมมองของทีม "${input.name}" (${input.page}) ให้ ${input.roles.join(', ')}`, { type: 'ops_saved_view', id: row.id });
    return this.shape(staff, await this.one(staff, row.id), await this.canManageTeam(staff));
  }

  async update(staff: Staff, id: string, input: z.infer<typeof UpdateViewBody>) {
    const v = await this.one(staff, id);
    await this.assertEdit(staff, v);
    // เปลี่ยนส่วนตัว ↔ ทีม ต้องมีสิทธิ์ทีม
    if (input.roles?.length && !v.roles.length && !(await this.canManageTeam(staff))) throw new AppError(403, 'forbidden', 'มุมมองของทีมสร้างได้เฉพาะ Owner และหัวหน้าทีม Support');
    await this.db.execute(sql`
      update ops_saved_views set
        name = coalesce(${input.name ?? null}, name),
        filters = coalesce(${input.filters ? JSON.stringify(input.filters) : null}::jsonb, filters),
        roles = ${input.roles ? sql`array[${sql.join(input.roles.map((r) => sql`${r}`), sql`, `)}]::text[]` : sql`roles`}
      where id = ${id}`);
    if (v.roles.length || input.roles?.length) await staffAudit(this.db, staff, 'view.team_updated', `แก้มุมมองของทีม "${input.name ?? v.name}" (${v.page})`, { type: 'ops_saved_view', id });
    return this.shape(staff, await this.one(staff, id), await this.canManageTeam(staff));
  }

  async remove(staff: Staff, id: string) {
    const v = await this.one(staff, id);
    await this.assertEdit(staff, v);
    await this.db.execute(sql`delete from ops_saved_views where id = ${id}`);
    if (v.roles.length) await staffAudit(this.db, staff, 'view.team_deleted', `ลบมุมมองของทีม "${v.name}" (${v.page})`, { type: 'ops_saved_view', id });
    return { ok: true };
  }

  /** คัดลอกเป็นมุมมองส่วนตัว (แก้ต่อได้โดยไม่กระทบทีม) */
  async copy(staff: Staff, id: string) {
    const v = await this.one(staff, id);
    const taken = new Set((await this.visible(staff, v.page)).filter((x) => !x.roles.length).map((x) => x.name.toLowerCase()));
    let name = `${v.name} (สำเนา)`.slice(0, 60);
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${v.name} (สำเนา ${i})`.slice(0, 60);
    return this.create(staff, { page: v.page, name, filters: v.filters, roles: [] });
  }

  async setPrefs(staff: Staff, id: string, input: z.infer<typeof PrefsBody>) {
    const v = await this.one(staff, id);
    if (input.hidden && !v.roles.length) throw new AppError(400, 'not_team_view', 'ซ่อนได้เฉพาะมุมมองของทีม · มุมมองของตัวเองให้ลบแทน');
    if (input.pinned && !v.pinned) {
      const [c] = await this.rows<{ n: number }>(sql`
        select count(*)::int as n from ops_view_prefs p join ops_saved_views v on v.id = p.view_id
        where p.staff_id = ${staff.id} and p.pinned`);
      if (c.n >= MAX_PINNED) throw new AppError(409, 'pin_limit', `ปักที่เมนูซ้ายได้ไม่เกิน ${MAX_PINNED} มุมมอง · เอาอันเดิมออกก่อน`, { max: MAX_PINNED });
    }
    // มุมมองเริ่มต้นมีได้หน้าละหนึ่ง
    if (input.isDefault)
      await this.db.execute(sql`
        update ops_view_prefs p set is_default = false from ops_saved_views v
        where v.id = p.view_id and p.staff_id = ${staff.id} and v.page = ${v.page} and p.view_id <> ${id}`);
    await this.db.execute(sql`
      insert into ops_view_prefs (staff_id, view_id, pinned, hidden, position, is_default)
      values (${staff.id}, ${id}, ${input.pinned ?? v.pinned}, ${input.hidden ?? v.hidden}, ${input.position ?? v.position}, ${input.isDefault ?? v.isDefault})
      on conflict (staff_id, view_id) do update set pinned = excluded.pinned, hidden = excluded.hidden, position = excluded.position, is_default = excluded.is_default`);
    return this.shape(staff, await this.one(staff, id), await this.canManageTeam(staff));
  }

  /**
   * จำนวนรายการของมุมมองที่ปักไว้ (ตัวเลขบนเมนูซ้าย · หน้าเว็บถามทุก 2 นาที)
   * ใช้ endpoint รายการเดิมกับตัวกรองที่บันทึก · หน้าที่ไม่มีสิทธิ์หรือไม่มีจำนวนรวม (ประวัติการส่ง) ได้ null
   */
  async counts(staff: Staff) {
    const pinned = (await this.visible(staff)).filter((v) => v.pinned && !v.hidden);
    const items = await Promise.all(pinned.map(async (v) => ({ id: v.id, count: await this.count(staff, v).catch(() => null) })));
    return { items };
  }

  private async count(staff: Staff, v: ViewRow): Promise<number | null> {
    const need = PAGE_ROLES[v.page];
    if (need && !has(staff, ...need)) return null;
    const f = { ...v.filters, limit: '1', offset: '0' };
    switch (v.page) {
      case 'workspaces':
        return (await this.customers.list(staff, parse(ListQuery, f))).total;
      case 'tickets': {
        // แท็บ (tab) ของหน้า Ticket แปลงเป็น assignee แบบเดียวกับหน้าเว็บ
        const { tab, ...rest } = f as Record<string, string>;
        const assignee = tab === 'mine' ? 'me' : tab === 'none' ? 'none' : undefined;
        return (await this.tickets.list(staff, parse(TicketsQuery, { ...rest, ...(assignee ? { assignee } : {}) }))).total;
      }
      case 'overdue':
        return (await this.billing.overdue(parse(OverdueQuery, f))).total;
      case 'invoices':
        return (await this.billing.listInvoices(parse(InvoicesQuery, f))).total;
      case 'users':
        return (await this.users.list(parse(UsersQuery, f))).total;
      case 'privacy':
        return (await this.privacy.list(parse(RequestsQuery, f))).total;
      default:
        return null;
    }
  }
}

@Controller('ops/views')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.views.list(req.staff!, parse(ViewsQuery, q));
  }
  @Get('counts')
  counts(@Req() req: OpsRequest) {
    return this.views.counts(req.staff!);
  }
  @Post()
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.views.create(req.staff!, parse(CreateViewBody, body));
  }
  @Patch(':id')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.views.update(req.staff!, parse(z.uuid(), id), parse(UpdateViewBody, body));
  }
  @Delete(':id')
  remove(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.views.remove(req.staff!, parse(z.uuid(), id));
  }
  @Post(':id/copy')
  @HttpCode(201)
  copy(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.views.copy(req.staff!, parse(z.uuid(), id));
  }
  @Put(':id/prefs')
  prefs(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.views.setPrefs(req.staff!, parse(z.uuid(), id), parse(PrefsBody, body));
  }
}

@Module({ imports: [WorkspacesModule, SupportModule, BillingModule, UsersModule, PrivacyModule], controllers: [ViewsController], providers: [ViewsService] })
export class ViewsModule {}
