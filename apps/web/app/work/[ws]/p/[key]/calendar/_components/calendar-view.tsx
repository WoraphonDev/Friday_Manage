"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, buttonVariants, Dialog, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import { SubscribeDialog } from "./subscribe-dialog";
import styles from "./cal.module.css";

type Cat = "todo" | "in_progress" | "done";
type Due = "done" | "overdue" | "today" | "upcoming";
export interface CalIssue {
  key: string; type: string; title: string; status: { name: string; category: Cat }; priority: string;
  planStart: string | null; planEnd: string | null; due: Due; parentKey: string | null; assignees: Person[]; version?: number;
}
export interface CalLeave { person: Person | null; leaveType: string; startDate: string; endDate: string; halfDay: "am" | "pm" | null; status: "pending" | "approved" }
export interface CalendarData {
  project: { key: string; name: string };
  today: string;
  month: string;
  range: { from: string; to: string };
  issues: CalIssue[];
  sprints: { id: string; number: number; name: string; startDate: string; endDate: string; status: string }[];
  milestones: { id: string; name: string; date: string }[];
  holidays: { date: string; name: string; scope: "workspace" | "project" }[];
  leaves: CalLeave[];
}

export type View = "month" | "week" | "day" | "agenda";
type Show = Record<"tasks" | "milestones" | "sprints" | "holidays" | "leaves" | "done", boolean>;
type Pending = { key: string; body: { planStart?: string; planEnd: string }; version?: number; reason?: string };
type Item =
  | { kind: "ms"; id: string; name: string }
  | { kind: "leave"; id: string; leave: CalLeave }
  | { kind: "task"; id: string; issue: CalIssue };

const DAY = 86_400_000;
const MAX_ITEMS = 3;
const REASONS = ["scope_added", "waiting_input", "blocked_by_dependency", "estimate_wrong", "other"] as const;

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** จันทร์ของสัปดาห์ (ปฏิทินเริ่มวันจันทร์ ตรงกับ range ของ API) */
export const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
export function shiftMonth(month: string, n: number) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
/** วันในช่องปฏิทินเดือน: สัปดาห์เต็ม (จันทร์–อาทิตย์) ที่คาบเกี่ยวเดือน */
export function monthDays(month: string) {
  const next = `${shiftMonth(month, 1)}-01`;
  const from = mondayOf(`${month}-01`);
  const to = addDays(mondayOf(addDays(next, -1)), 6);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const monthLabel = (month: string, year: YearFormat) =>
  new Intl.DateTimeFormat(`th-TH-u-ca-${year === "BE" ? "buddhist" : "gregory"}`, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
const dayMonth = (iso: string, year: YearFormat) => formatDate(iso, year).split(" ").slice(0, 2).join(" ");

export function CalendarView({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("calendar");
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const [view, setView] = useState<View>("month");
  // null = ยังไม่เลื่อน ใช้เดือน / วันนี้ตามที่ API ตอบ (เวลาไทย)
  const [anchor, setAnchor] = useState<string | null>(null);
  const [show, setShow] = useState<Show>({ tasks: true, milestones: true, sprints: true, holidays: true, leaves: true, done: false });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [needReason, setNeedReason] = useState<Pending | null>(null);
  const [needRequest, setNeedRequest] = useState<Pending | null>(null);
  const [subscribe, setSubscribe] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const dragged = useRef<string | null>(null);

  const month = anchor ? anchor.slice(0, 7) : null;
  const queryKey = ["calendar", ws, projectKey, month ?? "current"];
  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const q = useQuery({ queryKey, queryFn: () => api.get<CalendarData>(`${base}/calendar${month ? `?month=${month}` : ""}`) });
  // Canvas: การ์ด Unscheduled ทางขวา · ใช้รายการงานที่ไม่มีวันจาก API Timeline (calendar ส่งเฉพาะงานที่มีวัน)
  const unscheduled = useQuery({ queryKey: ["timeline", ws, projectKey], queryFn: () => api.get<{ unscheduled: { key: string; title: string; parentKey: string | null }[] }>(`${base}/timeline`), enabled: !!perms.data && !perms.data.guestViewer });
  const canEdit = !!perms.data?.permissions.includes("issue.edit") && !perms.data.guestViewer;
  const canCreate = !!perms.data?.permissions.includes("issue.create") && !perms.data.guestViewer;

  async function commit(p: Pending) {
    const path = `/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(p.key)}`;
    try {
      const version = p.version ?? (await api.get<{ version: number }>(path)).version;
      await api.patch(path, p.reason ? { ...p.body, planChangeReason: p.reason } : p.body, version);
      toast({ message: t("saved", { key: p.key, date: formatDate(p.body.planEnd, year) }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "plan_change_reason_required") setNeedReason(p);
      else if (e instanceof ApiError && e.code === "due_change_requires_approval") setNeedRequest(p);
      else toast({ message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof Error ? e.message : String(e) });
    }
    await cache.invalidateQueries({ queryKey: ["calendar", ws, projectKey] });
  }
  /** เปลี่ยน Due · ถ้า Due ใหม่มาก่อน Plan Start ให้เลื่อน Start ตามเพื่อไม่ให้ API ตอบ invalid_dates */
  function moveDue(issue: CalIssue, day: string) {
    if (!issue.planEnd || day === issue.planEnd) return;
    const body = issue.planStart && day < issue.planStart ? { planStart: day, planEnd: day } : { planEnd: day };
    void commit({ key: issue.key, body, version: issue.version });
  }

  if (q.isPending || perms.isPending) return <div className={styles.page}><LoadingState /></div>;
  const err = q.error ?? perms.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => q.refetch()} />}</div>;
  const d = q.data!;
  const at = anchor ?? d.today;
  const shownMonth = month ?? d.month;
  const days = view === "month" || view === "agenda" ? monthDays(shownMonth) : view === "day" ? [at] : Array.from({ length: 7 }, (_, i) => addDays(mondayOf(at), i));
  const weeks = view === "day" ? [days] : Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));

  // จัดของลงวัน: Milestone ก่อน ตามด้วยงาน (วัน Due) แล้ววันลา
  const items = new Map<string, Item[]>();
  const push = (day: string, it: Item) => items.set(day, [...(items.get(day) ?? []), it]);
  if (show.milestones) for (const m of d.milestones) push(m.date, { kind: "ms", id: m.id, name: m.name });
  if (show.tasks) for (const i of d.issues) if (i.planEnd && (show.done || i.due !== "done")) push(i.planEnd, { kind: "task", id: i.key, issue: i });
  if (show.leaves)
    d.leaves.forEach((l, li) => {
      for (let day = l.startDate; day <= l.endDate && day <= days[days.length - 1]; day = addDays(day, 1)) if (day >= days[0]) push(day, { kind: "leave", id: `leave-${li}`, leave: l });
    });
  const tags = new Map<string, { text: string; hol: boolean }[]>();
  const tag = (day: string, text: string, hol = false) => tags.set(day, [...(tags.get(day) ?? []), { text, hol }]);
  if (show.holidays) for (const h of d.holidays) tag(h.date, h.name, true);
  if (show.sprints)
    for (const sp of d.sprints) {
      tag(sp.startDate, t("sprintStart", { name: sp.name }));
      tag(sp.endDate, t("sprintEnd", { name: sp.name }));
    }
  const hasTasks = d.issues.some((i) => i.planEnd && days.includes(i.planEnd));

  const issueHref = (key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/calendar?issue=${encodeURIComponent(key)}`;
  const go = (dir: -1 | 1) => setAnchor(view === "month" || view === "agenda" ? `${shiftMonth(shownMonth, dir)}-01` : addDays(at, dir * (view === "day" ? 1 : 7)));
  const title = view === "month" || view === "agenda" ? monthLabel(shownMonth, year) : view === "day" ? formatDate(at, year, true) : `${formatDate(days[0], year)} – ${formatDate(days[6], year)}`;
  const toggle = (k: keyof Show) => setShow((s) => ({ ...s, [k]: !s[k] }));
  const dow = t.raw("dow") as string[];
  const dowShort = t.raw("dowShort") as string[];

  function onDrop(e: DragEvent, day: string) {
    e.preventDefault();
    setDropDay(null);
    const key = dragged.current ?? e.dataTransfer?.getData("text/plain");
    dragged.current = null;
    const issue = d.issues.find((i) => i.key === key);
    if (issue && canEdit) moveDue(issue, day);
    // งาน Unscheduled ที่ลากมาวาง = เริ่มและครบกำหนดวันนั้น
    else if (key && canEdit && unscheduled.data?.unscheduled.some((u) => u.key === key)) void commit({ key, body: { planStart: day, planEnd: day } });
  }

  const renderItem = (it: Item) => {
    if (it.kind === "ms")
      return (
        <span key={it.id} className={`${styles.ev} ${styles.ms}`} title={it.name}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ flex: "none" }}><rect x="1.5" y="1.5" width="7" height="7" transform="rotate(45 5 5)" fill="var(--contrast-ink)" /></svg>
          <span className={styles.t}>{it.name}</span>
        </span>
      );
    if (it.kind === "leave") {
      const l = it.leave;
      const text = [t("leave", { name: l.person?.displayName ?? t("someone"), type: l.leaveType }), l.halfDay ? t(`halfDay.${l.halfDay}`) : "", l.status === "pending" ? t("pending") : ""].filter(Boolean).join(" · ");
      return <span key={it.id} className={`${styles.ev} ${styles.leave}`} title={text}><span className={styles.t}>{text}</span></span>;
    }
    const i = it.issue;
    const cls = i.due === "overdue" ? styles.late : i.due === "today" ? styles.dueToday : i.due === "done" ? styles.done : i.status.category === "in_progress" ? styles.prog : styles.todo;
    const state = t(`state.${i.due}`);
    const label = `${t("task", { key: i.key, title: i.title, date: formatDate(i.planEnd, year) })}${state ? ` · ${state}` : ""}`;
    const onKey = (e: KeyboardEvent) => {
      if (!canEdit || !e.altKey || !i.planEnd) return;
      const n = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : e.key === "ArrowDown" ? 7 : 0;
      if (!n) return;
      e.preventDefault();
      moveDue(i, addDays(i.planEnd, n));
    };
    return (
      <Link
        key={it.id}
        href={issueHref(i.key)}
        className={`${styles.ev} ${cls} ${canEdit ? styles.editable : ""}`}
        aria-label={label}
        title={canEdit ? `${label}\n${t("dragHint")}` : label}
        draggable={canEdit}
        data-testid={`task-${i.key}`}
        onDragStart={(e) => { if (!canEdit) return e.preventDefault(); dragged.current = i.key; e.dataTransfer?.setData("text/plain", i.key); }}
        onDragEnd={() => { dragged.current = null; setDropDay(null); }}
        onKeyDown={onKey}
      >
        <span className={styles.evDot} aria-hidden="true" />
        <span className={styles.t}>{i.key} {i.title}</span>
      </Link>
    );
  };

  return (
    <div className={styles.page}>
      {/* Canvas: แถวแรก = เลื่อน + ชื่อเดือน · แถวสอง = มุมมอง, ตัวกรอง, + Task */}
      <div className={styles.bar} style={{ justifyContent: "flex-start" }}>
        <Button size="icon" aria-label={t(`prev.${view === "day" ? "week" : view === "agenda" ? "month" : view}`)} onClick={() => go(-1)}><ChevronLeft size={16} /></Button>
        <Button onClick={() => setAnchor(view === "month" || view === "agenda" ? null : d.today)}>{t("today")}</Button>
        <Button size="icon" aria-label={t(`next.${view === "day" ? "week" : view === "agenda" ? "month" : view}`)} onClick={() => go(1)}><ChevronRight size={16} /></Button>
        <h2 className={styles.title}>{title}</h2>
      </div>
      <div className={styles.bar} style={{ justifyContent: "flex-start" }}>
        <div className={styles.seg} role="group" aria-label={t("view.label")}>
          {(["month", "week", "day", "agenda"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{t(`view.${v}`)}</button>
          ))}
        </div>
        <Button aria-expanded={filtersOpen} onClick={() => setFiltersOpen((x) => !x)}>{t("filter")}</Button>
        {canCreate && <Link className={buttonVariants({ variant: "primary" })} href={`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/calendar?new=1&type=task`}>{t("newTask")}</Link>}
      </div>

      <div className={styles.layout}>
        <section className={styles.card} aria-label={title}>
          {!hasTasks && <p className={styles.empty} role="status"><b>{t("empty")}</b> <span className="muted">{t("emptyHint")}</span></p>}
          {view === "agenda" ? (
            <div className={styles.agenda}>
              {days.filter((day) => day.startsWith(shownMonth) && ((items.get(day) ?? []).length || (tags.get(day) ?? []).length)).map((day) => (
                <div key={day} className={`${styles.agendaDay} ${day === d.today ? styles.agendaToday : ""}`} data-testid={`day-${day}`}>
                  <div className={styles.agendaDate}><b>{Number(day.slice(8))}</b><span>{dow[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]}</span></div>
                  <div className={styles.agendaItems}>
                    {(tags.get(day) ?? []).map((x) => <span key={x.text} className={`${styles.tag} ${x.hol ? styles.tagHol : ""}`}>{x.text}</span>)}
                    {(items.get(day) ?? []).map(renderItem)}
                  </div>
                </div>
              ))}
            </div>
          ) : <>
          <div className={styles.dow} style={view === "day" ? { gridTemplateColumns: "1fr" } : undefined}>
            {(view === "day" ? [dow[(new Date(`${at}T00:00:00Z`).getUTCDay() + 6) % 7]] : dow).map((name, i) => <div key={name}><span className={styles.long}>{name}</span><span className={styles.short} aria-hidden="true">{dowShort[i]}</span></div>)}
          </div>
          {weeks.map((week) => (
            <div key={week[0]} className={styles.week} style={view === "day" ? { gridTemplateColumns: "1fr" } : undefined}>
              {week.map((day, c) => {
                const out = view === "month" && !day.startsWith(shownMonth);
                const isToday = day === d.today;
                const dayTags = tags.get(day) ?? [];
                const hol = dayTags.some((x) => x.hol);
                const list = items.get(day) ?? [];
                const open = view === "week" || view === "day" || expanded.has(day);
                const visible = open ? list : list.slice(0, MAX_ITEMS);
                const cls = [styles.cell, isToday ? styles.today : hol ? styles.hol : out ? styles.out : c >= 5 ? styles.wkend : "", dropDay === day ? styles.drop : "", view === "week" || view === "day" ? styles.tall : ""].join(" ");
                const n = Number(day.slice(8));
                return (
                  <div
                    key={day}
                    className={cls}
                    data-testid={`day-${day}`}
                    aria-label={`${formatDate(day, year, true)}${dayTags.length ? ` · ${dayTags.map((x) => x.text).join(" · ")}` : ""}`}
                    aria-current={isToday ? "date" : undefined}
                    onDragOver={(e) => { if (canEdit && dragged.current) { e.preventDefault(); setDropDay(day); } }}
                    onDragLeave={() => setDropDay((x) => (x === day ? null : x))}
                    onDrop={(e) => onDrop(e, day)}
                  >
                    <div className={styles.head}>
                      <span className={`${styles.num} ${isToday ? styles.numToday : out ? styles.numOut : ""}`}>{n === 1 || view === "week" ? dayMonth(day, year) : n}</span>
                      {dayTags.length > 0 && <span className={`${styles.tag} ${hol ? styles.tagHol : ""}`} title={dayTags.map((x) => x.text).join(" · ")}>{dayTags.map((x) => x.text).join(" · ")}</span>}
                    </div>
                    {visible.map(renderItem)}
                    {view === "month" && list.length > MAX_ITEMS && (
                      <button type="button" className={styles.more} aria-expanded={open} onClick={() => setExpanded((s) => { const x = new Set(s); if (x.has(day)) x.delete(day); else x.add(day); return x; })}>
                        {open ? t("less") : t("more", { count: list.length - MAX_ITEMS })}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          </>}
        </section>

        <aside className={styles.aside}>
          {!!unscheduled.data?.unscheduled.length && (
            <section className={styles.panel} aria-label={t("unscheduled")}>
              <h2>{t("unscheduled")}</h2>
              <p className="muted" style={{ fontSize: 11, margin: "-6px 0 8px" }}>{t("unscheduledHint")}</p>
              <div className={styles.unsched}>
                {unscheduled.data.unscheduled.slice(0, 5).map((u) => (
                  <span key={u.key} className={styles.uItem} draggable={canEdit} data-testid={`unscheduled-${u.key}`} onDragStart={(e) => { dragged.current = u.key; e.dataTransfer?.setData("text/plain", u.key); }} title={u.title}>
                    <span className={styles.grip} aria-hidden="true">⋮⋮</span><span className={styles.evDot} aria-hidden="true" /><span className={styles.t}>{u.key} {u.title}</span>
                  </span>
                ))}
                {unscheduled.data.unscheduled.length > 5 && <span className="muted" style={{ fontSize: 11 }}>{t("moreUnscheduled", { count: unscheduled.data.unscheduled.length - 5 })}</span>}
              </div>
            </section>
          )}
          {filtersOpen && <section className={styles.panel}>
            <h2>{t("show.title")}</h2>
            <div className={styles.checks}>
              {(["tasks", "milestones", "sprints", "holidays", "leaves", "done"] as const).map((k) => (
                <label key={k}><input type="checkbox" checked={show[k]} onChange={() => toggle(k)} />{t(`show.${k}`)}</label>
              ))}
            </div>
          </section>}
          <section className={styles.panel}>
            <h2>{t("legend.title")}</h2>
            <div className={styles.legend}>
              {([["late", styles.late], ["today", styles.dueToday], ["progress", styles.prog], ["todo", styles.todo], ["done", styles.done], ["milestone", styles.ms], ["leave", styles.leave]] as const).map(([k, c]) => (
                <div key={k}><span className={`${styles.swatch} ${c}`} />{t(`legend.${k}`)}</div>
              ))}
            </div>
            <button type="button" className={styles.link} onClick={() => setSubscribe(true)}>{t("subscribe.open")}</button>
          </section>
        </aside>
      </div>
      {canEdit && <div className="muted" style={{ fontSize: 11 }}>{t("footer")}</div>}

      {subscribe && <SubscribeDialog ws={ws} projectKey={d.project.key} onClose={() => setSubscribe(false)} />}
      {needReason && <ReasonDialog onClose={() => setNeedReason(null)} onSave={(reason) => { const p = needReason; setNeedReason(null); void commit({ ...p, reason }); }} />}
      {needRequest && (
        <RequestDialog
          ws={ws}
          pending={needRequest}
          year={year}
          onClose={() => setNeedRequest(null)}
          onSent={async () => { const k = needRequest.key; setNeedRequest(null); toast({ message: t("requested", { key: k }) }); await cache.invalidateQueries({ queryKey: ["calendar", ws, projectKey] }); }}
        />
      )}
    </div>
  );
}

function ReasonDialog({ onClose, onSave }: { onClose: () => void; onSave: (reason: string) => void }) {
  const t = useTranslations("calendar");
  const [reason, setReason] = useState("");
  return (
    <Dialog open title={t("reasonTitle")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSave(reason.trim()); }} className={styles.form}>
        <Input label={t("reasonLabel")} required value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className={styles.actions}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary">{t("save")}</Button></div>
      </form>
    </Dialog>
  );
}

function RequestDialog({ ws, pending, year, onClose, onSent }: { ws: string; pending: Pending; year: YearFormat; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("calendar");
  const [reason, setReason] = useState<string>("scope_added");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<unknown>(null);
  const due = pending.body.planEnd;
  async function send(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(pending.key)}/due-requests`, { requestedDue: due, reasonCode: reason, detail: detail || undefined });
      onSent();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Dialog open title={t("requestTitle")} description={t("requestBody", { key: pending.key, date: formatDate(due, year) })} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={send} className={styles.form}>
        <Select label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((c) => <option key={c} value={c}>{t(`reasons.${c}`)}</option>)}</Select>
        <label className="field">{t("detail")}<textarea className="input" required={reason === "other"} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        {!!error && <ErrorState error={error} />}
        <div className={styles.actions}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary">{t("send")}</Button></div>
      </form>
    </Dialog>
  );
}
