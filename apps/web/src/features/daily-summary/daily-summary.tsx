"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { formatDate } from "@/lib/format";
import { counts, type Item, items, num, teams } from "./daily-title";
import styles from "./daily-summary.module.css";

export { DAILY_EVENT, useDailyTitle } from "./daily-title";

const issueHref = (ws: string, key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key.split("-")[0])}/board?issue=${encodeURIComponent(key)}`;

/** เนื้อหาในหน้า Inbox: หัวข้อละรายการ คลิกเปิดงาน */
export function DailySummary({ ws, payload }: { ws: string; payload: Record<string, unknown> }) {
  const t = useTranslations("inbox-bell.daily");
  const { me } = useWorkspace();
  const c = counts(payload);
  const section = (key: string, label: string, list: Item[], total: number, tone: "danger" | "warning" | "neutral", extra: (i: Item) => string | null) =>
    list.length ? (
      <section key={key} className={styles.section} aria-label={label}>
        <h3 className={styles.head} data-tone={tone}>
          {label} <span className={styles.count}>{total}</span>
        </h3>
        <ul className={styles.list}>
          {list.map((i) => {
            const note = [extra(i), i.assignees?.filter(Boolean).join(", ")].filter(Boolean).join(" · ");
            return (
              <li key={i.issueKey}>
                <Link className={styles.item} href={issueHref(ws, i.issueKey)}>
                  <span className={styles.key}>{i.issueKey}</span>
                  <span className={styles.title}>{i.title}</span>
                  {note && <span className={styles.note}>{note}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        {total > list.length && <div className={styles.more}>{t("more", { count: total - list.length })}</div>}
      </section>
    ) : null;
  const late = (i: Item) => (typeof i.daysLate === "number" ? t("late", { days: i.daysLate }) : null);
  return (
    <div className={styles.wrap}>
      {section("today", t("section.dueToday"), items(payload.dueToday), c.dueToday, "warning", () => null)}
      {section("overdue", t("section.overdue"), items(payload.overdue), c.overdue, "danger", late)}
      {section("soon", t("section.dueSoon"), items(payload.dueSoon), c.dueSoon, "neutral", (i) => (i.planEnd ? t("due", { date: formatDate(i.planEnd, me.yearFormat) }) : null))}
      {section("review", t("section.review"), items(payload.review), c.review, "neutral", () => null)}
      {teams(payload).map((g) => section(`team-${g.projectKey}`, t("section.team", { project: g.projectName || g.projectKey }), items(g.issues), num(g.count, items(g.issues).length), "danger", late))}
    </div>
  );
}
