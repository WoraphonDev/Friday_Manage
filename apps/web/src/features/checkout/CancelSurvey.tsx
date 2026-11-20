"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { Button, Dialog, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import styles from "./cancel-survey.module.css";

const REASONS = ["too_expensive", "missing_feature", "switched_tool", "project_ended", "hard_to_use", "company_closed", "other"] as const;
type Reason = (typeof REASONS)[number];

/** ใช้อยู่เกินขีดจำกัดของ Free (`freeBlockers` ของ `GET w/billing`) */
type Blocker = { key: "seats" | "projects"; used: number; limit: number };

/**
 * W22 · แบบสอบถามตอนยกเลิกแพ็กเกจ (เหตุผล · ฟีเจอร์ที่ขาด · ย้ายไปใช้อะไร)
 * คำตอบเก็บที่ `cancellation-feedback` (เฉพาะ Owner · ใช้ทำหน้าธุรกิจของทีม Friday) แล้วจึงยกเลิกจริง
 * Admin ยกเลิกได้แต่ไม่ส่งแบบสอบถาม · ส่งแบบสอบถามไม่สำเร็จไม่ขวางการยกเลิก
 * ยกเลิก = เป็น Free เมื่อจบรอบ · ทีมใช้เกินขีดจำกัดของ Free อยู่ให้เห็นตัวเลขก่อนยืนยัน (ผู้ใช้เลือก 2026-11-20)
 */
export function CancelSurvey({
  open,
  onOpenChange,
  ws,
  sub,
  blockers = [],
  isOwner,
  onCancelled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ws: string;
  sub: { status: string; trialEndsAt: string | null; currentPeriodEnd: string | null };
  blockers?: Blocker[];
  isOwner: boolean;
  onCancelled: () => void | Promise<void>;
}) {
  const t = useTranslations("checkout.cancel");
  const base = `/w/${encodeURIComponent(ws)}`;
  const home = `/work/${encodeURIComponent(ws)}`;
  // ทดลองใช้ = ถึงวันสิ้นสุดทดลอง · แพ็กเกจที่จ่ายแล้ว = ถึงสิ้นรอบ (ตรงกับ API subscription/cancel)
  const until = formatDate(sub.status === "trialing" ? sub.trialEndsAt : sub.currentPeriodEnd, "BE", true);
  const toast = useToast();
  const [reason, setReason] = useState<Reason | null>(null);
  const [feature, setFeature] = useState("");
  const [switchedTo, setSwitchedTo] = useState("");
  const [detail, setDetail] = useState("");
  const reset = () => (setReason(null), setFeature(""), setSwitchedTo(""), setDetail(""));
  const feedback = (outcome: "canceled" | "kept") =>
    isOwner && reason
      ? api
          .post(`${base}/cancellation-feedback`, {
            reason,
            outcome,
            ...(reason === "missing_feature" && feature.trim() ? { missingFeature: feature.trim() } : {}),
            ...(reason === "switched_tool" && switchedTo.trim() ? { switchedTo: switchedTo.trim() } : {}),
            ...(detail.trim() ? { detail: detail.trim() } : {}),
          })
          .catch(() => undefined)
      : Promise.resolve();
  const cancel = useMutation({
    mutationFn: async () => {
      await feedback("canceled");
      await api.post(`${base}/billing/subscription/cancel`);
    },
    onSuccess: async () => {
      toast({ message: t("done") });
      reset();
      onOpenChange(false);
      await onCancelled();
    },
  });
  const keep = async () => {
    await feedback("kept");
    if (reason) toast({ message: t("kept") });
    reset();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : void keep())} title={t("title")} description={t("desc", { date: until })}>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          cancel.mutate();
        }}
      >
        {blockers.length > 0 && (
          <div className={styles.over} role="status">
            <AlertCircle size={16} aria-hidden="true" />
            <div>
              <b>{t("over.title")}</b>
              <span>{blockers.map((b) => t(`over.${b.key}`, { used: b.used, limit: b.limit })).join(" · ")}</span>
              <span>
                {t("over.hint", { date: until })}
                {blockers.some((b) => b.key === "seats") && (
                  <>
                    {" · "}
                    <Link href={`${home}/members`}>{t("over.members")}</Link>
                  </>
                )}
                {blockers.some((b) => b.key === "projects") && (
                  <>
                    {" · "}
                    <Link href={`${home}/projects`}>{t("over.projectsLink")}</Link>
                  </>
                )}
              </span>
            </div>
          </div>
        )}
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>{t("why")}</legend>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {t("whyHint")}
          </span>
          {REASONS.map((r) => (
            <label key={r} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
              <input type="radio" name="cancel-reason" checked={reason === r} onChange={() => setReason(r)} />
              <span>{t(`reasons.${r}`)}</span>
            </label>
          ))}
        </fieldset>
        {reason === "missing_feature" && <Input label={t("feature")} placeholder={t("featurePlaceholder")} maxLength={200} value={feature} onChange={(e) => setFeature(e.target.value)} />}
        {reason === "switched_tool" && <Input label={t("switchedTo")} placeholder={t("switchedPlaceholder")} maxLength={100} value={switchedTo} onChange={(e) => setSwitchedTo(e.target.value)} />}
        {reason && <Input label={t("detail")} maxLength={1000} value={detail} onChange={(e) => setDetail(e.target.value)} />}
        {cancel.error && (
          <span className="field-error" role="alert">
            {cancel.error instanceof Error ? cancel.error.message : String(cancel.error)}
          </span>
        )}
        <div className="dialog-actions">
          <Button onClick={() => void keep()}>{t("keep")}</Button>
          <Button type="submit" variant="danger" disabled={cancel.isPending}>
            {t("confirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
