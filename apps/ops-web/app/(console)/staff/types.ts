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
  /** อีเมลส่วนตัว (H1) · เจ้าของบัญชีเห็นเต็ม · คนอื่นเห็นแบบปิดบางส่วน */
  personalEmail?: string | null;
  personalEmailStatus?: "verified" | "pending" | "none";
  personalEmailVerifiedAt?: string | null;
}
/** สถานะสรุปรายการที่อนุมัติตัวเอง (H3) ของ Owner ที่ใช้งานอยู่ · มีเฉพาะช่วงมี Owner คนเดียว */
export interface DigestStatus {
  staffId: string;
  personalEmail: string | null;
  personalEmailVerified: boolean;
  lastSentAt: string | null;
  lastCount: number | null;
  failedAt: string | null;
  failedText: string | null;
}
export interface StaffList {
  items: StaffMember[];
  singleApprover: boolean;
  digest?: DigestStatus[];
}
/** GET ops/staff/me/personal-email */
export interface PersonalEmail {
  email: string | null;
  verifiedAt: string | null;
  pending: string | null;
  pendingExpiresAt: string | null;
  workEmail: string;
}
export const personalEmailKey = ["ops", "staff", "me", "personal-email"] as const;
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
