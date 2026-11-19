import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError } from '../common/errors.js';
import { loadPeople, type Person } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { PlanLimits } from '../core/plan-limits.js';
import { requirePerm } from '../projects/permissions.js';
import { ProjectsService, type ProjectRow } from '../projects/projects.service.js';
import { Content, type DiagramContent, linkedIssueIds, MAX_CONTENT_BYTES, previewOf, starterContent } from './content.js';

/** ถือสิทธิ์แก้ได้นานเท่านี้หลังบันทึกหรือ heartbeat ครั้งล่าสุด (ปิดแท็บ / ลืมกดเสร็จสิ้น → คนอื่นแก้ต่อได้เอง) */
export const LOCK_MS = 5 * 60_000;

const Name = z.string().trim().min(1, 'ต้องตั้งชื่อ').max(120);
const Description = z.string().trim().max(500);
const Template = z.enum(s.DIAGRAM_TEMPLATES);

export const ListDiagramsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  template: Template.optional(),
  sort: z.enum(['updated', 'name', 'created']).default('updated'),
  /** Diagram ที่มีกล่องผูกกับงานนี้ (แผงรายละเอียดงาน) */
  issue: z.uuid().optional(),
});
export const CreateDiagramBody = z.object({ name: Name, description: Description.nullish(), template: Template.default('blank') });
export const PatchDiagramBody = z
  .object({ name: Name, description: Description.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'ต้องระบุค่าที่จะแก้');
export const SaveContentBody = z.object({ revision: z.number().int().min(0), content: z.unknown() });
export const LockBody = z.object({ takeover: z.boolean().default(false) });
export const IssueOptionsQuery = z.object({ q: z.string().trim().max(100).default('') });

type DiagramRow = typeof s.diagrams.$inferSelect;

/**
 * แท็บ Diagram (storyboard ที่ผู้ใช้อนุมัติ 2026-11-19)
 * - แก้ได้ทีละคน: ล็อกต่ออายุทุกครั้งที่บันทึก / heartbeat · Admin ของโปรเจกต์ "แก้ไขแทน" ได้
 * - ไม่มีประวัติเวอร์ชัน (มีแค่ undo ในหน้าเว็บ) · revision กันบันทึกทับหลังถูกแก้ไขแทน
 * - แพ็กเกจ Free ใช้ไม่ได้ (402 plan_feature_unavailable)
 */
@Injectable()
export class DiagramsService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly limits: PlanLimits,
  ) {}

  private async ctx(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, perm?: string) {
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    // Guest Viewer เห็นเฉพาะ Overview, Timeline และงานที่แชร์ (04-permissions ข้อ 4) เหมือน Files
    if (access.guestViewer) throw new AppError(403, 'guest_view_limited', 'Guest เห็นเฉพาะ Overview, Timeline และงานที่แชร์ให้', { allowed: ['overview', 'timeline'] });
    if (perm) requirePerm(access, perm);
    return { project, access };
  }

  /** cached ใช้กับ heartbeat / บันทึกอัตโนมัติที่ยิงถี่ (ตาม PlanLimits.current) · ทางอื่นอ่านสด ไม่ให้อัปเกรดแล้วยังติด 402 */
  private async feature(tenant: TenantInfo, cached = false) {
    await this.limits.assertFeature(tenant.workspaceId, 'diagrams', cached);
  }

  private async rowOf(tx: Tx, project: ProjectRow, id: string, opts: { trashed?: boolean } = {}) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'diagram_not_found', 'ไม่พบ Diagram นี้');
    const [row] = await tx
      .select()
      .from(s.diagrams)
      .where(and(eq(s.diagrams.id, id), eq(s.diagrams.projectId, project.id), opts.trashed ? isNotNull(s.diagrams.deletedAt) : isNull(s.diagrams.deletedAt)));
    if (!row) throw new AppError(404, 'diagram_not_found', 'ไม่พบ Diagram นี้ หรือถูกลบไปแล้ว');
    return row;
  }

  private lockOf(row: Pick<DiagramRow, 'lockedBy' | 'lockedUntil'>, people: Map<string, Person>, now = Date.now()) {
    if (!row.lockedBy || !row.lockedUntil || row.lockedUntil.getTime() <= now) return null;
    return { user: people.get(row.lockedBy) ?? null, userId: row.lockedBy, until: row.lockedUntil };
  }

  private perms(access: { perms: Set<string>; role: string | null; userId: string }, row?: Pick<DiagramRow, 'createdBy'>) {
    const edit = access.perms.has('diagram.edit');
    return {
      edit,
      takeover: access.perms.has('diagram.takeover'),
      delete: edit && (access.role === 'admin' || (!!row && row.createdBy === access.userId)),
    };
  }

  // ---------------------------------------------------------------------------
  // อ่าน
  // ---------------------------------------------------------------------------
  async list(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof ListDiagramsQuery>) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key);
      const where = [eq(s.diagrams.projectId, project.id), isNull(s.diagrams.deletedAt)];
      if (q.template) where.push(eq(s.diagrams.template, q.template));
      if (q.q) where.push(or(ilike(s.diagrams.name, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), ilike(sql`coalesce(${s.diagrams.description}, '')`, `%${q.q}%`))!);
      if (q.issue) where.push(sql`${s.diagrams.issueIds} @> ARRAY[${q.issue}]::uuid[]`);
      const order = q.sort === 'name' ? [asc(s.diagrams.name)] : q.sort === 'created' ? [desc(s.diagrams.createdAt)] : [desc(s.diagrams.updatedAt)];
      const rows = await tx
        .select({
          id: s.diagrams.id,
          name: s.diagrams.name,
          description: s.diagrams.description,
          template: s.diagrams.template,
          content: s.diagrams.content,
          issueIds: s.diagrams.issueIds,
          createdBy: s.diagrams.createdBy,
          updatedBy: s.diagrams.updatedBy,
          createdAt: s.diagrams.createdAt,
          updatedAt: s.diagrams.updatedAt,
          lockedBy: s.diagrams.lockedBy,
          lockedUntil: s.diagrams.lockedUntil,
        })
        .from(s.diagrams)
        .where(and(...where))
        .orderBy(...order)
        .limit(500);
      const people = await loadPeople(tx, rows.flatMap((r) => [r.createdBy, r.updatedBy, r.lockedBy]));
      const issues = await this.issueChips(tx, project, rows.flatMap((r) => r.issueIds));
      return {
        items: rows.map((r) => {
          const preview = previewOf(r.content);
          return {
            id: r.id,
            name: r.name,
            description: r.description,
            template: r.template,
            issueCount: r.issueIds.length,
            createdBy: people.get(r.createdBy) ?? null,
            updatedBy: (r.updatedBy && people.get(r.updatedBy)) || people.get(r.createdBy) || null,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            lock: this.lockOf(r, people),
            // สถานะงานของภาพย่อ (สีกรอบ) · ไม่ส่งชื่องานในรายการ
            preview: { ...preview, nodes: preview.nodes.map((n) => ({ ...n, i: undefined, s: n.i ? (issues.get(n.i)?.tone ?? null) : null })) },
          };
        }),
        permissions: this.perms(access),
      };
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key);
      const row = await this.rowOf(tx, project, id);
      return this.dto(tx, project, access, row);
    });
  }

  private async dto(tx: Tx, project: ProjectRow, access: { perms: Set<string>; role: string | null; userId: string }, row: DiagramRow) {
    const people = await loadPeople(tx, [row.createdBy, row.updatedBy, row.lockedBy]);
    const issues = await this.issueChips(tx, project, row.issueIds);
    const parsed = Content.safeParse(row.content);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      template: row.template,
      content: parsed.success ? parsed.data : { nodes: [], edges: [] },
      revision: row.revision,
      createdBy: people.get(row.createdBy) ?? null,
      updatedBy: (row.updatedBy && people.get(row.updatedBy)) || people.get(row.createdBy) || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lock: this.lockOf(row, people),
      lockMs: LOCK_MS,
      issues: Object.fromEntries(issues),
      permissions: this.perms(access, row),
    };
  }

  /**
   * สถานะงานที่ผูก (ชิปบนกล่อง) · ผ่าน RLS เหมือนหน้าอื่น
   * งานที่ลบแล้วแสดง "งานถูกลบแล้ว" · งานที่ RLS ไม่ให้เห็นไม่อยู่ใน map (หน้าเว็บแสดง "งานที่คุณไม่มีสิทธิ์ดู")
   */
  private async issueChips(tx: Tx, project: ProjectRow, ids: string[]) {
    const want = [...new Set(ids)];
    const out = new Map<string, { id: string; key: string; title: string; status: string; category: string; tone: string; dueDate: string | null; deleted: boolean }>();
    if (!want.length) return out;
    const rows = await tx
      .select({
        id: s.issues.id,
        number: s.issues.number,
        title: s.issues.title,
        planEnd: s.issues.planEnd,
        deletedAt: s.issues.deletedAt,
        status: s.workflowStatuses.name,
        category: s.workflowStatuses.category,
      })
      .from(s.issues)
      .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
      .where(and(inArray(s.issues.id, want), eq(s.issues.projectId, project.id)));
    const now = today();
    for (const r of rows) {
      const open = r.category !== 'done' && r.category !== 'cancelled';
      const overdue = open && !!r.planEnd && r.planEnd < now;
      out.set(r.id, {
        id: r.id,
        key: `${project.key}-${r.number}`,
        title: r.title,
        status: r.status,
        category: r.category,
        // สีกรอบกล่อง = สีสถานะเดียวกับป้ายสถานะทุกหน้า · เลยกำหนดชนะสถานะ
        tone: r.deletedAt ? 'deleted' : overdue ? 'overdue' : r.category,
        dueDate: r.planEnd,
        deleted: !!r.deletedAt,
      });
    }
    return out;
  }

  /** ช่อง "ผูกกับงาน" ค้นด้วยเลขงาน (39, DP-39) หรือชื่อ · เฉพาะงานในโปรเจกต์นี้ที่ยังไม่ลบ */
  async issueOptions(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof IssueOptionsQuery>) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key, 'diagram.edit');
      const where = [eq(s.issues.projectId, project.id), isNull(s.issues.deletedAt)];
      const num = /^(?:[a-z][a-z0-9]*-)?(\d{1,9})$/i.exec(q.q)?.[1];
      if (num) where.push(or(eq(s.issues.number, Number(num)), ilike(s.issues.title, `%${q.q}%`))!);
      else if (q.q) where.push(ilike(s.issues.title, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
      const rows = await tx
        .select({ id: s.issues.id, number: s.issues.number, title: s.issues.title, status: s.workflowStatuses.name, category: s.workflowStatuses.category, planEnd: s.issues.planEnd })
        .from(s.issues)
        .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
        .where(and(...where))
        .orderBy(num ? sql`${s.issues.number} = ${Number(num)} desc` : desc(s.issues.updatedAt), desc(s.issues.number))
        .limit(20);
      const assignees = rows.length
        ? await tx
            .select({ issueId: s.issueAssignees.issueId, userId: s.issueAssignees.userId })
            .from(s.issueAssignees)
            .where(inArray(s.issueAssignees.issueId, rows.map((r) => r.id)))
        : [];
      const people = await loadPeople(tx, assignees.map((a) => a.userId));
      const now = today();
      return {
        items: rows.map((r) => {
          const open = r.category !== 'done' && r.category !== 'cancelled';
          return {
            id: r.id,
            key: `${project.key}-${r.number}`,
            title: r.title,
            status: r.status,
            category: r.category,
            tone: open && r.planEnd && r.planEnd < now ? 'overdue' : r.category,
            assignee: people.get(assignees.find((a) => a.issueId === r.id)?.userId ?? '') ?? null,
          };
        }),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // สร้าง / แก้ชื่อ / ลบ
  // ---------------------------------------------------------------------------
  async create(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof CreateDiagramBody>) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, 'diagram.edit');
      // คนสร้างเข้าหน้าแก้ทันที จึงถือสิทธิ์แก้ไว้เลย
      const [row] = await tx
        .insert(s.diagrams)
        .values({
          workspaceId: tenant.workspaceId,
          projectId: project.id,
          name: body.name,
          description: body.description || null,
          template: body.template,
          content: starterContent(body.template),
          createdBy: auth.userId,
          updatedBy: auth.userId,
          lockedBy: auth.userId,
          lockedUntil: new Date(Date.now() + LOCK_MS),
        })
        .returning();
      await this.audit(tx, auth, tenant, project, 'diagram.created', row.id, `สร้าง Diagram "${row.name}"`);
      return this.dto(tx, project, access, row);
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof PatchDiagramBody>) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, 'diagram.edit');
      await this.rowOf(tx, project, id);
      // แก้ชื่อ / คำอธิบายไม่ต้องถือสิทธิ์แก้ภาพ และไม่นับเป็นการแก้ภาพ (ไม่เพิ่ม revision)
      const [row] = await tx
        .update(s.diagrams)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          updatedAt: new Date(),
          updatedBy: auth.userId,
        })
        .where(eq(s.diagrams.id, id))
        .returning();
      return this.dto(tx, project, access, row);
    });
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, 'diagram.edit');
      const row = await this.rowOf(tx, project, id);
      if (!this.perms(access, row).delete) throw new AppError(403, 'diagram_delete_own_only', 'ลบได้เฉพาะ Diagram ที่คุณสร้าง · Admin ของโปรเจกต์ลบได้ทุกอัน', { permission: 'diagram.edit' });
      const lock = this.lockOf(row, new Map());
      if (lock && lock.userId !== auth.userId && access.role !== 'admin') {
        const people = await loadPeople(tx, [lock.userId]);
        throw new AppError(409, 'diagram_locked', `${people.get(lock.userId)?.displayName ?? 'มีคน'} กำลังแก้ไข Diagram นี้อยู่ · ลบได้หลังแก้เสร็จ`, { lock: this.lockOf(row, people) });
      }
      // soft delete → ถังขยะ (trigger soft_delete ตั้ง deleted_by)
      await tx.update(s.diagrams).set({ deletedAt: new Date(), lockedBy: null, lockedUntil: null }).where(eq(s.diagrams.id, id));
      await this.audit(tx, auth, tenant, project, 'diagram.deleted', id, `ลบ Diagram "${row.name}"`);
      return { ok: true };
    });
  }

  async restore(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, 'project.trash');
      const row = await this.rowOf(tx, project, id, { trashed: true });
      const [restored] = await tx.update(s.diagrams).set({ deletedAt: null }).where(eq(s.diagrams.id, row.id)).returning();
      await this.audit(tx, auth, tenant, project, 'diagram.restored', id, `กู้คืน Diagram "${row.name}"`);
      return this.dto(tx, project, access, restored);
    });
  }

  // ---------------------------------------------------------------------------
  // ล็อก (แก้ทีละคน)
  // ---------------------------------------------------------------------------

  /** ขอ / ต่ออายุสิทธิ์แก้ · takeover = Admin แก้ไขแทนคนที่ถืออยู่ */
  async lock(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof LockBody>) {
    await this.feature(tenant, true);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, 'diagram.edit');
      const row = await this.rowOf(tx, project, id);
      // ตรวจสิทธิ์แก้ไขแทนเฉพาะตอนที่คนอื่นถืออยู่จริง · ของตัวเอง / ว่าง = ขอสิทธิ์ตามปกติ
      const held = this.lockOf(row, new Map());
      const takeover = body.takeover && !!held && held.userId !== auth.userId;
      if (takeover) requirePerm(access, 'diagram.takeover');
      const until = new Date(Date.now() + LOCK_MS);
      const free = sql`(${s.diagrams.lockedBy} IS NULL OR ${s.diagrams.lockedBy} = ${auth.userId} OR ${s.diagrams.lockedUntil} <= now())`;
      const [updated] = await tx
        .update(s.diagrams)
        .set({ lockedBy: auth.userId, lockedUntil: until })
        .where(and(eq(s.diagrams.id, id), takeover ? sql`true` : free))
        .returning();
      if (!updated) {
        const [current] = await tx.select().from(s.diagrams).where(eq(s.diagrams.id, id));
        const people = await loadPeople(tx, [current?.lockedBy]);
        const lock = current ? this.lockOf(current, people) : null;
        throw new AppError(409, 'diagram_locked', `${lock?.user?.displayName ?? 'มีคน'} กำลังแก้ไข Diagram นี้อยู่ · คุณดูได้อย่างเดียว`, { lock });
      }
      if (takeover && held) {
        const people = await loadPeople(tx, [held.userId]);
        await this.audit(tx, auth, tenant, project, 'diagram.takeover', id, `แก้ไขแทน ${people.get(held.userId)?.displayName ?? 'ผู้ใช้'} ใน Diagram "${row.name}"`);
      }
      return this.dto(tx, project, access, updated);
    });
  }

  async unlock(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.feature(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await this.ctx(tx, auth, tenant, key);
      await this.rowOf(tx, project, id);
      // ปล่อยได้เฉพาะของตัวเอง · ของคนอื่นถือว่าปล่อยแล้ว (เช่น ถูกแก้ไขแทนไปก่อน)
      await tx
        .update(s.diagrams)
        .set({ lockedBy: null, lockedUntil: null })
        .where(and(eq(s.diagrams.id, id), eq(s.diagrams.lockedBy, auth.userId)));
      return { ok: true };
    });
  }

  /** บันทึกภาพ (หน้าเว็บบันทึกอัตโนมัติหลังหยุดแก้) · ต้องถือสิทธิ์แก้ หรือสิทธิ์หมดอายุแล้วและยังไม่มีใครรับต่อ */
  async save(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, body: z.infer<typeof SaveContentBody>) {
    await this.feature(tenant, true);
    const content = this.parseContent(body.content);
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.ctx(tx, auth, tenant, key, 'diagram.edit');
      await this.rowOf(tx, project, id);
      const issueIds = linkedIssueIds(content);
      await this.assertIssues(tx, project, issueIds);
      const mine = sql`(${s.diagrams.lockedBy} = ${auth.userId} OR ${s.diagrams.lockedBy} IS NULL OR ${s.diagrams.lockedUntil} <= now())`;
      const [updated] = await tx
        .update(s.diagrams)
        .set({
          content,
          issueIds,
          revision: sql`${s.diagrams.revision} + 1`,
          updatedAt: new Date(),
          updatedBy: auth.userId,
          lockedBy: auth.userId,
          lockedUntil: new Date(Date.now() + LOCK_MS),
        })
        .where(and(eq(s.diagrams.id, id), eq(s.diagrams.revision, body.revision), mine))
        .returning();
      if (!updated) {
        const [current] = await tx.select().from(s.diagrams).where(eq(s.diagrams.id, id));
        const people = await loadPeople(tx, [current?.lockedBy, current?.updatedBy]);
        const lock = current ? this.lockOf(current, people) : null;
        if (lock && lock.userId !== auth.userId) {
          throw new AppError(409, 'diagram_locked', `${lock.user?.displayName ?? 'มีคน'} แก้ไขแทนแล้ว · สิ่งที่คุณบันทึกไว้ก่อนหน้านี้ยังอยู่ครบ`, { lock });
        }
        throw new AppError(409, 'diagram_conflict', 'Diagram นี้ถูกแก้จากที่อื่นหลังคุณเปิด · โหลดใหม่ก่อนแก้ต่อ', { revision: current?.revision ?? null });
      }
      return { revision: updated.revision, updatedAt: updated.updatedAt, lock: { userId: auth.userId, until: updated.lockedUntil }, issues: Object.fromEntries(await this.issueChips(tx, project, issueIds)) };
    });
  }

  private parseContent(raw: unknown): DiagramContent {
    if (JSON.stringify(raw ?? null).length > MAX_CONTENT_BYTES) throw new AppError(413, 'diagram_too_large', 'Diagram ใหญ่เกิน 1 MB · แยกเป็นหลาย Diagram');
    return parse(Content, raw);
  }

  /** งานที่ผูกต้องอยู่ในโปรเจกต์นี้และยังไม่ถูกลบ (งานที่ถูกลบหลังผูกไว้แล้วยังคงผูกต่อได้ แสดงเป็น "งานถูกลบแล้ว") */
  private async assertIssues(tx: Tx, project: ProjectRow, ids: string[]) {
    if (!ids.length) return;
    const rows = await tx
      .select({ id: s.issues.id })
      .from(s.issues)
      .where(and(inArray(s.issues.id, ids), eq(s.issues.projectId, project.id)));
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((x) => !found.has(x));
    if (missing.length) throw new AppError(422, 'diagram_issue_not_found', 'กล่องผูกกับงานที่ไม่อยู่ในโปรเจกต์นี้', { issueIds: missing });
  }

  private async audit(tx: Tx, auth: AuthInfo, tenant: TenantInfo, project: ProjectRow, action: string, targetId: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType: 'diagram', targetId, summary: `${project.key} · ${summary}` });
  }
}
