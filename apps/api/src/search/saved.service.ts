import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService } from '../projects/projects.service.js';

const Name = z.string().trim().min(1).max(80);
const Json = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 8_000, 'ใหญ่เกินไป');
const MAX_PER_USER = 50;

export const SavedSearchBody = z.object({ name: Name, query: z.string().trim().min(1).max(200), filters: Json.default({}) });
// ฟิลด์ที่มีค่าเริ่มต้นตอนสร้างต้องไม่ใส่ค่าเริ่มต้นตอนแก้ ไม่งั้น {} จะกลายเป็นการแก้ทุกฟิลด์
export const PatchSavedSearchBody = z.object({ name: Name, query: z.string().trim().min(1).max(200), filters: Json }).partial().refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

export const SavedViewBody = z.object({
  name: Name,
  viewType: z.enum(['table', 'board', 'timeline', 'gantt', 'calendar', 'backlog']).default('table'),
  filters: Json.default({}),
  groupBy: z.string().trim().min(1).max(40).nullish(),
  sort: z.array(z.object({ field: z.string().trim().min(1).max(40), dir: z.enum(['asc', 'desc']).default('asc') })).max(5).default([]),
  columns: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  /** true = แชร์ทั้งโปรเจกต์ (ต้องมี project.views.share) · false = ของฉันคนเดียว */
  shared: z.boolean().default(false),
});
export const PatchSavedViewBody = z
  .object({
    name: Name,
    viewType: z.enum(['table', 'board', 'timeline', 'gantt', 'calendar', 'backlog']),
    filters: Json,
    groupBy: z.string().trim().min(1).max(40).nullable(),
    sort: z.array(z.object({ field: z.string().trim().min(1).max(40), dir: z.enum(['asc', 'desc']).default('asc') })).max(5),
    columns: z.array(z.string().trim().min(1).max(40)).max(40),
    shared: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

/** การค้นหาที่บันทึก (P1) และ View ที่บันทึกของหน้า Table (2) */
@Injectable()
export class SavedService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
  ) {}

  // saved-searches (ของตัวเอง) ----------------------------------------------------------------
  private mine(tenant: TenantInfo, auth: AuthInfo) {
    return and(eq(s.savedSearches.workspaceId, tenant.workspaceId), eq(s.savedSearches.userId, auth.userId));
  }

  listSearches(auth: AuthInfo, tenant: TenantInfo) {
    return this.db.run(auth, tenant, async (tx) => ({ items: (await tx.select().from(s.savedSearches).where(this.mine(tenant, auth)).orderBy(asc(s.savedSearches.name))).map(this.searchDto) }));
  }

  createSearch(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof SavedSearchBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.savedSearches).where(this.mine(tenant, auth));
      if ((n?.n ?? 0) >= MAX_PER_USER) throw new AppError(422, 'saved_search_limit', `บันทึกการค้นหาได้ไม่เกิน ${MAX_PER_USER} รายการ`);
      const [row] = await tx.insert(s.savedSearches).values({ workspaceId: tenant.workspaceId, userId: auth.userId, name: body.name, query: body.query, filters: body.filters }).returning();
      return this.searchDto(row);
    });
  }

  patchSearch(auth: AuthInfo, tenant: TenantInfo, id: string, body: z.infer<typeof PatchSavedSearchBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.update(s.savedSearches).set(body).where(and(eq(s.savedSearches.id, id), this.mine(tenant, auth))).returning();
      if (!row) throw notFound('การค้นหาที่บันทึก');
      return this.searchDto(row);
    });
  }

  deleteSearch(auth: AuthInfo, tenant: TenantInfo, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx.delete(s.savedSearches).where(and(eq(s.savedSearches.id, id), this.mine(tenant, auth))).returning({ id: s.savedSearches.id });
      if (!row) throw notFound('การค้นหาที่บันทึก');
      return { deleted: true };
    });
  }

  private searchDto = (r: typeof s.savedSearches.$inferSelect) => ({ id: r.id, name: r.name, query: r.query, filters: r.filters, createdAt: r.createdAt, updatedAt: r.updatedAt });

  // saved-views ---------------------------------------------------------------------------------
  private async ctx(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, write: boolean) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    if (access.guestViewer || tenant.role === 'guest') throw new AppError(403, 'guest_view_limited', 'Guest ใช้ View ที่บันทึกไม่ได้');
    if (write && (project.archivedAt || project.status === 'archived')) throw new AppError(403, 'project_archived', 'โปรเจกต์ที่เก็บถาวรแก้ไขไม่ได้');
    return { project, access };
  }

  private viewDto(v: typeof s.savedViews.$inferSelect, auth: AuthInfo) {
    return { id: v.id, name: v.name, viewType: v.viewType, filters: v.filters, groupBy: v.groupBy, sort: v.sort, columns: v.columns, shared: v.ownerId === null, mine: v.ownerId === auth.userId, createdAt: v.createdAt, updatedAt: v.updatedAt };
  }

  listViews(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, false);
      // ของฉัน + ที่แชร์ทั้งโปรเจกต์ (ของคนอื่นที่ไม่ได้แชร์ไม่เห็น)
      const rows = await tx
        .select()
        .from(s.savedViews)
        .where(and(eq(s.savedViews.projectId, project.id), or(isNull(s.savedViews.ownerId), eq(s.savedViews.ownerId, auth.userId))))
        .orderBy(sql`${s.savedViews.ownerId} is not null`, asc(s.savedViews.name));
      return { items: rows.map((r) => this.viewDto(r, auth)) };
    });
  }

  createView(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof SavedViewBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, true);
      if (body.shared) requirePerm(access, 'project.views.share');
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.savedViews).where(and(eq(s.savedViews.projectId, project.id), body.shared ? isNull(s.savedViews.ownerId) : eq(s.savedViews.ownerId, auth.userId)));
      if ((n?.n ?? 0) >= MAX_PER_USER) throw new AppError(422, 'saved_view_limit', `บันทึก View ได้ไม่เกิน ${MAX_PER_USER} รายการ`);
      const [row] = await tx
        .insert(s.savedViews)
        .values({ workspaceId: tenant.workspaceId, projectId: project.id, ownerId: body.shared ? null : auth.userId, name: body.name, viewType: body.viewType, filters: body.filters, groupBy: body.groupBy ?? null, sort: body.sort, columns: body.columns })
        .returning();
      return this.viewDto(row, auth);
    });
  }

  /** เจ้าของแก้ View ของตัวเองได้ · View ที่แชร์ทั้งโปรเจกต์แก้ / ลบได้เฉพาะผู้มี project.views.share */
  private async editable(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    const { project, access } = await this.ctx(tx, auth, tenant, key, true);
    const [v] = await tx.select().from(s.savedViews).where(and(eq(s.savedViews.id, id), eq(s.savedViews.projectId, project.id)));
    if (!v || (v.ownerId && v.ownerId !== auth.userId)) throw notFound('View');
    if (!v.ownerId && !access.perms.has('project.views.share')) throw forbidden('project.views.share');
    return { v, access };
  }

  patchView(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof PatchSavedViewBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { v, access } = await this.editable(tx, auth, tenant, key, id);
      // เปลี่ยนเป็นแชร์ทั้งโปรเจกต์ต้องมีสิทธิ์แชร์ · เปลี่ยนกลับเป็นส่วนตัวให้ผู้แก้เป็นเจ้าของ
      if (body.shared === true && v.ownerId) requirePerm(access, 'project.views.share');
      const { shared, ...rest } = body;
      const [row] = await tx
        .update(s.savedViews)
        .set({ ...rest, ...(shared === undefined ? {} : { ownerId: shared ? null : auth.userId }) })
        .where(eq(s.savedViews.id, v.id))
        .returning();
      return this.viewDto(row, auth);
    });
  }

  deleteView(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { v } = await this.editable(tx, auth, tenant, key, id);
      await tx.delete(s.savedViews).where(eq(s.savedViews.id, v.id));
      return { deleted: true };
    });
  }
}

