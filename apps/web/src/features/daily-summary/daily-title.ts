"use client";

import { useTranslations } from "next-intl";

/** แจ้งเตือนสรุปงานประจำวัน 08:30 (API: Reminders.daily) · รวมใกล้ครบกำหนด / วันนี้ / เลยกำหนด / รอ Review / งานทีมเลยกำหนด */
export const DAILY_EVENT = "digest.daily";

export interface Item {
  issueKey: string;
  title: string;
  planEnd: string | null;
  projectKey: string;
  daysLate?: number;
  daysLeft?: number;
  assignees?: (string | null)[];
}
export interface TeamGroup {
  projectKey: string;
  projectName: string;
  count: number;
  issues: Item[];
}

export const items = (v: unknown) => (Array.isArray(v) ? (v as Item[]) : []);
export const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
export const teams = (p: Record<string, unknown>) => (Array.isArray(p.team) ? (p.team as TeamGroup[]) : []);

export function counts(p: Record<string, unknown>) {
  return {
    dueToday: num(p.dueTodayCount, items(p.dueToday).length),
    overdue: num(p.overdueCount, items(p.overdue).length),
    dueSoon: num(p.dueSoonCount, items(p.dueSoon).length),
    review: num(p.reviewCount, items(p.review).length),
    team: num(p.teamCount, teams(p).reduce((n, g) => n + num(g.count, items(g.issues).length), 0)),
  };
}

/** หัวเรื่องตามภาษาของผู้ใช้ (payload.title เก็บเป็นภาษาไทย) */
export function useDailyTitle() {
  const t = useTranslations("inbox-bell.daily");
  return (p: Record<string, unknown>) => {
    const c = counts(p);
    return (["dueToday", "overdue", "dueSoon", "review", "team"] as const)
      .filter((k) => c[k] > 0)
      .map((k) => t(`count.${k}`, { count: c[k] }))
      .join(" · ");
  };
}

