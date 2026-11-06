"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Badge, Button, ConfirmDialog, Dialog, Input, LoadingState, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { copyText, errorText, SectionError, wsPath } from "./shared";
import { type Identity, type MfaStatus, type Session, profileKeys } from "./types";
import styles from "./profile.module.css";

/** ชื่ออุปกรณ์อ่านง่ายจาก User-Agent เมื่อ API ไม่มี deviceName */
export function deviceLabel(s: Pick<Session, "deviceName" | "userAgent">) {
  if (s.deviceName) return s.deviceName;
  const ua = s.userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  return [browser, os].filter(Boolean).join(" · ") || null;
}

export function SecurityTab({ ws }: { ws: string }) {
  const t = useTranslations("profile.security");
  const format = useFormatter();
  const cache = useQueryClient();
  const identities = useQuery({ queryKey: profileKeys.identities, queryFn: () => api.get<{ items: Identity[] }>("/me/identities") });
  const mfa = useQuery({ queryKey: profileKeys.mfa, queryFn: () => api.get<MfaStatus>("/me/mfa") });
  const sessions = useQuery({ queryKey: profileKeys.sessions, queryFn: () => api.get<{ items: Session[] }>("/me/sessions") });
  const [password, setPassword] = useState(false);
  const [mfaDialog, setMfaDialog] = useState<"setup" | "disable" | "regenerate" | null>(null);
  const [unlink, setUnlink] = useState<Identity | null>(null);
  const [revoke, setRevoke] = useState<Session | null>(null);
  const [revokeAll, setRevokeAll] = useState(false);

  if (identities.isPending || mfa.isPending) return <LoadingState />;
  const failed = identities.error ?? mfa.error;
  if (failed || !identities.data || !mfa.data) return <SectionError error={failed} retry={() => { void identities.refetch(); void mfa.refetch(); }} />;
  const pw = identities.data.items.find((i) => i.provider === "password");
  const back = `${wsPath(ws)}/profile?tab=sec`;
  const providerName = (p: Identity["provider"]) => ({ password: t("password"), google: "Google", microsoft: "Microsoft", saml: "SAML", oidc: "OIDC" })[p];
  const m = mfa.data;
  return (
    <div className={styles.section}>
      <h2>{t("title")}</h2>
      <div className={styles.kv}>
        <span>{pw ? (pw.passwordChangedAt ? t("passwordChanged", { when: format.relativeTime(new Date(pw.passwordChangedAt), new Date()) }) : t("password")) : t("noPassword")}</span>
        <Button size="small" onClick={() => setPassword(true)}>{pw ? t("changePassword") : t("setPassword")}</Button>
      </div>
      <div className={styles.kv}>
        <span>
          {t("mfa")}
          {m.enabled && <span className={cn(styles.muted, styles.small)}> · {t("backupLeft", { count: m.backupCodesLeft })}</span>}
        </span>
        <span className={styles.rowEnd}>
          <Badge tone={m.enabled ? "green" : "neutral"}>{m.enabled ? t("mfaOn") : t("mfaOff")}</Badge>
          {m.enabled ? (
            <>
              <Button size="small" onClick={() => setMfaDialog("regenerate")}>{t("regenerate")}</Button>
              {m.requiredByPolicy ? <span className={cn(styles.muted, styles.small)}>{t("requiredByPolicy")}</span> : <Button size="small" className={styles.danger} onClick={() => setMfaDialog("disable")}>{t("disable")}</Button>}
            </>
          ) : (
            <Button size="small" variant="primary" onClick={() => setMfaDialog("setup")}>{t("enable")}</Button>
          )}
        </span>
      </div>
      {(["google", "microsoft"] as const).map((provider) => {
        const linked = identities.data.items.find((i) => i.provider === provider);
        return (
          <div className={styles.kv} key={provider}>
            <span>{t("loginWith", { provider: providerName(provider) })}</span>
            <span className={styles.rowEnd}>
              {linked ? (
                <>
                  <Badge tone="green">{t("linked")}</Badge>
                  {linked.canDelete && <Button size="small" variant="ghost" className={styles.danger} onClick={() => setUnlink(linked)}>{t("unlink")}</Button>}
                </>
              ) : (
                // ผูกผ่าน OAuth (mode=link) แล้วกลับมาที่แท็บนี้
                <a className="button button-secondary button-small" href={`/api/v1/auth/oauth/${provider}/start?mode=link&next=${encodeURIComponent(back)}`}>{t("link")}</a>
              )}
            </span>
          </div>
        );
      })}

      <div className={styles.lb} style={{ marginTop: 8 }}>{t("devices")}</div>
      {sessions.isPending ? (
        <LoadingState />
      ) : sessions.error ? (
        <SectionError error={sessions.error} retry={() => sessions.refetch()} />
      ) : (
        <>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("devices")}>
            {sessions.data.items.map((s) => (
              <li className={styles.kv} key={s.id}>
                <span>
                  {[deviceLabel(s) ?? t("unknownDevice"), s.location].filter(Boolean).join(" · ")} {s.current && <Badge tone="blue">{t("thisDevice")}</Badge>}
                </span>
                {s.current ? (
                  <span className={styles.muted}>{t("now")}</span>
                ) : (
                  <span className={styles.rowEnd}>
                    <span className={cn(styles.muted, styles.small)}>{format.relativeTime(new Date(s.lastSeenAt), new Date())}</span>
                    <Button size="small" className={styles.danger} aria-label={t("signOutLabel", { device: deviceLabel(s) ?? t("unknownDevice") })} onClick={() => setRevoke(s)}>{t("signOut")}</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {sessions.data.items.some((s) => !s.current) && <Button style={{ alignSelf: "flex-start" }} className={styles.danger} onClick={() => setRevokeAll(true)}>{t("signOutOthers")}</Button>}
        </>
      )}

      <PasswordDialog open={password} onOpenChange={setPassword} hasPassword={!!pw} />
      <MfaDialog mode={mfaDialog} onClose={() => setMfaDialog(null)} />
      <ConfirmDialog
        open={!!unlink}
        onOpenChange={(open) => !open && setUnlink(null)}
        title={t("unlinkTitle", { provider: unlink ? providerName(unlink.provider) : "" })}
        description={t("unlinkDescription")}
        confirmLabel={t("unlink")}
        successMessage={t("unlinked")}
        onConfirm={async () => {
          await api.delete(`/me/identities/${unlink!.id}`);
          await cache.invalidateQueries({ queryKey: profileKeys.identities });
        }}
      />
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(open) => !open && setRevoke(null)}
        title={t("signOutTitle")}
        description={revoke ? (deviceLabel(revoke) ?? t("unknownDevice")) : undefined}
        confirmLabel={t("signOut")}
        successMessage={t("signedOut")}
        onConfirm={async () => {
          await api.delete(`/me/sessions/${revoke!.id}`);
          await cache.invalidateQueries({ queryKey: profileKeys.sessions });
        }}
      />
      <ConfirmDialog
        open={revokeAll}
        onOpenChange={setRevokeAll}
        title={t("signOutOthersTitle")}
        description={t("signOutOthersDescription")}
        confirmLabel={t("signOutOthers")}
        successMessage={t("signedOutOthers")}
        onConfirm={async () => {
          await api.delete("/me/sessions");
          await cache.invalidateQueries({ queryKey: profileKeys.sessions });
        }}
      />
    </div>
  );
}

function PasswordDialog({ open, onOpenChange, hasPassword }: { open: boolean; onOpenChange: (open: boolean) => void; hasPassword: boolean }) {
  const t = useTranslations("profile.password");
  const tc = useTranslations("common.app");
  const cache = useQueryClient();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [logoutOthers, setLogoutOthers] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const close = () => {
    // ไม่เก็บรหัสผ่านค้างไว้หลังปิด
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
    setLogoutOthers(true);
    onOpenChange(false);
  };
  const mismatch = !!confirm && next !== confirm;
  async function submit() {
    setPending(true);
    setError("");
    try {
      const r = await api.post<{ loggedOutSessions: number }>("/me/password:change", { ...(hasPassword ? { currentPassword: current } : {}), newPassword: next, logoutOthers });
      await cache.invalidateQueries({ queryKey: profileKeys.identities });
      await cache.invalidateQueries({ queryKey: profileKeys.sessions });
      toast({ message: r.loggedOutSessions ? t("changedLoggedOut", { count: r.loggedOutSessions }) : t("changed") });
      close();
    } catch (e) {
      setError(errorText(e, tc("unknownError")));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : !pending && close())} title={hasPassword ? t("title") : t("setTitle")} description={hasPassword ? undefined : t("setDescription")}>
      {hasPassword && <Input label={t("current")} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      <Input label={t("new")} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint={t("hint")} />
      <Input label={t("confirm")} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? t("mismatch") : undefined} />
      <label className={styles.check}><input type="checkbox" checked={logoutOthers} onChange={(e) => setLogoutOthers(e.target.checked)} />{t("logoutOthers")}</label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <Button disabled={pending} onClick={close}>{tc("cancel")}</Button>
        <Button variant="primary" disabled={pending || !next || next !== confirm || (hasPassword && !current)} onClick={() => void submit()}>{pending ? tc("saving") : tc("save")}</Button>
      </div>
    </Dialog>
  );
}

/**
 * 2FA: setup → ยืนยันรหัสแรก → แสดง Backup code ครั้งเดียว · ปิด / ออกชุดใหม่ต้องใส่รหัส
 * secret และ Backup code อยู่แค่ใน state ของ Dialog นี้ ปิดแล้วล้างทิ้ง ไม่เก็บใน cache
 */
function MfaDialog({ mode, onClose }: { mode: "setup" | "disable" | "regenerate" | null; onClose: () => void }) {
  const t = useTranslations("profile.mfa");
  const tc = useTranslations("common.app");
  const cache = useQueryClient();
  const toast = useToast();
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState<typeof mode>(null);
  if (mode !== started) {
    // เปิด Dialog ใหม่ทุกครั้งเริ่มจากศูนย์
    setStarted(mode);
    setSecret(null);
    setCodes(null);
    setCode("");
    setError("");
  }
  const close = () => {
    setSecret(null);
    setCodes(null);
    setCode("");
    onClose();
  };
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
  const begin = () => run(async () => setSecret(await api.post<{ secret: string; otpauthUrl: string }>("/me/mfa:setup")));
  const enable = () =>
    run(async () => {
      const r = await api.post<{ backupCodes: string[] }>("/me/mfa:enable", { code: code.trim() });
      setSecret(null);
      setCode("");
      setCodes(r.backupCodes);
      await cache.invalidateQueries({ queryKey: profileKeys.mfa });
    });
  const disable = () =>
    run(async () => {
      await api.post("/me/mfa:disable", { code: code.trim() });
      await cache.invalidateQueries({ queryKey: profileKeys.mfa });
      toast({ message: t("disabled") });
      close();
    });
  const regenerate = () =>
    run(async () => {
      const r = await api.post<{ backupCodes: string[] }>("/me/mfa/backup-codes:regenerate", { code: code.trim() });
      setCode("");
      setCodes(r.backupCodes);
      await cache.invalidateQueries({ queryKey: profileKeys.mfa });
    });
  const title = mode === "disable" ? t("disableTitle") : mode === "regenerate" ? t("regenerateTitle") : t("setupTitle");
  const codeInput = <Input label={t("code")} inputMode="numeric" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />;
  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && !pending && close()} title={title}>
      {codes ? (
        <>
          <p className={styles.muted}>{t("backupIntro")}</p>
          <ul className={styles.backupCodes} aria-label={t("backupLabel")}>
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="dialog-actions">
            <Button onClick={() => void copyText(codes.join("\n")).then(() => toast({ message: t("copied") }), () => undefined)}>{t("copy")}</Button>
            <Button variant="primary" onClick={close}>{t("savedCodes")}</Button>
          </div>
        </>
      ) : mode === "setup" ? (
        secret ? (
          <>
            <p className={styles.muted}>{t("scan")}</p>
            <div className={styles.secret} aria-label={t("secretLabel")}>{secret.secret.replace(/(.{4})/g, "$1 ").trim()}</div>
            <a href={secret.otpauthUrl} className="button button-secondary button-small" style={{ alignSelf: "flex-start" }}>{t("openApp")}</a>
            {codeInput}
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button disabled={pending} onClick={close}>{tc("cancel")}</Button>
              <Button variant="primary" disabled={pending || code.trim().length < 6} onClick={() => void enable()}>{t("verify")}</Button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.muted}>{t("intro")}</p>
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button disabled={pending} onClick={close}>{tc("cancel")}</Button>
              <Button variant="primary" disabled={pending} onClick={() => void begin()}>{t("start")}</Button>
            </div>
          </>
        )
      ) : (
        <>
          <p className={styles.muted}>{mode === "disable" ? t("disableIntro") : t("regenerateIntro")}</p>
          {codeInput}
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <Button disabled={pending} onClick={close}>{tc("cancel")}</Button>
            <Button variant={mode === "disable" ? "danger" : "primary"} disabled={pending || code.trim().length < 6} onClick={() => void (mode === "disable" ? disable() : regenerate())}>
              {mode === "disable" ? t("disableConfirm") : t("regenerateConfirm")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
