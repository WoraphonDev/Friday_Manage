"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, FileText, History, Lock, RefreshCw, Upload } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { hasAny } from "@/components/access";
import { useReauth } from "@/components/dialogs";
import { FileViewer } from "@/components/file-viewer";
import { Drawer, Empty, ErrorBlock, Modal, Notice, Seg, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import styles from "./tax.module.css";

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const thisMonth = () => todayBkk().slice(0, 7);
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });

export type DocKind = "tax_document" | "credit_note" | "debit_note";
const kindPath = (k: DocKind) => k.replace(/_/g, "-");
type Ws = { id: string; slug: string; name: string };
interface EtaxItem {
  id: string;
  docKind: DocKind;
  docId: string;
  number: string;
  docLabel: string;
  workspace: Ws;
  action: "issue" | "cancel";
  state: "failed" | "retrying" | "cancel_pending" | "waiting";
  jobStatus: string;
  problem: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  at: string;
  submittedAt: string | null;
  replacement: string | null;
}
export interface WhtItem {
  invoice: { id: string; number: string; subtotal: number };
  workspace: Ws;
  whtAmount: number;
  paidAt: string;
  paidOn: string;
  dueBy: string;
  daysLeft: number;
  state: "waiting" | "review" | "overdue" | "ewht" | "received" | "uncollected";
  certificate: { id: string; status: string; source: string; at: string; rejectReason: string | null; ewhtRef: string | null; decidedAt: string | null; hasFile: boolean } | null;
  requests: { count: number; lastAt: string | null; lastKind: string | null; today: boolean };
  nextAuto: string | null;
}
interface SalesLine {
  kind: "tax_invoice" | "receipt" | "credit_note" | "debit_note";
  count: number;
  cancelled: number;
  replaced: number;
  first: string | null;
  last: string | null;
  value: number;
  vat: number;
}
interface SalesCheck {
  ok: boolean;
  level?: "ok" | "bad" | "warn";
  code?: "numbers" | "etax" | "replacements" | "wht" | "outstanding" | "zero_invoices";
  params?: Record<string, string | number>;
  text: string;
}
interface TaxOverview {
  month: string;
  closed: boolean;
  vatRegistered: boolean;
  kpi: {
    sales: { value: number; vat: number; tx: number; rc: number; dn: number; cn: number };
    etax: { total: number; done: number; failed: number; waiting: number; pending: number; cancelPending: number; numbers: string[] };
    wht: { total: number; received: number; waiting: number; review: number; overdue: number; ewht: number };
    whtYear: { year: number; satang: number };
  };
  etax: { items: EtaxItem[]; counts: { all: number; failed: number; cancel: number; waiting: number } };
  wht: { items: WhtItem[]; counts: { follow: number; waiting: number; review: number; overdue: number; ewht: number; received: number } };
  sales: { lines: SalesLine[]; net: { value: number; vat: number; total: number }; checks: SalesCheck[]; rows: number };
}

/** จำนวนเงินภาษีแสดงทศนิยม 2 ตำแหน่ง (ตรงกับรายงาน) · เดือนเป็น "พ.ย. 2569" */
export function useTaxFmt() {
  const f = useFormatter();
  return {
    baht: (satang: number | null | undefined) => (satang == null ? "—" : f.number(satang / 100, { style: "currency", currency: "THB", minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    plain: (satang: number) => f.number(satang / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    month: (ym: string) => f.dateTime(new Date(`${ym}-01T00:00:00+07:00`), { month: "short", year: "numeric", timeZone: "Asia/Bangkok" }),
    date: (iso: string | null | undefined) => (iso ? f.dateTime(new Date(iso.length === 10 ? `${iso}T00:00:00+07:00` : iso), { day: "numeric", month: "short", timeZone: "Asia/Bangkok" }) : "—"),
    dateYear: (iso: string | null | undefined) => (iso ? f.dateTime(new Date(iso.length === 10 ? `${iso}T00:00:00+07:00` : iso), { dateStyle: "medium", timeZone: "Asia/Bangkok" }) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? f.dateTime(new Date(iso), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—"),
    time: (iso: string | null | undefined) => (iso ? f.dateTime(new Date(iso), { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—"),
    ago: (iso: string) => f.relativeTime(new Date(iso), new Date()),
  };
}

const ETAX_TONE: Record<EtaxItem["state"], string> = { failed: "pill bad", retrying: "pill", cancel_pending: "pill warn", waiting: "pill inf" };
const WHT_TONE: Record<WhtItem["state"], string> = { waiting: "pill warn", review: "pill inf", overdue: "pill bad", ewht: "pill inf", received: "pill ok", uncollected: "pill" };

// ---------------------------------------------------------------- E1 แท็บ

/** E1 · แท็บใบกำกับภาษี / 50 ทวิ: การ์ดสรุป 4 ช่อง · เอกสาร e-Tax ที่ต้องดู · 50 ทวิ · รายงานภาษีขาย · การเงินทำได้ทุกปุ่ม Owner / ผู้ตรวจอ่านอย่างเดียว */
export function TaxTab() {
  const t = useTranslations("money.tax");
  const fmt = useTaxFmt();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const [month, setMonth] = useState(thisMonth());
  const [etaxFilter, setEtaxFilter] = useState<"all" | "failed" | "cancel" | "waiting">("all");
  const [whtFilter, setWhtFilter] = useState<"follow" | "waiting" | "review" | "overdue" | "received">("follow");
  const [drawer, setDrawer] = useState<{ kind: DocKind; id: string } | null>(null);
  const [history, setHistory] = useState(false);
  const etaxRef = useRef<HTMLElement>(null);
  const whtRef = useRef<HTMLElement>(null);
  const q = useQuery({ queryKey: ["ops", "tax", month], queryFn: () => api.get<TaxOverview>(`/tax?month=${month}`), placeholderData: keepPreviousData });
  if (q.isPending) return <TableSkeleton rows={6} cols={6} />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const k = d.kpi;
  const go = (el: HTMLElement | null) => el?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="stack">
      <div className={styles.toolbar}>
        <input type="month" className="input" style={{ width: "auto" }} aria-label={t("monthLabel")} value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value || thisMonth())} />
        <span className={d.closed ? "pill ok" : "pill"}>{d.closed ? t("periodClosed") : t("periodOpen")}</span>
      </div>
      <section className="stats" aria-label="KPI">
        <div className={`stat ${styles.statStatic}`}>
          <span className="muted small">{d.vatRegistered ? t("kpi.vat", { month: fmt.month(month) }) : t("kpi.value", { month: fmt.month(month) })}</span>
          <b>{fmt.baht(d.vatRegistered ? k.sales.vat : k.sales.value)}</b>
          <span className="muted small">{t("kpi.vatSub", { tx: k.sales.tx + k.sales.rc, dn: k.sales.dn, cn: k.sales.cn })}</span>
        </div>
        <button type="button" className={`stat ${styles.stat} ${k.etax.total - k.etax.done ? "stat-warn" : "stat-ok"}`} onClick={() => (setEtaxFilter("all"), go(etaxRef.current))}>
          <span className="muted small">{t("kpi.etax")}</span>
          <b>{t("kpi.etaxValue", { done: k.etax.done, total: k.etax.total })}</b>
          <span className="muted small">{t("kpi.etaxSub", { failed: k.etax.failed, waiting: k.etax.waiting + k.etax.pending, cancel: k.etax.cancelPending })}</span>
        </button>
        <button type="button" className={`stat ${styles.stat} ${k.wht.overdue ? "stat-bad" : ""}`} onClick={() => (setWhtFilter("follow"), go(whtRef.current))}>
          <span className="muted small">{t("kpi.wht")}</span>
          <b>{t("kpi.whtValue", { received: k.wht.received, total: k.wht.total })}</b>
          <span className="muted small">{t("kpi.whtSub", { waiting: k.wht.waiting, review: k.wht.review, overdue: k.wht.overdue, ewht: k.wht.ewht })}</span>
        </button>
        <div className={`stat ${styles.statStatic}`}>
          <span className="muted small">{t("kpi.whtYear", { year: k.whtYear.year + 543 })}</span>
          <b>{fmt.baht(k.whtYear.satang)}</b>
          <span className="muted small">{t("kpi.whtYearSub")}</span>
        </div>
      </section>
      <EtaxCard refEl={etaxRef} data={d.etax} filter={etaxFilter} onFilter={setEtaxFilter} finance={finance} onOpen={(kind, id) => setDrawer({ kind, id })} onHistory={() => setHistory(true)} />
      <WhtCard refEl={whtRef} data={d.wht} filter={whtFilter} onFilter={setWhtFilter} finance={finance} month={month} />
      <SalesCard d={d} month={month} onEtax={() => (setEtaxFilter("all"), go(etaxRef.current))} onWht={() => (setWhtFilter("follow"), go(whtRef.current))} />
      {drawer && <EtaxDrawer kind={drawer.kind} id={drawer.id} onClose={() => setDrawer(null)} />}
      {history && <EtaxHistory month={month} onClose={() => setHistory(false)} onOpen={(kind, id) => (setHistory(false), setDrawer({ kind, id }))} />}
    </div>
  );
}

// ---------------------------------------------------------------- เอกสาร e-Tax ที่ต้องดู

function EtaxCard({ refEl, data, filter, onFilter, finance, onOpen, onHistory }: { refEl: React.RefObject<HTMLElement | null>; data: TaxOverview["etax"]; filter: "all" | "failed" | "cancel" | "waiting"; onFilter: (f: "all" | "failed" | "cancel" | "waiting") => void; finance: boolean; onOpen: (kind: DocKind, id: string) => void; onHistory: () => void }) {
  const t = useTranslations("money.tax");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [info, setInfo] = useState<EtaxItem | null>(null);
  const [manual, setManual] = useState<EtaxItem | null>(null);
  const act = useMutation({
    mutationFn: ({ x, op }: { x: EtaxItem; op: "retry" | "check" }) => api.post(`/etax/${kindPath(x.docKind)}/${x.docId}/${op}`, op === "retry" ? { action: x.action } : {}),
    onSuccess: (_r, { x, op }) => (toast(op === "check" ? t("checked") : x.action === "cancel" ? t("notified") : t("retried")), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  const items = data.items.filter((x) => filter === "all" || (filter === "failed" ? x.state === "failed" || x.state === "retrying" : filter === "cancel" ? x.state === "cancel_pending" : x.state === "waiting"));
  const problem = (x: EtaxItem) => {
    if (x.state === "waiting") return { main: t("problem.waiting", { ago: fmt.ago(x.submittedAt ?? x.at) }), sub: null };
    const err = x.problem ?? t("problem.unknown");
    const main = x.action === "cancel" ? (x.problem ? t("problem.cancelFailed", { error: err }) : t("problem.cancelWaiting")) : err;
    const sub = x.nextAttemptAt ? t("problem.retryAt", { time: fmt.time(x.nextAttemptAt), n: Math.min(x.attempts + 1, x.maxAttempts), max: x.maxAttempts }) : x.attempts ? t("problem.attempts", { n: x.attempts }) : null;
    return { main, sub };
  };
  return (
    <section className="card" ref={refEl} aria-labelledby="etax-title">
      <div className="card-head">
        <h2 className="card-title" id="etax-title">
          {t("etax")}
        </h2>
        <span className="spacer" />
        <Button size="small" onClick={onHistory}>
          <History size={14} aria-hidden="true" /> {t("history")}
        </Button>
      </div>
      <div className={styles.toolbar}>
        <Seg
          label={t("etaxFilter")}
          value={filter}
          onChange={onFilter}
          options={(["all", "failed", "cancel", "waiting"] as const).map((v) => ({ value: v, label: t(`etaxSeg.${v}`, { n: data.counts[v] }) }))}
        />
        <span className={`muted small ${styles.toolbarNote}`}>{t("etaxNote")}</span>
      </div>
      {!items.length ? (
        <Empty ok title={t("noEtax")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl" aria-label={t("etax")}>
            <thead>
              <tr>
                <th>{t("col.number")}</th>
                <th>{t("col.customer")}</th>
                <th>{t("col.status")}</th>
                <th>{t("col.problem")}</th>
                <th>{t("col.latest")}</th>
                {finance && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const p = problem(x);
                return (
                  <tr key={x.id}>
                    <td>
                      <button type="button" className={`mono small ${styles.docButton}`} onClick={() => onOpen(x.docKind, x.docId)}>
                        {x.number}
                      </button>
                      <div className="cell-sub">{x.replacement ? t("cancelledTo", { number: x.replacement }) : x.docLabel}</div>
                    </td>
                    <td>{x.workspace.name}</td>
                    <td>
                      <span className={ETAX_TONE[x.state]}>{t(`state.${x.state}`)}</span>
                    </td>
                    <td className="small">
                      {p.main}
                      {p.sub && <div className="cell-sub">{p.sub}</div>}
                    </td>
                    <td className="small">{fmt.dateTime(x.at)}</td>
                    {finance && (
                      <td>
                        <span className={styles.actions}>
                          {x.state === "waiting" ? (
                            <Button size="small" disabled={act.isPending} onClick={() => act.mutate({ x, op: "check" })}>
                              {t("check")}
                            </Button>
                          ) : x.action === "cancel" ? (
                            <>
                              <Button size="small" disabled={act.isPending} onClick={() => act.mutate({ x, op: "retry" })}>
                                {t("notifyAgain")}
                              </Button>
                              <Button size="small" onClick={() => setManual(x)}>
                                {t("manualCancel")}
                              </Button>
                            </>
                          ) : (
                            <>
                              {x.docKind === "tax_document" && (
                                <Button size="small" onClick={() => setInfo(x)}>
                                  {t("requestInfo")}
                                </Button>
                              )}
                              <Button size="small" disabled={act.isPending} onClick={() => act.mutate({ x, op: "retry" })}>
                                {t("retry")}
                              </Button>
                            </>
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {info && <RequestInfoDialog item={info} onClose={() => setInfo(null)} />}
      {manual && <ManualCancelDialog kind={manual.docKind} id={manual.docId} number={manual.number} onClose={() => setManual(null)} />}
    </section>
  );
}

/** ขอข้อมูลใหม่: อีเมลผู้ติดต่อด้านบัญชีให้แก้ข้อมูลออกใบกำกับ */
function RequestInfoDialog({ item, onClose }: { item: EtaxItem; onClose: () => void }) {
  const t = useTranslations("money.tax");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [message, setMessage] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<{ sent: number }>(`/tax-documents/${item.docId}/request-info`, message.trim() ? { message: message.trim() } : {}),
    onSuccess: (r) => (toast(t("requestInfoDone", { n: r.sent })), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("requestInfoTitle", { number: item.number })} description={t("requestInfoDesc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        {item.problem && <Notice tone="warn">{item.problem}</Notice>}
        <Textarea label={t("requestInfoMessage")} value={message} onChange={(e) => setMessage(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {t("requestInfoSend")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** E4 · บันทึกว่ายกเลิกที่ผู้ให้บริการแล้ว (แตะกุญแจ) */
export function ManualCancelDialog({ kind, id, number, onClose }: { kind: DocKind; id: string; number: string; onClose: () => void }) {
  const tm = useTranslations("money.etax.e4");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const ok = reference.trim().length >= 3 && reason.trim().length >= 3;
  const m = useMutation({
    mutationFn: () => run(() => api.post(`/etax/${kindPath(kind)}/${id}/cancel-manual`, { reference: reference.trim(), reason: reason.trim() }), tm("title")),
    onSuccess: () => (toast(tm("done", { number })), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={tm("title")} description={tm("desc", { number })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={tm("reference")} value={reference} onChange={(e) => setReference(e.target.value)} className="mono" />
        <Textarea label={tm("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <Notice>{tm("info")}</Notice>
        <p className="muted small">{tm("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            <Lock size={14} aria-hidden="true" /> {tm("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- E2 Drawer

interface EtaxDetail {
  kind: DocKind;
  id: string;
  number: string;
  docLabel: string;
  status: string;
  cancelled: boolean;
  cancelReason: string | null;
  issuedOn: string | null;
  providerRef: string | null;
  invoice: { id: string; number: string; status: string; paidAt: string | null };
  workspace: Ws;
  amount: { value: number; vat: number; total: number };
  buyer: { companyName: string; taxId: string; branchType: string; branchNo: string | null; address: string } | null;
  currentBuyer: EtaxDetail["buyer"];
  replacement: { id: string; number: string; status: string; createdAt: string } | null;
  replaces: { id: string; number: string } | null;
  jobs: { id: string; action: "issue" | "cancel"; status: string; attempts: number; maxAttempts: number; lastError: string | null; lastAttemptAt: string | null; nextAttemptAt: string | null; providerRef: string | null; note: string | null }[];
  state: { issue: string; cancel: string | null };
  timeline: { at: string; action: string; summary: string | null; by: string | null; system: boolean }[];
  pdf: string;
}

export function useEtaxDetail(kind: DocKind, id: string) {
  return useQuery({ queryKey: ["ops", "etax", kind, id], queryFn: () => api.get<EtaxDetail>(`/etax/${kindPath(kind)}/${id}`) });
}

/** E2 · รายละเอียดเอกสาร e-Tax: ข้อมูลที่ล็อก · ลำดับเหตุการณ์ · ปุ่มของการเงิน */
export function EtaxDrawer({ kind, id, onClose }: { kind: DocKind; id: string; onClose: () => void }) {
  const t = useTranslations("money.etax");
  const tt = useTranslations("money.tax");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const q = useEtaxDetail(kind, id);
  const [manual, setManual] = useState(false);
  const d = q.data;
  const cancelJob = d?.jobs.find((j) => j.action === "cancel");
  const issueJob = d?.jobs.find((j) => j.action === "issue");
  const openJob = cancelJob && !["done", "manual"].includes(cancelJob.status) ? cancelJob : issueJob && (issueJob.status === "failed" || (issueJob.status === "pending" && issueJob.attempts > 0)) ? issueJob : null;
  const retry = useMutation({
    mutationFn: (action: "issue" | "cancel") => api.post(`/etax/${kindPath(kind)}/${id}/retry`, { action }),
    onSuccess: (_r, action) => (toast(action === "cancel" ? tt("notified") : tt("retried")), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  const branch = (b: NonNullable<EtaxDetail["buyer"]>) => (b.branchType === "head" ? t("kv.head") : t("kv.branch", { no: b.branchNo ?? "" }));
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={d ? `${d.number} · ${d.docLabel}` : tt("etax")} description={d ? `${t("drawerDesc", { ws: d.workspace.name, invoice: d.invoice.number })}${d.replacement ? ` · ${t("replacedBy", { number: d.replacement.number })}` : ""}` : undefined}>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        d && (
          <div className="dialog-body">
            <div className={styles.pills}>
              {d.cancelled ? <span className="pill">{t("pill.cancelledInSystem")}</span> : <span className={d.state.issue === "done" || d.state.issue === "issued" ? "pill ok" : d.state.issue === "failed" ? "pill bad" : "pill inf"}>{tt(`state.${(d.state.issue in STATE_KEYS ? d.state.issue : "pending") as "pending"}`)}</span>}
              {cancelJob && <span className={cancelJob.status === "done" ? "pill ok" : cancelJob.status === "manual" ? "pill" : "pill warn"}>{cancelJob.status === "done" ? t("pill.cancelDone") : cancelJob.status === "manual" ? t("pill.cancelManual") : t("pill.cancelPending")}</span>}
            </div>
            <dl className={styles.kv}>
              <dt>{t("kv.date")}</dt>
              <dd>{t("kv.dateHint", { date: fmt.dateYear(d.issuedOn) })}</dd>
              <dt>{t("kv.amount")}</dt>
              <dd className="num" style={{ textAlign: "left" }}>
                {t("kv.amountValue", { value: fmt.baht(d.amount.value), vat: fmt.baht(d.amount.vat), total: fmt.baht(d.amount.total) })}
              </dd>
              {d.buyer && (
                <>
                  <dt>{t("kv.buyer")}</dt>
                  <dd>
                    {d.buyer.companyName} · {branch(d.buyer)} · <span className="mono">{d.buyer.taxId}</span>
                  </dd>
                </>
              )}
              <dt>{t("kv.ref")}</dt>
              <dd className="mono">{d.providerRef ?? "—"}</dd>
              {d.replacement && (
                <>
                  <dt>{t("kv.replacement")}</dt>
                  <dd>
                    <span className="mono">{d.replacement.number}</span> · {tt(`state.${(d.replacement.status in STATE_KEYS ? d.replacement.status : "pending") as "pending"}`)} {fmt.dateTime(d.replacement.createdAt)}
                  </dd>
                </>
              )}
              {d.replaces && (
                <>
                  <dt>{t("kv.replaces")}</dt>
                  <dd className="mono">{d.replaces.number}</dd>
                </>
              )}
            </dl>
            <h3 className={styles.heading}>{t("timeline")}</h3>
            {!d.timeline.length && !openJob ? (
              <p className="muted small">{t("noTimeline")}</p>
            ) : (
              <ol className="timeline">
                {d.timeline.map((e, i) => (
                  <li key={i} className={`timeline-item ${/failed|cancel_failed/.test(e.action) ? "tone-bad" : /late|unexpected/.test(e.action) ? "tone-warn" : "tone-ok"}`}>
                    <span className="muted small">{fmt.dateTime(e.at)}</span>
                    <span className="small">
                      <b>{t.has(`actions.${e.action}`) ? t(`actions.${e.action}` as "actions.billing.etax_issued") : e.action}</b>
                      {e.summary && <div className="cell-sub">{e.summary}</div>}
                      <div className="cell-sub">{e.by ? t("by", { name: e.by }) : t("system")}</div>
                    </span>
                  </li>
                ))}
                {openJob && openJob.attempts > 0 && (
                  <li className="timeline-item tone-bad">
                    <span className="muted small">{fmt.dateTime(openJob.lastAttemptAt)}</span>
                    <span className="small">
                      <b>{t("jobFailed", { action: t(`jobAction.${openJob.action}`), n: openJob.attempts })}</b>
                      {openJob.lastError && <div className="cell-sub">{openJob.lastError}</div>}
                    </span>
                  </li>
                )}
                {openJob?.nextAttemptAt && openJob.status === "pending" && (
                  <li className="timeline-item tone-warn">
                    <span className="muted small">{fmt.time(openJob.nextAttemptAt)}</span>
                    <span className="small">
                      <b>{t("jobNext", { time: fmt.time(openJob.nextAttemptAt) })}</b>
                      <div className="cell-sub">{t("jobNextHint")}</div>
                    </span>
                  </li>
                )}
              </ol>
            )}
            {d.cancelled && <Notice>{t("lateInfo")}</Notice>}
            <p className="muted small">{t("audit")}</p>
            <div className="dialog-actions">
              <a className={buttonClass("secondary")} href={`${OPS_BASE}${d.pdf}`} target="_blank" rel="noreferrer">
                <Download size={14} aria-hidden="true" /> {t("pdf")}
              </a>
              {finance && cancelJob && !["done", "manual"].includes(cancelJob.status) && <Button onClick={() => setManual(true)}>{tt("manualCancel")}</Button>}
              {finance && openJob && (openJob.status === "failed" || openJob.status === "pending") && (
                <Button variant="primary" disabled={retry.isPending} onClick={() => retry.mutate(openJob.action)}>
                  <RefreshCw size={14} aria-hidden="true" /> {openJob.action === "cancel" ? tt("notifyAgain") : tt("retry")}
                </Button>
              )}
            </div>
          </div>
        )
      )}
      {manual && d && <ManualCancelDialog kind={kind} id={id} number={d.number} onClose={() => (setManual(false), void q.refetch())} />}
    </Drawer>
  );
}
const STATE_KEYS = { failed: 1, retrying: 1, cancel_pending: 1, waiting: 1, pending: 1, submitted: 1, issued: 1, done: 1, cancelled: 1, manual: 1, not_required: 1 } as const;

/** ประวัติ e-Tax ทั้งเดือน (ชุดเดียวกับรายงานภาษีขาย) */
function EtaxHistory({ month, onClose, onOpen }: { month: string; onClose: () => void; onOpen: (kind: DocKind, id: string) => void }) {
  const t = useTranslations("money.tax");
  const fmt = useTaxFmt();
  const q = useQuery({ queryKey: ["ops", "etax", "history", month], queryFn: () => api.get<{ items: { date: string; number: string; kind: SalesLine["kind"]; cancelled: boolean; note: string | null; buyerName: string; value: number; vat: number; etax: string; etaxState: string }[] }>(`/etax?month=${month}`) });
  void onOpen;
  return (
    <Drawer open wide onOpenChange={(o) => !o && onClose()} title={t("historyTitle", { month: fmt.month(month) })} description={t("historyDesc")}>
      {q.isPending ? (
        <TableSkeleton rows={6} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("historyEmpty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl" aria-label={t("history")}>
            <thead>
              <tr>
                <th>{t("col.date")}</th>
                <th>{t("col.number")}</th>
                <th>{t("col.customer")}</th>
                <th className="num">{t("col.value")}</th>
                <th>{t("col.etax")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.number}>
                  <td className="small">{fmt.date(r.date)}</td>
                  <td className="mono small">
                    {r.number}
                    <div className="cell-sub">{r.note ?? t(`line.${r.kind}`)}</div>
                  </td>
                  <td>{r.buyerName}</td>
                  <td className="num">{fmt.plain(r.value + r.vat)}</td>
                  <td>
                    <span className={r.etaxState === "done" ? "pill ok" : r.etaxState === "failed" ? "pill bad" : r.etaxState === "not_required" ? "pill" : "pill warn"}>{r.etax}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------- 50 ทวิ

function WhtCard({ refEl, data, filter, onFilter, finance, month }: { refEl: React.RefObject<HTMLElement | null>; data: TaxOverview["wht"]; filter: "follow" | "waiting" | "review" | "overdue" | "received"; onFilter: (f: "follow" | "waiting" | "review" | "overdue" | "received") => void; finance: boolean; month: string }) {
  const t = useTranslations("money.tax");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [request, setRequest] = useState<WhtItem | null>(null);
  const [reject, setReject] = useState<WhtItem | null>(null);
  const [closing, setClosing] = useState<WhtItem | null>(null);
  const [viewing, setViewing] = useState<WhtItem | null>(null);
  const [importing, setImporting] = useState(false);
  const confirm = useMutation({ mutationFn: (x: WhtItem) => api.post(`/wht-certificates/${x.certificate!.id}/confirm`, {}), onSuccess: () => (toast(t("confirmed")), invalidate(cache)), onError: (e) => toast(errorToast(e)) });
  const items = data.items.filter((x) => (filter === "follow" ? ["waiting", "review", "overdue", "ewht"].includes(x.state) : filter === "received" ? x.state === "received" || x.state === "uncollected" : x.state === filter));
  const sub = (x: WhtItem) => {
    const c = x.certificate;
    if (x.state === "review") return t("whtSub.uploaded", { date: fmt.dateTime(c?.at) });
    if (x.state === "ewht") return c?.ewhtRef ? t("whtSub.ewhtRef", { ref: c.ewhtRef }) : null;
    if (x.state === "received") return c?.source === "ewht" ? t("whtSub.ewhtMatched", { date: fmt.date(c.decidedAt) }) : null;
    if (x.state === "uncollected") return c?.rejectReason ?? null;
    const parts = [];
    if (c?.status === "rejected" && c.rejectReason) parts.push(t("whtSub.rejected", { reason: c.rejectReason }));
    if (x.requests.count) parts.push(t(x.requests.lastKind === "manual" ? "whtSub.requested" : "whtSub.requestedAuto", { n: x.requests.count, date: fmt.date(x.requests.lastAt) }));
    else if (x.nextAuto) parts.push(t("whtSub.nextAuto", { date: fmt.date(x.nextAuto) }));
    return parts.join(" · ") || null;
  };
  return (
    <section className="card" ref={refEl} aria-labelledby="wht-title">
      <div className="card-head">
        <h2 className="card-title" id="wht-title">
          {t("wht")}
        </h2>
        <span className="spacer" />
        {finance && (
          <Button size="small" onClick={() => setImporting(true)}>
            <Upload size={14} aria-hidden="true" /> {t("importEwht")}
          </Button>
        )}
        <a className={buttonClass("secondary", "small")} href={`${OPS_BASE}/revenue/export?month=${month}&type=wht`} download>
          <Download size={14} aria-hidden="true" /> {t("csv")}
        </a>
      </div>
      <div className={styles.toolbar}>
        <Seg label={t("whtFilter")} value={filter} onChange={onFilter} options={(["follow", "waiting", "review", "overdue", "received"] as const).map((v) => ({ value: v, label: t(`whtSeg.${v}`, { n: data.counts[v] }) }))} />
        <span className={`muted small ${styles.toolbarNote}`}>{t("whtNote")}</span>
      </div>
      {!items.length ? (
        <p className="muted small">{t("noWht")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl" aria-label={t("wht")}>
            <thead>
              <tr>
                <th>{t("col.invoice")}</th>
                <th>{t("col.customer")}</th>
                <th className="num">{t("col.wht")}</th>
                <th>{t("col.paid")}</th>
                <th>{t("col.status")}</th>
                <th>{t("col.due")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const s = sub(x);
                const open = x.state === "waiting" || x.state === "overdue";
                return (
                  <tr key={x.invoice.id}>
                    <td className="mono small">{x.invoice.number}</td>
                    <td>{x.workspace.name}</td>
                    <td className="num">{fmt.baht(x.whtAmount)}</td>
                    <td className="small">{fmt.date(x.paidOn)}</td>
                    <td>
                      <span className={WHT_TONE[x.state]}>{x.state === "received" && x.certificate?.source === "ewht" ? t("whtState.receivedEwht") : t(`whtState.${x.state}`)}</span>
                      {s && <div className="cell-sub">{s}</div>}
                    </td>
                    <td className="small">
                      {open ? (
                        <>
                          {fmt.date(x.dueBy)}
                          <div className={`cell-sub ${x.daysLeft < 0 ? styles.checkBad : ""}`}>{x.daysLeft > 0 ? t("daysLeft", { n: x.daysLeft }) : x.daysLeft === 0 ? t("dueToday") : t("daysLate", { n: -x.daysLeft })}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className={styles.actions}>
                        {x.state === "review" && x.certificate?.hasFile && (
                          <Button size="small" variant="ghost" onClick={() => setViewing(x)}>
                            <FileText size={14} aria-hidden="true" /> {t("file")}
                          </Button>
                        )}
                        {finance && x.state === "review" && (
                          <>
                            <Button size="small" variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate(x)}>
                              {t("confirm")}
                            </Button>
                            <Button size="small" onClick={() => setReject(x)}>
                              {t("reject")}
                            </Button>
                          </>
                        )}
                        {finance && open && (
                          <Button size="small" disabled={x.requests.today} title={x.requests.today ? t("requestedToday") : undefined} onClick={() => setRequest(x)}>
                            {x.requests.count ? t("requestAgain") : t("requestNow")}
                          </Button>
                        )}
                        {finance && x.state === "overdue" && (
                          <Button size="small" onClick={() => setClosing(x)}>
                            {t("closeUncollected")}
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
      {request && <WhtRequestDialog item={request} onClose={() => setRequest(null)} />}
      {reject && <WhtRejectDialog item={reject} onClose={() => setReject(null)} />}
      {closing && <WhtCloseDialog item={closing} onClose={() => setClosing(null)} />}
      {importing && <EwhtImportDialog candidates={data.items.filter((x) => ["waiting", "overdue", "ewht"].includes(x.state))} onClose={() => setImporting(false)} />}
      {viewing && (
        <FileViewer
          path={`/wht-certificates/${viewing.certificate!.id}/file`}
          title={t("fileTitle", { ws: viewing.workspace.name })}
          description={<span className="mono">{viewing.invoice.number}</span>}
          filename={`wht-${viewing.invoice.number}`}
          onClose={() => setViewing(null)}
          footer={
            finance ? (
              <>
                <Button onClick={() => (setReject(viewing), setViewing(null))}>{t("reject")}</Button>
                <Button variant="primary" onClick={() => (confirm.mutate(viewing), setViewing(null))}>
                  {t("confirm")}
                </Button>
              </>
            ) : undefined
          }
        />
      )}
    </section>
  );
}

/** E7 · ขอ 50 ทวิ อีกครั้ง / ขอตอนนี้ · วันละ 1 ครั้งต่อใบ */
function WhtRequestDialog({ item, onClose }: { item: WhtItem; onClose: () => void }) {
  const t = useTranslations("money.wht.e7");
  const tc = useTranslations("common.dialog");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: ["ops", "wht", item.invoice.id], queryFn: () => api.get<WhtItem & { contacts: { email: string; name: string | null; role: "accounting" | "owner" | "admin" }[]; history: { kind: string; at: string }[] }>(`/wht/${item.invoice.id}`) });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [message, setMessage] = useState("");
  const contacts = q.data?.contacts ?? [];
  const to = picked ?? contacts.filter((c) => c.role === "accounting").map((c) => c.email).concat(contacts.some((c) => c.role === "accounting") ? [] : contacts.slice(0, 1).map((c) => c.email));
  const m = useMutation({
    mutationFn: () => api.post<{ sent: string[] }>(`/wht/${item.invoice.id}/request`, { recipients: to, ...(message.trim() ? { message: message.trim() } : {}) }),
    onSuccess: (r) => (toast(t("done", { to: r.sent.join(", ") })), invalidate(cache), onClose()),
  });
  const last = q.data?.history[0];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={item.requests.count ? t("title") : t("titleNow")} description={t("desc", { number: item.invoice.number, ws: item.workspace.name, amount: fmt.baht(item.whtAmount) })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), to.length && m.mutate())}>
        <dl className={styles.kv}>
          <dt>{t("asked")}</dt>
          <dd>{last ? t("askedValue", { n: q.data!.history.length, date: `${fmt.date(last.at)} (${t(`kind.${last.kind as "manual"}`)})` }) : t("askedNone")}</dd>
          <dt>{t("due")}</dt>
          <dd>{t("dueValue", { date: fmt.dateYear(item.dueBy) })}</dd>
        </dl>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("to")}</legend>
          {q.isPending ? (
            <TableSkeleton rows={2} cols={1} />
          ) : (
            contacts.map((c) => (
              <label key={c.email} className="check">
                <input type="checkbox" checked={to.includes(c.email)} onChange={() => setPicked(to.includes(c.email) ? to.filter((x) => x !== c.email) : [...to, c.email])} />
                <span>
                  {[c.name, t(`role.${c.role}`), c.email].filter(Boolean).join(" · ")}
                </span>
              </label>
            ))
          )}
        </fieldset>
        <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className={styles.preview}>
          <div className={styles.previewHead}>{t("preview")}</div>
          <div className={styles.previewBody}>{t("subject", { number: item.invoice.number, date: fmt.dateYear(item.dueBy) })}</div>
        </div>
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error ?? q.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!to.length || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const REJECT_CODES = ["name_mismatch", "amount_mismatch", "no_signature", "unreadable", "other"] as const;
/** E8 · 50 ทวิ ไม่ผ่าน · เลือกสาเหตุ (ลูกค้าเห็น) */
function WhtRejectDialog({ item, onClose }: { item: WhtItem; onClose: () => void }) {
  const t = useTranslations("money.wht.e8");
  const tc = useTranslations("common.dialog");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [code, setCode] = useState<(typeof REJECT_CODES)[number]>("name_mismatch");
  const [other, setOther] = useState("");
  const ok = code !== "other" || other.trim().length >= 3;
  const m = useMutation({
    mutationFn: () => api.post(`/wht-certificates/${item.certificate!.id}/reject`, code === "other" ? { code, reason: other.trim() } : { code }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc", { number: item.invoice.number, ws: item.workspace.name, date: fmt.dateTime(item.certificate?.at) })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <fieldset className={styles.radios}>
          <legend className="field-label">{t("cause")}</legend>
          {REJECT_CODES.map((c) => (
            <label key={c} className={styles.radio}>
              <input type="radio" name="wht-reject" checked={code === c} onChange={() => setCode(c)} />
              <span>
                <b className="small">{t(`reasons.${c}`)}</b>
                {t.has(`hints.${c}`) && <span className="muted small">{t(`hints.${c}` as "hints.other")}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        {code === "other" && <Textarea label={t("other")} value={other} onChange={(e) => setOther(e.target.value)} />}
        <Notice>{t("info")}</Notice>
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** ปิดว่าไม่ได้รับ (ต้องกรอกเหตุผล) */
function WhtCloseDialog({ item, onClose }: { item: WhtItem; onClose: () => void }) {
  const t = useTranslations("money.wht.close");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/wht/${item.invoice.id}/close`, { reason: reason.trim() }),
    onSuccess: () => (toast(t("done", { number: item.invoice.number })), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { number: item.invoice.number })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate())}>
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={reason.trim().length < 3 || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** อ่านไฟล์เป็นข้อความ (Blob.text ไม่มีในบางเบราว์เซอร์เก่า) */
const readText = (f: File) =>
  typeof f.text === "function"
    ? f.text()
    : new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ""));
        r.onerror = () => reject(r.error);
        r.readAsText(f);
      });

interface EwhtResult {
  rows: { line: number; payerTaxId: string; payerName: string; amount: number; date: string; reference: string; status: "matched" | "unmatched" | "already" | "invalid"; rate?: number | null; manual?: boolean; match: { invoiceId: string; number: string; workspace: Ws } | null }[];
  errors: { line: number; message: string }[];
  period: { from: string; to: string } | null;
  matched: number;
  closed: number;
}
/** E9 · นำเข้ารายการ e-Withholding Tax (CSV) · ดูผลจับคู่ก่อน · จับคู่เองได้ */
function EwhtImportDialog({ candidates, onClose }: { candidates: WhtItem[]; onClose: () => void }) {
  const t = useTranslations("money.wht.e9");
  const tc = useTranslations("common.dialog");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const preview = useMutation({ mutationFn: (body: { csv: string; filename: string; matches: Record<string, string> }) => api.post<EwhtResult>("/wht-ewht/import", { ...body, apply: false }) });
  const apply = useMutation({
    mutationFn: () => api.post<EwhtResult>("/wht-ewht/import", { csv: file!.csv, filename: file!.name, matches: manual, apply: true }),
    onSuccess: (r) => (toast(t("done", { n: r.closed })), invalidate(cache), onClose()),
  });
  const load = async (f: File | undefined) => {
    if (!f) return;
    const csv = await readText(f);
    setFile({ name: f.name, csv });
    setManual({});
    preview.mutate({ csv, filename: f.name, matches: {} });
  };
  const r = preview.data;
  const pick = (line: number, invoiceId: string) => {
    const next = { ...manual, [String(line)]: invoiceId };
    setManual(next);
    setPicking(null);
    preview.mutate({ csv: file!.csv, filename: file!.name, matches: next });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")} className="dialog-wide">
      <div className="dialog-body">
        <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label={t("choose")} onChange={(e) => (void load(e.target.files?.[0]), (e.target.value = ""))} />
        <button
          type="button"
          className={styles.drop}
          data-dragging={dragging || undefined}
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => (e.preventDefault(), setDragging(false), void load(e.dataTransfer.files?.[0]))}
        >
          <Upload size={20} aria-hidden="true" />
          {file ? <b>{file.name}</b> : <span>{t("drop")} <u>{t("choose")}</u></span>}
          {r?.period ? <span>{t("read", { n: r.rows.length, from: fmt.date(r.period.from), to: fmt.dateYear(r.period.to) })}</span> : <span className="small">{t("format")}</span>}
        </button>
        {r && r.errors.length > 0 && (
          <Notice tone="warn" title={t("errors", { n: r.errors.length })}>
            {r.errors.slice(0, 5).map((e) => t("line", e)).join(" · ")}
          </Notice>
        )}
        {r && r.rows.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl" aria-label={t("title")}>
              <thead>
                <tr>
                  <th>{t("col.payer")}</th>
                  <th className="num">{t("col.tax")}</th>
                  <th>{t("col.date")}</th>
                  <th>{t("col.match")}</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.line}>
                    <td>
                      {x.payerName} · <span className="mono small">{x.payerTaxId}</span>
                    </td>
                    <td className="num">
                      {fmt.baht(x.amount)}
                      {x.rate && <div className="cell-sub">{t("rate", { rate: x.rate })}</div>}
                    </td>
                    <td className="small">{fmt.date(x.date)}</td>
                    <td>
                      {x.status === "matched" ? (
                        <span className="pill ok">{x.match!.number}</span>
                      ) : x.status === "already" ? (
                        <span className="pill">{t("already", { number: x.match!.number })}</span>
                      ) : picking === x.line ? (
                        <Select label={t("pick")} value="" onChange={(e) => e.target.value && pick(x.line, e.target.value)}>
                          <option value="">—</option>
                          {candidates.map((c) => (
                            <option key={c.invoice.id} value={c.invoice.id}>
                              {c.invoice.number} · {c.workspace.name} · {fmt.baht(c.whtAmount)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <>
                          <span className="pill warn">{x.status === "invalid" ? t("invalid") : t("unmatched")}</span>{" "}
                          <button type="button" className="link-button small" onClick={() => setPicking(x.line)}>
                            {t("manual")}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Notice>{t("info")}</Notice>
        <p className="muted small">{t("note")}</p>
        <InlineError error={preview.error ?? apply.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button variant="primary" disabled={!r?.matched || apply.isPending || preview.isPending} onClick={() => apply.mutate()}>
            {t("submit", { n: r?.matched ?? 0 })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- รายงานภาษีขาย

function SalesCard({ d, month, onEtax, onWht }: { d: TaxOverview; month: string; onEtax: () => void; onWht: () => void }) {
  const t = useTranslations("money.tax");
  const fmt = useTaxFmt();
  const me = useMe().data;
  const [closing, setClosing] = useState(false);
  const canClose = hasAny(me, "owner", "finance") && !d.closed && month < thisMonth();
  const range = (l: SalesLine) => (!l.first ? "" : l.first === l.last ? l.first : `${l.first} – ${l.last!.slice(-4)}`);
  const checkText = (c: SalesCheck) => {
    const p = c.params ?? {};
    switch (c.code) {
      case "numbers":
        return c.ok ? t("checks.numbersOk", { range: String(p.range ?? "") }) : t("checks.numbersBad", { missing: String(p.missing ?? "") });
      case "etax":
        return c.ok ? t("checks.etaxOk", { n: Number(p.n ?? 0) }) : t("checks.etaxBad", { n: Number(p.n ?? 0) });
      case "replacements":
        return c.ok ? t("checks.replacementsOk", { n: Number(p.n ?? 0) }) : t("checks.replacementsBad", { numbers: String(p.numbers ?? "") });
      case "wht":
        return t("checks.wht", { n: Number(p.n ?? 0), amount: fmt.baht(Number(p.amount ?? 0)) });
      case "outstanding":
        return t("checks.outstanding", { n: Number(p.n ?? 0) });
      case "zero_invoices":
        return t("checks.zero_invoices", { n: Number(p.n ?? 0) });
      default:
        return c.text;
    }
  };
  const level = (c: SalesCheck) => c.level ?? (c.ok ? "ok" : "bad");
  return (
    <section className="card" aria-labelledby="sales-title">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="sales-title">
            {t("sales", { month: fmt.month(month) })}
          </h2>
          <span className="card-sub">{t("salesSub")}</span>
        </div>
        <span className="spacer" />
        <a className={buttonClass("secondary", "small")} href={`${OPS_BASE}/revenue/sales-report?month=${month}&format=pdf`} download>
          <Download size={14} aria-hidden="true" /> {t("reportPdf")}
        </a>
        <a className={buttonClass("secondary", "small")} href={`${OPS_BASE}/revenue/sales-report?month=${month}&format=xlsx`} download>
          <Download size={14} aria-hidden="true" /> {t("reportXlsx")}
        </a>
        {canClose && (
          <Button size="small" variant="primary" onClick={() => setClosing(true)}>
            <Lock size={14} aria-hidden="true" /> {t("closeMonth", { month: fmt.month(month) })}
          </Button>
        )}
      </div>
      {!d.vatRegistered && <Notice tone="warn">{t("notRegistered")}</Notice>}
      <div className={styles.salesGrid}>
        <div className={styles.salesTable}>
          {!d.sales.lines.length ? (
            <p className="muted small">{t("noSales")}</p>
          ) : (
            <table className="tbl" aria-label={t("sales", { month: fmt.month(month) })}>
              <thead>
                <tr>
                  <th>{t("salesCol")}</th>
                  <th className="num">{t("count")}</th>
                  <th className="num">{t("col.value")}</th>
                  {d.vatRegistered && <th className="num">{t("col.vat")}</th>}
                </tr>
              </thead>
              <tbody>
                {d.sales.lines.map((l) => (
                  <tr key={l.kind}>
                    <td>
                      {t(`line.${l.kind}`)} <span className="mono small">{range(l)}</span>
                      {l.replaced > 0 && <div className="cell-sub">{t("pairs", { n: l.replaced })}</div>}
                    </td>
                    <td className="num">{l.count}</td>
                    <td className="num">{l.kind === "debit_note" ? "+" : ""}{fmt.plain(l.value)}</td>
                    {d.vatRegistered && <td className="num">{l.kind === "debit_note" ? "+" : ""}{fmt.plain(l.vat)}</td>}
                  </tr>
                ))}
                <tr className={styles.netRow}>
                  <td>{d.vatRegistered ? t("net") : t("netValue")}</td>
                  <td />
                  <td className="num">{fmt.plain(d.sales.net.value)}</td>
                  {d.vatRegistered && <td className="num">{fmt.plain(d.sales.net.vat)}</td>}
                </tr>
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3 className={styles.heading}>{t("checksTitle")}</h3>
          <ul className={styles.checks} aria-label={t("checksTitle")}>
            {d.sales.checks.map((c, i) => (
              <li key={i} className={styles.check}>
                <span className={level(c) === "ok" ? styles.checkOk : level(c) === "warn" ? styles.checkWarn : styles.checkBad} aria-hidden="true">
                  {level(c) === "ok" ? <Check size={16} /> : <AlertTriangle size={15} />}
                </span>
                <span>{checkText(c)}</span>
                {c.code === "numbers" && c.ok ? (
                  <span className="muted small">{t("checks.numbersHint")}</span>
                ) : c.code === "etax" && !c.ok ? (
                  <button type="button" className="link-button small" onClick={onEtax}>
                    {t("checks.view")}
                  </button>
                ) : c.code === "wht" ? (
                  <button type="button" className="link-button small" onClick={onWht}>
                    {t("checks.view")}
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {closing && <ClosePeriodDialog month={month} etaxOpen={d.kpi.etax.total - d.kpi.etax.done} onClose={() => setClosing(false)} />}
    </section>
  );
}

/** ปิดงวด: e-Tax ยังไม่ครบก็ปิดได้ แต่ต้องกรอกเหตุผล · แตะกุญแจ (ใช้ทั้งแท็บภาษีและหน้ารายงานรายได้) */
export function ClosePeriodDialog({ month, etaxOpen, onClose }: { month: string; etaxOpen?: number; onClose: () => void }) {
  const t = useTranslations("money.tax");
  const tc = useTranslations("common.dialog");
  const fmt = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [reason, setReason] = useState("");
  // แท็บรายงานรายได้ไม่รู้จำนวน e-Tax ที่ค้าง: ถาม ops-api ก่อน ถ้าตอบว่าต้องกรอกเหตุผลจึงแสดงช่องบังคับ
  const [open, setOpen] = useState(etaxOpen ?? 0);
  const required = open > 0;
  const m = useMutation({
    mutationFn: () => run(() => api.post("/revenue/close", { month, ...(reason.trim() ? { reason: reason.trim() } : {}) }), t("closeTitle", { month: fmt.month(month) })),
    onSuccess: () => (toast(t("closedDone", { month: fmt.month(month) })), invalidate(cache), onClose()),
    onError: (e) => {
      const err = e as { code?: string; details?: { open?: number } };
      if (err.code === "etax_incomplete") setOpen(err.details?.open ?? 1);
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("closeTitle", { month: fmt.month(month) })} description={t("closeDesc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), (!required || reason.trim().length >= 3) && m.mutate())}>
        {required && <Notice tone="warn">{t("closeEtax", { n: open })}</Notice>}
        <Textarea label={required ? t("closeReason") : t("closeReasonOptional")} value={reason} onChange={(e) => setReason(e.target.value)} />
        {!(m.error as { code?: string } | null)?.code?.startsWith("etax_incomplete") && <InlineError error={m.error} />}
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={(required && reason.trim().length < 3) || m.isPending}>
            <Lock size={14} aria-hidden="true" /> {t("closeSubmit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
