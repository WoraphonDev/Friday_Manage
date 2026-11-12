"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Lock, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorState, Forbidden, Input, LoadingState, Select, buttonVariants } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api, supportId } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PAID_PLANS, baht, fitPlan, isPaidPlan, type Cycle, type PaidPlan, type PublicPlans, type Usage } from "@/features/plan-limits";
import type { BillingProfile, CheckoutResult, Invoice, Method, Quote, QuoteDiscount } from "../../../app/work/[ws]/billing/_components/types";
import { useQrDataUrl } from "./qr";
import { loadStripe, type StripeCardElement, type StripeLike } from "./stripe";
import styles from "./checkout.module.css";

type Entity = "corp" | "person";
/** ผลที่ต้องชำระต่อ (มีรายการชำระ) · ไม่มียอดชำระ (คูปองใช้ฟรี) ไปหน้าชำระแล้วทันที */
type PayResult = CheckoutResult & { payment: NonNullable<CheckoutResult["payment"]> };
type Phase =
  | { kind: "form" }
  | { kind: "pending"; result: PayResult }
  | { kind: "done"; invoice: Invoice | (CheckoutResult["invoice"] & Partial<Invoice>); method: Method; free?: boolean };
interface Form {
  companyName: string;
  taxId: string;
  branchType: "head" | "branch";
  branchNo: string;
  address: string;
  taxEmail: string;
  poNumber: string;
}
/** ใบเสนอราคาจาก API (A35a เพิ่มสถานะจด VAT) */
type QuoteVat = Quote & { vatRegistered?: boolean; documentType?: "tax_invoice_receipt" | "receipt" };
const EMPTY: Form = { companyName: "", taxId: "", branchType: "head", branchNo: "", address: "", taxEmail: "", poNumber: "" };
const SLIP_MAX = 5 * 1024 * 1024;
/** poll สถานะใบแจ้งหนี้จน `paid` (Webhook ของผู้ให้บริการยืนยันฝั่ง API) · หน้าเปลี่ยนเองเมื่อเงินเข้า */
export const POLL_MS = 3000;
const METHODS: Method[] = ["promptpay", "card", "transfer"];

/** Idempotency-Key ใหม่ต่อการกดชำระหนึ่งครั้ง · ใช้ซ้ำเมื่อ retry หลังเครือข่ายล้มหรือ 5xx (A33) */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const todayIso = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
/** ช่วงที่ใช้ได้ถ้าจ่ายวันนี้ (ก่อนออกใบแจ้งหนี้จริง) · คูปองใช้ฟรี N เดือน = ใบนี้ครอบคลุม N เดือน */
const periodFrom = (cycle: Cycle, freeMonths?: number | null) => {
  const start = todayIso();
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + (freeMonths ? freeMonths : cycle === "yearly" ? 12 : 1));
  d.setUTCDate(d.getUTCDate() - 1);
  return { start, end: d.toISOString().slice(0, 10) };
};

/**
 * W22 · หน้าชำระเงินฝั่งลูกค้า (Checkout 4b)
 * 1. ข้อมูลออกใบกำกับภาษี + หัก ณ ที่จ่าย 3% (ปิดบัตร) · 2. วิธีชำระ PromptPay QR / บัตร / โอน + สลิป · สรุปยอดด้านขวา
 * ยังไม่จด VAT: ซ่อนบรรทัด VAT และเรียกเอกสารว่า "ใบเสร็จ" ตาม `quote.documentType`
 */
export function Checkout({ ws, initialPlan, initialCycle }: { ws: string; initialPlan?: string; initialCycle?: string }) {
  const t = useTranslations("checkout");
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const base = `/w/${encodeURIComponent(ws)}`;
  const home = `/work/${encodeURIComponent(ws)}`;
  const canBill = workspace.role === "owner" || workspace.role === "admin";

  const plans = useQuery({ queryKey: ["public-plans"], queryFn: () => api.get<PublicPlans>("/public/plans"), staleTime: 300_000, enabled: canBill });
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<Usage>(`${base}/usage`), enabled: canBill, retry: false });
  const profile = useQuery({ queryKey: ["billing-profile", ws], queryFn: () => api.get<{ profile: BillingProfile | null }>(`${base}/billing/profile`), enabled: canBill });

  const [plan, setPlan] = useState<PaidPlan | null>(isPaidPlan(initialPlan) ? initialPlan : null);
  const [cycle, setCycle] = useState<Cycle>(initialCycle === "yearly" ? "yearly" : "monthly");
  const [entity, setEntity] = useState<Entity>("corp");
  const [form, setForm] = useState<Form>(EMPTY);
  const [method, setMethod] = useState<Method>("promptpay");
  const [wht, setWht] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [slip, setSlip] = useState<File | null>(null);
  const [slipAmount, setSlipAmount] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // โค้ดส่วนลด (O20): coupon = โค้ดที่ส่งไปคิดยอด · couponInput = ที่พิมพ์อยู่ · couponError = ข้อความจาก API เมื่อใช้ไม่ได้
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const stripe = useRef<{ stripe: StripeLike; card: StripeCardElement } | null>(null);
  const prefilled = useRef(false);
  const onCardReady = useCallback((s: { stripe: StripeLike; card: StripeCardElement } | null) => {
    stripe.current = s;
  }, []);

  // กรอกข้อมูลภาษีเดิมครั้งแรกที่โหลดได้ · ไม่มี profile = นิติบุคคล (กรณีที่พบบ่อยของ B2B)
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
  const whtOn = entity === "corp" && wht;
  // หัก ณ ที่จ่าย = ตัดบัตรเต็มยอดไม่ได้ จึงย้ายไป PromptPay ให้
  const current: Method = whtOn && method === "card" ? "promptpay" : method;
  const locked = phase.kind === "pending";

  const quote = useQuery({
    queryKey: ["billing-quote", ws, selected, cycle, whtOn, coupon],
    queryFn: () => api.get<QuoteVat>(`${base}/billing/quote?plan=${selected}&cycle=${cycle}&wht=${whtOn}${coupon ? `&coupon=${encodeURIComponent(coupon)}` : ""}`),
    enabled: canBill && phase.kind === "form",
    placeholderData: keepPreviousData,
  });
  // โค้ดใช้ไม่ได้ (หมดอายุ / ไม่ตรงแพ็กเกจ ฯลฯ): บอกเหตุผลใต้ช่องโค้ด แล้วคิดยอดใหม่แบบไม่มีโค้ด แทนการแสดง error ทั้งกล่อง
  const couponFailed = quote.error instanceof ApiError && quote.error.code.startsWith("coupon_");
  useEffect(() => {
    if (!couponFailed || !coupon) return;
    setCouponError((quote.error as ApiError).message);
    setCoupon(null);
    key.current = null;
  }, [couponFailed, coupon, quote.error]);
  // จำส่วนลดของใบเสนอราคาล่าสุดไว้แสดงชื่อโค้ดระหว่างรอชำระ (ใบแจ้งหนี้มีแค่ยอดส่วนลดรวม)
  const lastDiscounts = useRef<QuoteDiscount[]>([]);
  if (quote.data && !quote.isPlaceholderData) lastDiscounts.current = quote.data.discounts ?? [];
  const vatRegistered = quote.data?.vatRegistered !== false;
  const lastVat = useRef(vatRegistered);
  if (quote.data) lastVat.current = vatRegistered;

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

  if (!canBill)
    return (
      <div className={styles.page}>
        <Forbidden />
      </div>
    );
  const firstError = [plans, profile].find((q) => q.error)?.error;
  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    if (!code) return;
    key.current = null;
    setCouponError(null);
    setCoupon(code);
  };
  const removeCoupon = () => {
    key.current = null;
    setCoupon(null);
    setCouponInput("");
    setCouponError(null);
  };
  if (firstError)
    return (
      <div className={styles.page}>
        {firstError instanceof ApiError && firstError.status === 403 ? (
          <Forbidden />
        ) : (
          <ErrorState
            error={firstError}
            retry={() => {
              void plans.refetch();
              void profile.refetch();
            }}
          />
        )}
      </div>
    );
  if (plans.isPending || profile.isPending)
    return (
      <div className={styles.page}>
        <LoadingState />
      </div>
    );

  // เปลี่ยนรายละเอียดที่ส่งไปชำระ = คำขอใหม่ จึงล้าง key (key เดิมกับข้อมูลต่างกัน API ตอบ 422)
  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
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

  async function confirmCard(result: PayResult) {
    const s = stripe.current;
    // ไม่ได้ตั้งกุญแจผู้ให้บริการ (โหมดพัฒนา) → รอสถานะจาก API อย่างเดียว
    if (!s || !result.card) return;
    const r = await s.stripe.confirmCardPayment(result.card.clientSecret, {
      payment_method: { card: s.card, billing_details: { name: form.companyName.trim(), email: form.taxEmail.trim() } },
    });
    if (r.error) setProblem(r.error.message ?? t("card.failed"));
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
        body: { plan: selected, cycle, method: current, wht: whtOn, ...(form.poNumber.trim() ? { poNumber: form.poNumber.trim() } : {}), ...(coupon ? { coupon } : {}) },
      });
      // ได้ผลแล้ว: กดชำระครั้งต่อไปคือการชำระใหม่
      key.current = null;
      // ไม่มียอดชำระ (ใช้ฟรี N เดือน / ส่วนลดเต็มจำนวน): ใบแจ้งหนี้ชำระแล้วทันที ไม่ต้องเลือกวิธีชำระ
      if (result.free || !result.payment) {
        setPhase({ kind: "done", invoice: result.invoice, method: current, free: true });
        void cache.invalidateQueries({ queryKey: ["usage", ws] });
        return;
      }
      setPhase({ kind: "pending", result: result as PayResult });
      if (current === "card") await confirmCard(result as PayResult);
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

  async function sendSlip(result: PayResult) {
    if (!slip) return;
    if (slip.size > SLIP_MAX) {
      setProblem(t("transfer.tooLarge"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const body = new FormData();
      body.append("file", slip);
      // ยอดที่ลูกค้าบอก (สตางค์) ให้ API เทียบกับใบแจ้งหนี้ (A35a) · ไม่กรอกก็ส่งได้
      const declared = Math.round(Number(slipAmount.replace(/,/g, "")) * 100);
      if (slipAmount.trim() && declared > 0) body.append("amount", String(declared));
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
    if (latest.data && latest.data.status !== "paid") setProblem(r.payment.method === "promptpay" ? t("qr.notYet") : t("card.waiting"));
  }

  const planName = selectedSpec?.name ?? selected;
  if (phase.kind === "done") return <Done ws={ws} phase={phase} planName={planName} seats={seats} email={form.taxEmail.trim()} vatRegistered={lastVat.current} whtOn={whtOn} />;

  // ระหว่างคิดยอดใหม่หลังโค้ดใช้ไม่ได้ ไม่ใช้ข้อมูลของคำขอที่ล้ม
  const q = pending || couponFailed ? null : (quote.data ?? null);
  const amounts = pending ? pending.invoice : (q ?? undefined);
  const freeMonths = q?.freeMonths ?? null;
  // ไม่มียอดชำระ: ไม่ต้องสร้าง QR / ตัดบัตร / ขอเลขบัญชี
  const freeQuote = !!q && (q.amountDue === 0 || !!freeMonths);
  const discountTotal = pending ? (pending.invoice.discount ?? 0) : (q?.discount ?? 0);
  const discountLines: QuoteDiscount[] = pending ? lastDiscounts.current : (q?.discounts ?? []);
  const listPrice = pending ? pending.invoice.subtotal + discountTotal : (q?.listPrice ?? (q ? q.subtotal + discountTotal : 0));
  const pay = amounts ? `฿${baht(amounts.amountDue)}` : "–";
  const expiresIn = pending?.promptpay ? Math.max(0, Date.parse(pending.promptpay.expiresAt) - now) : 0;
  const expired = !!pending?.promptpay && expiresIn <= 0;
  const payMethod = pending?.payment.method ?? current;
  const payLabel = !pending
    ? freeQuote
      ? freeMonths
        ? t("coupon.startFree", { n: freeMonths })
        : t("coupon.confirmFree")
      : { promptpay: t("qr.create"), card: t("card.pay", { amount: pay }), transfer: t("transfer.request") }[current]
    : { promptpay: t("qr.check"), card: t("card.pay", { amount: pay }), transfer: t("transfer.send") }[pending.payment.method];
  const problemText = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : null;
  const receipt = !vatRegistered;
  const period = pending ? { start: pending.invoice.periodStart, end: pending.invoice.periodEnd } : periodFrom(cycle, freeMonths);

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>
            {t("title", { plan: planName })}
            <span className={cn(styles.pill, styles.pillWait)}>{t("status.unpaid")}</span>
          </h1>
          <div className={styles.sub}>{pending ? t("invoiceLine", { number: pending.invoice.number, date: formatDate(pending.invoice.dueDate, "BE", true) }) : t("draftLine")}</div>
        </div>
        <span className={styles.secure}>
          <Lock size={14} aria-hidden="true" />
          {t("secure")}
        </span>
      </div>
      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={cn(styles.card, styles.section)} aria-labelledby="co-tax">
            <div className={styles.sectionHead}>
              <span className={styles.num}>1</span>
              <h2 id="co-tax">{receipt ? t("tax.titleReceipt") : t("tax.title")}</h2>
              {profile.data?.profile && <span className={cn(styles.muted, styles.small)}>{t("tax.reuse")}</span>}
            </div>
            <div className={styles.seg} role="group" aria-label={t("tax.entity")}>
              {(["corp", "person"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-pressed={entity === e}
                  disabled={locked}
                  onClick={() => {
                    change(setEntity)(e);
                    if (e === "person") setWht(false);
                  }}
                >
                  {t(`tax.${e}`)}
                </button>
              ))}
            </div>
            <div className={styles.grid}>
              <Input label={entity === "corp" ? t("tax.companyName") : t("tax.personName")} value={form.companyName} onChange={setField("companyName")} error={errors.companyName} disabled={locked} autoComplete={entity === "corp" ? "organization" : "name"} />
              <Input label={t("tax.taxId")} className={styles.mono} inputMode="numeric" maxLength={13} value={form.taxId} onChange={setField("taxId")} error={errors.taxId} disabled={locked} />
              {entity === "corp" && (
                <Select label={t("tax.branch")} value={form.branchType} onChange={setField("branchType")} disabled={locked}>
                  <option value="head">{t("tax.head")}</option>
                  <option value="branch">{t("tax.branchOption")}</option>
                </Select>
              )}
              {entity === "corp" && form.branchType === "branch" && <Input label={t("tax.branchNo")} className={styles.mono} inputMode="numeric" maxLength={5} value={form.branchNo} onChange={setField("branchNo")} error={errors.branchNo} disabled={locked} />}
              <Input label={receipt ? t("tax.emailReceipt") : t("tax.email")} type="email" value={form.taxEmail} onChange={setField("taxEmail")} error={errors.taxEmail} disabled={locked} autoComplete="email" />
              <div className={styles.full}>
                <Input label={entity === "corp" ? t("tax.address") : t("tax.addressPerson")} value={form.address} onChange={setField("address")} error={errors.address} disabled={locked} autoComplete="street-address" />
              </div>
              <Input label={t("tax.po")} placeholder={t("tax.optional")} maxLength={50} value={form.poNumber} onChange={setField("poNumber")} disabled={locked} />
            </div>
            <div className={styles.wht}>
              <button type="button" role="switch" className={styles.switch} aria-checked={whtOn} aria-label={t("tax.wht")} disabled={locked || entity === "person"} onClick={() => change(setWht)(!wht)} />
              <span>
                <b>{t("tax.wht")}</b>
                <span className={cn(styles.muted, styles.small)}>{entity === "person" ? t("tax.whtPerson") : t("tax.whtHint")}</span>
              </span>
            </div>
          </section>

          <section className={cn(styles.card, styles.section)} aria-labelledby="co-pay">
            <div className={styles.sectionHead}>
              <span className={styles.num}>2</span>
              <h2 id="co-pay">{t("pay.title")}</h2>
              <span className={cn(styles.muted, styles.small)}>{t("pay.sub")}</span>
            </div>
            <div className={styles.methods} role="radiogroup" aria-label={t("pay.title")}>
              {METHODS.map((m) => {
                const blocked = m === "card" && whtOn;
                const tag = { promptpay: [t("pay.promptpayTag"), styles.pillPrimary], card: [t("pay.cardTag"), ""], transfer: [t("pay.transferTag"), ""] }[m];
                return (
                  <button key={m} type="button" role="radio" className={styles.method} aria-checked={payMethod === m} disabled={locked || blocked} onClick={() => change(setMethod)(m)}>
                    <span className={styles.rd} aria-hidden="true" />
                    <span className={styles.text}>
                      <b>{t(`pay.${m}`)}</b>
                      <small>{blocked ? t("pay.cardBlocked") : t(`pay.${m}Desc`)}</small>
                    </span>
                    <span className={cn(styles.pill, tag[1])}>{tag[0]}</span>
                  </button>
                );
              })}
            </div>

            {freeQuote && <div className={cn(styles.panel, styles.muted, styles.small)}>{freeMonths ? t("coupon.freeNote", { n: freeMonths }) : t("coupon.zeroNote")}</div>}

            {!freeQuote && payMethod === "promptpay" &&
              (pending?.promptpay ? (
                <PromptPayPanel number={pending.invoice.number} payload={pending.promptpay.qrPayload} amount={pay} expiresIn={expiresIn} />
              ) : (
                <div className={cn(styles.panel, styles.muted, styles.small)}>{t("qr.before")}</div>
              ))}

            {!freeQuote && payMethod === "card" && (
              <div className={styles.panel}>
                <CardField onReady={onCardReady} />
                <span className={styles.small}>{t("card.auto")}</span>
                <span className={cn(styles.muted, styles.small)}>{t("card.note")}</span>
              </div>
            )}

            {!freeQuote && payMethod === "transfer" &&
              (pending?.transfer ? (
                <TransferPanel base={base} result={pending} slip={slip} setSlip={setSlip} slipAmount={slipAmount} setSlipAmount={setSlipAmount} />
              ) : (
                <div className={cn(styles.panel, styles.muted, styles.small)}>{t("transfer.before")}</div>
              ))}
          </section>
        </div>

        <aside className={cn(styles.card, styles.aside)} aria-label={t("summary.title")}>
          <h2>{t("summary.title")}</h2>
          <div className={styles.planRow}>
            <span className={styles.planMark} aria-hidden="true">
              {planName.replace(/^Team\s*/, "").slice(0, 1) || "T"}
            </span>
            <span>
              <b>
                {planName} · {cycle === "yearly" ? t("summary.yearlyShort") : t("summary.monthly")}
              </b>
              <div className={cn(styles.muted, styles.small)}>{t("summary.seats", { n: seats, from: formatDate(period.start, "BE", true), to: formatDate(period.end, "BE", true) })}</div>
            </span>
          </div>
          {!locked && (
            <div className={styles.grid} style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Select label={t("summary.plan")} value={selected} onChange={(e) => change(setPlan)(e.target.value as PaidPlan)}>
                {PAID_PLANS.filter((c) => paidPlans.some((p) => p.code === c)).map((c) => (
                  <option key={c} value={c}>
                    {paidPlans.find((p) => p.code === c)?.name ?? c}
                  </option>
                ))}
              </Select>
              <Select label={t("summary.cycle")} value={cycle} onChange={(e) => change(setCycle)(e.target.value as Cycle)}>
                <option value="monthly">{t("summary.monthly")}</option>
                <option value="yearly">{t("summary.yearly", { months: plans.data?.yearlyMonths ?? 10 })}</option>
              </Select>
            </div>
          )}
          {selectedSpec && selectedSpec.seatLimit !== null && seats > selectedSpec.seatLimit && <div className={cn(styles.warn, styles.small)}>{t("summary.teamOver", { n: seats, plan: planName, limit: selectedSpec.seatLimit })}</div>}
          {!amounts ? (
            quote.error && !couponFailed ? (
              <ErrorState error={quote.error} retry={() => quote.refetch()} />
            ) : (
              <LoadingState />
            )
          ) : (
            <>
              {q?.grandfathered && <div className={cn(styles.muted, styles.small)}>{t("coupon.grandfathered")}</div>}
              {discountTotal > 0 && (
                <>
                  <div className={styles.sr}>
                    <span>{t("summary.price")}</span>
                    <span>฿{baht(listPrice)}</span>
                  </div>
                  {discountLines.length > 0 ? (
                    discountLines.map((d) => (
                      <div key={d.code} className={cn(styles.sr, styles.minus)}>
                        <span>
                          {t("coupon.line", { code: d.code })}
                          {d.kind !== "free_months" && (d.cyclesLeft === null ? ` · ${t("coupon.forever")}` : d.cyclesLeft > 0 ? ` · ${t("coupon.cyclesLeft", { n: d.cyclesLeft })}` : "")}
                        </span>
                        <span>−฿{baht(d.amount)}</span>
                      </div>
                    ))
                  ) : (
                    <div className={cn(styles.sr, styles.minus)}>
                      <span>{t("coupon.lineGeneric")}</span>
                      <span>−฿{baht(discountTotal)}</span>
                    </div>
                  )}
                </>
              )}
              <div className={styles.sr}>
                <span>{receipt ? (discountTotal > 0 ? t("coupon.afterDiscount") : t("summary.price")) : t("summary.priceNote")}</span>
                <span>฿{baht(amounts.subtotal)}</span>
              </div>
              {!receipt && (
                <div className={styles.sr}>
                  <span>{t("summary.vat")}</span>
                  <span>฿{baht(amounts.vat)}</span>
                </div>
              )}
              {!receipt && (
                <div className={cn(styles.sr, styles.total)}>
                  <span>{t("summary.taxTotal")}</span>
                  <span>฿{baht(amounts.total)}</span>
                </div>
              )}
              {amounts.whtAmount > 0 && (
                <div className={cn(styles.sr, styles.minus)}>
                  <span>{t("summary.wht")}</span>
                  <span>−฿{baht(amounts.whtAmount)}</span>
                </div>
              )}
              <div className={cn(styles.sr, styles.due)}>
                <span>{t("summary.due")}</span>
                <span>{pay}</span>
              </div>
            </>
          )}
          {!locked && (
            <div className={styles.coupon}>
              {coupon && q?.coupon ? (
                <span className={cn(styles.pill, styles.pillTeal)}>
                  {t("coupon.applied", { code: q.coupon })}
                  <button type="button" className={styles.pillX} aria-label={t("coupon.remove", { code: q.coupon })} onClick={removeCoupon}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ) : (
                <form
                  className={styles.couponRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    applyCoupon();
                  }}
                >
                  <input
                    className={cn("input", styles.mono)}
                    aria-label={t("coupon.label")}
                    placeholder={t("coupon.placeholder")}
                    maxLength={32}
                    value={couponInput}
                    aria-invalid={couponError ? true : undefined}
                    aria-describedby={couponError ? "coupon-error" : undefined}
                    onChange={(e) => {
                      setCouponInput(e.target.value);
                      setCouponError(null);
                    }}
                  />
                  <Button type="submit" disabled={!couponInput.trim() || (!!coupon && quote.isFetching)}>
                    {t("coupon.apply")}
                  </Button>
                </form>
              )}
              {couponError && (
                <span id="coupon-error" role="alert" className={cn(styles.warn, styles.small)}>
                  {couponError}
                </span>
              )}
            </div>
          )}
          {problemText && (
            <div role="alert" className={styles.problem}>
              {problemText}
              {problem instanceof ApiError && supportId(problem) && <div className={styles.mono}>{t("summary.requestId", { id: supportId(problem) ?? "" })}</div>}
            </div>
          )}
          {expired ? (
            <Button variant="primary" className={styles.payBtn} onClick={() => setPhase({ kind: "form" })}>
              {t("qr.renew")}
            </Button>
          ) : (
            <Button variant="primary" className={styles.payBtn} disabled={busy || !amounts || (pending?.payment.method === "transfer" && !slip)} onClick={primary}>
              {busy ? t("summary.processing") : payLabel}
            </Button>
          )}
          {pending && (
            <Button
              variant="ghost"
              onClick={() => {
                setProblem(null);
                setPhase({ kind: "form" });
              }}
            >
              {t("summary.edit")}
            </Button>
          )}
          <ul className={styles.bullets}>
            <li>{receipt ? t("summary.receiptNow") : t("summary.taxDocNow")}</li>
            <li>{t("summary.renew")}</li>
            <li>{t("summary.help")}</li>
          </ul>
          <div className={cn(styles.muted, styles.small)}>
            {t.rich("summary.terms", {
              terms: (c) => (
                <Link href="/legal/terms" target="_blank">
                  {c}
                </Link>
              ),
              dpa: (c) => (
                <Link href="/legal/dpa" target="_blank">
                  {c}
                </Link>
              ),
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** ช่องบัตรของผู้ให้บริการ (iframe) · ไม่ได้ตั้งกุญแจ = บอกว่าเป็นโหมดทดสอบ */
function CardField({ onReady }: { onReady: (s: { stripe: StripeLike; card: StripeCardElement } | null) => void }) {
  const t = useTranslations("checkout.card");
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
      <label>{t("field")}</label>
      <div ref={box} className={styles.cardBox} data-testid="stripe-card" hidden={state !== "ready"} />
      {state === "loading" && <div className={cn(styles.cardBox, styles.muted)}>{t("loading")}</div>}
      {state === "none" && <div className={cn(styles.muted, styles.small)}>{t("testMode")}</div>}
      {state === "error" && (
        <div className={cn(styles.warn, styles.small)} role="alert">
          {t("unavailable")}
        </div>
      )}
      {cardError && (
        <span className="field-error" role="alert">
          {cardError}
        </span>
      )}
    </div>
  );
}

function PromptPayPanel({ number, payload, amount, expiresIn }: { number: string; payload: string; amount: string; expiresIn: number }) {
  const t = useTranslations("checkout.qr");
  const qr = useQrDataUrl(payload);
  const mm = Math.floor(expiresIn / 60000);
  const ss = Math.floor((expiresIn % 60000) / 1000);
  return (
    <div className={cn(styles.panel, styles.qrRow)}>
      <div className={styles.qr}>{qr ? <img src={qr} alt={t("alt", { amount })} /> : t("loading")}</div>
      <div className={styles.qrText}>
        <b>{t("title")}</b>
        <span className={styles.muted}>{t("hint")}</span>
        <span className={styles.qrAmount}>{amount}</span>
        {expiresIn > 0 && (
          <span className={styles.waiting} role="status">
            <span className={styles.dot} aria-hidden="true" />
            {t("waiting")}
          </span>
        )}
        <span className={styles.muted} role="timer" aria-live="off">
          {expiresIn > 0 ? t("expires", { time: `${mm}:${String(ss).padStart(2, "0")}` }) : t("expired")}
        </span>
        {qr && expiresIn > 0 && (
          <a className={cn(buttonVariants({ size: "small" }))} style={{ alignSelf: "flex-start" }} href={qr} download={`promptpay-${number}.svg`}>
            {t("save")}
          </a>
        )}
      </div>
    </div>
  );
}

function CopyValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const t = useTranslations("checkout.transfer");
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className={styles.label}>{label}</div>
      <div className={styles.copyRow}>
        <b className={mono ? styles.mono : undefined}>{value}</b>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`${t("copy")} ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
    </div>
  );
}

/** โอนเข้าบัญชี: เลขบัญชี + เลขอ้างอิง (คัดลอกได้) · ใบแจ้งหนี้ PDF · แนบสลิปพร้อมยอดที่โอน */
function TransferPanel({ base, result, slip, setSlip, slipAmount, setSlipAmount }: { base: string; result: CheckoutResult; slip: File | null; setSlip: (f: File | null) => void; slipAmount: string; setSlipAmount: (v: string) => void }) {
  const t = useTranslations("checkout.transfer");
  const tr = result.transfer!;
  return (
    <div className={styles.panel}>
      <div className={styles.bank}>
        <CopyValue label={t("bank")} value={tr.bank} />
        <CopyValue label={t("accountName")} value={tr.accountName} />
        <CopyValue label={t("accountNo")} value={tr.accountNo} mono />
        <CopyValue label={t("reference")} value={tr.reference} mono />
        <div>
          <div className={styles.label}>{t("amount")}</div>
          <b>฿{baht(tr.amount)}</b>
        </div>
        <div>
          <div className={styles.label}>{t("dueDate")}</div>
          <b>{formatDate(tr.dueDate, "BE", true)}</b>
        </div>
      </div>
      <a href={`/api/v1${base}/billing/invoices/${result.invoice.id}.pdf`} target="_blank" rel="noreferrer" className={styles.small}>
        {t("invoicePdf", { number: result.invoice.number })}
      </a>
      <b className={styles.small}>{t("already")}</b>
      <span className={cn(styles.muted, styles.small)}>{t("alreadyHint")}</span>
      <div className={styles.grid}>
        <div className="field">
          <label htmlFor="slip">{t("slip")}</label>
          <div className={styles.drop}>
            <input id="slip" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setSlip(e.target.files?.[0] ?? null)} />
            <span className={styles.muted}>{slip ? slip.name : t("slipHint")}</span>
          </div>
        </div>
        <Input label={t("slipAmount")} hint={t("slipAmountHint")} inputMode="decimal" value={slipAmount} onChange={(e) => setSlipAmount(e.target.value)} />
      </div>
    </div>
  );
}

/** ชำระแล้ว: ต่ออายุทันที · แจ้งว่าส่ง e-Tax / ใบเสร็จทางอีเมลแล้ว · สลิปรอตรวจ = ใช้งานได้ทันที */
function Done({ ws, phase, planName, seats, email, vatRegistered, whtOn }: { ws: string; phase: Extract<Phase, { kind: "done" }>; planName: string; seats: number; email: string; vatRegistered: boolean; whtOn: boolean }) {
  const t = useTranslations("checkout.done");
  const ts = useTranslations("checkout.status");
  const f = useFormatter();
  const home = `/work/${encodeURIComponent(ws)}`;
  const inv = phase.invoice;
  const review = inv.status === "pending_review";
  const paidAt = inv.paidAt ? f.dateTime(new Date(inv.paidAt), { timeStyle: "medium" }) : f.dateTime(new Date(), { timeStyle: "medium" });
  const doc = inv.taxDocument?.pdfUrl ?? null;
  return (
    <div className={styles.page}>
      <section className={cn(styles.card, styles.done)} aria-labelledby="done-title">
        <span className={cn(styles.pill, review ? styles.pillWait : styles.pillOk)}>{review ? ts("review") : ts("paid")}</span>
        <h1 id="done-title">{review ? t("review") : t("paid")}</h1>
        <div className={styles.muted}>{review ? t("reviewVia") : phase.free ? t("freeVia") : t(`via.${phase.method}`, { time: paidAt })}</div>
        <ul>
          <li>{t("plan", { plan: planName, seats, date: formatDate(inv.periodEnd, "BE", true) })}</li>
          {phase.free ? <li>{t("freeUntil", { date: formatDate(inv.periodEnd, "BE", true) })}</li> : null}
          {email && !phase.free && <li>{review ? (vatRegistered ? t("taxDocLater", { email }) : t("receiptLater", { email })) : vatRegistered ? t("taxDoc", { email }) : t("receipt", { email })}</li>}
          {whtOn && <li>{t("wht")}</li>}
        </ul>
        <div className={styles.row}>
          {doc ? (
            <a className={buttonVariants()} href={doc} target="_blank" rel="noreferrer">
              {vatRegistered ? t("download") : t("downloadReceipt")}
            </a>
          ) : (
            inv.pdfUrl && (
              <a className={buttonVariants()} href={inv.pdfUrl} target="_blank" rel="noreferrer">
                {t("invoice")}
              </a>
            )
          )}
          <Link className={buttonVariants({ variant: "primary" })} href={home}>
            {t("back")}
          </Link>
          <Link className={buttonVariants({ variant: "ghost" })} href={`${home}/billing`}>
            {t("billing")}
          </Link>
        </div>
      </section>
    </div>
  );
}
