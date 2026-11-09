import type { OpsRole, Staff, StaffRole } from "@/lib/types";

/** บทบาทเดิมแปลงเป็นชุดใหม่ (ตอบจาก ops-api ก่อน O01 หรือ fixture เก่า) */
const LEGACY: Record<StaffRole, OpsRole[]> = { admin: ["owner", "finance", "support", "engineer"], finance: ["finance"], support: ["support"] };

/** บทบาทที่ใช้ได้ตอนนี้ (รวมสิทธิ์ฉุกเฉิน) · ops-api ตรวจซ้ำและตอบ 403 เสมอ ฝั่งเว็บใช้ซ่อนเมนู / ปุ่มเท่านั้น */
export function rolesOf(staff: Pick<Staff, "role" | "roles" | "elevated" | "effectiveRoles"> | undefined | null): OpsRole[] {
  if (!staff) return [];
  if (staff.effectiveRoles?.length) return staff.effectiveRoles;
  if (staff.roles?.length) return [...new Set([...staff.roles, ...(staff.elevated ?? [])])];
  return LEGACY[staff.role] ?? [];
}

/** มีบทบาทใดบทบาทหนึ่ง · ไม่ระบุ = ทุกคนที่ล็อกอิน */
export const hasAny = (staff: Parameters<typeof rolesOf>[0], ...need: OpsRole[]) => need.length === 0 || need.some((r) => rolesOf(staff).includes(r));

/** เห็นยอดเงินรายลูกค้า (06 › 2) */
export const seesMoney = (staff: Parameters<typeof rolesOf>[0]) => hasAny(staff, "owner", "finance", "auditor");

/** อักษรย่อสำหรับรูปโปรไฟล์ */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
