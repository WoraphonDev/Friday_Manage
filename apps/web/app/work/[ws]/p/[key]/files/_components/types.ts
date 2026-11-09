// รูปร่างข้อมูลจาก API ของ A11 (apps/api/src/files)
import type { Person } from "@/lib/types";

export interface FileItem {
  id: string;
  name: string;
  kind: "upload" | "link";
  mime: string | null;
  linkUrl: string | null;
  linkProvider: "figma" | "google_drive" | "notion" | "other" | null;
  size: number | null;
  versionNo: number | null;
  versionCount: number;
  folderId: string | null;
  uploader: Person | null;
  createdAt: string;
  updatedAt: string;
  attachments: number;
  evidence: boolean;
  deletedAt: string | null;
}
export interface FileList {
  items: FileItem[];
  breadcrumb: { id: string; name: string }[];
  totalBytes: number;
}
export interface FileVersion {
  versionNo: number;
  size: number;
  note: string | null;
  uploader: Person | null;
  createdAt: string;
  current: boolean;
}
export interface Attachment {
  id: string;
  targetType: "issue" | "test_run" | "comment" | "project" | "requirement";
  target: string;
  createdAt: string;
}
export interface FileDetail extends FileItem {
  versions: FileVersion[];
  attachmentList: Attachment[];
}
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  fileCount: number;
  createdAt: string;
}
export interface FolderList {
  rootFileCount: number;
  items: Folder[];
}
export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  uploadToken: string;
  expiresAt: string;
  maxBytes: number;
  storage: string;
}
