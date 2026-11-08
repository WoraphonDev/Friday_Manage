// รูปแบบข้อมูลจาก API จริง (A29 billing, A30 public) · เงินเป็นสตางค์ทั้งหมด

export type PlanCode = "free" | "team_s" | "team_m" | "team_l" | "enterprise";
export type PaidPlan = "team_s" | "team_m" | "team_l";
export type Cycle = "monthly" | "yearly";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";
export type LimitKind = "projects" | "seats" | "storage_bytes";

interface Meter {
  used: number;
  limit: number | null;
  ratio: number;
  over: boolean;
}

/** `GET w/{ws}/usage` */
export interface Usage {
  plan: { code: PlanCode; name: string };
  status: SubscriptionStatus;
  trial: { endsAt: string; daysLeft: number; expired: boolean } | null;
  seats: Meter;
  projects: Meter;
  storage: Meter & { usedGb: number; limitGb: number | null };
  canManageBilling: boolean;
}

/** `GET public/plans` */
export interface PublicPlan {
  code: PlanCode;
  name: string;
  seatLimit: number | null;
  guestsFree: boolean;
  projectLimit: number | null;
  storageGbPerMember: number | null;
  priceMonthlySatang: number | null;
  priceYearlySatang: number | null;
  contactSales: boolean;
  features: string[];
}
export interface PublicPlans {
  currency: "THB";
  vatRate: number;
  vatIncluded: boolean;
  trialDays: number;
  yearlyMonths: number;
  items: PublicPlan[];
}

/** `details` ของ 402 `plan_limit_reached` */
export interface PlanLimitDetails {
  kind?: LimitKind;
  limit?: number;
  current?: number;
  increment?: number;
  plan?: PlanCode;
  suggestedPlan?: PlanCode | null;
  exits?: string[];
}

export const PAID_PLANS: PaidPlan[] = ["team_s", "team_m", "team_l"];
export const isPaidPlan = (code: unknown): code is PaidPlan =>
  PAID_PLANS.includes(code as PaidPlan);

/** แพ็กเกจเล็กที่สุดที่รองรับจำนวนคนนี้ (ไม่มี → Enterprise) · ลำดับตาม API */
export function fitPlan(plans: PublicPlan[], people: number): PublicPlan | undefined {
  return plans.find((p) => p.seatLimit === null || p.seatLimit >= people);
}

const GB = 1024 ** 3;
export const bytesToGb = (bytes: number) => Math.round((bytes / GB) * 100) / 100;

/** สตางค์ → "3,210" หรือ "3,210.50" */
export function baht(satang: number) {
  return new Intl.NumberFormat("th-TH", {
    minimumFractionDigits: satang % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(satang / 100);
}

/** ลิงก์ไปหน้าชำระเงินพร้อมแพ็กเกจที่แนะนำ */
export function checkoutHref(ws: string, plan?: PlanCode | null) {
  const base = `/work/${encodeURIComponent(ws)}/billing/checkout`;
  return isPaidPlan(plan) ? `${base}?plan=${plan}` : base;
}
