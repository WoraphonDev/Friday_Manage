"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { IrreversibleDialog, useApprovalFlow, useReauth } from "@/components/dialogs";
import { Chip, ChipGroup, Drawer, Empty, ErrorBlock, Modal, Notice, Pager, TableSkeleton } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { usePresence, usePresenceOf } from "@/lib/presence";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { useSupportStaff } from "@/lib/staff-options";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { ViewsBar } from "@/components/views-bar";
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

export interface RequestStatsT {
  open: number;
  dueSoon: number;
  overdue: number;
  avgDays: number | null;
}
type ListResponse = { items: PrivacyRequest[]; total: number; counts: Record<"open" | "completed" | "rejected" | "all", number>; stats: RequestStatsT };
const PAGE = 50;

/** ตัวเลขสรุปจาก ops-api (ไม่ต้องโหลดคำขอทั้งหมดมานับ) */
export function useRequestStats(enabled: boolean) {
  return useQuery({ queryKey: [...key, "stats"], queryFn: () => api.get<ListResponse>("/privacy/requests?status=open&limit=1"), enabled, select: (d) => d.stats });
}

/** ตารางคำขอจากเจ้าของข้อมูล · กดเลขคำขอเปิดรายละเอียด · กรอง ค้น แบ่งหน้าที่ ops-api (ช่วง 1 · ข้อมูลเยอะ) */
export function RequestsTable({ enabled, onOpen }: { enabled: boolean; onOpen: (id: string) => void }) {
  const t = useTranslations("pl.privacy");
  const tr = useTranslations("pl.req");
  // ช่วง 3: ตัวกรองอยู่ใน URL (บันทึกเป็นมุมมองได้) · คีย์ตรงกับ ops-api › privacy.service RequestsQuery
  const tf = useTranslations("pl.privacy.f");
  const staff = useSupportStaff();
  const defs: FilterDef[] = [
    { key: "type", label: tf("type"), kind: "single", options: REQUEST_TYPES.map((v) => ({ value: v, label: t(`types.${v}`) })) },
    { key: "identity", label: tf("identity"), kind: "single", options: (["verified", "unverified"] as const).map((v) => ({ value: v, label: tf(`identities.${v}`) })) },
    { key: "due", label: tf("due"), kind: "single", options: (["soon", "overdue"] as const).map((v) => ({ value: v, label: tf(`dues.${v}`) })) },
    { key: "handler", label: tf("handler"), kind: "single", options: staff },
    { key: "hold", label: tf("hold"), kind: "single", options: [{ value: "yes", label: tf("holdYes") }] },
  ];
  const defaults = { status: "open", q: "", page: "0", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const fq = filterQuery(defs, f);
  const setFilters = (patch: Record<string, string>) => setF({ ...patch, page: "0" });
  const filter = f.status as "open" | "completed" | "rejected" | "all";
  const [search, setSearch] = useState(f.q);
  const offset = Number(f.page) * PAGE || 0;
  const setOffset = (v: number) => setF({ page: String(Math.floor(v / PAGE)) });
  const term = useDeferredValue(search.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term, page: "0" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const setFilter = (v: typeof filter) => setF({ status: v, page: "0" });
  const qs = new URLSearchParams({ status: filter, limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}), ...fq });
  const query = useQuery({ queryKey: [...key, "list", qs.toString()], queryFn: () => api.get<ListResponse>(`/privacy/requests?${qs}`), enabled, placeholderData: keepPreviousData });
  const items = query.data?.items ?? [];
  // ช่วง 2: J / K / Enter · เห็นเพื่อนที่เปิดคำขอเดียวกัน
  const tk = useTranslations("common.keys");
  const nav = useRowNav(items, { onOpen: (r) => onOpen(r.id), labels: { down: tk("down"), open: tk("open") } });
  const viewers = usePresenceOf("privacy", items.map((r) => r.id));
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <h2 className="card-title">{t("requests")}</h2>
        <span className="card-sub">{t("requestsSub")}</span>
        <span className="spacer" />
        <Input data-page-search type="search" aria-label={t("search")} placeholder={t("search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <FilterButton defs={defs} values={f} onChange={setFilters} />
        <ChipGroup className="row">
          {(["open", "completed", "rejected", "all"] as const).map((v) => (
            <Chip key={v} pressed={filter === v} onClick={() => setFilter(v)}>
              {t(`filter.${v}`)}
              {query.data?.counts ? ` · ${query.data.counts[v]}` : ""}
            </Chip>
          ))}
        </ChipGroup>
      </div>
      <div style={{ padding: "0 16px" }}>
        <ViewsBar page="privacy" values={f} defaults={defaults} onApply={(v) => (setSearch(v.q ?? ""), setF({ ...defaults, ...v }))} />
        <ActiveFilters defs={defs} values={f} onChange={setFilters} />
      </div>
      {query.isPending ? (
        <TableSkeleton rows={4} cols={7} />
      ) : query.error ? (
        <ErrorBlock error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        term || Object.keys(fq).length ? <Empty title={t("noMatch")} onClearFilters={() => (setSearch(""), setF({ ...filterKeys(defs), q: "", page: "0" }))} /> : <Empty ok={filter === "open"} title={filter === "open" ? t("emptyOpen") : t("empty")} />
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
              {items.map((r, i) => (
                <tr key={r.id} {...nav.rowProps(i)}>
                  <td>
                    <button type="button" className="link-button mono" onClick={() => onOpen(r.id)}>
                      {dsr(r.number)}
                    </button>
                    {viewers.get(r.id)?.[0] && <span className="viewing">● {t("viewing", { name: viewers.get(r.id)![0].name })}</span>}
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
                  <td className="small">
                    {r.status === "open" ? r.legalHold ? <span className="pill warn">{t("eraseHeld")}</span> : r.approvalRequestId && r.step === 3 ? tr("erasePending") : r.stepLabel : t(`filter.${r.status}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.data?.total != null && (
        <div style={{ padding: "10px 16px" }}>
          <Pager hotkeys offset={offset} limit={PAGE} shown={items.length} total={query.data.total} onChange={setOffset} />
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
  const others = usePresence("privacy", id);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={r ? `${dsr(r.number)} · ${t(`privacy.types.${r.requestType}`)}` : t("privacy.requests")}
      description={r ? t("req.who", { email: r.requesterEmail, ws: r.workspaces?.length ? r.workspaces.map((w) => w.name).join(", ") : r.userId ? t("privacy.allWs") : t("privacy.noAccount") }) : undefined}
    >
      {others[0] && <div className="presence-banner warn">● {t("privacy.othersHere", { name: others[0].name })}</div>}
      {q.isPending ? <TableSkeleton rows={5} cols={1} /> : q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : <RequestBody d={q.data} canAct={canAct} verify={verify} setModal={setModal} />}
      {r && modal === "advance" && <AdvanceDialog r={r} steps={q.data!.steps} onClose={() => setModal(null)} />}
      {r && modal === "reject" && <RejectDialog r={r} onClose={() => setModal(null)} />}
      {r && modal === "erase" && <EraseDialog d={q.data!} onClose={() => setModal(null)} />}
    </Drawer>
  );
}

function RequestBody({ d, canAct, verify, setModal }: { d: RequestDetail; canAct: boolean; verify: { mutate: (m: Exclude<Identity, "unverified">) => void; isPending: boolean }; setModal: (m: "advance" | "reject" | "erase") => void }) {
  const t = useTranslations("pl");
  const tl = useTranslations("leads");
  const fmt = useFmt();
  const r = d.request;
  const open = r.status === "open";
  const erase = r.requestType === "erase";
  const unverified = r.identity === "unverified";
  const eraseStep = erase && r.step === 3;
  const held = !!r.legalHold;
  const blocked = (d.erasePlan?.blockers.length ?? 0) > 0 || held;
  return (
    <div className="stack">
      <div className="row">
        <DuePill r={r} />
        {held && <span className="pill warn">{t("privacy.eraseHeld")}</span>}
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
            {held && erase && <Notice tone="warn" title={t("privacy.eraseHeld")}>{t("req.eraseHeld")}</Notice>}
            <div className="row">
              {eraseStep ? (
                <Button variant="danger" disabled={blocked || (!r.userId && !d.leads.length)} onClick={() => setModal("erase")}>
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
      {/* Lead ฝ่ายขาย (O54) ของอีเมลผู้ขอ · อยู่ในขอบเขตแม้ไม่มีบัญชี เพราะทีม Friday เป็นผู้ควบคุมข้อมูลนี้เอง */}
      <section>
        <h3 className="card-title">{t("req.leads")}</h3>
        {!d.leads.length ? (
          <p className="muted small">{t("req.leadsNone")}</p>
        ) : (
          <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
            {d.leads.map((l) => (
              <li key={l.id}>
                <b>#{l.number} {l.company}</b> <span className="muted">· {tl(`stage.${l.stage}` as "stage.new")} · {fmt.date(l.createdAt)}</span>
                <div className="muted">
                  {[l.contactName, l.contactTitle, l.email, l.phone].filter(Boolean).join(" · ") || t("req.leadErased")}
                  {l.consentAt ? ` · ${t("req.leadConsent", { date: fmt.date(l.consentAt) })}` : ""}
                  {l.notes ? ` · ${t("req.leadNotes", { n: l.notes })}` : ""}
                  {l.acceptedQuotes ? ` · ${t("req.leadQuotes", { n: l.acceptedQuotes })}` : ""}
                </div>
                {l.message && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>“{l.message}”</div>}
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
      {plan.blockers
        .filter((b) => b.code === "sole_owner")
        .map((b) => (
          <Notice key={b.workspace} tone="bad" title={t("blocker", { ws: b.workspace ?? "" })} />
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
