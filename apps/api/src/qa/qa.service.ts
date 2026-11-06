import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { loadPeople } from '../common/people.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { EventBus } from '../core/events.js';
import { IssuesService } from '../issues/issues.service.js';
import { requirePerm } from '../projects/permissions.js';

const Id = z.uuid();
const isoDate = z.iso.date();

export const CreateTestRunBody = z
  .object({
    result: z.enum(['passed', 'failed', 'blocked']),
    passedCount: z.number().int().min(0).max(32767).optional(),
    totalCount: z.number().int().min(0).max(32767).optional(),
    environment: z.enum(['local', 'sit', 'uat', 'production']).optional(),
    commitSha: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/, 'commit ต้องเป็น hex 7–40 ตัว').optional(),
    note: z.string().trim().max(5000).optional(),
    /** ไฟล์หลักฐาน (id ใน Files ของโปรเจกต์เดียวกัน) ที่แนบกับรอบนี้ */
    fileIds: z.array(Id).max(20).default([]),
  })
  .refine((v) => (v.passedCount === undefined) === (v.totalCount === undefined), { path: ['totalCount'], message: 'ระบุ passedCount และ totalCount คู่กัน' })
  .refine((v) => v.passedCount === undefined || v.passedCount <= v.totalCount!, { path: ['passedCount'], message: 'passedCount ต้องไม่เกิน totalCount' });

export const CreateBugBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  severity: z.enum(['critical', 'major', 'minor']).default('major'),
  /** ประเภท Bug บังคับ Environment · ไม่ส่ง = ใช้ของรอบทดสอบ ถ้ารอบไม่ได้ระบุใช้ SIT */
  environment: z.enum(['local', 'sit', 'uat', 'production']).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  assigneeIds: z.array(Id).max(20).optional(),
  /** ขั้นตอนทำซ้ำ · ไม่ส่ง = ใช้บันทึกของผลทดสอบ */
  steps: z.string().trim().max(5000).optional(),
  description: z.string().max(50_000).optional(),
});

export const CreateTimeLogBody = z.object({
  date: isoDate.optional(),
  md: z.number().gt(0).max(3),
  note: z.string().trim().max(1000).optional(),
});

const ENV = { local: 'Local', sit: 'SIT', uat: 'UAT', production: 'Production' } as const;

/** ผลทดสอบ (หน้า D, K2, M4) และบันทึกเวลา (C, D) */
@Injectable()
export class QaService {
  constructor(
    private readonly db: TenantDb,
    private readonly issues: IssuesService,
    private readonly events: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // test-runs
  // ---------------------------------------------------------------------------
  private async runDto(tx: Tx, runs: Array<typeof s.testRuns.$inferSelect>, projectKey: string) {
    if (!runs.length) return [];
    const people = await loadPeople(tx, runs.map((r) => r.testerId));
    const att = await tx.select({ targetId: s.fileAttachments.targetId, fileId: s.fileAttachments.fileId, name: s.files.name }).from(s.fileAttachments).innerJoin(s.files, eq(s.files.id, s.fileAttachments.fileId)).where(and(eq(s.fileAttachments.targetType, 'test_run'), inArray(s.fileAttachments.targetId, runs.map((r) => r.id))));
    const bugs = await tx.select({ runId: s.issues.foundInTestRunId, number: s.issues.number, title: s.issues.title }).from(s.issues).where(inArray(s.issues.foundInTestRunId, runs.map((r) => r.id)));
    return runs.map((r) => ({
      id: r.id,
      runNo: r.runNo,
      result: r.result,
      passedCount: r.passedCount,
      totalCount: r.totalCount,
      environment: r.environment,
      commitSha: r.commitSha,
      note: r.note,
      tester: r.testerId ? (people.get(r.testerId) ?? null) : null,
      createdAt: r.createdAt,
      files: att.filter((a) => a.targetId === r.id).map((a) => ({ id: a.fileId, name: a.name })),
      bugs: bugs.filter((b) => b.runId === r.id).map((b) => ({ key: `${projectKey}-${b.number}`, title: b.title })),
    }));
  }

  async listRuns(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, issue } = await this.issues.loadIssue(tx, auth, tenant, key);
      const runs = await tx.select().from(s.testRuns).where(eq(s.testRuns.issueId, issue.id)).orderBy(desc(s.testRuns.runNo));
      const items = await this.runDto(tx, runs, project.key);
      return { items, latest: items[0] ?? null };
    });
  }

  async createRun(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof CreateTestRunBody>) {
    const out = await this.db.run(auth, tenant, async (tx) => {
      const { project, access, issue } = await this.issues.loadIssue(tx, auth, tenant, key);
      requirePerm(access, 'issue.record_test');
      if (access.guestViewer) throw forbidden('issue.record_test');
      if (project.archivedAt || project.status === 'archived') throw new AppError(403, 'project_archived', 'โปรเจกต์ที่เก็บถาวรแก้ไขไม่ได้');
      // เลขรอบเพิ่มเอง · ล็อกต่องาน กันสองคนบันทึกพร้อมกันได้เลขซ้ำ
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'test-run:' + issue.id}, 0))`);
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${s.testRuns.runNo}), 0)::int` }).from(s.testRuns).where(eq(s.testRuns.issueId, issue.id));
      const runNo = (last?.n ?? 0) + 1;
      if (runNo > 32767) throw new AppError(422, 'too_many_runs', 'งานนี้มีผลทดสอบมากเกินไป');
      const [run] = await tx
        .insert(s.testRuns)
        .values({ workspaceId: tenant.workspaceId, issueId: issue.id, runNo, result: body.result, passedCount: body.passedCount, totalCount: body.totalCount, environment: body.environment, commitSha: body.commitSha, note: body.note, testerId: auth.userId })
        .returning();
      if (body.fileIds.length) {
        const found = await tx.select({ id: s.files.id }).from(s.files).where(and(inArray(s.files.id, body.fileIds), eq(s.files.projectId, project.id)));
        if (found.length !== new Set(body.fileIds).size) throw new AppError(404, 'file_not_found', 'ไม่พบไฟล์หลักฐานบางไฟล์ในโปรเจกต์นี้');
        await tx.insert(s.fileAttachments).values(found.map((f) => ({ workspaceId: tenant.workspaceId, fileId: f.id, targetType: 'test_run' as const, targetId: run.id, createdBy: auth.userId }))).onConflictDoNothing();
      }
      await tx.insert(s.activities).values({ workspaceId: tenant.workspaceId, projectId: project.id, issueId: issue.id, actorId: auth.userId, actorKind: 'user', verb: 'test_run_recorded', field: 'test_run', newValue: { runNo, result: body.result } });
      const issueKey = `${project.key}-${issue.number}`;
      return { dto: (await this.runDto(tx, [run], project.key))[0]!, run, project, issue, issueKey };
    });
    if (body.result === 'failed') {
      await this.events.publish({
        type: 'test_run.failed',
        workspaceId: tenant.workspaceId,
        projectId: out.project.id,
        issueId: out.issue.id,
        actorId: auth.userId,
        data: { issueKey: out.issueKey, title: out.issue.title, runNo: out.run.runNo, passedCount: body.passedCount ?? null, totalCount: body.totalCount ?? null, environment: body.environment ?? null, commitSha: body.commitSha ?? null },
        at: new Date(),
      });
    }
    return out.dto;
  }

  /**
   * สร้าง Bug จากผลทดสอบที่ไม่ผ่าน/ติดขัด · งานระดับ Task → Bug เป็น Sub-task ของงานนั้น · เป็น Sub-task → Bug อยู่ใต้งานแม่เดียวกัน
   * สร้างผ่าน IssuesService.create จึงได้กติกา สิทธิ์ (`issue.create`), Event และการตรวจเดียวกับการสร้างงานปกติ
   */
  async createBug(auth: AuthInfo, tenant: TenantInfo, key: string, runId: string, body: z.infer<typeof CreateBugBody>) {
    if (!Id.safeParse(runId).success) throw notFound('ผลทดสอบ');
    const ctx = await this.db.run(auth, tenant, async (tx) => {
      const { project, issue } = await this.issues.loadIssue(tx, auth, tenant, key);
      const [run] = await tx.select().from(s.testRuns).where(and(eq(s.testRuns.id, runId), eq(s.testRuns.issueId, issue.id)));
      if (!run) throw notFound('ผลทดสอบ');
      if (run.result === 'passed') throw new AppError(409, 'run_passed', 'ผลทดสอบนี้ผ่านแล้ว สร้าง Bug ไม่ได้');
      const [parent] = issue.parentId ? await tx.select({ number: s.issues.number }).from(s.issues).where(eq(s.issues.id, issue.parentId)) : [];
      const assignees = await tx.select({ userId: s.issueAssignees.userId }).from(s.issueAssignees).where(eq(s.issueAssignees.issueId, issue.id)).orderBy(asc(s.issueAssignees.sort));
      const evidence = await tx.select({ fileId: s.fileAttachments.fileId }).from(s.fileAttachments).where(and(eq(s.fileAttachments.targetType, 'test_run'), eq(s.fileAttachments.targetId, run.id)));
      return { project, issue, run, parentKey: parent ? `${project.key}-${parent.number}` : `${project.key}-${issue.number}`, assignees: assignees.map((a) => a.userId), evidence: evidence.map((e) => e.fileId) };
    });
    const { project, issue, run } = ctx;
    const issueKey = `${project.key}-${issue.number}`;
    const steps = body.steps ?? run.note ?? '';
    const description =
      body.description ??
      [
        `พบจากผลทดสอบ ${issueKey} · รอบที่ ${run.runNo} (${run.result === 'failed' ? 'ไม่ผ่าน' : 'ติดขัด'})`,
        run.passedCount !== null ? `ผ่าน ${run.passedCount} จาก ${run.totalCount} ข้อ` : '',
        (body.environment ?? run.environment) ? `Environment: ${ENV[(body.environment ?? run.environment)!]}` : '',
        run.commitSha ? `Commit: ${run.commitSha}` : '',
        steps ? `\nขั้นตอนทำซ้ำ / รายละเอียด:\n${steps}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    const bug = await this.issues.create(auth, tenant, project.key, {
      type: 'Bug',
      parentKey: ctx.parentKey,
      title: body.title ?? `[${issueKey} รอบ ${run.runNo}] ${issue.title}`,
      description,
      priority: body.priority ?? (body.severity === 'critical' ? 'urgent' : body.severity === 'major' ? 'high' : 'medium'),
      assigneeIds: body.assigneeIds ?? ctx.assignees,
      severity: body.severity,
      environment: body.environment ?? run.environment ?? 'sit',
      details: { steps, foundInRun: run.runNo, testedIssue: issueKey, commitSha: run.commitSha },
      sharedWithGuests: false,
    });
    // ผูก Bug กับผลทดสอบ และคัดหลักฐานของรอบนั้นมาแนบกับ Bug (ไฟล์เดียวกัน ไม่ทำสำเนา)
    await this.db.run(auth, tenant, async (tx) => {
      await tx.update(s.issues).set({ foundInTestRunId: run.id }).where(eq(s.issues.id, bug.id));
      if (ctx.evidence.length) {
        await tx.insert(s.fileAttachments).values(ctx.evidence.map((fileId) => ({ workspaceId: tenant.workspaceId, fileId, targetType: 'issue' as const, targetId: bug.id, createdBy: auth.userId }))).onConflictDoNothing();
      }
    });
    return { ...bug, foundInTestRun: { id: run.id, runNo: run.runNo, issueKey }, attachedFiles: ctx.evidence.length };
  }

  // ---------------------------------------------------------------------------
  // time-logs
  // ---------------------------------------------------------------------------
  private async timeCtx(tx: Tx, auth: AuthInfo, tenant: TenantInfo, key: string, write: boolean) {
    const ctx = await this.issues.loadIssue(tx, auth, tenant, key);
    // โปรเจกต์ที่ปิด Time log ทำเหมือนไม่มีฟีเจอร์นี้
    if (!ctx.project.timeLogEnabled) throw new AppError(404, 'time_log_disabled', 'โปรเจกต์นี้ไม่ได้เปิดบันทึกเวลา');
    if (ctx.access.guestViewer) throw forbidden('issue.time_log');
    if (write) {
      requirePerm(ctx.access, 'issue.time_log');
      if (ctx.project.archivedAt || ctx.project.status === 'archived') throw new AppError(403, 'project_archived', 'โปรเจกต์ที่เก็บถาวรแก้ไขไม่ได้');
    }
    return ctx;
  }

  async listLogs(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue } = await this.timeCtx(tx, auth, tenant, key, false);
      const rows = await tx.select().from(s.timeLogs).where(eq(s.timeLogs.issueId, issue.id)).orderBy(desc(s.timeLogs.date), desc(s.timeLogs.createdAt));
      const people = await loadPeople(tx, rows.map((r) => r.userId));
      const by = new Map<string, number>();
      for (const r of rows) by.set(r.userId, (by.get(r.userId) ?? 0) + r.md);
      const round = (n: number) => Math.round(n * 100) / 100;
      return {
        items: rows.map((r) => ({ id: r.id, date: r.date, md: r.md, note: r.note, user: people.get(r.userId) ?? null, mine: r.userId === auth.userId, createdAt: r.createdAt })),
        totalMd: round(rows.reduce((n, r) => n + r.md, 0)),
        estimateMd: issue.estimateMd,
        byUser: [...by].map(([id, md]) => ({ user: people.get(id) ?? null, md: round(md) })).sort((a, b) => b.md - a.md),
      };
    });
  }

  async createLog(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof CreateTimeLogBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { issue } = await this.timeCtx(tx, auth, tenant, key, true);
      const date = body.date ?? today();
      if (date > today()) throw new AppError(400, 'invalid_input', 'บันทึกเวลาล่วงหน้าไม่ได้', { fields: [{ path: 'date', message: 'ต้องไม่เกินวันนี้' }] });
      // รวมของคนเดียวกันในวันเดียวกันของงานเดียวกันไม่เกิน 3 MD (24 ชม.) เหมือนวันหนึ่งมี 24 ชั่วโมงจริง
      const [sum] = await tx.select({ n: sql<number>`coalesce(sum(${s.timeLogs.md}), 0)::float8` }).from(s.timeLogs).where(and(eq(s.timeLogs.issueId, issue.id), eq(s.timeLogs.userId, auth.userId), eq(s.timeLogs.date, date)));
      if ((sum?.n ?? 0) + body.md > 3) throw new AppError(422, 'time_log_limit', 'บันทึกเวลาของวันนั้นรวมเกิน 3 MD (24 ชั่วโมง)', { loggedMd: sum?.n ?? 0 });
      const [row] = await tx.insert(s.timeLogs).values({ workspaceId: tenant.workspaceId, issueId: issue.id, userId: auth.userId, date, md: body.md, note: body.note }).returning();
      const people = await loadPeople(tx, [auth.userId]);
      return { id: row.id, date: row.date, md: row.md, note: row.note, user: people.get(auth.userId) ?? null, mine: true, createdAt: row.createdAt };
    });
  }

  /** ลบได้เฉพาะของตัวเอง (Admin ก็ลบของคนอื่นไม่ได้ เพราะเป็นบันทึกของผู้ทำงาน) */
  async deleteLog(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    if (!Id.safeParse(id).success) throw notFound('บันทึกเวลา');
    return this.db.run(auth, tenant, async (tx) => {
      const { issue } = await this.timeCtx(tx, auth, tenant, key, true);
      const [row] = await tx.select().from(s.timeLogs).where(and(eq(s.timeLogs.id, id), eq(s.timeLogs.issueId, issue.id)));
      if (!row) throw notFound('บันทึกเวลา');
      if (row.userId !== auth.userId) throw new AppError(403, 'forbidden', 'ลบได้เฉพาะบันทึกเวลาของตัวเอง', { permission: 'issue.time_log' });
      await tx.delete(s.timeLogs).where(eq(s.timeLogs.id, id));
      return { deleted: true };
    });
  }
}
