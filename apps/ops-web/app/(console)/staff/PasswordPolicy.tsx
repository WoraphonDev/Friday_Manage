"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Notice, Seg } from "@/components/kit";
import { Button, InlineError, useToast } from "@/components/ui";
import { api } from "@/lib/api";

type Length = 8 | 12;
interface Policy {
  staffMinLength: Length;
  customerMinLength: Length;
}
interface PolicyResponse {
  policy: Policy;
  updatedAt: string | null;
  updatedBy: string | null;
  saved?: boolean;
}
export const passwordPolicyKey = ["ops", "staff", "password-policy"] as const;
const CHOICES = ["8", "12"] as const;

/**
 * ความยาวรหัสผ่านขั้นต่ำ (แบบ A ที่ผู้ใช้เลือก 19 พ.ย.): พนักงาน Ops กับลูกค้าแยกกัน · อยู่หลังปุ่มเฟืองหน้าพนักงาน
 * Owner แก้ได้ (กดบันทึกแล้วยืนยันอีกครั้ง) · ผู้ตรวจดูได้อย่างเดียว · มีผลกับการตั้งรหัสผ่านครั้งถัดไป
 */
export function PasswordPolicySection({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("staff.passwordPolicy");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: passwordPolicyKey, queryFn: () => api.get<PolicyResponse>("/staff/password-policy") });
  const [draft, setDraft] = useState<Policy | null>(null);
  const [confirming, setConfirming] = useState(false);
  const saved = q.data?.policy;
  const value = draft ?? saved;
  const dirty = !!saved && !!draft && (draft.staffMinLength !== saved.staffMinLength || draft.customerMinLength !== saved.customerMinLength);
  const m = useMutation({
    mutationFn: (p: Policy) => api.put<PolicyResponse>("/staff/password-policy", p),
    onSuccess: (r) => {
      cache.setQueryData(passwordPolicyKey, r);
      setDraft(null);
      setConfirming(false);
      toast(t("saved"));
    },
  });
  const change = (key: keyof Policy, v: string) => {
    if (!value) return;
    setDraft({ ...value, [key]: Number(v) as Length });
    setConfirming(false);
  };
  const row = (key: keyof Policy) => (
    <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <span className="stack" style={{ gap: 0, minWidth: 0 }}>
        <b>{t(`${key}.label`)}</b>
        <span className="muted small">{t(`${key}.desc`)}</span>
      </span>
      {canEdit && value ? (
        <Seg label={t(`${key}.label`)} value={String(value[key]) as (typeof CHOICES)[number]} onChange={(v) => change(key, v)} options={CHOICES.map((n) => ({ value: n, label: t("chars", { n }) }))} />
      ) : (
        <span className="pill">{value ? t("chars", { n: value[key] }) : "—"}</span>
      )}
    </div>
  );

  return (
    <section className="stack">
      <h3 className="card-title">{t("title")}</h3>
      <p className="muted small">{t(canEdit ? "desc" : "descReadOnly")}</p>
      {q.error ? (
        <InlineError error={q.error} />
      ) : (
        <>
          {row("staffMinLength")}
          {row("customerMinLength")}
          <Notice tone="info">{t("effect")}</Notice>
          {confirming && draft && saved && (
            <Notice tone="warn" title={t("confirmTitle")}>
              {t("confirmBody", { staffFrom: saved.staffMinLength, staffTo: draft.staffMinLength, customerFrom: saved.customerMinLength, customerTo: draft.customerMinLength })}
            </Notice>
          )}
          <InlineError error={m.error} />
          {canEdit && (
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              {confirming && <Button onClick={() => setConfirming(false)}>{t("cancel")}</Button>}
              <Button variant="primary" disabled={!dirty || m.isPending} onClick={() => (confirming && draft ? m.mutate(draft) : setConfirming(true))}>
                {confirming ? t("confirm") : t("save")}
              </Button>
            </div>
          )}
          {q.data?.updatedAt && (
            <p className="muted small">{t("updated", { name: q.data.updatedBy ?? "—", when: format.dateTime(new Date(q.data.updatedAt), { dateStyle: "medium", timeStyle: "short" }) })}</p>
          )}
        </>
      )}
    </section>
  );
}
