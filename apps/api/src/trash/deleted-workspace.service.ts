import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { effectivePlan, PLAN_CATALOG, type PlanCode } from '../billing/catalog.js';
import { config } from '../config.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo } from '../common/request.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { buildWorkspaceZip } from '../privacy/build-export.js';
import { purgeAt } from '../privacy/lifecycle.service.js';
import { Jobs } from '../queue/jobs.js';
import { daysLeftOf } from './shared.js';

const s = schema;
const EXPORT_TTL_MS = 7 * 86_400_000;
/** ที่เดียวกับ Export ปกติ (A31) · งาน privacy.cleanup-exports ลบไฟล์ที่หมดอายุให้ */
const exportPath = (id: string) => join(config.uploadDir, 'exports', `${id}.zip`);

/**
 * Z5 · หน้า Workspace ที่ลบไว้ และส่งออกข้อมูลก่อนลบถาวร
 * RLS ซ่อน Workspace ที่ลบแล้วจากทุกคน (app.ws_role กรอง deleted_at) จึงอ่านด้วย SYSTEM_DB
 * โดยบังคับว่าผู้เรียกเป็นสมาชิก active ของ Workspace นั้นทุกครั้ง · Owner เท่านั้นที่ส่งออกได้
 */
@Injectable()
export class DeletedWorkspaceService implements OnModuleInit {
  private readonly log = new Logger('DeletedWorkspace');

  constructor(
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly jobs: Jobs,
  ) {}

  onModuleInit() {
    this.jobs.define('trash.export-deleted', (d: { id: string }) => this.runExport(d.id));
  }

  /** Workspace ที่ลบแล้ว + บทบาทของผู้เรียก · ไม่ใช่สมาชิก (หรือไม่ได้ลบ) ตอบ 404 เหมือนไม่มี */
  private async membership(auth: AuthInfo, slug: string) {
    const [row] = await this.sys
      .select({ ws: s.workspaces, role: s.workspaceMembers.role })
      .from(s.workspaces)
      .innerJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.workspaces.id), eq(s.workspaceMembers.userId, auth.userId), eq(s.workspaceMembers.status, 'active')))
      .where(and(sql`lower(${s.workspaces.slug}) = ${slug.toLowerCase()}`, isNotNull(s.workspaces.deletedAt)));
    if (!row) throw notFound('Workspace ที่ถูกลบ');
    return row;
  }

  async info(auth: AuthInfo, slug: string) {
    const { ws, role } = await this.membership(auth, slug);
    const purge = purgeAt(ws);
    const people = await this.sys
      .select({ id: s.users.id, displayName: s.users.displayName, email: s.users.email, role: s.workspaceMembers.role })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, ws.id), eq(s.workspaceMembers.status, 'active')));
    const deleter = ws.deletedBy ? await this.sys.select({ displayName: s.users.displayName }).from(s.users).where(eq(s.users.id, ws.deletedBy)) : [];
    const [projects] = await this.sys.select({ n: sql<number>`count(*)::int` }).from(s.projects).where(and(eq(s.projects.workspaceId, ws.id), isNull(s.projects.deletedAt)));
    const [issues] = await this.sys.select({ n: sql<number>`count(*)::int` }).from(s.issues).where(and(eq(s.issues.workspaceId, ws.id), isNull(s.issues.deletedAt)));
    const [storage] = await this.sys.select({ n: sql<number>`coalesce(sum(${s.fileVersions.sizeBytes}), 0)::bigint` }).from(s.fileVersions).where(eq(s.fileVersions.workspaceId, ws.id));
    const [sub] = await this.sys
      .select({ status: s.subscriptions.status, planCode: s.plans.code, trialEndsAt: s.subscriptions.trialEndsAt, currentPeriodEnd: s.subscriptions.currentPeriodEnd })
      .from(s.subscriptions)
      .innerJoin(s.plans, eq(s.plans.id, s.subscriptions.planId))
      .where(eq(s.subscriptions.workspaceId, ws.id));
    // ลบได้เฉพาะเมื่อยกเลิกแพ็กเกจแล้ว จึงกู้คืนแล้วมักเป็น Free (Z5)
    const code: PlanCode = sub ? effectivePlan({ ...sub, planCode: sub.planCode as PlanCode }) : 'free';
    const owners = people.filter((p) => p.role === 'owner');
    const expired = purge.getTime() <= Date.now();
    return {
      slug: ws.slug,
      name: ws.name,
      deletedAt: ws.deletedAt,
      purgeAfter: purge,
      daysLeft: daysLeftOf(purge),
      deletedBy: deleter[0] ? { displayName: deleter[0].displayName, role: people.find((p) => p.id === ws.deletedBy)?.role ?? null } : null,
      // ติดต่อ Owner ให้กู้คืน (สมาชิกเห็นชื่อและอีเมลของ Owner ในหน้าสมาชิกอยู่แล้ว)
      owners: owners.map((o) => ({ displayName: o.displayName, email: o.email })),
      counts: { projects: projects?.n ?? 0, issues: issues?.n ?? 0, storageBytes: Number(storage?.n ?? 0), members: people.length },
      plan: { code, name: PLAN_CATALOG[code].name, status: sub?.status ?? null },
      myRole: role,
      can: { restore: role === 'owner' && !expired, export: role === 'owner' && !expired },
    };
  }

  /** ส่งออกข้อมูลก่อนลบถาวร (Owner) · ครั้งละหนึ่งงานเหมือน A31 */
  async requestExport(auth: AuthInfo, slug: string) {
    const { ws, role } = await this.membership(auth, slug);
    if (role !== 'owner') throw forbidden('ws.owner');
    if (purgeAt(ws).getTime() <= Date.now()) throw new AppError(410, 'restore_expired', 'เกินกำหนดแล้ว · ข้อมูลกำลังถูกลบถาวร');
    const [busy] = await this.sys
      .select({ id: s.workspaceExports.id })
      .from(s.workspaceExports)
      .where(and(eq(s.workspaceExports.workspaceId, ws.id), inArray(s.workspaceExports.status, ['queued', 'running']), sql`${s.workspaceExports.createdAt} > now() - interval '30 minutes'`));
    if (busy) throw new AppError(409, 'export_in_progress', 'มี Export ที่กำลังทำอยู่ รอให้เสร็จก่อน', { exportId: busy.id });
    const [row] = await this.sys.insert(s.workspaceExports).values({ workspaceId: ws.id, requestedBy: auth.userId }).returning();
    await this.sys.insert(s.auditLogs).values({ workspaceId: ws.id, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'export.requested', targetType: 'workspace_export', targetId: row!.id, summary: 'ขอ Export ทั้ง Workspace (ระหว่างรอลบถาวร)' });
    await this.jobs.enqueue('trash.export-deleted', { id: row!.id });
    return this.exportView(row!.id);
  }

  async listExports(auth: AuthInfo, slug: string) {
    const { ws, role } = await this.membership(auth, slug);
    if (role !== 'owner') throw forbidden('ws.owner');
    const rows = await this.sys.select({ id: s.workspaceExports.id }).from(s.workspaceExports).where(eq(s.workspaceExports.workspaceId, ws.id)).orderBy(desc(s.workspaceExports.createdAt)).limit(10);
    return { items: await Promise.all(rows.map((r) => this.exportView(r.id))) };
  }

  async download(auth: AuthInfo, slug: string, id: string) {
    const { ws, role } = await this.membership(auth, slug);
    if (role !== 'owner') throw forbidden('ws.owner');
    if (!z.uuid().safeParse(id).success) throw notFound('Export');
    const [r] = await this.sys.select().from(s.workspaceExports).where(and(eq(s.workspaceExports.id, id), eq(s.workspaceExports.workspaceId, ws.id)));
    if (!r) throw notFound('Export');
    if (r.status !== 'ready') throw new AppError(409, 'export_not_ready', 'Export ยังไม่เสร็จ', { status: r.status });
    if (r.expiresAt && r.expiresAt.getTime() < Date.now()) throw new AppError(410, 'export_expired', 'ลิงก์ดาวน์โหลดหมดอายุแล้ว · ขอ Export ใหม่');
    const info = await stat(exportPath(r.id)).catch(() => null);
    if (!info) throw new AppError(410, 'export_expired', 'ไฟล์ Export ถูกลบแล้ว · ขอ Export ใหม่');
    await this.sys.insert(s.auditLogs).values({ workspaceId: ws.id, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'export.downloaded', targetType: 'workspace_export', targetId: r.id, summary: 'ดาวน์โหลดไฟล์ Export (ระหว่างรอลบถาวร)' });
    return { stream: createReadStream(exportPath(r.id)), size: info.size, filename: `${ws.slug}-export-${r.createdAt.toISOString().slice(0, 10)}.zip` };
  }

  /**
   * งานเบื้องหลัง · สร้าง zip ด้วย SYSTEM_DB เพราะ RLS ซ่อน Workspace ที่ลบแล้ว
   * buildWorkspaceZip กรอง workspace_id ทุกตารางเอง จึงไม่ปนข้อมูลของ Workspace อื่น · ตรวจซ้ำว่าผู้ขอยังเป็น Owner
   */
  async runExport(id: string) {
    const [row] = await this.sys.select().from(s.workspaceExports).where(eq(s.workspaceExports.id, id));
    if (!row || row.status !== 'queued') return;
    await this.sys.update(s.workspaceExports).set({ status: 'running', updatedAt: new Date() }).where(eq(s.workspaceExports.id, id));
    try {
      const [owner] = await this.sys
        .select({ role: s.workspaceMembers.role })
        .from(s.workspaceMembers)
        .where(and(eq(s.workspaceMembers.workspaceId, row.workspaceId), eq(s.workspaceMembers.userId, row.requestedBy), eq(s.workspaceMembers.status, 'active')));
      if (owner?.role !== 'owner') throw new Error('ผู้ขอไม่ใช่ Owner ของ Workspace แล้ว');
      const { zip } = await this.sys.transaction((tx) => buildWorkspaceZip(tx, row.workspaceId));
      await mkdir(join(config.uploadDir, 'exports'), { recursive: true });
      await writeFile(exportPath(id), zip);
      await this.sys.update(s.workspaceExports).set({ status: 'ready', fileKey: `exports/${id}.zip`, expiresAt: new Date(Date.now() + EXPORT_TTL_MS), updatedAt: new Date() }).where(eq(s.workspaceExports.id, id));
      await this.sys.insert(s.auditLogs).values({ workspaceId: row.workspaceId, actorId: row.requestedBy, actorKind: 'user', category: 'secu', action: 'export.completed', targetType: 'workspace_export', targetId: id, summary: `Export เสร็จ ${zip.length} ไบต์` });
    } catch (err) {
      this.log.error(`export ${id} ล้มเหลว: ${(err as Error).message}`);
      await this.sys.update(s.workspaceExports).set({ status: 'failed', updatedAt: new Date() }).where(eq(s.workspaceExports.id, id));
    }
  }

  private async exportView(id: string) {
    const [r] = await this.sys.select().from(s.workspaceExports).where(eq(s.workspaceExports.id, id));
    const expired = r!.status === 'ready' && !!r!.expiresAt && r!.expiresAt.getTime() < Date.now();
    return { id: r!.id, status: expired ? 'expired' : r!.status, createdAt: r!.createdAt, expiresAt: r!.expiresAt };
  }
}
