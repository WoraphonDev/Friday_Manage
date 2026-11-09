"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronRight, CircleHelp, KeyRound, LogOut, Menu, Search, ShieldAlert, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Staff } from "@/lib/types";
import { hasAny, initials, rolesOf } from "../access";
import { Modal, Popover, RoleChips } from "../kit";
import { NAV, type NavItem, type TaskKey } from "./nav";
import { useOverview } from "./Sidebar";

interface Hit {
  id: string;
  group: "workspaces" | "users" | "invoices" | "tickets" | "commands";
  title: string;
  sub?: string;
  href?: string;
  action?: () => void;
}

/** G1 · ค้นหาทั้งระบบ (Ctrl K) · ค้นเฉพาะส่วนที่บทบาทเห็นได้ · ไม่แสดงเนื้อหางานของลูกค้า */
export function SearchPalette({ staff, open, onOpenChange, onApprovals }: { staff: Staff; open: boolean; onOpenChange: (o: boolean) => void; onApprovals: () => void }) {
  const t = useTranslations("common");
  const router = useRouter();
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const query = useDeferredValue(q.trim());
  const enabled = open && query.length >= 2;
  const enc = encodeURIComponent(query);
  const ws = useQuery({ queryKey: ["ops", "search", "ws", query], queryFn: () => api.get<{ items: { id: string; name: string; slug: string; plan: string | null; subStatus: string | null }[] }>(`/workspaces?q=${enc}&limit=5`), enabled });
  const users = useQuery({ queryKey: ["ops", "search", "users", query], queryFn: () => api.get<{ items: { id: string; email: string; displayName: string; firstWorkspace: string | null }[] }>(`/users?q=${enc}&limit=5`), enabled: enabled && hasAny(staff, "owner", "support") });
  const invoices = useQuery({ queryKey: ["ops", "search", "inv", query], queryFn: () => api.get<{ items: { id: string; number: string; status: string; workspace: { name: string } }[] }>(`/invoices?q=${enc}&limit=5`), enabled: enabled && hasAny(staff, "owner", "finance", "auditor") });
  const tickets = useQuery({ queryKey: ["ops", "search", "tickets", query], queryFn: () => api.get<{ items: { id: string; number: number; subject: string; status: string }[] }>(`/tickets?q=${enc}&status=active&limit=5`), enabled: enabled && hasAny(staff, "owner", "support") });

  const commands: Hit[] = useMemo(() => {
    const list: Hit[] = [];
    if (hasAny(staff, "owner", "finance", "auditor")) list.push({ id: "c-exc", group: "commands", title: t("search.goExceptions"), href: "/payments" });
    if (hasAny(staff, "owner")) list.push({ id: "c-appr", group: "commands", title: t("search.goApprovals"), action: onApprovals });
    if (hasAny(staff, "owner", "support")) list.push({ id: "c-tic", group: "commands", title: t("search.goTickets"), href: "/support" });
    if (hasAny(staff, "owner", "auditor")) list.push({ id: "c-staff", group: "commands", title: t("search.goStaff"), href: "/staff" });
    return list.filter((c) => !query || c.title.toLowerCase().includes(query.toLowerCase()));
  }, [staff, t, query, onApprovals]);

  const hits: Hit[] = [
    ...(ws.data?.items ?? []).map((w) => ({ id: `w-${w.id}`, group: "workspaces" as const, title: w.name, sub: `${w.slug}${w.plan ? ` · ${w.plan}` : ""}`, href: `/workspaces/${w.id}` })),
    ...(users.data?.items ?? []).map((u) => ({ id: `u-${u.id}`, group: "users" as const, title: u.email, sub: u.firstWorkspace ?? u.displayName, href: `/users?id=${u.id}` })),
    ...(invoices.data?.items ?? []).map((i) => ({ id: `i-${i.id}`, group: "invoices" as const, title: i.number, sub: `${i.workspace.name} · ${i.status}`, href: `/billing?tab=invoices&q=${encodeURIComponent(i.number)}` })),
    ...(tickets.data?.items ?? []).map((k) => ({ id: `t-${k.id}`, group: "tickets" as const, title: `#${k.number} · ${k.subject}`, sub: k.status, href: `/support?ticket=${k.id}` })),
    ...commands,
  ];
  const loading = enabled && [ws, users, invoices, tickets].some((r) => r.isFetching);
  useEffect(() => setIndex(0), [query]);
  const go = (h: Hit) => {
    onOpenChange(false);
    setQ("");
    if (h.action) h.action();
    else if (h.href) router.push(h.href);
  };
  const groups = (["workspaces", "users", "invoices", "tickets", "commands"] as const).filter((g) => hits.some((h) => h.group === g));
  return (
    <Modal open={open} onOpenChange={(o) => (onOpenChange(o), !o && setQ(""))} title={t("search.title")} hideTitle className="palette">
      <div className="palette-input">
        <Search size={18} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls="ops-palette-results"
          aria-activedescendant={hits[index] ? `hit-${hits[index].id}` : undefined}
          aria-label={t("search.title")}
          placeholder={t("search.placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && hits[index]) {
              e.preventDefault();
              go(hits[index]);
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-results" id="ops-palette-results" role="listbox" aria-label={t("search.title")}>
        {query.length > 0 && query.length < 2 && <p className="muted small" style={{ padding: 10 }}>{t("search.minChars")}</p>}
        {loading && <p className="muted small" style={{ padding: 10 }}>{t("search.searching")}</p>}
        {enabled && !loading && hits.length === 0 && <p className="muted small" style={{ padding: 10 }}>{t("search.noResult", { q: query })}</p>}
        {groups.map((g) => (
          <div key={g} role="group" aria-label={t(`search.${g}`)}>
            <div className="menu-label">{t(`search.${g}`)}</div>
            {hits
              .filter((h) => h.group === g)
              .map((h) => (
                <div key={h.id} id={`hit-${h.id}`} role="option" aria-label={h.sub ? `${h.title}, ${h.sub}` : h.title} aria-selected={hits[index]?.id === h.id} className="menu-item" onMouseEnter={() => setIndex(hits.indexOf(h))} onClick={() => go(h)}>
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span>{h.title}</span>
                    {h.sub && <span className="muted small">{h.sub}</span>}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="palette-foot">
        {t("search.hint")} · {t("search.privacy")}
      </div>
    </Modal>
  );
}

/** G2 · แผงแจ้งเตือน: งานที่บทบาทของฉันต้องทำวันนี้ (จาก ops/overview › tasks) */
const NOTIFY: { task: TaskKey; key: string; tag: "tagApprove" | "tagMoney" | "tagSla" | "tagIncident" | "tagPrivacy"; roles: Parameters<typeof hasAny>[1][]; href?: string }[] = [
  { task: "approvals", key: "approvals", tag: "tagApprove", roles: ["owner"] },
  { task: "paymentExceptions", key: "exceptions", tag: "tagMoney", roles: ["owner", "finance"], href: "/payments" },
  { task: "slipsToReview", key: "slips", tag: "tagMoney", roles: ["owner", "finance"], href: "/payments" },
  { task: "invoicesOverdue", key: "overdue", tag: "tagMoney", roles: ["owner", "finance"], href: "/payments" },
  { task: "ticketsBreached", key: "ticketsBreached", tag: "tagSla", roles: ["owner", "support"], href: "/support" },
  { task: "ticketsUnassigned", key: "ticketsUnassigned", tag: "tagSla", roles: ["support"], href: "/support" },
  { task: "incidentsOpen", key: "incidents", tag: "tagIncident", roles: ["owner", "engineer", "support"], href: "/operations" },
  { task: "trialEndingSoon", key: "trialEnding", tag: "tagSla", roles: ["support"], href: "/workspaces?status=trialing" },
  { task: "privacyDueSoon", key: "privacy", tag: "tagPrivacy", roles: ["owner", "support"], href: "/privacy" },
  { task: "breachesOpen", key: "breaches", tag: "tagPrivacy", roles: ["owner", "engineer"], href: "/privacy" },
];

export function useNotifications(staff: Staff) {
  const overview = useOverview();
  return NOTIFY.filter((n) => hasAny(staff, ...n.roles) && (overview.data?.tasks[n.task] ?? 0) > 0).map((n) => ({ ...n, count: overview.data!.tasks[n.task] }));
}

export function Topbar({
  staff,
  current,
  onSearch,
  onApprovals,
  onAddKey,
  onBreakGlass,
  onSignOut,
  onMenu,
}: {
  staff: Staff;
  current: (NavItem & { group: string }) | null;
  onSearch: () => void;
  onApprovals: () => void;
  onAddKey: () => void;
  onBreakGlass: () => void;
  onSignOut: () => void;
  onMenu: () => void;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const notes = useNotifications(staff);
  const group = current ? NAV.find((g) => g.items.some((i) => i.key === current.key))?.group : "";
  return (
    <header className="ops-top">
      <button type="button" className="ops-icon-btn ops-menu-btn" aria-label={t("top.openMenu")} onClick={onMenu}>
        <Menu size={18} />
      </button>
      <nav aria-label="breadcrumb" className="ops-crumbs">
        <Link href="/">{t("top.crumbRoot")}</Link>
        {current && current.key !== "home" && (
          <>
            {group && (
              <>
                <ChevronRight size={14} aria-hidden="true" />
                <span className="muted">{t(`groups.${group}`)}</span>
              </>
            )}
            <ChevronRight size={14} aria-hidden="true" />
            <span aria-current="page">{t(`nav.${current.key}`)}</span>
          </>
        )}
      </nav>
      <button type="button" className="ops-search" aria-label={t("top.searchLabel")} onClick={onSearch}>
        <Search size={16} aria-hidden="true" />
        <span>{t("top.search")}</span>
        <kbd>{t("top.shortcut")}</kbd>
      </button>
      <div className="ops-tools">
        <a className="ops-icon-btn" href="https://fridaymanage.com/help/ops" target="_blank" rel="noreferrer" aria-label={t("top.help")}>
          <CircleHelp size={18} />
        </a>
        <Popover
          label={t("notify.title")}
          trigger={({ toggle }) => (
            <button type="button" className="ops-icon-btn" aria-label={t("top.notifications", { count: notes.length })} onClick={toggle}>
              <Bell size={18} />
              {notes.length > 0 && (
                <span className="ops-dot" aria-hidden="true">
                  {notes.length}
                </span>
              )}
            </button>
          )}
        >
          {(close) => (
            <div>
              <div className="menu-label">{t("notify.title")}</div>
              {!notes.length && <p className="muted small" style={{ padding: "6px 10px" }}>{t("notify.empty")}</p>}
              {notes.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close();
                    if (n.task === "approvals") onApprovals();
                    else if (n.href) router.push(n.href);
                  }}
                >
                  <span className={n.tag === "tagApprove" ? "pill inf" : n.tag === "tagIncident" ? "pill bad" : "pill warn"}>{t(`notify.${n.tag}`)}</span>
                  <span>{t(`notify.${n.key}` as "notify.approvals", { count: n.count })}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
        <Popover
          label={t("top.account", { name: staff.name })}
          trigger={({ toggle }) => (
            <button type="button" className="ops-icon-btn" style={{ width: "auto", padding: "0 6px" }} aria-label={t("top.account", { name: staff.name })} onClick={toggle}>
              <span className="avatar avatar-sm" aria-hidden="true">
                {initials(staff.name)}
              </span>
            </button>
          )}
        >
          {(close) => (
            <div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 10px 10px" }}>
                <span className="avatar" aria-hidden="true">
                  {initials(staff.name)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <b>{staff.name}</b>
                  <div className="muted small">{staff.email}</div>
                </div>
              </div>
              <div style={{ padding: "0 10px 8px" }}>
                <RoleChips roles={staff.roles ?? rolesOf(staff)} elevated={staff.elevated} />
              </div>
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => (close(), onAddKey())}>
                <KeyRound size={16} /> {t("account.keys")}
              </button>
              {hasAny(staff, "owner", "auditor") && (
                <Link className="menu-item" href={`/staff?tab=audit&staff=${staff.id}`} onClick={close}>
                  <UserRound size={16} /> {t("account.myLog")}
                </Link>
              )}
              {(staff.roles ?? rolesOf(staff)).includes("owner") && (
                <button type="button" className="menu-item" onClick={() => (close(), onBreakGlass())}>
                  <ShieldAlert size={16} /> {t("account.breakGlass")}
                </button>
              )}
              <div className="menu-sep" />
              <div className="menu-item" aria-disabled="true">
                {t("account.language")} <span className="muted small">· {t("account.english")}</span>
              </div>
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => (close(), onSignOut())}>
                <LogOut size={16} /> {t("account.signOut")}
              </button>
            </div>
          )}
        </Popover>
      </div>
    </header>
  );
}
