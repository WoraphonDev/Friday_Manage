import type { Person } from "@/lib/types";
import type { StatusCategory } from "@/lib/status";

type Cat = StatusCategory;
export interface OverviewItem {
  key: string;
  type: string;
  title: string;
  status: { name: string; category: Cat };
  module: { id: string; name: string; color: string | null } | null;
  phase: { id: string; name: string } | null;
  parentKey: string | null;
  planEnd: string | null;
  lateDays: number;
  completedOn: string | null;
  assignees?: Person[];
  canOpen?: boolean;
}
export interface Overview {
  project: {
    key: string; name: string; clientName: string | null; description: string | null; status: string;
    startDate: string; goliveDate: string; progressMethod: string;
    owner: Person | null; memberCount: number; moduleCount: number;
    scope: { inScope: string[]; outScope: string[]; deliverables: string[]; acceptance: string[]; assumptions: string[] };
  };
  today: string;
  progress: {
    pct: number;
    /** แยก Dev / QA (project.progressSplit) · null = แถบเดียวแบบเดิม */
    split?: ProgressSplit | null;
    tasks: { done: number; total: number };
    md: { done: number; total: number; pct: number };
    time: { elapsedWorkingDays: number; totalWorkingDays: number; pct: number };
    remainingWorkingDays: number;
    lastPlanEnd: string | null;
    nextMilestone: { id: string; name: string; date: string; daysLeft: number } | null;
  };
  health: {
    level: "on_track" | "at_risk" | "off_track";
    plannedPct: number; actualPct: number; gapPct: number;
    behindPlan: number;
    overdue: { count: number; topAssignee?: { person: Person; count: number } | null };
    capacity: { remainingMd: number; teamMdPerWeek: number; weeksNeeded: number | null; weeksLeft: number };
  };
  kpis: {
    total: number; done: number; overdue: number; overdueDelta: number; dueToday: number; laterThisWeek: number;
    laterThisWeekRange: { from: string; to: string }; doneLast7Days: number; doneDelta: number;
  };
  lists: { overdue: OverviewItem[]; dueToday: OverviewItem[]; laterThisWeek: OverviewItem[]; doneLast7Days: OverviewItem[] };
  doneDaily: { date: string; count: number; workingDay: boolean }[];
  burnup: { unit: "md" | "count"; total: number; points: { weekStart: string; weekEnd: string; planned: number; done: number | null }[] };
  modules: { id: string | null; name: string; color: string | null; pct: number; split?: ProgressSplit | null; done: number; total: number; overdue: number; notStarted: boolean }[];
  statusBreakdown: { columns: { id: string; name: string; category: Cat; count: number; pct: number }[] };
  milestones: { id: string; name: string; date: string; daysLeft: number; linkedIssues: number; donePct: number; basis: "linked" | "module" | "project" }[];
  workloadThisWeek: { from: string; to: string; people: { person: Person; md: number; capacityMd: number; utilizationPct: number | null; over: boolean }[] } | null;
  activity: { id: string; issue: { key: string; title: string } | null; actor: Person | null; actorKind: string; verb: string; field: string | null; createdAt: string }[];
  /** M6 · null สำหรับ Guest */
  counts?: { openBugs: number; pendingDueRequests: number } | null;
}

export interface Row {
  id: string; key: string; type: string; parentKey: string | null; title: string;
  status: { id: string; name: string; category: Cat };
  priority: "urgent" | "high" | "medium" | "low";
  moduleId: string | null; phaseId: string | null;
  size: string | null; estimateMd: number | null; progressPct: number | null;
  planStart: string | null; planEnd: string | null; actualStart: string | null; actualEnd: string | null;
  version: number;
  /** false = งานของคนอื่น เปลี่ยนสถานะไม่ได้ (04-permissions ข้อ 3.3) */
  canMove?: boolean;
  assignees?: Person[]; ba?: Person | null; sa?: Person | null; reviewer?: Person | null;
  requirements?: string[]; screens?: string[]; labels?: { id: string; name: string; color: string | null }[];
  /** ค่า Custom field { [fieldId]: ค่า } (ชุดฟิลด์ของโปรเจกต์) */
  customFields?: Record<string, unknown>;
  /** หมายเหตุ · Guest ไม่ได้รับ */
  remark?: string | null;
}
interface Agg { taskCount: number; subtaskCount: number; doneCount: number; estimateMd: number; progressPct: number }
export interface TableData {
  items: Row[];
  nextCursor: string | number | null;
  summary: Agg;
  modules: (Agg & { id: string | null; name: string | null; color: string | null; phases: (Agg & { id: string | null; name: string | null })[] })[];
}
export interface SavedView { id: string; name: string; filters: Record<string, string>; shared: boolean; mine?: boolean }
export interface Options {
  issueTypes: { name: string; statuses?: { id: string; name: string; category: Cat }[] }[];
  modules: { id: string; name: string }[];
  members: Person[];
}

/** ความคืบหน้าแยกช่วง: Dev = ส่งให้ QA แล้ว · QA = Done (สูตรรวมเหมือนความคืบหน้าเดิม) */
export interface ProgressSplit {
  dev: { pct: number; done: number; total: number };
  qa: { pct: number; done: number; total: number };
}
