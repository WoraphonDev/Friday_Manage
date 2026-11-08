import type { Person, Permissions } from '@/lib/types';
export type IssueType = 'Task' | 'Story' | 'Bug' | 'Spike';
export interface Status { id: string; name: string; category: 'todo' | 'in_progress' | 'done'; workflowId?: string }
export interface Named { id: string; name: string; color?: string | null }
export interface Issue {
  id: string; key: string; projectKey: string; type: IssueType; parentKey: string | null;
  title: string; description: string | null; status: Status; priority: 'urgent' | 'high' | 'medium' | 'low';
  moduleId: string | null; phaseId: string | null; sprintId: string | null;
  /** ชื่อกลุ่ม (เฉพาะ GET issue) */
  group?: { id: string; name: string } | null;
  assigneeIds?: string[]; baId?: string | null; saId?: string | null; reviewerId?: string | null; testerId?: string | null; reporterId?: string;
  size: string | null; estimateMd: number | null; progressPct: number | null;
  planStart: string | null; planEnd: string | null; actualStart: string | null; actualEnd: string | null;
  severity: string | null; environment: string | null; details: Record<string, unknown>; reopenCount: number;
  sharedWithGuests: boolean; version: number; createdAt: string; updatedAt: string;
  requirements?: string[]; screens?: string[]; labels?: Named[];
  subtasks?: Issue[]; pendingDueRequest?: { id: string; requesterId: string; requestedDue: string; currentDue: string; createdAt: string } | null;
  warnings?: { code: string; message: string }[];
}
export interface IssueTypeOption extends Named { workflowId: string; requiredFields: string[]; statuses?: Status[] }
export interface ProjectMeta {
  id: string; key: string; name: string; status: string; modules: (Named & { phases?: Named[] })[];
  phases?: (Named & { moduleId: string })[]; sprints: (Named & { status: string; number?: number })[];
  statuses: Status[]; issueTypes: IssueTypeOption[];
}
export interface FormOptions extends Omit<ProjectMeta, 'id' | 'key' | 'name' | 'status' | 'statuses'> {
  members: Person[]; sizeMdMap: Record<string, number>; labels: Named[];
  requirements?: { code: string; kind: string; title: string | null }[]; screens?: { code: string; name: string | null }[];
}
export interface Scope {
  ws: string; projectKey: string; meId: string; yearFormat: 'BE' | 'CE';
  access: Permissions; project?: ProjectMeta; people: Person[];
  navigate: (key: string) => void; createSubtask: (parent: Issue) => void;
}
export interface ChecklistItem { id: string; text: string; kind: 'checklist' | 'acceptance'; done: boolean; doneBy: string | null; doneAt: string | null }
export interface Dependency { id: string; key: string; title: string; type: string; lagDays: number; status: Status; planStart: string | null; planEnd: string | null }
export interface Dependencies { blockedBy: Dependency[]; blocking: Dependency[]; warnings?: { code: string; message: string }[] }
export interface PublicPerson { id?: string; displayName: string; initials?: string; avatarUrl?: string | null }
export interface Comment { id: string; kind: 'comment'; body: string | null; author: PublicPerson | null; createdAt: string; editedAt: string | null; deletedAt: string | null; deletionReason: 'admin' | 'author' | null; canEdit: boolean; canDelete: boolean; files?: { id: string; name: string; mime?: string | null }[] }
export interface Activity { id: string; kind: 'activity'; actor: PublicPerson | null; verb: string; field: string | null; old: unknown; new: unknown; createdAt: string }
export interface Feed { items: (Comment | Activity)[]; nextCursor: string | null }
export interface DueImpact {
  currentDue: string; requestedDue: string; addedWorkingDays: number;
  workload: { person: Person | null; otherWorkMd: number; capacityMd: number; overloaded: boolean; overlapping: { key: string; title: string }[] }[];
  dependents: { key: string; title: string; affected: boolean }[];
  milestones: { id: string; name: string; date: string; onTime: boolean }[];
  goLive: { date: string; onTime: boolean }; parent: { key: string; planEnd: string | null; exceeded: boolean } | null;
  approvers: Person[]; warnings: { code: string; message: string }[];
}
export const issuePath = (ws: string, key: string) => `/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(key)}`;
export const projectPath = (ws: string, key: string) => `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(key)}`;
export const issueQuery = (ws: string, key: string) => ['issue-drawer', ws, key] as const;
