import type { OpsRole } from "@/lib/types";

/** รูปแบบของ ops-api › workspaces/customers.service (O02) · เงินเป็นสตางค์ */
export type Integration = "line" | "webhook" | "github" | "apiToken" | "automation" | "import";
export interface WsRow {
  id: string;
  slug: string;
  name: string;
  status: "trial" | "active" | "suspended" | "pending_delete";
  createdAt: string;
  plan: string | null;
  subStatus: "trialing" | "active" | "past_due" | "canceled" | null;
  cycle: "monthly" | "yearly" | null;
  trialEndsAt: string | null;
  periodEnd: string | null;
  seats: number;
  seatLimit: number | null;
  projects: number;
  active30: number;
  lastActiveAt: string | null;
  storageBytes: number;
  integrations: Integration[];
  health: number;
  mrr: number | null;
  paymentState: "ok" | "overdue";
}
export interface WsList {
  items: WsRow[];
  total: number;
  limit: number;
  offset: number;
  sort: string;
}
export interface Signal {
  code: string;
  message: string;
}
export interface Overview {
  id: string;
  slug: string;
  name: string;
  status: WsRow["status"];
  /** ถูกระงับ (C6) */
  suspension?: { mode: "read_only" | "full" | null; message: string | null; autoResume: boolean } | null;
  createdAt: string;
  dataRegion: string | null;
  legalName: string | null;
  subscription: { plan: string | null; status: string; cycle: string; trialEndsAt: string | null; currentPeriodEnd: string | null; paymentMethod: string | null; discount: { percent?: number; months?: number | null; active?: boolean } | null; seatLimit: number | null; pending?: { plan: string | null; cycle: string; at: string | null } | null } | null;
  usage: { members: number; guests: number; projects: number; issues: number; storageBytes: number; active30: number; lastActiveAt: string | null };
  owners: { id: string; email: string | null; displayName: string; role: "owner" | "admin" }[];
  supportAccess: { until: string | null; maxMode: "read" | "write"; notifyAdmins: boolean; active: boolean } | null;
  supportSessions: { id: string; ticketNo: string; mode: string; startedAt: string; endedAt: string | null; staffId: string }[];
  invoices: { id: string; number: string; status: string; total: number | null; amountDue: number | null; dueDate: string; paidAt: string | null; createdAt: string }[];
  health: { score: number; parts: { usage: number; payment: number; support: number; growth: number } };
  integrations: Integration[];
  topFeatures: string[];
  unusedFeatures: string[];
  acquisition: { source: string | null; medium: string | null; campaign: string | null; referrerHost: string | null; via: string } | null;
  economics: { mrrSatang: number; revenueSatang: number; costSatang: number; grossSatang: number; marginPct: number | null; costs: Record<string, { satang: number; qty?: number; gb?: number }> } | null;
  upgradeSignals: Signal[];
  notes: { id: string; text: string; staffName: string | null; createdAt: string }[];
}
export interface Member {
  id: string;
  email: string | null;
  displayName: string;
  role: "owner" | "admin" | "member" | "guest";
  jobTitle: string | null;
  status: "active" | "deactivated";
  lastActiveAt: string | null;
  joinedAt: string;
  login: string[];
  mfaEnabled: boolean;
  locked: boolean;
  disabled: boolean;
}
export const ROLE_NEEDS: Record<string, OpsRole[]> = {
  money: ["owner", "finance", "auditor"],
};
