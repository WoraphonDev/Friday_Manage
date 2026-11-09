"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InviteLinks } from "@/features/project-invite/project-invite-dialog";
import type { Invitation } from "./types";
import styles from "./members.module.css";

/** คำเชิญที่รอตอบรับของโปรเจกต์นี้ · การเชิญใหม่เปิด Modal ตัวเดียวกับปุ่ม Invite ที่หัวโปรเจกต์ */
export function InvitePanel({
  ws,
  projectId,
  year,
  canInvite,
  canListInvitations,
  invitations,
  onInvite,
  onChanged,
}: {
  ws: string;
  projectId: string | undefined;
  year: YearFormat;
  canInvite: boolean;
  canListInvitations: boolean;
  invitations: Invitation[];
  onInvite: () => void;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("members-workload.invites");
  const tr = useTranslations("members-workload.roles");
  const toast = useToast();
  const wsBase = `/w/${encodeURIComponent(ws)}`;
  const [links, setLinks] = useState<{ email: string; url: string }[]>([]);
  const pendingHere = invitations.filter((i) => i.projectId === projectId);

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
    <section id="invites" className={styles.card} aria-labelledby="invite-title">
      <div className={styles.chead}>
        <h2 id="invite-title">{t("pendingTitle")}</h2>
        {canInvite && <Button size="small" variant="primary" onClick={onInvite}>{t("open")}</Button>}
      </div>
      <div className={styles.pending}>
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
        <InviteLinks links={links} />
      </div>
    </section>
  );
}
