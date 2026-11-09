export const REQUEST_TYPES = ["access", "export", "rectify", "erase", "object", "restrict"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export type Identity = "unverified" | "email_match" | "link_confirmed";

export interface PrivacyRequest {
  id: string;
  number: number;
  requestType: RequestType;
  requesterEmail: string;
  userId: string | null;
  workspaceIds: string[];
  details: string | null;
  receivedAt: string;
  dueDate: string;
  identity: Identity;
  step: number;
  status: "open" | "completed" | "rejected";
  completedAt: string | null;
  rejectionReason: string | null;
  approvalRequestId: string | null;
  stepLabel: string;
  daysLeft: number;
  overdue: boolean;
  workspaces?: { id: string; name: string; slug: string }[];
}

export interface RequestDetail {
  request: PrivacyRequest;
  steps: { step: number; label: string; done: boolean }[];
  history: { at: string; action: string; text: string | null; staffName: string | null; approvedBy: string | null }[];
  scope: { memberships: { id: string; slug: string; name: string; role: string; status: string; soleOwner: boolean }[]; soleOwner: { slug: string; name: string }[]; invoicesKept: number };
  erasePlan: { remove: string[]; anonymize: string[]; keep: string[]; backupDays: number; blockers: { code: string; workspace: string }[] } | null;
}

export type Risk = "low" | "medium" | "high";
export interface Breach {
  id: string;
  number: number;
  discoveredAt: string;
  description: string;
  dataTypes: string[];
  affectedCount: number | null;
  workspaceIds: string[];
  risk: Risk;
  assessment: string | null;
  containment: string | null;
  containedAt: string | null;
  pdpcNotifiedAt: string | null;
  subjectsNotifiedAt: string | null;
  closedAt: string | null;
  pdpcDeadline: string;
  mustNotifyPdpc: boolean;
  hoursLeft: number | null;
  overdue: boolean;
}
export interface BreachDetail {
  breach: Breach;
  workspaces: { id: string; slug: string; name: string }[];
  log: { at: string; action: string; text: string | null; staffName: string | null }[];
}

export const dsr = (n: number) => `DSR-${String(n).padStart(4, "0")}`;
/** ค่าสำหรับ `<input type="datetime-local">` ตามเวลาเครื่อง */
export const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
/** วันนี้ตามเวลาไทย (YYYY-MM-DD) */
export const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
