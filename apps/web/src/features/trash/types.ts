/** สัญญาของ API ถังขยะ (A41 · apps/api/src/trash) */
export type TrashType = "project" | "issue" | "file";

export interface Deleter {
  id: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
  role: "owner" | "admin" | "member" | "guest" | null;
}
export interface ProjectRef {
  id: string;
  key: string;
  name: string;
}
interface Base {
  id: string;
  deletedAt: string;
  deletedBy: Deleter | null;
  purgeAt: string;
  daysLeft: number;
}
export interface TrashIssue extends Base {
  type: "issue";
  key: string;
  title: string;
  project: ProjectRef;
  subtasks: number;
  batchId: string | null;
}
export interface TrashFile extends Base {
  type: "file";
  name: string;
  kind: string;
  mime: string | null;
  sizeBytes: number;
  folder: string | null;
  project: ProjectRef;
}
export interface TrashProject extends Base {
  type: "project";
  key: string;
  name: string;
  color: string | null;
  archived: boolean;
  counts: { issues: number; files: number; members: number };
  /** Key ถูกโปรเจกต์อื่นใช้อยู่ · name = null เมื่อมองไม่เห็นโปรเจกต์นั้น */
  keyTaken: { key: string; name: string | null } | null;
}
export type TrashItem = TrashIssue | TrashFile | TrashProject;

export interface TrashBatch {
  id: string;
  ids: string[];
  keys: string[];
  count: number;
  subtasks: number;
  deletedBy: Deleter | null;
  deletedAt: string;
  projects: ProjectRef[];
}

export interface TrashList {
  type: TrashType;
  trashDays: number;
  counts: { project?: number; issue: number; file: number };
  items: TrashItem[];
  batches: TrashBatch[];
  deleters: Deleter[];
  projects: ProjectRef[];
  nextCursor: string | null;
  can: { restore: boolean; purge: boolean };
  project?: ProjectRef;
}

export interface RestoreResult {
  restored: { id: string; key?: string; name?: string }[];
  failed: { id: string; key?: string | null; name?: string | null; code: string; message: string }[];
}

/** GET workspaces/:slug/deleted (Z5) */
export interface DeletedWorkspaceInfo {
  slug: string;
  name: string;
  deletedAt: string;
  purgeAfter: string;
  daysLeft: number;
  deletedBy: { displayName: string; role: string | null } | null;
  owners: { displayName: string; email: string }[];
  counts: { projects: number; issues: number; storageBytes: number; members: number };
  plan: { code: string; name: string; status: string | null };
  myRole: "owner" | "admin" | "member" | "guest";
  can: { restore: boolean; export: boolean };
}

export interface DeletedExport {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  createdAt: string;
  expiresAt: string | null;
}

/** GET workspaces/deleted (Owner) */
export interface DeletedWorkspaceItem {
  slug: string;
  name: string;
  deletedAt: string;
  restorableUntil: string;
  daysLeft: number;
}

/** Key ตาม API (projectKey ใน apps/api) */
export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** เหลือไม่เกินนี้แสดงสีแดง (Z1) */
export const URGENT_DAYS = 3;
/** คำที่ต้องพิมพ์ก่อนลบถาวร (Z3 · ตรงกับ API) */
export const PURGE_WORD = "ลบถาวร";
