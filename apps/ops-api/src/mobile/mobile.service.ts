import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Db } from '@friday/db';
import { sql } from 'drizzle-orm';
import { ApprovalsService } from '../approvals/approvals.service.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { OpsPaymentsService } from '../payments/ops-payments.service.js';
import { PushService } from '../push/push.service.js';
import { BusinessClock } from '../support/clock.js';

const HOUR = 3_600_000;
/** คิวกรณีชำระผิดปกติ: ตัดสินภายใน 4 ชม. ทำการ (Canvas Billing) · เหลือไม่ถึง 1 ชม. = ใกล้ครบ */
export const PAYMENT_SLA_HOURS = 4;
const NEAR_HOURS = 1;
/** เหตุที่ตัดสินบนมือถือได้ · ที่เหลือ (ผูกใบอื่น · 50 ทวิ · ยอดไม่ตรง) ทำต่อบนคอมพิวเตอร์ */
const MOBILE_ACTIONS: Record<string, { yes: 'confirm' | 'credit' | null; no: 'reject' | null }> = {
  payer_name_mismatch: { yes: 'confirm', no: 'reject' },
  duplicate_slip: { yes: 'confirm', no: 'reject' },
  unreadable_slip: { yes: 'confirm', no: 'reject' },
  double_payment: { yes: 'credit', no: null },
  wht_not_declared: { yes: null, no: 'reject' },
};
const bkkDay = (d = new Date()) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);

/**
 * Friday Ops บนมือถือ (O25 · M6): สรุปข้อมูลที่พอให้ตัดสินได้ในจอเดียว · การกระทำใช้ endpoint เดิม (อนุมัติ · เหตุขัดข้อง · คิวชำระ)
 * งานทุก 5 นาที: คิวชำระใกล้ครบ SLA → Web Push ถึงฝ่ายการเงิน (ครั้งเดียวต่อรายการ)
 */
@Injectable()
export class MobileService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsMobile');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly approvalsSvc: ApprovalsService,
    private readonly paymentsSvc: OpsPaymentsService,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 300_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** M6.1 · รออนุมัติ (พร้อมข้อมูลลูกค้า) + ตัดสินแล้ววันนี้ */
  async approvals(staff: Staff) {
    const pending = (await this.approvalsSvc.list(staff, { status: 'pending', limit: 100 })).items;
    const wsIds = [...new Set(pending.map((p) => p.workspaceId).filter((x): x is string => !!x))];
    const facts = wsIds.length
      ? await this.db.execute(sql`
          select w.id, w.name, w.slug, w.created_at as "createdAt", p.code as plan,
            (select count(*)::int from invoices i where i.workspace_id = w.id and i.status = 'paid') as "paidInvoices",
            (select count(*)::int from approval_requests a where a.workspace_id = w.id and a.kind = 'billing.refund' and a.status = 'approved') as refunds
          from workspaces w left join subscriptions sub on sub.workspace_id = w.id left join plans p on p.id = sub.plan_id
          where w.id in ${sql.raw(`(${wsIds.map((x) => `'${x}'`).join(', ')})`)}`)
      : { rows: [] };
    const byId = new Map(((facts as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) => [r.id as string, r]));
    const today = await this.db.execute(sql`
      select a.id, a.kind, a.status, a.amount_satang::float8 as "amountSatang", a.decided_at as "decidedAt", w.name as workspace, a.payload
      from approval_requests a left join workspaces w on w.id = a.workspace_id
      where a.status in ('approved', 'rejected') and a.decided_at >= (date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')
      order by a.decided_at desc limit 20`);
    const todayRows = ((today as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) => ({ ...r, summary: summarize(r.kind as string, r.payload as Record<string, unknown>, r.amountSatang as number | null), payload: undefined }));
    return {
      items: pending.map((p) => ({ ...p, rule: (p.payload as { rule?: string }).rule ?? null, summary: summarize(p.kind, p.payload as Record<string, unknown>, p.amountSatang), workspace: p.workspaceId ? (byId.get(p.workspaceId) ?? null) : null })),
      decidedToday: todayRows,
    };
  }

  /** M6.3 · คิวกรณีชำระผิดปกติ: เวลาที่เหลือตาม SLA · ทำบนมือถือได้ไหม · สถิติวันนี้ */
  async payments(now = new Date()) {
    const { items } = await this.paymentsSvc.exceptions({ limit: 100 });
    const clock = new BusinessClock();
    const list = items
      .map((x) => {
        const due = clock.addHours(new Date(x.waitingSince), PAYMENT_SLA_HOURS);
        const left = due.getTime() - now.getTime();
        return { ...x, timeline: undefined, dueAt: due.toISOString(), minutesLeft: Math.round(left / 60_000), nearSla: left <= NEAR_HOURS * HOUR, actions: MOBILE_ACTIONS[x.reason ?? ''] ?? { yes: null, no: null } };
      })
      .sort((a, b) => a.minutesLeft - b.minutesLeft);
    // ยืนยันวันนี้ (เวลาไทย) · ระบบยืนยันเอง = Webhook / ธนาคาร / Slip API
    const [r] = (await this.db.execute(sql`
      select count(*) filter (where verified_by in ('webhook', 'bank', 'slip_api'))::int as auto, count(*)::int as total
      from payments
      where status = 'confirmed' and coalesce(reviewed_at, updated_at) >= (date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')`) as unknown as { rows: { auto: number; total: number }[] }).rows;
    return {
      items: list,
      stats: { autoPct: r && r.total ? Math.round((100 * r.auto) / r.total) : null, confirmedToday: r?.total ?? 0, nearSla: list.filter((x) => x.nearSla).length, day: bkkDay(now) },
      slaHours: PAYMENT_SLA_HOURS,
    };
  }

  /** คิวชำระที่ใกล้ครบ SLA → แจ้งฝ่ายการเงินครั้งเดียวต่อรายการ */
  async tick(now = new Date()) {
    const { items } = await this.payments(now);
    let sent = 0;
    for (const x of items.filter((i) => i.nearSla)) {
      const fresh = await this.push.once(`payment-sla:${x.id}`, () =>
        this.push.toRoles(['finance'], {
          title: x.minutesLeft <= 0 ? 'คิวชำระเกิน SLA' : 'คิวชำระใกล้ครบ SLA',
          body: `${x.workspace.name} · ${x.suggestion ?? ''}`.slice(0, 160),
          url: `/m/payments?id=${x.id}`,
          tag: `payment-${x.id}`,
        }),
      );
      if (fresh) sent++;
    }
    return { sent };
  }
}

/** ยอดของคำขอแบบสั้น (การ์ดในมือถือ) · ไม่มีจำนวนเงิน = ใช้ข้อมูลในคำขอ */
export function summarize(kind: string, payload: Record<string, unknown> | null, amountSatang: number | null) {
  if (amountSatang != null) return { kind: 'money' as const, satang: amountSatang };
  const input = ((payload ?? {}) as { input?: Record<string, unknown> }).input ?? {};
  if (kind === 'workspace.discount') return { kind: 'discount' as const, percent: input.percent as number, months: (input.months as number | null) ?? null };
  if (kind === 'workspace.extend_trial') return { kind: 'days' as const, days: input.days as number };
  return null;
}
