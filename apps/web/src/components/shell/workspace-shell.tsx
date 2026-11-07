"use client";

import {
  createContext,
  useContext,
  useEffect,
  Suspense,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import {
  Bell as BellIcon,
  Check,
  ChevronDown,
  CircleCheck,
  Clock,
  FileSpreadsheet,
  FolderKanban,
  Home,
  Inbox,
  CreditCard,
  Lock,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  User,
  Users,
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
import { LocaleSwitch, LocaleSync } from "@/features/locale-switch";
import { WorkspaceBanners } from "@/features/plan-limits";

interface ShellContext {
  me: Me;
  workspace: Workspace;
  projects: Project[];
  /** เปิด Command palette (หัวหน้ามือถือ M2/M5 มีปุ่มค้นหาของตัวเอง) */
  openSearch?: () => void;
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
        <Link
          className="nav-link"
          href={`${base}/new-project`}
          aria-current={pathname === `${base}/new-project` ? "page" : undefined}
          onClick={close}
        >
          {t("newProject")}
        </Link>
      )}
      {workspace.role !== "guest" && (
        <Link className="nav-link" href={`${base}/import`} onClick={close}>
          {t("import")}
        </Link>
      )}
      {["owner", "admin"].includes(workspace.role) && (
        // Canvas วาง Admin Console ไว้ล่างสุดของ Sidebar คั่นด้วยเส้น
        <div className="nav-footer">
          <Link className="nav-link" href={`${base}/admin`} onClick={close}>
            <Settings size={18} />
            {t("admin")}
          </Link>
          <Link className="nav-link" href={`${base}/billing`} onClick={close}>
            <CreditCard size={18} />
            {t("billing")}
          </Link>
        </div>
      )}
    </nav>
  );
}

/**
 * กรอบหน้าตามบริบทของ Canvas
 * - workspace: top bar + Sidebar (ทุกหน้าทั่วไป)
 *   Canvas O1 Lead, O2 Reports, P2 Automation, P1 Search, L1 Import ไม่มี Sidebar
 *   แต่ผู้ใช้เลือกให้แสดงตลอดเพื่อไม่ให้เมนูหายระหว่างสลับแท็บ (2026-11-07)
 * - admin: top bar ของ Admin Console + เมนูของหน้าเอง (N1, N2)
 * - checkout: หัวขาวเรียบ ไม่มีเมนู (R2)
 */
export type ShellChrome = "workspace" | "admin" | "checkout";
export function shellChrome(pathname: string): ShellChrome {
  const rest = pathname.replace(/^\/w\/[^/]+/, "");
  if (/^\/billing\/checkout(\/|$)/.test(rest)) return "checkout";
  if (/^\/admin(\/|$)/.test(rest)) return "admin";
  return "workspace";
}

/** ช่องค้นหาบนแถบบนของหน้าผลการค้นหา (Canvas P1): Enter = ค้นใหม่โดยคงตัวกรองอื่นไว้ */
function TopbarSearchInput({ base, label }: { base: string; label: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  return (
    <form
      className="search-trigger"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const next = new URLSearchParams(params.toString());
        if (draft.trim()) next.set("q", draft.trim());
        else next.delete("q");
        router.replace(`${base}/search?${next}`, { scroll: false });
      }}
    >
      <Search size={16} />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <kbd>Ctrl K</kbd>
    </form>
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
  const [wsQuery, setWsQuery] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
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
  const chrome = shellChrome(pathname);
  // O1/O2: หน้า Lead / Reports ไม่มีช่องค้นหาและ + New บนแถบบน
  const searchTrigger = (
    <button
      className="search-trigger"
      aria-label={t("nav.search")}
      onClick={() => setCommandOpen(true)}
    >
      <Search size={16} />
      <span>{t("nav.search")}</span>
      <kbd>Ctrl K</kbd>
    </button>
  );
  const unreadOf = (slug: string) =>
    summary.data?.workspaces.find((count) => count.slug === slug)?.unread ?? 0;
  const workspaceList = (close: () => void) => (
    <nav aria-label={t("nav.switchWorkspace")}>
      {workspaces.data?.items.map((item) => (
        <Link
          className="workspace-item"
          key={item.id}
          href={`/w/${encodeURIComponent(item.slug)}`}
          aria-current={item.slug === ws ? "true" : undefined}
          onClick={close}
        >
          <span className="workspace-logo">{item.name.slice(0, 1)}</span>
          <span className="workspace-item-text">
            <strong>{item.name}</strong>
            <small>{t(`roles.${item.role}`)}</small>
          </span>
          {unreadOf(item.slug) > 0 && (
            <Badge tone="red">{unreadOf(item.slug)}</Badge>
          )}
          {item.slug === ws && <Check size={16} />}
        </Link>
      ))}
    </nav>
  );
  const signOut = (
    <Button
      variant="ghost"
      onClick={() => {
        void logout().catch((error: unknown) =>
          toast({
            message:
              error instanceof Error ? error.message : t("app.unknownError"),
          }),
        );
      }}
    >
      {t("app.signOut")}
    </Button>
  );
  const isWsAdmin = ["owner", "admin"].includes(workspace.role);
  const closeSwitch = () => { setSwitchOpen(false); setWsQuery(""); };
  const wsFilter = wsQuery.trim().toLowerCase();
  const matching = (workspaces.data?.items ?? []).filter((item) => !wsFilter || item.name.toLowerCase().includes(wsFilter) || item.slug.toLowerCase().includes(wsFilter));
  // แบบเมนู Workspace ของ monday: ค้นหา · รายการ · สร้าง / ตั้งค่า (ภาษา ปี และออกจากระบบอยู่ในเมนูบัญชีที่ avatar)
  const switcher = (
    <Popover.Root open={switchOpen} onOpenChange={(open) => (open ? setSwitchOpen(true) : closeSwitch())}>
      <Popover.Trigger asChild>
        <button
          className="workspace-switch"
          aria-label={`${t("nav.switchWorkspace")}: ${workspace.name}`}
        >
          <span className="workspace-logo">{workspace.name.slice(0, 1)}</span>
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
          {(workspaces.data?.items.length ?? 0) > 4 && (
            <label className="menu-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                autoFocus
                placeholder={t("nav.searchWorkspace")}
                aria-label={t("nav.searchWorkspace")}
                value={wsQuery}
                onChange={(event) => setWsQuery(event.target.value)}
              />
            </label>
          )}
          <div className="menu-label">{t("nav.yourWorkspaces")}</div>
          <nav aria-label={t("nav.switchWorkspace")}>
            {matching.map((item) => (
              <Link
                className="workspace-item"
                key={item.id}
                href={`/w/${encodeURIComponent(item.slug)}`}
                aria-current={item.slug === ws ? "true" : undefined}
                onClick={closeSwitch}
              >
                <span className="workspace-logo">{item.name.slice(0, 1)}</span>
                <span className="workspace-item-text">
                  <strong>{item.name}</strong>
                  <small>{t(`roles.${item.role}`)}</small>
                </span>
                {unreadOf(item.slug) > 0 && <Badge tone="red">{unreadOf(item.slug)}</Badge>}
                {item.slug === ws && <Check size={16} />}
              </Link>
            ))}
            {!matching.length && <p className="menu-empty">{t("nav.noWorkspaceMatch")}</p>}
          </nav>
          <div className="menu-divider" />
          <Link className="menu-item menu-icon-item" href="/onboarding" onClick={closeSwitch}>
            <Plus size={16} aria-hidden="true" />
            {t("nav.addWorkspace")}
          </Link>
          {isWsAdmin && (
            <Link className="menu-item menu-icon-item" href={`${base}/admin`} onClick={closeSwitch}>
              <Settings size={16} aria-hidden="true" />
              {t("nav.workspaceSettings", { name: workspace.name })}
            </Link>
          )}
          <p className="menu-hint">{t("nav.switchHint")}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  // เมนูบัญชีที่ avatar แบบ monday: บัญชี | Workspace · ภาษา / ปี · ออกจากระบบ
  const accountLinks = [
    { href: `${base}/profile`, icon: User, label: t("nav.myProfile") },
    { href: `${base}/profile?tab=notify`, icon: BellIcon, label: t("nav.notifySettings") },
    { href: `${base}/profile?tab=hours`, icon: Clock, label: t("nav.workHours") },
    { href: `${base}/profile?tab=sec`, icon: ShieldCheck, label: t("nav.securitySettings") },
  ];
  const workspaceLinks = [
    ...(workspace.role !== "guest" ? [{ href: `${base}/members`, icon: Users, label: t("nav.membersInvite") }] : []),
    ...(workspace.role !== "guest" ? [{ href: `${base}/import`, icon: FileSpreadsheet, label: t("nav.importPlan") }] : []),
    ...(isWsAdmin ? [{ href: `${base}/admin`, icon: Settings, label: t("nav.admin") }, { href: `${base}/billing`, icon: CreditCard, label: t("nav.billing") }] : []),
  ];
  const accountMenu = (
    <Popover.Root open={accountOpen} onOpenChange={setAccountOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="account-trigger" aria-label={t("nav.accountMenu")}>
          <Avatar person={me.data} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover account-menu" sideOffset={8} align="end" aria-label={t("nav.accountMenu")}>
          <div className="account-head">
            <Avatar person={me.data} />
            <span className="account-who">
              <strong>{me.data.displayName}</strong>
              <small>{me.data.email}</small>
            </span>
          </div>
          <div className="account-cols">
            <nav aria-label={t("nav.accountSection")}>
              <div className="menu-label">{t("nav.accountSection")}</div>
              {accountLinks.map(({ href, icon: Icon, label }) => (
                <Popover.Close asChild key={href}>
                  <Link className="menu-item menu-icon-item" href={href}><Icon size={16} aria-hidden="true" />{label}</Link>
                </Popover.Close>
              ))}
            </nav>
            {workspaceLinks.length > 0 && (
              <nav aria-label={workspace.name}>
                <div className="menu-label">{workspace.name}</div>
                {workspaceLinks.map(({ href, icon: Icon, label }) => (
                  <Popover.Close asChild key={href}>
                    <Link className="menu-item menu-icon-item" href={href}><Icon size={16} aria-hidden="true" />{label}</Link>
                  </Popover.Close>
                ))}
              </nav>
            )}
          </div>
          <div className="account-foot">
            <LocaleSwitch signedIn showYearFormat onChange={() => setAccountOpen(false)} />
            <button
              type="button"
              className="menu-item menu-icon-item account-logout"
              onClick={() => {
                void logout().catch((error: unknown) =>
                  toast({ message: error instanceof Error ? error.message : t("app.unknownError") }),
                );
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              {t("app.signOut")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  return (
    <Context.Provider
      value={{
        me: me.data,
        workspace,
        projects: projects.data?.items ?? [],
        openSearch: () => setCommandOpen(true),
      }}
    >
      <YearFormatContext.Provider value={me.data.yearFormat}>
        {/* cookie ภาษาให้ตรงกับที่บันทึกในบัญชี (เข้าจากเครื่องใหม่ก็ได้ภาษาเดิม) */}
        <LocaleSync me={me.data} />
        <a className="skip-link" href="#main-content">
          {t("app.skip")}
        </a>
        {chrome === "checkout" ? (
          <header className="checkout-header">
            <div className="checkout-header-inner">
              <Link className="checkout-brand" href={base}>
                <span className="workspace-logo">F</span>
                Friday Manage
              </Link>
              <span className="muted">
                {t("nav.checkoutTitle", { name: workspace.name })}
              </span>
              <span className="topbar-spacer" />
              <span className="muted checkout-secure">
                <Lock size={14} aria-hidden="true" />
                {t("nav.secure")}
              </span>
            </div>
          </header>
        ) : chrome === "admin" ? (
          <header className="topbar">
            {switcher}
            <Badge className="admin-pill">{t("nav.admin")}</Badge>
            <span className="topbar-spacer" />
            <Link className="topbar-back" href={base}>
              {t("nav.backToWorkspace")}
            </Link>
            {accountMenu}
          </header>
        ) : (
          // มือถือใช้หัวขาวของแต่ละหน้า + เมนูล่าง ตาม Canvas M2–M7 จึงซ่อน top bar
          <header className="topbar topbar-desktop">
            <Button
              className="mobile-menu"
              variant="ghost"
              size="icon"
              aria-label={t("app.menu")}
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={20} />
            </Button>
            {/* ตัวสลับ Workspace ย้ายลงหัว Sidebar (ผู้ใช้ขอ 2026-11-07) · แถบบนเหลือชื่อระบบกลับ Home */}
            <Link className="topbar-brand" href={base}>
              <span className="brand-mark" aria-hidden="true">F</span>
              <span>Friday Manage</span>
            </Link>
            {pathname === `${base}/search` ? (
              <Suspense fallback={searchTrigger}>
                <TopbarSearchInput base={base} label={t("nav.search")} />
              </Suspense>
            ) : (
              searchTrigger
            )}
            <span className="topbar-spacer" />
            {/* Canvas: + New อยู่บนแถบบนทุกหน้า · นอกโปรเจกต์สร้างในโปรเจกต์แรกที่เข้าถึงได้ */}
            {(canCreate || (!selectedKey && workspace.role !== "guest" && !!projects.data?.items.length)) && (
              <Link
                className="button button-primary topbar-new"
                href={`${base}/p/${encodeURIComponent(selectedKey ?? projects.data!.items[0].key)}?new=1`}
              >
                {t("nav.new")}
              </Link>
            )}
            <Bell workspace={ws} unread={summary.data?.total ?? 0} />
            {accountMenu}
          </header>
        )}
        <div className={`workspace-body chrome-${chrome}`}>
          {chrome === "workspace" && (
            <aside className="sidebar">
              <div className="sidebar-workspace">
                <div className="menu-label">Workspace</div>
                {switcher}
              </div>
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
          )}
          <main className="workspace-main" id="main-content">
            {chrome !== "checkout" && (
              <WorkspaceBanners ws={ws} role={workspace.role} />
            )}
            {children}
          </main>
        </div>
        {chrome !== "checkout" && chrome !== "admin" && (
          <nav className="mobile-bottom-nav" aria-label={t("nav.mainMenu")}>
            {[
              { suffix: "", icon: Home, key: "home" },
              { suffix: "/my-tasks", icon: CircleCheck, key: "myTasks" },
            ].map(({ suffix, icon: Icon, key }) => (
              <Link
                key={key}
                className="nav-link"
                href={`${base}${suffix}`}
                aria-current={
                  pathname === `${base}${suffix}` ? "page" : undefined
                }
              >
                <Icon size={22} />
                {t(`nav.${key}`)}
              </Link>
            ))}
            <button
              type="button"
              className="nav-link"
              aria-current={selectedKey ? "page" : undefined}
              onClick={() => setMenuOpen(true)}
            >
              <FolderKanban size={22} />
              {t("nav.projects")}
            </button>
            <Link
              className="nav-link"
              href={`${base}/inbox`}
              aria-current={pathname === `${base}/inbox` ? "page" : undefined}
            >
              <Inbox size={22} />
              {t("nav.inbox")}
              {unread > 0 && <span className="bottom-nav-count">{unread}</span>}
            </Link>
            <Link
              className="nav-link"
              href={`${base}/profile`}
              aria-current={
                pathname.startsWith(`${base}/profile`) ? "page" : undefined
              }
            >
              <Avatar person={me.data} size="small" />
              {t("nav.profileTab")}
            </Link>
          </nav>
        )}
        <Drawer
          open={menuOpen}
          onOpenChange={setMenuOpen}
          title={workspace.name}
        >
          {/* มือถือไม่มี top bar: ค้นหา, สลับ Workspace, ภาษา และออกจากระบบอยู่ในเมนูนี้ */}
          <button
            type="button"
            className="search-trigger drawer-search"
            aria-label={t("nav.search")}
            onClick={() => {
              setMenuOpen(false);
              setCommandOpen(true);
            }}
          >
            <Search size={16} />
            <span>{t("nav.search")}</span>
          </button>
          <Navigation
            workspace={workspace}
            projects={projects.data?.items ?? []}
            unread={unread}
            close={() => setMenuOpen(false)}
          />
          <div className="menu-divider" />
          <div className="menu-label">{t("nav.yourWorkspaces")}</div>
          {workspaceList(() => setMenuOpen(false))}
          <Link
            className="workspace-item"
            href="/onboarding"
            onClick={() => setMenuOpen(false)}
          >
            {t("nav.createWorkspace")}
          </Link>
          <div className="menu-divider" />
          <LocaleSwitch
            signedIn
            showYearFormat
            onChange={() => setMenuOpen(false)}
          />
          {signOut}
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
