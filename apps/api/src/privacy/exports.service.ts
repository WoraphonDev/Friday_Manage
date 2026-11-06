import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Jobs } from '../queue/jobs.js';
import { buildWorkspaceZip } from './build-export.js';
import { assertAdmin, audit } from './shared.js';

const s = schema;
/** ลิงก์ดาวน์โหลดใช้ได้ 7 วัน แล้วไฟล์ถูกลบ */
const EXPORT_TTL_MS = 7 * 86_400_000;
const exportPath = (id: string) => join(config.uploadDir, 'exports', `${id}.zip`);

/** Export ทั้ง Workspace (N1 › ที่เก็บและการเก็บรักษาข้อมูล) */
@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly log = new Logger('Exports');

  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    this.jobs.define('privacy.export', (d: { id: string }) => this.run(d.id));
    this.jobs.define('privacy.cleanup-exports', () => this.cleanup());
    await this.jobs.every('privacy.cleanup-exports', '30 3 * * *');
  }

  async request(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    const row = await this.db.run(auth, tenant, async (tx) => {
      // ครั้งละหนึ่งงาน กันกดรัว (งานที่ค้างเกิน 30 นาทีถือว่าตาย ไม่บล็อก)
      const [busy] = await tx
        .select({ id: s.workspaceExports.id })
        .from(s.workspaceExports)
        .where(and(inArray(s.workspaceExports.status, ['queued', 'running']), sql`${s.workspaceExports.createdAt} > now() - interval '30 minutes'`));
      if (busy) throw new AppError(409, 'export_in_progress', 'มี Export ที่กำลังทำอยู่ รอให้เสร็จก่อน', { exportId: busy.id });
      const [created] = await tx.insert(s.workspaceExports).values({ workspaceId: tenant.workspaceId, requestedBy: auth.userId }).returning();
      await audit(tx, auth, tenant, 'secu', 'export.requested', 'ขอ Export ทั้ง Workspace', { type: 'workspace_export', id: created.id });
      return created;
    });
    // ส่งเข้าคิวหลัง commit (โหมด inline รัน handler ทันที ซึ่งต้องเห็นแถวที่เพิ่ง commit)
    await this.jobs.enqueue('privacy.export', { id: row.id });
    return this.dto(auth, tenant, row.id);
  }

  async list(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const rows = await tx.select().from(s.workspaceExports).orderBy(desc(s.workspaceExports.createdAt)).limit(50);
      const people = await loadPeople(tx, rows.map((r) => r.requestedBy));
      return { items: await Promise.all(rows.map((r) => this.view(r, tenant, people.get(r.requestedBy) ?? null))) };
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    return this.dto(auth, tenant, id);
  }

  async download(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    const row = await this.db.run(auth, tenant, async (tx) => {
      const r = await this.find(tx, id);
      if (r.status !== 'ready' || !r.fileKey) throw new AppError(409, 'export_not_ready', 'Export ยังไม่เสร็จ', { status: r.status });
      if (r.expiresAt && r.expiresAt.getTime() < Date.now()) throw new AppError(410, 'export_expired', 'ลิงก์ดาวน์โหลดหมดอายุแล้ว · ขอ Export ใหม่');
      await audit(tx, auth, tenant, 'secu', 'export.downloaded', 'ดาวน์โหลดไฟล์ Export', { type: 'workspace_export', id: r.id });
      return r;
    });
    const path = exportPath(row.id);
    const info = await stat(path).catch(() => null);
    if (!info) throw new AppError(410, 'export_expired', 'ไฟล์ Export ถูกลบแล้ว · ขอ Export ใหม่');
    return { stream: createReadStream(path), size: info.size, filename: `${tenant.slug}-export-${row.createdAt.toISOString().slice(0, 10)}.zip` };
  }

  // ---------------------------------------------------------------------------

  /** งานเบื้องหลัง · อ่านแถว Export ก่อนรู้ Workspace จึงใช้ SYSTEM_DB แล้วสร้างไฟล์ภายใต้ RLS ของผู้ขอ */
  async run(id: string) {
    const [row] = await this.sys.select().from(s.workspaceExports).where(eq(s.workspaceExports.id, id));
    if (!row || row.status !== 'queued') return;
    await this.sys.update(s.workspaceExports).set({ status: 'running', updatedAt: new Date() }).where(eq(s.workspaceExports.id, id));
    try {
      const [member] = await this.sys
        .select({ slug: s.workspaces.slug, role: s.workspaceMembers.role })
        .from(s.workspaces)
        .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, row.requestedBy), eq(s.workspaceMembers.status, 'active')))
        .where(eq(s.workspaces.id, row.workspaceId));
      if (!member || (member.role !== 'owner' && member.role !== 'admin')) throw new Error('ผู้ขอไม่ใช่ Owner / Admin ของ Workspace แล้ว');
      const auth = { userId: row.requestedBy, sessionId: 'export' };
      const tenant = { workspaceId: row.workspaceId, slug: member.slug, role: member.role };
      const { zip } = await this.db.run(auth, tenant, (tx) => buildWorkspaceZip(tx, row.workspaceId));
      await mkdir(join(config.uploadDir, 'exports'), { recursive: true });
      await writeFile(exportPath(id), zip);
      await this.sys.update(s.workspaceExports).set({ status: 'ready', fileKey: `exports/${id}.zip`, expiresAt: new Date(Date.now() + EXPORT_TTL_MS), updatedAt: new Date() }).where(eq(s.workspaceExports.id, id));
      await this.sys.insert(s.auditLogs).values({ workspaceId: row.workspaceId, actorId: row.requestedBy, actorKind: 'user', category: 'secu', action: 'export.completed', targetType: 'workspace_export', targetId: id, summary: `Export เสร็จ ${zip.length} ไบต์` });
    } catch (err) {
      this.log.error(`export ${id} ล้มเหลว: ${(err as Error).message}`);
      await this.sys.update(s.workspaceExports).set({ status: 'failed', updatedAt: new Date() }).where(eq(s.workspaceExports.id, id));
    }
  }

  /** ลบไฟล์ Export ที่หมดอายุ */
  async cleanup() {
    const rows = await this.sys.select({ id: s.workspaceExports.id }).from(s.workspaceExports).where(and(eq(s.workspaceExports.status, 'ready'), lt(s.workspaceExports.expiresAt, new Date())));
    for (const r of rows) {
      await rm(exportPath(r.id), { force: true });
      await this.sys.update(s.workspaceExports).set({ status: 'expired', fileKey: null, updatedAt: new Date() }).where(eq(s.workspaceExports.id, r.id));
    }
    return { expired: rows.length };
  }

  private async find(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('Export');
    const [r] = await tx.select().from(s.workspaceExports).where(eq(s.workspaceExports.id, id));
    if (!r) throw notFound('Export');
    return r;
  }

  private async dto(auth: AuthInfo, tenant: TenantInfo, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const r = await this.find(tx, id);
      return this.view(r, tenant, (await loadPeople(tx, [r.requestedBy])).get(r.requestedBy) ?? null);
    });
  }

  private async view(r: typeof s.workspaceExports.$inferSelect, tenant: TenantInfo, requestedBy: unknown) {
    const expired = r.status === 'ready' && !!r.expiresAt && r.expiresAt.getTime() < Date.now();
    const info = r.status === 'ready' && !expired ? await stat(exportPath(r.id)).catch(() => null) : null;
    return {
      id: r.id,
      status: expired ? 'expired' : r.status,
      requestedBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      sizeBytes: info?.size ?? null,
      downloadUrl: info ? `/api/v1/w/${tenant.slug}/exports/${r.id}/download` : null,
    };
  }
}
