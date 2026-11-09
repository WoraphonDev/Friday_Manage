import { resolveTxt } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { webUrl } from '../auth/auth.config.js';
import { Mailer } from '../core/mail.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { buildMessage, type Msg } from './message.js';
import { jsonPayload, renderEmail, renderWebhook, type WebhookFormat } from './render.js';
import { last4, openSecret, sealSecret } from './secrets.js';
import { assertPublicUrl, EmailSender, postWebhook } from './senders.js';

const s = schema;

/** อ่าน TXT record · แยกเป็น class เพื่อให้ test แทนที่ได้ */
@Injectable()
export class DnsChecker {
  async txt(name: string): Promise<string[]> {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch {
      return [];
    }
  }
}

const Id = z.string().uuid();
export const EmailBody = z.object({
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.string().trim().toLowerCase().email().max(254),
  replyTo: z.string().trim().toLowerCase().email().max(254).nullish(),
  smtpHost: z.string().trim().min(1).max(253).nullish(),
  smtpPort: z.number().int().min(1).max(65535).nullish(),
  smtpUser: z.string().trim().max(254).nullish(),
  /** ไม่ส่ง = ใช้ค่าเดิม · ส่ง null = ลบ */
  smtpPassword: z.string().max(500).nullish(),
});
export const CreateWebhookBody = z.object({
  name: z.string().trim().min(1).max(80),
  format: z.enum(['json', 'discord', 'slack', 'teams', 'telegram']).default('json'),
  url: z.string().trim().url().max(2000),
  signingSecret: z.string().min(8).max(200).nullish(),
  /** ให้ระบบสร้าง signing secret ให้ · แสดงค่าเต็มครั้งเดียวในคำตอบ */
  generateSecret: z.boolean().default(false),
});
export const PatchWebhookBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  format: z.enum(['json', 'discord', 'slack', 'teams', 'telegram']).optional(),
  url: z.string().trim().url().max(2000).optional(),
  signingSecret: z.string().min(8).max(200).nullish(),
  /** ส่ง active เพื่อเปิดใช้ Webhook ที่ถูกปิดชั่วคราวอีกครั้ง */
  status: z.enum(['active', 'paused']).optional(),
});
export const DeliveriesQuery = z.object({
  status: z.enum(['queued', 'sent', 'failed', 'skipped_quiet_hours']).optional(),
  channel: z.enum(['email', 'line', 'line_group', 'webhook']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});
export const PreviewQuery = z.object({
  channel: z.enum(['line', 'email', 'webhook']).default('email'),
  format: z.enum(['json', 'discord', 'slack', 'teams', 'telegram']).default('json'),
  safe: z.enum(['true', 'false']).optional(),
});

/** ตัวอย่างข้อมูลของหน้า N2 (ข้อมูลสมมติ) */
const SAMPLES: Record<string, { payload: Record<string, unknown>; why: string }> = {
  'issue.assigned': { payload: { actorName: 'Mick', issueKey: 'DP-40', issueTitle: 'คำนวณมูลค่าหลักประกันตามสัดส่วน', projectKey: 'DP', projectName: 'Development Plan', priority: 'Medium', planEnd: '2026-12-11' }, why: 'คุณเป็น Assignee' },
  'due_request.created': { payload: { actorName: 'Kaijeaw', issueKey: 'DP-30', issueTitle: 'Curtailment Information', projectKey: 'DP', projectName: 'Development Plan', planEnd: '2026-12-04', reason: 'รอ BA ยืนยันแบบฟอร์ม' }, why: 'คุณมีสิทธิ์อนุมัติคำขอเลื่อน Due' },
  'bug.created': { payload: { actorName: 'Donut', issueKey: 'DP-525', issueTitle: 'Workflow ส่งกลับแก้ไข: สถานะไม่กลับเป็น Draft', projectKey: 'DP', projectName: 'Development Plan', severity: 'Major' }, why: 'คุณเป็น Watcher' },
  'digest.daily': { payload: { projectKey: 'DP', projectName: 'Development Plan', title: 'สรุปงานวันนี้', dueToday: 2, overdue: 7, inReview: 4 }, why: 'คุณเปิด Daily digest ไว้' },
};

@Injectable()
export class ChannelsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly dns: DnsChecker,
    private readonly mailer: Mailer,
    private readonly email: EmailSender,
  ) {}

  private admin(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.settings');
  }

  // Email ---------------------------------------------------------------------
  private emailDto(c: typeof s.emailSenderConfigs.$inferSelect | undefined) {
    if (!c) return { configured: false, mode: this.mailer.enabled ? 'friday' : 'disabled', config: null };
    return {
      configured: true,
      // ยังไม่ยืนยันโดเมน ระบบส่งด้วยโดเมนของ Friday ไปก่อน
      mode: c.verifiedAt && c.smtpHost ? 'custom' : this.mailer.enabled ? 'friday' : 'disabled',
      config: {
        fromName: c.fromName,
        fromEmail: c.fromEmail,
        replyTo: c.replyTo,
        smtpHost: c.smtpHost,
        smtpPort: c.smtpPort,
        smtpUser: c.smtpUser,
        smtpPasswordLast4: c.smtpPasswordLast4,
        dns: { spf: c.spfOk, dkim: c.dkimOk, dmarc: c.dmarcOk },
        verifiedAt: c.verifiedAt,
      },
    };
  }

  async getEmail(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    const [c] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.emailSenderConfigs));
    return this.emailDto(c);
  }

  async putEmail(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof EmailBody>) {
    this.admin(tenant);
    if ((body.smtpHost == null) !== (body.smtpPort == null)) throw new AppError(400, 'invalid_input', 'ต้องระบุ SMTP host และ port คู่กัน', { fields: [{ path: 'smtpHost', message: 'ระบุทั้ง host และ port' }] });
    return this.db.run(auth, tenant, async (tx) => {
      const [old] = await tx.select().from(s.emailSenderConfigs);
      // เปลี่ยนโดเมนผู้ส่งหรือ SMTP ต้องตรวจ DNS ใหม่
      const changed = !old || old.fromEmail !== body.fromEmail || old.smtpHost !== (body.smtpHost ?? null) || old.smtpPort !== (body.smtpPort ?? null);
      const password = body.smtpPassword === undefined ? undefined : body.smtpPassword === null ? null : body.smtpPassword;
      const values = {
        workspaceId: tenant.workspaceId,
        fromName: body.fromName,
        fromEmail: body.fromEmail,
        replyTo: body.replyTo ?? null,
        smtpHost: body.smtpHost ?? null,
        smtpPort: body.smtpPort ?? null,
        smtpUser: body.smtpUser ?? null,
        ...(password === undefined ? {} : { smtpPasswordEncrypted: password ? sealSecret(password) : null, smtpPasswordLast4: password ? last4(password) : null }),
        ...(changed ? { spfOk: false, dkimOk: false, dmarcOk: false, verifiedAt: null } : {}),
      };
      const [saved] = await tx.insert(s.emailSenderConfigs).values(values).onConflictDoUpdate({ target: s.emailSenderConfigs.workspaceId, set: values }).returning();
      await this.audit(tx, auth, tenant, 'channel.email_updated', saved.id, saved.fromEmail);
      return this.emailDto(saved);
    });
  }

  /** ตรวจ SPF / DKIM (selector `friday`) / DMARC ของโดเมนผู้ส่ง · ผ่านครบจึงถือว่ายืนยันแล้ว */
  async verifyDns(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const [c] = await tx.select().from(s.emailSenderConfigs);
      if (!c) throw notFound('การตั้งค่าอีเมล');
      const domain = c.fromEmail.split('@')[1]!;
      const has = async (name: string, prefix: string) => (await this.dns.txt(name)).some((r) => r.toLowerCase().startsWith(prefix));
      const spf = await has(domain, 'v=spf1');
      const dkim = await has(`friday._domainkey.${domain}`, 'v=dkim1');
      const dmarc = await has(`_dmarc.${domain}`, 'v=dmarc1');
      const [saved] = await tx
        .update(s.emailSenderConfigs)
        .set({ spfOk: spf, dkimOk: dkim, dmarcOk: dmarc, verifiedAt: spf && dkim && dmarc ? new Date() : null })
        .where(eq(s.emailSenderConfigs.id, c.id))
        .returning();
      await this.audit(tx, auth, tenant, 'channel.email_dns_verified', c.id, `${domain} spf=${spf} dkim=${dkim} dmarc=${dmarc}`);
      return this.emailDto(saved);
    });
  }

  /** ส่งอีเมลทดสอบถึงผู้เรียก */
  async testEmail(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    const to = await this.email.targetFor(auth.userId);
    if (!to) throw notFound('ผู้ใช้');
    const via = await this.email.resolve(tenant.workspaceId);
    if (!via) throw new AppError(409, 'email_not_configured', 'ยังไม่ได้ตั้งค่าการส่งอีเมล');
    try {
      await this.mailer.send({ to, subject: '[Friday] อีเมลทดสอบ', text: 'นี่คืออีเมลทดสอบจาก Friday Manage · ถ้าคุณอ่านข้อความนี้ได้ แสดงว่าการตั้งค่าอีเมลใช้งานได้', from: via.from, replyTo: via.replyTo }, via.smtp);
    } catch (err) {
      throw new AppError(502, 'email_send_failed', 'ส่งอีเมลทดสอบไม่สำเร็จ', { reason: (err as Error).message.slice(0, 300) });
    }
    return { sent: true, to };
  }

  // Webhook -------------------------------------------------------------------
  private hookDto(h: typeof s.webhookEndpoints.$inferSelect, usedBy: Array<{ projectKey: string; eventType: string }> = []) {
    return {
      id: h.id,
      name: h.name,
      format: h.format,
      urlLast4: h.urlLast4,
      signed: !!h.signingSecretEncrypted,
      signingSecretLast4: h.signingSecretLast4,
      status: h.status,
      consecutiveFailures: h.consecutiveFailures,
      usedBy,
      createdAt: h.createdAt,
    };
  }

  async listWebhooks(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const hooks = await tx.select().from(s.webhookEndpoints).orderBy(s.webhookEndpoints.createdAt);
      const uses = await tx
        .select({ webhookId: s.projectNotificationRules.webhookId, projectKey: s.projects.key, eventType: s.projectNotificationRules.eventType })
        .from(s.projectNotificationRules)
        .innerJoin(s.projects, eq(s.projects.id, s.projectNotificationRules.projectId))
        .where(eq(s.projectNotificationRules.enabled, true));
      return { items: hooks.map((h) => this.hookDto(h, uses.filter((u) => u.webhookId === h.id).map((u) => ({ projectKey: u.projectKey, eventType: u.eventType })))) };
    });
  }

  private async checkUrl(url: string) {
    try {
      await assertPublicUrl(url);
    } catch (err) {
      throw new AppError(400, 'webhook_url_invalid', (err as Error).message, { fields: [{ path: 'url', message: (err as Error).message }] });
    }
  }

  async createWebhook(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof CreateWebhookBody>) {
    this.admin(tenant);
    await this.checkUrl(body.url);
    const secret = body.signingSecret ?? (body.generateSecret ? randomBytes(24).toString('base64url') : null);
    return this.db.run(auth, tenant, async (tx) => {
      const [h] = await tx
        .insert(s.webhookEndpoints)
        .values({
          workspaceId: tenant.workspaceId,
          name: body.name,
          format: body.format,
          urlEncrypted: sealSecret(body.url),
          urlLast4: last4(body.url),
          signingSecretEncrypted: secret ? sealSecret(secret) : null,
          signingSecretLast4: secret ? last4(secret) : null,
        })
        .returning();
      await this.audit(tx, auth, tenant, 'channel.webhook_created', h.id, h.name);
      // ค่าเต็มของ secret ที่ระบบสร้างให้ แสดงครั้งเดียวตอนสร้างเท่านั้น
      return { ...this.hookDto(h), ...(body.generateSecret && !body.signingSecret ? { signingSecret: secret } : {}) };
    });
  }

  async patchWebhook(auth: AuthInfo, tenant: TenantInfo, id: string, body: z.infer<typeof PatchWebhookBody>) {
    this.admin(tenant);
    if (body.url) await this.checkUrl(body.url);
    return this.db.run(auth, tenant, async (tx) => {
      const [h] = await tx.update(s.webhookEndpoints).set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.format ? { format: body.format } : {}),
        ...(body.url ? { urlEncrypted: sealSecret(body.url), urlLast4: last4(body.url) } : {}),
        ...(body.signingSecret === undefined ? {} : { signingSecretEncrypted: body.signingSecret ? sealSecret(body.signingSecret) : null, signingSecretLast4: body.signingSecret ? last4(body.signingSecret) : null }),
        ...(body.status ? { status: body.status, consecutiveFailures: 0 } : {}),
      }).where(and(eq(s.webhookEndpoints.id, id), eq(s.webhookEndpoints.workspaceId, tenant.workspaceId))).returning();
      if (!h) throw notFound('Webhook');
      await this.audit(tx, auth, tenant, 'channel.webhook_updated', h.id, h.name);
      return this.hookDto(h);
    });
  }

  async deleteWebhook(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.admin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const [h] = await tx.delete(s.webhookEndpoints).where(and(eq(s.webhookEndpoints.id, id), eq(s.webhookEndpoints.workspaceId, tenant.workspaceId))).returning();
      if (!h) throw notFound('Webhook');
      await this.audit(tx, auth, tenant, 'channel.webhook_deleted', h.id, h.name);
      return { deleted: true };
    });
  }

  /** ส่งข้อความทดสอบทันที (ไม่ผ่านคิว) เพื่อให้เห็นผลลัพธ์ในหน้าตั้งค่า */
  async testWebhook(auth: AuthInfo, tenant: TenantInfo, id: string) {
    this.admin(tenant);
    const [h] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, id)));
    if (!h) throw notFound('Webhook');
    const msg = this.sampleMessage('issue.assigned', tenant.slug, true).msg;
    try {
      await postWebhook({ format: h.format as WebhookFormat, url: openSecret(h.urlEncrypted), signingSecret: h.signingSecretEncrypted ? openSecret(h.signingSecretEncrypted) : null }, msg, tenant.slug);
    } catch (err) {
      throw new AppError(502, 'webhook_test_failed', 'ส่ง Webhook ทดสอบไม่สำเร็จ', { reason: (err as Error).message.slice(0, 300) });
    }
    return { ok: true };
  }

  // ประวัติการส่ง -----------------------------------------------------------------
  async deliveries(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof DeliveriesQuery>) {
    this.admin(tenant);
    // notification_deliveries เห็นทั้ง Workspace เฉพาะ Admin (RLS 0009) แต่ notifications เห็นเฉพาะของตัวเอง
    // จึงอ่านรายการส่งภายใต้ RLS ก่อน แล้วค่อยหาชนิดเหตุการณ์ / ผู้รับด้วย SYSTEM_DB (จำกัด Workspace เดียวกัน)
    const rows = await this.db.run(auth, tenant, (tx) =>
      tx
        .select()
        .from(s.notificationDeliveries)
        .where(and(q.status ? eq(s.notificationDeliveries.status, q.status) : undefined, q.channel ? eq(s.notificationDeliveries.channel, q.channel) : undefined, q.before ? lt(s.notificationDeliveries.createdAt, new Date(q.before)) : undefined))
        .orderBy(desc(s.notificationDeliveries.createdAt), desc(s.notificationDeliveries.id))
        .limit(q.limit + 1),
    );
    const page = rows.slice(0, q.limit);
    const notes = page.length
      ? await this.system
          .select({ id: s.notifications.id, eventType: s.notifications.eventType, recipientId: s.notifications.recipientId })
          .from(s.notifications)
          .where(and(eq(s.notifications.workspaceId, tenant.workspaceId), inArray(s.notifications.id, page.map((r) => r.notificationId))))
      : [];
    const hooks = await this.db.run(auth, tenant, (tx) => tx.select({ id: s.webhookEndpoints.id, name: s.webhookEndpoints.name }).from(s.webhookEndpoints));
    const noteBy = new Map(notes.map((n) => [n.id, n]));
    const hookName = new Map(hooks.map((h) => [h.id, h.name]));
    const items = page.map((r) => ({
      id: r.id,
      channel: r.channel,
      targetRef: r.targetRef,
      target: (r.channel === 'webhook' ? hookName.get(r.targetRef) : undefined) ?? r.targetRef,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
      eventType: noteBy.get(r.notificationId)?.eventType ?? null,
      recipientId: noteBy.get(r.notificationId)?.recipientId ?? null,
    }));
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.createdAt.toISOString() : null };
  }

  // N2 · ตัวอย่างข้อความ ----------------------------------------------------------------
  private sampleMessage(event: string, slug: string, safe: boolean): { msg: Msg; why: string } {
    const sample = SAMPLES[event] ?? { payload: { actorName: 'Mick', issueKey: 'DP-1', issueTitle: 'ตัวอย่างงาน', projectKey: 'DP', projectName: 'Development Plan' }, why: 'คุณเกี่ยวข้องกับเหตุการณ์นี้' };
    return { msg: buildMessage({ eventType: event, payload: sample.payload }, { safe, webUrl: webUrl(), workspaceSlug: slug }), why: sample.why };
  }

  async preview(auth: AuthInfo, tenant: TenantInfo, event: string, q: z.infer<typeof PreviewQuery>) {
    this.admin(tenant);
    const [cfg] = await this.db.run(auth, tenant, (tx) => tx.select({ safeMode: s.workspaceSettings.safeMode }).from(s.workspaceSettings));
    const safe = q.safe ? q.safe === 'true' : (cfg?.safeMode ?? true);
    const { msg, why } = this.sampleMessage(event, tenant.slug, safe);
    const rendered =
      q.channel === 'email' ? renderEmail(msg, why, `${webUrl()}/work/${tenant.slug}/profile`) : q.channel === 'webhook' ? renderWebhook(q.format, msg, tenant.slug) : jsonPayload(msg, tenant.slug);
    return { event, channel: q.channel, safeMode: safe, message: msg, rendered };
  }

  private async audit(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], auth: AuthInfo, tenant: TenantInfo, action: string, targetId: string, summary: string) {
    await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'data', action, targetType: 'channel', targetId, summary });
  }
}

export { Id };
