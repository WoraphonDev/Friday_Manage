import type { Person } from "@/lib/types";
import type { StatusCategory } from "@/lib/status";

export type Filter = "all" | "unread" | "assign" | "mention" | "activity" | "due";
export interface InboxNotification {
  id: string;
  workspaceId: string;
  eventType: string;
  category: Exclude<Filter, "all" | "unread">;
  actor: (Person & { displayName: string | null }) | null;
  project: { key: string; name: string | null } | null;
  payload: Record<string, unknown>;
  reason: string;
  readAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  issue?: {
    key: string;
    title: string;
    type: string;
    status: { name: string; category: StatusCategory };
    moduleName: string | null;
    planEnd: string | null;
    deleted: boolean;
    assignees: Person[];
  } | null;
  dueRequest?: {
    id: string;
    status: "pending" | "approved" | "rejected" | "cancelled";
    currentDue: string | null;
    requestedDue: string;
    reasonLabel: string;
    detail: string | null;
    decidedBy: Person | null;
    canDecide: boolean;
  } | null;
}
export interface InboxPage {
  items: InboxNotification[];
  counts: Record<Filter, number>;
  nextCursor: string | null;
}
export const inboxKey = (ws: string) => ["inbox", ws] as const;
