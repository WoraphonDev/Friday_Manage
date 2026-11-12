import type { Person } from "@/lib/types";
import type { StatusCategory } from "@/lib/status";

/** งานในหน้า Backlog ตาม issueDto ของ A06 (ส่ง assigneeIds เท่านั้น ชื่อคนมาจากสมาชิกโปรเจกต์) */
export interface BacklogIssue {
  id: string;
  key: string;
  title: string;
  type: string;
  parentId: string | null;
  rank: string;
  sprintId: string | null;
  moduleId: string | null;
  size: string | null;
  estimateMd: number | null;
  priority: "urgent" | "high" | "medium" | "low";
  planStart: string | null;
  planEnd: string | null;
  progressPct: number;
  status: { id: string; name: string; category: StatusCategory };
  assigneeIds: string[];
  /** false = งานของคนอื่น ดูได้อย่างเดียว */
  canMove?: boolean;
  version: number;
  subtasks?: BacklogIssue[];
}
export interface SprintStats {
  totalMd: number;
  remainingMd: number;
  doneMd: number;
  issueCount: number;
  doneCount: number;
  unestimatedCount: number;
}
export interface CapacityPerson {
  person?: Person;
  capacityHoursWeek: number | null;
  capacityMd: number;
  committedMd: number;
  leaveDays: number;
  overloaded: boolean;
}
export interface SprintCapacity {
  capacityMd: number;
  committedMd: number;
  unassignedMd: number;
  unavailableAssigneeMd: number;
  overloaded: boolean;
  workingDays: number;
  people: CapacityPerson[];
}
export interface BurndownPoint { date: string; remainingMd: number }
export interface Burndown {
  sprintId: string;
  asOf: string;
  baselineMd: number;
  ideal: BurndownPoint[];
  actual: (BurndownPoint & { doneMd: number; issueCount: number; doneCount: number })[];
}
export interface Sprint {
  id: string;
  number: number;
  name: string;
  goal: string | null;
  startDate: string;
  endDate: string;
  status: "planning" | "active" | "completed";
  issues: BacklogIssue[];
  stats: SprintStats;
  capacity: SprintCapacity;
  burndown: Burndown | null;
}
export interface BacklogData {
  projectKey: string;
  asOf: string;
  permissions: { canManageSprints: boolean; canMoveIssues: boolean };
  sprints: Sprint[];
  backlog: { issues: BacklogIssue[]; stats: SprintStats };
}
export interface ModuleItem { id: string; name: string; color: string | null }
export interface MemberItem { userId: string; displayName: string; initials?: string; avatarUrl?: string | null }

/** null = Backlog (งานที่ไม่อยู่ใน Sprint) */
export type Container = string | null;
export interface MoveBody {
  sprintId: Container;
  afterKey?: string;
  beforeKey?: string;
}
export interface MoveIntent {
  issue: BacklogIssue;
  body: MoveBody;
  undo: MoveBody;
}
export interface MoveResult {
  version: number;
  warnings: { code: string; message: string }[];
}
export interface CompleteResult {
  name: string;
  moved: { tasks: number; subtasks: number; destination: string | null };
}

export const listOf = (data: BacklogData, container: Container) =>
  container === null ? data.backlog.issues : (data.sprints.find((sprint) => sprint.id === container)?.issues ?? []);

/**
 * คำนวณเพื่อนบ้านจากรายการเต็มของปลายทาง (ไม่ใช่รายการที่กรองแล้ว)
 * เพื่อให้ rank ที่ API คำนวณถูกต้องแม้หน้าเว็บซ่อนบางงานด้วยตัวกรอง
 */
export function placement(data: BacklogData, key: string, target: Container, anchor: { before?: string; after?: string } = {}): MoveIntent | null {
  const containers: Container[] = [null, ...data.sprints.map((sprint) => sprint.id)];
  const source = containers.find((container) => listOf(data, container).some((issue) => issue.key === key));
  if (source === undefined || anchor.before === key || anchor.after === key) return null;
  const sourceList = listOf(data, source);
  const original = sourceList.findIndex((issue) => issue.key === key);
  const issue = sourceList[original];
  const targetList = listOf(data, target).filter((item) => item.key !== key);
  let index = targetList.length;
  if (anchor.before) index = targetList.findIndex((item) => item.key === anchor.before);
  else if (anchor.after) { const at = targetList.findIndex((item) => item.key === anchor.after); index = at < 0 ? -1 : at + 1; }
  if (index < 0 || (source === target && index === original)) return null;
  return {
    issue,
    body: { sprintId: target, afterKey: targetList[index - 1]?.key, beforeKey: targetList[index]?.key },
    undo: { sprintId: source, afterKey: sourceList[original - 1]?.key, beforeKey: sourceList[original + 1]?.key },
  };
}

/** วันทำการที่เหลือ (รวมวันนี้) อนุมานจากเส้นอุดมคติที่ลดเฉพาะวันทำการ · ไม่มีงานเลยจะอนุมานไม่ได้ */
export function remainingWorkingDays(burndown: Burndown | null) {
  if (!burndown || burndown.baselineMd <= 0) return null;
  let days = 0;
  for (let i = 1; i < burndown.ideal.length; i++) {
    if (burndown.ideal[i].date >= burndown.asOf && burndown.ideal[i].remainingMd < burndown.ideal[i - 1].remainingMd) days++;
  }
  return days;
}

export const round = (value: number) => Math.round(value * 100) / 100;
