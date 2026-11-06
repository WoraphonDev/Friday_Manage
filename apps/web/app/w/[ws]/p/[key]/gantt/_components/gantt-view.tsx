"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";
import { Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import styles from "./gantt.module.css";

type Cat = "todo" | "in_progress" | "done";
export interface GRow {
  key: string; type: string; title: string; status: { name: string; category: Cat };
  start: string; end: string; estimateMd?: number | null; progressPct: number; lateDays: number;
  assignees?: Person[]; canOpen?: boolean; subtasks: GRow[];
  critical?: boolean; slackDays?: number | null;
  baseline?: { start: string | null; end: string | null } | null; slipDays?: number | null;
}
interface Summary { start: string | null; end: string | null; progressPct: number; lateDays: number; taskCount: number }
export type DepType = "FS" | "SS" | "FF" | "SF";
export interface Dependency { from: string; to: string; type: DepType; lagDays: number; critical: boolean }
export interface GanttData {
  project: { key: string; name: string; startDate: string; goliveDate: string };
  today: string;
  range: { from: string; to: string };
  lastEnd: string | null;
  sprints: { id: string; number: number; name: string; startDate: string; endDate: string; status: string }[];
  milestones: { id: string; name: string; date: string; moduleId: string | null }[];
  modules: (Summary & { id: string | null; name: string; color: string | null; groups: (Summary & { phase: { id: string } | null; name: string; tasks: GRow[] })[] })[];
  unscheduled: { key: string }[];
  baselines: { version: number; name: string; source: string; createdAt: string }[];
  baseline: { version: number; name: string; createdAt: string } | null;
  dependencies: Dependency[];
  criticalPath: { keys: string[]; startDate: string | null; endDate: string | null };
  ignoredDependencies: number;
}
export interface PreviewItem { key: string; title: string; planStart: string; planEnd: string; previousStart: string | null; previousEnd: string | null; shiftDays: number; because: string[] }
export interface Preview { items: PreviewItem[]; summary: { moved: number; checked: number }; projectEnd: { before: string | null; after: string | null }; warnings: { code: string; message: string }[] }

export type Scale = "day" | "week" | "month";
/** Day = 21px ต่อวันตาม Canvas */
export const SCALE_PX: Record<Scale, number> = { day: 21, week: 8, month: 3 };
export const RH = 36;
const DAY = 86_400_000;
const PALETTE = ["#1d4ed8", "#b45309", "#0f766e", "#7c3aed", "#be185d", "#0369a1", "#4d7c0f", "#c2410c"];
const WD = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

export const toDay = (iso: string, from: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
/** วันที่ 1 ของเดือนถัดไป */
const nextMonth = (iso: string) => addDays(`${iso.slice(0, 8)}01`, 32).slice(0, 8) + "01";

type Line =
  | { kind: "module" | "group"; id: string; wbs: string; name: string; s: Summary }
  | { kind: "task"; wbs: string; row: GRow; depth: 2 | 3 }
  | { kind: "ms"; id: string; wbs: string; name: string; date: string };

/** แตก WBS เป็นแถวตามระดับที่ขยาย · 1 = Module, 2 = + กลุ่มงาน, 3 = ถึง Sub-task */
export function buildLines(d: GanttData, level: 1 | 2 | 3): Line[] {
  const out: Line[] = [];
  let msNo = 0;
  const ms = (moduleId: string | null) => {
    for (const m of d.milestones.filter((x) => x.moduleId === moduleId)) out.push({ kind: "ms", id: m.id, wbs: `M${++msNo}`, name: m.name, date: m.date });
  };
  const known = new Set(d.modules.map((m) => m.id));
  d.modules.forEach((m, mi) => {
    const mw = String(mi + 1);
    out.push({ kind: "module", id: `m:${m.id ?? "none"}`, wbs: mw, name: m.name, s: m });
    if (level < 2) return;
    m.groups.forEach((g, gi) => {
      const gw = `${mw}.${gi + 1}`;
      out.push({ kind: "group", id: `m:${m.id ?? "none"}:g:${g.phase?.id ?? gi}`, wbs: gw, name: g.name, s: g });
      if (level < 3) return;
      g.tasks.forEach((r, ti) => {
        const tw = `${gw}.${ti + 1}`;
        out.push({ kind: "task", wbs: tw, row: r, depth: 2 });
        r.subtasks.forEach((sub, si) => out.push({ kind: "task", wbs: `${tw}.${si + 1}`, row: sub, depth: 3 }));
      });
    });
    if (level >= 2) ms(m.id);
  });
  // Milestone ที่ไม่ผูก Module (หรือ Module ที่ไม่อยู่ในรายการ) ไว้ท้ายสุด
  if (level >= 2) for (const m of d.milestones.filter((x) => x.moduleId === null || !known.has(x.moduleId))) out.push({ kind: "ms", id: m.id, wbs: `M${++msNo}`, name: m.name, date: m.date });
  return out;
}

/**
 * เส้น Dependency แบบมุมฉากแบบ Canvas · ปลายต้นทางคือวันจบ (F) หรือวันเริ่ม (S)
 * ปลายทางเข้าทางซ้ายของวันเริ่ม (S) หรือทางขวาของวันจบ (F) · คืน [เส้น, หัวลูกศร]
 */
export function depPath(type: DepType, from: { x0: number; x1: number; y: number }, to: { x0: number; x1: number; y: number; top: number }) {
  const out = type[0] === "F" ? 1 : -1;
  const enter = type[1] === "S" ? 1 : -1;
  const x1 = out === 1 ? from.x1 : from.x0;
  const x2 = enter === 1 ? to.x0 : to.x1;
  const ox = x1 + out * 7;
  const path = enter * (x2 - ox) >= 7
    ? `M${x1} ${from.y} H${ox} V${to.y} H${x2}`
    : `M${x1} ${from.y} H${ox} V${to.top} H${x2 - enter * 8} V${to.y} H${x2}`;
  const arrow = `M${x2} ${to.y} L${x2 - enter * 6} ${to.y - 4} L${x2 - enter * 6} ${to.y + 4} Z`;
  return [path, arrow] as const;
}

const initials = (p: Person) => p.initials ?? p.displayName.replace(/\s+/g, "").slice(0, 2).toUpperCase();
const colorOf = (p: Person) => p.color ?? PALETTE[[...p.id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const short = (iso: string | null, year: YearFormat) => (iso ? formatDate(iso, year).split(" ").slice(0, 2).join(" ") : "—");

export function GanttView({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("gantt");
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const [scale, setScale] = useState<Scale>("day");
  const [level, setLevel] = useState<1 | 2 | 3>(3);
  const [critOn, setCritOn] = useState(true);
  // undefined = ยังไม่เลือก → เลือก Baseline ล่าสุดให้เมื่อรู้รายการ (Canvas เปิด "แผน vs จริง" ไว้) · null = ปิด
  const [baseVer, setBaseVer] = useState<number | null | undefined>(undefined);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const q = useQuery({
    queryKey: ["gantt", ws, projectKey, baseVer ?? null],
    queryFn: () => api.get<GanttData>(`${base}/gantt${baseVer ? `?baseline=v${baseVer}` : ""}`),
    placeholderData: keepPreviousData,
    enabled: perms.isSuccess && !perms.data.guestViewer,
  });
  const latest = q.data?.baselines.reduce((m, b) => Math.max(m, b.version), 0) ?? 0;
  useEffect(() => {
    if (baseVer === undefined && q.data && !q.isPlaceholderData) setBaseVer(latest || null);
  }, [baseVer, q.data, q.isPlaceholderData, latest]);

  const has = (p: string) => !!perms.data?.permissions.includes(p) && !perms.data.guestViewer;
  const canEdit = has("issue.edit");
  const canBaseline = has("project.baseline");
  const px = SCALE_PX[scale];
  const lines = useMemo(() => (q.data ? buildLines(q.data, level) : []), [q.data, level]);

  if (perms.isPending || (q.isPending && !perms.data?.guestViewer && !perms.error)) return <div className={styles.page}><LoadingState /></div>;
  if (perms.data?.guestViewer) return <div className={styles.page}><Forbidden /></div>;
  const err = perms.error ?? q.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => q.refetch()} />}</div>;
  const d = q.data!;

  // แกนเริ่มวันจันทร์ก่อนช่วงข้อมูล · เผื่อท้าย 14 วัน
  const from = addDays(d.range.from, -((weekday(d.range.from) + 6) % 7));
  const days = Math.max(28, toDay(d.range.to, from) + 14);
  const width = days * px;
  const height = Math.max(1, lines.length) * RH;
  const x = (iso: string) => toDay(iso, from) * px;
  const inset = px >= 10 ? 2 : 0;
  const span = (s: string, e: string) => ({ left: x(s) + inset, width: Math.max(3, (toDay(e, s) + 1) * px - inset * 2) });
  const issueHref = (key: string) => `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/gantt?issue=${encodeURIComponent(key)}`;
  const empty = !d.modules.some((m) => m.groups.length);

  // หัวแกน: สัปดาห์ (Day / Week) หรือเดือน (Month) · แถววันแสดงเฉพาะ Day
  const top: { left: number; width: number; label: string }[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const startOfUnit = scale === "month" ? day.endsWith("-01") || i === 0 : weekday(day) === 1;
    if (!startOfUnit) continue;
    const unitEnd = Math.min(days, i + (scale === "month" ? toDay(nextMonth(day), day) : 7));
    const last = addDays(from, unitEnd - 1);
    const label = scale === "month" ? formatDate(day, year).split(" ").slice(1).join(" ") : `${short(day, year)} – ${short(last, year)}`;
    top.push({ left: i * px, width: (unitEnd - i) * px, label });
  }
  const weekends = Array.from({ length: days }, (_, i) => i).filter((i) => [0, 6].includes(weekday(addDays(from, i))));

  // ตำแหน่งแถวของแต่ละงาน (เฉพาะที่แสดงอยู่) สำหรับวาด Dependency
  const rowOf = new Map<string, { i: number; row: GRow }>();
  lines.forEach((ln, i) => { if (ln.kind === "task") rowOf.set(ln.row.key, { i, row: ln.row }); });
  const wbsOf = new Map(lines.flatMap((ln) => (ln.kind === "task" ? [[ln.row.key, ln.wbs] as const] : [])));
  const predOf = (key: string) => d.dependencies.filter((dep) => dep.to === key).map((dep) => `${wbsOf.get(dep.from) ?? dep.from} ${dep.type}${dep.lagDays ? (dep.lagDays > 0 ? `+${dep.lagDays}` : dep.lagDays) : ""}`).join(", ");
  const arrows = d.dependencies.flatMap((dep) => {
    const a = rowOf.get(dep.from);
    const b = rowOf.get(dep.to);
    if (!a || !b) return [];
    const sa = span(a.row.start, a.row.end);
    const sb = span(b.row.start, b.row.end);
    const [path, head] = depPath(dep.type, { x0: sa.left, x1: sa.left + sa.width, y: a.i * RH + 18 }, { x0: sb.left, x1: sb.left + sb.width, y: b.i * RH + 18, top: b.i * RH });
    return [{ id: `${dep.from}-${dep.to}`, path, head, critical: critOn && dep.critical }];
  });

  const all = d.modules.flatMap((m) => m.groups.flatMap((g) => g.tasks.flatMap((r) => [r, ...r.subtasks])));
  const lateCount = all.filter((r) => r.lateDays > 0 && r.subtasks.length === 0).length;
  const slipCount = d.baseline ? all.filter((r) => (r.slipDays ?? 0) > 0 && r.subtasks.length === 0).length : 0;
  const scrollToToday = () => scrollRef.current?.scrollTo?.({ left: Math.max(0, x(d.today) - 200), behavior: "smooth" });

  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <div className={styles.seg} role="group" aria-label={t("scale.label")}>
          {(["day", "week", "month"] as const).map((s) => <button key={s} type="button" aria-pressed={scale === s} onClick={() => setScale(s)}>{t(`scale.${s}`)}</button>)}
        </div>
        <div className={styles.seg} role="group" aria-label={t("level.label")}>
          {([1, 2, 3] as const).map((n) => (
            <button key={n} type="button" aria-pressed={level === n} title={t("level.hint", { n, what: t(`level.what${n}`) })} onClick={() => setLevel(n)}>{t(`level.${["one", "two", "three"][n - 1]}`)}</button>
          ))}
        </div>
        <Button size="small" onClick={scrollToToday}>{t("today")}</Button>
        <span className="muted" style={{ fontSize: 13 }}>{formatDate(d.range.from, year)} – {formatDate(d.range.to, year)}</span>
        <span style={{ flex: 1 }} />
        {canEdit && <Button onClick={() => setAutoOpen(true)}>{t("autoSchedule")}</Button>}
        <Button className={styles.toggle} aria-pressed={critOn} onClick={() => setCritOn((c) => !c)}>{t("critical")}</Button>
        <Button className={styles.toggle} aria-pressed={!!baseVer} disabled={!latest} title={latest ? undefined : t("noBaseline")} onClick={() => setBaseVer(baseVer ? null : latest)}>{t("baselineToggle")}</Button>
        {!!baseVer && (
          <Select aria-label={t("baselineSelect")} size="small" value={String(baseVer)} onChange={(e) => setBaseVer(Number(e.target.value))}>
            {[...d.baselines].sort((a, b) => b.version - a.version).map((b) => <option key={b.version} value={b.version}>{t("baselineOption", { version: b.version, name: b.name })}</option>)}
          </Select>
        )}
        {canBaseline && <Button onClick={() => setBaselineOpen(true)}>{t("setBaseline", { version: latest + 1 })}</Button>}
      </div>

      {(lateCount > 0 || slipCount > 0 || d.ignoredDependencies > 0) && (
        <div className={styles.alert} role="status">
          <TriangleAlert size={18} color="#c2410c" aria-hidden="true" />
          <span>{[lateCount && t("alertLate", { count: lateCount }), slipCount && t("alertSlip", { count: slipCount, version: d.baseline!.version }), d.ignoredDependencies && t("alertIgnored", { count: d.ignoredDependencies })].filter(Boolean).join(" · ")}</span>
          <Link href={`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/members`}>{t("workload")}</Link>
        </div>
      )}

      {empty ? <section className={styles.card}><EmptyState title={t("empty")} description={t("emptyHint")} /></section> : (
        <section className={styles.card} ref={scrollRef} data-testid="gantt-scroll">
          <div className={styles.inner} style={{ minWidth: 540 + width }}>
            <div className={styles.left}>
              <div className={`${styles.lg} ${styles.head}`} role="row">
                {(["wbs", "task", "owner", "md", "start", "end", "pct", "pred"] as const).map((c, i) => <div key={c} className={i > 1 ? styles.opt : undefined}>{t(`cols.${c}`)}</div>)}
              </div>
              {lines.map((ln) => {
                if (ln.kind === "ms") return (
                  <div key={ln.id} className={styles.lg}>
                    <div className={styles.wbs}>{ln.wbs}</div>
                    <div className={styles.nm} style={{ paddingLeft: 14 }}>{ln.name}</div>
                    <div className={styles.opt} /><div className={styles.opt}>—</div><div className={styles.opt}>{short(ln.date, year)}</div><div className={styles.opt}>{short(ln.date, year)}</div><div className={styles.opt}>—</div><div className={styles.opt} />
                  </div>
                );
                if (ln.kind !== "task") return (
                  <div key={ln.id} className={`${styles.lg} ${ln.kind === "module" ? styles.mod : styles.sum}`}>
                    <div className={styles.wbs}>{ln.wbs}</div>
                    <div className={styles.nm} style={{ paddingLeft: ln.kind === "module" ? 0 : 14 }} title={ln.name}>{ln.name}</div>
                    <div className={styles.opt} /><div className={styles.opt} />
                    <div className={styles.opt}>{short(ln.s.start, year)}</div><div className={styles.opt}>{short(ln.s.end, year)}</div>
                    <div className={styles.opt}>{ln.s.progressPct}%</div><div className={styles.opt} />
                  </div>
                );
                const r = ln.row;
                const owner = r.assignees?.[0];
                return (
                  <div key={r.key} className={`${styles.lg} ${r.subtasks.length ? styles.sum : ""}`}>
                    <div className={styles.wbs}>{ln.wbs}</div>
                    {r.canOpen !== false
                      ? <Link className={styles.nm} style={{ paddingLeft: ln.depth * 14 }} href={issueHref(r.key)} title={`${r.key} ${r.title}`}>{r.key} {r.title}</Link>
                      : <span className={styles.nm} style={{ paddingLeft: ln.depth * 14 }} title={r.title}>{r.key} {r.title}</span>}
                    <div className={styles.opt}>{owner && <span className={styles.av} style={{ background: colorOf(owner) }} title={owner.displayName}>{initials(owner)}</span>}</div>
                    <div className={styles.opt}>{r.estimateMd ?? "—"}</div>
                    <div className={styles.opt}>{short(r.start, year)}</div>
                    <div className={styles.opt}>{short(r.end, year)}</div>
                    <div className={styles.opt}>{r.progressPct}%</div>
                    <div className={`${styles.opt} ${styles.wbs}`} data-testid={`pred-${r.key}`}>{predOf(r.key)}</div>
                  </div>
                );
              })}
            </div>

            <div className={styles.chart} style={{ width }}>
              <div className={styles.axis} data-testid="axis">
                <div className={styles.axisTop}>{top.map((u) => <div key={u.left} className={styles.wk} style={{ left: u.left, width: u.width }}>{u.label}</div>)}</div>
                {scale === "day" && (
                  <div className={styles.axisDay}>
                    {Array.from({ length: days }, (_, i) => {
                      const day = addDays(from, i);
                      const cls = `${styles.dy} ${[0, 6].includes(weekday(day)) ? styles.we : ""} ${day === d.today ? styles.now : ""}`;
                      return <div key={i} className={cls} style={{ left: i * px, width: px }}>{WD[weekday(day)]}<b>{Number(day.slice(8))}</b></div>;
                    })}
                  </div>
                )}
              </div>
              <div className={styles.plot} style={{ height }}>
                {scale !== "month" && weekends.map((i) => <span key={i} className={styles.weekend} style={{ left: i * px, width: px }} />)}
                {lines.map((ln, i) => {
                  const y = i * RH;
                  if (ln.kind === "ms") return (
                    <span key={ln.id}>
                      <svg className={styles.ms} style={{ left: x(ln.date) + px - 9, top: y + 9 }} width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={t("milestone", { name: ln.name, date: formatDate(ln.date, year) })}><rect x="3.5" y="3.5" width="11" height="11" transform="rotate(45 9 9)" fill="#1b1f24" /></svg>
                      <span className={styles.msLabel} style={{ left: x(ln.date) + px + 13, top: y + 8 }}>{ln.name}</span>
                    </span>
                  );
                  const summary = ln.kind !== "task" ? ln.s : ln.row.subtasks.length ? ln.row : null;
                  if (summary) {
                    if (!summary.start || !summary.end) return null;
                    const sc = ln.kind === "module" ? "#1b1f24" : "#5f6873";
                    const name = ln.kind === "task" ? `${ln.row.key} ${ln.row.title}` : ln.name;
                    return <span key={ln.kind === "task" ? ln.row.key : ln.id} className={styles.sb} role="img" aria-label={t("summaryBar", { name, start: formatDate(summary.start, year), end: formatDate(summary.end, year), pct: summary.progressPct })} style={{ left: x(summary.start), width: Math.max(3, (toDay(summary.end, summary.start) + 1) * px), top: y + 12, background: sc, "--sc": sc } as CSSProperties} />;
                  }
                  if (ln.kind !== "task") return null;
                  const r = ln.row;
                  const crit = critOn && !!r.critical;
                  const pos = span(r.start, r.end);
                  const slip = d.baseline && r.slipDays ? r.slipDays : 0;
                  const label = [
                    t("bar", { key: r.key, title: r.title, start: formatDate(r.start, year), end: formatDate(r.end, year), pct: r.progressPct }),
                    crit && t("barCritical"),
                    r.slackDays != null && r.slackDays > 0 && t("slack", { days: r.slackDays }),
                    r.lateDays > 0 && t("late", { days: r.lateDays }),
                    slip > 0 && t("slipLate", { days: slip }),
                    slip < 0 && t("slipEarly", { days: -slip }),
                  ].filter(Boolean).join(" · ");
                  const fill = <span style={{ width: `${r.progressPct}%`, background: crit ? "#dc2626" : "#2563eb" }} />;
                  const barStyle = { ...pos, top: y + 8, background: crit ? "#fecaca" : "#bfdbfe" };
                  const bl = d.baseline && r.baseline?.start && r.baseline.end ? r.baseline : null;
                  return (
                    <span key={r.key}>
                      {bl && <span className={styles.base} data-testid={`baseline-${r.key}`} title={t("baselineBar", { start: formatDate(bl.start, year), end: formatDate(bl.end, year) })} style={{ ...span(bl.start!, bl.end!), top: y + 29 }} />}
                      {r.canOpen !== false
                        ? <Link href={issueHref(r.key)} className={`${styles.gb} ${r.lateDays ? styles.late : ""}`} style={barStyle} aria-label={label} title={label} data-testid={`bar-${r.key}`} data-critical={crit || undefined}>{fill}</Link>
                        : <span className={`${styles.gb} ${r.lateDays ? styles.late : ""}`} style={barStyle} role="img" aria-label={label} title={label} data-testid={`bar-${r.key}`} data-critical={crit || undefined}>{fill}</span>}
                      {scale !== "month" && (r.assignees?.[0] || slip > 0) && (
                        <span className={styles.who} style={{ left: pos.left + pos.width + 6, top: y + 8 }}>
                          {r.assignees?.[0]?.displayName}
                          {slip > 0 && <span className={styles.slip}>{t("slipShort", { days: slip })}</span>}
                        </span>
                      )}
                    </span>
                  );
                })}
                <svg className={styles.deps} width={width} height={height} aria-hidden="true">
                  {arrows.map((a) => (
                    <g key={a.id} data-testid={`dep-${a.id}`} data-critical={a.critical || undefined}>
                      <path d={a.path} fill="none" stroke={a.critical ? "#dc2626" : "#6b7480"} strokeWidth={a.critical ? 1.8 : 1.5} />
                      <path d={a.head} fill={a.critical ? "#dc2626" : "#6b7480"} />
                    </g>
                  ))}
                </svg>
                <span className={styles.todayLine} style={{ left: x(d.today) + px / 2 - 1 }} />
              </div>
            </div>
          </div>
        </section>
      )}

      <div className={styles.legend}>
        <span><span className={styles.sw} style={{ background: "#bfdbfe" }}><i style={{ background: "#2563eb" }} /></span>{t("legend.task")}</span>
        <span><span className={styles.sw} style={{ background: "#fecaca" }}><i style={{ background: "#dc2626" }} /></span>{t("legend.critical")}</span>
        <span><span className={styles.sw} style={{ height: 6, borderRadius: 0, background: "#1b1f24" }} />{t("legend.summary")}</span>
        <span><span className={styles.sw} style={{ height: 5, background: "#a3acb8" }} />{t("legend.baseline")}</span>
        {d.criticalPath.keys.length > 0 && <span>{t("criticalSummary", { count: d.criticalPath.keys.length, start: formatDate(d.criticalPath.startDate, year), end: formatDate(d.criticalPath.endDate, year) })}</span>}
        {d.unscheduled.length > 0 && <span>{t("unscheduled", { count: d.unscheduled.length })}</span>}
      </div>

      {baselineOpen && (
        <BaselineDialog
          next={latest + 1}
          onClose={() => setBaselineOpen(false)}
          onSave={async (name) => {
            const created = await api.post<{ version: number }>(`${base}/baselines`, name ? { name } : {});
            setBaselineOpen(false);
            toast({ message: t("baselineDialog.done", { version: created.version }) });
            setBaseVer(created.version);
            await cache.invalidateQueries({ queryKey: ["gantt", ws, projectKey] });
          }}
        />
      )}
      {autoOpen && <AutoScheduleDialog ws={ws} base={base} year={year} onClose={() => setAutoOpen(false)} onChanged={() => cache.invalidateQueries({ queryKey: ["gantt", ws, projectKey] })} />}
    </div>
  );
}

function BaselineDialog({ next, onClose, onSave }: { next: number; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const t = useTranslations("gantt");
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open title={t("baselineDialog.title")} description={t("baselineDialog.body", { version: next })} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form
        className={styles.stack}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try { await onSave(name.trim()); } catch (err) { setError(err); setBusy(false); }
        }}
      >
        <Input label={t("baselineDialog.name")} placeholder={`Baseline v${next}`} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        {!!error && <ErrorState error={error} />}
        <div className={styles.actions}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary" disabled={busy}>{t("baselineDialog.submit")}</Button></div>
      </form>
    </Dialog>
  );
}

type Outcome = { key: string; due: string; status: "ok" | "approval" | "failed"; message?: string };
type Phase = { name: "loading" } | { name: "preview"; data: Preview } | { name: "applying"; data: Preview; done: number } | { name: "reason"; data: Preview; at: number; results: Outcome[] } | { name: "result"; results: Outcome[] } | { name: "error"; error: unknown };

/** ดูตัวอย่าง Auto-schedule แล้วยืนยันด้วย PATCH ทีละงาน (bulk ยังรับวันต่างกันต่องานไม่ได้ · ดู A07) */
function AutoScheduleDialog({ ws, base, year, onClose, onChanged }: { ws: string; base: string; year: YearFormat; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations("gantt");
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [reason, setReason] = useState("");
  const [requestFor, setRequestFor] = useState<Outcome | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api.post<Preview>(`${base}/schedule/preview`).then(
      (data) => { if (live) setPhase({ name: "preview", data }); },
      (error) => { if (live) setPhase({ name: "error", error }); },
    );
    return () => { live = false; };
  }, [base]);

  async function apply(data: Preview, at: number, results: Outcome[], why?: string) {
    const out = [...results];
    for (let i = at; i < data.items.length; i++) {
      const it = data.items[i];
      setPhase({ name: "applying", data, done: i });
      const path = `/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(it.key)}`;
      try {
        // preview ไม่ส่ง version จึงอ่านงานล่าสุดก่อนแก้ (If-Match)
        const issue = await api.get<{ version: number }>(path);
        const body = { planStart: it.planStart, planEnd: it.planEnd, ...(why ? { planChangeReason: why } : {}) };
        await api.patch(path, body, issue.version);
        out.push({ key: it.key, due: it.planEnd, status: "ok" });
      } catch (e) {
        if (e instanceof ApiError && e.code === "plan_change_reason_required" && !why) {
          // หยุดถามเหตุผลครั้งเดียว แล้วใช้กับงานที่เหลือทั้งรอบ
          setPhase({ name: "reason", data, at: i, results: out });
          return;
        }
        if (e instanceof ApiError && e.code === "due_change_requires_approval") out.push({ key: it.key, due: it.planEnd, status: "approval" });
        else out.push({ key: it.key, due: it.planEnd, status: "failed", message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof Error ? e.message : String(e) });
      }
    }
    setPhase({ name: "result", results: out });
    onChanged();
  }

  const fmt = (s: string | null, e: string | null) => `${formatDate(s, year)} – ${formatDate(e, year)}`;
  return (
    <>
      <Dialog open={!requestFor} title={t("auto.title")} onOpenChange={(o) => { if (!o && phase.name !== "applying") onClose(); }}>
        <div className={styles.stack}>
          {phase.name === "loading" && <><p className="muted" style={{ margin: 0 }}>{t("auto.loading")}</p><LoadingState /></>}
          {phase.name === "error" && <ErrorState error={phase.error} />}
          {(phase.name === "preview" || phase.name === "applying") && (() => {
            const p = phase.data;
            if (!p.items.length) return <p>{t("auto.none")}</p>;
            return (
              <>
                <p style={{ margin: 0 }}>{t("auto.summary", { moved: p.summary.moved, checked: p.summary.checked })}</p>
                {p.projectEnd.before && p.projectEnd.after && <p className="muted" style={{ margin: 0 }}>{t("auto.projectEnd", { before: formatDate(p.projectEnd.before, year), after: formatDate(p.projectEnd.after, year) })}</p>}
                {p.warnings.map((w) => <div key={w.code} className={styles.warn} role="alert">{w.message}</div>)}
                <div style={{ maxHeight: 320, overflow: "auto" }}>
                  <table className={styles.list}>
                    <thead><tr><th>{t("auto.colTask")}</th><th>{t("auto.colFrom")}</th><th>{t("auto.colTo")}</th><th>{t("auto.colShift")}</th></tr></thead>
                    <tbody>
                      {p.items.map((it) => (
                        <tr key={it.key} data-testid={`preview-${it.key}`}>
                          <td><b>{it.key}</b> {it.title}{it.because.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{t("auto.because", { keys: it.because.join(", ") })}</div>}</td>
                          <td className="muted">{fmt(it.previousStart, it.previousEnd)}</td>
                          <td>{fmt(it.planStart, it.planEnd)}</td>
                          <td>{t("auto.shift", { days: it.shiftDays })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
          {phase.name === "applying" && <p className="muted" role="status" style={{ margin: 0 }}>{t("auto.applying", { done: phase.done, total: phase.data.items.length })}</p>}
          {phase.name === "reason" && (
            <form className={styles.stack} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void apply(phase.data, phase.at, phase.results, reason.trim()); }}>
              <p style={{ margin: 0 }}>{t("auto.reasonTitle")}</p>
              <Input label={t("auto.reasonLabel")} required value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className={styles.actions}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary">{t("auto.continue")}</Button></div>
            </form>
          )}
          {phase.name === "result" && (
            <>
              <p style={{ margin: 0 }} role="status">{t("auto.result", { count: phase.results.filter((r) => r.status === "ok").length })}</p>
              {phase.results.some((r) => r.status === "approval") && (
                <div>
                  <b>{t("auto.needApproval")}</b>
                  {phase.results.filter((r) => r.status === "approval").map((r) => (
                    <div key={r.key} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                      <span style={{ flex: 1 }}>{r.key} → {formatDate(r.due, year)}</span>
                      {requested.has(r.key) ? <span className="muted">{t("auto.requested")}</span> : <Button size="small" onClick={() => setRequestFor(r)}>{t("auto.request")}</Button>}
                    </div>
                  ))}
                </div>
              )}
              {phase.results.some((r) => r.status === "failed") && (
                <div>
                  <b>{t("auto.failed")}</b>
                  {phase.results.filter((r) => r.status === "failed").map((r) => <div key={r.key} className="muted">{r.key}: {r.message}</div>)}
                </div>
              )}
            </>
          )}
          {phase.name !== "reason" && (
            <div className={styles.actions}>
              {phase.name === "preview" && phase.data.items.length > 0
                ? <><Button onClick={onClose}>{t("cancel")}</Button><Button variant="primary" onClick={() => void apply(phase.data, 0, [])}>{t("auto.confirm", { count: phase.data.items.length })}</Button></>
                : phase.name !== "applying" && <Button onClick={onClose}>{t("auto.close")}</Button>}
            </div>
          )}
        </div>
      </Dialog>
      {requestFor && (
        <RequestDialog
          ws={ws}
          issueKey={requestFor.key}
          due={requestFor.due}
          year={year}
          onClose={() => setRequestFor(null)}
          onSent={() => { setRequested((s) => new Set(s).add(requestFor.key)); setRequestFor(null); }}
        />
      )}
    </>
  );
}

function RequestDialog({ ws, issueKey, due, year, onClose, onSent }: { ws: string; issueKey: string; due: string; year: YearFormat; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("gantt");
  const [reason, setReason] = useState("blocked_by_dependency");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<unknown>(null);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(issueKey)}/due-requests`, { requestedDue: due, reasonCode: reason, detail: detail || undefined });
      onSent();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Dialog open title={t("requestTitle")} description={t("requestBody", { key: issueKey, date: formatDate(due, year) })} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={send} className={styles.stack}>
        <Select label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)}>{["scope_added", "waiting_input", "blocked_by_dependency", "estimate_wrong", "other"].map((c) => <option key={c} value={c}>{t(`reasons.${c}`)}</option>)}</Select>
        <label className="field">{t("detail")}<textarea className="input" required={reason === "other"} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        {!!error && <ErrorState error={error} />}
        <div className={styles.actions}><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary">{t("send")}</Button></div>
      </form>
    </Dialog>
  );
}
