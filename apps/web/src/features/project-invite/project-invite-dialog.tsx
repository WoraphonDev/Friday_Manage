"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { copyText, isEmail, splitEmails } from "../../../app/work/[ws]/p/[key]/members/_components/shared";
import type { InviteResult, ProjectMembers, ProjectRole, WorkspaceMember } from "../../../app/work/[ws]/p/[key]/members/_components/types";
import styles from "./project-invite.module.css";
import { localeNumberFormat } from "@/lib/format";

const num = localeNumberFormat({ maximumFractionDigits: 1 });

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

/**
 * เชิญเข้าโปรเจกต์จากปุ่ม Invite ที่หัวโปรเจกต์ (ทุกแท็บ) และหน้า Members · เปิดทับหน้าเดิม ไม่พาไปหน้าอื่น
 * (ต่างจาก Canvas 7 ที่ฝังฟอร์มในหน้า · ผู้ใช้เลือก Modal ให้เหมือน Invite ของ Workspace (H) · 2026-11-07)
 */
export function ProjectInviteDialog({ ws, projectKey, open, onOpenChange }: {
  ws: string; projectKey: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("members-workload.invites");
  const tr = useTranslations("members-workload.roles");
  const toast = useToast();
  const cache = useQueryClient();
  const { workspace } = useWorkspace();
  const wsBase = `/w/${encodeURIComponent(ws)}`;
  const base = `${wsBase}/projects/${encodeURIComponent(projectKey)}`;
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  const [capacity, setCapacity] = useState("40");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [links, setLinks] = useState<{ email: string; url: string }[]>([]);
  const members = useQuery({ queryKey: ["project-members", ws, projectKey], queryFn: () => api.get<ProjectMembers>(`${base}/members`), enabled: open });
  // สมาชิก Workspace ที่มีอยู่แล้วเพิ่มเข้าโปรเจกต์ตรง ๆ ไม่ต้องส่งคำเชิญ
  const directory = useQuery({
    queryKey: ["workspace-members", ws],
    queryFn: () => api.get<{ items: WorkspaceMember[] }>(`${wsBase}/members`),
    enabled: open && workspace.role !== "guest" && !!members.data?.canInvite,
  });
  const canAssignAdmin = !!members.data?.canManage;
  const list = splitEmails(emails);

  function reset() { setEmails(""); setRole("member"); setCapacity("40"); setError(""); setLinks([]); }
  function close(next: boolean) {
    if (!next && pending) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit() {
    // ข้อความผิดพลาดแสดงหลังกดส่งเท่านั้น ไม่ขึ้นแดงตั้งแต่ยังไม่ได้พิมพ์
    const bad = list.filter((e) => !isEmail(e));
    if (!list.length) return setError(t("required"));
    if (bad.length) return setError(t("invalid", { emails: bad.join(", ") }));
    setPending(true);
    setError("");
    const hours = capacity === "" ? undefined : Number(capacity);
    try {
      const byEmail = new Map((directory.data?.items ?? []).filter((m) => m.status === "active").map((m) => [m.email.toLowerCase(), m]));
      const existing = list.filter((e) => byEmail.has(e));
      const fresh = list.filter((e) => !byEmail.has(e));
      let added = 0;
      for (const email of existing) {
        await api.post(`${base}/members`, { userId: byEmail.get(email)!.userId, role, capacityHoursWeek: hours });
        added++;
      }
      const result = fresh.length
        ? await api.post<InviteResult>(`${wsBase}/invitations`, { emails: fresh, projectKey, projectRole: role, workspaceRole: "member", capacityHoursWeek: hours })
        : { items: [] };
      const invited = result.items.flatMap((i) => (i.status === "invited" ? [{ email: i.email, url: i.inviteUrl }] : []));
      const already = result.items.length - invited.length;
      toast({
        message: [invited.length ? t("sent", { count: invited.length }) : "", added ? t("added", { count: added }) : "", already ? t("alreadyMember", { count: already }) : ""].filter(Boolean).join(" · "),
      });
      setEmails("");
      // มีลิงก์ต้องส่งต่อเอง: ค้าง Modal ไว้ให้คัดลอก · ไม่มีก็ปิดเลย
      if (invited.length) setLinks(invited);
      else close(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["project-members", ws, projectKey] }),
        cache.invalidateQueries({ queryKey: ["workload", ws, projectKey] }),
        cache.invalidateQueries({ queryKey: ["invitations", ws] }),
      ]);
    }
  }

  const roleHelp = { admin: t("roleAdmin"), member: t("roleMember"), viewer: t("roleViewer") }[role];
  return (
    <Dialog open={open} onOpenChange={close} title={t("title")} size="medium">
      {members.data && !members.data.canInvite ? (
        <p className={styles.muted}>{t("noPermission")}</p>
      ) : (
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Input label={t("emails")} placeholder={t("emailsPlaceholder")} autoFocus value={emails} onChange={(e) => { setEmails(e.target.value); setError(""); }} error={error || undefined} />
          <div className={styles.row}>
            <Select label={t("role")} value={role} onChange={(e) => setRole(e.target.value as ProjectRole)} hint={roleHelp}>
              <option value="member">{tr("member")}</option>
              {canAssignAdmin && <option value="admin">{tr("admin")}</option>}
              <option value="viewer">{tr("viewer")}</option>
            </Select>
            <Input label={t("capacity")} type="number" min={0} max={80} value={capacity} onChange={(e) => setCapacity(e.target.value)} hint={t("capacityHint", { md: num.format(Number(capacity || 0) / 8) })} />
          </div>
          <InviteLinks links={links} />
          <div className={styles.actions}>
            <Button onClick={() => close(false)} disabled={pending}>{links.length ? t("done") : t("dismiss")}</Button>
            <Button type="submit" variant="primary" disabled={pending}>{pending ? t("sending") : list.length > 1 ? t("sendCount", { count: list.length }) : t("send")}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
