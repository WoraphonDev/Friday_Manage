"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

/**
 * กราฟของหน้าภาพรวม / ธุรกิจ ตามหลัก dataviz: แกนเดียว · สีเดียวไล่อ่อน-เข้ม · ป้ายค่าเฉพาะจุดสำคัญ
 * ทุกแท่ง hover / focus แล้วเห็นค่า · มีปุ่มดูเป็นตารางสำหรับคนที่อ่านกราฟไม่สะดวก
 */

export interface Col {
  label: string;
  value: number;
  display: string;
  /** primary = แท่งเน้น · soft = แท่งปกติ · forecast = คาดการณ์ (เส้นประ) */
  tone?: "primary" | "soft" | "forecast";
  /** แสดงค่าเหนือแท่งตลอด (ป้ายเฉพาะจุดสำคัญ) */
  labelled?: boolean;
}

/** กราฟแท่งแนวตั้ง (MRR รายเดือน · คาดการณ์) */
export function ColumnChart({ label, cols, height = 160 }: { label: string; cols: Col[]; height?: number }) {
  const t = useTranslations("ob.chart");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...cols.map((c) => c.value));
  if (!cols.length || cols.every((c) => c.value === 0)) return <p className="muted small">{t("empty")}</p>;
  return (
    <figure className="chart" aria-label={label}>
      <div className="chart-tools">
        <button type="button" className="link-button small" aria-pressed={table} onClick={() => setTable(!table)}>
          {table ? t("chart") : t("table")}
        </button>
      </div>
      {table ? (
        <DataTable label={label} rows={cols.map((c) => [c.label, c.display])} />
      ) : (
        <div className="chart-cols" style={{ height }} role="list" aria-label={label} onMouseLeave={() => setHover(null)}>
          {cols.map((c, i) => (
            <div key={c.label} className="chart-col" role="listitem" tabIndex={0} aria-label={`${c.label}: ${c.display}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
              {(c.labelled || hover === i) && <span className={hover === i ? "chart-tip" : "chart-value"}>{hover === i ? `${c.label} · ${c.display}` : c.display}</span>}
              <span className={`chart-bar chart-bar-${c.tone ?? "soft"}${hover === i ? " chart-bar-on" : ""}`} style={{ height: `${c.value > 0 ? Math.max(2, (c.value / max) * 100) : 0}%` }} />
              <span className="chart-axis">{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

export interface HRow {
  key: string;
  label: ReactNode;
  sub?: ReactNode;
  value: number;
  display: string;
  /** ค่าเทียบความยาวแท่ง (ไม่ระบุ = ค่ามากสุดในชุด) */
  of?: number;
  tone?: "primary" | "soft" | "warn" | "bad" | "neutral";
  note?: ReactNode;
}

/** แท่งแนวนอนพร้อมป้ายค่าทุกแถว (Funnel · เหตุผล · ฟีเจอร์ · ค้างรับ · แพ็กเกจ) */
export function HBars({ label, rows, tableHead }: { label: string; rows: HRow[]; tableHead?: [string, string] }) {
  const t = useTranslations("ob.chart");
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.of ?? r.value));
  if (!rows.length) return <p className="muted small">{t("empty")}</p>;
  return (
    <figure className="chart" aria-label={label}>
      <div className="chart-tools">
        <button type="button" className="link-button small" aria-pressed={table} onClick={() => setTable(!table)}>
          {table ? t("chart") : t("table")}
        </button>
      </div>
      {table ? (
        <DataTable label={label} head={tableHead} rows={rows.map((r) => [r.label, r.display])} />
      ) : (
        <ul className="hbars" aria-label={label}>
          {rows.map((r) => (
            <li key={r.key} tabIndex={0} title={typeof r.label === "string" ? `${r.label}: ${r.display}` : r.display}>
              <span className="hbar-label">
                <span>{r.label}</span>
                {r.sub && <span className="muted small">{r.sub}</span>}
              </span>
              <span className="hbar-track">
                <span className={`hbar hbar-${r.tone ?? "primary"}`} style={{ width: `${r.value > 0 ? Math.max(1, (r.value / (r.of ?? max)) * 100) : 0}%` }} />
              </span>
              <span className="hbar-value">
                {r.display}
                {r.note && <span className="muted small"> {r.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function DataTable({ label, head, rows }: { label: string; head?: [string, string]; rows: [ReactNode, string][] }) {
  const t = useTranslations("ob.chart");
  return (
    <div className="tbl-wrap">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            <th>{head?.[0] ?? t("col")}</th>
            <th className="num">{head?.[1] ?? t("value")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <td>{k}</td>
              <td className="num">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** ความเข้มของช่อง Cohort: สีเดียว (primary) ไล่ตาม % · 70% ลงไปจางสุด */
export const cohortShade = (pct: number) => {
  const k = Math.max(0, Math.min(1, (pct - 70) / 30));
  return { background: `color-mix(in srgb, var(--chart-primary) ${Math.round(12 + k * 78)}%, var(--card))`, color: k > 0.55 ? "var(--on-primary)" : "var(--foreground)" };
};
