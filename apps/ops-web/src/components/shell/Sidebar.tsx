"use client";

import { FridayMark } from "@/components/brand/FridayMark";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  BookOpen,
  Bug,
  CalendarDays,
  ChartColumn,
  ChartLine,
  Download,
  FileText,
  Filter,
  Flag,
  Gauge,
  Headphones,
  Heart,
  House,
  Inbox,
  KeyRound,
  List,
  ListChecks,
  Map,
  Megaphone,
  ReceiptText,
  RotateCcw,
  Send,
  Server,
  Settings2,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  Tag,
  Target,
  TerminalSquare,
  TriangleAlert,
  User,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import type { Staff } from "@/lib/types";
import { hasAny, initials, rolesOf } from "../access";
import { currentItem, isSoon, linkOf, NAV, type NavKey, type TaskKey } from "./nav";

const ICONS: Record<NavKey, LucideIcon> = {
  home: House, customers: Users, users: User, success: Heart, renewals: CalendarDays, leads: Target, quotes: FileText,
  billing: ChartLine, verify: ReceiptText, refunds: RotateCcw, accounting: Download, promotions: Tag, entitlements: SlidersHorizontal,
  announce: Megaphone, changelog: Star, onboarding: ListChecks, business: ChartColumn, funnel: Filter, adoption: ChartColumn,
  support: Inbox, sessions: Headphones, supportSettings: Settings2, help: BookOpen, bugs: Bug, system: Server, ops: TriangleAlert,
  deliveries: Send, flags: Flag, ratelimit: Gauge, scripts: TerminalSquare, privacy: Shield, abuse: ShieldAlert, legal: FileText,
  restore: Archive, jit: KeyRound, staff: UserPlus, audit: List, roadmap: Map,
};

export interface Overview {
  money: { mrr: number } | null;
  trialing: number;
  tasks: Record<TaskKey, number>;
}
/** ตัวเลขงานวันนี้ (O06) · ใช้ทำ badge ในเมนูและแผงแจ้งเตือน */
export const useOverview = (enabled = true) => useQuery({ queryKey: ["ops", "overview"], queryFn: () => api.get<Overview>("/overview"), enabled, staleTime: 60_000, refetchInterval: 120_000 });

export function Sidebar({ staff, pathname, search, open, onNavigate }: { staff: Staff; pathname: string; search: string; open: boolean; onNavigate: () => void }) {
  const t = useTranslations("common");
  const overview = useOverview();
  const current = currentItem(pathname, search);
  const mine = rolesOf(staff);
  return (
    <aside className="ops-side" aria-label={t("app.navLabel")} data-open={open}>
      <div className="ops-brand">
        <FridayMark />
        <div>
          <b>{t("app.name")}</b>
          <span>{t("app.tagline")}</span>
        </div>
      </div>
      <div className="ops-env">
        <span className="ops-env-dot" aria-hidden="true" />
        <span>{t("app.env")}</span>
        <span className="ops-env-region">{t("app.region")}</span>
      </div>
      <nav aria-label={t("app.navLabel")} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {NAV.map((g) => {
          const items = g.items.filter((i) => hasAny(staff, ...i.roles));
          if (!items.length) return null;
          return (
            <div className="ops-group" key={g.group || "top"} role="group" aria-label={g.group ? t(`groups.${g.group}`) : undefined}>
              {g.group && <span className="ops-glabel">{t(`groups.${g.group}`)}</span>}
              {items.map((i) => {
                const Icon = ICONS[i.key];
                const soon = isSoon(i);
                const count = (i.badge ?? []).reduce((n, k) => n + (overview.data?.tasks[k] ?? 0), 0);
                const on = current?.key === i.key;
                return (
                  <Link key={i.key} href={linkOf(i)} className={soon ? "ops-nav ops-nav-soon" : "ops-nav"} aria-current={on ? "page" : undefined} onClick={onNavigate}>
                    <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                    <span className="ops-nav-label">{t(`nav.${i.key}`)}</span>
                    {count > 0 && !soon && (
                      <span className="ops-badge" aria-label={t("nav.badge", { count })}>
                        {count}
                      </span>
                    )}
                    {soon && <span className="ops-soon">{t("nav.soon")}</span>}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="ops-me">
        <span className="avatar" aria-hidden="true">
          {initials(staff.name)}
        </span>
        <div style={{ minWidth: 0 }}>
          <b>{staff.name}</b>
          <span>{mine.map((r) => t(`roles.${r}`)).join(" · ")}</span>
        </div>
      </div>
    </aside>
  );
}
