"use client";

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button, InlineError, Input } from "@/components/ui";
import { keys } from "@/lib/query";
import { keyErrorKind, loginWithKey } from "./webauthn";

export function LoginForm() {
  const t = useTranslations("ops.auth");
  const tApp = useTranslations("ops.app");
  const router = useRouter();
  const cache = useQueryClient();
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState(false);
  // ตรวจหลัง mount เท่านั้น: server render ไม่มี window.PublicKeyCredential
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const login = useMutation({
    mutationFn: () => loginWithKey(email.trim()),
    onSuccess: (staff) => {
      cache.setQueryData(keys.me, staff);
      router.replace("/");
    },
  });
  const kind = keyErrorKind(login.error);

  return (
    <main className="auth-page">
      <form
        className="card auth-card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setInvalid(true);
          setInvalid(false);
          login.mutate();
        }}
      >
        <div className="brand brand-light">
          <span className="brand-mark">F</span>
          <div>
            <b>{tApp("name")}</b>
            <div className="muted small">{tApp("tagline")}</div>
          </div>
        </div>
        <div>
          <h1 className="page-title">{t("loginTitle")}</h1>
          <p className="muted">{t("loginDesc")}</p>
        </div>
        {!supported && (
          <div className="inline-error" role="alert">
            {t("unsupported")}
          </div>
        )}
        <Input label={t("email")} type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} error={invalid ? t("emailInvalid") : undefined} />
        {kind ? (
          <div className="inline-error" role="alert">
            {t(kind)}
          </div>
        ) : (
          <InlineError error={login.error} />
        )}
        <Button variant="primary" type="submit" disabled={!supported || login.isPending}>
          <KeyRound size={16} />
          {login.isPending ? t("waiting") : t("login")}
        </Button>
        <Link href="/enroll" className="small">
          {t("haveToken")}
        </Link>
      </form>
    </main>
  );
}
