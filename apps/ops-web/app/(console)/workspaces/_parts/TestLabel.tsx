"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal, Notice } from "@/components/kit";
import { Button, InlineError, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { BulkTarget } from "./types";

export type TestFlag = "test" | "not_test" | "clear";

/**
 * ยืนยันติด / เอาป้ายทดสอบ (ช่วง 1): ไม่แสดงรายการยาว · บอกจำนวน ตัวอย่าง 3 ชื่อ และเหตุผล
 * เลือกตามตัวกรองได้ (ops-api หารายการและทำทั้งชุด) · ชุดที่มีลูกค้าจ่ายเงินต้องยืนยันอีกครั้ง
 */
export function TestLabelDialog({ target, count, names, flag = "test", onClose, onDone }: { target: BulkTarget; count: number; names: string[]; flag?: TestFlag; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("customers.test");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  // ops-api ตอบ 409 has_paying = ชุดนี้มีลูกค้าจ่ายเงิน · ถามยืนยันอีกครั้ง
  const [paying, setPaying] = useState<number | null>(null);
  const m = useMutation({
    mutationFn: (confirmPaying: boolean) => api.post<{ updated: number }>("/workspaces/test-flag", { ...target, flag, reason: reason.trim(), confirmPaying }),
    onSuccess: (r) => {
      toast(t(`done.${flag}`, { n: r.updated }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "has_paying") setPaying(Number(e.details.paying ?? 0));
    },
  });
  const sample = names.slice(0, 3);
  const more = count - sample.length;
  const blocked = m.error instanceof ApiError && m.error.code === "has_paying" ? null : m.error;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t(`confirm.${flag}`, { n: count })} description={sample.length ? t("sample", { names: sample.join(", "), more: Math.max(0, more) }) : t("byFilter", { n: count })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate(paying != null))}>
        {flag === "test" && <p className="muted small">{t("effect")}</p>}
        {paying != null && (
          <Notice tone="warn" title={t("payingTitle", { n: paying })}>
            {t("payingHint")}
          </Notice>
        )}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={blocked} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant={paying != null ? "danger" : "primary"} disabled={reason.trim().length < 3 || m.isPending}>
            {paying != null ? t("confirmPaying", { n: count }) : t(`submit.${flag}`, { n: count })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
