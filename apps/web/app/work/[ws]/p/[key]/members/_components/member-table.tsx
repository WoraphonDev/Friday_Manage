"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { MoreHorizontal } from "lucide-react";
import { Avatar, Badge, Button, Dialog, EmptyState, Input, Select } from "@/components/ui";
import { formatDate, type YearFormat, localeNumberFormat } from "@/lib/format";
import { positionOptions, toPositionCode } from "@/lib/positions";
import { cn } from "@/lib/utils";
import type { ProjectMember, ProjectRole } from "./types";

export type RemoveChoice = { reassignTo: string | null } | { keepAssignments: true };
const KEEP = "__keep";
import styles from "./members.module.css";

const num = localeNumberFormat({ maximumFractionDigits: 1 });
const HOURS_PER_MD = 8;

export function MemberTable({
  members,
  year,
  canManage,
  thisWeek,
  onRole,
  onEdit,
  onRemove,
}: {
  members: ProjectMember[];
  year: YearFormat;
  canManage: boolean;
  /** Man-Day สัปดาห์นี้ต่อคน (จาก Workload) · ไม่มีข้อมูล = แสดง — */
  thisWeek: Map<string, { value: number; capacity: number | null }>;
  onRole: (member: ProjectMember, role: ProjectRole) => Promise<void>;
  onEdit: (member: ProjectMember, body: { position: string | null; capacityHoursWeek: number | null; pmDeputy?: boolean }) => Promise<void>;
  onRemove: (member: ProjectMember, choice: RemoveChoice) => Promise<void>;
}) {
  const t = useTranslations("members-workload.members");
  const tr = useTranslations("members-workload.roles");
  const ti = useTranslations("members-workload.invites");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ProjectMember | null>(null);
  const q = query.trim().toLowerCase();
  const rows = q ? members.filter((m) => `${m.displayName} ${m.email ?? ""} ${m.position ?? ""}`.toLowerCase().includes(q)) : members;

  return (
    <section id="members" className={styles.card} aria-labelledby="members-title">
      <div className={styles.chead}>
        <h2 id="members-title">{t("title")} <span className={styles.muted}>{t("count", { count: members.length })}</span></h2>
        <div className={styles.group}>
          <input className={cn("input", styles.search)} type="search" placeholder={t("search")} aria-label={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          {/* คำอธิบาย Role เปิดดูข้างตาราง (เดิมเป็นการ์ดแยกคู่กับฟอร์มเชิญที่ย้ายไปเป็น Modal) */}
          <Popover.Root>
            <Popover.Trigger asChild><button type="button" className="button button-secondary">{t("rolesButton")}</button></Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className={cn("popover", styles.rolesPop)} align="end" sideOffset={6} aria-label={ti("rolesTitle")}>
                <div className={styles.roles}>
                  <div><span className={styles.badgeCol}><Badge tone="blue">{tr("admin")}</Badge></span><div>{ti("roleAdmin")}</div></div>
                  <div><span className={styles.badgeCol}><Badge tone="green">{tr("member")}</Badge></span><div>{ti("roleMember")}</div></div>
                  <div><span className={styles.badgeCol}><Badge>{tr("viewer")}</Badge></span><div>{ti("roleViewer")}</div></div>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
      <div className={styles.scroll}>
        <div className={cn(styles.mt, styles.h)} role="row">
          <div>{t("colMember")}</div><div>{t("colPosition")}</div><div>{t("colRole")}</div><div>{t("colCapacity")}</div>
          <div>{t("colOpen")}</div><div>{t("colOverdue")}</div><div>{t("colWeek")}</div><div>{t("colJoined")}</div><div />
        </div>
        {!rows.length && <EmptyState title={t("empty")} description="" />}
        {rows.map((m) => {
          const week = thisWeek.get(m.userId);
          const cap = week?.capacity ?? null;
          const pct = week && cap ? (week.value / cap) * 100 : 0;
          return (
            <div className={styles.mt} key={m.userId} data-testid={`member-${m.userId}`}>
              <div className={styles.person}>
                <Avatar person={{ id: m.userId, displayName: m.displayName, initials: m.initials, avatarUrl: m.avatarUrl }} />
                <div>
                  <div className={styles.name}>
                    {m.displayName}
                    {m.isOwner && <Badge tone="blue">{t("owner")}</Badge>}
                    {m.isGuest && <Badge>{t("guest")}</Badge>}
                    {!m.active && <Badge tone="red">{t("inactive")}</Badge>}
                  </div>
                  {m.email && <div className={cn(styles.muted, styles.small)}>{m.email}</div>}
                </div>
              </div>
              <div>{m.position ?? "—"}</div>
              <div>
                {canManage && !m.isOwner ? (
                  <select aria-label={t("roleOf", { name: m.displayName })} value={m.role} onChange={(e) => void onRole(m, e.target.value as ProjectRole)}>
                    {(["admin", "member", "viewer"] as const).map((r) => <option key={r} value={r} disabled={m.isGuest && r !== "viewer"}>{tr(r)}</option>)}
                  </select>
                ) : (
                  tr(m.role)
                )}
                {m.pmDeputy && m.role !== "admin" && <> <Badge tone="blue">{t("pmDeputyBadge")}</Badge></>}
              </div>
              <div>{m.capacityHoursWeek === null ? <span className={styles.muted}>{t("capacityDefault")}</span> : t("capacity", { hours: m.capacityHoursWeek, md: num.format(m.capacityHoursWeek / HOURS_PER_MD) })}</div>
              <div>{m.openIssues}</div>
              <div className={m.overdueIssues > 0 ? styles.up : styles.muted}>{m.overdueIssues}</div>
              <div>
                {week && cap !== null ? (
                  <>
                    <span className={styles.meter}><span className={pct > 100 ? styles.over : pct >= 80 ? styles.mid : styles.low} style={{ width: `${Math.min(100, pct)}%` }} /></span>
                    <span className={pct > 100 ? styles.up : undefined}>{t("week", { value: num.format(week.value), capacity: num.format(cap) })}</span>
                  </>
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </div>
              <div className={styles.muted}>{formatDate(m.joinedAt, year)}</div>
              {canManage ? (
                <button type="button" className={styles.icon} aria-label={t("options", { name: m.displayName })} onClick={() => setEditing(m)}><MoreHorizontal size={16} /></button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
      {editing && (
        <MemberDialog
          member={editing}
          others={members.filter((m) => m.userId !== editing.userId && m.active)}
          onClose={() => setEditing(null)}
          onSave={async (body) => { await onEdit(editing, body); setEditing(null); }}
          onRemove={async (to) => { await onRemove(editing, to); setEditing(null); }}
        />
      )}
    </section>
  );
}

/** ⋯ ของสมาชิก: ตำแหน่ง, Capacity และนำออกจากโปรเจกต์พร้อมโอนงาน (P3) */
function MemberDialog({
  member,
  others,
  onClose,
  onSave,
  onRemove,
}: {
  member: ProjectMember;
  others: ProjectMember[];
  onClose: () => void;
  onSave: (body: { position: string | null; capacityHoursWeek: number | null; pmDeputy?: boolean }) => Promise<void>;
  onRemove: (choice: RemoveChoice) => Promise<void>;
}) {
  const t = useTranslations("members-workload.members");
  const tc = useTranslations("common.app");
  const [position, setPosition] = useState(toPositionCode(member.position));
  const [capacity, setCapacity] = useState(member.capacityHoursWeek === null ? "" : String(member.capacityHoursWeek));
  const [deputy, setDeputy] = useState(!!member.pmDeputy);
  // Owner / Admin เป็น PM อยู่แล้ว · Guest ทำแทน PM ไม่ได้
  const canDeputy = !member.isOwner && member.role !== "admin" && !member.isGuest;
  // ค่าเริ่มต้นคงงานไว้กับคนเดิม (ไม่แตะงาน) · เลือกโอนหรือปล่อยว่างได้
  const [to, setTo] = useState(KEEP);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : tc("unknownError"));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()} title={t("editTitle", { name: member.displayName })}>
      <form
        className={styles.dialogBody}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => onSave({ position: position.trim() || null, capacityHoursWeek: capacity === "" ? null : Number(capacity), ...(canDeputy ? { pmDeputy: deputy } : {}) }));
        }}
      >
        <Select label={t("position")} value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">{t("positionNone")}</option>
          {positionOptions(position).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <Input label={t("capacityHours")} type="number" min={0} max={168} value={capacity} hint={t("capacityHint")} onChange={(e) => setCapacity(e.target.value)} />
        {canDeputy && (
          <label className={styles.check}>
            <input type="checkbox" checked={deputy} onChange={(e) => setDeputy(e.target.checked)} />
            <span>
              <strong>{t("pmDeputy")}</strong>
              <span className={cn(styles.muted, styles.small)}>{t("pmDeputyHint")}</span>
            </span>
          </label>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={pending}>{pending ? tc("saving") : tc("save")}</Button>
        </div>
      </form>
      {!member.isOwner && (
        <div className={styles.dialogBody} style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 14 }}>
          <strong>{t("removeTitle")}</strong>
          <span className={styles.muted}>{t("removeHint")}</span>
          {member.openIssues > 0 && (
            <>
              <span>{t("openWork", { count: member.openIssues, md: num.format(member.openMd) })}</span>
              <Select label={t("reassignTo")} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value={KEEP}>{t("keepWork", { name: member.displayName })}</option>
                <option value="">{t("unassigned")}</option>
                {others.filter((m) => m.role !== "viewer").map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
              </Select>
            </>
          )}
          <div className={styles.actions}>
            <Button variant="danger" disabled={pending} onClick={() => void run(() => onRemove(to === KEEP ? { keepAssignments: true } : { reassignTo: to || null }))}>{t("remove")}</Button>
          </div>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </Dialog>
  );
}
