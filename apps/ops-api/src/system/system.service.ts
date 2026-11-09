import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApprovalsService, type ApprovalContext } from '../approvals/approvals.service.js';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { JobQueue } from './job-queue.js';

const s = schema;
const INCIDENT_STATUSES = schema.INCIDENT_STATUSES;
type Row = Record<string, unknown>;
const HOUR = 3_600_000;

/** ชื่อบริการแบบที่ลูกค้าเข้าใจ (หน้าสถานะสาธารณะไม่แสดงรายละเอียดภายใน) */
export const SERVICES = ['web', 'api', 'import_export', 'notifications_email', 'notifications_line', 'realtime', 'files', 'billing'] as const;

export const IncidentBody = z
  .object({
    title: z.string().trim().min(3).max(200),
    impact: z.enum(['minor', 'partial', 'major']).default('minor'),
    services: z.array(z.enum(SERVICES)).min(1).max(SERVICES.length),
    message: z.string().trim().min(3).max(2000),
    /** ภายในทีมเท่านั้น ไม่ขึ้นหน้าสถานะสาธารณะ */
    internal: z.boolean().default(false),
    notifySubscribers: z.boolean().default(true),
    showBanner: z.boolean().default(false),
  })
  .strict();
export const IncidentUpdateBody = z
  .object({ status: z.enum(INCIDENT_STATUSES), message: z.string().trim().min(3).max(2000), notifySubscribers: z.boolean().default(true), showBanner: z.boolean().default(false) })
  .strict();
export const MaintenanceBody = z
  .object({
    scope: z.enum(['read_only', 'full', 'import_export']).default('read_only'),
    message: z.string().trim().min(3).max(1000),
    /** ไม่ระบุ = เปิดทันทีหลังอนุมัติ */
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }),
    notifyPlan: z.enum(['3d_and_1h', '1d', 'none']).default('3d_and_1h'),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export const DiscardBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export const RetryManyBody = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100) }).strict();
export const SubscribeBody = z.object({ email: z.email().trim().toLowerCase().max(254) }).strict();
export const TokenBody = z.object({ token: z.string().min(10).max(200) }).strict();

interface MaintenancePayload {
  [k: string]: unknown;
  scope: 'read_only' | 'full' | 'import_export';
  message: string;
  startsAt: string | null;
  endsAt: string;
  notifyPlan: string;
}

/** ผลการตรวจ health ของ API ลูกค้า (เก็บในหน่วยความจำ 24 ชม. · รีสตาร์ทแล้วเริ่มนับใหม่) */
interface Probe {
  at: number;
  ok: boolean;
  ms: number;
}

/**
 * สถานะระบบ เหตุขัดข้อง หน้าสถานะสาธารณะ ปิดปรับปรุง และงานเบื้องหลังที่ล้ม (O04 · หน้า System / Operations · Y3–Y5)
 */
@Injectable()
export class SystemService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsSystem');
  private readonly probes: Probe[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly approvals: ApprovalsService,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit() {
    this.approvals.register('system.maintenance', (p, ctx) => this.applyMaintenance(ctx.requester, p as MaintenancePayload, ctx));
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      // ตรวจ API ทุก 30 วินาที (หน้าจอ: "ตรวจทุก 30 วินาที") · เปลี่ยนสถานะปิดปรับปรุงตามเวลา ทุกนาที
      this.timers.push(setInterval(() => void this.probe(), 30_000), setInterval(() => void this.tickMaintenance().catch((e) => this.log.error(String(e))), 60_000));
      for (const t of this.timers) t.unref();
    }
  }
  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  // ---------------------------------------------------------------- สถานะระบบ

  /** ตรวจ /healthz ของ API ลูกค้า 1 ครั้ง · test เรียกเองได้ */
  async probe() {
    const url = process.env.API_HEALTH_URL ?? 'http://localhost:3001/healthz';
    const start = Date.now();
    let ok = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    this.probes.push({ at: start, ok, ms: Date.now() - start });
    const cutoff = Date.now() - 24 * HOUR;
    while (this.probes.length && this.probes[0].at < cutoff) this.probes.shift();
    return { ok, ms: Date.now() - start };
  }

  async status() {
    const dbStart = Date.now();
    await this.db.execute(sql`select 1`);
    const dbMs = Date.now() - dbStart;
    const ok = this.probes.filter((p) => p.ok);
    const sorted = ok.map((p) => p.ms).sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
    // แบ่ง 24 ช่องรายชั่วโมงสำหรับกราฟ
    const hours = Array.from({ length: 24 }, (_, i) => {
      const from = Date.now() - (24 - i) * HOUR;
      const inHour = this.probes.filter((p) => p.at >= from && p.at < from + HOUR);
      return { from: new Date(from), probes: inHour.length, up: inHour.filter((p) => p.ok).length, avgMs: inHour.length ? Math.round(inHour.reduce((n, p) => n + p.ms, 0) / inHour.length) : null };
    });
    const deliveries = await this.rows(sql`
      select channel::text as channel, count(*)::int as total,
        count(*) filter (where status::text = 'sent')::int as sent, count(*) filter (where status::text = 'failed')::int as failed,
        count(*) filter (where status::text in ('queued', 'retrying'))::int as pending
      from notification_deliveries where created_at > now() - interval '24 hours' group by 1 order by 1`);
    const heavy = await this.rows(sql`
      select w.id, w.slug, w.name, u.api_calls as "apiCalls", u.webhook_calls as "webhookCalls", u.automation_runs as "automationRuns", u.storage_bytes::float8 as "storageBytes", u.active_users as "activeUsers"
      from daily_usages u join workspaces w on w.id = u.workspace_id
      where u.date = (select max(date) from daily_usages) order by u.api_calls desc, u.automation_runs desc limit 10`);
    const incidents = await this.db.select().from(s.incidents).orderBy(desc(s.incidents.startedAt)).limit(5);
    const counts = await this.jobs.counts().catch(() => null);
    return {
      versions: { web: process.env.WEB_VERSION ?? null, api: process.env.API_VERSION ?? null, ops: process.env.GIT_SHA ?? null },
      api: {
        probes: this.probes.length,
        uptimePct: this.probes.length ? Math.round((ok.length / this.probes.length) * 10_000) / 100 : null,
        avgMs: ok.length ? Math.round(ok.reduce((n, p) => n + p.ms, 0) / ok.length) : null,
        p95Ms: p95,
        last: this.probes.at(-1) ?? null,
        hours,
        /** อัตรา error ของคำขอจริงต้องมาจาก GlitchTip / CloudWatch (ยังไม่เชื่อม) */
        errorRate: null,
      },
      database: { ok: true, ms: dbMs },
      queue: counts ? { configured: true, ...counts } : { configured: false },
      deliveries,
      heavyWorkspaces: heavy,
      incidents,
    };
  }

  // ---------------------------------------------------------------- เหตุขัดข้อง

  async incidents() {
    const list = await this.db.select().from(s.incidents).orderBy(desc(s.incidents.startedAt)).limit(50);
    const updates = list.length ? await this.db.select().from(s.incidentUpdates).where(inArray(s.incidentUpdates.incidentId, list.map((i) => i.id))).orderBy(desc(s.incidentUpdates.createdAt)) : [];
    const [{ subscribers }] = await this.rows<{ subscribers: number }>(sql`select count(*)::int as subscribers from status_subscribers where confirmed_at is not null and unsubscribed_at is null`);
    return { items: list.map((i) => ({ ...i, updates: updates.filter((u) => u.incidentId === i.id) })), subscribers };
  }

  /** เปิดเหตุขัดข้อง (Y3) · ไม่ใช่ภายใน = ขึ้นหน้าสถานะสาธารณะทันที และส่งอีเมลผู้ติดตาม */
  async openIncident(staff: Staff, input: z.infer<typeof IncidentBody>) {
    const incident = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(s.incidents).values({ title: input.title, impact: input.impact, services: input.services, internal: input.internal, ownerId: staff.id }).returning();
      await tx.insert(s.incidentUpdates).values({ incidentId: row.id, status: 'investigating', message: input.message, notifySubscribers: input.notifySubscribers && !input.internal, showBanner: input.showBanner && !input.internal, createdBy: staff.id });
      return row;
    });
    await staffAudit(this.db, staff, 'system.incident_opened', `${input.title} · ${input.impact}`, { type: 'incident', id: incident.id });
    const notified = input.notifySubscribers && !input.internal ? await this.notifySubscribers(`[Friday Manage] ${input.title}`, input.message) : 0;
    return { incident, notified };
  }

  /** อัปเดตตามสถานะ (Y4) · resolved = ปิดเหตุ */
  async updateIncident(staff: Staff, id: string, input: z.infer<typeof IncidentUpdateBody>) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบเหตุขัดข้อง');
    const [i] = await this.db.select().from(s.incidents).where(eq(s.incidents.id, id));
    if (!i) throw new AppError(404, 'not_found', 'ไม่พบเหตุขัดข้อง');
    if (i.status === 'resolved') throw new AppError(409, 'incident_resolved', 'เหตุขัดข้องนี้ปิดแล้ว');
    await this.db.transaction(async (tx) => {
      await tx.update(s.incidents).set({ status: input.status, resolvedAt: input.status === 'resolved' ? new Date() : null, updatedAt: new Date() }).where(eq(s.incidents.id, id));
      await tx.insert(s.incidentUpdates).values({ incidentId: id, status: input.status, message: input.message, notifySubscribers: input.notifySubscribers && !i.internal, showBanner: input.showBanner && !i.internal, createdBy: staff.id });
    });
    await staffAudit(this.db, staff, 'system.incident_updated', `${i.title} → ${input.status}`, { type: 'incident', id });
    const notified = input.notifySubscribers && !i.internal ? await this.notifySubscribers(`[Friday Manage] ${input.status === 'resolved' ? 'แก้ไขแล้ว: ' : ''}${i.title}`, input.message) : 0;
    return { id, status: input.status, notified };
  }

  private async notifySubscribers(subject: string, text: string) {
    const subs = await this.db.select({ email: s.statusSubscribers.email }).from(s.statusSubscribers).where(and(isNotNull(s.statusSubscribers.confirmedAt), isNull(s.statusSubscribers.unsubscribedAt)));
    let n = 0;
    for (const sub of subs) {
      try {
        await this.mail.send({ to: sub.email, subject, text: `${text}\n\nติดตามสถานะได้ที่หน้าสถานะ Friday Manage · เลิกรับอีเมลได้จากลิงก์ในหน้าสถานะ` });
        n++;
      } catch {
        /* Mailer บันทึก log แล้ว */
      }
    }
    return n;
  }

  /**
   * หน้าสถานะสาธารณะ: เหตุที่ไม่ใช่ภายใน (ยังไม่ปิด + ปิดใน 7 วัน) และการปิดปรับปรุง · ไม่ส่งชื่อพนักงานหรือรายละเอียดภายใน
   * API ลูกค้าใช้ข้อมูลชุดเดียวกันทำแบนเนอร์ในแอป (`banner`)
   */
  async publicStatus() {
    const list = await this.db
      .select()
      .from(s.incidents)
      .where(and(eq(s.incidents.internal, false), or(isNull(s.incidents.resolvedAt), gt(s.incidents.resolvedAt, new Date(Date.now() - 7 * 24 * HOUR)))))
      .orderBy(desc(s.incidents.startedAt));
    const updates = list.length ? await this.db.select().from(s.incidentUpdates).where(inArray(s.incidentUpdates.incidentId, list.map((i) => i.id))).orderBy(desc(s.incidentUpdates.createdAt)) : [];
    const maintenance = await this.db
      .select({ id: s.maintenanceWindows.id, scope: s.maintenanceWindows.scope, message: s.maintenanceWindows.message, startsAt: s.maintenanceWindows.startsAt, endsAt: s.maintenanceWindows.endsAt, status: s.maintenanceWindows.status })
      .from(s.maintenanceWindows)
      .where(inArray(s.maintenanceWindows.status, ['scheduled', 'active']))
      .orderBy(s.maintenanceWindows.startsAt);
    const open = list.filter((i) => !i.resolvedAt);
    const worst = open.some((i) => i.impact === 'major') ? 'major_outage' : open.some((i) => i.impact === 'partial') ? 'partial_outage' : open.length ? 'degraded' : 'operational';
    const latest = (id: string) => updates.find((u) => u.incidentId === id);
    return {
      state: maintenance.some((m) => m.status === 'active') && worst === 'operational' ? 'maintenance' : worst,
      incidents: list.map((i) => ({
        id: i.id, title: i.title, impact: i.impact, status: i.status, services: i.services, startedAt: i.startedAt, resolvedAt: i.resolvedAt,
        updates: updates.filter((u) => u.incidentId === i.id).map((u) => ({ status: u.status, message: u.message, at: u.createdAt })),
      })),
      maintenance,
      banner: open.map((i) => latest(i.id)).find((u) => u?.showBanner)?.message ?? maintenance.find((m) => m.status === 'active')?.message ?? null,
    };
  }

  /** ติดตามหน้าสถานะ: ส่งลิงก์ยืนยันก่อน (กันใส่อีเมลคนอื่น) · ตอบแบบเดียวกันเสมอ ไม่บอกว่ามีอีเมลนี้หรือยัง */
  async subscribe(input: z.infer<typeof SubscribeBody>) {
    const token = randomBytes(24).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const [existing] = await this.db.select().from(s.statusSubscribers).where(sql`lower(${s.statusSubscribers.email}) = ${input.email}`);
    if (existing && existing.confirmedAt && !existing.unsubscribedAt) return { ok: true };
    if (existing) await this.db.update(s.statusSubscribers).set({ confirmTokenHash: hash, unsubscribedAt: null, confirmedAt: null }).where(eq(s.statusSubscribers.id, existing.id));
    else await this.db.insert(s.statusSubscribers).values({ email: input.email, confirmTokenHash: hash });
    await this.mail.send({ to: input.email, subject: 'ยืนยันการติดตามสถานะ Friday Manage', text: `ยืนยันด้วยรหัสนี้ในหน้าสถานะ: ${token}` }).catch(() => undefined);
    return { ok: true };
  }
  async confirmSubscription(input: z.infer<typeof TokenBody>) {
    const hash = createHash('sha256').update(input.token).digest('hex');
    const [r] = await this.db.update(s.statusSubscribers).set({ confirmedAt: new Date(), confirmTokenHash: null }).where(eq(s.statusSubscribers.confirmTokenHash, hash)).returning({ id: s.statusSubscribers.id });
    if (!r) throw new AppError(400, 'invalid_token', 'รหัสยืนยันไม่ถูกต้องหรือใช้ไปแล้ว');
    return { confirmed: true };
  }
  async unsubscribe(input: z.infer<typeof SubscribeBody>) {
    await this.db.update(s.statusSubscribers).set({ unsubscribedAt: new Date() }).where(sql`lower(${s.statusSubscribers.email}) = ${input.email}`);
    return { ok: true };
  }

  // ---------------------------------------------------------------- ปิดปรับปรุง

  async maintenance() {
    const items = await this.db.select().from(s.maintenanceWindows).orderBy(desc(s.maintenanceWindows.startsAt)).limit(50);
    return { items, active: items.find((m) => m.status === 'active') ?? null };
  }

  /** ตั้งเวลา / เปิดทันที (Y5) · ต้องอนุมัติทุกครั้ง (06 › 3) · มี Owner คนเดียวอนุมัติตัวเองได้ตามกติกาเดิม */
  async requestMaintenance(staff: Staff, input: z.infer<typeof MaintenanceBody>) {
    const start = input.startsAt ? new Date(input.startsAt) : null;
    const end = new Date(input.endsAt);
    if (end.getTime() <= (start ?? new Date()).getTime()) throw new AppError(422, 'invalid_window', 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม');
    if (end.getTime() - (start ?? new Date()).getTime() > 24 * HOUR) throw new AppError(422, 'window_too_long', 'ปิดปรับปรุงได้ไม่เกิน 24 ชั่วโมงต่อครั้ง');
    const payload: MaintenancePayload = { scope: input.scope, message: input.message, startsAt: input.startsAt ?? null, endsAt: input.endsAt, notifyPlan: input.notifyPlan };
    const pending = await this.approvals.gate(staff, {
      kind: 'system.maintenance', workspaceId: null, payload, reason: input.reason,
      exceeds: true, rule: 'ปิดปรับปรุงทั้งระบบต้องอนุมัติทุกครั้ง',
    });
    return { pendingApproval: pending! };
  }

  private async applyMaintenance(staff: Staff, p: MaintenancePayload, ctx: ApprovalContext) {
    const now = new Date();
    const start = p.startsAt ? new Date(p.startsAt) : now;
    if (new Date(p.endsAt).getTime() <= now.getTime()) throw new AppError(409, 'window_passed', 'ช่วงเวลาที่ขอผ่านไปแล้ว ขอใหม่');
    const [active] = await this.db.select({ id: s.maintenanceWindows.id }).from(s.maintenanceWindows).where(eq(s.maintenanceWindows.status, 'active'));
    const startNow = start.getTime() <= now.getTime();
    if (startNow && active) throw new AppError(409, 'maintenance_active', 'มีการปิดปรับปรุงที่กำลังทำงานอยู่');
    const [row] = await this.db
      .insert(s.maintenanceWindows)
      .values({ scope: p.scope, message: p.message, startsAt: startNow ? now : start, endsAt: new Date(p.endsAt), notifyPlan: p.notifyPlan, status: startNow ? 'active' : 'scheduled', createdBy: staff.id, approvalRequestId: ctx.requestId })
      .returning();
    await staffAudit(this.db, staff, startNow ? 'system.maintenance_started' : 'system.maintenance_scheduled', `${p.scope} · ${row.startsAt.toISOString()} – ${row.endsAt.toISOString()} · ${p.message}`, { type: 'maintenance_window', id: row.id }, undefined, { approvedBy: ctx.approver.id, selfApproved: ctx.selfApproved });
    if (p.notifyPlan !== 'none') await this.notifySubscribers(`[Friday Manage] ${startNow ? 'กำลังปิดปรับปรุง' : 'แจ้งปิดปรับปรุง'}`, `${p.message}\nช่วงเวลา ${row.startsAt.toISOString()} – ${row.endsAt.toISOString()}`);
    return { maintenance: row };
  }

  /** ปลดทันที / ยกเลิกที่ตั้งเวลาไว้ (ไม่ต้องอนุมัติ: ทำให้ระบบกลับมาใช้ได้) */
  async endMaintenance(staff: Staff, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบรายการปิดปรับปรุง');
    const [m] = await this.db.select().from(s.maintenanceWindows).where(eq(s.maintenanceWindows.id, id));
    if (!m) throw new AppError(404, 'not_found', 'ไม่พบรายการปิดปรับปรุง');
    if (m.status !== 'active' && m.status !== 'scheduled') throw new AppError(409, 'maintenance_closed', 'รายการนี้จบแล้ว', { status: m.status });
    const status = m.status === 'active' ? 'done' : 'cancelled';
    await this.db.update(s.maintenanceWindows).set({ status, endsAt: m.status === 'active' ? new Date() : m.endsAt, updatedAt: new Date() }).where(eq(s.maintenanceWindows.id, id));
    await staffAudit(this.db, staff, status === 'done' ? 'system.maintenance_ended' : 'system.maintenance_cancelled', m.message, { type: 'maintenance_window', id });
    return { id, status };
  }

  /** ตามเวลา: ถึงเวลาเริ่ม → active · เลยเวลาสิ้นสุด → done */
  async tickMaintenance(now = new Date()) {
    const started = await this.db.update(s.maintenanceWindows).set({ status: 'active', updatedAt: now }).where(and(eq(s.maintenanceWindows.status, 'scheduled'), lte(s.maintenanceWindows.startsAt, now), gt(s.maintenanceWindows.endsAt, now))).returning({ id: s.maintenanceWindows.id });
    const ended = await this.db.update(s.maintenanceWindows).set({ status: 'done', updatedAt: now }).where(and(inArray(s.maintenanceWindows.status, ['scheduled', 'active']), lte(s.maintenanceWindows.endsAt, now))).returning({ id: s.maintenanceWindows.id });
    return { started: started.length, ended: ended.length };
  }

  // ---------------------------------------------------------------- งานเบื้องหลังที่ล้ม

  async failedJobs() {
    if (!this.jobs.configured) return { configured: false, items: [] };
    const items = await this.jobs.failed();
    return {
      configured: true,
      items: items.map((j) => ({ ...j, workspaceId: typeof j.data.workspaceId === 'string' ? j.data.workspaceId : null, data: undefined })),
    };
  }

  private async jobOrThrow(id: string) {
    if (!this.jobs.configured) throw new AppError(409, 'queue_not_configured', 'ยังไม่ได้เชื่อมคิวงาน (ตั้ง VALKEY_URL)');
    const job = await this.jobs.job(id);
    if (!job) throw new AppError(404, 'not_found', 'ไม่พบงานนี้ในคิว');
    if (!(await job.isFailed())) throw new AppError(409, 'job_not_failed', 'งานนี้ไม่ได้อยู่ในสถานะล้ม');
    return job;
  }

  async retryJob(staff: Staff, id: string) {
    const job = await this.jobOrThrow(id);
    await job.retry('failed');
    await staffAudit(this.db, staff, 'system.job_retried', `${job.name} (${id})`);
    return { id, retried: true };
  }

  async retryMany(staff: Staff, ids: string[]) {
    const out: { id: string; retried: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await this.retryJob(staff, id);
        out.push({ id, retried: true });
      } catch (e) {
        out.push({ id, retried: false, error: e instanceof AppError ? e.code : 'error' });
      }
    }
    return { items: out };
  }

  /** ทิ้งงาน: ลบออกจากคิวพร้อมบันทึกเหตุผล (ข้อมูลงานเก็บไว้ใน Audit ของทีมเพื่อสืบย้อน) */
  async discardJob(staff: Staff, id: string, input: z.infer<typeof DiscardBody>) {
    const job = await this.jobOrThrow(id);
    const summary = `${job.name} (${id}) · ล้มเพราะ ${job.failedReason ?? '-'} · ${input.reason}`;
    await job.remove();
    await staffAudit(this.db, staff, 'system.job_discarded', summary);
    return { id, discarded: true };
  }
}
