"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { destinationAfterLogin } from "../../_components/navigation";
import {
  FormAlert,
  Heading,
  NS,
  OAuthLink,
  OtpInput,
  PasswordField,
  SplitLayout,
  safeReturnTo,
  styles,
} from "../../_components/shared";

type LoginResult = { id: string } | { mfaRequired: true; mfaToken: string; email: string };
interface Mfa {
  token: string;
  email: string;
}

const OAUTH_ERRORS = [
  "oauth_cancelled",
  "oauth_state_mismatch",
  "oauth_session_changed",
  "oauth_email_missing",
  "oauth_email_unverified",
  "account_disabled",
  "oauth_failed",
] as const;

export function LoginForm() {
  const t = useTranslations(NS);
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [returnTo, setReturnTo] = useState(() => safeReturnTo(params.get("returnTo") ?? params.get("next")));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [mfa, setMfa] = useState<Mfa | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ email?: boolean; password?: boolean }>({});

  const oauthError = params.get("error");
  const oauthMessage = OAUTH_ERRORS.find((code) => code === oauthError);

  // OAuth ที่เปิด 2FA ส่ง mfaToken มาใน fragment (#) เพื่อไม่ให้ token ติด log ของเซิร์ฟเวอร์
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const token = hash.get("mfaToken");
    if (!token) return;
    setMfa({ token, email: hash.get("email") ?? "" });
    const next = safeReturnTo(hash.get("next"));
    if (next && next !== "/") setReturnTo(next);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  async function finish() {
    router.replace(await destinationAfterLogin(returnTo));
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    const empty = { email: !email.trim(), password: !password };
    setMissing(empty);
    if (empty.email || empty.password) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<LoginResult>("/auth/login", { email, password, remember });
      if ("mfaRequired" in result) {
        setMfa({ token: result.mfaToken, email: result.email });
        setCode("");
        setBusy(false);
        return;
      }
      await finish();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    if (!mfa) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ id: string; backupCodesLeft?: number }>("/auth/login/mfa", {
        mfaToken: mfa.token,
        code: backup ? code.trim() : code,
        trustDevice: trust,
      });
      if (result.backupCodesLeft !== undefined)
        toast({ message: t("login.backupLeft", { count: result.backupCodesLeft }) });
      await finish();
    } catch (err) {
      // mfaToken หมดอายุ (5 นาที) ต้องเริ่มใหม่ที่ขั้นรหัสผ่าน
      if (err instanceof ApiError && err.code === "mfa_token_invalid") {
        setMfa(null);
        setBackup(false);
        setCode("");
        setNotice(t("login.mfaExpired"));
        setBusy(false);
        return;
      }
      setError(err);
      setBusy(false);
    }
  }

  function loginError() {
    if (!(error instanceof ApiError)) return undefined;
    if (error.code === "invalid_credentials") {
      const left = error.details.attemptsLeft;
      const minutes = error.details.lockoutMinutes;
      return typeof left === "number" && typeof minutes === "number" && left > 0
        ? t("login.attemptsLeft", { left, minutes })
        : t("login.invalid");
    }
    if (error.code === "account_locked") {
      const until = typeof error.details.lockedUntil === "string" ? new Date(error.details.lockedUntil) : null;
      return until && !Number.isNaN(until.getTime())
        ? t("login.locked", {
            time: until.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }),
          })
        : t("login.lockedNow");
    }
    if (error.code === "invalid_mfa_code") return t("login.mfaInvalid");
    return undefined;
  }

  if (mfa) {
    const complete = backup ? code.trim().length >= 6 : code.length === 6;
    return (
      <SplitLayout variant="login">
        <button
          type="button"
          className={cn(styles.linkButton, styles.backLink)}
          onClick={() => {
            setMfa(null);
            setBackup(false);
            setError(null);
            setCode("");
          }}
        >
          {t("common.back")}
        </button>
        <Heading
          title={backup ? t("login.backupTitle") : t("login.mfaTitle")}
          subtitle={
            backup
              ? t("login.backupSubtitle", { email: mfa.email })
              : t("login.mfaSubtitle", { email: mfa.email })
          }
        />
        <form className={styles.form} onSubmit={submitMfa} noValidate>
          {!!error && <FormAlert error={error} message={loginError()} />}
          {backup ? (
            <Input
              label={t("login.backupLabel")}
              className={styles.input}
              value={code}
              autoComplete="one-time-code"
              autoFocus
              onChange={(event) => setCode(event.target.value)}
            />
          ) : (
            <OtpInput value={code} onChange={setCode} invalid={!!error} autoFocus />
          )}
          <label className={styles.check}>
            <input type="checkbox" checked={trust} onChange={(event) => setTrust(event.target.checked)} />
            {t("login.trustDevice")}
          </label>
          <Button type="submit" variant="primary" className={styles.button} disabled={busy || !complete}>
            {busy ? t("common.working") : t("login.mfaSubmit")}
          </Button>
        </form>
        <div className={cn(styles.muted, styles.small, styles.center)}>
          {backup ? null : <>{t("login.noApp")} </>}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setBackup(!backup);
              setCode("");
              setError(null);
            }}
          >
            {backup ? t("login.useApp") : t("login.useBackup")}
          </button>
        </div>
      </SplitLayout>
    );
  }

  return (
    <SplitLayout variant="login">
      <Heading title={t("login.title")} subtitle={t("login.subtitle")} />
      <form className={styles.form} onSubmit={submitPassword} noValidate>
        {notice && <FormAlert tone="info" message={notice} />}
        {oauthMessage && !error && <FormAlert message={t(`login.oauthErrors.${oauthMessage}`)} />}
        {!!error && <FormAlert error={error} message={loginError()} />}
        <Input
          label={t("common.email")}
          className={styles.input}
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          error={missing.email ? t("signup.required") : undefined}
          aria-invalid={missing.email || (error instanceof ApiError && error.code === "invalid_credentials") ? true : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
        <PasswordField
          label={t("common.password")}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          labelExtra={<Link href="/forgot-password">{t("login.forgot")}</Link>}
          error={missing.password ? t("signup.required") : undefined}
          invalid={error instanceof ApiError && error.code === "invalid_credentials"}
        />
        <label className={styles.check}>
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          {t("login.remember")}
        </label>
        <Button type="submit" variant="primary" className={styles.button} disabled={busy}>
          {busy ? t("common.working") : t("login.submit")}
        </Button>
      </form>
      <div className={styles.or}>{t("common.or")}</div>
      <OAuthLink provider="google" label={t("login.google")} next={returnTo ?? undefined} remember={remember} />
      <OAuthLink provider="microsoft" label={t("login.microsoft")} next={returnTo ?? undefined} remember={remember} />
      {/* SSO / SAML ยังไม่วางเป็นงาน (docs/tasks/README.md) จึงแสดงตาม Canvas แต่ปิดไว้ */}
      <Button className={styles.button} disabled aria-describedby="sso-soon">
        {t("login.sso")}
      </Button>
      <span id="sso-soon" className={cn(styles.muted, styles.tiny, styles.center)} style={{ marginTop: -10 }}>
        {t("common.comingSoon")}
      </span>
      <div className={cn(styles.muted, styles.center)}>
        {t("login.noAccount")}{" "}
        <Link href={returnTo ? `/signup?returnTo=${encodeURIComponent(returnTo)}` : "/signup"} style={{ fontWeight: 600 }}>
          {t("login.signup")}
        </Link>
      </div>
    </SplitLayout>
  );
}
