import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { addDays, billingContacts, todayBkk } from '../billing/ledger.js';
import { OPS_DB } from '../db.js';
import { sqlRows } from '../sql-rows.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { healthScore } from '../metrics/economics.js';
import { PageQuery } from '../paging.js';
import { DEFAULT_PLAYBOOKS, METRIC, OUTCOMES, type Outcome, PlaybookBody, RECOVER_AT, type Step, type Trigger } from './playbooks.js';

const s = schema;
const HOUR = 3_600_000;
/** ปิดแล้วไม่เริ่ม Playbook เดิมกับลูกค้าเดิมซ้ำภายใน 14 วัน (กันวนเข้าออกเมื่อคะแนนแกว่ง) */
const COOLDOWN_DAYS = 14;
/** "เพิ่งตก" = คะแนนลดลงอย่างน้อยเท่านี้ใน 7 วัน */
const DROP = 10;

export const RunsQuery = PageQuery.extend({
  tab: z.enum(['active', 'dropped', 'recovered', 'churned']).default('active'),
  q: z.string().trim().max(100).optional(),
  playbook: z.string().trim().max(40).optional(),
  owner: z.union([z.uuid(), z.literal('me')]).optional(),
  weak: z.enum(['usage', 'payment', 'support', 'growth']).optional(),
  plan: z.enum(['team_s', 'team_m', 'team_l', 'enterprise']).optional(),
  minMrr: z.coerce.number().int().min(0).optional(),
  overdue: z.enum(['true']).optional(),
});
export const OutcomeBody = z.object({ outcome: z.enum(OUTCOMES), note: z.string().trim().max(2000).optional() }).strict();
export const SnoozeBody = z.object({ days: z.number().int().min(1).max(14) }).strict();
export const CloseBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const StartBody = z.object({ workspaceId: z.uuid(), playbookId: z.uuid() }).strict();

type PbRow = typeof s.playbooks.$inferSelect;
type RunRow = typeof s.playbookRuns.$inferSelect;
interface Health {
  workspaceId: string;
  score: number;
  usage: number;
  payment: number;
  support: number;
  growth: number;
}

/**
 * สุขภาพและ Playbook (O53 · เฟส 3) · Owner และ Support
 * ทุกเช้า 07:00 (เวลาไทย): เก็บคะแนนสุขภาพรายวัน → ปิด run ของลูกค้าที่ยกเลิก → เริ่ม Playbook ใหม่ตามเงื่อนไข → เดินขั้นอัตโนมัติ (อีเมล / ครบเวลารอ)
 * งานของคนแจกให้คนดูแลบัญชีลูกค้า ถ้าไม่มีให้ Support ที่มีงานค้างน้อยสุด (ออนไลน์ก่อน)
 */
@Injectable()
export class SuccessService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsSuccess');
  private timer?: NodeJS.Timeout;
  private lastDay = '';

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
  ) {}

  /** ตรวจทุกชั่วโมง · ทำงานรอบวันเมื่อเลย 07:00 ของวันใหม่ (รีสตาร์ตแล้วไม่ทำซ้ำ เพราะทุกขั้นรันซ้ำได้) */
  onModuleInit() {
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => {
        const bkk = new Date(Date.now() + 7 * HOUR);
        const day = bkk.toISOString().slice(0, 10);
        if (bkk.getUTCHours() >= 7 && day !== this.lastDay) {
          this.lastDay = day;
          void this.daily().catch((e) => this.log.error(String(e)));
        }
      }, HOUR / 4);
      this.timer.unref?.();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private rows<T>(q: SQL, db: Db | Tx = this.db) {
    return sqlRows<T>(db, q);
  }

  /** สร้าง Playbook เริ่มต้นที่ยังไม่มี (แก้ / ปิดได้จากปุ่มเฟือง · ไม่เขียนทับที่ทีมแก้แล้ว) */
  async ensureDefaults() {
    await this.db
      .insert(s.playbooks)
      .values(DEFAULT_PLAYBOOKS.map((p) => ({ key: p.key, name: p.name, trigger: p.trigger, steps: p.steps })))
      .onConflictDoNothing();
  }

  async daily(today = todayBkk()) {
    await this.ensureDefaults();
    const scored = await this.snapshot(today);
    const churned = await this.closeChurned();
    const started = await this.startRuns(today);
    const advanced = await this.advance(today);
    return { scored, churned, started, advanced };
  }

  // ---------------------------------------------------------------- คะแนนรายวัน

  /** คะแนนของลูกค้าที่จ่ายเงิน (แพ็กเกจเสียเงินที่ active / ค้างชำระ · ไม่รวม Workspace ทดสอบที่ทีมยืนยัน) */
  async snapshot(today: string) {
    const rows = await this.rows<Record<string, number> & { id: string }>(sql`
      select w.id,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.last_active_at > now() - interval '30 days') as active30,
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest' and m.joined_at < now() - interval '30 days') as "members30dAgo",
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status in ('open', 'pending_review') and i.due_date < ${today}::date) as overdue,
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid') as "paidTotal",
        (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid' and (i.paid_at at time zone 'Asia/Bangkok')::date <= i.due_date) as "paidOnTime",
        (select count(*)::int from support_tickets k where k.workspace_id = w.id and k.status in ('open', 'pending_customer', 'pending_dev')) as "openTickets"
      from workspaces w join subscriptions sub on sub.workspace_id = w.id join plans p on p.id = sub.plan_id
      where w.deleted_at is null and sub.status in ('active', 'past_due') and p.code <> 'free'
        and not exists (select 1 from ops_workspace_flags f where f.workspace_id = w.id and f.test_flag = 'test')`);
    if (!rows.length) return 0;
    const values = rows.map((r) => {
      const h = healthScore({ seats: r.seats, active30: r.active30, overdueInvoices: r.overdue, paidOnTime: r.paidOnTime, paidTotal: r.paidTotal, openTickets: r.openTickets, membersNow: r.seats, members30dAgo: r.members30dAgo });
      return { workspaceId: r.id, date: today, score: h.score, ...h.parts };
    });
    for (let i = 0; i < values.length; i += 500) {
      await this.db
        .insert(s.healthDaily)
        .values(values.slice(i, i + 500))
        .onConflictDoUpdate({ target: [s.healthDaily.workspaceId, s.healthDaily.date], set: { score: sql`excluded.score`, usage: sql`excluded.usage`, payment: sql`excluded.payment`, support: sql`excluded.support`, growth: sql`excluded.growth` } });
    }
    return values.length;
  }

  private async latest(ids: string[]): Promise<Map<string, Health>> {
    if (!ids.length) return new Map();
    const rows = await this.rows<Health>(sql`
      select distinct on (workspace_id) workspace_id as "workspaceId", score, usage, payment, support, growth
      from health_daily where workspace_id = any(${sql.param(ids)}::uuid[]) order by workspace_id, date desc`);
    return new Map(rows.map((r) => [r.workspaceId, r]));
  }

  // ---------------------------------------------------------------- เดิน Playbook

  private async closeRun(db: Db | Tx, runId: string, status: 'recovered' | 'churned' | 'closed', reason: string) {
    await db.update(s.playbookRuns).set({ status, closedAt: new Date(), closeReason: reason }).where(and(eq(s.playbookRuns.id, runId), eq(s.playbookRuns.status, 'active')));
    await db.update(s.playbookRunSteps).set({ status: 'skipped' }).where(and(eq(s.playbookRunSteps.runId, runId), eq(s.playbookRunSteps.status, 'pending')));
  }

  /** ลูกค้าที่ยกเลิกแพ็กเกจ / ถูกลบระหว่างอยู่ใน Playbook */
  private async closeChurned() {
    const gone = await this.rows<{ id: string }>(sql`
      select r.id from playbook_runs r join workspaces w on w.id = r.workspace_id left join subscriptions sub on sub.workspace_id = w.id
      where r.status = 'active' and (w.deleted_at is not null or sub.status = 'canceled' or sub.id is null)`);
    for (const r of gone) await this.closeRun(this.db, r.id, 'churned', 'ยกเลิกแพ็กเกจ');
    return gone.length;
  }

  /** ลูกค้าที่ต่ำกว่าเกณฑ์ติดกัน N วัน (นับแถวรายวันล่าสุด N แถว) */
  private async matching(pb: PbRow, today: string) {
    const t = pb.trigger as Trigger;
    const metric = METRIC[t.kind];
    const renewal = t.kind === 'renewal_low_health' ? sql`and exists (select 1 from customer_account_workspaces caw join customer_accounts ca on ca.id = caw.account_id
        where caw.workspace_id = h.workspace_id and ca.contract_end between ${today}::date and ${today}::date + 90)` : sql``;
    return this.rows<{ workspaceId: string; score: number }>(sql`
      select h.workspace_id as "workspaceId", (array_agg(h.score order by h.date desc))[1] as score
      from health_daily h
      where h.date > (${today}::date - ${t.days}::int) and h.date <= ${today}::date ${renewal}
      group by h.workspace_id
      having count(*) >= ${t.days}::int and bool_and(h.${sql.raw(metric)} < ${t.threshold}::int)`);
  }

  /** คนรับงาน: คนดูแลบัญชีลูกค้า → ผู้ดูแลประจำบัญชีของ Support → Support ที่งานค้างน้อยสุด (ออนไลน์ก่อน) */
  private async ownerFor(workspaceId: string) {
    const [m] = await this.rows<{ id: string | null }>(sql`
      select coalesce(
        (select ca.manager_id from customer_account_workspaces caw join customer_accounts ca on ca.id = caw.account_id join staff_users st on st.id = ca.manager_id
          where caw.workspace_id = ${workspaceId} and st.status = 'active'),
        (select am.staff_id from support_account_managers am join staff_users st on st.id = am.staff_id where am.workspace_id = ${workspaceId} and st.status = 'active')
      ) as id`);
    if (m?.id) return m.id;
    const [least] = await this.rows<{ id: string }>(sql`
      select st.id from staff_users st left join support_agents a on a.staff_id = st.id
      where st.status = 'active' and 'support' = any(st.roles)
      order by (coalesce(a.presence, 'online') = 'online') desc,
        (select count(*) from playbook_run_steps ps where ps.assignee_id = st.id and ps.status = 'pending' and ps.kind = 'task'), st.created_at
      limit 1`);
    return least?.id ?? null;
  }

  private async startRuns(today: string) {
    const pbs = await this.db.select().from(s.playbooks).where(eq(s.playbooks.enabled, true));
    let started = 0;
    for (const pb of pbs) {
      for (const m of await this.matching(pb, today)) {
        const [busy] = await this.rows<{ id: string }>(sql`
          select id from playbook_runs where playbook_id = ${pb.id} and workspace_id = ${m.workspaceId}
            and (status = 'active' or closed_at > now() - (${COOLDOWN_DAYS} || ' days')::interval) limit 1`);
        if (busy) continue;
        const ownerId = await this.ownerFor(m.workspaceId);
        const [run] = await this.db.insert(s.playbookRuns).values({ playbookId: pb.id, workspaceId: m.workspaceId, ownerId, scoreAtStart: m.score }).onConflictDoNothing().returning();
        if (!run) continue;
        await this.enter(run, pb, 0, today);
        started++;
      }
    }
    return started;
  }

  /** เข้าขั้นที่ i: อีเมลส่งเลยแล้วไปต่อ · งานของคน / รอ สร้างขั้นค้างพร้อมวันครบกำหนด · เกินขั้นสุดท้าย = จบ */
  private async enter(run: RunRow, pb: PbRow, i: number | 'close', today: string, why = 'จบทุกขั้น'): Promise<void> {
    const steps = pb.steps as Step[];
    if (i === 'close' || i >= steps.length) return this.closeRun(this.db, run.id, 'closed', i === 'close' ? why : 'จบทุกขั้น');
    const step = steps[i];
    await this.db.update(s.playbookRuns).set({ stepIndex: i }).where(eq(s.playbookRuns.id, run.id));
    if (step.kind === 'email') {
      const sent = await this.emailCustomer(run.workspaceId, step);
      await this.db.insert(s.playbookRunSteps).values({ runId: run.id, stepIndex: i, kind: 'email', title: step.title, status: 'done', outcome: 'sent', note: `ส่ง ${sent} อีเมล`, doneAt: new Date() });
      return this.enter(run, pb, i + 1, today);
    }
    await this.db.insert(s.playbookRunSteps).values({ runId: run.id, stepIndex: i, kind: step.kind, title: step.title, assigneeId: step.kind === 'task' ? run.ownerId : null, dueOn: addDays(today, step.days) });
  }

  /** อีเมลถึง Owner / Admin / ผู้รับใบแจ้งหนี้ · ข้ามอีเมลในรายชื่อไม่ส่ง (O23) */
  private async emailCustomer(workspaceId: string, step: Step) {
    const to = await billingContacts(this.db, workspaceId);
    if (!to.length) return 0;
    const blocked = await this.rows<{ email: string }>(sql`select lower(email) as email from email_suppressions where removed_at is null and lower(email) = any(${sql.param(to)}::text[])`);
    const skip = new Set(blocked.map((b) => b.email));
    let sent = 0;
    for (const email of to.filter((e) => !skip.has(e))) {
      try {
        await this.mail.send({ to: email, subject: step.title, text: step.body ?? step.title });
        sent++;
      } catch {
        /* Mailer บันทึก log แล้ว */
      }
    }
    return sent;
  }

  /** ขั้นรอที่ครบกำหนด: คะแนนถึง 60 = ฟื้นแล้ว ปิดเอง · ไม่ถึง = ไปขั้นถัดไป */
  private async advance(today: string) {
    const due = await this.rows<{ stepId: string; runId: string }>(sql`
      select ps.id as "stepId", ps.run_id as "runId" from playbook_run_steps ps join playbook_runs r on r.id = ps.run_id
      where ps.kind = 'wait' and ps.status = 'pending' and ps.due_on <= ${today}::date and r.status = 'active'`);
    for (const d of due) {
      const { run, pb } = await this.runOf(d.runId);
      const h = (await this.latest([run.workspaceId])).get(run.workspaceId);
      const ok = (h?.score ?? 0) >= RECOVER_AT;
      await this.db.update(s.playbookRunSteps).set({ status: 'done', outcome: ok ? 'recovered' : 'waited', doneAt: new Date() }).where(eq(s.playbookRunSteps.id, d.stepId));
      if (ok) await this.closeRun(this.db, run.id, 'recovered', `คะแนนฟื้นเป็น ${h!.score}`);
      else await this.enter(run, pb, run.stepIndex + 1, today);
    }
    return due.length;
  }

  private async runOf(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Playbook ของลูกค้า');
    const [r] = await this.db.select({ run: s.playbookRuns, pb: s.playbooks }).from(s.playbookRuns).innerJoin(s.playbooks, eq(s.playbooks.id, s.playbookRuns.playbookId)).where(eq(s.playbookRuns.id, id));
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบ Playbook ของลูกค้า');
    return r;
  }

  private async stepOf(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบขั้นนี้');
    const [st] = await this.db.select().from(s.playbookRunSteps).where(eq(s.playbookRunSteps.id, id));
    if (!st) throw new AppError(404, 'not_found', 'ไม่พบขั้นนี้');
    if (st.status !== 'pending') throw new AppError(409, 'step_done', 'ขั้นนี้บันทึกผลไปแล้ว');
    return st;
  }

  // ---------------------------------------------------------------- คนทำ

  /** บันทึกผลงานของคน แล้วไปขั้นตามทางแยก (ไม่ระบุ = ขั้นถัดไป · close = ปิด Playbook) */
  async recordOutcome(staff: Staff, stepId: string, input: z.infer<typeof OutcomeBody>, today = todayBkk()) {
    const st = await this.stepOf(stepId);
    if (st.kind !== 'task') throw new AppError(422, 'not_a_task', 'บันทึกผลได้เฉพาะงานของคน');
    const { run, pb } = await this.runOf(st.runId);
    if (run.status !== 'active') throw new AppError(409, 'run_closed', 'Playbook นี้ปิดแล้ว');
    await this.db.update(s.playbookRunSteps).set({ status: 'done', outcome: input.outcome, note: input.note ?? null, doneAt: new Date(), doneBy: staff.id }).where(eq(s.playbookRunSteps.id, st.id));
    const step = (pb.steps as Step[])[st.stepIndex];
    const next = step?.branches?.[input.outcome as Outcome] ?? st.stepIndex + 1;
    await audit(this.db, staff, run.workspaceId, 'data', 'ops.playbook_step', `Playbook ${pb.name} · ${st.title} · ${input.outcome}${input.note ? ` · ${input.note}` : ''}`, { type: 'playbook_run', id: run.id });
    await this.enter(run, pb, next, today, `ผล: ${input.outcome}`);
    return this.detail(run.id);
  }

  async snooze(staff: Staff, stepId: string, days: number) {
    const st = await this.stepOf(stepId);
    const due = addDays(st.dueOn ?? todayBkk(), days);
    await this.db.update(s.playbookRunSteps).set({ dueOn: due }).where(eq(s.playbookRunSteps.id, st.id));
    await staffAudit(this.db, staff, 'success.step_snoozed', `${st.title} เลื่อนเป็น ${due}`, { type: 'playbook_run', id: st.runId });
    return { id: st.id, dueOn: due };
  }

  async close(staff: Staff, runId: string, reason: string) {
    const { run, pb } = await this.runOf(runId);
    if (run.status !== 'active') throw new AppError(409, 'run_closed', 'Playbook นี้ปิดแล้ว');
    await this.closeRun(this.db, run.id, 'closed', reason);
    await audit(this.db, staff, run.workspaceId, 'data', 'ops.playbook_closed', `ปิด Playbook ${pb.name} · ${reason}`, { type: 'playbook_run', id: run.id });
    return { id: run.id, status: 'closed' };
  }

  /** เริ่ม Playbook เอง (เช่น จากแท็บ "เพิ่งตก") */
  async start(staff: Staff, input: z.infer<typeof StartBody>, today = todayBkk()) {
    const [pb] = await this.db.select().from(s.playbooks).where(eq(s.playbooks.id, input.playbookId));
    if (!pb) throw new AppError(404, 'not_found', 'ไม่พบ Playbook');
    const [run] = await this.db
      .insert(s.playbookRuns)
      .values({ playbookId: pb.id, workspaceId: input.workspaceId, ownerId: (await this.ownerFor(input.workspaceId)) ?? staff.id, scoreAtStart: (await this.latest([input.workspaceId])).get(input.workspaceId)?.score ?? null })
      .onConflictDoNothing()
      .returning();
    if (!run) throw new AppError(409, 'run_active', 'ลูกค้ารายนี้อยู่ใน Playbook นี้แล้ว');
    await audit(this.db, staff, input.workspaceId, 'data', 'ops.playbook_started', `เริ่ม Playbook ${pb.name}`, { type: 'playbook_run', id: run.id });
    await this.enter(run, pb, 0, today);
    return this.detail(run.id);
  }

  // ---------------------------------------------------------------- หน้าจอ

  private readonly MRR = sql`(select c.mrr_after_satang::float8 from subscription_changes c where c.workspace_id = w.id order by c.effective_at desc, c.created_at desc limit 1)`;

  async summary(staff: Staff, today = todayBkk()) {
    const [n] = await this.rows<{ paying: number; low: number; risk: number; recovered: number; closed: number }>(sql`
      with last as (select distinct on (workspace_id) workspace_id, score from health_daily where date > ${today}::date - 3 order by workspace_id, date desc)
      select (select count(*)::int from last) as paying, (select count(*)::int from last where score < 40) as low,
        (select coalesce(sum(${this.MRR}), 0)::float8 from playbook_runs r join workspaces w on w.id = r.workspace_id where r.status = 'active') as risk,
        (select count(*)::int from playbook_runs where status = 'recovered' and closed_at > now() - interval '30 days') as recovered,
        (select count(*)::int from playbook_runs where status <> 'active' and closed_at > now() - interval '30 days') as closed`);
    const todo = await this.rows<Record<string, unknown>>(sql`
      select ps.id, ps.title, ps.due_on as "dueOn", ps.assignee_id as "assigneeId", st.name as assignee, r.id as "runId", pb.name as playbook,
        r.step_index + 1 as step, jsonb_array_length(pb.steps) as steps, w.id as "workspaceId", w.name as workspace,
        (select score from health_daily h where h.workspace_id = w.id order by date desc limit 1) as score, ps.due_on < ${today}::date as overdue
      from playbook_run_steps ps join playbook_runs r on r.id = ps.run_id join playbooks pb on pb.id = r.playbook_id join workspaces w on w.id = r.workspace_id
      left join staff_users st on st.id = ps.assignee_id
      where ps.kind = 'task' and ps.status = 'pending' and r.status = 'active' and ps.due_on <= ${today}::date
      order by (ps.assignee_id = ${staff.id}) desc, ps.due_on, score nulls last limit 50`);
    const tabs = await this.counts(today);
    return {
      paying: n.paying, low: n.low, mrrAtRisk: n.risk, recoveredPct: n.closed ? Math.round((n.recovered / n.closed) * 100) : null,
      todo: { items: todo, mine: todo.filter((x) => x.assigneeId === staff.id).length, overdue: todo.filter((x) => x.overdue).length },
      tabs,
    };
  }

  private async counts(today: string) {
    const [c] = await this.rows<{ active: number; dropped: number; recovered: number; churned: number }>(sql`
      select (select count(*)::int from playbook_runs where status = 'active') as active,
        (select count(*)::int from (${this.droppedSql(today)}) d) as dropped,
        (select count(*)::int from playbook_runs where status = 'recovered' and closed_at > now() - interval '90 days') as recovered,
        (select count(*)::int from playbook_runs where status = 'churned' and closed_at > now() - interval '90 days') as churned`);
    return c;
  }

  /** ลูกค้าที่คะแนนลด ≥ 10 ใน 7 วันและยังไม่อยู่ใน Playbook */
  private droppedSql(today: string) {
    return sql`select n.workspace_id from health_daily n join health_daily o on o.workspace_id = n.workspace_id and o.date = ${today}::date - 7
      where n.date = ${today}::date and o.score - n.score >= ${DROP} and not exists (select 1 from playbook_runs r where r.workspace_id = n.workspace_id and r.status = 'active')`;
  }

  async runs(staff: Staff, q: z.infer<typeof RunsQuery>, today = todayBkk()) {
    const where: SQL[] = [];
    if (q.tab === 'dropped') where.push(sql`w.id in (${this.droppedSql(today)})`);
    else where.push(q.tab === 'active' ? sql`r.status = 'active'` : sql`r.status = ${q.tab} and r.closed_at > now() - interval '90 days'`);
    if (q.q) where.push(sql`(lower(w.name) like ${`%${q.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`} or lower(w.slug) like ${`%${q.q.toLowerCase()}%`})`);
    if (q.tab !== 'dropped') {
      if (q.playbook) where.push(sql`pb.key = ${q.playbook}`);
      if (q.owner) where.push(sql`r.owner_id = ${q.owner === 'me' ? staff.id : q.owner}`);
      if (q.overdue) where.push(sql`exists (select 1 from playbook_run_steps x where x.run_id = r.id and x.status = 'pending' and x.kind = 'task' and x.due_on < ${today}::date)`);
    }
    if (q.plan) where.push(sql`p.code = ${q.plan}`);
    if (q.minMrr) where.push(sql`coalesce(${this.MRR}, 0) >= ${q.minMrr}`);
    if (q.weak) where.push(sql`h.${sql.raw(q.weak)} = least(h.usage, h.payment, h.support, h.growth)`);
    const from = q.tab === 'dropped'
      ? sql`from workspaces w left join playbook_runs r on false left join playbooks pb on false`
      : sql`from playbook_runs r join workspaces w on w.id = r.workspace_id join playbooks pb on pb.id = r.playbook_id`;
    const base = sql`${from}
      left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id
      left join lateral (select score, usage, payment, support, growth from health_daily where workspace_id = w.id order by date desc limit 1) h on true
      left join lateral (select score from health_daily where workspace_id = w.id and date <= ${today}::date - 7 order by date desc limit 1) h7 on true
      left join staff_users own on own.id = r.owner_id
      where ${sql.join(where, sql` and `)}`;
    const items = await this.rows<Record<string, unknown>>(sql`
      select r.id as "runId", w.id as "workspaceId", w.name, w.slug, p.code as plan, h.score, h.usage, h.payment, h.support, h.growth, h7.score as "score7",
        pb.id as "playbookId", pb.name as playbook, r.status, r.closed_at as "closedAt", r.close_reason as "closeReason", own.name as owner, r.owner_id as "ownerId", ${this.MRR} as mrr,
        (select json_build_object('id', x.id, 'title', x.title, 'kind', x.kind, 'dueOn', x.due_on) from playbook_run_steps x where x.run_id = r.id and x.status = 'pending' order by x.step_index limit 1) as next
      ${base} order by ${q.tab === 'active' ? sql`h.score nulls last` : q.tab === 'dropped' ? sql`h7.score - h.score desc` : sql`r.closed_at desc`} limit ${q.limit} offset ${q.offset}`);
    const [{ n }] = await this.rows<{ n: number }>(sql`select count(*)::int as n ${base}`);
    return { items, total: n };
  }

  /** แผงขวา: คะแนนแยกส่วน · ขั้นของ Playbook (ทำแล้ว / ปัจจุบัน / ต่อไป) */
  async detail(runId: string) {
    const { run, pb } = await this.runOf(runId);
    const [ws] = await this.rows<Record<string, unknown>>(sql`
      select w.id, w.name, w.slug, p.code as plan, w.created_at as "createdAt",
        (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.status = 'active' and m.role <> 'guest') as seats,
        (select u.email from workspace_members m join users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.joined_at limit 1) as "ownerEmail",
        ${this.MRR} as mrr
      from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id where w.id = ${run.workspaceId}`);
    const history = await this.rows<{ date: string; score: number }>(sql`select to_char(date, 'YYYY-MM-DD') as date, score from health_daily where workspace_id = ${run.workspaceId} and date > current_date - 30 order by date`);
    const done = await this.db.select({ st: s.playbookRunSteps, by: s.staffUsers.name }).from(s.playbookRunSteps).leftJoin(s.staffUsers, eq(s.staffUsers.id, s.playbookRunSteps.assigneeId)).where(eq(s.playbookRunSteps.runId, run.id)).orderBy(s.playbookRunSteps.createdAt);
    const [owner] = run.ownerId ? await this.db.select({ name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, run.ownerId)) : [];
    return {
      id: run.id, status: run.status, closeReason: run.closeReason, startedAt: run.startedAt, scoreAtStart: run.scoreAtStart, stepIndex: run.stepIndex,
      owner: owner?.name ?? null, workspace: ws,
      health: (await this.latest([run.workspaceId])).get(run.workspaceId) ?? null, history,
      playbook: { id: pb.id, key: pb.key, name: pb.name, steps: pb.steps as Step[] },
      steps: done.map((d) => ({ id: d.st.id, stepIndex: d.st.stepIndex, kind: d.st.kind, title: d.st.title, status: d.st.status, outcome: d.st.outcome, note: d.st.note, dueOn: d.st.dueOn, doneAt: d.st.doneAt, assignee: d.by })),
    };
  }

  // ---------------------------------------------------------------- ปุ่มเฟือง

  async playbooks(today = todayBkk()) {
    await this.ensureDefaults();
    const pbs = await this.db.select().from(s.playbooks).orderBy(s.playbooks.createdAt);
    return { items: await Promise.all(pbs.map(async (p) => ({ ...p, matching: (await this.matching(p, today)).length, active: (await this.db.select({ id: s.playbookRuns.id }).from(s.playbookRuns).where(and(eq(s.playbookRuns.playbookId, p.id), eq(s.playbookRuns.status, 'active')))).length }))) };
  }

  async savePlaybook(staff: Staff, id: string, input: z.infer<typeof PlaybookBody>) {
    if (!has(staff, 'owner')) throw new AppError(403, 'forbidden', 'แก้ Playbook ได้เฉพาะ Owner');
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Playbook');
    const [row] = await this.db.update(s.playbooks).set({ name: input.name, enabled: input.enabled, trigger: input.trigger, steps: input.steps, updatedBy: staff.id }).where(eq(s.playbooks.id, id)).returning();
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบ Playbook');
    await staffAudit(this.db, staff, 'success.playbook_updated', `${row.name} · ${input.enabled ? 'เปิด' : 'ปิด'} · ${input.steps.length} ขั้น`, { type: 'playbook', id });
    return row;
  }
}
