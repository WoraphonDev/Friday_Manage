"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { EmptyState, ErrorState, LoadingState, Pill, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { daysLeft, formatDate } from "@/lib/format";
import { keys } from "@/lib/query";
import { PLAN_CODES, type WorkspaceRow } from "@/lib/types";
import { PageHeader } from "../shell/Shell";
import { WorkspaceDetailPanel } from "./WorkspaceDetail";

const STATUS_FILTERS = ["trial", "active", "suspended", "pending_delete", "trialing", "past_due", "canceled"] as const;
const COLORS = ["#0F766E", "#7C3AED", "#B45309", "#1D4ED8", "#BE185D", "#334155"];

/** สถานะที่ทีมต้องเห็นก่อน: ระงับ / รอลบ ของ Workspace มาก่อนสถานะของแพ็กเกจ */
export function useWorkspaceStatus() {
  const t = useTranslations("ops.ws.st");
  return (ws: { status: WorkspaceRow["status"] }, sub: { status: string | null; trialEndsAt: string | null } | null): { label: string; tone: Tone } => {
    if (ws.status === "suspended") return { label: t("suspended"), tone: "bad" };
    if (ws.status === "pending_delete") return { label: t("pendingDelete"), tone: "bad" };
    if (sub?.status === "trialing") {
      const days = daysLeft(sub.trialEndsAt) ?? 0;
      return days > 0 ? { label: t("trialing", { days }), tone: "inf" } : { label: t("trialEnded"), tone: "warn" };
    }
    if (sub?.status === "past_due") return { label: t("pastDue"), tone: "bad" };
    if (sub?.status === "canceled") return { label: t("canceled"), tone: "neu" };
    return { label: t("active"), tone: "ok" };
  };
}

export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => Array.from(p)[0] ?? "")
    .join("")
    .toUpperCase();
const colorOf = (id: string) => COLORS[Array.from(id).reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length];

export function Workspaces() {
  const t = useTranslations("ops");
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState(params.get("plan") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [selected, setSelected] = useState<string | null>(params.get("id"));
  const search = useDeferredValue(q.trim());
  const filter = { ...(search ? { q: search } : {}), ...(plan ? { plan } : {}), ...(status ? { status } : {}) };
  const list = useQuery({ queryKey: keys.workspaces(filter), queryFn: () => api.get<{ items: WorkspaceRow[] }>(`/workspaces?${new URLSearchParams(filter)}`) });
  const statusOf = useWorkspaceStatus();

  return (
    <>
      <PageHeader title={t("titles.workspaces")} desc={t("titles.workspacesDesc")} />
      <div className="split">
        <section className="card list-card">
          <div className="ch">
            <input className="input search" type="search" placeholder={t("ws.search")} aria-label={t("ws.searchLabel")} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="row-6">
              <select className="input select auto" aria-label={t("ws.plan")} value={plan} onChange={(e) => setPlan(e.target.value)}>
                <option value="">{t("ws.allPlans")}</option>
                {PLAN_CODES.map((p) => (
                  <option key={p} value={p}>
                    {t(`plans.${p}`)}
                  </option>
                ))}
              </select>
              <select className="input select auto" aria-label={t("ws.status")} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">{t("ws.allStatus")}</option>
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {t(`ws.filters.${s}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="tr h" aria-hidden="true">
            <span>{t("ws.colWorkspace")}</span>
            <span>{t("ws.colPlan")}</span>
            <span className="hs">{t("ws.colMembers")}</span>
            <span className="hs">{t("ws.colProjects")}</span>
            <span className="hs">{t("ws.colCreated")}</span>
            <span className="hs">{t("ws.colStatus")}</span>
          </div>
          {list.isPending ? (
            <LoadingState />
          ) : list.error ? (
            <ErrorState error={list.error} retry={() => void list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <EmptyState title={t("ws.empty")} description={t("ws.emptyDesc")} />
          ) : (
            list.data.items.map((w) => {
              const st = statusOf(w, { status: w.subStatus, trialEndsAt: w.trialEndsAt });
              return (
                <button key={w.id} type="button" className={selected === w.id ? "tr on" : "tr"} aria-current={selected === w.id ? "true" : undefined} onClick={() => setSelected(w.id)}>
                  <span className="ws-cell">
                    <span className="ws-mark" style={{ background: colorOf(w.id) }} aria-hidden="true">
                      {initialsOf(w.name)}
                    </span>
                    <span className="min0">
                      <b className="ellipsis">{w.name}</b>
                      <span className="muted mono">{w.slug}</span>
                    </span>
                  </span>
                  <span>{w.plan ? t(`plans.${w.plan}`) : t("plans.none")}</span>
                  <span className="hs">{w.seats}</span>
                  <span className="hs">{w.projects}</span>
                  <span className="hs muted">{formatDate(w.createdAt)}</span>
                  <span className="hs">
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </span>
                </button>
              );
            })
          )}
        </section>
        <section className="card detail-card" aria-label={t("ws.detailLabel")}>
          {selected ? <WorkspaceDetailPanel id={selected} /> : <EmptyState title={t("ws.pick")} />}
        </section>
      </div>
    </>
  );
}
