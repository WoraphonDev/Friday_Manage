"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ErrorState } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateRange, type YearFormat } from "@/lib/format";
import { addDays, projectEndpoint, round1, weekStart, type WorkloadCell, type WorkloadResponse } from "./types";
import styles from "./dashboard.module.css";

/** Canvas O1: 24 สัปดาห์ โดยสัปดาห์นี้เป็นคอลัมน์ที่ 5 (เห็นย้อนหลัง 4 สัปดาห์) */
export const HEAT_WEEKS = 24;
export const HEAT_WEEKS_BACK = 4;

/** ระดับสีตามสัดส่วน Man-Day ต่อ capacity ของคนนั้นในสัปดาห์นั้น (หักวันลาแล้ว) */
export function heatLevel(value: number, capacity: number | null) {
  if (value <= 0) return "empty" as const;
  const ratio = capacity && capacity > 0 ? value / capacity : Infinity;
  if (ratio <= 0.8) return "low" as const;
  if (ratio <= 1) return "full" as const;
  if (ratio <= 2) return "over" as const;
  return "critical" as const;
}
const ratioOf = (cell: WorkloadCell) => (cell.value <= 0 ? 0 : cell.capacity && cell.capacity > 0 ? cell.value / cell.capacity : Infinity);
const shortDate = (date: string) => `${Number(date.slice(8, 10))}/${Number(date.slice(5, 7))}`;

export function WorkloadHeatmap({ ws, projectKey, today, yearFormat, issueHref }: { ws: string; projectKey: string; today: string; yearFormat: YearFormat; issueHref: (key: string) => string }) {
  const t = useTranslations("lead-dashboard-reports");
  const from = addDays(weekStart(today), -7 * HEAT_WEEKS_BACK);
  const to = addDays(from, HEAT_WEEKS * 7 - 1);
  const [picked, setPicked] = useState<{ person: number; week: number } | null>(null);
  const workload = useQuery({
    queryKey: ["lead-dashboard", ws, projectKey, "workload", from, to],
    queryFn: () => api.get<WorkloadResponse>(`${projectEndpoint(ws, projectKey)}/workload?from=${from}&to=${to}&group=week&unit=md`),
  });

  const legend = <div className={styles.legend}>
    {(["low", "full", "over", "critical"] as const).map((level) => <span key={level}><span className={`${styles.swatch} ${styles[level]}`} aria-hidden="true" />{t(`heat.${level}`)}</span>)}
  </div>;
  const header = <div className={styles.cardHead}>
    <h2>{t("heat.title")} <span className={styles.headNote}>{t("heat.unit")}</span></h2>
    {legend}
  </div>;

  if (workload.error) return <section className={styles.card} aria-label={t("heat.title")}>{header}<ErrorState error={workload.error} retry={() => void workload.refetch()} /></section>;
  if (!workload.data) return <section className={styles.card} aria-label={t("heat.title")} aria-busy="true">{header}<p className={styles.cardNote}>{t("loading")}</p></section>;

  const { buckets, people } = workload.data;
  const thisWeek = weekStart(today);
  const columns = { gridTemplateColumns: `110px repeat(${buckets.length}, minmax(0, 1fr)) 64px` };
  const selected = picked ? { person: people[picked.person], cell: people[picked.person]?.cells[picked.week], bucket: buckets[picked.week] } : null;

  return <section className={styles.card} aria-label={t("heat.title")}>
    {header}
    {!people.length ? <p className={styles.cardNote}>{t("heat.empty")}</p> : <div className={styles.heatScroll}>
      <div className={styles.heat} role="table" aria-label={t("heat.title")}>
        <div className={styles.heatRow} style={columns} role="row">
          <span role="columnheader" />
          {buckets.map((bucket) => <span key={bucket.start} role="columnheader" className={`${styles.weekLabel} ${bucket.start === thisWeek ? styles.thisWeek : ""}`} aria-current={bucket.start === thisWeek ? "date" : undefined}>{shortDate(bucket.start)}</span>)}
          <span role="columnheader" className={styles.peakHead}>{t("heat.peak")}</span>
        </div>
        {people.map((row, personIndex) => {
          const keys = new Set(row.cells.flatMap((cell) => cell.issues.map((issue) => issue.key)));
          const peak = Math.max(0, ...row.cells.map(ratioOf));
          const peakClass = peak > 2 ? styles.peakCritical : peak > 1 ? styles.peakOver : styles.peakOk;
          return <div key={row.person.id} className={styles.heatRow} style={columns} role="row" aria-label={row.person.displayName}>
            <span role="rowheader" className={styles.personCell}>{row.person.displayName}<span>{t("heat.tasks", { count: keys.size })}</span></span>
            {row.cells.map((cell, weekIndex) => {
              const level = heatLevel(cell.value, cell.capacity);
              const value = round1(cell.value);
              const tip = t("heat.tip", { name: row.person.displayName, week: shortDate(buckets[weekIndex].start), value, capacity: round1(cell.capacity ?? 0) }) + (cell.leaveDays ? ` · ${t("heat.leave", { days: cell.leaveDays })}` : "");
              const active = picked?.person === personIndex && picked.week === weekIndex;
              return <span key={buckets[weekIndex].start} role="cell">
                <button type="button" className={`${styles.heatCell} ${styles[level]} ${active ? styles.heatActive : ""}`} title={tip} aria-label={tip} aria-pressed={active}
                  data-level={level} disabled={!cell.issues.length} onClick={() => setPicked(active ? null : { person: personIndex, week: weekIndex })}>
                  {level === "empty" ? "" : value}
                </button>
              </span>;
            })}
            <span role="cell" className={`${styles.peak} ${peakClass}`}>{peak === Infinity ? "—" : `${peak.toFixed(1)}×`}</span>
          </div>;
        })}
      </div>
    </div>}
    {selected?.cell && selected.bucket && <div className={styles.weekPanel} role="region" aria-label={t("heat.panel", { name: selected.person.person.displayName, range: formatDateRange(selected.bucket.start, selected.bucket.end, yearFormat) })}>
      <div className={styles.weekPanelHead}>
        <b>{t("heat.panel", { name: selected.person.person.displayName, range: formatDateRange(selected.bucket.start, selected.bucket.end, yearFormat) })}</b>
        <span className={styles.muted}>{t("heat.panelTotal", { value: round1(selected.cell.value), capacity: round1(selected.cell.capacity ?? 0) })}</span>
        <Button size="small" variant="ghost" onClick={() => setPicked(null)}>{t("close")}</Button>
      </div>
      <ul>
        {selected.cell.issues.map((issue) => <li key={issue.key}><Link href={issueHref(issue.key)}>{issue.key}</Link> <span className={styles.issueTitle}>{issue.title}</span> <span className={styles.muted}>{t("md", { value: round1(issue.value) })}</span></li>)}
      </ul>
      <p className={styles.cardNote}>{t("heat.reassign")}</p>
    </div>}
    <p className={styles.cardNote}>{t("heat.note")}</p>
  </section>;
}
