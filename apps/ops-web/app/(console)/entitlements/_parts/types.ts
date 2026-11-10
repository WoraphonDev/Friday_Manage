// รูปข้อมูลจาก ops-api `GET ops/entitlements` (O21)
import { useTranslations } from "next-intl";
import { useFmt } from "../../workspaces/_parts/format";

export type PlanCode = "free" | "team_s" | "team_m" | "team_l" | "enterprise";
export type Value = number | boolean | null;
export type Matrix = Record<PlanCode, Record<string, Value>>;
export interface Key {
  key: string;
  kind: "limit" | "feature";
  unit?: "count" | "gb_per_member" | "per_month" | "per_minute" | "days";
  enforced: boolean;
}
export type OverrideKey = "seats" | "storage_gb" | "api_rpm" | "automation_runs" | "sso";
export interface Change {
  plan: PlanCode;
  key: string;
  from: Value;
  to: Value;
  reduced: boolean;
}
export interface Override {
  id: string;
  workspace: { id: string; name: string; slug: string; plan: PlanCode | null };
  key: OverrideKey;
  base: Value;
  value: Value;
  expiresAt: string | null;
  contractRef: string | null;
  reason: string;
  createdBy: string;
  approvedBy: string | null;
  status: "active" | "expiring" | "expired" | "contract";
}
export interface Near {
  workspace: { id: string; name: string; slug: string };
  plan: PlanCode;
  key: "seats" | "projects" | "storage";
  used: number;
  limit: number;
  ratio: number;
  etaDays: number | null;
  referredAt: string | null;
}
export interface Overview {
  keys: Key[];
  overrideKeys: OverrideKey[];
  plans: { code: PlanCode; name: string; customers: number }[];
  current: { version: number; effectiveAt: string | null; matrix: Matrix; reason: string | null; createdBy: string | null; approvedBy: string | null };
  scheduled: { version: number; effectiveAt: string; reason: string }[];
  pending: { id: string; reason: string; createdAt: string; requestedBy: string; effectiveAt: string | null }[];
  overrides: Override[];
  nearLimit: Near[];
}
export interface HistoryItem {
  version: number;
  effectiveAt: string;
  reason: string;
  restoredFrom: number | null;
  createdBy: string | null;
  approvedBy: string | null;
  status: "current" | "scheduled" | "past";
  changes: Change[];
}

export const PLANS: PlanCode[] = ["free", "team_s", "team_m", "team_l", "enterprise"];
export const PLAN_NAME: Record<PlanCode, string> = { free: "Free", team_s: "Team S", team_m: "Team M", team_l: "Team L", enterprise: "Enterprise" };
/** Enterprise ที่ไม่จำกัดในคีย์เหล่านี้ = กำหนดในสัญญา (Canvas › "ตามสัญญา") */
const CONTRACT_KEYS = new Set(["seats", "storage_gb_per_member", "history_days"]);

/** แสดงค่าในตาราง · `unitOf` บอกหน่วยของคีย์ */
export function useShow() {
  const t = useTranslations("ent");
  const fmt = useFmt();
  return (key: string, v: Value, opts: { plan?: PlanCode; unit?: Key["unit"] | "gb" } = {}) => {
    if (typeof v === "boolean") return v ? t("matrix.yes") : t("matrix.no");
    if (v === null) return opts.plan === "enterprise" && CONTRACT_KEYS.has(key) ? t("matrix.contract") : t("matrix.unlimited");
    // API ต่อนาที 0 = ใช้ API ไม่ได้
    if (v === 0 && key === "api_rpm") return t("matrix.no");
    const unit = opts.unit ?? (key === "storage_gb" ? "gb" : "count");
    return t(`units.${unit}` as "units.count", { value: fmt.num(v) });
  };
}
