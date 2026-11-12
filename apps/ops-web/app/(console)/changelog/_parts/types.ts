// รูปแบบข้อมูลของ ops/changelog และ ops/nps (O33 · apps/ops-api/src/changelog)
export type Kind = "new" | "improved" | "fixed";
export type Audience = "all" | "plans" | "flag" | "admins";
export type EntryStatus = "draft" | "scheduled" | "published" | "hidden";
export type Range = "30d" | "90d" | "12m";
export type Group = "all" | "detractor" | "passive" | "promoter";

export interface Entry {
  id: string;
  kind: Kind;
  title: string;
  summary: string;
  body: string;
  titleEn: string | null;
  summaryEn: string | null;
  bodyEn: string | null;
  mediaUrl: string | null;
  mediaKind: "image" | "video" | null;
  mediaAlt: string | null;
  ctaLabel: string | null;
  ctaLabelEn: string | null;
  ctaPath: string | null;
  audience: Audience;
  audiencePlans: string[];
  audienceFlag: string | null;
  spotlight: boolean;
  showPublic: boolean;
  status: EntryStatus;
  displayDate: string | null;
  publishedAt: string | null;
  hiddenAt: string | null;
  hideReason: string | null;
  createdAt: string;
  updatedAt: string;
  views: number;
  clicks: number;
  viewPct: number | null;
  clickPct: number | null;
  flagWorkspaces: number | null;
  createdBy: string | null;
  devIssueKey: string | null;
}

export interface ChangelogData {
  items: Entry[];
  kpis: {
    published30: number;
    byKind: Record<Kind, number>;
    activeUsers30: number;
    readers30: number;
    readersPct: number | null;
    clickPct: number | null;
  };
}

export interface NpsSummary {
  range: Range;
  score: number | null;
  delta: number | null;
  answered: number;
  asked: number;
  dismissed: number;
  promotersPct: number;
  passivesPct: number;
  detractorsPct: number;
  groups: Record<Exclude<Group, "all">, number>;
  openDetractors: number;
  monthly: { month: string; answered: number; score: number | null }[];
  byPlan: { plan: string | null; answered: number; score: number | null }[];
  topics: { topic: string; count: number }[];
}

export interface NpsResponse {
  id: string;
  score: number;
  comment: string | null;
  topics: string[];
  tags: string[];
  role: string;
  plan: string | null;
  createdAt: string;
  followUpStatus: "open" | "done";
  note: string | null;
  followedUpAt: string | null;
  followedUpBy: string | null;
  workspace: { id: string; name: string; slug: string };
  ticket: { id: string; number: number } | null;
}

export interface NpsDetail extends NpsResponse {
  context: {
    previous: { score: number; at: string } | null;
    health: number | null;
    members: number;
    tickets90: { count: number; latest: { number: number; subject: string; status: string } | null };
  };
}

export interface NpsSettings {
  enabled: boolean;
  audience: "admins" | "members";
  firstAfterDays: number;
  repeatDays: number;
  samplePct: number;
  excludeTrialDays: number | null;
  excludeTicketDays: number | null;
  excludeSpotlightDay: boolean;
  excludeShortMobile: boolean;
  question: string;
  questionEn: string | null;
  followUps: { detractor: string; passive: string; promoter: string };
  followUpsEn: { detractor: string; passive: string; promoter: string } | null;
  topics: string[];
  updatedAt: string;
}

export const CHANGELOG_KEY = ["ops", "changelog"] as const;
export const NPS_KEY = ["ops", "nps"] as const;
export const PLAN_CODES = ["free", "team_s", "team_m", "team_l", "enterprise"] as const;

export const KIND_TONE: Record<Kind, "ok" | "inf" | "neu"> = { new: "ok", improved: "inf", fixed: "neu" };
export const STATUS_TONE: Record<EntryStatus, "ok" | "warn" | "neu" | "bad"> = { published: "ok", scheduled: "warn", draft: "neu", hidden: "bad" };
/** สีป้ายคะแนน NPS ตามกลุ่ม */
export const scoreTone = (n: number) => (n <= 6 ? "bad" : n <= 8 ? "warn" : "ok");
export const npsTone = (n: number | null) => (n === null ? "neu" : n >= 20 ? "ok" : n >= 0 ? "warn" : "bad");
export const signed = (n: number | null) => (n === null ? "—" : n > 0 ? `+${n}` : String(n));

/** หน้าในแอปลูกค้าที่ใช้บ่อยสำหรับปุ่ม "ลองใช้" (ต่อจาก /work/{ws}) */
export const CTA_PRESETS = [
  { path: "/profile?tab=notify", label: "Profile › การแจ้งเตือน" },
  { path: "/profile", label: "Profile" },
  { path: "/my-tasks", label: "My Tasks" },
  { path: "/inbox", label: "Inbox" },
  { path: "/members", label: "สมาชิก" },
  { path: "/admin", label: "Admin Console" },
  { path: "/billing", label: "แพ็กเกจและการชำระเงิน" },
] as const;
