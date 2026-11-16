"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, CountUp, ErrorState, Forbidden, Input, LoadingState, MotionSwap, Select, buttonVariants } from "@/components/ui";
import { useSlidingIndicator } from "@/lib/motion";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api, supportId } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PAID_PLANS, baht, fitPlan, isPaidPlan, type Cycle, type PaidPlan, type PublicPlans, type Usage } from "@/features/plan-limits";
import type { BillingProfile, CheckoutResult, Invoice, Method, Quote, QuoteDiscount } from "../../../app/work/[ws]/billing/_components/types";
import styles from "./checkout.module.css";

type Entity = "corp" | "person";
/** ไม่มียอดชำระ (คูปองใช้ฟรี) จบที่หน้านี้ · มียอดชำระไปหน้าชำระใบแจ้งหนี้ (InvoicePay) ทุกวิธี */
type Phase = { kind: "form" } | { kind: "done"; invoice: Invoice | (CheckoutResult["invoice"] & Partial<Invoice>); method: Method; free?: boolean };
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
type QuoteVat = Quote & {
  vatRegistered?: boolean;
  documentType?: "tax_invoice_receipt" | "receipt";
  /** O41 · R5–R6: อัปเกรดกลางรอบคิดส่วนต่าง · ลดแพ็กเกจ / เปลี่ยนรอบมีผลรอบถัดไป */
  change?:
    | { kind: "new" }
    | { kind: "upgrade"; fromPlan: string; effectiveAt: string; proration: { left: number; total: number; newPartSatang: number; oldPartSatang: number; diffSatang: number } }
    | { kind: "next_cycle"; reason: "cycle" | "downgrade"; effectiveAt: string };
  /** เครดิตคงเหลือที่หักใบนี้ · payNowSatang = ยอดที่ต้องชำระหลังหักเครดิต */
  credit?: { balanceSatang: number; applySatang: number };
  payNowSatang?: number;
};
const EMPTY: Form = { companyName: "", taxId: "", branchType: "head", branchNo: "", address: "", taxEmail: "", poNumber: "" };
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
 * 1. ข้อมูลออกใบกำกับภาษี + หัก ณ ที่จ่าย 3% (ปิดบัตร) · 2. เลือกวิธีชำระ PromptPay QR / บัตร / โอน · สรุปยอดด้านขวา
 * กดปุ่มแล้วออกใบแจ้งหนี้และไปหน้าชำระใบแจ้งหนี้ (InvoicePay) ของใบนั้นทุกวิธี: QR / ฟอร์มบัตร / เลขบัญชีอยู่ที่หน้านั้น
 * (ผู้ใช้เลือกจาก storyboard 16 พ.ย. 2026 · design/proposals/billing)
 * ยังไม่จด VAT: ซ่อนบรรทัด VAT และเรียกเอกสารว่า "ใบเสร็จ" ตาม `quote.documentType`
 */
export function Checkout({ ws, initialPlan, initialCycle }: { ws: string; initialPlan?: string; initialCycle?: string }) {
  const t = useTranslations("checkout");
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const router = useRouter();
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
  // โค้ดส่วนลด (O20): coupon = โค้ดที่ส่งไปคิดยอด · couponInput = ที่พิมพ์อยู่ · couponError = ข้อความจาก API เมื่อใช้ไม่ได้
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const prefilled = useRef(false);
  // ตัวเลือกทีละอัน (นิติบุคคล / บุคคล · วิธีชำระ): พื้น / กรอบของตัวที่เลือกเลื่อนตาม
  const entityRef = useSlidingIndicator<HTMLDivElement>("button");
  const methodRef = useSlidingIndicator<HTMLDivElement>("button");

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
  // ระหว่างออกใบแจ้งหนี้ล็อกช่องไว้ (กันแก้ข้อมูลหลังกดแล้ว)
  const locked = busy;

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
  const vatRegistered = quote.data?.vatRegistered !== false;
  const lastVat = useRef(vatRegistered);
  if (quote.data) lastVat.current = vatRegistered;

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
      // ไปหน้าของใบแจ้งหนี้: QR / ฟอร์มบัตร / เลขบัญชี + แนบสลิป · กลับมาจ่ายทีหลังได้จาก URL นี้
      void cache.invalidateQueries({ queryKey: ["billing-invoices", ws] });
      router.push(`${home}/billing/invoices/${result.invoice.id}`);
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

  const planName = selectedSpec?.name ?? selected;
  if (phase.kind === "done") return <Done ws={ws} phase={phase} planName={planName} seats={seats} email={form.taxEmail.trim()} vatRegistered={lastVat.current} whtOn={whtOn} />;

  // ระหว่างคิดยอดใหม่หลังโค้ดใช้ไม่ได้ ไม่ใช้ข้อมูลของคำขอที่ล้ม
  const q = couponFailed ? null : (quote.data ?? null);
  const amounts = q ?? undefined;
  const freeMonths = q?.freeMonths ?? null;
  const upgrade = q?.change?.kind === "upgrade" ? q.change : null;
  const scheduled = q?.change?.kind === "next_cycle" ? q.change : null;
  const creditUse = q?.credit?.applySatang ?? 0;
  const payNow = q ? (q.payNowSatang ?? q.amountDue) : 0;
  // ไม่มียอดชำระ (คูปอง / เครดิตพอทั้งใบ): ไม่ต้องสร้าง QR / ตัดบัตร / ขอเลขบัญชี
  const freeQuote = !!q && (payNow === 0 || !!freeMonths);
  const discountTotal = q?.discount ?? 0;
  const discountLines: QuoteDiscount[] = q?.discounts ?? [];
  const listPrice = q?.listPrice ?? (q ? q.subtotal + discountTotal : 0);
  const pay = amounts ? `฿${baht(payNow)}` : "–";
  const payMethod = current;
  const payLabel = freeQuote
    ? freeMonths
      ? t("coupon.startFree", { n: freeMonths })
      : creditUse > 0
        ? t("credit.confirm")
        : t("coupon.confirmFree")
    : { promptpay: t("qr.create"), card: t("card.next"), transfer: t("transfer.request") }[current];
  // ใบเสนอราคาของตัวเลือกตอนนี้ (ฝ่ายจัดซื้อใช้ออก PO ก่อนชำระ)
  const quotationHref = `/api/v1${base}/billing/quotation.pdf?plan=${selected}&cycle=${cycle}&wht=${whtOn}${coupon ? `&coupon=${encodeURIComponent(coupon)}` : ""}`;
  const problemText = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : null;
  const receipt = !vatRegistered;
  const period = periodFrom(cycle, freeMonths);

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>
            {t("title", { plan: planName })}
            <span className={cn(styles.pill, styles.pillWait)}>{t("status.unpaid")}</span>
          </h1>
          <div className={styles.sub}>{t("draftLine")}</div>
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
            <div ref={entityRef} className={cn(styles.seg, "motion-pill")} role="group" aria-label={t("tax.entity")}>
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
            <div ref={methodRef} className={cn(styles.methods, "motion-pill")} role="radiogroup" aria-label={t("pay.title")}>
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

            {/* เปลี่ยนวิธีชำระ = กล่องรายละเอียดชุดใหม่เคลื่อนเข้า (แสดงทีละกล่อง ห่อแล้วระยะห่างจึงเท่าเดิม) */}
            <MotionSwap key={freeQuote ? "free" : payMethod}>
            {freeQuote && <div className={cn(styles.panel, styles.muted, styles.small)}>{freeMonths ? t("coupon.freeNote", { n: freeMonths }) : creditUse > 0 ? t("credit.paidNote") : t("coupon.zeroNote")}</div>}

            {!freeQuote && payMethod === "promptpay" && <div className={cn(styles.panel, styles.muted, styles.small)}>{t("qr.before")}</div>}

            {!freeQuote && payMethod === "card" && (
              <div className={cn(styles.panel, styles.small)}>
                <span>{t("card.before")}</span>
                <span className={styles.muted}>{t("card.auto")}</span>
              </div>
            )}

            {!freeQuote && payMethod === "transfer" && <div className={cn(styles.panel, styles.muted, styles.small)}>{t("transfer.before")}</div>}
            </MotionSwap>
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
              {upgrade && (
                <>
                  <div className={styles.sr}>
                    <span>
                      {t("upgrade.newPart", { plan: planName })}
                      <small className={cn(styles.muted, styles.small)} style={{ display: "block" }}>{t("upgrade.days", { left: upgrade.proration.left, total: upgrade.proration.total })}</small>
                    </span>
                    <span>฿{baht(upgrade.proration.newPartSatang)}</span>
                  </div>
                  <div className={cn(styles.sr, styles.minus)}>
                    <span>{t("upgrade.oldPart")}</span>
                    <span>−฿{baht(upgrade.proration.oldPartSatang)}</span>
                  </div>
                </>
              )}
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
                <span>{upgrade ? t("upgrade.diff") : receipt ? (discountTotal > 0 ? t("coupon.afterDiscount") : t("summary.price")) : t("summary.priceNote")}</span>
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
              {creditUse > 0 && (
                <div className={cn(styles.sr, styles.minus)}>
                  <span>
                    {t("credit.line")}
                    <small className={cn(styles.muted, styles.small)} style={{ display: "block" }}>{t("credit.left", { from: baht(q?.credit?.balanceSatang ?? 0), to: baht((q?.credit?.balanceSatang ?? 0) - creditUse) })}</small>
                  </span>
                  <span>−฿{baht(creditUse)}</span>
                </div>
              )}
              <div className={cn(styles.sr, styles.due)}>
                <span>{t("summary.due")}</span>
                <span><CountUp value={pay} /></span>
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
            <div role="alert" className={cn(styles.problem, "motion-in")}>
              {problemText}
              {problem instanceof ApiError && supportId(problem) && <div className={styles.mono}>{t("summary.requestId", { id: supportId(problem) ?? "" })}</div>}
            </div>
          )}
          {upgrade && <div className={cn(styles.muted, styles.small)}>{t("upgrade.after", { date: formatDate(upgrade.effectiveAt, "BE", true) })}</div>}
          {scheduled ? (
            <ScheduleChange ws={ws} plan={selected} cycle={cycle} change={scheduled} planName={planName} />
          ) : (
            <Button variant="primary" className={styles.payBtn} disabled={busy || !amounts} onClick={startCheckout}>
              {busy ? t("summary.processing") : payLabel}
            </Button>
          )}
          {amounts && !freeQuote && (
            <a className={cn(buttonVariants({ variant: "ghost" }), styles.quoteLink)} href={quotationHref} target="_blank" rel="noreferrer">
              {t("summary.quotation")}
            </a>
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

/**
 * O41 · R6: ลดแพ็กเกจ / เปลี่ยนรอบบิลระหว่างรอบที่จ่ายแล้ว → ตั้งให้มีผลรอบถัดไป (ไม่มีเงินคืนรอบนี้)
 * แสดงสิ่งที่ต้องลดก่อนวันที่มีผล · ถึงวันนั้นยังเกิน ระบบคงแพ็กเกจเดิมอีก 1 รอบ
 */
function ScheduleChange({ ws, plan, cycle, change, planName }: { ws: string; plan: string; cycle: string; change: { reason: "cycle" | "downgrade"; effectiveAt: string }; planName: string }) {
  const t = useTranslations("checkout.schedule");
  const router = useRouter();
  const base = `/w/${encodeURIComponent(ws)}`;
  const [agree, setAgree] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post<{ pendingChange: { blockers: { key: "seats" | "projects"; used: number; limit: number }[] } }>(`${base}/billing/scheduled-change`, { plan, cycle }),
    onSuccess: () => router.push(`/work/${encodeURIComponent(ws)}/billing?scheduled=1`),
  });
  const date = formatDate(change.effectiveAt, "BE", true);
  return (
    <div className={cn(styles.panel, styles.small)} role="status">
      <b>{t(change.reason === "cycle" ? "titleCycle" : "title", { plan: planName, date })}</b>
      <span className={styles.muted}>{t("hint", { date })}</span>
      <label className={styles.agree}>
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>{t("agree", { date })}</span>
      </label>
      {save.error && <span role="alert">{save.error instanceof Error ? save.error.message : String(save.error)}</span>}
      <Button variant="primary" className={styles.payBtn} disabled={!agree || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t("saving") : t("submit")}
      </Button>
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
      <section className={cn(styles.card, styles.done, "motion-in")} aria-labelledby="done-title">
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
