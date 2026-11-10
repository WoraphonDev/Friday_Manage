"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Empty, ErrorBlock, Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";
import { REASON_TONE, type Suppression } from "./types";

/** รายชื่อที่ไม่ส่งอีเมลให้ · เอาออกได้เฉพาะ Owner / Support (Y7) */
export function Suppressions() {
  const t = useTranslations("dlv.suppressions");
  const fmt = useFmt();
  const me = useMe().data;
  const canRemove = hasAny(me, "owner", "support");
  const [removing, setRemoving] = useState<Suppression | null>(null);
  const q = useQuery({ queryKey: ["ops", "deliveries", "suppressions"], queryFn: () => api.get<{ items: Suppression[] }>("/email-suppressions"), enabled: !!me });
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("note")}</span>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.email")}</th>
                <th scope="col">{t("col.reason")}</th>
                <th scope="col">{t("col.ws")}</th>
                <th scope="col">{t("col.since")}</th>
                {canRemove && (
                  <th scope="col">
                    <span className="sr-only">{t("col.actions")}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id}>
                  <td className="mono small">{s.email}</td>
                  <td>
                    <Pill tone={REASON_TONE[s.reason]}>{t(`reason.${s.reason}`)}</Pill>
                    {s.detail && <div className="cell-sub">{s.detail}</div>}
                  </td>
                  <td className="muted">{s.workspace?.name ?? "—"}</td>
                  <td className="muted num">{fmt.date(s.since)}</td>
                  {canRemove && (
                    <td>
                      <Button size="small" onClick={() => setRemoving(s)}>
                        {t("remove")}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removing && <RemoveDialog s={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}

/** Y7 · เอาอีเมลออกจากรายการไม่ส่ง · ต้องมีเหตุผล (เช่น ลูกค้ายืนยันใน Ticket) */
function RemoveDialog({ s, onClose }: { s: Suppression; onClose: () => void }) {
  const t = useTranslations("dlv.y7");
  const ts = useTranslations("dlv.suppressions");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/email-suppressions/${s.id}/remove`, { reason: reason.trim() }),
    onSuccess: () => (toast(t("done", { email: s.email })), void cache.invalidateQueries({ queryKey: ["ops", "deliveries"] }), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { email: s.email })} description={t("added", { reason: ts(`reason.${s.reason}`), date: fmt.date(s.since) })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 5 && m.mutate())}>
        <Notice tone="warn" title={t("warn")} />
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} hint={tc("reasonRequired", { min: 5 })} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={reason.trim().length < 5 || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
