"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny } from "@/components/access";
import { useApprovalFlow } from "@/components/dialogs";
import { Chip, ChipGroup, Drawer, Empty, ErrorBlock, Modal, Notice, Pager, Seg, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useUrlFilters } from "@/lib/url-state";
import { useSupportStaff } from "@/lib/staff-options";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { ViewsBar } from "@/components/views-bar";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import { useDelivery } from "./Accounting";
import { ClosePeriodDialog, EtaxDrawer, useEtaxDetail, useTaxFmt } from "./Tax";
import { StatementImportButton } from "./Statement";

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const thisMonth = () => todayBkk().slice(0, 7);
function Table({ head, children, label }: { head: (string | { label: string; num?: boolean })[]; children: React.ReactNode; label?: string }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (typeof h === "string" ? <th key={h}>{h}</th> : <th key={h.label} className={h.num ? "num" : undefined}>{h.label}</th>))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });

// ---------------------------------------------------------------- เงินเข้า

interface Incoming {
  date: string;
  totalSatang: number;
  items: { id: string; at: string; amount: number; method: string; verifiedBy: string | null; providerRef: string | null; status: string; reconciliation: string; exceptionReason: string | null; invoice: { number: string }; workspace: { name: string } }[];
}
export function IncomingTab() {
  const t = useTranslations("money");
  const fmt = useFmt();
  const [date, setDate] = useState(todayBkk());
  const q = useQuery({ queryKey: ["ops", "payments", "incoming", date], queryFn: () => api.get<Incoming>(`/payments/incoming?date=${date}`), placeholderData: keepPreviousData });
  const finance = hasAny(useMe().data, "finance");
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("tabs.incoming")}</h2>
        {q.data && <span className="card-sub">{t("incoming.total", { amount: fmt.money(q.data.totalSatang) })}</span>}
        <span className="spacer" />
        {finance && <StatementImportButton />}
        <input type="date" className="input" style={{ width: "auto" }} aria-label={t("incoming.date")} value={date} onChange={(e) => setDate(e.target.value || todayBkk())} />
      </div>
      <p className="muted small">{t("incoming.note")}</p>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={7} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("incoming.empty")} />
      ) : (
        <Table head={[t("incoming.time"), t("verify.col.ws"), t("verify.col.invoice"), { label: t("incoming.amount"), num: true }, t("verify.col.channel"), t("incoming.by"), t("incoming.ref"), t("incoming.status"), t("incoming.recon")]}>
          {q.data.items.map((p) => (
            <tr key={p.id}>
              <td className="small">{fmt.dateTime(p.at)}</td>
              <td>{p.workspace.name}</td>
              <td className="mono small">{p.invoice.number}</td>
              <td className="num">{fmt.money(p.amount)}</td>
              <td>{t(`methods.${p.method}` as "methods.card")}</td>
              <td>{p.verifiedBy ? t(`incoming.verifiedBy.${p.verifiedBy}` as "incoming.verifiedBy.staff") : "—"}</td>
              <td className="mono small">{p.providerRef ?? "—"}</td>
              <td>
                <span className={p.status === "confirmed" ? "pill ok" : p.exceptionReason ? "pill warn" : "pill"}>{t(`incoming.pStatus.${p.status}` as "incoming.pStatus.confirmed")}</span>
              </td>
              <td>
                <span className={p.reconciliation === "matched" ? "pill ok" : p.reconciliation === "manual" ? "pill inf" : "pill"}>{t(`incoming.reconciliation.${p.reconciliation}` as "incoming.reconciliation.matched")}</span>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- ใบแจ้งหนี้

interface InvoiceRow {
  id: string;
  number: string;
  status: string;
  total: number;
  whtAmount: number;
  amountDue: number;
  poNumber: string | null;
  dueDate: string;
  paidAt: string | null;
  workspace: { id: string; slug: string; name: string };
  taxDocumentStatus: string | null;
  /** ใบกำกับภาษี / ใบเสร็จที่ยังมีผล (ฉบับแทนฉบับที่ยกเลิก) */
  taxDocument: { id: string; number: string; status: string; docType: string } | null;
  /** ไม่มีใน ops-api รุ่นก่อน (ระหว่าง deploy ทีละ service) */
  creditNotes?: { id: string; number: string }[];
  debitNotes?: { id: string; number: string }[];
  hasCreditNote: boolean;
}
/** ลิงก์ PDF ของเอกสาร (แม่แบบเดียวกับที่ลูกค้าได้) */
function DocLink({ path, label }: { path: string; label: string }) {
  return (
    <a className="link-button small mono" href={`${OPS_BASE}${path}`} target="_blank" rel="noreferrer">
      <FileText size={12} aria-hidden="true" /> {label}
    </a>
  );
}
const STATUSES = ["", "open", "pending_review", "overdue", "paid", "void"] as const;
const INVOICE_PAGE = 50;
export function InvoicesTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const t = useTranslations("money");
  const fmt = useFmt();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const params = useSearchParams();
  // ตัวกรองและหน้าอยู่ใน URL (ช่วง 1) · เดิมดึง 100 ใบแรกโดยไม่บอกว่ามีมากกว่านั้น
  // ช่วง 3: ครบกำหนด · วิธีชำระ · 50 ทวิ · ยอด (คีย์ตรงกับ ops-api › billing.service InvoicesQuery)
  const tf = useTranslations("money.invoices.f");
  const defs: FilterDef[] = [
    { key: "due", label: tf("due"), kind: "dates", fromKey: "dueFrom", toKey: "dueTo" },
    { key: "method", label: tf("method"), kind: "single", options: (["card", "promptpay", "transfer"] as const).map((m) => ({ value: m, label: tf(`methods.${m}`) })) },
    { key: "wht", label: tf("wht"), kind: "single", options: [{ value: "yes", label: tf("whtYes") }] },
    { key: "amount", label: tf("amount"), kind: "range", minKey: "amountMin", maxKey: "amountMax", unit: "baht" },
  ];
  const defaults = { status: "", q: "", page: "0", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const fq = filterQuery(defs, f);
  const setFilters = (patch: Record<string, string>) => setF({ ...patch, page: "0" });
  const status = f.status as (typeof STATUSES)[number];
  const setStatus = (v: (typeof STATUSES)[number]) => setF({ status: v, page: "0" });
  const [q, setQ] = useState(f.q || (params?.get("q") ?? ""));
  const search = useDeferredValue(q.trim());
  useEffect(() => {
    if (search !== f.q) setF({ q: search, page: "0" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const offset = Number(f.page) * INVOICE_PAGE || 0;
  const [voiding, setVoiding] = useState<InvoiceRow | null>(null);
  const [linking, setLinking] = useState<InvoiceRow | null>(null);
  const [debiting, setDebiting] = useState<InvoiceRow | null>(null);
  const [replacing, setReplacing] = useState<InvoiceRow | null>(null);
  const [etaxDoc, setEtaxDoc] = useState<string | null>(null);
  const tt = useTranslations("money.tax");
  const filter = new URLSearchParams({ limit: String(INVOICE_PAGE), offset: String(offset), ...(status ? { status } : {}), ...(search ? { q: search } : {}), ...fq });
  const list = useQuery({ queryKey: ["ops", "invoices", filter.toString()], queryFn: () => api.get<{ items: InvoiceRow[]; total: number }>(`/invoices?${filter}`), placeholderData: keepPreviousData });
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("tabs.invoices")}</h2>
        <span className="card-sub">{t("invoices.note")}</span>
      </div>
      <ChipGroup className="row">
        <div style={{ flex: "1 1 240px" }}>
          <Input data-page-search aria-label={t("invoices.search")} placeholder={t("invoices.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {STATUSES.map((s) => (
          <Chip key={s || "all"} pressed={status === s} onClick={() => setStatus(s)}>
            {s ? t(`invoices.status.${s}`) : t("invoices.statusAll")}
          </Chip>
        ))}
        <FilterButton defs={defs} values={f} onChange={setFilters} />
      </ChipGroup>
      <ViewsBar page="invoices" values={f} defaults={defaults} onApply={(v) => (setQ(v.q ?? ""), setF({ ...defaults, ...v }))} />
      <ActiveFilters defs={defs} values={f} onChange={setFilters} />
      {list.isPending ? (
        <TableSkeleton rows={5} cols={8} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty title={t("invoices.empty")} onClearFilters={status || search || Object.keys(fq).length ? () => (setQ(""), setF({ ...filterKeys(defs), status: "", page: "0" })) : undefined} />
      ) : (
        <Table head={[t("invoices.number"), t("invoices.ws"), { label: t("invoices.total"), num: true }, { label: t("invoices.wht"), num: true }, { label: t("invoices.due"), num: true }, t("invoices.dueDate"), t("incoming.status"), t("invoices.docs"), ...(finance ? [t("invoices.actions")] : [])]}>
          {list.data.items.map((i) => (
            <tr key={i.id}>
              <td className="mono small">
                {i.number}
                {i.poNumber && <div className="cell-sub">PO {i.poNumber}</div>}
              </td>
              <td>{i.workspace.name}</td>
              <td className="num">{fmt.money(i.total)}</td>
              <td className="num">{i.whtAmount ? fmt.money(i.whtAmount) : "—"}</td>
              <td className="num">{fmt.money(i.amountDue)}</td>
              <td>{fmt.date(i.dueDate)}</td>
              <td>
                <span className={i.status === "paid" ? "pill ok" : i.status === "void" ? "pill" : i.dueDate < todayBkk() ? "pill bad" : "pill warn"}>{t(`invoices.status.${i.status}` as "invoices.status.open")}</span>
                {i.hasCreditNote && <span className="pill inf">{t("invoices.cn")}</span>}
              </td>
              <td className="small">
                <span className="stack" style={{ gap: 2 }}>
                  <DocLink path={`/invoices/${i.id}/pdf`} label={t("invoices.invoicePdf")} />
                  {i.taxDocument && (
                    <span>
                      <DocLink path={`/tax-documents/${i.taxDocument.id}/pdf`} label={i.taxDocument.number} />{" "}
                      {/* เปิดรายละเอียด e-Tax (E2) จากแท็บใบแจ้งหนี้ */}
                      <button type="button" className="link-button small" onClick={() => setEtaxDoc(i.taxDocument!.id)}>
                        · {tt.has(`state.${i.taxDocument.status}`) ? tt(`state.${i.taxDocument.status}` as "state.issued") : i.taxDocument.status}
                      </button>
                    </span>
                  )}
                  {(i.creditNotes ?? []).map((n) => (
                    <DocLink key={n.id} path={`/credit-notes/${n.id}/pdf`} label={n.number} />
                  ))}
                  {(i.debitNotes ?? []).map((n) => (
                    <DocLink key={n.id} path={`/debit-notes/${n.id}/pdf`} label={n.number} />
                  ))}
                </span>
              </td>
              {finance && (
                <td>
                  <span className="row" style={{ flexWrap: "nowrap" }}>
                    {(i.status === "open" || i.status === "pending_review") && (
                      <Button size="small" onClick={() => setLinking(i)}>
                        {t("invoices.link")}
                      </Button>
                    )}
                    {i.status === "paid" && i.taxDocument && i.taxDocument.status !== "cancelled" && (
                      <>
                        <Button size="small" onClick={() => setDebiting(i)}>
                          {t("invoices.debit")}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => setReplacing(i)}>
                          {t("invoices.replace")}
                        </Button>
                      </>
                    )}
                    {i.status !== "void" && (
                      <Button size="small" variant="ghost" onClick={() => setVoiding(i)}>
                        {t("invoices.void")}
                      </Button>
                    )}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
      {list.data?.total != null && <Pager offset={offset} limit={INVOICE_PAGE} shown={list.data.items.length} total={list.data.total} onChange={(o) => setF({ page: String(Math.floor(o / INVOICE_PAGE)) })} />}
      {creating && <CreateInvoiceDrawer onClose={() => onCreatingChange(false)} />}
      {voiding && <VoidDialog inv={voiding} onClose={() => setVoiding(null)} />}
      {linking && <SendLinkDialog inv={linking} onClose={() => setLinking(null)} />}
      {debiting && <DebitNoteDialog inv={debiting} onClose={() => setDebiting(null)} />}
      {replacing && <ReplaceTaxDocDialog inv={replacing} onClose={() => setReplacing(null)} />}
      {etaxDoc && <EtaxDrawer kind="tax_document" id={etaxDoc} onClose={() => setEtaxDoc(null)} />}
    </section>
  );
}

/** B1 · สร้างใบแจ้งหนี้ด้วยมือ */
function CreateInvoiceDrawer({ onClose }: { onClose: () => void }) {
  const t = useTranslations("money.b1");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [wsQ, setWsQ] = useState("");
  const [ws, setWs] = useState<{ id: string; name: string } | null>(null);
  const [po, setPo] = useState("");
  const [dueDays, setDueDays] = useState("30");
  const [items, setItems] = useState([{ description: "", qty: "1", unit: "" }]);
  const [discount, setDiscount] = useState("0");
  const [wht, setWht] = useState(false);
  const [plan, setPlan] = useState("");
  const [cycle, setCycle] = useState<"monthly" | "yearly">("yearly");
  const [start, setStart] = useState(todayBkk());
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [send, setSend] = useState(true);
  const search = useDeferredValue(wsQ.trim());
  const found = useQuery({ queryKey: ["ops", "workspaces", "pick", search], queryFn: () => api.get<{ items: { id: string; name: string; slug: string }[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`), enabled: !ws && search.length >= 2 });
  const lines = items.map((i) => ({ description: i.description.trim(), qty: Number(i.qty), unitSatang: Math.round(Number(i.unit) * 100) }));
  const gross = lines.reduce((n, l) => n + l.qty * l.unitSatang, 0);
  const subtotal = gross - Math.round((gross * Number(discount)) / 100);
  const vat = Math.round(subtotal * 0.07);
  const whtAmt = wht ? Math.round(subtotal * 0.03) : 0;
  const ok = !!ws && lines.every((l) => l.description && l.qty >= 1 && l.unitSatang >= 0) && subtotal > 0 && (!plan || !!end);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ invoice: { number: string } }>("/invoices", {
        workspaceId: ws!.id,
        ...(po.trim() ? { poNumber: po.trim() } : {}),
        dueDays: Number(dueDays),
        items: lines,
        discountPct: Number(discount),
        wht,
        ...(plan ? { plan: { code: plan, cycle, periodStart: start, periodEnd: end } } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        send,
      }),
    onSuccess: (r) => (toast(t("done", { number: r.invoice.number })), invalidate(cache), onClose()),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} wide title={t("title")} description={t("desc")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && create.mutate())}>
        {ws ? (
          <div className="row">
            <span className="field-label">{t("ws")}:</span> <b>{ws.name}</b>
            <Button size="small" variant="ghost" onClick={() => setWs(null)}>
              ✕
            </Button>
          </div>
        ) : (
          <div className="field">
            <Input label={t("ws")} placeholder={t("wsSearch")} value={wsQ} onChange={(e) => setWsQ(e.target.value)} />
            {found.data?.items.map((w) => (
              <button key={w.id} type="button" className="menu-item" onClick={() => setWs(w)}>
                {w.name} <span className="muted small">{w.slug}</span>
              </button>
            ))}
          </div>
        )}
        <div className="grid-2">
          <Input label={t("po")} value={po} onChange={(e) => setPo(e.target.value)} />
          <Input label={t("dueDays")} type="number" min={1} max={90} value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
        </div>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("items")}</legend>
          {items.map((it, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: "3 1 200px" }}>
                <Input label={`${t("desc2")} ${i + 1}`} value={it.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              </div>
              <div style={{ flex: "1 1 70px" }}>
                <Input label={t("qty")} type="number" min={1} value={it.qty} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              </div>
              <div style={{ flex: "1 1 110px" }}>
                <Input label={t("unit")} type="number" min={0} value={it.unit} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
              </div>
              {items.length > 1 && (
                <Button size="small" variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  {t("remove")}
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button size="small" onClick={() => setItems([...items, { description: "", qty: "1", unit: "" }])}>
              {t("add")}
            </Button>
          </div>
        </fieldset>
        <div className="grid-2">
          <Input label={t("discount")} type="number" min={0} max={100} value={discount} onChange={(e) => setDiscount(e.target.value)} />
          <label className="check" style={{ alignSelf: "end" }}>
            <input type="checkbox" checked={wht} onChange={(e) => setWht(e.target.checked)} />
            <span>{t("wht")}</span>
          </label>
        </div>
        <div className="field">
          <label htmlFor="b1-plan">{t("plan")}</label>
          <select id="b1-plan" className="input" value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">{t("planNone")}</option>
            {["team_s", "team_m", "team_l", "enterprise"].map((p) => (
              <option key={p} value={p}>
                {planLabel(p)}
              </option>
            ))}
          </select>
        </div>
        {plan && (
          <div className="grid-3">
            <div className="field">
              <span className="field-label">{t("cycle")}</span>
              <Seg label={t("cycle")} value={cycle} onChange={setCycle} options={[{ value: "monthly", label: "รายเดือน" }, { value: "yearly", label: "รายปี" }]} />
            </div>
            <Input label={t("start")} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <Input label={t("end")} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        )}
        <Textarea label={t("note")} value={note} onChange={(e) => setNote(e.target.value)} />
        <table className="tbl" aria-label={t("amountDue")}>
          <tbody>
            <tr>
              <td>{t("subtotal")}</td>
              <td className="num">{fmt.money(subtotal)}</td>
            </tr>
            <tr>
              <td>{t("vat")}</td>
              <td className="num">{fmt.money(vat)}</td>
            </tr>
            {wht && (
              <tr>
                <td>{t("whtLine")}</td>
                <td className="num">−{fmt.money(whtAmt)}</td>
              </tr>
            )}
            <tr>
              <td className="cell-main">{t("amountDue")}</td>
              <td className="num cell-main">{fmt.money(subtotal + vat - whtAmt)}</td>
            </tr>
          </tbody>
        </table>
        <label className="check">
          <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
          <span>{t("send")}</span>
        </label>
        <p className="muted small">{t("fixed")}</p>
        <InlineError error={create.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || create.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

/** B2 · ยกเลิกใบแจ้งหนี้ (ชำระแล้วออกใบลดหนี้ · เครดิต / คืนเงิน / ไม่คืน) */
function VoidDialog({ inv, onClose }: { inv: InvoiceRow; onClose: () => void }) {
  const t = useTranslations("money.b2");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const paid = inv.status === "paid";
  const [money, setMoney] = useState<"credit" | "refund" | "none">("credit");
  const [method, setMethod] = useState<"original" | "bank_transfer">("bank_transfer");
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/invoices/${inv.id}/void`, { reason: reason.trim(), ...(paid ? { money, refundMethod: method } : {}) }).then(handle),
    onSuccess: (r) => {
      if (!(r as { pendingApproval?: unknown })?.pendingApproval) toast(t("done", { number: inv.number }));
      invalidate(cache);
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { number: inv.number })} description={paid ? t("paidDesc", { ws: inv.workspace.name, amount: fmt.money(inv.amountDue) }) : t("openDesc", { ws: inv.workspace.name })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate())}>
        {paid && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("money")}</legend>
            {(["credit", "refund", "none"] as const).map((v) => (
              <label key={v} className="check">
                <input type="radio" name="b2-money" checked={money === v} onChange={() => setMoney(v)} />
                <span>
                  <b>{t(v)}</b> <span className="muted">· {t(`${v}Desc`)}</span>
                </span>
              </label>
            ))}
            {money === "refund" && <Seg label={t("method")} value={method} onChange={setMethod} options={[{ value: "bank_transfer", label: t("bank") }, { value: "original", label: t("original") }]} />}
          </fieldset>
        )}
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

/** B5 · ส่งลิงก์จ่ายเงิน */
function SendLinkDialog({ inv, onClose }: { inv: InvoiceRow; onClose: () => void }) {
  const t = useTranslations("money.b5");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const [to, setTo] = useState("");
  const m = useMutation({ mutationFn: () => api.post<{ sent: number }>(`/invoices/${inv.id}/send-link`, to.trim() ? { to: to.trim() } : {}), onSuccess: (r) => (toast(t("done", { n: r.sent })), onClose()) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { ws: inv.workspace.name })} description={inv.number}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <Input label={t("to")} type="email" placeholder={t("all")} value={to} onChange={(e) => setTo(e.target.value)} />
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** ใบเพิ่มหนี้ (ม.86/9): ยอดที่คิดขาดก่อน VAT · ระบบออกใบแจ้งหนี้ส่วนเพิ่มให้ลูกค้าจ่ายที่หน้าชำระใบแจ้งหนี้ */
function DebitNoteDialog({ inv, onClose }: { inv: InvoiceRow; onClose: () => void }) {
  const t = useTranslations("money.debit");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [dueDays, setDueDays] = useState("7");
  const satang = Math.round(Number(amount.replace(/,/g, "")) * 100);
  const valid = satang > 0 && reason.trim().length >= 3 && Number(dueDays) >= 1 && Number(dueDays) <= 90;
  const m = useMutation({
    mutationFn: () => api.post<{ debitNote: { number: string }; invoice: { number: string } }>(`/invoices/${inv.id}/debit-note`, { amountSatang: satang, reason: reason.trim(), dueDays: Number(dueDays) }),
    onSuccess: (r) => (toast(t("done", { number: r.debitNote.number, invoice: r.invoice.number })), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { number: inv.taxDocument?.number ?? inv.number })} description={t("desc", { ws: inv.workspace.name })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), valid && m.mutate())}>
        <Input label={t("amount")} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input label={t("dueDays")} type="number" min={1} max={90} value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!valid || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const CAUSES = ["buyer", "taxId", "branch", "other"] as const;
/** E3 · ออกฉบับใหม่แทน: แก้ข้อมูลผู้ซื้อในหน้าจอ · แจ้งยกเลิกฉบับเดิมที่ผู้ให้บริการและส่งฉบับใหม่อ้างฉบับเดิมอัตโนมัติ */
function ReplaceTaxDocDialog({ inv, onClose }: { inv: InvoiceRow; onClose: () => void }) {
  const t = useTranslations("money.replace");
  const tc = useTranslations("common.dialog");
  const tf = useTaxFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const doc = inv.taxDocument!;
  const detail = useEtaxDetail("tax_document", doc.id);
  const base = detail.data?.currentBuyer ?? detail.data?.buyer ?? null;
  const [cause, setCause] = useState<(typeof CAUSES)[number]>("buyer");
  const [other, setOther] = useState("");
  const [buyer, setBuyer] = useState<{ companyName: string; taxId: string; branchType: string; branchNo: string; address: string } | null>(null);
  const b = buyer ?? (base ? { companyName: base.companyName, taxId: base.taxId, branchType: base.branchType, branchNo: base.branchNo ?? "", address: base.address } : null);
  const edit = (patch: Partial<NonNullable<typeof b>>) => b && setBuyer({ ...b, ...patch });
  const reason = cause === "other" ? other.trim() : t(`causes.${cause}`);
  const ok = !!b && reason.length >= 3 && /^\d{13}$/.test(b.taxId) && !!b.companyName.trim() && !!b.address.trim() && (b.branchType === "head" || /^\d{5}$/.test(b.branchNo));
  const m = useMutation({
    mutationFn: () => api.post<{ replacement: { number: string } }>(`/tax-documents/${doc.id}/replace`, { reason, buyer: { companyName: b!.companyName.trim(), taxId: b!.taxId, branchType: b!.branchType, branchNo: b!.branchType === "head" ? null : b!.branchNo, address: b!.address.trim() } }),
    onSuccess: (r) => (toast(t("done", { old: doc.number, number: r.replacement.number })), invalidate(cache), onClose()),
  });
  const date = tf.dateYear(detail.data?.issuedOn);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { number: doc.number })} description={t("desc")} className="dialog-wide">
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Select label={t("cause")} value={cause} onChange={(e) => setCause(e.target.value as (typeof CAUSES)[number])}>
          {CAUSES.map((c) => (
            <option key={c} value={c}>
              {t(`causes.${c}`)}
            </option>
          ))}
        </Select>
        {cause === "other" && <Textarea label={t("reason")} placeholder={t("placeholder")} value={other} onChange={(e) => setOther(e.target.value)} />}
        {!b ? (
          detail.error ? <InlineError error={detail.error} /> : <TableSkeleton rows={3} cols={2} />
        ) : (
          <div className="stack">
            <Input label={t("company")} value={b.companyName} onChange={(e) => edit({ companyName: e.target.value })} />
            <Input label={t("taxId")} inputMode="numeric" className="mono" value={b.taxId} onChange={(e) => edit({ taxId: e.target.value.replace(/\D/g, "").slice(0, 13) })} />
            <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
              <Select label={t("branch")} value={b.branchType} onChange={(e) => edit({ branchType: e.target.value })}>
                <option value="head">{t("head")}</option>
                <option value="branch">{t("branchOther")}</option>
              </Select>
              {b.branchType === "branch" && <Input label={t("branchNo")} inputMode="numeric" className="mono" value={b.branchNo} onChange={(e) => edit({ branchNo: e.target.value.replace(/\D/g, "").slice(0, 5) })} />}
            </div>
            <Textarea label={t("address")} value={b.address} onChange={(e) => edit({ address: e.target.value })} />
          </div>
        )}
        <h3 className="field-label">{t("next")}</h3>
        <ol className="timeline">
          <li className="timeline-item tone-warn">
            <span className="mono small">1</span>
            <span className="small">
              <b>{t("steps.cancel", { number: doc.number })}</b>
              <div className="cell-sub">{t("steps.cancelHint")}</div>
            </span>
          </li>
          <li className="timeline-item">
            <span className="mono small">2</span>
            <span className="small">
              <b>{t("steps.notify")}</b>
              <div className="cell-sub">{t("steps.notifyHint")}</div>
            </span>
          </li>
          <li className="timeline-item">
            <span className="mono small">3</span>
            <span className="small">
              <b>{t("steps.issue", { date })}</b>
              <div className="cell-sub">{t("steps.issueHint")}</div>
            </span>
          </li>
          <li className="timeline-item">
            <span className="mono small">4</span>
            <span className="small">
              <b>{t("steps.send")}</b>
            </span>
          </li>
          <li className="timeline-item">
            <span className="mono small">5</span>
            <span className="small">
              <b>{t("steps.mail")}</b>
            </span>
          </li>
        </ol>
        <Notice tone="warn">{t("closedInfo")}</Notice>
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- ค้างชำระ

interface OverdueRow {
  id: string;
  number: string;
  amountDue: number;
  dueDate: string;
  daysOverdue: number;
  workspace: { name: string };
  events: { at: string; step: string; channel: string; result: string | null }[];
  reminders: { email: number; line: number; phone: number };
  nextStep: { day: number; step: string; on: string } | null;
  needsHuman: boolean;
}
const OVERDUE_PAGE = 50;
export function OverdueTab() {
  const t = useTranslations("money");
  const fmt = useFmt();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  // ช่วง 1 (ข้อมูลเยอะ): ค้นและแบ่งหน้าที่ ops-api · เรียงตามยอด × วันที่ค้าง
  // ช่วง 3: ตัวกรองอยู่ใน URL (บันทึกเป็นมุมมองได้) · คีย์ตรงกับ ops-api › billing.service OverdueQuery
  const tf = useTranslations("money.overdue.f");
  const staff = useSupportStaff();
  const defs: FilterDef[] = [
    { key: "age", label: tf("age"), kind: "single", options: (["1-7", "8-30", "31+"] as const).map((v) => ({ value: v, label: tf(`ages.${v}`) })) },
    { key: "amount", label: tf("amount"), kind: "range", minKey: "amountMin", maxKey: "amountMax", unit: "baht" },
    { key: "plan", label: tf("plan"), kind: "single", options: (["team_s", "team_m", "team_l", "enterprise"] as const).map((p) => ({ value: p, label: planLabel(p) })) },
    { key: "cycle", label: tf("cycle"), kind: "single", options: (["monthly", "yearly"] as const).map((c) => ({ value: c, label: tf(`cycles.${c}`) })) },
    { key: "contacted", label: tf("contacted"), kind: "single", options: (["yes", "no"] as const).map((c) => ({ value: c, label: tf(`contactedOpts.${c}`) })) },
    { key: "human", label: tf("human"), kind: "single", options: [{ value: "yes", label: tf("humanYes") }] },
    { key: "manager", label: tf("manager"), kind: "single", options: [{ value: "none", label: tf("noManager") }, ...staff] },
  ];
  const defaults = { q: "", page: "0", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const fq = filterQuery(defs, f);
  const setFilters = (patch: Record<string, string>) => setF({ ...patch, page: "0" });
  const [search, setSearch] = useState(f.q);
  const offset = Number(f.page) * OVERDUE_PAGE || 0;
  const setOffset = (v: number) => setF({ page: String(Math.floor(v / OVERDUE_PAGE)) });
  const term = useDeferredValue(search.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term, page: "0" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const qs = new URLSearchParams({ limit: String(OVERDUE_PAGE), offset: String(offset), ...(term ? { q: term } : {}), ...fq });
  const q = useQuery({ queryKey: ["ops", "overdue", qs.toString()], queryFn: () => api.get<{ items: OverdueRow[]; total: number; totalSatang: number }>(`/overdue?${qs}`), placeholderData: keepPreviousData });
  const [contact, setContact] = useState<OverdueRow | null>(null);
  const [extend, setExtend] = useState<OverdueRow | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{q.data ? t("overdue.total", { amount: fmt.money(q.data.totalSatang) }) : t("tabs.overdue", { n: "" })}</h2>
        <span className="card-sub">{t("overdue.steps")}</span>
      </div>
      <p className="muted small">{t("overdue.note")}</p>
      <div className="row">
        <div style={{ flex: "1 1 240px" }}>
          <Input data-page-search type="search" aria-label={t("overdue.search")} placeholder={t("overdue.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <FilterButton defs={defs} values={f} onChange={setFilters} />
      </div>
      <ViewsBar page="overdue" values={f} defaults={defaults} onApply={(v) => (setSearch(v.q ?? ""), setF({ ...defaults, ...v }))} />
      <ActiveFilters defs={defs} values={f} onChange={setFilters} />
      {q.isPending ? (
        <TableSkeleton rows={4} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        term || Object.keys(fq).length ? <Empty title={t("overdue.noMatch")} onClearFilters={() => (setSearch(""), setF({ ...filterKeys(defs), q: "", page: "0" }))} /> : <Empty ok title={t("overdue.empty")} />
      ) : (
        <Table head={[t("overdue.invoice"), t("verify.col.ws"), { label: t("incoming.amount"), num: true }, t("overdue.late"), t("overdue.reminded"), t("overdue.next"), ...(finance ? [t("invoices.actions")] : [])]}>
          {q.data.items.map((r) => (
            <tr key={r.id}>
              <td className="mono small">{r.number}</td>
              <td>
                {r.workspace.name} {r.needsHuman && <span className="pill warn">{t("overdue.human")}</span>}
              </td>
              <td className="num">{fmt.money(r.amountDue)}</td>
              <td>
                <span className={r.daysOverdue > 7 ? "pill bad" : "pill warn"}>{t("overdue.days", { n: r.daysOverdue })}</span>
              </td>
              <td className="small">{t("overdue.remindersValue", r.reminders)}</td>
              <td className="small">{r.nextStep ? t("overdue.nextValue", { step: t(`overdue.stepNames.${r.nextStep.step}` as "overdue.stepNames.reminder"), date: fmt.date(r.nextStep.on) }) : t("overdue.none")}</td>
              {finance && (
                <td>
                  <span className="row" style={{ flexWrap: "nowrap" }}>
                    <Button size="small" onClick={() => setContact(r)}>
                      {t("overdue.contact")}
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => setExtend(r)}>
                      {t("overdue.extend")}
                    </Button>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
      {q.data?.total != null && <Pager offset={offset} limit={OVERDUE_PAGE} shown={q.data.items.length} total={q.data.total} onChange={setOffset} />}
      {contact && <ContactDrawer row={contact} onClose={() => setContact(null)} />}
      {extend && <ExtendDialog row={extend} onClose={() => setExtend(null)} />}
    </section>
  );
}

/** B3 · ติดต่อลูกค้าค้างชำระ */
function ContactDrawer({ row, onClose }: { row: OverdueRow; onClose: () => void }) {
  const t = useTranslations("money.b3");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [channel, setChannel] = useState<"email" | "line" | "phone">("email");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/invoices/${row.id}/contact`, { channel, ...(message.trim() ? { message: message.trim() } : {}), ...(result.trim() ? { result: result.trim() } : {}) }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  const ok = channel !== "phone" || result.trim().length > 0;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title", { ws: row.workspace.name })} description={t("desc", { amount: fmt.money(row.amountDue), days: row.daysOverdue })}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="field">
          <span className="field-label">{t("channel")}</span>
          <Seg label={t("channel")} value={channel} onChange={setChannel} options={[{ value: "email", label: t("email") }, { value: "line", label: t("line") }, { value: "phone", label: t("phone") }]} />
        </div>
        {channel === "email" && <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} />}
        {channel === "line" && <p className="muted small">{t("lineNote")}</p>}
        {channel !== "email" && <Input label={t("result")} value={result} onChange={(e) => setResult(e.target.value)} />}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
      <section className="stack">
        <h3 className="card-title">{t("history")}</h3>
        {row.events.map((e, i) => (
          <div key={i} className="small">
            <span className="muted">{fmt.dateTime(e.at)}</span> · {e.step} · {e.channel} {e.result ? `· ${e.result}` : ""}
          </div>
        ))}
      </section>
    </Drawer>
  );
}

/** B4 · ขยายเวลาชำระ */
function ExtendDialog({ row, onClose }: { row: OverdueRow; onClose: () => void }) {
  const t = useTranslations("money.b4");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const m = useMutation({ mutationFn: () => api.post(`/invoices/${row.id}/extend`, { dueDate: date, reason: reason.trim(), notify }), onSuccess: () => (toast(t("done")), invalidate(cache), onClose()) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { ws: row.workspace.name })} description={t("desc", { number: row.number, date: fmt.date(row.dueDate) })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), date && reason.trim().length >= 3 && m.mutate())}>
        <Input label={t("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} hint={t("max")} />
        <p className="muted small">{t("notes")}</p>
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>{t("notify")}</span>
        </label>
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!date || reason.trim().length < 3 || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- ภาษี

// ---------------------------------------------------------------- คืนเงิน (สรุป)

interface RefundsData {
  pending: { id: string }[];
  history: { id: string; at: string; type: string; ref: string | null; reason: string | null; amountSatang: number; workspace: { name: string } }[];
}
export function RefundsSummaryTab() {
  const t = useTranslations("money");
  const fmt = useFmt();
  const q = useQuery({ queryKey: ["ops", "refunds"], queryFn: () => api.get<RefundsData>("/refunds") });
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("refundsTab.recent")}</h2>
        {q.data && <span className="pill warn">{t("refundsTab.pending", { n: q.data.pending.length })}</span>}
        <span className="spacer" />
        <Link href="/refunds" className={buttonClass("primary", "small")}>
          {t("refundsTab.open")}
        </Link>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <Table head={[t("refunds.col.date"), t("refunds.col.type"), t("refunds.col.ws"), t("refunds.col.ref"), { label: t("refunds.col.amount"), num: true }, t("refunds.col.reason")]}>
          {q.data.history.slice(0, 10).map((h) => (
            <tr key={h.id}>
              <td>{fmt.date(h.at)}</td>
              <td>{t(`refunds.types.${h.type}` as "refunds.types.refund")}</td>
              <td>{h.workspace.name}</td>
              <td className="mono small">{h.ref ?? "—"}</td>
              <td className="num">{fmt.money(h.amountSatang)}</td>
              <td className="small">{h.reason}</td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- รายงานรายได้ · ปิดงวด · ส่งออก (B8)

interface RevenueRow {
  month: string;
  recognizedSatang: number;
  cashSatang: number;
  vatSatang: number;
  whtSatang: number;
  feesSatang: number;
  refundsSatang: number;
  deferredSatang: number;
  closed: boolean;
}
export function RevenueTab() {
  const t = useTranslations("money.revenue");
  const fmt = useFmt();
  const me = useMe().data;
  const tf = useTaxFmt();
  const [closing, setClosing] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["ops", "revenue"], queryFn: () => api.get<{ months: RevenueRow[] }>("/revenue?months=6") });
  const delivery = useDelivery();
  const canClose = hasAny(me, "owner", "finance");
  const set = delivery.data?.settings;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("note")}</span>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={6} cols={9} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <Table label={t("title")} head={[t("month"), ...(["recognized", "cash", "vat", "wht", "fees", "refunds", "deferred"] as const).map((k) => ({ label: t(k), num: true })), t("close")]}>
          {q.data.months.map((m) => (
            <tr key={m.month}>
              <td className="mono">{m.month}</td>
              <td className="num">{fmt.money(m.recognizedSatang)}</td>
              <td className="num">{fmt.money(m.cashSatang)}</td>
              <td className="num">{fmt.money(m.vatSatang)}</td>
              <td className="num">{fmt.money(m.whtSatang)}</td>
              <td className="num">{fmt.money(m.feesSatang)}</td>
              <td className="num">{fmt.money(m.refundsSatang)}</td>
              <td className="num">{fmt.money(m.deferredSatang)}</td>
              <td>
                {m.closed ? (
                  <span className="pill ok">{t("closed")}</span>
                ) : canClose && m.month < thisMonth() ? (
                  <Button size="small" onClick={() => setClosing(m.month)}>
                    {t("close")}
                  </Button>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {/* อ่านจากค่าตั้งจริง (E6) ไม่เขียนวันที่ตายตัว */}
      {set && <p className="muted small">{set.auto && delivery.data?.next ? t("accountant", { day: set.day, time: set.time, next: tf.date(delivery.data.next.date) }) : t("accountantOff")}</p>}
      {closing && <ClosePeriodDialog month={closing} onClose={() => setClosing(null)} />}
    </section>
  );
}
