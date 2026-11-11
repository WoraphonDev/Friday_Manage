import { ApiError, supportId } from "@/lib/api";
import type { Person } from "@/lib/types";

/** "เมื่อ … ถ้า … ให้ …" ตาม apps/api/src/automation/rules.ts (A26) */
export const TRIGGERS = ["issue_created", "status_changed", "subtasks_done", "overdue", "test_attached", "sprint_started", "sprint_completed", "schedule"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const CONDITION_FIELDS = ["type", "status", "statusCategory", "priority", "assignee", "label", "module", "severity", "estimateMd", "daysToDue", "isSubtask"] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const OPS = ["eq", "in", "gt", "lt", "empty", "not_empty"] as const;
export type Op = (typeof OPS)[number];
/** ฟิลด์ตัวเลขใช้ gt/lt ได้ · ฟิลด์อื่นเทียบค่า */
export const NUMERIC_FIELDS: ConditionField[] = ["estimateMd", "daysToDue"];
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export const SEVERITIES = ["critical", "major", "minor"] as const;
export { STATUS_CATEGORIES } from "@/lib/status";
export const ACTION_TYPES = ["set_status", "assign", "set_priority", "add_label", "add_watcher", "create_subtask", "comment", "notify"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface Condition {
  field: ConditionField;
  op: Op;
  value?: string | number | boolean | (string | number)[];
  not: boolean;
}
export type UserRef = string; // uuid | "reporter" | "creator"
export type Action =
  | { type: "set_status"; status: string }
  | { type: "assign"; mode: "add" | "set" | "clear"; user?: UserRef }
  | { type: "set_priority"; priority: (typeof PRIORITIES)[number] }
  | { type: "add_label"; label: string }
  | { type: "add_watcher"; user: UserRef }
  | { type: "create_subtask"; title: string; assignee?: UserRef }
  | { type: "comment"; body: string }
  | { type: "notify"; to: "assignees" | "reporter" | "project_owner" | "users"; userIds?: string[]; message: string };

export interface RuleShape {
  name: string;
  trigger: Trigger;
  triggerConfig: Record<string, unknown>;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}
export interface Rule extends RuleShape {
  id: string;
  sentence: string;
  createdBy?: Person | null;
  stats30d?: { runs: number; failed: number; lastRunAt: string | null };
}
export interface RuleList {
  usage: { runsThisMonth: number; quota: number };
  items: Rule[];
}
export interface Template {
  id: string;
  category: string;
  name: string;
  description: string;
  rule: Omit<RuleShape, "enabled">;
  sentence: string;
}
export interface DryRun {
  ruleId: string;
  sentence: string;
  checked: number;
  matched: number;
  items: { key: string; title: string; status: string; wouldDo: { action: string; text: string; warning?: string }[] }[];
  notes: string[];
}
export interface Run {
  id: string;
  rule: { id: string; name: string };
  issueKeys: string[];
  result: "success" | "skipped" | "failed" | "retried";
  depth: number;
  detail: unknown;
  ranAt: string;
}
/** GET p/form-options (ใช้เป็นตัวเลือกค่าในตัวสร้างกฎ) */
export interface FormOptions {
  members: (Person & { role: string })[];
  labels: { id: string; name: string }[];
  modules: { id: string; name: string }[];
  issueTypes: { id: string; name: string; statuses: { id: string; name: string }[] }[];
}

export const blankAction = (type: ActionType): Action => {
  switch (type) {
    case "set_status": return { type, status: "" };
    case "assign": return { type, mode: "add", user: "" };
    case "set_priority": return { type, priority: "high" };
    case "add_label": return { type, label: "" };
    case "add_watcher": return { type, user: "" };
    case "create_subtask": return { type, title: "" };
    case "comment": return { type, body: "" };
    case "notify": return { type, to: "assignees", message: "" };
  }
};
export const blankRule = (): RuleShape => ({ name: "", trigger: "issue_created", triggerConfig: {}, conditions: [], actions: [blankAction("notify")], enabled: true });

/** กรองช่องว่างออกก่อนส่ง (API ตรวจ schema เข้ม: user ว่าง = ผิด) */
export function toBody(r: RuleShape) {
  const actions = r.actions.map((a) => {
    if (a.type === "assign") return a.mode === "clear" ? { type: a.type, mode: a.mode } : { type: a.type, mode: a.mode, user: a.user };
    if (a.type === "create_subtask") return a.assignee ? a : { type: a.type, title: a.title };
    if (a.type === "notify") return a.to === "users" ? a : { type: a.type, to: a.to, message: a.message };
    return a;
  });
  const conditions = r.conditions.map((c) => (c.op === "empty" || c.op === "not_empty" ? { field: c.field, op: c.op, not: c.not } : c));
  const cfg = Object.fromEntries(Object.entries(r.triggerConfig).filter(([, v]) => v !== "" && v !== undefined && v !== null));
  return { name: r.name.trim(), trigger: r.trigger, triggerConfig: cfg, conditions, actions, enabled: r.enabled };
}

/** ช่องที่ยังไม่ครบ (ปิดปุ่มบันทึก) */
export function incomplete(r: RuleShape) {
  if (!r.name.trim() || !r.actions.length) return true;
  if (r.trigger === "schedule" && (!r.triggerConfig.time || (r.triggerConfig.frequency === "weekly" && !r.triggerConfig.weekday))) return true;
  if (r.conditions.some((c) => c.op !== "empty" && c.op !== "not_empty" && (c.value === undefined || c.value === "" || (Array.isArray(c.value) && !c.value.length)))) return true;
  return r.actions.some((a) => {
    switch (a.type) {
      case "set_status": return !a.status;
      case "assign": return a.mode !== "clear" && !a.user;
      case "add_label": return !a.label.trim();
      case "add_watcher": return !a.user;
      case "create_subtask": return !a.title.trim();
      case "comment": return !a.body.trim();
      case "notify": return !a.message.trim() || (a.to === "users" && !a.userIds?.length);
      default: return false;
    }
  });
}

export function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError) return supportId(error) ? `${error.message} (${supportId(error)})` : error.message;
  return error instanceof Error ? error.message : fallback;
}
