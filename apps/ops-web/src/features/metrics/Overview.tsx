"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonClass, EmptyState, ErrorState, LoadingState, Pill, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBaht, formatNumber } from "@/lib/format";
import { keys } from "@/lib/query";
import { can } from "@/lib/roles";
import { PLAN_CODES, type Metrics } from "@/lib/types";
import { PageHeader, useStaff } from "../shell/Shell";

export function Overview() {
  const t = useTranslations("ops");
  const staff = useStaff();
  const q = useQuery({ queryKey: keys.metrics, queryFn: () => api.get<Metrics>("/metrics") });
  return (
    <>
      <PageHeader title={t("titles.overview")} desc={t("titles.overviewDesc")} />
      {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : <Body m={q.data} finance={can(staff?.role, "finance")} />}
    </>
  );
}

function Body({ m, finance }: { m: Metrics; finance: boolean }) {
  const t = useTranslations("ops");
  const byPlan = PLAN_CODES.filter((p) => p !== "free" && m.byPlan[p])
    .map((p) => `${t(`plansShort.${p}`)} ${m.byPlan[p]}`)
    .join(" · ");
  const todo: { k: string; tone: Tone; text: string; href: string; b: string }[] = [];
  if (m.pendingPayments && finance) todo.push({ k: t("metrics.kPay"), tone: "warn", text: t("metrics.tPay", { count: m.pendingPayments }), href: "/payments", b: t("metrics.bPay") });
  if (m.pastDue) todo.push({ k: t("metrics.kPastDue"), tone: "bad", text: t("metrics.tPastDue", { count: m.pastDue }), href: "/workspaces?status=past_due", b: t("metrics.bList") });
  if (m.trialExpired) todo.push({ k: t("metrics.kTrial"), tone: "inf", text: t("metrics.tTrial", { count: m.trialExpired }), href: "/workspaces?status=trialing", b: t("metrics.bList") });
  if (m.suspended) todo.push({ k: t("metrics.kSuspended"), tone: "neu", text: t("metrics.tSuspended", { count: m.suspended }), href: "/workspaces?status=suspended", b: t("metrics.bList") });

  return (
    <>
      <div className="kpis">
        <div className="kp">
          <span className="muted small-13">{t("metrics.mrr")}</span>
          <b>{formatBaht(m.mrr)}</b>
          <span className="small ok-text">{t("metrics.paid30", { amount: formatBaht(m.paidLast30Days) })}</span>
        </div>
        <div className="kp">
          <span className="muted small-13">{t("metrics.paying")}</span>
          <b>{formatNumber(m.payingWorkspaces)}</b>
          <span className="muted small">{byPlan || t("ui.none")}</span>
        </div>
        <div className="kp">
          <span className="muted small-13">{t("metrics.trialing")}</span>
          <b>{formatNumber(m.trialing)}</b>
          <span className="muted small">{t("metrics.trialExpired", { count: m.trialExpired })}</span>
        </div>
        <div className="kp">
          <span className="muted small-13">{t("metrics.canceled")}</span>
          <b>{formatNumber(m.canceledLast30Days)}</b>
          <span className="muted small">{t("metrics.totals", { count: m.workspaces, fresh: m.newWorkspacesLast30Days })}</span>
        </div>
        <div className="kp kp-warn">
          <span className="muted small-13">{t("metrics.pending")}</span>
          <b className="warn-text">{formatNumber(m.pendingPayments)}</b>
          <span className="muted small">{t("metrics.pastDue", { count: m.pastDue })}</span>
        </div>
      </div>
      <div className="muted small">{t("metrics.note")}</div>
      <section className="card">
        <div className="ch">
          <h2>{t("metrics.todo")}</h2>
        </div>
        {todo.length === 0 ? (
          <EmptyState title={t("metrics.todoEmpty")} description={t("metrics.todoEmptyDesc")} />
        ) : (
          todo.map((x) => (
            <div className="pr" key={x.href}>
              <Pill tone={x.tone}>{x.k}</Pill>
              <span className="grow-300">{x.text}</span>
              <Link className={buttonClass()} href={x.href}>
                {x.b}
              </Link>
            </div>
          ))
        )}
      </section>
    </>
  );
}
