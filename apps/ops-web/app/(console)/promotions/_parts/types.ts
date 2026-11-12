"use client";

import { useTranslations } from "next-intl";
import type { Tone } from "@/components/ui";
import { useFmt } from "../../workspaces/_parts/format";

/** รูปแบบตาม ops-api › promotions (O20) · เงินเป็นสตางค์ */
export type PlanCode = "free" | "team_s" | "team_m" | "team_l" | "enterprise";
export type CouponKind = "percent" | "amount" | "free_months";
export type CouponDuration = "once" | "repeating" | "forever";
export type CouponState = "draft" | "active" | "disabled" | "expired" | "exhausted";

export interface PlanRow {
  code: PlanCode;
  name: string;
  defaultName: string;
  monthlySatang: number | null;
  yearlySatang: number | null;
  yearlyCustom: boolean;
  yearlyMonths: number;
  listed: boolean;
  openForSignup: boolean;
  seatLimit: number | null;
  storageGbPerMember: number | null;
  projects: number | null;
  customers: number;
  grandfathered: number;
  version: number | null;
  priceEditable: boolean;
}

export interface Coupon {
  id: string;
  code: string;
  description: string | null;
  kind: CouponKind;
  value: number;
  duration: CouponDuration;
  durationCycles: number | null;
  planCodes: string[];
  maxRedemptions: number | null;
  expiresOn: string | null;
  newCustomersOnly: boolean;
  stackable: boolean;
  status: "draft" | "active" | "disabled";
  state: CouponState;
  used: number;
  pending: number;
  discountGivenSatang: number;
  retention: { ended: number; eligible: number; kept: number; rate: number | null };
  createdAt: string;
  createdBy: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
  disableReason: string | null;
  pendingApproval: boolean;
}

export interface Overview {
  plans: PlanRow[];
  pendingPrices: { id: string; plan: string; requestedBy: string; createdAt: string; reason: string; monthlySatang: number | null; yearlySatang: number | null }[];
  coupons: Coupon[];
  summary: { activeCoupons: number; discountThisMonthSatang: number };
}

export type ChangeField = "name" | "monthly" | "yearly" | "listed" | "openForSignup";
export interface PriceVersion {
  id: string;
  plan: string;
  planName: string;
  version: number;
  displayName: string | null;
  monthlySatang: number | null;
  yearlySatang: number | null;
  listed: boolean;
  openForSignup: boolean;
  existingPolicy: "grandfather" | "next_cycle";
  existingFrom: string | null;
  effectiveAt: string;
  reason: string;
  createdBy: string | null;
  approvedBy: string | null;
  status: "current" | "past";
  changes: { field: ChangeField; from: string | number | boolean | null; to: string | number | boolean | null }[];
}

export interface Redemption {
  workspace: { id: string; name: string; slug: string };
  status: "pending" | "active" | "ended";
  cyclesTotal: number | null;
  cyclesUsed: number;
  discountSatang: number;
  createdAt: string;
  endedAt: string | null;
  keptPaying: boolean | null;
}

export const PROMO_KEY = ["ops", "promotions"] as const;
/** แพ็กเกจที่คูปองใช้ได้ (Free ไม่มีราคาให้ลด) */
export const COUPON_PLANS = ["team_s", "team_m", "team_l", "enterprise"] as const;
export const PLAN_NAME: Record<string, string> = { free: "Free", team_s: "Team S", team_m: "Team M", team_l: "Team L", enterprise: "Enterprise" };
export const STATE_TONE: Record<CouponState, Tone> = { draft: "warn", active: "ok", disabled: "neu", expired: "neu", exhausted: "neu" };

/** บาทที่พิมพ์ (มีจุลภาคได้) → สตางค์ · ว่าง = null · พิมพ์ผิด = NaN */
export function bahtToSatang(raw: string): number | null {
  const s = raw.replace(/[,\s฿]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}
export const satangToBaht = (n: number | null | undefined) => (n == null ? "" : String(n / 100));

/** ข้อความของคูปอง (ตาราง · ตัวอย่างที่ลูกค้าเห็น) */
export function useCouponText() {
  const t = useTranslations("promo");
  const fmt = useFmt();
  const off = (c: Pick<Coupon, "kind" | "value">) => (c.kind === "amount" ? fmt.money(c.value) : t(`off.${c.kind}`, { value: c.value }));
  const duration = (c: Pick<Coupon, "kind" | "duration" | "durationCycles">) =>
    c.kind === "free_months" ? t("dur.once") : c.duration === "repeating" ? t("dur.repeating", { count: c.durationCycles ?? 1 }) : t(`dur.${c.duration}`);
  const durationCell = (c: Pick<Coupon, "kind" | "value" | "duration" | "durationCycles">) => (c.kind === "free_months" ? t("dur.months", { count: c.value }) : duration(c));
  const plans = (codes: string[]) => {
    const team = ["team_s", "team_m", "team_l"];
    if (codes.length === 3 && team.every((c) => codes.includes(c))) return t("coupons.allTeam");
    return codes.map((c) => PLAN_NAME[c] ?? c).join(", ");
  };
  /** วันที่ YYYY-MM-DD เป็นวันไทย (ไม่ให้เลื่อนวันตามโซนเวลาเครื่อง) */
  const day = (d: string) => fmt.date(`${d}T12:00:00+07:00`);
  const preview = (c: Pick<Coupon, "kind" | "value" | "duration" | "durationCycles" | "expiresOn">) => {
    const main =
      c.kind === "free_months"
        ? t("preview.free", { count: c.value })
        : c.duration === "repeating"
          ? t("preview.repeating", { off: off(c), count: c.durationCycles ?? 1 })
          : t(`preview.${c.duration}`, { off: off(c) });
    return c.expiresOn ? main + t("preview.until", { date: day(c.expiresOn) }) : main;
  };
  return { off, duration, durationCell, plans, preview, day };
}
