import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus, type EventType } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { SAMPLE_PROJECT_NAME } from '../projects/sample-project.service.js';
import { Jobs } from '../queue/jobs.js';
import {
  currentOf,
  isLegacy,
  MEMBER_STEPS,
  type MemberStepKey,
  metWorkspaceSteps,
  ONBOARDING_LAUNCHED_AT,
  ONBOARDING_VERSION,
  type StepAction,
  WORKSPACE_STEPS,
  type WorkspaceCounts,
  type WorkspaceStepKey,
} from './steps.js';

const s = schema;

export const TaskOpenedBody = z.object({ issueKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/) }).strict();

/**
 * เหตุการณ์ → ขั้นของ Workspace ที่อาจเสร็จจากเหตุการณ์นั้น (ตรวจเฉพาะขั้นที่เกี่ยวข้อง ให้เหตุการณ์ที่ส่งต่อสอดคล้องกับการกระทำ)
 * ขั้นที่ไม่มีเหตุการณ์ (โปรเจกต์แรก, แจ้งเตือน) ตรวจตอนเปิด Home และงานทุกคืน
 */
const TRIGGERS: Partial<Record<EventType, WorkspaceStepKey[]>> = {
  'issue.created': ['issues', 'assign_due'],
  'import.completed': ['issues', 'assign_due'],
  'issue.assigned': ['assign_due'],
  'issue.updated': ['assign_due'],
  'issue.status_changed': ['status_update'],
  'member.joined': ['team'],
};
const RECONCILE_JOB = 'onboarding.reconcile';
/** ตรวจย้อนหลังทุกคืนเฉพาะ Workspace อายุไม่เกินนี้ (หน้า Ops ดูไม่เกิน 90 วัน) */
const RECONCILE_DAYS = 120;

type Step = { key: string; at: Date | null; meta: Record<string, number> };
interface StepView {
  key: string;
  title: string;
  done: boolean;
  doneAt: string | null;
  current: number;
  target: number;
  action: { kind: StepAction; path: string } | null;
  detail: Record<string, unknown> | null;
}

/** ผู้ทำขั้น (บันทึกในนามคนนี้ผ่าน RLS) · null = งานของระบบ (งานทุกคืน) */
type Actor = { userId: string } | null;

const asDate = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

/**
 * Onboarding checklist ของลูกค้า (A43 · หน้าจอ V1–V4)
 * - ขั้นตรวจจากข้อมูลจริง บันทึกครั้งแรกที่เสร็จใน onboarding_progress แล้วไม่ย้อนกลับ แม้ข้อมูลลดลงภายหลัง
 * - บันทึกในนามผู้ที่ทำขั้นนั้นผ่าน TenantDb (RLS ของ onboarding_progress ให้สมาชิกทุกคนบันทึกขั้นของ Workspace ได้)
 * - ตัวเลขของ Workspace นับผ่าน SYSTEM_DB เฉพาะ Workspace ปัจจุบันและคืนเป็นตัวเลขเท่านั้น
 *   เพราะ RLS ซ่อนงานในโปรเจกต์ private ที่ผู้ดูไม่ได้เป็นสมาชิก และการผูก LINE / ตั้งค่าแจ้งเตือนของคนอื่น (เหมือน mfaStats ของ Admin)
 */
@Injectable()
export class OnboardingService implements OnModuleInit {
  private readonly log = new Logger('Onboarding');

  constructor(
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly db: TenantDb,
    private readonly events: EventBus,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    for (const type of Object.keys(TRIGGERS) as EventType[]) this.events.on(type, (e) => this.onEvent(e));
    this.jobs.define(RECONCILE_JOB, () => this.reconcile());
    // 01:30 เวลาไทย หลังสรุปยอดใช้รายวัน (analytics.daily_usage 01:00)
    await this.jobs.every(RECONCILE_JOB, '30 1 * * *');
  }

  // ---------------------------------------------------------------------------
  // GET w/{ws}/onboarding
  // ---------------------------------------------------------------------------

  async get(auth: AuthInfo, tenant: TenantInfo) {
    assertNotGuest(tenant);
    return tenant.role === 'member' ? this.memberView(auth, tenant) : this.workspaceView(auth, tenant);
  }

  private async workspaceView(auth: AuthInfo, tenant: TenantInfo) {
    const counts = await this.counts(tenant.workspaceId);
    const { createdAt, dismissal, progress } = await this.db.run(auth, tenant, async (tx) => ({
      createdAt: await workspaceCreatedAt(tx, tenant.workspaceId),
      dismissal: await dismissalOf(tx, tenant.workspaceId, auth.userId),
      progress: await progressOf(tx, tenant.workspaceId, null),
    }));
    if (!progress.size && isLegacy(createdAt, counts)) return { scope: 'workspace' as const, version: ONBOARDING_VERSION, eligible: false as const };

    const recorded = await this.record({ userId: auth.userId }, tenant.workspaceId, null, metWorkspaceSteps(counts).filter((x) => !progress.has(x.key)), WORKSPACE_STEPS.length);
    for (const r of recorded) progress.set(r.key, r.doneAt);

    const extra = await this.db.run(auth, tenant, (tx) => this.workspaceDetails(tx, tenant.workspaceId, progress));
    const steps: StepView[] = WORKSPACE_STEPS.map((def) => ({
      key: def.key,
      title: def.title,
      done: progress.has(def.key),
      doneAt: progress.get(def.key)?.toISOString() ?? null,
      current: currentOf(def.key, counts),
      target: def.target,
      action: def.action ? { kind: def.action, path: actionPath(def.action, extra.projectKey) } : null,
      detail: extra.detail[def.key] ?? null,
    }));
    return this.view('workspace', steps, dismissal);
  }

  /** ข้อมูลประกอบของขั้น: ชื่อโปรเจกต์แรก, คำเชิญที่ยังไม่ตอบรับ (Owner / Admin เป็นผู้ส่งเอง) · ผ่าน RLS */
  private async workspaceDetails(tx: Tx, workspaceId: string, progress: Map<string, Date>) {
    const [project] = await tx
      .select({ key: s.projects.key, name: s.projects.name })
      .from(s.projects)
      .where(and(eq(s.projects.workspaceId, workspaceId), isNull(s.projects.deletedAt), sql`${s.projects.name} <> ${SAMPLE_PROJECT_NAME}`))
      .orderBy(asc(s.projects.createdAt))
      .limit(1);
    const detail: Partial<Record<WorkspaceStepKey, Record<string, unknown>>> = {};
    if (project) detail.first_project = { projectKey: project.key, projectName: project.name };
    if (!progress.has('team')) {
      const pending = await tx
        .select({ email: s.invitations.email, createdAt: s.invitations.createdAt })
        .from(s.invitations)
        .where(and(eq(s.invitations.workspaceId, workspaceId), eq(s.invitations.status, 'pending'), gt(s.invitations.expiresAt, new Date())))
        .orderBy(asc(s.invitations.createdAt))
        .limit(20);
      detail.team = { pendingInvites: pending.slice(0, 3).map((p) => p.email), pendingCount: pending.length };
    }
    return { projectKey: project?.key ?? null, detail };
  }

  private async memberView(auth: AuthInfo, tenant: TenantInfo) {
    const data = await this.db.run(auth, tenant, async (tx) => {
      const [me] = await tx
        .select({ joinedAt: s.workspaceMembers.joinedAt, workStart: s.workspaceMembers.workStart, workDays: s.workspaceMembers.workDays, avatarUrl: s.users.avatarUrl })
        .from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
        .where(and(eq(s.workspaceMembers.workspaceId, tenant.workspaceId), eq(s.workspaceMembers.userId, auth.userId)));
      const progress = await progressOf(tx, tenant.workspaceId, auth.userId);
      if (!progress.size && me.joinedAt < ONBOARDING_LAUNCHED_AT) return null;
      return { me, progress, dismissal: await dismissalOf(tx, tenant.workspaceId, auth.userId), ...(await this.memberFacts(tx, tenant.workspaceId, auth.userId)) };
    });
    if (!data) return { scope: 'member' as const, version: ONBOARDING_VERSION, eligible: false as const };
    const { me, progress, dismissal, assigned, opened, notify, invitedBy } = data;

    const met: Step[] = [];
    if (me.avatarUrl && (me.workStart || me.workDays)) met.push({ key: 'profile', at: null, meta: {} });
    if (opened) met.push({ key: 'open_assigned', at: null, meta: {} });
    if (notify) met.push({ key: 'notify_channel', at: null, meta: {} });
    const recorded = await this.record({ userId: auth.userId }, tenant.workspaceId, auth.userId, met.filter((x) => !progress.has(x.key)), MEMBER_STEPS.length);
    for (const r of recorded) progress.set(r.key, r.doneAt);
    // สมาชิกช่วยบันทึกขั้นของ Workspace ด้วย (เช่น ผูก LINE แล้วกลับมาหน้า Home) เพื่อให้ Owner และ Friday Ops เห็นเร็ว
    await this.advanceWorkspace({ userId: auth.userId }, tenant.workspaceId).catch((err: Error) => this.log.warn(`ตรวจขั้นของ Workspace ไม่สำเร็จ: ${err.message}`));

    const detail: Record<MemberStepKey, Record<string, unknown> | null> = {
      profile: { avatar: !!me.avatarUrl, hours: !!(me.workStart || me.workDays) },
      open_assigned: assigned ? { issueKey: assigned.key, title: assigned.title } : null,
      notify_channel: null,
    };
    const steps: StepView[] = MEMBER_STEPS.map((def) => ({
      key: def.key,
      title: def.title,
      done: progress.has(def.key),
      doneAt: progress.get(def.key)?.toISOString() ?? null,
      current: progress.has(def.key) ? 1 : 0,
      target: def.target,
      action: def.key === 'open_assigned' && !assigned ? null : { kind: def.action, path: def.key === 'open_assigned' ? `p/${assigned!.projectKey}?issue=${assigned!.key}` : actionPath(def.action, null) },
      detail: detail[def.key],
    }));
    return { ...this.view('member', steps, dismissal), invitedBy };
  }

  /** ข้อมูลของตัวเอง (RLS ให้เห็นเฉพาะแถวของตัวเองอยู่แล้ว) */
  private async memberFacts(tx: Tx, workspaceId: string, userId: string) {
    const [assigned] = await tx
      .select({ id: s.issues.id, number: s.issues.number, title: s.issues.title, projectKey: s.projects.key })
      .from(s.issueAssignees)
      .innerJoin(s.issues, eq(s.issues.id, s.issueAssignees.issueId))
      .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
      .where(and(eq(s.issueAssignees.userId, userId), isNull(s.issues.deletedAt), isNull(s.projects.deletedAt), isNull(s.issues.completedAt)))
      .orderBy(asc(s.issues.createdAt))
      .limit(1);
    // "เปิดงานแล้ว" จากข้อมูล: เคยแก้ / คอมเมนต์ในงานที่ได้รับมอบหมาย (ปุ่ม "เปิดงาน" บันทึกเองผ่าน :task-opened)
    const touched = await tx.execute<{ ok: boolean }>(sql`
      select exists (
        select 1 from ${s.issueAssignees} a
        where a.user_id = ${userId}
          and (exists (select 1 from ${s.activities} x where x.issue_id = a.issue_id and x.actor_id = ${userId} and x.verb <> 'created')
            or exists (select 1 from ${s.comments} c where c.issue_id = a.issue_id and c.author_id = ${userId}))
      ) as ok`);
    const notify = await tx.execute<{ ok: boolean }>(sql`
      select (exists (select 1 from ${s.lineBindings} b where b.user_id = ${userId} and b.unbound_at is null)
        or exists (select 1 from ${s.userNotificationPrefs} p where p.workspace_id = ${workspaceId} and p.user_id = ${userId})
        or exists (select 1 from ${s.userNotificationSettings} n where n.workspace_id = ${workspaceId} and n.user_id = ${userId})) as ok`);
    const [inviter] = await tx
      .select({ name: s.users.displayName })
      .from(s.invitations)
      .innerJoin(s.users, eq(s.users.id, s.invitations.invitedBy))
      .where(and(eq(s.invitations.workspaceId, workspaceId), eq(s.invitations.acceptedUserId, userId)))
      .limit(1);
    return {
      assigned: assigned ? { key: `${assigned.projectKey}-${assigned.number}`, title: assigned.title, projectKey: assigned.projectKey } : null,
      opened: !!touched.rows[0]?.ok,
      notify: !!notify.rows[0]?.ok,
      invitedBy: inviter ? { name: inviter.name } : null,
    };
  }

  private view(scope: 'workspace' | 'member', steps: StepView[], dismissal: Dismissal | undefined) {
    const doneCount = steps.filter((x) => x.done).length;
    return {
      scope,
      version: ONBOARDING_VERSION,
      eligible: true as const,
      steps,
      doneCount,
      total: steps.length,
      next: steps.find((x) => !x.done)?.key ?? null,
      completed: doneCount === steps.length,
      hidden: !!dismissal?.hiddenAt,
      never: dismissal?.never ?? false,
      completionSeen: !!dismissal?.completionSeenAt,
    };
  }

  // ---------------------------------------------------------------------------
  // ซ่อน / แสดง / ไม่ต้องแสดงอีก (ต่อคน)
  // ---------------------------------------------------------------------------

  async dismiss(auth: AuthInfo, tenant: TenantInfo, action: 'hide' | 'show' | 'never' | 'complete_seen') {
    assertNotGuest(tenant);
    const now = new Date();
    const set =
      action === 'hide' ? { hiddenAt: now } : action === 'show' ? { hiddenAt: null, never: false } : action === 'never' ? { never: true } : { completionSeenAt: now };
    return this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx
        .insert(s.onboardingDismissals)
        .values({ workspaceId: tenant.workspaceId, userId: auth.userId, ...set })
        .onConflictDoUpdate({ target: [s.onboardingDismissals.workspaceId, s.onboardingDismissals.userId], set })
        .returning();
      return { hidden: !!row.hiddenAt, never: row.never, completionSeen: !!row.completionSeenAt };
    });
  }

  /** ปุ่ม "เปิดงาน" ในรายการของสมาชิก (V3) · บันทึกเฉพาะงานที่ได้รับมอบหมายจริงและมองเห็นได้ */
  async taskOpened(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof TaskOpenedBody>) {
    assertNotGuest(tenant);
    const [projectKey, num] = [body.issueKey.slice(0, body.issueKey.lastIndexOf('-')).toUpperCase(), Number(body.issueKey.slice(body.issueKey.lastIndexOf('-') + 1))];
    const ok = await this.db.run(auth, tenant, async (tx) => {
      const [row] = await tx
        .select({ id: s.issues.id })
        .from(s.issues)
        .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
        .innerJoin(s.issueAssignees, and(eq(s.issueAssignees.issueId, s.issues.id), eq(s.issueAssignees.userId, auth.userId)))
        .where(and(eq(s.projects.workspaceId, tenant.workspaceId), eq(s.projects.key, projectKey), eq(s.issues.number, num), isNull(s.issues.deletedAt)));
      return !!row;
    });
    if (!ok) throw new AppError(404, 'issue_not_found', 'ไม่พบงานที่ได้รับมอบหมายนี้');
    const recorded = await this.record({ userId: auth.userId }, tenant.workspaceId, auth.userId, [{ key: 'open_assigned', at: null, meta: {} }], MEMBER_STEPS.length);
    return { recorded: recorded.length > 0 };
  }

  // ---------------------------------------------------------------------------
  // ผู้ฟังเหตุการณ์ และงานทุกคืน
  // ---------------------------------------------------------------------------

  private async onEvent(e: DomainEvent) {
    // เหตุการณ์จากระบบ (Automation, Job) ไม่มีผู้ทำให้บันทึกในนาม · ขั้นจะถูกบันทึกตอนเปิด Home หรืองานทุกคืน
    if (!e.actorId) return;
    // member.joined ที่ไม่มี via = เพิ่มสมาชิกเดิมเข้าโปรเจกต์ (จำนวนสมาชิก Workspace ไม่เปลี่ยน)
    if (e.type === 'member.joined' && !e.data.via) return;
    await this.advanceWorkspace({ userId: e.actorId }, e.workspaceId, TRIGGERS[e.type], e.type === 'import.completed' ? { imported: Number(e.data.imported ?? e.data.added ?? 0) || 0 } : {});
  }

  /** ตรวจและบันทึกขั้นของ Workspace ที่เพิ่งเสร็จ · ข้าม Workspace ที่ครบแล้วหรือเป็น Workspace เก่าที่ใช้จริงแล้ว */
  private async advanceWorkspace(actor: Actor, workspaceId: string, only?: WorkspaceStepKey[], extraMeta: Record<string, number> = {}) {
    const done = await this.sys
      .select({ step: s.onboardingProgress.step })
      .from(s.onboardingProgress)
      .where(and(eq(s.onboardingProgress.workspaceId, workspaceId), isNull(s.onboardingProgress.userId), eq(s.onboardingProgress.version, ONBOARDING_VERSION)));
    if (done.length >= WORKSPACE_STEPS.length) return [];
    const counts = await this.counts(workspaceId);
    if (!done.length) {
      const [ws] = await this.sys.select({ createdAt: s.workspaces.createdAt }).from(s.workspaces).where(eq(s.workspaces.id, workspaceId));
      if (!ws || isLegacy(ws.createdAt, counts)) return [];
    }
    const have = new Set(done.map((d) => d.step));
    const met = metWorkspaceSteps(counts)
      .filter((x) => !have.has(x.key) && (!only || only.includes(x.key)))
      .map((x) => (x.key === 'issues' && extraMeta.imported ? { ...x, meta: { ...x.meta, imported: extraMeta.imported } } : x));
    return this.record(actor, workspaceId, null, met, WORKSPACE_STEPS.length);
  }

  /**
   * งานทุกคืน: ตรวจ Workspace อายุไม่เกิน 120 วันที่ยังไม่ครบ · ขั้นที่ไม่มีเหตุการณ์ (โปรเจกต์แรก, แจ้งเตือน) และลูกค้าที่ไม่กลับมาเปิด Home
   * ใช้ SYSTEM_DB เพราะเป็นงานของระบบข้ามทุก Workspace (ไม่มีผู้ใช้ในคำขอ) · Friday Ops อ่านผลจาก onboarding_progress
   */
  async reconcile() {
    const since = new Date(Date.now() - RECONCILE_DAYS * 86_400_000);
    const rows = await this.sys.execute<{ id: string }>(sql`
      select w.id from ${s.workspaces} w
      where w.deleted_at is null and w.created_at >= ${since}
        and (select count(*) from ${s.onboardingProgress} p where p.workspace_id = w.id and p.user_id is null and p.version = ${ONBOARDING_VERSION}) < ${WORKSPACE_STEPS.length}`);
    let recorded = 0;
    for (const { id } of rows.rows) {
      try {
        recorded += (await this.advanceWorkspace(null, id)).length;
      } catch (err) {
        this.log.warn(`ตรวจ Onboarding ของ ${id} ไม่สำเร็จ: ${(err as Error).message}`);
      }
    }
    return { workspaces: rows.rows.length, recorded };
  }

  /**
   * บันทึกขั้นที่เสร็จครั้งแรก + เหตุการณ์ onboarding.step_done ใน product_events (05-business-metrics › 1.2) ในธุรกรรมเดียวกัน
   * จึงนับครั้งเดียวแม้หลายคำขอตรวจพร้อมกัน (unique ของ onboarding_progress) · ส่ง EventBus หลัง commit
   */
  private async record(actor: Actor, workspaceId: string, userId: string | null, steps: Step[], total: number) {
    if (!steps.length) return [];
    const work = async (tx: Tx | Db) => {
      const now = Date.now();
      const inserted = await tx
        .insert(s.onboardingProgress)
        .values(steps.map((x) => ({ workspaceId, userId, version: ONBOARDING_VERSION, step: x.key, meta: x.meta, ...(x.at && x.at.getTime() <= now ? { doneAt: x.at } : {}) })))
        .onConflictDoNothing()
        .returning({ key: s.onboardingProgress.step, doneAt: s.onboardingProgress.doneAt });
      if (!inserted.length) return { inserted, completed: false };
      await tx.insert(s.productEvents).values(
        inserted.map((r) => ({ workspaceId, userId: actor?.userId ?? null, name: 'onboarding.step_done', props: { step: userId ? `member.${r.key}` : r.key, version: ONBOARDING_VERSION } })),
      );
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.onboardingProgress)
        .where(and(eq(s.onboardingProgress.workspaceId, workspaceId), userId ? eq(s.onboardingProgress.userId, userId) : isNull(s.onboardingProgress.userId), eq(s.onboardingProgress.version, ONBOARDING_VERSION)));
      return { inserted, completed: n >= total };
    };
    const result = actor
      ? await this.db.run({ userId: actor.userId, sessionId: '' }, { workspaceId, slug: '', role: 'member' }, work)
      : await this.sys.transaction(work);
    const at = new Date();
    const scope = userId ? 'member' : 'workspace';
    await this.events.publish([
      ...result.inserted.map((r) => ({ type: 'onboarding.step_done' as const, workspaceId, actorId: actor?.userId ?? null, data: { step: r.key, scope, version: ONBOARDING_VERSION, userId }, at })),
      ...(result.completed ? [{ type: 'onboarding.completed' as const, workspaceId, actorId: actor?.userId ?? null, data: { scope, version: ONBOARDING_VERSION, userId }, at }] : []),
    ]);
    return result.inserted;
  }

  /** ตัวเลขของขั้น Workspace (ไม่นับโปรเจกต์ตัวอย่างและงานในนั้น) · SYSTEM_DB จำกัดที่ Workspace เดียว คืนเฉพาะตัวเลขและเวลา */
  async counts(workspaceId: string): Promise<WorkspaceCounts> {
    const r = await this.sys.execute<Record<string, unknown>>(sql`
      with p as (
        select id, created_at from ${s.projects} where workspace_id = ${workspaceId} and deleted_at is null and name <> ${SAMPLE_PROJECT_NAME}
      ), i as (
        select id, created_at, plan_end from ${s.issues} where workspace_id = ${workspaceId} and deleted_at is null and project_id in (select id from p)
      ), m as (
        select user_id, joined_at from ${s.workspaceMembers} where workspace_id = ${workspaceId} and status = 'active' and role <> 'guest'
      ), st as (
        select created_at from ${s.activities} where workspace_id = ${workspaceId} and field = 'statusId' and actor_kind = 'user' and project_id in (select id from p)
      ), n as (
        select least(
          (select b.bound_at from ${s.lineBindings} b where b.user_id = m.user_id and b.unbound_at is null),
          (select min(x.created_at) from ${s.userNotificationPrefs} x where x.workspace_id = ${workspaceId} and x.user_id = m.user_id and x.channel = 'email' and x.enabled),
          (select x.created_at from ${s.userNotificationSettings} x where x.workspace_id = ${workspaceId} and x.user_id = m.user_id)
        ) as at from m
      )
      select
        (select count(*)::int from p) as projects,
        (select min(created_at) from p) as first_project_at,
        (select count(*)::int from i) as issues,
        (select created_at from i order by created_at offset 9 limit 1) as tenth_issue_at,
        (select count(*)::int from m) as members,
        (select joined_at from m order by joined_at offset 2 limit 1) as third_member_at,
        (select count(*)::int from i where plan_end is not null and exists (select 1 from ${s.issueAssignees} a where a.issue_id = i.id)) as assigned_with_due,
        (select count(*)::int from st) as status_changes,
        (select min(created_at) from st) as first_status_at,
        (select count(*)::int from n where at is not null) as notify_members,
        (select min(at) from n) as first_notify_at`);
    const x = r.rows[0];
    return {
      projects: Number(x.projects),
      firstProjectAt: asDate(x.first_project_at),
      issues: Number(x.issues),
      tenthIssueAt: asDate(x.tenth_issue_at),
      members: Number(x.members),
      thirdMemberAt: asDate(x.third_member_at),
      assignedWithDue: Number(x.assigned_with_due),
      statusChanges: Number(x.status_changes),
      firstStatusAt: asDate(x.first_status_at),
      notifyMembers: Number(x.notify_members),
      firstNotifyAt: asDate(x.first_notify_at),
    };
  }
}

type Dismissal = typeof s.onboardingDismissals.$inferSelect;

function assertNotGuest(tenant: TenantInfo) {
  // Guest ไม่เห็นการ์ดและรายการ (V1) · ตอบ 403 เหมือนส่วนอื่นที่ Guest ใช้ไม่ได้
  if (tenant.role === 'guest') throw new AppError(403, 'forbidden', 'Guest ไม่มีรายการเริ่มต้นใช้งาน');
}

async function workspaceCreatedAt(tx: Tx, workspaceId: string) {
  const [ws] = await tx.select({ createdAt: s.workspaces.createdAt }).from(s.workspaces).where(eq(s.workspaces.id, workspaceId));
  return ws.createdAt;
}

async function dismissalOf(tx: Tx, workspaceId: string, userId: string) {
  const [row] = await tx.select().from(s.onboardingDismissals).where(and(eq(s.onboardingDismissals.workspaceId, workspaceId), eq(s.onboardingDismissals.userId, userId)));
  return row;
}

/** ขั้นที่บันทึกแล้ว → เวลาที่เสร็จ · userId null = ขั้นของ Workspace */
async function progressOf(tx: Tx, workspaceId: string, userId: string | null) {
  const rows = await tx
    .select({ step: s.onboardingProgress.step, doneAt: s.onboardingProgress.doneAt })
    .from(s.onboardingProgress)
    .where(and(eq(s.onboardingProgress.workspaceId, workspaceId), userId ? eq(s.onboardingProgress.userId, userId) : isNull(s.onboardingProgress.userId), eq(s.onboardingProgress.version, ONBOARDING_VERSION)));
  return new Map(rows.map((r) => [r.step, r.doneAt]));
}

/** ลิงก์ของปุ่ม ต่อจาก /work/{ws}/ · ขั้นที่ต้องเปิดโปรเจกต์ใช้โปรเจกต์แรก (ยังไม่มีโปรเจกต์ = ไปสร้างโปรเจกต์) */
function actionPath(action: StepAction, projectKey: string | null): string {
  switch (action) {
    case 'new_project':
      return 'new-project';
    case 'import':
      return 'import';
    case 'invite':
      return 'members';
    case 'table':
      return projectKey ? `p/${projectKey}/table` : 'new-project';
    case 'kanban':
      return projectKey ? `p/${projectKey}/board` : 'new-project';
    case 'notify_settings':
      return 'profile?tab=notify';
    case 'profile_hours':
      return 'profile?tab=hours';
    case 'open_issue':
      return '';
  }
}

