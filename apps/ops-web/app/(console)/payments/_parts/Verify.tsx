"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileImage } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { useApprovalFlow } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";

export interface ExceptionItem {
  id: string;
  reason: string;
  suggestion: string;
  method: "card" | "promptpay" | "transfer";
  expectedSatang: number;
  receivedSatang: number;
  hasSlip: boolean;
  waitingSince: string;
  invoice: { id: string; number: string; status: string; amountDue: number; dueDate: string };
  workspace: { id: string; slug: string; name: string };
  timeline: { at: string; action: string; actorKind: string; summary: string | null }[];
}
interface SlipItem {
  id: string;
  method: string;
  amount: number;
  hasSlip: boolean;
  createdAt: string;
  exceptionReason: string | null;
  invoice: { id: string; number: string; amountDue: number };
  workspace: { id: string; name: string };
}
export const exceptionsKey = ["ops", "payments", "exceptions"] as const;

/** แท็บกรณีผิดปกติ (Billing › verify) · เฉพาะรายการที่ระบบยืนยันเองไม่ได้ + สลิปรอตรวจปกติ */
export function VerifyTab() {
  const t = useTranslations("money");
  const fmt = useFmt();
  const me = useMe().data;
  const q = useQuery({ queryKey: exceptionsKey, queryFn: () => api.get<{ items: ExceptionItem[]; payments30d: number }>("/payments/exceptions") });
  const slips = useQuery({ queryKey: ["ops", "payments", "pending"], queryFn: () => api.get<{ items: SlipItem[] }>("/payments?status=pending_review") });
  const [open, setOpen] = useState<ExceptionItem | null>(null);
  const [flagging, setFlagging] = useState<SlipItem | null>(null);
  const decide = hasAny(me, "finance");
  const normal = (slips.data?.items ?? []).filter((s) => !s.exceptionReason && s.hasSlip);
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("tabs.verify", { n: q.data?.items.length ?? 0 })}</h2>
          {q.data && <span className="card-sub">{t("verify.summary", { total: q.data.payments30d, n: q.data.items.length })}</span>}
        </div>
        <p className="muted small">{t("verify.note")}</p>
        {q.isPending ? (
          <TableSkeleton rows={4} cols={7} />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : !q.data.items.length ? (
          <Empty ok title={t("verify.empty")} description={t("verify.emptyDesc")} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {(["problem", "ws", "invoice", "expected", "received", "channel", "waiting", "suggest"] as const).map((c) => (
                    <th key={c} className={c === "expected" || c === "received" ? "num" : undefined}>
                      {t(`verify.col.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((x) => (
                  <tr key={x.id} style={{ cursor: "pointer" }} onClick={() => setOpen(x)}>
                    <td>
                      <button type="button" className="link-button" onClick={(e) => (e.stopPropagation(), setOpen(x))}>
                        {t(`reasons.${x.reason}` as "reasons.amount_mismatch")}
                      </button>
                    </td>
                    <td>{x.workspace.name}</td>
                    <td className="mono small">{x.invoice.number}</td>
                    <td className="num">{fmt.money(x.expectedSatang)}</td>
                    <td className="num">{fmt.money(x.receivedSatang)}</td>
                    <td>{t(`methods.${x.method}`)}</td>
                    <td className="small">{fmt.ago(x.waitingSince)}</td>
                    <td className="small">{x.suggestion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("verify.slips")}</h2>
          <span className="card-sub">{t("verify.slipsNote")}</span>
        </div>
        {slips.isPending ? (
          <TableSkeleton rows={2} cols={5} />
        ) : slips.error ? (
          <ErrorBlock error={slips.error} retry={() => void slips.refetch()} />
        ) : !normal.length ? (
          <p className="muted small">{t("verify.noSlips")}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {normal.map((s) => (
                  <tr key={s.id}>
                    <td>{s.workspace.name}</td>
                    <td className="mono small">{s.invoice.number}</td>
                    <td className="num">{fmt.money(s.amount)}</td>
                    <td className="small">{fmt.ago(s.createdAt)}</td>
                    <td>
                      <span className="row">
                        <a className="button button-small button-ghost" href={`${OPS_BASE}/payments/${s.id}/slip`} target="_blank" rel="noreferrer">
                          <FileImage size={14} /> {t("verify.slip")}
                        </a>
                        {decide && (
                          <>
                            <SlipPass id={s.id} />
                            <Button size="small" onClick={() => setFlagging(s)}>
                              {t("verify.flag")}
                            </Button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <DecisionDrawer item={open} canDecide={decide} onClose={() => setOpen(null)} />}
      {flagging && <FlagDialog item={flagging} onClose={() => setFlagging(null)} />}
    </>
  );
}

function SlipPass({ id }: { id: string }) {
  const t = useTranslations("money.verify");
  const toast = useToast();
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.post(`/payments/${id}/confirm`, {}),
    onSuccess: () => (toast(t("passed")), void cache.invalidateQueries({ queryKey: ["ops"] })),
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <Button size="small" variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>
      {t("pass")}
    </Button>
  );
}

const FLAGGABLE = ["payer_name_mismatch", "unreadable_slip", "amount_mismatch", "wht_not_declared", "wht_certificate"] as const;
function FlagDialog({ item, onClose }: { item: SlipItem; onClose: () => void }) {
  const t = useTranslations("money");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState<(typeof FLAGGABLE)[number]>("payer_name_mismatch");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/payments/${item.id}/flag`, { reason, note: note.trim() }),
    onSuccess: () => (toast(t("verify.flagged")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("verify.flag")} description={`${item.workspace.name} · ${item.invoice.number}`}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), note.trim().length >= 3 && m.mutate())}>
        <div className="field">
          <label htmlFor="flag-reason">{t("verify.flagReason")}</label>
          <select id="flag-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            {FLAGGABLE.map((r) => (
              <option key={r} value={r}>
                {t(`reasons.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <Textarea label={tc("reason")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={note.trim().length < 3 || m.isPending}>
            {tc("confirm")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** แผงตัดสิน: หลักฐาน · ลำดับเหตุการณ์ · ผ่าน / ไม่ผ่าน (B6) / ผูกใบอื่น (B7) / เครดิต / คืนเงิน */
function DecisionDrawer({ item, canDecide, onClose }: { item: ExceptionItem; canDecide: boolean; onClose: () => void }) {
  const t = useTranslations("money");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [reason, setReason] = useState("");
  const [modal, setModal] = useState<"fail" | "match" | null>(null);
  const done = (message: string) => {
    toast(message);
    void cache.invalidateQueries({ queryKey: ["ops"] });
    onClose();
  };
  const pass = useMutation({ mutationFn: () => api.post(`/payments/${item.id}/confirm`, { note: reason.trim() || undefined }), onSuccess: () => done(t("verify.passed")) });
  const credit = useMutation({ mutationFn: () => api.post(`/payments/${item.id}/to-credit`, { reason: reason.trim() }), onSuccess: () => done(t("verify.credited")) });
  const refund = useMutation({
    mutationFn: () => api.post(`/refunds`, { invoiceId: item.invoice.id, amountSatang: item.receivedSatang, method: "original", reason: reason.trim(), paymentId: item.id }).then(handle),
    onSuccess: (r) => ((r as { pendingApproval?: unknown })?.pendingApproval ? onClose() : done(t("verify.passed"))),
  });
  const double = item.reason === "double_payment";
  const busy = pass.isPending || credit.isPending || refund.isPending;
  const err = pass.error ?? credit.error ?? refund.error;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} wide title={`${t(`reasons.${item.reason}` as "reasons.amount_mismatch")} · ${item.workspace.name}`} description={t("verify.panel")}>
      <section className="stack">
        <h3 className="card-title">{t("verify.evidence")}</h3>
        <table className="tbl">
          <tbody>
            <tr>
              <td className="muted">{t("verify.col.invoice")}</td>
              <td className="mono">{item.invoice.number}</td>
            </tr>
            <tr>
              <td className="muted">{t("verify.col.expected")}</td>
              <td>{fmt.money(item.expectedSatang)}</td>
            </tr>
            <tr>
              <td className="muted">{t("verify.col.received")}</td>
              <td>
                <b>{fmt.money(item.receivedSatang)}</b>
              </td>
            </tr>
            <tr>
              <td className="muted">{t("verify.col.channel")}</td>
              <td>{t(`methods.${item.method}`)}</td>
            </tr>
          </tbody>
        </table>
        {item.hasSlip && (
          <a className="button button-small" href={`${OPS_BASE}/payments/${item.id}/slip`} target="_blank" rel="noreferrer">
            <FileImage size={14} /> {t("verify.slip")}
          </a>
        )}
        <Notice tone="info" title={t("verify.suggestion")}>
          {item.suggestion}
        </Notice>
        <h3 className="card-title">{t("verify.timeline")}</h3>
        <ol className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
          {item.timeline.map((e, i) => (
            <li key={i}>
              <span className="muted">{fmt.dateTime(e.at)}</span> · {e.summary ?? e.action}
            </li>
          ))}
        </ol>
      </section>
      {canDecide && (
        <section className="stack">
          <Textarea label={t("verify.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="muted small">{t("verify.passNote")}</p>
          <InlineError error={err} />
          <div className="row">
            {!double && (
              <Button variant="primary" disabled={busy} onClick={() => pass.mutate()}>
                {t("verify.pass")}
              </Button>
            )}
            <Button disabled={busy} onClick={() => setModal("fail")}>
              {t("verify.fail")}
            </Button>
            <Button disabled={busy} onClick={() => setModal("match")}>
              {t("verify.match")}
            </Button>
            {(double || item.receivedSatang > item.expectedSatang) && item.invoice.status === "paid" && (
              <Button disabled={busy || reason.trim().length < 3} onClick={() => credit.mutate()}>
                {t("verify.credit")}
              </Button>
            )}
            {double && (
              <Button disabled={busy || reason.trim().length < 3} onClick={() => refund.mutate()}>
                {t("verify.refund")}
              </Button>
            )}
          </div>
        </section>
      )}
      {modal === "fail" && <FailDialog item={item} onClose={() => setModal(null)} onDone={() => done(t("verify.failed"))} />}
      {modal === "match" && <MatchDialog item={item} onClose={() => setModal(null)} onDone={() => done(t("verify.matched"))} />}
    </Drawer>
  );
}

/** B6 · ไม่ผ่าน แจ้งลูกค้า */
function FailDialog({ item, onClose, onDone }: { item: ExceptionItem; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("money.b6");
  const tc = useTranslations("common.dialog");
  const tr = useTranslations("money.reasons");
  const [reason, setReason] = useState(tr(item.reason as "amount_mismatch"));
  const [message, setMessage] = useState(t("defaultMessage"));
  const m = useMutation({ mutationFn: () => api.post(`/payments/${item.id}/reject`, { reason: reason.trim(), message: message.trim() }), onSuccess: onDone });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { ws: item.workspace.name })} description={item.invoice.number}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate())}>
        <Input label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} />
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

/** B7 · ผูกเงินเข้ากับใบแจ้งหนี้อื่นของ Workspace เดียวกัน */
function MatchDialog({ item, onClose, onDone }: { item: ExceptionItem; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("money.b7");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const [picked, setPicked] = useState("");
  const [reason, setReason] = useState("");
  const list = useQuery({
    queryKey: ["ops", "invoices", "match", item.workspace.id],
    queryFn: () => api.get<{ items: { id: string; number: string; status: string; amountDue: number; dueDate: string; workspace: { id: string } }[] }>(`/invoices?q=${encodeURIComponent(item.workspace.name)}&limit=50`),
  });
  const open = (list.data?.items ?? []).filter((i) => i.workspace.id === item.workspace.id && (i.status === "open" || i.status === "pending_review"));
  const m = useMutation({ mutationFn: () => api.post(`/payments/${item.id}/match`, { invoiceId: picked, reason: reason.trim() }), onSuccess: onDone });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { amount: fmt.money(item.receivedSatang) })} description={t("note")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), picked && reason.trim().length >= 3 && m.mutate())}>
        {list.isPending ? (
          <TableSkeleton rows={2} cols={2} />
        ) : !open.length ? (
          <p className="muted small">{t("none")}</p>
        ) : (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            {open.map((i) => {
              const diff = item.receivedSatang - i.amountDue;
              return (
                <label key={i.id} className="check">
                  <input type="radio" name="b7" checked={picked === i.id} onChange={() => setPicked(i.id)} />
                  <span>
                    <b className="mono">{i.number}</b> · {fmt.money(i.amountDue)} · {fmt.date(i.dueDate)} ·{" "}
                    <span className={diff === 0 ? "pill ok" : diff > 0 ? "pill inf" : "pill warn"}>{diff === 0 ? t("match") : diff > 0 ? t("over", { amount: fmt.money(diff) }) : t("under", { amount: fmt.money(-diff) })}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!picked || reason.trim().length < 3 || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
