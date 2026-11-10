// รูปข้อมูลจาก ops-api `ops/support/*` (O22)
export const PLANS = ["free", "team_s", "team_m", "team_l", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];
export const CATEGORIES = ["how_to", "feature_request", "bug", "import", "notification", "api", "billing", "tax_invoice", "payment", "outage", "account", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const GROUPS = ["l1", "l2", "fin", "lead"] as const;
export type Group = (typeof GROUPS)[number];
export const TARGETS = ["l1", "l2", "fin", "acct", "all"] as const;
export type Target = (typeof TARGETS)[number];
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Presence = "online" | "busy" | "offline" | "leave";

export interface Dur {
  n: number;
  unit: "h" | "d";
}
export interface DayHours {
  open: boolean;
  from: string;
  to: string;
}
export interface Config {
  mode: "least" | "round" | "manual";
  defaultCap: number;
  skipUnavailable: boolean;
  reopenDays: number;
  onAway: "queue" | "ask_lead" | "keep";
  sla: Record<Plan, { first: Dur | null; resolve: Dur | null }>;
  hours: DayHours[];
  thaiHolidays: boolean;
}
export interface Rule {
  id: string;
  position: number;
  plans: Plan[];
  categories: Category[];
  target: Target;
  priority: Priority;
  enabled: boolean;
}
export interface Agent {
  staffId: string;
  name: string;
  email: string;
  groups: Group[];
  cap: number | null;
  presence: Presence;
  presenceNote: string | null;
  load: number;
  accounts: { id: string; name: string }[];
}
export interface SettingsView {
  config: Config;
  rules: Rule[];
  agents: Agent[];
  warnPct: number;
  holidays: { count: number; upcoming: { date: string; name: string }[] };
  updatedAt: string | null;
  updatedBy: string | null;
  canEdit: boolean;
}
export interface Canned {
  id: string;
  title: string;
  body: string;
  tag: string | null;
  uses: number;
  archivedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export const TARGET_TONE: Record<Target, "inf" | "ok" | "warn" | "neu"> = { l1: "inf", l2: "inf", fin: "warn", acct: "ok", all: "neu" };
export const PRIORITY_TONE: Record<Priority, "bad" | "warn" | "neu" | "inf"> = { urgent: "bad", high: "warn", normal: "neu", low: "inf" };
export const SETTINGS_KEY = ["ops", "support", "settings"] as const;
export const CANNED_KEY = ["ops", "support", "canned"] as const;

/** ตัวแปรในข้อความสำเร็จรูป · แทนค่าตอนใส่ในช่องตอบ */
export const VARIABLES = ["{ชื่อผู้แจ้ง}", "{ชื่อ Workspace}", "{เลข Ticket}"] as const;
export function fillVariables(body: string, v: { requester: string; workspace: string; ticket: number }) {
  return body.replaceAll("{ชื่อผู้แจ้ง}", v.requester).replaceAll("{ชื่อ Workspace}", v.workspace).replaceAll("{เลข Ticket}", `#${v.ticket}`);
}
