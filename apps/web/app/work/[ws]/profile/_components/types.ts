// รูปแบบข้อมูลจาก API ของหน้า I (Profile) · ดู apps/api/src/me, auth/me-security.controller.ts, line, calendar
import type { Me } from "@/lib/types";

export interface ProfileMe extends Me {
  emailVerified?: boolean;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  about?: string | null;
  avatarUrl?: string | null;
}
export type MePatch = Partial<Pick<ProfileMe, "displayName" | "firstName" | "lastName" | "phone" | "about" | "avatarUrl" | "locale" | "yearFormat" | "timezone">>;

export interface Membership {
  role: "owner" | "admin" | "member" | "guest";
  jobTitle: string | null;
  department: string | null;
  capacityHoursWeek: number;
  /** null = ใช้เวลาทำงานของ Workspace */
  workStart: string | null;
  workEnd: string | null;
  workDays: number[] | null;
  effective: { workStart: string; workEnd: string; workDays: number[] };
}

export type PrefChannel = "in_app" | "email" | "line";
export type PrefGroup = "assigned" | "activity" | "schedule" | "project";
export interface PrefRow {
  eventType: string;
  group: PrefGroup;
  label: string;
  hint: string | null;
  channels: Record<PrefChannel, { enabled: boolean; locked: boolean; custom: boolean }>;
}
export interface Prefs {
  workspace: string;
  channels: PrefChannel[];
  rows: PrefRow[];
}
export interface NotifySettings {
  workspace: string;
  dueReminder: "1d_and_today" | "3d" | "today_only";
  digest: "workdays" | "daily" | "off";
  quietStart: string | null;
  quietEnd: string | null;
  quietOnHolidays: boolean;
  autoWatch: boolean;
  custom: boolean;
}

export interface LineStatus {
  linked: boolean;
  displayName: string | null;
  boundAt: string | null;
}
export interface LinkCode {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export interface Leave {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  halfDay: "am" | "pm" | null;
  status: "pending" | "approved" | "rejected";
  source: string;
  createdAt: string;
}
export interface Feed {
  id: string;
  projectKey: string | null;
  createdAt: string;
  /** มีเฉพาะตอนสร้าง (เก็บแค่ hash ดูซ้ำไม่ได้) */
  url?: string;
}

export interface Session {
  id: string;
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
  location: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  backupCodesLeft: number;
  setupPending: boolean;
  requiredByPolicy: boolean;
}
export interface Identity {
  id: string;
  provider: "password" | "google" | "microsoft" | "saml" | "oidc";
  createdAt: string;
  passwordChangedAt?: string | null;
  canDelete: boolean;
}

export const profileKeys = {
  membership: (ws: string) => ["profile", ws, "membership"] as const,
  prefs: (ws: string) => ["profile", ws, "notification-prefs"] as const,
  settings: (ws: string) => ["profile", ws, "notification-settings"] as const,
  leaves: (ws: string) => ["profile", ws, "leaves"] as const,
  feeds: (ws: string) => ["profile", ws, "calendar-feeds"] as const,
  stats: (ws: string) => ["profile", ws, "stats"] as const,
  line: ["me", "line"] as const,
  sessions: ["me", "sessions"] as const,
  mfa: ["me", "mfa"] as const,
  identities: ["me", "identities"] as const,
};
