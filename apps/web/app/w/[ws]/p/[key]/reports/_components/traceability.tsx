"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Forbidden, LoadingState, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { YearFormat } from "@/lib/format";
import { projectEndpoint, type TraceabilityResponse, type TraceResult } from "../../dashboard/_components/types";
import styles from "./reports.module.css";

interface Props { ws: string; projectKey: string; yearFormat: YearFormat; issueHref: (key: string) => string }
type Kind = "all" | "FR" | "NFR";
const RESULTS: TraceResult[] = ["uncovered", "untested", "partial", "passed", "failed", "blocked"];
const RESULT_TONE: Record<TraceResult, { bg: string; fg: string }> = {
  uncovered: { bg: "#FEF3C7", fg: "#92400E" },
  untested: { bg: "#EEF0F3", fg: "#3D4550" },
  partial: { bg: "#DBEAFE", fg: "#1E40AF" },
  passed: { bg: "#DCFCE7", fg: "#166534" },
  failed: { bg: "#FEE2E2", fg: "#991B1B" },
  blocked: { bg: "#EDE9FE", fg: "#5B21B6" },
};

export function Traceability({ ws, projectKey, issueHref }: Props) {
  const t = useTranslations("lead-dashboard-reports");
  const [kind, setKind] = useState<Kind>("all");
  const [result, setResult] = useState<TraceResult | "">("");
  const params = new URLSearchParams();
  if (kind !== "all") params.set("kind", kind);
  if (result) params.set("result", result);
  const query = params.size ? `?${params}` : "";
  const trace = useQuery({ queryKey: ["reports", ws, projectKey, "traceability", kind, result], queryFn: () => api.get<TraceabilityResponse>(`${projectEndpoint(ws, projectKey)}/reports/traceability${query}`), placeholderData: (previous) => previous });
  if (trace.error instanceof ApiError && trace.error.status === 403) return <Forbidden />;
  if (trace.error) return <ErrorState error={trace.error} retry={() => void trace.refetch()} />;
  if (!trace.data) return <LoadingState />;
  const { summary, requirements, screens } = trace.data;
  const noRequirements = summary.requirements.total === 0;

  // Screen ของแต่ละ Requirement = Screen ที่มีงานร่วมกัน (API ผูก FR และ Screen กับงานแยกกัน)
  const screensOf = (keys: Set<string>) => screens.filter((s) => s.issues.some((i) => keys.has(i.key))).map((s) => s.code);
  const linked = new Map<string, boolean>();
  for (const r of requirements) for (const i of r.issues) linked.set(i.key, i.status.category === "done");
  const donePct = linked.size ? Math.round(([...linked.values()].filter(Boolean).length / linked.size) * 100) : 0;
  const keyLinks = (keys: string[], limit = 4) => <>{keys.slice(0, limit).map((key, index) => <span key={key}>{index > 0 && ", "}<Link href={issueHref(key)}>{key}</Link></span>)}{keys.length > limit && <span className={styles.muted}> {t("more", { count: keys.length - limit })}</span>}</>;

  return <>
    {noRequirements && <div className={`${styles.card} ${styles.banner} ${styles.bannerWarn}`}>
      <b>{t("trace.noFrTitle")}</b>
      <span className={styles.bannerText}>{t("trace.noFrNote")}</span>
      <Link className="button button-secondary" href={`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/import`}>{t("trace.importFr")}</Link>
    </div>}
    <div className={styles.filters}>
      <div role="group" aria-label={t("trace.kind")} className={styles.filters}>
        {(["all", "FR", "NFR"] as const).map((value) => <Button key={value} className={styles.chip} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "all" ? t("trace.allKinds") : value}</Button>)}
      </div>
      <Select size="small" aria-label={t("trace.result")} value={result} onChange={(event) => setResult(event.target.value as TraceResult | "")}>
        <option value="">{t("trace.allResults")}</option>
        {RESULTS.map((value) => <option key={value} value={value}>{t(`trace.results.${value}`)}</option>)}
      </Select>
    </div>
    <div className={styles.kpis}>
      <div className={styles.card} role="group" aria-label={t("trace.kpiFr")}><span className={styles.kpiLabel}>{t("trace.kpiFr")}</span><b>{summary.requirements.total}</b></div>
      <div className={styles.card} role="group" aria-label={t("trace.kpiScreens")}><span className={styles.kpiLabel}>{t("trace.kpiScreens")}</span><b>{summary.screens.total}</b></div>
      <div className={styles.card} role="group" aria-label={t("trace.kpiNoFr")}><span className={styles.kpiLabel}>{t("trace.kpiNoFr")}</span><b style={{ color: summary.issuesWithoutRequirement.count ? "#B45309" : "#166534" }}>{summary.issuesWithoutRequirement.count}</b></div>
      <div className={styles.card} role="group" aria-label={t("trace.kpiDone")}><span className={styles.kpiLabel}>{t("trace.kpiDone")}</span><b>{donePct}%</b></div>
    </div>
    <div className={`${styles.card} ${styles.tableScroll}`}>
      <table className={styles.table} style={{ minWidth: 760 }}>
        <thead><tr><th>{t("trace.requirement")}</th><th>{t("trace.issues")}</th><th>{t("trace.screens")}</th><th>{t("trace.test")}</th><th>{t("trace.progress")}</th></tr></thead>
        <tbody>
          {requirements.map((r) => {
            const keys = r.issues.map((i) => i.key);
            const done = r.issues.filter((i) => i.status.category === "done").length;
            const tone = RESULT_TONE[r.result];
            const pct = r.issues.length ? Math.round((done / r.issues.length) * 100) : 0;
            return <tr key={r.code}>
              <td><b>{r.code}</b><div className={styles.small}>{r.title}</div></td>
              <td>{r.issues.length ? <>{r.issues.length} · {keyLinks(keys)}</> : "0"}</td>
              <td className={styles.muted}>{screensOf(new Set(keys)).join(", ") || "—"}</td>
              <td><span className={styles.pill} style={{ background: tone.bg, color: tone.fg }}>{t(`trace.results.${r.result}`)}</span></td>
              <td><div className={styles.cov}><div className={styles.covBar} role="meter" aria-label={t("trace.progressOf", { code: r.code })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div><span className={styles.small}>{done} / {r.issues.length}</span></div></td>
            </tr>;
          })}
          {!requirements.length && !noRequirements && <tr><td colSpan={5} className={styles.muted}>{t("trace.filteredEmpty")}</td></tr>}
          {summary.issuesWithoutRequirement.count > 0 && <tr>
            <td><b className={styles.warn}>{t("trace.noFr")}</b></td>
            <td>{summary.issuesWithoutRequirement.count} · {keyLinks(summary.issuesWithoutRequirement.keys)}</td>
            <td className={styles.muted}>—</td>
            <td />
            <td><Link href={issueHref(summary.issuesWithoutRequirement.keys[0] ?? "")}>{t("trace.assignFr")}</Link></td>
          </tr>}
        </tbody>
      </table>
    </div>
  </>;
}
