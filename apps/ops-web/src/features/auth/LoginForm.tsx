"use client";

import { FridayMark } from "@/components/brand/FridayMark";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { InlineError, Input } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { keys } from "@/lib/query";
import type { Staff } from "@/lib/types";
import { LOGIN_SUCCESS_MS, LoginSuccess, motionPause, shake, slideOut, SUBMIT_DONE_MS, SubmitButton } from "./motion";
import { loginWithCode, loginWithPassword } from "./password";
import { keyErrorKind, loginWithKey } from "./webauthn";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * เข้าสู่ระบบหลังบ้าน · วิธีหลัก: อีเมล + รหัสผ่าน → รหัส 6 หลักจากแอป Authenticator (ใช้ได้ทุกเครื่องและโหมดไม่ระบุตัวตน)
 * Passkey / Security key เป็นทางลัดบนเครื่องที่ลงทะเบียนไว้
 */
export function LoginForm() {
  const t = useTranslations("ops.auth");
  const tApp = useTranslations("ops.app");
  const tc = useTranslations("common.auth");
  const router = useRouter();
  const cache = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfa, setMfa] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<{ email?: boolean; password?: boolean }>({});
  const [busy, setBusy] = useState<"submit" | "key" | null>(null);
  const [done, setDone] = useState<"submit" | "key" | null>(null);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // ตรวจหลัง mount เท่านั้น: server render ไม่มี window.PublicKeyCredential
  const [keySupported, setKeySupported] = useState(true);
  useEffect(() => setKeySupported(browserSupportsWebAuthn()), []);
  // ผิดแล้วฟอร์มสั่น · error เป็น object ใหม่ทุกครั้ง จึงสั่นซ้ำได้
  useEffect(() => {
    if (error) shake(form.current);
  }, [error]);

  /** ปุ่มเขียว → ฟอร์มเลื่อนออก → หน้าจอสำเร็จจนแถบเต็ม → เข้าหน้าหลัก (เหมือนแอปลูกค้า) */
  async function finish(staff: Staff, via: "submit" | "key") {
    cache.setQueryData(keys.me, staff);
    router.prefetch("/");
    setBusy(null);
    setDone(via);
    await motionPause(SUBMIT_DONE_MS);
    const leaving = await slideOut(form.current);
    flushSync(() => setSuccess(true));
    leaving?.cancel();
    await motionPause(LOGIN_SUCCESS_MS);
    router.replace("/");
  }

  async function attempt(via: "submit" | "key", fn: () => Promise<Staff | void>) {
    setBusy(via);
    setError(null);
    try {
      const staff = await fn();
      if (staff) await finish(staff, via);
      else setBusy(null);
    } catch (e) {
      setBusy(null);
      setDone(null);
      // หมดเวลาใส่รหัส 6 หลัก: กลับไปขั้นรหัสผ่าน
      if (e instanceof ApiError && e.code === "mfa_expired") setMfa(null);
      setError(e);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mfa) {
      if (!/^\d{6}$/.test(code)) return setError(new Error(t("codeInvalid")));
      return void attempt("submit", () => loginWithCode(mfa, code));
    }
    const bad = { email: !EMAIL.test(email.trim()), password: !password };
    setInvalid(bad);
    if (bad.email || bad.password) return;
    void attempt("submit", async () => {
      const r = await loginWithPassword(email.trim(), password);
      setPassword("");
      setCode("");
      setMfa(r.mfaToken);
    });
  }

  function passkey() {
    if (!EMAIL.test(email.trim())) return setInvalid({ email: true });
    setInvalid({});
    void attempt("key", () => loginWithKey(email.trim()));
  }

  const kind = keyErrorKind(error);
  const message = kind ? (
    <div className="inline-error" role="alert">
      {t(kind)}
    </div>
  ) : error instanceof ApiError && error.code === "enrollment_incomplete" ? (
    <div className="inline-error" role="alert">
      {tc("incomplete")}
    </div>
  ) : (
    <InlineError error={error} />
  );
  const locked = !!busy || !!done;

  return (
    <main className="auth-page">
      <section className="card auth-card">
        {success ? (
          <LoginSuccess title={t("successTitle")} subtitle={t("successDesc")} />
        ) : (
          <form ref={form} className="stack" noValidate onSubmit={submit}>
            <div className="auth-brand">
              <FridayMark />
              <div>
                <b>{tApp("name")}</b>
                <div className="muted small">{tc("audited")}</div>
              </div>
            </div>
            {mfa ? (
              <>
                <div>
                  <h1 className="page-title">{t("codeTitle")}</h1>
                  <p className="muted">{t("codeDesc", { email: email.trim() })}</p>
                </div>
                <Input
                  label={t("code")}
                  className="auth-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
                {message}
                <SubmitButton busy={busy === "submit"} done={done === "submit"} disabled={locked || code.length !== 6} busyLabel={t("working")}>
                  {t("login")}
                </SubmitButton>
                <button
                  type="button"
                  className="auth-link"
                  disabled={locked}
                  onClick={() => {
                    setMfa(null);
                    setError(null);
                  }}
                >
                  ← {t("otherAccount")}
                </button>
                <p className="muted small">{t("lockNote")}</p>
              </>
            ) : (
              <>
                <div>
                  <h1 className="page-title">{t("loginTitle")}</h1>
                  <p className="muted">{t("loginDesc")}</p>
                </div>
                <Input
                  label={t("email")}
                  type="email"
                  autoComplete="username webauthn"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  error={invalid.email ? t("emailInvalid") : undefined}
                />
                <Input
                  label={t("password")}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={invalid.password ? t("passwordRequired") : undefined}
                />
                {message}
                <SubmitButton busy={busy === "submit"} done={done === "submit"} disabled={locked} busyLabel={t("working")}>
                  {t("next")}
                </SubmitButton>
                {keySupported && (
                  <>
                    <div className="auth-or">{t("or")}</div>
                    <SubmitButton type="button" variant="secondary" busy={busy === "key"} done={done === "key"} disabled={locked} busyLabel={t("waiting")} onClick={passkey}>
                      <KeyRound size={16} />
                      {t("loginKey")}
                    </SubmitButton>
                  </>
                )}
                <p className="muted small">{tc("lostKey")}</p>
                <Link href="/enroll" className="small">
                  {t("haveToken")}
                </Link>
              </>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
