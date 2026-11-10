"use client";

import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { MoreHorizontal } from "lucide-react";
import { Avatar, Badge, Button, ErrorState, EmptyState, Forbidden, LoadingState, Select, type Tone, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";
import { copyText } from "../../p/[key]/members/_components/shared";
import type { Invitation, ProjectMembers, WorkspaceMember } from "../../p/[key]/members/_components/types";
import styles from "../../p/[key]/members/_components/members.module.css";
import { InviteDialog } from "./invite-dialog";
import { ManageDialog } from "./manage-dialog";
import local from "./ws.module.css";

type WsRole = WorkspaceMember["role"];
type Tab = "all" | "active" | "invited" | "off";
type Row =
  | { kind: "member"; id: string; member: WorkspaceMember; status: "active" | "off" }
  | { kind: "invite"; id: string; invite: Invitation; status: "invited" };

const STATUS_TONE: Record<Row["status"], Tone> = { active: "green", invited: "amber", off: "neutral" };
const TABS: Tab[] = ["all", "active", "invited", "off"];
const TAB_LABEL = { all: "tabAll", active: "tabActive", invited: "tabInvited", off: "tabOff" } as const;
const STATUS_LABEL = { active: "statusActive", invited: "statusInvited", off: "statusOff" } as const;

/** หน้า H · สมาชิก Workspace */
export function WorkspaceMembers({ ws }: { ws: string }) {
  const t = useTranslations("members-workload.ws");
  const ti = useTranslations("members-workload.invites");
  const tr = useTranslations("members-workload.roles");
  const format = useFormatter();
  const { me, workspace, projects } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}`;
  const isGuest = workspace.role === "guest";
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [inviting, setInviting] = useState(false);
  const [managing, setManaging] = useState<WorkspaceMember | null>(null);

  // Guest ไม่เห็นรายชื่อคนในองค์กร (04-permissions ข้อ 4) จึงไม่เรียก API เลย
  const members = useQuery({ queryKey: ["workspace-members", ws], queryFn: () => api.get<{ items: WorkspaceMember[] }>(`${base}/members`), enabled: !isGuest });
  const invitations = useQuery({ queryKey: ["invitations", ws], queryFn: () => api.get<{ items: Invitation[] }>(`${base}/invitations`), enabled: isAdmin });
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<{ seats: { used: number; limit: number | null } }>(`${base}/usage`), enabled: !isGuest, retry: false });
  // API สมาชิก Workspace ยังไม่บอกโปรเจกต์ของแต่ละคน จึงรวมจากสมาชิกของแต่ละโปรเจกต์ที่เห็น (โหลดไม่ได้ = ข้าม)
  const projectMembers = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["project-members", ws, p.key],
      queryFn: () => api.get<ProjectMembers>(`${base}/projects/${encodeURIComponent(p.key)}/members`),
      enabled: !isGuest,
      retry: false,
    })),
  });

  if (isGuest) return <div className={styles.page}><Forbidden /></div>;
  if (members.isPending) return <div className={styles.page}><LoadingState /></div>;
  if (members.error)
    return <div className={styles.page}>{members.error instanceof ApiError && members.error.status === 403 ? <Forbidden /> : <ErrorState error={members.error} retry={() => members.refetch()} />}</div>;

  const projectsOf = new Map<string, Project[]>();
  projectMembers.forEach((q, i) => q.data?.items.forEach((m) => projectsOf.set(m.userId, [...(projectsOf.get(m.userId) ?? []), projects[i]])));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const all: Row[] = [
    ...members.data.items.map((m): Row => ({ kind: "member", id: m.userId, member: m, status: m.status === "active" ? "active" : "off" })),
    ...(invitations.data?.items ?? []).map((inv): Row => ({ kind: "invite", id: inv.id, invite: inv, status: "invited" })),
  ];
  const count = (s: Tab) => (s === "all" ? all.length : all.filter((r) => r.status === s).length);
  const q = query.trim().toLowerCase();
  const rows = all.filter((r) => {
    if (tab !== "all" && r.status !== tab) return false;
    if (roleFilter && (r.kind === "member" ? r.member.role : r.invite.workspaceRole) !== roleFilter) return false;
    if (projectFilter) {
      const keys = r.kind === "member" ? (projectsOf.get(r.id) ?? []).map((p) => p.key) : [projectById.get(r.invite.projectId ?? "")?.key];
      if (!keys.includes(projectFilter)) return false;
    }
    return !q || (r.kind === "member" ? `${r.member.displayName} ${r.member.email}` : r.invite.email).toLowerCase().includes(q);
  });
  const seats = usage.data?.seats;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["workspace-members", ws] });
    await cache.invalidateQueries({ queryKey: ["invitations", ws] });
    await cache.invalidateQueries({ queryKey: ["usage", ws] });
  };
  const fail = (e: unknown) => toast({ message: e instanceof Error ? e.message : String(e) });

  async function changeRole(m: WorkspaceMember, role: WsRole) {
    try {
      // สมาชิก Workspace ไม่มี version จึงไม่ส่ง If-Match
      await api.request(`${base}/members/${m.userId}`, { method: "PATCH", body: { role } });
      toast({ message: t("roleChanged", { name: m.displayName, role: tr(role) }) });
    } catch (e) {
      fail(e);
    }
    await refresh();
  }
  async function inviteAction(inv: Invitation, action: "resend" | "revoke") {
    try {
      const r = await api.post<{ inviteUrl?: string; emailSent?: boolean }>(`${base}/invitations/${inv.id}/${action}`);
      // ส่งอีเมลไม่ได้ (ยังไม่ตั้ง SMTP / ส่งไม่ผ่าน) จึงคัดลอกลิงก์ใหม่ให้ส่งต่อเอง
      const copy = action === "resend" && !r.emailSent && r.inviteUrl;
      if (copy) await copyText(r.inviteUrl!).catch(() => undefined);
      toast({ message: action === "resend" ? (copy ? `${ti("resent", { email: inv.email })} · ${ti("copied")}` : ti("resentEmailed", { email: inv.email })) : ti("revoked", { email: inv.email }) });
    } catch (e) {
      fail(e);
    }
    await refresh();
  }
  // Admin ตั้ง/แก้ Owner ไม่ได้ (A14) · Owner เท่านั้นที่เห็นตัวเลือก Owner
  const roleOptions: WsRole[] = workspace.role === "owner" ? ["owner", "admin", "member", "guest"] : ["admin", "member", "guest"];
  const canEditRole = (m: WorkspaceMember) => isAdmin && m.userId !== me.id && m.status === "active" && (workspace.role === "owner" || m.role !== "owner");

  return (
    <div className={styles.page}>
      <header className={local.head}>
        <div>
          <div className={cn(styles.muted, styles.small)}>{t("breadcrumb", { workspace: workspace.name })}</div>
          <h1>{t("title")}</h1>
          <div className={styles.muted}>{t("description")}</div>
        </div>
        {isAdmin && <Button variant="primary" onClick={() => setInviting(true)}>{t("invite")}</Button>}
      </header>

      <div className={styles.kpis}>
        <div className={styles.kp}><span className={styles.muted}>{t("active")}</span><span className={styles.v}>{count("active")}</span></div>
        {isAdmin && <div className={styles.kp}><span className={styles.muted}>{t("pending")}</span><span className={styles.v}>{count("invited")}</span></div>}
        <div className={styles.kp}><span className={styles.muted}>{t("deactivated")}</span><span className={cn(styles.v, styles.muted)}>{count("off")}</span></div>
        {seats && (
          <div className={styles.kp}>
            <span className={styles.muted}>{t("seats")}</span>
            <span className={styles.v}>{seats.limit === null ? seats.used : t("seatsValue", { used: seats.used, limit: seats.limit })}</span>
            {seats.limit !== null && <span className={local.seat}><span style={{ width: `${Math.min(100, (seats.used / seats.limit) * 100)}%` }} /></span>}
          </div>
        )}
      </div>

      <div className={styles.bar}>
        <div className={styles.group} role="group" aria-label={t("tabsLabel")}>
          {TABS.filter((s) => s !== "invited" || isAdmin).map((s) => (
            <button key={s} type="button" className={local.chip} aria-pressed={tab === s} onClick={() => setTab(s)}>
              {t(TAB_LABEL[s])} <span>{count(s)}</span>
            </button>
          ))}
        </div>
        <div className={styles.group}>
          <input className="input" type="search" placeholder={t("search")} aria-label={t("searchLabel")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select size="small" aria-label={t("roleFilter")} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">{t("allRoles")}</option>
            {(["owner", "admin", "member", "guest"] as const).map((r) => <option key={r} value={r}>{tr(r)}</option>)}
          </Select>
          <Select size="small" aria-label={t("projectFilter")} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">{t("allProjects")}</option>
            {projects.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </Select>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.scroll}>
          <div className={cn(local.mr, local.h)}>
            <div>{t("colMember")}</div><div>{t("colPosition")}</div><div>{t("colRole")}</div><div>{t("colProjects")}</div><div>{t("colLast")}</div><div>{t("colStatus")}</div><div />
          </div>
          {!rows.length && <EmptyState title={t("empty")} description="" />}
          {rows.map((r) => {
            if (r.kind === "invite") {
              const inv = r.invite;
              const p = projectById.get(inv.projectId ?? "");
              return (
                <div className={local.mr} key={r.id} data-testid={`row-${r.id}`}>
                  <div className={styles.person}>
                    <Avatar person={{ id: inv.id, displayName: inv.email }} />
                    <div><div className={styles.name}>{inv.email}</div><div className={cn(styles.muted, styles.small)}>{t("invitedBy", { date: formatDate(inv.createdAt, me.yearFormat) })}</div></div>
                  </div>
                  <div className={styles.muted}>—</div>
                  <div>{tr(inv.workspaceRole)}</div>
                  <div>{p ? <Badge>{p.name}</Badge> : <span className={styles.muted}>{t("noProjects")}</span>}</div>
                  <div className={styles.muted}>{t("never")}</div>
                  <div><Badge tone={STATUS_TONE.invited}>{t(STATUS_LABEL.invited)}</Badge></div>
                  <div className={local.inline}>
                    <Button size="small" onClick={() => void inviteAction(inv, "resend")}>{ti("resend")}</Button>
                    <Button size="small" variant="ghost" onClick={() => void inviteAction(inv, "revoke")}>{ti("cancel")}</Button>
                  </div>
                </div>
              );
            }
            const m = r.member;
            const mine = projectsOf.get(m.userId) ?? [];
            return (
              <div className={local.mr} key={r.id} data-testid={`row-${r.id}`}>
                <div className={styles.person}>
                  <Avatar person={{ id: m.userId, displayName: m.displayName }} />
                  <div><div className={styles.name}>{m.displayName}</div><div className={cn(styles.muted, styles.small)}>{m.email}</div></div>
                </div>
                <div>{m.jobTitle ?? "—"}</div>
                <div>
                  {canEditRole(m) ? (
                    <select aria-label={t("roleOf", { name: m.displayName })} value={m.role} onChange={(e) => void changeRole(m, e.target.value as WsRole)}>
                      {(roleOptions.includes(m.role) ? roleOptions : [m.role, ...roleOptions]).map((x) => <option key={x} value={x}>{tr(x)}</option>)}
                    </select>
                  ) : (
                    tr(m.role)
                  )}
                </div>
                <div className={local.pills}>{mine.length ? mine.map((p) => <Badge key={p.key}>{p.name}</Badge>) : <span className={styles.muted}>{t("noProjects")}</span>}</div>
                <div className={styles.muted}>{m.lastActiveAt ? format.relativeTime(new Date(m.lastActiveAt), new Date()) : t("never")}</div>
                <div><Badge tone={STATUS_TONE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge></div>
                <div>
                  {isAdmin && m.userId !== me.id && (workspace.role === "owner" || m.role !== "owner") ? (
                    <button type="button" className={styles.icon} aria-label={t("options", { name: m.displayName })} onClick={() => setManaging(m)}><MoreHorizontal size={16} /></button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={cn(styles.card, styles.roles)}>
        <div><span className={styles.badgeCol}><Badge tone="blue">{t("ownerAdmin")}</Badge></span><div>{t("roleOwnerAdmin")}</div></div>
        <div><span className={styles.badgeCol}><Badge tone="green">{tr("member")}</Badge></span><div>{t("roleMember")}</div></div>
        <div><span className={styles.badgeCol}><Badge>{tr("guest")}</Badge></span><div>{t("roleGuest")}</div></div>
      </section>

      {inviting && <InviteDialog ws={ws} projects={projects} canInviteAdmin={isAdmin} onClose={() => setInviting(false)} onDone={refresh} />}
      {managing && (
        <ManageDialog
          ws={ws}
          member={managing}
          others={members.data.items.filter((m) => m.status === "active" && m.userId !== managing.userId && m.role !== "guest")}
          onClose={() => setManaging(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}
