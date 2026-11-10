export type Period = "30d" | "quarter" | "12m";
export interface Business {
  computedAt: string;
  period?: Period;
  cashThisMonth?: { month: string; receivedSatang: number; invoices: number };
  mrrSatang: number;
  payingWorkspaces: number;
  arpaSatang: number;
  margin: {
    marginPct: number | null;
    revenueSatang: number;
    costSatang: number;
    infraMonth: string | null;
    infraSatang: number;
    byPlan: { plan: string; customers: number; revenueSatang: number; costSatang: number; marginPct: number | null }[];
    breakdown?: { lineSatang: number; emailSatang: number; storageSatang: number; paymentFeesSatang: number; infraSatang: number };
  };
  customers: {
    top: CustomerProfit[];
    unprofitable: CustomerProfit[];
  };
  funnel: { windowDays: number; signups: number; emailVerified: number; firstProject: number; secondMember: number; activated: number; paid: number };
  trialConversion: { ended: number; converted: number; pct: number | null };
  cohorts: { month: string; customers: number; retention: (number | null)[] }[];
  channels: { source: string; signups?: number; conversionPct?: number | null; newPaying: number; spendSatang: number; cacSatang: number | null; paybackMonths: number | null }[];
  ltvSatang: number | null;
  monthlyRevenueChurnPct: number;
  cancellationReasons: { reason: string; n: number; kept: number }[];
  featureAdoption: { feature: string; workspaces: number; pct: number | null }[];
  upgradeReady: { workspace: { id: string; slug: string; name: string }; plan: string; signals: { code: string; message: string }[] }[];
  arAging: { d0_30: number; d31_60: number; d60plus: number; notDue: number };
  deferredRevenueSatang: number;
  forecast: { month: string; mrrSatang: number }[];
}
export interface CustomerProfit {
  workspace: { id: string; slug?: string; name?: string };
  plan: string;
  revenueSatang: number;
  costSatang: number;
  grossSatang: number;
  marginPct: number | null;
}

export const RESOURCES = ["line_message", "email", "storage_gb_month", "payment_fee_promptpay", "payment_fee_card", "etax_doc", "slip_check"] as const;
export type Resource = (typeof RESOURCES)[number];
export interface Rate {
  resource: Resource;
  unitCostSatang: string | number | null;
  pct: string | number | null;
  effectiveFrom: string;
}
export interface Costs {
  rates: { resource: Resource; kind: "pct" | "unit"; current: Rate | null; scheduled: Rate[]; history: Rate[] }[];
  infra: { month: string; category: "aws" | "tools" | "other"; amountSatang: number }[];
  allocation: string;
}
export interface Marketing {
  month: string;
  items: { source: string; amountSatang: number; note: string | null }[];
  sources: string[];
  totalSatang: number;
}

/** ค่าที่กรอกในช่อง: % หรือบาทต่อหน่วย (API เก็บเป็นสตางค์ ทศนิยมได้) */
export const rateInput = (r: Rate | null, kind: "pct" | "unit") => (!r ? "" : kind === "pct" ? String(Number(r.pct)) : String(Number(r.unitCostSatang) / 100));
export const thisMonth = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
