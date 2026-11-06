"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import {
  Check,
  ChevronDown,
  CircleCheck,
  FolderKanban,
  Home,
  Inbox,
  Menu,
  Search,
  Settings,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type {
  List,
  Me,
  NotificationSummary,
  Permissions,
  Project,
  Workspace,
} from "@/lib/types";
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  ErrorState,
  Forbidden,
  LoadingState,
  NotFound,
  YearFormatContext,
  useToast,
} from "@/components/ui";
import { Bell } from "@/features/bell/Bell";
import { CommandPalette } from "@/features/command-palette/CommandPalette";

interface ShellContext {
  me: Me;
  workspace: Workspace;
  projects: Project[];
}
const Context = createContext<ShellContext | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("WorkspaceShell is required");
  return value;
}

function Navigation({
  workspace,
  projects,
  unread,
  close,
}: {
  workspace: Workspace;
  projects: Project[];
  unread: number;
  close?: () => void;
}) {
  const t = useTranslations("common.nav");
  const pathname = usePathname();
  const base = `/w/${encodeURIComponent(workspace.slug)}`;
  return (
    <nav aria-label={t("workspaceNav")}>
      <Link
        className="nav-link"
        href={base}
        aria-current={pathname === base ? "page" : undefined}
        onClick={close}
      >
        <Home size={18} />
        {t("home")}
      </Link>
      <Link
        className="nav-link"
        href={`${base}/my-tasks`}
        aria-current={pathname === `${base}/my-tasks` ? "page" : undefined}
        onClick={close}
      >
        <CircleCheck size={18} />
        {t("myTasks")}
      </Link>
      <Link
        className="nav-link"
        href={`${base}/inbox`}
        aria-current={pathname === `${base}/inbox` ? "page" : undefined}
        onClick={close}
      >
        <Inbox size={18} />
        {t("inbox")}
        {unread > 0 && <Badge tone="red">{unread}</Badge>}
      </Link>
      <div className="nav-section">{t("projects")}</div>
      {projects.length ? (
        projects.map((project) => (
          <Link
            className="nav-link"
            key={project.id}
            href={`${base}/p/${encodeURIComponent(project.key)}`}
            aria-current={
              pathname.startsWith(`${base}/p/${project.key}/`) ||
              pathname === `${base}/p/${project.key}`
                ? "page"
                : undefined
            }
            onClick={close}
          >
            <span
              className="project-dot"
              style={{ background: project.color ?? "#334155" }}
            />
            <span className="project-name">{project.name}</span>
          </Link>
        ))
      ) : (
        <span className="muted menu-label">{t("noProjects")}</span>
      )}
      {workspace.role !== "guest" && (
        <Link className="nav-link" href={`${base}/new-project`} onClick={close}>
          {t("newProject")}
        </Link>
      )}
      {workspace.role !== "guest" && (
        <Link className="nav-link" href={`${base}/import`} onClick={close}>
          {t("import")}
        </Link>
      )}
      {["owner", "admin"].includes(workspace.role) && (
        <>
          <div className="nav-section">{t("admin")}</div>
          <Link className="nav-link" href={`${base}/admin`} onClick={close}>
            <Settings size={18} />
            {t("admin")}
          </Link>
        </>
      )}
    </nav>
  );
}

export function WorkspaceShell({
  ws,
  children,
}: {
  ws: string;
  children: ReactNode;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const cache = useQueryClient();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<Me>("/me"),
  });
  const workspaces = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.get<List<Workspace>>("/me/workspaces"),
    enabled: !!me.data,
  });
  const workspace = workspaces.data?.items.find((item) => item.slug === ws);
  const projects = useQuery({
    queryKey: queryKeys.projects(ws),
    queryFn: () =>
      api.get<List<Project>>(`/w/${encodeURIComponent(ws)}/projects`),
    enabled: !!workspace,
  });
  const summary = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api.get<NotificationSummary>("/me/notifications/summary"),
    enabled: !!me.data,
  });
  const selectedKey = pathname.match(/\/p\/([^/]+)/)?.[1];
  const permissions = useQuery({
    queryKey: queryKeys.permissions(ws, selectedKey ?? ""),
    queryFn: () =>
      api.get<Permissions>(
        `/w/${encodeURIComponent(ws)}/projects/${selectedKey}/my-permissions`,
      ),
    enabled: !!workspace && !!selectedKey,
  });
  const unread =
    summary.data?.workspaces.find((item) => item.slug === ws)?.unread ?? 0;
  const canCreate =
    !!selectedKey && permissions.data?.permissions.includes("issue.create");
  useEffect(() => {
    setMenuOpen(false);
    setCommandOpen(false);
    setSwitchOpen(false);
  }, [pathname]);
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      const index = Number(event.key) - 1;
      if (/^[1-9]$/.test(event.key) && workspaces.data?.items[index]) {
        event.preventDefault();
        router.push(`/w/${workspaces.data.items[index].slug}`);
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [router, workspaces.data]);
  if (me.isPending || (me.data && workspaces.isPending))
    return <LoadingState />;
  if (me.error || workspaces.error)
    return (
      <ErrorState
        error={me.error ?? workspaces.error}
        retry={() => {
          void me.refetch();
          void workspaces.refetch();
        }}
      />
    );
  if (!workspace) return <NotFound />;
  if (workspace.status === "suspended" || workspace.status === "pending_delete")
    return <Forbidden />;
  if (!me.data) return <LoadingState />;
  const base = `/w/${encodeURIComponent(ws)}`;
  async function logout() {
    await api.post("/auth/logout");
    cache.clear();
    router.replace("/login");
  }
  return (
    <Context.Provider
      value={{ me: me.data, workspace, projects: projects.data?.items ?? [] }}
    >
      <YearFormatContext.Provider value={me.data.yearFormat}>
        <a className="skip-link" href="#main-content">
          {t("app.skip")}
        </a>
        <header className="topbar">
          <Button
            className="mobile-menu"
            variant="ghost"
            size="icon"
            aria-label={t("app.menu")}
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={20} />
          </Button>
          <Popover.Root open={switchOpen} onOpenChange={setSwitchOpen}>
            <Popover.Trigger asChild>
              <button
                className="workspace-switch"
                aria-label={`${t("nav.switchWorkspace")}: ${workspace.name}`}
              >
                <span className="workspace-logo">
                  {workspace.name.slice(0, 1)}
                </span>
                <span>{workspace.name}</span>
                <ChevronDown size={14} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="popover workspace-menu"
                sideOffset={8}
                align="start"
              >
                <div className="menu-label">
                  {t("nav.yourWorkspaces")} · {me.data.email}
                </div>
                <nav aria-label={t("nav.switchWorkspace")}>
                  {workspaces.data?.items.map((item) => (
                    <Link
                      className="workspace-item"
                      key={item.id}
                      href={`/w/${encodeURIComponent(item.slug)}`}
                      aria-current={item.slug === ws ? "true" : undefined}
                      onClick={() => setSwitchOpen(false)}
                    >
                      <span className="workspace-logo">
                        {item.name.slice(0, 1)}
                      </span>
                      <span className="workspace-item-text">
                        <strong>{item.name}</strong>
                        <small>{t(`roles.${item.role}`)}</small>
                      </span>
                      {(summary.data?.workspaces.find(
                        (count) => count.slug === item.slug,
                      )?.unread ?? 0) > 0 && (
                        <Badge tone="red">
                          {
                            summary.data?.workspaces.find(
                              (count) => count.slug === item.slug,
                            )?.unread
                          }
                        </Badge>
                      )}
                      {item.slug === ws && <Check size={16} />}
                    </Link>
                  ))}
                </nav>
                <div className="menu-divider" />
                <Link
                  className="workspace-item"
                  href="/onboarding"
                  onClick={() => setSwitchOpen(false)}
                >
                  {t("nav.createWorkspace")}
                </Link>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void logout().catch((error: unknown) => toast({ message: error instanceof Error ? error.message : t("app.unknownError") }));
                  }}
                >
                  {t("app.signOut")}
                </Button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button
            className="search-trigger"
            aria-label={t("nav.search")}
            onClick={() => setCommandOpen(true)}
          >
            <Search size={16} />
            <span>{t("nav.search")}</span>
            <kbd>Ctrl K</kbd>
          </button>
          <span className="topbar-spacer" />
          {canCreate && (
            <Link
              className="button button-primary topbar-new"
              href={`${base}/p/${selectedKey}?new=1`}
            >
              {t("nav.new")}
            </Link>
          )}
          <Bell workspace={ws} unread={summary.data?.total ?? 0} />
          <Link href={`${base}/profile`} aria-label={t("nav.profile")}>
            <Avatar person={me.data} />
          </Link>
        </header>
        <div className="workspace-body">
          <aside className="sidebar">
            <Navigation
              workspace={workspace}
              projects={projects.data?.items ?? []}
              unread={unread}
            />
            {projects.isPending && <LoadingState />}
            {projects.error && (
              <ErrorState
                error={projects.error}
                retry={() => void projects.refetch()}
              />
            )}
          </aside>
          <main className="workspace-main" id="main-content">
            {children}
          </main>
        </div>
        <nav className="mobile-bottom-nav" aria-label={t("nav.workspaceNav")}>
          {[
            { suffix: "", icon: Home, key: "home" },
            { suffix: "/my-tasks", icon: CircleCheck, key: "myTasks" },
            { suffix: "/inbox", icon: Inbox, key: "inbox" },
          ].map(({ suffix, icon: Icon, key }) => (
            <Link
              key={key}
              className="nav-link"
              href={`${base}${suffix}`}
              aria-current={
                pathname === `${base}${suffix}` ? "page" : undefined
              }
            >
              <Icon size={20} />
              {t(`nav.${key}`)}
            </Link>
          ))}
          <button type="button" className="nav-link" onClick={() => setMenuOpen(true)}>
            <FolderKanban size={20} />{t("nav.projects")}
          </button>
        </nav>
        <Drawer
          open={menuOpen}
          onOpenChange={setMenuOpen}
          title={workspace.name}
        >
          <Navigation
            workspace={workspace}
            projects={projects.data?.items ?? []}
            unread={unread}
            close={() => setMenuOpen(false)}
          />
        </Drawer>
        <CommandPalette
          workspace={ws}
          open={commandOpen}
          onOpenChange={setCommandOpen}
        />
      </YearFormatContext.Provider>
    </Context.Provider>
  );
}
