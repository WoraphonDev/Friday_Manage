"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileImage, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { useApprovalFlow } from "@/components/dialogs";
import { FileThumb, FileViewer } from "@/components/file-viewer";
import { Drawer, Empty, ErrorBlock, Modal, Notice, Pager, TableSkeleton, TodoCard, TodoRow } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useShortcuts, useStableRows } from "@/lib/shortcuts";
import { SlipRun } from "./SlipRun";
import { Kbd } from "@/components/shortcut-help";
import { usePresence } from "@/lib/presence";
import { NewItemsBar } from "@/components/new-items";
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
const PAGE = 50;

/** แท็บกรณีผิดปกติ (Billing › verify) · เฉพาะรายการที่ระบบยืนยันเองไม่ได้ + สลิปรอตรวจปกติ */
export function VerifyTab() {
  const t = useTranslations("money");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const me = useMe().data;
  // ช่วง 1 (ข้อมูลเยอะ): สองคิวแบ่งหน้าที่ ops-api · รอนานสุดขึ้นก่อน · สลิปปกติกรองที่ server (เดิมกรองในเบราว์เซอร์)
  const [excOffset, setExcOffset] = useState(0);
  const [slipOffset, setSlipOffset] = useState(0);
  const q = useQuery({ queryKey: [...exceptionsKey, excOffset], queryFn: () => api.get<{ items: ExceptionItem[]; payments30d: number; total: number }>(`/payments/exceptions?limit=${PAGE}&offset=${excOffset}`), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const slips = useQuery({ queryKey: ["ops", "payments", "pending", slipOffset], queryFn: () => api.get<{ items: SlipItem[]; total: number }>(`/payments?status=pending_review&queue=slips&limit=${PAGE}&offset=${slipOffset}`), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  // ช่วง 2: รายการใหม่ไม่แทรกเอง · รอกด "แสดง"
  const excStable = useStableRows(q.data?.items, `exc:${excOffset}`);
  const slipStable = useStableRows(slips.data?.items, `slip:${slipOffset}`);
  const [open, setOpen] = useState<ExceptionItem | null>(null);
  const [flagging, setFlagging] = useState<SlipItem | null>(null);
  const [viewing, setViewing] = useState<SlipItem | null>(null);
  // ช่วง 2 · ตรวจสลิปต่อเนื่อง
  const [running, setRunning] = useState(false);
  const decide = hasAny(me, "finance");
  const normal = slipStable.rows;
  useShortcuts([{ keys: "p", label: t("run.start"), list: true, run: () => decide && normal.length > 0 && setRunning(true) }], decide);
  const pending = q.isPending || slips.isPending;
  const error = q.error ?? slips.error;
  const exceptions = excStable.rows;
  return (
    <>
      {/* โครงหน้า Ops: กรณีผิดปกติ + สลิปรอตรวจ = งานที่ต้องทำ อยู่บนสุดในแถบเดียว · ไม่มีงาน = แถบเขียวบรรทัดเดียว */}
      {pending ? (
        <TableSkeleton rows={3} cols={5} />
      ) : error ? (
        <ErrorBlock error={error} retry={() => (void q.refetch(), void slips.refetch())} />
      ) : (
        !(q.data?.total ?? exceptions.length) && !(slips.data?.total ?? normal.length) && !excStable.fresh && !slipStable.fresh ? (
          <Empty ok title={t("verify.empty")} description={t("verify.emptyDesc")} />
        ) : (
          <>
            <NewItemsBar count={excStable.fresh + slipStable.fresh} onShow={() => (excStable.reveal(), slipStable.reveal())} />
            {!!exceptions.length && (
              <TodoCard title={t("verify.exceptionsTitle")} count={q.data?.total ?? exceptions.length} hint={q.data ? t("verify.summary", { total: q.data.payments30d, n: q.data.total ?? exceptions.length }) : undefined}>
          {exceptions.map((x) => (
            <TodoRow
              key={x.id}
              actions={
                <Button size="small" variant={decide ? "primary" : "secondary"} onClick={() => setOpen(x)}>
                  {decide ? t("verify.decide") : t("verify.view")}
                </Button>
              }
            >
              <button type="button" className="link-button" onClick={() => setOpen(x)}>
                {t(`reasons.${x.reason}` as "reasons.amount_mismatch")}
              </button>
              <b>{x.workspace.name}</b>
              <span className="mono small muted">{x.invoice.number}</span>
              <span className="num">
                {t("verify.col.expected")} <b>{fmt.money(x.expectedSatang)}</b> · {t("verify.col.received")} <b>{fmt.money(x.receivedSatang)}</b>
              </span>
              <span className="muted small">
                {t(`methods.${x.method}`)} · {fmt.ago(x.waitingSince)}
              </span>
            </TodoRow>
          ))}
                <div className="todo-row">
                  <Pager offset={excOffset} limit={PAGE} shown={exceptions.length} total={q.data?.total ?? exceptions.length} onChange={setExcOffset} />
                </div>
              </TodoCard>
            )}
            {!!normal.length && (
              <TodoCard
                title={t("verify.slipsTitle")}
                count={slips.data?.total ?? normal.length}
                hint={
                  decide && (
                    <Button size="small" variant="primary" onClick={() => setRunning(true)}>
                      <Play size={14} aria-hidden="true" /> {t("run.start")}
                    </Button>
                  )
                }
              >
          {normal.map((s) => (
            <TodoRow
              key={s.id}
              actions={
                <>
                  <Button size="small" variant="ghost" onClick={() => setViewing(s)}>
                    <FileImage size={14} /> {t("verify.slip")}
                  </Button>
                  {decide && (
                    <>
                      <Button size="small" onClick={() => setFlagging(s)}>
                        {t("verify.flag")}
                      </Button>
                      <SlipPass id={s.id} />
                    </>
                  )}
                </>
              }
            >
              <span className="pill warn">{t("verify.slipTag")}</span>
              <b>{s.workspace.name}</b>
              <span className="mono small muted">{s.invoice.number}</span>
              <b className="num">{fmt.money(s.amount)}</b>
              <span className="muted small">{fmt.ago(s.createdAt)}</span>
            </TodoRow>
          ))}
                <div className="todo-row">
                  <Pager offset={slipOffset} limit={PAGE} shown={normal.length} total={slips.data?.total ?? normal.length} onChange={setSlipOffset} />
                </div>
              </TodoCard>
            )}
          </>
        )
      )}
      <p className="muted small">{t("verify.note")} · {t("verify.slipsNote")}</p>
      {running && <SlipRun onClose={() => setRunning(false)} />}
      {open && (
        <DecisionDrawer
          key={open.id}
          item={open}
          canDecide={decide}
          onClose={() => setOpen(null)}
          // ช่วง 2: ตัดสินแล้วเปิดรายการถัดไป (ตำแหน่งเดิมในคิวที่เหลือ) · หมดคิว = ปิด
          onDecided={() => setOpen(exceptions.filter((x) => x.id !== open.id)[exceptions.findIndex((x) => x.id === open.id)] ?? null)}
          pos={{ at: exceptions.findIndex((x) => x.id === open.id) + 1, total: exceptions.length, onNext: () => setOpen(exceptions[exceptions.findIndex((x) => x.id === open.id) + 1] ?? null) }}
        />
      )}
      {flagging && <FlagDialog item={flagging} onClose={() => setFlagging(null)} />}
      {viewing && (
        <FileViewer
          path={`/payments/${viewing.id}/slip`}
          title={t("verify.slipTitle", { ws: viewing.workspace.name })}
          description={<span className="mono">{viewing.invoice.number}</span>}
          filename={`slip-${viewing.invoice.number}`}
          onClose={() => setViewing(null)}
          aside={
            <>
              <table className="tbl">
                <tbody>
                  <tr>
                    <td className="muted">{t("verify.col.expected")}</td>
                    <td className="num">
                      <b>{fmt.money(viewing.invoice.amountDue)}</b>
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">{t("verify.col.received")}</td>
                    <td className="num">{fmt.money(viewing.amount)}</td>
                  </tr>
                  <tr>
                    <td className="muted">{t("verify.col.channel")}</td>
                    <td className="num">{t(`methods.${viewing.method}` as "methods.transfer")}</td>
                  </tr>
                  <tr>
                    <td className="muted">{t("verify.uploaded")}</td>
                    <td className="num">{fmt.dateTime(viewing.createdAt)}</td>
                  </tr>
                </tbody>
              </table>
              {decide && <p className="muted small">{t("verify.compare")}</p>}
            </>
          }
          footer={
            decide && (
              <>
                <Button onClick={() => setViewing(null)}>{tc("close")}</Button>
                <span className="row">
                  <Button onClick={() => (setViewing(null), setFlagging(viewing))}>{t("verify.flag")}</Button>
                  <SlipPass id={viewing.id} onDone={() => setViewing(null)} />
                </span>
              </>
            )
          }
        />
      )}
    </>
  );
}

function SlipPass({ id, onDone }: { id: string; onDone?: () => void }) {
  const t = useTranslations("money.verify");
  const toast = useToast();
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.post(`/payments/${id}/confirm`, {}),
    onSuccess: () => (toast(t("passed")), void cache.invalidateQueries({ queryKey: ["ops"] }), onDone?.()),
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
function DecisionDrawer({ item, canDecide, onClose, onDecided, pos }: { item: ExceptionItem; canDecide: boolean; onClose: () => void; onDecided?: () => void; pos?: { at: number; total: number; onNext: () => void } }) {
  const tr = useTranslations("money.run");
  // ช่วง 2: บอกเพื่อนว่ากำลังตัดสินรายการนี้ · เห็นเพื่อนที่เปิดอยู่
  const others = usePresence("payment", item.id);
  useShortcuts([{ keys: "s", label: tr("skip"), run: () => pos && pos.at < pos.total && pos.onNext() }]);
  const t = useTranslations("money");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [reason, setReason] = useState("");
  const [modal, setModal] = useState<"fail" | "match" | "slip" | null>(null);
  const done = (message: string) => {
    toast(message);
    void cache.invalidateQueries({ queryKey: ["ops"] });
    // ช่วง 2: ตัดสินแล้วไปรายการถัดไปในคิว (ถ้ามี)
    if (onDecided) onDecided();
    else onClose();
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
      {pos && (
        <div className="run-bar" role="status" style={{ margin: "0 -22px" }}>
          <span className="muted small">{tr("exceptionProgress", { pos: pos.at, total: pos.total })}</span>
          <span className="run-progress" aria-hidden="true">
            <i style={{ width: `${Math.round((pos.at / pos.total) * 100)}%` }} />
          </span>
          {pos.at < pos.total && (
            <Button size="small" onClick={pos.onNext}>
              {tr("skip")} <Kbd keys="s" />
            </Button>
          )}
        </div>
      )}
      {others[0] && (
        <div className="presence-banner warn" role="status">
          ● {tr("othersHere", { name: others[0].name })}
        </div>
      )}
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
        {item.hasSlip && <FileThumb path={`/payments/${item.id}/slip`} label={t("verify.slipThumb")} hint={t("verify.slipThumbHint")} onOpen={() => setModal("slip")} />}
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
      {modal === "slip" && (
        <FileViewer
          path={`/payments/${item.id}/slip`}
          title={t("verify.slipTitle", { ws: item.workspace.name })}
          description={<span className="mono">{item.invoice.number}</span>}
          filename={`slip-${item.invoice.number}`}
          onClose={() => setModal(null)}
          aside={
            <table className="tbl">
              <tbody>
                <tr>
                  <td className="muted">{t("verify.col.expected")}</td>
                  <td className="num">{fmt.money(item.expectedSatang)}</td>
                </tr>
                <tr>
                  <td className="muted">{t("verify.col.received")}</td>
                  <td className="num">
                    <b>{fmt.money(item.receivedSatang)}</b>
                  </td>
                </tr>
                <tr>
                  <td className="muted">{t("verify.col.channel")}</td>
                  <td className="num">{t(`methods.${item.method}`)}</td>
                </tr>
              </tbody>
            </table>
          }
        />
      )}
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
