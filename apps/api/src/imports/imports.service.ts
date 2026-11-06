import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { today } from '../common/dates.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { WorkCalendar } from '../projects/calendar.js';
import { requirePerm } from '../projects/permissions.js';
import { projectKey, ProjectsService } from '../projects/projects.service.js';
import { type ParsedWorkbook, readPlanWorkbook } from './excel.js';
import { applyUpdate, computeUpdate, statusNames, type UpdateDiff, type UpdatePlan } from './update.js';
import { buildPlanXlsx } from './export.js';
import { autoMap, type CheckOptions, checkPlan, type ColumnMapping, FIELDS, type Field, personKey, type PlanCheck } from './plan.js';

const s = schema;
const isoDate = z.iso.date();

/** คนในไฟล์ → สมาชิก (userId) / เชิญด้วยอีเมล / ไม่ระบุ (null) */
const PersonTarget = z.union([z.object({ userId: z.uuid() }), z.object({ email: z.email() }), z.null()]);
type PersonMapping = Record<string, z.infer<typeof PersonTarget>>;

const ProjectDraft = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  key: projectKey.optional(),
  startDate: isoDate.optional(),
  goliveDate: isoDate.optional(),
  visibility: z.enum(['private', 'workspace']).optional(),
});

export const PatchImportBody = z.object({
  columnMapping: z.record(z.string(), z.enum(Object.keys(FIELDS) as [Field, ...Field[]]).nullable()).optional(),
  personMapping: z.record(z.string(), PersonTarget).optional(),
  project: ProjectDraft.optional(),
  /** ตั้งแผนนี้เป็น Baseline v1 (ค่าเริ่มต้นเปิด) */
  setBaseline: z.boolean().optional(),
  /** โหมดอัปเดต: งานที่หายไปจากไฟล์ (key = No.) · ค่าเริ่มต้น keep */
  missing: z.record(z.string().regex(/^\d+$/), z.enum(['keep', 'delete'])).optional(),
  /** โหมดอัปเดต: ใช้กับงานที่หายไปทุกงาน (ค่าใน `missing` รายงานชนะ) */
  missingAll: z.enum(['keep', 'delete']).optional(),
  /** โหมดอัปเดต: เหตุผลที่บันทึกใน plan_changes */
  planChangeReason: z.string().trim().min(1).max(500).optional(),
});

interface JobState {
  project: z.infer<typeof ProjectDraft>;
  setBaseline: boolean;
  sheet: string;
  summary: PlanCheck['summary'];
  findings: PlanCheck['findings'];
  /** decided = ผู้ใช้เลือกแล้ว (สมาชิก / อีเมล / ไม่ระบุ) · false = ยังไม่พบและยังไม่ได้เลือก */
  people: { name: string; roles: string[]; rows: number; decided: boolean; target: z.infer<typeof PersonTarget> }[];
  columns: { header: string; field: Field | null; sample: unknown }[];
  /** โหมดอัปเดตเท่านั้น */
  diff?: UpdateDiff;
  missingChoice?: Record<string, 'keep' | 'delete'>;
  missingAll?: 'keep' | 'delete';
  planChangeReason?: string;
}

type Job = typeof s.importJobs.$inferSelect;

@Injectable()
export class ImportsService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly invitations: InvitationsService,
    private readonly events: EventBus,
  ) {}

  /** L3 ขั้นที่ 1 · อัปโหลดแล้วจับคู่คอลัมน์และคนให้อัตโนมัติ */
  async upload(auth: AuthInfo, tenant: TenantInfo, file: { buffer: Buffer; originalname: string } | undefined, mode: string, targetKey?: string) {
    if (tenant.role === 'guest') throw forbidden('ws.project.create');
    if (!file) throw new AppError(400, 'file_required', 'แนบไฟล์ .xlsx');
    if (!/\.xlsx$/i.test(file.originalname)) throw new AppError(400, 'invalid_file', 'รองรับเฉพาะไฟล์ .xlsx');
    if (mode !== 'create' && mode !== 'update') throw new AppError(400, 'mode_not_supported', 'mode ต้องเป็น create (โปรเจกต์ใหม่) หรือ update (อัปเดตแผนของโปรเจกต์เดิม)');
    if (mode === 'update' && !targetKey) throw new AppError(400, 'project_required', 'ระบุ projectKey ของโปรเจกต์ที่จะอัปเดต');
    const wb = await this.parse(file.buffer);
    // อัปเดตแผนต้องมี project.baseline · ตรวจก่อนเก็บไฟล์ลงดิสก์
    if (mode === 'update') await this.db.run(auth, tenant, async (tx) => void (await this.updateProject(tx, auth, tenant, targetKey!)));

    const storageKey = `imports/${randomUUID()}.xlsx`;
    const path = join(config.uploadDir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.buffer);

    return this.db.run(auth, tenant, async (tx) => {
      const columnMapping = autoMap(wb.table.headers);
      const members = await this.members(tx);
      if (mode === 'update') {
        const project = await this.updateProject(tx, auth, tenant, targetKey!);
        const ev = await this.evaluateUpdate(tx, tenant, project, wb, columnMapping, {}, members, {}, true);
        const [job] = await tx
          .insert(s.importJobs)
          .values({ workspaceId: tenant.workspaceId, projectId: project.id, mode: 'update', fileName: file.originalname, storageKey, columnMapping, personMapping: ev.personMapping, validation: ev.state, status: 'validated', rowTotal: ev.state.summary.rows, createdBy: auth.userId })
          .returning();
        return view(job, ev.state);
      }
      const draft = suggestProject(file.originalname);
      const { state, personMapping } = await this.evaluate(tx, tenant, wb, columnMapping, {}, members, { project: draft, setBaseline: true }, true);
      const [job] = await tx
        .insert(s.importJobs)
        .values({
          workspaceId: tenant.workspaceId,
          mode: 'create',
          fileName: file.originalname,
          storageKey,
          columnMapping,
          personMapping,
          validation: state,
          status: 'validated',
          rowTotal: state.summary.rows,
          createdBy: auth.userId,
        })
        .returning();
      return view(job, state);
    });
  }

  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const job = await this.own(tx, auth, id);
      return view(job, job.validation as JobState);
    });
  }

  /** L3 ขั้นที่ 2–3 · แก้การจับคู่คอลัมน์ / คน / ข้อมูลโปรเจกต์ แล้วตรวจซ้ำ */
  async patch(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof PatchImportBody>) {
    return this.db.run(auth, tenant, async (tx) => {
      const job = await this.own(tx, auth, id);
      if (job.status !== 'validated') throw new AppError(409, 'import_not_editable', 'งานนำเข้านี้เสร็จแล้วหรือกำลังทำงาน');
      const prev = job.validation as JobState;
      const wb = await this.parse(await readFile(join(config.uploadDir, job.storageKey)));
      const columnMapping = { ...(job.columnMapping as ColumnMapping), ...(input.columnMapping ?? {}) };
      const personMapping = { ...(job.personMapping as PersonMapping), ...(input.personMapping ?? {}) };
      const settings = { project: { ...prev.project, ...(input.project ?? {}) }, setBaseline: input.setBaseline ?? prev.setBaseline };
      if (job.mode === 'update') {
        const project = await this.updateProject(tx, auth, tenant, job);
        const keep = { missingChoice: { ...(prev.missingChoice ?? {}), ...(input.missing ?? {}) }, missingAll: input.missingAll ?? prev.missingAll, planChangeReason: input.planChangeReason ?? prev.planChangeReason };
        const ev = await this.evaluateUpdate(tx, tenant, project, wb, columnMapping, personMapping, await this.members(tx), keep, false);
        const [done] = await tx.update(s.importJobs).set({ columnMapping, personMapping, validation: ev.state, rowTotal: ev.state.summary.rows }).where(eq(s.importJobs.id, job.id)).returning();
        return view(done, ev.state);
      }
      const { state } = await this.evaluate(tx, tenant, wb, columnMapping, personMapping, await this.members(tx), settings, false);
      const [updated] = await tx
        .update(s.importJobs)
        .set({ columnMapping, personMapping, validation: state, rowTotal: state.summary.rows })
        .where(eq(s.importJobs.id, job.id))
        .returning();
      return view(updated, state);
    });
  }

  /** L3 ขั้นที่ 4 · สร้างโปรเจกต์และงานทั้งหมดในธุรกรรมเดียว */
  async commit(auth: AuthInfo, tenant: TenantInfo, id: string, baseUrl: string) {
    const result = await this.db.run(auth, tenant, async (tx) => {
      const job = await this.own(tx, auth, id);
      if (job.status !== 'validated') throw new AppError(409, 'import_not_editable', 'งานนำเข้านี้เสร็จแล้วหรือกำลังทำงาน');
      const prev = job.validation as JobState;
      const wb = await this.parse(await readFile(join(config.uploadDir, job.storageKey)));
      const personMapping = job.personMapping as PersonMapping;
      if (job.mode === 'update') return this.commitUpdate(tx, auth, tenant, job, prev, wb, personMapping);
      const { check } = await this.evaluate(tx, tenant, wb, job.columnMapping as ColumnMapping, personMapping, await this.members(tx), prev, false);

      const p = prev.project;
      const missing = (['name', 'key'] as const).filter((k) => !p[k]);
      if (missing.length) throw new AppError(400, 'project_details_required', 'ระบุชื่อโปรเจกต์และ Project Key ก่อนนำเข้า', { fields: missing });

      const rows = check.rows.filter((r) => !check.skip.has(r.no));
      const moduleNames = [...new Set(rows.map((r) => r.module))];
      const startDate = p.startDate ?? check.summary.planFrom ?? today();
      const goliveDate = p.goliveDate ?? check.summary.planTo ?? startDate;
      const { project } = await this.projects.createInTx(tx, auth, tenant, {
        name: p.name!,
        key: p.key!,
        startDate,
        goliveDate: goliveDate < startDate ? startDate : goliveDate,
        visibility: p.visibility ?? 'private',
        timezone: config.timezone,
        sprintLengthWeeks: 2,
        modules: moduleNames,
        milestones: [],
        estimateUnit: 'man_day',
        progressMethod: 'weighted',
      });
      const base = { workspaceId: tenant.workspaceId, projectId: project.id };

      // วันหยุดในชีต Holidays ที่ไม่มีในปฏิทินของ Workspace → วันหยุดเฉพาะโปรเจกต์ (ให้ Plan End ตรงกับไฟล์)
      const wsCal = await WorkCalendar.load(tx, project);
      const extra = wb.holidays.filter((h) => wsCal.isWorkingDay(h.date));
      if (extra.length) await tx.insert(s.projectHolidays).values(extra.map((h) => ({ ...base, date: h.date, name: h.name }))).onConflictDoNothing();

      const moduleId = new Map((await tx.select({ id: s.modules.id, name: s.modules.name }).from(s.modules).where(eq(s.modules.projectId, project.id))).map((m) => [m.name, m.id]));
      // กลุ่มงานตามลำดับที่พบในไฟล์
      const phaseKeys = [...new Set(rows.filter((r) => r.phase).map((r) => `${r.module}\u0000${r.phase}`))];
      const phaseRows = phaseKeys.length
        ? await tx
            .insert(s.phases)
            .values(phaseKeys.map((k, i) => ({ ...base, moduleId: moduleId.get(k.split('\u0000')[0])!, name: k.split('\u0000')[1], sort: i })))
            .returning({ id: s.phases.id, moduleId: s.phases.moduleId, name: s.phases.name })
        : [];
      const phaseId = new Map(phaseRows.map((x) => [`${x.moduleId}\u0000${x.name}`, x.id]));

      const [taskType] = await tx.select().from(s.issueTypes).where(and(eq(s.issueTypes.projectId, project.id), eq(s.issueTypes.name, 'Task')));
      const statusId = new Map(
        (await tx.select({ id: s.workflowStatuses.id, name: s.workflowStatuses.name }).from(s.workflowStatuses).where(and(eq(s.workflowStatuses.workflowId, taskType.workflowId)))).map((x) => [x.name, x.id]),
      );
      const userOf = (name: string | null) => {
        if (!name) return null;
        const t = personMapping[personKey(name)];
        return t && 'userId' in t ? t.userId : null;
      };

      // Requirement / Screen ที่ถูกอ้างถึง
      const codes = async (table: typeof s.requirements | typeof s.screens, list: string[]) => {
        const uniq = [...new Set(list)];
        if (!uniq.length) return new Map<string, string>();
        const inserted = await tx
          .insert(table)
          .values(uniq.map((code) => ({ ...base, code, ...(table === s.requirements ? { kind: code.startsWith('NFR') ? 'NFR' : 'FR' } : {}) })))
          .returning({ id: table.id, code: table.code });
        return new Map(inserted.map((x) => [x.code, x.id]));
      };
      const reqId = await codes(s.requirements, rows.flatMap((r) => r.requirements));
      const scrId = await codes(s.screens, rows.flatMap((r) => r.screens));

      // งาน: เลขงาน = ID ในไฟล์ (DP-39 = ID 39 ตาม Prototype) · No. เก็บใน excel_row_no ใช้จับคู่ตอนอัปเดตแผน
      const issueIds = new Map<number, string>();
      for (const chunk of chunks(rows, 200)) {
        const inserted = await tx
          .insert(s.issues)
          .values(
            chunk.map((r) => {
              const unmatched = { devs: r.devs.filter((d) => !userOf(d)), ba: r.ba && !userOf(r.ba) ? r.ba : null };
              const mid = moduleId.get(r.module)!;
              return {
                ...base,
                number: r.number,
                excelRowNo: r.no,
                issueTypeId: taskType.id,
                moduleId: mid,
                phaseId: r.phase ? (phaseId.get(`${mid}\u0000${r.phase}`) ?? null) : null,
                title: r.title,
                description: r.remark,
                statusId: statusId.get(r.status) ?? statusId.get('To do')!,
                baId: userOf(r.ba),
                reporterId: auth.userId,
                createdBy: auth.userId,
                size: r.size,
                estimateMd: r.estimateMd,
                planStart: r.planStart,
                planEnd: r.planEnd,
                actualStart: r.actualStart,
                actualEnd: r.actualEnd,
                details: {
                  ...(r.requirementText ? { requirementText: r.requirementText } : {}),
                  ...(unmatched.devs.length || unmatched.ba ? { importedPeople: unmatched } : {}),
                },
              };
            }),
          )
          .returning({ id: s.issues.id, number: s.issues.number });
        const noOf = new Map(chunk.map((r) => [r.number, r.no]));
        inserted.forEach((x) => issueIds.set(noOf.get(x.number)!, x.id));
      }
      await tx.update(s.projects).set({ issueSeq: Math.max(0, ...rows.map((r) => r.number)) }).where(eq(s.projects.id, project.id));

      const ws = { workspaceId: tenant.workspaceId };
      const assignees = rows.flatMap((r) =>
        [...new Set(r.devs.map(userOf).filter((u): u is string => !!u))].map((userId, i) => ({ ...ws, issueId: issueIds.get(r.no)!, userId, sort: i })),
      );
      const reqLinks = rows.flatMap((r) => [...new Set(r.requirements)].map((c) => ({ ...ws, issueId: issueIds.get(r.no)!, requirementId: reqId.get(c)! })));
      const scrLinks = rows.flatMap((r) => [...new Set(r.screens)].map((c) => ({ ...ws, issueId: issueIds.get(r.no)!, screenId: scrId.get(c)! })));
      for (const c of chunks(assignees, 500)) await tx.insert(s.issueAssignees).values(c);
      for (const c of chunks(reqLinks, 500)) await tx.insert(s.issueRequirements).values(c);
      for (const c of chunks(scrLinks, 500)) await tx.insert(s.issueScreens).values(c);
      for (const c of chunks(rows, 500)) {
        await tx.insert(s.activities).values(c.map((r) => ({ ...base, issueId: issueIds.get(r.no)!, actorId: auth.userId, actorKind: 'import' as const, verb: 'imported', newValue: { fileName: job.fileName, no: r.no } })));
      }

      // Baseline v1 ใช้เทียบ Plan กับ Actual และบันทึกการแก้แผนหลังจากนี้
      if (prev.setBaseline) {
        const [bl] = await tx.insert(s.planBaselines).values({ ...base, version: 1, name: 'Baseline v1', source: 'import', createdBy: auth.userId }).returning();
        const devsOf = new Map<string, string[]>();
        assignees.forEach((a) => devsOf.set(a.issueId, [...(devsOf.get(a.issueId) ?? []), a.userId]));
        for (const c of chunks(rows, 500)) {
          await tx.insert(s.baselineItems).values(
            c.map((r) => {
              const issueId = issueIds.get(r.no)!;
              return { ...ws, baselineId: bl.id, issueId, planStart: r.planStart, planEnd: r.planEnd, estimateMd: r.estimateMd, assigneeIds: devsOf.get(issueId) ?? [] };
            }),
          );
        }
      }

      const backlog = rows.filter((r) => !r.planStart && !r.planEnd).length;
      await tx
        .update(s.importJobs)
        .set({ projectId: project.id, status: 'completed', rowImported: rows.length, rowSkipped: check.skip.size, completedAt: new Date() })
        .where(eq(s.importJobs.id, job.id));
      await tx.insert(s.auditLogs).values({
        workspaceId: tenant.workspaceId,
        actorId: auth.userId,
        actorKind: 'user',
        category: 'data',
        action: 'import.completed',
        targetType: 'project',
        targetId: project.id,
        summary: `${job.fileName} → ${project.key} · ${rows.length} งาน · ข้าม ${check.skip.size}`,
      });
      const emails = Object.values(personMapping).flatMap((t) => (t && 'email' in t ? [t.email] : []));
      return { mode: 'create' as const, project: { key: project.key, name: project.name }, imported: rows.length, scheduled: rows.length - backlog, backlog, skipped: check.skip.size, baseline: prev.setBaseline, emails, events: [] as DomainEvent[], projectId: project.id, fileName: job.fileName };
    });

    // คนที่เลือก "เชิญด้วยอีเมล" ได้คำเชิญเข้าโปรเจกต์ที่เพิ่งสร้าง
    const { emails, events, projectId, fileName, ...summary } = result;
    await this.events.publish([
      ...events,
      { type: 'import.completed', workspaceId: tenant.workspaceId, projectId, actorId: auth.userId, data: { fileName, mode: summary.mode, projectKey: summary.project.key, ...counts(summary) }, at: new Date() },
    ]);
    const invitations = emails.length
      ? (await this.invitations.create(auth, tenant, { emails, workspaceRole: 'member', projectKey: summary.project.key, projectRole: 'member', expiresInDays: 7 }, baseUrl)).items
      : [];
    return { ...summary, invitations };
  }

  // ---------------------------------------------------------------------------
  // โหมดอัปเดตแผน (L3)
  // ---------------------------------------------------------------------------

  /** โปรเจกต์ปลายทางของการอัปเดต (key หรือ job) · ต้องมี project.baseline */
  private async updateProject(tx: Tx, auth: AuthInfo, tenant: TenantInfo, target: string | Job) {
    let key = typeof target === 'string' ? target : '';
    if (typeof target !== 'string') {
      const [p] = await tx.select({ key: s.projects.key }).from(s.projects).where(eq(s.projects.id, target.projectId ?? ''));
      if (!p) throw notFound('โปรเจกต์');
      key = p.key;
    }
    const { project, access } = await this.projects.load(tx, auth, tenant, key);
    requirePerm(access, 'project.view');
    requirePerm(access, 'project.baseline');
    if (project.archivedAt) throw new AppError(409, 'project_archived', 'โปรเจกต์ถูก Archive แล้ว อัปเดตแผนไม่ได้');
    return project;
  }

  private async evaluateUpdate(
    tx: Tx,
    tenant: TenantInfo,
    project: typeof s.projects.$inferSelect,
    wb: ParsedWorkbook,
    columnMapping: ColumnMapping,
    personMapping: PersonMapping,
    members: Map<string, string>,
    keep: Pick<JobState, 'missingChoice' | 'missingAll' | 'planChangeReason'>,
    autoMatch: boolean,
  ) {
    const cal = await WorkCalendar.load(tx, project);
    const base = await this.evaluate(tx, tenant, wb, columnMapping, personMapping, members, { project: { key: project.key, name: project.name }, setBaseline: false }, autoMatch, {
      cal,
      keepPlanEnd: true,
      baOptional: true,
      noDerivedSize: true,
      statuses: await statusNames(tx, project.id),
    });
    const plan: UpdatePlan = await computeUpdate(tx, project, base.check, Object.values(columnMapping).includes('id'));
    const state: JobState = { ...base.state, diff: plan.diff, ...keep };
    state.summary = { ...state.summary, ready: plan.diff.changed.length + plan.diff.added.length };
    return { ...base, state, plan };
  }

  private async commitUpdate(tx: Tx, auth: AuthInfo, tenant: TenantInfo, job: Job, prev: JobState, wb: ParsedWorkbook, personMapping: PersonMapping) {
    const project = await this.updateProject(tx, auth, tenant, job);
    // กันอัปเดตแผนพร้อมกันสองคำขอ (เลขงาน / No. ซ้ำ)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'import:' + project.id}, 0))`);
    const ev = await this.evaluateUpdate(tx, tenant, project, wb, job.columnMapping as ColumnMapping, personMapping, await this.members(tx), prev, false);
    const userOf = (name: string | null) => {
      if (!name) return null;
      const t = personMapping[personKey(name)];
      return t && 'userId' in t ? t.userId : null;
    };
    const choice = (no: number) => prev.missingChoice?.[String(no)] ?? prev.missingAll ?? 'keep';
    const deleteNos = new Set(ev.plan.diff.missing.filter((m) => choice(m.no) === 'delete').map((m) => m.no));
    const reason = prev.planChangeReason ?? `อัปเดตแผนจากไฟล์ ${job.fileName}`;
    const done = await applyUpdate(tx, { auth, tenant, project, fileName: job.fileName, plan: ev.plan, userOf, deleteNos, reason });

    const skipped = ev.check.skip.size;
    await tx.update(s.importJobs).set({ status: 'completed', rowImported: done.added + done.changed, rowSkipped: skipped, completedAt: new Date() }).where(eq(s.importJobs.id, job.id));
    await tx.insert(s.auditLogs).values({
      workspaceId: tenant.workspaceId,
      actorId: auth.userId,
      actorKind: 'user',
      category: 'data',
      action: 'import.completed',
      targetType: 'project',
      targetId: project.id,
      summary: `${job.fileName} → อัปเดต ${project.key} · เพิ่ม ${done.added} · เปลี่ยน ${done.changed} · ลบ ${done.deleted} · ข้าม ${skipped}`,
    });
    const emails = Object.values(personMapping).flatMap((t) => (t && 'email' in t ? [t.email] : []));
    const { events, ...counts } = done;
    return { mode: 'update' as const, project: { key: project.key, name: project.name }, ...counts, skipped, emails, events, projectId: project.id, fileName: job.fileName };
  }

  /** `GET projects/:key/export.xlsx` · เห็นโปรเจกต์ได้ก็ export ได้ ยกเว้น Guest */
  async exportXlsx(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project, access } = await this.projects.load(tx, auth, tenant, key);
      requirePerm(access, 'project.view');
      if (access.guestViewer || tenant.role === 'guest') throw new AppError(403, 'guest_view_limited', 'Guest export แผนงานไม่ได้', { allowed: ['overview', 'timeline'] });
      return { filename: `${project.key}-plan.xlsx`, buffer: await buildPlanXlsx(tx, project) };
    });
  }

  // ---------------------------------------------------------------------------

  private async parse(buffer: Buffer): Promise<ParsedWorkbook> {
    try {
      return await readPlanWorkbook(buffer);
    } catch (e) {
      if ((e as Error).message === 'no_table_sheet') {
        throw new AppError(400, 'no_table_sheet', 'ไม่พบชีตตารางงาน (ต้องมีหัวคอลัมน์ No. และ Module ในแถวแรก)');
      }
      throw new AppError(400, 'invalid_file', 'อ่านไฟล์ Excel ไม่ได้');
    }
  }

  private async own(tx: Tx, auth: AuthInfo, id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('งานนำเข้า');
    const [job] = await tx.select().from(s.importJobs).where(eq(s.importJobs.id, id));
    if (!job || job.createdBy !== auth.userId) throw notFound('งานนำเข้า');
    return job;
  }

  /** สมาชิกที่จับคู่ได้ (ไม่รวม Guest) · key = ชื่อที่แสดงแบบไม่สนตัวพิมพ์ */
  private async members(tx: Tx) {
    const rows = await tx
      .select({ userId: s.workspaceMembers.userId, displayName: s.users.displayName })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.role, 'guest')));
    return new Map(rows.map((r) => [personKey(r.displayName), r.userId]));
  }

  /** ตรวจไฟล์ตามการจับคู่ปัจจุบัน · ครั้งแรกจับคู่คนกับสมาชิกให้อัตโนมัติ */
  private async evaluate(
    tx: Tx,
    tenant: TenantInfo,
    wb: ParsedWorkbook,
    columnMapping: ColumnMapping,
    personMapping: PersonMapping,
    members: Map<string, string>,
    settings: Pick<JobState, 'project' | 'setBaseline'>,
    autoMatch: boolean,
    opts: CheckOptions & { cal?: WorkCalendar } = {},
  ) {
    // ปฏิทิน: วันทำงานและวันหยุดของ Workspace + ชีต Holidays ในไฟล์
    const [ws] = await tx.select({ cal: s.workspaceSettings.holidayCalendarId, days: s.workspaceSettings.workDays }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
    const off = new Set(wb.holidays.map((h) => h.date));
    if (ws?.cal) (await tx.select({ date: s.holidays.date }).from(s.holidays).where(eq(s.holidays.calendarId, ws.cal))).forEach((h) => off.add(h.date));
    const cal = opts.cal ?? new WorkCalendar(new Set(ws?.days ?? [1, 2, 3, 4, 5]), off);

    // ชื่อที่ถูกจับคู่แล้ว (สมาชิก / อีเมล / ไม่ระบุ) ไม่ต้องเตือนว่าไม่พบ
    const handled = new Set([...members.keys(), ...Object.keys(personMapping)]);
    const check = checkPlan(wb, columnMapping, cal, handled, opts);

    const mapping: PersonMapping = { ...personMapping };
    // จับคู่อัตโนมัติเฉพาะคนที่ชื่อตรงกับสมาชิก · คนที่ไม่พบยังไม่ถือว่าตัดสินแล้ว (ต่างจากการเลือก "ไม่ระบุ" = null)
    if (autoMatch) for (const p of check.people) if (!(personKey(p.name) in mapping) && members.has(personKey(p.name))) mapping[personKey(p.name)] = { userId: members.get(personKey(p.name))! };
    // userId ที่ส่งมาต้องเป็นสมาชิกจริง
    const memberIds = new Set(members.values());
    for (const [k, t] of Object.entries(mapping)) {
      if (t && 'userId' in t && !memberIds.has(t.userId)) throw new AppError(400, 'invalid_people', `"${k}" จับคู่กับคนที่ไม่ได้เป็นสมาชิก`);
    }
    const first = wb.table.rows[0]?.cells ?? [];
    const state: JobState = {
      ...settings,
      sheet: wb.table.name,
      summary: check.summary,
      findings: check.findings,
      people: check.people.map((p) => ({ ...p, decided: personKey(p.name) in mapping, target: mapping[personKey(p.name)] ?? null })),
      columns: wb.table.headers.map((h, i) => ({ header: h, field: columnMapping[h] ?? null, sample: first[i] ?? null })),
    };
    return { state, check, personMapping: mapping };
  }
}

const counts = (r: Record<string, unknown>) => Object.fromEntries(['imported', 'scheduled', 'backlog', 'added', 'changed', 'unchanged', 'deleted', 'kept', 'planChanges', 'skipped'].filter((k) => k in r).map((k) => [k, r[k]]));

function view(job: Job, state: JobState) {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    fileName: job.fileName,
    projectId: job.projectId,
    fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.label])),
    ...state,
    findings: state.findings.slice(0, 1000),
    ...(state.diff ? { diff: { ...state.diff, added: state.diff.added.slice(0, 1000), changed: state.diff.changed.slice(0, 1000), missing: state.diff.missing.slice(0, 1000) } } : {}),
  };
}

/** ชื่อโปรเจกต์จากชื่อไฟล์ เช่น "Development Plan 2026-11 (2026-11-05).xlsx" → "Development Plan 2026-11" · Key = อักษรแรกของคำ */
function suggestProject(fileName: string) {
  const name = fileName.replace(/\.xlsx$/i, '').replace(/\s*\(.*\)\s*$/, '').trim();
  const key = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w[0].toUpperCase())
    .join('')
    .slice(0, 10);
  return { name, key: key.length >= 2 ? key : undefined };
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

