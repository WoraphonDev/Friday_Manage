import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { initials } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { IssuesService } from '../issues/issues.service.js';
import { projectAccess, requirePerm } from '../projects/permissions.js';
import { projectKey, ProjectsService } from '../projects/projects.service.js';
import {
  BATCH_WINDOW_MS, daysLeftOf, PURGE_CONFIRM, purgeAtOf, removeStoredObjects, suggestKey, TRASH_TYPES, type TrashType, trashDaysOf,
} from './shared.js';

const s = schema;

export const TrashQuery = z.object({
  type: z.enum(TRASH_TYPES).default('issue'),
  /** Key ของโปรเจกต์ที่ยังใช้งาน (กรองงาน / ไฟล์) */
  project: projectKey.optional(),
  deletedBy: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type TrashQuery = z.infer<typeof TrashQuery>;

export const RestoreProjectBody = z.object({ newKey: projectKey.optional() }).strict();

interface Deleter {
  id: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
  role: string | null;
}

/** ตำแหน่งต่อจากแถวสุดท้าย (deletedAt, id) เพราะหลายแถวลบในเวลาเดียวกันได้ */
const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) throw new AppError(400, 'invalid_cursor', 'cursor ไม่ถูกต้อง');
  return { at: date, id: id! };
}

/**
 * ถังขยะ (A41 · Z1–Z4) · อ่าน / กู้คืน / ลบถาวร งาน โปรเจกต์ และไฟล์ที่ยังไม่ครบ trash_days
 * ทุก query ของลูกค้าผ่าน TenantDb (RLS) · ใช้ SYSTEM_DB เฉพาะที่เขียนเหตุผลไว้
 */
@Injectable()
export class TrashService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly projects: ProjectsService,
    private readonly issues: IssuesService,
    private readonly limits: PlanLimits,
    private readonly events: EventBus,
  ) {}

  private isWsAdmin(tenant: TenantInfo) {
    return tenant.role === 'owner' || tenant.role === 'admin';
  }

  // ---------------------------------------------------------------------------
  // รายการ
  // ---------------------------------------------------------------------------

  /** Z1 · ถังขยะทั้ง Workspace (Owner / Admin) */
  async listWorkspace(auth: AuthInfo, tenant: TenantInfo, q: TrashQuery) {
    if (!this.isWsAdmin(tenant)) throw forbidden('workspace.trash');
    return this.db.run(auth, tenant, async (tx) => {
      let projectId: string | undefined;
      if (q.project) {
        const [p] = await tx.select({ id: s.projects.id }).from(s.projects).where(and(eq(s.projects.key, q.project), isNull(s.projects.deletedAt)));
        if (!p) throw new AppError(404, 'project_not_found', 'ไม่พบโปรเจกต์');
        projectId = p.id;
      }
      return this.list(tx, tenant, q, { projectId, workspace: true });
    });
  }

  /** Z4 · ถังขยะของโปรเจกต์ (สิทธิ์ project.trash) · มีเฉพาะงานและไฟล์ */
  async listProject(auth: AuthInfo, tenant: TenantInfo, key: string, q: TrashQuery) {
    if (tenant.role === 'guest') throw forbidden('project.trash');
    if (q.type === 'project') throw new AppError(400, 'invalid_type', 'ถังขยะของโปรเจกต์มีเฉพาะงานและไฟล์');
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.trash');
      const out = await this.list(tx, tenant, q, { projectId: project.id, workspace: false });
      return { ...out, project: { id: project.id, key: project.key, name: project.name } };
    });
  }

  private async list(tx: Tx, tenant: TenantInfo, q: TrashQuery, scope: { projectId?: string; workspace: boolean }) {
    const days = await trashDaysOf(tx);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const cursor = decodeCursor(q.cursor);
    const counts = {
      ...(scope.workspace ? { project: await this.countProjects(tx, cutoff) } : {}),
      issue: await this.countIssues(tx, cutoff, scope.projectId),
      file: await this.countFiles(tx, cutoff, scope.projectId),
    };

    let rows: { id: string; deletedAt: Date; deletedBy: string | null; [k: string]: unknown }[];
    if (q.type === 'project') rows = await this.projectRows(tx, tenant, cutoff, q, cursor);
    else if (q.type === 'issue') rows = await this.issueRows(tx, cutoff, q, cursor, scope.projectId);
    else rows = await this.fileRows(tx, cutoff, q, cursor, scope.projectId);

    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const people = await this.deleters(tx, await this.deleterIds(tx, cutoff, scope.projectId, scope.workspace));
    const items = page.map((r) => {
      const purgeAt = purgeAtOf(r.deletedAt, days);
      return { type: q.type, ...r, deletedBy: r.deletedBy ? (people.get(r.deletedBy) ?? null) : null, purgeAt, daysLeft: daysLeftOf(purgeAt) };
    });
    const batches = q.type === 'issue' ? await this.issueBatches(tx, cutoff, items as unknown as BatchInput[], people, scope.projectId) : [];
    const batchOf = new Map(batches.flatMap((b) => b.ids.map((id) => [id, b.id] as const)));
    return {
      type: q.type,
      trashDays: days,
      counts,
      items: items.map((i) => (q.type === 'issue' ? { ...i, batchId: batchOf.get(i.id) ?? null } : i)),
      batches,
      deleters: [...people.values()],
      projects: await this.projectsWithTrash(tx, cutoff, scope.projectId),
      nextCursor: more ? encodeCursor(page[page.length - 1]!.deletedAt, page[page.length - 1]!.id) : null,
      can: { restore: true, purge: tenant.role === 'owner' && scope.workspace },
    };
  }

  // งานที่แสดง = "ราก" ของการลบ: ไม่นับ Sub-task ที่ลบพร้อมแม่ (ลูกกู้คืนพร้อมแม่ตามของเดิมใน A03) และงานในโปรเจกต์ที่อยู่ในถังขยะ
  private issueScope(cutoff: Date, projectId?: string) {
    return and(
      isNotNull(s.issues.deletedAt),
      gt(s.issues.deletedAt, cutoff),
      isNull(s.projects.deletedAt),
      projectId ? eq(s.issues.projectId, projectId) : undefined,
      sql`not exists (select 1 from ${s.issues} p where p.id = ${s.issues.parentId} and p.deleted_at is not null)`,
    );
  }

  /**
   * ชุดคิดจากงานทั้งหมดในถังขยะของคนลบเดียวกันรอบช่วงเวลาของหน้านี้ ไม่ใช่แค่แถวในหน้า (หน้าละ 100)
   * ลบหลายร้อยงานพร้อมกันจาก Table ต้องเห็นเป็นชุดเดียวที่นับครบและกู้คืนได้ในครั้งเดียว (ผู้ใช้ลบ 536 งาน 2026-11-14)
   */
  private async issueBatches(tx: Tx, cutoff: Date, page: BatchInput[], people: Map<string, Deleter>, projectId?: string) {
    const mine = page.filter((i) => i.deletedBy);
    if (!mine.length) return [];
    const times = mine.map((i) => i.deletedAt.getTime());
    // เผื่อสองช่วงชุด: งานแรกของชุดอาจอยู่ก่อนงานเก่าสุดในหน้า
    const from = new Date(Math.min(...times) - 2 * BATCH_WINDOW_MS);
    const to = new Date(Math.max(...times) + 2 * BATCH_WINDOW_MS);
    const rows = await tx
      .select({
        id: s.issues.id,
        number: s.issues.number,
        deletedAt: s.issues.deletedAt,
        deletedBy: s.issues.deletedBy,
        projectId: s.projects.id,
        projectKey: s.projects.key,
        projectName: s.projects.name,
        subtasks: sql<number>`(select count(*)::int from ${s.issues} c where c.parent_id = ${s.issues.id} and c.deleted_at = ${s.issues.deletedAt})`,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(
        this.issueScope(cutoff, projectId),
        inArray(s.issues.deletedBy, [...new Set(mine.map((i) => i.deletedBy!.id))]),
        sql`${s.issues.deletedAt} between ${from.toISOString()}::timestamptz and ${to.toISOString()}::timestamptz`,
      ))
      .limit(BATCH_SCAN_MAX);
    const all: BatchInput[] = rows.map((r) => ({
      id: r.id,
      key: `${r.projectKey}-${r.number}`,
      deletedAt: r.deletedAt!,
      deletedBy: r.deletedBy ? (people.get(r.deletedBy) ?? null) : null,
      subtasks: r.subtasks,
      project: { id: r.projectId, key: r.projectKey, name: r.projectName },
    }));
    const onPage = new Set(page.map((i) => i.id));
    return batchesOf(all).filter((b) => b.ids.some((id) => onPage.has(id)));
  }

  private fileScope(cutoff: Date, projectId?: string) {
    return and(isNotNull(s.files.deletedAt), gt(s.files.deletedAt, cutoff), isNull(s.projects.deletedAt), projectId ? eq(s.files.projectId, projectId) : undefined);
  }

  private projectScope(cutoff: Date) {
    return and(isNotNull(s.projects.deletedAt), gt(s.projects.deletedAt, cutoff));
  }

  private async countIssues(tx: Tx, cutoff: Date, projectId?: string) {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.issues).innerJoin(s.projects, eq(s.projects.id, s.issues.projectId)).where(this.issueScope(cutoff, projectId));
    return r?.n ?? 0;
  }

  private async countFiles(tx: Tx, cutoff: Date, projectId?: string) {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.files).innerJoin(s.projects, eq(s.projects.id, s.files.projectId)).where(this.fileScope(cutoff, projectId));
    return r?.n ?? 0;
  }

  private async countProjects(tx: Tx, cutoff: Date) {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.projects).where(this.projectScope(cutoff));
    return r?.n ?? 0;
  }

  private after(col: { deletedAt: SQL | unknown; id: unknown }, cursor: { at: Date; id: string } | null) {
    if (!cursor) return undefined;
    return sql`(${col.deletedAt}, ${col.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
  }

  private async issueRows(tx: Tx, cutoff: Date, q: TrashQuery, cursor: { at: Date; id: string } | null, projectId?: string) {
    const keyMatch = q.q ? /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(q.q) : null;
    const text = q.q
      ? or(ilike(s.issues.title, `%${escapeLike(q.q)}%`), keyMatch ? and(eq(s.projects.key, keyMatch[1]!.toUpperCase()), eq(s.issues.number, Number(keyMatch[2]))) : undefined)
      : undefined;
    const rows = await tx
      .select({
        id: s.issues.id,
        number: s.issues.number,
        title: s.issues.title,
        deletedAt: s.issues.deletedAt,
        deletedBy: s.issues.deletedBy,
        projectId: s.projects.id,
        projectKey: s.projects.key,
        projectName: s.projects.name,
        subtasks: sql<number>`(select count(*)::int from ${s.issues} c where c.parent_id = ${s.issues.id} and c.deleted_at = ${s.issues.deletedAt})`,
      })
      .from(s.issues)
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(this.issueScope(cutoff, projectId), q.deletedBy ? eq(s.issues.deletedBy, q.deletedBy) : undefined, text, this.after({ deletedAt: s.issues.deletedAt, id: s.issues.id }, cursor)))
      .orderBy(desc(s.issues.deletedAt), desc(s.issues.id))
      .limit(q.limit + 1);
    return rows.map((r) => ({
      id: r.id,
      key: `${r.projectKey}-${r.number}`,
      title: r.title,
      project: { id: r.projectId, key: r.projectKey, name: r.projectName },
      subtasks: r.subtasks,
      deletedAt: r.deletedAt!,
      deletedBy: r.deletedBy,
    }));
  }

  private async fileRows(tx: Tx, cutoff: Date, q: TrashQuery, cursor: { at: Date; id: string } | null, projectId?: string) {
    const rows = await tx
      .select({
        id: s.files.id,
        name: s.files.name,
        kind: s.files.kind,
        mime: s.files.mime,
        deletedAt: s.files.deletedAt,
        deletedBy: s.files.deletedBy,
        projectId: s.projects.id,
        projectKey: s.projects.key,
        projectName: s.projects.name,
        folder: sql<string | null>`(select f.name from ${s.folders} f where f.id = ${s.files.folderId})`,
        sizeBytes: sql<number>`(select coalesce(sum(v.size_bytes), 0)::bigint from ${s.fileVersions} v where v.file_id = ${s.files.id})`,
      })
      .from(s.files)
      .innerJoin(s.projects, eq(s.projects.id, s.files.projectId))
      .where(and(this.fileScope(cutoff, projectId), q.deletedBy ? eq(s.files.deletedBy, q.deletedBy) : undefined, q.q ? ilike(s.files.name, `%${escapeLike(q.q)}%`) : undefined, this.after({ deletedAt: s.files.deletedAt, id: s.files.id }, cursor)))
      .orderBy(desc(s.files.deletedAt), desc(s.files.id))
      .limit(q.limit + 1);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      mime: r.mime,
      sizeBytes: Number(r.sizeBytes),
      folder: r.folder,
      project: { id: r.projectId, key: r.projectKey, name: r.projectName },
      deletedAt: r.deletedAt!,
      deletedBy: r.deletedBy,
    }));
  }

  private async projectRows(tx: Tx, tenant: TenantInfo, cutoff: Date, q: TrashQuery, cursor: { at: Date; id: string } | null) {
    const text = q.q ? or(ilike(s.projects.name, `%${escapeLike(q.q)}%`), ilike(s.projects.key, `%${escapeLike(q.q)}%`)) : undefined;
    const rows = await tx
      .select()
      .from(s.projects)
      .where(and(this.projectScope(cutoff), q.deletedBy ? eq(s.projects.deletedBy, q.deletedBy) : undefined, text, this.after({ deletedAt: s.projects.deletedAt, id: s.projects.id }, cursor)))
      .orderBy(desc(s.projects.deletedAt), desc(s.projects.id))
      .limit(q.limit + 1);
    const sizes = await this.projectSizes(tenant, rows.map((r) => r.id));
    const out = [];
    for (const p of rows) {
      out.push({
        id: p.id,
        key: p.key,
        name: p.name,
        color: p.color,
        archived: !!p.archivedAt,
        counts: sizes.get(p.id) ?? { issues: 0, files: 0, members: 0 },
        keyTaken: await this.keyTakenBy(tx, tenant, p.key, p.id),
        deletedAt: p.deletedAt!,
        deletedBy: p.deletedBy,
      });
    }
    return out;
  }

  /**
   * จำนวนงาน / ไฟล์ / สมาชิกของโปรเจกต์ในถังขยะ (Z2 "สิ่งที่กลับมา") · Owner / Admin ของ Workspace เห็นแถวโปรเจกต์ Private
   * ที่ยังไม่ได้เข้าร่วม แต่ RLS ซ่อนงานข้างใน จึงนับผ่าน SYSTEM_DB โดยกรอง Workspace และ id ตรง ๆ · ตอบแค่ตัวเลข ไม่เปิดเนื้อหา
   */
  private async projectSizes(tenant: TenantInfo, ids: string[]) {
    const map = new Map<string, { issues: number; files: number; members: number }>();
    if (!ids.length) return map;
    const rows = await this.system
      .select({
        id: s.projects.id,
        // select ตารางเดียว drizzle ไม่ใส่ชื่อตารางหน้าคอลัมน์ จึงอ้าง projects.id ตรง ๆ ใน subquery
        issues: sql<number>`(select count(*)::int from issues i where i.project_id = projects.id and i.deleted_at is null)`,
        files: sql<number>`(select count(*)::int from files f where f.project_id = projects.id and f.deleted_at is null)`,
        members: sql<number>`(select count(*)::int from project_members m where m.project_id = projects.id)`,
      })
      .from(s.projects)
      .where(and(eq(s.projects.workspaceId, tenant.workspaceId), inArray(s.projects.id, ids)));
    for (const r of rows) map.set(r.id, { issues: r.issues, files: r.files, members: r.members });
    return map;
  }

  /** โปรเจกต์ที่ใช้ Key นี้อยู่ · ชื่อแสดงเฉพาะเมื่อผู้เรียกมองเห็นโปรเจกต์นั้น (RLS) */
  private async keyTakenBy(tx: Tx, tenant: TenantInfo, key: string, exceptId: string) {
    if (await this.projects.keyFree(tenant.workspaceId, key, exceptId)) return null;
    const [live] = await tx.select({ key: s.projects.key, name: s.projects.name }).from(s.projects).where(and(eq(s.projects.key, key), isNull(s.projects.deletedAt)));
    return live ?? { key, name: null };
  }

  /** ผู้ลบทุกคนในขอบเขต (ตัวกรอง "ลบโดย") */
  private async deleterIds(tx: Tx, cutoff: Date, projectId: string | undefined, workspace: boolean) {
    const a = await tx.selectDistinct({ id: s.issues.deletedBy }).from(s.issues).innerJoin(s.projects, eq(s.projects.id, s.issues.projectId)).where(this.issueScope(cutoff, projectId));
    const b = await tx.selectDistinct({ id: s.files.deletedBy }).from(s.files).innerJoin(s.projects, eq(s.projects.id, s.files.projectId)).where(this.fileScope(cutoff, projectId));
    const c = workspace ? await tx.selectDistinct({ id: s.projects.deletedBy }).from(s.projects).where(this.projectScope(cutoff)) : [];
    return [...a, ...b, ...c].map((r) => r.id);
  }

  /** ชื่อและบทบาทใน Workspace ของผู้ลบ ("ดนัย (Admin)") */
  private async deleters(tx: Tx, ids: (string | null)[]) {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    const map = new Map<string, Deleter>();
    if (!want.length) return map;
    const rows = await tx
      .select({ id: s.users.id, displayName: s.users.displayName, avatarUrl: s.users.avatarUrl, role: s.workspaceMembers.role })
      .from(s.users)
      .leftJoin(s.workspaceMembers, eq(s.workspaceMembers.userId, s.users.id))
      .where(inArray(s.users.id, want));
    for (const r of rows) map.set(r.id, { id: r.id, displayName: r.displayName, initials: initials(r.displayName), avatarUrl: r.avatarUrl, role: r.role ?? null });
    return map;
  }

  /** โปรเจกต์ที่ยังใช้งานและมีงาน / ไฟล์ในถังขยะ (ตัวกรอง "ทุกโปรเจกต์") */
  private async projectsWithTrash(tx: Tx, cutoff: Date, projectId?: string) {
    if (projectId) return [];
    const a = await tx.selectDistinct({ id: s.projects.id, key: s.projects.key, name: s.projects.name }).from(s.issues).innerJoin(s.projects, eq(s.projects.id, s.issues.projectId)).where(this.issueScope(cutoff));
    const b = await tx.selectDistinct({ id: s.projects.id, key: s.projects.key, name: s.projects.name }).from(s.files).innerJoin(s.projects, eq(s.projects.id, s.files.projectId)).where(this.fileScope(cutoff));
    return [...new Map([...a, ...b].map((p) => [p.id, p])).values()].sort((x, y) => x.key.localeCompare(y.key));
  }

  // ---------------------------------------------------------------------------
  // กู้คืน
  // ---------------------------------------------------------------------------

  /**
   * กู้คืนงานหลายงาน (ชุด) ด้วย IssuesService.restore ทีละงาน · Sub-task ที่ลบพร้อมแม่กลับมาพร้อมกัน
   * ส่งงานเดียวแล้วไม่สำเร็จตอบ error ของงานนั้นตรง ๆ · หลายงานตอบผลรายงาน
   */
  async restoreIssues(auth: AuthInfo, tenant: TenantInfo, ids: string[]) {
    const rows = await this.db.run(auth, tenant, (tx) =>
      tx
        .select({ id: s.issues.id, number: s.issues.number, parentId: s.issues.parentId, key: s.projects.key, projectDeletedAt: s.projects.deletedAt })
        .from(s.issues)
        .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
        .where(inArray(s.issues.id, ids)),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    // แม่ก่อนลูก: Sub-task ที่ลบแยกไว้ก่อนแม่ต้องรอแม่กลับมาก่อน (409 parent_deleted)
    const order = [...new Set(ids)].sort((a, b) => Number(byId.get(a)?.parentId === b) - Number(byId.get(b)?.parentId === a));
    const restored: { id: string; key: string }[] = [];
    const failed: { id: string; key: string | null; code: string; message: string }[] = [];
    let lastError: AppError | null = null;
    for (const id of order) {
      const r = byId.get(id);
      const key = r ? `${r.key}-${r.number}` : null;
      try {
        if (!r) throw notFound('งานในถังขยะ');
        if (r.projectDeletedAt) throw new AppError(409, 'project_deleted', `โปรเจกต์ ${r.key} อยู่ในถังขยะ · กู้คืนโปรเจกต์ก่อน`);
        await this.issues.restore(auth, tenant, key!, { workspaceAdmin: this.isWsAdmin(tenant) });
        restored.push({ id, key: key! });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        lastError = err;
        failed.push({ id, key, code: err.code, message: err.message });
      }
    }
    if (ids.length === 1 && lastError) throw lastError;
    return { restored, failed };
  }

  /** กู้คืนไฟล์ · Owner / Admin ของ Workspace หรือผู้มีสิทธิ์ project.trash ในโปรเจกต์ของไฟล์ */
  async restoreFiles(auth: AuthInfo, tenant: TenantInfo, ids: string[]) {
    const restored: { id: string; name: string }[] = [];
    const failed: { id: string; name: string | null; code: string; message: string }[] = [];
    let lastError: AppError | null = null;
    for (const id of [...new Set(ids)]) {
      try {
        const name = await this.db.run(auth, tenant, async (tx) => {
          const [row] = await tx.select({ f: s.files, p: s.projects }).from(s.files).innerJoin(s.projects, eq(s.projects.id, s.files.projectId)).where(eq(s.files.id, id)).for('update', { of: s.files });
          if (!row) throw notFound('ไฟล์ในถังขยะ');
          const { f, p } = row;
          if (!this.isWsAdmin(tenant)) {
            if (tenant.role === 'guest') throw forbidden('project.trash');
            requirePerm(await projectAccess(tx, auth, tenant, p), 'project.trash');
          }
          if (p.deletedAt) throw new AppError(409, 'project_deleted', `โปรเจกต์ ${p.key} อยู่ในถังขยะ · กู้คืนโปรเจกต์ก่อน`);
          if (!f.deletedAt) return f.name;
          const purgeAt = purgeAtOf(f.deletedAt, await trashDaysOf(tx));
          if (purgeAt.getTime() <= Date.now()) throw new AppError(410, 'restore_expired', 'เลยกำหนดกู้คืนแล้ว', { restorableUntil: purgeAt });
          // โฟลเดอร์เดิมหายไปแล้ว → กลับไปที่ราก (เหมือน p/files/{id}/restore)
          const folder = f.folderId ? (await tx.select({ id: s.folders.id }).from(s.folders).where(eq(s.folders.id, f.folderId)))[0] : undefined;
          await tx.update(s.files).set({ deletedAt: null, ...(f.folderId && !folder ? { folderId: null } : {}) }).where(eq(s.files.id, f.id));
          await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'file.restored', targetType: 'file', targetId: f.id, summary: f.name });
          return f.name;
        });
        restored.push({ id, name });
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        lastError = err;
        failed.push({ id, name: null, code: err.code, message: err.message });
      }
    }
    if (ids.length === 1 && lastError) throw lastError;
    return { restored, failed };
  }

  /**
   * Z2 · กู้คืนโปรเจกต์ (สิทธิ์เท่าการลบ: Project Owner / Workspace Owner / Admin)
   * Key ถูกโปรเจกต์อื่นใช้แล้วตอบ 409 project_key_taken พร้อม Key ที่แนะนำ · ส่ง newKey แล้วเก็บ Key เดิมเป็น alias
   * เกินแพ็กเกจตอบ 402 ก่อนกู้ (ไม่กู้บางส่วน)
   */
  async restoreProject(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof RestoreProjectBody>) {
    if (!z.uuid().safeParse(id).success) throw notFound('โปรเจกต์ในถังขยะ');
    const events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const [p] = await tx.select().from(s.projects).where(eq(s.projects.id, id)).for('update');
      if (!p) throw notFound('โปรเจกต์ในถังขยะ');
      if (!this.isWsAdmin(tenant) && p.ownerUserId !== auth.userId) throw forbidden('project.owner');
      if (!p.deletedAt) throw new AppError(409, 'not_deleted', 'โปรเจกต์นี้ไม่ได้อยู่ในถังขยะ');
      const days = await trashDaysOf(tx);
      const purgeAt = purgeAtOf(p.deletedAt, days);
      if (purgeAt.getTime() <= Date.now()) throw new AppError(410, 'restore_expired', `เกินกำหนดกู้คืน ${days} วันแล้ว`, { restorableUntil: purgeAt });

      const free = (key: string) => this.projects.keyFree(tenant.workspaceId, key, p.id);
      let key = p.key;
      if (input.newKey && input.newKey !== p.key) {
        if (!(await free(input.newKey))) throw new AppError(409, 'key_taken', 'Project Key นี้มีใน Workspace แล้ว', { key: input.newKey, suggestedKey: await suggestKey(input.newKey, free) });
        key = input.newKey;
      } else if (!(await free(p.key))) {
        const takenBy = await this.keyTakenBy(tx, tenant, p.key, p.id);
        throw new AppError(409, 'project_key_taken', `Key ${p.key} ถูกใช้แล้ว · เลือก Key ใหม่ก่อนกู้คืน`, { key: p.key, takenBy, suggestedKey: await suggestKey(p.key, free) });
      }
      // โปรเจกต์ที่ Archive ไม่นับในแพ็กเกจ (Q2)
      if (!p.archivedAt) await this.limits.assert(tx, tenant.workspaceId, 'projects');

      await tx.update(s.projects).set({ deletedAt: null, key }).where(eq(s.projects.id, p.id));
      if (key !== p.key) await this.audit(tx, auth, tenant, 'project', p.id, 'project.key_changed', `${p.key} → ${key} (กู้คืนจากถังขยะ)`);
      await this.audit(tx, auth, tenant, 'project', p.id, 'project.restored_from_trash', `${key} · ${p.name}`);
      events.push({ type: 'project.restored_from_trash', workspaceId: tenant.workspaceId, projectId: p.id, actorId: auth.userId, data: { projectKey: key, oldKey: key !== p.key ? p.key : null, name: p.name }, at: new Date() });
      return { id: p.id, key, oldKey: key !== p.key ? p.key : null, name: p.name, restored: true };
    });
    if (result.oldKey) {
      // ลิงก์เดิม (MKT-12) พาไป Key ใหม่ · ถ้า Key ใหม่เคยเป็น alias ของโปรเจกต์นี้เองให้ลบทิ้ง (เหมือนเปลี่ยน Key ใน L2)
      // Admin ของ Workspace ที่ยังไม่ได้เข้าร่วมโปรเจกต์ Private เขียน alias ผ่าน RLS ไม่ได้ (policy ของตารางในโปรเจกต์)
      // ตรวจสิทธิ์กู้คืนแล้วข้างบน จึงเขียนด้วย SYSTEM_DB โดยกรอง Workspace + โปรเจกต์ หลัง commit
      await this.system.delete(s.projectKeyAliases).where(and(eq(s.projectKeyAliases.workspaceId, tenant.workspaceId), eq(s.projectKeyAliases.projectId, result.id), eq(s.projectKeyAliases.oldKey, result.key)));
      await this.system.insert(s.projectKeyAliases).values({ workspaceId: tenant.workspaceId, projectId: result.id, oldKey: result.oldKey }).onConflictDoNothing();
    }
    await this.events.publish(events);
    return result;
  }

  // ---------------------------------------------------------------------------
  // ลบถาวร (Z3)
  // ---------------------------------------------------------------------------

  /**
   * ลบถาวรทันที · Owner ของ Workspace เท่านั้น + พิมพ์ "ลบถาวร" · คืนพื้นที่ไฟล์
   * ลบได้เฉพาะรายการที่อยู่ในถังขยะ · งานลบพร้อม Sub-task ที่ลบพร้อมกัน (FK cascade)
   */
  async purge(auth: AuthInfo, tenant: TenantInfo, type: TrashType, ids: string[], confirm: string) {
    if (tenant.role !== 'owner') throw forbidden('workspace.owner');
    if (confirm !== PURGE_CONFIRM) throw new AppError(400, 'confirm_required', `พิมพ์ "${PURGE_CONFIRM}" เพื่อยืนยัน`, { fields: ['confirm'] });
    const unique = [...new Set(ids)];
    if (!unique.every((id) => z.uuid().safeParse(id).success)) throw notFound('รายการในถังขยะ');
    const { keys, labels } = await this.db.run(auth, tenant, async (tx) => {
      let found: { id: string; label: string }[] = [];
      let keys: string[] = [];
      if (type === 'issue') {
        const rows = await tx.select({ id: s.issues.id, number: s.issues.number, key: s.projects.key, deletedAt: s.issues.deletedAt }).from(s.issues).innerJoin(s.projects, eq(s.projects.id, s.issues.projectId)).where(inArray(s.issues.id, unique));
        found = rows.filter((r) => r.deletedAt).map((r) => ({ id: r.id, label: `${r.key}-${r.number}` }));
        if (found.length !== unique.length) throw notFound('งานในถังขยะ');
        await tx.delete(s.issues).where(and(inArray(s.issues.id, unique), isNotNull(s.issues.deletedAt)));
      } else if (type === 'file') {
        const rows = await tx.select({ id: s.files.id, name: s.files.name, deletedAt: s.files.deletedAt }).from(s.files).where(inArray(s.files.id, unique));
        found = rows.filter((r) => r.deletedAt).map((r) => ({ id: r.id, label: r.name }));
        if (found.length !== unique.length) throw notFound('ไฟล์ในถังขยะ');
        keys = (await tx.select({ key: s.fileVersions.storageKey }).from(s.fileVersions).where(inArray(s.fileVersions.fileId, unique))).map((r) => r.key);
        await tx.delete(s.files).where(and(inArray(s.files.id, unique), isNotNull(s.files.deletedAt)));
      } else {
        const rows = await tx.select({ id: s.projects.id, key: s.projects.key, name: s.projects.name, deletedAt: s.projects.deletedAt }).from(s.projects).where(inArray(s.projects.id, unique));
        found = rows.filter((r) => r.deletedAt).map((r) => ({ id: r.id, label: `${r.key} · ${r.name}` }));
        if (found.length !== unique.length) throw notFound('โปรเจกต์ในถังขยะ');
        // ไฟล์ของโปรเจกต์ Private ที่ Owner ยังไม่ได้เข้าร่วมถูก RLS ซ่อน · อ่าน key ของไฟล์ผ่าน SYSTEM_DB เพื่อลบในที่เก็บให้ครบ (กรอง Workspace + id)
        keys = (await this.system.select({ key: s.fileVersions.storageKey }).from(s.fileVersions).innerJoin(s.files, eq(s.files.id, s.fileVersions.fileId))
          .where(and(eq(s.files.workspaceId, tenant.workspaceId), inArray(s.files.projectId, unique)))).map((r) => r.key);
        await tx.delete(s.projects).where(and(inArray(s.projects.id, unique), isNotNull(s.projects.deletedAt)));
      }
      const names = { issue: 'งาน', file: 'ไฟล์', project: 'โปรเจกต์' }[type];
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action: 'trash.purged', targetType: type, targetId: found.length === 1 ? found[0]!.id : null,
        summary: `ลบถาวร${names} ${found.length} รายการ: ${found.map((f) => f.label).slice(0, 20).join(', ')}${found.length > 20 ? ' …' : ''}` });
      return { keys, labels: found };
    });
    await removeStoredObjects(keys);
    await this.events.publish({ type: 'trash.purged', workspaceId: tenant.workspaceId, actorId: auth.userId, data: { source: 'user', type, ids: labels.map((l) => l.id), count: labels.length }, at: new Date() });
    return { purged: labels.length, type, items: labels };
  }

  private async audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, targetType: string, targetId: string, action: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType, targetId, summary });
  }
}

function escapeLike(v: string) {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** งานที่ดึงมาจัดชุดต่อหน้า · มากกว่าที่ Table ลบได้ครั้งละ (2,000) เผื่อลบหลายรอบติดกัน */
const BATCH_SCAN_MAX = 5000;

interface BatchInput {
  id: string;
  key: string;
  deletedAt: Date;
  deletedBy: Deleter | null;
  subtasks: number;
  project: { id: string; key: string; name: string };
}

/**
 * "ชุด" = งานที่คนเดียวกันลบภายใน 2 นาทีนับจากงานแรกของชุด และมีอย่างน้อย 2 งาน (เลือกหลายแถวแล้วลบผิด · Z1)
 * คิดจากงานรอบช่วงเวลาของหน้าที่ส่งกลับ (issueBatches) ไม่ใช่เฉพาะแถวในหน้า
 */
export function batchesOf(items: BatchInput[]) {
  const sorted = [...items].filter((i) => i.deletedBy).sort((a, b) => a.deletedBy!.id.localeCompare(b.deletedBy!.id) || a.deletedAt.getTime() - b.deletedAt.getTime());
  const groups: BatchInput[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && g[0]!.deletedBy!.id === it.deletedBy!.id && it.deletedAt.getTime() - g[0]!.deletedAt.getTime() <= BATCH_WINDOW_MS) g.push(it);
    else groups.push([it]);
  }
  return groups
    .filter((g) => g.length >= 2)
    .map((g) => ({
      id: `${g[0]!.deletedBy!.id}:${g[0]!.deletedAt.getTime()}`,
      ids: g.map((i) => i.id),
      keys: g.map((i) => i.key),
      count: g.length,
      subtasks: g.reduce((n, i) => n + i.subtasks, 0),
      deletedBy: g[0]!.deletedBy,
      deletedAt: g[g.length - 1]!.deletedAt,
      projects: [...new Map(g.map((i) => [i.project.id, i.project])).values()],
    }))
    .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}
