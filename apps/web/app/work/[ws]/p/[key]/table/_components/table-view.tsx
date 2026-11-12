"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PlanIoDialog, usePlanIoSections } from "@/features/plan-io/plan-io";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, LayoutList, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { AvatarStack, Avatar, Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { useIsMobile } from "@/lib/use-mobile";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import type { Options, Row, SavedView, TableData } from "./types";
import styles from "./ot.module.css";
import { StructureDialog, type StructureAction } from "./structure-dialog";
import { CustomCell, DateCell, PeopleCell, RemarkCell, SizeCell, SubtaskAdd } from "./cell-editors";
import { availableColumns, columnShowsAt, customText, DEFAULT_PROFILE, type CustomFieldDef, type FieldProfile, type Level } from "@/lib/field-profile";
import { isClosedCategory, STATUS_CATEGORIES, statusColorStyle, type StatusTone, statusTone, useStatusColors } from "@/lib/status";

// ต้องตรงกับความสูงแถว .table td ใน ot.module.css (ใช้คำนวณ virtual scroll)
const ROW_H = 38;
/** เกินจำนวนนี้จะ render เฉพาะแถวที่อยู่ในจอ (virtualized) */
export const VIRTUAL_AFTER = 300;
const PAGE = 500;
const MAX_PAGES = 4;
const FILTER_KEYS = ["q", "status", "assignee", "ba", "size", "priority", "level", "overdue", "hideDone", "sprint"] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;
const SIZES = ["XS", "S", "M", "L", "XL"] as const;
const GROUPS = ["module", "status", "assignee", "priority", "none"] as const;
type GroupBy = (typeof GROUPS)[number];
const SORTS = ["rank", "number", "planEnd", "priority"] as const;
// คอลัมน์มาจากชุดฟิลด์ของโปรเจกต์ (Template · ผู้ใช้ตัดสิน 2026-11-09) · แต่ละคนซ่อน / เปิดเพิ่มได้จากเมนู Columns (จำในเครื่อง)
type Col = string;
/** ความกว้างคอลัมน์ตาม Canvas Table (.gr grid-template-columns) · คอลัมน์ใหม่ / Custom field ใช้ค่ากลาง */
const COL_W: Record<string, number> = { dev: 84, ba: 40, sa: 40, reviewer: 56, status: 112, priority: 84, size: 78, start: 74, end: 82, actualStart: 84, actualEnd: 110, refs: 124, labels: 124, progress: 96, remark: 220 };
const colWidth = (c: Col) => COL_W[c] ?? 140;
const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
type ProjectFields = { fieldProfile?: FieldProfile; customFields?: CustomFieldDef[] };
/** ชื่องานกว้างอย่างน้อยเท่านี้ · ตารางกว้างกว่าจอเมื่อไรเลื่อนแนวนอนในกล่อง
 *  (340 เดิมแคบไปเมื่อเปิดหลายคอลัมน์ ชื่องานถูกตัดเร็ว ผู้ใช้ขอให้กว้างขึ้น) */
const NAME_MIN_W = 520;

type Display =
  | { kind: "module"; id: string; name: string; color: string | null; count: number; phases: number; md: number; pct: number; moduleId: string | null; from: string | null; to: string | null }
  | { kind: "phase"; id: string; moduleId: string | null; phaseId: string | null; name: string; done: number; total: number; md: number }
  | { kind: "issue"; row: Row; sub: boolean }
  | { kind: "add"; id: string; name: string; moduleId: string | null; phaseId: string | null }
  | { kind: "foot"; id: string; count: number; md: number }
  | { kind: "subAdd"; id: string; parentKey: string };

/** แทรกแถวพิมพ์ Sub-task ต่อจาก Sub-task ตัวสุดท้ายของ Task ที่กด */
function withSubtaskAdd(display: Display[], parentKey: string | null): Display[] {
  if (!parentKey) return display;
  let at = display.findIndex((d) => d.kind === "issue" && d.row.key === parentKey);
  if (at < 0) return display;
  at += 1;
  while (at < display.length) {
    const next = display[at];
    if (next.kind !== "issue" || next.row.parentKey !== parentKey) break;
    at += 1;
  }
  return [...display.slice(0, at), { kind: "subAdd", id: `${parentKey}:sub-add`, parentKey }, ...display.slice(at)];
}

/** ช่วงแผนของกลุ่ม: Plan Start แรกสุด – Plan End สุดท้าย */
function span(rows: Row[]) {
  const starts = rows.map((r) => r.planStart).filter((x): x is string => !!x).sort();
  const ends = rows.map((r) => r.planEnd).filter((x): x is string => !!x).sort();
  return { from: starts[0] ?? null, to: ends.at(-1) ?? null };
}

/** แถวที่แสดง: Module › (Task ที่ไม่มีกลุ่ม) › กลุ่ม › Task › Sub-task (Sub-task ตามแม่ทันที) + แถวเพิ่มงาน (ระดับ Module เฉพาะเมื่อไม่มีกลุ่ม) + สรุปท้าย Module
 *  กลุ่มไม่บังคับ (ผู้ใช้ขอ 2026-11-08): Task ที่ไม่มีกลุ่มอยู่ใต้ Module โดยตรง ไม่มีหัวกลุ่ม */
export function buildDisplay(data: TableData, collapsed: Set<string>, noModule: string, noPhase: string, includeEmpty = false): Display[] {
  const out: Display[] = [];
  const keys = new Set(data.items.map((r) => r.key));
  const kids = new Map<string, Row[]>();
  for (const r of data.items) if (r.parentKey && keys.has(r.parentKey)) kids.set(r.parentKey, [...(kids.get(r.parentKey) ?? []), r]);
  for (const m of data.modules) {
    const mid = m.id ?? "none";
    const inModule = data.items.filter((r) => (r.moduleId ?? null) === m.id && !(r.parentKey && keys.has(r.parentKey)));
    if (!inModule.length && !(includeEmpty && m.id)) continue;
    const named = m.phases.filter((x) => x.id && (includeEmpty || inModule.some((r) => r.phaseId === x.id)));
    out.push({ kind: "module", id: mid, name: m.name ?? noModule, color: m.color, count: m.taskCount, phases: named.length, md: m.estimateMd, pct: m.progressPct, moduleId: m.id, ...span(inModule) });
    if (collapsed.has(mid)) continue;
    const rowsOf = (phaseId: string | null) => inModule.filter((r) => (r.phaseId ?? null) === phaseId).flatMap((r) => [{ kind: "issue" as const, row: r, sub: !!r.parentKey }, ...(kids.get(r.key) ?? []).map((k) => ({ kind: "issue" as const, row: k, sub: true }))]);
    out.push(...rowsOf(null));
    // มีกลุ่มแล้วเพิ่ม Task จากแถวของกลุ่ม (เลือก "ไม่มีกลุ่ม" ในฟอร์มได้ งานจะขึ้นใต้ Module ตรงนี้) · ยังไม่มีกลุ่มจึงต้องมีแถวนี้ (ผู้ใช้ขอ 2026-11-11)
    if (!named.length) out.push({ kind: "add", id: `${mid}:add`, name: m.name ?? noModule, moduleId: m.id, phaseId: null });
    for (const ph of named) {
      const pid = `${mid}:${ph.id}`;
      out.push({ kind: "phase", id: pid, moduleId: m.id, phaseId: ph.id, name: ph.name ?? noPhase, done: ph.doneCount, total: ph.taskCount, md: ph.estimateMd });
      if (collapsed.has(pid)) continue;
      out.push(...rowsOf(ph.id));
      out.push({ kind: "add", id: `${pid}:add`, name: ph.name ?? noPhase, moduleId: m.id, phaseId: ph.id });
    }
    out.push({ kind: "foot", id: `${mid}:foot`, count: m.taskCount, md: m.estimateMd });
  }
  return out;
}

/** จัดกลุ่มแบบอื่นที่ไม่ใช่ Module (Status / Assignee / Priority / None) จากแถวที่โหลดแล้ว */
function buildFlat(data: TableData, collapsed: Set<string>, group: Exclude<GroupBy, "module">, label: (r: Row) => string): Display[] {
  const keys = new Set(data.items.map((r) => r.key));
  const kids = new Map<string, Row[]>();
  for (const r of data.items) if (r.parentKey && keys.has(r.parentKey)) kids.set(r.parentKey, [...(kids.get(r.parentKey) ?? []), r]);
  const roots = data.items.filter((r) => !(r.parentKey && keys.has(r.parentKey)));
  const buckets = new Map<string, Row[]>();
  for (const r of roots) { const k = group === "none" ? "" : label(r); buckets.set(k, [...(buckets.get(k) ?? []), r]); }
  const out: Display[] = [];
  for (const [name, rows] of buckets) {
    const id = `${group}:${name}`;
    const md = rows.reduce((n, r) => n + (r.estimateMd ?? 0), 0);
    const pct = rows.length ? Math.round(rows.reduce((n, r) => n + (r.progressPct ?? 0), 0) / rows.length) : 0;
    if (group !== "none") out.push({ kind: "module", id, name, color: null, count: rows.length, phases: 0, md, pct, moduleId: null, ...span(rows) });
    if (collapsed.has(id)) continue;
    for (const r of rows) {
      out.push({ kind: "issue", row: r, sub: !!r.parentKey });
      for (const k of kids.get(r.key) ?? []) out.push({ kind: "issue", row: k, sub: true });
    }
  }
  return out;
}

type Stuck = { module: number | null; phase: number | null };
const NOT_STUCK: Stuck = { module: null, phase: null };
const bodyRows = (box: HTMLElement) => box.querySelectorAll<HTMLTableRowElement>(":scope > table > tbody > tr[data-i]");

/** แถวแรกที่ยังโผล่พ้นเส้นใต้หัวตาราง · แถวเรียงบนลงล่างจึงค้นแบบแบ่งครึ่ง (scroll ทุกครั้งไม่ต้องวัดทุกแถว) */
function firstBelow(rows: NodeListOf<HTMLTableRowElement>, line: number) {
  let lo = 0, hi = rows.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > line) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found;
}

/** Module / กลุ่มของแถวแรกที่เห็น เมื่อตารางเลื่อนพ้นหัวตารางขึ้นไปแล้ว · เดินย้อนจากแถวนั้นจึงเจอกลุ่มก่อน Module ของมันเสมอ */
export function stuckGroups(box: HTMLElement, display: Display[], line: number, top: number): Stuck {
  if (top >= line) return NOT_STUCK;
  const rows = bodyRows(box);
  const found = firstBelow(rows, line);
  if (found < 0) return NOT_STUCK;
  let phase: number | null = null;
  for (let i = Number(rows[found].dataset.i); i >= 0; i--) {
    const kind = display[i]?.kind;
    if (kind === "phase" && phase === null) phase = i;
    if (kind === "module") return { module: i, phase };
  }
  return NOT_STUCK;
}

/** แถว Module / กลุ่มถัดไปที่เลื่อนขึ้นมาชนแถบที่ค้างอยู่ ดันแถบเดิมขึ้นแทนการซ้อนทับ */
function pushOffsets(box: HTMLElement, display: Display[], line: number, stackH: number, phaseH: number) {
  const rows = bodyRows(box);
  const found = firstBelow(rows, line);
  let all = 0, phase = 0;
  for (let j = found + 1; found >= 0 && j < rows.length; j++) {
    const top = rows[j].getBoundingClientRect().top;
    if (top >= line + stackH) break;
    const kind = display[Number(rows[j].dataset.i)]?.kind;
    if (kind === "module") { all = line + stackH - top; break; }
    if (kind === "phase" && phaseH && !phase) phase = Math.min(phaseH, line + stackH - top);
  }
  return { all, phase };
}

const PILL: Record<StatusTone, string> = { todo: styles.sTodo, in_progress: styles.sProg, review: styles.sRev, blocked: styles.sBlk, done: styles.sDone, cancelled: styles.sCan };
const pillClass = (category: string, name: string) => PILL[statusTone(category, name)];

export function TableView({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("overview-table.table");
  const statusColors = useStatusColors(ws, projectKey);
  // มือถือ: รายการแบบการ์ดแทนตารางกว้าง + ตัวเลือกพับเก็บ (ผู้ใช้แจ้ง 2026-11-11 ว่าตารางเลื่อนขวาไม่เห็น / ตัวกรองรก) · desktop ไม่เปลี่ยน
  const mobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  const search = useSearchParams();
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const page = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const [filters, setFilters] = useState<Filters>(() => (search.get("overdue") === "true" ? { overdue: "true" } : {}));
  const [groupBy, setGroupBy] = useState<GroupBy>("module");
  const [sort, setSort] = useState<(typeof SORTS)[number]>("rank");
  // คอลัมน์ที่คนนี้เลือกเอง (null = ตามโปรเจกต์) · จำในเครื่องต่อโปรเจกต์ · อ่านหลัง mount เพื่อไม่ให้ HTML จาก server ไม่ตรง
  const colsKey = `friday:table-cols:${ws}:${projectKey}`;
  const [userCols, setUserCols] = useState<Col[] | null>(null);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(colsKey) ?? "null");
      setUserCols(Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : null);
    } catch { setUserCols(null); }
  }, [colsKey]);
  const chooseCols = (next: Col[] | null) => {
    setUserCols(next);
    try { if (next) window.localStorage.setItem(colsKey, JSON.stringify(next)); else window.localStorage.removeItem(colsKey); } catch { /* ไม่มี storage ก็ใช้ได้เฉพาะรอบนี้ */ }
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  const [saving, setSaving] = useState(false);
  const [structure, setStructure] = useState<StructureAction | null>(null);
  const [reveal, setReveal] = useState<{ moduleId: string; phaseId?: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const headScroll = useRef<HTMLDivElement>(null);
  const hbar = useRef<HTMLDivElement>(null);
  const hbarInner = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const ctxPhaseRef = useRef<HTMLDivElement>(null);
  /** index ใน display ของ Module / กลุ่มที่ค้างใต้หัวตาราง */
  const [ctx, setCtx] = useState<{ module: number | null; phase: number | null }>({ module: null, phase: null });
  const [deleting, setDeleting] = useState(false);
  const [reasonFor, setReasonFor] = useState<{ run: (reason: string) => Promise<void> } | null>(null);
  const [subFor, setSubFor] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const ioSections = usePlanIoSections(ws, projectKey);
  const openIo = (section: string) => {
    const next = new URLSearchParams(search);
    next.set("io", section);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const canEdit = !!perms.data?.permissions.includes("issue.edit");
  const canCreate = !!perms.data?.permissions.includes("issue.create");
  const canSettings = !!perms.data?.permissions.includes("project.settings");
  const canDelete = !!perms.data?.permissions.includes("issue.delete") || perms.data?.role === "admin";
  const options = useQuery({ queryKey: ["form-options", ws, projectKey], queryFn: () => api.get<Options>(`${base}/form-options`), enabled: !!perms.data && !perms.data.guestViewer });
  const views = useQuery({ queryKey: ["saved-views", ws, projectKey], queryFn: () => api.get<{ items: SavedView[] }>(`${base}/saved-views`) });
  // ชุดฟิลด์ / Custom field มากับข้อมูลโปรเจกต์ (cache เดียวกับ Drawer)
  const project = useQuery({ queryKey: queryKeys.project(ws, projectKey), queryFn: () => api.get<ProjectFields>(base), enabled: !!perms.data && !perms.data.guestViewer });
  const profile = project.data?.fieldProfile ?? DEFAULT_PROFILE;
  const customFields = project.data?.customFields ?? [];
  const available = availableColumns(profile, customFields);
  const chosen = userCols ?? profile.columns;
  const cols = available.filter((c) => chosen.includes(c));
  // ตัวกรองของฟิลด์ที่ซ่อนทั้ง Task และ Sub-task ไม่มีประโยชน์ จึงไม่แสดง
  const usedField = (f: "ba" | "size") => profile.fields[f]?.task !== "hidden" || profile.fields[f]?.subtask !== "hidden";
  const colLabel = (c: Col) => c.startsWith("cf:") ? (customFields.find((f) => `cf:${f.id}` === c)?.name ?? c) : t(`cols.${c}`);

  const params = new URLSearchParams({ view: "table", limit: String(PAGE), sort });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  // ซ่อนงานที่ปิดแล้ว (เสร็จ / ยกเลิก) · open = งานค้างทุกหมวด
  else if (filters.hideDone) params.set("status", "open");
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.ba) params.set("ba", filters.ba);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.level) params.set("level", filters.level);
  if (filters.overdue) params.set("overdue", "true");
  if (filters.sprint) params.set("sprint", filters.sprint);
  const tableKey = ["table", ws, projectKey, params.toString()];
  const table = useQuery({
    queryKey: tableKey,
    queryFn: async () => {
      // โหลดต่อจนครบ (สูงสุด 2,000 แถว) · สรุปรวมมาจากหน้าแรก
      const first = await api.get<TableData>(`${base}/issues?${params}`);
      let cursor = first.nextCursor;
      for (let i = 1; cursor !== null && i < MAX_PAGES; i++) {
        const next = await api.get<TableData>(`${base}/issues?${params}&cursor=${encodeURIComponent(String(cursor))}`);
        first.items.push(...next.items);
        cursor = next.nextCursor;
      }
      return { ...first, nextCursor: cursor };
    },
    enabled: !!perms.data && !perms.data.guestViewer,
  });

  // API ยังไม่มีตัวกรอง Size จึงกรองจากแถวที่โหลดมาแล้ว
  const view = useMemo(() => (table.data && filters.size ? { ...table.data, items: table.data.items.filter((r) => r.size === filters.size) } : table.data), [table.data, filters.size]);
  const grouped = useMemo(() => {
    if (!view) return [];
    if (groupBy === "module") return buildDisplay(view, collapsed, t("noModule"), t("noPhase"), !FILTER_KEYS.some((key) => filters[key]));
    const label = (r: Row) =>
      groupBy === "status" ? r.status.name : groupBy === "assignee" ? (r.assignees?.[0]?.displayName ?? t("noAssignee")) : r.priority;
    return buildFlat(view, collapsed, groupBy, label);
  }, [view, collapsed, groupBy, filters, t]);
  const display = useMemo(() => withSubtaskAdd(grouped, subFor), [grouped, subFor]);
  const virtual = display.length > VIRTUAL_AFTER;
  // ตารางใช้ scroll ของหน้า: ระยะที่เลื่อนผ่านตาราง = ขอบบนของตัวตารางที่พ้นใต้หัวตารางขึ้นไป
  // ใช้รอบเดียวกันหา Module / กลุ่มที่ค้างใต้หัวตาราง และระยะที่แถว Module ถัดไปดันขึ้น
  useEffect(() => {
    const update = () => {
      const box = scroller.current;
      const head = headRef.current;
      if (!box || !head) return;
      const line = head.getBoundingClientRect().bottom;
      const top = box.getBoundingClientRect().top;
      if (virtual) {
        setScrollTop(Math.max(0, line - top));
        setViewH(window.innerHeight);
      }
      const next = stuckGroups(box, display, line, top);
      setCtx((old) => (old.module === next.module && old.phase === next.phase ? old : next));
      const stack = ctxRef.current;
      if (stack) {
        const push = pushOffsets(box, display, line, stack.offsetHeight, ctxPhaseRef.current?.offsetHeight ?? 0);
        stack.style.transform = push.all ? `translateY(${-push.all}px)` : "";
        if (ctxPhaseRef.current) ctxPhaseRef.current.style.transform = push.phase ? `translateY(${-push.phase}px)` : "";
      }
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [virtual, display, ctx.module, ctx.phase]);
  // แนวนอน: ตัวตาราง หัวตาราง และแถบเลื่อนล่างจอ เลื่อนตรงกันเสมอ
  useEffect(() => {
    const body = scroller.current, head = headScroll.current, bar = hbar.current, inner = hbarInner.current;
    if (!body || !head || !bar || !inner) return;
    const size = () => {
      inner.style.width = `${body.scrollWidth}px`;
      bar.hidden = body.scrollWidth <= body.clientWidth + 1;
      head.scrollLeft = body.scrollLeft;
    };
    const fromBody = () => {
      head.scrollLeft = body.scrollLeft;
      if (bar.scrollLeft !== body.scrollLeft) bar.scrollLeft = body.scrollLeft;
    };
    const fromBar = () => { if (body.scrollLeft !== bar.scrollLeft) body.scrollLeft = bar.scrollLeft; };
    // หัวตารางเป็น overflow hidden ไม่รับล้อเมาส์แนวนอนเอง จึงส่งต่อให้ตัวตาราง
    const wheelHead = (e: WheelEvent) => {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (Math.abs(dx) <= Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
      body.scrollLeft += dx;
      e.preventDefault();
    };
    size();
    body.addEventListener("scroll", fromBody, { passive: true });
    bar.addEventListener("scroll", fromBar, { passive: true });
    head.addEventListener("wheel", wheelHead, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    observer?.observe(body);
    if (body.firstElementChild) observer?.observe(body.firstElementChild);
    return () => {
      body.removeEventListener("scroll", fromBody);
      bar.removeEventListener("scroll", fromBar);
      head.removeEventListener("wheel", wheelHead);
      observer?.disconnect();
    };
  }, [display.length > 0, cols.join(), table.data]);
  useEffect(() => {
    if (!reveal || structure) return;
    const index = display.findIndex((row) => reveal.phaseId ? row.kind === "phase" && row.phaseId === reveal.phaseId : row.kind === "module" && row.moduleId === reveal.moduleId);
    if (index < 0) return;
    // กลุ่มที่เพิ่งสร้างอาจอยู่พ้นช่วงที่ virtualized table render อยู่
    if (virtual && scroller.current) {
      const page = document.scrollingElement ?? document.documentElement;
      page.scrollTop = page.scrollTop + scroller.current.getBoundingClientRect().top + index * ROW_H - window.innerHeight / 2;
      setScrollTop(index * ROW_H);
    }
    const frame = requestAnimationFrame(() => {
      const selector = reveal.phaseId ? `[data-phase-id="${reveal.phaseId}"]` : `[data-module-id="${reveal.moduleId}"]`;
      scroller.current?.querySelector(selector)?.scrollIntoView({ block: "center" });
      setReveal(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [display, reveal, structure, virtual]);
  const statuses = options.data?.issueTypes.find((x) => x.name === "Task")?.statuses ?? [];
  const reload = () => cache.invalidateQueries({ queryKey: ["table", ws, projectKey] });
  const set = (k: keyof Filters, v: string) => { setFilters((f) => ({ ...f, [k]: v || undefined })); setSelected(new Set()); };
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function patch(row: Row, body: Record<string, unknown>) {
    const run = async (reason?: string) => {
      try {
        await api.patch(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(row.key)}`, reason ? { ...body, planChangeReason: reason } : body, row.version);
        toast({ message: t("saved", { key: row.key }) });
      } catch (e) {
        if (e instanceof ApiError && e.code === "plan_change_reason_required") { setReasonFor({ run: (r) => run(r) }); return; }
        toast({ message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof ApiError && e.code === "due_change_requires_approval" ? t("needsApproval") : e instanceof Error ? e.message : String(e) });
      }
      await reload();
    };
    await run();
  }

  async function bulk(set: Record<string, unknown>, reason?: string): Promise<void> {
    const keys = [...selected];
    try {
      const r = await api.post<{ results: { key: string; ok: boolean; error?: { code: string } }[] }>(`${base}/issues/bulk`, { keys, set: reason ? { ...set, planChangeReason: reason } : set });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.some((f) => f.error?.code === "plan_change_reason_required") && !reason) { setReasonFor({ run: (rs) => bulk(set, rs) }); return; }
      toast({ message: failed.length ? t("bulkFailed", { count: failed.length }) : t("bulkDone", { count: keys.length }) });
      if (!failed.length) setSelected(new Set());
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : String(e) });
    }
    await reload();
  }

  // bulk ของ API ไม่รับ statusId จึงแก้ทีละงานพร้อม version ของแถว
  async function bulkStatus(statusId: string) {
    const rows = (table.data?.items ?? []).filter((r) => selected.has(r.key));
    const results = await Promise.allSettled(rows.map((r) => api.patch(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(r.key)}`, { statusId }, r.version)));
    const failed = results.filter((x) => x.status === "rejected").length;
    toast({ message: failed ? t("bulkFailed", { count: failed }) : t("bulkDone", { count: rows.length }) });
    if (!failed) setSelected(new Set());
    await reload();
  }

  if (perms.isPending || (table.isPending && table.fetchStatus !== "idle")) return <div className={styles.page}><LoadingState /></div>;
  if (perms.data?.guestViewer) return <div className={styles.page}><Forbidden /></div>;
  const err = perms.error ?? table.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => table.refetch()} />}</div>;
  const data = view!;
  const issueRows = display.filter((d): d is Extract<Display, { kind: "issue" }> => d.kind === "issue");
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - 10) : 0;
  const end = virtual ? Math.min(display.length, start + Math.ceil(viewH / ROW_H) + 20) : display.length;
  const shown = display.slice(start, end);
  const allSelected = issueRows.length > 0 && issueRows.every((d) => selected.has(d.row.key));
  const filtered = FILTER_KEYS.some((k) => filters[k]);
  const s = data.summary;
  const span = cols.length + 1;
  const extra = (["status", "priority", "level"] as const).filter((k) => filters[k]).length;
  const activeView = (f: Filters) => JSON.stringify(f) === JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, x]) => x)));
  const taskHref = (moduleId?: string | null, phaseId?: string | null) => {
    const query = new URLSearchParams({ new: "1", type: "task" });
    if (moduleId) query.set("moduleId", moduleId);
    if (phaseId) query.set("phaseId", phaseId);
    return `${page}/table?${query}`;
  };
  async function structureSaved(moduleId: string, phaseId?: string) {
    if (structure?.kind === "createModule" || structure?.kind === "createPhase") { setFilters({}); setGroupBy("module"); setReveal({ moduleId, phaseId }); }
    setCollapsed((old) => { const next = new Set(old); next.delete(moduleId); if (phaseId) next.delete(`${moduleId}:${phaseId}`); return next; });
    await Promise.all([
      reload(),
      cache.invalidateQueries({ queryKey: ["form-options", ws, projectKey] }),
      cache.invalidateQueries({ queryKey: ["issue-form-options", ws, projectKey] }),
      cache.invalidateQueries({ queryKey: queryKeys.project(ws, projectKey), exact: true }),
      cache.invalidateQueries({ queryKey: ["overview", ws, projectKey] }),
      cache.invalidateQueries({ queryKey: ["workspace", ws, "project", projectKey, "settings", "modules"] }),
    ]);
    toast({ message: t("structure.saved") });
  }
  const groupIds = display.filter((d) => d.kind === "module" || d.kind === "phase").map((d) => d.id);
  const tableMinW = NAME_MIN_W + cols.reduce((n, c) => n + colWidth(c) + 10, 0) + (cols.length ? 9 : 0);
  // คอลัมน์แรกถัดจากชื่อเว้นซ้ายเพิ่ม 9px (CSS nth-child(2)) จึงกว้างขึ้นเท่ากัน ไม่ให้เนื้อหาเบียด
  const colgroup = <colgroup><col />{cols.map((c, i) => <col key={c} style={{ width: colWidth(c) + 10 + (i === 0 ? 9 : 0) }} />)}</colgroup>;
  const stuckModule = ctx.module !== null ? display[ctx.module] : undefined;
  const stuckPhase = ctx.phase !== null ? display[ctx.phase] : undefined;
  const ctxModule = stuckModule?.kind === "module" ? stuckModule : null;
  const ctxPhase = stuckPhase?.kind === "phase" ? stuckPhase : null;
  const moduleInfo = (d: Extract<Display, { kind: "module" }>) => <>
    <span className={styles.muted} style={{ fontSize: 12 }}>{groupBy === "module" && d.phases ? t("moduleTasks", { count: d.count, phases: d.phases }) : t("groupTasks", { count: d.count })}</span>
    <span className={styles.mbar}><span><span style={{ width: `${d.pct}%`, background: d.color ?? "var(--primary)" }} /></span><b>{d.pct}%</b></span>
    <span className={styles.muted} style={{ fontSize: 12, marginLeft: 8 }}>{d.from && d.to ? `${formatDate(d.from, year)} – ${formatDate(d.to, year)}` : `${d.md} MD`}</span>
    {groupBy === "module" && canCreate && <Link className={styles.addb} style={{ marginLeft: "auto" }} href={taskHref(d.moduleId)} scroll={false}>{t("addTask")}</Link>}
  </>;
  const phaseInfo = (d: Extract<Display, { kind: "phase" }>) => <>
    <span className={`${styles.pill} ${styles.sTodo}`}>{d.done}/{d.total}</span>
    <span className={`${styles.muted} ${styles.small}`}>{d.md} MD</span>
  </>;
  /** ย่อจากแถบที่ค้างอยู่: ย่อแล้วเลื่อนให้แถวนั้นมาอยู่ใต้หัวตารางพอดี ไม่ค้างอยู่กลางงานของ Module ถัดไป */
  const collapseStuck = (id: string) => {
    const index = display.findIndex((d) => d.kind !== "issue" && d.id === id);
    toggle(id);
    requestAnimationFrame(() => {
      const box = scroller.current, head = headRef.current;
      if (!box || !head) return;
      const page = document.scrollingElement ?? document.documentElement;
      const row = box.querySelector<HTMLElement>(`tr[data-i="${index}"]`);
      const top = row ? row.getBoundingClientRect().top : box.getBoundingClientRect().top + index * ROW_H;
      page.scrollTop += top - head.getBoundingClientRect().bottom;
    });
  };

  return (
    <div className={styles.page}>
      <div className={mobile ? styles.mViews : styles.bar} role="group" aria-label={t("views")}>
        {!mobile && <span className={styles.muted} style={{ fontSize: 12, marginRight: 4 }}>{t("views")}</span>}
        <button type="button" className={styles.chip} aria-pressed={!filtered} onClick={() => setFilters({})}>{t("allTasks")}</button>
        <button type="button" className={styles.chip} aria-pressed={activeView({ assignee: "me" })} onClick={() => setFilters({ assignee: "me" })}>{t("myView")}</button>
        <button type="button" className={styles.chip} aria-pressed={activeView({ overdue: "true" })} onClick={() => setFilters({ overdue: "true" })}>{t("overdue")}</button>
        <button type="button" className={styles.chip} aria-pressed={activeView({ sprint: "current" })} onClick={() => setFilters({ sprint: "current" })}>{t("currentSprintView")}</button>
        <button type="button" className={styles.chip} aria-pressed={activeView({ sprint: "none" })} onClick={() => setFilters({ sprint: "none" })}>{t("backlogView")}</button>
        {views.data?.items.map((v) => (
          <span key={v.id} style={{ display: "inline-flex", alignItems: "center" }}>
            <button type="button" className={styles.chip} aria-pressed={activeView(v.filters as Filters)} onClick={() => setFilters(v.filters as Filters)}>{v.name}</button>
            {v.mine !== false && <button type="button" className={styles.toggle} aria-label={t("deleteView", { name: v.name })} onClick={async () => { await api.delete(`${base}/saved-views/${v.id}`); await cache.invalidateQueries({ queryKey: ["saved-views", ws, projectKey] }); }}><X size={14} /></button>}
          </span>
        ))}
        <button type="button" className={styles.addb} onClick={() => setSaving(true)}>{t("saveView")}</button>
      </div>

      {mobile ? (
        <div className={styles.mTools}>
          <div className={styles.mToolRow}>
            <form className={styles.search} onSubmit={(e) => { e.preventDefault(); set("q", String(new FormData(e.currentTarget).get("q") ?? "")); }}>
              <Search size={16} aria-hidden="true" />
              <input type="search" name="q" aria-label={t("search")} placeholder={t("search")} defaultValue={filters.q ?? ""} />
            </form>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" className={styles.tbtn} aria-label={t("filter")}><SlidersHorizontal size={16} aria-hidden="true" />{extra > 0 && <span className={`${styles.pill} ${styles.sProg}`}>{extra}</span>}</button>
              </Popover.Trigger>
              <Popover.Content className={`popover ${styles.pop}`} sideOffset={6} align="end">
                <Select label={t("status")} size="small" value={filters.status ?? ""} onChange={(e) => set("status", e.target.value)}>
                  <option value="">{t("allStatus")}</option>
                  {STATUS_CATEGORIES.map((c) => <option key={c} value={c}>{t(`statusCategory.${c}`)}</option>)}
                </Select>
                <Select label={t("priority")} size="small" value={filters.priority ?? ""} onChange={(e) => set("priority", e.target.value)}>
                  <option value="">{t("anyPriority")}</option>
                  {(["urgent", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
                <Select label={t("level")} size="small" value={filters.level ?? ""} onChange={(e) => set("level", e.target.value)}>
                  <option value="">{t("allLevels")}</option><option value="task">{t("tasks")}</option><option value="subtask">{t("subtasks")}</option>
                </Select>
                {filtered && <Button size="small" variant="ghost" onClick={() => setFilters({})}>{t("clear")}</Button>}
              </Popover.Content>
            </Popover.Root>
            <button type="button" className={styles.tbtn} aria-label={t("moreOptions")} aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}><LayoutList size={16} aria-hidden="true" /></button>
            {canCreate && <Link className={`${styles.tbtn} ${styles.pri}`} href={taskHref()} scroll={false}>{t("addTask")}</Link>}
          </div>
          {moreOpen && (
            <div className={styles.mMore} role="group" aria-label={t("moreOptions")}>
              <label className={styles.tbtn}>{t("groupBy")}
                <select className={styles.tsel} aria-label={t("groupBy")} value={groupBy} onChange={(e) => { setGroupBy(e.target.value as GroupBy); setCollapsed(new Set()); }}>
                  {GROUPS.map((g) => <option key={g} value={g}>{t(`groups.${g}`)}</option>)}
                </select>
              </label>
              {usedField("ba") && <select className={styles.tbtn} aria-label={t("ba")} value={filters.ba ?? ""} onChange={(e) => set("ba", e.target.value)}>
                <option value="">{t("ba")}: {t("anyone")}</option>
                {options.data?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>}
              <select className={styles.tbtn} aria-label={t("assignee")} value={filters.assignee ?? ""} onChange={(e) => set("assignee", e.target.value)}>
                <option value="">{t("assignee")}: {t("anyone")}</option>
                <option value="me">{t("me")}</option>
                <option value="none">{t("none")}</option>
                {options.data?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
              {usedField("size") && <select className={styles.tbtn} aria-label={t("size")} value={filters.size ?? ""} onChange={(e) => set("size", e.target.value)}>
                <option value="">{t("size")}: {t("allSizes")}</option>
                {SIZES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>}
              <label className={styles.tbtn}>{t("sort")}:
                <select className={styles.tsel} aria-label={t("sort")} value={sort} onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])}>
                  {SORTS.map((o) => <option key={o} value={o}>{t(`sorts.${o}`)}</option>)}
                </select>
              </label>
              <label className={styles.tbtn} style={{ cursor: "pointer" }}>
                <input type="checkbox" className={styles.cb} checked={!filters.hideDone} onChange={() => set("hideDone", filters.hideDone ? "" : "1")} />{t("showCompleted")}
              </label>
              <button type="button" className={`${styles.tbtn} ${styles.ghost}`} onClick={() => setCollapsed(new Set())}>{t("expandAll")}</button>
              <button type="button" className={`${styles.tbtn} ${styles.ghost}`} onClick={() => setCollapsed(new Set(groupIds))}>{t("collapseAll")}</button>
              {/* Import / Export เปิดเป็น Popup (ผู้ใช้ตัดสิน 2026-11-09) · สมาชิกทั่วไปเห็นเฉพาะ Export */}
              {ioSections.length > 0 && <button type="button" className={styles.tbtn} onClick={() => openIo(ioSections[0])}>{t("importExport")}</button>}
              {canSettings && <button type="button" className={styles.tbtn} onClick={() => setStructure({ kind: "createModule" })}>{t("addModule")}</button>}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.toolbar}>
          <div className={styles.bar} role="group" aria-label={t("filters")}>
            <form className={styles.search} onSubmit={(e) => { e.preventDefault(); set("q", String(new FormData(e.currentTarget).get("q") ?? "")); }}>
              <Search size={16} aria-hidden="true" />
              <input type="search" name="q" aria-label={t("search")} placeholder={t("search")} defaultValue={filters.q ?? ""} />
            </form>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" className={styles.tbtn}><SlidersHorizontal size={16} aria-hidden="true" />{t("filter")}{extra > 0 && <span className={`${styles.pill} ${styles.sProg}`}>{extra}</span>}</button>
              </Popover.Trigger>
              <Popover.Content className={`popover ${styles.pop}`} sideOffset={6} align="start">
                <Select label={t("status")} size="small" value={filters.status ?? ""} onChange={(e) => set("status", e.target.value)}>
                  <option value="">{t("allStatus")}</option>
                  {STATUS_CATEGORIES.map((c) => <option key={c} value={c}>{t(`statusCategory.${c}`)}</option>)}
                </Select>
                <Select label={t("priority")} size="small" value={filters.priority ?? ""} onChange={(e) => set("priority", e.target.value)}>
                  <option value="">{t("anyPriority")}</option>
                  {(["urgent", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
                <Select label={t("level")} size="small" value={filters.level ?? ""} onChange={(e) => set("level", e.target.value)}>
                  <option value="">{t("allLevels")}</option><option value="task">{t("tasks")}</option><option value="subtask">{t("subtasks")}</option>
                </Select>
                {filtered && <Button size="small" variant="ghost" onClick={() => setFilters({})}>{t("clear")}</Button>}
              </Popover.Content>
            </Popover.Root>
            <label className={styles.tbtn}>{t("groupBy")}
              <select className={styles.tsel} aria-label={t("groupBy")} value={groupBy} onChange={(e) => { setGroupBy(e.target.value as GroupBy); setCollapsed(new Set()); }}>
                {GROUPS.map((g) => <option key={g} value={g}>{t(`groups.${g}`)}</option>)}
              </select>
            </label>
            {usedField("ba") && <select className={styles.tbtn} aria-label={t("ba")} value={filters.ba ?? ""} onChange={(e) => set("ba", e.target.value)}>
              <option value="">{t("ba")}: {t("anyone")}</option>
              {options.data?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>}
            <select className={styles.tbtn} aria-label={t("assignee")} value={filters.assignee ?? ""} onChange={(e) => set("assignee", e.target.value)}>
              <option value="">{t("assignee")}: {t("anyone")}</option>
              <option value="me">{t("me")}</option>
              <option value="none">{t("none")}</option>
              {options.data?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
            {usedField("size") && <select className={styles.tbtn} aria-label={t("size")} value={filters.size ?? ""} onChange={(e) => set("size", e.target.value)}>
              <option value="">{t("size")}: {t("allSizes")}</option>
              {SIZES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>}
            <label className={styles.tbtn}>{t("sort")}:
              <select className={styles.tsel} aria-label={t("sort")} value={sort} onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])}>
                {SORTS.map((o) => <option key={o} value={o}>{t(`sorts.${o}`)}</option>)}
              </select>
            </label>
            <Popover.Root>
              <Popover.Trigger asChild><button type="button" className={styles.tbtn}>{t("columns")}</button></Popover.Trigger>
              <Popover.Content className={`popover ${styles.pop}`} sideOffset={6} align="start">
                {available.map((c) => (
                  <label key={c} className={styles.colCheck}>
                    <input type="checkbox" checked={cols.includes(c)} onChange={() => chooseCols(cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c])} />{colLabel(c)}
                  </label>
                ))}
                <p className={styles.popHint}>{t("columnsHint")}</p>
                {userCols && <Button size="small" variant="ghost" onClick={() => chooseCols(null)}>{t("columnsReset")}</Button>}
              </Popover.Content>
            </Popover.Root>
            <label className={styles.tbtn} style={{ cursor: "pointer" }}>
              <input type="checkbox" className={styles.cb} checked={!filters.hideDone} onChange={() => set("hideDone", filters.hideDone ? "" : "1")} />{t("showCompleted")}
            </label>
          </div>
          <div className={styles.bar}>
            <button type="button" className={`${styles.tbtn} ${styles.ghost}`} onClick={() => setCollapsed(new Set())}>{t("expandAll")}</button>
            <button type="button" className={`${styles.tbtn} ${styles.ghost}`} onClick={() => setCollapsed(new Set(groupIds))}>{t("collapseAll")}</button>
            {/* Import / Export เปิดเป็น Popup (ผู้ใช้ตัดสิน 2026-11-09) · สมาชิกทั่วไปเห็นเฉพาะ Export */}
            {ioSections.length > 0 && <button type="button" className={styles.tbtn} onClick={() => openIo(ioSections[0])}>{t("importExport")}</button>}
            {canSettings && <button type="button" className={styles.tbtn} onClick={() => setStructure({ kind: "createModule" })}>{t("addModule")}</button>}
            {canCreate && <Link className={`${styles.tbtn} ${styles.pri}`} href={taskHref()} scroll={false}>{t("addTask")}</Link>}
          </div>
        </div>
      )}

      {canEdit && selected.size > 0 && (
        <BulkBar count={selected.size} options={options.data} statuses={statuses} canDelete={canDelete} onApply={(set) => bulk(set)} onStatus={(id) => void bulkStatus(id)} onDelete={() => setDeleting(true)} onClear={() => setSelected(new Set())} />
      )}

      {mobile ? (
        <MobileList display={display} collapsed={collapsed} onToggle={toggle} ws={ws} projectKey={projectKey} year={year} canCreate={canCreate} taskHref={taskHref}
          empty={!display.length ? (filtered ? t("emptyFiltered") : t("empty")) : null}
          summary={`${t("summary", { tasks: s.taskCount, subs: s.subtaskCount, done: s.doneCount, md: s.estimateMd, pct: s.progressPct })} · ${t("rows", { shown: issueRows.length, total: data.items.length })}`} />
      ) : (
        <section className={styles.card} style={{ overflow: "clip" }}>
          {!data.items.length && display.length > 0 && <EmptyState title={t("empty")} />}
          {!display.length ? <EmptyState title={filtered ? t("emptyFiltered") : t("empty")} /> : (
            <>
            {/* หัวตารางแยกเป็นตารางของตัวเอง ติดใต้ top bar · ความกว้างคอลัมน์ใช้ colgroup ชุดเดียวกับตัวตาราง */}
            <div className={styles.stickyHead} ref={headRef}>
              <div className={styles.headScroll} ref={headScroll}>
                <table className={styles.table} style={{ minWidth: tableMinW }}>
                  {colgroup}
                  <thead>
                    <tr>
                      <th>
                        <div className={styles.nameHead}>
                          {canEdit ? <input type="checkbox" className={styles.cb} aria-label={t("selectAll")} checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(issueRows.map((d) => d.row.key)) : new Set())} /> : <span style={{ width: 16 }} />}
                          {t("cols.name")}
                        </div>
                      </th>
                      {cols.map((c) => <th key={c}>{colLabel(c)}</th>)}
                    </tr>
                  </thead>
                </table>
              </div>
              {(ctxModule || ctxPhase) && <div className={styles.ctx} data-testid="table-stuck"><div ref={ctxRef}>
                {ctxModule && <div className={styles.ctxModule}>
                  <button type="button" className={styles.chv} aria-expanded aria-label={t("collapse", { name: ctxModule.name })} onClick={() => collapseStuck(ctxModule.id)}><ChevronDown size={16} /></button>
                  {ctxModule.color !== null && <span className={styles.swatch} style={{ background: ctxModule.color }} />}
                  <span className={styles.mname}>{ctxModule.name}</span>
                  {moduleInfo(ctxModule)}
                </div>}
                {ctxPhase && <div className={styles.ctxPhase} ref={ctxPhaseRef}>
                  <button type="button" className={styles.chv} aria-expanded aria-label={t("collapse", { name: ctxPhase.name })} onClick={() => collapseStuck(ctxPhase.id)}><ChevronDown size={16} /></button>
                  <span className={styles.plabel}>{t("phaseLabel")}</span>
                  <b>{ctxPhase.name}</b>
                  {phaseInfo(ctxPhase)}
                </div>}
              </div></div>}
            </div>
            <div className={styles.tableWrap} ref={scroller} data-testid="table-scroll">
              <table className={styles.table} aria-rowcount={display.length + 1} style={{ minWidth: tableMinW }}>
                {colgroup}
                <tbody>
                  {virtual && start > 0 && <tr aria-hidden="true"><td colSpan={span} style={{ height: start * ROW_H, padding: 0 }} /></tr>}
                  {shown.map((d, n) => d.kind === "module" ? (
                    <tr key={d.id} data-i={start + n} data-module-id={d.moduleId ?? undefined} className={styles.moduleRow}>
                      <td colSpan={span}>
                        <div className={styles.mrow}>
                          <button type="button" className={styles.chv} aria-expanded={!collapsed.has(d.id)} aria-label={t(collapsed.has(d.id) ? "expand" : "collapse", { name: d.name })} onClick={() => toggle(d.id)}>
                            <ChevronDown size={16} style={{ transform: collapsed.has(d.id) ? "rotate(-90deg)" : undefined }} />
                          </button>
                          {d.color !== null && <span className={styles.swatch} style={{ background: d.color }} />}
                          <span className={styles.mname} onDoubleClick={canSettings && d.moduleId ? () => setStructure({ kind: "renameModule", id: d.moduleId!, name: d.name }) : undefined}>{d.name}</span>
                          {groupBy === "module" && (canSettings || canCreate) && d.moduleId && <Popover.Root>
                            <Popover.Trigger asChild><button type="button" className={styles.chv} aria-label={t("structure.moduleMenu", { name: d.name })}>⋯</button></Popover.Trigger>
                            <Popover.Portal><Popover.Content className="popover" align="start" sideOffset={4}>
                              {canSettings && <Popover.Close asChild><button type="button" className="menu-item" onClick={() => setStructure({ kind: "renameModule", id: d.moduleId!, name: d.name })}>{t("structure.renameModule")}</button></Popover.Close>}
                              <Popover.Close asChild><button type="button" className="menu-item" onClick={() => setStructure({ kind: "createPhase", moduleId: d.moduleId!, moduleName: d.name })}>{t("structure.createPhase")}</button></Popover.Close>
                            </Popover.Content></Popover.Portal>
                          </Popover.Root>}
                          {moduleInfo(d)}
                        </div>
                      </td>
                    </tr>
                  ) : d.kind === "phase" ? (
                    <tr key={d.id} data-i={start + n} data-phase-id={d.phaseId ?? undefined} className={styles.phaseRow}>
                      <td colSpan={span}>
                        <div className={styles.prow}>
                          <button type="button" className={styles.chv} aria-expanded={!collapsed.has(d.id)} aria-label={t(collapsed.has(d.id) ? "expand" : "collapse", { name: d.name })} onClick={() => toggle(d.id)}>
                            <ChevronDown size={16} style={{ transform: collapsed.has(d.id) ? "rotate(-90deg)" : undefined }} />
                          </button>
                          <span className={styles.plabel}>{t("phaseLabel")}</span>
                          <b>{d.name}</b>
                          {canSettings && d.moduleId && d.phaseId && <Popover.Root>
                            <Popover.Trigger asChild><button type="button" className={styles.chv} aria-label={t("structure.phaseMenu", { name: d.name })}>⋯</button></Popover.Trigger>
                            <Popover.Portal><Popover.Content className="popover" align="start" sideOffset={4}>
                              <Popover.Close asChild><button type="button" className="menu-item" onClick={() => setStructure({ kind: "renamePhase", id: d.phaseId!, moduleId: d.moduleId!, name: d.name })}>{t("structure.renamePhase")}</button></Popover.Close>
                              <Popover.Close asChild><button type="button" className="menu-item" onClick={() => setStructure({ kind: "deletePhase", id: d.phaseId!, moduleId: d.moduleId!, name: d.name })}>{t("structure.deletePhase")}</button></Popover.Close>
                            </Popover.Content></Popover.Portal>
                          </Popover.Root>}
                          {phaseInfo(d)}
                        </div>
                      </td>
                    </tr>
                  ) : d.kind === "add" ? (
                    canCreate ? <tr key={d.id} data-i={start + n} className={styles.addRow}><td colSpan={span}><Link className={styles.addb} href={taskHref(d.moduleId, d.phaseId)} scroll={false}>{t("addTaskIn", { name: d.name })}</Link></td></tr> : null
                  ) : d.kind === "subAdd" ? (
                    <tr key={d.id} data-i={start + n} className={styles.subAddRow}><td colSpan={span}>
                      <SubtaskAdd base={base} parentKey={d.parentKey} onClose={() => setSubFor(null)}
                        onCreated={async (key) => { toast({ message: t("cell.subtaskCreated", { key }) }); await reload(); }}
                        onFullForm={() => { setSubFor(null); router.replace(`${page}/table?${new URLSearchParams({ issue: d.parentKey, new: "1", parent: d.parentKey })}`, { scroll: false }); }} />
                    </td></tr>
                  ) : d.kind === "foot" ? (
                    <tr key={d.id} data-i={start + n} className={styles.footRow}><td colSpan={span}><div className={styles.footInner}><span>{t("footTasks", { count: d.count })}</span><span>{t("footMd", { md: d.md })}</span></div></td></tr>
                  ) : (
                    <IssueRow key={d.row.key} index={start + n} row={d.row} statusColor={statusColors.get(d.row.status.id)} sub={d.sub} cols={cols} profile={profile} customFields={customFields} ws={ws} projectKey={projectKey} year={year} canEdit={canEdit} statuses={statuses} people={options.data?.members ?? []}
                      onAddSub={canCreate && !d.sub ? () => setSubFor(d.row.key) : undefined}
                      selected={selected.has(d.row.key)} onSelect={(on) => setSelected((c) => { const n = new Set(c); if (on) n.add(d.row.key); else n.delete(d.row.key); return n; })}
                      onPatch={(body) => patch(d.row, body)} />
                  ))}
                  {virtual && end < display.length && <tr aria-hidden="true"><td colSpan={span} style={{ height: (display.length - end) * ROW_H, padding: 0 }} /></tr>}
                </tbody>
              </table>
            </div>
            <div className={styles.hbar} ref={hbar} aria-hidden="true"><div ref={hbarInner} /></div>
            </>
          )}
          {groupBy === "module" && canSettings && (
            <div style={{ padding: "10px 14px" }}><button type="button" className={styles.newModule} style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => setStructure({ kind: "createModule" })}>{t("newModule")}</button></div>
          )}
          <div className={styles.foot}>
            {t("summary", { tasks: s.taskCount, subs: s.subtaskCount, done: s.doneCount, md: s.estimateMd, pct: s.progressPct })} · {t("rows", { shown: issueRows.length, total: data.items.length })}{virtual ? ` · ${t("virtualHint")}` : ""}
          </div>
        </section>
      )}

      <PlanIoDialog ws={ws} projectKey={projectKey} />
      {structure && <StructureDialog base={base} action={structure} onClose={() => setStructure(null)} onSaved={structureSaved} />}
      {saving && <SaveViewDialog onClose={() => setSaving(false)} onSave={async (name, shared) => {
        await api.post(`${base}/saved-views`, { name, viewType: "table", shared, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
        toast({ message: t("viewSaved", { name }) });
        setSaving(false);
        await cache.invalidateQueries({ queryKey: ["saved-views", ws, projectKey] });
      }} />}
      {deleting && <DeleteDialog count={selected.size} onClose={() => setDeleting(false)} onConfirm={async (confirmText) => {
        await api.post(`${base}/issues/bulk`, { keys: [...selected], delete: true, confirmText });
        toast({ message: t("deleted", { count: selected.size }) });
        setDeleting(false);
        setSelected(new Set());
        await reload();
      }} />}
      {reasonFor && <ReasonDialog onClose={() => setReasonFor(null)} onSubmit={async (r) => { const job = reasonFor; setReasonFor(null); await job.run(r); }} />}
    </div>
  );
}

/**
 * List บนมือถือ (≤ 760 px): การ์ดเรียงลงล่าง ไม่มีคอลัมน์ให้เลื่อนขวา · Module / กลุ่มย่อ-ขยายได้ · แตะงานเปิดรายละเอียด
 * แก้ค่าในช่อง / เลือกหลายงานใช้บนจอใหญ่ (เหมือน Gantt / Settings ที่เปิดบนจอใหญ่เท่านั้น)
 */
function MobileList({ display, collapsed, onToggle, ws, projectKey, year, canCreate, taskHref, empty, summary }: {
  display: Display[]; collapsed: Set<string>; onToggle: (id: string) => void; ws: string; projectKey: string; year: YearFormat; canCreate: boolean;
  taskHref: (moduleId?: string | null, phaseId?: string | null) => string; empty: string | null; summary: string;
}) {
  const t = useTranslations("overview-table.table");
  const statusColors = useStatusColors(ws, projectKey);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  if (empty) return <section className={styles.card}><EmptyState title={empty} /></section>;
  const href = (key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/table?issue=${encodeURIComponent(key)}`;
  const chevron = (id: string) => <ChevronDown size={18} aria-hidden="true" style={{ transform: collapsed.has(id) ? "rotate(-90deg)" : undefined }} />;
  return (
    <section className={styles.mList} aria-label={t("listLabel")}>
      {display.map((d) => {
        if (d.kind === "module")
          return (
            <button key={d.id} type="button" className={styles.mModule} aria-expanded={!collapsed.has(d.id)} onClick={() => onToggle(d.id)}>
              {chevron(d.id)}
              {d.color !== null && <span className={styles.swatch} style={{ background: d.color }} />}
              <span className={styles.mModuleText}>
                <b>{d.name}</b>
                <span className={styles.muted}>{d.phases ? t("moduleTasks", { count: d.count, phases: d.phases }) : t("groupTasks", { count: d.count })}{d.from && d.to ? ` · ${formatDate(d.from, year)} – ${formatDate(d.to, year)}` : ""}</span>
              </span>
              <span className={styles.mPct}><span><span style={{ width: `${d.pct}%`, background: d.color ?? "var(--primary)" }} /></span>{d.pct}%</span>
            </button>
          );
        if (d.kind === "phase")
          return (
            <button key={d.id} type="button" className={styles.mPhase} aria-expanded={!collapsed.has(d.id)} onClick={() => onToggle(d.id)}>
              {chevron(d.id)}
              <span className={styles.plabel}>{t("phaseLabel")}</span>
              <b>{d.name}</b>
              <span className={`${styles.pill} ${styles.sTodo}`}>{d.done}/{d.total}</span>
            </button>
          );
        if (d.kind === "add")
          return canCreate ? <Link key={d.id} className={styles.mAdd} href={taskHref(d.moduleId, d.phaseId)} scroll={false}>{t("addTaskIn", { name: d.name })}</Link> : null;
        if (d.kind !== "issue") return null;
        const r = d.row;
        const done = isClosedCategory(r.status.category);
        const due = r.dueDate !== undefined ? r.dueDate : r.planEnd;
        const late = !done && !!due && due < today;
        return (
          <Link key={r.key} href={href(r.key)} scroll={false} className={`${styles.mItem} ${d.sub ? styles.mSub : ""}`}>
            <span className={styles.mItemTop}>
              <span className={styles.mKey}>{r.key}</span>
              <span className={`${styles.pill} ${pillClass(r.status.category, r.status.name)}`} style={statusColorStyle(statusColors.get(r.status.id))}>{r.status.name}</span>
            </span>
            <span className={`${styles.mTitle} ${done ? styles.mDone : ""}`}>{r.title}</span>
            <span className={styles.mMeta}>
              {r.assignees?.length ? <AvatarStack people={r.assignees} max={3} /> : <span className={styles.muted}>{t("unassigned")}</span>}
              {r.planEnd && <span className={late ? styles.dueLate : styles.muted}>{t("dueShort", { date: formatDate(r.planEnd, year) })}</span>}
              {r.progressPct !== null && r.progressPct > 0 && <span className={styles.muted}>{r.progressPct}%</span>}
            </span>
          </Link>
        );
      })}
      <div className={styles.foot}>{summary}</div>
    </section>
  );
}

function IssueRow({ index, row, statusColor, sub, cols, profile, customFields, ws, projectKey, year, canEdit, statuses, people, selected, onSelect, onPatch, onAddSub }: {
  index: number; row: Row; statusColor?: string; sub: boolean; cols: Col[]; profile: FieldProfile; customFields: CustomFieldDef[]; ws: string; projectKey: string; year: YearFormat; canEdit: boolean;
  statuses: { id: string; name: string; category?: string }[]; people: Person[]; selected: boolean; onSelect: (on: boolean) => void;
  onPatch: (body: Record<string, unknown>) => void; onAddSub?: () => void;
}) {
  const t = useTranslations("overview-table.table");
  const href = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/table?issue=${encodeURIComponent(row.key)}`;
  const statusOptions = statuses.some((s) => s.id === row.status.id) ? statuses : [{ id: row.status.id, name: row.status.name }, ...statuses];
  const done = isClosedCategory(row.status.category);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  // โปรเจกต์แยก Dev / QA: งานที่ส่ง QA แล้วตัดสินเลยกำหนดด้วย QA Due ไม่ใช่วันจบของ Dev
  const due = row.dueDate !== undefined ? row.dueDate : row.planEnd;
  const dueCls = !done && due ? (due < today ? styles.dueLate : due === today ? styles.dueToday : "") : "";
  const actualLate = !!(row.actualEnd && row.planEnd && row.actualEnd > row.planEnd);
  // นับเป็นวันปฏิทินจากวันที่ในแผน (YYYY-MM-DD) เพื่อบอกว่าเสร็จช้ากว่าแผนเท่าไร
  const lateBy = actualLate ? Math.round((Date.parse(row.actualEnd!) - Date.parse(row.planEnd!)) / 86400000) : 0;
  const edit = (field: string) => t("edit", { field, key: row.key });
  const empty = <span className={styles.muted}>—</span>;
  const devView = row.assignees?.length ? <span className={styles.avs}><AvatarStack people={row.assignees} max={3} /></span> : empty;
  const baView = row.ba ? <span className={styles.avs}><Avatar size="small" person={row.ba} /></span> : empty;
  const saView = row.sa ? <span className={styles.avs}><Avatar size="small" person={row.sa} /></span> : empty;
  const sizeView = <span style={{ whiteSpace: "nowrap" }}>{row.size ? <span className={`${styles.pill} ${styles.sTodo}`} style={{ fontWeight: 700 }}>{row.size}</span> : empty}{row.estimateMd !== null ? ` ${row.estimateMd}` : ""}</span>;
  const refs = [...(row.requirements ?? []), ...(row.screens ?? [])].join(" · ");
  const remarkView = row.remark ? <span className={styles.remarkText} title={row.remark}>{row.remark}</span> : empty;
  const reviewerView = row.reviewer ? <span className={styles.avs}><Avatar size="small" person={row.reviewer} /></span> : empty;
  const labelText = (row.labels ?? []).map((l) => l.name).join(", ");
  const level: Level = sub ? "subtask" : "task";
  const cell: Record<string, React.ReactNode> = {
    dev: canEdit ? <PeopleCell multiple label={edit(t("cols.dev"))} people={people} value={row.assignees?.map((p) => p.id) ?? []} onChange={(ids) => onPatch({ assigneeIds: ids })}>{devView}</PeopleCell> : devView,
    ba: canEdit ? <PeopleCell label={edit(t("cols.ba"))} people={people} value={row.ba ? [row.ba.id] : []} onChange={(ids) => onPatch({ baId: ids[0] ?? null })}>{baView}</PeopleCell> : baView,
    sa: canEdit ? <PeopleCell label={edit(t("cols.sa"))} people={people} value={row.sa ? [row.sa.id] : []} onChange={(ids) => onPatch({ saId: ids[0] ?? null })}>{saView}</PeopleCell> : saView,
    reviewer: canEdit ? <PeopleCell label={edit(t("cols.reviewer"))} people={people} value={row.reviewer ? [row.reviewer.id] : []} onChange={(ids) => onPatch({ reviewerId: ids[0] ?? null })}>{reviewerView}</PeopleCell> : reviewerView,
    priority: canEdit ? (
      <select className={`${styles.pill} ${styles.pillSelect} ${styles.sTodo}`} aria-label={edit(t("cols.priority"))} value={row.priority} onChange={(e) => onPatch({ priority: e.target.value })}>
        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    ) : <span className={`${styles.pill} ${styles.sTodo}`}>{row.priority}</span>,
    labels: labelText ? <span className={styles.refs} title={labelText}>{labelText}</span> : empty,
    status: canEdit && row.canMove !== false && statuses.length ? (
      <select className={`${styles.pill} ${styles.pillSelect} ${pillClass(row.status.category, row.status.name)}`} style={statusColorStyle(statusColor)} aria-label={edit(t("cols.status"))} value={row.status.id} onChange={(e) => onPatch({ statusId: e.target.value })}>
        {statusOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    ) : <span className={`${styles.pill} ${pillClass(row.status.category, row.status.name)}`} style={statusColorStyle(statusColor)}>{row.status.name}</span>,
    size: canEdit ? <SizeCell label={edit(t("cols.size"))} size={row.size} md={row.estimateMd} onChange={onPatch}>{sizeView}</SizeCell> : sizeView,
    start: canEdit ? <DateCell label={edit(t("cols.start"))} value={row.planStart} onChange={(v) => onPatch({ planStart: v })}>{row.planStart ? formatDate(row.planStart, year) : "—"}</DateCell> : formatDate(row.planStart, year),
    end: canEdit ? <DateCell label={edit(t("cols.end"))} value={row.planEnd} className={dueCls} onChange={(v) => onPatch({ planEnd: v })}>{row.planEnd ? formatDate(row.planEnd, year) : "—"}</DateCell>
      : <span className={dueCls}>{formatDate(row.planEnd, year)}</span>,
    // Actual Start แก้เองได้ (เริ่มก่อนกดสถานะ) · Actual End ระบบตั้งเมื่อสถานะเป็น Done
    actualStart: canEdit ? <DateCell label={edit(t("cell.actualStart"))} value={row.actualStart} max={row.actualEnd ?? today} onChange={(v) => onPatch({ actualStart: v })}>
        {row.actualStart ? formatDate(row.actualStart, year) : "—"}
      </DateCell> : row.actualStart ? formatDate(row.actualStart, year) : empty,
    actualEnd: row.actualEnd ? <span className={styles.actualCell}><span className={actualLate ? styles.dueLate : undefined}>{formatDate(row.actualEnd, year)}</span>{actualLate && <span className={styles.dueLate}>{t("actualLate", { days: lateBy })}</span>}</span> : empty,
    // Canvas: "FR-01.2 · SCR-101" ตัวเล็กสีจาง ตัดด้วย … · แก้ใน Drawer
    refs: refs ? <span className={styles.refs} title={refs}>{refs}</span> : empty,
    progress: <span className={styles.prog}><span><span style={{ width: `${row.progressPct ?? 0}%`, background: (row.progressPct ?? 0) >= 100 ? "var(--success-solid)" : "var(--primary)" }} /></span><span>{row.progressPct ?? 0}%</span></span>,
    remark: canEdit ? <RemarkCell label={edit(t("cols.remark"))} value={row.remark ?? null} onChange={(v) => onPatch({ remark: v })}>{remarkView}</RemarkCell> : remarkView,
  };
  function customCell(c: Col) {
    const field = customFields.find((f) => `cf:${f.id}` === c);
    if (!field) return empty;
    const value = row.customFields?.[field.id] ?? null;
    const text = customText(field, value, people, (iso) => formatDate(iso, year));
    const view = text ? <span className={styles.cfText} title={text}>{text}</span> : empty;
    return canEdit ? <CustomCell label={edit(field.name)} field={field} value={value} people={people} onChange={(v) => onPatch({ customFields: { [field.id]: v } })}>{view}</CustomCell> : view;
  }
  return (
    <tr className={`${styles.itemRow}${selected ? ` ${styles.sel}` : ""}`} data-i={index} data-testid={`row-${row.key}`}>
      <td>
        <div className={styles.name} style={{ paddingLeft: sub ? 54 : 30 }}>
          {canEdit ? <input type="checkbox" className={styles.cb} aria-label={t("select", { key: row.key })} checked={selected} onChange={(e) => onSelect(e.target.checked)} /> : <span style={{ width: 16, flex: "none" }} />}
          <span role="img" aria-label={sub ? t("typeSubtask") : t("typeTask")} className={sub ? styles.typeSub : styles.typeTask}><Check size={12} strokeWidth={3} aria-hidden="true" /></span>
          <span className={styles.key}>{row.key}</span>
          {/* เปิด Drawer โดยไม่เด้งหน้ากลับบนสุด (ตารางใช้ scroll ของหน้าหลัก) */}
          <Link href={href} scroll={false} className={`${styles.nm}${done ? ` ${styles.nmDone}` : ""}`} title={row.title}>{row.title}</Link>
          {onAddSub && <button type="button" className={styles.subAddBtn} aria-label={t("cell.addSubtaskTo", { key: row.key })} onClick={onAddSub}><Plus size={13} aria-hidden="true" />Sub-task</button>}
        </div>
      </td>
      {cols.map((c) => <td key={c}>{
        // ฟิลด์ที่ซ่อนในระดับของแถวนี้ (เช่น Size ของ Sub-task) ไม่แสดงค่าและแก้ไม่ได้
        !columnShowsAt(c, level, profile, customFields) ? <span className={styles.muted} title={t("notUsedAtLevel")}>—</span>
          : c.startsWith("cf:") ? customCell(c) : cell[c]
      }</td>)}
    </tr>
  );
}

function BulkBar({ count, options, statuses, canDelete, onApply, onStatus, onDelete, onClear }: { count: number; options?: Options; statuses: { id: string; name: string }[]; canDelete: boolean; onApply: (set: Record<string, unknown>) => void; onStatus: (id: string) => void; onDelete: () => void; onClear: () => void }) {
  const t = useTranslations("overview-table.table");
  const [moduleId, setModuleId] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [status, setStatus] = useState("");
  // เปิดแผงย่อยใต้ปุ่ม (ไม่ใช้ portal เพื่อให้อยู่ในแถบเดียวกัน)
  const action = (label: string, body: React.ReactNode) => (
    <Popover.Root>
      <Popover.Trigger asChild><button type="button" className={styles.bulkBtn}>{label}</button></Popover.Trigger>
      <Popover.Content className={`popover ${styles.pop}`} sideOffset={6} align="start">{body}</Popover.Content>
    </Popover.Root>
  );
  return (
    <div className={styles.bulk} role="region" aria-label={t("selected", { count })}>
      <b style={{ marginRight: 8 }}>{t("selected", { count })}</b>
      {action(t("bulkStatus"), <>
        <select aria-label={t("bulkStatus")} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("bulkStatus")}</option>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <Button size="small" disabled={!status} onClick={() => onStatus(status)}>{t("apply")}</Button>
      </>)}
      {action(t("bulkAssignee"), <>
        <select aria-label={t("bulkAssignee")} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">{t("bulkAssignee")}</option>{options?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>
        <Button size="small" disabled={!assignee} onClick={() => onApply({ assigneeIds: [assignee] })}>{t("apply")}</Button>
      </>)}
      {action(t("bulkDue"), <>
        <input type="date" aria-label={t("bulkDue")} value={due} onChange={(e) => setDue(e.target.value)} />
        <Button size="small" disabled={!due} onClick={() => onApply({ planEnd: due })}>{t("apply")}</Button>
      </>)}
      {action(t("bulkModule"), <>
        <select aria-label={t("bulkModule")} value={moduleId} onChange={(e) => setModuleId(e.target.value)}><option value="">{t("bulkModule")}</option>{options?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <Button size="small" disabled={!moduleId} onClick={() => onApply({ moduleId })}>{t("apply")}</Button>
      </>)}
      {canDelete && <button type="button" className={styles.bulkBtn} style={{ color: "var(--status-overdue-bg)" }} onClick={onDelete}>{t("delete")}</button>}
      <button type="button" className={`${styles.bulkBtn} ${styles.bulkClear}`} onClick={onClear}>{t("unselect")}</button>
    </div>
  );
}

function SaveViewDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, shared: boolean) => Promise<void> }) {
  const t = useTranslations("overview-table.table");
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  return (
    <Dialog open title={t("saveView")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void onSave(name.trim(), shared); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("viewName")} required value={name} onChange={(e) => setName(e.target.value)} />
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{t("viewShared")}</label>
        <Button type="submit" variant="primary">{t("apply")}</Button>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: (text: string) => Promise<void> }) {
  const t = useTranslations("overview-table.table");
  const phrase = `ลบ ${count} งาน`;
  const [text, setText] = useState("");
  return (
    <Dialog open title={t("deleteTitle")} description={t("deleteDescription")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (text === phrase) void onConfirm(text); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("deleteConfirm", { text: phrase })} value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="danger" disabled={text !== phrase}>{t("delete")}</Button>
      </form>
    </Dialog>
  );
}

function ReasonDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const t = useTranslations("overview-table.table");
  const [reason, setReason] = useState("");
  return (
    <Dialog open title={t("reason")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void onSubmit(reason.trim()); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("reason")} required value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button type="submit" variant="primary">{t("apply")}</Button>
      </form>
    </Dialog>
  );
}

