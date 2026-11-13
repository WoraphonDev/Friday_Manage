import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Audience, eligibleTenant } from './audience.js';

const { npsSettings, userUiStates: ui, supportTickets: tk, workspaces, users } = schema;
const DAY = 86_400_000;
const TZ = 'Asia/Bangkok';

export type NpsSettings = typeof npsSettings.$inferSelect;
/** ค่าเดียวกับ default ของตาราง (O32 · คำตัดสิน U5) · ใช้เมื่อยังไม่มีแถว (ฐานข้อมูลทดสอบที่ล้างตาราง) */
export const NPS_DEFAULTS: NpsSettings = {
  id: 1,
  enabled: true,
  audience: 'admins',
  firstAfterDays: 30,
  repeatDays: 90,
  samplePct: 50,
  excludeTrialDays: 14,
  excludeTicketDays: 7,
  excludeSpotlightDay: true,
  excludeShortMobile: true,
  question: 'คุณจะแนะนำ Friday Work Management ให้เพื่อนหรือเพื่อนร่วมงานไหม',
  questionEn: null,
  followUps: { detractor: 'อะไรที่เราควรปรับให้ดีขึ้นที่สุด', passive: 'อะไรที่จะทำให้ให้ 10 คะแนน', promoter: 'ชอบอะไรที่สุด' },
  followUpsEn: null,
  topics: ['speed', 'usability', 'missing_feature', 'price', 'mobile'],
  updatedBy: null,
  updatedAt: new Date(0),
};

export const AnswerBody = z
  .object({
    workspace: z.string().trim().min(1, 'ระบุ Workspace'),
    score: z.number().int().min(0).max(10),
    comment: z.string().trim().max(2000, 'ความเห็นยาวไม่เกิน 2,000 ตัวอักษร').optional(),
    topics: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  })
  .strict();
export const DismissBody = z.object({ workspace: z.string().trim().min(1, 'ระบุ Workspace') }).strict();
/** mobile / sessionSeconds: เว็บบอกว่าเปิดบนมือถือและใช้งานมากี่วินาที (เงื่อนไข "มือถือใช้งานไม่ถึง 2 นาที" ของ U5) */
export const PromptQuery = z
  .object({
    workspace: z.string().trim().min(1, 'ระบุ Workspace'),
    mobile: z.enum(['true', 'false']).optional(),
    sessionSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
  })
  .strict();
/** มือถือต้องใช้งานอย่างน้อยเท่านี้ก่อนถาม เมื่อเปิด exclude_short_mobile */
export const SHORT_MOBILE_SECONDS = 120;

/** กลุ่มคะแนนของ NPS: 0–6 ไม่พอใจ · 7–8 เฉย ๆ · 9–10 แนะนำต่อ */
export const groupOf = (score: number) => (score <= 6 ? 'detractor' : score <= 8 ? 'passive' : 'promoter');

/** วันตามเวลาไทย (YYYY-MM-DD) · ใช้ตัดสิน "≤ 1 ครั้งต่อวัน" และ "วันที่เห็น Spotlight" */
const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

/**
 * สุ่มแบบคงที่ต่อคนต่อรอบ (repeat_days): เรียกซ้ำกี่ครั้งในรอบเดียวกันก็ได้ผลเดิม จึงไม่ใช่ "สุ่มจนกว่าจะโดน"
 * รอบใหม่สุ่มใหม่ ให้คนที่ไม่ถูกเลือกรอบนี้มีโอกาสรอบหน้า
 */
export function sampled(userId: string, pct: number, repeatDays: number, now = new Date()) {
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const period = Math.floor(now.getTime() / DAY / Math.max(1, repeatDays));
  const n = createHash('sha256').update(`${userId}:${period}`).digest().readUInt32BE(0) % 100;
  return n < pct;
}

interface Device {
  mobile: boolean;
  sessionSeconds?: number;
}

type Skip = 'disabled' | 'role' | 'short_mobile' | 'asked_today' | 'answered_recently' | 'too_new' | 'trial' | 'ticket' | 'spotlight_today' | 'not_sampled';

/**
 * แบบสำรวจ NPS ในแอป (U3 · ตั้งค่าใน U5 ของ Friday Ops)
 * - คำตอบเขียนผ่าน TenantDb.run (RLS: เพิ่ม / อ่านได้เฉพาะแถวของตัวเองใน Workspace ปัจจุบัน) · ไม่ส่งเนื้อหาไป product_events
 * - ถามได้ ≤ 1 ครั้งต่อวัน และซ้ำทุก repeat_days ต่อคน (ข้าม Workspace) ตาม user_ui_states
 * - แบบสอบถามตอนยกเลิกแพ็กเกจอยู่ที่ W22 / cancellation-feedback (ไม่ทำซ้ำที่นี่)
 */
@Injectable()
export class NpsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audience: Audience,
    // support_tickets เป็นตารางของทีม Friday (ลูกค้าไม่มีสิทธิ์อ่าน) · อ่านเฉพาะว่ามี Ticket ค้าง / เพิ่งปิดหรือไม่ ด้วย SYSTEM_DB
    @Inject(SYSTEM_DB) private readonly system: Db,
  ) {}

  private async settings(tx: Tx): Promise<NpsSettings> {
    const [row] = await tx.select().from(npsSettings).where(eq(npsSettings.id, 1));
    return row ?? NPS_DEFAULTS;
  }

  private async state(tx: Tx, userId: string) {
    const [row] = await tx.select().from(ui).where(eq(ui.userId, userId));
    return row ?? null;
  }

  private allowedRole(s: NpsSettings, tenant: TenantInfo) {
    if (tenant.role === 'guest') return false;
    return s.audience === 'members' || tenant.role === 'owner' || tenant.role === 'admin';
  }

  /** เหตุผลที่ไม่ถาม (null = ถามได้) · เรียงจากเงื่อนไขที่ไม่ต้องอ่านเพิ่มก่อน */
  private async skip(tx: Tx, auth: AuthInfo, tenant: TenantInfo, s: NpsSettings, now: Date, device: Device): Promise<Skip | null> {
    if (!s.enabled) return 'disabled';
    if (!this.allowedRole(s, tenant)) return 'role';
    // ยังไม่บันทึกว่าถาม: เว็บถามใหม่ได้เมื่อใช้งานครบเวลา
    if (s.excludeShortMobile && device.mobile && (device.sessionSeconds ?? 0) < SHORT_MOBILE_SECONDS) return 'short_mobile';
    const st = await this.state(tx, auth.userId);
    const today = dayOf(now);
    if (st?.npsPromptedAt && dayOf(st.npsPromptedAt) === today) return 'asked_today';
    if (st?.npsRespondedAt && now.getTime() - st.npsRespondedAt.getTime() < s.repeatDays * DAY) return 'answered_recently';
    if (!st?.npsRespondedAt) {
      const [user] = await tx.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, auth.userId));
      if (user && now.getTime() - user.createdAt.getTime() < s.firstAfterDays * DAY) return 'too_new';
    }
    if (s.excludeSpotlightDay && st?.spotlightSeenAt && dayOf(st.spotlightSeenAt) === today) return 'spotlight_today';
    if (s.excludeTrialDays !== null) {
      const sub = await this.audience.subscription(tenant.workspaceId);
      const [ws] = await tx.select({ createdAt: workspaces.createdAt }).from(workspaces).where(eq(workspaces.id, tenant.workspaceId));
      // ทดลองใช้อยู่และ Workspace อายุยังไม่ถึงเกณฑ์ (ยังไม่ได้ลองจริงพอจะให้คะแนน)
      if (sub.status === 'trialing' && ws && now.getTime() - ws.createdAt.getTime() < s.excludeTrialDays * DAY) return 'trial';
    }
    if (s.excludeTicketDays !== null) {
      const since = new Date(now.getTime() - s.excludeTicketDays * DAY);
      // Ticket ของผู้ใช้เอง หรือของ Workspace นี้ ที่ยังเปิดอยู่ / ปิดไม่ถึงเกณฑ์ (เพิ่งมีปัญหา ไม่ควรถามความพอใจ)
      const [hit] = await this.system
        .select({ id: tk.id })
        .from(tk)
        .where(
          and(
            or(eq(tk.requesterUserId, auth.userId), eq(tk.workspaceId, tenant.workspaceId)),
            or(sql`${tk.status} in ('open', 'pending_customer', 'pending_dev')`, sql`coalesce(${tk.closedAt}, ${tk.solvedAt}, ${tk.updatedAt}) > ${since}`),
          ),
        )
        .limit(1);
      if (hit) return 'ticket';
    }
    if (!sampled(auth.userId, s.samplePct, s.repeatDays, now)) return 'not_sampled';
    return null;
  }

  /**
   * GET me/nps-prompt · ตัดสินว่าจะถามไหม · ถาม = บันทึกเวลาที่แสดง (ไม่ถามซ้ำในวันเดียวกัน)
   * เว็บเรียกเมื่อพร้อมแสดงจริงเท่านั้น (ไม่มี Spotlight / Dialog อื่น) · มือถือส่ง mobile + sessionSeconds มาให้ตัดสินเงื่อนไข "ใช้งานไม่ถึง 2 นาที"
   */
  async prompt(auth: AuthInfo, slug: string, device: Device = { mobile: false }, now = new Date()) {
    const tenant = await eligibleTenant(this.db, auth, slug);
    if (!tenant) return { ask: false as const, reason: 'role' as Skip };
    return this.db.run(auth, tenant, async (tx) => {
      const s = await this.settings(tx);
      const reason = await this.skip(tx, auth, tenant, s, now, device);
      if (reason) return { ask: false as const, reason };
      await tx
        .insert(ui)
        .values({ userId: auth.userId, npsPromptedAt: now })
        .onConflictDoUpdate({ target: ui.userId, set: { npsPromptedAt: now, updatedAt: sql`now()` } });
      return {
        ask: true as const,
        question: s.question,
        questionEn: s.questionEn,
        followUps: s.followUps as Record<string, string>,
        followUpsEn: (s.followUpsEn as Record<string, string> | null) ?? null,
        topics: s.topics,
        excludeShortMobile: s.excludeShortMobile,
      };
    });
  }

  /** ตอบ / ปิดได้เฉพาะเมื่อมีแบบสำรวจที่แสดงแล้วและยังไม่ได้ตอบ (กันส่งซ้ำหรือยิงตรงโดยไม่ถูกถาม) */
  private async pending(tx: Tx, auth: AuthInfo, tenant: TenantInfo, s: NpsSettings) {
    if (!this.allowedRole(s, tenant)) throw new AppError(403, 'nps_not_allowed', 'บทบาทนี้ไม่ได้อยู่ในกลุ่มที่ตอบแบบสำรวจ');
    const st = await this.state(tx, auth.userId);
    const open = !!st?.npsPromptedAt && (!st.npsRespondedAt || st.npsRespondedAt < st.npsPromptedAt);
    if (!open) throw new AppError(409, 'nps_not_prompted', 'ไม่มีแบบสำรวจที่รอคำตอบ (อาจตอบหรือปิดไปแล้ว)');
  }

  private async record(auth: AuthInfo, slug: string, answer: { score: number; comment: string | null; topics: string[] } | null) {
    const tenant = await eligibleTenant(this.db, auth, slug);
    if (!tenant) throw new AppError(403, 'nps_not_allowed', 'บทบาทนี้ไม่ได้อยู่ในกลุ่มที่ตอบแบบสำรวจ');
    const plan = await this.audience.planOf(tenant.workspaceId);
    return this.db.run(auth, tenant, async (tx) => {
      const s = await this.settings(tx);
      await this.pending(tx, auth, tenant, s);
      let topics: string[] = [];
      if (answer) {
        topics = [...new Set(answer.topics)];
        const unknown = topics.filter((x) => !s.topics.includes(x));
        if (unknown.length) throw new AppError(400, 'invalid_input', 'หัวข้อไม่อยู่ในรายการที่ให้เลือก', { fields: [{ path: 'topics', message: `ไม่รู้จัก: ${unknown.join(', ')}` }] });
      }
      // SQL ตรง: grant ของ friday_app เป็นรายคอลัมน์ (tags / note / การติดตามเป็นของทีม Friday) จึงระบุเฉพาะคอลัมน์ที่เพิ่มได้
      const res = await tx.execute(sql`
        insert into nps_responses (workspace_id, user_id, role, plan, score, comment, topics)
        values (${tenant.workspaceId}, ${auth.userId}, ${tenant.role}, ${plan}, ${answer?.score ?? null}, ${answer?.comment || null}, ${sql.param(topics)}::text[])
        returning id`);
      await tx
        .insert(ui)
        .values({ userId: auth.userId, npsRespondedAt: sql`now()` })
        .onConflictDoUpdate({ target: ui.userId, set: { npsRespondedAt: sql`now()`, updatedAt: sql`now()` } });
      return (res.rows[0] as { id: string }).id;
    });
  }

  /** POST me/nps · คะแนน (บังคับ) + ความเห็น / หัวข้อ (ไม่บังคับ · ข้ามได้ทุกขั้น) */
  async answer(auth: AuthInfo, input: z.infer<typeof AnswerBody>) {
    const id = await this.record(auth, input.workspace, { score: input.score, comment: input.comment ?? null, topics: input.topics ?? [] });
    return { id, score: input.score, group: groupOf(input.score) };
  }

  /** POST me/nps/dismiss · ปิดโดยไม่ตอบ = บันทึกแถว score ว่าง (นับใน "ปิดโดยไม่ตอบ" ของ Ops) และไม่ถามจนถึงรอบถัดไป */
  async dismiss(auth: AuthInfo, input: z.infer<typeof DismissBody>) {
    await this.record(auth, input.workspace, null);
    return { dismissed: true };
  }
}
