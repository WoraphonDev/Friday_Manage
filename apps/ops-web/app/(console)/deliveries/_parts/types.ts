// รูปข้อมูลจาก ops-api `GET ops/deliveries` (O23)
import { useTranslations } from "next-intl";

export type Channel = "email" | "line" | "line_group" | "webhook";
export type UiStatus = "ok" | "fail" | "retry" | "quiet" | "blocked" | "queued";
export interface Item {
  id: string;
  createdAt: string;
  channel: Channel;
  to: string;
  workspace: { id: string; name: string; slug: string };
  event: { type: string | null; issueKey: string | null };
  status: UiStatus;
  attempts: number;
}
export interface Stats {
  total: number;
  byChannel: { email: number; line: number; webhook: number };
  deliveredPct: number | null;
  failed: { total: number; email: number; line: number; webhook: number };
  waitingQuiet: number;
  suppressed: number;
  bouncePct: number | null;
}
export interface ListResponse {
  stats: Stats;
  items: Item[];
  nextBefore: string | null;
}
export interface LogEntry {
  at: string;
  kind: "attempt_ok" | "attempt_failed" | "quiet" | "suppressed" | "cancelled" | "paused" | "resend" | "bounced" | "complained";
  attempt?: number;
  status?: number | null;
  message?: string;
  final?: boolean;
}
export interface Content {
  view: { subject?: string; text: string } | null;
  request?: { method: string; url: string; headers: Record<string, string>; body: string | null };
}
export interface Detail extends Omit<Item, "workspace"> {
  workspace: Item["workspace"] | null;
  sentAt: string | null;
  lastError: string | null;
  response: { status: number | null; body: string | null } | null;
  log: LogEntry[];
  webhook: { id: string; name: string; status: string } | null;
  suppression: { id: string; reason: SuppressionReason; since: string } | null;
  content: Content | null;
  contentAccess: { allowed: boolean; reason: "role" | "no_grant" | null };
  canResend: boolean;
  resendRequested: boolean;
  event: Item["event"] & { projectKey?: string | null };
}
export type SuppressionReason = "hard_bounce" | "complaint" | "soft_bounce_repeated" | "manual";
export interface Suppression {
  id: string;
  email: string;
  reason: SuppressionReason;
  detail: string | null;
  source: string;
  workspace: { id: string; name: string } | null;
  since: string;
}

export const STATUS_TONE: Record<UiStatus, "ok" | "bad" | "warn" | "neu" | "inf"> = { ok: "ok", fail: "bad", retry: "warn", quiet: "warn", blocked: "neu", queued: "inf" };
export const REASON_TONE: Record<SuppressionReason, "bad" | "warn" | "neu"> = { hard_bounce: "bad", complaint: "warn", soft_bounce_repeated: "neu", manual: "neu" };

/** ชื่อเหตุการณ์ภาษาไทย + Issue key · เหตุการณ์ที่ไม่รู้จักแสดงรหัสตรง ๆ */
export function useEventText() {
  const t = useTranslations("dlv.events");
  return (e: { type: string | null; issueKey: string | null }) => {
    // key ของ next-intl ห้ามมีจุด จึงแปลง issue.assigned → issue_assigned
    const key = (e.type ?? "").replace(/\./g, "_") as "issue_assigned";
    const name = e.type && t.has(key) ? t(key) : (e.type ?? "—");
    return e.issueKey ? `${name} ${e.issueKey}` : name;
  };
}
