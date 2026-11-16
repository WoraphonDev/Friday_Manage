"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AlertCircle, CalendarClock, Clock, CreditCard, Landmark, QrCode } from "lucide-react";
import { Badge, Button, CountUp, Dialog, EmptyState, ErrorState, Forbidden, LoadingState, buttonVariants, useToast, type Tone } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api } from "@/lib/api";
import { formatDate, today } from "@/lib/format";
import { cn } from "@/lib/utils";
import { baht, checkoutHref, isPaidPlan, type PublicPlans, type SubscriptionStatus, type Usage } from "@/features/plan-limits";
import { CancelSurvey } from "@/features/checkout/CancelSurvey";
import type { BillingOverview, Invoice, InvoiceStatus, Method } from "./types";
import { PlansCompare } from "./plans";
import styles from "./billing.module.css";

const STATUS_TONE: Record<SubscriptionStatus, Tone> = { trialing: "amber", active: "green", past_due: "red", canceled: "neutral" };
const INVOICE_TONE: Record<InvoiceStatus, Tone> = { open: "amber", pending_review: "blue", paid: "green", void: "neutral" };

const METHOD_ICON: Record<Method, typeof CreditCard> = { card: CreditCard, promptpay: QrCode, transfer: Landmark };

/** กล่องการใช้งานหนึ่งอย่าง (สมาชิก / พื้นที่ / โปรเจกต์) · หลอดวิ่งจาก 0 ตอนเปิดหน้า (.motion-bar) */
function Meter({ label, used, limit, value, note }: { label: string; used: number; limit: number | null; value: ReactNode; note?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className={styles.meter}>
      <div className={styles.meterTop}>
        <span className={styles.meterLabel}>{label}</span>
        <span className={styles.meterValue}>{value}</span>
      </div>
      {limit !== null && (
        <div className={styles.bar}>
          <span className={cn("motion-bar", used > limit && styles.over)} style={{ width: `${pct}%` }} />
        </div>
      )}
      {note && <span className={styles.meterNote}>{note}</span>}
    </div>
  );
}

/** สิ่งที่ต้องทำจากใบแจ้งหนี้ (รอชำระ / รอตรวจสลิป / ส่ง 50 ทวิ) · แสดงเป็นแถบบนสุดของหน้า */
interface Todo {
  key: string;
  tone: "warn" | "info";
  title: string;
  hint: string;
  action?: ReactNode;
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
  const [comparing, setComparing] = useState(false);
  const [upload, setUpload] = useState<{ invoice: Invoice; kind: "slip" | "wht-certificate" } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const overview = useQuery({ queryKey: ["billing", ws], queryFn: () => api.get<BillingOverview>(`${base}/billing`), enabled: canBill });
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<Usage>(`${base}/usage`), enabled: canBill, retry: false });
  const invoices = useQuery({ queryKey: ["billing-invoices", ws], queryFn: () => api.get<{ items: Invoice[] }>(`${base}/billing/invoices`), enabled: canBill });
  // ราคาต่อรอบของแพ็กเกจปัจจุบัน (คีย์เดียวกับหน้าชำระเงิน จึงใช้แคชร่วมกัน) · โหลดไม่ได้ก็แค่ไม่แสดงราคา
  const plans = useQuery({ queryKey: ["public-plans"], queryFn: () => api.get<PublicPlans>("/public/plans"), staleTime: 300_000, enabled: canBill, retry: false });

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
  const items = invoices.data?.items ?? [];
  // 50 ทวิ (รอบ 4): ต้องส่งหลังชำระ ยังไม่ส่งหรือไม่ผ่าน · เลยกำหนดยังส่งได้ (ขึ้น "เลยกำหนด") · แจ้ง e-WHT / รอตรวจ = ส่งแล้ว
  const needWhtFor = (inv: Invoice) => inv.whtAmount > 0 && inv.status === "paid" && (!inv.whtCertificate || inv.whtCertificate.status === "rejected");
  const whtLate = (inv: Invoice) => !!inv.whtDueBy && inv.whtDueBy < now;
  const whtText = (inv: Invoice) => (whtLate(inv) ? t("whtLate", { date: formatDate(inv.whtDueBy, "BE", true) }) : t("whtDue", { date: formatDate(inv.whtDueBy, "BE", true) }));
  // ใบที่ยังไม่จ่ายทุกวิธี → หน้าชำระใบแจ้งหนี้ (QR / บัตร / เลขบัญชี) · โอนที่รอตรวจ → แนบสลิปใหม่
  const needSlipFor = (inv: Invoice) => inv.status === "open" || (inv.method === "transfer" && inv.status === "pending_review");
  const slipButton = (inv: Invoice) => (
    <Link className={buttonVariants({ size: "small", variant: inv.status === "open" ? "primary" : undefined })} href={`/work/${encodeURIComponent(ws)}/billing/invoices/${inv.id}${inv.hasSlip ? "?slip=new" : ""}`}>
      {inv.hasSlip ? t("slipAgain") : t("payInvoice")}
    </Link>
  );
  const todos: Todo[] = items.flatMap((inv) => {
    const list: Todo[] = [];
    if (inv.status === "pending_review")
      list.push({ key: `${inv.id}-review`, tone: "info", title: t("todo.review", { number: inv.number }), hint: t("todo.reviewHint"), action: needSlipFor(inv) ? slipButton(inv) : undefined });
    else if (inv.status === "open")
      list.push({ key: `${inv.id}-open`, tone: "warn", title: t("todo.open", { number: inv.number, amount: baht(inv.amountDue) }), hint: t("todo.openHint", { date: formatDate(inv.dueDate, "BE", true) }), action: needSlipFor(inv) ? slipButton(inv) : undefined });
    if (needWhtFor(inv))
      list.push({
        key: `${inv.id}-wht`,
        tone: "warn",
        title: whtLate(inv) ? t("todo.whtLate", { number: inv.number, date: formatDate(inv.whtDueBy, "BE", true) }) : t("todo.wht", { number: inv.number, date: formatDate(inv.whtDueBy, "BE", true) }),
        hint: inv.whtCertificate?.status === "rejected" ? t("todo.whtRejected", { reason: inv.whtCertificate.rejectReason ?? "-" }) : t("todo.whtHint"),
        // หน้าใบแจ้งหนี้มีทั้งอัปโหลดไฟล์และแจ้งว่าหักผ่าน e-WHT (E11)
        action: (
          <Link className={buttonVariants({ size: "small" })} href={`/work/${encodeURIComponent(ws)}/billing/invoices/${inv.id}`}>
            {t("whtSend")}
          </Link>
        ),
      });
    return list;
  });
  const lastMethod = items.find((inv) => inv.method)?.method ?? null;
  const catalog = plans.data?.items.find((p) => p.code === o.plan.code);
  const price = isPaidPlan(o.plan.code) && catalog ? (sub.cycle === "yearly" ? catalog.priceYearlySatang : catalog.priceMonthlySatang) : null;
  const seatsLeft = u && u.seats.limit !== null ? u.seats.limit - u.seats.used : null;
  const storagePct = u && u.storage.limitGb ? Math.round((u.storage.usedGb / u.storage.limitGb) * 100) : null;

  const taxCard = (
    <section className={styles.card} aria-labelledby="bill-profile">
      <div className={styles.ch}>
        <h2 id="bill-profile">{t("profileTitle")}</h2>
        <Link href={`/work/${encodeURIComponent(ws)}/billing/checkout`}>{t("edit")}</Link>
      </div>
      {o.profile ? (
        <div className={styles.tax}>
          <dl>
            <dt>{t("companyName")}</dt>
            <dd>{o.profile.companyName}</dd>
            <dt>{t("taxId")}</dt>
            <dd className={styles.mono}>{o.profile.taxId}</dd>
            <dt>{t("branch")}</dt>
            <dd>{o.profile.branchType === "head" ? t("head") : t("branchNo", { no: o.profile.branchNo ?? "" })}</dd>
            <dt>{t("taxEmail")}</dt>
            <dd>{o.profile.taxEmail}</dd>
            <dt>{t("address")}</dt>
            <dd>{o.profile.address}</dd>
          </dl>
          <div className={styles.chips}>
            <Badge tone={o.profile.whtEnabled ? "amber" : "neutral"}>{o.profile.whtEnabled ? t("whtOn") : t("whtOff")}</Badge>
          </div>
        </div>
      ) : (
        <div className={cn(styles.tax, styles.muted)}>{t("profileEmpty")}</div>
      )}
    </section>
  );

  const methodsCard = (
    <section className={styles.card} aria-labelledby="bill-methods">
      <div className={styles.ch}>
        <h2 id="bill-methods">{t("methodsTitle")}</h2>
        <span className={cn(styles.muted, styles.small)}>{t("methodsHint")}</span>
      </div>
      <ul className={cn(styles.methods, "motion-list")}>
        {(["card", "promptpay", "transfer"] as const).map((m) => {
          const Icon = METHOD_ICON[m];
          return (
            <li key={m} className={styles.method}>
              <span className={styles.methodIcon}><Icon size={17} aria-hidden="true" /></span>
              <span className={styles.methodText}>
                <b>{t(`methods.${m}`)}</b>
                <span className={cn(styles.muted, styles.small)}>{t(`methods.${m}Hint`)}</span>
              </span>
              {lastMethod === m && <Badge tone="neutral">{t("lastUsed")}</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>{t("title")}</h1>
          <div className={styles.muted}>{t("subtitle")}</div>
        </div>
        <Button onClick={() => setComparing(true)}>{t("compare")}</Button>
      </div>

      {todos.map((todo) => (
        <div key={todo.key} className={cn(styles.todo, todo.tone === "info" && styles.todoInfo)} role="status">
          {todo.tone === "info" ? <Clock size={18} aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
          <p>
            <b>{todo.title}</b> · {todo.hint}
          </p>
          {todo.action}
        </div>
      ))}

      <section className={cn(styles.card, styles.plan)} aria-label={t("planLabel")}>
        <div className={styles.planInfo}>
          <Badge tone={STATUS_TONE[sub.status]}>{t(`status.${sub.status}`)}</Badge>
          <div className={styles.planName}>
            <h2>{trialDays !== null ? t("planTrial", { plan: o.plan.name, days: trialDays }) : o.plan.name}</h2>
            {price !== null && (
              <span className={styles.price}>
                <b>฿<CountUp value={baht(price)} /></b> / {sub.cycle === "yearly" ? t("perYear") : t("perMonth")}
                {plans.data && ` · ${plans.data.vatIncluded ? t("vatIncluded") : t("vatExcluded")}`}
              </span>
            )}
          </div>
          <div className={styles.period}>
            <CalendarClock size={14} aria-hidden="true" />
            {description}
          </div>
        </div>
        {u && (
          <div className={styles.usage}>
            <div className={cn(styles.meters, "motion-list")}>
              <Meter
                label={t("seats")}
                used={u.seats.used}
                limit={u.seats.limit}
                value={u.seats.limit === null ? <CountUp value={t("people", { n: u.seats.used })} /> : <><CountUp value={u.seats.used} /> <small>/ {t("people", { n: u.seats.limit })}</small></>}
                note={seatsLeft === null ? undefined : seatsLeft >= 0 ? t("seatsLeft", { n: seatsLeft }) : t("seatsOver", { n: -seatsLeft })}
              />
              <Meter
                label={t("storage")}
                used={u.storage.usedGb}
                limit={u.storage.limitGb}
                value={u.storage.limitGb === null ? <CountUp value={`${u.storage.usedGb} GB`} /> : <><CountUp value={u.storage.usedGb} /> <small>/ {u.storage.limitGb} GB</small></>}
                note={storagePct === null ? undefined : t("storageUsed", { pct: storagePct })}
              />
              {u.projects.limit !== null && <Meter label={t("projects")} used={u.projects.used} limit={u.projects.limit} value={<><CountUp value={u.projects.used} /> <small>/ {u.projects.limit}</small></>} />}
            </div>
            <div className={styles.usageNote}>{t("guestsNote")}</div>
          </div>
        )}
        <div className={styles.planActions}>
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

      <div className={styles.split}>
        <section className={styles.card} aria-labelledby="bill-invoices">
          <div className={styles.ch}>
            <h2 id="bill-invoices">{t("invoicesTitle")}</h2>
            <span className={cn(styles.muted, styles.small)}>{t("invoicesHint")}</span>
          </div>
          {invoices.isPending ? (
            <LoadingState />
          ) : invoices.error ? (
            <ErrorState error={invoices.error} retry={() => invoices.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState title={t("noInvoices")} description={t("noInvoicesHint")} />
          ) : (
            <div className="table-scroll">
              <table className={styles.invTable}>
                <thead>
                  <tr>
                    <th>{t("col.number")}</th>
                    <th>{t("col.period")}</th>
                    <th className={styles.num}>{t("col.amount")}</th>
                    <th>{t("col.status")}</th>
                    <th className={styles.num}>{t("col.documents")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((inv) => {
                    const needWht = needWhtFor(inv);
                    return (
                      <tr key={inv.id}>
                        <td className={styles.mono}>{inv.number}</td>
                        <td>
                          {t("period", { from: formatDate(inv.periodStart, "BE", true), to: formatDate(inv.periodEnd, "BE", true) })}
                          {inv.method && <span className={styles.sub}>{t(`methods.${inv.method}`)}</span>}
                          {needWht && inv.whtDueBy && <span className={cn(styles.sub, styles.warn)}>{whtText(inv)}</span>}
                        </td>
                        <td className={cn(styles.num, styles.amount)}>฿{baht(inv.amountDue)}</td>
                        <td>
                          <Badge tone={INVOICE_TONE[inv.status]}>{t(`invoiceStatus.${inv.status}`)}</Badge>
                        </td>
                        <td className={styles.num}>
                          <span className={styles.docs}>
                            <a className={buttonVariants({ size: "small" })} href={inv.pdfUrl} target="_blank" rel="noreferrer">
                              {t("invoicePdf")}
                            </a>
                            {inv.taxDocument && (
                              <a className={buttonVariants({ size: "small" })} href={inv.taxDocument.pdfUrl} target="_blank" rel="noreferrer">
                                {t("taxPdf")}
                              </a>
                            )}
                            {inv.notes?.map((n) => (
                              <a key={n.id} className={buttonVariants({ size: "small" })} href={n.pdfUrl} target="_blank" rel="noreferrer" title={n.number}>
                                {t(n.kind === "credit" ? "creditNote" : "debitNote")}
                              </a>
                            ))}
                            {needSlipFor(inv) && slipButton(inv)}
                            {needWht && (
                              <Button size="small" onClick={() => pick(inv, "wht-certificate")}>
                                {t("wht")}
                              </Button>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
        <div className={styles.side}>
          {taxCard}
          {methodsCard}
        </div>
      </div>

      {/* เปรียบเทียบแพ็กเกจเป็นหน้าต่างซ้อน ไม่ออกจากหน้า Billing (ผู้ใช้ขอ 2026-11-15) · กดปุ่มของแพ็กเกจแล้วปิดหน้าต่างไปตามลิงก์ */}
      <Dialog open={comparing} onOpenChange={setComparing} title={t("compare")} size="xl">
        <div onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a[href]")) setComparing(false); }}>
          <PlansCompare ws={ws} sub={sub} heading="none" />
        </div>
      </Dialog>

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
