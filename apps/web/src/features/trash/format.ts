import { localeDateFormat, localeNumberFormat } from "@/lib/format";
import type { Deleter } from "./types";

type T = (key: string, values?: Record<string, string | number>) => string;

/** "11 พ.ย. 16:02" ตามเวลาไทย (คอลัมน์ "ลบเมื่อ" ของ Z1) */
export const formatDateTime = (iso: string) =>
  localeDateFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(new Date(iso));

/** " (Admin)" ต่อท้ายชื่อผู้ลบ · ไม่รู้บทบาท = ว่าง */
export const roleText = (t: T, role: Deleter["role"] | string | null | undefined) =>
  role && ["owner", "admin", "member", "guest"].includes(role) ? ` (${t(`role.${role}`)})` : "";

export const deleterText = (t: T, d: Deleter | null) => (d ? `${d.displayName}${roleText(t, d.role)}` : t("unknownUser"));

const UNITS = ["B", "KB", "MB", "GB", "TB"];
/** ขนาดไฟล์แบบอ่านง่าย (1024) */
export function formatBytes(bytes: number) {
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${localeNumberFormat({ maximumFractionDigits: n >= 10 || i === 0 ? 0 : 1 }).format(n)} ${UNITS[i]}`;
}
