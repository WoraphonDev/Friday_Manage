import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq } from 'drizzle-orm';
import { UnrecoverableError } from '../queue/jobs.js';
import { Mailer, type SmtpConfig } from '../core/mail.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { webUrl } from '../auth/auth.config.js';
import type { Msg } from './message.js';
import { renderEmail, renderWebhook, sign, type WebhookFormat } from './render.js';
import { openSecret } from './secrets.js';

const s = schema;

export type ExternalChannel = 'email' | 'line' | 'line_group' | 'webhook';

export interface SendContext {
  workspaceId: string;
  workspaceSlug: string;
  recipientId: string;
  targetRef: string;
  msg: Msg;
  /** "ทำไมฉันได้รับแจ้ง" */
  why: string;
}

/**
 * ช่องทางส่งออกนอกแอป · LINE (A24) ลงทะเบียน sender ของตัวเองด้วย `ChannelRegistry.register`
 * - personal: ส่งหาผู้รับตาม pref ของเขา (user_notification_prefs)
 * - project: ส่งตามกฎของโปรเจกต์ (project_notification_rules) ไปยัง target ที่กฎระบุ
 * `send` ล้มให้ throw (ลองใหม่ด้วยคิว) · โยน UnrecoverableError เมื่อลองใหม่ไม่มีประโยชน์
 */
export interface ChannelSender {
  readonly channel: ExternalChannel;
  readonly scope: 'personal' | 'project';
  /** Workspace นี้ส่งช่องทางนี้ได้ไหม (ตั้งค่าครบ / เปิดใช้) · ไม่ได้ = ไม่สร้างรายการส่ง */
  available(workspaceId: string): Promise<boolean>;
  /** ผู้รับเริ่มต้นของ personal: เปิดอยู่ถ้าผู้ใช้ไม่เคยตั้ง pref */
  targetFor?(recipientId: string): Promise<string | null>;
  send(ctx: SendContext): Promise<void>;
}

@Injectable()
export class ChannelRegistry {
  private readonly senders = new Map<ExternalChannel, ChannelSender>();

  register(sender: ChannelSender) {
    this.senders.set(sender.channel, sender);
  }

  get(channel: ExternalChannel) {
    return this.senders.get(channel);
  }

  personal() {
    return [...this.senders.values()].filter((x) => x.scope === 'personal');
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** อีเมลที่ Workspace ตั้งไว้ (ถ้ามี) หรือของระบบ */
@Injectable()
export class EmailSender implements ChannelSender {
  readonly channel = 'email' as const;
  readonly scope = 'personal' as const;

  constructor(
    private readonly mailer: Mailer,
    @Inject(SYSTEM_DB) private readonly db: Db,
  ) {}

  /** ค่า SMTP ของ Workspace ใช้เมื่อยืนยันโดเมนแล้ว · ไม่งั้นส่งผ่านระบบ แสดงชื่อของ Workspace และตอบกลับไปที่อีเมลที่ตั้งไว้ */
  async resolve(workspaceId: string): Promise<{ smtp?: SmtpConfig; from?: string; replyTo?: string } | null> {
    const [cfg] = await this.db.select().from(s.emailSenderConfigs).where(eq(s.emailSenderConfigs.workspaceId, workspaceId));
    if (cfg?.verifiedAt && cfg.smtpHost) {
      return {
        smtp: {
          host: cfg.smtpHost,
          port: cfg.smtpPort ?? 587,
          user: cfg.smtpUser,
          pass: cfg.smtpPasswordEncrypted ? openSecret(cfg.smtpPasswordEncrypted) : null,
        },
        from: `${cfg.fromName} <${cfg.fromEmail}>`,
        replyTo: cfg.replyTo ?? undefined,
      };
    }
    if (!this.mailer.enabled) return null;
    const fallback = process.env.MAIL_FROM?.match(/<([^>]+)>/)?.[1] ?? process.env.MAIL_FROM ?? 'no-reply@localhost';
    return cfg ? { from: `${cfg.fromName} <${fallback}>`, replyTo: cfg.replyTo ?? cfg.fromEmail } : {};
  }

  async available(workspaceId: string) {
    return (await this.resolve(workspaceId)) !== null;
  }

  async targetFor(recipientId: string) {
    const [u] = await this.db.select({ email: s.users.email }).from(s.users).where(eq(s.users.id, recipientId));
    return u?.email ?? null;
  }

  async send(ctx: SendContext) {
    const via = await this.resolve(ctx.workspaceId);
    if (!via) throw new UnrecoverableError('ยังไม่ได้ตั้งค่าการส่งอีเมล');
    const mail = renderEmail(ctx.msg, ctx.why, `${webUrl()}/w/${ctx.workspaceSlug}/profile`);
    await this.mailer.send({ to: ctx.targetRef, ...mail, from: via.from, replyTo: via.replyTo }, via.smtp);
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

function isPrivateAddress(ip: string): boolean {
  const v6 = ip.toLowerCase();
  const mapped = v6.startsWith('::ffff:') ? v6.slice(7) : null;
  if (mapped && isIP(mapped) === 4) return isPrivateAddress(mapped);
  if (isIP(ip) === 6) return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Webhook ปลายทางเป็นที่อยู่ที่ผู้ใช้กรอกเอง จึงกัน SSRF: ต้องเป็น http(s) (production = https) และไม่ชี้เข้าเครือข่ายภายใน
 * ตั้ง WEBHOOK_ALLOW_PRIVATE=1 เฉพาะเครื่อง dev / test ที่ปลายทางอยู่ในเครื่อง
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnrecoverableError('URL ไม่ถูกต้อง');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && process.env.NODE_ENV !== 'production')) {
    throw new UnrecoverableError('Webhook ต้องเป็น https');
  }
  if (process.env.WEBHOOK_ALLOW_PRIVATE === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new UnrecoverableError('หา Host ของ Webhook ไม่พบ');
  if (addrs.some(isPrivateAddress)) throw new UnrecoverableError('Webhook ชี้เข้าเครือข่ายภายในไม่ได้');
  return u;
}

export interface WebhookTarget {
  format: WebhookFormat;
  url: string;
  signingSecret: string | null;
}

/** ส่ง 1 ครั้ง · ไม่ตาม redirect (กัน redirect เข้าเครือข่ายภายใน) · timeout 10 วินาที */
export async function postWebhook(target: WebhookTarget, msg: Msg, workspace: string): Promise<void> {
  const url = await assertPublicUrl(target.url);
  const body = JSON.stringify(renderWebhook(target.format, msg, workspace, { chatId: url.searchParams.get('chat_id') ?? undefined }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'FridayManage-Webhook/1',
    'x-friday-delivery': randomUUID(),
    'x-friday-timestamp': timestamp,
  };
  if (target.signingSecret) headers['x-friday-signature'] = sign(target.signingSecret, timestamp, body);
  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (res.status >= 300) throw new Error(`Webhook ตอบ HTTP ${res.status}`);
}

@Injectable()
export class WebhookSender implements ChannelSender {
  readonly channel = 'webhook' as const;
  readonly scope = 'project' as const;

  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  async available() {
    return true;
  }

  async send(ctx: SendContext) {
    const [hook] = await this.db
      .select()
      .from(s.webhookEndpoints)
      .where(and(eq(s.webhookEndpoints.workspaceId, ctx.workspaceId), eq(s.webhookEndpoints.id, ctx.targetRef)));
    if (!hook) throw new UnrecoverableError('Webhook ถูกลบแล้ว');
    if (hook.status !== 'active') throw new UnrecoverableError('Webhook ถูกปิดชั่วคราว');
    await postWebhook(
      {
        format: hook.format,
        url: openSecret(hook.urlEncrypted),
        signingSecret: hook.signingSecretEncrypted ? openSecret(hook.signingSecretEncrypted) : null,
      },
      ctx.msg,
      ctx.workspaceSlug,
    );
  }
}
