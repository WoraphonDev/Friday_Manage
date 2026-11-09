import { type Db, schema } from '@friday/db';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

/**
 * ตัวคำนวณของหน้า Workspaces / รายละเอียดลูกค้า (O02)
 * O06 (ธุรกิจและกำไร) ใช้สูตรเดียวกัน · ถ้า O06 ย้ายไปไว้ที่ metrics ให้ import จากที่นั่นแทน ไม่เขียนซ้ำ
 */
const s = schema;
const DAY = 86_400_000;

export interface HealthInput {
  seats: number;
  active30: number;
  overdueInvoices: number;
  paidOnTime: number;
  paidTotal: number;
  openTickets: number;
  membersNow: number;
  members30dAgo: number;
}

/** คะแนนสุขภาพ 0–100 · การใช้งาน 40% · การชำระเงิน 25% · Support 20% · การเติบโตของทีม 15% (ตามหน้าจอ CustomerDetail) */
export function healthScore(x: HealthInput) {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const usage = x.seats > 0 ? clamp(x.active30 / x.seats) : 0;
  const payment = x.overdueInvoices > 0 ? 0 : x.paidTotal > 0 ? x.paidOnTime / x.paidTotal : 1;
  const support = 1 - Math.min(x.openTickets, 5) / 5;
  // ทีมโต 20% ใน 30 วัน = เต็ม · คงที่ = ครึ่ง · หดลง = ต่ำกว่าครึ่ง
  const growth = x.members30dAgo > 0 ? clamp(0.5 + ((x.membersNow - x.members30dAgo) / x.members30dAgo) * 2.5) : x.membersNow > 1 ? 1 : 0.5;
  const score = Math.round(100 * (0.4 * usage + 0.25 * payment + 0.2 * support + 0.15 * growth));
  const pct = (n: number) => Math.round(n * 100);
  return { score, parts: { usage: pct(usage), payment: pct(payment), support: pct(support), growth: pct(growth) } };
}

/** MRR ก่อน VAT หลังส่วนลด (สตางค์) · ใช้ค่าล่าสุดจาก subscription_changes ถ้ามี ไม่มีก็คิดจากราคาแพ็กเกจ */
export function mrrOf(sub: { status: string; cycle: string; discount: unknown } | null, plan: { priceMonthlySatang: number | null; priceYearlySatang: number | null } | null, lastChange?: number | null) {
  if (lastChange != null) return lastChange;
  if (!sub || !plan || !['active', 'past_due'].includes(sub.status)) return 0;
  const base = sub.cycle === 'yearly' ? Math.round((plan.priceYearlySatang ?? 0) / 12) : plan.priceMonthlySatang ?? 0;
  const pct = (sub.discount as { percent?: number } | null)?.percent ?? 0;
  return Math.round(base * (1 - pct / 100));
}

/** กำไรขั้นต้นต่อลูกค้า 30 วันล่าสุด: รายได้ (MRR) − ต้นทุนผันแปรจาก daily_usages × cost_rates */
export async function profitOf(db: Db, workspaceId: string, mrr: number, paymentMethod: string | null) {
  const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const [u] = await db
    .select({
      line: sql<number>`coalesce(sum(${s.dailyUsages.lineMessages}), 0)::int`,
      emails: sql<number>`coalesce(sum(${s.dailyUsages.emails}), 0)::int`,
      storage: sql<number>`coalesce(avg(${s.dailyUsages.storageBytes}), 0)::float8`,
    })
    .from(s.dailyUsages)
    .where(and(eq(s.dailyUsages.workspaceId, workspaceId), gte(s.dailyUsages.date, since)));
  const rates = await db.select().from(s.costRates).where(lte(s.costRates.effectiveFrom, today)).orderBy(desc(s.costRates.effectiveFrom));
  const rate = (resource: string) => rates.find((r) => r.resource === resource);
  const unit = (resource: string) => Number(rate(resource)?.unitCostSatang ?? 0);
  const fee = rate(paymentMethod === 'card' ? 'payment_fee_card' : paymentMethod === 'promptpay' ? 'payment_fee_promptpay' : '');
  const costs = {
    lineMessages: { qty: u.line, satang: Math.round(u.line * unit('line_message')) },
    emails: { qty: u.emails, satang: Math.round(u.emails * unit('email')) },
    storage: { gb: Math.round((u.storage / 1024 ** 3) * 10) / 10, satang: Math.round((u.storage / 1024 ** 3) * unit('storage_gb_month')) },
    paymentFee: { satang: Math.round((mrr * Number(fee?.pct ?? 0)) / 100) },
  };
  const totalCost = costs.lineMessages.satang + costs.emails.satang + costs.storage.satang + costs.paymentFee.satang;
  return { revenueSatang: mrr, costs, costSatang: totalCost, grossSatang: mrr - totalCost, marginPct: mrr > 0 ? Math.round(((mrr - totalCost) / mrr) * 100) : null };
}

export interface SignalInput {
  plan: string | null;
  cycle: string | null;
  subStatus: string | null;
  seats: number;
  seatLimit: number | null;
  storageBytes: number;
  storageGbPerMember: number | null;
  limitHits14d: { limit: string; n: number }[];
  paidMonths: number;
}

/** สัญญาณพร้อมอัปเกรด (หน้าจอ: "สัญญาณพร้อมอัปเกรด") */
export function upgradeSignals(x: SignalInput) {
  const out: { code: string; message: string }[] = [];
  if (x.seatLimit && x.seats / x.seatLimit >= 0.8) out.push({ code: 'seats_near_limit', message: `ที่นั่ง ${x.seats} / ${x.seatLimit} (${Math.round((x.seats / x.seatLimit) * 100)}%)` });
  if (x.storageGbPerMember && x.seats > 0) {
    const cap = x.storageGbPerMember * x.seats * 1024 ** 3;
    if (x.storageBytes / cap >= 0.8) out.push({ code: 'storage_near_limit', message: `พื้นที่ไฟล์ใช้ ${Math.round((x.storageBytes / cap) * 100)}% ของแพ็กเกจ` });
  }
  for (const h of x.limitHits14d) if (h.n >= 2) out.push({ code: 'limit_hit', message: `ชนขีดจำกัด ${h.limit} ${h.n} ครั้งใน 14 วัน` });
  if (x.cycle === 'monthly' && x.subStatus === 'active' && x.paidMonths >= 6) out.push({ code: 'yearly_candidate', message: `จ่ายรายเดือนมาแล้ว ${x.paidMonths} รอบ · เสนอรายปี` });
  return out;
}
