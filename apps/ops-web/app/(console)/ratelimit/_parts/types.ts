export const RL_KEY = ["ops", "ratelimit"] as const;
export const PLANS = ["free", "team_s", "team_m", "team_l", "enterprise"] as const;

export interface RlRow {
  id: string;
  name: string;
  slug: string;
  plan: (typeof PLANS)[number];
  base: number | null;
  limit: number | null;
  peak: number;
  calls: number;
  rejected: number;
  usagePct: number | null;
  maxStreak: number;
  curStreak: number;
  curSince: string | null;
  override: { value: number | null; expiresAt: string | null } | null;
  topToken: string | null;
}
export interface RlSummary {
  limited24h: number;
  rejected24h: number;
  tabs: { limited: number; near: number; overrides: number };
  todo: RlRow[];
  streakAlert: number;
}
export interface Point {
  minute: string;
  calls: number;
  rejected: number;
  limit: number | null;
}
export interface RlDetail {
  id: string;
  name: string;
  slug: string;
  stats: RlRow | null;
  override: { value: number | null; expiresAt: string | null; reason: string } | null;
  series: Point[];
  breakdown: { tokenId: string; token: string | null; revoked: boolean; route: string; calls: number; rejected: number; peak: number }[];
  lastNotifiedAt: string | null;
  headroom: number;
}
