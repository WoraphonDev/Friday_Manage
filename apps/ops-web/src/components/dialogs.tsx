"use client";

/**
 * Modal กลางของ Friday Ops (Modals-Global G4–G9, G12) · หน้าอื่นเรียกใช้ผ่าน hook ไม่ต้องสร้าง Modal เอง
 * - useReauth().run(fn): ทำรายการ · ถ้า ops-api ตอบ `reauth_required` เปิด G4 ให้แตะกุญแจ แล้วทำซ้ำ
 * - useApprovalFlow().handle(result): ผลที่มี `pendingApproval` (202) → G12 ถ้าอนุมัติตัวเองได้ · ไม่ได้ → G7
 * - <ConfirmDialog> (G5) · <IrreversibleDialog> (G6) · <ApprovalsDrawer> (G8) · <ExportDialog> (G9)
 */
import { startAuthentication } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/query";
import { hasAny } from "./access";
import { Drawer, Empty, ErrorBlock, Modal, Notice, TableSkeleton } from "./kit";
import { Button, errorToast, InlineError, Input, Textarea, useToast } from "./ui";

/** ชื่อรายการที่ต้องอนุมัติ · key ของ next-intl ห้ามมีจุด จึงแปลง `billing.refund` → `billing_refund` */
type CommonT = ReturnType<typeof useTranslations<"common">>;
export function kindText(t: CommonT, kind: string) {
  const key = `kinds.${kind.replace(/\./g, "_")}` as "kinds.billing_refund";
  return t.has(key) ? t(key) : kind;
}

// ---------------------------------------------------------------- G4 · ยืนยันตัวตนซ้ำ

type Pending = { label?: string; resolve: () => void; reject: (e: unknown) => void; error: unknown };
const ReauthContext = createContext<{ run: <T>(fn: () => Promise<T>, label?: string) => Promise<T> }>({ run: (fn) => fn() });
export const useReauth = () => useContext(ReauthContext);

/** แตะกุญแจ: ขอ challenge → ให้ key เซ็น → ops-api ตั้ง cookie `fm_ops_re` 15 นาที */
export async function reauthenticate() {
  const { options, challengeToken } = await api.post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"]; challengeToken: string }>("/auth/reauth/options");
  const response = await startAuthentication({ optionsJSON: options });
  await api.post("/auth/reauth/verify", { challengeToken, response });
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("common.reauth");
  const td = useTranslations("common.dialog");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);

  const run = useCallback(async <T,>(fn: () => Promise<T>, label?: string): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_required")) throw e;
      await new Promise<void>((resolve, reject) => setPending({ label, resolve, reject, error: e }));
      return fn();
    }
  }, []);

  const tap = async () => {
    if (!pending) return;
    setBusy(true);
    setFailed(null);
    try {
      await reauthenticate();
      const p = pending;
      setPending(null);
      p.resolve();
    } catch (e) {
      setFailed(e);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    pending?.reject(pending.error);
    setPending(null);
    setFailed(null);
  };
  const cancelled = failed instanceof Error && !(failed instanceof ApiError);

  return (
    <ReauthContext.Provider value={{ run }}>
      {children}
      <Modal open={!!pending} onOpenChange={(o) => !o && close()} title={t("title")} description={t("desc")}>
        <div className="dialog-body">
          {pending?.label && (
            <div className="row">
              <span className="muted">{t("action")}</span>
              <b>{pending.label}</b>
            </div>
          )}
          <Notice tone="info" icon={<KeyRound size={18} />} title={busy ? t("waiting") : t("hint")} />
          {cancelled ? <InlineError error={new Error(t("cancelled"))} /> : <InlineError error={failed} />}
          <p className="muted small">{t("noBackup")}</p>
          <div className="dialog-actions">
            <Button onClick={close}>{td("cancel")}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void tap()}>
              <KeyRound size={16} />
              {failed ? t("retry") : t("start")}
            </Button>
          </div>
        </div>
      </Modal>
    </ReauthContext.Provider>
  );
}

// ---------------------------------------------------------------- G5 · ยืนยันพร้อมเหตุผล

export interface ConfirmValues {
  reason: string;
  ticketNo: string;
  notify: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  minReason = 3,
  ticket,
  notify,
  reasonLabel,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  minReason?: number;
  /** แสดงช่อง Ticket ที่เกี่ยวข้อง (บังคับ) */
  ticket?: boolean;
  /** แสดงช่องติ๊ก "แจ้งผู้ใช้ทางอีเมล" */
  notify?: boolean;
  reasonLabel?: string;
  children?: ReactNode;
  onConfirm: (v: ConfirmValues) => Promise<unknown>;
}) {
  const t = useTranslations("common.dialog");
  const [reason, setReason] = useState("");
  const [ticketNo, setTicketNo] = useState("");
  const [notifyUser, setNotifyUser] = useState(true);
  const [touched, setTouched] = useState(false);
  const m = useMutation({ mutationFn: () => onConfirm({ reason: reason.trim(), ticketNo: ticketNo.trim(), notify: notifyUser }) });
  const reasonOk = minReason === 0 || reason.trim().length >= minReason;
  const ticketOk = !ticket || ticketNo.trim().length >= 3;
  const reset = (o: boolean) => {
    if (!o) {
      setReason("");
      setTicketNo("");
      setTouched(false);
      m.reset();
    }
    onOpenChange(o);
  };
  return (
    <Modal open={open} onOpenChange={reset} title={title} description={description}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (reasonOk && ticketOk) m.mutate(undefined, { onSuccess: () => reset(false) });
        }}
      >
        {children}
        {ticket && <Input label={t("ticket")} value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} placeholder="#512" error={touched && !ticketOk ? t("reasonRequired", { min: 3 }) : undefined} />}
        {minReason > 0 && (
          <Textarea label={reasonLabel ?? t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} error={touched && !reasonOk ? t("reasonRequired", { min: minReason }) : undefined} />
        )}
        {notify && (
          <label className="check">
            <input type="checkbox" checked={notifyUser} onChange={(e) => setNotifyUser(e.target.checked)} />
            <span>{t("notifyUser")}</span>
          </label>
        )}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={() => reset(false)}>{t("cancel")}</Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} disabled={m.isPending}>
            {m.isPending ? t("saving") : (confirmLabel ?? t("confirm"))}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- G6 · ย้อนกลับไม่ได้

export function IrreversibleDialog({
  open,
  onOpenChange,
  title,
  description,
  word,
  confirmLabel,
  note,
  minReason = 5,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  /** คำที่ต้องพิมพ์ยืนยัน (เช่น slug) */
  word: string;
  confirmLabel?: string;
  note?: ReactNode;
  minReason?: number;
  children?: ReactNode;
  onConfirm: (v: { reason: string; typed: string }) => Promise<unknown>;
}) {
  const t = useTranslations("common.dialog");
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const m = useMutation({ mutationFn: () => onConfirm({ reason: reason.trim(), typed: typed.trim() }) });
  const ok = reason.trim().length >= minReason && typed.trim() === word;
  const reset = (o: boolean) => {
    if (!o) {
      setReason("");
      setTyped("");
      m.reset();
    }
    onOpenChange(o);
  };
  return (
    <Modal open={open} onOpenChange={reset} title={title} description={description}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) m.mutate(undefined, { onSuccess: () => reset(false) });
        }}
      >
        <Notice tone="bad" icon={<ShieldAlert size={18} />} title={t("irreversible")} />
        {children}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={t("reasonRequired", { min: minReason })} />
        <Input label={t("typeToConfirm", { word })} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="mono" />
        {note && <p className="muted small">{note}</p>}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={() => reset(false)}>{t("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!ok || m.isPending}>
            {m.isPending ? t("saving") : (confirmLabel ?? t("confirm"))}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- G7 / G12 · ผลที่ต้องอนุมัติ

export interface PendingApproval {
  id: string;
  kind: string;
  reason: string;
  expiresAt: string;
  amountSatang: number | null;
  payload: Record<string, unknown> & { rule?: string };
  canSelfApprove?: boolean;
  requestedBy?: string;
}
const ApprovalContext = createContext<{ handle: <T>(result: T) => T }>({ handle: (r) => r });
/** ส่งผลของรายการที่อาจตอบ 202 `pendingApproval` · ไม่ใช่ = คืนค่าเดิม */
export const useApprovalFlow = () => useContext(ApprovalContext);

export function ApprovalFlowProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("common");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const me = useMe().data;
  const [current, setCurrent] = useState<PendingApproval | null>(null);
  const [selfReason, setSelfReason] = useState("");
  const self = !!current?.canSelfApprove;
  const done = () => {
    setCurrent(null);
    setSelfReason("");
    void cache.invalidateQueries({ queryKey: ["ops"] });
  };
  const approveSelf = useMutation({
    mutationFn: () => run(() => api.post(`/approvals/${current!.id}/approve`, { note: selfReason.trim() }), kindText(t, current!.kind)),
    onSuccess: () => {
      toast(t("approval.selfDone"));
      done();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/approvals/${current!.id}/cancel`),
    onSuccess: () => {
      toast(t("approval.cancelled"));
      done();
    },
    onError: (e) => toast(errorToast(e)),
  });
  const handle = useCallback(<T,>(result: T): T => {
    const p = (result as { pendingApproval?: PendingApproval } | null)?.pendingApproval;
    if (p) setCurrent(p);
    return result;
  }, []);
  const kindLabel = current ? kindText(t, current.kind) : "";
  return (
    <ApprovalContext.Provider value={{ handle }}>
      {children}
      <Modal open={!!current && !self} onOpenChange={(o) => !o && done()} title={t("approval.sentTitle")} description={current ? t("approval.sentDesc", { time: format.dateTime(new Date(current.expiresAt), { dateStyle: "medium", timeStyle: "short" }) }) : undefined}>
        {current && (
          <div className="dialog-body">
            <div className="stack small">
              <div className="row">
                <span className="muted">{kindLabel}</span>
              </div>
              {current.payload.rule && (
                <div>
                  <span className="muted">{t("approval.rule")}: </span>
                  {current.payload.rule}
                </div>
              )}
              <div>
                <span className="muted">{t("approval.requester")}: </span>
                {me?.name ?? t("approval.you")}
              </div>
            </div>
            <p className="muted small">{t("approval.noSelf")}</p>
            <div className="dialog-actions">
              <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                {t("approval.cancelRequest")}
              </Button>
              <Button variant="primary" onClick={done}>
                {t("dialog.close")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={!!current && self} onOpenChange={(o) => !o && done()} title={t("approval.selfTitle")} description={current ? `${kindLabel} · ${current.payload.rule ?? ""}` : undefined}>
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (selfReason.trim().length >= 5) approveSelf.mutate();
          }}
        >
          <Notice tone="warn" title={t("approval.selfDesc")} />
          <Textarea label={t("approval.selfReason")} value={selfReason} onChange={(e) => setSelfReason(e.target.value)} hint={t("dialog.reasonRequired", { min: 5 })} />
          <p className="muted small">{t("approval.selfNot")}</p>
          <InlineError error={approveSelf.error} />
          <div className="dialog-actions">
            <Button onClick={done}>{t("approval.selfLater")}</Button>
            <Button type="submit" variant="primary" disabled={selfReason.trim().length < 5 || approveSelf.isPending}>
              {t("approval.selfApprove")}
            </Button>
          </div>
        </form>
      </Modal>
    </ApprovalContext.Provider>
  );
}

// ---------------------------------------------------------------- G8 · คำขอที่ส่งถึงฉัน

interface ApprovalRow extends PendingApproval {
  requesterName: string;
  createdAt: string;
  status: string;
}

export function ApprovalsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("common");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const me = useMe().data;
  const owner = hasAny(me, "owner");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ["ops", "approvals", "pending"], queryFn: () => api.get<{ items: ApprovalRow[]; singleApprover: boolean }>("/approvals?status=pending"), enabled: open });
  const decide = useMutation({
    mutationFn: ({ id, kind, decision }: { id: string; kind: string; decision: "approve" | "reject" }) =>
      decision === "approve" ? run(() => api.post(`/approvals/${id}/approve`, { note: notes[id]?.trim() || undefined }), kindText(t, kind)) : api.post(`/approvals/${id}/reject`, { note: notes[id]?.trim() || undefined }),
    onSuccess: (_r, v) => {
      toast(v.decision === "approve" ? t("approval.approved") : t("approval.rejected"));
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (e) => toast(errorToast(e)),
  });
  const money = (s: number) => format.number(s / 100, { style: "currency", currency: "THB" });
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t("approval.inboxTitle")} description={t("approval.needsKey")}>
      {list.isPending ? (
        <TableSkeleton rows={3} cols={2} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !list.data.items.length ? (
        <Empty ok title={t("approval.inboxEmpty")} />
      ) : (
        <div className="stack">
          {list.data.items.map((a) => {
            const mine = a.requestedBy === me?.id;
            const canDecide = owner && (!mine || a.canSelfApprove);
            return (
              <article key={a.id} className="card" aria-label={kindText(t, a.kind)}>
                <div className="card-head">
                  <h3 className="card-title">{kindText(t, a.kind)}</h3>
                  {mine && <span className="pill warn">{t("approval.you")}</span>}
                </div>
                <div className="muted small">
                  {t("approval.requestedAt", {
                    name: a.requesterName,
                    time: format.dateTime(new Date(a.createdAt), { dateStyle: "medium", timeStyle: "short" }),
                    expires: format.dateTime(new Date(a.expiresAt), { dateStyle: "medium", timeStyle: "short" }),
                  })}
                </div>
                {a.amountSatang != null && (
                  <div>
                    <span className="muted">{t("approval.amount")}: </span>
                    <b>{money(a.amountSatang)}</b>
                  </div>
                )}
                {a.payload.rule && <div className="small">{a.payload.rule}</div>}
                <div className="small">
                  <span className="muted">{t("approval.requesterReason")}: </span>
                  {a.reason}
                </div>
                {canDecide ? (
                  <>
                    <Input label={t("approval.note")} value={notes[a.id] ?? ""} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                    <div className="dialog-actions">
                      {!mine && (
                        <Button disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, kind: a.kind, decision: "reject" })}>
                          {t("approval.reject")}
                        </Button>
                      )}
                      <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, kind: a.kind, decision: "approve" })}>
                        {t("approval.approve")}
                      </Button>
                    </div>
                  </>
                ) : (
                  mine && <p className="muted small">{t("approval.noSelf")}</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------- G9 · ส่งออก

export interface ExportColumn {
  key: string;
  label: string;
  /** ข้อมูลส่วนบุคคล → ต้องระบุเหตุผล */
  pii?: boolean;
}

/** ส่งออก CSV จากข้อมูลที่โหลดไว้ตามตัวกรองปัจจุบัน (มี BOM ให้ Excel อ่านภาษาไทยได้) */
export function ExportDialog({
  open,
  onOpenChange,
  title,
  columns,
  rows,
  filename,
  onExported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  filename: string;
  onExported?: (v: { columns: string[]; reason: string; count: number }) => void;
}) {
  const t = useTranslations("common");
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>(() => columns.filter((c) => !c.pii).map((c) => c.key));
  const [reason, setReason] = useState("");
  const needsReason = columns.some((c) => c.pii && picked.includes(c.key));
  const ok = picked.length > 0 && (!needsReason || reason.trim().length >= 5);
  const link = useRef<HTMLAnchorElement>(null);
  const download = () => {
    const cols = columns.filter((c) => picked.includes(c.key));
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = "﻿" + [cols.map((c) => esc(c.label)).join(","), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(","))].join("\r\n");
    if (typeof URL.createObjectURL === "function" && link.current) {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      link.current.href = url;
      link.current.download = filename;
      link.current.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    onExported?.({ columns: picked, reason: reason.trim(), count: rows.length });
    toast(t("export.done", { count: rows.length }));
    onOpenChange(false);
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={t("export.rows", { count: rows.length })}>
      <div className="dialog-body">
        <div className="field">
          <span className="field-label">{t("export.format")}</span>
          <div className="row">
            <span className="pill inf">{t("export.csv")}</span>
            <span className="pill">{t("export.xlsx")}</span>
          </div>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("export.columns")}</legend>
          {columns.map((c) => (
            <label key={c.key} className="check">
              <input type="checkbox" checked={picked.includes(c.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.key] : picked.filter((k) => k !== c.key))} />
              <span>
                {c.label}
                {c.pii && <span className="muted"> · {t("export.pii")}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        {needsReason && <Textarea label={t("dialog.reason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={t("dialog.reasonRequired", { min: 5 })} />}
        <p className="muted small">{t("export.logged")}</p>
        <a ref={link} hidden aria-hidden="true" />
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>{t("dialog.cancel")}</Button>
          <Button variant="primary" disabled={!ok} onClick={download}>
            {t("export.download")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
