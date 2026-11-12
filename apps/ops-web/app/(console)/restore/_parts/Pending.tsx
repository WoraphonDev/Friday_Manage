"use client";

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow, useReauth } from "@/components/dialogs";
import { Empty, ErrorBlock, Modal, Notice, Seg, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import type { PendingWorkspace, TicketView } from "./types";

const DAY = 86_400_000;
type Data = { items: PendingWorkspace[]; extendLimitDays: number };
const roleKey = (r: string | null) => (r && ["owner", "admin", "member", "guest"].includes(r) ? (r as "owner") : "unknown");

/** Workspace ที่รอลบถาวร · ยืดเวลา (Z7) · กู้คืนแทนลูกค้า (Z8) */
export function Pending({ query: q, canAct }: { query: UseQueryResult<Data>; canAct: boolean }) {
  const t = useTranslations("rst.pending");
  const tr = useTranslations("rst.roles");
  const fmt = useFmt();
  const [extend, setExtend] = useState<PendingWorkspace | null>(null);
  const [restore, setRestore] = useState<PendingWorkspace | null>(null);
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("sub")}</span>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.ws")}</th>
                <th scope="col">{t("col.plan")}</th>
                <th scope="col">{t("col.by")}</th>
                <th scope="col">{t("col.purge")}</th>
                <th scope="col">{t("col.ticket")}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((w) => {
                const purge = w.daysLeft > 0 ? t("left", { date: fmt.date(w.purgeAfter), n: w.daysLeft }) : t("due", { date: fmt.date(w.purgeAfter) });
                const ticket = w.tickets[0];
                const waiting = w.pendingApprovals.length > 0;
                return (
                  <tr key={w.id}>
                    <td>
                      <b>{w.name}</b>
                      <div className="muted small">
                        {w.slug} · {t("members", { n: w.members })}
                      </div>
                    </td>
                    <td className="small">{w.planStatus === "canceled" ? t("canceled", { plan: planLabel(w.plan) }) : planLabel(w.plan)}</td>
                    <td className="small">
                      {w.deletedBy ? tr(roleKey(w.deletedBy.role)) : "—"} · {fmt.date(w.deletedAt)}
                    </td>
                    <td>
                      {w.daysLeft <= 7 ? <Pill tone="bad">{purge}</Pill> : <span className="small">{purge}</span>}
                      {w.extendedDays > 0 && <div className="muted small">{t("extended", { n: w.extendedDays })}</div>}
                    </td>
                    <td>{ticket ? <Pill tone="inf">{`Ticket #${ticket.number} ${ticket.subject}`}</Pill> : "—"}</td>
                    <td>
                      {waiting ? (
                        <Pill tone="warn">{t("waiting")}</Pill>
                      ) : (
                        canAct && (
                          <span className="row" style={{ flexWrap: "nowrap" }}>
                            <Button size="small" disabled={!ticket} onClick={() => setExtend(w)}>
                              {t("extend")}
                            </Button>
                            {ticket && (
                              <Button size="small" variant="primary" onClick={() => setRestore(w)}>
                                {t("restore")}
                              </Button>
                            )}
                          </span>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {extend && <ExtendDialog w={extend} limit={q.data?.extendLimitDays ?? 30} onClose={() => setExtend(null)} />}
      {restore && <RestoreWorkspaceDialog w={restore} onClose={() => setRestore(null)} />}
    </section>
  );
}

/** Z7 · ยืดเวลาก่อนลบถาวร · รวมเกิน 30 วันส่งขออนุมัติ (G7) */
function ExtendDialog({ w, limit, onClose }: { w: PendingWorkspace; limit: number; onClose: () => void }) {
  const t = useTranslations("rst.z7");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [days, setDays] = useState<"7" | "14" | "30">("14");
  const [ticketId, setTicketId] = useState(w.tickets[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const n = Number(days);
  const total = w.extendedDays + n;
  const over = total > limit;
  const next = new Date(Date.parse(w.purgeAfter) + n * DAY).toISOString();
  const m = useMutation({
    mutationFn: () => api.post<{ pendingApproval?: unknown; purgeAfter?: string }>(`/restore/workspaces/${w.id}/extend`, { days: n, ticketId, reason: reason.trim(), notify }),
    onSuccess: (r) => {
      if (r.pendingApproval) handle(r);
      else toast(t("done", { date: fmt.date(r.purgeAfter!) }));
      void cache.invalidateQueries({ queryKey: ["ops", "restore"] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { name: w.name })} description={t("desc", { date: fmt.date(w.purgeAfter), extended: w.extendedDays })}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="field">
          <span className="field-label">{t("by")}</span>
          <Seg label={t("by")} value={days} onChange={setDays} options={(["7", "14", "30"] as const).map((v) => ({ value: v, label: t("days", { n: v }) }))} />
          <span className={over ? "field-error" : "muted small"}>{over ? t("over", { total, limit }) : t("hint", { date: fmt.date(next), limit })}</span>
        </div>
        <Select label={`${t("ticket")} *`} value={ticketId} onChange={(e) => setTicketId(e.target.value)}>
          {w.tickets.map((x) => (
            <option key={x.id} value={x.id}>
              #{x.number} · {x.subject}
            </option>
          ))}
        </Select>
        <Textarea label={`${t("reason")} *`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          {t("notify")}
        </label>
        <InlineError error={m.error} />
        <p className="muted small">{t("note", { limit })}</p>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ticketId || reason.trim().length < 5 || m.isPending}>
            {over ? t("submitApproval") : t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Z8 · กู้คืน Workspace แทนลูกค้า · แตะ Security key (G4) + อนุมัติทุกครั้ง */
function RestoreWorkspaceDialog({ w, onClose }: { w: PendingWorkspace; onClose: () => void }) {
  const t = useTranslations("rst.z8");
  const tr = useTranslations("rst.roles");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const cache = useQueryClient();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const [ticketId, setTicketId] = useState(w.tickets[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const tickets = useQuery({ queryKey: ["ops", "restore", "tickets", w.id], queryFn: () => api.get<{ items: TicketView[] }>(`/restore/tickets?workspaceId=${w.id}`) });
  const ticket = tickets.data?.items.find((x) => x.id === ticketId);
  const m = useMutation({
    mutationFn: () => run(() => api.post(`/restore/workspaces/${w.id}/restore`, { ticketId, reason: reason.trim() }), t("reauth")),
    onSuccess: (r) => {
      handle(r);
      void cache.invalidateQueries({ queryKey: ["ops", "restore"] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { name: w.name })} description={t("desc", { deleted: fmt.date(w.deletedAt), purge: fmt.date(w.purgeAfter) })}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Notice tone="info" icon={<Info size={18} />}>
          {t("info")}
        </Notice>
        {w.tickets.length > 1 && (
          <Select label="Ticket *" value={ticketId} onChange={(e) => setTicketId(e.target.value)}>
            {w.tickets.map((x) => (
              <option key={x.id} value={x.id}>
                #{x.number} · {x.subject}
              </option>
            ))}
          </Select>
        )}
        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", margin: 0 }}>
          <dt className="muted">{t("requester")}</dt>
          <dd style={{ margin: 0 }}>
            {ticket ? (
              <>
                {ticket.requesterEmail ?? "—"} · <Pill tone={ticket.requesterRole === "owner" ? "ok" : "warn"}>{tr(roleKey(ticket.requesterRole))}</Pill> {t("verified", { n: ticket.number })}
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="muted">{t("after")}</dt>
          <dd style={{ margin: 0 }}>{t("afterText")}</dd>
        </dl>
        {ticket && ticket.requesterRole !== "owner" && <Notice tone="warn" title={t("notEligible")} />}
        <Textarea label={`${t("reason")} *`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        <InlineError error={m.error} />
        <p className="muted small">{t("note")}</p>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ticketId || reason.trim().length < 5 || m.isPending}>
            <KeyRound size={16} /> {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
