"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Smartphone, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { useReauth } from "@/components/dialogs";
import { Button, errorToast, InlineError, LoadingState, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { keys } from "@/lib/query";
import { EnrollForm } from "./EnrollForm";
import { fetchMethods } from "./password";
import { PasswordSetup } from "./PasswordSetup";

/** เมนูบัญชี › วิธีเข้าระบบ: รหัสผ่าน + แอป Authenticator (ใช้ได้ทุกเครื่อง) และ Passkey / Security key (ทางลัดบนเครื่องประจำ) */
export function LoginMethods() {
  const t = useTranslations("ops.auth");
  const format = useFormatter();
  const cache = useQueryClient();
  const toast = useToast();
  const { run } = useReauth();
  const [view, setView] = useState<"list" | "password" | "key">("list");
  const methods = useQuery({ queryKey: keys.methods, queryFn: fetchMethods });
  const refresh = () => cache.invalidateQueries({ queryKey: keys.methods });
  const remove = useMutation({
    mutationFn: (id: string) => run(() => api.delete(`/auth/keys/${encodeURIComponent(id)}`), t("removeKey")),
    onSuccess: () => {
      void refresh();
      toast(t("keyRemoved"));
    },
    onError: (e) => toast(errorToast(e)),
  });
  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : t("never"));

  if (view === "password")
    return (
      <PasswordSetup
        mode="session"
        onDone={() => {
          void refresh();
          setView("list");
        }}
      />
    );
  if (view === "key")
    return (
      <div className="stack">
        <EnrollForm mode="session" />
        <button
          type="button"
          className="auth-link"
          onClick={() => {
            void refresh();
            setView("list");
          }}
        >
          ← {t("back")}
        </button>
      </div>
    );
  if (methods.isPending) return <LoadingState />;
  if (!methods.data) return <InlineError error={methods.error} />;
  const m = methods.data;
  return (
    <div className="auth-methods">
      <div className="auth-method">
        <span>
          <Smartphone size={18} aria-hidden="true" />
          <span>
            <b>{t("methodPassword")}</b>
            <div className="muted small">{m.totp ? t("methodSetAt", { date: date(m.totpEnabledAt) }) : t("methodNotSet")}</div>
          </span>
        </span>
        <Button size="small" variant={m.totp ? "secondary" : "primary"} onClick={() => setView("password")}>
          {m.totp ? t("reset") : t("setup")}
        </Button>
      </div>
      {m.keys.map((k) => (
        <div key={k.id} className="auth-method">
          <span>
            <KeyRound size={18} aria-hidden="true" />
            <span>
              <b>{k.name}</b>
              <div className="muted small">{t("keyMeta", { created: date(k.createdAt), used: date(k.lastUsedAt) })}</div>
            </span>
          </span>
          <Button
            size="small"
            variant="ghost"
            // ต้องเหลือวิธีเข้าระบบอย่างน้อย 1 วิธี
            disabled={(m.keys.length <= 1 && !m.totp) || remove.isPending}
            aria-label={`${t("removeKey")} ${k.name}`}
            onClick={() => remove.mutate(k.id)}
          >
            <Trash2 size={14} /> {t("removeKey")}
          </Button>
        </div>
      ))}
      {!m.keys.length && (
        <p className="muted small" style={{ margin: 0 }}>
          {t("noKeys")}
        </p>
      )}
      <button type="button" className="auth-link" onClick={() => setView("key")}>
        + {t("addKey")}
      </button>
      {!m.totp && <Pill tone="warn">{t("onlyKeysWarn")}</Pill>}
    </div>
  );
}
