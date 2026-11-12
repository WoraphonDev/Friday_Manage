"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal } from "@/components/kit";
import { Button, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../bugs.module.css";
import type { LinkStatus } from "./types";

type Action = "link_fixed" | "workaround" | "return";

/** T10 · ทีมพัฒนาปิดงานแบบไม่แก้ / ซ้ำ: ผูก Ticket ไปงานที่แก้แล้ว · แจ้งพร้อมทางเลี่ยง · หรือคืนให้ Support */
export function ResolveDialog({ link, onClose }: { link: LinkStatus & { id: string }; onClose: () => void }) {
  const t = useTranslations("bugs.t10");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [action, setAction] = useState<Action>(link.duplicateOfKey ? "link_fixed" : "workaround");
  const [target, setTarget] = useState(link.duplicateOfKey ?? "");
  const [message, setMessage] = useState("");
  const body =
    action === "link_fixed"
      ? { action, targetKey: target.trim().toUpperCase() }
      : action === "workaround"
        ? { action, message: message.trim() }
        : { action, ...(message.trim() ? { note: message.trim() } : {}) };
  const m = useMutation({
    mutationFn: () =>
      api.post<{
        moved?: number;
        issueKey?: string;
        notified?: number;
        returned?: number;
      }>(`/dev-bridge/links/${link.id}/resolve`, body),
    onSuccess: (r) => {
      toast({
        message: r.moved != null ? t("moved", { n: r.moved, key: r.issueKey ?? target }) : r.returned != null ? t("returned", { n: r.returned }) : t("sent", { n: r.notified ?? 0 }),
      });
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  const ok = action === "link_fixed" ? /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/.test(target.trim()) : action === "workaround" ? message.trim().length >= 10 : true;
  const options: { v: Action; label: string; note: string }[] = [
    {
      v: "link_fixed",
      label: link.duplicateOfKey ? t("linkFixed", { key: link.duplicateOfKey }) : t("linkFixedAny"),
      note: t("linkFixedNote"),
    },
    { v: "workaround", label: t("workaround"), note: t("workaroundNote") },
    { v: "return", label: t("return"), note: t("returnNote") },
  ];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("title", {
        key: link.issueKey,
        what: link.resolution === "duplicate" ? t("duplicate") : t("wontFix"),
      })}
      description={t("desc", { status: link.statusName ?? "—" })}
    >
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <fieldset className={styles.radios}>
          {options.map((o) => (
            <label key={o.v} className={`${styles.radioCard} ${action === o.v ? styles.radioOn : ""}`}>
              <input type="radio" name="t10" checked={action === o.v} onChange={() => setAction(o.v)} />
              <span>
                <b>{o.label}</b>
                <span className="muted small">{o.note}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {action === "link_fixed" && !link.duplicateOfKey && <Input label={t("target")} className="mono" placeholder="FM-466" value={target} onChange={(e) => setTarget(e.target.value)} />}
        {action !== "link_fixed" && <Textarea label={action === "workaround" ? `${t("message")} *` : t("note")} rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
