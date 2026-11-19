"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSlidingIndicator } from "@/lib/motion";
import Link from "next/link";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChartGantt, Check, ChevronDown, ChevronLeft, Columns3, EyeOff, FileBarChart, Folder, GanttChartSquare, LayoutDashboard, LayoutGrid, History, ListTodo, MoreHorizontal, PauseCircle, Plus, Search, Settings, Table2, Users, Workflow, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateRange } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Project } from "@/lib/types";
import {
  ActionSheet,
  AvatarStack,
  Badge,
  ErrorState,
  Forbidden,
  LoadingState,
  NotFound,
  PausedState,
  useToast,
} from "@/components/ui";
import { IssueDrawer } from "@/features/issue-drawer/IssueDrawer";
import { withoutDrawerParams } from "@/features/issue-drawer/url";
import { ProjectInviteDialog } from "@/features/project-invite/project-invite-dialog";
import { useWorkspace } from "./workspace-shell";
import { FALLBACK_PROJECT_COLOR } from "@/lib/colors";
import { useIsMobile } from "@/lib/use-mobile";

// ใช้ queryKey เดียวกับหน้า Overview และหน้า Members เพื่อไม่ยิง API ซ้ำเมื่อเปิดหน้านั้น
type HealthLevel = "on_track" | "at_risk" | "off_track";
const HEALTH_TONE = {
  on_track: "green",
  at_risk: "amber",
  off_track: "red",
} as const;
interface HeaderMember {
  userId: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
  active: boolean;
}

export const projectTabs = [
  // mobile: แท็บที่มีบนมือถือตาม Canvas M6/M7 (Overview, Kanban, List, Calendar, Files)
  // optional: แท็บเสริมที่ซ่อนไว้ก่อน ผู้ใช้เลือกแสดงเองจากปุ่ม + ท้ายแถวแท็บ · หน้ายังเปิดจาก URL ได้ตามสิทธิ์
  { path: "", label: "overview", mobile: true },
  {
    path: "/reports",
    label: "reports",
    permission: "project.reports.view",
    desktop: true,
    optional: true,
  },
  { path: "/backlog", label: "backlog", hiddenForGuestViewer: true, optional: true },
  { path: "/table", label: "table", hiddenForGuestViewer: true, mobile: true },
  { path: "/board", label: "board", hiddenForGuestViewer: true, mobile: true },
  { path: "/timeline", label: "timeline", desktop: true },
  { path: "/gantt", label: "gantt", hiddenForGuestViewer: true, desktop: true, optional: true },
  // การแก้ไขแผน: ย้ายจากแท็บเสริมไปอยู่ใน Popup Import / Export ของ Table และเมนู Settings (ผู้ใช้ตัดสิน 2026-11-09)
  { path: "/calendar", label: "calendar", hiddenForGuestViewer: true, mobile: true },
  { path: "/members", label: "members", permission: "project.workload.view" },
  { path: "/files", label: "files", hiddenForGuestViewer: true, mobile: true },
  // แท็บ Diagram (ผู้ใช้อนุมัติ storyboard 2026-11-19) · มือถือดูได้อย่างเดียว
  { path: "/diagrams", label: "diagrams", hiddenForGuestViewer: true, mobile: true },
  {
    path: "/settings",
    label: "settings",
    permission: "project.settings",
    desktop: true,
  },
];
/** ไอคอนของแท็บเสริมในเมนูเพิ่มมุมมอง */
const VIEW_ICONS: Record<string, typeof Plus> = { reports: FileBarChart, backlog: ListTodo, gantt: ChartGantt, planChanges: History };
/** มือถือ (W32): ไอคอนของทุกมุมมองในเมนู "มุมมอง ▾" ตามต้นแบบ proj.view-switch */
const MOBILE_VIEW_ICONS: Record<string, typeof Plus> = {
  overview: LayoutDashboard, reports: FileBarChart, backlog: ListTodo, table: Table2, board: Columns3, timeline: GanttChartSquare,
  gantt: ChartGantt, calendar: CalendarDays, members: Users, files: Folder, diagrams: Workflow, settings: Settings,
};

export function allowedProjectTab(
  tab: (typeof projectTabs)[number],
  access: Permissions,
) {
  return (
    !(tab.hiddenForGuestViewer && access.guestViewer) &&
    (!tab.permission || access.permissions.includes(tab.permission))
  );
}

/**
 * แท็บเสริมที่ผู้ใช้เลือกแสดงในโปรเจกต์นี้ · เลือกเป็นรายคน เก็บใน browser (ผู้ใช้ตัดสินใจ 2026-11-07)
 * อ่าน storage ไม่ได้ (private window, ถูกบล็อก) = ใช้แท็บหลักอย่างเดียว
 */
function useOptionalTabs(ws: string, projectKey: string) {
  const storageKey = `friday:project-tabs:${ws}:${projectKey}`;
  const [shown, setShown] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      setShown(Array.isArray(saved) ? saved.filter((v): v is string => typeof v === "string") : []);
    } catch {
      setShown([]);
    }
  }, [storageKey]);
  function toggle(label: string) {
    setShown((current) => {
      const next = current.includes(label) ? current.filter((v) => v !== label) : [...current, label];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* บันทึกไม่ได้ก็ยังใช้ได้ใน session นี้ */
      }
      return next;
    });
  }
  return [shown, toggle] as const;
}

export function ProjectShell({
  projectKey,
  children,
}: {
  projectKey: string;
  children: React.ReactNode;
}) {
  const { workspace, me } = useWorkspace();
  const t = useTranslations("common");
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tabsRef = useSlidingIndicator<HTMLElement>(".tab");
  const cache = useQueryClient();
  const ws = workspace.slug;
  const endpoint = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const base = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const project = useQuery({
    queryKey: queryKeys.project(ws, projectKey),
    queryFn: () => api.get<Project>(endpoint),
  });
  const permissions = useQuery({
    queryKey: queryKeys.permissions(ws, projectKey),
    queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`),
  });
  const [shownTabs, toggleTab] = useOptionalTabs(ws, projectKey);
  const canSeeTeam = !!permissions.data && !permissions.data.guestViewer;
  const health = useQuery({
    queryKey: ["overview", ws, projectKey, "scope=all"],
    queryFn: () =>
      api.get<{ health: { level: HealthLevel } }>(
        `${endpoint}/overview?scope=all`,
      ),
    enabled: !!permissions.data,
  });
  const team = useQuery({
    queryKey: ["project-members", ws, projectKey],
    queryFn: () =>
      api.get<{ items: HeaderMember[]; canInvite: boolean }>(
        `${endpoint}/members`,
      ),
    enabled: canSeeTeam,
  });
  const [inviting, setInviting] = useState(false);
  const mobile = useIsMobile();
  const [viewsOpen, setViewsOpen] = useState(false);
  const { openSearch } = useWorkspace();
  const error = project.error ?? permissions.error;
  async function joinAsAdmin() {
    try {
      await api.post(`${endpoint}/join-as-admin`);
      await cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
      await project.refetch();
      await permissions.refetch();
    } catch (failure) {
      toast({
        message:
          failure instanceof Error ? failure.message : t("app.unknownError"),
      });
    }
  }
  // โปรเจกต์พักอยู่และผู้ใช้ไม่ได้อยู่ในรายชื่อที่เห็น (API ตอบ 403 project_paused)
  if (error instanceof ApiError && error.code === "project_paused")
    return (
      <PausedState
        name={String(error.details.name ?? projectKey)}
        by={typeof error.details.pausedBy === "string" ? error.details.pausedBy : null}
        homeHref={`/work/${encodeURIComponent(ws)}`}
      />
    );
  if (error instanceof ApiError && error.status === 403)
    return (
      <Forbidden
        joinAsAdmin={
          ["owner", "admin"].includes(workspace.role)
            ? () => void joinAsAdmin()
            : undefined
        }
      />
    );
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  if (error)
    return (
      <ErrorState
        error={error}
        retry={() => {
          void project.refetch();
          void permissions.refetch();
        }}
      />
    );
  if (!project.data || !permissions.data) return <LoadingState />;
  const access = permissions.data;
  const route = pathname.slice(base.length);
  const matchingTab = projectTabs.find(
    (tab) =>
      tab.path && (route === tab.path || route.startsWith(`${tab.path}/`)),
  );
  const extraDenied =
    (route.startsWith("/automation") &&
      !access.permissions.includes("project.automation")) ||
    (route.startsWith("/reports") &&
      !access.permissions.includes("project.reports.view")) ||
    (route.startsWith("/plan-changes") &&
      !access.permissions.includes("project.baseline"));
  // โปรเจกต์ที่ Archive แล้วเสียสิทธิ์ project.settings แต่ต้องเข้า Danger zone เพื่อกด "กู้คืน" ได้
  const dangerByArchive =
    route.startsWith("/settings/danger") &&
    access.permissions.includes("project.archive");
  if (
    (matchingTab &&
      !allowedProjectTab(matchingTab, access) &&
      !dangerByArchive) ||
    extraDenied
  )
    return <Forbidden />;
  const issueKey = search.get("issue");
  const newIssue =
    search.get("new") === "1" && access.permissions.includes("issue.create");
  function closeDrawer() {
    const params = withoutDrawerParams(search, pathname);
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`, {
      scroll: false,
    });
  }
  const activeTeam = (team.data?.items ?? []).filter((m) => m.active);
  // Automation เป็นส่วนหนึ่งของ Settings แท็บ Settings จึงเลือกอยู่
  const isCurrentTab = (tab: (typeof projectTabs)[number]) =>
    route === tab.path || (!!tab.path && route.startsWith(`${tab.path}/`)) || (tab.path === "/settings" && route.startsWith("/automation"));
  const allowedTabs = projectTabs.filter((tab) => allowedProjectTab(tab, access));
  const optionalTabs = allowedTabs.filter((tab) => tab.optional);
  // หน้าที่เปิดอยู่แสดงแท็บเสมอแม้ไม่ได้เลือกไว้ (เข้าจากลิงก์ในหน้าอื่น) เพื่อให้รู้ว่าอยู่หน้าไหน
  const visibleTabs = allowedTabs.filter(
    (tab) => !tab.optional || shownTabs.includes(tab.label) || isCurrentTab(tab),
  );
  // ซ่อนแท็บของหน้าที่เปิดอยู่ต้องออกจากหน้านั้นด้วย ไม่งั้นแท็บยังค้าง (หน้าที่เปิดอยู่แสดงแท็บเสมอ)
  function hideTab(tab: (typeof projectTabs)[number]) {
    if (shownTabs.includes(tab.label)) toggleTab(tab.label);
    if (isCurrentTab(tab)) router.push(base);
  }
  // ทุกหน้าใช้หัวและแท็บชุดเดียวกัน รวม Automation ที่อยู่ใต้ Settings
  // (Canvas O1/O2/M1/P2 ตัดหัวให้สั้นลง แต่ผู้ใช้เลือกให้แท็บและเมนูไม่หายเมื่อสลับหน้า · 2026-11-07)
  const canCreate = access.permissions.includes("issue.create");
  const dates = formatDateRange(
    project.data.startDate,
    project.data.goliveDate,
    me.yearFormat,
  );
  const tabName = (tab: (typeof projectTabs)[number]) => t(`nav.${tab.path === "/members" ? "projectMembers" : tab.label}`);
  const currentTab = allowedTabs.find(isCurrentTab);
  // W32 · มือถือตามต้นแบบ (proj.*): หัว B · ย้อนกลับไปรายการโปรเจกต์ · ค้นหา · สร้างงาน · หัวข้อ = มุมมองปัจจุบัน
  // ปุ่ม "มุมมอง ▾" เปิดทุกมุมมองที่มีสิทธิ์ (รวม Timeline / Gantt / Settings ที่เดิมเปิดเฉพาะจอใหญ่)
  const mobileHeader = (
    <header className="m-head m-project-head">
      <div className="m-head-row">
        <Link className="m-icon" href={`/work/${encodeURIComponent(ws)}/projects`} aria-label={t("nav.back")}>
          <ChevronLeft size={22} aria-hidden="true" />
        </Link>
        <span className="m-spacer" />
        <button type="button" className="m-icon" aria-label={t("nav.search")} onClick={() => openSearch?.()}>
          <Search size={20} aria-hidden="true" />
        </button>
        {canCreate && (
          <Link className="m-icon" href={`${base}?new=1`} aria-label={t("nav.new")}>
            <Plus size={22} aria-hidden="true" />
          </Link>
        )}
      </div>
      <h1 className="m-title">{currentTab && currentTab.path ? tabName(currentTab) : project.data.name}</h1>
      <div className="m-subtitle">
        {[project.data.name, projectKey, t(`status.${project.data.status}`), health.data ? t(`health.${health.data.health.level}`) : null].filter(Boolean).join(" · ")}
      </div>
      <button type="button" className="m-view-switch" aria-haspopup="dialog" onClick={() => setViewsOpen(true)}>
        <LayoutGrid size={18} aria-hidden="true" />
        <span>{t("nav.mobileView", { name: currentTab ? tabName(currentTab) : t("nav.overview") })}</span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      <ActionSheet
        open={viewsOpen}
        onOpenChange={setViewsOpen}
        title={t("nav.mobileViews", { name: project.data.name })}
        actions={allowedTabs.map((tab) => {
          const Icon = MOBILE_VIEW_ICONS[tab.label] ?? LayoutDashboard;
          return {
            key: tab.label,
            label: tabName(tab),
            icon: <Icon size={20} aria-hidden="true" />,
            hint: isCurrentTab(tab) ? "✓" : undefined,
            onSelect: () => router.push(`${base}${tab.path}`),
          };
        })}
      />
    </header>
  );
  return (
    <>
      {mobile ? mobileHeader : (
        <header
          className="project-header"
        >
          <div className="project-header-row">
            <div className="project-heading">
              <div className="muted project-crumb">
                {workspace.name} / {t("nav.projects")} / {project.data.name}
              </div>
              <div className="project-title-row">
                <Link
                  className="button button-ghost button-icon project-back"
                  href={`/work/${encodeURIComponent(ws)}`}
                  aria-label={t("nav.back")}
                >
                  <ChevronLeft size={22} aria-hidden="true" />
                </Link>
                <span
                  className="project-icon"
                  style={{ background: project.data.color ?? FALLBACK_PROJECT_COLOR }}
                  aria-hidden="true"
                >
                  {projectKey.slice(0, 2)}
                </span>
                <h1>{project.data.name}</h1>
                <Badge tone="blue">{t(`status.${project.data.status}`)}</Badge>
                {health.data && (
                  <Badge tone={HEALTH_TONE[health.data.health.level]}>
                    {t(`health.${health.data.health.level}`)}
                  </Badge>
                )}
                <span className="project-dates">{dates}</span>
              </div>
              {/* มือถือ M6: รายละเอียดเป็นบรรทัดเดียวใต้ชื่อแทน badge */}
              <div className="muted project-subline">
                {[
                  projectKey,
                  t(`status.${project.data.status}`),
                  health.data ? t(`health.${health.data.health.level}`) : null,
                  dates,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            <div className="project-actions">
              {activeTeam.length > 0 && (
                <span
                  className="project-team"
                  title={t("nav.projectTeam", { count: activeTeam.length })}
                >
                  <AvatarStack
                    max={5}
                    people={activeTeam.map((m) => ({
                      id: m.userId,
                      displayName: m.displayName,
                      initials: m.initials,
                      avatarUrl: m.avatarUrl,
                    }))}
                  />
                </span>
              )}
              {team.data?.canInvite && (
                // เปิด Modal ทับหน้าปัจจุบัน ไม่พาไปแท็บ Members (2026-11-07)
                <button
                  type="button"
                  className="button project-invite"
                  onClick={() => setInviting(true)}
                >
                  {t("nav.invite")}
                </button>
              )}
              {/* เมนู ⋯ มีเฉพาะมือถือ (หัวมือถือไม่มีปุ่ม + New) · Settings / Automation / การแก้ไขแผน
                  ซ้ำกับแท็บ เมนู Settings และเมนู + จึงเอาออกจากจอใหญ่ (ผู้ใช้ตัดสินใจ 2026-11-07) */}
              {canCreate && (
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      className="button button-icon project-menu-trigger mobile-only"
                      aria-label={t("nav.projectMenu")}
                    >
                      <MoreHorizontal size={18} aria-hidden="true" />
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      className="popover project-menu"
                      sideOffset={6}
                      align="end"
                    >
                      <nav aria-label={t("nav.projectMenu")}>
                        <Popover.Close asChild>
                          <Link className="menu-item" href={`${base}?new=1`}>
                            {t("nav.new")}
                          </Link>
                        </Popover.Close>
                      </nav>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              )}
              {canCreate && (
                <Link className="button button-primary project-new" href={`${base}?new=1`}>
                  {t("nav.new")}
                </Link>
              )}
            </div>
          </div>
          <nav ref={tabsRef} className="tabs" aria-label={t("nav.projectViews")}>
            {visibleTabs.map((tab) => {
              const link = (
                <Link
                  key={tab.path}
                  className={`tab${"mobile" in tab ? "" : " desktop-project-tab"}`}
                  data-tab={tab.label}
                  aria-current={isCurrentTab(tab) ? "page" : undefined}
                  href={`${base}${tab.path}`}
                >
                  {tab.label === "table" ? (
                    <>
                      <span className="label-wide">{t("nav.table")}</span>
                      <span className="label-narrow">{t("nav.list")}</span>
                    </>
                  ) : (
                    t(`nav.${tab.path === "/members" ? "projectMembers" : tab.label}`)
                  )}
                </Link>
              );
              if (!tab.optional) return link;
              // แท็บเสริมลบได้จากแถบแท็บโดยตรง (× โผล่เมื่อชี้)
              const name = t(`nav.${tab.label}`);
              return (
                <span key={tab.path} className="tab-optional desktop-project-tab">
                  {link}
                  <button
                    type="button"
                    className="tab-remove"
                    aria-label={t("nav.hideTab", { name })}
                    title={t("nav.hideTab", { name })}
                    onClick={() => hideTab(tab)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              );
            })}
            {optionalTabs.length > 0 && (
              // แท็บเสริมเป็นแท็บจอใหญ่ทั้งหมด ปุ่มเลือกจึงไม่แสดงบนมือถือ
              // แบบเมนู "Board views": กดมุมมองแล้วเพิ่มเป็นแท็บและเปิดทันที · ซ่อนได้จากปุ่มท้ายแถว
              <Popover.Root>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="tab desktop-project-tab project-tab-picker"
                    aria-label={t("nav.chooseTabs")}
                    title={t("nav.chooseTabs")}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="popover view-picker"
                    sideOffset={6}
                    align="start"
                    aria-label={t("nav.moreTabs")}
                  >
                    <div className="view-picker-head">
                      <strong>{t("nav.moreTabs")}</strong>
                      <span className="muted">{t("nav.viewsHint")}</span>
                    </div>
                    <ul className="view-options">
                      {optionalTabs.map((tab) => {
                        // แท็บที่เห็นอยู่ (เลือกไว้ หรือเป็นหน้าที่เปิดอยู่) ซ่อนได้เสมอ
                        const shown = shownTabs.includes(tab.label) || isCurrentTab(tab);
                        const Icon = VIEW_ICONS[tab.label] ?? LayoutDashboard;
                        const name = t(`nav.${tab.label}`);
                        return (
                          <li key={tab.path} className="view-option">
                            <Popover.Close asChild>
                              <button
                                type="button"
                                className="view-option-main"
                                aria-label={name}
                                aria-describedby={`view-desc-${tab.label}`}
                                onClick={() => {
                                  if (!shown) toggleTab(tab.label);
                                  router.push(`${base}${tab.path}`);
                                }}
                              >
                                <span className="view-icon"><Icon size={16} aria-hidden="true" /></span>
                                <span className="view-text">
                                  <b>{name}</b>
                                  <small id={`view-desc-${tab.label}`}>{t(`nav.viewDesc.${tab.label}`)}</small>
                                </span>
                                {shown && <Check className="view-check" size={16} aria-label={t("nav.tabShown")} />}
                              </button>
                            </Popover.Close>
                            {shown && (
                              <button
                                type="button"
                                className="view-hide"
                                aria-label={t("nav.hideTab", { name })}
                                title={t("nav.hideTab", { name })}
                                onClick={() => hideTab(tab)}
                              >
                                <EyeOff size={15} aria-hidden="true" />
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
          </nav>
          <p className="muted mobile-project-note">{t("nav.mobileOnly")}</p>
        </header>
      )}
      {project.data.pausedAt && (
        <div className="paused-banner" role="status">
          <PauseCircle size={16} aria-hidden="true" />
          <span className="paused-banner-text">
            <b>{t("paused.banner", { date: formatDate(project.data.pausedAt, me.yearFormat, true) })}</b> · {t("paused.bannerHint")}
          </span>
          {access.permissions.includes("project.archive") && (
            <Link className="button button-secondary" href={`${base}/settings/danger`}>{t("paused.manage")}</Link>
          )}
        </div>
      )}
      {children}
      {(issueKey || newIssue) && (
        <IssueDrawer issueKey={issueKey ?? undefined} onClose={closeDrawer} />
      )}
      {inviting && <ProjectInviteDialog ws={ws} projectKey={projectKey} open onOpenChange={setInviting} />}
    </>
  );
}
