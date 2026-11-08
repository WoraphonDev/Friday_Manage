"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog } from "@/components/ui";
import { setConfirmHandler, type ConfirmRequest } from "@/lib/api";
import { formatDate } from "@/lib/format";

/**
 * กล่องยืนยันกลางของคำขอที่ API ให้ยืนยันก่อน (422 + confirmField)
 * เช่น Sub-task วันที่เกินช่วง Task แม่ หรือย้ายไป Done ทั้งที่ Acceptance criteria ยังไม่ครบ
 * ทุกหน้า (Task, Table, Gantt, Timeline, Calendar, Kanban) ได้กล่องเดียวกันโดยไม่ต้องเขียนเอง
 */
export function ConfirmHost() {
  const t = useTranslations("common.confirmRequest");
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    setConfirmHandler((next) => new Promise<boolean>((resolve) => {
      // คำขอที่ค้างอยู่ก่อนหน้าถือว่ายกเลิก (กันกล่องซ้อน)
      resolver.current?.(false);
      resolver.current = resolve;
      setRequest(next);
    }));
    return () => { setConfirmHandler(null); resolver.current?.(false); };
  }, []);
  function answer(ok: boolean) {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  }
  const known = request && t.has(`${request.code}.title`) ? request.code : null;
  const d = request?.details ?? {};
  const values = {
    message: request?.message ?? "",
    parentKey: String(d.parentKey ?? ""),
    start: typeof d.nextStart === "string" ? formatDate(d.nextStart, "BE") : "—",
    end: typeof d.nextEnd === "string" ? formatDate(d.nextEnd, "BE") : "—",
  };
  return (
    <Dialog
      open={!!request}
      title={known ? t(`${known}.title`, values) : t("fallbackTitle")}
      description={known ? t(`${known}.description`, values) : request?.message}
      onOpenChange={(open) => { if (!open) answer(false); }}
    >
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <Button onClick={() => answer(false)}>{t("cancel")}</Button>
        <Button variant="primary" onClick={() => answer(true)}>{known ? t(`${known}.action`) : t("fallbackAction")}</Button>
      </div>
    </Dialog>
  );
}
