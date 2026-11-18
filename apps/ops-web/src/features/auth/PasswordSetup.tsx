"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useReauth } from "@/components/dialogs";
import { Button, buttonClass, InlineError, Input } from "@/components/ui";
import { finishPasswordSetup, startPasswordSetup, type TotpSetup } from "./password";

const PASSWORD_MIN = 12;

/** วาด QR ของ otpauth:// เป็น SVG · โหลดไลบรารีเมื่อใช้จริงเท่านั้น (แบบเดียวกับ QR PromptPay ของแอปลูกค้า) */
function useQr(payload: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!payload) return;
    import("qrcode")
      .then((QR) => QR.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 }))
      .then((svg) => alive && setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [payload]);
  return url;
}

/**
 * ตั้งรหัสผ่าน + แอป Authenticator 2 ขั้น
 * mode `token` = ลิงก์เชิญ / ลิงก์ตั้งค่าใหม่จาก Owner · mode `session` = ตั้งจากเมนูบัญชี (ops-api ขอให้ยืนยันตัวตนซ้ำก่อน)
 */
export function PasswordSetup({ mode, token: initialToken = "", onDone, onUseKey }: { mode: "token" | "session"; token?: string; onDone?: () => void; onUseKey?: () => void }) {
  const t = useTranslations("ops.auth");
  const { run } = useReauth();
  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [checked, setChecked] = useState(false);
  const qr = useQr(setup?.otpauthUrl);

  const start = useMutation({
    mutationFn: () => (mode === "token" ? startPasswordSetup(token.trim()) : run(() => startPasswordSetup(), t("setupTitle"))),
    onSuccess: setSetup,
  });
  const finish = useMutation({ mutationFn: () => finishPasswordSetup(setup!.setupToken, password, code) });

  const tooShort = password.length < PASSWORD_MIN;
  const mismatch = confirm !== password;
  const step = finish.data ? 2 : setup ? 1 : 0;
  const steps = (
    <ol className="auth-steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {[t("stepPassword"), t("stepApp")].map((label, i) => (
        <li key={label} className={i < step ? "auth-step auth-step-done" : i === step ? "auth-step auth-step-now" : "auth-step"}>
          <span className="auth-step-n" aria-hidden="true">
            {i < step ? "✓" : i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );

  if (finish.data)
    return (
      <div className="stack">
        {steps}
        <div className="pill ok" role="status">
          {mode === "token" ? t("setupReady") : t("setupSaved")}
        </div>
        {mode === "token" ? (
          <Link href="/login" className={buttonClass("primary")}>
            {t("goLogin")}
          </Link>
        ) : (
          onDone && (
            <Button variant="primary" onClick={onDone}>
              {t("close")}
            </Button>
          )
        )}
      </div>
    );

  if (setup)
    return (
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (/^\d{6}$/.test(code)) finish.mutate();
        }}
      >
        {steps}
        <div className="auth-qr">
          {qr ? <img src={qr} alt={t("qrAlt")} /> : <span className="skeleton" style={{ width: 132, height: 132 }} />}
          <div className="stack" style={{ gap: 6, minWidth: 0 }}>
            <p className="muted small" style={{ margin: 0 }}>
              {t("qrHint")}
            </p>
            <span className="muted small">{t("secretLabel")}</span>
            <code className="auth-secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          </div>
        </div>
        <Input
          label={t("code")}
          className="auth-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <InlineError error={finish.error} />
        <Button type="submit" variant="primary" disabled={code.length !== 6 || finish.isPending}>
          {finish.isPending ? t("working") : mode === "token" ? t("activate") : t("save")}
        </Button>
        <button type="button" className="auth-link" onClick={() => (setSetup(null), setCode(""), finish.reset())}>
          ← {t("back")}
        </button>
      </form>
    );

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setChecked(true);
        if (!tooShort && !mismatch && (mode === "session" || token.trim().length >= 10)) start.mutate();
      }}
    >
      {steps}
      {mode === "token" && !initialToken && <Input label={t("token")} className="mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
      <Input
        label={t("newPassword")}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={t("passwordHint", { min: PASSWORD_MIN })}
        error={checked && tooShort ? t("passwordShort", { min: PASSWORD_MIN }) : undefined}
      />
      <Input label={t("confirmPassword")} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={checked && !tooShort && mismatch ? t("passwordMismatch") : undefined} />
      <InlineError error={start.error} />
      <Button type="submit" variant="primary" disabled={start.isPending || (mode === "token" && token.trim().length < 10)}>
        {start.isPending ? t("working") : t("next")}
      </Button>
      {onUseKey && (
        <button type="button" className="auth-link" onClick={onUseKey}>
          {t("useKeysInstead")}
        </button>
      )}
    </form>
  );
}
