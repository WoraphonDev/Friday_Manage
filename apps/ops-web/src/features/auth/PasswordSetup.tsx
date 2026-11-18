"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useReauth } from "@/components/dialogs";
import { Button, buttonClass, InlineError, Input } from "@/components/ui";
import { finishPasswordSetup, startPasswordSetup, type TotpSetup } from "./password";

const PASSWORD_MIN = 12;

type StrengthLevel = "weak" | "fair" | "good" | "strong";
/** กติกาเดียวกับ ops-api (PasswordVerifyBody) · รูปแบบเดียวกับ checkPassword ของแอปลูกค้า แต่ขั้นต่ำ 12 ตัว */
export function checkPassword(value: string) {
  const rules = { length: value.length >= PASSWORD_MIN, upper: /[A-Z]/.test(value), digit: /[0-9]/.test(value), special: /[^A-Za-z0-9]/.test(value) };
  const valid = rules.length && rules.upper && rules.digit;
  const score = Object.values(rules).filter(Boolean).length;
  const level: StrengthLevel = !valid ? (score <= 2 ? "weak" : "fair") : score === 4 && value.length >= 16 ? "strong" : "good";
  return { rules, valid, level };
}

/** แบบ C ที่ผู้ใช้เลือก (19 พ.ย. · เหมือนหน้าต่างเปลี่ยนรหัสผ่านในโปรไฟล์ของแอปลูกค้า):
 * ปิดอยู่เห็นแค่ข้อความสั้น · คลิกช่องหรือมีค่าแล้ว แถบความปลอดภัย + เงื่อนไขเลื่อนลงมา */
function PasswordRules({ value, open }: { value: string; open: boolean }) {
  const t = useTranslations("ops.auth");
  const { rules, level } = checkPassword(value);
  const bars = level === "strong" ? 4 : level === "good" ? 3 : level === "fair" ? 2 : value ? 1 : 0;
  return (
    <>
      <div className="pw-reveal" data-open={open}>
        <div aria-hidden={!open}>
          <span className="pw-meter" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} data-on={i < bars} data-level={level} />
            ))}
          </span>
          {value && (
            <span className="pw-strength" data-level={level} aria-live="polite">
              {t("passwordStrength", { level: t(`passwordLevels.${level}`) })}
            </span>
          )}
          <ul className="pw-rules" aria-label={t("passwordRulesLabel")}>
            {(["length", "upper", "digit", "special"] as const).map((rule) => (
              <li key={rule} data-ok={rules[rule]}>
                <span aria-hidden="true">{rules[rule] ? "✓" : "○"}</span>
                {rule === "length" ? t("passwordRules.length", { n: PASSWORD_MIN }) : rule === "special" ? t("passwordRules.specialOptional") : t(`passwordRules.${rule}`)}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {!open && <span className="pw-hint">{t("passwordHint", { min: PASSWORD_MIN })}</span>}
    </>
  );
}

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
  const [focused, setFocused] = useState(false);
  const qr = useQr(setup?.otpauthUrl);

  const start = useMutation({
    mutationFn: () => (mode === "token" ? startPasswordSetup(token.trim()) : run(() => startPasswordSetup(), t("setupTitle"))),
    onSuccess: setSetup,
  });
  const finish = useMutation({ mutationFn: () => finishPasswordSetup(setup!.setupToken, password, code) });

  const tooShort = password.length < PASSWORD_MIN;
  const weak = !checkPassword(password).valid;
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
        if (!weak && !mismatch && (mode === "session" || token.trim().length >= 10)) start.mutate();
      }}
    >
      {steps}
      {mode === "token" && !initialToken && <Input label={t("token")} className="mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
      <div className="pw-field">
        <Input
          label={t("newPassword")}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          error={checked && weak ? (tooShort ? t("passwordShort", { min: PASSWORD_MIN }) : t("passwordWeak")) : undefined}
        />
        <PasswordRules value={password} open={focused || !!password} />
      </div>
      <div className="pw-field">
        <Input label={t("confirmPassword")} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={checked && !weak && mismatch ? t("passwordMismatch") : undefined} />
        {!!confirm && !mismatch && (
          <span className="pw-match" role="status">
            ✓ {t("passwordMatch")}
          </span>
        )}
      </div>
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
