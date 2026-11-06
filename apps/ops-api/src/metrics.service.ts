import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@friday/db';
import { sql } from 'drizzle-orm';
import { OPS_DB } from './db.js';

type Row = Record<string, string | number | null>;
/** node-postgres คืน `{ rows }` · ตัวขับอื่นคืนอาร์เรย์ตรง ๆ */
const rowsOf = <T,>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));

/** ตัวเลขธุรกิจ (3.12 › ops/metrics) · เงินเป็นสตางค์ */
@Injectable()
export class MetricsService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  async get() {
    const one = async (q: ReturnType<typeof sql>) => rowsOf<Row>(await this.db.execute(q))[0];
    // MRR = ใบแจ้งหนี้ที่ชำระแล้วล่าสุดของแต่ละ Workspace ที่ยังเป็น active (รายปี หาร 12) · ไม่รวมภาษี
    const revenue = await one(sql`
      select coalesce(sum(case when s.cycle = 'yearly' then i.subtotal / 12 else i.subtotal end), 0)::bigint as mrr, count(*)::int as paying
      from subscriptions s
      join lateral (select subtotal from invoices where workspace_id = s.workspace_id and status = 'paid' order by created_at desc limit 1) i on true
      where s.status = 'active'`);
    const base = await one(sql`
      select
        (select count(*)::int from workspaces where deleted_at is null) as workspaces,
        (select count(*)::int from workspaces where deleted_at is null and created_at > now() - interval '30 days') as new_30d,
        (select count(*)::int from subscriptions where status = 'trialing' and trial_ends_at > now()) as trialing,
        (select count(*)::int from subscriptions where status = 'trialing' and trial_ends_at <= now()) as trial_expired,
        (select count(*)::int from subscriptions where status = 'canceled' and updated_at > now() - interval '30 days') as canceled_30d,
        (select count(*)::int from subscriptions where status = 'past_due') as past_due,
        (select count(*)::int from payments where status = 'pending_review') as pending_payments,
        (select count(*)::int from workspaces where status = 'suspended') as suspended,
        (select coalesce(sum(amount), 0)::bigint from payments where status = 'confirmed' and updated_at > now() - interval '30 days') as paid_30d`);
    const byPlan = rowsOf<{ code: string; n: number }>(await this.db.execute(sql`select p.code, count(*)::int as n from subscriptions s join plans p on p.id = s.plan_id group by p.code order by p.code`));
    return {
      mrr: Number(revenue.mrr),
      payingWorkspaces: Number(revenue.paying),
      trialing: Number(base.trialing),
      trialExpired: Number(base.trial_expired),
      canceledLast30Days: Number(base.canceled_30d),
      pastDue: Number(base.past_due),
      pendingPayments: Number(base.pending_payments),
      suspended: Number(base.suspended),
      paidLast30Days: Number(base.paid_30d),
      workspaces: Number(base.workspaces),
      newWorkspacesLast30Days: Number(base.new_30d),
      byPlan: Object.fromEntries(byPlan.map((r) => [r.code, r.n])),
    };
  }
}
