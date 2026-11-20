import type { OpsRole } from "@/lib/types";

/** รูปแบบของ ops-api › workspaces/customers.service (O02) · เงินเป็นสตางค์ */
export type Integration = "line" | "webhook" | "github" | "apiToken" | "automation" | "import";
export interface WsRow {
  id: string;
  slug: string;
  name: string;
  status: "trial" | "active" | "suspended" | "pending_delete";
  /** โหมดระงับ (C6) · null = ไม่ได้ระงับ */
  suspensionMode?: "read_only" | "full" | null;
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
  /** ผู้ซื้อ (เลขภาษีเดียวกัน หรือเจ้าของคนเดียวกัน) · count = จำนวน Workspace ของผู้ซื้อ (ลูกค้าจริง) */
  buyer: Buyer;
  test: TestInfo;
  /** บัญชีลูกค้าระดับบริษัท (ช่วง 3) */
  account?: { id: string; name: string; kind: string } | null;
}
export interface Buyer {
  key: string | null;
  name: string | null;
  company: boolean;
  count: number;
}
export interface TestInfo {
  isTest: boolean;
  flag: "test" | "not_test" | null;
  auto: boolean;
  suggest: "staff_domain" | "name_prefix" | null;
  reason: string | null;
  by: string | null;
  at: string | null;
}
export interface WsList {
  items: WsRow[];
  total: number;
  limit: number;
  offset: number;
  sort: string;
  counts?: Record<"all" | "paying" | "trialing" | "past_due" | "suspended", number>;
  tests?: { hidden: number; suggested: number };
  /** กรองผู้ซื้อรายเดียว: ยอดรวมทุก Workspace ของผู้ซื้อ */
  buyer?: { key: string; name: string | null; workspaces: number; seats: number; seatLimit: number; mrr: number | null; openTickets: number; account?: { id: string; name: string } | null } | null;
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
  subscription: { plan: string | null; status: string; cycle: string; trialEndsAt: string | null; currentPeriodEnd: string | null; paymentMethod: string | null; discount: { percent?: number; months?: number | null; cyclesLeft?: number | null; reason?: string; setAt?: string | null; setByName?: string | null; active?: boolean } | null; seatLimit: number | null; pending?: { plan: string | null; cycle: string; at: string | null } | null } | null;
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
  test?: TestInfo;
  buyer?: Buyer & { others: { id: string; name: string; slug: string; status: string; subStatus: string | null; plan: string | null }[] };
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

/** ทำหลายราย (H4–H7) · ops-api › workspaces/bulk.service */
export type BulkAction = "extend_trial" | "coupon" | "discount";
export interface BulkFilter {
  plan?: string;
  status?: string;
  q?: string;
  feature?: string;
  buyer?: string;
  test?: "hide" | "only" | "all";
  suggest?: "any" | "staff_domain" | "name_prefix";
}
/** เลือกเป็นรายการ id หรือตามตัวกรอง (เซิร์ฟเวอร์หารายการ ณ เวลายืนยัน) */
export type BulkTarget = { ids: string[] } | { filter: BulkFilter };
export interface BulkPreviewRow {
  workspaceId: string;
  name: string;
  slug: string;
  verdict: "ok" | "approval" | "skip";
  reason: string | null;
  code: string | null;
}
export interface BulkPreview {
  action: BulkAction;
  total: number;
  counts: { ok: number; approval: number; skip: number };
  rows: BulkPreviewRow[];
  limits: { discountPct: number; discountCycles: number; trialDays: number; trialTimes: number };
  coupon: { id: string; code: string } | null;
}
export interface BulkResultRow {
  workspaceId: string;
  name: string;
  slug: string;
  result: "done" | "pending" | "skipped" | "failed";
  detail: string | null;
  approvalId: string | null;
}
export interface BulkResult {
  batchId: string;
  startedAt: string;
  finishedAt: string;
  counts: { done: number; pending: number; skipped: number; failed: number };
  rows: BulkResultRow[];
}
/** คูปองจาก GET ops/promotions (O20) */
export interface CouponOption {
  id: string;
  code: string;
  kind: "percent" | "amount" | "free_months";
  value: number;
  duration: "once" | "repeating" | "forever";
  durationCycles: number | null;
  maxRedemptions: number | null;
  expiresOn: string | null;
  state: string;
  used: number;
}
