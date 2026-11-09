"use client";

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button, buttonClass, InlineError, Input } from "@/components/ui";
import { keyErrorKind, registerKey } from "./webauthn";

/** mode `token` = พนักงานใหม่ใช้ enrollToken จากสคริปต์ `enroll` · mode `session` = เพิ่ม key สำรองขณะล็อกอินอยู่ */
export function EnrollForm({ mode, token: initialToken = "" }: { mode: "token" | "session"; token?: string }) {
  const t = useTranslations("ops.auth");
  const tc = useTranslations("common.auth");
  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState(t("keyNameDefault"));
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const enroll = useMutation({ mutationFn: () => registerKey({ ...(mode === "token" ? { enrollToken: token.trim() } : {}), name: name.trim() || t("keyNameDefault") }) });
  const kind = keyErrorKind(enroll.error);

  // พนักงานใหม่ต้องมีกุญแจ 2 อันก่อนใช้งาน (S2) · อันแรกเสร็จแล้วให้ลงทะเบียนกุญแจสำรองต่อด้วยโทเค็นเดิม
  const keysNow = enroll.data?.keys ?? 0;
  if (mode === "token" && enroll.data && keysNow < 2)
    return (
      <div className="stack">
        <Steps done={keysNow} />
        <div className="pill ok" role="status">
          {t("enrolled", { count: keysNow })}
        </div>
        <p className="muted small">{tc("twoKeys")}</p>
        <Input label={t("keyName")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <InlineError error={enroll.error} />
        <Button
          variant="primary"
          disabled={enroll.isPending}
          onClick={() => {
            setName((n) => (n === t("keyNameDefault") ? tc("backupName") : n));
            enroll.mutate();
          }}
        >
          <KeyRound size={16} />
          {enroll.isPending ? t("waiting") : tc("nextKey")}
        </Button>
      </div>
    );
  if (enroll.data)
    return (
      <div className="stack">
        {mode === "token" && <Steps done={2} />}
        <div className="pill ok" role="status">
          {mode === "token" ? tc("ready") : t("enrolled", { count: enroll.data.keys })}
        </div>
        {mode === "token" && (
          <Link href="/login" className={buttonClass("primary")}>
            {t("goLogin")}
          </Link>
        )}
      </div>
    );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        enroll.mutate();
      }}
    >
      {!supported && (
        <div className="inline-error" role="alert">
          {t("unsupported")}
        </div>
      )}
      {mode === "token" && <Steps done={0} />}
      {mode === "token" && <Input label={t("token")} className="mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
      <Input label={t("keyName")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      {kind ? (
        <div className="inline-error" role="alert">
          {t(kind)}
        </div>
      ) : (
        <InlineError error={enroll.error} />
      )}
      <Button variant="primary" type="submit" disabled={!supported || enroll.isPending || (mode === "token" && token.trim().length < 10)}>
        <KeyRound size={16} />
        {enroll.isPending ? t("waiting") : t("enroll")}
      </Button>
    </form>
  );
}

export function EnrollPage({ token }: { token?: string }) {
  const t = useTranslations("ops.auth");
  return (
    <main className="auth-page">
      <section className="card auth-card">
        <div>
          <h1 className="page-title">{t("enrollTitle")}</h1>
          <p className="muted">{t("enrollDesc")}</p>
        </div>
        <EnrollForm mode="token" token={token} />
        <Link href="/login" className="small">
          {t("backLogin")}
        </Link>
      </section>
    </main>
  );
}

/** S2 · ลำดับการลงทะเบียน 2 กุญแจ */
function Steps({ done }: { done: number }) {
  const tc = useTranslations("common.auth");
  return (
    <ol className="auth-steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {[tc("step1"), tc("step2")].map((label, i) => (
        <li key={label} className={i < done ? "auth-step auth-step-done" : i === done ? "auth-step auth-step-now" : "auth-step"}>
          <span className="auth-step-n" aria-hidden="true">
            {i < done ? "✓" : i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}
