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
  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState(t("keyNameDefault"));
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const enroll = useMutation({ mutationFn: () => registerKey({ ...(mode === "token" ? { enrollToken: token.trim() } : {}), name: name.trim() || t("keyNameDefault") }) });
  const kind = keyErrorKind(enroll.error);

  if (enroll.data)
    return (
      <div className="stack">
        <div className="pill ok" role="status">
          {t("enrolled", { count: enroll.data.keys })}
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
