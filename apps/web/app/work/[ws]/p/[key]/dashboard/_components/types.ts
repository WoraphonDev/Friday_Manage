// รูปแบบคำตอบของ A09 (apps/api/src/reports) และ A08 (workload) ที่หน้า O1 / O2 ใช้
import type { Person } from "@/lib/types";

export type Severity = "high" | "medium" | "low";
export type RiskKind = "overdue" | "due_soon_low_progress" | "capacity_over" | "blocked" | "pending_due_requests";
export type HealthStatus = "on_track" | "at_risk" | "off_track" | "done" | "no_forecast";

export interface RiskItem {
  kind: RiskKind;
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  issueKeys: string[];
  people?: { id: string; displayName: string; count?: number; md?: number; capacityMd?: number; utilizationPct?: number | null }[];
}
export interface RisksResponse {
  project: { key: string; name: string };
  asOf: string;
  counts: Record<Severity, number>;
  items: RiskItem[];
}

export interface ModuleStat {
  id: string | null;
  name: string;
  taskCount: number;
  doneCount: number;
  totalMd: number;
  doneMd: number;
  remainingMd: number;
  progressPct: number;
  overdue: number;
  planStart: string | null;
  plannedEnd: string | null;
  milestone: { name: string; date: string } | null;
  targetDate: string | null;
  velocityMdPerWeek: number;
  forecastEnd: string | null;
  forecastReason: "no_velocity" | "no_estimate" | null;
  slipDays: number | null;
  status: HealthStatus;
}
export interface ModulesResponse {
  asOf: string;
  project: { key: string; name: string; goliveDate: string | null };
  summary: {
    taskCount: number;
    totalMd: number;
    doneMd: number;
    remainingMd: number;
    progressPct: number;
    capacityMdPerWeek: number;
    requiredWeeks: number | null;
    weeksToGoLive: number | null;
    gapWeeks: number | null;
    forecastEnd: string | null;
    forecastReason: "no_velocity" | "no_estimate" | null;
    status: HealthStatus;
  };
  velocity: { windowDays: number; note: string };
  modules: ModuleStat[];
}

export interface WeekPoint { weekStart: string; weekEnd: string; plannedMd: number; doneMd: number }
export interface ForecastResponse extends ModulesResponse {
  weekly: WeekPoint[];
  modules: (ModuleStat & { weekly: WeekPoint[] })[];
}

export interface WorkloadCell {
  value: number;
  capacity: number | null;
  utilizationPct: number | null;
  over: boolean;
  leaveDays: number;
  issues: { key: string; title: string; value: number }[];
}
export interface WorkloadResponse {
  range: { from: string; to: string };
  unit: "md" | "hour" | "count";
  buckets: { start: string; end: string }[];
  people: { person: Person; position: string | null; projectRole: string | null; capacityHoursWeek: number; cells: WorkloadCell[]; total: { value: number; capacity: number | null } }[];
}

export interface WeeklyReport {
  project: { key: string; name: string };
  week: { start: string; end: string; label: string; draft: boolean; asOf: string };
  status: "on_track" | "at_risk" | "off_track";
  totals: { doneCount: number; taskCount: number; usedMd: number; totalMd: number; overdue: number };
  thisWeek: {
    done: { count: number; md: number; keys: string[] };
    inProgress: number;
    inReview: number;
    overdue: { count: number; byAssignee: { id: string; displayName: string; count: number }[] };
    newBugs: { key: string; title: string; status: string }[];
    fixedBugs: { key: string; title: string }[];
  };
  nextWeek: {
    start: string;
    end: string;
    starting: { count: number; md: number; byModule: { name: string; count: number }[] };
    holidays: { date: string; name: string }[];
    sprintEvents: { date: string; type: "sprint_start" | "sprint_end"; name: string }[];
  };
  risks: RiskItem[];
  needsHelp: { unassigned: { count: number; keys: string[] } };
  text: string;
}

export type TraceResult = "uncovered" | "untested" | "partial" | "passed" | "failed" | "blocked";
export interface TraceIssue {
  key: string;
  title: string;
  type: string;
  status: { name: string; category: "todo" | "in_progress" | "done" };
  latestTest: { result: string; runNo: number; environment: string | null; passed: number | null; total: number | null; at: string } | null;
}
export interface TraceabilityResponse {
  project: { key: string; name: string };
  summary: {
    requirements: Record<TraceResult, number> & { total: number };
    screens: { total: number };
    issuesWithoutRequirement: { count: number; keys: string[] };
  };
  requirements: { code: string; kind: "FR" | "NFR"; title: string; result: TraceResult; issues: TraceIssue[] }[];
  screens: { code: string; name: string; result: TraceResult; issues: TraceIssue[] }[];
}

export interface ReportSchedule {
  schedule: { reportType: string; weekday: number; time: string; channels: string[]; recipients: string[] } | null;
}

/** วันที่ YYYY-MM-DD บวกวัน (ไม่ขึ้นกับ timezone ของเครื่อง) */
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
/** วันจันทร์ของสัปดาห์ (จันทร์–อาทิตย์ แบบเดียวกับ weekOf ของ API) */
export function weekStart(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const round1 = (value: number) => Math.round(value * 10) / 10;
export const projectEndpoint = (ws: string, key: string) => `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(key)}`;
export const projectBase = (ws: string, key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key)}`;

/** สีตามระดับ Health (ตรงกับ pill ใน Canvas O1 / O2) */
export const STATUS_TONE: Record<HealthStatus, { bg: string; fg: string }> = {
  on_track: { bg: "var(--success-soft)", fg: "var(--success-text)" },
  at_risk: { bg: "var(--warning-soft)", fg: "var(--warning-text)" },
  off_track: { bg: "var(--danger-soft)", fg: "var(--danger-text)" },
  done: { bg: "var(--success-soft)", fg: "var(--success-text)" },
  no_forecast: { bg: "var(--subtle)", fg: "var(--foreground-soft)" },
};
