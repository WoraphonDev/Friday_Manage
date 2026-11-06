"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Input, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { copyText, isEmail, splitEmails } from "./shared";
import type { Invitation, InviteResult, ProjectRole, WorkspaceMember } from "./types";
import styles from "./members.module.css";

const num = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 1 });

/** ลิงก์ที่ได้หลังเชิญ · ระบบยังไม่ส่งอีเมลเอง (A14) ผู้เชิญจึงต้องส่งต่อเอง */
export function InviteLinks({ links }: { links: { email: string; url: string }[] }) {
  const t = useTranslations("members-workload.invites");
  const toast = useToast();
  if (!links.length) return null;
  return (
    <div className={styles.links} role="status">
      <strong>{t("linksTitle")}</strong>
      {links.map((l) => (
        <div key={l.email}>
          <span><b>{l.email}</b> <code>{l.url}</code></span>
          <Button size="small" onClick={async () => { await copyText(l.url); toast({ message: t("copied") }); }}>{t("copy")}</Button>
        </div>
      ))}
    </div>
  );
}

export function InvitePanel({
  ws,
  projectKey,
  projectId,
  year,
  canInvite,
  canAssignAdmin,
  canListInvitations,
  invitations,
  directory,
  onChanged,
}: {
  ws: string;
  projectKey: string;
  projectId: string | undefined;
  year: YearFormat;
  canInvite: boolean;
  canAssignAdmin: boolean;
  canListInvitations: boolean;
  invitations: Invitation[];
  /** สมาชิก Workspace ที่มีอยู่ (คนที่อยู่ใน Workspace แล้วเพิ่มเข้าโปรเจกต์ตรง ๆ ไม่ต้องส่งคำเชิญ) */
  directory: WorkspaceMember[];
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("members-workload.invites");
  const tr = useTranslations("members-workload.roles");
  const toast = useToast();
  const wsBase = `/w/${encodeURIComponent(ws)}`;
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  const [capacity, setCapacity] = useState("40");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [links, setLinks] = useState<{ email: string; url: string }[]>([]);
  const list = splitEmails(emails);
  const pendingHere = invitations.filter((i) => i.projectId === projectId);

  async function submit() {
    const bad = list.filter((e) => !isEmail(e));
    if (!list.length) return setError(t("required"));
    if (bad.length) return setError(t("invalid", { emails: bad.join(", ") }));
    setPending(true);
    setError("");
    const hours = capacity === "" ? undefined : Number(capacity);
    try {
      // คนที่เป็นสมาชิก Workspace อยู่แล้ว: เพิ่มเข้าโปรเจกต์ตรง ๆ · คนอื่นส่งคำเชิญทางอีเมล
      const byEmail = new Map(directory.filter((m) => m.status === "active").map((m) => [m.email.toLowerCase(), m]));
      const existing = list.filter((e) => byEmail.has(e));
      const fresh = list.filter((e) => !byEmail.has(e));
      let added = 0;
      for (const email of existing) {
        await api.post(`${wsBase}/projects/${encodeURIComponent(projectKey)}/members`, { userId: byEmail.get(email)!.userId, role, capacityHoursWeek: hours });
        added++;
      }
      const result = fresh.length
        ? await api.post<InviteResult>(`${wsBase}/invitations`, { emails: fresh, projectKey, projectRole: role, workspaceRole: "member", capacityHoursWeek: hours })
        : { items: [] };
      const invited = result.items.flatMap((i) => (i.status === "invited" ? [{ email: i.email, url: i.inviteUrl }] : []));
      const already = result.items.length - invited.length;
      setLinks(invited);
      setEmails("");
      toast({
        message: [invited.length ? t("sent", { count: invited.length }) : "", added ? t("added", { count: added }) : "", already ? t("alreadyMember", { count: already }) : ""].filter(Boolean).join(" · "),
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onChanged();
    } finally {
      setPending(false);
    }
  }

  async function act(inv: Invitation, action: "resend" | "revoke") {
    try {
      const r = await api.post<{ inviteUrl?: string }>(`${wsBase}/invitations/${inv.id}/${action}`);
      if (r.inviteUrl) setLinks([{ email: inv.email, url: r.inviteUrl }]);
      toast({ message: t(action === "resend" ? "resent" : "revoked", { email: inv.email }) });
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : String(e) });
    }
    await onChanged();
  }

  return (
    <div id="invites" className={styles.split}>
      <section className={styles.card} aria-labelledby="invite-title">
        <div className={styles.chead}><h2 id="invite-title">{t("title")}</h2></div>
        {canInvite ? (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Input label={t("emails")} placeholder={t("emailsPlaceholder")} value={emails} onChange={(e) => { setEmails(e.target.value); setError(""); }} error={error || undefined} />
            <Select label={t("role")} value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
              <option value="member">{tr("member")}</option>
              {canAssignAdmin && <option value="admin">{tr("admin")}</option>}
              <option value="viewer">{tr("viewer")}</option>
            </Select>
            <Input label={t("capacity")} type="number" min={0} max={80} value={capacity} onChange={(e) => setCapacity(e.target.value)} hint={t("capacityHint", { md: num.format(Number(capacity || 0) / 8) })} />
            <div>
              <Button type="submit" variant="primary" disabled={pending}>{pending ? t("sending") : list.length > 1 ? t("sendCount", { count: list.length }) : t("send")}</Button>
            </div>
            <InviteLinks links={links} />
          </form>
        ) : (
          <p className={cn(styles.note, styles.muted)}>{t("noPermission")}</p>
        )}
        <div className={styles.pending}>
          <h3>{t("pendingTitle")}</h3>
          {!canListInvitations ? (
            <span className={cn(styles.muted, styles.small)}>{t("pendingHidden")}</span>
          ) : !pendingHere.length ? (
            <span className={cn(styles.muted, styles.small)}>{t("pendingEmpty")}</span>
          ) : (
            pendingHere.map((inv) => (
              <div className={styles.inv} key={inv.id} data-testid={`invite-${inv.id}`}>
                <span>{inv.email}</span>
                <Badge>{tr(inv.projectRole ?? inv.workspaceRole)}</Badge>
                <span className={cn(styles.muted, styles.small)}>{t("sentAt", { date: formatDate(inv.createdAt, year) })}</span>
                <Button size="small" onClick={() => void act(inv, "resend")}>{t("resend")}</Button>
                <Button size="small" onClick={() => void act(inv, "revoke")}>{t("cancel")}</Button>
              </div>
            ))
          )}
        </div>
      </section>
      <section id="roles" className={styles.card} aria-labelledby="roles-title">
        <div className={styles.chead}><h2 id="roles-title">{t("rolesTitle")}</h2></div>
        <div className={styles.roles}>
          <div><span className={styles.badgeCol}><Badge tone="blue">{tr("admin")}</Badge></span><div>{t("roleAdmin")}</div></div>
          <div><span className={styles.badgeCol}><Badge tone="green">{tr("member")}</Badge></span><div>{t("roleMember")}</div></div>
          <div><span className={styles.badgeCol}><Badge>{tr("viewer")}</Badge></span><div>{t("roleViewer")}</div></div>
        </div>
      </section>
    </div>
  );
}
