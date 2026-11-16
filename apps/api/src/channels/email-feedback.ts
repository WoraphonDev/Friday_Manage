import { createPublicKey, type KeyObject, timingSafeEqual, verify, X509Certificate } from 'node:crypto';
import { Controller, HttpCode, Inject, Injectable, Logger, Post, Query, type RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors.js';
import { Public } from '../common/request.js';
import { SYSTEM_DB } from '../db/db.module.js';
import type { DeliveryLogEntry } from './dispatcher.js';

const s = schema;
const DAY = 86_400_000;
/** bounce ชั่วคราว (เช่น กล่องเต็ม) ต่างวันกันครบจำนวนนี้ภายใน 7 วัน → ไม่ส่งอีก (Canvas: "กล่องเต็มติดต่อกัน 5 วัน") */
const SOFT_BOUNCE_DAYS = 5;

/**
 * token ของ URL ที่ผู้ให้บริการอีเมลเรียก (SNS subscription: `.../hooks/email-feedback?token=...`)
 * production ต้องตั้ง EMAIL_FEEDBACK_TOKEN · dev / test ใช้ค่าคงที่ให้ตัวจำลองในเครื่องเรียกได้
 * ลายเซ็น SNS ตรวจเพิ่มใน SnsVerifier (token อย่างเดียวรั่วจาก log ได้)
 */
function expectedToken() {
  return process.env.EMAIL_FEEDBACK_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'dev-email-feedback');
}

interface SesNotification {
  notificationType?: string;
  eventType?: string;
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[] };
  complaint?: { complaintFeedbackType?: string; complainedRecipients?: { emailAddress?: string }[] };
}

type Kind = 'bounce_permanent' | 'bounce_transient' | 'complaint';

type SnsEnvelope = Record<string, unknown> & { Type?: string };
const SNS_TYPES = ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'];
/** ใบรับรองและ SubscribeURL ต้องมาจาก SNS ของ AWS เท่านั้น (กันชี้ไปเซิร์ฟเวอร์อื่น / SSRF) */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** URL ของ SNS จริง: https + host sns.<region>.amazonaws.com */
export function isSnsUrl(raw: unknown, pem = false) {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname) && !u.port && (!pem || u.pathname.endsWith('.pem'));
  } catch {
    return false;
  }
}

/** ข้อความที่ SNS เซ็น (เรียงตามชื่อ field · Subject มีเฉพาะ Notification ที่ใส่หัวข้อ) */
export function snsStringToSign(m: SnsEnvelope) {
  const keys = m.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys
    .filter((k) => !(k === 'Subject' && (m.Subject === undefined || m.Subject === null)))
    .map((k) => `${k}\n${String(m[k] ?? '')}\n`)
    .join('');
}

/**
 * ตรวจลายเซ็นของข้อความ SNS (SignatureVersion 1 = SHA1withRSA · 2 = SHA256withRSA) และ TopicArn ที่อนุญาต
 * เปิดเมื่อ SNS_VERIFY=on หรือ production (ปิดได้ด้วย SNS_VERIFY=off ตอนทดสอบในเครื่องที่ไม่มี AWS)
 * test แทน `fetchCert` / `confirm` ด้วยกุญแจที่สร้างเองได้
 */
@Injectable()
export class SnsVerifier {
  private readonly log = new Logger('SnsVerifier');
  private readonly certs = new Map<string, KeyObject>();
  fetchCert = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!res.ok) throw new Error(`ดึงใบรับรองไม่ได้ (${res.status})`);
    return res.text();
  };
  confirm = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!res.ok) throw new Error(`ยืนยันการสมัครไม่ได้ (${res.status})`);
  };

  get enabled() {
    const flag = process.env.SNS_VERIFY;
    return flag === 'on' || (process.env.NODE_ENV === 'production' && flag !== 'off');
  }

  /** TopicArn ที่รับ (คั่นด้วยจุลภาค) · ว่าง = ไม่รับเลยเมื่อเปิดตรวจ เพราะใครก็สร้าง Topic ของตัวเองแล้วเซ็นถูกต้องได้ */
  get allowedTopics() {
    return (process.env.SNS_ALLOWED_TOPIC_ARNS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  }

  private async key(url: string) {
    const hit = this.certs.get(url);
    if (hit) return hit;
    const pem = await this.fetchCert(url);
    // ใบรับรอง X.509 ของ AWS · test ส่ง public key PEM มาแทนได้
    const key = pem.includes('BEGIN CERTIFICATE') ? new X509Certificate(pem).publicKey : createPublicKey(pem);
    // ใบรับรองของ SNS เปลี่ยนไม่บ่อย · จำไว้ทั้งโปรเซส (จำกัดจำนวนกันโตไม่หยุด)
    if (this.certs.size > 50) this.certs.clear();
    this.certs.set(url, key);
    return key;
  }

  async check(m: SnsEnvelope) {
    if (!SNS_TYPES.includes(String(m.Type))) throw new AppError(400, 'sns_required', 'ต้องเป็นข้อความจาก Amazon SNS');
    const version = String(m.SignatureVersion ?? '');
    if (version !== '1' && version !== '2') throw new AppError(400, 'sns_signature_version', 'ไม่รองรับ SignatureVersion นี้');
    if (!isSnsUrl(m.SigningCertURL, true)) throw new AppError(400, 'sns_cert_url', 'SigningCertURL ต้องเป็น https ของ sns.*.amazonaws.com');
    if (typeof m.Signature !== 'string' || !m.Signature) throw new AppError(400, 'sns_signature_missing', 'ไม่มีลายเซ็น');
    let key: KeyObject;
    try {
      key = await this.key(String(m.SigningCertURL));
    } catch (e) {
      this.log.warn(`SNS cert: ${(e as Error).message}`);
      throw new AppError(502, 'sns_cert_unavailable', 'ดึงใบรับรองของ SNS ไม่ได้');
    }
    const ok = verify(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256', Buffer.from(snsStringToSign(m), 'utf8'), key, Buffer.from(m.Signature, 'base64'));
    if (!ok) throw new AppError(401, 'sns_signature_invalid', 'ลายเซ็นของ SNS ไม่ถูกต้อง');
    if (!this.allowedTopics.includes(String(m.TopicArn ?? ''))) throw new AppError(403, 'sns_topic_not_allowed', 'TopicArn นี้ไม่อยู่ในรายการที่อนุญาต (SNS_ALLOWED_TOPIC_ARNS)');
  }
}


/**
 * รับ bounce / complaint จากผู้ให้บริการอีเมล (รูปแบบ Amazon SES ผ่าน SNS · ตัวจำลองในเครื่องส่งรูปเดียวกัน)
 * bounce ถาวร / รายงานสแปม → เพิ่มในรายชื่อไม่ส่งทันที · bounce ชั่วคราวซ้ำหลายวัน → เพิ่มเช่นกัน
 * ใช้ SYSTEM_DB เพราะเรียกจากเซิร์ฟเวอร์ภายนอก ไม่รู้ Workspace และตารางเหล่านี้เป็นของทีม Friday (RLS ops_only)
 */
@Injectable()
export class EmailFeedbackService {
  private readonly log = new Logger('EmailFeedback');

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly sns: SnsVerifier,
  ) {}

  async receive(raw: string, token: string | undefined) {
    const want = expectedToken();
    if (!want) throw new AppError(503, 'email_feedback_not_configured', 'ยังไม่ได้ตั้ง EMAIL_FEEDBACK_TOKEN');
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'invalid_token', 'token ไม่ถูกต้อง');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AppError(400, 'invalid_body', 'ต้องเป็น JSON');
    }
    // ซอง SNS: Notification ห่อข้อความของ SES ไว้ใน Message
    if (this.sns.enabled) await this.sns.check(body);
    if (body.Type === 'SubscriptionConfirmation') {
      // ยืนยันอัตโนมัติเฉพาะเมื่อตรวจลายเซ็นแล้ว · ปิดตรวจ (dev) = log URL ไว้ให้กดเอง กันถูกหลอกให้เรียก URL ภายนอก
      if (!this.sns.enabled || !isSnsUrl(body.SubscribeURL)) {
        this.log.warn(`SNS SubscriptionConfirmation · ยืนยันที่ ${String(body.SubscribeURL ?? '')}`);
        return { accepted: 0, subscription: 'pending' };
      }
      try {
        await this.sns.confirm(String(body.SubscribeURL));
      } catch (e) {
        this.log.error(`ยืนยัน SNS ไม่ได้: ${(e as Error).message}`);
        throw new AppError(502, 'sns_confirm_failed', 'ยืนยันการสมัคร SNS ไม่สำเร็จ');
      }
      this.log.log(`ยืนยัน SNS แล้ว · ${String(body.TopicArn ?? '')}`);
      return { accepted: 0, subscription: 'confirmed' };
    }
    if (body.Type === 'UnsubscribeConfirmation') return { accepted: 0, subscription: 'unsubscribed' };
    const n = (typeof body.Message === 'string' ? JSON.parse(body.Message) : body) as SesNotification;
    const type = n.notificationType ?? n.eventType;
    const items: { email: string; kind: Kind; detail: string | null }[] = [];
    if (type === 'Bounce') {
      const permanent = n.bounce?.bounceType === 'Permanent';
      for (const r of n.bounce?.bouncedRecipients ?? []) {
        if (r.emailAddress) items.push({ email: r.emailAddress, kind: permanent ? 'bounce_permanent' : 'bounce_transient', detail: r.diagnosticCode ?? n.bounce?.bounceSubType ?? null });
      }
    } else if (type === 'Complaint') {
      for (const r of n.complaint?.complainedRecipients ?? []) if (r.emailAddress) items.push({ email: r.emailAddress, kind: 'complaint', detail: n.complaint?.complaintFeedbackType ?? null });
    }
    let suppressed = 0;
    for (const it of items) if (await this.apply(it, n)) suppressed++;
    return { accepted: items.length, suppressed };
  }

  private async apply(it: { email: string; kind: Kind; detail: string | null }, raw: SesNotification) {
    const email = it.email.trim().toLowerCase();
    await this.db.insert(s.emailFeedbackEvents).values({ email, kind: it.kind, detail: it.detail, raw });
    // รายการส่งล่าสุดถึงอีเมลนี้ (3 วัน) ได้บันทึกว่าปลายทางตีกลับ · ใช้ตอบลูกค้าว่า "ทำไมไม่ได้รับ"
    const [last] = await this.db
      .select({ id: s.notificationDeliveries.id, workspaceId: s.notificationDeliveries.workspaceId })
      .from(s.notificationDeliveries)
      .where(and(eq(s.notificationDeliveries.channel, 'email'), sql`lower(${s.notificationDeliveries.targetRef}) = ${email}`, gte(s.notificationDeliveries.createdAt, new Date(Date.now() - 3 * DAY))))
      .orderBy(desc(s.notificationDeliveries.createdAt))
      .limit(1);
    if (last) {
      const entry: DeliveryLogEntry = { at: new Date().toISOString(), kind: it.kind === 'complaint' ? 'complained' : 'bounced', message: it.detail ?? it.kind };
      await this.db
        .update(s.notificationDeliveries)
        .set({ log: sql`${s.notificationDeliveries.log} || ${JSON.stringify([entry])}::jsonb` })
        .where(eq(s.notificationDeliveries.id, last.id));
    }
    let reason: 'hard_bounce' | 'complaint' | 'soft_bounce_repeated' | null = it.kind === 'bounce_permanent' ? 'hard_bounce' : it.kind === 'complaint' ? 'complaint' : null;
    if (!reason) {
      const [row] = await this.db
        .select({ days: sql<number>`count(distinct (${s.emailFeedbackEvents.createdAt} AT TIME ZONE 'Asia/Bangkok')::date)::int` })
        .from(s.emailFeedbackEvents)
        .where(and(sql`lower(${s.emailFeedbackEvents.email}) = ${email}`, eq(s.emailFeedbackEvents.kind, 'bounce_transient'), gte(s.emailFeedbackEvents.createdAt, new Date(Date.now() - 7 * DAY))));
      if ((row?.days ?? 0) >= SOFT_BOUNCE_DAYS) reason = 'soft_bounce_repeated';
    }
    if (!reason) return false;
    const [active] = await this.db
      .select({ id: s.emailSuppressions.id })
      .from(s.emailSuppressions)
      .where(and(sql`lower(${s.emailSuppressions.email}) = ${email}`, isNull(s.emailSuppressions.removedAt)));
    if (active) return false;
    await this.db
      .insert(s.emailSuppressions)
      .values({ email, reason, detail: it.detail, workspaceId: last?.workspaceId ?? null, source: 'ses' })
      .onConflictDoNothing();
    return true;
  }
}

/** Webhook ขาเข้าจากผู้ให้บริการอีเมล · SNS ส่ง Content-Type text/plain จึงอ่านจาก rawBody */
@Controller('hooks/email-feedback')
export class EmailFeedbackController {
  constructor(private readonly feedback: EmailFeedbackService) {}

  @Public()
  @Post()
  @HttpCode(200)
  hook(@Req() req: RawBodyRequest<Request>, @Query('token') token?: string) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.feedback.receive(raw || JSON.stringify(req.body ?? {}), token);
  }
}
