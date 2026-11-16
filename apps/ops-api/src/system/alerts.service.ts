import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PushService } from '../push/push.service.js';

const s = schema;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** แจ้งซ้ำทุก 30 นาทีถ้ายังเกิน · กลับมาปกติ 10 นาทีแล้วแจ้ง "กลับมาปกติ" (S11) */
export const RENOTIFY_MS = 30 * MINUTE;
export const NORMAL_MS = 10 * MINUTE;
const KEY = 'alerts';

export const AlertSettings = z
  .object({
    /** แจ้งเมื่อ 5xx / คำขอทั้งหมด เกินกี่ % */
    thresholdPct: z.number().min(0.1, 'เกณฑ์ต้องอย่างน้อย 0.1%').max(50, 'เกณฑ์ต้องไม่เกิน 50%'),
    /** ช่วงที่ใช้คิดอัตรา (นาที) */
    windowMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
    /** คำขอน้อยกว่านี้ในช่วงนั้นไม่นับ (กันแจ้งผิดช่วงกลางคืน) */
    minRequests: z.number().int().min(0).max(1_000_000),
    push: z.boolean(),
    email: z.boolean(),
    /** เปิดเหตุขัดข้องแบบภายในให้อัตโนมัติ (ไม่ประกาศลูกค้า) · ค่าเริ่มต้นปิด กันเหตุขัดข้องเท็จ (คำตัดสินข้อ 7) */
    autoIncident: z.boolean(),
  })
  .strict();
export type AlertSettings = z.infer<typeof AlertSettings>;
export const DEFAULT_ALERTS: AlertSettings = { thresholdPct: 2, windowMin: 5, minRequests: 200, push: true, email: true, autoIncident: false };

/** ผลจาก GET /api/v1/internal/traffic ของ API ลูกค้า (apps/api/src/common/errors.ts › TrafficCounter) */
export interface TrafficSnapshot {
  windowMin: number;
  total: number;
  errors: number;
  ratePct: number | null;
  topRoute: { route: string; errors: number } | null;
  p95Ms: number | null;
  minutes: { at: string; total: number; errors: number; topRoute: string | null }[];
}

interface AlertDetails {
  ratePct: number;
  errors: number;
  total: number;
  windowMin: number;
  thresholdPct: number;
  topRoute: string | null;
  p95Ms: number | null;
  peakPct: number;
  /** เริ่มกลับมาปกติเมื่อไร (ครบ 10 นาที = ปิด) · null = ยังเกินอยู่ */
  normalSince: string | null;
}
type AlertRow = typeof s.systemAlerts.$inferSelect;
type Notice = 'open' | 'repeat' | 'resolved';

/**
 * Error rate ของ API ลูกค้า (รอบ 4 · S10–S12): อ่านตัวนับ 5xx ทุกครั้งที่ตรวจ API (30 วินาที) · เก็บรายนาที 24 ชม. ในหน่วยความจำ
 * เกินเกณฑ์ → system_alerts + Push / อีเมล ถึงวิศวกรและ Owner · แจ้งซ้ำทุก 30 นาทีจนมีคนรับทราบ · ปกติครบ 10 นาที = ปิดและแจ้ง
 */
@Injectable()
export class AlertsService {
  private readonly log = new Logger('OpsAlerts');
  /** รายนาทีย้อนหลัง 24 ชม. (key = เวลาเริ่มนาที) · รีสตาร์ท ops-api แล้วเริ่มใหม่เหมือนผลตรวจ API */
  private readonly minutes = new Map<number, { total: number; errors: number }>();
  /** ผลอ่านล่าสุด · null = ยังอ่านไม่ได้ (API ไม่ตอบ / token ไม่ตรง) */
  last: (TrafficSnapshot & { at: number }) | null = null;
  lastError: string | null = null;
  /** test แทนได้ · ค่าเริ่มต้นเรียก API ลูกค้าตาม API_METRICS_URL หรือ origin เดียวกับ API_HEALTH_URL */
  fetchTraffic = async (windowMin: number): Promise<TrafficSnapshot> => {
    const health = process.env.API_HEALTH_URL ?? 'http://localhost:3001/healthz';
    const url = new URL(process.env.API_METRICS_URL ?? new URL('/api/v1/internal/traffic', health).toString());
    url.searchParams.set('window', String(windowMin));
    const res = await fetch(url, { headers: { 'x-ops-metrics-token': process.env.OPS_METRICS_TOKEN || 'dev-ops-metrics' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TrafficSnapshot;
  };

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly push: PushService,
  ) {}

  // ---------------------------------------------------------------- ค่าตั้ง (S11)

  async settings(): Promise<AlertSettings> {
    const [r] = await this.db.select({ value: s.opsSettings.value }).from(s.opsSettings).where(eq(s.opsSettings.key, KEY));
    const ok = AlertSettings.safeParse({ ...DEFAULT_ALERTS, ...((r?.value ?? {}) as object) });
    return ok.success ? ok.data : DEFAULT_ALERTS;
  }

  async saveSettings(staff: Staff, input: AlertSettings) {
    const before = await this.settings();
    const diff: string[] = [];
    if (before.thresholdPct !== input.thresholdPct) diff.push(`เกณฑ์ ${before.thresholdPct}% → ${input.thresholdPct}%`);
    if (before.windowMin !== input.windowMin) diff.push(`ช่วง ${before.windowMin} → ${input.windowMin} นาที`);
    if (before.minRequests !== input.minRequests) diff.push(`ขั้นต่ำ ${before.minRequests} → ${input.minRequests} คำขอ`);
    if (before.push !== input.push) diff.push(input.push ? 'เปิด Push' : 'ปิด Push');
    if (before.email !== input.email) diff.push(input.email ? 'เปิดอีเมล' : 'ปิดอีเมล');
    if (before.autoIncident !== input.autoIncident) diff.push(input.autoIncident ? 'เปิดเหตุขัดข้องภายในอัตโนมัติ' : 'ไม่เปิดเหตุขัดข้องอัตโนมัติ');
    if (!diff.length) return { settings: before, saved: false };
    await this.db.transaction(async (tx) => {
      await tx.insert(s.opsSettings).values({ key: KEY, value: input, updatedBy: staff.id }).onConflictDoUpdate({ target: s.opsSettings.key, set: { value: input, updatedBy: staff.id, updatedAt: new Date() } });
      await staffAudit(tx, staff, 'system.alerts_updated', `เกณฑ์แจ้งเตือน Error rate: ${diff.join(' · ')}`);
    });
    return { settings: input, saved: true };
  }

  // ---------------------------------------------------------------- อ่านตัวนับและประเมิน

  /** เรียกจากการตรวจ API ทุก 30 วินาที · อ่านไม่ได้ = ไม่เปลี่ยนสถานะการแจ้งเตือน (ไม่รู้ ≠ ปกติ) */
  async pull(now = new Date()) {
    const cfg = await this.settings();
    let snap: TrafficSnapshot;
    try {
      snap = await this.fetchTraffic(cfg.windowMin);
    } catch (e) {
      this.lastError = String((e as Error).message ?? e).slice(0, 200);
      return null;
    }
    return this.ingest(snap, now, cfg);
  }

  /** รับผลอ่าน 1 ครั้ง (test เรียกตรงได้พร้อมเวลาที่กำหนด) */
  async ingest(snap: TrafficSnapshot, now = new Date(), cfg?: AlertSettings) {
    const settings = cfg ?? (await this.settings());
    this.lastError = null;
    this.last = { ...snap, at: now.getTime() };
    for (const m of snap.minutes ?? []) this.minutes.set(Date.parse(m.at), { total: m.total, errors: m.errors });
    for (const at of this.minutes.keys()) if (at < now.getTime() - 24 * HOUR) this.minutes.delete(at);
    return this.evaluate(snap, settings, now);
  }

  private over(snap: Pick<TrafficSnapshot, 'total' | 'ratePct'>, cfg: AlertSettings) {
    return snap.total >= cfg.minRequests && snap.ratePct != null && snap.ratePct > cfg.thresholdPct;
  }

  private async openAlert() {
    const [a] = await this.db.select().from(s.systemAlerts).where(and(eq(s.systemAlerts.kind, 'error_rate'), isNull(s.systemAlerts.resolvedAt))).orderBy(desc(s.systemAlerts.startedAt)).limit(1);
    return a ?? null;
  }

  private async evaluate(snap: TrafficSnapshot, cfg: AlertSettings, now: Date): Promise<{ state: 'normal' | 'opened' | 'over' | 'recovering' | 'resolved'; alertId: string | null; notified: Notice | null }> {
    const open = await this.openAlert();
    if (this.over(snap, cfg)) {
      const details: AlertDetails = {
        ratePct: snap.ratePct!, errors: snap.errors, total: snap.total, windowMin: snap.windowMin ?? cfg.windowMin, thresholdPct: cfg.thresholdPct,
        topRoute: snap.topRoute?.route ?? null, p95Ms: snap.p95Ms, peakPct: Math.max(snap.ratePct!, (open?.details as AlertDetails | undefined)?.peakPct ?? 0), normalSince: null,
      };
      if (!open) {
        const [row] = await this.db.insert(s.systemAlerts).values({ kind: 'error_rate', startedAt: now, details, lastNotifiedAt: now }).returning();
        await staffAudit(this.db, null, 'system.alert_opened', `Error rate ${details.ratePct}% เกินเกณฑ์ ${cfg.thresholdPct}% · 5xx ${details.errors} จาก ${details.total} คำขอใน ${details.windowMin} นาที`, { type: 'system_alert', id: row.id });
        if (cfg.autoIncident) await this.createIncident(null, row).catch((e) => this.log.error(`เปิดเหตุขัดข้องอัตโนมัติไม่ได้: ${e}`));
        await this.notify('open', row, details, cfg);
        return { state: 'opened', alertId: row.id, notified: 'open' };
      }
      // ยังไม่มีใครรับทราบ → แจ้งซ้ำทุก 30 นาที · รับทราบแล้วไม่แจ้งซ้ำคนอื่น (S12)
      const repeat = !open.acknowledgedAt && (!open.lastNotifiedAt || now.getTime() - open.lastNotifiedAt.getTime() >= RENOTIFY_MS);
      await this.db.update(s.systemAlerts).set({ details, ...(repeat ? { lastNotifiedAt: now } : {}) }).where(eq(s.systemAlerts.id, open.id));
      if (repeat) await this.notify('repeat', open, details, cfg);
      return { state: 'over', alertId: open.id, notified: repeat ? 'repeat' : null };
    }
    if (!open) return { state: 'normal', alertId: null, notified: null };
    const d = open.details as AlertDetails;
    const since = d.normalSince ? new Date(d.normalSince) : now;
    if (now.getTime() - since.getTime() >= NORMAL_MS) {
      await this.db.update(s.systemAlerts).set({ resolvedAt: now, details: { ...d, normalSince: since.toISOString() } }).where(eq(s.systemAlerts.id, open.id));
      await staffAudit(this.db, null, 'system.alert_resolved', `Error rate กลับมาปกติ ${Math.round(NORMAL_MS / MINUTE)} นาที · สูงสุด ${d.peakPct}%`, { type: 'system_alert', id: open.id });
      await this.notify('resolved', open, d, cfg, now);
      return { state: 'resolved', alertId: open.id, notified: 'resolved' };
    }
    if (!d.normalSince) await this.db.update(s.systemAlerts).set({ details: { ...d, normalSince: since.toISOString() } }).where(eq(s.systemAlerts.id, open.id));
    return { state: 'recovering', alertId: open.id, notified: null };
  }

  /** Push + อีเมล ถึงวิศวกรและ Owner ตามที่ตั้ง · ส่งไม่ได้ไม่ให้การตรวจล้ม */
  private async notify(kind: Notice, alert: AlertRow, d: AlertDetails, cfg: AlertSettings, now = new Date()) {
    const minutes = Math.max(1, Math.round((now.getTime() - alert.startedAt.getTime()) / MINUTE));
    const title = kind === 'resolved' ? 'Error rate กลับมาปกติ' : `Error rate ${kind === 'repeat' ? 'ยังเกิน' : 'เกิน'} ${d.ratePct}%`;
    const body =
      kind === 'resolved'
        ? `ปกติต่อเนื่อง ${Math.round(NORMAL_MS / MINUTE)} นาที · เกินเกณฑ์รวม ${minutes} นาที · สูงสุด ${d.peakPct}%`
        : `5xx ${d.errors} ครั้งใน ${d.windowMin} นาที${d.topRoute ? ` · ${d.topRoute}` : ''} · แตะเพื่อเปิด`;
    if (cfg.push) await this.push.toRoles(['engineer', 'owner'], { title, body, url: `/m/incidents?alert=${alert.id}`, tag: `alert-${alert.id}` }).catch((e) => this.log.warn(`Push: ${e}`));
    if (!cfg.email) return;
    const to = await this.recipients();
    const text = `${title}\n${body.replace(' · แตะเพื่อเปิด', '')}\n\nเกณฑ์ ${d.thresholdPct}% ใน ${d.windowMin} นาที · ดูรายละเอียดที่ ${config.origin}/system`;
    for (const email of to) {
      try {
        await this.mail.send({ to: email, subject: `[Friday Ops] ${title}`, text });
      } catch {
        /* Mailer บันทึก log แล้ว */
      }
    }
  }

  private async recipients() {
    const r = await this.db.execute(sql`select email from staff_users where status = 'active' and roles && array['engineer', 'owner']::text[] and (expires_at is null or expires_at > now()) order by email`);
    return ((r as unknown as { rows: { email: string }[] }).rows ?? []).map((x) => x.email);
  }

  // ---------------------------------------------------------------- รับทราบ / เปิดเหตุขัดข้อง (S10 · S12)

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบการแจ้งเตือน');
    const [a] = await this.db.select().from(s.systemAlerts).where(eq(s.systemAlerts.id, id));
    if (!a) throw new AppError(404, 'not_found', 'ไม่พบการแจ้งเตือน');
    return a;
  }

  /** "รับทราบ · ฉันดูอยู่": หยุดแจ้งซ้ำ และบอกคนอื่นว่ามีคนดูแล้ว (แทนแจ้งเตือนเดิมบนเครื่องด้วย tag เดียวกัน) */
  async acknowledge(staff: Staff, id: string) {
    const a = await this.find(id);
    if (a.resolvedAt) throw new AppError(409, 'alert_resolved', 'การแจ้งเตือนนี้กลับมาปกติแล้ว');
    if (a.acknowledgedAt) return { id, acknowledgedAt: a.acknowledgedAt, acknowledgedBy: a.acknowledgedBy, already: true };
    const at = new Date();
    await this.db.update(s.systemAlerts).set({ acknowledgedBy: staff.id, acknowledgedAt: at }).where(eq(s.systemAlerts.id, id));
    await staffAudit(this.db, staff, 'system.alert_acknowledged', `รับทราบ Error rate เกิน (${(a.details as AlertDetails).ratePct}%) · กำลังดู`, { type: 'system_alert', id });
    await this.push.toRoles(['engineer', 'owner'], { title: `${staff.name} รับทราบ Error rate เกินแล้ว`, body: 'กำลังดูอยู่ · ระบบไม่แจ้งซ้ำ', url: `/m/incidents?alert=${id}`, tag: `alert-${id}` }, staff.id).catch(() => 0);
    return { id, acknowledgedAt: at, acknowledgedBy: staff.id, already: false };
  }

  /** เปิดเหตุขัดข้องแบบภายในจากการแจ้งเตือน (ไม่ประกาศลูกค้า · เปลี่ยนเป็นสาธารณะได้ในหน้าเหตุขัดข้อง) · มีแล้วคืนอันเดิม */
  async openIncident(staff: Staff, id: string) {
    const a = await this.find(id);
    if (a.incidentId) return { incidentId: a.incidentId, created: false };
    const incidentId = await this.createIncident(staff, a);
    return { incidentId, created: true };
  }

  private async createIncident(staff: Staff | null, a: AlertRow) {
    const d = a.details as AlertDetails;
    const title = `Error rate เกิน ${d.peakPct ?? d.ratePct}%`;
    const message = `5xx ${d.errors} จาก ${d.total} คำขอใน ${d.windowMin} นาที${d.topRoute ? ` · ส่วนใหญ่จาก ${d.topRoute}` : ''}`;
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(s.incidents).values({ title, impact: 'partial', services: ['api'], internal: true, ownerId: staff?.id ?? null }).returning({ id: s.incidents.id });
      await tx.insert(s.incidentUpdates).values({ incidentId: row.id, status: 'investigating', message, createdBy: staff?.id ?? null });
      // กันสองคนกดพร้อมกันแล้วได้สองเหตุ: ผูกได้เฉพาะตอนยังว่าง
      const linked = await tx.update(s.systemAlerts).set({ incidentId: row.id }).where(and(eq(s.systemAlerts.id, a.id), isNull(s.systemAlerts.incidentId))).returning({ id: s.systemAlerts.id });
      if (!linked.length) throw new AppError(409, 'incident_exists', 'มีคนเปิดเหตุขัดข้องจากการแจ้งเตือนนี้แล้ว');
      await staffAudit(tx, staff, 'system.incident_opened', `${title} · partial · ภายใน · จากการแจ้งเตือน Error rate${staff ? '' : ' (อัตโนมัติ)'}`, { type: 'incident', id: row.id });
      return row.id;
    });
    return id;
  }

  // ---------------------------------------------------------------- ข้อมูลหน้าจอ

  /** การแจ้งเตือนที่เปิดอยู่ + ล่าสุด (หน้าเหตุขัดข้องบนมือถือ) */
  async list() {
    const items = await this.db.execute(sql`
      select a.id, a.kind, a.started_at as "startedAt", a.resolved_at as "resolvedAt", a.details, a.last_notified_at as "lastNotifiedAt",
        a.acknowledged_at as "acknowledgedAt", a.incident_id as "incidentId",
        case when st.id is null then null else json_build_object('id', st.id, 'name', st.name) end as "acknowledgedBy"
      from system_alerts a left join staff_users st on st.id = a.acknowledged_by
      order by a.started_at desc limit 10`);
    const rows = ((items as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as { resolvedAt: string | null }[];
    return { open: rows.find((r) => !r.resolvedAt) ?? null, items: rows, settings: await this.settings() };
  }

  /** การ์ด Error rate และกราฟ 24 ชม. ในหน้าสถานะระบบ (S10) */
  async summary(now = Date.now()) {
    const cfg = await this.settings();
    const { open } = await this.list();
    const hours = Array.from({ length: 24 }, (_, i) => {
      const from = now - (24 - i) * HOUR;
      let total = 0;
      let errors = 0;
      for (const [at, m] of this.minutes) if (at >= from && at < from + HOUR) (total += m.total), (errors += m.errors);
      const ratePct = total ? Math.round((errors / total) * 10_000) / 100 : null;
      return { from: new Date(from).toISOString(), total, errors, ratePct, over: ratePct != null && ratePct > cfg.thresholdPct };
    });
    const l = this.last;
    const openAlert = open as (Record<string, unknown> & { startedAt: string; details: AlertDetails }) | null;
    return {
      errorRate: l
        ? {
            at: new Date(l.at).toISOString(), ratePct: l.ratePct, errors: l.errors, total: l.total, windowMin: l.windowMin, topRoute: l.topRoute?.route ?? null, p95Ms: l.p95Ms,
            thresholdPct: cfg.thresholdPct, minRequests: cfg.minRequests, over: this.over(l, cfg),
            overMinutes: openAlert && !openAlert.details.normalSince ? Math.max(1, Math.round((now - new Date(openAlert.startedAt).getTime()) / MINUTE)) : null,
          }
        : null,
      errorRateError: l ? null : this.lastError,
      errorHours: hours,
      alert: open,
      alertSettings: cfg,
    };
  }
}
