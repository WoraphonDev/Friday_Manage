"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { useReauth } from "@/components/dialogs";
import { Drawer, Notice } from "@/components/kit";
import { Button, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { type PersonalEmail, personalEmailKey, staffKey } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domainOf = (e: string) => e.split("@")[1]?.toLowerCase() ?? "";

/**
 * H1 · อีเมลส่วนตัวของพนักงาน (แก้ได้เฉพาะเจ้าของบัญชี)
 * บันทึก = แตะกุญแจ (ops-api ตอบ reauth_required) → ส่งรหัส 6 หลักไปอีเมลใหม่ (หมด 15 นาที) → ใส่รหัสยืนยัน
 * ห้ามโดเมนเดียวกับอีเมลงาน (ตรวจที่นี่ก่อน และ ops-api ตรวจซ้ำ)
 */
export function PersonalEmailDrawer({ open, onOpenChange, name, roleLabel }: { open: boolean; onOpenChange: (o: boolean) => void; name: string; roleLabel: string }) {
  const t = useTranslations("staff.personal");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const q = useQuery({ queryKey: personalEmailKey, queryFn: () => api.get<PersonalEmail>("/staff/me/personal-email"), enabled: open });
  const [email, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [touched, setTouched] = useState(false);
  const [changing, setChanging] = useState(false);
  const data = q.data;
  const value = email ?? data?.email ?? "";
  const pending = !changing ? (data?.pending ?? null) : null;
  const request = useMutation({
    mutationFn: (to: string) => run(() => api.post<{ pending: string; expiresAt: string }>("/staff/me/personal-email", { email: to }), t("label")),
    onSuccess: () => {
      setChanging(false);
      setCode("");
      setTouched(false);
      void cache.invalidateQueries({ queryKey: personalEmailKey });
    },
  });
  const verify = useMutation({
    mutationFn: () => api.post<{ email: string; notifiedOld: boolean }>("/staff/me/personal-email/verify", { code }),
    onSuccess: (r) => {
      toast(r.notifiedOld ? t("doneOld") : t("done"));
      void cache.invalidateQueries({ queryKey: staffKey });
      close(false);
    },
  });
  const close = (o: boolean) => {
    if (!o) {
      setEmail(null);
      setCode("");
      setTouched(false);
      setChanging(false);
      request.reset();
      verify.reset();
    }
    onOpenChange(o);
  };
  const trimmed = value.trim().toLowerCase();
  const sameDomain = !!data && EMAIL.test(trimmed) && domainOf(trimmed) === domainOf(data.workEmail);
  const emailError = touched ? (!EMAIL.test(trimmed) ? t("invalid") : sameDomain ? t("sameDomain", { domain: domainOf(data!.workEmail) }) : undefined) : undefined;
  const status = data?.verifiedAt ? (
    <span className="pill ok">{t("verifiedOn", { date: format.dateTime(new Date(data.verifiedAt), { day: "numeric", month: "short" }) })}</span>
  ) : null;

  return (
    <Drawer open={open} onOpenChange={close} title={name} description={data ? `${roleLabel} · ${data.workEmail}` : roleLabel}>
      {q.isPending ? (
        <p className="muted small">…</p>
      ) : q.error ? (
        <InlineError error={q.error} />
      ) : pending ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (/^\d{6}$/.test(code)) verify.mutate();
          }}
        >
          {data?.email && data.verifiedAt && <Notice tone="info">{t("current", { email: data.email })}</Notice>}
          <Input
            label={t("code")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            hint={t("codeHint", { email: pending, time: data?.pendingExpiresAt ? format.dateTime(new Date(data.pendingExpiresAt), { timeStyle: "short" }) : "—" })}
            error={touched && !/^\d{6}$/.test(code) ? t("codeInvalid") : undefined}
            className="mono"
          />
          <InlineError error={verify.error ?? request.error} />
          <div className="dialog-actions">
            <Button type="button" onClick={() => setChanging(true)}>
              {t("change")}
            </Button>
            <Button type="button" disabled={request.isPending} onClick={() => request.mutate(pending)}>
              {t("resend")}
            </Button>
            <Button type="submit" variant="primary" disabled={verify.isPending}>
              {t("verify")}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (EMAIL.test(trimmed) && !sameDomain) request.mutate(trimmed);
          }}
        >
          <div className="grid-2">
            <Input label={t("name")} value={name} readOnly />
            <Input label={t("work")} value={data?.workEmail ?? ""} readOnly hint={t("workHint")} />
          </div>
          <div className="field">
            <Input label={t("label")} type="email" value={value} onChange={(e) => setEmail(e.target.value)} hint={t("hint")} error={emailError} />
            {status}
          </div>
          <Notice tone="info">{t("info")}</Notice>
          <InlineError error={request.error} />
          <p className="muted small">{t("note")}</p>
          <div className="dialog-actions">
            <Button type="button" onClick={() => close(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={request.isPending}>
              {t("save")}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
