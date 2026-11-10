import { timingSafeEqual } from 'node:crypto';
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
 * TODO(I01): ตรวจลายเซ็นของ SNS และยืนยัน SubscriptionConfirmation เมื่อขึ้น AWS จริง
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

/**
 * รับ bounce / complaint จากผู้ให้บริการอีเมล (รูปแบบ Amazon SES ผ่าน SNS · ตัวจำลองในเครื่องส่งรูปเดียวกัน)
 * bounce ถาวร / รายงานสแปม → เพิ่มในรายชื่อไม่ส่งทันที · bounce ชั่วคราวซ้ำหลายวัน → เพิ่มเช่นกัน
 * ใช้ SYSTEM_DB เพราะเรียกจากเซิร์ฟเวอร์ภายนอก ไม่รู้ Workspace และตารางเหล่านี้เป็นของทีม Friday (RLS ops_only)
 */
@Injectable()
export class EmailFeedbackService {
  private readonly log = new Logger('EmailFeedback');

  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

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
    // ซอง SNS: Notification ห่อข้อความของ SES ไว้ใน Message · SubscriptionConfirmation ยืนยันเองตอนตั้งค่า AWS (I01)
    if (body.Type === 'SubscriptionConfirmation') {
      this.log.warn(`SNS SubscriptionConfirmation · ยืนยันที่ ${String(body.SubscribeURL ?? '')}`);
      return { accepted: 0, subscription: 'pending' };
    }
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
