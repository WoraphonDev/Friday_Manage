// รูปแบบ response จริงของ apps/ops-api (ดู src/**/*.service.ts) · วันที่มาเป็น ISO string · เงินเป็นสตางค์

/** บทบาทแบบเดิม (ops-api ยังส่ง `role` ให้หน้าเดิมจนกว่า O11–O15 จะย้ายไปใช้ `roles`) */
export type StaffRole = "admin" | "support" | "finance";
/** บทบาทของทีม Friday (06-ops-roles) · 1 คนมีได้หลายบทบาท */
export type OpsRole = "owner" | "finance" | "support" | "engineer" | "auditor";
export const OPS_ROLES: OpsRole[] = ["owner", "finance", "support", "engineer", "auditor"];
export interface Limits {
  refundSatang: number;
  creditSatang: number;
  discountPct: number;
  discountCycles: number;
  trialDays: number;
  trialTimes: number;
}
export interface Staff {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  roles?: OpsRole[];
  /** บทบาทที่เปิดชั่วคราวด้วยสิทธิ์ฉุกเฉิน */
  elevated?: OpsRole[];
  effectiveRoles?: OpsRole[];
  department?: string | null;
  limits?: Limits;
}

/** วิธีเข้าระบบของบัญชีที่ล็อกอินอยู่ (GET /auth/me › methods) */
export interface LoginMethods {
  /** ตั้งรหัสผ่าน + แอป Authenticator แล้ว */
  totp: boolean;
  totpEnabledAt: string | null;
  keys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
}

export interface Metrics {
  mrr: number;
  payingWorkspaces: number;
  trialing: number;
  trialExpired: number;
  canceledLast30Days: number;
  pastDue: number;
  pendingPayments: number;
  suspended: number;
  paidLast30Days: number;
  workspaces: number;
  newWorkspacesLast30Days: number;
  byPlan: Record<string, number>;
}

export type PlanCode = "free" | "team_s" | "team_m" | "team_l" | "enterprise";
export const PLAN_CODES: PlanCode[] = ["free", "team_s", "team_m", "team_l", "enterprise"];
export type WorkspaceStatus = "trial" | "active" | "suspended" | "pending_delete";
export type SubStatus = "trialing" | "active" | "past_due" | "canceled";

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  plan: PlanCode | null;
  subStatus: SubStatus | null;
  cycle: "monthly" | "yearly" | null;
  trialEndsAt: string | null;
  periodEnd: string | null;
  seats: number;
  projects: number;
}

export interface SupportSession {
  id: string;
  workspaceId: string;
  staffId: string;
  ticketNo: string;
  reason: string;
  mode: "read" | "write";
  secondApproverId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** เวลาหมดของเซิร์ฟเวอร์ (H8) · นับถอยหลังจากค่านี้ ไม่ใช่นาฬิกาเครื่อง */
  expiresAt?: string | null;
  /** จบเพราะหมดเวลา / ออกเอง · null = ยังเปิดอยู่ */
  endReason?: "expired" | "manual" | null;
  usedMinutes?: number;
}
export interface OpenSession extends SupportSession {
  workspace: { name: string; slug: string };
  staffName: string;
  staffRoles?: OpsRole[];
}
/** GET ops/support-sessions · serverTime ใช้ปรับนาฬิกาเครื่องให้ตรงเซิร์ฟเวอร์ */
export interface SessionsResponse {
  items: OpenSession[];
  serverTime?: string;
}

export interface WorkspaceDetail {
  id: string;
  slug: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  subscription: {
    plan: PlanCode | null;
    status: SubStatus;
    cycle: "monthly" | "yearly";
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    paymentMethod: string | null;
    discount: { percent: number; months: number | null; reason: string } | null;
  } | null;
  usage: { members: number; guests: number; projects: number; issues: number; storageBytes: number };
  owners: { id: string; email: string; displayName: string; role: "owner" | "admin" }[];
  supportAccess: { until: string | null; maxMode: "read" | "write"; notifyAdmins: boolean; active: boolean } | null;
  supportSessions: SupportSession[];
  invoices: { id: string; number: string; status: string; total: number; amountDue: number; createdAt: string }[];
}

export interface PaymentRow {
  id: string;
  method: "card" | "promptpay" | "transfer";
  amount: number;
  status: "pending_review" | "confirmed" | "rejected";
  hasSlip: boolean;
  createdAt: string;
  reviewedAt: string | null;
  invoice: { id: string; number: string; status: string; total: number; whtAmount: number; amountDue: number; dueDate: string };
  workspace: { id: string; slug: string; name: string };
  whtCertificates: { id: string; status: "pending_review" | "confirmed" | "rejected"; createdAt: string }[];
}

export interface Flag {
  id: string;
  key: string;
  description: string | null;
  defaultOn: boolean;
  createdAt: string;
  updatedAt: string;
  overrides: { workspaceId: string; slug: string; name: string; enabled: boolean }[];
}

