"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { kindText, useApprovalFlow, useReauth } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, Modal, PageHead, Seg, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";

interface Pending {
  id: string;
  kind: string;
  amountSatang: number | null;
  reason: string;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
}
interface History {
  id: string;
  at: string;
  type: string;
  ref: string | null;
  reason: string | null;
  amountSatang: number;
  requestedBy: string | null;
  approvedBy: string | null;
  invoice: string | null;
  workspace: { name: string };
}

/** หน้า 13 · คืนเงิน เครดิต และการอนุมัติ (Refunds.dc.html) */
export function RefundsPage() {
  const t = useTranslations("money.refunds");
  const tc = useTranslations("common");
  const fmt = useFmt();
  const f = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const me = useMe().data;
  const owner = (me?.roles ?? []).includes("owner") || hasAny(me, "owner");
  const [form, setForm] = useState(false);
  const [rejecting, setRejecting] = useState<Pending | null>(null);
  const q = useQuery({ queryKey: ["ops", "refunds"], queryFn: () => api.get<{ pending: Pending[]; history: History[] }>("/refunds") });
  const approve = useMutation({
    mutationFn: (p: Pending) => run(() => api.post(`/approvals/${p.id}/approve`, {}), kindText(tc, p.kind)),
    onSuccess: () => (toast(t("approved")), void cache.invalidateQueries({ queryKey: ["ops"] })),
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          hasAny(me, "finance") && (
            <Button variant="primary" onClick={() => setForm(true)}>
              <Plus size={16} /> {t("new")}
            </Button>
          )
        }
      />
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("pending")}</h2>
          <span className="card-sub">{t("pendingNote")}</span>
        </div>
        {q.isPending ? (
          <TableSkeleton rows={2} cols={4} />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : !q.data.pending.length ? (
          <Empty ok title={t("noPending")} />
        ) : (
          <div className="stack">
            {q.data.pending.map((p) => {
              const mine = p.requestedBy === me?.name;
              return (
                <article key={p.id} className="notice notice-warn" aria-label={kindText(tc, p.kind)}>
                  <div className="notice-body">
                    <b>
                      {kindText(tc, p.kind)} · {p.amountSatang != null ? fmt.money(p.amountSatang) : "—"}
                    </b>
                    <span className="small">{p.reason}</span>
                    <span className="muted small">{t("requestedBy", { name: p.requestedBy, time: f.dateTime(new Date(p.createdAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>
                  </div>
                  {owner && (
                    <span className="row" style={{ flexWrap: "nowrap" }}>
                      {!mine && (
                        <Button size="small" onClick={() => setRejecting(p)}>
                          {t("reject")}
                        </Button>
                      )}
                      <Button size="small" variant="primary" disabled={approve.isPending} onClick={() => approve.mutate(p)}>
                        {t("approve")}
                      </Button>
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("history")}</h2>
          <span className="card-sub">{t("historyNote")}</span>
        </div>
        {q.data && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("col.date")}</th>
                  <th>{t("col.type")}</th>
                  <th>{t("col.ws")}</th>
                  <th>{t("col.ref")}</th>
                  <th className="num">{t("col.amount")}</th>
                  <th>{t("col.by")}</th>
                  <th>{t("col.reason")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.history.map((h) => (
                  <tr key={h.id}>
                    <td>{fmt.date(h.at)}</td>
                    <td>{t(`types.${h.type}` as "types.refund")}</td>
                    <td>{h.workspace.name}</td>
                    <td className="mono small">
                      {h.ref ?? "—"}
                      {h.invoice && <div className="cell-sub">{h.invoice}</div>}
                    </td>
                    <td className="num">{fmt.money(h.amountSatang)}</td>
                    <td className="small">
                      {h.requestedBy ?? "—"}
                      {h.approvedBy ? ` / ${h.approvedBy}` : ""}
                    </td>
                    <td className="small">{h.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("rules")}</h2>
          <span className="card-sub">{t("rulesNote")}</span>
        </div>
        <table className="tbl">
          <tbody>
            <tr>
              <td>{t("ruleRefund")}</td>
              <td>{t("approver")}</td>
              <td className="muted small">{t("expires")}</td>
            </tr>
            <tr>
              <td>{t("ruleCredit")}</td>
              <td>{t("approver")}</td>
              <td className="muted small">{t("expires")}</td>
            </tr>
          </tbody>
        </table>
      </section>
      {form && <RefundForm onClose={() => setForm(false)} />}
      {rejecting && <RejectDialog p={rejecting} onClose={() => setRejecting(null)} />}
    </>
  );
}

function RejectDialog({ p, onClose }: { p: Pending; onClose: () => void }) {
  const t = useTranslations("money.refunds");
  const tc = useTranslations("common");
  const toast = useToast();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/approvals/${p.id}/reject`, { note: note.trim() }), onSuccess: () => (toast(t("rejected")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${t("reject")} ${kindText(tc, p.kind)}`}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), note.trim().length >= 3 && m.mutate())}>
        <Textarea label={t("rejectReason")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("dialog.cancel")}</Button>
          <Button type="submit" variant="danger" disabled={note.trim().length < 3 || m.isPending}>
            {t("reject")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** ขอคืนเงิน (อ้างใบแจ้งหนี้ที่ชำระแล้ว) / ให้เครดิต (อ้าง Workspace) · เกินวงเงิน → 202 → G7 / G12 */
function RefundForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations("money.refunds.form");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [kind, setKind] = useState<"refund" | "credit">("refund");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ id: string; label: string; workspaceId?: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"bank_transfer" | "original">("bank_transfer");
  const [reason, setReason] = useState("");
  const search = useDeferredValue(query.trim());
  const found = useQuery({
    queryKey: ["ops", "refund-pick", kind, search],
    queryFn: async () =>
      kind === "refund"
        ? (await api.get<{ items: { id: string; number: string; amountDue: number; workspace: { id: string; name: string } }[] }>(`/invoices?status=paid&q=${encodeURIComponent(search)}&limit=6`)).items.map((i) => ({ id: i.id, label: `${i.number} · ${i.workspace.name} · ${fmt.money(i.amountDue)}`, workspaceId: i.workspace.id }))
        : (await api.get<{ items: { id: string; name: string; slug: string }[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`)).items.map((w) => ({ id: w.id, label: `${w.name} · ${w.slug}` })),
    enabled: !target && search.length >= 2,
  });
  const satang = Math.round(Number(amount) * 100);
  const ok = !!target && satang > 0 && reason.trim().length >= 3;
  const m = useMutation({
    mutationFn: () =>
      (kind === "refund"
        ? api.post<{ creditNote?: { number: string } }>("/refunds", { invoiceId: target!.id, amountSatang: satang, method, reason: reason.trim() })
        : api.post<{ creditSatang?: number }>("/credits", { workspaceId: target!.id, amountSatang: satang, reason: reason.trim() })
      ).then(handle),
    onSuccess: (r) => {
      const res = r as { pendingApproval?: unknown; creditNote?: { number: string } };
      if (!res.pendingApproval) toast(kind === "refund" ? t("doneRefund", { number: res.creditNote?.number ?? "" }) : t("doneCredit", { amount: fmt.money(satang) }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("kind")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Seg label={t("kind")} value={kind} onChange={(v) => (setKind(v), setTarget(null), setQuery(""))} options={[{ value: "refund", label: t("refund") }, { value: "credit", label: t("credit") }]} />
        {target ? (
          <div className="row">
            <b>{target.label}</b>
            <Button size="small" variant="ghost" onClick={() => setTarget(null)}>
              ✕
            </Button>
          </div>
        ) : (
          <div className="field">
            <Input label={kind === "refund" ? t("invoice") : t("ws")} placeholder={kind === "refund" ? t("invoiceSearch") : t("wsSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
            {found.data?.map((x) => (
              <button key={x.id} type="button" className="menu-item" onClick={() => setTarget(x)}>
                {x.label}
              </button>
            ))}
          </div>
        )}
        <Input label={t("amount")} type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        {kind === "refund" && <Seg label={t("method")} value={method} onChange={setMethod} options={[{ value: "bank_transfer", label: t("bank") }, { value: "original", label: t("original") }]} />}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
