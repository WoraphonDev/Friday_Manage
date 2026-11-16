"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileText, Upload } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorState, Forbidden, Input, LoadingState, buttonVariants } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api, supportId } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { baht } from "@/features/plan-limits";
import type { BillingProfile, InvoiceDetail, TransferInfo } from "../../../app/work/[ws]/billing/_components/types";
import { CardPay, QrPay } from "./pay-methods";
import styles from "./invoice-pay.module.css";

const SLIP_MAX = 5 * 1024 * 1024;
const SLIP_TYPES = ["image/png", "image/jpeg", "application/pdf"];
/** ยอดในช่องกรอก (สตางค์ → "9,800.00") · แปลงกลับด้วยการตัด comma */
const amountText = (satang: number) => (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** poll สถานะใบแจ้งหนี้บัตร / PromptPay ที่รอชำระ (Webhook ของผู้ให้บริการยืนยันฝั่ง API) · หน้าเปลี่ยนเองเมื่อเงินเข้า */
export const POLL_MS = 3000;
/** เวลาตอนนี้ในรูปแบบของช่อง datetime-local (เวลาเครื่องผู้ใช้) */
const localNow = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/**
 * W22b · หน้าชำระใบแจ้งหนี้ `/work/:ws/billing/invoices/:id` · ทุกวิธีชำระมาที่หน้านี้หลังออกใบแจ้งหนี้
 * แยกจากหน้าชำระเงินเพราะคนโอนมักออกไปแอปธนาคารหรือโอนวันหลัง จึงต้องมี URL กลับมาได้ (ผู้ใช้เลือกจาก storyboard 16 พ.ย. 2026)
 * โอน: ① บัญชีรับโอน ② แนบสลิป + ยอด + เวลาโอน · PromptPay: ① QR ② รอเงินเข้า · บัตร: ① ข้อมูลบัตร ② ยืนยันชำระ
 */
export function InvoicePay({ ws, id, replace = false }: { ws: string; id: string; replace?: boolean }) {
  const t = useTranslations("checkout.invoicePay");
  const tt = useTranslations("checkout.transfer");
  const ts = useTranslations("checkout.status");
  const td = useTranslations("checkout.done");
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const base = `/w/${encodeURIComponent(ws)}`;
  const home = `/work/${encodeURIComponent(ws)}`;
  const canBill = workspace.role === "owner" || workspace.role === "admin";

  const invoice = useQuery({
    queryKey: ["billing-invoice", ws, id],
    queryFn: () => api.get<InvoiceDetail>(`${base}/billing/invoices/${encodeURIComponent(id)}`),
    enabled: canBill,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === "open" && (q.state.data.method === "card" || q.state.data.method === "promptpay") ? POLL_MS : false),
  });
  const f = useFormatter();
  const profile = useQuery({ queryKey: ["billing-profile", ws], queryFn: () => api.get<{ profile: BillingProfile | null }>(`${base}/billing/profile`), enabled: canBill, retry: false });
  // แนบสลิปใหม่ระหว่างรอตรวจ (มาจากปุ่ม "แนบสลิปใหม่" ในหน้า Billing ได้ด้วย ?slip=new)
  const [replacing, setReplacing] = useState(replace);

  if (!canBill)
    return (
      <div className={styles.page}>
        <Forbidden />
      </div>
    );
  if (invoice.error)
    return (
      <div className={styles.page}>
        {invoice.error instanceof ApiError && invoice.error.status === 403 ? <Forbidden /> : <ErrorState error={invoice.error} retry={() => invoice.refetch()} />}
      </div>
    );
  if (invoice.isPending)
    return (
      <div className={styles.page}>
        <LoadingState />
      </div>
    );

  const inv = invoice.data;
  const tr = inv.transfer;
  const email = profile.data?.profile?.taxEmail ?? "";
  const vatRegistered = inv.vat > 0;
  const status = inv.status === "paid" ? ts("paid") : inv.status === "pending_review" ? ts("review") : inv.status === "void" ? t("voidTitle") : ts("unpaid");
  const statusClass = inv.status === "paid" ? styles.pillOk : inv.status === "pending_review" ? styles.pillInfo : inv.status === "void" ? undefined : styles.pillWait;
  const due = formatDate(inv.dueDate, "BE", true);
  const showForm = !!tr && (inv.status === "open" || (inv.status === "pending_review" && replacing));
  const online = inv.status === "open" && (inv.method === "card" || inv.method === "promptpay");
  const refresh = async () => {
    const latest = (await invoice.refetch()).data;
    if (latest?.status === "paid") void cache.invalidateQueries({ queryKey: ["usage", ws] });
    return latest;
  };
  const later = (
    <div className={styles.later}>
      <span>{t("later")}</span>
      <a href={inv.pdfUrl} target="_blank" rel="noreferrer">
        {tt("invoicePdf", { number: inv.number })}
      </a>
    </div>
  );

  const sent = (next: InvoiceDetail) => {
    cache.setQueryData(["billing-invoice", ws, id], next);
    setReplacing(false);
    void cache.invalidateQueries({ queryKey: ["usage", ws] });
    void cache.invalidateQueries({ queryKey: ["billing", ws] });
    void cache.invalidateQueries({ queryKey: ["billing-invoices", ws] });
  };

  return (
    <div className={styles.page}>
      {/* ปุ่มย้อนกลับมาจากกรอบหน้า (workspace shell) จึงไม่ทำซ้ำ */}
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1>
            {t("title", { number: inv.number })}
            <span className={cn(styles.pill, statusClass)}>{status}</span>
          </h1>
          <div className={styles.sub}>{inv.plan ? t("planLine", { plan: inv.plan.name, cycle: t(inv.plan.cycle), date: due }) : t("dueLine", { date: due })}</div>
        </div>
        {inv.status !== "void" && (
          <div className={styles.amount}>
            <span className={styles.muted}>{t("toPay")}</span>
            <b>฿{baht(inv.amountDue)}</b>
          </div>
        )}
      </div>

      {showForm && tr ? (
        <div className={cn(styles.steps, "motion-in")}>
          <BankCard tr={tr} />
          <SlipCard
            base={base}
            invoice={inv}
            onSent={sent}
            onCancel={inv.status === "pending_review" ? () => setReplacing(false) : undefined}
          />
          {later}
        </div>
      ) : online ? (
        <div className={cn(styles.steps, "motion-in")}>
          {inv.method === "promptpay" ? <QrPay base={base} invoice={inv} refresh={refresh} /> : <CardPay base={base} invoice={inv} email={email} cycle={inv.plan?.cycle ?? null} refresh={refresh} />}
          {later}
        </div>
      ) : inv.status === "pending_review" ? (
        <section className={cn(styles.card, styles.done, "motion-in")} aria-labelledby="review-title">
          <h2 id="review-title">{inv.plan ? t("reviewTitle", { plan: inv.plan.name }) : t("reviewTitleNoPlan")}</h2>
          <ul>
            <li>{td("reviewVia")}</li>
            {email && <li>{vatRegistered ? td("taxDocLater", { email }) : td("receiptLater", { email })}</li>}
            {tr && <li>{t("reviewAgain")}</li>}
          </ul>
          <div className={styles.row}>
            <Link className={buttonVariants({ variant: "primary" })} href={home}>
              {td("back")}
            </Link>
            {tr && <Button onClick={() => setReplacing(true)}>{t("slipAgain")}</Button>}
            <Link className={buttonVariants({ variant: "ghost" })} href={`${home}/billing`}>
              {td("billing")}
            </Link>
          </div>
        </section>
      ) : inv.status === "paid" ? (
        <section className={cn(styles.card, styles.done, "motion-in")} aria-labelledby="paid-title">
          <h2 id="paid-title">{inv.plan ? t("paidHeading", { plan: inv.plan.name }) : t("paidHeadingNoPlan")}</h2>
          <ul>
            {inv.paidAt && <li>{t("paidVia", { method: t(`methods.${inv.method ?? "transfer"}`), time: f.dateTime(new Date(inv.paymentPaidAt ?? inv.paidAt), { dateStyle: "medium", timeStyle: "short" }) })}</li>}
            {email && <li>{vatRegistered ? td("taxDoc", { email }) : td("receipt", { email })}</li>}
            {inv.plan && <li>{t("paidUntil", { date: formatDate(inv.periodEnd, "BE", true) })}</li>}
          </ul>
          <div className={styles.row}>
            {inv.taxDocument ? (
              <a className={buttonVariants()} href={inv.taxDocument.pdfUrl} target="_blank" rel="noreferrer">
                {vatRegistered ? td("download") : td("downloadReceipt")}
              </a>
            ) : (
              <a className={buttonVariants()} href={inv.pdfUrl} target="_blank" rel="noreferrer">
                {td("invoice")}
              </a>
            )}
            <Link className={buttonVariants({ variant: "primary" })} href={home}>
              {td("back")}
            </Link>
            <Link className={buttonVariants({ variant: "ghost" })} href={`${home}/billing`}>
              {td("billing")}
            </Link>
          </div>
        </section>
      ) : inv.status === "void" ? (
        <section className={cn(styles.card, styles.done, "motion-in")} aria-labelledby="void-title">
          <h2 id="void-title">{t("voidTitle")}</h2>
          <div className={styles.muted}>{t("voidHint")}</div>
          <div className={styles.row}>
            <Link className={buttonVariants({ variant: "primary" })} href={`${home}/billing/checkout`}>
              {t("checkout")}
            </Link>
          </div>
        </section>
      ) : (
        // ใบที่ยังไม่ชำระแต่ไม่ใช่การโอน (บัตร / PromptPay ชำระในหน้าชำระเงิน)
        <section className={cn(styles.card, styles.done, "motion-in")}>
          <div className={styles.muted}>{t("otherMethod", { method: t(`methods.${inv.method ?? "transfer"}`) })}</div>
          <div className={styles.row}>
            <a className={buttonVariants()} href={inv.pdfUrl} target="_blank" rel="noreferrer">
              {td("invoice")}
            </a>
            <Link className={buttonVariants({ variant: "ghost" })} href={`${home}/billing`}>
              {td("billing")}
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

/** ① บัญชีรับโอน · ทุกช่องคัดลอกได้ · เลขอ้างอิงทำพื้นสีเพราะเป็นช่องที่ลืมใส่บ่อยที่สุด */
function BankCard({ tr }: { tr: TransferInfo }) {
  const t = useTranslations("checkout.invoicePay");
  const tt = useTranslations("checkout.transfer");
  return (
    <section className={cn(styles.card, styles.step)} aria-labelledby="pay-step-1">
      <div className={styles.stepHead}>
        <span className={styles.num} aria-hidden="true">
          1
        </span>
        <h2 id="pay-step-1">{t("step1")}</h2>
      </div>
      <dl className={styles.rows}>
        <CopyRow label={tt("bank")} value={tr.bank} />
        <CopyRow label={tt("accountName")} value={tr.accountName} />
        <CopyRow label={tt("accountNo")} value={tr.accountNo} mono />
        <CopyRow label={tt("amount")} value={amountText(tr.amount)} mono />
        <CopyRow label={t("referenceShort")} value={tr.reference} mono highlight />
      </dl>
      <span className={styles.hint}>{t("referenceHint")}</span>
    </section>
  );
}

function CopyRow({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  const tt = useTranslations("checkout.transfer");
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn(styles.copyRow, highlight && styles.ref)}>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>{value}</dd>
      <Button
        size="icon"
        variant="ghost"
        aria-label={`${tt("copy")} ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** ② แนบสลิป: ลากวางหรือเลือกไฟล์ · เห็นภาพสลิปก่อนส่ง · ยอดที่โอนกรอกยอดใบแจ้งหนี้ไว้ (แก้ได้) */
function SlipCard({ base, invoice, onSent, onCancel }: { base: string; invoice: InvoiceDetail; onSent: (next: InvoiceDetail) => void; onCancel?: () => void }) {
  const t = useTranslations("checkout.invoicePay");
  const tt = useTranslations("checkout.transfer");
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState(() => amountText(invoice.amountDue));
  const [paidAt, setPaidAt] = useState(localNow);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // ภาพตัวอย่างของสลิปที่เป็นรูป · คืนหน่วยความจำเมื่อเปลี่ยนไฟล์
  useEffect(() => {
    if (!file || !file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function choose(f: File | undefined) {
    if (!f) return;
    setProblem(null);
    if (!SLIP_TYPES.includes(f.type)) return setProblem(t("badType"));
    if (f.size > SLIP_MAX) return setProblem(tt("tooLarge"));
    setFile(f);
  }

  async function send() {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      const body = new FormData();
      body.append("file", file);
      // ยอดที่ลูกค้าบอก (สตางค์) ให้ API เทียบกับใบแจ้งหนี้ (A35a) · ลบออกก็ส่งได้
      const declared = Math.round(Number(amount.replace(/,/g, "")) * 100);
      if (amount.trim() && declared > 0) body.append("amount", String(declared));
      // เวลาที่โอน = วันที่ของใบกำกับภาษี (ไม่ใช่วันที่ทีมงานตรวจ)
      if (paidAt) body.append("paidAt", new Date(paidAt).toISOString());
      onSent(await api.request<InvoiceDetail>(`${base}/billing/invoices/${invoice.id}/slip`, { method: "POST", body }));
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  const problemText = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : null;
  return (
    <section className={cn(styles.card, styles.step)} aria-labelledby="pay-step-2">
      <div className={styles.stepHead}>
        <span className={styles.num} aria-hidden="true">
          2
        </span>
        <h2 id="pay-step-2">{t("step2")}</h2>
      </div>
      <input
        ref={input}
        id="slip"
        type="file"
        className="sr-only"
        aria-label={tt("slip")}
        accept={SLIP_TYPES.join(",")}
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {file ? (
        <div className={cn(styles.file, "motion-in")}>
          <span className={styles.thumb} aria-hidden="true">
            {preview ? <img src={preview} alt="" /> : <FileText size={22} />}
          </span>
          <span className={styles.fileMeta}>
            <b>{file.name}</b>
            <span className={styles.muted}>{fileSize(file.size)}</span>
          </span>
          <Button size="small" variant="ghost" onClick={() => input.current?.click()}>
            {t("change")}
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className={styles.drop}
          data-dragging={dragging || undefined}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            choose(e.dataTransfer.files?.[0]);
          }}
        >
          <Upload size={24} aria-hidden="true" />
          <b>{t("drop")}</b>
          <span className={styles.muted}>{tt("slipHint")}</span>
        </button>
      )}
      <div className={styles.cardGrid}>
        <Input label={tt("slipAmount")} hint={t("amountHint")} inputMode="decimal" className={styles.mono} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label={t("slipPaidAt")} hint={t("slipPaidAtHint")} type="datetime-local" max={localNow()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
      </div>
      {problemText && (
        <div role="alert" className={cn(styles.problem, "motion-in")}>
          {problemText}
          {problem instanceof ApiError && supportId(problem) && <div className={styles.mono}>{supportId(problem)}</div>}
        </div>
      )}
      <Button variant="primary" className={styles.send} disabled={!file || busy} onClick={send}>
        {busy ? tt("send") + "…" : tt("send")}
      </Button>
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel}>
          {t("cancelAgain")}
        </Button>
      ) : (
        <span className={styles.hint}>{tt("alreadyHint")}</span>
      )}
    </section>
  );
}
