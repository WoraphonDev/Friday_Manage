import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { signToken, verifyToken } from '../auth/crypto.js';
import { AppError, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { PlanLimits } from '../core/plan-limits.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService, type ProjectRow } from '../projects/projects.service.js';
import { finalKeyOf, LocalStorage, MAX_FILE_BYTES, S3Storage, StagingGone, stagingKeyFor, type StorageDriver, UPLOAD_TTL_SECONDS } from './storage.js';

const Id = z.uuid();
const Name = z.string().trim().min(1).max(255).refine((v) => !/[\\/\0]/.test(v), 'ชื่อมี / \\ ไม่ได้');
const FolderId = z.union([Id, z.literal('root')]);

export const UploadUrlBody = z.object({
  name: Name,
  size: z.number().int().min(0),
  mime: z.string().trim().max(120).default('application/octet-stream'),
  /** เป้าหมายของไฟล์ใหม่ (ไม่ส่ง = รากของโปรเจกต์) */
  folderId: Id.nullish(),
  /** ส่งเมื่ออัปโหลดเป็นเวอร์ชันใหม่ของไฟล์เดิม */
  fileId: Id.optional(),
});
export const CreateFileBody = z.union([
  z.object({ uploadToken: z.string().min(10), note: z.string().trim().max(500).optional() }),
  z.object({ linkUrl: z.url().max(2000), name: Name.optional(), folderId: Id.nullish() }),
]);
export const VersionBody = z.object({ uploadToken: z.string().min(10), note: z.string().trim().max(500).optional() });
export const PatchFileBody = z.object({ name: Name, folderId: Id.nullable() }).partial().refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');
export const DeleteFileBody = z.object({ confirm: z.boolean().default(false) });
export const ListFilesQuery = z.object({
  folder: FolderId.optional(),
  uploader: Id.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'oldest', 'name', 'size']).default('newest'),
  /** งานที่ไฟล์แนบอยู่ เช่น `issue:DP-39` หรือ `test_run:<uuid>` */
  target: z.string().trim().max(80).optional(),
  trashed: z.stringbool().default(false),
});
export const AttachBody = z.object({ targetType: z.enum(['issue', 'test_run', 'comment', 'project', 'requirement']), target: z.string().trim().min(1).max(80).optional() });
export const FolderBody = z.object({ name: Name, parentId: Id.nullish() });
export const PatchFolderBody = z.object({ name: Name, parentId: Id.nullable() }).partial().refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');

const PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)figma\.com$/, 'figma'],
  [/(^|\.)(drive|docs)\.google\.com$/, 'google_drive'],
  [/(^|\.)notion\.(so|site)$/, 'notion'],
];

interface UploadClaims extends Record<string, unknown> {
  k: string;
  s: number;
  n: string;
  m: string;
  w: string;
  p: string;
  u: string;
  f?: string;
  d?: string | null;
}

/** หน้า 8 · Files และไฟล์แนบของงาน / ผลทดสอบ (C, D) */
@Injectable()
export class FilesService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly limits: PlanLimits,
    private readonly local: LocalStorage,
    private readonly s3: S3Storage,
  ) {}

  get driver(): StorageDriver {
    return process.env.S3_BUCKET ? this.s3 : this.local;
  }

  private async ctx(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, perm?: string) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    // Guest เห็นเฉพาะ Overview และ Timeline (04-permissions ข้อ 4)
    if (access.guestViewer || tenant.role === 'guest') throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });
    if (perm) requirePerm(access, perm);
    return { project, access };
  }

  // ---------------------------------------------------------------------------
  // อัปโหลด
  // ---------------------------------------------------------------------------
  async uploadUrl(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof UploadUrlBody>) {
    if (body.size > MAX_FILE_BYTES) throw new AppError(413, 'file_too_large', 'ไฟล์ใหญ่เกิน 100 MB', { maxBytes: MAX_FILE_BYTES, size: body.size });
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      if (body.fileId) await this.fileOf(tx, project, body.fileId, false);
      if (body.folderId) await this.folderOf(tx, project, body.folderId);
      // พื้นที่ไฟล์ของแพ็กเกจ → 402 (หน้า Q2)
      await this.limits.assert(tx, tenant.workspaceId, 'storage_bytes', body.size);
      // ลิงก์ PUT ชี้ไป staging เท่านั้น · ยืนยันแล้วย้ายไป key ถาวร (BUG-06)
      const storageKey = stagingKeyFor(`${tenant.workspaceId}/${project.id}/${randomUUID()}`);
      const target = await this.driver.presignUpload(storageKey, { size: body.size, mime: body.mime });
      const claims: UploadClaims = { k: storageKey, s: body.size, n: body.name, m: body.mime, w: tenant.workspaceId, p: project.id, u: auth.userId, ...(body.fileId ? { f: body.fileId } : {}), d: body.folderId ?? null };
      const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);
      return { ...target, uploadToken: signToken('file-upload', claims, 3600), expiresAt, maxBytes: MAX_FILE_BYTES, storage: this.driver.kind };
    });
  }

  /** ตรวจ uploadToken ว่าออกให้ผู้เรียกในโปรเจกต์นี้ */
  private claims(tenant: TenantInfo, auth: AuthInfo, project: ProjectRow, token: string, fileId?: string) {
    const c = verifyToken<UploadClaims>('file-upload', token);
    if (!c || c.w !== tenant.workspaceId || c.p !== project.id || c.u !== auth.userId || !finalKeyOf(c.k)) throw new AppError(400, 'invalid_upload_token', 'ลิงก์อัปโหลดไม่ถูกต้องหรือหมดอายุ · ขอใหม่แล้วอัปโหลดอีกครั้ง');
    if (fileId !== undefined && c.f !== fileId) throw new AppError(400, 'invalid_upload_token', 'ลิงก์อัปโหลดนี้ไม่ได้ออกให้เวอร์ชันของไฟล์นี้');
    return c;
  }

  /**
   * จองการยืนยัน upload ในธุรกรรมนี้ แล้วคืน key ถาวร
   * - ล็อกต่อ upload: token เดียวยืนยันได้ครั้งเดียว แม้ส่งพร้อมกัน (BUG-07)
   * - ล็อกพื้นที่ต่อ Workspace แล้วตรวจโควตาซ้ำ: URL หลายอันที่ออกจาก usage เดียวกันยืนยันเกินพื้นที่ไม่ได้ (BUG-08)
   * advisory lock ถือจนธุรกรรม commit คำขอถัดไปจึงเห็นแถว file_versions ที่เพิ่งบันทึก
   */
  private async reserve(tx: Tx, tenant: TenantInfo, c: UploadClaims) {
    const finalKey = finalKeyOf(c.k)!;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'file-upload:' + c.k}, 0))`);
    const [used] = await tx.select({ id: s.fileVersions.id }).from(s.fileVersions).where(eq(s.fileVersions.storageKey, finalKey));
    if (used) throw new AppError(409, 'upload_already_used', 'ไฟล์นี้ยืนยันไปแล้ว · ขอลิงก์อัปโหลดใหม่ถ้าต้องการเพิ่มอีกไฟล์');
    const st = await this.driver.stat(c.k);
    if (!st) throw new AppError(409, 'upload_incomplete', 'ยังไม่พบไฟล์ที่อัปโหลด · อัปโหลดให้เสร็จก่อนยืนยัน');
    if (st.size !== c.s) throw new AppError(409, 'upload_incomplete', 'ขนาดไฟล์ที่อัปโหลดไม่ตรงกับที่แจ้งไว้', { expected: c.s, actual: st.size });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'storage:' + tenant.workspaceId}, 0))`);
    await this.limits.assert(tx, tenant.workspaceId, 'storage_bytes', c.s);
    return finalKey;
  }

  /** ย้ายเนื้อหาไป key ถาวรหลังบันทึกแถวแล้ว · ล้ม = ธุรกรรมย้อนกลับ ไม่มีเวอร์ชันที่ชี้ไฟล์ซึ่งยังแก้ทับได้ */
  private async commitObject(c: UploadClaims, finalKey: string) {
    try {
      await this.driver.commit(c.k, finalKey);
    } catch (err) {
      if (err instanceof StagingGone) throw new AppError(409, 'upload_already_used', 'ไฟล์นี้ยืนยันไปแล้ว · ขอลิงก์อัปโหลดใหม่ถ้าต้องการเพิ่มอีกไฟล์');
      throw err;
    }
  }

  async create(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof CreateFileBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      if ('linkUrl' in body) {
        const u = new URL(body.linkUrl);
        if (u.protocol !== 'https:') throw new AppError(400, 'invalid_input', 'ลิงก์ต้องเป็น https', { fields: [{ path: 'linkUrl', message: 'ต้องเป็น https' }] });
        if (body.folderId) await this.folderOf(tx, project, body.folderId);
        const provider = PROVIDERS.find(([re]) => re.test(u.hostname))?.[1] ?? 'other';
        const [f] = await tx
          .insert(s.files)
          .values({ workspaceId: tenant.workspaceId, projectId: project.id, folderId: body.folderId ?? null, kind: 'link', name: body.name ?? u.hostname, linkUrl: body.linkUrl, linkProvider: provider, uploadedBy: auth.userId })
          .returning();
        await this.audit(tx, auth, tenant, 'file.link_added', f.id, f.name);
        return this.dtoOne(tx, project, f.id);
      }
      const c = this.claims(tenant, auth, project, body.uploadToken);
      if (c.f) throw new AppError(400, 'invalid_upload_token', 'โทเค็นนี้ใช้กับเวอร์ชันใหม่ (POST files/{id}/versions)');
      if (c.d) await this.folderOf(tx, project, c.d);
      const finalKey = await this.reserve(tx, tenant, c);
      const [f] = await tx
        .insert(s.files)
        .values({ workspaceId: tenant.workspaceId, projectId: project.id, folderId: c.d ?? null, kind: 'upload', name: c.n, mime: c.m, uploadedBy: auth.userId })
        .returning();
      await this.addVersion(tx, tenant, auth, f.id, 1, c, finalKey, body.note);
      await this.commitObject(c, finalKey);
      await this.audit(tx, auth, tenant, 'file.uploaded', f.id, f.name);
      return this.dtoOne(tx, project, f.id);
    });
  }

  private async addVersion(tx: Tx, tenant: TenantInfo, auth: AuthInfo, fileId: string, versionNo: number, c: UploadClaims, storageKey: string, note?: string) {
    const [v] = await tx.insert(s.fileVersions).values({ workspaceId: tenant.workspaceId, fileId, versionNo, storageKey, sizeBytes: c.s, note: note ?? null, uploadedBy: auth.userId }).returning();
    await tx.update(s.files).set({ currentVersionId: v.id }).where(eq(s.files.id, fileId));
    return v;
  }

  async createVersion(auth: AuthInfo, tenant: TenantInfo, key: string, fileId: string, body: z.infer<typeof VersionBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      const f = await this.fileOf(tx, project, fileId, false);
      if (f.kind !== 'upload') throw new AppError(400, 'link_file', 'ไฟล์ที่เป็นลิงก์ไม่มีเวอร์ชัน');
      const c = this.claims(tenant, auth, project, body.uploadToken, f.id);
      const finalKey = await this.reserve(tx, tenant, c);
      // ล็อกต่อไฟล์ กันสองคนอัปโหลดเวอร์ชันพร้อมกันได้เลขซ้ำ
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'file-version:' + f.id}, 0))`);
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${s.fileVersions.versionNo}), 0)::int` }).from(s.fileVersions).where(eq(s.fileVersions.fileId, f.id));
      await this.addVersion(tx, tenant, auth, f.id, (last?.n ?? 0) + 1, c, finalKey, body.note);
      await this.commitObject(c, finalKey);
      await this.audit(tx, auth, tenant, 'file.version_added', f.id, `${f.name} v${(last?.n ?? 0) + 1}`);
      return this.dtoOne(tx, project, f.id);
    });
  }

  // ---------------------------------------------------------------------------
  // อ่าน
  // ---------------------------------------------------------------------------
  private async fileOf(tx: Tx, project: ProjectRow, id: string, withDeleted: boolean) {
    if (!Id.safeParse(id).success) throw notFound('ไฟล์');
    const [f] = await tx.select().from(s.files).where(and(eq(s.files.id, id), eq(s.files.projectId, project.id), withDeleted ? undefined : isNull(s.files.deletedAt)));
    if (!f) throw notFound('ไฟล์');
    return f;
  }

  private async folderOf(tx: Tx, project: ProjectRow, id: string) {
    const [f] = await tx.select().from(s.folders).where(and(eq(s.folders.id, id), eq(s.folders.projectId, project.id)));
    if (!f) throw new AppError(404, 'folder_not_found', 'ไม่พบโฟลเดอร์');
    return f;
  }

  /** หลักฐาน = แนบกับผลทดสอบ หรือแนบกับ Bug · ลบแล้วหลักฐานในงานจะหาย (P3) */
  private async evidence(tx: Tx, fileIds: string[]) {
    if (!fileIds.length) return new Map<string, Array<{ targetType: string; ref: string }>>();
    const at = await tx.select().from(s.fileAttachments).where(inArray(s.fileAttachments.fileId, fileIds));
    const issueIds = at.filter((a) => a.targetType === 'issue').map((a) => a.targetId);
    const runIds = at.filter((a) => a.targetType === 'test_run').map((a) => a.targetId);
    const bugs = issueIds.length
      ? await tx.select({ id: s.issues.id, number: s.issues.number, key: s.projects.key }).from(s.issues).innerJoin(s.projects, eq(s.projects.id, s.issues.projectId)).innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId)).where(and(inArray(s.issues.id, issueIds), eq(s.issueTypes.name, 'Bug')))
      : [];
    const runs = runIds.length
      ? await tx.select({ id: s.testRuns.id, runNo: s.testRuns.runNo, number: s.issues.number, key: s.projects.key }).from(s.testRuns).innerJoin(s.issues, eq(s.issues.id, s.testRuns.issueId)).innerJoin(s.projects, eq(s.projects.id, s.issues.projectId)).where(inArray(s.testRuns.id, runIds))
      : [];
    const out = new Map<string, Array<{ targetType: string; ref: string }>>();
    for (const a of at) {
      const bug = bugs.find((b) => b.id === a.targetId);
      const run = runs.find((r) => r.id === a.targetId);
      const ref = a.targetType === 'issue' && bug ? { targetType: 'bug', ref: `${bug.key}-${bug.number}` } : a.targetType === 'test_run' && run ? { targetType: 'test_run', ref: `${run.key}-${run.number} · run ${run.runNo}` } : null;
      if (ref) out.set(a.fileId, [...(out.get(a.fileId) ?? []), ref]);
    }
    return out;
  }

  private async dtos(tx: Tx, project: ProjectRow, rows: Array<typeof s.files.$inferSelect>) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const versions = await tx.select().from(s.fileVersions).where(inArray(s.fileVersions.fileId, ids)).orderBy(desc(s.fileVersions.versionNo));
    const counts = await tx.select({ fileId: s.fileAttachments.fileId, n: sql<number>`count(*)::int` }).from(s.fileAttachments).where(inArray(s.fileAttachments.fileId, ids)).groupBy(s.fileAttachments.fileId);
    const evidence = await this.evidence(tx, ids);
    const people = await loadPeople(tx, rows.map((r) => r.uploadedBy));
    return rows.map((f) => {
      const vs = versions.filter((v) => v.fileId === f.id);
      const cur = vs.find((v) => v.id === f.currentVersionId) ?? vs[0];
      return {
        id: f.id,
        name: f.name,
        kind: f.kind,
        mime: f.mime,
        linkUrl: f.linkUrl,
        linkProvider: f.linkProvider,
        size: cur ? Number(cur.sizeBytes) : null,
        versionNo: cur?.versionNo ?? null,
        versionCount: vs.length,
        folderId: f.folderId,
        uploader: people.get(f.uploadedBy) ?? null,
        createdAt: f.createdAt,
        updatedAt: cur?.createdAt ?? f.createdAt,
        attachments: counts.find((c) => c.fileId === f.id)?.n ?? 0,
        evidence: (evidence.get(f.id)?.length ?? 0) > 0,
        deletedAt: f.deletedAt,
      };
    });
  }

  private async dtoOne(tx: Tx, project: ProjectRow, id: string) {
    const [f] = await tx.select().from(s.files).where(eq(s.files.id, id));
    return (await this.dtos(tx, project, [f!]))[0]!;
  }

  async list(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof ListFilesQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key);
      if (q.trashed) requirePerm(access, 'project.trash');
      let ids: string[] | undefined;
      if (q.target) {
        const [type, ref] = q.target.split(':');
        const targetId = await this.targetId(tx, project, type as 'issue', ref);
        ids = (await tx.select({ id: s.fileAttachments.fileId }).from(s.fileAttachments).where(and(eq(s.fileAttachments.targetType, type as 'issue'), eq(s.fileAttachments.targetId, targetId)))).map((r) => r.id);
      }
      const order = { newest: desc(s.files.createdAt), oldest: asc(s.files.createdAt), name: asc(s.files.name), size: desc(s.files.createdAt) }[q.sort];
      const rows = await tx
        .select()
        .from(s.files)
        .where(
          and(
            eq(s.files.projectId, project.id),
            q.trashed ? isNotNull(s.files.deletedAt) : isNull(s.files.deletedAt),
            // ค่าเริ่มต้นคือรากของโปรเจกต์ · folder=root ชัดเจน หรือ q / target ค้นทั้งโปรเจกต์
            q.folder && q.folder !== 'root' ? eq(s.files.folderId, q.folder) : q.folder === 'root' || (!q.q && !q.target && !q.trashed) ? isNull(s.files.folderId) : undefined,
            q.uploader ? eq(s.files.uploadedBy, q.uploader) : undefined,
            q.q ? ilike(s.files.name, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
            ids ? inArray(s.files.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']) : undefined,
          ),
        )
        .orderBy(order);
      let items = await this.dtos(tx, project, rows);
      if (q.sort === 'size') items = items.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      const crumbs: Array<{ id: string; name: string }> = [];
      let cur: Awaited<ReturnType<FilesService['folderOf']>> | undefined = q.folder && q.folder !== 'root' ? await this.folderOf(tx, project, q.folder) : undefined;
      while (cur) {
        crumbs.unshift({ id: cur.id, name: cur.name });
        cur = cur.parentId ? await this.folderOf(tx, project, cur.parentId) : undefined;
      }
      return { items, breadcrumb: crumbs, totalBytes: items.reduce((n, i) => n + (i.size ?? 0), 0) };
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key);
      const f = await this.fileOf(tx, project, id, access.perms.has('project.trash'));
      const versions = await tx.select().from(s.fileVersions).where(eq(s.fileVersions.fileId, f.id)).orderBy(desc(s.fileVersions.versionNo));
      const people = await loadPeople(tx, versions.map((v) => v.uploadedBy));
      const atts = await tx.select().from(s.fileAttachments).where(eq(s.fileAttachments.fileId, f.id));
      return {
        ...(await this.dtoOne(tx, project, f.id)),
        versions: versions.map((v) => ({ versionNo: v.versionNo, size: Number(v.sizeBytes), note: v.note, uploader: people.get(v.uploadedBy) ?? null, createdAt: v.createdAt, current: v.id === f.currentVersionId })),
        attachmentList: await this.attachmentRefs(tx, project, atts),
      };
    });
  }

  private async attachmentRefs(tx: Tx, project: ProjectRow, atts: Array<typeof s.fileAttachments.$inferSelect>) {
    const out = [];
    for (const a of atts) {
      let ref: string = a.targetId;
      if (a.targetType === 'issue') {
        const [i] = await tx.select({ number: s.issues.number }).from(s.issues).where(eq(s.issues.id, a.targetId));
        if (i) ref = `${project.key}-${i.number}`;
      } else if (a.targetType === 'project') ref = project.key;
      else if (a.targetType === 'requirement') {
        const [r] = await tx.select({ code: s.requirements.code }).from(s.requirements).where(eq(s.requirements.id, a.targetId));
        if (r) ref = r.code;
      }
      out.push({ id: a.id, targetType: a.targetType, target: ref, createdAt: a.createdAt });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // แก้ไข / ลบ / กู้คืน / ดาวน์โหลด
  // ---------------------------------------------------------------------------
  async patch(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof PatchFileBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      const f = await this.fileOf(tx, project, id, false);
      if (body.folderId) await this.folderOf(tx, project, body.folderId);
      await tx.update(s.files).set({ ...(body.name ? { name: body.name } : {}), ...(body.folderId !== undefined ? { folderId: body.folderId } : {}) }).where(eq(s.files.id, f.id));
      await this.audit(tx, auth, tenant, 'file.updated', f.id, body.name ? `${f.name} → ${body.name}` : f.name);
      return this.dtoOne(tx, project, f.id);
    });
  }

  /** ลบ = soft delete (คืนได้ภายใน trash_days ของ Workspace · ค่าเริ่มต้น 30 วัน) · หลักฐานของผลทดสอบ / Bug ต้องส่ง `confirm: true` */
  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof DeleteFileBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.delete');
      const f = await this.fileOf(tx, project, id, false);
      const ev = (await this.evidence(tx, [f.id])).get(f.id) ?? [];
      if (ev.length && !body.confirm) {
        throw new AppError(409, 'file_is_evidence', 'ไฟล์นี้เป็นหลักฐานของผลทดสอบหรือ Bug · ถ้าลบ หลักฐานในงานจะหาย · แนะนำให้อัปโหลดเวอร์ชันใหม่แทน', { evidence: ev, requiresConfirm: true });
      }
      await tx.update(s.files).set({ deletedAt: new Date() }).where(eq(s.files.id, f.id));
      await this.audit(tx, auth, tenant, 'file.deleted', f.id, f.name);
      const [ws] = await tx.select({ days: s.workspaceSettings.trashDays }).from(s.workspaceSettings);
      return { deleted: true, restorableUntil: new Date(Date.now() + (ws?.days ?? 30) * 86_400_000), evidence: ev };
    });
  }

  async restore(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'project.trash');
      const f = await this.fileOf(tx, project, id, true);
      if (!f.deletedAt) throw new AppError(409, 'not_deleted', 'ไฟล์นี้ไม่ได้อยู่ในถังขยะ');
      const [ws] = await tx.select({ days: s.workspaceSettings.trashDays }).from(s.workspaceSettings);
      const until = new Date(f.deletedAt.getTime() + (ws?.days ?? 30) * 86_400_000);
      if (until.getTime() < Date.now()) throw new AppError(410, 'restore_expired', 'เลยกำหนดกู้คืนแล้ว', { restorableUntil: until });
      // โฟลเดอร์เดิมหายไปแล้ว → กลับไปที่ราก
      const folder = f.folderId ? (await tx.select().from(s.folders).where(eq(s.folders.id, f.folderId)))[0] : undefined;
      await tx.update(s.files).set({ deletedAt: null, ...(f.folderId && !folder ? { folderId: null } : {}) }).where(eq(s.files.id, f.id));
      await this.audit(tx, auth, tenant, 'file.restored', f.id, f.name);
      return this.dtoOne(tx, project, f.id);
    });
  }

  /** URL หมดอายุใน 5 นาที · เว็บเรียกแล้ว redirect 302 */
  async download(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, version?: number) {
    const { f, v } = await this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key);
      const f = await this.fileOf(tx, project, id, false);
      if (f.kind !== 'upload') throw new AppError(400, 'link_file', 'ไฟล์นี้เป็นลิงก์ภายนอก', { linkUrl: f.linkUrl });
      const [v] = await tx.select().from(s.fileVersions).where(and(eq(s.fileVersions.fileId, f.id), version ? eq(s.fileVersions.versionNo, version) : eq(s.fileVersions.id, f.currentVersionId!)));
      if (!v) throw notFound('เวอร์ชันของไฟล์');
      return { f, v };
    });
    return this.driver.presignDownload(v.storageKey, { filename: f.name, mime: f.mime ?? 'application/octet-stream' });
  }

  // ---------------------------------------------------------------------------
  // ไฟล์แนบ
  // ---------------------------------------------------------------------------
  private async targetId(tx: Tx, project: ProjectRow, type: z.infer<typeof AttachBody>['targetType'], ref: string | undefined): Promise<string> {
    if (type === 'project') return project.id;
    if (!ref) throw new AppError(400, 'invalid_input', 'ต้องระบุ target', { fields: [{ path: 'target', message: 'จำเป็น' }] });
    if (type === 'issue') {
      const m = ref.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
      const [i] = m && m[1]!.toUpperCase() === project.key ? await tx.select({ id: s.issues.id }).from(s.issues).where(and(eq(s.issues.projectId, project.id), eq(s.issues.number, Number(m[2])), isNull(s.issues.deletedAt))) : [];
      if (!i) throw notFound('งาน');
      return i.id;
    }
    if (type === 'requirement') {
      const [r] = await tx.select({ id: s.requirements.id }).from(s.requirements).where(and(eq(s.requirements.projectId, project.id), eq(s.requirements.code, ref)));
      if (!r) throw notFound('Requirement');
      return r.id;
    }
    if (!Id.safeParse(ref).success) throw notFound('เป้าหมาย');
    if (type === 'test_run') {
      const [r] = await tx.select({ id: s.testRuns.id }).from(s.testRuns).innerJoin(s.issues, eq(s.issues.id, s.testRuns.issueId)).where(and(eq(s.testRuns.id, ref), eq(s.issues.projectId, project.id)));
      if (!r) throw notFound('ผลทดสอบ');
      return r.id;
    }
    const [c] = await tx.select({ id: s.comments.id }).from(s.comments).innerJoin(s.issues, eq(s.issues.id, s.comments.issueId)).where(and(eq(s.comments.id, ref), eq(s.issues.projectId, project.id), isNull(s.comments.deletedAt)));
    if (!c) throw notFound('คอมเมนต์');
    return c.id;
  }

  async attach(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof AttachBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      const f = await this.fileOf(tx, project, id, false);
      const targetId = await this.targetId(tx, project, body.targetType, body.target);
      const [row] = await tx.insert(s.fileAttachments).values({ workspaceId: tenant.workspaceId, fileId: f.id, targetType: body.targetType, targetId, createdBy: auth.userId }).onConflictDoNothing().returning();
      if (row) await this.audit(tx, auth, tenant, 'file.attached', f.id, `${f.name} → ${body.targetType}:${body.target ?? project.key}`);
      return { attached: !!row, file: await this.dtoOne(tx, project, f.id) };
    });
  }

  async detach(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof AttachBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      const f = await this.fileOf(tx, project, id, false);
      const targetId = await this.targetId(tx, project, body.targetType, body.target);
      const removed = await tx.delete(s.fileAttachments).where(and(eq(s.fileAttachments.fileId, f.id), eq(s.fileAttachments.targetType, body.targetType), eq(s.fileAttachments.targetId, targetId))).returning({ id: s.fileAttachments.id });
      if (!removed.length) throw notFound('ไฟล์แนบ');
      await this.audit(tx, auth, tenant, 'file.detached', f.id, `${f.name} ← ${body.targetType}:${body.target ?? project.key}`);
      return { detached: true };
    });
  }

  // ---------------------------------------------------------------------------
  // โฟลเดอร์
  // ---------------------------------------------------------------------------
  async folders(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key);
      const rows = await tx.select().from(s.folders).where(eq(s.folders.projectId, project.id)).orderBy(asc(s.folders.name));
      const counts = await tx.select({ folderId: s.files.folderId, n: sql<number>`count(*)::int` }).from(s.files).where(and(eq(s.files.projectId, project.id), isNull(s.files.deletedAt), isNotNull(s.files.folderId))).groupBy(s.files.folderId);
      const [root] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.files).where(and(eq(s.files.projectId, project.id), isNull(s.files.deletedAt), isNull(s.files.folderId)));
      return { rootFileCount: root?.n ?? 0, items: rows.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, fileCount: counts.find((c) => c.folderId === f.id)?.n ?? 0, createdAt: f.createdAt })) };
    });
  }

  private async checkParent(tx: Tx, project: ProjectRow, id: string | undefined, parentId: string | null | undefined) {
    if (!parentId) return;
    await this.folderOf(tx, project, parentId);
    // ย้ายโฟลเดอร์เข้าตัวเอง / ลูกหลานตัวเองไม่ได้ (วนเป็นวง)
    let cur: string | null = parentId;
    for (let i = 0; i < 50 && cur; i++) {
      if (cur === id) throw new AppError(409, 'folder_cycle', 'ย้ายโฟลเดอร์เข้าไปในตัวเองไม่ได้');
      cur = (await tx.select({ p: s.folders.parentId }).from(s.folders).where(eq(s.folders.id, cur)))[0]?.p ?? null;
    }
  }

  async createFolder(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof FolderBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      await this.checkParent(tx, project, undefined, body.parentId);
      const [f] = await tx.insert(s.folders).values({ workspaceId: tenant.workspaceId, projectId: project.id, parentId: body.parentId ?? null, name: body.name }).returning();
      return { id: f.id, name: f.name, parentId: f.parentId, fileCount: 0, createdAt: f.createdAt };
    });
  }

  async patchFolder(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof PatchFolderBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      const f = await this.folderOf(tx, project, id);
      await this.checkParent(tx, project, f.id, body.parentId);
      const [row] = await tx.update(s.folders).set(body).where(eq(s.folders.id, f.id)).returning();
      return { id: row.id, name: row.name, parentId: row.parentId };
    });
  }

  /** ลบโฟลเดอร์ได้เฉพาะที่ว่าง (ไม่มีไฟล์ — รวมไฟล์ในถังขยะ — และไม่มีโฟลเดอร์ย่อย) */
  async deleteFolder(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'file.upload');
      const f = await this.folderOf(tx, project, id);
      const [files] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.files).where(eq(s.files.folderId, f.id));
      const [subs] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.folders).where(eq(s.folders.parentId, f.id));
      if ((files?.n ?? 0) > 0 || (subs?.n ?? 0) > 0) throw new AppError(409, 'folder_not_empty', 'โฟลเดอร์นี้ยังมีไฟล์หรือโฟลเดอร์ย่อย · ย้ายหรือลบก่อน', { files: files?.n ?? 0, folders: subs?.n ?? 0 });
      await tx.delete(s.folders).where(eq(s.folders.id, f.id));
      return { deleted: true };
    });
  }

  private async audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, action: string, targetId: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType: 'file', targetId, summary });
  }
}

