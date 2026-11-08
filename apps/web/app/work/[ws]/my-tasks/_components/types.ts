import type { Person } from "@/lib/types";

export type Health = "on_track" | "at_risk" | "off_track" | "unknown";
export type DueState = "overdue" | "today" | "later" | "none" | "done";

export interface IssueRef {
  key: string;
  title: string;
  project: { key: string; name: string };
  status: { name: string; category: "todo" | "in_progress" | "done" };
  planEnd: string | null;
}
export interface ApprovalItem {
  id: string;
  requester: { id: string; displayName: string } | null;
  requestedDue: string;
  previousDue?: string | null;
  issue: { key: string; title: string; planEnd: string | null };
  project: { key: string; name: string };
  canDecide: boolean;
  status: string;
}
export interface HomeData {
  today: string;
  week: { start: string; end: string };
  summary: {
    dueToday: { team: number; mine: number; keys: string[] };
    overdue: { team: number; mine: number; byAssignee: { person: Person | null; count: number }[] };
    dueThisWeek: { team: number; mine: number; until: string };
    inProgress: { mine: number };
    waitingReview: number;
    unreadMentions: { count: number; latestFrom: string | null };
    pendingApprovals: number;
  };
  waiting: { approvals: ApprovalItem[]; reviews: (IssueRef & { from: Person | null })[] };
  projects: {
    key: string;
    name: string;
    color: string | null;
    goliveDate: string | null;
    daysToGolive: number | null;
    progressPct: number;
    overdue: number;
    myTasks: number;
    health: { level: Health; gapPct: number | null };
  }[];
  recent: { key: string; title: string; project: { key: string; name: string }; verb: string; at: string }[];
  upcoming: { date: string; type: "sprint_start" | "sprint_end" | "milestone" | "phase_end" | "holiday"; title: string; project: string | null }[];
  workload: {
    week: { start: string; end: string };
    team: { md: number; capacityMd: number; utilizationPct: number | null };
    mine: { md: number; capacityMd: number; utilizationPct: number | null } | null;
    people: { person?: Person; md: number; capacityMd: number; utilizationPct: number | null }[];
  } | null;
}
export interface InboxItem {
  id: string;
  eventType: string;
  actor: { id: string; displayName: string | null } | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export type Tab = "assigned" | "reviewer" | "watching" | "created";
export type GroupBy = "due" | "project" | "status";
export interface TaskItem {
  key: string;
  title: string;
  type: string | null;
  project: { key: string; name: string; color: string | null };
  status: { id: string; name: string; category: "todo" | "in_progress" | "done" };
  priority: "urgent" | "high" | "medium" | "low";
  planStart: string | null;
  planEnd: string | null;
  due: { state: DueState; days: number | null };
  estimateMd: number | null;
  parentKey: string | null;
  subtasks: { total: number; done: number } | null;
  assignees: Person[];
  version: number;
}
export interface TaskGroup {
  key: string;
  label: string;
  range?: { from: string; to: string };
  count: number;
  items: TaskItem[];
}
export interface MyIssues {
  today: string;
  tab: Tab;
  group: GroupBy;
  counts: Record<Tab, number>;
  total: number;
  groups: TaskGroup[];
}
export interface FormOptions {
  issueTypes: { name: string; statuses: { id: string; name: string; category: "todo" | "in_progress" | "done" }[] }[];
}
