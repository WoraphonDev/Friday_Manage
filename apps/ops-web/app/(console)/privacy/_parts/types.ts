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
  /** คำขอลบของผู้ใช้ที่ติด Legal hold → "รอ Legal hold" (H11) */
  legalHold?: boolean;
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
  /** Lead ฝ่ายขายที่อีเมลตรงกับผู้ขอ (ทีม Friday เป็นผู้ควบคุมข้อมูล) */
  leads: { id: string; number: number; company: string; contactName: string | null; contactTitle: string | null; email: string | null; phone: string | null; message: string | null; source: string; stage: string; consentAt: string | null; ip: string | null; createdAt: string; notes: number; acceptedQuotes: number }[];
  erasePlan: { remove: string[]; anonymize: string[]; keep: string[]; backupDays: number; blockers: { code: string; workspace: string | null }[] } | null;
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

/** Workspace ที่รอลบ (H10) · แหล่งเดียวกับหน้ากู้คืน */
export interface PendingDelete {
  id: string;
  slug: string;
  name: string;
  requestedAt: string;
  purgeAt: string;
  daysLeft: number;
  requestedBy: { name: string; email: string; role: string } | null;
  system: boolean;
  legalHold: boolean;
  unpaidInvoices: number;
  purgeApproval: string | null;
  purgeApproved: boolean;
}
export interface PurgePreview {
  workspace: { id: string; slug: string; name: string; purgeAt: string };
  remove: { projects: number; issues: number; bytes: number; members: number };
  keepYears: number;
  tickets: { id: string; number: number; subject: string; status: string; fromOwner: boolean }[];
  checks: { legalHold: boolean; unpaidInvoices: number };
}
export interface LegalHold {
  id: string;
  workspaceId: string;
  scope: "workspace" | "users";
  userIds: string[];
  userEmails: string[];
  reason: string;
  reference: string;
  reviewOn: string | null;
  notifyCustomer: boolean;
  createdAt: string;
  createdByName: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  workspace: { id: string; name: string; slug: string };
  active: boolean;
  releaseApproval: string | null;
}
export type RetentionKey = "workspaceDataDays" | "trashDays" | "systemLogDays" | "staffAuditDays";
export interface RetentionRow {
  key: RetentionKey;
  label: string;
  enforced: boolean;
  note: string | null;
  days: number;
  defaultDays: number;
  min: number;
  max: number;
  pendingApproval: { id: string; key: string; days: number } | null;
}
export interface RetentionInfo {
  rows: RetentionRow[];
  taxYears: number;
  lastRun: { at?: string; logRows?: number; sessionRows?: number; systemLogDays?: number } | null;
}
