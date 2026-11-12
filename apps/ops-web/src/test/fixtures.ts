// ข้อมูลสมมติทั้งหมด (repo เป็น Public) · โดเมน example เท่านั้น
import type { Flag, Metrics, OpenSession, PaymentRow, Staff, WorkspaceDetail, WorkspaceRow } from "@/lib/types";

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const limits = { refundSatang: 1_000_000, creditSatang: 500_000, discountPct: 30, discountCycles: 12, trialDays: 30, trialTimes: 2 };
/** admin = Owner ทีมเล็กที่ทำทุกงานเอง (แบบ preset ของ ops-api test) */
export const staff: Record<Staff["role"] | "engineer" | "auditor", Staff> = {
  admin: { id: "00000000-0000-4000-8000-000000000001", email: "admin@example.com", name: "แอดมินตัวอย่าง", role: "admin", roles: ["owner", "finance", "support", "engineer"], elevated: [], effectiveRoles: ["owner", "finance", "support", "engineer"], department: "ผู้บริหาร", limits },
  support: { id: "00000000-0000-4000-8000-000000000002", email: "support@example.com", name: "ซัพพอร์ตตัวอย่าง", role: "support", roles: ["support"], elevated: [], effectiveRoles: ["support"], department: "ปฏิบัติการ", limits },
  finance: { id: "00000000-0000-4000-8000-000000000003", email: "finance@example.com", name: "การเงินตัวอย่าง", role: "finance", roles: ["finance"], elevated: [], effectiveRoles: ["finance"], department: "การเงิน", limits },
  engineer: { id: "00000000-0000-4000-8000-000000000004", email: "eng@example.com", name: "วิศวกรตัวอย่าง", role: "support", roles: ["engineer"], elevated: [], effectiveRoles: ["engineer"], department: "เทคโนโลยี", limits },
  auditor: { id: "00000000-0000-4000-8000-000000000005", email: "audit@office.example.com", name: "ผู้ตรวจตัวอย่าง", role: "support", roles: ["auditor"], elevated: [], effectiveRoles: ["auditor"], department: "ภายนอก", limits },
};

/** ops/overview (O06) */
export const overview = {
  month: "2026-11",
  money: { mrr: 18_450_000, arr: 221_400_000, payingWorkspaces: 7, arpa: 2_635_714, movement: {}, netNewMrr: 0, churn: { logoPct: 0, revenuePct: 0, paymentFailures: 0 }, nrrPct: null },
  trialing: 3,
  tasks: { paymentExceptions: 7, slipsToReview: 1, approvals: 2, ticketsBreached: 0, ticketsUnassigned: 6, incidentsOpen: 3, invoicesOverdue: 0, trialEndingSoon: 0, privacyDueSoon: 2, breachesOpen: 0 },
};

export const metrics: Metrics = {
  mrr: 18_450_000,
  payingWorkspaces: 7,
  trialing: 3,
  trialExpired: 1,
  canceledLast30Days: 2,
  pastDue: 1,
  pendingPayments: 2,
  suspended: 0,
  paidLast30Days: 5_000_000,
  workspaces: 12,
  newWorkspacesLast30Days: 4,
  byPlan: { team_s: 4, team_m: 2, team_l: 1, free: 5 },
};
export const emptyMetrics: Metrics = { ...metrics, pendingPayments: 0, pastDue: 0, trialExpired: 0, suspended: 0 };

export const wsA = "10000000-0000-4000-8000-00000000000a";
export const wsB = "10000000-0000-4000-8000-00000000000b";
export const workspaceRows: WorkspaceRow[] = [
  { id: wsA, slug: "sample-team", name: "ทีมตัวอย่าง", status: "active", createdAt: "2026-03-12T03:00:00.000Z", plan: "team_l", subStatus: "active", cycle: "yearly", trialEndsAt: null, periodEnd: future(200), seats: 41, projects: 6 },
  { id: wsB, slug: "trial-team", name: "ทีมทดลอง", status: "active", createdAt: "2026-10-22T03:00:00.000Z", plan: "team_m", subStatus: "trialing", cycle: "monthly", trialEndsAt: future(3), periodEnd: future(3), seats: 6, projects: 1 },
];

export const detailA: WorkspaceDetail = {
  id: wsA,
  slug: "sample-team",
  name: "ทีมตัวอย่าง",
  status: "active",
  createdAt: "2026-03-12T03:00:00.000Z",
  subscription: { plan: "team_l", status: "active", cycle: "yearly", trialEndsAt: null, currentPeriodEnd: future(200), paymentMethod: "card", discount: null },
  usage: { members: 41, guests: 3, projects: 6, issues: 320, storageBytes: 1024 },
  owners: [{ id: "u1", email: "owner@example.com", displayName: "เจ้าของตัวอย่าง", role: "owner" }],
  supportAccess: { until: null, maxMode: "write", notifyAdmins: true, active: true },
  supportSessions: [],
  invoices: [{ id: "i1", number: "INV-2569-0001", status: "paid", total: 5_885_000, amountDue: 0, createdAt: "2026-03-12T03:00:00.000Z" }],
};
export const detailB: WorkspaceDetail = {
  ...detailA,
  id: wsB,
  slug: "trial-team",
  name: "ทีมทดลอง",
  createdAt: "2026-10-22T03:00:00.000Z",
  subscription: { plan: "team_m", status: "trialing", cycle: "monthly", trialEndsAt: future(3), currentPeriodEnd: future(3), paymentMethod: null, discount: null },
  supportAccess: null,
  invoices: [],
};

export const payId = "20000000-0000-4000-8000-000000000001";
export const whtId = "30000000-0000-4000-8000-000000000001";
export const payments: PaymentRow[] = [
  {
    id: payId,
    method: "transfer",
    amount: 312_000,
    status: "pending_review",
    hasSlip: true,
    createdAt: past(120),
    reviewedAt: null,
    invoice: { id: "i2", number: "INV-2569-0112", status: "pending", total: 321_000, whtAmount: 9_000, amountDue: 312_000, dueDate: "2026-11-20" },
    workspace: { id: wsA, slug: "sample-team", name: "ทีมตัวอย่าง" },
    whtCertificates: [{ id: whtId, status: "pending_review", createdAt: past(60) }],
  },
];

export const mySessionId = "40000000-0000-4000-8000-000000000001";
export const openSessions = (staffId: string): OpenSession[] => [
  { id: mySessionId, workspaceId: wsA, staffId, ticketNo: "#1001", reason: "ลูกค้าแจ้งนำเข้าไฟล์ค้างที่ขั้นตรวจสอบ", mode: "read", secondApproverId: null, startedAt: past(12), endedAt: null, workspace: { name: "ทีมตัวอย่าง", slug: "sample-team" }, staffName: "ซัพพอร์ตตัวอย่าง" },
];

export const flagId = "50000000-0000-4000-8000-000000000001";
export const flags: Flag[] = [
  { id: flagId, key: "automation_v2", description: "ตัวสร้างกฎแบบใหม่", defaultOn: false, createdAt: past(1000), updatedAt: past(1000), overrides: [{ workspaceId: wsA, slug: "sample-team", name: "ทีมตัวอย่าง", enabled: true }] },
  { id: "50000000-0000-4000-8000-000000000002", key: "line_approve_button", description: "ปุ่มอนุมัติใน LINE", defaultOn: true, createdAt: past(1000), updatedAt: past(1000), overrides: [] },
];

