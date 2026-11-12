import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { webUrl } from '../auth/auth.config.js';
import { Jobs, JOB_ATTEMPTS, UnrecoverableError } from '../queue/jobs.js';
import { Audience } from '../notifications/audience.js';
import { Notifier } from '../notifications/notifier.js';
import { WorkCalendar } from '../projects/calendar.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { reasonIn } from '../notifications/rules.js';
import { buildMessage, isCritical, isUrgent, toLocale, type Msg } from './message.js';
import { nextSendTime, type QuietRule } from './quiet.js';
import { ChannelRegistry, DeliveryError, type ExternalChannel, type SendResult } from './senders.js';

const s = schema;

export const CHANNEL_JOBS = {
  dispatch: 'channels.dispatch',
  deliver: 'channels.deliver',
  flushQuiet: 'channels.flush-quiet',
  scan: 'channels.scan',
  purge: 'channels.purge',
} as const;

/** เก็บประวัติการส่ง (รวมเนื้อหาที่ส่ง) และเหตุการณ์ bounce 90 วัน (O23) */
export const DELIVERY_RETENTION_DAYS = 90;

/** 1 เหตุการณ์ในลำดับการส่ง (notification_deliveries.log) */
export interface DeliveryLogEntry {
  at: string;
  kind: 'attempt_ok' | 'attempt_failed' | 'quiet' | 'suppressed' | 'cancelled' | 'paused' | 'resend' | 'bounced' | 'complained';
  attempt?: number;
  status?: number | null;
  message?: string;
  final?: boolean;
}

/**
 * เหตุการณ์ที่ส่ง Email ให้ตั้งแต่ต้นถ้าผู้ใช้ยังไม่เคยตั้ง pref (Canvas I › คอลัมน์ Email)
 * ที่เหลือปิดไว้ก่อน เปิดเองได้ที่ Profile
 */
export const EMAIL_DEFAULT_ON = new Set([
  'issue.assigned',
  'issue.review_requested',
  'issue.mentioned',
  'due_request.created',
  'due_request.decided',
  'issue.overdue',
  'member.joined',
  'project.health_changed',
  'digest.daily',
  'channel.webhook_paused',
  // ผู้รับรายงานถูกเลือกไว้ที่ report-schedule อยู่แล้ว
  'report.weekly',
  // ประกาศจากทีม Friday ถึง Owner / Admin (O24) · ทีม Friday เลือกช่องทางอีเมลไว้แล้ว
  'ops.announcement',
]);

/** ช่วงงดส่งเริ่มต้นของผู้ใช้ที่ยังไม่เคยตั้ง (Profile: ไม่รบกวน 20:00–08:00 และวันหยุด) */
const DEFAULT_PERSONAL_QUIET: QuietRule = { start: '20:00', end: '08:00', holidays: true };
/** กลุ่มทีม / Webhook: หลัง 19:00 และวันหยุด ส่งรวมเช้าวันทำงานถัดไป (L2) */
const PROJECT_QUIET_START = '19:00';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** ช่วงที่งานสแกนย้อนดูแจ้งเตือนที่ไม่ได้ผ่าน Notifier */
const SCAN_WINDOW_MS = 5 * 60_000;

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
/** ช่องทางที่ส่งถึงทั้งกลุ่ม (ไม่ใช่ผู้รับรายคน) · ตรวจตามกฎของโปรเจกต์แทนสิทธิ์ของผู้รับ */
const GROUP_CHANNELS = new Set<ExternalChannel>(['webhook', 'line_group']);

type NotificationRow = typeof s.notifications.$inferSelect;
const payloadOf = (n: NotificationRow) => (n.payload ?? {}) as Record<string, unknown>;

/** pref ของช่องทางรายคน · ไม่เคยตั้ง = ค่าเริ่มต้น (Email เปิดเฉพาะ EMAIL_DEFAULT_ON) */
function personalEnabled(pref: Map<string, boolean>, channel: ExternalChannel, eventType: string) {
  return pref.get(channel) ?? (channel === 'email' && EMAIL_DEFAULT_ON.has(eventType));
}

/**
 * ท่อส่งแจ้งเตือนออกนอกแอป: notifications ใหม่ → pref ของผู้รับ + กฎของโปรเจกต์ → notification_deliveries → คิว
 * ใช้ SYSTEM_DB เพราะรันในงานคิวที่ไม่มีผู้ใช้ให้ RLS และ notification_deliveries เขียนได้เฉพาะงานเบื้องหลัง (RLS 0009)
 * ทุกข้อมูลที่อ่านกรองด้วย workspace_id ของแจ้งเตือนเสมอ
 */
@Injectable()
export class ChannelDispatcher implements OnModuleInit {
  private readonly log = new Logger('ChannelDispatcher');
  private readonly audience: Audience;

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly notifier: Notifier,
    private readonly registry: ChannelRegistry,
  ) {
    this.audience = new Audience(db);
  }

  async onModuleInit() {
    this.jobs.define<{ notificationIds: string[] }>(CHANNEL_JOBS.dispatch, (d) => this.dispatch(d.notificationIds));
    this.jobs.define<{ deliveryId: string }>(CHANNEL_JOBS.deliver, (d, ctx) => this.deliver(d.deliveryId, { attempt: ctx.attempt }));
    this.jobs.define(CHANNEL_JOBS.flushQuiet, () => this.flushQuiet());
    this.jobs.define(CHANNEL_JOBS.scan, () => this.scan());
    this.jobs.define(CHANNEL_JOBS.purge, () => this.purge());
    await this.jobs.every(CHANNEL_JOBS.flushQuiet, '*/10 * * * *');
    await this.jobs.every(CHANNEL_JOBS.scan, '* * * * *');
    await this.jobs.every(CHANNEL_JOBS.purge, '17 3 * * *');
    this.hookNotifier();
  }

  /**
   * ต่อท่อส่งเข้ากับ Notifier โดยไม่แก้ notifications/** (lane ของ A23):
   * ครอบ notify() ให้ส่งงาน dispatch ทันทีหลังสร้างแจ้งเตือน · แจ้งเตือนที่เขียนตรงโดยไม่ผ่าน Notifier ถูกงาน scan เก็บภายในไม่กี่นาที
   * ถ้า A23 เพิ่ม hook ใน Notifier ภายหลัง ให้ลบส่วนนี้ (ดู "คำขอนอก lane" ใน A25)
   */
  private hookNotifier() {
    const n = this.notifier as Notifier & { __channelsHooked?: boolean };
    if (n.__channelsHooked) return;
    n.__channelsHooked = true;
    const original = n.notify.bind(n);
    n.notify = async (input) => {
      // ใช้นาฬิกาของฐานข้อมูล: แถวที่ notify() เพิ่งสร้างมี created_at >= เวลานี้เสมอ และไม่เก็บแถวเก่าของเหตุการณ์เดียวกัน
      const since = await this.dbClock().catch(() => null);
      await original(input);
      if (!since) return; // งาน scan จะเก็บให้
      try {
        const ids = await this.db
          .select({ id: s.notifications.id })
          .from(s.notifications)
          .where(
            and(
              eq(s.notifications.workspaceId, input.workspaceId),
              eq(s.notifications.eventType, input.eventType),
              inArray(s.notifications.recipientId, input.recipientIds),
              gte(s.notifications.createdAt, since),
            ),
          );
        if (ids.length) await this.jobs.enqueue(CHANNEL_JOBS.dispatch, { notificationIds: ids.map((r) => r.id) });
      } catch (err) {
        // การส่งออกนอกแอปพลาดต้องไม่ทำให้คำขอหลักล้ม
        this.log.error(`dispatch hook failed: ${(err as Error).stack ?? err}`);
      }
    };
  }

  private async dbClock() {
    const r = await this.db.execute(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`);
    return new Date(Math.floor((r.rows[0] as { ms: number }).ms));
  }

  /** เก็บแจ้งเตือนที่ยังไม่เคยผ่านท่อ (เขียนตรง) ภายใน SCAN_WINDOW_MS */
  async scan(now = new Date()) {
    const rows = await this.db
      .select({ id: s.notifications.id })
      .from(s.notifications)
      .where(
        and(
          gte(s.notifications.createdAt, new Date(now.getTime() - SCAN_WINDOW_MS)),
          sql`not exists (select 1 from notification_deliveries d where d.notification_id = ${s.notifications.id})`,
        ),
      )
      .limit(500);
    if (rows.length) await this.dispatch(rows.map((r) => r.id));
    await this.resendRequested();
  }

  /** ทีม Friday ขอส่งซ้ำ (ops-api ตั้ง resend_requested_at) · จองแถวก่อนแล้วส่งเข้าคิว */
  async resendRequested() {
    const rows = await this.db
      .update(s.notificationDeliveries)
      .set({ resendRequestedAt: null })
      .where(sql`${s.notificationDeliveries.resendRequestedAt} IS NOT NULL`)
      .returning({ id: s.notificationDeliveries.id });
    for (const r of rows) await this.jobs.enqueue(CHANNEL_JOBS.deliver, { deliveryId: r.id }, { jobId: `resend-${r.id}-${Date.now()}` });
    return rows.length;
  }

  /** ลบประวัติการส่งและเหตุการณ์ bounce ที่เก่ากว่า 90 วัน */
  async purge(now = new Date()) {
    const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000);
    const gone = await this.db.delete(s.notificationDeliveries).where(sql`${s.notificationDeliveries.createdAt} < ${cutoff}`).returning({ id: s.notificationDeliveries.id });
    await this.db.delete(s.emailFeedbackEvents).where(sql`${s.emailFeedbackEvents.createdAt} < ${cutoff}`);
    return { deleted: gone.length };
  }

  /** ต่อท้ายลำดับเหตุการณ์ของรายการส่ง พร้อมแก้คอลัมน์อื่นในคำสั่งเดียว */
  private async record(id: string, entry: Omit<DeliveryLogEntry, 'at'> & { at?: Date }, set: Partial<typeof s.notificationDeliveries.$inferInsert> = {}) {
    const e: DeliveryLogEntry = { ...entry, at: (entry.at ?? new Date()).toISOString() };
    await this.db
      .update(s.notificationDeliveries)
      .set({ ...set, log: sql`${s.notificationDeliveries.log} || ${JSON.stringify([e])}::jsonb` })
      .where(eq(s.notificationDeliveries.id, id));
  }

  /** ชื่อปลายทางที่แสดงในหลังบ้าน (เก็บครั้งแรกที่ส่ง) */
  private async labelOf(channel: ExternalChannel, targetRef: string, recipientId: string) {
    if (channel === 'email') return targetRef;
    if (channel === 'webhook') {
      const [h] = await this.db.select({ name: s.webhookEndpoints.name }).from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, targetRef));
      return h?.name ?? 'Webhook';
    }
    if (channel === 'line_group') {
      const [g] = await this.db.select({ name: s.lineGroups.name }).from(s.lineGroups).where(eq(s.lineGroups.id, targetRef));
      return g ? `กลุ่ม LINE · ${g.name}` : 'กลุ่ม LINE';
    }
    const [u] = await this.db.select({ name: s.users.displayName }).from(s.users).where(eq(s.users.id, recipientId));
    return `LINE ส่วนตัว · ${u?.name ?? ''}`.trim();
  }

  /** อีเมลอยู่ในรายชื่อไม่ส่ง (bounce ถาวร / รายงานสแปม) ไหม */
  private async suppressed(email: string) {
    const [r] = await this.db
      .select({ reason: s.emailSuppressions.reason })
      .from(s.emailSuppressions)
      .where(and(sql`lower(${s.emailSuppressions.email}) = lower(${email})`, isNull(s.emailSuppressions.removedAt)));
    return r?.reason ?? null;
  }

  /** ตัดสินว่าแจ้งเตือนแต่ละรายการต้องส่งทางไหน แล้วสร้างรายการส่ง + ส่งเข้าคิว */
  async dispatch(notificationIds: string[]) {
    if (!notificationIds.length) return;
    const rows = await this.db.select().from(s.notifications).where(inArray(s.notifications.id, notificationIds));
    const created: string[] = [];
    for (const n of rows) {
      try {
        created.push(...(await this.plan(n)));
      } catch (err) {
        this.log.error(`plan ${n.id} failed: ${(err as Error).stack ?? err}`);
      }
    }
    for (const deliveryId of created) await this.jobs.enqueue(CHANNEL_JOBS.deliver, { deliveryId }, { jobId: `deliver-${deliveryId}` });
  }

  private async plan(n: NotificationRow): Promise<string[]> {
    const out: string[] = [];
    const insert = async (channel: ExternalChannel, targetRef: string) => {
      const [row] = await this.db
        .insert(s.notificationDeliveries)
        .values({ workspaceId: n.workspaceId, notificationId: n.id, channel, targetRef })
        .onConflictDoNothing()
        .returning({ id: s.notificationDeliveries.id });
      if (row) out.push(row.id);
    };

    // ผู้รับรายคน (Email, LINE ส่วนตัว) ตาม pref ของเขา
    const pref = await this.prefs(n);
    for (const sender of this.registry.personal()) {
      if (!personalEnabled(pref, sender.channel, n.eventType) || !(await sender.available(n.workspaceId))) continue;
      const target = (await sender.targetFor?.(n.recipientId)) ?? null;
      if (target) await insert(sender.channel, target);
    }

    // ส่งเข้ากลุ่ม / Webhook ตามกฎของโปรเจกต์ · เหตุการณ์เดียวมีหลายผู้รับ จึงส่งครั้งเดียว
    if (n.projectId && !(n.eventType === 'bug.created' && String(payloadOf(n).severity ?? '').toLowerCase() === 'minor')) {
      const rules = await this.db
        .select()
        .from(s.projectNotificationRules)
        .where(and(eq(s.projectNotificationRules.projectId, n.projectId), eq(s.projectNotificationRules.eventType, n.eventType), eq(s.projectNotificationRules.enabled, true)));
      for (const r of rules) {
        const [channel, target]: [ExternalChannel, string | null] = r.webhookId ? ['webhook', r.webhookId] : ['line_group', r.lineGroupId];
        if (!target || !this.registry.get(channel)) continue;
        if (channel === 'webhook') {
          const [hook] = await this.db.select({ status: s.webhookEndpoints.status }).from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, target));
          if (hook?.status !== 'active') continue;
        }
        // เหตุการณ์เดียวสร้างแจ้งเตือนหลายผู้รับด้วยคำสั่ง INSERT เดียว (created_at เท่ากันทุกแถว) → ส่งกลุ่ม / Webhook ครั้งเดียว
        const dup = await this.db.execute(sql`
          select 1 from notification_deliveries d join notifications o on o.id = d.notification_id
          where d.workspace_id = ${n.workspaceId} and d.channel = ${channel} and d.target_ref = ${target}
            and o.project_id = ${n.projectId} and o.event_type = ${n.eventType} and o.issue_id is not distinct from ${n.issueId}
            and o.created_at = (select created_at from notifications where id = ${n.id})
          limit 1`);
        if (!dup.rows.length) await insert(channel, target);
      }
    }
    return out;
  }

  private async prefs(n: NotificationRow) {
    const rows = await this.db
      .select({ channel: s.userNotificationPrefs.channel, enabled: s.userNotificationPrefs.enabled })
      .from(s.userNotificationPrefs)
      .where(and(eq(s.userNotificationPrefs.workspaceId, n.workspaceId), eq(s.userNotificationPrefs.userId, n.recipientId), eq(s.userNotificationPrefs.eventType, n.eventType)));
    return new Map(rows.map((p) => [p.channel as string, p.enabled]));
  }

  /**
   * ตรวจผู้รับรายคนซ้ำ ณ เวลาส่ง (BUG-05): รายการที่รอช่วงงดส่งหรือ retry อาจถูกส่งหลังผู้รับหมดสิทธิ์
   * คืนเหตุผลที่ไม่ส่ง หรือ null = ยังส่งได้ · ใช้สิทธิ์และ pref ล่าสุด ไม่ใช่ค่าตอนสร้างแจ้งเตือน
   */
  private async personalBlocked(n: NotificationRow, channel: ExternalChannel): Promise<string | null> {
    if (!personalEnabled(await this.prefs(n), channel, n.eventType)) return 'ผู้รับปิดช่องทางนี้ของเหตุการณ์นี้แล้ว';
    if (n.projectId) {
      const project = await this.audience.project(n.projectId);
      const issue = project && n.issueId ? await this.audience.issue(n.issueId, project.key) : null;
      if (!project || (n.issueId && !issue)) return 'ไม่พบโปรเจกต์หรืองานแล้ว';
      if (!(await this.audience.visible([n.recipientId], project, issue)).has(n.recipientId)) return 'ผู้รับไม่มีสิทธิ์เห็นข้อมูลนี้แล้ว';
      return null;
    }
    const [m] = await this.db
      .select({ userId: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, n.workspaceId), eq(s.workspaceMembers.userId, n.recipientId), eq(s.workspaceMembers.status, 'active'), isNull(s.users.disabledAt)));
    return m ? null : 'ผู้รับไม่ได้เป็นสมาชิก Workspace แล้ว';
  }

  /** ช่วงงดส่งของรายการนี้ · null = ส่งได้เสมอ */
  private async quietRule(n: NotificationRow, channel: ExternalChannel): Promise<QuietRule | null> {
    const p = payloadOf(n);
    if (channel === 'webhook' || channel === 'line_group') {
      const [cfg] = n.projectId ? await this.db.select().from(s.projectNotificationSettings).where(eq(s.projectNotificationSettings.projectId, n.projectId)) : [];
      if ((cfg?.quietMode ?? 'after_hours') === 'always_send') return null;
      if ((cfg?.criticalBugBypass ?? true) && isCritical(p)) return null;
      const [ws] = await this.db.select({ workStart: s.workspaceSettings.workStart }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, n.workspaceId));
      return { start: PROJECT_QUIET_START, end: hhmm(ws?.workStart ?? '09:30'), holidays: true };
    }
    if (isCritical(p) || isUrgent(p)) return null;
    const [u] = await this.db
      .select()
      .from(s.userNotificationSettings)
      .where(and(eq(s.userNotificationSettings.workspaceId, n.workspaceId), eq(s.userNotificationSettings.userId, n.recipientId)));
    return u ? { start: hhmm(u.quietStart), end: hhmm(u.quietEnd), holidays: u.quietOnHolidays } : DEFAULT_PERSONAL_QUIET;
  }

  private async workingDay(n: NotificationRow, project: ProjectInfo | null) {
    const cal = await this.db.transaction((tx) =>
      WorkCalendar.load(tx as Tx, { id: n.projectId ?? NIL_UUID, workspaceId: n.workspaceId, holidayCalendarId: project?.holidayCalendarId ?? null }),
    );
    return (date: string) => cal.isWorkingDay(date);
  }

  /**
   * ส่งจริง 1 รายการ · เรียกจากคิว (retry ตาม Jobs) และงาน flush
   * ช่วงงดส่ง → status skipped_quiet_hours แล้ว flush ส่งให้เมื่อพ้นช่วง
   */
  async deliver(deliveryId: string, opts: { attempt?: number; now?: Date } = {}) {
    const now = opts.now ?? new Date();
    const [d] = await this.db.select().from(s.notificationDeliveries).where(eq(s.notificationDeliveries.id, deliveryId));
    if (!d || d.status === 'sent') return;
    const [n] = await this.db.select().from(s.notifications).where(eq(s.notifications.id, d.notificationId));
    const sender = this.registry.get(d.channel as ExternalChannel);
    if (!n || !sender) return this.fail(d.id, 'ไม่พบแจ้งเตือนหรือช่องทางนี้ถูกปิด', true);
    if (!d.targetLabel) await this.db.update(s.notificationDeliveries).set({ targetLabel: await this.labelOf(d.channel as ExternalChannel, d.targetRef, n.recipientId) }).where(eq(s.notificationDeliveries.id, d.id));
    if (!GROUP_CHANNELS.has(d.channel as ExternalChannel)) {
      // ยกเลิกถาวร (ไม่ throw = ไม่ retry) และบันทึกเหตุผลไว้ใน last_error
      const blocked = await this.personalBlocked(n, d.channel as ExternalChannel);
      if (blocked) {
        await this.record(d.id, { at: now, kind: 'cancelled', message: blocked, final: true });
        return this.fail(d.id, `ยกเลิกการส่ง: ${blocked}`, true);
      }
    }
    if (d.channel === 'email') {
      // รายชื่อไม่ส่งอีเมล (O23) · ไม่ใช่ความผิดพลาด จึงไม่ retry
      const reason = await this.suppressed(d.targetRef);
      if (reason) {
        await this.record(d.id, { at: now, kind: 'suppressed', message: reason, final: true }, { status: 'suppressed', lastError: `อีเมลอยู่ในรายชื่อไม่ส่ง (${reason})` });
        return;
      }
    }

    const project = n.projectId ? await this.projectInfo(n.projectId) : null;
    const rule = await this.quietRule(n, d.channel as ExternalChannel);
    if (rule) {
      const wait = nextSendTime(now, rule, await this.workingDay(n, project));
      if (wait) {
        if (d.status !== 'skipped_quiet_hours') await this.record(d.id, { at: now, kind: 'quiet', message: wait.toISOString() }, { status: 'skipped_quiet_hours' });
        return;
      }
    }

    const [ws] = await this.db.select({ slug: s.workspaces.slug }).from(s.workspaces).where(eq(s.workspaces.id, n.workspaceId));
    const [settings] = await this.db.select({ safeMode: s.workspaceSettings.safeMode }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, n.workspaceId));
    // ช่องทางส่วนตัวใช้ภาษาของผู้รับ (Profile) · ช่องทางกลุ่มคนอ่านหลายคน จึงใช้ภาษาหลักของระบบ (ไทย)
    const locale = GROUP_CHANNELS.has(d.channel as ExternalChannel) ? 'th' : await this.localeOf(n.recipientId);
    const msg: Msg = buildMessage(
      { eventType: n.eventType, payload: payloadOf(n), projectKey: project?.key, projectName: project?.name },
      // โหมดปลอดภัยเปิดเป็นค่าเริ่มต้น (workspace_settings.safe_mode) · ส่งเฉพาะหัวข้อ + ลิงก์
      { safe: settings?.safeMode ?? true, webUrl: webUrl(), workspaceSlug: ws?.slug ?? '', locale },
    );
    const attempts = d.attempts + 1;
    try {
      const result = (await sender.send({ workspaceId: n.workspaceId, workspaceSlug: ws?.slug ?? '', recipientId: n.recipientId, targetRef: d.targetRef, msg, why: reasonIn(locale, n.reason ?? 'มีเหตุการณ์ที่เกี่ยวข้องกับคุณ') })) ?? {};
      await this.record(
        d.id,
        { at: now, kind: 'attempt_ok', attempt: attempts, status: result.response?.status ?? null },
        { status: 'sent', attempts, sentAt: now, lastError: null, ...(result.content ? { content: result.content } : {}), ...(result.response ? { response: result.response } : {}) },
      );
      if (d.channel === 'webhook') await this.db.update(s.webhookEndpoints).set({ consecutiveFailures: 0 }).where(eq(s.webhookEndpoints.id, d.targetRef));
    } catch (err) {
      const message = ((err as Error).message ?? String(err)).slice(0, 500);
      const final = err instanceof UnrecoverableError || (opts.attempt ?? 1) >= JOB_ATTEMPTS;
      const result: SendResult = err instanceof DeliveryError ? err.result : ((err as { result?: SendResult }).result ?? {});
      await this.record(
        d.id,
        { at: now, kind: 'attempt_failed', attempt: attempts, status: result.response?.status ?? null, message, final },
        { ...(result.content ? { content: result.content } : {}), ...(result.response ? { response: result.response } : {}) },
      );
      await this.fail(d.id, message, final, attempts);
      if (final && d.channel === 'webhook' && (await this.pauseWebhook(n.workspaceId, d.targetRef, message))) await this.record(d.id, { at: now, kind: 'paused' });
      throw err;
    }
  }

  private async localeOf(userId: string) {
    const [u] = await this.db.select({ locale: s.users.locale }).from(s.users).where(eq(s.users.id, userId));
    return toLocale(u?.locale);
  }

  private async fail(id: string, message: string, final: boolean, attempts?: number) {
    await this.db
      .update(s.notificationDeliveries)
      .set({ status: 'failed', lastError: message, ...(attempts ? { attempts } : {}) })
      .where(eq(s.notificationDeliveries.id, id));
    if (final) this.log.warn(`delivery ${id} failed: ${message}`);
  }

  /** ล้มครบรอบ retry → ปิด Webhook ชั่วคราวและแจ้ง Admin (Admin Console: "ส่งซ้ำเมื่อล้มเหลว 3 ครั้ง แล้วปิดชั่วคราวและแจ้ง Admin") */
  private async pauseWebhook(workspaceId: string, webhookId: string, error: string) {
    const [hook] = await this.db
      .update(s.webhookEndpoints)
      .set({ status: 'paused', consecutiveFailures: sql`${s.webhookEndpoints.consecutiveFailures} + 1` })
      .where(and(eq(s.webhookEndpoints.workspaceId, workspaceId), eq(s.webhookEndpoints.id, webhookId), eq(s.webhookEndpoints.status, 'active')))
      .returning({ name: s.webhookEndpoints.name });
    if (!hook) return false;
    const admins = await this.db
      .select({ userId: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.role, ['owner', 'admin'])));
    await this.notifier.notify({
      workspaceId,
      recipientIds: admins.map((a) => a.userId),
      eventType: 'channel.webhook_paused',
      actorId: null,
      payload: { title: hook.name, reason: error },
      reason: 'คุณเป็น Owner / Admin ของ Workspace · Webhook ส่งไม่สำเร็จติดต่อกันจึงถูกปิดชั่วคราว',
      dedupeKey: `webhook_paused:${webhookId}`,
    });
    return true;
  }

  /** ส่งรายการที่พ้นช่วงงดส่งแล้ว (งานตามเวลาทุก 10 นาที) */
  async flushQuiet(now = new Date()) {
    const rows = await this.db
      .select({ id: s.notificationDeliveries.id })
      .from(s.notificationDeliveries)
      .where(eq(s.notificationDeliveries.status, 'skipped_quiet_hours'))
      .limit(500);
    for (const r of rows) {
      try {
        await this.deliver(r.id, { now });
      } catch {
        // เก็บ error ไว้ในรายการส่งแล้ว
      }
    }
    const done = rows.length
      ? await this.db.select({ id: s.notificationDeliveries.id }).from(s.notificationDeliveries).where(and(inArray(s.notificationDeliveries.id, rows.map((r) => r.id)), eq(s.notificationDeliveries.status, 'sent')))
      : [];
    return { checked: rows.length, sent: done.length };
  }

  private async projectInfo(projectId: string): Promise<ProjectInfo | null> {
    const [p] = await this.db
      .select({ key: s.projects.key, name: s.projects.name, holidayCalendarId: s.projects.holidayCalendarId })
      .from(s.projects)
      .where(eq(s.projects.id, projectId));
    return p ?? null;
  }
}

interface ProjectInfo {
  key: string;
  name: string;
  holidayCalendarId: string | null;
}
