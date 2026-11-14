"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, Search } from "lucide-react";
import { AvatarStack, Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import styles from "./tl.module.css";
import { MilestoneDialog } from "./milestone-dialog";
import { statusDotColor, type StatusCategory, isClosedCategory } from "@/lib/status";

type Cat = StatusCategory;
export interface TLRow {
  key: string; type: string; title: string; status: { name: string; category: Cat };
  start: string; end: string; progressPct: number; lateDays: number;
  assignees?: Person[]; ba?: Person | null; sa?: Person | null; canOpen?: boolean; subtasks: TLRow[];
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
  unscheduled: { key: string; type: string; title: string; moduleId: string | null; parentKey: string | null; assignees?: Person[]; ba?: Person | null; sa?: Person | null }[];
  /** วันทำงานประจำสัปดาห์ (ISO 1 = จ. … 7 = อา.) + วันหยุดของโปรเจกต์ · ไม่มีถือว่า จ.–ศ. */
  calendar?: { workDays: number[]; holidays: string[] };
}

export type Zoom = "day" | "week" | "month";
/** Canvas Timeline: Week = 1 คอลัมน์ต่อสัปดาห์ (≈28 px) · Month / Quarter ย่อลงตามลำดับ */
// เท่ากับสเกลของ Gantt เพื่อให้สองหน้าดูเหมือนกัน
export const PX_PER_DAY: Record<Zoom, number> = { day: 21, week: 8, month: 3 };
const DAY = 86_400_000;
// ช่องชื่องานปรับกว้างได้ (ลากขอบ / ปุ่มขยาย) เพื่ออ่านชื่อ Task ยาว ๆ ได้เต็ม · จำค่าไว้ในเบราว์เซอร์นี้
export const LABEL_W = 290;
export const LABEL_MIN = 200;
export const LABEL_MAX = 720;
const LABEL_WIDE = 520;
const LABEL_KEY = "friday.timeline.labelWidth";
const clampLabel = (w: number) => Math.round(Math.min(LABEL_MAX, Math.max(LABEL_MIN, w)));
// สีตามหมวด (Review ที่ยังอยู่หมวด In progress แยกด้วยชื่อ) · ชุดเดียวกับป้ายสถานะใน Table
// แถบงานช่วงวันหยุดเหลือเส้นบางปลายมนตรงกลาง (บอกว่าช่วงนั้นไม่นับเป็นวันทำงาน)
// ช่วงวันทำงานเป็นก้อนมุมโค้ง เส้นสอดเข้าใต้มุมโค้งจึงต่อกันนุ่ม ๆ ไม่เป็นขั้น · ความสูงแถบ 12 px (ผู้ใช้เลือก 2026-11-14)
const BAR_H = 12;
const LINE_H = 2;
const BAR_R = 4;
/** mask ของแถบ (SVG): วันทำงานเต็มความสูง · วันหยุดเหลือเส้นบางสีจาง · ไม่มีวันหยุดในช่วง = undefined */
export function offDayMask(start: string, end: string, px: number, isOff: (iso: string) => boolean) {
  const days = toDay(end, start) + 1;
  const segs: { off: boolean; from: number; to: number }[] = [];
  for (let i = 0; i < days; i++) {
    const off = isOff(addDays(start, i));
    const last = segs[segs.length - 1];
    if (last && last.off === off) last.to = (i + 1) * px;
    else segs.push({ off, from: i * px, to: (i + 1) * px });
  }
  const offDays = segs.filter((g) => g.off).reduce((n, g) => n + (g.to - g.from) / px, 0);
  if (!offDays) return { offDays: 0, mask: undefined };
  const w = Math.max(px, days * px);
  // วาดเส้นก่อน แล้วก้อนวันทำงานทับ: ส่วนที่เส้นโผล่ใต้มุมโค้งคือรอยต่อ
  const lines = segs.filter((g) => g.off).map((g) => {
    const x0 = Math.max(0, g.from - BAR_R);
    const x1 = Math.min(w, g.to + BAR_R);
    return `<rect x='${x0}' y='${(BAR_H - LINE_H) / 2}' width='${x1 - x0}' height='${LINE_H}' rx='${LINE_H / 2}' fill-opacity='.6'/>`;
  });
  const blocks = segs.filter((g) => !g.off).map((g) => `<rect x='${g.from}' width='${g.to - g.from}' height='${BAR_H}' rx='${Math.min(BAR_R, (g.to - g.from) / 2)}'/>`);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${BAR_H}'>${lines.join("")}${blocks.join("")}</svg>`;
  return { offDays, mask: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` };
}
/**
 * งานเลยกำหนดที่ยังไม่เสร็จ: แดงตั้งแต่หัวแถบถึงเส้นวันนี้ หลังเส้นคงสีเดิม · แถบอยู่ก่อนวันนี้ทั้งหมด = แดงทั้งแถบ
 * (ผู้ใช้เลือกจาก mockup 2026-11-14 แทนกรอบแดง) · ใช้กับ Gantt ด้วย
 */
export function lateFillWidth(start: string, today: string, px: number, barWidth: number) {
  return Math.max(0, Math.min(barWidth, toDay(today, start) * px));
}
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
  | { kind: "group"; id: string; name: string; color: string; s: Summary; count: number }
  | { kind: "task"; row: TLRow; color: string; sub: boolean; hasKids: boolean };

type Drag = { key: string; mode: "move" | "start" | "end"; x0: number; start: string; end: string; delta: number };
/** ตัวกรอง (ผู้ใช้ขอ 2026-11-14) · ค่าว่าง = ไม่กรอง · module = id ของ Module ("none" = ไม่ระบุ Module) · คนเป็น userId */
export interface TLFilters { q: string; module: string; ba: string; sa: string; dev: string }
const NO_FILTERS: TLFilters = { q: "", module: "", ba: "", sa: "", dev: "" };
type Who = { assignees?: Person[]; ba?: Person | null; sa?: Person | null };
const hasPerson = (f: TLFilters, r: Who) => (!f.ba || r.ba?.id === f.ba) && (!f.sa || r.sa?.id === f.sa) && (!f.dev || !!r.assignees?.some((p) => p.id === f.dev));
const hasText = (q: string, r: { key: string; title: string }) => !q || r.key.toLowerCase().includes(q) || r.title.toLowerCase().includes(q);

/**
 * กรองงานใน Module ตามข้อความ / คน · Task แสดงเมื่อตัวเองหรือ Sub-task ตรง · Sub-task แสดงเฉพาะที่ตรง
 * (ค้นด้วยข้อความแล้วชื่อ Task ตรง = แสดง Sub-task ทั้งหมดของ Task นั้น)
 */
export function filterTasks(rows: TLRow[], f: TLFilters): TLRow[] {
  const q = f.q.trim().toLowerCase();
  const out: TLRow[] = [];
  for (const r of rows) {
    const selfText = hasText(q, r);
    const subs = r.subtasks.filter((x) => hasPerson(f, x) && (selfText || hasText(q, x)));
    if ((selfText && hasPerson(f, r)) || subs.length) out.push({ ...r, subtasks: subs });
  }
  return out;
}
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
  const [filters, setFilters] = useState<TLFilters>(NO_FILTERS);
  const filtering = Object.values(filters).some((v) => v.trim());
  const setFilter = (k: keyof TLFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [needReason, setNeedReason] = useState<Pending | null>(null);
  const [needRequest, setNeedRequest] = useState<Pending | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ความกว้างที่มองเห็น: แกนเวลายาวอย่างน้อยเต็มจอ ไม่เหลือพื้นที่ว่างด้านขวา
  const [viewW, setViewW] = useState(0);
  const dragged = useRef<string | null>(null);
  const [labelW, setLabelW] = useState(LABEL_W);
  const [resizing, setResizing] = useState(false);
  const labelLoaded = useRef(false);
  // อ่านค่าหลัง mount เพื่อไม่ให้ HTML จาก SSR ต่างจากฝั่ง client
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(LABEL_KEY));
      if (saved) setLabelW(clampLabel(saved));
    } catch { /* เบราว์เซอร์ปิด storage ใช้ค่าเริ่มต้น */ }
    labelLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!labelLoaded.current || resizing) return;
    try { localStorage.setItem(LABEL_KEY, String(labelW)); } catch { /* ไม่จำค่าได้ก็ใช้งานต่อได้ */ }
  }, [labelW, resizing]);
  const startResize = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = labelW;
    setResizing(true);
    const move = (ev: MouseEvent) => setLabelW(clampLabel(w0 + ev.clientX - x0));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setResizing(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const resizeKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 20;
    const next = e.key === "ArrowLeft" ? labelW - step : e.key === "ArrowRight" ? labelW + step : e.key === "Home" ? LABEL_MIN : e.key === "End" ? LABEL_MAX : null;
    if (next === null) return;
    e.preventDefault();
    setLabelW(clampLabel(next));
  };
  const wide = labelW > LABEL_W;
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
    const days = Math.max(28, toDay(t.toISOString().slice(0, 10), from), Math.ceil((viewW - labelW) / PX_PER_DAY[zoom]));
    return { from, days };
  }, [q.data, viewW, zoom, labelW]);
  const hasData = !!q.data;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setViewW(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);

  // Module / กลุ่ม / งาน หลังกรอง · Module และกลุ่มที่ไม่เหลืองานถูกซ่อนตอนกรอง
  const modules = useMemo(() => {
    if (!q.data) return [];
    if (!filtering) return q.data.modules;
    return q.data.modules
      .filter((m) => !filters.module || (m.id ?? "none") === filters.module)
      .map((m) => ({ ...m, groups: m.groups.map((g) => ({ ...g, tasks: filterTasks(g.tasks, filters) })).filter((g) => g.tasks.length) }))
      .filter((m) => m.groups.length);
  }, [q.data, filters, filtering]);

  const lines = useMemo<Line[]>(() => {
    if (!q.data) return [];
    const out: Line[] = [];
    const personColor = (r: TLRow) => {
      const id = r.assignees?.[0]?.id;
      if (!id) return "var(--chart-neutral)";
      return PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
    };
    modules.forEach((m) => {
      const mid = `m:${m.id ?? "none"}`;
      // สีคงที่ตามลำดับ Module ทั้งหมด (กรองแล้วสีไม่เปลี่ยน)
      const mcolor = m.color ?? PALETTE[Math.max(0, q.data!.modules.findIndex((x) => x.id === m.id)) % PALETTE.length];
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
        out.push({ kind: "group", id: gid, name: g.name, color: mcolor, s: g, count: filtering ? g.tasks.length : g.taskCount });
        if (!closed.has(gid)) tasks(g.tasks);
      });
    });
    return out;
  }, [q.data, modules, filtering, closed, colorBy]);

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
  const scrollBy = (dir: number) => scrollRef.current?.scrollBy?.({ left: dir * (scrollRef.current.clientWidth - labelW) * 0.8, behavior: "smooth" });

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
  // วันหยุด = ไม่ใช่วันทำงานของ Workspace หรืออยู่ในปฏิทินวันหยุด (ตรงกับ WorkCalendar ฝั่ง API)
  const workDays = new Set(d.calendar?.workDays ?? [1, 2, 3, 4, 5]);
  const holidays = new Set(d.calendar?.holidays ?? []);
  const isOff = (iso: string) => !workDays.has(weekday(iso) || 7) || holidays.has(iso);
  const weekends = zoom === "month" ? [] : Array.from({ length: ax.days }, (_, i) => i).filter((i) => isOff(addDays(ax.from, i)));
  const issueHref = (key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/timeline?issue=${encodeURIComponent(key)}`;
  const newHref = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/timeline?new=1&type=task`;
  const tasksOf = (moduleLineId: string) => modules.find((m) => `m:${m.id ?? "none"}` === moduleLineId)?.groups.reduce((n, g) => n + g.tasks.length, 0) ?? 0;
  // ตัวเลือกคนจากงานในโปรเจกต์ (เฉพาะคนที่มีงานจริง) · Guest ไม่เห็นชื่อคนจึงไม่มีตัวกรองคน
  const everyone = (pick: (r: Who) => (Person | null | undefined)[]) => {
    const map = new Map<string, Person>();
    const walk = (r: TLRow) => { pick(r).forEach((p) => p && map.set(p.id, p)); r.subtasks.forEach(walk); };
    d.modules.forEach((m) => m.groups.forEach((g) => g.tasks.forEach(walk)));
    d.unscheduled.forEach((u) => pick(u).forEach((p) => p && map.set(p.id, p)));
    return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "th"));
  };
  const baList = guest ? [] : everyone((r) => [r.ba]);
  const saList = guest ? [] : everyone((r) => [r.sa]);
  const devList = guest ? [] : everyone((r) => r.assignees ?? []);
  const fq = filters.q.trim().toLowerCase();
  const unscheduled = filtering
    ? d.unscheduled.filter((u) => (!filters.module || (u.moduleId ?? "none") === filters.module) && hasPerson(filters, u) && hasText(fq, u))
    : d.unscheduled;
  // ระดับที่แสดง: Module = ย่อทุก Module · Task = เปิด Module ย่อ Sub-task · Sub-task = เปิดทั้งหมด
  const showLevel = (lv: "module" | "task" | "subtask") => {
    setLevel(lv);
    if (lv === "subtask") return setClosed(new Set());
    if (lv === "module") return setClosed(new Set(d.modules.map((m) => `m:${m.id ?? "none"}`)));
    setClosed(new Set(d.modules.flatMap((m) => m.groups.flatMap((g) => g.tasks.filter((r) => r.subtasks.length).map((r) => `t:${r.key}`)))));
  };
  const moduleOptions = d.modules.filter((m) => m.groups.length);
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
      <div className={styles.bar} role="group" aria-label={t("filters.label")}>
        <label className={styles.search}>
          <Search size={14} aria-hidden="true" />
          <input type="search" aria-label={t("filters.search")} placeholder={t("filters.search")} value={filters.q} onChange={(e) => setFilter("q", e.target.value)} />
        </label>
        <Select aria-label={t("filters.module")} size="small" prefix={t("filters.module")} value={filters.module} onChange={(e) => setFilter("module", e.target.value)}>
          <option value="">{t("filters.all")}</option>
          {moduleOptions.map((m) => <option key={m.id ?? "none"} value={m.id ?? "none"}>{m.name}</option>)}
        </Select>
        {!guest && ([["ba", baList], ["sa", saList], ["dev", devList]] as const).map(([k, list]) => (
          <Select key={k} aria-label={t(`filters.${k}`)} size="small" prefix={t(`filters.${k}`)} value={filters[k]} onChange={(e) => setFilter(k, e.target.value)}>
            <option value="">{t("filters.anyone")}</option>
            {list.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </Select>
        ))}
        {filtering && <Button size="small" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>{t("filters.clear")}</Button>}
      </div>

      <section className={styles.card}>
        {empty ? <EmptyState title={t("empty")} description={t("emptyHint")} /> : filtering && !modules.length ? <EmptyState title={t("filters.noMatch")} description={t("filters.noMatchHint")} action={<Button size="small" onClick={() => setFilters(NO_FILTERS)}>{t("filters.clear")}</Button>} /> : (
          <div className={styles.scroll} ref={scrollRef} data-testid="timeline-scroll">
            <div className={`${styles.grid} ${resizing ? styles.resizing : ""}`} style={{ width: labelW + width, ["--lab-w" as string]: `${labelW}px` }} data-resized={labelW !== LABEL_W || undefined} data-testid="timeline-grid">
              <div className={`${styles.row} ${styles.headRow}`}>
                <div className={styles.lab}>
                  <span className={styles.labText}>{t("rowsLabel")}</span>
                  <button type="button" className={styles.widen} aria-label={t(wide ? "narrowLabels" : "widenLabels")} title={t(wide ? "narrowLabels" : "widenLabels")} onClick={() => setLabelW(wide ? LABEL_W : LABEL_WIDE)}>
                    {wide ? <ChevronsLeft size={14} aria-hidden="true" /> : <ChevronsRight size={14} aria-hidden="true" />}
                  </button>
                  <span
                    role="separator"
                    tabIndex={0}
                    aria-orientation="vertical"
                    aria-label={t("resizeLabels")}
                    aria-valuemin={LABEL_MIN}
                    aria-valuemax={LABEL_MAX}
                    aria-valuenow={labelW}
                    title={t("resizeLabelsHint")}
                    className={styles.resizer}
                    data-testid="label-resizer"
                    onMouseDown={startResize}
                    onKeyDown={resizeKey}
                    onDoubleClick={() => setLabelW(LABEL_W)}
                  />
                </div>
                <div className={styles.lane} style={{ width }} data-testid="axis">
                  <div className={styles.axisUnits}>{units.map((u) => <span key={u.left} className={styles.unit} style={{ left: u.left, width: u.width }} title={u.title}>{u.label}</span>)}</div>
                  {zoom === "day" && (
                    <div className={styles.axisDays}>
                      {dayCells.map((day, i) => (
                        <span key={day} className={`${styles.dy} ${isOff(day) ? styles.we : ""} ${day === d.today ? styles.now : ""}`} style={{ left: i * px, width: px }}>
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
                        <span className={styles.cnt}>{ln.kind === "module" ? t("tasks", { count: tasksOf(ln.id) }) : ln.count}</span>
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
                // Month (3 px/วัน) ไม่ทำเส้นบาง: จะกลายเป็นรอยขาดทุกสัปดาห์จนอ่านแถบยาก
                const thin = zoom === "month" ? { offDays: 0, mask: undefined } : offDayMask(start, end, px, isOff);
                const names = guest ? "" : (r.assignees ?? []).map((a) => a.displayName).join(", ");
                // เลยกำหนดและยังไม่เสร็จ: แดงจากหัวแถบถึงเส้นวันนี้
                const red = r.lateDays > 0 && !isClosedCategory(r.status.category) ? lateFillWidth(start, d.today, px, Math.max(px, (toDay(end, start) + 1) * px)) : 0;
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
                        className={`${styles.b} ${canEdit ? styles.editable : ""} ${live ? styles.dragging : ""} `}
                        style={{ left: x(start), width: Math.max(px, (toDay(end, start) + 1) * px), opacity: ln.sub ? 0.8 : 1 }}
                        data-off-days={thin.offDays || undefined}
                        aria-label={`${t("bar", { key: r.key, title: r.title, start: formatDate(start, year), end: formatDate(end, year) })}${r.lateDays ? ` · ${t("late", { days: r.lateDays })}` : ""}${names ? ` · ${names}` : ""}`}
                        title={canEdit ? t("barHint") : undefined}
                        onMouseDown={startDrag("move")}
                        onKeyDown={onKey}
                      >
                        <span className={styles.body} style={{ background: ln.color, maskImage: thin.mask, WebkitMaskImage: thin.mask }}>
                          <span className={styles.prog} style={{ width: `${r.progressPct}%` }} />
                          {red > 0 && <span className={styles.lateFill} data-testid={`late-${r.key}`} style={{ width: red }} />}
                        </span>
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
        {unscheduled.length > 0 && (
          <div className={styles.unsched} aria-label={t("unscheduled")}>
            {/* Canvas: หัวข้อ + คำแนะนำอยู่แถวบน แยกจากรายการ เพื่อไม่ให้ไหลปนกับ chip */}
            <div className={styles.unschedHead}>
              <h2 className={styles.unschedTitle}>{t("unscheduled")} <span className="muted">{t("unscheduledCount", { count: unscheduled.length })}</span></h2>
              {canEdit && <span className="muted" style={{ fontSize: 12 }}>{t("unscheduledHint")}</span>}
            </div>
            <div className={styles.unschedList}>
              {unscheduled.map((u) => (
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
