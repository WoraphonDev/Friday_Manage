"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, Input, buttonVariants } from "@/components/ui";
import { ApiError, api, supportId } from "@/lib/api";
import { cn } from "@/lib/utils";
import { baht } from "@/features/plan-limits";
import type { InvoiceDetail } from "../../../app/work/[ws]/billing/_components/types";
import { useQrDataUrl } from "./qr";
import { loadStripe, type StripeCardElement, type StripeElementType, type StripeLike } from "./stripe";
import styles from "./invoice-pay.module.css";

/** `POST w/billing/invoices/:id/pay` · client secret ของบัตร หรือ QR PromptPay ของใบเดิม */
export interface PayResponse {
  invoice: { id: string; amountDue: number };
  payment: { id: string; method: "card" | "promptpay"; status: string; amount: number };
  card?: { clientSecret: string };
  promptpay?: { qrPayload: string; expiresAt: string };
}
type Refresh = () => Promise<InvoiceDetail | undefined>;
const payKey = (base: string, id: string) => ["billing-pay", base, id];
const usePay = (base: string, id: string) =>
  useQuery({ queryKey: payKey(base, id), queryFn: () => api.request<PayResponse>(`${base}/billing/invoices/${id}/pay`, { method: "POST", body: {} }), staleTime: Infinity, retry: false });

function Problem({ problem }: { problem: unknown }) {
  const text = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : null;
  if (!text) return null;
  return (
    <div role="alert" className={cn(styles.problem, "motion-in")}>
      {text}
      {problem instanceof ApiError && supportId(problem) && <div className={styles.mono}>{supportId(problem)}</div>}
    </div>
  );
}
function Step({ n, id, title, children }: { n: number; id: string; title: string; children: React.ReactNode }) {
  return (
    <section className={cn(styles.card, styles.step)} aria-labelledby={id}>
      <div className={styles.stepHead}>
        <span className={styles.num} aria-hidden="true">
          {n}
        </span>
        <h2 id={id}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PromptPay: ① สแกน QR (นับถอยหลัง · บันทึกรูป · หมดอายุสร้างใหม่ในใบเดิม) ② รอเงินเข้า (หน้า poll สถานะเอง)
// ---------------------------------------------------------------------------
export function QrPay({ base, invoice, refresh }: { base: string; invoice: InvoiceDetail; refresh: Refresh }) {
  const t = useTranslations("checkout.invoicePay");
  const tq = useTranslations("checkout.qr");
  const cache = useQueryClient();
  const pay = usePay(base, invoice.id);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const qr = useQrDataUrl(pay.data?.promptpay?.qrPayload);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const expiresAt = pay.data?.promptpay ? Date.parse(pay.data.promptpay.expiresAt) : 0;
  const left = Math.max(0, expiresAt - now);
  const expired = !!pay.data?.promptpay && left <= 0;
  const amount = `฿${baht(invoice.amountDue)}`;

  async function renew() {
    setBusy(true);
    setProblem(null);
    try {
      cache.setQueryData(payKey(base, invoice.id), await api.request<PayResponse>(`${base}/billing/invoices/${invoice.id}/pay`, { method: "POST", body: { renew: true } }));
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setProblem(null);
    const latest = await refresh();
    if (latest && latest.status !== "paid") setProblem(tq("notYet"));
  }

  return (
    <>
      <Step n={1} id="pay-step-1" title={t("qrStep")}>
        <div className={styles.qrRow}>
          <div className={styles.qrBox} data-expired={expired || undefined}>
            {qr && !expired ? <img src={qr} alt={tq("alt", { amount })} /> : !expired && <span className={styles.muted}>{tq("loading")}</span>}
            {expired && <b className={styles.qrOver}>{t("qrExpired")}</b>}
          </div>
          <div className={styles.qrText}>
            <span className={styles.muted}>{t("qrAmount")}</span>
            <b className={styles.qrAmount}>{amount}</b>
            {pay.data?.promptpay && !expired && (
              <span className={styles.mono} role="timer" aria-live="off">
                {t("qrExpires", { time: `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}` })}
              </span>
            )}
            {expired ? (
              <>
                <span className={styles.hint}>{t("qrExpiredHint")}</span>
                <Button variant="primary" disabled={busy} onClick={renew}>
                  {tq("renew")}
                </Button>
              </>
            ) : (
              qr && (
                <a className={buttonVariants({ size: "small" })} style={{ alignSelf: "flex-start" }} href={qr} download={`promptpay-${invoice.number}.svg`}>
                  {tq("save")}
                </a>
              )
            )}
          </div>
        </div>
        <Problem problem={pay.error} />
      </Step>
      <Step n={2} id="pay-step-2" title={t("waitStep")}>
        {expired ? (
          <span className={styles.muted}>{t("renewFirst")}</span>
        ) : (
          <>
            <span className={styles.waiting} role="status">
              <span className={styles.dot} aria-hidden="true" />
              {t("waiting")}
            </span>
            <span className={styles.note}>{t("waitHint")}</span>
            <Button onClick={check}>{t("checkAgain")}</Button>
          </>
        )}
        <Problem problem={problem} />
      </Step>
    </>
  );
}

// ---------------------------------------------------------------------------
// บัตร: ① ช่องของผู้ให้บริการแยก 3 ช่อง + ชื่อบนบัตร + อีเมล ② สรุปยอด + ชำระ · ไม่ผ่าน = บอกเหตุผล ลองใหม่ในใบเดิม
// ---------------------------------------------------------------------------
type Field = "cardNumber" | "cardExpiry" | "cardCvc";
const FIELDS: Field[] = ["cardNumber", "cardExpiry", "cardCvc"];
/** สีของตัวอักษรใน iframe ของผู้ให้บริการต้องเป็นค่าจริง จึงอ่านจาก token ของหน้า (สว่าง / มืดตรงกัน) */
const tokenColor = (name: string, fallback: string) => (typeof window === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

export function CardPay({ base, invoice, email: initialEmail, cycle, refresh }: { base: string; invoice: InvoiceDetail; email: string; cycle: "monthly" | "yearly" | null; refresh: Refresh }) {
  const t = useTranslations("checkout.invoicePay");
  const tc = useTranslations("checkout.card");
  const ts = useTranslations("checkout.summary");
  const boxes = useRef<Record<Field, HTMLDivElement | null>>({ cardNumber: null, cardExpiry: null, cardCvc: null });
  const stripe = useRef<{ stripe: StripeLike; number: StripeCardElement } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [fieldError, setFieldError] = useState<Partial<Record<Field, string>>>({});
  const [brand, setBrand] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  useEffect(() => setEmail((e) => e || initialEmail), [initialEmail]);

  useEffect(() => {
    const mounted: StripeCardElement[] = [];
    let alive = true;
    loadStripe()
      .then((s) => {
        if (!alive) return;
        if (!s) return setState("none");
        const style = { base: { fontSize: "14px", color: tokenColor("--foreground", "#24272c"), "::placeholder": { color: tokenColor("--faint", "#7a8088") } }, invalid: { color: tokenColor("--danger", "#c8264a") } };
        const els = s.elements({ locale: "th" });
        const made = {} as Record<Field, StripeCardElement>;
        for (const f of FIELDS) {
          const el = els.create(f as StripeElementType, { style, ...(f === "cardNumber" ? { showIcon: true } : {}) });
          el.mount(boxes.current[f]!);
          el.on("change", (e) => {
            setFieldError((x) => ({ ...x, [f]: e.error?.message }));
            if (f === "cardNumber") setBrand(e.brand && e.brand !== "unknown" ? e.brand : null);
          });
          made[f] = el;
          mounted.push(el);
        }
        stripe.current = { stripe: s, number: made.cardNumber };
        setState("ready");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
      mounted.forEach((m) => m.destroy());
      stripe.current = null;
    };
  }, []);

  async function payNow() {
    const e: typeof errors = {};
    if (!name.trim()) e.name = t("required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) e.email = t("emailInvalid");
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.request<PayResponse>(`${base}/billing/invoices/${invoice.id}/pay`, { method: "POST", body: {} });
      const s = stripe.current;
      // ไม่ได้ตั้งกุญแจผู้ให้บริการ (โหมดพัฒนา) → รอสถานะจาก API อย่างเดียว
      if (s && r.card) {
        const res = await s.stripe.confirmCardPayment(r.card.clientSecret, { payment_method: { card: s.number, billing_details: { name: name.trim(), email: email.trim() } } });
        if (res.error) {
          setProblem(res.error.message ?? tc("failed"));
          return;
        }
      }
      setWaiting(true);
      await refresh();
    } catch (err) {
      setProblem(err);
    } finally {
      setBusy(false);
    }
  }

  const vat = invoice.vat > 0;
  const field = (f: Field, label: string, extra?: string) => (
    <div className={cn("field", f === "cardNumber" && styles.full)}>
      <label id={`${f}-label`}>{label}</label>
      <div className={cn(styles.stripeBox, fieldError[f] && styles.stripeBad)}>
        <div ref={(el) => void (boxes.current[f] = el)} className={styles.stripeMount} aria-labelledby={`${f}-label`} data-testid={`stripe-${f}`} />
        {f === "cardNumber" && brand && <span className={styles.brand}>{brand.toUpperCase()}</span>}
        {extra && <span className={styles.hint}>{extra}</span>}
      </div>
      {fieldError[f] && (
        <span className="field-error" role="alert">
          {fieldError[f]}
        </span>
      )}
    </div>
  );

  return (
    <>
      <Step n={1} id="pay-step-1" title={t("cardStep")}>
        <div className={styles.brands} aria-hidden="true">
          {["VISA", "Mastercard", "JCB", "AMEX"].map((b) => (
            <span key={b} className={styles.brand}>
              {b}
            </span>
          ))}
        </div>
        {state === "none" && <span className={cn(styles.note)}>{tc("testMode")}</span>}
        {state === "error" && (
          <span className="field-error" role="alert">
            {tc("unavailable")}
          </span>
        )}
        <div className={styles.cardGrid} hidden={state === "none" || state === "error"}>
          {field("cardNumber", t("cardNumber"))}
          {field("cardExpiry", t("cardExpiry"))}
          {field("cardCvc", t("cardCvc"), t("cardCvcHint"))}
        </div>
        <div className={styles.cardGrid}>
          <div className={styles.full}>
            <Input label={t("cardName")} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} autoComplete="cc-name" />
          </div>
          <div className={styles.full}>
            <Input label={t("cardEmail")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} hint={errors.email ? undefined : t("cardEmailHint")} autoComplete="email" />
          </div>
        </div>
        <span className={styles.hint}>{t("cardSecure")}</span>
      </Step>
      <Step n={2} id="pay-step-2" title={t("confirmStep")}>
        <div className={styles.sumRows}>
          <div>
            <span>{vat ? ts("priceNote") : ts("price")}</span>
            <span className={styles.mono}>฿{baht(invoice.subtotal)}</span>
          </div>
          {vat && (
            <div>
              <span className={styles.muted}>{ts("vat")}</span>
              <span className={styles.mono}>฿{baht(invoice.vat)}</span>
            </div>
          )}
          <div className={styles.sumDue}>
            <span>{t("chargeTotal")}</span>
            <span className={styles.mono}>฿{baht(invoice.amountDue)}</span>
          </div>
        </div>
        <Problem problem={problem} />
        {waiting && !problem ? (
          <span className={styles.waiting} role="status">
            <span className={styles.dot} aria-hidden="true" />
            {tc("waiting")}
          </span>
        ) : null}
        <Button variant="primary" className={styles.send} disabled={busy || state === "loading"} onClick={payNow}>
          {busy ? t("verifying") : t("payCard", { amount: `฿${baht(invoice.amountDue)}` })}
        </Button>
        <span className={styles.hint}>{t("autoRenew", { cycle: cycle === "yearly" ? t("year") : t("month") })}</span>
      </Step>
    </>
  );
}
