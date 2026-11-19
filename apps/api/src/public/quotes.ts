import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { clientIp } from '../auth/abuse-blocks.js';
import { AppError } from '../common/errors.js';
import { SYSTEM_DB } from '../db/db.module.js';

const s = schema;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

export const AcceptQuoteBody = z
  .object({
    name: z.string().trim().min(2, 'ระบุชื่อผู้ลงนาม').max(120),
    title: z.string().trim().min(2, 'ระบุตำแหน่ง').max(120),
    po: z.string().trim().max(60).optional(),
    agree: z.literal(true, 'ต้องยอมรับเงื่อนไขในใบเสนอราคา'),
  })
  .strict();
export const ChangeQuoteBody = z.object({ message: z.string().trim().min(5, 'บอกสิ่งที่อยากแก้อย่างน้อย 5 ตัวอักษร').max(2000), email: z.email().trim().toLowerCase().optional() }).strict();

/**
 * หน้าตอบรับใบเสนอราคาของลูกค้า (O55) · ไม่ต้องล็อกอิน ใช้ token ในลิงก์ (เก็บแค่ hash) · ลิงก์หมดตามวันใช้ได้ถึง
 * อ่าน / เขียนด้วย SYSTEM_DB เพราะเป็นตารางของทีม Friday · ขั้นตั้งค่าหลังตอบรับ (สัญญา สิทธิ์ ใบแจ้งหนี้) เป็นงานของ ops-api
 */
@Injectable()
export class PublicQuotesService {
  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new AppError(404, 'quote_not_found', 'ไม่พบใบเสนอราคา หรือลิงก์ถูกเปลี่ยนแล้ว');
    const [q] = await this.db
      .select({ q: s.quotes, company: s.customerAccounts.name, contacts: s.customerAccounts.contacts })
      .from(s.quotes)
      .innerJoin(s.customerAccounts, eq(s.customerAccounts.id, s.quotes.accountId))
      .where(eq(s.quotes.tokenHash, hash(token)));
    if (!q) throw new AppError(404, 'quote_not_found', 'ไม่พบใบเสนอราคา หรือลิงก์ถูกเปลี่ยนแล้ว');
    return q;
  }

  private view(r: Awaited<ReturnType<PublicQuotesService['byToken']>>) {
    const q = r.q;
    const expired = q.status === 'expired' || (q.status === 'sent' && q.validUntil < today());
    return {
      number: q.number, company: r.company, status: expired ? 'expired' : q.status, planCode: q.planCode,
      seats: q.seats, months: q.months, pricePerSeatSatang: q.pricePerSeatSatang, listPerSeatSatang: q.listPerSeatSatang,
      subtotalSatang: q.subtotalSatang, vatSatang: q.vatSatang, totalSatang: q.totalSatang,
      entitlements: q.entitlements, sla: q.sla, contractStart: q.contractStart, validUntil: q.validUntil,
      acceptedAt: q.acceptedAt, acceptedBy: (q.acceptance as { name?: string } | null)?.name ?? null,
    };
  }

  /** เปิดดู · นับครั้งที่เปิดเฉพาะตอนที่ยังรอตอบ (ทีมขายเห็นว่าลูกค้าเปิดแล้ว) */
  async get(token: string) {
    const r = await this.byToken(token);
    if (r.q.status === 'sent') await this.db.update(s.quotes).set({ viewCount: sql`${s.quotes.viewCount} + 1`, lastViewedAt: new Date() }).where(eq(s.quotes.id, r.q.id));
    return this.view(r);
  }

  async accept(token: string, input: z.infer<typeof AcceptQuoteBody>, ip?: string | null) {
    const r = await this.byToken(token);
    if (r.q.status === 'accepted') throw new AppError(409, 'quote_accepted', 'ตอบรับใบเสนอราคานี้แล้ว');
    if (r.q.status !== 'sent' || r.q.validUntil < today()) throw new AppError(410, 'quote_expired', 'ใบเสนอราคานี้หมดอายุหรือถูกยกเลิกแล้ว · ติดต่อทีมขายเพื่อขอใบใหม่');
    const [row] = await this.db
      .update(s.quotes)
      .set({ status: 'accepted', acceptedAt: new Date(), acceptance: { name: input.name, title: input.title, po: input.po ?? null, ip: clientIp(ip), at: new Date().toISOString() } })
      .where(and(eq(s.quotes.id, r.q.id), eq(s.quotes.status, 'sent')))
      .returning({ id: s.quotes.id });
    if (!row) throw new AppError(409, 'quote_accepted', 'ตอบรับใบเสนอราคานี้แล้ว');
    return this.view(await this.byToken(token));
  }

  /** ขอแก้ไข → Ticket เข้าคิว Support เดิม (ผู้แจ้ง = อีเมลที่กรอก หรือผู้ลงนามในบัญชีลูกค้า) */
  async requestChange(token: string, input: z.infer<typeof ChangeQuoteBody>) {
    const r = await this.byToken(token);
    if (r.q.status !== 'sent') throw new AppError(409, 'quote_closed', 'ใบเสนอราคานี้ปิดแล้ว');
    const contacts = (r.contacts ?? []) as { email?: string; role?: string }[];
    const email = input.email ?? contacts.find((c) => c.role === 'signer' && c.email)?.email ?? contacts.find((c) => c.email)?.email;
    if (!email) throw new AppError(422, 'email_required', 'ระบุอีเมลที่ให้ทีมขายตอบกลับ');
    await this.db.transaction(async (tx) => {
      await tx.update(s.quotes).set({ changeRequest: input.message }).where(eq(s.quotes.id, r.q.id));
      const [t] = await tx
        .insert(s.supportTickets)
        .values({ workspaceId: r.q.workspaceId, requesterEmail: email, channel: 'email', category: 'billing', priority: 'high', subject: `ขอแก้ไขใบเสนอราคา ${r.q.number} · ${r.company}` })
        .returning({ id: s.supportTickets.id });
      await tx.insert(s.supportTicketMessages).values({ ticketId: t.id, authorKind: 'customer', body: input.message });
    });
    return { received: true };
  }
}
