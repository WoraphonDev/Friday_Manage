"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { ConfirmDialog, useApprovalFlow, useReauth } from "@/components/dialogs";
import { Chip, Drawer, Empty, ErrorBlock, Modal, Notice, Seg, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, errorToast, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import { planLabel, useFmt } from "../../workspaces/_parts/format";

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const thisMonth = () => todayBkk().slice(0, 7);
const lastMonth = () => {
  const d = new Date(`${thisMonth()}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
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
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("tabs.incoming")}</h2>
        {q.data && <span className="card-sub">{t("incoming.total", { amount: fmt.money(q.data.totalSatang) })}</span>}
        <span className="spacer" />
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
  hasCreditNote: boolean;
}
const STATUSES = ["", "open", "pending_review", "overdue", "paid", "void"] as const;
export function InvoicesTab({ creating, onCreatingChange }: { creating: boolean; onCreatingChange: (o: boolean) => void }) {
  const t = useTranslations("money");
  const fmt = useFmt();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const params = useSearchParams();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const [q, setQ] = useState(params?.get("q") ?? "");
  const search = useDeferredValue(q.trim());
  const [voiding, setVoiding] = useState<InvoiceRow | null>(null);
  const [linking, setLinking] = useState<InvoiceRow | null>(null);
  const filter = new URLSearchParams({ limit: "100", ...(status ? { status } : {}), ...(search ? { q: search } : {}) });
  const list = useQuery({ queryKey: ["ops", "invoices", filter.toString()], queryFn: () => api.get<{ items: InvoiceRow[]; total: number }>(`/invoices?${filter}`), placeholderData: keepPreviousData });
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("tabs.invoices")}</h2>
        <span className="card-sub">{t("invoices.note")}</span>
      </div>
      <div className="row">
        <div style={{ flex: "1 1 240px" }}>
          <Input aria-label={t("invoices.search")} placeholder={t("invoices.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {STATUSES.map((s) => (
          <Chip key={s || "all"} pressed={status === s} onClick={() => setStatus(s)}>
            {s ? t(`invoices.status.${s}`) : t("invoices.statusAll")}
          </Chip>
        ))}
      </div>
      {list.isPending ? (
        <TableSkeleton rows={5} cols={8} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty title={t("invoices.empty")} onClearFilters={status || search ? () => (setStatus(""), setQ("")) : undefined} />
      ) : (
        <Table head={[t("invoices.number"), t("invoices.ws"), { label: t("invoices.total"), num: true }, { label: t("invoices.wht"), num: true }, { label: t("invoices.due"), num: true }, t("invoices.dueDate"), t("incoming.status"), t("invoices.etax"), ...(finance ? [t("invoices.actions")] : [])]}>
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
              <td className="small">{i.taxDocumentStatus ?? "—"}</td>
              {finance && (
                <td>
                  <span className="row" style={{ flexWrap: "nowrap" }}>
                    {(i.status === "open" || i.status === "pending_review") && (
                      <Button size="small" onClick={() => setLinking(i)}>
                        {t("invoices.link")}
                      </Button>
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
      {creating && <CreateInvoiceDrawer onClose={() => onCreatingChange(false)} />}
      {voiding && <VoidDialog inv={voiding} onClose={() => setVoiding(null)} />}
      {linking && <SendLinkDialog inv={linking} onClose={() => setLinking(null)} />}
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
export function OverdueTab() {
  const t = useTranslations("money");
  const fmt = useFmt();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const q = useQuery({ queryKey: ["ops", "overdue"], queryFn: () => api.get<{ items: OverdueRow[]; totalSatang: number }>("/overdue") });
  const [contact, setContact] = useState<OverdueRow | null>(null);
  const [extend, setExtend] = useState<OverdueRow | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{q.data ? t("overdue.total", { amount: fmt.money(q.data.totalSatang) }) : t("tabs.overdue", { n: "" })}</h2>
        <span className="card-sub">{t("overdue.steps")}</span>
      </div>
      <p className="muted small">{t("overdue.note")}</p>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("overdue.empty")} />
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

interface Tax {
  etax: { id: string; number: string; docType: string; status: string; createdAt: string; invoice: string; workspace: { name: string } }[];
  wht: { id: string; number: string; whtAmount: number; paidAt: string; daysSincePaid: number; certificateStatus: string | null; certificateId: string | null; workspace: { name: string } }[];
  whtPendingSatang: number;
  salesVat: { month: string; vatRegistered: boolean; invoices: number; subtotalSatang: number; vatSatang: number; whtSatang: number; creditNoteVatSatang: number; netVatSatang: number };
}
export function TaxTab() {
  const t = useTranslations("money.tax");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const [month, setMonth] = useState(thisMonth());
  const q = useQuery({ queryKey: ["ops", "tax", month], queryFn: () => api.get<Tax>(`/tax?month=${month}`), placeholderData: keepPreviousData });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/tax-documents/${id}/retry`), onSuccess: () => (toast(t("retried")), invalidate(cache)), onError: (e) => toast(errorToast(e)) });
  const review = useMutation({ mutationFn: ({ id, ok }: { id: string; ok: boolean }) => api.post(`/wht-certificates/${id}/${ok ? "confirm" : "reject"}`, ok ? {} : { reason: "เอกสารไม่ถูกต้อง" }), onSuccess: () => invalidate(cache), onError: (e) => toast(errorToast(e)) });
  if (q.isPending) return <TableSkeleton rows={4} cols={5} />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("etax")}</h2>
          <span className="card-sub">{t("etaxNote")}</span>
        </div>
        {!d.etax.length ? (
          <Empty ok title={t("noEtax")} />
        ) : (
          <Table head={[t("doc"), "ใบแจ้งหนี้", "Workspace", t("status"), ""]}>
            {d.etax.map((x) => (
              <tr key={x.id}>
                <td className="mono small">{x.number}</td>
                <td className="mono small">{x.invoice}</td>
                <td>{x.workspace.name}</td>
                <td>
                  <span className={x.status === "failed" ? "pill bad" : "pill warn"}>{x.status}</span>
                </td>
                <td>
                  {finance && x.status === "failed" && (
                    <Button size="small" disabled={retry.isPending} onClick={() => retry.mutate(x.id)}>
                      {t("retry")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("wht")}</h2>
          <span className="card-sub">{t("whtPending", { amount: fmt.money(d.whtPendingSatang) })}</span>
        </div>
        <p className="muted small">{t("whtNote")}</p>
        {!d.wht.length ? (
          <p className="muted small">{t("noWht")}</p>
        ) : (
          <Table head={["ใบแจ้งหนี้", "Workspace", { label: "ภาษีที่หัก", num: true }, t("status"), ""]}>
            {d.wht.map((w) => (
              <tr key={w.id}>
                <td className="mono small">{w.number}</td>
                <td>{w.workspace.name}</td>
                <td className="num">{fmt.money(w.whtAmount)}</td>
                <td>
                  <span className={w.certificateStatus === "pending_review" ? "pill warn" : "pill"}>{t(`certStatus.${w.certificateStatus ?? "missing"}` as "certStatus.missing")}</span> <span className="muted small">{t("days", { n: w.daysSincePaid })}</span>
                </td>
                <td>
                  {w.certificateId && (
                    <span className="row" style={{ flexWrap: "nowrap" }}>
                      <a className={buttonClass("ghost", "small")} href={`${OPS_BASE}/wht-certificates/${w.certificateId}/file`} target="_blank" rel="noreferrer">
                        <FileText size={14} /> {t("file")}
                      </a>
                      {finance && w.certificateStatus === "pending_review" && (
                        <>
                          <Button size="small" variant="primary" onClick={() => review.mutate({ id: w.certificateId!, ok: true })}>
                            {t("confirm")}
                          </Button>
                          <Button size="small" onClick={() => review.mutate({ id: w.certificateId!, ok: false })}>
                            {t("reject")}
                          </Button>
                        </>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("sales")}</h2>
          <span className="spacer" />
          <input type="month" className="input" style={{ width: "auto" }} aria-label={t("month")} value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />
        </div>
        {!d.salesVat.vatRegistered && <Notice tone="warn">{t("notRegistered")}</Notice>}
        <table className="tbl" aria-label={t("sales")}>
          <tbody>
            <tr>
              <td>{t("invoicesN", { n: d.salesVat.invoices })}</td>
              <td className="num">
                {t("base")} {fmt.money(d.salesVat.subtotalSatang)}
              </td>
            </tr>
            <tr>
              <td>{t("vat")}</td>
              <td className="num">{fmt.money(d.salesVat.vatSatang)}</td>
            </tr>
            <tr>
              <td>{t("cnVat")}</td>
              <td className="num">−{fmt.money(d.salesVat.creditNoteVatSatang)}</td>
            </tr>
            <tr>
              <td className="cell-main">{t("net")}</td>
              <td className="num cell-main">{fmt.money(d.salesVat.netVatSatang)}</td>
            </tr>
            <tr>
              <td className="muted">{t("whtTotal")}</td>
              <td className="num">{fmt.money(d.salesVat.whtSatang)}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

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
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const { run } = useReauth();
  const [closing, setClosing] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["ops", "revenue"], queryFn: () => api.get<{ months: RevenueRow[] }>("/revenue?months=6") });
  const canClose = hasAny(me, "owner", "finance");
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
      <p className="muted small">{t("accountant")}</p>
      {closing && (
        <ConfirmDialog
          open
          minReason={0}
          onOpenChange={() => setClosing(null)}
          title={t("closeTitle", { month: closing })}
          description={t("closeDesc")}
          onConfirm={async () => {
            await run(() => api.post("/revenue/close", { month: closing }), t("closeTitle", { month: closing }));
            toast(t("closedDone", { month: closing }));
            invalidate(cache);
          }}
        />
      )}
    </section>
  );
}

/** B8 · ส่งออกให้สำนักงานบัญชี (ไฟล์ CSV จาก ops-api) */
export function AccountantExport({ onClose }: { onClose: () => void }) {
  const t = useTranslations("money.b8");
  const tc = useTranslations("common.dialog");
  const [month, setMonth] = useState(lastMonth());
  const [type, setType] = useState<"sales" | "credit_notes" | "wht">("sales");
  const revenue = useQuery({ queryKey: ["ops", "revenue"], queryFn: () => api.get<{ months: RevenueRow[] }>("/revenue?months=6") });
  const closed = revenue.data?.months.find((m) => m.month === month)?.closed;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <div className="dialog-body">
        <Input label={t("month")} type="month" value={month} onChange={(e) => setMonth(e.target.value || lastMonth())} />
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("type")}</legend>
          {(["sales", "credit_notes", "wht"] as const).map((v) => (
            <label key={v} className="check">
              <input type="radio" name="b8" checked={type === v} onChange={() => setType(v)} />
              <span>{t(`types.${v}`)}</span>
            </label>
          ))}
        </fieldset>
        <span className={closed ? "pill ok" : "pill warn"}>{closed ? t("closedLabel") : t("draft")}</span>
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <a className={buttonClass("primary")} href={`${OPS_BASE}/revenue/export?month=${month}&type=${type}`} download onClick={onClose}>
            {t("download")}
          </a>
        </div>
      </div>
    </Modal>
  );
}
