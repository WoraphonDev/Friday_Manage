import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ANNOUNCEMENT_EVENT } from '../announcements/announcements.service.js';
import { audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { seesEmail } from '../workspaces/customers.service.js';

const s = schema;
const DAY = 86_400_000;

/**
 * รหัสขั้นของ Workspace ตามลำดับ · ต้องตรงกับ WORKSPACE_STEPS ใน apps/api/src/onboarding/steps.ts (A43 ตัดสินขั้นและบันทึก onboarding_progress)
 * ชื่อขั้นที่แสดงอยู่ในข้อความของ ops-web
 */
export const STEPS = ['first_project', 'issues', 'team', 'assign_due', 'status_update', 'notifications'] as const;
export type StepKey = (typeof STEPS)[number];
/** เวอร์ชันของชุดขั้น (onboarding_progress.version) · ตัวเลขในหน้านี้แยกตามเวอร์ชัน */
export const VERSION = 1;
/** ติดขั้นเดิมนานกว่านี้ = "ติดเกิน 3 วัน" */
export const STUCK_DAYS = 3;
/** ไม่มีใครเข้าใช้นานกว่านี้ = "หยุดใช้" (ไม่แสดงในตารางลูกค้าที่ติด) */
export const INACTIVE_DAYS = 14;
/** ส่งอีเมลช่วยเหลือถึง Workspace เดียวกันได้ 1 ครั้งต่อ 7 วัน */
export const EMAIL_EVERY_DAYS = 7;

export const OverviewQuery = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30) });
export const FollowupBody = z
  .object({
    assigneeId: z.uuid().nullable().optional(),
    status: z.enum(s.ONBOARDING_FOLLOWUP_STATUSES).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export const EmailBody = z
  .object({
    subject: z.string().trim().min(1, 'กรอกหัวข้ออีเมล').max(150),
    body: z.string().trim().min(1, 'กรอกข้อความ').max(4000),
    /** ข้อความสำเร็จรูปที่ใช้ (O22) · นับยอดใช้ */
    cannedId: z.uuid().optional(),
    assigneeId: z.uuid().nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/** ตัวแปรในข้อความสำเร็จรูป (O22) ที่ใช้ได้กับอีเมลช่วยเหลือ */
export const fillVars = (text: string, v: { workspace: string; customer: string }) => text.replaceAll('{ชื่อ Workspace}', v.workspace).replaceAll('{ชื่อผู้แจ้ง}', v.customer);

type Row = Record<string, unknown>;
interface WsRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  members: number;
  lastActiveAt: Date | null;
  plan: string | null;
  subStatus: string | null;
  trialEndsAt: Date | null;
  steps: Partial<Record<StepKey, Date>>;
  assigneeId: string | null;
  assigneeName: string | null;
  followupStatus: string | null;
  lastEmailedAt: Date | null;
  activated: boolean;
  paid: boolean;
}

const asDate = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
const pct = (n: number, d: number) => (d ? Math.round((n * 100) / d) : 0);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const daysBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / DAY);

/** สถานะ Onboarding ของ Workspace หนึ่ง: ขั้นที่ติด ติดมากี่วัน หยุดใช้หรือยัง */
export function progressOf(w: Pick<WsRow, 'createdAt' | 'steps' | 'lastActiveAt'>, now = new Date()) {
  const idx = STEPS.findIndex((k) => !w.steps[k]);
  const done = STEPS.filter((k) => w.steps[k]).length;
  // ติดมา = วันตั้งแต่ทำขั้นก่อนหน้าเสร็จ (ขั้นแรก = ตั้งแต่สร้าง Workspace)
  const before = idx < 0 ? [] : STEPS.slice(0, idx).map((k) => w.steps[k]!.getTime());
  const since = new Date(Math.max(w.createdAt.getTime(), ...before));
  const lastSeen = w.lastActiveAt ?? w.createdAt;
  return {
    done,
    complete: idx < 0,
    stuckStep: idx < 0 ? null : STEPS[idx],
    stuckIndex: idx,
    stuckDays: idx < 0 ? 0 : Math.floor(daysBetween(since, now)),
    inactive: now.getTime() - lastSeen.getTime() > INACTIVE_DAYS * DAY,
  };
}

/**
 * Onboarding checklist ใน Friday Ops (O34 · บอร์ด 18 · V5 · V7)
 * - ขั้นที่เสร็จอ่านจาก onboarding_progress (A43 บันทึกตอนเกิดจริง + ตรวจทุกคืน) · ตัวเลขประกอบจากตารางเดิม
 * - ใช้ OPS_DB (friday_worker) เพราะเป็นหลังบ้านที่ดูข้ามทุก Workspace · ส่งเฉพาะตัวเลขและชื่อ Workspace ไม่ส่งเนื้อหางาน
 * - อีเมลช่วยเหลือส่งผ่านท่อเดียวกับประกาศ (O24) จึงอยู่ในประวัติการส่ง (O23) และไม่ส่งถึงรายชื่อไม่ส่งอีเมล
 */
@Injectable()
export class OnboardingService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  private async rows<T = Row>(db: Db | Tx, q: SQL) {
    const r = await db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** Workspace (ไม่ถูกลบ) พร้อมขั้นที่เสร็จ แพ็กเกจ และผู้ติดตาม · `where` จำกัดชุด */
  private async workspaces(where: SQL): Promise<WsRow[]> {
    const rows = await this.rows<Row>(this.db, sql`
      select w.id, w.name, w.slug, w.created_at as "createdAt",
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as members,
        (select max(m.last_active_at) from workspace_members m where m.workspace_id = w.id) as "lastActiveAt",
        p.code as plan, sub.status as "subStatus", sub.trial_ends_at as "trialEndsAt",
        coalesce((select jsonb_object_agg(op.step, op.done_at) from onboarding_progress op
          where op.workspace_id = w.id and op.user_id is null and op.version = ${VERSION}), '{}'::jsonb) as steps,
        f.assignee_id as "assigneeId", st.name as "assigneeName", f.status as "followupStatus", f.last_emailed_at as "lastEmailedAt",
        -- เริ่มใช้จริงตามนิยามเดียวกับหน้าธุรกิจและกำไร (05 › 2): สมาชิก ≥ 3 และงาน ≥ 10 ภายใน 7 วัน
        ((select count(*) from workspace_members m where m.workspace_id = w.id and m.joined_at <= w.created_at + interval '7 days') >= 3
          and (select count(*) from issues i where i.workspace_id = w.id and i.created_at <= w.created_at + interval '7 days') >= 10) as activated,
        exists (select 1 from subscription_changes c where c.workspace_id = w.id and c.kind = 'new') as paid
      from workspaces w
      left join subscriptions sub on sub.workspace_id = w.id
      left join plans p on p.id = sub.plan_id
      left join onboarding_followups f on f.workspace_id = w.id
      left join staff_users st on st.id = f.assignee_id
      where w.deleted_at is null and ${where}
      order by w.created_at desc`);
    return rows.map((r) => {
      const raw = (r.steps ?? {}) as Record<string, string>;
      const steps: Partial<Record<StepKey, Date>> = {};
      for (const k of STEPS) if (raw[k]) steps[k] = new Date(raw[k]);
      return {
        id: r.id as string,
        name: r.name as string,
        slug: r.slug as string,
        createdAt: asDate(r.createdAt)!,
        members: Number(r.members),
        lastActiveAt: asDate(r.lastActiveAt),
        plan: (r.plan as string | null) ?? null,
        subStatus: (r.subStatus as string | null) ?? null,
        trialEndsAt: asDate(r.trialEndsAt),
        steps,
        assigneeId: (r.assigneeId as string | null) ?? null,
        assigneeName: (r.assigneeName as string | null) ?? null,
        followupStatus: (r.followupStatus as string | null) ?? null,
        lastEmailedAt: asDate(r.lastEmailedAt),
        activated: !!r.activated,
        paid: !!r.paid,
      };
    });
  }

  /** `GET ops/onboarding?days` · KPI · แถบผ่านแต่ละขั้น · ข้อสังเกต · ลูกค้าที่ติด / หยุดใช้ */
  async overview(q: z.infer<typeof OverviewQuery>, now = new Date()) {
    const since = new Date(now.getTime() - q.days * DAY);
    const all = await this.workspaces(sql`w.created_at > ${since}`);
    const prog = new Map(all.map((w) => [w.id, progressOf(w, now)]));
    const complete = all.filter((w) => prog.get(w.id)!.complete);
    const open = all.filter((w) => !prog.get(w.id)!.complete);
    const stuckRows = open.filter((w) => !prog.get(w.id)!.inactive);
    const over3 = stuckRows.filter((w) => prog.get(w.id)!.stuckDays > STUCK_DAYS);

    const funnel = STEPS.map((key, i) => {
      const passed = all.filter((w) => w.steps[key]);
      return { key, passed: passed.length, pct: pct(passed.length, all.length), avgDays: avg(passed.map((w) => daysBetween(w.createdAt, w.steps[key]!))) };
    }).map((f, i, arr) => ({ ...f, drop: i === 0 ? null : f.pct - arr[i - 1].pct }));

    // ข้อสังเกต: ขั้นที่หลุดมากที่สุด + อัตราจ่ายเงินของคนที่ผ่าน / ไม่ผ่านขั้นนั้น
    const worst = funnel.slice(1).reduce<(typeof funnel)[number] | null>((m, f) => (f.drop! < 0 && (!m || f.drop! < m.drop!) ? f : m), null);
    const paidPct = (ws: WsRow[]) => pct(ws.filter((w) => w.paid).length, ws.length);
    const insights = {
      biggestDrop: worst
        ? { key: worst.key, drop: worst.drop!, paidPassedPct: paidPct(all.filter((w) => w.steps[worst.key])), paidOtherPct: paidPct(all.filter((w) => !w.steps[worst.key])) }
        : null,
      notificationsPct: funnel[STEPS.indexOf('notifications')].pct,
    };

    const shape = (w: WsRow) => {
      const p = prog.get(w.id)!;
      return {
        id: w.id,
        name: w.name,
        slug: w.slug,
        members: w.members,
        createdAt: w.createdAt,
        plan: w.plan,
        subStatus: w.subStatus,
        trialDaysLeft: w.subStatus === 'trialing' && w.trialEndsAt ? Math.max(0, Math.ceil((w.trialEndsAt.getTime() - now.getTime()) / DAY)) : null,
        done: p.done,
        stuckStep: p.stuckStep,
        stuckDays: p.stuckDays,
        lastActiveAt: w.lastActiveAt,
        followup: w.followupStatus ? { assigneeId: w.assigneeId, assigneeName: w.assigneeName, status: w.followupStatus, lastEmailedAt: w.lastEmailedAt } : null,
      };
    };
    const bySeverity = (a: WsRow, b: WsRow) => prog.get(b.id)!.stuckDays - prog.get(a.id)!.stuckDays;
    return {
      days: q.days,
      version: VERSION,
      kpis: {
        newWorkspaces: all.length,
        trial: all.filter((w) => w.subStatus === 'trialing').length,
        free: all.filter((w) => w.subStatus !== 'trialing' && w.plan === 'free').length,
        completedPct: pct(complete.length, all.length),
        avgDaysToComplete: avg(complete.map((w) => daysBetween(w.createdAt, new Date(Math.max(...STEPS.map((k) => w.steps[k]!.getTime())))))),
        activatedPct: pct(all.filter((w) => w.activated).length, all.length),
        stuckOver3: over3.length,
        stuckUnassigned: over3.filter((w) => !w.assigneeId).length,
      },
      funnel,
      insights,
      stuck: stuckRows.sort(bySeverity).slice(0, 500).map(shape),
      inactive: open.filter((w) => prog.get(w.id)!.inactive).sort(bySeverity).slice(0, 500).map(shape),
    };
  }

  /** `GET ops/onboarding/workspaces/{id}` · ติดตาม (V5) และการ์ดในรายละเอียดลูกค้า (V7) */
  async detail(staff: Staff, id: string, now = new Date()) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [w] = await this.workspaces(sql`w.id = ${id}`);
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const p = progressOf(w, now);
    const progress = await this.rows<{ step: string; doneAt: string; meta: Record<string, number> }>(this.db, sql`
      select step, done_at as "doneAt", meta from onboarding_progress where workspace_id = ${id} and user_id is null and version = ${VERSION}`);
    const owner = await this.owner(this.db, id);
    const [sig] = await this.rows<Row>(this.db, sql`
      select
        (select count(*)::int from invitations i where i.workspace_id = ${id} and i.status = 'pending' and i.expires_at > now()) as "pendingInvites",
        (select min(i.created_at) from invitations i where i.workspace_id = ${id} and i.status = 'pending' and i.expires_at > now()) as "oldestInviteAt",
        (select count(*)::int from invitations i where i.workspace_id = ${id} and i.status = 'accepted') as "acceptedInvites",
        (select count(*)::int from workspace_members m where m.workspace_id = ${id} and m.status = 'active' and m.last_active_at > now() - interval '7 days') as "active7d",
        (select count(*)::int from daily_usages d where d.workspace_id = ${id} and d.date > current_date - 7 and d.active_users > 0) as "activeDays7d",
        (select count(*)::int from support_tickets t where t.workspace_id = ${id} and t.status not in ('solved', 'closed')) as "openTickets",
        (select row_to_json(a) from (select source, medium, via from workspace_acquisitions where workspace_id = ${id}) a) as acquisition`);
    const [f] = await this.db.select().from(s.onboardingFollowups).where(eq(s.onboardingFollowups.workspaceId, id));
    const [suppressed] = owner
      ? await this.rows<{ reason: string }>(this.db, sql`select reason from email_suppressions where lower(email) = lower(${owner.email}) and removed_at is null limit 1`)
      : [];
    const assignees = await this.rows<{ id: string; name: string }>(this.db, sql`
      select id, name from staff_users where status = 'active' and roles && array['owner', 'support']::text[] order by name`);
    const emailOk = seesEmail(staff);
    return {
      workspace: {
        id: w.id,
        name: w.name,
        slug: w.slug,
        createdAt: w.createdAt,
        members: w.members,
        plan: w.plan,
        subStatus: w.subStatus,
        trialDaysLeft: w.subStatus === 'trialing' && w.trialEndsAt ? Math.max(0, Math.ceil((w.trialEndsAt.getTime() - now.getTime()) / DAY)) : null,
        lastActiveAt: w.lastActiveAt,
      },
      owner: owner ? { name: owner.name, email: emailOk ? owner.email : null, suppressed: !!suppressed } : null,
      version: VERSION,
      done: p.done,
      total: STEPS.length,
      complete: p.complete,
      stuckStep: p.stuckStep,
      stuckDays: p.stuckDays,
      inactive: p.inactive,
      steps: STEPS.map((key) => {
        const r = progress.find((x) => x.step === key);
        return { key, doneAt: r ? asDate(r.doneAt) : null, meta: r?.meta ?? {} };
      }),
      signals: {
        pendingInvites: Number(sig.pendingInvites),
        oldestInviteAt: asDate(sig.oldestInviteAt),
        acceptedInvites: Number(sig.acceptedInvites),
        active7d: Number(sig.active7d),
        activeDays7d: Number(sig.activeDays7d),
        openTickets: Number(sig.openTickets),
        acquisition: (sig.acquisition as { source: string | null; medium: string | null; via: string } | null) ?? null,
      },
      followup: f
        ? {
            assigneeId: f.assigneeId,
            assigneeName: assignees.find((a) => a.id === f.assigneeId)?.name ?? null,
            status: f.status,
            note: f.note,
            lastEmailedAt: f.lastEmailedAt,
            emailsSent: f.emailsSent,
            nextEmailAt: f.lastEmailedAt ? new Date(f.lastEmailedAt.getTime() + EMAIL_EVERY_DAYS * DAY) : null,
          }
        : null,
      assignees,
    };
  }

  /** Owner ของ Workspace (ผู้รับอีเมลช่วยเหลือ) */
  private async owner(db: Db | Tx, workspaceId: string) {
    const [o] = await db
      .select({ id: s.users.id, name: s.users.displayName, email: s.users.email })
      .from(s.workspaceMembers)
      .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.role, 'owner'), eq(s.workspaceMembers.status, 'active'), sql`${s.users.disabledAt} is null`))
      .limit(1);
    return o ?? null;
  }

  private async exists(db: Db | Tx, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [w] = await db.select({ id: s.workspaces.id, name: s.workspaces.name }).from(s.workspaces).where(and(eq(s.workspaces.id, id), sql`${s.workspaces.deletedAt} is null`));
    if (!w) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    return w;
  }

  private async checkAssignee(db: Db | Tx, assigneeId: string | null | undefined) {
    if (!assigneeId) return;
    const [ok] = await this.rows(db, sql`select 1 from staff_users where id = ${assigneeId} and status = 'active' and roles && array['owner', 'support']::text[]`);
    if (!ok) throw new AppError(422, 'invalid_assignee', 'ผู้ติดตามต้องเป็นพนักงาน Owner หรือ Support ที่ใช้งานอยู่');
  }

  /**
   * `PUT ops/onboarding/workspaces/{id}/followup` · ผู้ติดตาม สถานะ บันทึกภายใน ("บันทึกอย่างเดียว")
   * บันทึกภายในไม่ลง Audit ของลูกค้า (ลูกค้าเห็นได้) จึงลงเฉพาะ Audit ของทีม Friday
   */
  async saveFollowup(staff: Staff, id: string, input: z.infer<typeof FollowupBody>) {
    return this.db.transaction(async (tx) => {
      const w = await this.exists(tx, id);
      await this.checkAssignee(tx, input.assigneeId);
      const set = {
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        updatedBy: staff.id,
      };
      const [row] = await tx
        .insert(s.onboardingFollowups)
        .values({ workspaceId: id, ...set })
        .onConflictDoUpdate({ target: s.onboardingFollowups.workspaceId, set })
        .returning();
      const parts = [input.assigneeId !== undefined && 'ผู้ติดตาม', input.status && `สถานะ ${input.status}`, input.note !== undefined && 'บันทึกภายใน'].filter(Boolean).join(' · ');
      await staffAudit(tx, staff, 'ops.onboarding_followup', `ติดตาม Onboarding ของ ${w.name}: ${parts || 'บันทึก'}`, { type: 'workspace', id }, id);
      return { followup: row };
    });
  }

  /**
   * `POST ops/onboarding/workspaces/{id}/email` · อีเมลช่วยเหลือถึง Owner (V5) · ส่งด้วยมือเท่านั้น (คำตัดสิน 12 พ.ย. 2569)
   * - 1 ครั้งต่อ 7 วันต่อ Workspace · ล็อกแถวติดตามในธุรกรรมกันกดส่งพร้อมกัน
   * - Owner อยู่ในรายชื่อไม่ส่ง (O23) = ไม่ส่ง (422)
   * - ส่งผ่านแจ้งเตือน + รายการส่ง (ท่อเดียวกับประกาศ O24) ให้ API ลูกค้าส่งและอยู่ในประวัติการส่ง · Audit ทั้งของลูกค้าและทีม
   */
  async sendEmail(staff: Staff, id: string, input: z.infer<typeof EmailBody>, now = new Date()) {
    return this.db.transaction(async (tx) => {
      const w = await this.exists(tx, id);
      await this.checkAssignee(tx, input.assigneeId);
      await tx.insert(s.onboardingFollowups).values({ workspaceId: id, updatedBy: staff.id }).onConflictDoNothing();
      const [f] = await tx.select().from(s.onboardingFollowups).where(eq(s.onboardingFollowups.workspaceId, id)).for('update');
      if (f.lastEmailedAt && now.getTime() - f.lastEmailedAt.getTime() < EMAIL_EVERY_DAYS * DAY) {
        throw new AppError(409, 'email_too_soon', `ส่งอีเมลถึง Workspace นี้ได้ 1 ครั้งต่อ ${EMAIL_EVERY_DAYS} วัน`, { nextEmailAt: new Date(f.lastEmailedAt.getTime() + EMAIL_EVERY_DAYS * DAY) });
      }
      const owner = await this.owner(tx, id);
      if (!owner) throw new AppError(422, 'no_recipient', 'Workspace นี้ไม่มี Owner ที่ใช้งานอยู่');
      const [sup] = await this.rows<{ reason: string }>(tx, sql`select reason from email_suppressions where lower(email) = lower(${owner.email}) and removed_at is null limit 1`);
      if (sup) throw new AppError(422, 'email_suppressed', `อีเมลของ Owner อยู่ในรายชื่อไม่ส่ง (${sup.reason}) · ติดต่อทางอื่นแทน`);

      const vars = { workspace: w.name, customer: owner.name };
      const title = fillVars(input.subject, vars);
      const text = fillVars(input.body, vars);
      const [note] = await tx
        .insert(s.notifications)
        .values({ workspaceId: id, recipientId: owner.id, eventType: ANNOUNCEMENT_EVENT, payload: { title, text, kind: 'onboarding_followup' }, reason: `คุณเป็น Owner ของ Workspace ${w.name}`, inApp: false })
        .returning({ id: s.notifications.id });
      // resend_requested_at: งาน scan ของ API ลูกค้าหยิบไปส่งภายใน 1 นาที (เหมือนประกาศ O24)
      await tx.insert(s.notificationDeliveries).values({ workspaceId: id, notificationId: note.id, channel: 'email', targetRef: owner.email, targetLabel: owner.email, status: 'queued', resendRequestedAt: now });
      const [row] = await tx
        .update(s.onboardingFollowups)
        .set({
          status: 'emailed',
          lastEmailedAt: now,
          emailsSent: sql`${s.onboardingFollowups.emailsSent} + 1`,
          // ยังไม่มีผู้ติดตาม = คนที่ส่งเป็นผู้ติดตาม
          assigneeId: input.assigneeId !== undefined ? input.assigneeId : (f.assigneeId ?? staff.id),
          ...(input.note !== undefined ? { note: input.note || null } : {}),
          updatedBy: staff.id,
        })
        .where(eq(s.onboardingFollowups.workspaceId, id))
        .returning();
      if (input.cannedId) await tx.update(s.supportCannedReplies).set({ uses: sql`${s.supportCannedReplies.uses} + 1` }).where(eq(s.supportCannedReplies.id, input.cannedId));
      await audit(tx, staff, id, 'notify', 'ops.onboarding_email', `ส่งอีเมลช่วยเหลือการเริ่มใช้งาน "${title}" ถึง Owner`, { type: 'notification', id: note.id });
      return { followup: row, notificationId: note.id, to: seesEmail(staff) ? owner.email : null };
    });
  }
}
