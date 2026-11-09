import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { today } from '../common/dates.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Jobs } from '../queue/jobs.js';

const s = schema;

/** ฟีเจอร์ที่นับการใช้ (05-business-metrics › 1.2) */
export const FEATURES = ['table', 'kanban', 'gantt', 'timeline', 'calendar', 'workload', 'due_request', 'import', 'automation', 'saved_view', 'git', 'api', 'line', 'report'] as const;
const LIMITS = ['seats', 'storage', 'automation', 'projects', 'guests', 'feature'] as const;
const short = z.string().trim().max(40);

/** props ของแต่ละเหตุการณ์ · strict ทั้งหมดเพื่อไม่ให้มีเนื้อหาของลูกค้าหลุดเข้ามา */
const EventItem = z.discriminatedUnion('name', [
  z.object({ name: z.literal('feature.used'), props: z.object({ feature: z.enum(FEATURES) }).strict() }).strict(),
  z.object({ name: z.literal('limit.hit'), props: z.object({ limit: z.enum(LIMITS), current: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }).strict() }).strict(),
  z.object({ name: z.enum(['upgrade.prompt_shown', 'upgrade.prompt_clicked']), props: z.object({ placement: short, planFrom: short.optional(), planTo: short.optional() }).strict() }).strict(),
  z.object({ name: z.literal('onboarding.step_done'), props: z.object({ step: short }).strict() }).strict(),
  z.object({ name: z.enum(['checkout.started', 'checkout.method_selected']), props: z.object({ plan: short.optional(), cycle: z.enum(['monthly', 'yearly']).optional(), method: z.enum(['card', 'promptpay', 'transfer', 'bill_payment']).optional() }).strict() }).strict(),
]);
export const EventsBody = z.object({ events: z.array(EventItem).min(1).max(50) }).strict();

/** ส่งมากับ `POST auth/signup` · เว็บเก็บจาก cookie ของการเข้าครั้งแรก */
export const AttributionBody = z
  .object({
    utmSource: z.string().trim().max(100).optional(),
    utmMedium: z.string().trim().max(100).optional(),
    utmCampaign: z.string().trim().max(100).optional(),
    utmTerm: z.string().trim().max(100).optional(),
    referrer: z.string().trim().max(500).optional(),
    landingPath: z.string().trim().max(300).optional(),
    firstSeenAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const CancellationBody = z
  .object({
    reason: z.enum(['too_expensive', 'missing_feature', 'switched_tool', 'project_ended', 'hard_to_use', 'company_closed', 'other']),
    missingFeature: z.string().trim().max(200).optional(),
    switchedTo: z.string().trim().max(100).optional(),
    detail: z.string().trim().max(1000).optional(),
    offerShown: z.enum(['none', 'discount', 'pause']).default('none'),
    outcome: z.enum(['canceled', 'kept']),
  })
  .strict();

type ChangeKind = (typeof s.subscriptionChanges.$inferInsert)['kind'];
const PLAN_RANK: Record<string, number> = { free: 0, team_s: 1, team_m: 2, team_l: 3, enterprise: 4 };

/** เก็บ host ของ referrer เท่านั้น (URL เต็มอาจมีข้อมูลส่วนบุคคล) */
export function referrerHost(raw?: string) {
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase().slice(0, 255) || null;
  } catch {
    return null;
  }
}

/** เปลี่ยนแพ็กเกจแบบไหน (ใช้ทำ MRR movement) · null = ต่ออายุเหมือนเดิม ไม่ต้องบันทึก */
export function classifyChange(prev: { plan: string | null; status: string | null; cycle: string | null }, next: { plan: string; cycle: string }): ChangeKind | null {
  if (!prev.plan || prev.status === 'trialing' || prev.status === 'canceled' || prev.plan === 'free') return prev.status === 'canceled' ? 'reactivate' : 'new';
  const diff = (PLAN_RANK[next.plan] ?? 0) - (PLAN_RANK[prev.plan] ?? 0);
  if (diff > 0) return 'upgrade';
  if (diff < 0) return 'downgrade';
  if (prev.cycle !== next.cycle) return 'cycle_change';
  return null;
}

/**
 * เก็บข้อมูลธุรกิจตั้งแต่วันแรก (A34 · 05-business-metrics › 1)
 * ข้อมูลระดับระบบ (ที่มาของผู้ใช้ / Workspace, ยอดใช้รายวัน) เขียนผ่าน SYSTEM_DB เพราะแอปไม่มีสิทธิ์ในตารางเหล่านั้น
 * เหตุการณ์ในแอปเขียนผ่าน TenantDb (RLS) · ล้มแล้วทิ้ง ไม่ทำให้คำขอของลูกค้าช้าหรือล้ม
 */
@Injectable()
export class AnalyticsService implements OnModuleInit {
  private readonly log = new Logger('Analytics');

  constructor(
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly db: TenantDb,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    this.jobs.define('analytics.daily_usage', async (data: { date?: string }) => {
      await this.rollupDailyUsage(data.date ?? previousDay(today()));
    });
    // 01:00 เวลาไทย สรุปของเมื่อวาน
    await this.jobs.every('analytics.daily_usage', '0 1 * * *');
  }

  /** ช่องทางที่ผู้ใช้มาครั้งแรก · เรียกใน transaction ของการสมัคร (SYSTEM_DB) */
  async recordSignup(tx: Tx | Db, userId: string, a?: z.infer<typeof AttributionBody>) {
    await tx
      .insert(s.signupAttributions)
      .values({
        userId,
        utmSource: a?.utmSource ?? null,
        utmMedium: a?.utmMedium ?? null,
        utmCampaign: a?.utmCampaign ?? null,
        utmTerm: a?.utmTerm ?? null,
        referrerHost: referrerHost(a?.referrer),
        landingPath: a?.landingPath?.split('?')[0] ?? null,
        firstSeenAt: a?.firstSeenAt ? new Date(a.firstSeenAt) : null,
      })
      .onConflictDoNothing();
  }

  /**
   * ที่มาของ Workspace: คัดลอกจากผู้สร้าง · ถ้าผู้สร้างเคยเป็นสมาชิก Workspace อื่นมาก่อน = มาจากการถูกชวน (โตแบบไม่ต้องจ่ายค่าโฆษณา)
   * เรียกใน transaction ของการสร้าง Workspace (SYSTEM_DB)
   */
  async copyAcquisition(tx: Tx | Db, workspaceId: string, creatorId: string) {
    const [a] = await tx.select().from(s.signupAttributions).where(eq(s.signupAttributions.userId, creatorId));
    const [joined] = await tx
      .select({ workspaceId: s.workspaceMembers.workspaceId })
      .from(s.workspaceMembers)
      .where(and(eq(s.workspaceMembers.userId, creatorId), ne(s.workspaceMembers.workspaceId, workspaceId), ne(s.workspaceMembers.role, 'owner')))
      .orderBy(asc(s.workspaceMembers.joinedAt))
      .limit(1);
    await tx
      .insert(s.workspaceAcquisitions)
      .values({ workspaceId, source: a?.utmSource ?? null, medium: a?.utmMedium ?? null, campaign: a?.utmCampaign ?? null, referrerHost: a?.referrerHost ?? null, via: joined ? 'invited_user' : 'signup', referringWorkspaceId: joined?.workspaceId ?? null })
      .onConflictDoNothing();
  }

  /** `POST w/{ws}/events` · feature.used นับครั้งแรกของวันต่อคนต่อฟีเจอร์ */
  async track(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof EventsBody>) {
    try {
      return await this.db.run(auth, tenant, async (tx) => {
        const since = new Date(`${today()}T00:00:00+07:00`);
        let accepted = 0;
        for (const e of body.events) {
          if (e.name === 'feature.used') {
            const [seen] = await tx
              .select({ id: s.productEvents.id })
              .from(s.productEvents)
              .where(and(eq(s.productEvents.userId, auth.userId), eq(s.productEvents.name, e.name), sql`${s.productEvents.props}->>'feature' = ${e.props.feature}`, gte(s.productEvents.occurredAt, since)))
              .limit(1);
            if (seen) continue;
          }
          await tx.insert(s.productEvents).values({ workspaceId: tenant.workspaceId, userId: auth.userId, name: e.name, props: e.props });
          accepted++;
        }
        return { accepted };
      });
    } catch (err) {
      this.log.warn(`ทิ้งเหตุการณ์ ${body.events.length} รายการ: ${(err as Error).message}`);
      return { accepted: 0 };
    }
  }

  /** แบบสอบถามตอนกดยกเลิก (ต้องตอบก่อนยืนยันยกเลิก) */
  async cancellation(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof CancellationBody>) {
    if (tenant.role !== 'owner') throw new AppError(403, 'forbidden', 'เฉพาะ Owner ของ Workspace');
    return this.db.run(auth, tenant, async (tx) => {
      const [r] = await tx
        .insert(s.cancellationResponses)
        .values({ workspaceId: tenant.workspaceId, userId: auth.userId, reason: body.reason, missingFeature: body.missingFeature ?? null, switchedTo: body.switchedTo ?? null, detail: body.detail ?? null, offerShown: body.offerShown, outcome: body.outcome })
        .returning({ id: s.cancellationResponses.id, createdAt: s.cancellationResponses.createdAt });
      return r;
    });
  }

  /**
   * บันทึกทุกครั้งที่ MRR ของ Workspace เปลี่ยน · MRR ก่อน VAT หลังส่วนลด รายปีหาร 12
   * เรียกใน transaction เดียวกับที่เปลี่ยน `subscriptions` (SYSTEM_DB)
   */
  async subscriptionChanged(
    tx: Tx | Db,
    input: { workspaceId: string; kind: ChangeKind; planFrom: string | null; planTo: string | null; mrrAfterSatang: number; actorKind: 'user' | 'system' | 'staff'; actorId: string | null; effectiveAt?: Date },
  ) {
    const [last] = await tx.select({ mrr: s.subscriptionChanges.mrrAfterSatang }).from(s.subscriptionChanges).where(eq(s.subscriptionChanges.workspaceId, input.workspaceId)).orderBy(desc(s.subscriptionChanges.effectiveAt), desc(s.subscriptionChanges.createdAt)).limit(1);
    await tx.insert(s.subscriptionChanges).values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      planFrom: input.planFrom,
      planTo: input.planTo,
      mrrBeforeSatang: last?.mrr ?? 0,
      mrrAfterSatang: Math.max(0, Math.round(input.mrrAfterSatang)),
      actorKind: input.actorKind,
      actorId: input.actorId,
      effectiveAt: input.effectiveAt ?? new Date(),
    });
  }

  /**
   * ยอดใช้ต่อ Workspace ของวันหนึ่ง (เวลาไทย) · ใช้ SYSTEM_DB เพราะรวมทุก Workspace
   * api_calls ยังเป็น 0 จนกว่าจะเก็บ log ของ API token
   */
  async rollupDailyUsage(date: string) {
    const from = new Date(`${date}T00:00:00+07:00`);
    const to = new Date(from.getTime() + 86_400_000);
    await this.sys.execute(sql`
      insert into daily_usages (workspace_id, date, line_messages, emails, webhook_calls, storage_bytes, automation_runs, active_users)
      select w.id, ${date}::date,
        (select count(*)::int from notification_deliveries d where d.workspace_id = w.id and d.status = 'sent' and d.channel in ('line', 'line_group') and d.created_at >= ${from} and d.created_at < ${to}),
        (select count(*)::int from notification_deliveries d where d.workspace_id = w.id and d.status = 'sent' and d.channel = 'email' and d.created_at >= ${from} and d.created_at < ${to}),
        (select count(*)::int from notification_deliveries d where d.workspace_id = w.id and d.status = 'sent' and d.channel = 'webhook' and d.created_at >= ${from} and d.created_at < ${to}),
        (select coalesce(sum(v.size_bytes), 0)::bigint from file_versions v where v.workspace_id = w.id),
        (select count(*)::int from automation_runs r where r.workspace_id = w.id and r.created_at >= ${from} and r.created_at < ${to}),
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.last_active_at >= ${from} and m.last_active_at < ${to})
      from workspaces w
      where w.deleted_at is null
      on conflict (workspace_id, date) do update set
        line_messages = excluded.line_messages, emails = excluded.emails, webhook_calls = excluded.webhook_calls,
        storage_bytes = excluded.storage_bytes, automation_runs = excluded.automation_runs, active_users = excluded.active_users`);
    return { date };
  }

  /** PDPA (05 › 3): ลบบัญชีแล้วทำให้ข้อมูลธุรกิจระบุตัวไม่ได้ · ตัวเลขรวมยังอยู่ */
  async forgetUser(userId: string) {
    await this.sys.delete(s.signupAttributions).where(eq(s.signupAttributions.userId, userId));
    await this.sys.update(s.productEvents).set({ userId: null }).where(eq(s.productEvents.userId, userId));
    await this.sys.update(s.cancellationResponses).set({ userId: null }).where(eq(s.cancellationResponses.userId, userId));
  }

  /** ใช้ใน test: เหตุการณ์ของ Workspace ช่วงหนึ่ง */
  async eventsOf(workspaceId: string, sinceMs: number) {
    return this.sys.select().from(s.productEvents).where(and(eq(s.productEvents.workspaceId, workspaceId), gte(s.productEvents.occurredAt, new Date(sinceMs)), lt(s.productEvents.occurredAt, new Date(Date.now() + 60_000))));
  }
}

function previousDay(d: string) {
  return new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
