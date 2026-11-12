"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { AvatarStack, Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import styles from "./tl.module.css";
import { MilestoneDialog } from "./milestone-dialog";
import { statusDotColor, type StatusCategory } from "@/lib/status";

type Cat = StatusCategory;
export interface TLRow {
  key: string; type: string; title: string; status: { name: string; category: Cat };
  start: string; end: string; progressPct: number; lateDays: number;
  assignees?: Person[]; canOpen?: boolean; subtasks: TLRow[];
}
interface Summary { start: string | null; end: string | null; progressPct: number; lateDays: number; taskCount: number }
export interface TimelineData {
  project: { key: string; name: string; startDate: string; goliveDate: string };
  today: string;
  range: { from: string; to: string };
  lastEnd: string | null;
  sprints: { id: string; number: number; name: string; startDate: string; endDate: string; status: string }[];
  milestones: { id: string; name: string; date: string; moduleId: string | null }[];
  modules: (Summary & { id: string | null; name: string; color: string | null; groups: (Summary & { phase: { id: string } | null; name: string; tasks: TLRow[] })[] })[];
  unscheduled: { key: string; type: string; title: string; moduleId: string | null; parentKey: string | null }[];
}

export type Zoom = "day" | "week" | "month";
/** Canvas Timeline: Week = 1 คอลัมน์ต่อสัปดาห์ (≈28 px) · Month / Quarter ย่อลงตามลำดับ */
// เท่ากับสเกลของ Gantt เพื่อให้สองหน้าดูเหมือนกัน
export const PX_PER_DAY: Record<Zoom, number> = { day: 21, week: 8, month: 3 };
const DAY = 86_400_000;
const LABEL_W = 290;
// สีตามหมวด (Review ที่ยังอยู่หมวด In progress แยกด้วยชื่อ) · ชุดเดียวกับป้ายสถานะใน Table
const statusColor = (s: { name: string; category: Cat }) => statusDotColor(s.category, s.name);
// สีข้อมูลต้องเป็น hex เพราะนำไปต่อค่าความโปร่งใส (`${color}33`)
const PALETTE = ["#5b3fc4", "#0f766e", "#b45309", "#1d4ed8", "#be185d", "#0369a1", "#4d7c0f", "#c2410c"];

export const toDay = (iso: string, from: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const nextMonth = (iso: string) => {
  const dt = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  dt.setUTCMonth(dt.getUTCMonth() + 1);
  return dt.toISOString().slice(0, 10);
};
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

type Line =
  | { kind: "module"; id: string; name: string; color: string; s: Summary; count: number }
  | { kind: "group"; id: string; name: string; color: string; s: Summary }
  | { kind: "task"; row: TLRow; color: string; sub: boolean; hasKids: boolean };

type Drag = { key: string; mode: "move" | "start" | "end"; x0: number; start: string; end: string; delta: number };
type Pending = { key: string; body: { planStart?: string; planEnd?: string }; reason?: string };

export function TimelineView({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("timeline");
  const locale = useLocale();
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [zoom, setZoom] = useState<Zoom>("day");
  const [colorBy, setColorBy] = useState<"module" | "status" | "assignee">("module");
  const [level, setLevel] = useState<"module" | "task" | "subtask">("subtask");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [needReason, setNeedReason] = useState<Pending | null>(null);
  const [needRequest, setNeedRequest] = useState<Pending | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ความกว้างที่มองเห็น: แกนเวลายาวอย่างน้อยเต็มจอ ไม่เหลือพื้นที่ว่างด้านขวา
  const [viewW, setViewW] = useState(0);
  const dragged = useRef<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const q = useQuery({ queryKey: ["timeline", ws, projectKey], queryFn: () => api.get<TimelineData>(`${base}/timeline`) });
  const canEdit = !!perms.data?.permissions.includes("issue.edit") && !perms.data.guestViewer;
  const canCreate = !!perms.data?.permissions.includes("issue.create") && !perms.data.guestViewer;
  const canSettings = !!perms.data?.permissions.includes("project.settings");
  const guest = !!perms.data?.guestViewer;
  const px = PX_PER_DAY[zoom];

  // วันเริ่มของแกน = ต้นสัปดาห์ (จันทร์) ก่อนช่วงข้อมูล · เผื่อท้าย 14 วัน
  const axis = useMemo(() => {
    if (!q.data) return null;
    // แกนเวลาเต็มเดือน: เริ่มวันที่ 1 ของเดือนแรก จบวันสุดท้ายของเดือนสุดท้าย (และยาวอย่างน้อยเต็มจอ)
    const from = `${q.data.range.from.slice(0, 7)}-01`;
    const t = new Date(`${q.data.range.to.slice(0, 7)}-01T00:00:00Z`);
    t.setUTCMonth(t.getUTCMonth() + 1);
    const days = Math.max(28, toDay(t.toISOString().slice(0, 10), from), Math.ceil((viewW - LABEL_W) / PX_PER_DAY[zoom]));
    return { from, days };
  }, [q.data, viewW, zoom]);
  const hasData = !!q.data;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setViewW(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);

  const lines = useMemo<Line[]>(() => {
    if (!q.data) return [];
    const out: Line[] = [];
    const personColor = (r: TLRow) => {
      const id = r.assignees?.[0]?.id;
      if (!id) return "var(--chart-neutral)";
      return PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
    };
    q.data.modules.forEach((m, mi) => {
      const mid = `m:${m.id ?? "none"}`;
      const mcolor = m.color ?? PALETTE[mi % PALETTE.length];
      out.push({ kind: "module", id: mid, name: m.name, color: mcolor, s: m, count: m.taskCount });
      if (closed.has(mid)) return;
      // Module › (Task ที่ไม่มีกลุ่ม) › กลุ่ม › Task › Sub-task · กลุ่มไม่บังคับ (ผู้ใช้ขอ 2026-11-08)
      const colorOf = (r: TLRow) => (colorBy === "module" ? mcolor : colorBy === "status" ? statusColor(r.status) : personColor(r));
      const tasks = (rows: TLRow[]) => { for (const r of rows) {
        out.push({ kind: "task", row: r, color: colorOf(r), sub: false, hasKids: r.subtasks.length > 0 });
        if (!closed.has(`t:${r.key}`)) for (const s of r.subtasks) out.push({ kind: "task", row: s, color: colorOf(s), sub: true, hasKids: false });
      } };
      for (const g of m.groups.filter((x) => !x.phase)) tasks(g.tasks);
      m.groups.filter((x) => x.phase).forEach((g) => {
        const gid = `${mid}:g:${g.phase!.id}`;
        out.push({ kind: "group", id: gid, name: g.name, color: mcolor, s: g });
        if (!closed.has(gid)) tasks(g.tasks);
      });
    });
    return out;
  }, [q.data, closed, colorBy]);

  // ลาก bar: ใช้ mousemove/mouseup ของ window เพื่อให้ลากออกนอก bar ได้
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => setDrag((d) => (d ? { ...d, delta: Math.round((e.clientX - d.x0) / px) } : d));
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (d && d.delta !== 0) {
        const body = d.mode === "move" ? { planStart: addDays(d.start, d.delta), planEnd: addDays(d.end, d.delta) } : d.mode === "start" ? { planStart: minDate(addDays(d.start, d.delta), d.end) } : { planEnd: maxDate(addDays(d.end, d.delta), d.start) };
        void commit({ key: d.key, body });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.key, drag?.mode, px]);

  async function commit(p: Pending) {
    try {
      // timeline ไม่ส่ง version จึงอ่านงานล่าสุดก่อนแก้ (If-Match)
      const issue = await api.get<{ version: number }>(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(p.key)}`);
      await api.patch(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(p.key)}`, p.reason ? { ...p.body, planChangeReason: p.reason } : p.body, issue.version);
      toast({ message: t("saved", { key: p.key, start: formatDate(p.body.planStart ?? null, year), end: formatDate(p.body.planEnd ?? null, year) }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "plan_change_reason_required") setNeedReason(p);
      else if (e instanceof ApiError && e.code === "due_change_requires_approval" && p.body.planEnd) setNeedRequest(p);
      else toast({ message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof Error ? e.message : String(e) });
    }
    await cache.invalidateQueries({ queryKey: ["timeline", ws, projectKey] });
  }

  if (q.isPending || perms.isPending) return <div className={styles.page}><LoadingState /></div>;
  const err = q.error ?? perms.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => q.refetch()} />}</div>;
  const d = q.data!;
  const ax = axis!;
  const width = ax.days * px;
  const x = (iso: string) => toDay(iso, ax.from) * px;
  const toggle = (id: string) => setClosed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const scrollToToday = () => scrollRef.current?.scrollTo?.({ left: Math.max(0, x(d.today) - 200), behavior: "smooth" });
  const scrollBy = (dir: number) => scrollRef.current?.scrollBy?.({ left: dir * (scrollRef.current.clientWidth - LABEL_W) * 0.8, behavior: "smooth" });

  // หัวแกนแบบเดียวกับ Gantt: แถวบน = ช่วงสัปดาห์ (Day / Week) หรือเดือน (Month) · แถวล่าง = ทุกวันพร้อมตัวย่อวัน (Day)
  const short = (iso: string) => formatDate(iso, year).split(" ").slice(0, 2).join(" ");
  const weekdayName = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "th-TH", { weekday: "narrow", timeZone: "UTC" });
  const units: { left: number; width: number; label: string; title: string }[] = [];
  for (let i = 0; i < ax.days; i++) {
    const day = addDays(ax.from, i);
    const isStart = i === 0 || (zoom === "month" ? day.endsWith("-01") : weekday(day) === 1);
    if (!isStart) continue;
    const len = zoom === "month" ? toDay(nextMonth(day), day) : 7 - ((weekday(day) + 6) % 7);
    const unitEnd = Math.min(ax.days, i + len);
    const last = addDays(ax.from, unitEnd - 1);
    const w = (unitEnd - i) * px;
    const range = `${short(day)} – ${short(last)}`;
    // ช่องแคบ (สัปดาห์ในมุมมอง Week) แสดงแค่วันเริ่ม · ช่วงเต็มอยู่ใน title
    const label = zoom === "month" ? formatDate(day, year).split(" ").slice(1).join(" ") : w >= 100 ? range : short(day);
    units.push({ left: i * px, width: w, label, title: zoom === "month" ? label : range });
  }
  const dayCells = zoom === "day" ? Array.from({ length: ax.days }, (_, i) => addDays(ax.from, i)) : [];
  // ป้าย Milestone ที่อยู่ใกล้กันตัดด้วย … ไม่ให้ทับป้ายถัดไป (ชื่อเต็มอยู่ใน title)
  const msSorted = [...d.milestones].sort((a, b) => a.date.localeCompare(b.date));
  const msRoom = (id: string) => {
    const i = msSorted.findIndex((m) => m.id === id);
    const next = msSorted[i + 1];
    return next ? Math.max(24, x(next.date) - x(msSorted[i]!.date) - 8) : undefined;
  };
  const weekends = zoom === "month" ? [] : Array.from({ length: ax.days }, (_, i) => i).filter((i) => [0, 6].includes(weekday(addDays(ax.from, i))));
  const issueHref = (key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/timeline?issue=${encodeURIComponent(key)}`;
  const newHref = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/timeline?new=1&type=task`;
  const tasksOf = (moduleLineId: string) => d.modules.find((m) => `m:${m.id ?? "none"}` === moduleLineId)?.groups.reduce((n, g) => n + g.tasks.length, 0) ?? 0;
  // ระดับที่แสดง: Module = ย่อทุก Module · Task = เปิด Module ย่อ Sub-task · Sub-task = เปิดทั้งหมด
  const showLevel = (lv: "module" | "task" | "subtask") => {
    setLevel(lv);
    if (lv === "subtask") return setClosed(new Set());
    if (lv === "module") return setClosed(new Set(d.modules.map((m) => `m:${m.id ?? "none"}`)));
    setClosed(new Set(d.modules.flatMap((m) => m.groups.flatMap((g) => g.tasks.filter((r) => r.subtasks.length).map((r) => `t:${r.key}`)))));
  };
  const empty = !d.modules.some((m) => m.groups.length);

  const laneBg = (
    <>
      {weekends.map((i) => <span key={i} className={styles.weekend} style={{ left: i * px, width: px }} />)}
      {units.map((u) => <span key={u.left} className={styles.tick} style={{ left: u.left }} />)}
      <span className={styles.todayLine} style={{ left: x(d.today) }} />
    </>
  );

  function onDropRow(e: DragEvent, rowId: string) {
    e.preventDefault();
    setDropRow(null);
    const key = dragged.current ?? e.dataTransfer?.getData("text/plain");
    dragged.current = null;
    if (!key || !canEdit) return;
    const lane = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const day = addDays(ax.from, Math.max(0, Math.floor((e.clientX - lane.left) / px)));
    void rowId;
    void commit({ key, body: { planStart: day, planEnd: day } });
  }

  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <div className={styles.seg} role="group" aria-label={t("zoom.label")}>
          {(["day", "week", "month"] as const).map((z) => <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>{t(`zoom.${z}`)}</button>)}
        </div>
        <Button size="icon" variant="ghost" aria-label={t("prev")} onClick={() => scrollBy(-1)}><ChevronLeft size={16} /></Button>
        <Button size="small" onClick={scrollToToday}>{t("today")}</Button>
        <Button size="icon" variant="ghost" aria-label={t("next")} onClick={() => scrollBy(1)}><ChevronRight size={16} /></Button>
        <span className="muted" style={{ fontSize: 12 }}>{formatDate(d.range.from, year)} – {formatDate(d.range.to, year)}</span>
      </div>
      <div className={styles.bar}>
        <div className={styles.seg} role="group" aria-label={t("levelLabel")}>
          {(["module", "task", "subtask"] as const).map((lv) => <button key={lv} type="button" aria-pressed={level === lv} onClick={() => showLevel(lv)}>{t(`levels.${lv}`)}</button>)}
        </div>
        <Select aria-label={t("colorBy")} size="small" prefix={t("colorBy")} value={colorBy} onChange={(e) => setColorBy(e.target.value as typeof colorBy)}>
          {(["module", "status", "assignee"] as const).filter((c) => !(guest && c === "assignee")).map((c) => <option key={c} value={c}>{t(`colors.${c}`)}</option>)}
        </Select>
        {canSettings && <Button size="small" onClick={() => setMilestoneOpen(true)}>{t("addMilestone")}</Button>}
      </div>

      <section className={styles.card}>
        {empty ? <EmptyState title={t("empty")} description={t("emptyHint")} /> : (
          <div className={styles.scroll} ref={scrollRef} data-testid="timeline-scroll">
            <div className={styles.grid} style={{ width: LABEL_W + width }}>
              <div className={`${styles.row} ${styles.headRow}`}>
                <div className={styles.lab}>{t("rowsLabel")}</div>
                <div className={styles.lane} style={{ width }} data-testid="axis">
                  <div className={styles.axisUnits}>{units.map((u) => <span key={u.left} className={styles.unit} style={{ left: u.left, width: u.width }} title={u.title}>{u.label}</span>)}</div>
                  {zoom === "day" && (
                    <div className={styles.axisDays}>
                      {dayCells.map((day, i) => (
                        <span key={day} className={`${styles.dy} ${[0, 6].includes(weekday(day)) ? styles.we : ""} ${day === d.today ? styles.now : ""}`} style={{ left: i * px, width: px }}>
                          {weekdayName.format(new Date(`${day}T00:00:00Z`))}<b>{Number(day.slice(8))}</b>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.row} aria-label={t("milestones")}>
                <div className={`${styles.lab} ${styles.mod}`}><svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="2.5" width="9" height="9" transform="rotate(45 7 7)" fill="var(--chart-strong)" /></svg>{t("milestones")}</div>
                <div className={styles.lane} style={{ width }}>
                  {laneBg}
                  {d.milestones.map((ms) => (
                    <span key={ms.id} className={styles.ms} style={{ left: x(ms.date), maxWidth: msRoom(ms.id) }} title={`${ms.name} · ${formatDate(ms.date, year)}`}>
                      <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="2.5" width="9" height="9" transform="rotate(45 7 7)" fill="var(--chart-strong)" /></svg><span className={styles.msName}>{ms.name}</span>
                    </span>
                  ))}
                </div>
              </div>
              {lines.map((ln) => {
                if (ln.kind !== "task") {
                  const s = ln.s;
                  return (
                    <div key={ln.id} className={styles.row}>
                      <div className={`${styles.lab} ${ln.kind === "module" ? styles.mod : styles.grp}`}>
                        <button type="button" className={styles.toggle} aria-expanded={!closed.has(ln.id)} aria-label={t(closed.has(ln.id) ? "expand" : "collapse", { name: ln.name })} onClick={() => toggle(ln.id)}><ChevronDown size={14} style={{ transform: closed.has(ln.id) ? "rotate(-90deg)" : undefined }} /></button>
                        <span style={{ width: ln.kind === "module" ? 12 : 16, height: ln.kind === "module" ? 12 : 16, borderRadius: ln.kind === "module" ? 3 : 4, background: ln.kind === "module" ? ln.color : `${ln.color}26`, border: ln.kind === "module" ? 0 : `1px solid ${ln.color}66`, flex: "none" }} aria-hidden="true" />
                        <span className={styles.labText}>{ln.name}</span>
                        <span className={styles.cnt}>{ln.kind === "module" ? t("tasks", { count: tasksOf(ln.id) }) : ln.s.taskCount}</span>
                        {canCreate && <Link className={styles.add} href={newHref} aria-label={t("addIn", { name: ln.name })}><Plus size={14} aria-hidden="true" /></Link>}
                      </div>
                      <div className={`${styles.lane} ${dropRow === ln.id ? styles.drop : ""}`} style={{ width }} onDragOver={(e) => { if (canEdit && dragged.current) { e.preventDefault(); setDropRow(ln.id); } }} onDragLeave={() => setDropRow(null)} onDrop={(e) => onDropRow(e, ln.id)} data-testid={`lane-${ln.id}`}>
                        {laneBg}
                        {s.start && s.end && <>
                          <span className={`${styles.b} ${styles.summary}`} style={{ left: x(s.start), width: Math.max(px, (toDay(s.end, s.start) + 1) * px), background: ln.kind === "module" ? "var(--subtle)" : `${ln.color}33` }}><span className={styles.fill} style={{ width: `${s.progressPct}%`, background: ln.color }} /></span>
                          <span className={styles.barLabel} style={{ left: x(s.end) + px + 6 }}>{s.progressPct}% · {formatDate(s.start, year)} – {formatDate(s.end, year)}</span>
                        </>}
                      </div>
                    </div>
                  );
                }
                const r = ln.row;
                // ป้ายท้ายแถบ: คน · สถานะ · % · ช่วงวัน (ผู้ใช้ขอ 2026-11-08) · ขณะลากใช้วันที่ใหม่
                const live = drag?.key === r.key ? drag : null;
                const start = live ? (live.mode === "end" ? r.start : addDays(r.start, live.delta)) : r.start;
                const end = live ? (live.mode === "start" ? r.end : addDays(r.end, live.delta)) : r.end;
                const open = r.canOpen !== false;
                const names = guest ? "" : (r.assignees ?? []).map((a) => a.displayName).join(", ");
                const onKey = (e: KeyboardEvent) => {
                  if (!canEdit || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                  e.preventDefault();
                  const n = e.key === "ArrowLeft" ? -1 : 1;
                  void commit({ key: r.key, body: e.shiftKey ? { planEnd: maxDate(addDays(r.end, n), r.start) } : { planStart: addDays(r.start, n), planEnd: addDays(r.end, n) } });
                };
                const startDrag = (mode: Drag["mode"]) => (e: ReactMouseEvent) => {
                  if (!canEdit || e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDrag({ key: r.key, mode, x0: e.clientX, start: r.start, end: r.end, delta: 0 });
                };
                return (
                  <div key={`${r.key}${ln.sub ? ":s" : ""}`} className={styles.row}>
                    <div className={`${styles.lab} ${ln.sub ? styles.sub : styles.task}`}>
                      {ln.hasKids && <button type="button" className={styles.toggle} aria-expanded={!closed.has(`t:${r.key}`)} aria-label={t(closed.has(`t:${r.key}`) ? "expand" : "collapse", { name: r.key })} onClick={() => toggle(`t:${r.key}`)}><ChevronDown size={14} style={{ transform: closed.has(`t:${r.key}`) ? "rotate(-90deg)" : undefined }} /></button>}
                      {!ln.hasKids && <span className={styles.dotStatus} style={{ borderColor: statusColor(r.status), background: r.status.category === "done" || r.status.category === "cancelled" ? statusColor(r.status) : "transparent" }} aria-hidden="true" />}
                      <span className="muted" style={{ fontSize: 11, flex: "none", whiteSpace: "nowrap" }}>{r.key}</span>
                      {open ? <Link className={styles.labText} href={issueHref(r.key)} style={{ color: "var(--foreground)" }}>{r.title}</Link> : <span className={styles.labText}>{r.title}</span>}
                      {!guest && !!r.assignees?.length && <span className={styles.who}><AvatarStack people={r.assignees} max={1} /></span>}
                    </div>
                    <div className={`${styles.lane} ${dropRow === r.key ? styles.drop : ""}`} style={{ width }} onDragOver={(e) => { if (canEdit && dragged.current) { e.preventDefault(); setDropRow(r.key); } }} onDragLeave={() => setDropRow(null)} onDrop={(e) => onDropRow(e, r.key)}>
                      {laneBg}
                      <span
                        role="button"
                        tabIndex={0}
                        data-testid={`bar-${r.key}`}
                        className={`${styles.b} ${canEdit ? styles.editable : ""} ${live ? styles.dragging : ""} ${r.lateDays ? styles.late : ""}`}
                        style={{ left: x(start), width: Math.max(px, (toDay(end, start) + 1) * px), background: ln.color, opacity: ln.sub ? 0.8 : 1 }}
                        aria-label={`${t("bar", { key: r.key, title: r.title, start: formatDate(start, year), end: formatDate(end, year) })}${r.lateDays ? ` · ${t("late", { days: r.lateDays })}` : ""}${names ? ` · ${names}` : ""}`}
                        title={canEdit ? t("barHint") : undefined}
                        onMouseDown={startDrag("move")}
                        onKeyDown={onKey}
                      >
                        <span className={styles.prog} style={{ width: `${r.progressPct}%` }} />
                        {canEdit && <span className={`${styles.handle} ${styles.start}`} aria-label={t("resizeStart", { key: r.key })} data-testid={`start-${r.key}`} onMouseDown={startDrag("start")} />}
                        {canEdit && <span className={`${styles.handle} ${styles.end}`} aria-label={t("resizeEnd", { key: r.key })} data-testid={`end-${r.key}`} onMouseDown={startDrag("end")} />}
                      </span>
                      {/* Canvas: ชื่อผู้รับผิดชอบ · % หรือ "เลย N วัน" อยู่ขวาของแท่ง */}
                      <span className={`${styles.barLabel} ${r.lateDays ? styles.barLate : ""}`} style={{ left: x(end) + px + 6 }} aria-hidden="true">{[names || r.key, r.status.name, r.lateDays ? t("late", { days: r.lateDays }) : `${r.progressPct}%`, start === end ? formatDate(end, year) : `${formatDate(start, year)} – ${formatDate(end, year)}`].join(" · ")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {d.unscheduled.length > 0 && (
          <div className={styles.unsched} aria-label={t("unscheduled")}>
            {/* Canvas: หัวข้อ + คำแนะนำอยู่แถวบน แยกจากรายการ เพื่อไม่ให้ไหลปนกับ chip */}
            <div className={styles.unschedHead}>
              <h2 className={styles.unschedTitle}>{t("unscheduled")} <span className="muted">{t("unscheduledCount", { count: d.unscheduled.length })}</span></h2>
              {canEdit && <span className="muted" style={{ fontSize: 12 }}>{t("unscheduledHint")}</span>}
            </div>
            <div className={styles.unschedList}>
              {d.unscheduled.map((u) => (
                <span key={u.key} className={`${styles.chip} ${canEdit ? "" : styles.chipStatic}`} title={`${u.key} ${u.title}`} draggable={canEdit} data-testid={`unscheduled-${u.key}`} onDragStart={(e) => { dragged.current = u.key; e.dataTransfer?.setData("text/plain", u.key); }}>
                  {canEdit && (
                    <svg className={styles.grip} width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
                      <circle cx="2" cy="2" r="1.3" /><circle cx="6" cy="2" r="1.3" /><circle cx="2" cy="7" r="1.3" /><circle cx="6" cy="7" r="1.3" /><circle cx="2" cy="12" r="1.3" /><circle cx="6" cy="12" r="1.3" />
                    </svg>
                  )}
                  <span className={styles.dot} style={{ background: "var(--chart-primary)", opacity: u.parentKey ? 0.6 : 1 }} aria-hidden="true" />
                  <span className={styles.chipKey}>{u.key}</span>
                  <span className={styles.chipTitle}>{u.title}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className={styles.foot}>
          <span>{t("todayLine", { date: formatDate(d.today, year) })}</span>
          {d.lastEnd && <span>{t("lastEnd", { date: formatDate(d.lastEnd, year) })}</span>}
          <span className={styles.legend}><i style={{ background: "var(--chart-strong)", height: 12 }} />{t("legend.module")}</span>
          <span className={styles.legend}><i style={{ background: "var(--chart-primary)" }} />{t("legend.task")}</span>
          <span className={styles.legend}><i style={{ background: "var(--chart-primary)", opacity: 0.8 }} />{t("legend.subtask")}</span>
          <span className={styles.legend}><i style={{ outline: "2px solid var(--danger)" }} />{t("legend.late")}</span>
          {canEdit && <span>{t("footer")}</span>}
        </div>
      </section>

      {needReason && <ReasonDialog onClose={() => setNeedReason(null)} onSave={(reason) => { const p = needReason; setNeedReason(null); void commit({ ...p, reason }); }} />}
      {milestoneOpen && <MilestoneDialog base={base} initialDate={d.today} modules={d.modules.filter((module): module is typeof module & { id: string } => !!module.id)} onClose={() => setMilestoneOpen(false)} onCreated={async () => {
        await Promise.all([cache.invalidateQueries({ queryKey: ["timeline", ws, projectKey] }), cache.invalidateQueries({ queryKey: ["overview", ws, projectKey] }), cache.invalidateQueries({ queryKey: ["workspace", ws, "project", projectKey, "settings", "milestones"] })]);
        toast({ message: t("milestoneForm.created") });
      }} />}
      {needRequest && <RequestDialog ws={ws} pending={needRequest} year={year} onClose={() => setNeedRequest(null)} onSent={async () => { const k = needRequest.key; setNeedRequest(null); toast({ message: t("requested", { key: k }) }); await cache.invalidateQueries({ queryKey: ["timeline", ws, projectKey] }); }} />}
    </div>
  );
}

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

function ReasonDialog({ onClose, onSave }: { onClose: () => void; onSave: (reason: string) => void }) {
  const t = useTranslations("timeline");
  const [reason, setReason] = useState("");
  return (
    <Dialog open title={t("reasonTitle")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSave(reason.trim()); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("reasonLabel")} required value={reason} onChange={(e) => setReason(e.target.value)} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary">{t("save")}</Button></div>
      </form>
    </Dialog>
  );
}

function RequestDialog({ ws, pending, year, onClose, onSent }: { ws: string; pending: Pending; year: YearFormat; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("timeline");
  const [reason, setReason] = useState("scope_added");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<unknown>(null);
  const due = pending.body.planEnd!;
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
      <form onSubmit={send} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Select label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)}>{["scope_added", "waiting_input", "blocked_by_dependency", "estimate_wrong", "other"].map((c) => <option key={c} value={c}>{t(`reasons.${c}`)}</option>)}</Select>
        <label className="field">{t("detail")}<textarea className="input" required={reason === "other"} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        {!!error && <ErrorState error={error} />}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary">{t("send")}</Button></div>
      </form>
    </Dialog>
  );
}
