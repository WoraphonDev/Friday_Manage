"use client";

import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Button, Dialog, Input, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";
import { InviteLinks } from "@/features/project-invite/project-invite-dialog";
import { copyText, isEmail, splitEmails } from "../../p/[key]/members/_components/shared";
import type { InviteResult, ProjectRole } from "../../p/[key]/members/_components/types";
import styles from "../../p/[key]/members/_components/members.module.css";
import local from "./ws.module.css";

type InviteRole = "admin" | "member" | "guest";
const ROLE_DESC = { admin: "roleAdminDesc", member: "roleMemberDesc", guest: "roleGuestDesc" } as const;

/** H › เชิญสมาชิก: หลายอีเมลพร้อมกัน, Role, เพิ่มเข้าโปรเจกต์ และลิงก์เชิญ */
export function InviteDialog({
  ws,
  projects,
  canInviteAdmin,
  onClose,
  onDone,
}: {
  ws: string;
  projects: Project[];
  canInviteAdmin: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("members-workload.ws");
  const ti = useTranslations("members-workload.invites");
  const tr = useTranslations("members-workload.roles");
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}`;
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [projectKey, setProjectKey] = useState("");
  const [projectRole, setProjectRole] = useState<ProjectRole>("member");
  const [jobTitle, setJobTitle] = useState("");
  const [capacity, setCapacity] = useState("40");
  const [message, setMessage] = useState("");
  const [expires, setExpires] = useState<1 | 7 | 30>(7);
  const [link, setLink] = useState<string | null>(null);
  const [links, setLinks] = useState<{ email: string; url: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const bad = emails.filter((e) => !isEmail(e));
  const add = (text: string) => {
    const next = splitEmails(text).filter((e) => !emails.includes(e));
    if (next.length) setEmails([...emails, ...next]);
    setDraft("");
    setError("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      if (draft.trim()) {
        e.preventDefault();
        add(draft);
      } else if (e.key === "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && !draft && emails.length) setEmails(emails.slice(0, -1));
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    add(draft + e.clipboardData.getData("text"));
  };
  // ส่งอีเมลที่ยังพิมพ์ค้างในช่องด้วย
  const all = draft.trim() ? [...emails, ...splitEmails(draft).filter((x) => !emails.includes(x))] : emails;

  async function send() {
    const invalid = all.filter((e) => !isEmail(e));
    if (!all.length) return setError(ti("required"));
    if (invalid.length) return setError(t("invalidList", { emails: invalid.join(", ") }));
    setPending(true);
    setError("");
    try {
      const r = await api.post<InviteResult>(`${base}/invitations`, {
        emails: all,
        workspaceRole: role,
        ...(projectKey ? { projectKey, projectRole: role === "guest" ? "viewer" : projectRole } : {}),
        ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
        ...(capacity !== "" ? { capacityHoursWeek: Number(capacity) } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        expiresInDays: expires,
      });
      const invited = r.items.flatMap((i) => (i.status === "invited" ? [{ email: i.email, url: i.inviteUrl }] : []));
      const already = r.items.length - invited.length;
      setLinks(invited);
      setEmails([]);
      setDraft("");
      toast({ message: [invited.length ? ti("sent", { count: invited.length }) : "", already ? ti("alreadyMember", { count: already }) : ""].filter(Boolean).join(" · ") });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  async function createLink() {
    try {
      // ลิงก์ให้สิทธิ์ Admin ไม่ได้ (A14) จึงใช้ Member แทนเมื่อเลือก Admin
      const r = await api.post<{ url: string }>(`${base}/invite-links`, { role: role === "guest" ? "guest" : "member", expiresInDays: expires });
      setLink(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Dialog open size="medium" onOpenChange={(open) => !open && !pending && onClose()} title={t("inviteTitle")}>
      <form className={styles.dialogBody} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className={styles.dialogBody} style={{ gap: 6 }}>
          <span className={local.lb}>{t("emails")} <span aria-hidden="true">*</span></span>
          <div className={local.emailBox}>
            {emails.map((e) => (
              <span key={e} className={cn(local.ec, !isEmail(e) && local.bad)} title={!isEmail(e) ? t("invalidEmail") : undefined}>
                {e}
                <button type="button" aria-label={t("removeEmail", { email: e })} onClick={() => setEmails(emails.filter((x) => x !== e))}><X size={12} /></button>
              </span>
            ))}
            <input aria-label={t("emailsInput")} placeholder={t("emailsPlaceholder")} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste} onBlur={() => draft.trim() && add(draft)} />
          </div>
          {bad.length > 0 && <span className={styles.error}>{t("invalidList", { emails: bad.join(", ") })}</span>}
        </div>

        <div className={styles.dialogBody} style={{ gap: 6 }}>
          <span className={local.lb}>{t("wsRole")}</span>
          <div className={local.opts} role="group" aria-label={t("wsRole")}>
            {(["admin", "member", "guest"] as const).filter((r) => r !== "admin" || canInviteAdmin).map((r) => (
              <button key={r} type="button" className={local.opt} aria-pressed={role === r} onClick={() => setRole(r)}>
                <span>{tr(r)}</span>
                <span className={styles.muted}>{t(ROLE_DESC[r])}</span>
              </button>
            ))}
          </div>
        </div>

        {!!projects.length && (
          // Canvas H: รายการโปรเจกต์ติ๊กเลือกพร้อมบทบาท · API รับได้ครั้งละ 1 โปรเจกต์ จึงติ๊กได้ทีละรายการ
          <fieldset className={local.projects}>
            <legend className={local.lb}>{t("addToProject")} <span className={styles.muted}>{t("optional")}</span></legend>
            {projects.map((p) => (
              <div key={p.key} className={local.projRow}>
                <label className={local.projName}>
                  <input type="checkbox" checked={projectKey === p.key} onChange={(e) => setProjectKey(e.target.checked ? p.key : "")} />
                  <span className={local.dot} style={{ background: p.color ?? "#334155" }} aria-hidden="true" />
                  {p.name}
                </label>
                <select aria-label={t("projectRoleFor", { name: p.name })} value={role === "guest" ? "viewer" : projectRole} disabled={projectKey !== p.key || role === "guest"} onChange={(e) => setProjectRole(e.target.value as ProjectRole)}>
                  {(["member", "admin", "viewer"] as const).map((r) => <option key={r} value={r}>{tr(r)}</option>)}
                </select>
              </div>
            ))}
          </fieldset>
        )}

        <div className={local.two}>
          <Input label={t("position")} placeholder={t("positionPlaceholder")} value={jobTitle} maxLength={80} onChange={(e) => setJobTitle(e.target.value)} />
          <Input label={t("capacity")} type="number" min={0} max={80} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </div>
        <label className={styles.dialogBody} style={{ gap: 6 }}>
          <span className={local.lb}>{t("message")}</span>
          <textarea className={styles.textarea} placeholder={t("messagePlaceholder")} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />
        </label>

        <div className={local.link}>
          <span className={local.lb}>{t("linkTitle")}</span>
          {link ? <code>{link}</code> : <span className={cn(styles.muted, styles.small)} style={{ flex: "1 1 200px" }}>{t(role === "guest" ? "linkGuest" : "linkMember")}</span>}
          <select aria-label={t("linkExpiry")} value={expires} onChange={(e) => { setExpires(Number(e.target.value) as 1 | 7 | 30); setLink(null); }}>
            <option value={7}>{t("expires7")}</option>
            <option value={1}>{t("expires1")}</option>
            <option value={30}>{t("expires30")}</option>
          </select>
          {link ? (
            <Button size="small" onClick={async () => { await copyText(link); toast({ message: ti("copied") }); }}>{ti("copy")}</Button>
          ) : (
            <Button size="small" onClick={() => void createLink()}>{t("createLink")}</Button>
          )}
        </div>
        <InviteLinks links={links} />
        <p className={cn(styles.muted, styles.small)} style={{ margin: 0 }}>{t("notice")}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={cn(styles.actions, local.foot)}>
          <Button onClick={onClose} disabled={pending}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending || !all.length}>{pending ? ti("sending") : t("send", { count: all.length })}</Button>
        </div>
      </form>
    </Dialog>
  );
}
