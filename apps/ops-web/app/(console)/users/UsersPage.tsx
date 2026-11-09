"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { ConfirmDialog, useReauth } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, Modal, Notice, PageHead, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, LoadingState, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";

type Status = "active" | "locked" | "unverified" | "disabled";
interface UserRow {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  yearFormat: string;
  timezone: string;
  status: Status;
  login: string[];
  mfaEnabled: boolean;
  lineBound: boolean;
  workspaces: number;
  firstWorkspace: string | null;
  lastSeenAt: string | null;
}
interface UserDetail {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: string | null;
  locale: string;
  yearFormat: string;
  timezone: string;
  createdAt: string;
  status: Status;
  login: string[];
  mfaEnabled: boolean;
  line: { displayName: string } | null;
  memberships: { id: string; slug: string; name: string; role: string; status: string }[];
  sessions: { id: string; deviceName: string | null; userAgent: string | null; ip: string | null; lastSeenAt: string }[];
  tickets: { id: string; number: number; subject: string; status: string }[];
}
const TONE: Record<Status, string> = { active: "pill ok", locked: "pill warn", unverified: "pill", disabled: "pill bad" };
const PROOFS = ["email_reply", "workspace_owner", "video_call"] as const;

/** หน้า 2b · ผู้ใช้ทั้งหมด (Users.dc.html) · ค้นได้เฉพาะ Owner / Support · ทำรายการเป็นงานของ Support */
export function UsersPage() {
  const t = useTranslations("customers.users");
  const fmt = useFmt();
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [offset, setOffset] = useState(0);
  const search = useDeferredValue(q.trim());
  const filter = new URLSearchParams({ limit: "50", offset: String(offset), ...(search ? { q: search } : {}), ...(status ? { status } : {}) });
  const list = useQuery({ queryKey: ["ops", "users", filter.toString()], queryFn: () => api.get<{ items: UserRow[]; total: number }>(`/users?${filter}`), placeholderData: keepPreviousData });
  const open = params?.get("id") ?? null;
  const setOpen = (id: string | null) => router.replace(id ? `/users?id=${id}` : "/users");
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} />
      <section className="card">
        <div className="row">
          <div style={{ flex: "1 1 260px" }}>
            <Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} />
          </div>
          <select className="input" style={{ width: "auto" }} aria-label={t("col.status")} value={status} onChange={(e) => (setStatus(e.target.value as Status | ""), setOffset(0))}>
            <option value="">{t("statusAll")}</option>
            {(["active", "locked", "unverified", "disabled"] as Status[]).map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <p className="muted small">{t("hint")}</p>
        {list.isPending ? (
          <TableSkeleton rows={6} cols={7} />
        ) : list.error ? (
          <ErrorBlock error={list.error} retry={() => void list.refetch()} />
        ) : !rows.length ? (
          <Empty title={t("empty")} onClearFilters={search || status ? () => (setQ(""), setStatus("")) : undefined} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {(["user", "ws", "login", "mfa", "line", "lang", "last", "status"] as const).map((c) => (
                      <th key={c}>{t(`col.${c}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} style={{ cursor: "pointer" }} onClick={() => setOpen(u.id)}>
                      <td>
                        <button type="button" className="link-button" onClick={(e) => (e.stopPropagation(), setOpen(u.id))}>
                          {u.email}
                        </button>
                        <div className="cell-sub">{u.displayName}</div>
                      </td>
                      <td className="small">{u.firstWorkspace ? (u.workspaces > 1 ? t("wsCount", { first: u.firstWorkspace, more: u.workspaces - 1 }) : u.firstWorkspace) : <span className="muted">{t("noWs")}</span>}</td>
                      <td className="small">{u.login.join(", ") || "—"}</td>
                      <td>{u.mfaEnabled ? "✓" : "—"}</td>
                      <td>{u.lineBound ? "✓" : "—"}</td>
                      <td className="small">{u.locale}</td>
                      <td className="small">{fmt.ago(u.lastSeenAt)}</td>
                      <td>
                        <span className={TONE[u.status]}>{t(`status.${u.status}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <span className="muted small">{`${offset + 1}–${offset + rows.length} / ${total}`}</span>
              <span className="spacer" />
              <Button size="small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                ‹
              </Button>
              <Button size="small" disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>
                ›
              </Button>
            </div>
          </>
        )}
      </section>
      {open && <UserDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

type Action = "unlock" | "resend" | "signOut" | "reset2fa" | "changeEmail" | "close" | null;

function UserDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("customers.users");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const support = hasAny(me, "support");
  const [action, setAction] = useState<Action>(null);
  const q = useQuery({ queryKey: ["ops", "user", id], queryFn: () => api.get<UserDetail>(`/users/${id}`) });
  const done = (message: string) => {
    setAction(null);
    toast(message);
    void cache.invalidateQueries({ queryKey: ["ops"] });
  };
  const u = q.data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} wide title={u?.email ?? "…"} description={u ? u.displayName : undefined}>
      {q.isPending ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        u && (
          <div className="stack">
            <span className={TONE[u.status]}>{t(`status.${u.status}`)}</span>
            <table className="tbl">
              <tbody>
                <tr>
                  <td className="muted">{t("verified")}</td>
                  <td>{u.emailVerifiedAt ? fmt.date(u.emailVerifiedAt) : "—"}</td>
                </tr>
                <tr>
                  <td className="muted">{t("line")}</td>
                  <td>{u.line?.displayName ?? "—"}</td>
                </tr>
                <tr>
                  <td className="muted">{t("locale")}</td>
                  <td>
                    {u.locale} · {u.yearFormat} · {u.timezone}
                  </td>
                </tr>
                <tr>
                  <td className="muted">{t("since")}</td>
                  <td>{fmt.date(u.createdAt)}</td>
                </tr>
                <tr>
                  <td className="muted">{t("memberships")}</td>
                  <td>
                    {u.memberships.map((m) => (
                      <div key={m.id}>
                        <Link href={`/workspaces/${m.id}`}>{m.name}</Link> · {m.role} {m.status !== "active" && <span className="pill">{m.status}</span>}
                      </div>
                    ))}
                  </td>
                </tr>
                <tr>
                  <td className="muted">{t("devices")}</td>
                  <td className="small">{u.sessions.length ? u.sessions.map((s) => <div key={s.id}>{`${s.deviceName ?? s.userAgent ?? "—"} · ${fmt.ago(s.lastSeenAt)}`}</div>) : t("noDevices")}</td>
                </tr>
                <tr>
                  <td className="muted">{t("tickets")}</td>
                  <td className="small">{u.tickets.length ? u.tickets.map((k) => <div key={k.id}>{`#${k.number} · ${k.subject}`}</div>) : t("noTickets")}</td>
                </tr>
              </tbody>
            </table>
            {support && (
              <>
                <Notice tone="info">{t("proofNote")}</Notice>
                <div className="row">
                  {u.status === "locked" && <Button onClick={() => setAction("unlock")}>{t("unlock")}</Button>}
                  {!u.emailVerifiedAt && u.status !== "disabled" && <Button onClick={() => setAction("resend")}>{t("resend")}</Button>}
                  {u.mfaEnabled && <Button onClick={() => setAction("reset2fa")}>{t("reset2fa")}</Button>}
                  <Button onClick={() => setAction("signOut")}>{t("signOut")}</Button>
                  {u.status !== "disabled" && <Button onClick={() => setAction("changeEmail")}>{t("changeEmail")}</Button>}
                  {u.status !== "disabled" && (
                    <Button variant="danger" onClick={() => setAction("close")}>
                      {t("close")}
                    </Button>
                  )}
                </div>
              </>
            )}
            {(action === "unlock" || action === "resend" || action === "signOut") && (
              <ConfirmDialog
                open
                ticket
                onOpenChange={() => setAction(null)}
                title={t(action === "unlock" ? "unlockTitle" : action === "resend" ? "resendTitle" : "signOutTitle", { email: u.email })}
                description={action === "signOut" ? t("signOutDesc") : undefined}
                onConfirm={async ({ reason, ticketNo }) => {
                  await api.post(`/users/${u.id}/${action === "unlock" ? "unlock" : action === "resend" ? "resend-verification" : "sign-out-all"}`, { reason, ticketNo });
                  done(t("done"));
                }}
              />
            )}
            {(action === "reset2fa" || action === "changeEmail" || action === "close") && <AccountDialog kind={action} user={u} onClose={() => setAction(null)} onDone={done} />}
          </div>
        )
      )}
    </Drawer>
  );
}

/** C10 รีเซ็ต 2FA · C11 เปลี่ยนอีเมล · C12 ปิดบัญชี (ทุกข้อแตะกุญแจซ้ำ) */
function AccountDialog({ kind, user, onClose, onDone }: { kind: "reset2fa" | "changeEmail" | "close"; user: UserDetail; onClose: () => void; onDone: (m: string) => void }) {
  const t = useTranslations("customers.users");
  const tc = useTranslations("common.dialog");
  const { run } = useReauth();
  const [proofs, setProofs] = useState<string[]>([]);
  const [ticketNo, setTicketNo] = useState("");
  const [reason, setReason] = useState("");
  const [email, setEmail] = useState("");
  const active = user.memberships.filter((m) => m.status === "active");
  const m = useMutation({
    mutationFn: () => {
      const base = { ticketNo: ticketNo.trim(), reason: reason.trim() };
      if (kind === "reset2fa") return run(() => api.post(`/users/${user.id}/reset-2fa`, { ...base, proofs }), t("reset2fa"));
      if (kind === "changeEmail") return run(() => api.post(`/users/${user.id}/change-email`, { ...base, proofs, newEmail: email.trim() }), t("changeEmail"));
      return run(() => api.post(`/users/${user.id}/close`, { ...base, confirmEmail: email.trim() }), t("close"));
    },
    onSuccess: () => onDone(kind === "changeEmail" ? t("c11Done", { email: email.trim() }) : t("done")),
  });
  const needsProofs = kind !== "close";
  const ok = (!needsProofs || new Set(proofs).size >= 2) && ticketNo.trim().length >= 3 && reason.trim().length >= 3 && (kind === "reset2fa" || email.trim().length > 3);
  const title = kind === "reset2fa" ? t("c10Title", { email: user.email }) : kind === "changeEmail" ? t("c11Title", { email: user.email }) : t("c12Title", { email: user.email });
  const desc = kind === "reset2fa" ? t("c10Desc") : kind === "changeEmail" ? t("c11Desc") : t("c12Desc", { n: active.length });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} description={desc}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {kind === "close" && (
          <table className="tbl" aria-label={t("c12Impact")}>
            <tbody>
              {active.map((w) => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>{w.role}</td>
                  <td className="small">{w.role === "owner" ? t("soleOwner") : t("remove")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {kind === "changeEmail" && <Input label={t("newEmail")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        {needsProofs && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("proofs")}</legend>
            {PROOFS.map((p) => (
              <label key={p} className="check">
                <input type="checkbox" checked={proofs.includes(p)} onChange={(e) => setProofs(e.target.checked ? [...proofs, p] : proofs.filter((x) => x !== p))} />
                <span>{t(`proof.${p}`)}</span>
              </label>
            ))}
          </fieldset>
        )}
        <Input label={tc("ticket")} placeholder="#515" value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} />
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        {kind === "close" && <Input label={t("confirmEmail")} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
        <p className="muted small">{kind === "reset2fa" ? t("c10Note") : kind === "changeEmail" ? t("c11Note") : t("c12Note")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant={kind === "close" ? "danger" : "primary"} disabled={!ok || m.isPending}>
            {kind === "reset2fa" ? t("reset2fa") : kind === "changeEmail" ? t("c11Submit") : t("c12Submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
