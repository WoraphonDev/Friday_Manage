// ข้อมูลจาก ops-api `ops/onboarding` (O34) · ตัวเลขและชื่อ Workspace เท่านั้น
export const STEPS = ["first_project", "issues", "team", "assign_due", "status_update", "notifications"] as const;
export type StepKey = (typeof STEPS)[number];
export type FollowupStatus = "open" | "emailed" | "no_reply" | "replied" | "done";

export interface StuckRow {
  id: string;
  name: string;
  slug: string;
  members: number;
  createdAt: string;
  plan: string | null;
  subStatus: string | null;
  trialDaysLeft: number | null;
  done: number;
  stuckStep: StepKey | null;
  stuckDays: number;
  lastActiveAt: string | null;
  followup: { assigneeId: string | null; assigneeName: string | null; status: FollowupStatus; lastEmailedAt: string | null } | null;
}

export interface OnboardingOverview {
  days: 7 | 30 | 90;
  version: number;
  kpis: { newWorkspaces: number; trial: number; free: number; completedPct: number; avgDaysToComplete: number | null; activatedPct: number; stuckOver3: number; stuckUnassigned: number };
  funnel: { key: StepKey; passed: number; pct: number; avgDays: number | null; drop: number | null }[];
  insights: { biggestDrop: { key: StepKey; drop: number; paidPassedPct: number; paidOtherPct: number } | null; notificationsPct: number };
  stuck: StuckRow[];
  inactive: StuckRow[];
}

export interface OnboardingDetail {
  workspace: { id: string; name: string; slug: string; createdAt: string; members: number; plan: string | null; subStatus: string | null; trialDaysLeft: number | null; lastActiveAt: string | null };
  owner: { name: string; email: string | null; suppressed: boolean } | null;
  version: number;
  done: number;
  total: number;
  complete: boolean;
  stuckStep: StepKey | null;
  stuckDays: number;
  inactive: boolean;
  steps: { key: StepKey; doneAt: string | null; meta: Record<string, number> }[];
  signals: { pendingInvites: number; oldestInviteAt: string | null; acceptedInvites: number; active7d: number; activeDays7d: number; openTickets: number; acquisition: { source: string | null; medium: string | null; via: string } | null };
  followup: { assigneeId: string | null; assigneeName: string | null; status: FollowupStatus; note: string | null; lastEmailedAt: string | null; emailsSent: number; nextEmailAt: string | null } | null;
  assignees: { id: string; name: string }[];
}

export interface CannedReply {
  id: string;
  title: string;
  body: string;
  tag: string | null;
}

export const onbKey = (days: number) => ["ops", "onboarding", days] as const;
export const onbDetailKey = (id: string) => ["ops", "onboarding", "ws", id] as const;
