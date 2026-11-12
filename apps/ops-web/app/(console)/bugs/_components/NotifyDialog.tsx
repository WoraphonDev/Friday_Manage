"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Empty, ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../bugs.module.css";
import { BRIDGE_KEY, timeText } from "./types";

interface Preview {
  link: {
    id: string;
    issueKey: string;
    title: string;
    doneAt: string | null;
    releasedAt: string | null;
    releaseVersion: string | null;
  };
  tickets: {
    id: string;
    number: number;
    subject: string;
    status: string;
    workspace: string | null;
    email: string | null;
    requester: string | null;
  }[];
  message: string;
  reopenDays: number;
}

/** T9 · แจ้งลูกค้าว่าแก้แล้ว: ทุก Ticket ที่ผูกและยังไม่แจ้ง · ข้อความแก้ได้พร้อมตัวแปร · อีเมล T13 + กระดิ่ง (Support เท่านั้น เพราะเห็นอีเมลลูกค้า) */
export function NotifyDialog({ linkId, onClose }: { linkId: string; onClose: () => void }) {
  const t = useTranslations("bugs.t9");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({
    queryKey: [...BRIDGE_KEY, "notify", linkId],
    queryFn: () => api.get<Preview>(`/dev-bridge/links/${linkId}/notify`),
  });
  const [message, setMessage] = useState("");
  const [solve, setSolve] = useState(true);
  const [csat, setCsat] = useState(true);
  const [changelog, setChangelog] = useState(false);
  useEffect(() => {
    if (q.data) setMessage(q.data.message);
  }, [q.data]);
  const m = useMutation({
    mutationFn: () =>
      api.post<{
        notified: number;
        emailed: number;
        changelogId: string | null;
      }>(`/dev-bridge/links/${linkId}/notify`, {
        message: message.trim(),
        solve,
        csat: solve && csat,
        changelog,
      }),
    onSuccess: (r) => (toast({ message: t("done", { n: r.notified }) }), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  const l = q.data?.link;
  const n = q.data?.tickets.length ?? 0;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      className="dialog-wide"
      title={t("title", { key: l?.issueKey ?? "…" })}
      description={
        l?.doneAt
          ? t("desc", {
              done: timeText(l.doneAt),
              released: l.releasedAt ? timeText(l.releasedAt) : "none",
              version: l.releaseVersion ?? "none",
            })
          : undefined
      }
    >
      {q.isPending ? (
        <TableSkeleton rows={3} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !n ? (
        <Empty ok title={t("none")} />
      ) : (
        <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), message.trim().length >= 10 && m.mutate())}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("ticket")}</th>
                  <th scope="col">{t("workspace")}</th>
                  <th scope="col">{t("requester")}</th>
                  <th scope="col">{t("after")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.tickets.map((k) => (
                  <tr key={k.id}>
                    <td className="mono">#{k.number}</td>
                    <td>{k.workspace ?? "—"}</td>
                    <td>{k.email ?? k.requester ?? "—"}</td>
                    <td>
                      <Pill tone={solve ? "ok" : "inf"}>{solve ? t("solved") : t("waitingCustomer")}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Textarea label={t("message")} rows={5} value={message} onChange={(e) => setMessage(e.target.value)} hint={t("messageHint")} />
          <label className="check">
            <input type="checkbox" checked={solve} onChange={(e) => setSolve(e.target.checked)} />
            <span>{t("solve", { days: q.data.reopenDays })}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={solve && csat} disabled={!solve} onChange={(e) => setCsat(e.target.checked)} />
            <span>{t("csat")}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={changelog} onChange={(e) => setChangelog(e.target.checked)} />
            <span>{t("changelog")}</span>
          </label>
          <InlineError error={m.error} />
          <div className="dialog-actions">
            <span className="muted small push-start">{t("channel")}</span>
            <Button onClick={onClose}>{tc("cancel")}</Button>
            <Button type="submit" className={styles.success} disabled={message.trim().length < 10 || m.isPending}>
              {t("submit", { n })}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
