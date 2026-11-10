"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useApprovalFlow } from "@/components/dialogs";
import { Modal, Notice, Seg } from "@/components/kit";
import { Button, InlineError, Input, LoadingState, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { type Change, type Key, type Matrix, PLAN_NAME, type PlanCode, useShow, type Value } from "./types";

interface Preview {
  fromVersion: number;
  nextVersion: number;
  changes: Change[];
  affected: { plan: PlanCode; key: string; from: Value; to: Value; workspaces: number; examples: { id: string; name: string }[] }[];
  affectedTotal: number;
}

/** P2 · บันทึกสิทธิ์เป็นเวอร์ชันใหม่ · นับลูกค้าที่ถูกลดสิทธิ์ก่อนส่ง · ต้องมีคนอนุมัติเสมอ */
export function SaveVersion({ draft, current, keys, onClose, onSent }: { draft: Matrix; current: Matrix; keys: Key[]; onClose: () => void; onSent: () => void }) {
  const t = useTranslations("ent");
  const tc = useTranslations("common.dialog");
  const show = useShow();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [when, setWhen] = useState<"now" | "scheduled">("now");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const preview = useQuery({ queryKey: ["ops", "entitlements", "preview", draft], queryFn: () => api.post<Preview>("/entitlements/preview", { matrix: draft }), staleTime: 0 });
  const unitOf = (key: string) => keys.find((k) => k.key === key)?.unit;
  // วันที่มีผลเริ่ม 00:00 เวลาไทยของวันนั้น
  const effectiveAt = when === "scheduled" && date ? `${date}T00:00:00+07:00` : null;
  const ok = reason.trim().length >= 3 && (when === "now" || !!date) && !!preview.data?.changes.length;
  const m = useMutation({
    mutationFn: () => api.post("/entitlements/versions", { matrix: draft, effectiveAt, reason: reason.trim() }).then(handle),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onSent();
    },
  });
  const p = preview.data;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      className="dialog-wide"
      title={p ? t("save.title", { version: p.nextVersion }) : t("saveVersion")}
      description={p ? t("save.desc", { count: p.changes.length }) : undefined}
    >
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {preview.isPending ? (
          <LoadingState />
        ) : preview.error ? (
          <InlineError error={preview.error} />
        ) : (
          p && (
            <>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t("save.col.item")}</th>
                      <th scope="col">{t("save.col.plan")}</th>
                      <th scope="col" className="num">
                        {t("save.col.from")}
                      </th>
                      <th scope="col" className="num">
                        {t("save.col.to")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.changes.map((c) => (
                      <tr key={`${c.plan}:${c.key}`}>
                        <td>{t(`keys.${c.key}` as "keys.seats")}</td>
                        <td>{PLAN_NAME[c.plan]}</td>
                        <td className="num muted">{show(c.key, c.from, { plan: c.plan, unit: unitOf(c.key) })}</td>
                        <td className={c.reduced ? "num cell-strong" : "num"}>{show(c.key, c.to, { plan: c.plan, unit: unitOf(c.key) })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.affected.map((a) => (
                <Notice key={`${a.plan}:${a.key}`} tone={a.workspaces ? "warn" : "info"} title={t("save.reduced", { key: t(`keys.${a.key}` as "keys.seats"), plan: PLAN_NAME[a.plan] })}>
                  {a.workspaces ? t("save.affected", { count: a.workspaces }) : t("save.affectedNone")}
                  {a.examples.length > 0 && ` · ${a.examples.map((x) => x.name).join(", ")}`}
                </Notice>
              ))}
            </>
          )
        )}
        <Seg label={t("save.effective")} value={when} onChange={setWhen} options={[{ value: "now", label: t("save.now") }, { value: "scheduled", label: t("save.scheduled") }]} />
        {when === "scheduled" && <Input type="date" label={t("save.effectiveDate")} value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />}
        <p className="muted small">{t("save.grace")}</p>
        <p className="muted small">{t("save.announce")}</p>
        <Textarea label={t("save.reason")} value={reason} onChange={(e) => setReason(e.target.value)} required />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("save.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
