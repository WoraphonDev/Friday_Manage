"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { Chip, Drawer, Empty, ErrorBlock, Modal, Notice, PageHead, Seg, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, errorToast, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import type { OpenSession } from "@/lib/types";
import { planLabel, useFmt } from "../workspaces/_parts/format";

interface TicketRow {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  requesterEmail: string | null;
  createdAt: string;
  firstResponseDueAt: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  workspace: { id: string; slug: string; name: string } | null;
  slaBreached: boolean;
}
interface Summary {
  open: number;
  unassigned: number;
  breached: number;
  firstResponseMinutes: number | null;
  csat: number | null;
}
interface TicketDetail {
  ticket: TicketRow & {
    cause: string | null;
    csat: number | null;
    assignee: { id: string; name: string } | null;
    requesterEmail: string | null;
  };
  messages: {
    id: string;
    authorKind: "customer" | "staff" | "system";
    body: string;
    internal: boolean;
    createdAt: string;
    authorName: string | null;
  }[];
  customer: {
    id: string;
    slug: string;
    name: string;
    plan: string | null;
    seatLimit: number | null;
    seats: number;
    tickets90d: number;
    unhappy90d: number;
    accessUntil: string | null;
    accessGranted: boolean;
    sla: { first: number };
  } | null;
}
const key = ["ops", "tickets"] as const;
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });

/** หน้า 6 · Support (Support.dc.html): คิว Ticket · รายละเอียดและข้อความ · ผลงานรายคน · การเข้าช่วยเหลือ */
export function SupportPage() {
  const t = useTranslations("ss.support");
  const params = useSearchParams();
  const router = useRouter();
  const me = useMe().data;
  const [queue, setQueue] = useState<"mine" | "none" | "all">("all");
  const [status, setStatus] = useState<"active" | "solved" | "closed">("active");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const search = useDeferredValue(q.trim());
  const filter = new URLSearchParams({
    status,
    limit: "100",
    ...(queue !== "all" ? { assignee: queue } : {}),
    ...(search ? { q: search } : {}),
    ...(params?.get("workspace") ? { workspaceId: params.get("workspace")! } : {}),
  });
  const list = useQuery({
    queryKey: [...key, filter.toString()],
    queryFn: () => api.get<{ items: TicketRow[]; summary: Summary }>(`/tickets?${filter}`),
    placeholderData: keepPreviousData,
  });
  const selected = params?.get("ticket") ?? null;
  const select = (id: string | null) => router.replace(id ? `/support?ticket=${id}` : "/support");
  const s = list.data?.summary;
  const support = hasAny(me, "support");
  return (
    <>
      <PageHead
        title={t("title")}
        desc={
          s
            ? t("summary", {
                open: s.open,
                unassigned: s.unassigned,
                breached: s.breached,
                first: s.firstResponseMinutes == null ? t("na") : t("minutes", { n: s.firstResponseMinutes }),
                csat: s.csat == null ? t("na") : `${s.csat}/5`,
              })
            : undefined
        }
        actions={
          support && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> {t("create")}
            </Button>
          )
        }
      />
      <div className="support-split">
        <section className="card" style={{ alignSelf: "start" }}>
          <Seg
            label={t("title")}
            value={queue}
            onChange={setQueue}
            options={(["all", "mine", "none"] as const).map((v) => ({
              value: v,
              label: t(`queues.${v}`),
            }))}
          />
          <div className="row">
            {(["active", "solved", "closed"] as const).map((v) => (
              <Chip key={v} pressed={status === v} onClick={() => setStatus(v)}>
                {t(`statusFilter.${v}`)}
              </Chip>
            ))}
          </div>
          <Input aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
          {list.isPending ? (
            <TableSkeleton rows={5} cols={1} />
          ) : list.error ? (
            <ErrorBlock error={list.error} retry={() => void list.refetch()} />
          ) : !list.data.items.length ? (
            <Empty ok={queue === "none"} title={queue === "none" ? t("emptyQueue") : t("empty")} />
          ) : (
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }} aria-label={t("title")}>
              {list.data.items.map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    className="menu-item"
                    aria-current={selected === k.id ? "true" : undefined}
                    style={{
                      alignItems: "flex-start",
                      border: "1px solid var(--border)",
                      background: selected === k.id ? "var(--primary-soft)" : undefined,
                    }}
                    onClick={() => select(k.id)}
                  >
                    <span
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        minWidth: 0,
                      }}
                    >
                      <span className="row">
                        <b className="mono">#{k.number}</b>
                        {k.priority === "urgent" || k.priority === "high" ? <span className="pill bad">{t(`priority.${k.priority}`)}</span> : null}
                        {k.slaBreached && <span className="pill warn">{t("breached")}</span>}
                      </span>
                      <span>{k.subject}</span>
                      <span className="muted small">
                        {k.workspace?.name ?? k.requesterEmail} · {t(`status.${k.status}` as "status.open")} · {k.assigneeName ?? t("unassigned")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div>
          {selected ? (
            <TicketView id={selected} />
          ) : (
            <section className="card">
              <Empty title={t("pick")} />
            </section>
          )}
        </div>
      </div>
      <Stats />
      <Sessions />
      {creating && <CreateTicket onClose={() => setCreating(false)} onCreated={(id) => select(id)} />}
    </>
  );
}

function TicketView({ id }: { id: string }) {
  const t = useTranslations("ss");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const support = hasAny(me, "support");
  const q = useQuery({
    queryKey: [...key, "detail", id],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}`),
  });
  const [mode, setMode] = useState<"reply" | "internal" | "customer">("reply");
  const [body, setBody] = useState("");
  const [modal, setModal] = useState<"assign" | "escalate" | "solve" | null>(null);
  const act = useMutation({
    mutationFn: (action: "claim" | "release") => api.post(`/tickets/${id}/${action}`),
    onSuccess: (_r, a) => (toast(a === "claim" ? t("support.claimed") : t("support.released")), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  const send = useMutation({
    mutationFn: () =>
      api.post<{ reopened?: boolean }>(`/tickets/${id}/messages`, {
        body: body.trim(),
        internal: mode === "internal",
        fromCustomer: mode === "customer",
      }),
    onSuccess: (r) => (setBody(""), toast(r.reopened ? t("support.reopened") : t("support.sent")), invalidate(cache)),
  });
  if (q.isPending)
    return (
      <section className="card">
        <TableSkeleton rows={4} cols={1} />
      </section>
    );
  if (q.error)
    return (
      <section className="card">
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      </section>
    );
  const { ticket: k, messages, customer } = q.data;
  const closed = k.status === "closed";
  const mine = k.assignee?.id === me?.id;
  return (
    <div className="ticket-grid">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            #{k.number} · {k.subject}
          </h2>
        </div>
        <div className="row small">
          <span className="pill">{t(`support.status.${k.status}` as "support.status.open")}</span>
          <span className={k.priority === "urgent" || k.priority === "high" ? "pill bad" : "pill"}>{t(`support.priority.${k.priority}` as "support.priority.normal")}</span>
          <span className="pill">{t(`support.channel.${k.channel}` as "support.channel.email")}</span>
          {k.slaBreached ? (
            <span className="pill warn">{t("support.breached")}</span>
          ) : (
            k.firstResponseDueAt && (
              <span className="muted">
                {t("support.dueIn", {
                  time: fmt.dateTime(k.firstResponseDueAt),
                })}
              </span>
            )
          )}
          <span className="muted">
            {t("support.assignee")}: {k.assignee?.name ?? t("support.unassigned")}
          </span>
        </div>
        {support && !closed && (
          <div className="row">
            {!k.assignee && (
              <Button variant="primary" disabled={act.isPending} onClick={() => act.mutate("claim")}>
                {t("support.claim")}
              </Button>
            )}
            {(mine || hasAny(me, "owner") || !k.assignee) && <Button onClick={() => setModal("assign")}>{t("support.assign")}</Button>}
            {k.status !== "pending_dev" && k.status !== "solved" && <Button onClick={() => setModal("escalate")}>{t("support.escalate")}</Button>}
            {mine && (
              <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate("release")}>
                {t("support.release")}
              </Button>
            )}
            {k.status !== "solved" && <Button onClick={() => setModal("solve")}>{t("support.solve")}</Button>}
          </div>
        )}
        <ol className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="messages">
          {messages.map((m) => (
            <li key={m.id} className={m.internal ? "notice notice-warn" : m.authorKind === "customer" ? "notice" : m.authorKind === "system" ? "notice notice-info" : "notice notice-ok"}>
              <div className="notice-body">
                <span className="small">
                  <b>{m.authorKind === "system" ? t("support.system") : (m.authorName ?? k.requesterEmail)}</b> <span className="muted">· {fmt.dateTime(m.createdAt)}</span> {m.internal && <span className="pill warn">{t("support.internalTag")}</span>}
                </span>
                <span style={{ whiteSpace: "pre-wrap" }}>{m.body}</span>
              </div>
            </li>
          ))}
        </ol>
        {support && !closed && (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), body.trim() && send.mutate())}>
            <Seg label={t("support.reply")} value={mode} onChange={setMode} options={(["reply", "internal", "customer"] as const).map((v) => ({ value: v, label: t(`support.modes.${v}`) }))} />
            <Textarea
              aria-label={mode === "reply" ? t("support.reply") : mode === "internal" ? t("support.internal") : t("support.fromCustomer")}
              placeholder={mode === "reply" ? t("support.reply") : mode === "internal" ? t("support.internal") : t("support.fromCustomer")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <InlineError error={send.error} />
            <div>
              <Button type="submit" variant="primary" disabled={!body.trim() || send.isPending}>
                {t("support.send")}
              </Button>
            </div>
          </form>
        )}
      </section>
      <aside className="card" aria-label={t("support.customer")}>
        <h3 className="card-title">{customer?.name ?? t("support.customer")}</h3>
        {customer ? (
          <table className="tbl">
            <tbody>
              <tr>
                <td className="muted">{t("support.plan")}</td>
                <td>
                  {planLabel(customer.plan)} ·{" "}
                  {t("support.seats", {
                    seats: customer.seats,
                    limit: customer.seatLimit ?? "∞",
                  })}
                </td>
              </tr>
              <tr>
                <td className="muted">{t("support.sla")}</td>
                <td>{t("support.slaValue", { first: customer.sla.first })}</td>
              </tr>
              <tr>
                <td className="muted">{t("support.tickets90")}</td>
                <td>
                  {t("support.tickets90Value", {
                    n: customer.tickets90d,
                    bad: customer.unhappy90d,
                  })}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="muted small">{t("support.noWs")}</p>
        )}
        {customer &&
          (customer.accessGranted ? (
            <Notice tone="info">
              {t("support.access", {
                until: customer.accessUntil ? fmt.date(customer.accessUntil) : t("support.accessForever"),
              })}
            </Notice>
          ) : (
            <Notice tone="warn">{t("support.noAccess")}</Notice>
          ))}
        {customer && (
          <Link className={buttonClass("ghost", "small")} href={`/workspaces/${customer.id}`}>
            {t("support.openCustomer")}
          </Link>
        )}
      </aside>
      {modal === "assign" && <AssignDialog id={id} onClose={() => setModal(null)} />}
      {modal === "escalate" && <EscalateDialog id={id} number={k.number} onClose={() => setModal(null)} />}
      {modal === "solve" && <SolveDialog id={id} number={k.number} onClose={() => setModal(null)} />}
    </div>
  );
}

/** T2 · โอนให้พนักงาน Support คนอื่น */
function AssignDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("ss.t2");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  // รายชื่อพนักงานอ่านได้เฉพาะ Owner / ผู้ตรวจ · Support คนอื่นใส่รหัสพนักงานไม่ได้ จึงเลือกจากผลงาน 30 วัน (คนที่เคยรับ Ticket)
  const staff = useQuery({
    queryKey: ["ops", "staff"],
    queryFn: () =>
      api.get<{
        items: { id: string; name: string; roles: string[]; status: string }[];
      }>("/staff"),
    enabled: hasAny(me, "owner", "auditor"),
    retry: false,
  });
  const stats = useQuery({
    queryKey: [...key, "stats"],
    queryFn: () => api.get<{ items: { id: string; name: string }[] }>("/tickets/stats"),
  });
  const people = staff.data ? staff.data.items.filter((s) => s.roles.includes("support") && s.status === "active") : (stats.data?.items ?? []);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${id}/assign`, {
        staffId: to,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), to && m.mutate())}>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("staff")}</legend>
          {people.map((p) => (
            <label key={p.id} className="check">
              <input type="radio" name="t2" checked={to === p.id} onChange={() => setTo(p.id)} />
              <span>{p.name}</span>
            </label>
          ))}
        </fieldset>
        <Textarea label={t("note")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!to || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** T3 · ส่งต่อระดับ 2 (ทีมพัฒนา) */
function EscalateDialog({ id, number, onClose }: { id: string; number: number; onClose: () => void }) {
  const t = useTranslations("ss.t3");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [severity, setSeverity] = useState<"S1" | "S2" | "S3" | "S4">("S2");
  const [affected, setAffected] = useState("");
  const [steps, setSteps] = useState("");
  const [requestId, setRequestId] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${id}/escalate`, {
        severity,
        steps: steps.trim(),
        ...(affected.trim() ? { affected: affected.trim() } : {}),
        ...(requestId.trim() ? { requestId: requestId.trim() } : {}),
      }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { n: number })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), steps.trim().length >= 10 && m.mutate())}>
        <div className="field">
          <label htmlFor="t3-sev">{t("severity")}</label>
          <select id="t3-sev" className="input" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
            {(["S1", "S2", "S3", "S4"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`sev.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <Input label={t("affected")} value={affected} onChange={(e) => setAffected(e.target.value)} />
        <Textarea label={t("steps")} value={steps} onChange={(e) => setSteps(e.target.value)} hint={tc("reasonRequired", { min: 10 })} />
        <Input label={t("requestId")} className="mono" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
        <p className="muted small">{t("notify")}</p>
        <Notice tone="warn">{t("pii")}</Notice>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={steps.trim().length < 10 || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** T5 · ปิดเรื่องพร้อมสาเหตุจริง */
function SolveDialog({ id, number, onClose }: { id: string; number: number; onClose: () => void }) {
  const t = useTranslations("ss.t5");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [outcome, setOutcome] = useState("");
  const [cause, setCause] = useState("");
  const [csat, setCsat] = useState(true);
  const m = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${id}/solve`, {
        outcome: outcome.trim(),
        cause: cause.trim(),
        sendCsat: csat,
      }),
    onSuccess: () => (toast(t("done")), invalidate(cache), onClose()),
  });
  const ok = outcome.trim().length >= 3 && cause.trim().length >= 3;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { n: number })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Textarea label={t("outcome")} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        <Input label={t("cause")} value={cause} onChange={(e) => setCause(e.target.value)} hint={t("causeHint")} />
        <label className="check">
          <input type="checkbox" checked={csat} onChange={(e) => setCsat(e.target.checked)} />
          <span>{t("csat")}</span>
        </label>
        <p className="muted small">{t("reopen")}</p>
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

/** T1 · สร้าง Ticket สำหรับเรื่องที่มาทางโทรศัพท์ / LINE / อีเมล */
function CreateTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("ss.t1");
  const ts = useTranslations("ss.support");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [wsQ, setWsQ] = useState("");
  const [ws, setWs] = useState<{ id: string; name: string } | null>(null);
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<"phone" | "line" | "email">("phone");
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [assignMe, setAssignMe] = useState(false);
  const [notify, setNotify] = useState(true);
  const search = useDeferredValue(wsQ.trim());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "pick-ticket", search],
    queryFn: () => api.get<{ items: { id: string; name: string; slug: string }[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`),
    enabled: !ws && search.length >= 2,
  });
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && subject.trim().length >= 3 && body.trim().length > 0;
  const m = useMutation({
    mutationFn: () =>
      api.post<{ ticket: { id: string; number: number } }>("/tickets", {
        ...(ws ? { workspaceId: ws.id } : {}),
        requesterEmail: email.trim(),
        channel,
        priority,
        subject: subject.trim(),
        body: body.trim(),
        assignToMe: assignMe,
        notify,
        ...(category.trim() ? { category: category.trim() } : {}),
      }),
    onSuccess: (r) => (toast(t("done", { n: r.ticket.number })), invalidate(cache), onClose(), onCreated(r.ticket.id)),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
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
        <Input label={t("requester")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="field">
          <span className="field-label">{t("channel")}</span>
          <Seg
            label={t("channel")}
            value={channel}
            onChange={setChannel}
            options={(["phone", "line", "email"] as const).map((c) => ({
              value: c,
              label: ts(`channel.${c}`),
            }))}
          />
        </div>
        <div className="field">
          <span className="field-label">{t("priority")}</span>
          <Seg label={t("priority")} value={priority} onChange={setPriority} options={(["low", "normal", "high", "urgent"] as const).map((p) => ({ value: p, label: ts(`priority.${p}`) }))} />
        </div>
        <Input label={t("category")} value={category} onChange={(e) => setCategory(e.target.value)} />
        <Input label={t("subject")} value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Textarea label={t("body")} value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={assignMe} onChange={(e) => setAssignMe(e.target.checked)} />
          <span>{t("assignMe")}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>{t("notify")}</span>
        </label>
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

function Stats() {
  const t = useTranslations("ss.support");
  const q = useQuery({
    queryKey: [...key, "stats"],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          name: string;
          solved: number;
          firstResponseMinutes: number | null;
          resolutionHours: number | null;
          withinSlaPct: number | null;
          csat: number | null;
        }[];
      }>("/tickets/stats"),
  });
  return (
    <section className="card">
      <h2 className="card-title">{t("stats")}</h2>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["staff", "solved", "first", "resolve", "sla", "csat"] as const).map((c) => (
                  <th key={c}>{t(`statsCol.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="num">{s.solved}</td>
                  <td className="num">{s.firstResponseMinutes == null ? "—" : t("minutes", { n: s.firstResponseMinutes })}</td>
                  <td className="num">{s.resolutionHours == null ? "—" : t("hours", { n: s.resolutionHours })}</td>
                  <td className="num">{s.withinSlaPct == null ? "—" : `${s.withinSlaPct}%`}</td>
                  <td className="num">{s.csat ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Sessions() {
  const t = useTranslations("ss.support");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({
    queryKey: ["ops", "support-sessions"],
    queryFn: () => api.get<{ items: OpenSession[] }>("/support-sessions"),
  });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/support-sessions/${id}/end`),
    onSuccess: () => (toast(t("ended")), invalidate(cache)),
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <section className="card" id="sessions">
      <div className="card-head">
        <h2 className="card-title">{t("sessions")}</h2>
        {q.data && <span className="card-sub">{t("sessionsOpen", { n: q.data.items.length })}</span>}
      </div>
      {q.isPending ? (
        <TableSkeleton rows={1} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <p className="muted small">{t("noSessions")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["ws", "ticket", "staff", "time", "mode"] as const).map((c) => (
                  <th key={c}>{t(`sessionCol.${c}`)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.workspace.name}</td>
                  <td>{s.ticketNo}</td>
                  <td>{s.staffName}</td>
                  <td>{fmt.ago(s.startedAt)}</td>
                  <td>
                    <span className="pill inf">{s.mode === "write" ? t("write") : t("read")}</span>
                  </td>
                  <td>
                    <Button size="small" disabled={end.isPending} onClick={() => end.mutate(s.id)}>
                      {t("end")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
