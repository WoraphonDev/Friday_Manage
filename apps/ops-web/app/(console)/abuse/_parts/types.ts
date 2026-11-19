import styles from "../abuse.module.css";

export const ABUSE_KEY = ["ops", "abuse"] as const;
export const KINDS = ["fake_signup", "invite_spam", "api_abuse", "payment"] as const;
export const OUTCOMES = ["dismissed", "verify_identity", "suspended", "blocked"] as const;
export const BLOCK_KINDS = ["email_domain", "ip", "workspace_slug", "api_token"] as const;
export type Kind = (typeof KINDS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type BlockKind = (typeof BLOCK_KINDS)[number];
export type Action = "dismiss" | "verify_identity" | "suspend" | "block";

export interface Signal {
  rule: string;
  points: number;
  detail: string;
  values?: string[];
}
export interface CaseItem {
  id: string;
  number: number;
  kind: Kind;
  label: string;
  score: number;
  status: "open" | "auto_suspended" | "closed";
  outcome: Outcome | null;
  reason: string | null;
  signals: Signal[];
  ip: string | null;
  createdAt: string;
  autoSuspendedAt: string | null;
  confirmBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  workspaces: number;
  users: number;
}
export interface WsFacts {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  deleted: boolean;
  plan: string | null;
  subStatus: string | null;
  paying: boolean;
  paidEver: boolean;
  members: number;
  pendingInvites: number;
  projects: number;
  ip: string | null;
  ownerEmail: string | null;
}
export interface CaseDetail extends Omit<CaseItem, "workspaces" | "users"> {
  workspaces: WsFacts[];
  workspaceTotal: number;
  users: { id: string; email: string; verified: boolean; createdAt: string }[];
  userTotal: number;
  blockable: { ip: string | null; domains: string[] };
}
export interface Summary {
  deciders: { id: string; name: string }[];
  signups7d: number;
  autoSuspended7d: number;
  falsePositivePct: number | null;
  todo: { open: number; autoSuspended: number; oldestAt: string | null };
  tabs: { history: number; blocks: number };
}
export interface DecideResult {
  decided: number;
  outcome: Outcome;
  blocks: { kind: string; value: string }[];
  next: string | null;
}

/** สีของคะแนน: ถึงเกณฑ์ระงับ (90) = แดง · ถึงเกณฑ์รอตรวจ (70) = เหลือง */
export const scoreClass = (n: number, big = false) => [styles.score, n >= 90 ? styles.scoreBad : n >= 70 ? styles.scoreWarn : "", big ? styles.big : ""].filter(Boolean).join(" ");

/** ปุ่มหลักตามประเภท (storyboard ขั้น 2): สแปมคำเชิญ = ระงับและลบคำเชิญ · สมัครปลอม = ลบและบล็อก · อื่น ๆ = ระงับ */
export const primaryAction = (kind: Kind): { action: Action; key: "suspendInvites" | "block" | "suspend" } =>
  kind === "invite_spam" ? { action: "suspend", key: "suspendInvites" } : kind === "fake_signup" ? { action: "block", key: "block" } : { action: "suspend", key: "suspend" };

export const OUTCOME_TONE: Record<Outcome, "ok" | "warn" | "bad" | "neu"> = { dismissed: "ok", verify_identity: "warn", suspended: "bad", blocked: "bad" };

/** ช่วงเวลาแบบสั้น → { unit, n } ให้หน้าเว็บแปลด้วย abuse.dur.* */
export type Dur = { unit: "d" | "h" | "m"; n: number };
const dur = (ms: number): Dur => {
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? { unit: "d", n: Math.floor(h / 24) } : h >= 1 ? { unit: "h", n: h } : { unit: "m", n: Math.max(1, Math.round(ms / 60_000)) };
};
/** เวลาที่เหลือถึง iso · เลยแล้ว = null */
export function timeLeft(iso: string | null, now = Date.now()): Dur | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  return ms > 0 ? dur(ms) : null;
}
export function ageOf(iso: string | null, now = Date.now()): Dur | null {
  return iso ? dur(Math.max(0, now - Date.parse(iso))) : null;
}
