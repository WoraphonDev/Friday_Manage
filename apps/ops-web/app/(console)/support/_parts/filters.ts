"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { hasAny } from "@/components/access";
import type { FilterDef } from "@/components/filters";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useSupportStaff } from "@/lib/staff-options";
import { CATEGORIES, PRIORITIES } from "../settings/_parts/types";
import { planLabel } from "../../workspaces/_parts/format";

export const TICKET_SORTS = ["sla", "newest", "waiting", "priority"] as const;
const PLANS = ["free", "team_s", "team_m", "team_l", "enterprise"] as const;

/** เหตุขัดข้องที่ยังไม่ปิด (ตัวเลือกตัวกรอง "ผูกกับเหตุขัดข้อง") */
export function useOpenIncidents() {
  const me = useMe().data;
  const q = useQuery({
    queryKey: ["ops", "incidents", "open-options"],
    queryFn: () => api.get<{ items: { id: string; title: string; status: string }[] }>("/incidents"),
    enabled: hasAny(me, "support", "owner", "engineer"),
    staleTime: 60_000,
  });
  return (q.data?.items ?? []).filter((i) => i.status !== "resolved");
}

/** ตัวกรองหน้า Ticket (ช่วง 3) · คีย์ตรงกับ ops-api › support/tickets.service TicketsQuery */
export function useTicketFilters(): FilterDef[] {
  const t = useTranslations("ss.support.f");
  const ts = useTranslations("ss.support");
  const tc = useTranslations("sset.category");
  const staff = useSupportStaff();
  const incidents = useOpenIncidents();
  return [
    { key: "priority", label: t("priority"), kind: "multi", options: PRIORITIES.map((p) => ({ value: p, label: ts(`priority.${p}`) })) },
    { key: "sla", label: t("slaLabel"), kind: "single", options: (["breached", "soon", "today"] as const).map((v) => ({ value: v, label: t(`sla.${v}`) })) },
    { key: "category", label: t("category"), kind: "multi", options: CATEGORIES.map((c) => ({ value: c, label: tc(c) })) },
    { key: "channel", label: t("channel"), kind: "multi", options: (["email", "phone", "line", "in_app"] as const).map((c) => ({ value: c, label: ts(`channel.${c}`) })) },
    { key: "assignees", label: t("assignees"), kind: "multi", options: staff },
    { key: "plan", label: t("plan"), kind: "multi", options: PLANS.map((p) => ({ value: p, label: planLabel(p) })) },
    { key: "created", label: t("created"), kind: "dates", presetKey: "created", presets: ["1", "7", "30"].map((d) => ({ value: d, label: d === "1" ? t("today") : t("lastDays", { n: d }) })), fromKey: "createdFrom", toKey: "createdTo" },
    { key: "quiet", label: t("quietLabel"), kind: "single", options: (["24", "72", "168"] as const).map((h) => ({ value: h, label: t(`quiet.${h}`) })) },
    { key: "incident", label: t("incident"), kind: "single", options: [{ value: "none", label: t("noIncident") }, ...incidents.map((i) => ({ value: i.id, label: i.title }))] },
    { key: "csat", label: t("csatLabel"), kind: "single", options: (["low", "high", "none"] as const).map((v) => ({ value: v, label: t(`csat.${v}`) })) },
  ];
}
