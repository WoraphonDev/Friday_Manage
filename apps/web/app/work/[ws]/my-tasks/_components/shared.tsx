"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui";
import { formatDate, type YearFormat } from "@/lib/format";
import type { TaskItem } from "./types";
import styles from "./hmt.module.css";

export const taskHref = (ws: string, projectKey: string, issueKey: string) =>
  `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/board?issue=${encodeURIComponent(issueKey)}`;
export const projectHref = (ws: string, projectKey: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;

export const STATUS_TONE = { todo: "neutral", in_progress: "blue", done: "green" } as const;

/** "เลย N วัน" / "วันนี้" / วันที่ (ข้อความอยู่ใน namespace ของงานนี้) */
export function useDueText() {
  const t = useTranslations("home-my-tasks.tasks");
  return (item: Pick<TaskItem, "due" | "planEnd">, year: YearFormat) => {
    const { state, days } = item.due;
    if (state === "overdue") return { text: t("dueLabels.overdue", { days: days ?? 0 }), cls: styles.late };
    if (state === "today") return { text: t("dueLabels.today"), cls: styles.today };
    if (state === "done") return { text: t("dueLabels.done"), cls: styles.done };
    if (state === "none" || !item.planEnd) return { text: t("dueLabels.none"), cls: styles.muted };
    return { text: formatDate(item.planEnd, year), cls: "" };
  };
}

export function StatusBadge({ category, name }: { category: "todo" | "in_progress" | "done"; name: string }) {
  const review = /review/i.test(name);
  return <Badge tone={review ? "amber" : STATUS_TONE[category]}>{name}</Badge>;
}

export const bkkHour = (now = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(now)) % 24;
