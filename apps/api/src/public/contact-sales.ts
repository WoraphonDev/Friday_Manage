import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, gt, inArray, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { clientIp, SIGNUP_BLOCKED, signupBlocked } from '../auth/abuse-blocks.js';
import { AppError } from '../common/errors.js';
import type { AppRequest } from '../common/request.js';
import { SYSTEM_DB } from '../db/db.module.js';

const s = schema;
const WINDOW_MS = 10 * 60_000;
/** ส่งฟอร์มได้ 5 ครั้งต่อ IP ต่อ 10 นาที (คนจริงส่งครั้งเดียว · กันสคริปต์) */
const PER_IP = 5;
export const NEEDS = ['sso', 'annual_contract', 'tax_invoice', 'onboarding', 'api', 'security_review', 'other'] as const;

export const ContactSalesBody = z
  .object({
    company: z.string().trim().min(2, 'ระบุชื่อบริษัท').max(200),
    contactName: z.string().trim().min(2, 'ระบุชื่อผู้ติดต่อ').max(120),
    contactTitle: z.string().trim().max(120).optional(),
    email: z.email('อีเมลไม่ถูกต้อง').trim().toLowerCase().max(254),
    phone: z.string().trim().max(40).optional(),
    teamSize: z.number().int().min(1).max(100_000),
    needs: z.array(z.enum(NEEDS)).max(NEEDS.length).default([]),
    message: z.string().trim().max(3000).optional(),
    /** ต้องยินยอมให้ติดต่อกลับ (PDPA) */
    consent: z.literal(true, 'ต้องยินยอมให้ทีม Friday ติดต่อกลับ'),
    /** ช่องดักบอท (ซ่อนจากคน) · มีค่า = บอท */
    website: z.string().max(200).optional(),
  })
  .strict();

/** จำกัดต่อ IP แบบหน้าศูนย์ช่วยเหลือ · นับในหน่วยความจำ */
@Injectable()
export class ContactSalesLimit implements CanActivate {
  private readonly hits = new Map<string, { at: number; n: number }>();
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.at >= WINDOW_MS) this.hits.delete(k);
    const cur = this.hits.get(key);
    const entry = !cur || now - cur.at >= WINDOW_MS ? { at: now, n: 0 } : cur;
    entry.n++;
    this.hits.set(key, entry);
    if (entry.n > PER_IP) {
      const retryAfter = Math.max(1, Math.ceil((entry.at + WINDOW_MS - now) / 1000));
      ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw new AppError(429, 'rate_limited', `ส่งบ่อยเกินไป · ลองใหม่ใน ${Math.ceil(retryAfter / 60)} นาที`, { retryAfter });
    }
    return true;
  }
  reset() {
    this.hits.clear();
  }
}

/**
 * ฟอร์มติดต่อฝ่ายขาย (O54) → Lead ในหลังบ้าน · เขียนด้วย SYSTEM_DB เพราะเป็นตารางของทีม Friday และผู้ส่งยังไม่มีบัญชี
 * อีเมลเดิมที่ยังเปิดอยู่ภายใน 30 วัน = เพิ่มบันทึกในดีลเดิม ไม่สร้างซ้ำ · บอท (ช่องดัก) ตอบเหมือนสำเร็จแต่ไม่บันทึก
 */
@Injectable()
export class ContactSalesService {
  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  async submit(input: z.infer<typeof ContactSalesBody>, ip?: string | null) {
    if (input.website) return { received: true };
    if (await signupBlocked(this.db, input.email, ip)) throw new AppError(403, 'signup_blocked', SIGNUP_BLOCKED);
    const summary = [`ขนาดทีม ${input.teamSize} คน`, input.needs.length ? `ต้องการ ${input.needs.join(', ')}` : null, input.message ?? null].filter(Boolean).join(' · ');
    return this.db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: s.leads.id })
        .from(s.leads)
        .where(and(sql`lower(${s.leads.email}) = ${input.email}`, inArray(s.leads.stage, ['new', 'contacted', 'demo', 'proposal']), gt(s.leads.createdAt, sql`now() - interval '30 days'`)))
        .limit(1);
      if (open) {
        await tx.insert(s.leadNotes).values({ leadId: open.id, kind: 'system', body: `ส่งฟอร์มติดต่อฝ่ายขายอีกครั้ง · ${summary}` });
        return { received: true };
      }
      const [lead] = await tx
        .insert(s.leads)
        .values({
          company: input.company, contactName: input.contactName, contactTitle: input.contactTitle ?? null, email: input.email, phone: input.phone ?? null,
          teamSize: input.teamSize, seats: input.teamSize, needs: input.needs, message: input.message ?? null, source: 'form', consentAt: new Date(), ip: clientIp(ip),
        })
        .returning({ id: s.leads.id });
      await tx.insert(s.leadNotes).values({ leadId: lead.id, kind: 'system', body: `ส่งฟอร์มติดต่อฝ่ายขาย · ${summary}` });
      return { received: true };
    });
  }
}
