"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Forbidden, LoadingState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { projectEndpoint, round1, type ForecastResponse, type ModuleStat, type WeekPoint } from "../../dashboard/_components/types";
import styles from "./reports.module.css";

interface Props { ws: string; projectKey: string; yearFormat: YearFormat; issueHref: (key: string) => string }

export function PlanVsActual({ ws, projectKey, yearFormat }: Props) {
  const t = useTranslations("lead-dashboard-reports");
  const forecast = useQuery({ queryKey: ["reports", ws, projectKey, "module-forecast"], queryFn: () => api.get<ForecastResponse>(`${projectEndpoint(ws, projectKey)}/reports/module-forecast?weeks=8`) });
  if (forecast.error instanceof ApiError && forecast.error.status === 403) return <Forbidden />;
  if (forecast.error) return <ErrorState error={forecast.error} retry={() => void forecast.refetch()} />;
  if (!forecast.data) return <LoadingState />;
  const data = forecast.data;

  return <>
    <div className={`${styles.card} ${styles.banner} ${styles.bannerInfo}`}>
      <b>{t("pva.actualTitle")}</b>
      <span className={styles.bannerText}>{t("pva.actualNote")}</span>
      <Link className="button button-secondary" href={`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/import`}>{t("pva.updateFromExcel")}</Link>
    </div>
    {!data.modules.length ? <EmptyState title={t("pva.emptyTitle")} description={t("pva.emptyDescription")} /> : <>
      <WeeklyChart weeks={data.weekly} yearFormat={yearFormat} />
      <div className={`${styles.card} ${styles.tableScroll}`}>
        <table className={styles.table} style={{ minWidth: 820 }}>
          <thead><tr>
            <th>{t("pva.module")}</th><th>{t("pva.tasks")}</th><th>{t("pva.mdPlan")}</th><th>{t("pva.mdDone")}</th><th>{t("pva.planEnd")}</th><th>{t("pva.forecast")}</th><th>{t("pva.diff")}</th>
          </tr></thead>
          <tbody>{data.modules.map((m) => <Row key={m.id ?? "none"} module={m} yearFormat={yearFormat} />)}</tbody>
        </table>
      </div>
    </>}
    <p className={styles.footNote}>{t("pva.note", { days: data.velocity.windowDays })}</p>
  </>;
}

function Row({ module: m, yearFormat }: { module: ModuleStat; yearFormat: YearFormat }) {
  const t = useTranslations("lead-dashboard-reports");
  const forecast = m.status === "done" ? (m.forecastEnd ? formatDate(m.forecastEnd, yearFormat) : t("modules.done"))
    : m.forecastEnd ? formatDate(m.forecastEnd, yearFormat)
      : !m.plannedEnd ? t("pva.notPlanned")
        : m.doneCount === 0 ? t("pva.notStarted")
          : t(`forecastReason.${m.forecastReason ?? "no_velocity"}`);
  const slip = m.slipDays;
  const diff = slip === null ? "—" : slip > 0 ? t("slipLate", { days: slip }) : slip < 0 ? t("slipEarly", { days: -slip }) : t("slipOk");
  const diffClass = slip === null ? styles.muted : slip > 7 ? styles.bad : slip > 0 ? styles.warn : styles.ok;
  return <tr>
    <td><b>{m.name}</b>{m.milestone && <div className={styles.small}>{t("pva.milestone", { name: m.milestone.name, date: formatDate(m.milestone.date, yearFormat) })}</div>}</td>
    <td>{m.doneCount} / {m.taskCount}</td>
    <td>{round1(m.totalMd)}</td>
    <td>{m.doneMd > 0 ? round1(m.doneMd) : "—"}</td>
    <td>{m.plannedEnd ? formatDate(m.plannedEnd, yearFormat) : "—"}</td>
    <td>{forecast}</td>
    <td className={diffClass}>{diff}</td>
  </tr>;
}

const W = 640;
const H = 180;
const PAD = { left: 34, right: 8, top: 12, bottom: 24 };

/** SVG เขียนเอง: แท่งคู่ Man-Day ที่ตั้งใจเสร็จ (แผน) เทียบที่เสร็จจริง รายสัปดาห์ */
function WeeklyChart({ weeks, yearFormat }: { weeks: WeekPoint[]; yearFormat: YearFormat }) {
  const t = useTranslations("lead-dashboard-reports");
  const max = Math.max(1, ...weeks.flatMap((w) => [w.plannedMd, w.doneMd]));
  const slot = (W - PAD.left - PAD.right) / Math.max(1, weeks.length);
  const bar = Math.min(18, slot / 3);
  const y = (value: number) => PAD.top + (1 - value / max) * (H - PAD.top - PAD.bottom);
  const planned = weeks.reduce((n, w) => n + w.plannedMd, 0);
  const done = weeks.reduce((n, w) => n + w.doneMd, 0);
  const label = t("pva.chartLabel", { weeks: weeks.length, planned: round1(planned), done: round1(done) });
  return <figure className={`${styles.card} ${styles.chart}`}>
    <figcaption className={styles.chartHead}>
      <b>{t("pva.chartTitle")}</b>
      <span className={styles.legend}><span className={styles.swatchPlan} aria-hidden="true" />{t("pva.plan")} <span className={styles.swatchDone} aria-hidden="true" />{t("pva.actual")}</span>
    </figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={styles.chartSvg}>
      <title>{label}</title>
      {[0, 0.5, 1].map((ratio) => <g key={ratio}>
        <line x1={PAD.left} x2={W - PAD.right} y1={y(max * ratio)} y2={y(max * ratio)} stroke="#EEF0F3" />
        <text x={PAD.left - 4} y={y(max * ratio) + 4} textAnchor="end" fontSize="10" fill="#5F6873">{round1(max * ratio)}</text>
      </g>)}
      {weeks.map((w, index) => {
        const cx = PAD.left + slot * index + slot / 2;
        return <g key={w.weekStart} data-testid="pva-week">
          <rect x={cx - bar - 1} y={y(w.plannedMd)} width={bar} height={Math.max(0, y(0) - y(w.plannedMd))} fill="#BFDBFE" rx="2"><title>{t("pva.barPlan", { week: formatDate(w.weekStart, yearFormat), value: w.plannedMd })}</title></rect>
          <rect x={cx + 1} y={y(w.doneMd)} width={bar} height={Math.max(0, y(0) - y(w.doneMd))} fill="#1D4ED8" rx="2"><title>{t("pva.barDone", { week: formatDate(w.weekStart, yearFormat), value: w.doneMd })}</title></rect>
          <text x={cx} y={H - 8} fontSize="10" fill="#5F6873" textAnchor="middle">{`${Number(w.weekStart.slice(8, 10))}/${Number(w.weekStart.slice(5, 7))}`}</text>
        </g>;
      })}
    </svg>
  </figure>;
}
