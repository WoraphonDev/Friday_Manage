"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { formatDateRange } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Project } from "@/lib/types";
import {
  Badge,
  ErrorState,
  Forbidden,
  LoadingState,
  NotFound,
  useToast,
} from "@/components/ui";
import { IssueDrawer } from "@/features/issue-drawer/IssueDrawer";
import { useWorkspace } from "./workspace-shell";

export const projectTabs = [
  { path: "", label: "overview" },
  {
    path: "/dashboard",
    label: "dashboard",
    permission: "project.reports.view",
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
  if ((matchingTab && !allowedProjectTab(matchingTab, access)) || extraDenied)
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
  return (
    <>
      <header className="project-header">
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          {workspace.name} / {t("nav.projects")} / {project.data.name}
        </div>
        <div className="project-title-row">
          <span
            className="project-icon"
            style={{ background: project.data.color ?? "#334155" }}
          >
            {projectKey}
          </span>
          <div className="project-title">
            <h1>{project.data.name}</h1>
            <div className="project-meta">
              <Badge tone="blue">{t(`status.${project.data.status}`)}</Badge>
              <span>
                {formatDateRange(
                  project.data.startDate,
                  project.data.goliveDate,
                  me.yearFormat,
                )}
              </span>
            </div>
          </div>
          {access.permissions.includes("issue.create") && (
            <Link className="button button-primary" href={`${base}?new=1`}>
              {t("nav.new")}
            </Link>
          )}
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
                {t(`nav.${tab.label}`)}
              </Link>
            ))}
        </nav>
        <p className="muted mobile-project-note">{t("nav.mobileOnly")}</p>
      </header>
      {children}
      {(issueKey || newIssue) && (
        <IssueDrawer issueKey={issueKey ?? undefined} onClose={closeDrawer} />
      )}
    </>
  );
}
