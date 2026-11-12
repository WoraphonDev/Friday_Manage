import { api } from "@/lib/api";
import type { DeletedExport, DeletedWorkspaceInfo, DeletedWorkspaceItem, RestoreResult, TrashList, TrashType } from "./types";

const enc = encodeURIComponent;
const wsBase = (ws: string) => `/w/${enc(ws)}`;

export interface TrashScope {
  ws: string;
  /** ไม่ส่ง = ถังขยะทั้ง Workspace (Z1) · ส่ง = ถังขยะของโปรเจกต์ (Z4) */
  projectKey?: string;
}
export interface TrashFilters {
  type: TrashType;
  q: string;
  project: string;
  deletedBy: string;
}

/** cache key มี Workspace / โปรเจกต์ (AGENTS.md) */
export const trashKeys = {
  all: (ws: string) => ["workspace", ws, "trash"] as const,
  list: (scope: TrashScope, f: TrashFilters) => ["workspace", scope.ws, "trash", scope.projectKey ?? "*", f] as const,
  deletedWorkspaces: ["me", "workspaces", "deleted"] as const,
  deletedInfo: (ws: string) => ["deleted-workspace", ws] as const,
  deletedExports: (ws: string) => ["deleted-workspace", ws, "exports"] as const,
};

export function fetchTrash(scope: TrashScope, f: TrashFilters, cursor?: string) {
  const params = new URLSearchParams({ type: f.type });
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.project && !scope.projectKey) params.set("project", f.project);
  if (f.deletedBy) params.set("deletedBy", f.deletedBy);
  if (cursor) params.set("cursor", cursor);
  const path = scope.projectKey ? `${wsBase(scope.ws)}/projects/${enc(scope.projectKey)}/trash` : `${wsBase(scope.ws)}/trash`;
  return api.get<TrashList>(`${path}?${params}`);
}

export const restoreItems = (ws: string, type: "issue" | "file", ids: string[]) => api.post<RestoreResult>(`${wsBase(ws)}/trash/${type}:restore`, { ids });
export const restoreProject = (ws: string, id: string, newKey?: string) =>
  api.post<{ id: string; key: string; oldKey: string | null; name: string; restored: true }>(`${wsBase(ws)}/trash/project/${enc(id)}:restore`, newKey ? { newKey } : {});
export const purgeItems = (ws: string, type: TrashType, ids: string[], confirm: string) =>
  api.post<{ purged: number }>(`${wsBase(ws)}/trash/${type}:purge`, { ids, confirm });

export const fetchDeletedWorkspaces = () => api.get<{ items: DeletedWorkspaceItem[] }>("/workspaces/deleted");
export const fetchDeletedInfo = (ws: string) => api.get<DeletedWorkspaceInfo>(`/workspaces/${enc(ws)}/deleted`);
export const restoreWorkspace = (ws: string) => api.post<{ slug: string; restored: true }>(`/workspaces/${enc(ws)}/restore`);
export const fetchDeletedExports = (ws: string) => api.get<{ items: DeletedExport[] }>(`/workspaces/${enc(ws)}/deleted/exports`);
export const requestDeletedExport = (ws: string) => api.post<DeletedExport>(`/workspaces/${enc(ws)}/deleted/exports`);
export const deletedExportUrl = (ws: string, id: string) => `/api/v1/workspaces/${enc(ws)}/deleted/exports/${enc(id)}/download`;
