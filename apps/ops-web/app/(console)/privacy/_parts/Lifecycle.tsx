"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX, Lock, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useDeferredValue, useState } from "react";
import { CountUp } from "@/components/count-up";
import { IrreversibleDialog, useApprovalFlow, useReauth } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import styles from "../privacy.module.css";
import type { LegalHold, PendingDelete, PrivacyRequest, PurgePreview, RetentionInfo, RetentionKey, RetentionRow } from "./types";
import { type PickedWs, WorkspacePicker } from "./WorkspacePicker";

const keys = {
  pending: ["ops", "privacy", "pending-deletes"] as const,
  holds: ["ops", "privacy", "legal-holds"] as const,
  retention: ["ops", "privacy", "retention"] as const,
};
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });
/** ที่อยู่การ์ด Legal hold · ปุ่ม "ดู Legal hold" เลื่อนมาที่นี่ */
const HOLDS_ID = "legal-holds";

export const usePendingDeletes = () => useQuery({ queryKey: keys.pending, queryFn: () => api.get<{ items: PendingDelete[]; graceDays: number }>("/privacy/pending-deletes") });
export const useLegalHolds = () => useQuery({ queryKey: keys.holds, queryFn: () => api.get<{ items: LegalHold[] }>("/privacy/legal-holds") });
export const useRetention = () => useQuery({ queryKey: keys.retention, queryFn: () => api.get<RetentionInfo>("/privacy/retention") });

function CardHead({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
      <h2 className="card-title">{title}</h2>
      {sub && <span className="card-sub">{sub}</span>}
      {action && (
        <>
          <span className="spacer" />
          {action}
        </>
      )}
    </div>
  );
}

/** เก็บเป็นปีเมื่อหารด้วย 365 ลงตัว (730 วัน = 2 ปี) */
function useKeep() {
  const t = useTranslations("pl.life");
  return (days: number) => (days >= 365 && days % 365 === 0 ? t("years", { n: days / 365 }) : t("days", { n: days }));
}

/** ตัวเลข 4 ช่องของส่วนล่าง (H10): คำขอที่เปิด · Workspace รอลบ · Legal hold · ข้อมูลที่ลบตามนโยบายเมื่อคืน */
export function LifecycleKpis({ requests }: { requests: PrivacyRequest[] }) {
  const t = useTranslations("pl.life.kpi");
  const fmt = useFmt();
  const pending = usePendingDeletes().data?.items ?? [];
  const holds = (useLegalHolds().data?.items ?? []).filter((h) => h.active);
  const last = useRetention().data?.lastRun ?? null;
  const open = requests.filter((r) => r.status === "open");
  const soon = open.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 7).length;
  const purged = last ? (last.logRows ?? 0) + (last.sessionRows ?? 0) : null;
  return (
    <section className="stats" aria-label={t("purged")}>
      <div className="stat">
        <span className="muted small">{t("open")}</span>
        <b>
          <CountUp value={open.length} />
        </b>
        <span className="muted small">{t("openNote", { n: soon })}</span>
      </div>
      <div className="stat">
        <span className="muted small">{t("pending")}</span>
        <b>
          <CountUp value={pending.length} />
        </b>
        <span className="muted small">{t("pendingNote", { n: pending.filter((p) => p.daysLeft === 0 && !p.legalHold).length })}</span>
      </div>
      <div className={holds.length ? "stat stat-warn" : "stat"}>
        <span className="muted small">{t("holds")}</span>
        <b>
          <CountUp value={holds.length} />
        </b>
        <span className="muted small">{holds[0]?.workspace.name ?? t("holdsNone")}</span>
      </div>
      <div className="stat">
        <span className="muted small">{t("purged")}</span>
        <b>
          <CountUp value={purged == null ? "—" : t("purgedRows", { n: fmt.num(purged) })} />
        </b>
        <span className="muted small">{last?.systemLogDays ? t("purgedNote", { days: last.systemLogDays }) : t("purgedNone")}</span>
      </div>
    </section>
  );
}

/** Workspace ที่รอลบ (H10) · แก้บั๊ก: อ่านจากแหล่งเดียวกับหน้ากู้คืน · Owner ลบทันทีได้ (H13) */
export function PendingDeletes({ owner }: { owner: boolean }) {
  const t = useTranslations("pl.privacy");
  const tl = useTranslations("pl.life");
  const fmt = useFmt();
  const q = usePendingDeletes();
  const [purging, setPurging] = useState<PendingDelete | null>(null);
  const viewHold = () => {
    const el = document.getElementById(HOLDS_ID);
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    el?.classList.remove(styles.flash);
    void el?.offsetWidth;
    el?.classList.add(styles.flash);
  };
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <CardHead title={t("pendingDeletes")} sub={t("pendingDeletesSub")} />
      {q.isPending ? (
        <TableSkeleton rows={2} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("noPendingDeletes")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("pdCol.ws")}</th>
                <th>{t("pdCol.by")}</th>
                <th>{t("pdCol.at")}</th>
                <th>{t("pdCol.purge")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <b>{d.name}</b>
                    <div className="muted small mono">{d.slug}</div>
                  </td>
                  <td className="small">{d.requestedBy ? tl("byRole", { name: d.requestedBy.name, role: d.requestedBy.role }) : tl("system")}</td>
                  <td className="small num">{fmt.date(d.requestedAt)}</td>
                  <td className="small">
                    {d.legalHold ? (
                      <span className="pill warn">{tl("held")}</span>
                    ) : d.purgeApproved ? (
                      <span className="pill bad">{tl("approved")}</span>
                    ) : (
                      <span className={d.daysLeft <= 7 ? "pill warn" : "pill"}>{d.daysLeft > 0 ? tl("purgeIn", { date: fmt.date(d.purgeAt), n: d.daysLeft }) : tl("purgeToday", { date: fmt.date(d.purgeAt) })}</span>
                    )}
                    {d.purgeApproval && !d.purgeApproved && <div className="muted small">{tl("approvalPending")}</div>}
                  </td>
                  <td>
                    <div className={styles.actions}>
                      {d.legalHold ? (
                        <Button size="small" onClick={viewHold}>
                          {tl("viewHold")}
                        </Button>
                      ) : (
                        <>
                          {!d.purgeApproved && (
                            <Link className={buttonClass("secondary", "small")} href="/restore?tab=pending">
                              {tl("extend")}
                            </Link>
                          )}
                          {owner && !d.purgeApproved && !d.purgeApproval && (
                            <Button size="small" onClick={() => setPurging(d)}>
                              {tl("purgeNow")}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {purging && <PurgeNowDialog d={purging} onClose={() => setPurging(null)} />}
    </section>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li>
      {ok ? <CircleCheck size={16} className={styles.ok} aria-hidden /> : <CircleX size={16} className={styles.bad} aria-hidden />}
      <span>{children}</span>
    </li>
  );
}

/** H13 · ลบถาวรทันที: Ticket จาก Owner + ไม่มี hold + ไม่ค้างชำระ + พิมพ์ slug → ขอคนที่สองอนุมัติเสมอ (202) */
function PurgeNowDialog({ d, onClose }: { d: PendingDelete; onClose: () => void }) {
  const t = useTranslations("pl.life.h13");
  const fmt = useFmt();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...keys.pending, d.id], queryFn: () => api.get<PurgePreview>(`/privacy/pending-deletes/${d.id}`) });
  const tickets = (q.data?.tickets ?? []).filter((x) => x.fromOwner);
  const [ticket, setTicket] = useState("");
  const ticketId = ticket || tickets[0]?.id || "";
  const c = q.data?.checks;
  return (
    <IrreversibleDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("title", { name: d.name })}
      description={t("desc")}
      word={d.slug}
      confirmLabel={t("submit")}
      note={t("note")}
      onConfirm={async ({ reason, typed }) => {
        if (!ticketId) throw new Error(t("noTicket"));
        const res = await run(() => api.post(`/privacy/pending-deletes/${d.id}/purge-now`, { ticketId, confirmSlug: typed, reason }), t("reauth"));
        handle(res);
        invalidate(cache);
      }}
    >
      {q.isPending ? (
        <TableSkeleton rows={3} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <ul className={styles.checks}>
            <Check ok={tickets.length > 0}>{tickets.length ? t("ticket") : t("noTicket")}</Check>
            <Check ok={!c!.legalHold}>{c!.legalHold ? t("hasHold") : t("noHold")}</Check>
            <Check ok={c!.unpaidInvoices === 0}>{c!.unpaidInvoices ? t("unpaid", { n: c!.unpaidInvoices }) : t("noUnpaid")}</Check>
          </ul>
          {tickets.length > 0 && (
            <Select label={t("ticketPick")} value={ticketId} onChange={(e) => setTicket(e.target.value)}>
              {tickets.map((x) => (
                <option key={x.id} value={x.id}>
                  #{x.number} · {x.subject}
                </option>
              ))}
            </Select>
          )}
          <div className={styles.kv}>
            <span className={styles.kvKey}>{t("remove")}</span>
            <span>{t("removeText", { projects: q.data.remove.projects, issues: fmt.num(q.data.remove.issues), size: fmt.bytes(q.data.remove.bytes), members: q.data.remove.members })}</span>
            <span className={styles.kvKey}>{t("keep")}</span>
            <span>{t("keepText", { n: q.data.keepYears })}</span>
          </div>
        </>
      )}
    </IrreversibleDialog>
  );
}

// ---------------------------------------------------------------- Legal hold (H11)

export function LegalHolds({ owner }: { owner: boolean }) {
  const t = useTranslations("pl.life");
  const fmt = useFmt();
  const q = useLegalHolds();
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  return (
    <section id={HOLDS_ID} className="card" style={{ padding: 0, overflow: "hidden" }}>
      <CardHead
        title={t("holds")}
        sub={t("holdsSub")}
        action={
          owner && (
            <Button size="small" variant="primary" onClick={() => setCreating(true)}>
              <Lock size={14} /> {t("setHold")}
            </Button>
          )
        }
      />
      {q.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("holdsEmpty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("hCol.ws")}</th>
                <th>{t("hCol.scope")}</th>
                <th>{t("hCol.reason")}</th>
                <th>{t("hCol.until")}</th>
                {owner && <th />}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((h) => (
                <tr key={h.id} className={h.active ? undefined : styles.released}>
                  <td>{h.workspace.name}</td>
                  <td className="small" title={h.scope === "users" ? h.userEmails.join(", ") : undefined}>
                    {h.scope === "workspace" ? t("scopeWs") : t("scopeUsers", { n: h.userIds.length })}
                  </td>
                  <td className="small">
                    {h.reason} · {h.reference}
                  </td>
                  <td className="small">
                    {h.active ? (
                      <>
                        {t("untilRelease")}
                        {h.reviewOn && <div className="muted">{t("reviewOn", { date: fmt.date(h.reviewOn) })}</div>}
                      </>
                    ) : (
                      t("released", { date: fmt.date(h.releasedAt) })
                    )}
                  </td>
                  {owner && (
                    <td>
                      {h.active &&
                        (h.releaseApproval ? (
                          <span className="pill warn">{t("releasePending")}</span>
                        ) : (
                          <Button size="small" variant="ghost" onClick={() => setReleasing(h)}>
                            {t("release")}
                          </Button>
                        ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <SetHold onClose={() => setCreating(false)} />}
      {releasing && <ReleaseHold h={releasing} onClose={() => setReleasing(null)} />}
    </section>
  );
}

const REASONS = ["dispute", "court", "investigation", "other"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** H11 · ตั้ง Legal hold (Owner · แตะกุญแจ) · ไม่แจ้งลูกค้าเป็นค่าเริ่มต้น */
function SetHold({ onClose }: { onClose: () => void }) {
  const t = useTranslations("pl.life.h11");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const pending = usePendingDeletes().data?.items ?? [];
  const [ws, setWs] = useState<PickedWs[]>([]);
  const [scope, setScope] = useState<"workspace" | "users">("workspace");
  const [emails, setEmails] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [reasonKey, setReasonKey] = useState<(typeof REASONS)[number]>("dispute");
  const [other, setOther] = useState("");
  const [reference, setReference] = useState("");
  const [end, setEnd] = useState<"until" | "date">("until");
  const [reviewOn, setReviewOn] = useState("");
  const [notify, setNotify] = useState(false);
  const reason = reasonKey === "other" ? other.trim() : t(`reasons.${reasonKey}`);
  const ok = ws.length === 1 && reason.length >= 3 && reference.trim().length >= 2 && (scope === "workspace" || emails.length > 0) && (end === "until" || !!reviewOn);
  const addEmail = () => {
    const v = email.trim().replace(/,$/, "").toLowerCase();
    if (EMAIL.test(v) && !emails.includes(v)) setEmails([...emails, v]);
    if (EMAIL.test(v)) setEmail("");
  };
  const m = useMutation({
    mutationFn: () =>
      run(
        () =>
          api.post("/privacy/legal-holds", {
            workspaceId: ws[0].id,
            scope,
            userEmails: scope === "users" ? emails : [],
            reason,
            reference: reference.trim(),
            ...(end === "date" && reviewOn ? { reviewOn } : {}),
            notifyCustomer: notify,
          }),
        t("reauth"),
      ),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <WorkspacePicker label={t("ws")} placeholder={t("wsSearch")} value={ws} onChange={(v) => setWs(v.slice(-1))} extra={pending.map((p) => ({ id: p.id, name: p.name, slug: p.slug }))} />
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("scope")}</legend>
          {(["workspace", "users"] as const).map((v) => (
            <label key={v} className="check">
              <input type="radio" name="h11-scope" checked={scope === v} onChange={() => setScope(v)} />
              <span>
                <b>{v === "workspace" ? t("scopeWs") : t("scopeUsers")}</b> <span className="muted small">{v === "workspace" ? t("scopeWsDesc") : t("scopeUsersDesc")}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {scope === "users" && (
          <div className="field">
            <Input
              label={t("emails")}
              hint={t("emailsHint")}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={addEmail}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addEmail();
                }
              }}
            />
            {emails.length > 0 && (
              <div className={styles.chips}>
                {emails.map((x) => (
                  <span key={x} className="pill inf">
                    {x}
                    <button type="button" className="link-button" aria-label={t("removeEmail", { email: x })} onClick={() => setEmails(emails.filter((y) => y !== x))}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="grid-2">
          <Select label={t("reason")} value={reasonKey} onChange={(e) => setReasonKey(e.target.value as (typeof REASONS)[number])}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reasons.${r}`)}
              </option>
            ))}
          </Select>
          <Input label={t("reference")} placeholder={t("referencePh")} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        {reasonKey === "other" && <Input label={t("reasonOther")} value={other} onChange={(e) => setOther(e.target.value)} />}
        <Select label={t("end")} value={end} onChange={(e) => setEnd(e.target.value as "until" | "date")}>
          <option value="until">{t("endUntil")}</option>
          <option value="date">{t("endDate")}</option>
        </Select>
        {end === "date" && <Input label={t("reviewDate")} type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} />}
        <div className={styles.section}>{t("effects")}</div>
        <ul className={styles.checks}>
          <li>
            <CircleCheck size={16} className={styles.ok} aria-hidden /> <span>{t("e1")}</span>
          </li>
          <li>
            <CircleAlert size={16} className={styles.warn} aria-hidden /> <span>{t("e2")}</span>
          </li>
          <li>
            <CircleAlert size={16} className={styles.warn} aria-hidden /> <span>{t("e3")}</span>
          </li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>
            {t("notify")} <span className="muted small">{t("notifyHint")}</span>
          </span>
        </label>
        <p className="muted small">{t("note")}</p>
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

/** ยกเลิก Legal hold → ขอคนที่สองอนุมัติ (202) */
function ReleaseHold({ h, onClose }: { h: LegalHold; onClose: () => void }) {
  const t = useTranslations("pl.life");
  const tc = useTranslations("common.dialog");
  const { handle } = useApprovalFlow();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/privacy/legal-holds/${h.id}/release`, { reason: reason.trim() }),
    onSuccess: (res) => (handle(res), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("releaseTitle", { ws: h.workspace.name })} description={t("releaseDesc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 5 && m.mutate())}>
        <Textarea label={t("releaseReason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={tc("reasonRequired", { min: 5 })} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={reason.trim().length < 5 || m.isPending}>
            {t("releaseSubmit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- นโยบายการเก็บข้อมูล (H12)

export function RetentionCard({ owner }: { owner: boolean }) {
  const t = useTranslations("pl.life");
  const tp = useTranslations("pl.privacy");
  const keep = useKeep();
  const q = useRetention();
  const [editing, setEditing] = useState<RetentionRow | null>(null);
  const row = (key: RetentionKey) => q.data?.rows.find((r) => r.key === key);
  const editable = (r: RetentionRow | undefined) =>
    r && (
      <tr key={r.key}>
        <td>
          {r.label}
          {!r.enforced && r.note && <div className="muted small">{r.note}</div>}
        </td>
        <td className="num">
          {keep(r.days)}
          {r.key === "trashDays" && <span className="muted small"> {t("trashNote")}</span>}
          {r.pendingApproval && <div className="pill warn small">{t("pendingChange", { n: r.pendingApproval.days })}</div>}
        </td>
        <td>
          {owner && !r.pendingApproval && (
            <Button size="small" aria-label={t("editLabel", { label: r.label })} onClick={() => setEditing(r)}>
              {t("edit")}
            </Button>
          )}
        </td>
      </tr>
    );
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <CardHead title={tp("retention")} sub={tp("retentionSub")} />
      {q.isPending ? (
        <TableSkeleton rows={6} cols={3} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("rCol.what")}</th>
                <th>{t("rCol.keep")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {editable(row("workspaceDataDays"))}
              {editable(row("trashDays"))}
              <tr>
                <td>{t("customerAudit")}</td>
                <td>{t("byPlan")}</td>
                <td className="muted small">{t("byPlanNote")}</td>
              </tr>
              {editable(row("systemLogDays"))}
              <tr>
                <td>{t("tax")}</td>
                <td className="num">
                  {t("years", { n: q.data.taxYears })} <Lock size={12} aria-hidden className="muted" />
                </td>
                <td className="muted small">{t("taxNote")}</td>
              </tr>
              {editable(row("staffAuditDays"))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RetentionDialog r={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** H12 · ยาวขึ้นบันทึกได้เลย · สั้นลงแสดงจำนวนแถวที่จะลบแล้วส่งขออนุมัติ (202) */
function RetentionDialog({ r, onClose }: { r: RetentionRow; onClose: () => void }) {
  const t = useTranslations("pl.life.h12");
  const tc = useTranslations("common.dialog");
  const keep = useKeep();
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const { handle } = useApprovalFlow();
  const [value, setValue] = useState(String(r.days));
  const [reason, setReason] = useState("");
  const days = Number(value);
  const valid = Number.isInteger(days) && days >= r.min && days <= r.max && days !== r.days;
  const shorter = valid && days < r.days;
  const deferred = useDeferredValue(days);
  const estimate = useQuery({
    queryKey: [...keys.retention, "estimate", r.key, deferred],
    queryFn: () => api.get<{ rows: number | null }>(`/privacy/retention/estimate?key=${r.key}&days=${deferred}`),
    enabled: shorter && deferred === days,
  });
  const ok = valid && reason.trim().length >= 5;
  const m = useMutation({
    mutationFn: () => run(() => api.put<{ pendingApproval?: unknown }>("/privacy/retention", { key: r.key, days, reason: reason.trim() }), t("reauth")),
    onSuccess: (res) => {
      if (!res?.pendingApproval) toast(t("saved"));
      handle(res);
      invalidate(cache);
      onClose();
    },
  });
  const rows = estimate.data?.rows;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { label: r.label })} description={t("desc", { days: keep(r.days) })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={t("keep")} type="number" inputMode="numeric" min={r.min} max={r.max} className="num" hint={t("hint", { min: r.min, max: r.max })} value={value} onChange={(e) => setValue(e.target.value)} />
        {shorter && <Notice tone="warn" title={t("shorter", { days, rows: rows != null ? t("rows", { n: fmt.num(rows) }) : "" })} />}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={tc("reasonRequired", { min: 5 })} />
        <p className="muted small">{t("note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {shorter ? t("submitApproval") : t("submitSave")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** ส่วนล่างของหน้า PDPA (H10): Workspace ที่รอลบเต็มความกว้าง แล้ว Legal hold คู่กับนโยบายการเก็บข้อมูล */
export function Lifecycle({ owner }: { owner: boolean }) {
  return (
    <>
      <PendingDeletes owner={owner} />
      <div className={styles.lower}>
        <LegalHolds owner={owner} />
        <RetentionCard owner={owner} />
      </div>
    </>
  );
}
