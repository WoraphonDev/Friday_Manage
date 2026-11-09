"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Mail } from "lucide-react";
import { Button, Input, LoadingState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { destinationAfterLogin } from "../../_components/navigation";
import {
  CardLayout,
  FormAlert,
  Heading,
  NS,
  OAuthLink,
  OtpInput,
  PasswordField,
  PasswordStrength,
  SplitLayout,
  checkPassword,
  safeReturnTo,
  styles,
  useCountdown,
} from "../../_components/shared";

type Field = "displayName" | "email" | "password" | "acceptTerms";
type Errors = Partial<Record<Field, string>>;

/** 400 invalid_input ส่ง details.fields: [{ path, message }] */
function fieldErrors(error: unknown): Errors {
  if (!(error instanceof ApiError) || !Array.isArray(error.details.fields)) return {};
  const out: Errors = {};
  for (const item of error.details.fields as { path?: string; message?: string }[]) {
    if (item.path && ["displayName", "email", "password", "acceptTerms"].includes(item.path))
      out[item.path as Field] ??= item.message;
  }
  return out;
}

export function SignupForm() {
  const params = useSearchParams();
  const token = params.get("token");
  return token ? <VerifyLink token={token} /> : <SignupFlow />;
}

function SignupFlow() {
  const t = useTranslations(NS);
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const [step, setStep] = useState<"form" | "verify">("form");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // ขั้นยืนยันอีเมล
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"verify" | "change">("verify");
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  // false = ระบบยังไม่ได้ตั้ง SMTP รหัสยืนยันจึงไม่ถูกส่ง · ให้ข้ามไปก่อนแล้วยืนยันภายหลังได้ (ผู้ใช้ขอ 2026-11-09)
  const [emailDelivery, setEmailDelivery] = useState(true);
  const countdown = useCountdown();

  function validate(): Errors {
    const out: Errors = {};
    if (!displayName.trim()) out.displayName = t("signup.required");
    // ไม่รับช่องว่าง , ; ในอีเมล (เช่น "tang@gg.co," จากการคัดลอก) · ว่าง = ต้องกรอก
    if (!email.trim()) out.email = t("signup.required");
    else if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(email.trim())) out.email = t("signup.invalidEmail");
    if (!checkPassword(password).valid) out.password = t("password.tooWeak");
    if (!accept) out.acceptTerms = t("signup.mustAccept");
    return out;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const local = validate();
    setErrors(local);
    setError(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const created = await api.post<{ emailDelivery?: boolean }>("/auth/signup", {
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        acceptTerms: true,
      });
      setEmailDelivery(created?.emailDelivery !== false);
      setStep("verify");
      setCode("");
      countdown.start(60);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // เปลี่ยนอีเมลระหว่างยืนยัน: รหัสถูกส่งไปที่อีเมลใหม่และยืนยันผ่าน me/email:confirm
      if (mode === "change") await api.post("/me/email:confirm", { code });
      else await api.post("/auth/verify-email", { code });
      router.replace(returnTo ?? "/onboarding");
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setInfo(null);
    try {
      const result =
        mode === "change"
          ? await api.post<{ retryAfter: number }>("/me/email:change", { newEmail: email, password })
          : await api.post<{ retryAfter: number; emailDelivery?: boolean }>("/auth/verify-email:resend", {});
      if ("emailDelivery" in result && result.emailDelivery === false) setEmailDelivery(false);
      countdown.start(result.retryAfter ?? 60);
      setInfo(t("common.resent"));
    } catch (err) {
      if (err instanceof ApiError && typeof err.details.retryAfter === "number") countdown.start(err.details.retryAfter);
      setError(err);
    }
  }

  async function changeEmail(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await api.post<{ pendingEmail: string; retryAfter: number }>("/me/email:change", {
        newEmail: newEmail.trim(),
        password,
      });
      setEmail(result.pendingEmail);
      setMode("change");
      setChanging(false);
      setCode("");
      countdown.start(result.retryAfter ?? 60);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (step === "verify") {
    const invalidCode = error instanceof ApiError && error.code === "invalid_token";
    return (
      <SplitLayout variant="signup">
        <span className={cn(styles.icon, styles.iconBlue)}>
          <Mail size={28} aria-hidden="true" />
        </span>
        <Heading
          title={t("signup.verifyTitle")}
          subtitle={t.rich("signup.verifySubtitle", {
            email,
            b: (chunks) => <b className={styles.strong}>{chunks}</b>,
          })}
        />
        {changing ? (
          <form className={styles.form} onSubmit={changeEmail} noValidate>
            {!!error && <FormAlert error={error} />}
            <Input
              label={t("signup.newEmail")}
              className={styles.input}
              type="email"
              autoComplete="email"
              autoFocus
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
            />
            <div className={styles.row}>
              <Button className={styles.button} onClick={() => setChanging(false)}>
                {t("signup.cancel")}
              </Button>
              <Button type="submit" variant="primary" className={styles.button} disabled={busy || !newEmail.trim()}>
                {t("signup.sendToNewEmail")}
              </Button>
            </div>
          </form>
        ) : (
          <form className={styles.form} onSubmit={verify} noValidate>
            {!emailDelivery && <FormAlert tone="info" message={t("signup.noDelivery")} />}
            {info && <FormAlert tone="success" message={info} />}
            {!!error && <FormAlert error={error} message={invalidCode ? t("signup.codeInvalid") : undefined} />}
            <OtpInput value={code} onChange={setCode} invalid={invalidCode} autoFocus />
            <Button type="submit" variant="primary" className={styles.button} disabled={busy || code.length !== 6}>
              {busy ? t("common.working") : t("signup.verifySubmit")}
            </Button>
            {!emailDelivery && (
              // ยังส่งอีเมลไม่ได้: บัญชีใช้งานได้แล้ว (API ไม่บังคับยืนยัน) ยืนยันอีเมลภายหลังได้เมื่อเปิดระบบอีเมล
              <Button className={styles.button} disabled={busy} onClick={() => router.replace(returnTo ?? "/onboarding")}>
                {t("signup.skipVerify")}
              </Button>
            )}
            <div className={cn(styles.muted, styles.small)}>
              {t("signup.noEmail")}{" "}
              {countdown.left > 0 ? (
                <span>{t.rich("common.resendIn", { time: countdown.label, b: (chunks) => <b>{chunks}</b> })}</span>
              ) : (
                <button type="button" className={styles.linkButton} onClick={resend}>
                  {t("common.resend")}
                </button>
              )}{" "}
              · {t("common.checkSpam")} ·{" "}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setChanging(true);
                  setNewEmail("");
                  setError(null);
                  setInfo(null);
                }}
              >
                {t("signup.changeEmail")}
              </button>
            </div>
          </form>
        )}
      </SplitLayout>
    );
  }

  const emailTaken = error instanceof ApiError && error.code === "email_taken";
  const loginHref = returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login";
  return (
    <SplitLayout variant="signup">
      <Heading
        title={t("signup.title")}
        subtitle={
          <>
            {t("signup.hasAccount")}{" "}
            <Link href={loginHref} style={{ fontWeight: 600 }}>
              {t("signup.login")}
            </Link>
          </>
        }
      />
      <OAuthLink provider="google" label={t("signup.google")} next={returnTo ?? "/onboarding"} />
      <div className={styles.or}>{t("signup.orEmail")}</div>
      <form className={styles.form} onSubmit={submit} noValidate>
        {!!error && !emailTaken && <FormAlert error={error} />}
        <Input
          label={t("signup.displayName")}
          className={styles.input}
          placeholder={t("signup.displayNamePlaceholder")}
          autoComplete="nickname"
          value={displayName}
          error={errors.displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div className={styles.field}>
          <Input
            label={t("signup.workEmail")}
            className={styles.input}
            type="email"
            autoComplete="email"
            value={email}
            error={emailTaken ? t("signup.emailTaken") : errors.email}
            hint={t("signup.workEmailHint")}
            onChange={(event) => setEmail(event.target.value)}
          />
          {emailTaken && (
            <Link href={loginHref} className={styles.small}>
              {t("signup.loginInstead")}
            </Link>
          )}
        </div>
        <div className={styles.field}>
          <PasswordField
            label={t("common.password")}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            error={errors.password}
          />
          <PasswordStrength value={password} />
        </div>
        <div className={styles.field}>
          <label className={cn(styles.check, styles.small)}>
            <input
              type="checkbox"
              checked={accept}
              aria-invalid={errors.acceptTerms ? true : undefined}
              onChange={(event) => setAccept(event.target.checked)}
            />
            <span>
              {t.rich("signup.acceptTerms", {
                terms: (chunks) => (
                  <Link href="/legal/terms" target="_blank">
                    {chunks}
                  </Link>
                ),
                privacy: (chunks) => (
                  <Link href="/legal/privacy" target="_blank">
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          </label>
          {errors.acceptTerms && (
            <span className="field-error" role="alert">
              {errors.acceptTerms}
            </span>
          )}
        </div>
        <Button type="submit" variant="primary" className={styles.button} disabled={busy}>
          {busy ? t("common.working") : t("signup.submit")}
        </Button>
      </form>
    </SplitLayout>
  );
}

/** ลิงก์ในอีเมล: /signup?token=… ยืนยันอีเมลตอนสมัคร หรืออีเมลใหม่ (me/email:change) */
function VerifyLink({ token }: { token: string }) {
  const t = useTranslations(NS);
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const sent = useRef(false);
  useEffect(() => {
    // ลิงก์ใช้ได้ครั้งเดียว · กัน StrictMode เรียกซ้ำ
    if (sent.current) return;
    sent.current = true;
    api
      .post("/auth/verify-email", { token })
      .then(() => setState("ok"))
      .catch((err) => {
        setError(err);
        setState("error");
      });
  }, [token]);

  if (state === "loading")
    return (
      <CardLayout>
        <Heading title={t("signup.linkVerifying")} />
        <LoadingState />
      </CardLayout>
    );
  if (state === "error")
    return (
      <CardLayout>
        <Heading title={t("signup.linkInvalid")} subtitle={t("signup.linkInvalidDescription")} />
        <FormAlert error={error} />
        <Link href="/login" className={cn("button button-primary", styles.button)}>
          {t("signup.goLogin")}
        </Link>
      </CardLayout>
    );
  return (
    <CardLayout>
      <Heading title={t("signup.linkVerified")} subtitle={t("signup.linkVerifiedDescription")} />
      <Button
        variant="primary"
        className={styles.button}
        onClick={async () => router.replace(await destinationAfterLogin(returnTo))}
      >
        {t("signup.continue")}
      </Button>
    </CardLayout>
  );
}
