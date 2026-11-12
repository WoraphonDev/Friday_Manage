/** รูปแบบข้อมูลของ ops-api › ops/restore (O31) */

export type TrashType = "issue" | "project" | "file";

export interface Deleter {
  name: string;
  role: string | null;
}

export interface TicketView {
  id: string;
  number: number;
  subject: string;
  status: string;
  requesterEmail: string | null;
  requesterRole: string | null;
  eligible: boolean;
  reason: string | null;
}

interface ItemBase {
  id: string;
  ids: string[];
  count: number;
  project: { key: string; name: string };
  deletedBy: Deleter | null;
  deletedAt: string;
  purgeAt: string;
  daysLeft: number;
}
export type TrashItem =
  | (ItemBase & { type: "issue"; keys: string[]; projects: string[]; subtasks: number })
  | (ItemBase & { type: "project"; counts: { issues: number; files: number }; keyTaken: boolean })
  | (ItemBase & { type: "file"; sizeBytes: number; folder: string | null });

export interface TrashList {
  workspace: { id: string; slug: string; name: string; deleted: boolean };
  ticket: TicketView;
  trashDays: number;
  counts: { all: number; project: number; issue: number; file: number };
  items: TrashItem[];
}

export interface Summary {
  pendingWorkspaces: number;
  pendingSoon: number;
  restored30d: { total: number; issue: number; project: number; file: number; workspace: number };
  purgeTonight: { issues: number; projects: number; runsAt: string };
  backupDays: number;
}

export interface PendingWorkspace {
  id: string;
  slug: string;
  name: string;
  members: number;
  plan: string | null;
  planStatus: string | null;
  deletedAt: string;
  deletedBy: Deleter | null;
  purgeAfter: string;
  daysLeft: number;
  extendedDays: number;
  extendLeft: number;
  tickets: { id: string; number: number; subject: string; status: string }[];
  pendingApprovals: { id: string; kind: string }[];
}

export interface LookupResult {
  q: string;
  kind: "issue" | "project";
  status: "live" | "in_trash" | "purged" | "not_found";
  deletedAt?: string | null;
  purgedAt?: string | null;
  trashDays: number;
  backupDays: number;
}

export interface HistoryItem {
  id: string;
  action: string;
  reason: string;
  workspaceId: string | null;
  workspaceName: string | null;
  staffName: string | null;
  approvedBy: string | null;
  selfApproved: boolean;
  createdAt: string;
}
