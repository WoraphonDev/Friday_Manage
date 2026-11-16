"use client";

import { AlertTriangle, CheckCircle2, FileText, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button, Input } from "@/components/ui";
import { ApiError, api, supportId } from "@/lib/api";
import { formatDate, today } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InvoiceDetail } from "../../../app/work/[ws]/billing/_components/types";
import styles from "./invoice-pay.module.css";

/** ขนาดไฟล์ที่ API รับ (เท่ากับสลิป) */
const WHT_MAX = 5 * 1024 * 1024;
const WHT_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const DAY = 86_400_000;
/** สตางค์ → "450.00" */
const money = (satang: number) => (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ต้องส่ง 50 ทวิ: มีหัก ณ ที่จ่าย · ยังไม่ส่ง หรือส่งแล้วไม่ผ่าน */
export const needsWht = (inv: Pick<InvoiceDetail, "whtAmount" | "status" | "whtCertificate">) => inv.whtAmount > 0 && inv.status !== "void" && (!inv.whtCertificate || inv.whtCertificate.status === "rejected");

/**
 * E11 · 50 ทวิ ในหน้าใบแจ้งหนี้ (รอบ 4) · แบนเนอร์กำหนดส่ง (30 วันหลังชำระ · เลยกำหนดยังส่งได้)
 * เลือก "อัปโหลดไฟล์" หรือ "หักผ่าน e-Withholding Tax" (เลขอ้างอิง ไม่ต้องมีไฟล์) · ข้าง ๆ เป็นสรุปใบแจ้งหนี้
 */
export function WhtSection({ base, invoice, onSent }: { base: string; invoice: InvoiceDetail; onSent: (next: InvoiceDetail) => void }) {
  const t = useTranslations("checkout.wht");
  if (invoice.whtAmount <= 0 || invoice.status === "void") return null;
  const open = needsWht(invoice);
  const rate = invoice.subtotal > 0 ? Math.round((invoice.whtAmount / invoice.subtotal) * 100) : 3;
  const days = invoice.whtDueBy ? Math.round((Date.parse(invoice.whtDueBy) - Date.parse(today())) / DAY) : null;
  const overdue = invoice.whtOverdue ?? (days !== null && days < 0);
  const due = invoice.whtDueBy ? formatDate(invoice.whtDueBy, "BE", true) : null;
  return (
    <div className={cn(styles.whtWrap, "motion-in")}>
      {open && due && (
        <div className={cn(styles.banner, overdue ? styles.bannerBad : styles.bannerWarn)} role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{overdue ? t("bannerOverdue", { date: due, amount: money(invoice.whtAmount) }) : t("banner", { date: due, days: days ?? 0, amount: money(invoice.whtAmount) })}</span>
        </div>
      )}
      <div className={styles.whtGrid}>
        <section className={cn(styles.card, styles.step)} aria-labelledby="wht-title">
          <div className={styles.stepHead}>
            <h2 id="wht-title">{t("title")}</h2>
          </div>
          {open ? (
            <WhtForm base={base} invoice={invoice} rate={rate} onSent={onSent} />
          ) : (
            <WhtState invoice={invoice} />
          )}
          {!due && open && <span className={styles.hint}>{t("dueAfterPay")}</span>}
        </section>
        <Summary invoice={invoice} rate={rate} />
      </div>
    </div>
  );
}

function WhtState({ invoice }: { invoice: InvoiceDetail }) {
  const t = useTranslations("checkout.wht");
  const cert = invoice.whtCertificate!;
  const at = formatDate(cert.uploadedAt, "BE", true);
  if (cert.status === "pending_review")
    return (
      <div className={styles.whtState}>
        <span className={cn(styles.pill, styles.pillInfo)}>{t("reviewPill")}</span>
        <span>{t("review", { date: at })}</span>
      </div>
    );
  if (cert.status === "pending_ewht")
    return (
      <div className={styles.whtState}>
        <span className={cn(styles.pill, styles.pillInfo)}>{t("ewhtPill")}</span>
        <span>{t("ewhtWaiting")}</span>
        {cert.ewhtRef && <span className={styles.muted}>{t("ewhtRef", { ref: cert.ewhtRef })}</span>}
      </div>
    );
  if (cert.status === "confirmed")
    return (
      <div className={styles.whtState}>
        <span className={cn(styles.pill, styles.pillOk)}>
          <CheckCircle2 size={12} aria-hidden="true" /> {cert.source === "ewht" ? t("receivedEwht") : t("received")}
        </span>
        <span className={styles.muted}>{t("receivedHint")}</span>
      </div>
    );
  // ปิดว่าไม่ได้รับ (ทีมการเงิน) · ไม่มีฟอร์มให้ส่งแล้ว
  return (
    <div className={styles.whtState}>
      <span className={styles.pill}>{t("closedPill")}</span>
      <span className={styles.muted}>{t("closed")}</span>
    </div>
  );
}

function WhtForm({ base, invoice, rate, onSent }: { base: string; invoice: InvoiceDetail; rate: number; onSent: (next: InvoiceDetail) => void }) {
  const t = useTranslations("checkout.wht");
  const [mode, setMode] = useState<"upload" | "ewht">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const cert = invoice.whtCertificate;

  function choose(f: File | undefined) {
    if (!f) return;
    setProblem(null);
    if (!WHT_TYPES.includes(f.type)) return setProblem(t("badType"));
    if (f.size > WHT_MAX) return setProblem(t("tooLarge"));
    setFile(f);
  }

  async function send() {
    setBusy(true);
    setProblem(null);
    try {
      if (mode === "upload") {
        if (!file) return;
        const body = new FormData();
        body.append("file", file);
        onSent(await api.request<InvoiceDetail>(`${base}/billing/invoices/${invoice.id}/wht-certificate`, { method: "POST", body }));
      } else {
        onSent(await api.post<InvoiceDetail>(`${base}/billing/invoices/${invoice.id}/wht-ewht`, { reference: reference.trim() }));
      }
      setFile(null);
      setReference("");
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  const ready = mode === "upload" ? !!file : reference.trim().length >= 3;
  const problemText = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : null;
  return (
    <>
      {cert?.status === "rejected" && (
        <div role="alert" className={styles.problem}>
          {t("rejected", { reason: cert.rejectReason ?? t("rejectedNoReason") })}
        </div>
      )}
      <fieldset className={styles.choices}>
        <legend className="sr-only">{t("how")}</legend>
        <label className={styles.choice} data-on={mode === "upload" || undefined}>
          <input type="radio" name="wht-mode" checked={mode === "upload"} onChange={() => setMode("upload")} />
          <span>
            <b>{t("upload")}</b>
            <span className={styles.hint}>{t("uploadHint")}</span>
          </span>
        </label>
        <label className={styles.choice} data-on={mode === "ewht" || undefined}>
          <input type="radio" name="wht-mode" checked={mode === "ewht"} onChange={() => setMode("ewht")} />
          <span>
            <b>{t("ewht")}</b>
            <span className={styles.hint}>{t("ewhtHint")}</span>
          </span>
        </label>
      </fieldset>
      {mode === "upload" ? (
        <>
          <input
            ref={input}
            type="file"
            className="sr-only"
            aria-label={t("fileLabel")}
            accept={WHT_TYPES.join(",")}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {file ? (
            <div className={cn(styles.file, "motion-in")}>
              <span className={styles.thumb} aria-hidden="true">
                <FileText size={22} />
              </span>
              <span className={styles.fileMeta}>
                <b>{file.name}</b>
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
              <Upload size={22} aria-hidden="true" />
              <b>{t("drop")}</b>
            </button>
          )}
        </>
      ) : (
        <Input label={t("refLabel")} hint={t("refHint")} value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
      )}
      <dl className={styles.kv}>
        <dt>{t("payee")}</dt>
        <dd>
          {t("payeeValue")}
          {invoice.taxDocument && (
            <>
              {" · "}
              <a href={invoice.taxDocument.pdfUrl} target="_blank" rel="noreferrer">
                {t("payeeDoc")}
              </a>
            </>
          )}
        </dd>
        <dt>{t("amount")}</dt>
        <dd className={styles.mono}>{t("amountValue", { amount: money(invoice.whtAmount), rate, base: money(invoice.subtotal) })}</dd>
      </dl>
      {problemText && (
        <div role="alert" className={cn(styles.problem, "motion-in")}>
          {problemText}
          {problem instanceof ApiError && supportId(problem) && <div className={styles.mono}>{supportId(problem)}</div>}
        </div>
      )}
      <div className={styles.whtActions}>
        <Button variant="primary" disabled={!ready || busy} onClick={send}>
          {busy ? `${t("send")}…` : t("send")}
        </Button>
      </div>
    </>
  );
}

/** สรุปใบแจ้งหนี้ (ข้างการ์ด 50 ทวิ) */
function Summary({ invoice, rate }: { invoice: InvoiceDetail; rate: number }) {
  const t = useTranslations("checkout.wht");
  const tp = useTranslations("checkout.invoicePay");
  return (
    <section className={cn(styles.card, styles.step)} aria-labelledby="wht-summary">
      <div className={styles.stepHead}>
        <h2 id="wht-summary">{t("summary")}</h2>
      </div>
      <div className={styles.sumRows}>
        <div>
          <span>{invoice.plan ? `${invoice.plan.name} · ${tp(invoice.plan.cycle)}` : t("subtotal")}</span>
          <span className={styles.mono}>฿{money(invoice.subtotal)}</span>
        </div>
        {invoice.vat > 0 && (
          <div>
            <span>{t("vat")}</span>
            <span className={styles.mono}>฿{money(invoice.vat)}</span>
          </div>
        )}
        <div className={styles.sumTotal}>
          <span>{t("total")}</span>
          <span className={styles.mono}>฿{money(invoice.total)}</span>
        </div>
        <div>
          <span>{t("whtLine", { rate })}</span>
          <span className={styles.mono}>−฿{money(invoice.whtAmount)}</span>
        </div>
        <div className={styles.sumDue}>
          <span>{invoice.status === "paid" && invoice.paidAt ? t("paidOn", { date: formatDate(invoice.paidAt, "BE", true) }) : t("due")}</span>
          <span className={styles.mono}>฿{money(invoice.amountDue)}</span>
        </div>
      </div>
    </section>
  );
}
