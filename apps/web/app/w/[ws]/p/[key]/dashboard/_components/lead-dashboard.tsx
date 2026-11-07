"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Forbidden, LoadingState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateRange, today as todayIso, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { WorkloadHeatmap } from "./workload-heatmap";
import { addDays, daysBetween, projectBase, projectEndpoint, round1, STATUS_TONE, weekStart, type ModuleStat, type ModulesResponse, type RiskItem, type RisksResponse, type WeeklyReport } from "./types";
import styles from "./dashboard.module.css";

interface ViewProps { ws: string; projectKey: string }
type Sort = "start" | "md";

const SEVERITY_STYLE: Record<RiskItem["severity"], { color: string; icon: string }> = {
  high: { color: "#B91C1C", icon: "!" },
  medium: { color: "#C2410C", icon: "!" },
  low: { color: "#B45309", icon: "i" },
};

export function LeadDashboard(props: ViewProps) {
  return <ScopedDashboard key={`${props.ws}/${props.projectKey}`} {...props} />;
}

function ScopedDashboard({ ws, projectKey }: ViewProps) {
  const t = useTranslations("lead-dashboard-reports");
  const { me } = useWorkspace();
  const yearFormat: YearFormat = me.yearFormat;
  const search = useSearchParams();
  const pathname = usePathname();
  const [sort, setSort] = useState<Sort>("start");
  const endpoint = projectEndpoint(ws, projectKey);
  const base = projectBase(ws, projectKey);
  const now = todayIso();

  const permissions = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`) });
  const perms = permissions.data?.permissions ?? [];
  const allowed = !!permissions.data && !permissions.data.guestViewer && perms.includes("project.workload.view");
  const risks = useQuery({ queryKey: ["lead-dashboard", ws, projectKey, "risks"], queryFn: () => api.get<RisksResponse>(`${endpoint}/insights/risks`), enabled: allowed });
  const modules = useQuery({ queryKey: ["lead-dashboard", ws, projectKey, "modules"], queryFn: () => api.get<ModulesResponse>(`${endpoint}/insights/modules`), enabled: allowed });
  // KPI "เริ่มสัปดาห์นี้ / หน้า": รายงานของสัปดาห์ก่อนบอกงานที่เริ่มสัปดาห์นี้ · รายงานสัปดาห์นี้บอกสัปดาห์หน้า
  const thisWeek = useQuery({ queryKey: ["reports", ws, projectKey, "weekly", weekStart(now)], queryFn: () => api.get<WeeklyReport>(`${endpoint}/reports/weekly?week=${weekStart(now)}`), enabled: allowed });
  const lastWeek = useQuery({ queryKey: ["reports", ws, projectKey, "weekly", addDays(weekStart(now), -7)], queryFn: () => api.get<WeeklyReport>(`${endpoint}/reports/weekly?week=${addDays(weekStart(now), -7)}`), enabled: allowed });

  const issueHref = (key: string) => {
    const next = new URLSearchParams(search);
    next.delete("new");
    next.set("issue", key);
    return `${pathname}?${next}`;
  };

  const error = permissions.error ?? risks.error ?? modules.error;
  const denied = (error instanceof ApiError && error.status === 403) || permissions.data?.guestViewer || (!!permissions.data && !allowed);
  if (denied) return <Forbidden />;
  if (error) return <ErrorState error={error} retry={() => { void permissions.refetch(); void risks.refetch(); void modules.refetch(); }} />;
  if (!risks.data || !modules.data) return <LoadingState />;

  const summary = modules.data.summary;
  const tone = STATUS_TONE[summary.status];
  const toolbar = <div className={styles.toolbar}>
    <span className={styles.muted}>{t("asOf", { date: formatDate(modules.data.asOf, yearFormat) })}</span>
    <span className={styles.pill} style={{ background: tone.bg, color: tone.fg }}>{t(`status.${summary.status}`)}</span>
    {/* ปุ่มสร้างรายงาน / Import อยู่บนหัวโปรเจกต์แบบ Lead ตาม Canvas O1 */}
  </div>;

  if (!summary.taskCount) return <section className={styles.page} aria-label={t("dashboardTitle")}>
    {toolbar}
    <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} action={<Link className="button button-primary" href={`/w/${encodeURIComponent(ws)}/import`}>{t("importPlan")}</Link>} />
  </section>;

  const mods = modules.data.modules;
  const starts = mods.map((m) => m.planStart).filter((d): d is string => !!d).sort();
  const ends = mods.map((m) => m.plannedEnd).filter((d): d is string => !!d).sort();
  const planStart = starts[0] ?? null;
  const planEnd = ends.at(-1) ?? null;
  const planWeeks = planStart && planEnd ? Math.max(1, Math.round((daysBetween(planStart, planEnd) + 1) / 7)) : null;
  const over = summary.gapWeeks !== null && summary.gapWeeks > 0;
  const weekly = (q: typeof thisWeek) => q.data?.nextWeek.starting;

  return <section className={styles.page} aria-label={t("dashboardTitle")}>
    {toolbar}

    <div className={styles.kpis}>
      <Kpi label={t("kpi.tasks")} value={summary.taskCount} note={t("kpi.tasksNote", { modules: mods.filter((m) => m.id).length, progress: summary.progressPct })} />
      <Kpi label={t("kpi.md")} value={round1(summary.totalMd)} note={t("kpi.mdNote", { done: round1(summary.doneMd), remaining: round1(summary.remainingMd) })} />
      <Kpi label={t("kpi.span")} value={planWeeks === null ? "—" : t("weeks", { value: planWeeks })} note={planStart && planEnd ? formatDateRange(planStart, planEnd, yearFormat) : t("kpi.noDates")} />
      <Kpi label={t("kpi.required")} danger={over}
        value={summary.requiredWeeks === null ? "—" : t("weeks", { value: summary.requiredWeeks })}
        note={summary.requiredWeeks === null ? t("kpi.noCapacity")
          : `${t("kpi.requiredNote", { remaining: round1(summary.remainingMd), capacity: summary.capacityMdPerWeek })}${summary.gapWeeks !== null ? ` · ${summary.gapWeeks > 0 ? t("kpi.gapOver", { value: summary.gapWeeks }) : t("kpi.gapOk", { value: summary.weeksToGoLive ?? 0 })}` : ""}`} />
      <Kpi label={t("kpi.starting")}
        value={weekly(lastWeek) && weekly(thisWeek) ? t("kpi.startingValue", { now: weekly(lastWeek)!.count, next: weekly(thisWeek)!.count }) : "—"}
        note={weekly(lastWeek) && weekly(thisWeek) ? t("kpi.startingNote", { now: weekly(lastWeek)!.md, next: weekly(thisWeek)!.md, overdue: thisWeek.data!.totals.overdue }) : (thisWeek.error || lastWeek.error) ? t("kpi.unavailable") : t("loading")} />
    </div>

    <section className={styles.card} aria-label={t("risks.title")}>
      <div className={styles.cardHead}><h2>{t("risks.title")}</h2><span className={styles.pill} style={{ background: "#FEE2E2", color: "#991B1B" }}>{risks.data.items.length}</span></div>
      {!risks.data.items.length ? <p className={styles.cardNote}>{t("risks.empty")}</p> : <ul className={styles.risks}>
        {risks.data.items.map((risk) => <RiskRow key={risk.kind} risk={risk} ws={ws} base={base} issueHref={issueHref} />)}
      </ul>}
    </section>

    <WorkloadHeatmap ws={ws} projectKey={projectKey} today={now} yearFormat={yearFormat} issueHref={issueHref} />

    <ModuleTable modules={mods} sort={sort} setSort={setSort} today={modules.data.asOf} yearFormat={yearFormat} velocityDays={modules.data.velocity.windowDays} />
  </section>;
}

function Kpi({ label, value, note, danger }: { label: string; value: string | number; note: string; danger?: boolean }) {
  return <div className={`${styles.kpi} ${danger ? styles.kpiDanger : ""}`} role="group" aria-label={label}>
    <span className={styles.kpiLabel}>{label}</span>
    <b>{value}</b>
    <span className={styles.kpiNote}>{note}</span>
  </div>;
}

function RiskRow({ risk, ws, base, issueHref }: { risk: RiskItem; ws: string; base: string; issueHref: (key: string) => string }) {
  const t = useTranslations("lead-dashboard-reports");
  const level = SEVERITY_STYLE[risk.severity];
  const action: Record<RiskItem["kind"], string> = {
    overdue: `${base}/table`,
    due_soon_low_progress: `${base}/calendar`,
    capacity_over: `${base}/members`,
    blocked: `${base}/gantt`,
    pending_due_requests: `/w/${encodeURIComponent(ws)}/inbox`,
  };
  return <li className={styles.risk}>
    <span className={styles.level} style={{ background: level.color }} role="img" aria-label={t(`severity.${risk.severity}`)}>{level.icon}</span>
    <div className={styles.riskBody}>
      <b>{risk.title}</b>
      <div className={styles.muted}>{risk.detail}</div>
      {!!risk.issueKeys.length && <div className={styles.keys}>{risk.issueKeys.slice(0, 6).map((key) => <Link key={key} href={issueHref(key)}>{key}</Link>)}{risk.issueKeys.length > 6 && <span className={styles.muted}>{t("more", { count: risk.issueKeys.length - 6 })}</span>}</div>}
    </div>
    <Link className={`button button-secondary button-small ${styles.riskAction}`} href={action[risk.kind]}>{t(`risks.action.${risk.kind}`)}</Link>
  </li>;
}

/** วันที่ 1 ของเดือนถัดไป */
const nextMonth = (date: string) => `${addDays(`${date.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
const monthFormat = (year: YearFormat) => new Intl.DateTimeFormat(`th-TH-u-ca-${year === "BE" ? "buddhist" : "gregory"}`, { month: "short", timeZone: "UTC" });

function ModuleTable({ modules, sort, setSort, today, yearFormat, velocityDays }: { modules: ModuleStat[]; sort: Sort; setSort: (sort: Sort) => void; today: string; yearFormat: YearFormat; velocityDays: number }) {
  const t = useTranslations("lead-dashboard-reports");
  const rows = [...modules].sort(sort === "md"
    ? (a, b) => b.totalMd - a.totalMd
    : (a, b) => (a.planStart ?? "9999").localeCompare(b.planStart ?? "9999") || a.name.localeCompare(b.name));
  // แกนเวลา: ตั้งแต่วันเริ่มแรกสุดถึงวันจบหลังสุดของทุก Module ตัดเป็นเดือน
  const starts = modules.map((m) => m.planStart).filter((d): d is string => !!d).sort();
  const ends = modules.map((m) => m.plannedEnd).filter((d): d is string => !!d).sort();
  const t0 = starts[0] ? `${starts[0].slice(0, 7)}-01` : null;
  const lastEnd = ends.at(-1) ?? starts.at(-1) ?? null;
  const t1 = lastEnd ? nextMonth(lastEnd) : null;
  const span = t0 && t1 ? Math.max(1, daysBetween(t0, t1)) : 1;
  const pct = (date: string) => (t0 ? (daysBetween(t0, date) / span) * 100 : 0);
  const months: string[] = [];
  if (t0 && t1) for (let m = t0; m < t1 && months.length < 36; m = nextMonth(m)) months.push(m);
  const fmt = monthFormat(yearFormat);
  const todayPct = t0 && t1 && today >= t0 && today <= t1 ? pct(today) : null;

  return <section className={styles.card} aria-label={t("modules.title")}>
    <div className={styles.cardHead}>
      <h2>{t("modules.title")}</h2>
      <div className={styles.seg} role="group" aria-label={t("modules.sort")}>
        <button type="button" aria-pressed={sort === "start"} onClick={() => setSort("start")}>{t("modules.byStart")}</button>
        <button type="button" aria-pressed={sort === "md"} onClick={() => setSort("md")}>{t("modules.byMd")}</button>
      </div>
    </div>
    <div role="table" aria-label={t("modules.title")}>
      <div className={`${styles.modRow} ${styles.modHead}`} role="row">
        <span role="columnheader">{t("modules.name")}</span>
        <span role="columnheader">{t("modules.tasks")}</span>
        <span role="columnheader">{t("modules.md")}</span>
        <span role="columnheader" className={styles.hideSmall}>{t("modules.progress")}</span>
        <span role="columnheader" className={styles.hideSmall}>{t("modules.forecast")}</span>
        <span role="columnheader" className={`${styles.hideSmall} ${styles.months}`}>{months.map((m) => <span key={m}>{fmt.format(new Date(`${m}T00:00:00Z`))}</span>)}</span>
      </div>
      {rows.map((m) => {
        const left = m.planStart ? pct(m.planStart) : null;
        const right = m.plannedEnd ? pct(m.plannedEnd) : left;
        const range = m.planStart || m.plannedEnd ? formatDateRange(m.planStart ?? m.plannedEnd, m.plannedEnd ?? m.planStart, yearFormat) : t("modules.noDates");
        return <div key={m.id ?? "none"} className={styles.modRow} role="row" aria-label={m.name}>
          <span role="cell" className={styles.modName}><b title={m.name}>{m.name}</b>{m.overdue > 0 && <span className={styles.overdue}>{t("modules.overdue", { count: m.overdue })}</span>}</span>
          <span role="cell">{m.taskCount}</span>
          <span role="cell"><b>{round1(m.totalMd)}</b></span>
          <span role="cell" className={styles.hideSmall}>
            <span className={styles.progress} role="meter" aria-label={t("modules.progressOf", { name: m.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.progressPct}>
              <span className={styles.progressBar}><span style={{ width: `${m.progressPct}%` }} /></span>{m.progressPct}%
            </span>
          </span>
          <span role="cell" className={styles.hideSmall}><Forecast module={m} yearFormat={yearFormat} /></span>
          <span role="cell" className={`${styles.hideSmall} ${styles.track}`} title={range} style={{ backgroundSize: `${100 / Math.max(1, months.length)}% 100%` }}>
            {left !== null && right !== null && <span className={styles.trackBar} style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }} />}
            {todayPct !== null && <span className={styles.todayLine} style={{ left: `${todayPct}%` }} aria-hidden="true" />}
          </span>
        </div>;
      })}
    </div>
    <p className={styles.cardNote}>{t("modules.note", { days: velocityDays })}</p>
  </section>;
}

function Forecast({ module: m, yearFormat }: { module: ModuleStat; yearFormat: YearFormat }) {
  const t = useTranslations("lead-dashboard-reports");
  if (m.status === "done") return <span className={styles.ok}>{t("modules.done")}</span>;
  if (!m.forecastEnd) return <span className={styles.muted}>{t(`forecastReason.${m.forecastReason ?? "no_velocity"}`)}</span>;
  const slip = m.slipDays ?? 0;
  return <span>
    {formatDate(m.forecastEnd, yearFormat)}{" "}
    <span className={slip > 7 ? styles.bad : slip > 0 ? styles.warn : styles.ok}>{slip > 0 ? t("slipLate", { days: slip }) : t("slipOk")}</span>
  </span>;
}
