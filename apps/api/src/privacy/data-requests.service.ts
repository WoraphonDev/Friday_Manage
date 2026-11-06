import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { today } from '../common/dates.js';
import { AppError, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { addDays } from '../projects/calendar.js';
import { buildSubjectBundle } from './build-export.js';
import { assertAdmin, audit } from './shared.js';

const s = schema;
/** PDPA: ตอบคำขอภายใน 30 วัน */
const DUE_DAYS = 30;
const resultPath = (id: string) => join(config.uploadDir, 'privacy', `${id}.json`);

export const CreateRequestBody = z.object({ requesterEmail: z.email().max(254), requestType: z.enum(['erase', 'export']) });
export const ListQuery = z.object({ status: z.enum(['pending', 'in_progress', 'completed', 'rejected', 'open', 'all']).default('all') });
export const PatchRequestBody = z.object({ status: z.enum(['pending', 'in_progress', 'rejected']) }).strict();
export const CompleteBody = z.object({ confirmEmail: z.email().optional() }).strict();

type Row = typeof s.dataSubjectRequests.$inferSelect;
const ERASED_NAME = 'ผู้ใช้ที่ถูกลบ';

/** คำขอจากเจ้าของข้อมูล (PDPA) · N1 */
@Injectable()
export class DataRequestsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly sys: Db,
  ) {}

  async list(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof ListQuery>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const where = q.status === 'all' ? undefined : q.status === 'open' ? ne(s.dataSubjectRequests.status, 'completed') : eq(s.dataSubjectRequests.status, q.status);
      const rows = await tx.select().from(s.dataSubjectRequests).where(where).orderBy(asc(s.dataSubjectRequests.dueDate), asc(s.dataSubjectRequests.createdAt));
      const people = await loadPeople(tx, rows.map((r) => r.handledBy));
      return { items: rows.map((r) => this.dto(r, people.get(r.handledBy ?? '') ?? null)) };
    });
  }

  /** บันทึกคำขอที่ได้รับ (อีเมล / ฟอร์ม) · ครบกำหนดใน 30 วัน */
  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateRequestBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const email = input.requesterEmail.trim().toLowerCase();
      const [dup] = await tx.select({ id: s.dataSubjectRequests.id }).from(s.dataSubjectRequests).where(and(sql`lower(${s.dataSubjectRequests.requesterEmail}) = ${email}`, eq(s.dataSubjectRequests.requestType, input.requestType), ne(s.dataSubjectRequests.status, 'completed'), ne(s.dataSubjectRequests.status, 'rejected')));
      if (dup) throw new AppError(409, 'data_request_exists', 'มีคำขอประเภทเดียวกันของอีเมลนี้ที่ยังไม่เสร็จ', { id: dup.id });
      const [row] = await tx.insert(s.dataSubjectRequests).values({ workspaceId: tenant.workspaceId, requesterEmail: email, requestType: input.requestType, dueDate: addDays(today(), DUE_DAYS) }).returning();
      await audit(tx, auth, tenant, 'data', 'data_request.created', `รับคำขอ${input.requestType === 'erase' ? 'ลบข้อมูล' : 'สำเนาข้อมูล'} ของ ${email}`, { type: 'data_subject_request', id: row.id });
      return this.dto(row, null);
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof PatchRequestBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.find(tx, id);
      if (cur.status === 'completed') throw new AppError(409, 'data_request_completed', 'คำขอนี้เสร็จแล้ว แก้ไม่ได้');
      const [row] = await tx.update(s.dataSubjectRequests).set({ status: input.status, handledBy: auth.userId, updatedAt: new Date() }).where(eq(s.dataSubjectRequests.id, cur.id)).returning();
      await audit(tx, auth, tenant, 'data', 'data_request.updated', `คำขอของ ${row.requesterEmail} → ${input.status}`, { type: 'data_subject_request', id: row.id });
      return this.dto(row, (await loadPeople(tx, [auth.userId])).get(auth.userId) ?? null);
    });
  }

  /**
   * ปิดคำขอ · export = สร้างสำเนาข้อมูลของเจ้าของ (ดาวน์โหลดที่ `.../result`)
   * erase = ถอนเขาออกจาก Workspace นี้ และทำให้บัญชีเป็นนิรนามถ้าไม่มี Workspace อื่นแล้ว (ต้องยืนยันอีเมลซ้ำ)
   */
  async complete(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof CompleteBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.find(tx, id);
      if (cur.status === 'completed') throw new AppError(409, 'data_request_completed', 'คำขอนี้เสร็จแล้ว');
      if (cur.requestType === 'erase' && input.confirmEmail?.toLowerCase() !== cur.requesterEmail.toLowerCase()) {
        throw new AppError(400, 'confirm_required', 'การลบข้อมูลย้อนกลับไม่ได้ · ส่ง confirmEmail เป็นอีเมลของผู้ขอเพื่อยืนยัน', { requesterEmail: cur.requesterEmail });
      }
      // หาตัวผู้ขอ: ผู้ใช้ทั้งระบบ (users ไม่ผูก Workspace) จึงอ่านด้วย SYSTEM_DB เฉพาะอีเมลนี้
      const [user] = await this.sys.select({ id: s.users.id }).from(s.users).where(sql`lower(${s.users.email}) = ${cur.requesterEmail.toLowerCase()}`);
      const [member] = user ? await tx.select().from(s.workspaceMembers).where(eq(s.workspaceMembers.userId, user.id)) : [];
      let result: Record<string, unknown> = { found: !!member };

      if (cur.requestType === 'export' && user && member) {
        const bundle = await buildSubjectBundle(tx, tenant.workspaceId, user.id);
        await mkdir(join(config.uploadDir, 'privacy'), { recursive: true });
        await writeFile(resultPath(cur.id), JSON.stringify(bundle, null, 2));
        result = { found: true, file: true };
      }
      if (cur.requestType === 'erase' && user && member) {
        if (member.role === 'owner') {
          const [owners] = await tx.select({ n: count() }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active')));
          if (owners.n <= 1) throw new AppError(409, 'last_owner', 'ผู้ขอเป็น Owner คนเดียวของ Workspace · โอนความเป็น Owner ก่อน');
        }
        await tx.delete(s.teamMembers).where(eq(s.teamMembers.userId, user.id));
        await tx.delete(s.projectMembers).where(eq(s.projectMembers.userId, user.id));
        await tx.delete(s.issueWatchers).where(eq(s.issueWatchers.userId, user.id));
        await tx.delete(s.notifications).where(eq(s.notifications.recipientId, user.id));
        await tx.update(s.workspaceMembers).set({ status: 'deactivated', jobTitle: null, department: null }).where(eq(s.workspaceMembers.userId, user.id));
        result = { found: true, removedFromWorkspace: true, anonymized: await this.anonymizeIfOrphan(user.id, tenant.workspaceId) };
      }

      const [row] = await tx.update(s.dataSubjectRequests).set({ status: 'completed', completedAt: new Date(), handledBy: auth.userId, updatedAt: new Date() }).where(eq(s.dataSubjectRequests.id, cur.id)).returning();
      await audit(tx, auth, tenant, 'data', `data_request.${cur.requestType === 'erase' ? 'erased' : 'exported'}`, `ปิดคำขอ${cur.requestType === 'erase' ? 'ลบข้อมูล' : 'สำเนาข้อมูล'} ของ ${cur.requesterEmail} · ${JSON.stringify(result)}`, { type: 'data_subject_request', id: row.id });
      return { ...this.dto(row, (await loadPeople(tx, [auth.userId])).get(auth.userId) ?? null), result };
    });
  }

  async result(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    const row = await this.db.run(auth, tenant, async (tx) => {
      const r = await this.find(tx, id);
      if (r.status !== 'completed' || r.requestType !== 'export') throw new AppError(409, 'result_not_available', 'ไม่มีไฟล์ผลลัพธ์ของคำขอนี้');
      await audit(tx, auth, tenant, 'data', 'data_request.result_downloaded', `ดาวน์โหลดสำเนาข้อมูลของ ${r.requesterEmail}`, { type: 'data_subject_request', id: r.id });
      return r;
    });
    const info = await stat(resultPath(row.id)).catch(() => null);
    if (!info) throw new AppError(409, 'result_not_available', 'ไม่พบผู้ขอใน Workspace นี้ จึงไม่มีข้อมูลให้ส่งออก');
    return { stream: createReadStream(resultPath(row.id)), size: info.size, filename: `data-request-${row.id.slice(0, 8)}.json` };
  }

  // ---------------------------------------------------------------------------

  /** ผู้ใช้ที่ไม่มี Workspace อื่นที่ยังใช้งานอยู่: ลบข้อมูลส่วนตัวในบัญชี (ใช้ SYSTEM_DB เพราะ users / sessions เป็นของทั้งระบบ ไม่ผูก Workspace) */
  private async anonymizeIfOrphan(userId: string, workspaceId: string) {
    const [others] = await this.sys.select({ n: count() }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.userId, userId), eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.workspaceId, workspaceId)));
    if (others.n > 0) return false;
    await this.sys.update(s.users).set({ email: `erased-${userId}@invalid.example`, displayName: ERASED_NAME, firstName: null, lastName: null, phone: null, about: null, avatarUrl: null, passwordHash: null, disabledAt: new Date(), updatedAt: new Date() }).where(eq(s.users.id, userId));
    await this.sys.delete(s.userSessions).where(eq(s.userSessions.userId, userId));
    await this.sys.delete(s.userIdentities).where(eq(s.userIdentities.userId, userId));
    await this.sys.delete(s.mfaFactors).where(eq(s.mfaFactors.userId, userId));
    await this.sys.delete(s.authTokens).where(eq(s.authTokens.userId, userId));
    return true;
  }

  private async find(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('คำขอ');
    const [r] = await tx.select().from(s.dataSubjectRequests).where(eq(s.dataSubjectRequests.id, id));
    if (!r) throw notFound('คำขอ');
    return r;
  }

  private dto(r: Row, handledBy: unknown) {
    const daysLeft = Math.round((Date.parse(r.dueDate) - Date.parse(today())) / 86_400_000);
    return { id: r.id, requesterEmail: r.requesterEmail, requestType: r.requestType, status: r.status, dueDate: r.dueDate, daysLeft, overdue: r.status !== 'completed' && r.status !== 'rejected' && daysLeft < 0, handledBy, completedAt: r.completedAt, createdAt: r.createdAt, hasResult: r.status === 'completed' && r.requestType === 'export' };
  }
}
