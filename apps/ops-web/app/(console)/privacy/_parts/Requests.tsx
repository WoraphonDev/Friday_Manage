"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { IrreversibleDialog, useApprovalFlow, useReauth } from "@/components/dialogs";
import { Chip, Drawer, Empty, ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { dsr, type Identity, type PrivacyRequest, REQUEST_TYPES, type RequestDetail, type RequestType, todayBkk } from "./types";
import { type PickedWs, WorkspacePicker } from "./WorkspacePicker";

const key = ["ops", "privacy", "requests"] as const;
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });
const typeTone: Record<RequestType, string> = { erase: "pill bad", export: "pill inf", access: "pill inf", rectify: "pill ok", object: "pill warn", restrict: "pill warn" };

/** ป้ายครบกำหนด: ≤ 7 วันเตือน · เกินกำหนดแดง · ปิดแล้วบอกวันที่ */
export function DuePill({ r }: { r: PrivacyRequest }) {
  const t = useTranslations("pl.privacy");
  const fmt = useFmt();
  if (r.status === "completed") return <span className="pill ok">{t("doneAt", { date: fmt.date(r.completedAt) })}</span>;
  if (r.status === "rejected") return <span className="pill">{t("rejectedAt", { date: fmt.date(r.completedAt) })}</span>;
  if (r.daysLeft < 0) return <span className="pill bad">{t("late", { n: -r.daysLeft })}</span>;
  if (r.daysLeft === 0) return <span className="pill bad">{t("dueToday")}</span>;
  return <span className={r.daysLeft <= 7 ? "pill warn" : "pill"}>{t("left", { n: r.daysLeft })}</span>;
}

export function useRequests(enabled: boolean) {
  return useQuery({ queryKey: [...key, "all"], queryFn: () => api.get<{ items: PrivacyRequest[] }>("/privacy/requests?status=all"), enabled });
}

/** ตัวเลขสรุป 4 ช่องบนหัวหน้า (Privacy.dc.html) */
export function RequestStats({ items }: { items: PrivacyRequest[] }) {
  const t = useTranslations("pl.privacy.stats");
  const open = items.filter((r) => r.status === "open");
  const soon = open.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 7).length;
  const late = open.filter((r) => r.daysLeft < 0).length;
  const since = Date.now() - 90 * 86_400_000;
  const done = items.filter((r) => r.status === "completed" && r.completedAt && Date.parse(r.completedAt) >= since);
  const avg = done.length ? Math.round(done.reduce((s, r) => s + (Date.parse(r.completedAt!) - Date.parse(r.receivedAt)) / 86_400_000, 0) / done.length) : null;
  return (
    <section className="stats">
      <div className="stat">
        <span className="muted small">{t("open")}</span>
        <b>{open.length}</b>
      </div>
      <div className={soon ? "stat stat-warn" : "stat"}>
        <span className="muted small">{t("dueSoon")}</span>
        <b>{soon}</b>
      </div>
      <div className={late ? "stat stat-bad" : "stat stat-ok"}>
        <span className="muted small">{t("overdue")}</span>
        <b>{late}</b>
      </div>
      <div className="stat">
        <span className="muted small">{t("avg")}</span>
        <b>{avg == null ? "—" : t("days", { n: avg })}</b>
      </div>
    </section>
  );
}

/** ตารางคำขอจากเจ้าของข้อมูล · กดเลขคำขอเปิดรายละเอียด */
export function RequestsTable({ query, onOpen }: { query: ReturnType<typeof useRequests>; onOpen: (id: string) => void }) {
  const t = useTranslations("pl.privacy");
  const tr = useTranslations("pl.req");
  const [filter, setFilter] = useState<"open" | "completed" | "rejected" | "all">("open");
  const items = (query.data?.items ?? []).filter((r) => filter === "all" || r.status === filter);
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <h2 className="card-title">{t("requests")}</h2>
        <span className="card-sub">{t("requestsSub")}</span>
        <span className="spacer" />
        <div className="row">
          {(["open", "completed", "rejected", "all"] as const).map((v) => (
            <Chip key={v} pressed={filter === v} onClick={() => setFilter(v)}>
              {t(`filter.${v}`)}
            </Chip>
          ))}
        </div>
      </div>
      {query.isPending ? (
        <TableSkeleton rows={4} cols={7} />
      ) : query.error ? (
        <ErrorBlock error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        <Empty ok={filter === "open"} title={filter === "open" ? t("emptyOpen") : t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["no", "type", "who", "ws", "identity", "due", "status"] as const).map((c) => (
                  <th key={c}>{t(`col.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button type="button" className="link-button mono" onClick={() => onOpen(r.id)}>
                      {dsr(r.number)}
                    </button>
                  </td>
                  <td>
                    <span className={typeTone[r.requestType]}>{t(`types.${r.requestType}`)}</span>
                  </td>
                  <td className="small">{r.requesterEmail}</td>
                  <td className="small">{r.workspaces?.length ? r.workspaces.map((w) => w.name).join(", ") : r.userId ? t("allWs") : t("noAccount")}</td>
                  <td>
                    <span className={r.identity === "unverified" ? "pill" : "pill ok"}>{t(`identity.${r.identity}`)}</span>
                  </td>
                  <td>
                    <DuePill r={r} />
                  </td>
                  <td className="small">{r.status === "open" ? (r.approvalRequestId && r.step === 3 ? tr("erasePending") : r.stepLabel) : t(`filter.${r.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** รายละเอียดคำขอ (Drawer ขวา): ขั้นตอน ขอบเขต สิ่งที่จะลบ ประวัติ และปุ่มดำเนินการ */
export function RequestDrawer({ id, canAct, onClose }: { id: string; canAct: boolean; onClose: () => void }) {
  const t = useTranslations("pl");
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...key, "detail", id], queryFn: () => api.get<RequestDetail>(`/privacy/requests/${id}`) });
  const [modal, setModal] = useState<"advance" | "reject" | "erase" | null>(null);
  const verify = useMutation({
    mutationFn: (method: Exclude<Identity, "unverified">) => api.post(`/privacy/requests/${id}/verify`, { method }),
    onSuccess: () => (toast(t("req.verified")), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  const r = q.data?.request;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={r ? `${dsr(r.number)} · ${t(`privacy.types.${r.requestType}`)}` : t("privacy.requests")}
      description={r ? t("req.who", { email: r.requesterEmail, ws: r.workspaces?.length ? r.workspaces.map((w) => w.name).join(", ") : r.userId ? t("privacy.allWs") : t("privacy.noAccount") }) : undefined}
    >
      {q.isPending ? <TableSkeleton rows={5} cols={1} /> : q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : <RequestBody d={q.data} canAct={canAct} verify={verify} setModal={setModal} />}
      {r && modal === "advance" && <AdvanceDialog r={r} steps={q.data!.steps} onClose={() => setModal(null)} />}
      {r && modal === "reject" && <RejectDialog r={r} onClose={() => setModal(null)} />}
      {r && modal === "erase" && <EraseDialog d={q.data!} onClose={() => setModal(null)} />}
    </Drawer>
  );
}

function RequestBody({ d, canAct, verify, setModal }: { d: RequestDetail; canAct: boolean; verify: { mutate: (m: Exclude<Identity, "unverified">) => void; isPending: boolean }; setModal: (m: "advance" | "reject" | "erase") => void }) {
  const t = useTranslations("pl");
  const fmt = useFmt();
  const r = d.request;
  const open = r.status === "open";
  const erase = r.requestType === "erase";
  const unverified = r.identity === "unverified";
  const eraseStep = erase && r.step === 3;
  const blocked = (d.erasePlan?.blockers.length ?? 0) > 0;
  return (
    <div className="stack">
      <div className="row">
        <DuePill r={r} />
        <span className={unverified ? "pill" : "pill ok"}>{t(`privacy.identity.${r.identity}`)}</span>
        <span className="muted small">{t("req.received", { date: fmt.date(r.receivedAt), due: fmt.date(r.dueDate) })}</span>
      </div>
      {r.details && (
        <div className="notice">
          <div className="notice-body">
            <b className="small">{t("req.details")}</b>
            <span className="small" style={{ whiteSpace: "pre-wrap" }}>
              {r.details}
            </span>
          </div>
        </div>
      )}
      <section>
        <h3 className="card-title">{t("req.steps")}</h3>
        <ol className="steps">
          {d.steps.map((s) => (
            <li key={s.step} className={s.done ? "step-done" : open && s.step === r.step ? "step-now" : undefined} aria-current={open && s.step === r.step ? "step" : undefined}>
              <span className="step-n">{s.step}</span>
              <span className="small">{s.label}</span>
            </li>
          ))}
        </ol>
        <p className="muted small">{t("req.stepsNote")}</p>
      </section>
      {!open ? (
        <Notice tone={r.status === "completed" ? "ok" : "info"} title={t("req.closed")}>
          {r.rejectionReason}
        </Notice>
      ) : (
        canAct && (
          <div className="stack">
            {unverified && (
              <div className="notice notice-warn">
                <div className="notice-body">
                  <b className="small">{t("req.needVerify")}</b>
                  <div className="row">
                    <Button size="small" disabled={verify.isPending || !r.userId} onClick={() => verify.mutate("email_match")}>
                      {t("req.verifyEmail")}
                    </Button>
                    <Button size="small" disabled={verify.isPending} onClick={() => verify.mutate("link_confirmed")}>
                      {t("req.verifyLink")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            <div className="row">
              {eraseStep ? (
                <Button variant="danger" disabled={blocked || !r.userId} onClick={() => setModal("erase")}>
                  {t("req.erase")}
                </Button>
              ) : (
                <Button variant="primary" disabled={unverified} onClick={() => setModal("advance")}>
                  {r.step >= 4 ? t("req.finish") : t("req.next")}
                </Button>
              )}
              <Button onClick={() => setModal("reject")}>{t("req.reject")}</Button>
            </div>
          </div>
        )
      )}
      <section>
        <h3 className="card-title">{t("req.scope")}</h3>
        {!r.userId ? (
          <p className="muted small">{t("req.scopeNone")}</p>
        ) : (
          <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
            {d.scope.memberships.map((m) => (
              <li key={m.id}>
                {m.name} <span className="muted">· {m.role}</span> {m.soleOwner && <span className="pill warn">{t("req.soleOwner")}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {d.erasePlan && <ErasePlan plan={d.erasePlan} />}
      <details>
        <summary className="small">{t("req.history")}</summary>
        {d.history.map((h, i) => (
          <div key={i} className="small">
            <span className="muted">{fmt.dateTime(h.at)}</span> · {h.staffName ?? "—"} · {h.text}
          </div>
        ))}
      </details>
    </div>
  );
}

function ErasePlan({ plan }: { plan: NonNullable<RequestDetail["erasePlan"]> }) {
  const t = useTranslations("pl.req");
  const rows: [string, string, string][] = [
    ...plan.remove.map((x) => [x, t("planRemove"), "pill bad"] as [string, string, string]),
    ...plan.anonymize.map((x) => [x, t("planAnon"), "pill warn"] as [string, string, string]),
    ...plan.keep.map((x) => [x, t("planKeep"), "pill"] as [string, string, string]),
  ];
  return (
    <section className="stack" style={{ gap: 6 }}>
      <h3 className="card-title">{t("plan")}</h3>
      {rows.map(([what, how, cls]) => (
        <div key={what} className="row small" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <span className={cls}>{how}</span>
          <span>{what}</span>
        </div>
      ))}
      <span className="muted small">{t("backup", { n: plan.backupDays })}</span>
      {plan.blockers.map((b) => (
        <Notice key={b.workspace} tone="bad" title={t("blocker", { ws: b.workspace })} />
      ))}
    </section>
  );
}

/** ขั้นถัดไป · ขั้นสุดท้ายส่งข้อความถึงผู้ขอ */
function AdvanceDialog({ r, steps, onClose }: { r: PrivacyRequest; steps: RequestDetail["steps"]; onClose: () => void }) {
  const t = useTranslations("pl.req");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const last = r.step >= 4;
  const label = (n: number) => steps.find((s) => s.step === n)?.label ?? String(n);
  const m = useMutation({
    mutationFn: () => api.post<{ sent: boolean }>(`/privacy/requests/${r.id}/advance`, { note: note.trim(), ...(last && message.trim() ? { message: message.trim() } : {}) }),
    onSuccess: (res) => (toast(last ? t("completed", { sent: String(res.sent) }) : t("advanced")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("advanceTitle", { step: label(r.step), next: last ? t("advanceDone") : label(r.step + 1) })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), note.trim().length >= 3 && m.mutate())}>
        <Textarea label={t("note")} value={note} onChange={(e) => setNote(e.target.value)} />
        {last && <Textarea label={t("message")} hint={t("messageHint")} value={message} onChange={(e) => setMessage(e.target.value)} />}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={note.trim().length < 3 || m.isPending}>
            {last ? t("finish") : t("next")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A5 · ปฏิเสธพร้อมเหตุผลตามกฎหมาย */
function RejectDialog({ r, onClose }: { r: PrivacyRequest; onClose: () => void }) {
  const t = useTranslations("pl.a5");
  const tp = useTranslations("pl.privacy");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [basis, setBasis] = useState("");
  const [message, setMessage] = useState("");
  const ok = basis.trim().length >= 5 && message.trim().length >= 5;
  const m = useMutation({
    mutationFn: () => api.post(`/privacy/requests/${r.id}/reject`, { legalBasis: basis.trim(), message: message.trim() }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { type: tp(`types.${r.requestType}`) })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={t("basis")} value={basis} onChange={(e) => setBasis(e.target.value)} />
        <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} />
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

/** A6 · ลบตามคำขอ: พิมพ์ "ลบข้อมูล" · แตะกุญแจ · ส่งให้คนที่สองอนุมัติเสมอ (202) */
function EraseDialog({ d, onClose }: { d: RequestDetail; onClose: () => void }) {
  const t = useTranslations("pl");
  const tc = useTranslations("common.dialog");
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const cache = useQueryClient();
  const r = d.request;
  return (
    <IrreversibleDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("a6.title", { email: r.requesterEmail })}
      description={d.scope.memberships.map((m) => m.name).join(", ") || t("privacy.allWs")}
      word="ลบข้อมูล"
      confirmLabel={tc("sendForApproval")}
      onConfirm={async ({ reason }) => {
        const res = await run(() => api.post(`/privacy/requests/${r.id}/erase`, { confirm: "ลบข้อมูล", reason }), t("a6.reauth"));
        handle(res);
        invalidate(cache);
      }}
    >
      {d.erasePlan && <ErasePlan plan={d.erasePlan} />}
    </IrreversibleDialog>
  );
}

/** A3 · บันทึกคำขอที่มาทางอีเมล */
export function CreateRequest({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("pl.a3");
  const tp = useTranslations("pl.privacy");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [type, setType] = useState<RequestType>("export");
  const [received, setReceived] = useState(todayBkk());
  const [email, setEmail] = useState("");
  const [ws, setWs] = useState<PickedWs[]>([]);
  const [identity, setIdentity] = useState<Identity>("unverified");
  const [details, setDetails] = useState("");
  const [ack, setAck] = useState(true);
  const ok = /.+@.+\..+/.test(email.trim()) && !!received;
  const m = useMutation({
    mutationFn: () =>
      api.post<{ request: PrivacyRequest; forwardToOwner: boolean }>("/privacy/requests", {
        requestType: type,
        requesterEmail: email.trim(),
        receivedAt: received,
        workspaceIds: ws.map((w) => w.id),
        identity,
        acknowledge: ack,
        ...(details.trim() ? { details: details.trim() } : {}),
      }),
    onSuccess: (res) => {
      toast(res.forwardToOwner ? { message: t("done", { n: res.request.number }), detail: t("noAccount") } : t("done", { n: res.request.number }));
      invalidate(cache);
      onCreated(res.request.id);
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="grid-2">
          <Select label={t("type")} value={type} onChange={(e) => setType(e.target.value as RequestType)}>
            {REQUEST_TYPES.map((v) => (
              <option key={v} value={v}>
                {tp(`types.${v}`)}
              </option>
            ))}
          </Select>
          <Input label={t("received")} type="date" max={todayBkk()} value={received} onChange={(e) => setReceived(e.target.value)} />
        </div>
        <Input label={t("email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <WorkspacePicker label={t("ws")} placeholder={t("wsSearch")} hint={t("wsAll")} value={ws} onChange={setWs} />
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("identity")}</legend>
          {(["unverified", "email_match", "link_confirmed"] as const).map((v) => (
            <label key={v} className="check">
              <input type="radio" name="a3-identity" checked={identity === v} onChange={() => setIdentity(v)} />
              <span>{tp(`identity.${v}`)}</span>
            </label>
          ))}
        </fieldset>
        <Textarea label={t("details")} value={details} onChange={(e) => setDetails(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t("ack")}</span>
        </label>
        <p className="muted small">{t("forward")}</p>
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
