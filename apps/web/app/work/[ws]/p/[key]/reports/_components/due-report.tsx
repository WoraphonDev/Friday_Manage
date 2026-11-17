"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CalendarDays, ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import { AvatarStack, Badge, EmptyState, ErrorState, Forbidden, LoadingState, type Tone } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { DEFAULT_ITEM_COLOR } from "@/lib/colors";
import { formatDate, formatDateRange, today as todayIso, type YearFormat } from "@/lib/format";
import type { Person } from "@/lib/types";
import { addDays, projectEndpoint, round1, weekStart } from "../../dashboard/_components/types";
import styles from "./reports.module.css";

interface Props { ws: string; projectKey: string; yearFormat: YearFormat; issueHref: (key: string) => string }

type TaskState = "done" | "late" | "at_risk" | "on_track";
type PlanStatus = "done" | "late" | "on_track" | "at_risk" | "off_track" | "no_forecast";
interface ModuleRef { id: string; name: string; color: string | null }
interface DueTask {
  id: string; key: string; title: string; type: string; parentKey: string | null;
  module: ModuleRef | null; phase: string | null; ba: Person | null; sa: Person | null; devs: Person[];
  estimateMd: number | null; planStart: string | null; planEnd: string; progressPct: number;
  status: { name: string; category: string }; state: TaskState;
}
interface DuePlan {
  module: ModuleRef | null; phase: { id: string; name: string } | null;
  taskCount: number; doneCount: number; totalMd: number; doneMd: number; progressPct: number;
  plannedEnd: string; forecastEnd: string | null; forecastReason: "no_estimate" | "no_velocity" | null; slipDays: number | null; status: PlanStatus;
  tasks: Array<{ key: string; title: string; devs: Person[]; estimateMd: number | null; planEnd: string | null; progressPct: number; state: TaskState }>;
}
type PersonOption = Person & { count: number };
export interface DueReportResponse {
  range: { from: string; to: string };
  asOf: string;
  options: { modules: Array<{ id: string; name: string | null; color: string | null; count: number }>; ba: PersonOption[]; sa: PersonOption[]; dev: PersonOption[] };
  summary: { taskCount: number; md: number; doneCount: number; atRiskCount: number; lateCount: number };
  tasks: DueTask[];
  planSummary: { groupCount: number; md: number; progressPct: number; slipCount: number };
  plans: DuePlan[];
  velocity: { windowDays: number };
}

type View = "task" | "plan";
const PEOPLE = ["ba", "sa", "dev"] as const;
type Filter = { view: View; from: string; to: string; modules: string[]; ba: string[]; sa: string[]; dev: string[] };
const NO_MODULE = "none";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** ช่วงลัด · สัปดาห์ = จันทร์–อาทิตย์ แบบเดียวกับรายงานประจำสัปดาห์ */
const PRESETS = ["today", "thisWeek", "nextWeek", "twoWeeks", "thisMonth", "nextMonth"] as const;
type Preset = (typeof PRESETS)[number];
function presetRange(preset: Preset, now: string): [string, string] {
  const monday = weekStart(now);
  const monthStart = `${now.slice(0, 8)}01`;
  const monthEnd = (start: string) => addDays(`${addDays(start, 31).slice(0, 8)}01`, -1);
  switch (preset) {
    case "today": return [now, now];
    case "thisWeek": return [monday, addDays(monday, 6)];
    case "nextWeek": return [addDays(monday, 7), addDays(monday, 13)];
    case "twoWeeks": return [now, addDays(now, 13)];
    case "thisMonth": return [monthStart, monthEnd(monthStart)];
    case "nextMonth": { const next = `${addDays(monthStart, 31).slice(0, 8)}01`; return [next, monthEnd(next)]; }
  }
}

/** ตัวกรองอยู่ใน URL: คัดลอกลิงก์ส่งให้คนอื่นแล้วเห็นรายงานเดียวกัน */
function readFilter(search: URLSearchParams, now: string): Filter {
  const list = (name: string) => (search.get(name) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const [defFrom, defTo] = presetRange("thisWeek", now);
  const from = search.get("from") ?? "";
  const to = search.get("to") ?? "";
  const valid = ISO.test(from) && ISO.test(to) && from <= to;
  return { view: search.get("view") === "plan" ? "plan" : "task", from: valid ? from : defFrom, to: valid ? to : defTo, modules: list("m"), ba: list("ba"), sa: list("sa"), dev: list("dev") };
}

export function DueReport({ ws, projectKey, yearFormat, issueHref }: Props) {
  const t = useTranslations("lead-dashboard-reports.due");
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const now = todayIso();
  const filter = readFilter(search, now);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const setFilter = (patch: Partial<Filter>) => {
    const f = { ...filter, ...patch };
    const next = new URLSearchParams(search);
    next.set("report", "due");
    next.set("view", f.view);
    next.set("from", f.from);
    next.set("to", f.to);
    for (const [k, v] of [["m", f.modules], ["ba", f.ba], ["sa", f.sa], ["dev", f.dev]] as const) {
      if (v.length) next.set(k, v.join(",")); else next.delete(k);
    }
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  const qs = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.modules.length) qs.set("modules", filter.modules.join(","));
  for (const k of PEOPLE) if (filter[k].length) qs.set(k, filter[k].join(","));
  const report = useQuery({
    queryKey: ["reports", ws, projectKey, "due", qs.toString()],
    queryFn: () => api.get<DueReportResponse>(`${projectEndpoint(ws, projectKey)}/reports/due?${qs}`),
    // เปลี่ยนตัวกรองแล้วตารางเดิมค้างไว้ระหว่างโหลด ไม่กระพริบเป็นหน้าโหลด
    placeholderData: keepPreviousData,
  });

  if (report.error instanceof ApiError && report.error.status === 403) return <Forbidden />;
  const data = report.data;
  const filtering = filter.modules.length + filter.ba.length + filter.sa.length + filter.dev.length > 0;
  const noModule = t("noModule");
  const moduleOptions: Option[] = (data?.options.modules ?? []).map((m) => ({ value: m.id, label: m.name ?? noModule, count: m.count, color: m.id === NO_MODULE ? undefined : (m.color ?? DEFAULT_ITEM_COLOR) }));
  const personOptions = (list: PersonOption[] | undefined): Option[] => (list ?? []).map((p) => ({ value: p.id, label: p.displayName, count: p.count }));

  return <>
    <div className={`${styles.card} ${styles.dueBar}`} role="search">
      <div className={styles.seg} role="radiogroup" aria-label={t("viewLabel")}>
        {(["task", "plan"] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={filter.view === v} className={filter.view === v ? styles.segOn : ""} onClick={() => setFilter({ view: v })}>{t(`view.${v}`)}</button>)}
      </div>
      <FilterMenu label={t("module")} options={moduleOptions} selected={filter.modules} onChange={(modules) => setFilter({ modules })} searchable />
      {PEOPLE.map((k) => <FilterMenu key={k} label={t(k)} options={personOptions(data?.options[k])} selected={filter[k]} onChange={(v) => setFilter({ [k]: v })} searchable />)}
      {filtering && <button type="button" className={styles.clearLink} onClick={() => setFilter({ modules: [], ba: [], sa: [], dev: [] })}>{t("clearFilters")}</button>}
      <span className={styles.spacer} />
      <DateRange from={filter.from} to={filter.to} now={now} yearFormat={yearFormat} onChange={(from, to) => setFilter({ from, to })} />
      <button type="button" className="button button-secondary" disabled={!data} onClick={() => data && downloadCsv(data, filter.view, projectKey, t, noModule)}><Download size={14} aria-hidden="true" />{t("export")}</button>
    </div>

    {report.error ? <ErrorState error={report.error} retry={() => void report.refetch()} />
      : !data ? <LoadingState />
        : <div className={styles.swap} aria-busy={report.isFetching}>
          {filter.view === "task" ? <>
            <dl className={styles.dueStats}>
              <Stat label={t("stat.tasks")} value={data.summary.taskCount} unit={t("unit.tasks")} />
              <Stat label={t("stat.md")} value={round1(data.summary.md)} unit="MD" />
              <Stat label={t("stat.done")} value={data.summary.doneCount} unit={t("unit.tasks")} tone="ok" />
              <Stat label={t("stat.atRisk")} value={data.summary.atRiskCount + data.summary.lateCount} unit={t("unit.tasks")} tone={data.summary.lateCount ? "bad" : data.summary.atRiskCount ? "warn" : undefined} note={data.summary.lateCount ? t("stat.lateNote", { count: data.summary.lateCount }) : undefined} />
            </dl>
            {!data.tasks.length ? <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
              : <TaskTable tasks={data.tasks} yearFormat={yearFormat} issueHref={issueHref} noModule={noModule} />}
          </> : <>
            <dl className={styles.dueStats}>
              <Stat label={t("stat.plans")} value={data.planSummary.groupCount} unit={t("unit.groups")} />
              <Stat label={t("stat.md")} value={round1(data.planSummary.md)} unit="MD" />
              <Stat label={t("stat.progress")} value={data.planSummary.progressPct} unit="%" />
              <Stat label={t("stat.slip")} value={data.planSummary.slipCount} unit={t("unit.groups")} tone={data.planSummary.slipCount ? "bad" : undefined} />
            </dl>
            {!data.plans.length ? <EmptyState title={t("emptyPlanTitle")} description={t("emptyPlanDescription")} />
              : <PlanTable plans={data.plans} yearFormat={yearFormat} issueHref={issueHref} noModule={noModule} open={open} toggle={(k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />}
            <p className={styles.footNote}>{t("planNote", { days: data.velocity.windowDays })}</p>
          </>}
        </div>}
  </>;
}

function Stat({ label, value, unit, tone, note }: { label: string; value: number; unit: string; tone?: "ok" | "warn" | "bad"; note?: string }) {
  const cls = tone === "bad" ? styles.bad : tone === "warn" ? styles.warn : tone === "ok" ? styles.ok : "";
  return <div className={`${styles.card} ${styles.dueStat}`}>
    <dt>{label}</dt>
    <dd className={cls}>{value} <small>{unit}</small></dd>
    {note && <dd className={styles.small}>{note}</dd>}
  </div>;
}

const STATE_TONE: Record<TaskState, Tone> = { done: "green", late: "red", at_risk: "amber", on_track: "neutral" };

function StateBadge({ task }: { task: { state: TaskState; status?: { name: string } } }) {
  const t = useTranslations("lead-dashboard-reports.due");
  // งานปกติแสดงชื่อสถานะจริง · เลยกำหนด / เสี่ยง แสดงป้ายเตือนแทนให้เห็นทันที
  const text = task.state === "late" || task.state === "at_risk" ? t(`state.${task.state}`) : (task.status?.name ?? t(`state.${task.state}`));
  return <Badge tone={STATE_TONE[task.state]}>{text}</Badge>;
}

function Progress({ pct }: { pct: number }) {
  return <span className={styles.prog}><span className={styles.progBar}><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>{pct}%</span>;
}

function ModuleName({ module, noModule }: { module: ModuleRef | null; noModule: string }) {
  return <span className={styles.mod}>{module && <i style={{ background: module.color ?? DEFAULT_ITEM_COLOR }} aria-hidden="true" />}{module?.name ?? noModule}</span>;
}

function TaskTable({ tasks, yearFormat, issueHref, noModule }: { tasks: DueTask[]; yearFormat: YearFormat; issueHref: (key: string) => string; noModule: string }) {
  const t = useTranslations("lead-dashboard-reports.due");
  const days = new Map<string, DueTask[]>();
  for (const task of tasks) days.set(task.planEnd, [...(days.get(task.planEnd) ?? []), task]);
  return <div className={`${styles.card} ${styles.tableScroll}`}>
    <table className={styles.table} style={{ minWidth: 960 }}>
      <thead><tr><th>{t("col.task")}</th><th>{t("module")}</th><th>{t("ba")}</th><th>{t("sa")}</th><th>{t("dev")}</th><th>MD</th><th>{t("col.planEnd")}</th><th>{t("col.progress")}</th><th>{t("col.status")}</th></tr></thead>
      <tbody>{[...days].map(([day, list]) => <Fragment key={day}>
        <tr className={styles.dayRow}><td colSpan={9}>{formatWeekday(day, yearFormat)}<span>{t("dayTotal", { count: list.length, md: round1(list.reduce((n, x) => n + (x.estimateMd ?? 0), 0)) })}</span></td></tr>
        {list.map((task) => <tr key={task.id}>
          <td><Link className={styles.key} href={issueHref(task.key)}>{task.key}</Link> <Link href={issueHref(task.key)} className={styles.titleLink}>{task.title}</Link>{task.parentKey && <div className={styles.small}>{t("subOf", { key: task.parentKey })}</div>}</td>
          <td><ModuleName module={task.module} noModule={noModule} />{task.phase && <div className={styles.small}>{task.phase}</div>}</td>
          <td>{task.ba?.displayName ?? "—"}</td>
          <td>{task.sa?.displayName ?? "—"}</td>
          <td>{task.devs.length ? <AvatarStack people={task.devs} /> : "—"}</td>
          <td>{task.estimateMd ?? "—"}</td>
          <td>{formatDate(task.planEnd, yearFormat)}</td>
          <td><Progress pct={task.progressPct} /></td>
          <td><StateBadge task={task} /></td>
        </tr>)}
      </Fragment>)}</tbody>
    </table>
  </div>;
}

const PLAN_TONE: Record<PlanStatus, Tone> = { done: "green", on_track: "green", at_risk: "amber", off_track: "red", late: "red", no_forecast: "neutral" };

function PlanTable({ plans, yearFormat, issueHref, noModule, open, toggle }: { plans: DuePlan[]; yearFormat: YearFormat; issueHref: (key: string) => string; noModule: string; open: Set<string>; toggle: (key: string) => void }) {
  const t = useTranslations("lead-dashboard-reports.due");
  const diff = (p: DuePlan) => {
    if (p.status === "done") return t("plan.done");
    if (p.status === "late") return t("plan.late");
    if (p.slipDays === null) return t(`plan.reason.${p.forecastReason ?? "no_velocity"}`);
    return p.slipDays > 0 ? t("plan.slip", { days: p.slipDays }) : t("plan.onTrack");
  };
  return <div className={`${styles.card} ${styles.tableScroll}`}>
    <table className={styles.table} style={{ minWidth: 900 }}>
      <thead><tr><th>{t("col.plan")}</th><th>{t("col.tasks")}</th><th>{t("col.md")}</th><th>{t("col.progress")}</th><th>{t("col.planEnd")}</th><th>{t("col.forecast")}</th><th>{t("col.diff")}</th></tr></thead>
      <tbody>{plans.map((p) => {
        const key = `${p.module?.id ?? NO_MODULE}|${p.phase?.id ?? ""}`;
        const expanded = open.has(key);
        return <Fragment key={key}>
          <tr>
            <td><button type="button" className={styles.expand} aria-expanded={expanded} onClick={() => toggle(key)}>
              {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              <ModuleName module={p.module} noModule={noModule} />{p.phase && <span className={styles.muted}>› {p.phase.name}</span>}
            </button></td>
            <td>{p.doneCount} / {p.taskCount}</td>
            <td>{round1(p.doneMd)} / {round1(p.totalMd)}</td>
            <td><Progress pct={p.progressPct} /></td>
            <td>{formatDate(p.plannedEnd, yearFormat)}</td>
            <td>{p.forecastEnd ? formatDate(p.forecastEnd, yearFormat) : "—"}</td>
            <td><Badge tone={PLAN_TONE[p.status]}>{diff(p)}</Badge></td>
          </tr>
          {expanded && p.tasks.map((task) => <tr key={task.key} className={styles.childRow}>
            <td><Link className={styles.key} href={issueHref(task.key)}>{task.key}</Link> <Link href={issueHref(task.key)} className={styles.titleLink}>{task.title}</Link></td>
            <td colSpan={2} className={styles.small}>{[task.devs.map((d) => d.displayName).join(", "), task.estimateMd !== null ? `${task.estimateMd} MD` : ""].filter(Boolean).join(" · ") || "—"}</td>
            <td><Progress pct={task.progressPct} /></td>
            <td>{task.planEnd ? formatDate(task.planEnd, yearFormat) : "—"}</td>
            <td colSpan={2}>{(task.state === "late" || task.state === "at_risk" || task.state === "done") && <StateBadge task={task} />}</td>
          </tr>)}
        </Fragment>;
      })}</tbody>
    </table>
  </div>;
}

function formatWeekday(date: string, yearFormat: YearFormat) {
  const weekday = new Intl.DateTimeFormat(typeof document !== "undefined" && document.documentElement.lang === "en" ? "en-US" : "th-TH", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  return `${weekday} ${formatDate(date, yearFormat, true)}`;
}

// ---------------------------------------------------------------------------
// ตัวกรองแบบเลือกหลายค่า (รูปแบบเดียวกับ My Tasks)
// ---------------------------------------------------------------------------
interface Option { value: string; label: string; count: number; color?: string }

/** ปิดเมนูเมื่อคลิกนอกกรอบหรือกด Esc */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open, close]);
  return ref;
}

function FilterMenu({ label, options, selected, onChange, searchable }: { label: string; options: Option[]; selected: string[]; onChange: (v: string[]) => void; searchable?: boolean }) {
  const t = useTranslations("lead-dashboard-reports.due");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const menuId = useId();
  // ค่าที่เลือกไว้ (เช่นจากลิงก์) แต่ไม่มีในตัวเลือกแล้วยังต้องเห็นเพื่อเอาติ๊กออกได้
  const all: Option[] = [...options, ...selected.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: "—", count: 0 }))];
  const names = selected.map((v) => all.find((o) => o.value === v)?.label ?? v);
  const text = names.length === 0 ? label : names.length === 1 ? `${label}: ${names[0]}` : `${label}: ${names[0]} +${names.length - 1}`;
  const shown = q.trim() ? all.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : all;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return <div ref={ref} className={styles.ddWrap}>
    <button type="button" className={`${styles.dd} ${selected.length ? styles.ddOn : ""}`} aria-haspopup="true" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((o) => !o)}>
      <span className={styles.ddText}>{text}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div id={menuId} className={`${styles.menu} motion-in`} role="group" aria-label={label}>
      {searchable && <label className={styles.menuSearch}><Search size={13} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchIn", { name: label })} aria-label={t("searchIn", { name: label })} autoFocus /></label>}
      <div className={styles.menuList}>
        {shown.length === 0 && <div className={styles.menuEmpty}>{t("noOptions")}</div>}
        {shown.map((o) => <label key={o.value} className={styles.opt}>
          <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
          {o.color && <span className={styles.sw} style={{ background: o.color }} />}
          <span className={styles.optLabel}>{o.label}</span><span className={styles.optN}>{o.count}</span>
        </label>)}
      </div>
      <div className={styles.menuFoot}>
        <button type="button" onClick={() => onChange([])} disabled={!selected.length}>{t("clear")}</button>
        <button type="button" onClick={() => onChange([...new Set([...selected, ...shown.map((o) => o.value)])])}>{t("selectAll")}</button>
      </div>
    </div>}
  </div>;
}

function DateRange({ from, to, now, yearFormat, onChange }: { from: string; to: string; now: string; yearFormat: YearFormat; onChange: (from: string, to: string) => void }) {
  const t = useTranslations("lead-dashboard-reports.due");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from, to });
  const ref = useDismiss(open, () => setOpen(false));
  const id = useId();
  const valid = ISO.test(draft.from) && ISO.test(draft.to) && draft.from <= draft.to;
  const active = PRESETS.find((p) => { const [a, b] = presetRange(p, now); return a === draft.from && b === draft.to; });
  const show = () => { setDraft({ from, to }); setOpen((o) => !o); };
  return <div ref={ref} className={styles.ddWrap}>
    <button type="button" className={`${styles.dd} ${styles.ddOn}`} aria-haspopup="dialog" aria-expanded={open} aria-label={t("rangeLabel", { range: formatDateRange(from, to, yearFormat) })} onClick={show}>
      <CalendarDays size={14} aria-hidden="true" /><span className={styles.ddText}>{formatDateRange(from, to, yearFormat)}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className={`${styles.menu} ${styles.rangeMenu} motion-in`} role="dialog" aria-label={t("rangeTitle")}>
      <b className={styles.rangeTitle}>{t("rangeTitle")}</b>
      <div className={styles.chips}>{PRESETS.map((p) => <button key={p} type="button" className={active === p ? styles.chipOn : ""} aria-pressed={active === p} onClick={() => { const [a, b] = presetRange(p, now); setDraft({ from: a, to: b }); }}>{t(`preset.${p}`)}</button>)}</div>
      <div className={styles.rangeInputs}>
        <label htmlFor={`${id}-from`}>{t("from")}<input id={`${id}-from`} className="input" type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} /></label>
        <label htmlFor={`${id}-to`}>{t("to")}<input id={`${id}-to`} className="input" type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} /></label>
      </div>
      {!valid && <span className="field-error">{t("rangeInvalid")}</span>}
      <div className={styles.rangeFoot}>
        <button type="button" className="button button-ghost" onClick={() => setOpen(false)}>{t("cancel")}</button>
        <button type="button" className="button button-primary" disabled={!valid} onClick={() => { onChange(draft.from, draft.to); setOpen(false); }}>{t("apply")}</button>
      </div>
    </div>}
  </div>;
}

// ---------------------------------------------------------------------------
// ส่งออก: CSV แบบ UTF-8 มี BOM เปิดใน Excel แล้วภาษาไทยไม่เพี้ยน
// ---------------------------------------------------------------------------
function downloadCsv(data: DueReportResponse, view: View, projectKey: string, t: (key: string) => string, noModule: string) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: Array<Array<string | number | null>> = view === "task"
    ? [
      [t("col.key"), t("col.task"), t("col.parent"), t("module"), t("col.phase"), t("ba"), t("sa"), t("dev"), "MD", t("col.planStart"), t("col.planEnd"), t("col.progress"), t("col.status"), t("col.state")],
      ...data.tasks.map((x) => [x.key, x.title, x.parentKey, x.module?.name ?? noModule, x.phase, x.ba?.displayName ?? null, x.sa?.displayName ?? null, x.devs.map((d) => d.displayName).join(", "), x.estimateMd, x.planStart, x.planEnd, x.progressPct, x.status.name, t(`state.${x.state}`)]),
    ]
    : [
      [t("module"), t("col.phase"), t("col.doneTasks"), t("col.allTasks"), t("col.doneMd"), t("col.planMd"), t("col.progress"), t("col.planEnd"), t("col.forecast"), t("col.slipDays")],
      ...data.plans.map((p) => [p.module?.name ?? noModule, p.phase?.name ?? null, p.doneCount, p.taskCount, p.doneMd, p.totalMd, p.progressPct, p.plannedEnd, p.forecastEnd, p.slipDays]),
    ];
  const csv = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectKey}-${view === "task" ? "tasks" : "plans"}-${data.range.from}_${data.range.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
