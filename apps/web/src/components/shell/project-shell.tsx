"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDateRange } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Project } from "@/lib/types";
import {
  AvatarStack,
  Badge,
  ErrorState,
  Forbidden,
  LoadingState,
  NotFound,
  useToast,
} from "@/components/ui";
import { IssueDrawer } from "@/features/issue-drawer/IssueDrawer";
import { withoutDrawerParams } from "@/features/issue-drawer/url";
import { ProjectInviteDialog } from "@/features/project-invite/project-invite-dialog";
import { useWorkspace } from "./workspace-shell";

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
  { path: "", label: "overview", mobile: true },
  {
    path: "/dashboard",
    label: "dashboard",
    permission: "project.reports.view",
  },
  {
    path: "/reports",
    label: "reports",
    permission: "project.reports.view",
    desktop: true,
  },
  { path: "/backlog", label: "backlog", hiddenForGuestViewer: true },
  { path: "/table", label: "table", hiddenForGuestViewer: true, mobile: true },
  { path: "/board", label: "board", hiddenForGuestViewer: true, mobile: true },
  { path: "/timeline", label: "timeline", desktop: true },
  { path: "/gantt", label: "gantt", hiddenForGuestViewer: true, desktop: true },
  { path: "/calendar", label: "calendar", hiddenForGuestViewer: true, mobile: true },
  { path: "/members", label: "members", permission: "project.workload.view" },
  { path: "/files", label: "files", hiddenForGuestViewer: true, mobile: true },
  {
    path: "/settings",
    label: "settings",
    permission: "project.settings",
    desktop: true,
  },
];
/** แท็บของหัวแบบ Lead (Canvas O1/O2) */

export function allowedProjectTab(
  tab: (typeof projectTabs)[number],
  access: Permissions,
) {
  return (
    !(tab.hiddenForGuestViewer && access.guestViewer) &&
    (!tab.permission || access.permissions.includes(tab.permission))
  );
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
  const cache = useQueryClient();
  const ws = workspace.slug;
  const endpoint = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const base = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const project = useQuery({
    queryKey: queryKeys.project(ws, projectKey),
    queryFn: () => api.get<Project>(endpoint),
  });
  const permissions = useQuery({
    queryKey: queryKeys.permissions(ws, projectKey),
    queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`),
  });
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
  const headerRef = useRef<HTMLElement>(null);
  const [inviting, setInviting] = useState(false);
  // Drawer รายละเอียด/สร้างงานเริ่มใต้หัวโปรเจกต์ตาม Canvas C / B · เก็บตำแหน่งเป็น CSS variable
  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const bottom = headerRef.current?.getBoundingClientRect().bottom ?? 0;
      // top bar ติดอยู่กับที่: เลื่อนหัวโปรเจกต์พ้นจอแล้ว Drawer ต้องเริ่มใต้ top bar ไม่ใช่ทับ
      const bar = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
      root.style.setProperty("--drawer-top", `${Math.max(0, Math.round(bar), Math.round(bottom))}px`);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (headerRef.current) observer?.observe(headerRef.current);
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--drawer-top");
    };
  });
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
  // P2 Automation มี breadcrumb ของหน้าเอง · แท็บอื่นใช้หัวและแท็บชุดเดียวกันทุกหน้า
  // (Canvas O1/O2/M1 ตัดหัวให้สั้นลง แต่ผู้ใช้เลือกให้แท็บไม่ขยับและครบทุกหน้า · 2026-11-07)
  const headerVariant = route.startsWith("/automation") ? "none" : "full";
  const canCreate = access.permissions.includes("issue.create");
  const dates = formatDateRange(
    project.data.startDate,
    project.data.goliveDate,
    me.yearFormat,
  );
  // หน้าที่ไม่มีแท็บของตัวเอง เข้าจากเมนู ⋯ ตาม Canvas (Main มีปุ่ม ⋯ ข้าง Invite)
  const menuItems = [
    { path: "/settings", label: "settings", permission: "project.settings" },
    {
      path: "/automation",
      label: "automation",
      permission: "project.automation",
    },
    {
      path: "/plan-changes",
      label: "planChanges",
      permission: "project.baseline",
    },
  ].filter((item) => access.permissions.includes(item.permission));
  return (
    <>
      {headerVariant !== "none" && (
        <header
          className="project-header"
          ref={headerRef}
        >
          <div className="project-header-row">
            <div className="project-heading">
              <div className="muted project-crumb">
                {workspace.name} / {t("nav.projects")} / {project.data.name}
              </div>
              <div className="project-title-row">
                <Link
                  className="button button-ghost button-icon project-back"
                  href={`/w/${encodeURIComponent(ws)}`}
                  aria-label={t("nav.back")}
                >
                  <ChevronLeft size={22} aria-hidden="true" />
                </Link>
                <span
                  className="project-icon"
                  style={{ background: project.data.color ?? "#334155" }}
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
              {(menuItems.length > 0 || canCreate) && (
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      className={`button button-icon project-menu-trigger${menuItems.length ? "" : " mobile-only"}`}
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
                        {canCreate && (
                          // มือถือไม่มีปุ่ม + New บนหัว จึงย้ายมาไว้ในเมนู ⋯
                          <Popover.Close asChild>
                            <Link className="menu-item mobile-only" href={`${base}?new=1`}>
                              {t("nav.new")}
                            </Link>
                          </Popover.Close>
                        )}
                        {menuItems.map((item) => (
                          <Popover.Close asChild key={item.path}>
                            <Link
                              className="menu-item desktop-only"
                              href={`${base}${item.path}`}
                            >
                              {t(`nav.${item.label}`)}
                            </Link>
                          </Popover.Close>
                        ))}
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
          <nav className="tabs" aria-label={t("nav.projectViews")}>
            {projectTabs
              .filter((tab) => allowedProjectTab(tab, access))
              .map((tab) => (
                <Link
                  key={tab.path}
                  className={`tab${"mobile" in tab ? "" : " desktop-project-tab"}`}
                  data-tab={tab.label}
                  aria-current={
                    route === tab.path ||
                    (!!tab.path && route.startsWith(`${tab.path}/`))
                      ? "page"
                      : undefined
                  }
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
              ))}
          </nav>
          <p className="muted mobile-project-note">{t("nav.mobileOnly")}</p>
        </header>
      )}
      {children}
      {(issueKey || newIssue) && (
        <IssueDrawer issueKey={issueKey ?? undefined} onClose={closeDrawer} />
      )}
      {inviting && <ProjectInviteDialog ws={ws} projectKey={projectKey} open onOpenChange={setInviting} />}
    </>
  );
}
