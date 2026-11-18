"use client";

import { useTranslations } from "next-intl";
import type { FilterDef } from "@/components/filters";
import { useSupportStaff } from "@/lib/staff-options";
import { planLabel } from "./format";

const PLANS = ["free", "team_s", "team_m", "team_l", "enterprise"] as const;
const FEATURES = ["line", "webhook", "github", "api_token", "automation", "import", "no_project"] as const;

/** ตัวกรองหน้า Workspaces (ช่วง 3) · คีย์ตรงกับ ops-api › workspaces/bulk-filter · MRR เฉพาะคนที่เห็นเงิน */
export function useWorkspaceFilters(money: boolean): FilterDef[] {
  const t = useTranslations("customers.list.f");
  const tf = useTranslations("customers.list.features");
  const staff = useSupportStaff();
  const opts = <T extends string>(key: string, values: readonly T[]) => values.map((v) => ({ value: v, label: t(`${key}.${v}` as "health.low") }));
  return [
    { key: "plan", label: t("plan"), kind: "multi", options: PLANS.map((p) => ({ value: p, label: planLabel(p) })) },
    { key: "feature", label: t("feature"), kind: "single", options: FEATURES.map((x) => ({ value: x, label: tf(x) })) },
    { key: "health", label: t("healthLabel"), kind: "multi", options: opts("health", ["low", "mid", "high"]) },
    { key: "seats", label: t("seatsLabel"), kind: "single", options: opts("seats", ["near", "full", "under"]) },
    { key: "activity", label: t("activityLabel"), kind: "single", options: opts("activity", ["active7", "idle14", "idle30"]) },
    { key: "trialEnds", label: t("trialEnds"), kind: "single", options: ["3", "7", "14"].map((d) => ({ value: d, label: t("days", { n: d }) })) },
    { key: "overdueDays", label: t("overdueDays"), kind: "single", options: ["7", "30", "60"].map((d) => ({ value: d, label: t("moreThan", { n: d }) })) },
    { key: "cycle", label: t("cycleLabel"), kind: "single", options: opts("cycle", ["monthly", "yearly"]) },
    { key: "created", label: t("created"), kind: "dates", presetKey: "created", presets: ["7", "30", "90"].map((d) => ({ value: d, label: t("lastDays", { n: d }) })), fromKey: "createdFrom", toKey: "createdTo" },
    { key: "source", label: t("source"), kind: "text", placeholder: t("sourceHint") },
    { key: "manager", label: t("manager"), kind: "single", options: [{ value: "none", label: t("noManager") }, ...staff] },
    { key: "tickets", label: t("ticketsLabel"), kind: "single", options: opts("tickets", ["open", "none"]) },
    ...(money ? [{ key: "mrr", label: t("mrr"), kind: "range" as const, minKey: "mrrMin", maxKey: "mrrMax", unit: "baht" as const }] : []),
  ];
}
