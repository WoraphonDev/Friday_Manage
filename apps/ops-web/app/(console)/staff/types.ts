import type { Limits, OpsRole } from "@/lib/types";

/** รูปแบบของ ops-api › staff.service (dto) */
export interface StaffMember {
  id: string;
  email: string;
  name: string;
  roles: OpsRole[];
  department: string | null;
  limits: Limits;
  customLimits: Partial<Limits> | null;
  status: "invited" | "active" | "suspended" | "disabled";
  expiresAt: string | null;
  keys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  createdAt: string;
  elevations: { id: string; role: OpsRole; endsAt: string }[];
}
export interface StaffList {
  items: StaffMember[];
  singleApprover: boolean;
}
export interface AuditRow {
  id: string;
  staffId: string | null;
  staffName: string;
  roles: OpsRole[];
  action: string;
  targetType: string | null;
  targetId: string | null;
  workspaceId: string | null;
  reason: string | null;
  approvedBy: string | null;
  selfApproved: boolean;
  ip: string | null;
  createdAt: string;
}
/** ค่าเริ่มต้นตาม 06 › 3 (ops-api › auth/roles.ts) */
export const DEFAULT_LIMITS: Limits = { refundSatang: 1_000_000, creditSatang: 500_000, discountPct: 30, discountCycles: 12, trialDays: 30, trialTimes: 2 };
export const staffKey = ["ops", "staff"] as const;
