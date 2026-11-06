"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog, InlineError, Input, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { keys } from "@/lib/query";
import { PLAN_CODES, type WorkspaceDetail } from "@/lib/types";

export type ActionKind = "extend" | "discount" | "plan" | "suspend" | "resume";
// ใช้ path แบบ `/:id/extend-trial` (ops-api รับทั้งแบบนี้และ `:extend-trial`) เพราะ `:` ในส่วนท้ายของ path ผ่าน rewrite ของ Next ได้ไม่แน่นอน
const PATH: Record<ActionKind, string> = { extend: "extend-trial", discount: "discount", plan: "change-plan", suspend: "suspend", resume: "resume" };
const TITLE = { extend: "extend", discount: "discount", plan: "changePlan", suspend: "suspend", resume: "resume" } as const;

/** Dialog ของการกระทำกับ Workspace · ทุกข้อต้องมีเหตุผล (ไปอยู่ใน Audit Log ของลูกค้า) */
export function ActionDialog({ kind, workspace, onClose }: { kind: ActionKind; workspace: WorkspaceDetail; onClose: () => void }) {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("14");
  const [percent, setPercent] = useState("10");
  const [months, setMonths] = useState("");
  const [plan, setPlan] = useState<string>(workspace.subscription?.plan ?? "team_s");
  const [touched, setTouched] = useState(false);
  const body = () => {
    const r = { reason: reason.trim() };
    if (kind === "extend") return { ...r, days: Number(days) };
    if (kind === "discount") return { ...r, percent: Number(percent), ...(months ? { months: Number(months) } : {}) };
    if (kind === "plan") return { ...r, plan };
    return r;
  };
  const run = useMutation({
    mutationFn: () => api.post<{ trialEndsAt?: string }>(`/workspaces/${workspace.id}/${PATH[kind]}`, body()),
    onSuccess: (r) => {
      toast(kind === "extend" ? t("ws.done.extend", { date: formatDate(r.trialEndsAt) }) : t(`ws.done.${kind}`));
      void cache.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
      void cache.invalidateQueries({ queryKey: ["ops", "workspaces"] });
      void cache.invalidateQueries({ queryKey: keys.metrics });
      onClose();
    },
  });
  const reasonShort = reason.trim().length < 3;
  const note = kind === "plan" ? t("ws.planNote") : kind === "suspend" ? t("ws.suspendNote") : undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`${t(`ws.${TITLE[kind]}`)} · ${workspace.name}`} description={note}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (reasonShort) return;
          run.mutate();
        }}
      >
        {kind === "extend" && <Input label={t("ws.days")} type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} />}
        {kind === "discount" && (
          <>
            <Input label={t("ws.percent")} type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} />
            <Input label={t("ws.months")} type="number" min={1} max={36} value={months} onChange={(e) => setMonths(e.target.value)} />
          </>
        )}
        {kind === "plan" && (
          <Select label={t("ws.newPlan")} value={plan} onChange={(e) => setPlan(e.target.value)}>
            {PLAN_CODES.map((p) => (
              <option key={p} value={p}>
                {t(`plans.${p}`)}
              </option>
            ))}
          </Select>
        )}
        <Input label={t("ui.reason")} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} hint={t("ui.reasonHint")} error={touched && reasonShort ? t("ui.reasonShort") : undefined} />
        <InlineError error={run.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant={kind === "suspend" ? "danger" : "primary"} disabled={run.isPending}>
            {run.isPending ? t("ui.saving") : t(`ws.${TITLE[kind]}`)}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
