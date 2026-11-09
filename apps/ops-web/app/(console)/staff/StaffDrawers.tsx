"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog, useReauth } from "@/components/dialogs";
import { CopyButton, Drawer, Notice, RolePicker } from "@/components/kit";
import { Button, errorToast, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import type { Limits, OpsRole } from "@/lib/types";
import { DEFAULT_LIMITS, staffKey, type StaffMember } from "./types";

/** A1 · เชิญพนักงาน · เพิ่มบทบาท Owner ต้องแตะกุญแจ (ops-api ตอบ reauth_required) */
export function InviteDrawer({ open, onOpenChange, initialRoles = ["support"] }: { open: boolean; onOpenChange: (o: boolean) => void; initialRoles?: OpsRole[] }) {
  const t = useTranslations("staff.inviteForm");
  const tc = useTranslations("common");
  const cache = useQueryClient();
  const { run } = useReauth();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<OpsRole[]>(initialRoles);
  const [dept, setDept] = useState("");
  const [expires, setExpires] = useState("");
  const [touched, setTouched] = useState(false);
  const invite = useMutation({
    mutationFn: () =>
      run(
        () => api.post<{ staff: StaffMember; enrollUrl: string }>("/staff", { email: email.trim(), name: name.trim(), roles, department: dept.trim() || null, expiresAt: expires ? new Date(`${expires}T23:59:59+07:00`).toISOString() : null }),
        t("title"),
      ),
    onSuccess: () => void cache.invalidateQueries({ queryKey: staffKey }),
  });
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const ok = validEmail && name.trim().length > 0 && roles.length > 0;
  const close = (o: boolean) => {
    if (!o) {
      setEmail("");
      setName("");
      setDept("");
      setExpires("");
      setTouched(false);
      setRoles(initialRoles);
      invite.reset();
    }
    onOpenChange(o);
  };
  return (
    <Drawer open={open} onOpenChange={close} title={t("title")} description={t("desc")}>
      {invite.data ? (
        <div className="stack">
          <Notice tone="ok" title={t("sent")}>
            {invite.data.staff.email}
          </Notice>
          <Input label={t("link")} value={invite.data.enrollUrl} readOnly className="mono" />
          <CopyButton text={invite.data.enrollUrl} label={t("copy")} />
          <div className="dialog-actions">
            <Button variant="primary" onClick={() => close(false)}>
              {tc("dialog.close")}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (ok) invite.mutate();
          }}
        >
          <Input label={t("email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={touched && !validEmail ? tc("dialog.reasonRequired", { min: 5 }) : undefined} />
          <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <div className="field">
            <span className="field-label">{t("roles")}</span>
            <RolePicker value={roles} onChange={setRoles} />
            {roles.includes("owner") && <span className="pill warn">{t("ownerKey")}</span>}
            {touched && !roles.length && <span className="field-error">{t("rolesRequired")}</span>}
          </div>
          <Input label={t("department")} value={dept} onChange={(e) => setDept(e.target.value)} hint={t("departmentHint")} maxLength={60} />
          <Input label={t("expires")} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          <InlineError error={invite.error} />
          <div className="dialog-actions">
            <Button onClick={() => close(false)}>{tc("dialog.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={invite.isPending}>
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}

const baht = (satang: number) => String(Math.round(satang) / 100);

/** A2 · จัดการพนักงาน: บทบาท แผนก วงเงิน กุญแจ สถานะ */
export function ManageDrawer({ member, onOpenChange, ownersLeft }: { member: StaffMember | null; onOpenChange: (o: boolean) => void; ownersLeft: number }) {
  const t = useTranslations("staff.manageForm");
  const tc = useTranslations("common");
  const ts = useTranslations("staff");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const [roles, setRoles] = useState<OpsRole[]>(member?.roles ?? []);
  const [dept, setDept] = useState(member?.department ?? "");
  const [custom, setCustom] = useState(!!member?.customLimits);
  const [limits, setLimits] = useState<Limits>(member?.limits ?? DEFAULT_LIMITS);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<null | "suspended" | "active" | "disabled">(null);
  const [link, setLink] = useState<string | null>(null);
  const done = (message: string) => {
    toast(message);
    void cache.invalidateQueries({ queryKey: staffKey });
  };
  const save = useMutation({
    mutationFn: () =>
      run(
        () =>
          api.patch(`/staff/${member!.id}`, {
            roles,
            department: dept.trim() || null,
            limits: custom ? limits : null,
            reason: reason.trim(),
          }),
        t("title", { name: member!.name }),
      ),
    onSuccess: () => {
      setReason("");
      done(t("saved"));
    },
  });
  const removeKey = useMutation({
    mutationFn: (credentialId: string) => run(() => api.delete(`/staff/${member!.id}/keys/${encodeURIComponent(credentialId)}`), t("removeKey")),
    onSuccess: () => done(t("keyRemoved")),
    onError: (e) => toast(errorToast(e)),
  });
  const enrollLink = useMutation({
    mutationFn: () => api.post<{ enrollUrl: string }>(`/staff/${member!.id}/enroll-link`),
    onSuccess: (r) => {
      setLink(r.enrollUrl);
      done(t("enrollLinkDone"));
    },
    onError: (e) => toast(errorToast(e)),
  });
  if (!member) return null;
  const isLastOwner = member.roles.includes("owner") && ownersLeft <= 1;
  const field = (key: keyof Limits, label: string, money?: boolean) => (
    <Input
      label={label}
      type="number"
      min={0}
      disabled={!custom}
      value={money ? baht(limits[key]) : String(limits[key])}
      onChange={(e) => setLimits({ ...limits, [key]: money ? Math.round(Number(e.target.value) * 100) : Number(e.target.value) })}
    />
  );
  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : ts("never"));
  return (
    <Drawer
      open={!!member}
      onOpenChange={onOpenChange}
      wide
      title={t("title", { name: member.name })}
      description={`${member.email} · ${t("joined", { date: date(member.createdAt) })}`}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (roles.length && reason.trim().length >= 3) save.mutate();
        }}
      >
        <div className="field">
          <span className="field-label">{t("roles")}</span>
          <RolePicker value={roles} onChange={setRoles} disabled={isLastOwner ? ["owner"] : []} />
        </div>
        <Input label={t("department")} value={dept} onChange={(e) => setDept(e.target.value)} maxLength={60} />
        <fieldset className="card" style={{ margin: 0 }}>
          <legend className="field-label">{t("limits")}</legend>
          <label className="check">
            <input type="checkbox" checked={custom} onChange={(e) => (setCustom(e.target.checked), !e.target.checked && setLimits(DEFAULT_LIMITS))} />
            <span>{custom ? t("custom") : t("useDefault")}</span>
          </label>
          <div className="grid-2">
            {field("refundSatang", t("refund"), true)}
            {field("creditSatang", t("credit"), true)}
            {field("discountPct", t("discountPct"))}
            {field("discountCycles", t("discountCycles"))}
            {field("trialDays", t("trialDays"))}
            {field("trialTimes", t("trialTimes"))}
          </div>
        </fieldset>
        <Input label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={tc("dialog.reasonRequired", { min: 3 })} />
        <p className="muted small">{t("ownerNote")}</p>
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <Button type="submit" variant="primary" disabled={!roles.length || reason.trim().length < 3 || save.isPending}>
            {t("save")}
          </Button>
        </div>
      </form>

      <section className="stack">
        <h3 className="card-title">{t("keys")}</h3>
        {member.keys.map((k) => (
          <div key={k.id} className="row" style={{ justifyContent: "space-between" }}>
            <span className="row">
              <KeyRound size={16} aria-hidden="true" />
              <span>
                <b>{k.name}</b>
                <div className="muted small">{t("keyMeta", { created: date(k.createdAt), used: date(k.lastUsedAt) })}</div>
              </span>
            </span>
            <Button size="small" variant="ghost" disabled={member.keys.length <= 1 || removeKey.isPending} aria-label={`${t("removeKey")} ${k.name}`} onClick={() => removeKey.mutate(k.id)}>
              <Trash2 size={14} /> {t("removeKey")}
            </Button>
          </div>
        ))}
        <Button disabled={enrollLink.isPending} onClick={() => enrollLink.mutate()}>
          {t("enrollLink")}
        </Button>
        {link && (
          <div className="stack">
            <Input label={t("enrollLink")} value={link} readOnly className="mono" />
            <CopyButton text={link} />
          </div>
        )}
      </section>

      <section className="row">
        {member.status === "active" || member.status === "invited" ? (
          <Button onClick={() => setStatus("suspended")} disabled={isLastOwner}>
            {t("suspend")}
          </Button>
        ) : (
          member.status === "suspended" && <Button onClick={() => setStatus("active")}>{t("activate")}</Button>
        )}
        {member.status !== "disabled" && (
          <Button variant="danger" disabled={isLastOwner} onClick={() => setStatus("disabled")}>
            {t("disable")}
          </Button>
        )}
      </section>
      {status && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setStatus(null)}
          danger={status === "disabled"}
          title={t(status === "suspended" ? "suspendTitle" : status === "active" ? "activateTitle" : "disableTitle", { name: member.name })}
          description={status === "disabled" ? t("disableDesc") : undefined}
          onConfirm={async ({ reason: r }) => {
            await api.post(`/staff/${member.id}/status`, { status, reason: r });
            done(t("statusDone"));
          }}
        />
      )}
    </Drawer>
  );
}
