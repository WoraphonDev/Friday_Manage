"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Forbidden, Input, LoadingState, Select, buttonVariants } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api, supportId } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PAID_PLANS, baht, fitPlan, isPaidPlan, type Cycle, type PaidPlan, type PublicPlans, type Usage } from "@/features/plan-limits";
import { useQrDataUrl } from "./qr";
import { loadStripe, type StripeCardElement, type StripeLike } from "./stripe";
import type { BillingProfile, CheckoutResult, Invoice, Method, Quote } from "./types";
import styles from "./billing.module.css";

type Entity = "corp" | "person";
type Phase = { kind: "form" } | { kind: "pending"; result: CheckoutResult } | { kind: "done"; invoice: Pick<Invoice, "number" | "periodEnd" | "status">; method: Method };
interface Form {
  companyName: string;
  taxId: string;
  branchType: "head" | "branch";
  branchNo: string;
  address: string;
  taxEmail: string;
  poNumber: string;
}
const EMPTY: Form = { companyName: "", taxId: "", branchType: "head", branchNo: "", address: "", taxEmail: "", poNumber: "" };
const SLIP_MAX = 5 * 1024 * 1024;
/** poll สถานะใบแจ้งหนี้จน `paid` (Webhook ของ Stripe ยืนยันฝั่ง API) */
export const POLL_MS = 3000;

/** Idempotency-Key ใหม่ต่อการกดชำระหนึ่งครั้ง · ใช้ซ้ำเมื่อ retry หลังเครือข่ายล้มหรือ 5xx (A33) */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const addDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function Option({ on, onClick, title, hint, disabled }: { on: boolean; onClick: () => void; title: string; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" className={styles.opt} aria-pressed={on} onClick={onClick} disabled={disabled}>
      <span className={styles.rd} aria-hidden="true" />
      <span>
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

/** R2 · ชำระเงิน (บัตร / PromptPay / โอน + หัก ณ ที่จ่าย) */
export function Checkout({ ws, initialPlan, initialCycle }: { ws: string; initialPlan?: string; initialCycle?: string }) {
  const t = useTranslations("saas-pages.checkout");
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const base = `/w/${encodeURIComponent(ws)}`;
  const canBill = workspace.role === "owner" || workspace.role === "admin";

  const plans = useQuery({ queryKey: ["public-plans"], queryFn: () => api.get<PublicPlans>("/public/plans"), staleTime: 300_000, enabled: canBill });
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<Usage>(`${base}/usage`), enabled: canBill, retry: false });
  const profile = useQuery({ queryKey: ["billing-profile", ws], queryFn: () => api.get<{ profile: BillingProfile | null }>(`${base}/billing/profile`), enabled: canBill });

  const [plan, setPlan] = useState<PaidPlan | null>(isPaidPlan(initialPlan) ? initialPlan : null);
  const [cycle, setCycle] = useState<Cycle>(initialCycle === "yearly" ? "yearly" : "monthly");
  const [entity, setEntity] = useState<Entity>("corp");
  const [form, setForm] = useState<Form>(EMPTY);
  const [method, setMethod] = useState<Method>("card");
  const [wht, setWht] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [slip, setSlip] = useState<File | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const key = useRef<string | null>(null);
  const stripe = useRef<{ stripe: StripeLike; card: StripeCardElement } | null>(null);
  const prefilled = useRef(false);
  const onCardReady = useCallback((s: { stripe: StripeLike; card: StripeCardElement } | null) => {
    stripe.current = s;
  }, []);

  // กรอกข้อมูลภาษีเดิมให้ครั้งแรกที่โหลดได้ · ไม่มี profile = นิติบุคคลเป็นค่าเริ่มต้น (กรณีที่พบบ่อยของ B2B)
  useEffect(() => {
    const p = profile.data?.profile;
    if (prefilled.current || !profile.data) return;
    prefilled.current = true;
    if (!p) return;
    setForm({ companyName: p.companyName, taxId: p.taxId, branchType: p.branchType, branchNo: p.branchNo ?? "", address: p.address, taxEmail: p.taxEmail, poNumber: "" });
    setWht(p.whtEnabled);
  }, [profile.data]);

  const paidPlans = (plans.data?.items ?? []).filter((p) => isPaidPlan(p.code));
  const seats = usage.data?.seats.used ?? 0;
  // ไม่ได้ระบุแพ็กเกจ: เลือกแพ็กเกจเล็กที่สุดที่รองรับทีมปัจจุบัน
  const fit = fitPlan(paidPlans, seats)?.code;
  const selected: PaidPlan = plan ?? (isPaidPlan(fit) ? fit : "team_l");
  const selectedSpec = paidPlans.find((p) => p.code === selected);
  const canWht = entity === "corp" && method !== "card";
  const whtOn = canWht && wht;
  const locked = phase.kind === "pending";

  const quote = useQuery({
    queryKey: ["billing-quote", ws, selected, cycle, whtOn],
    queryFn: () => api.get<Quote>(`${base}/billing/quote?plan=${selected}&cycle=${cycle}&wht=${whtOn}`),
    enabled: canBill && phase.kind === "form",
    placeholderData: keepPreviousData,
  });

  const pending = phase.kind === "pending" ? phase.result : null;
  const watching = !!pending && pending.payment.method !== "transfer";
  const invoice = useQuery({
    queryKey: ["billing-invoice", ws, pending?.invoice.id],
    queryFn: () => api.get<Invoice>(`${base}/billing/invoices/${pending!.invoice.id}`),
    enabled: watching,
    refetchInterval: watching ? POLL_MS : false,
  });
  useEffect(() => {
    if (pending && invoice.data?.status === "paid") {
      setPhase({ kind: "done", invoice: invoice.data, method: pending.payment.method });
      void cache.invalidateQueries({ queryKey: ["usage", ws] });
    }
  }, [invoice.data, pending, cache, ws]);
  // นับถอยหลัง QR (หมดอายุ 15 นาที)
  useEffect(() => {
    if (!pending?.promptpay) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pending]);

  if (!canBill) return <div className={styles.page}><Forbidden /></div>;
  const firstError = [plans, profile].find((q) => q.error)?.error;
  if (firstError)
    return <div className={styles.page}>{firstError instanceof ApiError && firstError.status === 403 ? <Forbidden /> : <ErrorState error={firstError} retry={() => { void plans.refetch(); void profile.refetch(); }} />}</div>;
  if (plans.isPending || profile.isPending) return <div className={styles.page}><LoadingState /></div>;

  // เปลี่ยนรายละเอียดที่ส่งไปชำระ = คำขอใหม่ จึงล้าง key (key เดิมกับข้อมูลต่างกัน API ตอบ 422)
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    key.current = null;
    set(v);
  };
  const setField = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    if (k === "poNumber") key.current = null;
    setForm((f) => ({ ...f, [k]: value }));
    setErrors((x) => ({ ...x, [k]: undefined }));
  };

  function validate() {
    const e: Partial<Record<keyof Form, string>> = {};
    if (!form.companyName.trim()) e.companyName = t("errors.required");
    if (!/^\d{13}$/.test(form.taxId.trim())) e.taxId = t("errors.taxId");
    if (entity === "corp" && form.branchType === "branch" && !/^\d{5}$/.test(form.branchNo.trim())) e.branchNo = t("errors.branchNo");
    if (!form.address.trim()) e.address = t("errors.required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.taxEmail.trim())) e.taxEmail = t("errors.email");
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function confirmCard(result: CheckoutResult) {
    const s = stripe.current;
    // ไม่ได้ตั้งกุญแจ Stripe (โหมดพัฒนา) → รอสถานะจาก API อย่างเดียว
    if (!s || !result.card) return;
    const r = await s.stripe.confirmCardPayment(result.card.clientSecret, {
      payment_method: { card: s.card, billing_details: { name: form.companyName.trim(), email: form.taxEmail.trim() } },
    });
    if (r.error) setProblem(r.error.message ?? t("cardFailed"));
  }

  async function startCheckout() {
    if (!validate()) return;
    setBusy(true);
    setProblem(null);
    try {
      const corp = entity === "corp";
      await api.put(`${base}/billing/profile`, {
        companyName: form.companyName.trim(),
        taxId: form.taxId.trim(),
        branchType: corp ? form.branchType : "head",
        branchNo: corp && form.branchType === "branch" ? form.branchNo.trim() : null,
        address: form.address.trim(),
        taxEmail: form.taxEmail.trim(),
        whtEnabled: whtOn,
      });
      key.current ??= newKey();
      const result = await api.request<CheckoutResult>(`${base}/billing/checkout`, {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: { plan: selected, cycle, method, wht: whtOn, ...(form.poNumber.trim() ? { poNumber: form.poNumber.trim() } : {}) },
      });
      // ได้ผลแล้ว: กดชำระครั้งต่อไปคือการชำระใหม่
      key.current = null;
      setPhase({ kind: "pending", result });
      if (method === "card") await confirmCard(result);
    } catch (e) {
      // 4xx = คำขอนี้จบแล้ว (เช่นข้อมูลผิด) → ครั้งหน้าใช้ key ใหม่ · เครือข่ายล้ม / 5xx = ลองซ้ำด้วย key เดิม
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) key.current = null;
      if (e instanceof ApiError && Array.isArray(e.details.fields)) {
        const fields = e.details.fields as { path: string; message: string }[];
        setErrors(Object.fromEntries(fields.filter((f) => f.path in EMPTY).map((f) => [f.path, f.message])));
      }
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  async function sendSlip(result: CheckoutResult) {
    if (!slip) return;
    if (slip.size > SLIP_MAX) {
      setProblem(t("slipTooLarge"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const body = new FormData();
      body.append("file", slip);
      const inv = await api.request<Invoice>(`${base}/billing/invoices/${result.invoice.id}/slip`, { method: "POST", body });
      setPhase({ kind: "done", invoice: inv, method: "transfer" });
      void cache.invalidateQueries({ queryKey: ["usage", ws] });
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  async function primary() {
    if (phase.kind === "form") return startCheckout();
    if (phase.kind !== "pending") return;
    const r = phase.result;
    if (r.payment.method === "transfer") return sendSlip(r);
    setProblem(null);
    if (r.payment.method === "card" && stripe.current) {
      setBusy(true);
      try {
        await confirmCard(r);
      } finally {
        setBusy(false);
      }
    }
    const latest = await invoice.refetch();
    if (latest.data && latest.data.status !== "paid") setProblem(r.payment.method === "promptpay" ? t("notReceived") : t("waitingConfirm"));
  }

  if (phase.kind === "done") return <Done ws={ws} phase={phase} planName={selectedSpec?.name ?? selected} again={() => setPhase({ kind: "form" })} whtOn={whtOn} />;

  const amounts = pending ? pending.invoice : quote.data;
  const pay = amounts ? baht(amounts.amountDue) : "–";
  const expiresIn = pending?.promptpay ? Math.max(0, Date.parse(pending.promptpay.expiresAt) - now) : 0;
  const expired = !!pending?.promptpay && expiresIn <= 0;
  const payLabel = !pending
    ? method === "card"
      ? t("payCard", { amount: pay })
      : method === "promptpay"
        ? t("createQr")
        : t("requestInvoice")
    : pending.payment.method === "card"
      ? t("payCard", { amount: pay })
      : pending.payment.method === "promptpay"
        ? t("scanned")
        : t("sendSlip");
  const problemText = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : null;

  return (
    <div className={styles.page}>
      {/* R2: ชื่อหน้าและ "เชื่อมต่อแบบเข้ารหัส" อยู่ในหัวของ shell แล้ว · คง h1 ไว้ให้โปรแกรมอ่านหน้าจอ */}
      <h1 className="sr-only">{t("title")}</h1>
      <div className={styles.steps} aria-label={t("stepsLabel")}>
        {(["plan", "tax", "pay"] as const).map((s, i) => (
          <span key={s} className={cn(styles.step, styles.on)}>
            <b>{i + 1}</b>
            {t(`steps.${s}`)}
          </span>
        ))}
      </div>
      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={cn(styles.card, styles.section)} aria-labelledby="co-plan">
            <h2 id="co-plan">{t("planTitle")}</h2>
            <div className={styles.options} role="group" aria-label={t("planTitle")}>
              {PAID_PLANS.map((code) => {
                const spec = paidPlans.find((p) => p.code === code);
                if (!spec) return null;
                return <Option key={code} on={selected === code} disabled={locked} onClick={() => change(setPlan)(code)} title={spec.name} hint={t("upTo", { n: spec.seatLimit ?? 0 })} />;
              })}
            </div>
            <div className={styles.options} role="group" aria-label={t("cycleLabel")}>
              <Option on={cycle === "monthly"} disabled={locked} onClick={() => change(setCycle)("monthly")} title={t("monthly")} hint={t("monthlyHint")} />
              <Option on={cycle === "yearly"} disabled={locked} onClick={() => change(setCycle)("yearly")} title={t("yearly")} hint={t("yearlyHint", { months: plans.data?.yearlyMonths ?? 10 })} />
            </div>
            {usage.data && selectedSpec && (
              <div className={cn(styles.small, selectedSpec.seatLimit !== null && seats > selectedSpec.seatLimit ? styles.warn : styles.muted)}>
                {selectedSpec.seatLimit !== null && seats > selectedSpec.seatLimit
                  ? t("teamOver", { n: seats, plan: selectedSpec.name, limit: selectedSpec.seatLimit })
                  : t("teamNow", { n: seats, plan: selectedSpec.name, limit: selectedSpec.seatLimit ?? 0 })}
              </div>
            )}
          </section>

          <section className={cn(styles.card, styles.section)} aria-labelledby="co-tax">
            <h2 id="co-tax">{t("taxTitle")}</h2>
            <div className={styles.options} role="group" aria-label={t("entityLabel")}>
              <Option on={entity === "corp"} disabled={locked} onClick={() => change(setEntity)("corp")} title={t("corp")} />
              <Option on={entity === "person"} disabled={locked} onClick={() => change(setEntity)("person")} title={t("person")} />
            </div>
            <div className={styles.grid}>
              <Input label={entity === "corp" ? t("companyName") : t("personName")} value={form.companyName} onChange={setField("companyName")} error={errors.companyName} disabled={locked} autoComplete="organization" />
              <Input label={t("taxId")} className={styles.mono} inputMode="numeric" maxLength={13} value={form.taxId} onChange={setField("taxId")} error={errors.taxId} disabled={locked} />
              {entity === "corp" && (
                <Select label={t("branch")} value={form.branchType} onChange={setField("branchType")} disabled={locked}>
                  <option value="head">{t("head")}</option>
                  <option value="branch">{t("branchOption")}</option>
                </Select>
              )}
              {entity === "corp" && form.branchType === "branch" && (
                <Input label={t("branchNo")} className={styles.mono} inputMode="numeric" maxLength={5} value={form.branchNo} onChange={setField("branchNo")} error={errors.branchNo} disabled={locked} />
              )}
              <div className={styles.full}>
                <Input label={t("address")} value={form.address} onChange={setField("address")} error={errors.address} disabled={locked} autoComplete="street-address" />
              </div>
              <Input label={t("taxEmail")} type="email" value={form.taxEmail} onChange={setField("taxEmail")} error={errors.taxEmail} disabled={locked} autoComplete="email" />
              <Input label={t("po")} placeholder={t("optional")} maxLength={50} value={form.poNumber} onChange={setField("poNumber")} disabled={locked} />
            </div>
          </section>

          <section className={cn(styles.card, styles.section)} aria-labelledby="co-pay">
            <h2 id="co-pay">{t("payTitle")}</h2>
            <div className={styles.options} role="group" aria-label={t("payTitle")}>
              <Option on={method === "card"} disabled={locked} onClick={() => change(setMethod)("card")} title={t("methods.card")} hint={t("methods.cardHint")} />
              <Option on={method === "promptpay"} disabled={locked} onClick={() => change(setMethod)("promptpay")} title={t("methods.promptpay")} hint={t("methods.promptpayHint")} />
              <Option on={method === "transfer"} disabled={locked} onClick={() => change(setMethod)("transfer")} title={t("methods.transfer")} hint={t("methods.transferHint")} />
            </div>

            {method === "card" && (
              <>
                <CardField onReady={onCardReady} />
                <div className={cn(styles.muted, styles.small)}>{t("cardNote")}</div>
              </>
            )}

            {method === "promptpay" &&
              (pending?.promptpay ? (
                <PromptPayPanel number={pending.invoice.number} payload={pending.promptpay.qrPayload} amount={pay} expiresIn={expiresIn} />
              ) : (
                <div className={cn(styles.panel, styles.muted, styles.small)}>{t("promptpayBefore")}</div>
              ))}

            {method === "transfer" &&
              (pending?.transfer ? (
                <div className={cn(styles.panel, styles.bank)}>
                  <div><div className={styles.label}>{t("bank")}</div><b>{pending.transfer.bank}</b></div>
                  <div><div className={styles.label}>{t("accountName")}</div><b>{pending.transfer.accountName}</b></div>
                  <div><div className={styles.label}>{t("accountNo")}</div><b className={styles.mono}>{pending.transfer.accountNo}</b></div>
                  <div><div className={styles.label}>{t("amount")}</div><b>{t("baht", { amount: baht(pending.transfer.amount) })}</b></div>
                  <div><div className={styles.label}>{t("reference")}</div><b className={styles.mono}>{pending.transfer.reference}</b></div>
                  <div><div className={styles.label}>{t("dueDate")}</div><b>{formatDate(pending.transfer.dueDate, "BE", true)}</b></div>
                  <div className={styles.full}>
                    <label className={styles.label} htmlFor="slip">{t("slip")}</label>
                    <div className={styles.drop}>
                      <input id="slip" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setSlip(e.target.files?.[0] ?? null)} />
                      <span className={styles.muted}>{slip ? slip.name : t("slipHint")}</span>
                    </div>
                  </div>
                  <div className={styles.full}>
                    <a href={`/api/v1${base}/billing/invoices/${pending.invoice.id}.pdf`} target="_blank" rel="noreferrer">
                      {t("invoicePdf", { number: pending.invoice.number })}
                    </a>
                  </div>
                </div>
              ) : (
                <div className={cn(styles.panel, styles.muted, styles.small)}>{t("transferBefore")}</div>
              ))}
            {method === "transfer" && <div className={cn(styles.muted, styles.small)}>{t("transferNote")}</div>}

            {canWht && (
              <label className={styles.whtBox}>
                <input type="checkbox" checked={wht} disabled={locked} onChange={(e) => change(setWht)(e.target.checked)} />
                <span>
                  <b>{t("whtLabel")}</b>
                  <div className={cn(styles.muted, styles.small)}>{t("whtHint")}</div>
                </span>
              </label>
            )}
            {entity === "corp" && method === "card" && <div className={cn(styles.muted, styles.small)}>{t("whtCard")}</div>}
          </section>
        </div>

        <aside className={cn(styles.card, styles.aside)} aria-label={t("summary")}>
          <h2>{t("summary")}</h2>
          {!amounts ? (
            quote.error ? <ErrorState error={quote.error} retry={() => quote.refetch()} /> : <LoadingState />
          ) : (
            <>
              <div className={styles.sr}>
                <span>
                  {selectedSpec?.name ?? selected} · {cycle === "yearly" ? t("yearly") : t("monthly")}
                </span>
                <span>{baht(amounts.subtotal)}</span>
              </div>
              <div className={styles.sr}>
                <span className={styles.muted}>{t("vat")}</span>
                <span>{baht(amounts.vat)}</span>
              </div>
              <div className={cn(styles.sr, styles.total)}>
                <span>{t("taxTotal")}</span>
                <span>{baht(amounts.total)}</span>
              </div>
              {amounts.whtAmount > 0 && (
                <div className={cn(styles.sr, styles.whtLine)}>
                  <span>{t("whtLine")}</span>
                  <span>− {baht(amounts.whtAmount)}</span>
                </div>
              )}
              <div className={cn(styles.sr, styles.due)}>
                <span>{t("due")}</span>
                <span>{t("baht", { amount: pay })}</span>
              </div>
            </>
          )}
          {problemText && (
            <div role="alert" className={cn(styles.warn, styles.small)}>
              {problemText}
              {problem instanceof ApiError && supportId(problem) && <div className={styles.mono}>{t("requestId", { id: supportId(problem) ?? "" })}</div>}
            </div>
          )}
          {expired ? (
            <Button variant="primary" className={styles.payBtn} onClick={() => setPhase({ kind: "form" })}>
              {t("newQr")}
            </Button>
          ) : (
            <Button variant="primary" className={styles.payBtn} disabled={busy || !amounts || (pending?.payment.method === "transfer" && !slip)} onClick={primary}>
              {busy ? t("processing") : payLabel}
            </Button>
          )}
          {pending && (
            <Button variant="ghost" onClick={() => { setProblem(null); setPhase({ kind: "form" }); }}>
              {t("edit")}
            </Button>
          )}
          <div className={cn(styles.muted, styles.small)} style={{ marginTop: 8 }}>
            {t.rich("terms", {
              terms: (c) => <Link href="/legal/terms" target="_blank">{c}</Link>,
              dpa: (c) => <Link href="/legal/dpa" target="_blank">{c}</Link>,
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** ช่องบัตรของ Stripe Elements (iframe ของ Stripe) · ไม่ได้ตั้งกุญแจ = บอกว่าเป็นโหมดทดสอบ */
function CardField({ onReady }: { onReady: (s: { stripe: StripeLike; card: StripeCardElement } | null) => void }) {
  const t = useTranslations("saas-pages.checkout");
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [cardError, setCardError] = useState<string | null>(null);
  useEffect(() => {
    let card: StripeCardElement | null = null;
    let alive = true;
    loadStripe()
      .then((stripe) => {
        if (!alive) return;
        if (!stripe || !box.current) {
          setState("none");
          onReady(null);
          return;
        }
        card = stripe.elements({ locale: "th" }).create("card", { hidePostalCode: true });
        card.mount(box.current);
        card.on("change", (e) => setCardError(e.error?.message ?? null));
        onReady({ stripe, card });
        setState("ready");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
      card?.destroy();
      onReady(null);
    };
  }, [onReady]);
  return (
    <div className="field">
      <label>{t("cardNumber")}</label>
      <div ref={box} className={styles.cardBox} data-testid="stripe-card" hidden={state !== "ready"} />
      {state === "loading" && <div className={cn(styles.cardBox, styles.muted)}>{t("cardLoading")}</div>}
      {state === "none" && <div className={cn(styles.panel, styles.muted, styles.small)}>{t("cardTestMode")}</div>}
      {state === "error" && <div className={cn(styles.warn, styles.small)} role="alert">{t("cardUnavailable")}</div>}
      {cardError && <span className="field-error" role="alert">{cardError}</span>}
    </div>
  );
}

function PromptPayPanel({ number, payload, amount, expiresIn }: { number: string; payload: string; amount: string; expiresIn: number }) {
  const t = useTranslations("saas-pages.checkout");
  const qr = useQrDataUrl(payload);
  const mm = Math.floor(expiresIn / 60000);
  const ss = Math.floor((expiresIn % 60000) / 1000);
  return (
    <div className={cn(styles.panel, styles.qrRow)}>
      <div className={styles.qr}>{qr ? <img src={qr} alt={t("qrAlt", { amount })} /> : t("qrLoading")}</div>
      <div className={styles.qrText}>
        <b>{t("scanToPay", { amount })}</b>
        <span className={styles.muted} role="timer" aria-live="off">
          {expiresIn > 0 ? t("qrExpires", { time: `${mm}:${String(ss).padStart(2, "0")}` }) : t("qrExpired")}
        </span>
        <span className={styles.muted}>{t("qrNext")}</span>
        {qr && (
          <a className={cn(buttonVariants({ size: "small" }))} style={{ alignSelf: "flex-start" }} href={qr} download={`promptpay-${number}.svg`}>
            {t("downloadQr")}
          </a>
        )}
      </div>
    </div>
  );
}

function Done({ ws, phase, planName, again, whtOn }: { ws: string; phase: Extract<Phase, { kind: "done" }>; planName: string; again: () => void; whtOn: boolean }) {
  const t = useTranslations("saas-pages.checkout.done");
  const base = `/w/${encodeURIComponent(ws)}`;
  const review = phase.invoice.status === "pending_review";
  const m = phase.method;
  const next = formatDate(addDay(phase.invoice.periodEnd), "BE", true);
  return (
    <div className={styles.page}>
      <section className={cn(styles.card, styles.done)} aria-labelledby="done-title">
        <span className={cn(styles.pill, review ? styles.wait : styles.ok)}>{review ? t("reviewTag") : m === "card" ? t("paidTag") : t("receivedTag")}</span>
        <h1 id="done-title">{review ? t("reviewTitle", { plan: planName }) : t("title", { plan: planName })}</h1>
        <div className={styles.muted}>{review ? t("reviewDescription") : m === "card" ? t("cardDescription") : t("promptpayDescription")}</div>
        <ul>
          <li>{t("taxDoc", { when: review ? t("afterReview") : t("now") })}</li>
          {whtOn && <li>{t("wht")}</li>}
          <li>{m === "card" ? t("nextCard", { date: next }) : t("nextInvoice", { date: next })}</li>
        </ul>
        <div className={styles.row}>
          <Link className={buttonVariants({ variant: "primary" })} href={base}>{t("back")}</Link>
          <Link className={buttonVariants()} href={`${base}/billing`}>{t("billing")}</Link>
          <Button onClick={again}>{t("again")}</Button>
        </div>
      </section>
    </div>
  );
}
