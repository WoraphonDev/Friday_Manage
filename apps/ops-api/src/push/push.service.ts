import { createECDH, createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import webpush from 'web-push';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import type { StaffRole } from '../auth/roles.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';

const s = schema;
const b64url = (b: Buffer) => b.toString('base64url');

/**
 * กุญแจ VAPID: production ตั้ง OPS_VAPID_PUBLIC_KEY / OPS_VAPID_PRIVATE_KEY (สร้างด้วย `npx web-push generate-vapid-keys`)
 * dev / test ไม่ตั้ง = สร้างจาก OPS_AUTH_SECRET ให้คงที่ (การสมัครเดิมใช้ได้ต่อหลัง restart) · production ไม่ตั้ง = ปิด Web Push
 */
function vapidKeys(): { publicKey: string; privateKey: string } | null {
  const pub = process.env.OPS_VAPID_PUBLIC_KEY;
  const priv = process.env.OPS_VAPID_PRIVATE_KEY;
  if (pub && priv) return { publicKey: pub, privateKey: priv };
  if (process.env.NODE_ENV === 'production') return null;
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(createHash('sha256').update(`${config.secret}:vapid`).digest());
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

export const SubscribeBody = z
  .object({
    endpoint: z.url().max(1000).refine((u) => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'ปลายทางต้องเป็น https'),
    keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
    userAgent: z.string().trim().max(300).optional(),
  })
  .strict();
export const UnsubscribeBody = z.object({ endpoint: z.url().max(1000) }).strict();

export interface PushMessage {
  title: string;
  body: string;
  /** หน้าที่เปิดเมื่อแตะแจ้งเตือน (path ของ ops-web เช่น /m/approvals?id=…) */
  url: string;
  /** แจ้งเตือนที่ tag เดียวกันแทนที่อันเดิมบนเครื่อง */
  tag?: string;
}

/** ส่ง Web Push ถึงพนักงาน (O25) · ส่งไม่ได้ไม่ทำให้งานหลักล้ม · test แทน `sender` ได้ */
@Injectable()
export class PushService {
  private readonly log = new Logger('OpsPush');
  readonly keys = vapidKeys();
  /** ข้อความที่ส่ง (test ตรวจได้) */
  readonly sent: { staffId: string; message: PushMessage }[] = [];
  sender = (sub: webpush.PushSubscription, payload: string) =>
    webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', vapidDetails: { subject: process.env.OPS_VAPID_SUBJECT ?? 'mailto:ops@fridaymanage.com', ...this.keys! } });

  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  async status(staff: Staff) {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.staffPushSubscriptions).where(eq(s.staffPushSubscriptions.staffId, staff.id));
    return { enabled: !!this.keys, publicKey: this.keys?.publicKey ?? null, devices: r.n };
  }

  async subscribe(staff: Staff, input: z.infer<typeof SubscribeBody>) {
    if (!this.keys) throw new AppError(503, 'push_disabled', 'ยังไม่ได้ตั้งค่า Web Push (OPS_VAPID_PUBLIC_KEY / OPS_VAPID_PRIVATE_KEY)');
    const values = { staffId: staff.id, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent ?? null };
    // endpoint เดิมของคนอื่น (ใช้เครื่องร่วมกัน) ย้ายมาเป็นของคนที่สมัครล่าสุด
    await this.db.insert(s.staffPushSubscriptions).values(values).onConflictDoUpdate({ target: s.staffPushSubscriptions.endpoint, set: values });
    await staffAudit(this.db, staff, 'push.subscribed', `เปิดแจ้งเตือนในมือถือ${input.userAgent ? ` · ${input.userAgent.slice(0, 80)}` : ''}`);
    return this.status(staff);
  }

  async unsubscribe(staff: Staff, input: z.infer<typeof UnsubscribeBody>) {
    const r = await this.db.delete(s.staffPushSubscriptions).where(and(eq(s.staffPushSubscriptions.staffId, staff.id), eq(s.staffPushSubscriptions.endpoint, input.endpoint))).returning({ id: s.staffPushSubscriptions.id });
    if (r.length) await staffAudit(this.db, staff, 'push.unsubscribed', 'ปิดแจ้งเตือนในมือถือ');
    return this.status(staff);
  }

  /** ส่งถึงพนักงานตาม id · คืนจำนวนเครื่องที่ส่งสำเร็จ */
  async toStaff(ids: string[], message: PushMessage) {
    const unique = [...new Set(ids)];
    if (!unique.length) return 0;
    for (const staffId of unique) this.sent.push({ staffId, message });
    if (!this.keys) return 0;
    const subs = await this.db.select().from(s.staffPushSubscriptions).where(inArray(s.staffPushSubscriptions.staffId, unique));
    let ok = 0;
    const payload = JSON.stringify(message);
    for (const sub of subs) {
      try {
        await this.sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        await this.db.update(s.staffPushSubscriptions).set({ lastSentAt: new Date() }).where(eq(s.staffPushSubscriptions.id, sub.id));
        ok++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // เครื่องยกเลิกการสมัครแล้ว
        if (code === 404 || code === 410) await this.db.delete(s.staffPushSubscriptions).where(eq(s.staffPushSubscriptions.id, sub.id));
        else this.log.warn(`ส่ง Web Push ไม่ได้ (${code ?? 'network'}): ${String((e as Error).message).slice(0, 200)}`);
      }
    }
    return ok;
  }

  /** ส่งถึงทุกคนที่มีบทบาท (ใช้งานอยู่ ยังไม่หมดอายุ) · `except` = ไม่ส่งถึงคนที่ทำรายการเอง */
  async toRoles(roles: StaffRole[], message: PushMessage, except?: string) {
    const rows = await this.db
      .select({ id: s.staffUsers.id })
      .from(s.staffUsers)
      .where(sql`${s.staffUsers.status} = 'active' and ${s.staffUsers.roles} && ${sql.raw(`ARRAY[${roles.map((r) => `'${r}'`).join(', ')}]::text[]`)} and (${s.staffUsers.expiresAt} is null or ${s.staffUsers.expiresAt} > now())`);
    return this.toStaff(rows.map((r) => r.id).filter((id) => id !== except), message);
  }

  /** ส่งครั้งเดียวต่อ key (เช่น `payment-sla:<id>`) · คืน false ถ้าเคยส่งแล้ว */
  async once(key: string, send: () => Promise<unknown>) {
    const r = await this.db.insert(s.staffPushNotices).values({ key }).onConflictDoNothing().returning({ key: s.staffPushNotices.key });
    if (!r.length) return false;
    await send();
    return true;
  }

  async test(staff: Staff) {
    const devices = await this.toStaff([staff.id], { title: 'Friday Ops', body: 'ทดสอบแจ้งเตือน · ถ้าเห็นข้อความนี้แปลว่าตั้งค่าเรียบร้อย', url: '/m', tag: 'test' });
    return { devices };
  }
}
