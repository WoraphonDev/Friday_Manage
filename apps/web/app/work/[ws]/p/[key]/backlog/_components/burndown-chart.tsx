"use client";

import { useTranslations } from "next-intl";
import { formatDate, type YearFormat } from "@/lib/format";
import type { Burndown } from "./types";
import styles from "./backlog.module.css";

const W = 360;
const H = 150;
const PAD = { left: 30, right: 8, top: 10, bottom: 22 };

/** SVG เขียนเอง: เส้นแผน (ประ) และเส้นจริงจาก snapshot รายวัน · ไม่เติมวันที่ไม่มี snapshot */
export function BurndownChart({ burndown, yearFormat }: { burndown: Burndown; yearFormat: YearFormat }) {
  const t = useTranslations("backlog");
  const dates = burndown.ideal.map((point) => point.date);
  const max = Math.max(1, burndown.baselineMd, ...burndown.actual.map((point) => point.remainingMd));
  const x = (index: number) => PAD.left + (dates.length > 1 ? (index / (dates.length - 1)) * (W - PAD.left - PAD.right) : 0);
  const y = (value: number) => PAD.top + (1 - value / max) * (H - PAD.top - PAD.bottom);
  const ideal = burndown.ideal.map((point, index) => `${x(index)},${y(point.remainingMd)}`).join(" ");
  const actualPoints = burndown.actual
    .map((point) => ({ ...point, index: dates.indexOf(point.date) }))
    .filter((point) => point.index >= 0);
  const actual = actualPoints.map((point) => `${x(point.index)},${y(point.remainingMd)}`).join(" ");
  const latest = burndown.actual.at(-1);
  const label = t("burndownLabel", { remaining: latest?.remainingMd ?? burndown.baselineMd, baseline: burndown.baselineMd });
  return <figure className={styles.burndown}>
    <figcaption className={styles.burndownHead}>
      <span>{t("burndownTitle")}</span>
      <span className={styles.legend}><span className={styles.legendIdeal} aria-hidden="true" />{t("ideal")} · <span className={styles.legendActual} aria-hidden="true" />{t("actual")}</span>
    </figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={styles.burndownSvg}>
      <title>{label}</title>
      {[0, 0.5, 1].map((ratio) => <g key={ratio}>
        <line x1={PAD.left} x2={W - PAD.right} y1={y(max * ratio)} y2={y(max * ratio)} stroke="#EEF0F3" />
        <text x={PAD.left - 4} y={y(max * ratio) + 4} textAnchor="end" fontSize="10" fill="#5F6873">{Math.round(max * ratio)}</text>
      </g>)}
      <polyline points={ideal} fill="none" stroke="#9AA3AE" strokeWidth="1.5" strokeDasharray="4 3" data-testid="burndown-ideal" />
      {actualPoints.length > 0 && <polyline points={actual} fill="none" stroke="#1D4ED8" strokeWidth="2.5" data-testid="burndown-actual" />}
      {actualPoints.map((point) => <circle key={point.date} cx={x(point.index)} cy={y(point.remainingMd)} r="3" fill="#1D4ED8"><title>{t("burndownPoint", { date: formatDate(point.date, yearFormat), remaining: point.remainingMd })}</title></circle>)}
      <text x={PAD.left} y={H - 6} fontSize="10" fill="#5F6873">{formatDate(dates[1] ?? dates[0], yearFormat)}</text>
      <text x={W - PAD.right} y={H - 6} fontSize="10" fill="#5F6873" textAnchor="end">{formatDate(dates.at(-1), yearFormat)}</text>
    </svg>
  </figure>;
}
