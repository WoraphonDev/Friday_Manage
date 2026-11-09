import { ApiError, supportId } from "@/lib/api";

/** แท็บของ N1 ตามเมนูใน Canvas · `notify-templates` = หน้า N2 */
export const SECTIONS = ["overview", "projects", "teams", "std", "load", "security", "audit", "data", "notify", "integ", "bill"] as const;
export type Section = (typeof SECTIONS)[number] | "notify-templates";
export const isSection = (v: string): v is Section => (SECTIONS as readonly string[]).includes(v) || v === "notify-templates";
/** หัวข้อเมนูตาม Canvas */
export const NAV_GROUPS: { key: string; items: (typeof SECTIONS)[number][] }[] = [
  { key: "groupOverview", items: ["overview"] },
  { key: "groupOrg", items: ["projects", "teams", "std", "load"] },
  { key: "groupGov", items: ["security", "audit", "data"] },
  { key: "groupSystem", items: ["notify", "integ", "bill"] },
];

export const SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

export interface Person {
  id: string;
  displayName: string;
  initials?: string;
  avatarUrl?: string | null;
}

/** GET w/admin/overview (A18) */
export interface AdminOverview {
  plan: { code: string; name: string; status: string; trialEndsAt: string | null };
  users: { active: number; seatLimit: number | null; guests: number; activeLast7Days: number };
  projects: { active: number; archived: number; limit: number | null };
  storage: { usedBytes: number; limitBytes: number | null };
  issues: { total: number; open: number };
  weeklyActiveUsers: { week: string; users: number }[];
  mfa: { enabled: number; total: number };
  actions: { code: string; count: number; message: string }[];
  projectList: {
    id: string;
    key: string;
    name: string;
    visibility: "private" | "workspace";
    status: string;
    pm: { id: string; displayName: string | null } | null;
    memberCount: number;
    lastActivityAt: string | null;
  }[];
}

/** GET w/settings */
export interface WorkspaceSettings {
  workStart: string;
  workEnd: string;
  workDays: number[];
  sizeMdMap: Record<Size, number>;
  allowProjectOverride: boolean;
  safeMode: boolean;
  trashDays: 30 | 90;
  archiveRetentionYears: number | null;
  requireConsentOnFirstLogin: boolean;
  holidayCalendarId: string | null;
  dataRegion: string;
  recalculated?: { projects: number; issues: number };
}

export interface HolidayCalendar {
  id: string;
  name: string;
  source: string;
  holidayCount: number;
  isDefault: boolean;
  editable: boolean;
}
export interface Holidays {
  calendarId: string | null;
  name?: string;
  editable?: boolean;
  items: { id: string; date: string; name: string; kind: "bank" | "company" }[];
}
/** project_templates.config (รูปแบบเดียวกับ TemplateConfig ของ API) · เก็บค่าอื่นที่หน้านี้ไม่ได้แก้ไว้ตามเดิม */
export interface TemplateConfig {
  category?: string;
  fields?: Partial<Record<import("@/lib/field-profile").ProfileField, { task?: import("@/lib/field-profile").FieldMode; subtask?: import("@/lib/field-profile").FieldMode }>>;
  columns?: string[];
  customFields?: { name: string; fieldType: import("@/lib/field-profile").CustomFieldType; options?: unknown; taskMode?: import("@/lib/field-profile").FieldMode; subtaskMode?: import("@/lib/field-profile").FieldMode }[];
  [key: string]: unknown;
}
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  usageCount: number;
  config?: TemplateConfig;
}

export interface Team {
  id: string;
  name: string;
  color: string | null;
  lead: Person | null;
  memberCount: number;
  capacityMdWeek: number;
  projectCount: number;
}
export interface TeamDetail extends Team {
  members: (Person & { role: string; jobTitle: string | null; capacityHoursWeek: number })[];
}
export interface WorkspaceMember {
  userId: string;
  displayName: string;
  email: string | null;
  role: "owner" | "admin" | "member" | "guest";
  status: string;
}

/** GET w/workload (A08) */
export interface WorkspaceWorkload {
  range: { from: string; to: string };
  buckets: { start: string; end: string }[];
  people: {
    person: Person;
    jobTitle: string | null;
    capacityHoursWeek: number;
    allocatedHoursWeek: number;
    overAllocated: boolean;
    overPeriods: number;
    cells: { value: number; capacity: number | null; over: boolean; byProject: { key: string; name: string; color: string | null; value: number }[] }[];
  }[];
}

export type MfaEnforcement = "none" | "admin" | "all";
export interface SecurityPolicy {
  passwordMinLength: number;
  passwordRequireSpecial: boolean;
  passwordRotationDays: number | null;
  lockoutAttempts: number;
  lockoutMinutes: number;
  sessionIdleHours: number;
  mfaEnforcement: MfaEnforcement;
  allowedEmailDomains: string[];
  ipAllowlist: string[];
  mfa?: { enabled: number; total: number; missing: Person[] };
}

export type AuditCategory = "perm" | "data" | "secu" | "plan" | "notify";
export interface AuditEntry {
  id: string;
  at: string;
  actor: { id: string | null; kind: string; displayName: string | null };
  category: AuditCategory;
  action: string;
  summary: string;
  ip: string | null;
}

export interface SupportAccess {
  enabled: boolean;
  expired: boolean;
  until: string | null;
  maxMode: "read" | "write";
  notifyAdmins: boolean;
  sessions: { id: string; ticketNo: string; mode: string; startedAt: string; durationMinutes: number | null; staffName: string }[];
}
export interface WorkspaceExport {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  createdAt: string;
  expiresAt: string | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
}
export interface DataRequest {
  id: string;
  requesterEmail: string;
  requestType: "erase" | "export";
  status: "pending" | "in_progress" | "completed" | "rejected";
  dueDate: string;
  daysLeft: number;
  overdue: boolean;
  completedAt: string | null;
  createdAt: string;
}

export interface LineConfig {
  configured: boolean;
  webhookUrl: string;
  config: { channelId: string; channelSecretLast4: string | null; accessTokenLast4: string | null; fallbackToEmail: boolean; batchDigestMinutes: number } | null;
}
export interface EmailConfig {
  configured: boolean;
  mode: "custom" | "friday" | "disabled";
  config: {
    fromName: string;
    fromEmail: string;
    replyTo: string | null;
    dns: { spf: boolean; dkim: boolean; dmarc: boolean };
    verifiedAt: string | null;
  } | null;
}
export type WebhookFormat = "json" | "discord" | "slack" | "teams" | "telegram";
export const WEBHOOK_FORMATS: WebhookFormat[] = ["discord", "slack", "teams", "telegram", "json"];
export interface Webhook {
  id: string;
  name: string;
  format: WebhookFormat;
  urlLast4: string | null;
  signed: boolean;
  status: "active" | "paused";
  consecutiveFailures: number;
  usedBy: { projectKey: string; eventType: string }[];
  /** มีเฉพาะคำตอบของ POST ตอนให้ระบบสร้าง secret · แสดงครั้งเดียว */
  signingSecret?: string;
}

export interface GitIntegrations {
  configured: boolean;
  items: { id: string; provider: string; accountName: string; status: string; repositories: { id: string; fullName: string; projects: string[] }[] }[];
}
export interface ApiToken {
  id: string;
  name: string;
  scopes: ("read" | "write")[];
  createdBy: Person | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  /** มีเฉพาะคำตอบของ POST · แสดงครั้งเดียว */
  token?: string;
}

/** GET w/notification-templates/{event}:preview (A25) */
export interface PreviewMessage {
  event: string;
  head: string;
  title: string;
  project: string;
  rows: [string, string][];
  note: string;
  buttons: { label: string; url: string }[];
  color: string;
  url: string;
  safe: boolean;
}
export interface Preview {
  event: string;
  channel: "line" | "email" | "webhook";
  safeMode: boolean;
  message: PreviewMessage;
  rendered: unknown;
}

/** path ของ API (ต่อหลัง /api/v1) */
export const wsPath = (ws: string) => `/w/${encodeURIComponent(ws)}`;
/** ที่อยู่หน้าเว็บของ Workspace */
export const workPath = (ws: string) => `/work/${encodeURIComponent(ws)}`;
export const adminKey = (ws: string, ...rest: string[]) => ["workspace", ws, "admin", ...rest];

export function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError) return supportId(error) ? `${error.message} (${supportId(error)})` : error.message;
  return error instanceof Error ? error.message : fallback;
}
export const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

export function formatBytes(bytes: number | null) {
  if (bytes === null) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${new Intl.NumberFormat("th-TH", { maximumFractionDigits: 1 }).format(gb)} GB`;
  return `${new Intl.NumberFormat("th-TH", { maximumFractionDigits: 1 }).format(bytes / 1024 ** 2)} MB`;
}
