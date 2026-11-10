"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal, Seg } from "@/components/kit";
import { Button, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import type { Detail } from "./types";

/** Y6 · ดูข้อความที่ส่ง: ที่ผู้รับเห็น / Request / Response · เนื้อหางานซ่อนจนลูกค้าเปิดสิทธิ์ช่วยเหลือ */
export function MessageDialog({ d, onClose, onAttach }: { d: Detail; onClose: () => void; onAttach?: () => void }) {
  const t = useTranslations("dlv.y6");
  const tr = useTranslations("dlv");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const [mode, setMode] = useState<"view" | "request" | "response">(d.channel === "email" ? "view" : "request");
  const c = d.content;
  const req = c?.request;
  const denied = !d.contentAccess.allowed ? (d.contentAccess.reason === "role" ? t("noRole") : t("noGrant")) : null;
  let body: string;
  if (mode === "view") body = c?.view ? [c.view.subject, c.view.text].filter(Boolean).join("\n\n") : (denied ?? t("nothing"));
  else if (mode === "request")
    body = req
      ? [`${req.method} ${req.url}`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`), "", req.body ?? denied ?? ""].join("\n")
      : t("nothing");
  else body = d.response ? `HTTP ${d.response.status ?? "—"}\n\n${d.response.body ?? ""}` : t("nothing");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} className="dialog-wide" title={t("title", { channel: tr(`channel.${d.channel}`) })} description={t("desc", { to: d.to, time: fmt.dateTime(d.sentAt ?? d.createdAt), attempts: d.attempts })}>
      <div className="dialog-body">
        <Seg label={t("mode")} value={mode} onChange={setMode} options={[{ value: "view", label: t("view") }, { value: "request", label: t("request") }, { value: "response", label: t("response") }]} />
        <pre className="code-box mono small" aria-label={t(mode)}>
          {body}
        </pre>
        <p className="muted small">{t("hidden")}</p>
        <div className="dialog-actions">
          {onAttach && <Button onClick={onAttach}>{tr("detail.attach")}</Button>}
          <Button variant="primary" onClick={onClose}>
            {tc("close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** แนบสรุปการส่งเป็นข้อความภายในของ Ticket */
export function AttachDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("dlv.attach");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [num, setNum] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<{ ticketNumber: number }>(`/deliveries/${id}/attach`, { ticketNumber: Number(num) }),
    onSuccess: (r) => (toast(t("done", { number: r.ticketNumber })), void cache.invalidateQueries({ queryKey: ["ops", "support"] }), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), Number(num) > 0 && m.mutate())}>
        <Input label={t("ticket")} inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value.replace(/[^\d]/g, ""))} placeholder="509" />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!(Number(num) > 0) || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

