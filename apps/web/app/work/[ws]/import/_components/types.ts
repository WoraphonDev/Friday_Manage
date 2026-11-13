// รูปแบบตอบกลับของ `w/:ws/import-jobs` (apps/api/src/imports/imports.service.ts › view)

export type Level = "err" | "warn";
export interface Finding {
  level: Level;
  no: number | null;
  rowNo: number;
  module: string | null;
  title: string | null;
  problem: string;
  fix: string;
}
export type PersonTarget = { userId: string } | { email: string } | null;
export interface JobPerson {
  name: string;
  roles: ("dev" | "ba" | "sa" | "qa")[];
  rows: number;
  /** false = ยังไม่พบในรายชื่อสมาชิกและยังไม่ได้เลือก */
  decided: boolean;
  target: PersonTarget;
}
export interface FieldChange {
  field: string;
  label: string;
  old: unknown;
  new: unknown;
}
export interface UpdateDiff {
  added: { no: number; number: number | null; title: string; module: string }[];
  changed: { no: number; key: string; title: string; fields: FieldChange[] }[];
  missing: { no: number; key: string; title: string; status: string }[];
  unchanged: number;
  /** โหมด unstarted: งานที่ค่าต่างแต่เริ่มทำแล้ว จึงไม่แก้ */
  locked?: { no: number; key: string; title: string; status: string; fields: string[] }[];
}
export interface ImportSummary {
  rows: number;
  modules: number;
  phases: number;
  manDay: number;
  devs: number;
  bas: number;
  planFrom: string | null;
  planTo: string | null;
  ready: number;
  backlog: number;
  skipped: number;
  /** จำนวนข้อ Checklist + Acceptance (คอลัมน์ Checklist · แถวต่อท้ายที่ Title เดียวกัน) */
  checklist?: number;
}
export interface ImportJob {
  id: string;
  status: "validated" | "running" | "completed" | "failed" | string;
  mode: "create" | "update";
  fileName: string;
  projectId: string | null;
  /** ฟิลด์ปลายทาง → ชื่อที่แสดง */
  fields: Record<string, string>;
  project: { name?: string; key?: string; startDate?: string; goliveDate?: string; visibility?: "private" | "workspace" };
  setBaseline: boolean;
  sheet: string;
  summary: ImportSummary;
  findings: Finding[];
  people: JobPerson[];
  columns: { header: string; field: string | null; sample: unknown }[];
  diff?: UpdateDiff;
  missingChoice?: Record<string, "keep" | "delete">;
  missingAll?: "keep" | "delete";
  planChangeReason?: string;
  /** โหมดอัปเดต: replace = จับคู่และแก้งานเดิม · append = ทุกแถวเป็นงานใหม่ */
  updateKind?: UpdateKind;
  /** โหมด unstarted: ผู้ใช้ยืนยันให้เพิ่มงานใหม่ในไฟล์แล้ว */
  addNew?: boolean;
}
export interface CommitResult {
  mode: "create" | "update";
  project: { key: string; name: string };
  imported?: number;
  scheduled?: number;
  backlog?: number;
  checklist?: number;
  baseline?: boolean;
  added?: number;
  changed?: number;
  unchanged?: number;
  deleted?: number;
  kept?: number;
  planChanges?: number;
  skipped: number;
  invitations: unknown[];
}
export interface Member {
  userId: string;
  displayName: string;
  email: string;
  role: "owner" | "admin" | "member" | "guest";
  status: string;
}

/** key ของคนใน personMapping ต้องตรงกับ `personKey` ของ API: ไม่สนตัวพิมพ์และ ’ กับ ' */
export const personKey = (name: string) => name.trim().toLowerCase().replace(/[’‘`]/g, "'");

/** replace = ลบแผนเดิมแล้วสร้างใหม่ · sync = จับคู่และแก้งานเดิม (API เท่านั้น ไม่มีในหน้าเลือก) */
export type UpdateKind = "replace" | "sync" | "append" | "unstarted";
