"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorState, Forbidden, LoadingState, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { today } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Project } from "@/lib/types";
import { ProjectInviteDialog } from "@/features/project-invite/project-invite-dialog";
import { InvitePanel } from "./invite-panel";
import { MemberTable } from "./member-table";
import { workloadRange } from "./shared";
import type { Invitation, ProjectMember, ProjectMembers, ProjectRole, Workload } from "./types";
import { WorkloadPanel, workloadKey, workloadParams } from "./workload-panel";
import styles from "./members.module.css";

const SECTIONS = ["workload", "members", "invites"] as const;

/** หน้า 7 · Members + Workload ของโปรเจกต์ */
export function MembersView({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("members-workload");
  const { me, workspace } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const wsBase = `/w/${encodeURIComponent(ws)}`;
  const base = `${wsBase}/projects/${encodeURIComponent(projectKey)}`;
  const isWsAdmin = workspace.role === "owner" || workspace.role === "admin";
  const [section, setSection] = useState<(typeof SECTIONS)[number]>("workload");
  const [inviting, setInviting] = useState(false);
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if ((SECTIONS as readonly string[]).includes(h)) setSection(h as (typeof SECTIONS)[number]);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const project = useQuery({ queryKey: queryKeys.project(ws, projectKey), queryFn: () => api.get<Project>(base) });
  const allowed = !!perms.data && !perms.data.guestViewer;
  const canWorkload = !!perms.data?.permissions.includes("project.workload.view");
  const members = useQuery({ queryKey: ["project-members", ws, projectKey], queryFn: () => api.get<ProjectMembers>(`${base}/members`), enabled: allowed });
  const invitations = useQuery({ queryKey: ["invitations", ws], queryFn: () => api.get<{ items: Invitation[] }>(`${wsBase}/invitations`), enabled: allowed && isWsAdmin });
  // สัปดาห์นี้ของตาราง Members ใช้ query เดียวกับมุมมองเริ่มต้นของ Workload (ไม่โหลดซ้ำ)
  const defaultParams = workloadParams(workloadRange("week", today(), 0), "week", "md");
  const workload = useQuery({ queryKey: workloadKey(ws, projectKey, defaultParams), queryFn: () => api.get<Workload>(`${base}/workload?${defaultParams}`), enabled: allowed && canWorkload });

  if (perms.isPending || (members.isPending && members.fetchStatus !== "idle")) return <div className={styles.page}><LoadingState /></div>;
  if (perms.data?.guestViewer) return <div className={styles.page}><Forbidden /></div>;
  const err = perms.error ?? members.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => { void perms.refetch(); void members.refetch(); }} />}</div>;

  const list = members.data!.items;
  const canManage = members.data!.canManage;
  const canInvite = members.data!.canInvite;
  const now = today();
  const idx = workload.data?.buckets.findIndex((b) => b.start <= now && now <= b.end) ?? -1;
  const thisWeek = new Map(idx < 0 ? [] : (workload.data?.people ?? []).map((p) => [p.person.id, { value: p.cells[idx].value, capacity: p.cells[idx].capacity }]));
  const pendingCount = (invitations.data?.items ?? []).filter((i) => i.projectId === project.data?.id).length;

  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["project-members", ws, projectKey] });
    await cache.invalidateQueries({ queryKey: ["workload", ws, projectKey] });
    await cache.invalidateQueries({ queryKey: ["invitations", ws] });
  };
  const fail = (e: unknown) => toast({ message: e instanceof Error ? e.message : String(e) });

  async function onRole(m: ProjectMember, role: ProjectRole) {
    try {
      await api.request(`${base}/members/${m.userId}`, { method: "PATCH", body: { role } });
      toast({ message: t("members.roleChanged", { name: m.displayName, role: t(`roles.${role}`) }) });
    } catch (e) {
      fail(e);
    }
    await refresh();
  }
  async function onEdit(m: ProjectMember, body: { positions: string[]; capacityHoursWeek: number | null; pmDeputy?: boolean }) {
    // สมาชิกโปรเจกต์ไม่มี version จึงไม่ส่ง If-Match
    await api.request(`${base}/members/${m.userId}`, { method: "PATCH", body });
    toast({ message: t("members.saved", { name: m.displayName }) });
    await refresh();
  }
  async function onRemove(m: ProjectMember, reassignTo: string | null) {
    const r = await api.delete<{ reassigned: number }>(`${base}/members/${m.userId}`, { body: { reassignTo } });
    toast({ message: r.reassigned ? t("members.removedWithWork", { name: m.displayName, count: r.reassigned }) : t("members.removed", { name: m.displayName }) });
    await refresh();
  }

  return (
    <div className={styles.page}>
      <nav className={styles.subnav} aria-label={t("sections.label")}>
        {SECTIONS.filter((s) => s !== "workload" || canWorkload).map((s) => (
          <a key={s} href={`#${s}`} aria-current={section === s} onClick={() => setSection(s)}>
            {s === "workload" ? t("sections.workload") : s === "members" ? t("sections.members", { count: list.length }) : t("sections.invites", { count: pendingCount })}
          </a>
        ))}
      </nav>
      {canWorkload && (
        <div id="workload" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <WorkloadPanel ws={ws} projectKey={projectKey} base={base} year={me.yearFormat} members={list} canReassign={!!perms.data?.permissions.includes("issue.edit")} />
        </div>
      )}
      <MemberTable members={list} year={me.yearFormat} canManage={canManage} thisWeek={thisWeek} onRole={onRole} onEdit={onEdit} onRemove={onRemove} />
      <InvitePanel
        ws={ws}
        projectId={project.data?.id}
        year={me.yearFormat}
        canInvite={canInvite}
        canListInvitations={isWsAdmin}
        invitations={invitations.data?.items ?? []}
        onInvite={() => setInviting(true)}
        onChanged={refresh}
      />
      <ProjectInviteDialog ws={ws} projectKey={projectKey} open={inviting} onOpenChange={setInviting} />
    </div>
  );
}
