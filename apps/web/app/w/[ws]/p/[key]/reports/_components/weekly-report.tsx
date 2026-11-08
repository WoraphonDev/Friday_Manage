"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ErrorState, FloatingNotice, Forbidden, LoadingState, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateRange, today as todayIso, type YearFormat } from "@/lib/format";
import { addDays, projectBase, projectEndpoint, STATUS_TONE, weekStart, type ReportSchedule, type WeeklyReport } from "../../dashboard/_components/types";
import styles from "./reports.module.css";

const WEEKS_BACK = 8;
interface Props { ws: string; projectKey: string; yearFormat: YearFormat; issueHref: (key: string) => string; canSend: boolean }
type Notice = { tone: "ok" | "error"; message: string };

export function WeeklyReportView({ ws, projectKey, yearFormat, issueHref, canSend }: Props) {
  const t = useTranslations("lead-dashboard-reports");
  const endpoint = projectEndpoint(ws, projectKey);
  const current = weekStart(todayIso());
  const [week, setWeek] = useState(current);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sending, setSending] = useState(false);
  const report = useQuery({ queryKey: ["reports", ws, projectKey, "weekly", week], queryFn: () => api.get<WeeklyReport>(`${endpoint}/reports/weekly?week=${week}`) });
  // รอบส่งเป็นข้อมูลประกอบ · โหลดไม่ได้ก็ยังแสดงรายงาน
  const schedule = useQuery({ queryKey: ["reports", ws, projectKey, "schedule"], queryFn: () => api.get<ReportSchedule>(`${endpoint}/report-schedule`), retry: false });

  if (report.error instanceof ApiError && report.error.status === 403) return <Forbidden />;
  const weeks = Array.from({ length: WEEKS_BACK }, (_, index) => addDays(current, -7 * index));
  const weekLabel = (start: string) => formatDateRange(start, addDays(start, 4), yearFormat);
  const data = report.data;
  const text = draft ?? data?.text ?? "";
  const sched = schedule.data?.schedule ?? null;

  function pickWeek(value: string) {
    setWeek(value); setDraft(null); setEditing(false); setNotice(null);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: "ok", message: t("weekly.copied") });
    } catch {
      setNotice({ tone: "error", message: t("weekly.copyFailed") });
    }
  }
  async function send() {
    setSending(true); setNotice(null);
    try {
      const result = await api.post<{ sent: number }>(`${endpoint}/reports/weekly:send`);
      setNotice({ tone: result.sent ? "ok" : "error", message: result.sent ? t("weekly.sent", { count: result.sent }) : t("weekly.sentNone") });
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : t("weekly.sendFailed") });
    } finally { setSending(false); }
  }

  return <>
    <div className={`${styles.card} ${styles.bar}`}>
      <Select size="small" aria-label={t("weekly.round")} value={week} onChange={(event) => pickWeek(event.target.value)}>
        {weeks.map((start) => <option key={start} value={start}>{start === current ? t("weekly.roundDraft", { range: weekLabel(start) }) : t("weekly.roundPast", { range: weekLabel(start) })}</option>)}
      </Select>
      <span className={styles.muted}>{sched ? t("weekly.recipients", { count: sched.recipients.length }) : schedule.isLoading ? "" : t("weekly.noSchedule")}</span>
      <span className={styles.spacer} />
      <Button aria-pressed={editing} disabled={!data} onClick={() => { setEditing(!editing); if (!editing && draft === null && data) setDraft(data.text); }}>{editing ? t("weekly.doneEditing") : t("weekly.edit")}</Button>
      <Button disabled={!data} onClick={() => void copy()}>{t("weekly.copy")}</Button>
      <Button disabled={!data} onClick={() => window.print()}>{t("weekly.pdf")}</Button>
      {canSend && week === current && <Button variant="primary" disabled={!data || sending} onClick={() => void send()}>{sending ? t("weekly.sending") : t("weekly.send")}</Button>}
    </div>
    {notice && <FloatingNotice tone={notice.tone === "ok" ? "info" : "error"}><span>{notice.message}</span></FloatingNotice>}
    {report.error ? <ErrorState error={report.error} retry={() => void report.refetch()} />
      : !data ? <LoadingState />
        : editing ? <div className={styles.card}>
          <label className={styles.editLabel} htmlFor="weekly-text">{t("weekly.editLabel")}</label>
          <textarea id="weekly-text" className={styles.editor} value={text} onChange={(event) => setDraft(event.target.value)} rows={18} />
          <div className={styles.editFoot}><Button size="small" variant="ghost" onClick={() => setDraft(data.text)}>{t("weekly.resetText")}</Button></div>
        </div>
          : <Document report={data} yearFormat={yearFormat} issueHref={issueHref} schedule={sched} settingsHref={`${projectBase(ws, projectKey)}/settings/notify`} />}
  </>;
}

function Document({ report: r, yearFormat, issueHref, schedule, settingsHref }: { report: WeeklyReport; yearFormat: YearFormat; issueHref: (key: string) => string; schedule: ReportSchedule["schedule"]; settingsHref: string }) {
  const t = useTranslations("lead-dashboard-reports");
  const tone = STATUS_TONE[r.status];
  const keys = (list: { key: string }[]) => list.map((item, index) => <span key={item.key}>{index > 0 && ", "}<Link href={issueHref(item.key)}>{item.key}</Link></span>);
  const holidays = r.nextWeek.holidays.map((h) => formatDate(h.date, yearFormat)).join(", ");
  return <article className={`${styles.card} ${styles.doc}`} aria-label={t("reports.kind.weekly")}>
    <div>
      <div className={styles.muted}>{r.week.draft ? t("weekly.metaDraft", { date: formatDate(r.week.asOf, yearFormat) }) : t("weekly.metaFinal", { date: formatDate(r.week.end, yearFormat) })}</div>
      <h2>{t("weekly.heading", { project: r.project.name, range: formatDateRange(r.week.start, addDays(r.week.start, 4), yearFormat) })}</h2>
    </div>
    <dl className={styles.stats}>
      <div><dt>{t("weekly.status")}</dt><dd style={{ color: tone.fg }}>{t(`status.${r.status}`)}</dd></div>
      <div><dt>{t("weekly.doneTotal")}</dt><dd>{t("weekly.doneTotalValue", { done: r.totals.doneCount, total: r.totals.taskCount })}</dd></div>
      <div><dt>{t("weekly.mdUsed")}</dt><dd>{r.totals.usedMd} / {r.totals.totalMd}</dd></div>
      <div><dt>{t("weekly.late")}</dt><dd style={{ color: r.totals.overdue ? "#B91C1C" : undefined }}>{r.totals.overdue}</dd></div>
    </dl>

    <div>
      <h3>{t("weekly.thisWeek")}</h3>
      <ul>
        <li>{t.rich("weekly.doneLine", { count: r.thisWeek.done.count, md: r.thisWeek.done.md, inProgress: r.thisWeek.inProgress, inReview: r.thisWeek.inReview, b: (chunk) => <b>{chunk}</b> })}</li>
        {r.thisWeek.overdue.count > 0 && <li>{t("weekly.overdueLine", { count: r.thisWeek.overdue.count, people: r.thisWeek.overdue.byAssignee.map((p) => `${p.displayName} ${p.count}`).join(" · ") })}</li>}
        {r.thisWeek.newBugs.length > 0 && <li>{t("weekly.newBugs", { count: r.thisWeek.newBugs.length })} {keys(r.thisWeek.newBugs)}</li>}
        {r.thisWeek.fixedBugs.length > 0 && <li>{t("weekly.fixedBugs", { count: r.thisWeek.fixedBugs.length })} {keys(r.thisWeek.fixedBugs)}</li>}
      </ul>
    </div>

    <div>
      <h3>{holidays ? t("weekly.nextWeekOff", { range: formatDateRange(r.nextWeek.start, addDays(r.nextWeek.start, 4), yearFormat), holidays }) : t("weekly.nextWeek", { range: formatDateRange(r.nextWeek.start, addDays(r.nextWeek.start, 4), yearFormat) })}</h3>
      <ul>
        <li>{t.rich("weekly.startingLine", { count: r.nextWeek.starting.count, md: r.nextWeek.starting.md, b: (chunk) => <b>{chunk}</b> })}{r.nextWeek.starting.byModule.length > 0 && `: ${r.nextWeek.starting.byModule.map((m) => `${m.name} ${m.count}`).join(" · ")}`}</li>
        {r.nextWeek.sprintEvents.map((event) => <li key={`${event.type}-${event.name}`}>{t(`weekly.${event.type}`, { name: event.name, date: formatDate(event.date, yearFormat) })}</li>)}
      </ul>
    </div>

    <div>
      <h3>{t("weekly.risks")}</h3>
      {!r.risks.length ? <p className={styles.muted}>{t("weekly.noRisks")}</p> : <div className={styles.tableScroll}><table className={styles.table}>
        <thead><tr><th>{t("weekly.riskCol")}</th><th>{t("weekly.impactCol")}</th><th>{t("weekly.issuesCol")}</th></tr></thead>
        <tbody>{r.risks.map((risk) => <tr key={risk.kind}><td><b>{risk.title}</b></td><td>{risk.detail}</td><td>{risk.issueKeys.length ? keys(risk.issueKeys.slice(0, 5).map((key) => ({ key }))) : "—"}</td></tr>)}</tbody>
      </table></div>}
    </div>

    <div>
      <h3>{t("weekly.help")}</h3>
      {r.needsHelp.unassigned.count ? <ul><li>{t("weekly.unassigned", { count: r.needsHelp.unassigned.count })} {keys(r.needsHelp.unassigned.keys.map((key) => ({ key })))}</li></ul>
        : <p className={styles.muted}>{t("weekly.noHelp")}</p>}
    </div>

    <div className={styles.docFoot}>
      {schedule ? t("weekly.scheduleOn", { day: t(`weekday.d${schedule.weekday}`), time: schedule.time }) : t("weekly.scheduleOff")} · <Link href={settingsHref}>{t("weekly.scheduleLink")}</Link>
    </div>
  </article>;
}
