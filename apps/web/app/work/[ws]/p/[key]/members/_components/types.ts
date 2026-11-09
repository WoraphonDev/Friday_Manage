import type { Person } from "@/lib/types";

export type Unit = "md" | "hour" | "count";
export type Group = "day" | "week" | "month";
export type ProjectRole = "admin" | "member" | "viewer";

/** GET projects/{key}/workload (A08) */
export interface WorkloadCell {
  value: number;
  capacity: number | null;
  utilizationPct: number | null;
  over: boolean;
  leaveDays: number;
  issues: { key: string; title: string; value: number }[];
}
export interface WorkloadPerson {
  person: Person & { initials: string };
  position: string | null;
  projectRole: ProjectRole;
  capacityHoursWeek: number;
  cells: WorkloadCell[];
  total: { value: number; capacity: number | null; utilizationPct: number | null; leaveDays: number };
}
export interface Workload {
  range: { from: string; to: string };
  unit: Unit;
  group: Group;
  hoursPerMd: number;
  buckets: { start: string; end: string }[];
  people: WorkloadPerson[];
  team: { value: number; capacity: number | null; utilizationPct: number | null }[];
  thisWeek: {
    from: string;
    to: string;
    people: number;
    capacityMd: number;
    assignedMd: number;
    utilizationPct: number | null;
    overloaded: { person: Person; utilizationPct: number | null }[];
  };
  withoutBa: number;
  unscheduled: { count: number; noDates: number; noEstimate: number };
}

/** GET projects/{key}/members (A04) */
export interface ProjectMember {
  userId: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
  email: string | null;
  role: ProjectRole;
  isOwner: boolean;
  isGuest: boolean;
  active: boolean;
  position: string | null;
  capacityHoursWeek: number | null;
  capacityMdWeek: number | null;
  openIssues: number;
  overdueIssues: number;
  openMd: number;
  joinedAt: string;
}
export interface ProjectMembers {
  items: ProjectMember[];
  canInvite: boolean;
  canManage: boolean;
}

/** GET w/{ws}/invitations (A14 · Owner / Admin ของ Workspace) */
export interface Invitation {
  id: string;
  email: string;
  workspaceRole: "admin" | "member" | "guest";
  projectId: string | null;
  projectRole: ProjectRole | null;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}
export interface InviteResult {
  items: (
    | { email: string; status: "invited"; invitationId: string; inviteUrl: string; expiresAt: string }
    | { email: string; status: "already_member" }
  )[];
}

/** GET w/{ws}/members */
export interface WorkspaceMember {
  userId: string;
  displayName: string;
  email: string;
  role: "owner" | "admin" | "member" | "guest";
  status: "active" | "deactivated";
  jobTitle: string | null;
  capacityHoursWeek: number;
  lastActiveAt: string | null;
}
