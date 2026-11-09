"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge, Button, EmptyState, ErrorState, Forbidden, LoadingState, buttonVariants, useToast, type Tone } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api } from "@/lib/api";
import { formatDate, today } from "@/lib/format";
import { cn } from "@/lib/utils";
import { baht, checkoutHref, type SubscriptionStatus, type Usage } from "@/features/plan-limits";
import { CancelSurvey } from "@/features/checkout/CancelSurvey";
import type { BillingOverview, Invoice, InvoiceStatus } from "./types";
import styles from "./billing.module.css";

const STATUS_TONE: Record<SubscriptionStatus, Tone> = { trialing: "amber", active: "green", past_due: "red", canceled: "neutral" };
const INVOICE_TONE: Record<InvoiceStatus, Tone> = { open: "amber", pending_review: "blue", paid: "green", void: "neutral" };

function Meter({ label, used, limit, value }: { label: string; used: number; limit: number | null; value: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className={styles.meterHead}>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      {limit !== null && (
        <div className={styles.bar}>
          <span className={cn(used > limit && styles.over)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** แพ็กเกจ & Billing ของ Workspace (Owner / Admin · `ws.billing`) */
export function BillingOverviewPage({ ws }: { ws: string }) {
  const t = useTranslations("saas-pages.billing");
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}`;
  const canBill = workspace.role === "owner" || workspace.role === "admin";
  const [cancelling, setCancelling] = useState(false);
  const [upload, setUpload] = useState<{ invoice: Invoice; kind: "slip" | "wht-certificate" } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const overview = useQuery({ queryKey: ["billing", ws], queryFn: () => api.get<BillingOverview>(`${base}/billing`), enabled: canBill });
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<Usage>(`${base}/usage`), enabled: canBill, retry: false });
  const invoices = useQuery({ queryKey: ["billing-invoices", ws], queryFn: () => api.get<{ items: Invoice[] }>(`${base}/billing/invoices`), enabled: canBill });

  if (!canBill) return <div className={styles.page}><Forbidden /></div>;
  if (overview.error)
    return <div className={styles.page}>{overview.error instanceof ApiError && overview.error.status === 403 ? <Forbidden /> : <ErrorState error={overview.error} retry={() => overview.refetch()} />}</div>;
  if (overview.isPending) return <div className={styles.page}><LoadingState /></div>;

  const o = overview.data;
  const sub = o.subscription;
  const u = usage.data;
  const trialDays = u?.trial && !u.trial.expired ? u.trial.daysLeft : null;
  const description =
    sub.status === "trialing"
      ? u?.trial?.expired
        ? t("trialExpired")
        : t("trialNote")
      : sub.status === "canceled"
        ? t("canceledNote", { date: formatDate(sub.currentPeriodEnd, "BE", true) })
        : sub.status === "past_due"
          ? t("pastDueNote")
          : t("activeNote", { date: formatDate(sub.currentPeriodEnd, "BE", true), cycle: sub.cycle === "yearly" ? t("yearly") : t("monthly") });
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["billing", ws] });
    await cache.invalidateQueries({ queryKey: ["billing-invoices", ws] });
    await cache.invalidateQueries({ queryKey: ["usage", ws] });
  };

  function pick(invoice: Invoice, kind: "slip" | "wht-certificate") {
    setUpload({ invoice, kind });
    fileInput.current?.click();
  }
  async function sendFile(file: File | undefined) {
    const target = upload;
    if (!file || !target) return;
    try {
      const body = new FormData();
      body.append("file", file);
      await api.request(`${base}/billing/invoices/${target.invoice.id}/${target.kind}`, { method: "POST", body });
      toast({ message: target.kind === "slip" ? t("slipSent", { number: target.invoice.number }) : t("whtSent", { number: target.invoice.number }) });
      await refresh();
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setUpload(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const now = today();
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>{t("title")}</h1>
          <div className={styles.muted}>{t("subtitle")}</div>
        </div>
        <Link className={buttonVariants()} href="/pricing">
          {t("compare")}
        </Link>
      </div>

      <section className={cn(styles.card, styles.planCard)} aria-label={t("planLabel")}>
        <div>
          <Badge tone={STATUS_TONE[sub.status]}>{t(`status.${sub.status}`)}</Badge>
          <h2>{trialDays !== null ? t("planTrial", { plan: o.plan.name, days: trialDays }) : o.plan.name}</h2>
          <div className={cn(styles.muted)} style={{ fontSize: 12 }}>
            {description}
          </div>
        </div>
        {u && (
          <div className={styles.meters}>
            <Meter label={t("seats")} used={u.seats.used} limit={u.seats.limit} value={u.seats.limit === null ? t("people", { n: u.seats.used }) : t("seatsValue", { used: u.seats.used, limit: u.seats.limit })} />
            <Meter label={t("storage")} used={u.storage.usedGb} limit={u.storage.limitGb} value={u.storage.limitGb === null ? `${u.storage.usedGb} GB` : t("storageValue", { used: u.storage.usedGb, limit: u.storage.limitGb })} />
            {u.projects.limit !== null && <Meter label={t("projects")} used={u.projects.used} limit={u.projects.limit} value={`${u.projects.used} / ${u.projects.limit}`} />}
            <div className={cn(styles.muted, styles.small)}>{t("guestsNote")}</div>
          </div>
        )}
        <div className={styles.row}>
          <Link className={buttonVariants({ variant: "primary" })} href={checkoutHref(ws, sub.status === "active" ? null : sub.planCode)}>
            {sub.status === "active" ? t("changePlan") : t("pay")}
          </Link>
          {workspace.role === "owner" && (sub.status === "active" || sub.status === "trialing") && (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              {t("cancel")}
            </Button>
          )}
        </div>
      </section>

      <section className={styles.card} aria-labelledby="bill-methods">
        <div className={styles.ch}>
          <h2 id="bill-methods">{t("methodsTitle")}</h2>
          <span className={cn(styles.muted)} style={{ fontSize: 12 }}>{t("methodsHint")}</span>
        </div>
        <div className={styles.profile}>
          {(["card", "promptpay", "transfer"] as const).map((m) => (
            <div key={m} className={styles.panel}>
              <b>{t(`methods.${m}`)}</b>
              <div className={cn(styles.muted, styles.small)}>{t(`methods.${m}Hint`)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card} aria-labelledby="bill-profile">
        <div className={styles.ch}>
          <h2 id="bill-profile">{t("profileTitle")}</h2>
          <Link href={`/work/${encodeURIComponent(ws)}/billing/checkout`}>{t("profileEdit")}</Link>
        </div>
        {o.profile ? (
          <div className={styles.profile}>
            <div><div className={cn(styles.muted, styles.small)}>{t("companyName")}</div>{o.profile.companyName}</div>
            <div><div className={cn(styles.muted, styles.small)}>{t("taxId")}</div><span className={styles.mono}>{o.profile.taxId}</span></div>
            <div><div className={cn(styles.muted, styles.small)}>{t("branch")}</div>{o.profile.branchType === "head" ? t("head") : t("branchNo", { no: o.profile.branchNo ?? "" })}</div>
            <div><div className={cn(styles.muted, styles.small)}>{t("taxEmail")}</div>{o.profile.taxEmail}</div>
            <div className={styles.full}><div className={cn(styles.muted, styles.small)}>{t("address")}</div>{o.profile.address}</div>
            <div className={styles.full}>{o.profile.whtEnabled ? t("whtOn") : t("whtOff")}</div>
          </div>
        ) : (
          <div className={cn(styles.profile, styles.muted)}>{t("profileEmpty")}</div>
        )}
      </section>

      <section className={styles.card} aria-labelledby="bill-invoices">
        <div className={styles.ch}>
          <h2 id="bill-invoices">{t("invoicesTitle")}</h2>
          <span className={cn(styles.muted)} style={{ fontSize: 12 }}>{t("invoicesHint")}</span>
        </div>
        {invoices.isPending ? (
          <LoadingState />
        ) : invoices.error ? (
          <ErrorState error={invoices.error} retry={() => invoices.refetch()} />
        ) : invoices.data.items.length === 0 ? (
          <EmptyState title={t("noInvoices")} description={t("noInvoicesHint")} />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {invoices.data.items.map((inv) => {
              const needWht = inv.whtAmount > 0 && !inv.whtCertificate && !!inv.whtDueBy && inv.whtDueBy >= now && inv.status !== "void";
              const needSlip = inv.method === "transfer" && (inv.status === "open" || inv.status === "pending_review");
              return (
                <li key={inv.id} className={styles.inv}>
                  <span className={cn(styles.mono, styles.no)}>{inv.number}</span>
                  <span className={styles.desc}>
                    {t("period", { from: formatDate(inv.periodStart, "BE", true), to: formatDate(inv.periodEnd, "BE", true) })}
                    {inv.method && ` · ${t(`methods.${inv.method}`)}`}
                    {needWht && <div className={cn(styles.small, styles.warn)}>{t("whtDue", { date: formatDate(inv.whtDueBy, "BE", true) })}</div>}
                  </span>
                  <b>฿{baht(inv.amountDue)}</b>
                  <Badge tone={INVOICE_TONE[inv.status]}>{t(`invoiceStatus.${inv.status}`)}</Badge>
                  <span className={styles.row}>
                    <a className={buttonVariants({ size: "small" })} href={inv.pdfUrl} target="_blank" rel="noreferrer">
                      {t("invoicePdf")}
                    </a>
                    {inv.taxDocument && (
                      <a className={buttonVariants({ size: "small" })} href={inv.taxDocument.pdfUrl} target="_blank" rel="noreferrer">
                        {t("taxPdf")}
                      </a>
                    )}
                    {needSlip && (
                      <Button size="small" onClick={() => pick(inv, "slip")}>
                        {inv.hasSlip ? t("slipAgain") : t("slip")}
                      </Button>
                    )}
                    {needWht && (
                      <Button size="small" onClick={() => pick(inv, "wht-certificate")}>
                        {t("wht")}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <input
          ref={fileInput}
          type="file"
          className={styles.hiddenInput}
          aria-label={upload?.kind === "wht-certificate" ? t("wht") : t("slip")}
          accept="image/png,image/jpeg,image/webp,application/pdf"
          tabIndex={-1}
          onChange={(e) => void sendFile(e.target.files?.[0])}
        />
      </section>

      <CancelSurvey
        open={cancelling}
        onOpenChange={setCancelling}
        base={base}
        isOwner={workspace.role === "owner"}
        until={formatDate(sub.status === "trialing" ? sub.trialEndsAt : sub.currentPeriodEnd, "BE", true)}
        onCancelled={refresh}
      />
    </div>
  );
}
