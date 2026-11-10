"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { type HistoryItem, type Key, PLAN_NAME, useShow } from "./types";

/** P3 · ประวัติการแก้สิทธิ์ · ดูความต่างจากเวอร์ชันก่อนหน้า · กู้เวอร์ชันเก่าเป็นเวอร์ชันใหม่ (ต้องอนุมัติ) */
export function HistoryDrawer({ open, onOpenChange, canRestore, keys }: { open: boolean; onOpenChange: (o: boolean) => void; canRestore: boolean; keys: Key[] }) {
  const t = useTranslations("ent.historyDrawer");
  const tk = useTranslations("ent");
  const fmt = useFmt();
  const show = useShow();
  const q = useQuery({ queryKey: ["ops", "entitlements", "versions"], queryFn: () => api.get<{ items: HistoryItem[] }>("/entitlements/versions"), enabled: open });
  const [openDiff, setOpenDiff] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<HistoryItem | null>(null);
  const unitOf = (key: string) => keys.find((k) => k.key === key)?.unit;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t("title")} description={t("desc")}>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("empty")} />
      ) : (
        <ol className="stack" aria-label={t("title")}>
          {q.data.items.map((v, i) => {
            const first = i === q.data.items.length - 1;
            return (
              <li key={v.version} className="version-item" data-current={v.status === "current"}>
                <div className="row">
                  <b>{t("version", { version: v.version })}</b>
                  {v.status === "current" && <Pill tone="inf">{t("current")}</Pill>}
                  {v.status === "scheduled" && <Pill tone="warn">{t("scheduled")}</Pill>}
                  {v.restoredFrom && <Pill>{t("restoredFrom", { version: v.restoredFrom })}</Pill>}
                </div>
                <span className="muted small">
                  {t("meta", { date: fmt.date(v.effectiveAt), by: v.createdBy ?? t("system") })}
                  {v.approvedBy && ` · ${t("approvedBy", { name: v.approvedBy })}`}
                </span>
                <span className="small">{v.reason}</span>
                <div className="row">
                  {!first && (
                    <Button size="small" variant="ghost" aria-expanded={openDiff === v.version} onClick={() => setOpenDiff(openDiff === v.version ? null : v.version)}>
                      {openDiff === v.version ? t("hideDiff") : t("diff")}
                    </Button>
                  )}
                  {first && <span className="muted small">{t("first")}</span>}
                  {canRestore && v.status === "past" && (
                    <Button size="small" onClick={() => setRestoring(v)}>
                      {t("restore")}
                    </Button>
                  )}
                </div>
                {openDiff === v.version &&
                  (v.changes.length ? (
                    <ul className="small stack">
                      {v.changes.map((c) => (
                        <li key={`${c.plan}:${c.key}`}>
                          {tk(`keys.${c.key}` as "keys.seats")} · {PLAN_NAME[c.plan]}: <span className="muted">{show(c.key, c.from, { plan: c.plan, unit: unitOf(c.key) })}</span> → <b>{show(c.key, c.to, { plan: c.plan, unit: unitOf(c.key) })}</b>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted small">{t("noDiff")}</span>
                  ))}
              </li>
            );
          })}
        </ol>
      )}
      {restoring && <RestoreDialog item={restoring} onClose={() => setRestoring(null)} onDone={() => (setRestoring(null), onOpenChange(false))} />}
    </Drawer>
  );
}

function RestoreDialog({ item, onClose, onDone }: { item: HistoryItem; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ent.historyDrawer");
  const tc = useTranslations("common.dialog");
  const ts = useTranslations("ent.save");
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/entitlements/versions/${item.version}/restore`, { reason: reason.trim() }).then(handle),
    onSuccess: () => (void cache.invalidateQueries({ queryKey: ["ops"] }), onDone()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("restoreTitle", { version: item.version })} description={t("restoreDesc", { version: item.version })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate())}>
        <Textarea label={ts("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={reason.trim().length < 3 || m.isPending}>
            {ts("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
