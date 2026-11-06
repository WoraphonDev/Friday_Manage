"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";
import { errorText, SectionError, wsPath } from "./shared";
import { type Identity, type Membership, type MePatch, type ProfileMe, profileKeys } from "./types";
import styles from "./profile.module.css";

interface Form {
  firstName: string;
  lastName: string;
  displayName: string;
  jobTitle: string;
  department: string;
  email: string;
  phone: string;
  timezone: string;
  locale: string;
  yearFormat: "BE" | "CE";
  about: string;
}
const formOf = (me: ProfileMe, m: Membership): Form => ({
  firstName: me.firstName ?? "",
  lastName: me.lastName ?? "",
  displayName: me.displayName,
  jobTitle: m.jobTitle ?? "",
  department: m.department ?? "",
  email: me.email,
  phone: me.phone ?? "",
  timezone: me.timezone,
  locale: me.locale,
  yearFormat: me.yearFormat,
  about: me.about ?? "",
});
const nullable = (v: string) => (v.trim() ? v.trim() : null);

/** ส่งเฉพาะฟิลด์ที่เปลี่ยน · ช่องว่าง = null */
export function profileChanges(before: Form, after: Form) {
  const me: MePatch = {};
  const membership: { jobTitle?: string | null; department?: string | null } = {};
  for (const key of ["firstName", "lastName", "phone", "about"] as const) if (before[key].trim() !== after[key].trim()) me[key] = nullable(after[key]);
  if (before.displayName.trim() !== after.displayName.trim()) me.displayName = after.displayName.trim();
  if (before.timezone !== after.timezone) me.timezone = after.timezone;
  if (before.locale !== after.locale) me.locale = after.locale;
  if (before.yearFormat !== after.yearFormat) me.yearFormat = after.yearFormat;
  for (const key of ["jobTitle", "department"] as const) if (before[key].trim() !== after[key].trim()) membership[key] = nullable(after[key]);
  const email = after.email.trim().toLowerCase() !== before.email.toLowerCase() ? after.email.trim() : null;
  return { me, membership, email };
}

function timezones(current: string) {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const all = [...new Set(["Asia/Bangkok", current, ...zones])];
  const now = new Date();
  return all.map((zone) => {
    try {
      const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;
      return { zone, label: offset ? `${zone} (${offset})` : zone };
    } catch {
      return { zone, label: zone };
    }
  });
}

export function PersonalTab({ ws }: { ws: string }) {
  const t = useTranslations("profile.personal");
  const tc = useTranslations("common.app");
  const { me: shellMe } = useWorkspace();
  const me = shellMe as ProfileMe;
  const cache = useQueryClient();
  const toast = useToast();
  const base = wsPath(ws);
  const membership = useQuery({ queryKey: profileKeys.membership(ws), queryFn: () => api.get<Membership>(`${base}/me/membership`) });
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [pending, setPending] = useState(false);
  const [emailTarget, setEmailTarget] = useState<string | null>(null);
  const initial = useMemo(() => (membership.data ? formOf(me, membership.data) : null), [me, membership.data]);
  useEffect(() => {
    if (initial && !form) setForm(initial);
  }, [initial, form]);
  const zones = useMemo(() => timezones(me.timezone), [me.timezone]);

  if (membership.isPending) return <LoadingState />;
  if (membership.error) return <SectionError error={membership.error} retry={() => membership.refetch()} />;
  if (!form || !initial) return <LoadingState />;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const changes = profileChanges(initial, form);
  const dirty = Object.keys(changes.me).length > 0 || Object.keys(changes.membership).length > 0 || !!changes.email;

  async function save() {
    if (!form || !initial) return;
    if (!form.displayName.trim()) return setErrors({ displayName: t("displayNameRequired") });
    setErrors({});
    setPending(true);
    try {
      if (Object.keys(changes.me).length) {
        const updated = await api.request<ProfileMe>("/me", { method: "PATCH", body: changes.me });
        cache.setQueryData(queryKeys.me, (old: ProfileMe | undefined) => (old ? { ...old, ...updated } : updated));
      }
      if (Object.keys(changes.membership).length) {
        const updated = await api.request<Membership>(`${base}/me/membership`, { method: "PATCH", body: changes.membership });
        cache.setQueryData(profileKeys.membership(ws), updated);
      }
      if (Object.keys(changes.me).length || Object.keys(changes.membership).length) toast({ message: t("saved") });
      // อีเมลใหม่ต้องยืนยันก่อนจึงเปลี่ยนจริง (me/email:change → me/email:confirm)
      if (changes.email) setEmailTarget(changes.email);
      setForm({ ...form, email: initial.email });
    } catch (e) {
      const fields = e instanceof ApiError ? (e.details.fields as { path: string; message: string }[] | undefined) : undefined;
      if (fields?.length) setErrors(Object.fromEntries(fields.map((f) => [f.path, f.message])));
      toast({ message: errorText(e, tc("unknownError")) });
    } finally {
      setPending(false);
    }
  }
  const sample = "2026-12-02";
  return (
    <div className={styles.section}>
      <h2>{t("title")}</h2>
      <div className={styles.grid}>
        <Input label={t("firstName")} value={form.firstName} onChange={(e) => set("firstName", e.target.value)} maxLength={80} error={errors.firstName} />
        <Input label={t("lastName")} value={form.lastName} onChange={(e) => set("lastName", e.target.value)} maxLength={80} error={errors.lastName} />
        <Input label={t("displayName")} value={form.displayName} onChange={(e) => set("displayName", e.target.value)} maxLength={80} error={errors.displayName} />
        <Input label={t("jobTitle")} value={form.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} maxLength={80} error={errors.jobTitle} />
        <Input label={t("department")} value={form.department} onChange={(e) => set("department", e.target.value)} maxLength={80} error={errors.department} />
        <Input label={t("email")} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} hint={me.emailVerified ? t("emailHintVerified") : t("emailHint")} />
        <Input label={t("phone")} type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={30} error={errors.phone} />
        <Select label={t("timezone")} value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
          {zones.map((z) => <option key={z.zone} value={z.zone}>{z.label}</option>)}
        </Select>
        <Select label={t("locale")} value={form.locale} onChange={(e) => set("locale", e.target.value)}>
          <option value="th">{t("localeTh")}</option>
          <option value="en">English</option>
        </Select>
        <Select label={t("yearFormat")} value={form.yearFormat} onChange={(e) => set("yearFormat", e.target.value as "BE" | "CE")} hint={t("datePreview", { date: formatDate(sample, form.yearFormat, true) })}>
          <option value="BE">{t("yearBE")}</option>
          <option value="CE">{t("yearCE")}</option>
        </Select>
        <div className={cn("field", styles.full)}>
          <label htmlFor="profile-about">{t("about")}</label>
          <textarea id="profile-about" className={cn("input", styles.textarea)} value={form.about} maxLength={500} placeholder={t("aboutPlaceholder")} onChange={(e) => set("about", e.target.value)} />
        </div>
      </div>
      <div className={styles.actions}>
        <Button disabled={!dirty || pending} onClick={() => { setForm(initial); setErrors({}); }}>{tc("cancel")}</Button>
        <Button variant="primary" disabled={!dirty || pending} onClick={() => void save()}>{pending ? tc("saving") : tc("save")}</Button>
      </div>
      <EmailChangeDialog email={emailTarget} onClose={() => setEmailTarget(null)} />
    </div>
  );
}

/** เปลี่ยนอีเมล 2 ขั้น: ยืนยันรหัสผ่าน (ถ้ามี) → ใส่รหัส 6 หลักที่ส่งไปอีเมลใหม่ */
function EmailChangeDialog({ email, onClose }: { email: string | null; onClose: () => void }) {
  const t = useTranslations("profile.email");
  const tc = useTranslations("common.app");
  const cache = useQueryClient();
  const toast = useToast();
  const identities = useQuery({ queryKey: profileKeys.identities, queryFn: () => api.get<{ items: Identity[] }>("/me/identities"), enabled: !!email });
  const hasPassword = identities.data?.items.some((i) => i.provider === "password") ?? true;
  const [step, setStep] = useState<"password" | "code">("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setStep("password");
    setPassword("");
    setCode("");
    setError("");
  }, [email]);
  async function run(fn: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, tc("unknownError")));
    } finally {
      setPending(false);
    }
  }
  const request = () =>
    run(async () => {
      await api.post("/me/email:change", { newEmail: email, ...(hasPassword ? { password } : {}) });
      setPassword("");
      setStep("code");
    });
  const confirm = () =>
    run(async () => {
      await api.post("/me/email:confirm", { code: code.trim() });
      await cache.invalidateQueries({ queryKey: queryKeys.me });
      toast({ message: t("changed", { email: email ?? "" }) });
      onClose();
    });
  return (
    <Dialog open={!!email} onOpenChange={(open) => !open && !pending && onClose()} title={t("title")} description={step === "password" ? t("passwordStep", { email: email ?? "" }) : t("codeStep", { email: email ?? "" })}>
      {step === "password" ? (
        hasPassword && <Input label={t("password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      ) : (
        <Input label={t("code")} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <Button disabled={pending} onClick={onClose}>{tc("cancel")}</Button>
        {step === "password" ? (
          <Button variant="primary" disabled={pending || (hasPassword && !password)} onClick={() => void request()}>{t("send")}</Button>
        ) : (
          <Button variant="primary" disabled={pending || code.length !== 6} onClick={() => void confirm()}>{t("confirm")}</Button>
        )}
      </div>
    </Dialog>
  );
}
