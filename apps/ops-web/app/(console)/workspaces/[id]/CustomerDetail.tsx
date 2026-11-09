"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Headphones } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny, initials } from "@/components/access";
import { ConfirmDialog, useApprovalFlow } from "@/components/dialogs";
import { ErrorBlock, Notice, Tabs } from "@/components/kit";
import { Button, LoadingState, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { DiscountDialog, EnterDialog, PlanDialog, RequestAccessDialog, SuspendDialog, TransferDialog, TrialDialog } from "../_parts/Actions";
import { healthTone, planLabel, useFmt } from "../_parts/format";
import { AuditPanel, BillingPanel, IntegrationsPanel, MembersPanel, OverviewPanel, ProjectsPanel, SecurityPanel, SupportPanel, UsagePanel, useMembers } from "../_parts/Panels";
import type { Overview } from "../_parts/types";

type Tab = "overview" | "usage" | "projects" | "users" | "integrations" | "security" | "billing" | "support" | "audit";
type Dialog = "enter" | "request" | "discount" | "plan" | "trial" | "suspend" | "resume" | "transfer" | null;

/** หน้า 3 · รายละเอียดลูกค้า 9 แท็บ (CustomerDetail.dc.html) */
export function CustomerDetail({ id }: { id: string }) {
  const t = useTranslations("customers");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const me = useMe().data;
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<Dialog>(null);
  const q = useQuery({ queryKey: ["ops", "workspace", id], queryFn: () => api.get<Overview>(`/workspaces/${id}`) });
  const members = useMembers(id);
  const refresh = () => void cache.invalidateQueries({ queryKey: ["ops"] });
  const close = () => setDialog(null);
  const after = (message: string) => (r: unknown) => {
    close();
    if ((r as { pendingApproval?: unknown })?.pendingApproval) handle(r);
    else toast(message);
    refresh();
    return r;
  };

  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const ws = q.data;
  const sub = ws.subscription;
  const owner = ws.owners.find((o) => o.role === "owner");
  const can = {
    enter: hasAny(me, "support"),
    finance: hasAny(me, "finance"),
    trial: hasAny(me, "support") && sub?.status === "trialing",
    suspend: hasAny(me, "owner", "finance"),
    transfer: hasAny(me, "owner", "support"),
  };
  const discountText = sub?.discount?.percent != null ? `${sub.discount.percent}%` : "—";

  return (
    <>
      <Link href="/workspaces" className="row small" style={{ textDecoration: "none" }}>
        <ArrowLeft size={14} /> {t("detail.back")}
      </Link>
      <section className="card">
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }} aria-hidden="true">
            {initials(ws.name)}
          </span>
          <div className="stack" style={{ gap: 6, flex: "1 1 320px" }}>
            <div className="row">
              <h1 className="page-title">{ws.name}</h1>
              <span className="pill inf">{planLabel(sub?.plan)}</span>
              <span className={ws.status === "suspended" ? "pill bad" : sub?.status === "past_due" ? "pill warn" : "pill ok"}>
                {ws.status === "suspended" ? t("wsStatus.suspended") : t(`subStatus.${(sub?.status as "active") ?? "none"}`)}
                {sub?.cycle ? ` · ${t(`cycle.${sub.cycle as "monthly"}`)}` : ""}
              </span>
              <span className={`pill ${healthTone(ws.health.score)}`}>{t("detail.health", { score: ws.health.score })}</span>
            </div>
            <div className="muted small row">
              <span className="mono">{ws.slug}</span>
              {owner?.email && <span>· {t("detail.owner", { email: owner.email })}</span>}
              <span>· {t("detail.since", { date: fmt.date(ws.createdAt) })}</span>
              <span>· {t("detail.region", { region: t("detail.regionTh") })}</span>
              {ws.legalName && <span>· {ws.legalName}</span>}
            </div>
          </div>
          <div className="page-actions">
            {can.enter && (
              <Button variant="primary" onClick={() => setDialog(ws.supportAccess?.active ? "enter" : "request")}>
                <Headphones size={16} /> {t("detail.actions.enter")}
              </Button>
            )}
            {can.finance && <Button onClick={() => setDialog("discount")}>{t("detail.actions.discount")}</Button>}
            {can.finance && <Button onClick={() => setDialog("plan")}>{t("detail.actions.plan")}</Button>}
            {can.trial && <Button onClick={() => setDialog("trial")}>{t("detail.actions.trial")}</Button>}
            {can.suspend &&
              (ws.status === "suspended" ? (
                <Button onClick={() => setDialog("resume")}>{t("detail.actions.resume")}</Button>
              ) : (
                <Button variant="danger" onClick={() => setDialog("suspend")}>
                  {t("detail.actions.suspend")}
                </Button>
              ))}
          </div>
        </div>
        {ws.supportAccess?.active ? (
          <Notice tone="info">{t("detail.access", { until: ws.supportAccess.until ? fmt.date(ws.supportAccess.until) : t("detail.accessForever") })}</Notice>
        ) : (
          <Notice tone="warn">{t("detail.noAccess")}</Notice>
        )}
      </section>

      <Tabs
        label={ws.name}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: t("detail.tabs.overview") },
          { value: "usage", label: t("detail.tabs.usage") },
          { value: "projects", label: t("detail.tabs.projects", { n: ws.usage.projects }) },
          { value: "users", label: t("detail.tabs.users", { n: ws.usage.members + ws.usage.guests }) },
          { value: "integrations", label: t("detail.tabs.integrations") },
          { value: "security", label: t("detail.tabs.security") },
          ...(hasAny(me, "owner", "finance", "support", "auditor") ? [{ value: "billing" as const, label: t("detail.tabs.billing") }] : []),
          { value: "support", label: t("detail.tabs.support") },
          ...(hasAny(me, "owner", "finance", "support", "auditor") ? [{ value: "audit" as const, label: t("detail.tabs.audit") }] : []),
        ]}
      />
      <div role="tabpanel" aria-label={t(`detail.tabs.${tab}` as "detail.tabs.overview", { n: "" })}>
        {tab === "overview" && <OverviewPanel ws={ws} />}
        {tab === "usage" && <UsagePanel id={id} />}
        {tab === "projects" && <ProjectsPanel id={id} />}
        {tab === "users" && <MembersPanel id={id} guests={ws.usage.guests} onTransfer={can.transfer ? () => setDialog("transfer") : undefined} />}
        {tab === "integrations" && <IntegrationsPanel id={id} />}
        {tab === "security" && <SecurityPanel id={id} />}
        {tab === "billing" && <BillingPanel id={id} />}
        {tab === "support" && <SupportPanel id={id} />}
        {tab === "audit" && <AuditPanel id={id} />}
      </div>

      {dialog === "enter" && <EnterDialog ws={ws} onOpenChange={close} onRequest={() => setDialog("request")} onDone={(n) => (close(), toast(t("c1.done", { n })), refresh())} />}
      {dialog === "request" && <RequestAccessDialog ws={ws} onOpenChange={close} onDone={(n) => (close(), toast(t("c2.done", { n })))} />}
      {dialog === "discount" && (
        <DiscountDialog
          names={[ws.name]}
          context={sub ? (sub.discount ? t("c3.current", { plan: planLabel(sub.plan), cycle: t(`cycle.${sub.cycle as "monthly"}`), discount: discountText }) : t("c3.noCurrent", { plan: planLabel(sub.plan), cycle: t(`cycle.${sub.cycle as "monthly"}`) })) : undefined}
          onOpenChange={close}
          submit={(body) => api.post(`/workspaces/${id}/discount`, body).then(after(t("c3.done", { pct: body.percent })))}
        />
      )}
      {dialog === "plan" && <PlanDialog ws={ws} onOpenChange={close} onDone={(plan) => after(t("c4.done", { plan: planLabel(plan) }))(null)} />}
      {dialog === "trial" && (
        <TrialDialog
          names={[ws.name]}
          trialEndsAt={sub?.trialEndsAt}
          context={t("c5.current", { plan: planLabel(sub?.plan), date: fmt.date(sub?.trialEndsAt) })}
          onOpenChange={close}
          submit={(body) => api.post(`/workspaces/${id}/extend-trial`, body).then(after(t("c5.done", { name: ws.name })))}
        />
      )}
      {dialog === "suspend" && <SuspendDialog ws={ws} canPolicy={hasAny(me, "finance")} onOpenChange={close} submit={(body) => api.post(`/workspaces/${id}/suspend`, body).then(after(t("c6.done", { name: ws.name })))} />}
      {dialog === "resume" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={t("c6.resumeTitle", { name: ws.name })}
          onConfirm={({ reason }) => api.post(`/workspaces/${id}/resume`, { reason }).then(after(t("c6.resumed", { name: ws.name })))}
        />
      )}
      {dialog === "transfer" && members.data && <TransferDialog ws={ws} members={members.data.items} onOpenChange={close} onDone={after("")} />}
    </>
  );
}
