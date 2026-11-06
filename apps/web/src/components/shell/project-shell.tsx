"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  { path: "", label: "overview" },
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
  { path: "/table", label: "table", hiddenForGuestViewer: true },
  { path: "/board", label: "board", hiddenForGuestViewer: true },
  { path: "/timeline", label: "timeline", desktop: true },
  { path: "/gantt", label: "gantt", hiddenForGuestViewer: true, desktop: true },
  { path: "/calendar", label: "calendar", hiddenForGuestViewer: true },
  { path: "/members", label: "members", permission: "project.workload.view" },
  { path: "/files", label: "files", hiddenForGuestViewer: true },
  {
    path: "/settings",
    label: "settings",
    permission: "project.settings",
    desktop: true,
  },
];
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
    const params = new URLSearchParams(search);
    params.delete("issue");
    params.delete("new");
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`, {
      scroll: false,
    });
  }
  const activeTeam = (team.data?.items ?? []).filter((m) => m.active);
  // P2 Automation มี breadcrumb ของหน้าเอง · O1/O2 ใช้หัวแบบ Lead ที่ไม่มี breadcrumb และปุ่มทีม
  const headerVariant = route.startsWith("/automation")
    ? "none"
    : /^\/(dashboard|reports)(\/|$)/.test(route)
      ? "lead"
      : "full";
  const lead = headerVariant === "lead";
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
        <header className="project-header">
          <div className="project-header-row">
            <div className="project-heading">
              {!lead && (
                <div className="muted project-crumb">
                  {workspace.name} / {t("nav.projects")} / {project.data.name}
                </div>
              )}
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
                <span className="project-dates">
                  {formatDateRange(
                    project.data.startDate,
                    project.data.goliveDate,
                    me.yearFormat,
                  )}
                </span>
              </div>
            </div>
            <div className="project-actions">
              {!lead && activeTeam.length > 0 && (
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
              {!lead && team.data?.canInvite && (
                <Link
                  className="button project-invite"
                  href={`${base}/members#invites`}
                >
                  {t("nav.invite")}
                </Link>
              )}
              {!lead && menuItems.length > 0 && (
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      className="button button-icon project-menu-trigger"
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
                        {menuItems.map((item) => (
                          <Popover.Close asChild key={item.path}>
                            <Link
                              className="menu-item"
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
              {!lead && access.permissions.includes("issue.create") && (
                <Link className="button button-primary" href={`${base}?new=1`}>
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
                  className={`tab${tab.desktop ? " desktop-project-tab" : ""}`}
                  aria-current={
                    route === tab.path ||
                    (!!tab.path && route.startsWith(`${tab.path}/`))
                      ? "page"
                      : undefined
                  }
                  href={`${base}${tab.path}`}
                >
                  {t(
                    `nav.${tab.path === "/members" ? "projectMembers" : tab.label}`,
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
    </>
  );
}
