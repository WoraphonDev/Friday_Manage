"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorState, Forbidden, LoadingState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { projectEndpoint } from "../../dashboard/_components/types";
import { PlanVsActual } from "./plan-vs-actual";
import { Traceability } from "./traceability";
import { WeeklyReportView } from "./weekly-report";
import styles from "./reports.module.css";

interface ViewProps { ws: string; projectKey: string }
const REPORTS = ["weekly", "pva", "trace"] as const;
export type ReportKind = (typeof REPORTS)[number];

export function ReportsView(props: ViewProps) {
  return <ScopedReports key={`${props.ws}/${props.projectKey}`} {...props} />;
}

function ScopedReports({ ws, projectKey }: ViewProps) {
  const t = useTranslations("lead-dashboard-reports");
  const { me } = useWorkspace();
  const search = useSearchParams();
  const pathname = usePathname();
  const initial = search.get("report");
  const [report, setReport] = useState<ReportKind>(REPORTS.includes(initial as ReportKind) ? (initial as ReportKind) : "weekly");
  const endpoint = projectEndpoint(ws, projectKey);
  const permissions = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`) });

  const issueHref = (key: string) => {
    const next = new URLSearchParams(search);
    next.delete("new");
    next.set("issue", key);
    return `${pathname}?${next}`;
  };

  const error = permissions.error;
  if ((error instanceof ApiError && error.status === 403) || permissions.data?.guestViewer) return <Forbidden />;
  if (error) return <ErrorState error={error} retry={() => void permissions.refetch()} />;
  if (!permissions.data) return <LoadingState />;
  const perms = permissions.data.permissions;
  if (!perms.includes("project.reports.view")) return <Forbidden />;

  const common = { ws, projectKey, yearFormat: me.yearFormat, issueHref };
  return <div className={styles.page}>
    <nav className={`${styles.card} ${styles.nav}`} aria-label={t("reports.nav")}>
      {REPORTS.map((kind) => <button key={kind} type="button" className={`${styles.navItem} ${report === kind ? styles.navOn : ""}`} aria-current={report === kind ? "page" : undefined} onClick={() => setReport(kind)}>{t(`reports.kind.${kind}`)}</button>)}
      <p className={styles.navNote}>{t("reports.navNote")}</p>
    </nav>
    <section className={styles.main} aria-label={t(`reports.kind.${report}`)}>
      {report === "weekly" && <WeeklyReportView {...common} canSend={perms.includes("project.settings")} />}
      {report === "pva" && <PlanVsActual {...common} />}
      {report === "trace" && <Traceability {...common} />}
    </section>
  </div>;
}
