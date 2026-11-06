"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Check, LockKeyhole, Mail, Unlink } from "lucide-react";
import { Button, Input, LoadingState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CardLayout,
  FormAlert,
  Heading,
  NS,
  PasswordField,
  PasswordStrength,
  checkPassword,
  styles,
  useCountdown,
  type PasswordPolicy,
} from "../../_components/shared";

function Dots({ step }: { step: 1 | 2 | 3 }) {
  const t = useTranslations(NS);
  return (
    <div className={styles.dots} role="img" aria-label={t("forgot.stepLabel", { step })}>
      {[1, 2, 3].map((n) => (
        <span key={n} data-state={n === step ? "on" : n < step ? "done" : undefined} />
      ))}
    </div>
  );
}

function Help() {
  const t = useTranslations(NS);
  return <div className={cn(styles.muted, styles.tiny)}>{t("forgot.help")}</div>;
}

export function ForgotPasswordFlow() {
  const token = useSearchParams().get("token");
  return token ? <ResetPassword token={token} /> : <RequestLink />;
}

/** ขั้นที่ 1–2 · ขอลิงก์ (API ตอบ 202 เสมอ ไม่บอกว่ามีบัญชีหรือไม่) */
function RequestLink() {
  const t = useTranslations(NS);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const countdown = useCountdown();

  async function send(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ retryAfter: number }>("/auth/password/forgot", { email: email.trim() });
      setSent(true);
      countdown.start(result.retryAfter ?? 60);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <CardLayout footer={<Help />}>
        <Dots step={2} />
        <span className={cn(styles.icon, styles.iconGreen)}>
          <Mail size={28} aria-hidden="true" />
        </span>
        <Heading
          title={t("forgot.sentTitle")}
          subtitle={t.rich("forgot.sentSubtitle", {
            email: email.trim(),
            b: (chunks) => <b className={styles.strong}>{chunks}</b>,
          })}
        />
        {!!error && <FormAlert error={error} />}
        <div className={styles.row}>
          <a className={cn("button", styles.button)} href="https://mail.google.com" target="_blank" rel="noreferrer">
            {t("forgot.openGmail")}
          </a>
          <a className={cn("button", styles.button)} href="https://outlook.live.com/mail" target="_blank" rel="noreferrer">
            {t("forgot.openOutlook")}
          </a>
        </div>
        <div className={cn(styles.muted, styles.small)}>
          {t("forgot.notReceived")}{" "}
          {countdown.left > 0 ? (
            t.rich("common.resendIn", { time: countdown.label, b: (chunks) => <b>{chunks}</b> })
          ) : (
            <button type="button" className={styles.linkButton} onClick={() => send()} disabled={busy}>
              {t("forgot.resendLink")}
            </button>
          )}{" "}
          ·{" "}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => {
              setSent(false);
              setError(null);
            }}
          >
            {t("forgot.otherEmail")}
          </button>
        </div>
      </CardLayout>
    );

  return (
    <CardLayout footer={<Help />}>
      <Dots step={1} />
      <span className={cn(styles.icon, styles.iconBlue)}>
        <LockKeyhole size={28} aria-hidden="true" />
      </span>
      <Heading title={t("forgot.title")} subtitle={t("forgot.subtitle")} />
      <form className={styles.form} onSubmit={send} noValidate>
        {!!error && <FormAlert error={error} />}
        <Input
          label={t("common.email")}
          className={styles.input}
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" variant="primary" className={styles.button} disabled={busy || !email.trim()}>
          {busy ? t("common.working") : t("forgot.submit")}
        </Button>
      </form>
      <Link href="/login" className={styles.center}>
        {t("forgot.backToLogin")}
      </Link>
    </CardLayout>
  );
}

interface ResetInfo {
  email: string;
  expiresAt: string;
  policy: PasswordPolicy;
}

/** ขั้นที่ 3–4 · เปิดจากลิงก์ในอีเมล /forgot-password?token=… */
function ResetPassword({ token }: { token: string }) {
  const t = useTranslations(NS);
  const router = useRouter();
  const info = useQuery({
    queryKey: ["auth", "reset", token],
    queryFn: () => api.get<ResetInfo>(`/auth/password/reset?token=${encodeURIComponent(token)}`),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [logoutAll, setLogoutAll] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  if (info.isPending)
    return (
      <CardLayout footer={<Help />}>
        <LoadingState />
      </CardLayout>
    );

  const linkInvalid =
    (info.error instanceof ApiError && info.error.code === "invalid_token") ||
    (error instanceof ApiError && error.code === "invalid_token");
  if (info.isError || linkInvalid)
    return (
      <CardLayout footer={<Help />}>
        <span className={cn(styles.icon, styles.iconRed)}>
          <Unlink size={28} aria-hidden="true" />
        </span>
        {linkInvalid ? (
          <Heading title={t("forgot.linkInvalidTitle")} subtitle={t("forgot.linkInvalidSubtitle")} />
        ) : (
          <FormAlert error={info.error} />
        )}
        <Button variant="primary" className={styles.button} onClick={() => router.replace("/forgot-password")}>
          {t("forgot.requestNew")}
        </Button>
      </CardLayout>
    );

  if (done)
    return (
      <CardLayout footer={<Help />}>
        <span className={cn(styles.icon, styles.iconGreen)}>
          <Check size={28} strokeWidth={2.5} aria-hidden="true" />
        </span>
        <Heading title={t("forgot.doneTitle")} subtitle={t("forgot.doneSubtitle")} />
        <Link href="/login" className={cn("button button-primary", styles.button)}>
          {t("forgot.login")}
        </Link>
      </CardLayout>
    );

  const policy = info.data.policy;
  const strong = checkPassword(password, policy).valid;
  const matches = confirm.length > 0 && confirm === password;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/reset", { token, newPassword: password, logoutAll });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardLayout footer={<Help />}>
      <Dots step={3} />
      <Heading title={t("forgot.resetTitle")} subtitle={t("forgot.resetSubtitle", { email: info.data.email })} />
      <form className={styles.form} onSubmit={save} noValidate>
        {!!error && <FormAlert error={error} />}
        <div className={styles.field}>
          <PasswordField
            label={t("forgot.newPassword")}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            autoFocus
          />
          <PasswordStrength value={password} policy={policy} showMeter={false} />
        </div>
        <PasswordField
          label={t("forgot.confirmPassword")}
          name="confirm"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          error={confirm && !matches ? t("forgot.mismatch") : undefined}
          hint={matches ? <span className={styles.ok}>{t("forgot.match")}</span> : undefined}
        />
        <label className={cn(styles.check, styles.small)}>
          <input type="checkbox" checked={logoutAll} onChange={(event) => setLogoutAll(event.target.checked)} />
          {t("forgot.logoutAll")}
        </label>
        <Button type="submit" variant="primary" className={styles.button} disabled={busy || !strong || !matches}>
          {busy ? t("common.working") : t("forgot.save")}
        </Button>
      </form>
    </CardLayout>
  );
}
