import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { today } from '../common/dates.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Notifier } from '../notifications/notifier.js';
import { ProjectsService } from '../projects/projects.service.js';
import { loadContext, type Mode } from '../project-structure/context.js';
import { Jobs } from '../queue/jobs.js';
import { localParts } from './quiet.js';

const s = schema;
const Id = z.string().uuid();

const EventType = z
  .string()
  .regex(/^[a-z_]+\.[a-z_]+$/, 'ชื่อเหตุการณ์ไม่ถูกต้อง')
  // คำขอเลื่อน Due ส่งเฉพาะคนที่มีสิทธิ์อนุมัติ ไม่ส่งเข้ากลุ่ม (L2)
  .refine((v) => !v.startsWith('due_request.'), 'คำขอเลื่อน Due ส่งเข้ากลุ่มหรือ Webhook ไม่ได้');

export const RulesBody = z.object({
  rules: z
    .array(
      z
        .object({ eventType: EventType, enabled: z.boolean().default(true), webhookId: Id.nullish(), lineGroupId: Id.nullish() })
        .refine((r) => (r.webhookId ? 1 : 0) + (r.lineGroupId ? 1 : 0) === 1, 'เลือกปลายทางได้อย่างเดียว: Webhook หรือ LINE กลุ่ม'),
    )
    .max(200),
});
export const SettingsBody = z.object({ quietMode: z.enum(['after_hours', 'always_send']), criticalBugBypass: z.boolean().default(true) });
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'รูปแบบเวลา HH:MM');
export const ScheduleBody = z.object({
  weekday: z.number().int().min(1).max(7),
  time: Time.default('09:00'),
  channels: z.array(z.enum(['email', 'line', 'line_group', 'webhook'])).max(4).default([]),
  recipients: z.array(Id).max(100).default([]),
});

const isoWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** L2 › การแจ้งเตือนของโปรเจกต์ และ O2 › รายงานรายสัปดาห์ที่ตั้งเวลาส่ง */
@Injectable()
export class ProjectNotifyService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly notifier: Notifier,
    private readonly jobs: Jobs,
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  async onModuleInit() {
    this.jobs.define('channels.weekly-reports', () => this.runDueSchedules());
    await this.jobs.every('channels.weekly-reports', '*/15 * * * *');
  }

  private ctx<T>(auth: AuthInfo, tenant: TenantInfo, key: string, mode: Mode, fn: (tx: Parameters<Parameters<TenantDb['run']>[2]>[0], project: Awaited<ReturnType<typeof loadContext>>['project']) => Promise<T>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await loadContext(tx, this.projects, auth, tenant, key, mode);
      return fn(tx, project);
    });
  }

  // กฎ ------------------------------------------------------------------------------
  getRules(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.ctx(auth, tenant, key, 'read', async (tx, project) => {
      const rules = await tx.select().from(s.projectNotificationRules).where(eq(s.projectNotificationRules.projectId, project.id)).orderBy(s.projectNotificationRules.eventType, s.projectNotificationRules.createdAt);
      const hooks = await tx.select({ id: s.webhookEndpoints.id, name: s.webhookEndpoints.name, format: s.webhookEndpoints.format, status: s.webhookEndpoints.status }).from(s.webhookEndpoints).orderBy(s.webhookEndpoints.name);
      const groups = await tx.select({ id: s.lineGroups.id, name: s.lineGroups.name }).from(s.lineGroups).orderBy(s.lineGroups.name);
      return {
        rules: rules.map((r) => ({ id: r.id, eventType: r.eventType, enabled: r.enabled, webhookId: r.webhookId, lineGroupId: r.lineGroupId })),
        // ปลายทางที่เลือกได้ (ตั้งเพิ่มที่ Admin Console › ช่องทางแจ้งเตือน)
        targets: { webhooks: hooks, lineGroups: groups },
      };
    });
  }

  putRules(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof RulesBody>) {
    return this.ctx(auth, tenant, key, 'write', async (tx, project) => {
      const seen = new Set<string>();
      for (const r of body.rules) {
        const k = `${r.eventType}|${r.webhookId ?? r.lineGroupId}`;
        if (seen.has(k)) throw new AppError(400, 'invalid_input', 'มีกฎซ้ำ (เหตุการณ์และปลายทางเดียวกัน)', { fields: [{ path: 'rules', message: k }] });
        seen.add(k);
      }
      const hookIds = [...new Set(body.rules.flatMap((r) => (r.webhookId ? [r.webhookId] : [])))];
      const groupIds = [...new Set(body.rules.flatMap((r) => (r.lineGroupId ? [r.lineGroupId] : [])))];
      const okHooks = hookIds.length ? (await tx.select({ id: s.webhookEndpoints.id }).from(s.webhookEndpoints).where(inArray(s.webhookEndpoints.id, hookIds))).length : 0;
      const okGroups = groupIds.length ? (await tx.select({ id: s.lineGroups.id }).from(s.lineGroups).where(inArray(s.lineGroups.id, groupIds))).length : 0;
      if (okHooks !== hookIds.length || okGroups !== groupIds.length) throw new AppError(422, 'target_not_found', 'ไม่พบ Webhook หรือ LINE กลุ่มที่เลือก');
      await tx.delete(s.projectNotificationRules).where(eq(s.projectNotificationRules.projectId, project.id));
      if (body.rules.length) {
        await tx.insert(s.projectNotificationRules).values(
          body.rules.map((r) => ({ workspaceId: tenant.workspaceId, projectId: project.id, eventType: r.eventType, enabled: r.enabled, webhookId: r.webhookId ?? null, lineGroupId: r.lineGroupId ?? null })),
        );
      }
      await this.audit(tx, auth, tenant, project, 'project.notification_rules_updated', `${body.rules.length} กฎ`);
      return { rules: body.rules.length };
    }).then(() => this.getRules(auth, tenant, key));
  }

  // ช่วงงดส่ง ------------------------------------------------------------------------
  getSettings(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.ctx(auth, tenant, key, 'read', async (tx, project) => {
      const [c] = await tx.select().from(s.projectNotificationSettings).where(eq(s.projectNotificationSettings.projectId, project.id));
      return { quietMode: c?.quietMode ?? 'after_hours', criticalBugBypass: c?.criticalBugBypass ?? true };
    });
  }

  putSettings(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof SettingsBody>) {
    return this.ctx(auth, tenant, key, 'write', async (tx, project) => {
      const values = { workspaceId: tenant.workspaceId, projectId: project.id, quietMode: body.quietMode, criticalBugBypass: body.criticalBugBypass };
      await tx.insert(s.projectNotificationSettings).values(values).onConflictDoUpdate({ target: s.projectNotificationSettings.projectId, set: values });
      await this.audit(tx, auth, tenant, project, 'project.notification_settings_updated', body.quietMode);
      return { quietMode: body.quietMode, criticalBugBypass: body.criticalBugBypass };
    });
  }

  // รายงานรายสัปดาห์ ---------------------------------------------------------------------
  getSchedule(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.ctx(auth, tenant, key, 'read', async (tx, project) => {
      const [c] = await tx.select().from(s.reportSchedules).where(and(eq(s.reportSchedules.projectId, project.id), eq(s.reportSchedules.reportType, 'weekly')));
      return { schedule: c ? this.scheduleDto(c) : null };
    });
  }

  putSchedule(auth: AuthInfo, tenant: TenantInfo, key: string, body: z.infer<typeof ScheduleBody>) {
    return this.ctx(auth, tenant, key, 'write', async (tx, project) => {
      const values = { workspaceId: tenant.workspaceId, projectId: project.id, reportType: 'weekly', weekday: body.weekday, time: body.time, channels: body.channels, recipients: body.recipients };
      const [c] = await tx.insert(s.reportSchedules).values(values).onConflictDoUpdate({ target: [s.reportSchedules.projectId, s.reportSchedules.reportType], set: values }).returning();
      await this.audit(tx, auth, tenant, project, 'project.report_schedule_updated', `weekly วัน ${body.weekday} ${body.time}`);
      return { schedule: this.scheduleDto(c) };
    });
  }

  private scheduleDto(c: typeof s.reportSchedules.$inferSelect) {
    return { reportType: c.reportType, weekday: c.weekday, time: c.time.slice(0, 5), channels: c.channels, recipients: c.recipients as string[] };
  }

  /** `POST p/reports/weekly:send` · ส่งรายงานสัปดาห์นี้ทันที */
  sendWeekly(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.ctx(auth, tenant, key, 'write', async (tx, project) => {
      const [sched] = await tx.select().from(s.reportSchedules).where(and(eq(s.reportSchedules.projectId, project.id), eq(s.reportSchedules.reportType, 'weekly')));
      const sent = await this.sendReport({ id: project.id, key: project.key, name: project.name, workspaceId: tenant.workspaceId, ownerUserId: project.ownerUserId }, (sched?.recipients as string[] | undefined) ?? [], undefined);
      return { sent };
    });
  }

  /** งานตามเวลา: ส่งรายงานของโปรเจกต์ที่ถึงวัน / เวลาตามที่ตั้ง · ส่งวันละครั้ง (dedupeKey) แม้งานนี้รันซ้ำ */
  async runDueSchedules(now = new Date()) {
    const { date, minutes } = localParts(now);
    const rows = await this.system
      .select({ sched: s.reportSchedules, key: s.projects.key, name: s.projects.name, ownerUserId: s.projects.ownerUserId })
      .from(s.reportSchedules)
      .innerJoin(s.projects, eq(s.projects.id, s.reportSchedules.projectId))
      .where(and(eq(s.reportSchedules.reportType, 'weekly'), eq(s.reportSchedules.weekday, isoWeekday(date)), isNull(s.projects.deletedAt), isNull(s.projects.archivedAt)));
    let sent = 0;
    for (const r of rows) {
      const [h, m] = r.sched.time.split(':').map(Number);
      if ((h ?? 0) * 60 + (m ?? 0) > minutes) continue;
      sent += await this.sendReport({ id: r.sched.projectId, key: r.key, name: r.name, workspaceId: r.sched.workspaceId, ownerUserId: r.ownerUserId }, r.sched.recipients as string[], `weekly:${r.sched.projectId}:${date}`, date);
    }
    return { date, sent };
  }

  private async sendReport(project: { id: string; key: string; name: string; workspaceId: string; ownerUserId: string }, recipients: string[], dedupeKey: string | undefined, date = today()) {
    // ข้อมูลสรุปอย่างง่ายจากตารางงานโดยตรง · เมื่อ A09 (reports) merge แล้วเปลี่ยนมาใช้ข้อมูลชุดเดียวกับหน้า Reports
    const [c] = (
      await this.system.execute(sql`
        select count(*) filter (where completed_at >= now() - interval '7 days')::int as done,
               count(*) filter (where completed_at is null and plan_end < ${date})::int as overdue,
               count(*) filter (where completed_at is null)::int as open
        from issues where project_id = ${project.id} and deleted_at is null`)
    ).rows as Array<{ done: number; overdue: number; open: number }>;
    const wanted = recipients.length ? recipients : [project.ownerUserId];
    // ผู้รับต้องเป็นสมาชิก Workspace ที่ active เท่านั้น
    const members = await this.system
      .select({ userId: s.workspaceMembers.userId })
      .from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.workspaceId, project.workspaceId), eq(s.workspaceMembers.status, 'active'), inArray(s.workspaceMembers.userId, wanted)));
    if (!members.length) return 0;
    await this.notifier.notify({
      workspaceId: project.workspaceId,
      recipientIds: members.map((m) => m.userId),
      eventType: 'report.weekly',
      // รายงานเป็นข้อความของระบบ ไม่มีผู้ทำ (ผู้กดส่งเองก็เป็นผู้รับได้)
      actorId: null,
      projectId: project.id,
      payload: { projectKey: project.key, projectName: project.name, title: `รายงานสรุปสัปดาห์ ${project.key}`, date, done: c?.done ?? 0, overdue: c?.overdue ?? 0, open: c?.open ?? 0 },
      reason: 'คุณอยู่ในรายชื่อผู้รับรายงานรายสัปดาห์ของโปรเจกต์นี้',
      dedupeKey,
    });
    return members.length;
  }

  private async audit(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], auth: AuthInfo, tenant: TenantInfo, project: { id: string; key: string }, action: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType: 'project', targetId: project.id, summary: `${project.key} · ${summary}` });
  }
}
