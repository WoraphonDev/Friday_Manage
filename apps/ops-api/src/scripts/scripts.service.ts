import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { audit, staffAudit } from '../audit.js';
import type { Staff, StaffRole } from '../auth/auth.guard.js';
import { limitsOf } from '../auth/roles.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PageQuery } from '../paging.js';
import { sqlRows } from '../sql-rows.js';
import { JobQueue } from '../system/job-queue.js';
import { type AfterCommit, type MaintenanceScript, type MoveParams, scriptOf, SCRIPTS, type Target } from './registry.js';

const s = schema;
const BATCH = 500;
/**
 * ขั้นอนุมัติไม่มี hook ตอนปฏิเสธ / หมดอายุ / ยกเลิก จึงอ่านสถานะจากคำขออนุมัติแทน (แบบเดียวกับใบเสนอราคา)
 * ไม่งั้นการรันที่ถูกปฏิเสธค้าง "รออนุมัติ" ในงานต้องทำตลอดไป · ต้อง join approval_requests เป็น ar
 */
const STATUS = sql.raw(`case when r.status = 'pending_approval' and ar.status in ('rejected', 'expired', 'cancelled') then ar.status else r.status end`);
export const OPEN = sql.raw(`(r.status in ('running', 'stopping') or (r.status = 'pending_approval' and ar.status = 'pending'))`);
const KEEP_DAYS = 30;
const SAMPLE = 5;

export const DryRunBody = z.object({ workspaceId: z.uuid(), params: z.record(z.string(), z.unknown()).default({}) }).strict();
export const RequestBody = z.object({ reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500), ticketRef: z.string().trim().max(40).optional(), confirmSlug: z.string().trim().max(60).optional() }).strict();
export const UndoBody = z.object({ reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500) }).strict();
export const RunsQuery = PageQuery.extend({ q: z.string().trim().max(100).optional(), script: z.string().trim().max(60).optional() });

type RunRow = typeof s.scriptRuns.$inferSelect;
/** ตัวตั้งค่าคอลัมน์ · ชื่อตาราง / คอลัมน์มาจากโค้ดของสคริปต์ (registry) เท่านั้น จึงใช้ sql.raw ได้ */
const setCols = (cols: string[], values: Record<string, unknown>) => sql.join(cols.map((c) => sql`${sql.raw(c)} = ${values[c] ?? null}`), sql`, `);

/**
 * สคริปต์ดูแลข้อมูล (O56 · เฟส 3) · Owner และวิศวกร
 * ทดลองรัน (อ่านอย่างเดียว) → ขออนุมัติคนที่สองทุกครั้ง (ชนิด script.run) → รันทีละ 500 แถวในพื้นหลัง (หยุดได้) → ย้อนกลับด้วยขั้นอนุมัติเดียวกัน (script.undo)
 * ข้าม Workspace ที่ติด Legal hold · บันทึก Audit log ของทีมและของ Workspace · ค่าเดิมเก็บ 30 วัน
 */
@Injectable()
export class ScriptsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsScripts');
  private timer?: NodeJS.Timeout;
  /** งานที่รันอยู่ในโปรเซสนี้ (test รอให้จบได้) */
  readonly running = new Map<string, Promise<void>>();

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly mail: Mailer,
    private readonly queue: JobQueue,
  ) {}

  onModuleInit() {
    this.approvals.register('script.run', (p, ctx) => this.approved(p.runId as string, ctx));
    this.approvals.register('script.undo', (p, ctx) => this.approvedUndo(p.runId as string, ctx));
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.purge().catch((e) => this.log.error(String(e))), 3_600_000);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private rows<T>(q: SQL, db: Db | Tx = this.db) {
    return sqlRows<T>(db, q);
  }

  /** ลบค่าเดิมเกิน 30 วัน (ย้อนกลับไม่ได้แล้ว) */
  async purge() {
    const r = await this.db.delete(s.scriptRunChanges).where(sql`${s.scriptRunChanges.createdAt} < now() - (${KEEP_DAYS} || ' days')::interval`).returning({ id: s.scriptRunChanges.id });
    return r.length;
  }

  private script(key: string) {
    const sc = scriptOf(key);
    if (!sc) throw new AppError(404, 'not_found', 'ไม่พบสคริปต์นี้');
    return sc;
  }

  private async assertWorkspace(id: string) {
    const [w] = await this.db.select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name, deletedAt: s.workspaces.deletedAt }).from(s.workspaces).where(eq(s.workspaces.id, id));
    if (!w || w.deletedAt) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [hold] = await this.db.select({ id: s.legalHolds.id }).from(s.legalHolds).where(and(eq(s.legalHolds.workspaceId, id), sql`${s.legalHolds.releasedAt} is null`)).limit(1);
    if (hold) throw new AppError(409, 'legal_hold', 'Workspace นี้ติด Legal hold · สคริปต์แก้ข้อมูลไม่ได้จนกว่าจะยกเลิก');
    return w;
  }

  private targets(sc: MaintenanceScript, workspaceId: string, params: unknown) {
    return this.rows<Target>(sc.targets(workspaceId, params as never));
  }

  // ---------------------------------------------------------------- หน้าจอ

  async overview(staff: Staff) {
    const last = await this.rows<{ key: string; at: string; n: number }>(sql`
      select script_key as key, max(created_at) as at, count(*) filter (where status in ('done', 'undone') and created_at > now() - interval '30 days')::int as n
      from script_runs where undo_of is null group by script_key`);
    const [n] = await this.rows<{ runs: number; undone: number }>(sql`
      select count(*) filter (where status in ('done', 'undone', 'running', 'stopped', 'failed') and created_at > now() - interval '30 days' and undo_of is null)::int as runs,
        count(*) filter (where status = 'undone' and updated_at > now() - interval '30 days')::int as undone from script_runs`);
    const todo = await this.rows<Record<string, unknown>>(sql`
      select ${this.COLS} ${this.FROM} where ${OPEN} order by r.created_at`);
    return {
      scripts: SCRIPTS.map((sc) => ({ key: sc.key, table: sc.table, columns: sc.columns, undoable: sc.undoable, fields: sc.fields, lastRunAt: last.find((l) => l.key === sc.key)?.at ?? null, runs30: last.find((l) => l.key === sc.key)?.n ?? 0 })),
      runs30: n.runs, undone30: n.undone, todo, canApprove: staff.roles.includes('owner'),
    };
  }

  private readonly COLS = sql`r.id, r.script_key as "scriptKey", r.workspace_id as "workspaceId", w.name as "workspaceName", w.slug as "workspaceSlug", r.params, ${STATUS} as status, r.dry_result as "dryResult", ar.decision_note as "decisionNote",
    r.reason, r.ticket_ref as "ticketRef", rq.name as "requestedBy", r.requested_by as "requestedById", ap.name as "approvedBy", r.approval_request_id as "approvalRequestId",
    r.undo_of as "undoOf", r.total, r.progress, r.changed, r.error, r.started_at as "startedAt", r.finished_at as "finishedAt", r.created_at as "createdAt",
    exists (select 1 from script_run_changes c where c.run_id = r.id) as "hasChanges"`;
  private readonly FROM = sql`from script_runs r left join workspaces w on w.id = r.workspace_id join staff_users rq on rq.id = r.requested_by left join staff_users ap on ap.id = r.approved_by
    left join approval_requests ar on ar.id = r.approval_request_id`;

  async runs(q: z.infer<typeof RunsQuery>) {
    const w: SQL[] = [sql`r.status <> 'dry_run'`];
    if (q.script) w.push(sql`r.script_key = ${q.script}`);
    if (q.q) {
      const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      w.push(sql`(lower(coalesce(w.name, '')) like ${like} or lower(coalesce(w.slug, '')) like ${like} or lower(rq.name) like ${like})`);
    }
    const cond = sql.join(w, sql` and `);
    const items = await this.rows<Record<string, unknown>>(sql`select ${this.COLS} ${this.FROM} where ${cond} order by r.created_at desc limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n ${this.FROM} where ${cond}`);
    return { items, total: n };
  }

  async run(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบการรัน');
    const [r] = await this.rows<Record<string, unknown>>(sql`select ${this.COLS} ${this.FROM} where r.id = ${id}`);
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบการรัน');
    return r;
  }

  private async row(id: string): Promise<RunRow> {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบการรัน');
    const [r] = await this.db.select().from(s.scriptRuns).where(eq(s.scriptRuns.id, id));
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบการรัน');
    return r;
  }

  // ---------------------------------------------------------------- ทดลองรัน → ขออนุมัติ

  /** ทดลองรัน: อ่านอย่างเดียว · จำนวนแถว + ตัวอย่างก่อน / หลัง · แก้ค่าแล้วต้องทดลองใหม่ (คำขอผูกกับการทดลองนี้) */
  async dryRun(staff: Staff, key: string, input: z.infer<typeof DryRunBody>) {
    const sc = this.script(key);
    const parsed = sc.params.safeParse(input.params);
    if (!parsed.success) throw new AppError(400, 'invalid_params', parsed.error.issues[0]?.message ?? 'ค่าไม่ถูกต้อง', { issues: parsed.error.issues });
    if (sc.sendsMail && !this.mail.enabled) throw new AppError(409, 'mail_disabled', 'ยังไม่ได้ตั้ง SMTP ของ Ops · สคริปต์นี้ส่งอีเมลไม่ได้');
    await this.assertWorkspace(input.workspaceId);
    const started = Date.now();
    let dryResult: { count: number; sample: Target[]; ms: number; notes?: string[] };
    if (sc.remote === 'issue_move') {
      const p = await this.movePreview(staff, input.workspaceId, parsed.data as MoveParams);
      dryResult = { ...p, ms: Date.now() - started };
    } else {
      const rows = await this.targets(sc, input.workspaceId, parsed.data);
      dryResult = { count: rows.length, sample: rows.slice(0, SAMPLE), ms: Date.now() - started };
    }
    const [r] = await this.db.insert(s.scriptRuns).values({ scriptKey: key, workspaceId: input.workspaceId, params: parsed.data as object, status: 'dry_run', dryResult, requestedBy: staff.id, total: dryResult.count }).returning({ id: s.scriptRuns.id });
    return this.run(r.id);
  }

  /** ขอรันจริง: ต้องทดลองรันก่อน · คนที่สองอนุมัติทุกครั้ง (มี Owner คนเดียวใช้กติกาอนุมัติตัวเองแบบเดิม) · สคริปต์ที่ย้อนไม่ได้ต้องพิมพ์ slug ยืนยัน */
  async request(staff: Staff, id: string, input: z.infer<typeof RequestBody>) {
    const r = await this.row(id);
    if (r.requestedBy !== staff.id) throw new AppError(403, 'forbidden', 'ขอรันได้เฉพาะคนที่ทดลองรัน');
    if (r.status !== 'dry_run') throw new AppError(409, 'not_dry_run', 'ต้องทดลองรันใหม่ก่อนขอรันจริง');
    const sc = this.script(r.scriptKey);
    const ws = await this.assertWorkspace(r.workspaceId!);
    if (!sc.undoable && input.confirmSlug !== ws.slug) throw new AppError(422, 'confirm_required', 'สคริปต์นี้ย้อนกลับไม่ได้ · พิมพ์ slug ของ Workspace เพื่อยืนยัน', { slug: ws.slug });
    if (!(r.dryResult as { count: number }).count) throw new AppError(422, 'nothing_to_change', 'ทดลองรันแล้วไม่มีแถวที่ต้องเปลี่ยน');
    const pending = await this.approvals.gate(staff, {
      kind: 'script.run', workspaceId: r.workspaceId, target: { type: 'script_run', id }, payload: { runId: id }, reason: input.reason, exceeds: true,
      rule: `รันสคริปต์ ${sc.key} กับ ${ws.name} (${(r.dryResult as { count: number }).count} แถว) ต้องมีคนที่สองอนุมัติทุกครั้ง`,
    });
    await this.db.update(s.scriptRuns).set({ status: 'pending_approval', reason: input.reason, ticketRef: input.ticketRef ?? null, approvalRequestId: pending!.id }).where(eq(s.scriptRuns.id, id));
    return { ...(await this.run(id)), pendingApproval: pending };
  }

  private async staffOf(id: string): Promise<Staff> {
    const [r] = await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id));
    return { id: r.id, email: r.email, name: r.name, roles: r.roles as StaffRole[], elevated: [], department: r.department, limits: limitsOf(r.limits) };
  }

  /** อนุมัติแล้ว: เริ่มรันในพื้นหลัง · ปิดหน้าได้ */
  private async approved(id: string, ctx: ApprovalContext) {
    await this.db.update(s.scriptRuns).set({ status: 'running', approvedBy: ctx.approver.id, startedAt: new Date() }).where(and(eq(s.scriptRuns.id, id), eq(s.scriptRuns.status, 'pending_approval')));
    this.start(id, () => this.execute(id));
    return { id, status: 'running' };
  }

  private start(id: string, fn: () => Promise<void>) {
    const p = fn()
      .catch(async (e) => {
        this.log.error(`script ${id}: ${String(e)}`);
        await this.db.update(s.scriptRuns).set({ status: 'failed', error: String((e as Error).message ?? e).slice(0, 500), finishedAt: new Date() }).where(eq(s.scriptRuns.id, id));
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  /** รันจริงทีละ 500 แถว · แต่ละชุดเป็นธุรกรรมของตัวเอง (หยุดกลางทางแล้วชุดที่เสร็จคงอยู่และย้อนได้) · หาแถวใหม่ตอนรัน ไม่ใช้ผลทดลอง */
  private async execute(id: string) {
    const r = await this.row(id);
    const sc = this.script(r.scriptKey);
    await this.assertWorkspace(r.workspaceId!);
    if (sc.remote === 'issue_move') {
      // ทำทั้งก้อนในธุรกรรมเดียวที่ API · หยุดกลางทางไม่ได้ (ล้มแล้วไม่มีอะไรเปลี่ยน)
      const staff = await this.staffOf(r.requestedBy);
      const keys = await this.moveKeys(r.workspaceId!, r.params as MoveParams);
      const moved = await this.queue.run<{ moved: { from: string; to: string }[] }>('ops.issues_move', { workspaceId: r.workspaceId, staffName: staff.name, mode: 'move', input: { keys, targetProjectKey: (r.params as MoveParams).targetKey, typeMap: {} } }, 120_000);
      await this.db.update(s.scriptRuns).set({ total: moved.moved.length }).where(eq(s.scriptRuns.id, id));
      await this.finish(r, 'done', moved.moved.length);
      return;
    }
    const rows = await this.targets(sc, r.workspaceId!, r.params);
    await this.db.update(s.scriptRuns).set({ total: rows.length }).where(eq(s.scriptRuns.id, id));
    let changed = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const [cur] = await this.db.select({ status: s.scriptRuns.status }).from(s.scriptRuns).where(eq(s.scriptRuns.id, id));
      if (cur?.status === 'stopping') {
        await this.finish(r, 'stopped', changed);
        return;
      }
      const after: AfterCommit[] = [];
      await this.db.transaction(async (tx) => {
        let n = 0;
        for (const t of rows.slice(i, i + BATCH)) {
          if (sc.apply) {
            const next = await sc.apply({ tx, workspaceId: r.workspaceId!, appUrl: config.appUrl }, t);
            // แถวที่เปลี่ยนไปแล้วระหว่างทดลองกับรันจริง (เช่น มีคนตอบรับคำเชิญ) ไม่นับ
            if (next === undefined) continue;
            after.push(next);
          } else {
            await tx.execute(sql`update ${sql.raw(sc.table)} set ${setCols(sc.columns, t.after)} where id = ${t.id}`);
          }
          await tx.insert(s.scriptRunChanges).values({ runId: id, tableName: sc.table, rowId: t.id, workspaceId: r.workspaceId, before: t.before, after: t.after });
          n++;
        }
        changed += n;
        await tx.update(s.scriptRuns).set({ progress: Math.min(i + BATCH, rows.length), changed }).where(eq(s.scriptRuns.id, id));
      });
      await this.afterCommit(after);
    }
    await this.finish(r, 'done', changed);
  }

  /** ส่งอีเมลหลัง commit ทีละรายการ · ส่งไม่ผ่านไม่ทำให้ทั้งการรันล้ม แต่บันทึกผลลงแถว (เช่น invitations.email_status) ให้รันซ้ำได้ */
  private async afterCommit(items: AfterCommit[]) {
    for (const a of items) {
      let status: 'sent' | 'failed' | 'disabled' = 'sent';
      let error: string | null = null;
      if (a.mail && !this.mail.enabled) status = 'disabled';
      else if (a.mail) {
        try {
          await this.mail.send(a.mail);
        } catch (e) {
          status = 'failed';
          error = String((e as Error).message ?? e).slice(0, 500);
          this.log.warn(`ส่งอีเมลจากสคริปต์ถึง ${a.mail.to} ไม่สำเร็จ: ${error}`);
        }
      }
      if (a.record) await this.db.execute(a.record(status, error));
    }
  }

  private async finish(r: RunRow, status: 'done' | 'stopped', changed: number) {
    await this.db.update(s.scriptRuns).set({ status, changed, progress: changed, finishedAt: new Date() }).where(eq(s.scriptRuns.id, r.id));
    const staff = await this.staffOf(r.requestedBy);
    const what = `สคริปต์ ${r.scriptKey} ${status === 'done' ? 'สำเร็จ' : 'หยุดกลางทาง'} · เปลี่ยน ${changed} แถว${r.reason ? ` · ${r.reason}` : ''}`;
    if (r.workspaceId) await audit(this.db, staff, r.workspaceId, 'data', 'ops.script_run', what, { type: 'script_run', id: r.id }, r.approvedBy ? { approvedBy: r.approvedBy, selfApproved: r.approvedBy === r.requestedBy } : undefined);
  }

  async stop(staff: Staff, id: string) {
    const r = await this.row(id);
    if (r.status !== 'running') throw new AppError(409, 'not_running', 'สคริปต์นี้ไม่ได้รันอยู่');
    await this.db.update(s.scriptRuns).set({ status: 'stopping' }).where(eq(s.scriptRuns.id, id));
    await staffAudit(this.db, staff, 'scripts.stopped', r.scriptKey, { type: 'script_run', id }, r.workspaceId ?? undefined);
    return this.run(id);
  }

  // ---------------------------------------------------------------- ย้ายงานข้ามโปรเจกต์ (API ทำแทนผ่านคิว)

  /** Key ของงานที่จะย้าย: จากช่อง Key (คั่นด้วยจุลภาค / ช่องว่าง) หรือทุก Task ใน Module · ข้าม RLS จึงกรอง workspace_id เอง */
  private async moveKeys(workspaceId: string, p: MoveParams) {
    const keys = new Set<string>();
    for (const k of (p.keys ?? '').split(/[\s,]+/).filter(Boolean)) {
      const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/.exec(k.trim());
      if (!m || m[1].toUpperCase() !== p.projectKey) throw new AppError(400, 'invalid_params', `Key ${k} ไม่ใช่งานของโปรเจกต์ ${p.projectKey}`);
      keys.add(k.trim().toUpperCase());
    }
    if (p.module) {
      const rows = await this.rows<{ key: string }>(sql`
        select pr.key || '-' || i.number as key from issues i join projects pr on pr.id = i.project_id join modules m on m.id = i.module_id
        where i.workspace_id = ${workspaceId}::uuid and pr.workspace_id = ${workspaceId}::uuid and pr.key = ${p.projectKey} and pr.deleted_at is null
          and i.deleted_at is null and i.parent_id is null and lower(m.name) = lower(${p.module}) order by i.number`);
      if (!rows.length) throw new AppError(422, 'nothing_to_change', `ไม่พบ Task ใน Module "${p.module}" ของ ${p.projectKey}`);
      rows.forEach((r) => keys.add(r.key));
    }
    if (keys.size > 200) throw new AppError(422, 'too_many', `ย้ายได้ครั้งละไม่เกิน 200 งาน · เลือกไว้ ${keys.size} งาน`);
    return [...keys];
  }

  /** ดูก่อนย้ายจาก API · แปลงเป็นผลทดลองรัน (ก่อน / หลัง = Key) พร้อมสิ่งที่ตามไปไม่ได้ให้คนอนุมัติเห็น */
  private async movePreview(staff: Staff, workspaceId: string, p: MoveParams) {
    const keys = await this.moveKeys(workspaceId, p);
    type Preview = { count: number; issues: { key: string; newKey: string; title: string }[]; statuses: { typeName: string; from: { name: string }; to: { name: string } | null; suggested: { name: string } | null }[]; types: { from: { name: string }; to: { name: string } | null }[]; dropped: { requirements: string[]; screens: string[]; milestones: string[]; customFields: string[]; dependencies: { other: string }[]; dueRequests: number }; people: { outside: { name: string }[] }; files: { move: number; keep: number } };
    const r = await this.queue.run<Preview>('ops.issues_move', { workspaceId, staffName: staff.name, mode: 'preview', input: { keys, targetProjectKey: p.targetKey, typeMap: {} } });
    const noType = r.types.filter((t) => !t.to).map((t) => t.from.name);
    if (noType.length) throw new AppError(422, 'mapping_required', `โปรเจกต์ ${p.targetKey} ไม่มีประเภทงาน ${noType.join(', ')} · ให้ลูกค้าย้ายเองจากหน้าเว็บเพื่อเลือกประเภทงาน`);
    const noStatus = r.statuses.filter((x) => !x.to && !x.suggested).map((x) => `${x.typeName} · ${x.from.name}`);
    if (noStatus.length) throw new AppError(422, 'mapping_required', `จับคู่สถานะไม่ได้: ${noStatus.join(', ')}`);
    const d = r.dropped;
    const notes = [
      ...r.statuses.filter((x) => !x.to && x.suggested).map((x) => `สถานะ ${x.from.name} → ${x.suggested!.name} (ค่าแนะนำในหมวดเดียวกัน)`),
      d.requirements.length ? `ลิงก์ Requirement หลุด: ${d.requirements.join(', ')}` : '',
      d.screens.length ? `ลิงก์ Screen หลุด: ${d.screens.join(', ')}` : '',
      d.milestones.length ? `Milestone หลุด: ${d.milestones.join(', ')}` : '',
      d.customFields.length ? `ค่า Custom field หลุด: ${d.customFields.join(', ')}` : '',
      d.dependencies.length ? `Dependency กับงานที่ไม่ย้ายหลุด: ${[...new Set(d.dependencies.map((x) => x.other))].join(', ')}` : '',
      d.dueRequests ? `คำขอเลื่อน Due ที่รออยู่ถูกยกเลิก ${d.dueRequests} รายการ` : '',
      r.people.outside.length ? `เพิ่มเป็นสมาชิก ${p.targetKey}: ${r.people.outside.map((x) => x.name).join(', ')}` : '',
      r.files.move ? `ไฟล์แนบ ${r.files.move} ไฟล์ย้ายตามไป · ใช้ร่วม ${r.files.keep} ไฟล์อยู่ที่เดิม` : '',
    ].filter(Boolean);
    return { count: r.count, sample: r.issues.slice(0, SAMPLE).map((i) => ({ id: i.key, label: `${i.key} ${i.title}`.slice(0, 80), before: { key: i.key }, after: { key: i.newKey } })), notes };
  }

  // ---------------------------------------------------------------- ย้อนกลับ

  /** ย้อนกลับใช้ขั้นอนุมัติเดียวกัน · ได้เฉพาะสคริปต์ที่ย้อนได้ ภายใน 30 วัน */
  async requestUndo(staff: Staff, id: string, reason: string) {
    const r = await this.row(id);
    const sc = this.script(r.scriptKey);
    if (!sc.undoable) throw new AppError(422, 'not_undoable', 'สคริปต์นี้ย้อนกลับไม่ได้');
    if (!['done', 'stopped'].includes(r.status) || r.undoOf) throw new AppError(409, 'not_undoable', 'ย้อนกลับได้เฉพาะการรันที่จบแล้ว');
    const [c] = await this.db.select({ id: s.scriptRunChanges.id }).from(s.scriptRunChanges).where(eq(s.scriptRunChanges.runId, id)).limit(1);
    if (!c) throw new AppError(410, 'changes_purged', 'เกิน 30 วันแล้ว ค่าเดิมถูกลบ ย้อนกลับไม่ได้');
    const [u] = await this.db
      .insert(s.scriptRuns)
      .values({ scriptKey: r.scriptKey, workspaceId: r.workspaceId, params: r.params as object, status: 'pending_approval', reason, requestedBy: staff.id, undoOf: id, total: r.changed })
      .returning({ id: s.scriptRuns.id });
    const pending = await this.approvals.gate(staff, { kind: 'script.undo', workspaceId: r.workspaceId, target: { type: 'script_run', id: u.id }, payload: { runId: u.id }, reason, exceeds: true, rule: `ย้อนกลับสคริปต์ ${r.scriptKey} (${r.changed} แถว) ต้องมีคนที่สองอนุมัติ` });
    await this.db.update(s.scriptRuns).set({ approvalRequestId: pending!.id }).where(eq(s.scriptRuns.id, u.id));
    return { ...(await this.run(u.id)), pendingApproval: pending };
  }

  private async approvedUndo(id: string, ctx: ApprovalContext) {
    await this.db.update(s.scriptRuns).set({ status: 'running', approvedBy: ctx.approver.id, startedAt: new Date() }).where(and(eq(s.scriptRuns.id, id), eq(s.scriptRuns.status, 'pending_approval')));
    this.start(id, () => this.executeUndo(id));
    return { id, status: 'running' };
  }

  /** คืนค่าเดิมทุกแถว (ทีละ 500) · ทับค่าที่มีคนแก้หลังสคริปต์รันด้วย จึงต้องอนุมัติ */
  private async executeUndo(id: string) {
    const u = await this.row(id);
    const sc = this.script(u.scriptKey);
    const changes = await this.db.select().from(s.scriptRunChanges).where(eq(s.scriptRunChanges.runId, u.undoOf!));
    let done = 0;
    for (let i = 0; i < changes.length; i += BATCH) {
      await this.db.transaction(async (tx) => {
        for (const c of changes.slice(i, i + BATCH)) await tx.execute(sql`update ${sql.raw(sc.table)} set ${setCols(sc.columns, c.before as Record<string, unknown>)} where id = ${c.rowId}`);
        done += Math.min(BATCH, changes.length - i);
        await tx.update(s.scriptRuns).set({ progress: done, changed: done }).where(eq(s.scriptRuns.id, id));
      });
    }
    await this.db.update(s.scriptRuns).set({ status: 'done', finishedAt: new Date(), changed: done }).where(eq(s.scriptRuns.id, id));
    await this.db.update(s.scriptRuns).set({ status: 'undone' }).where(eq(s.scriptRuns.id, u.undoOf!));
    await this.db.delete(s.scriptRunChanges).where(inArray(s.scriptRunChanges.runId, [u.undoOf!]));
    const staff = await this.staffOf(u.requestedBy);
    if (u.workspaceId) await audit(this.db, staff, u.workspaceId, 'data', 'ops.script_undone', `ย้อนกลับสคริปต์ ${u.scriptKey} · คืนค่าเดิม ${done} แถว · ${u.reason ?? ''}`, { type: 'script_run', id: u.undoOf! }, u.approvedBy ? { approvedBy: u.approvedBy, selfApproved: u.approvedBy === u.requestedBy } : undefined);
  }
}
