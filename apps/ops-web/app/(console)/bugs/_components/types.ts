// ชนิดข้อมูลของ ops-api › ops/dev-bridge (O36) · ตรงกับ apps/ops-api/src/dev-bridge/dev-bridge.service.ts
import { useTranslations } from "next-intl";
import type { Tone } from "@/components/ui";

export const BRIDGE_KEY = ["ops", "dev-bridge"] as const;
export const SEVERITIES = ["S1", "S2", "S3", "S4"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Filter = "open" | "to_notify" | "not_fixed" | "closed30";

export interface Mapping {
  severityPriority: Record<Severity, Priority>;
  releasedStatus: string;
  label: string;
  issueType: "Bug";
}

export interface Settings {
  configured: boolean;
  apiBaseUrl: string | null;
  workspaceSlug: string | null;
  projectKey: string | null;
  tokenHint: string | null;
  tokenExpiresAt: string | null;
  hasWebhookSecret: boolean;
  webhookPath: string;
  mapping: Mapping;
  lastWebhookAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  projectUrl: string | null;
  canEdit: boolean;
}

export interface Overview {
  kpi: {
    openBugs: number;
    bySeverity: Record<Severity, number>;
    ticketsWaiting: number;
    workspaces: number;
    avgFixDaysS2: number | null;
    toNotify: number;
    linksToNotify: number;
  };
  released: {
    linkId: string;
    issueKey: string;
    releasedAt: string;
    tickets: number;
  }[];
  connection: Settings;
  canNotify: boolean;
}

/** สถานะงานใน FM ที่ใช้แสดงป้าย (แถวในตาราง / การ์ด T8) */
export interface LinkStatus {
  issueKey: string;
  statusName: string | null;
  statusCategory: string | null;
  resolution: "wont_fix" | "duplicate" | null;
  duplicateOfKey: string | null;
  sprintName: string | null;
  doneAt: string | null;
  releasedAt: string | null;
}

export interface LinkRow extends LinkStatus {
  id: string;
  title: string;
  severity: Severity;
  assigneeName: string | null;
  dueDate: string | null;
  createdAt: string;
  tickets: number;
  unnotified: number;
  workspaces: string[];
}

export interface LinkDetail extends LinkStatus {
  id: string;
  title: string;
  severity: Severity;
  assigneeName: string | null;
  dueDate: string | null;
  releaseVersion: string | null;
  syncedAt: string | null;
  createdAt: string;
  url: string | null;
  tickets: {
    id: string;
    number: number;
    status: string;
    workspace: string | null;
    notifiedAt: string | null;
    outcome: "fixed" | "workaround" | "returned" | null;
  }[];
  unnotified: number;
}

export interface FmIssue {
  key: string;
  title: string;
  status: { name: string; category: string };
  priority: string;
  linkedTickets: number;
  url: string | null;
}

export const severityTone = (s: string): Tone => (s === "S1" ? "bad" : s === "S2" ? "warn" : s === "S4" ? "ok" : "neu");
export const categoryTone = (c: string | null): Tone => (c === "done" ? "ok" : c === "in_progress" ? "warn" : c === "review" ? "inf" : c === "blocked" || c === "cancelled" ? "bad" : "neu");

const time = (iso: string) => {
  const d = new Date(iso);
  const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(d) === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  return new Intl.DateTimeFormat(
    "th-TH",
    sameDay
      ? { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }
      : {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Bangkok",
        },
  ).format(d);
};

/** ป้ายสถานะงานแบบบอร์ด 20: "Done · ขึ้น production 15:05" · "In progress · Sprint 24" · "ไม่แก้ · ซ้ำกับ FM-466" */
export function useStatusLabel() {
  const t = useTranslations("bugs.status");
  return (l: LinkStatus): { text: string; tone: Tone } => {
    if (l.resolution === "duplicate")
      return {
        text: l.duplicateOfKey ? t("duplicate", { key: l.duplicateOfKey }) : t("duplicateNoKey"),
        tone: "bad",
      };
    if (l.resolution === "wont_fix") return { text: t("wont_fix"), tone: "bad" };
    if (!l.statusName) return { text: t("unknown"), tone: "neu" };
    if (l.statusCategory === "done" && l.releasedAt)
      return {
        text: t("released", { name: l.statusName, time: time(l.releasedAt) }),
        tone: "ok",
      };
    if (l.sprintName && l.statusCategory !== "done")
      return {
        text: t("withSprint", { name: l.statusName, sprint: l.sprintName }),
        tone: categoryTone(l.statusCategory),
      };
    return { text: l.statusName, tone: categoryTone(l.statusCategory) };
  };
}

export const timeText = time;
