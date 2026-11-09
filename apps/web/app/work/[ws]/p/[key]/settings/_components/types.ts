import { api, ApiError, supportId } from "@/lib/api";

/** แท็บของ L2 ตามลำดับใน Canvas · notify / integ ยังไม่มี API (03-api › 3.5 p/notification-rules, p/repositories) */
// import / export / plan-changes = Import / Export ของโปรเจกต์ (ผู้ใช้ตัดสิน 2026-11-09) เนื้อหาเดียวกับ Popup ในแท็บ Table
export const SECTIONS = ["general", "workflow", "types", "modules", "perms", "notify", "integ", "import", "export", "plan-changes", "danger"] as const;
/** เมนูที่ต้องมีสิทธิ์ project.baseline */
export const BASELINE_SECTIONS: readonly string[] = ["import", "plan-changes"];
export type Section = (typeof SECTIONS)[number];
export const isSection = (v: string | undefined): v is Section => !!v && (SECTIONS as readonly string[]).includes(v);

export type Category = "todo" | "in_progress" | "done";
export type Size = "XS" | "S" | "M" | "L" | "XL";
export const SIZES: Size[] = ["XS", "S", "M", "L", "XL"];
/** ค่าเริ่มต้นขององค์กร (docs/decisions.md) ใช้แสดงเมื่อโปรเจกต์ยังใช้ค่าของ Workspace (sizeMdMap = null) */
export const DEFAULT_SIZE_MD: Record<Size, number> = { XS: 1, S: 3, M: 5, L: 8, XL: 12 };

export interface ProjectDetail {
  id: string;
  key: string;
  name: string;
  clientName: string | null;
  description: string | null;
  color: string | null;
  startDate: string;
  goliveDate: string;
  timezone: string;
  visibility: "private" | "workspace";
  status: string;
  archivedAt: string | null;
  ownerUserId: string;
  sprintLengthWeeks: 1 | 2 | 3 | null;
  estimateUnit: "man_day" | "hour";
  progressMethod: "count" | "weighted";
  sizeMdMap: Record<Size, number> | null;
  holidayCalendarId: string | null;
  workStart: string | null;
  workEnd: string | null;
  timeLogEnabled: boolean;
  version: number;
  myRole: string | null;
  warnings?: { code: string; message: string }[];
}

export interface Member {
  userId: string;
  displayName: string;
  initials?: string;
  email: string | null;
  role: "admin" | "member" | "viewer";
  isOwner: boolean;
  isGuest: boolean;
  active: boolean;
}

export interface Status {
  id: string;
  workflowId: string;
  name: string;
  category: Category;
  boardColumnId: string | null;
  wipLimit: number | null;
  sort: number;
  issueCount: number;
}
export interface Rule {
  id: string;
  ruleType: string;
  config: Record<string, unknown>;
  enabled: boolean;
}
export interface CatalogRule {
  ruleType: string;
  title: string;
  description: string;
  configured: boolean;
  enabled: boolean;
}
export interface Workflow {
  id: string;
  name: string;
  kind: "standard" | "bug";
  issueTypes: { id: string; name: string; enabled: boolean }[];
  statuses: Status[];
  rules: Rule[];
  catalog: CatalogRule[];
}

export interface IssueType {
  id: string;
  name: string;
  color: string | null;
  workflow: { id: string; name: string };
  requiredFields: string[];
  enabled: boolean;
  issueCount: number;
}
export interface IssueTypes {
  items: IssueType[];
  requiredFieldOptions: { key: string; label: string }[];
}
export interface CustomField {
  id: string;
  name: string;
  fieldType: "text" | "number" | "select" | "multi_select" | "user" | "date";
  options: { choices?: { id: string; label: string }[] } | null;
  /** แสดง / บังคับในระดับ Task และ Sub-task (ชุดฟิลด์) */
  taskMode?: "hidden" | "optional" | "required";
  subtaskMode?: "hidden" | "optional" | "required";
}
export interface Label {
  id: string;
  name: string;
  color: string | null;
  issueCount: number;
}
export interface Module {
  id: string;
  name: string;
  color: string | null;
  owner: { id: string; displayName: string } | null;
  issueCount: number;
  phases?: { id: string; name: string }[];
}
export interface DeleteImpact {
  key: string;
  name: string;
  issues: number;
  files: number;
  members: number;
  trashDays: number;
  canDelete: boolean;
}
export interface HolidayCalendar {
  id: string;
  name: string;
  isDefault: boolean;
}

/** ข้อความ error พร้อม requestId ให้ผู้ใช้แจ้งทีมได้ */
export function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError) return supportId(error) ? `${error.message} (${supportId(error)})` : error.message;
  return error instanceof Error ? error.message : fallback;
}
export const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

/** สลับตำแหน่งในรายการ (ปุ่มเลื่อนขึ้น / ลงแทนการลาก เพื่อให้ใช้คีย์บอร์ดได้) */
export function move<T>(list: T[], index: number, delta: number) {
  const next = list.slice();
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** PATCH ของแท็บโครงสร้าง (A05) ไม่ใช้ If-Match · ต่างจาก PATCH p/ ที่ต้องส่ง version */
export const patchPlain = <T = unknown>(path: string, body: unknown) => api.request<T>(path, { method: "PATCH", body });
