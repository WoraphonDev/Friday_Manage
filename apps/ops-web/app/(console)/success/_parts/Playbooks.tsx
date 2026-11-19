"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorBlock, Switch, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../success.module.css";
import { type PbStep, SUCCESS_KEY } from "./RunDrawer";

const OUTCOMES = ["reached", "no_answer", "will_cancel"] as const;
interface Pb {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  trigger: { kind: string; threshold: number; days: number };
  steps: PbStep[];
  matching: number;
  active: number;
}

/** ปุ่มเฟือง (storyboard ขั้น 3): Playbook เริ่มต้น 5 แบบ · แก้เงื่อนไข ขั้น ทางแยก เปิด / ปิด · แก้ได้เฉพาะ Owner */
export function PlaybooksPanel({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("success.pb");
  const q = useQuery({ queryKey: [...SUCCESS_KEY, "playbooks"], queryFn: () => api.get<{ items: Pb[] }>("/success/playbooks") });
  if (q.isPending) return <TableSkeleton rows={5} cols={3} />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  return (
    <div className="stack">
      {!canEdit && <p className="muted small">{t("ownerOnly")}</p>}
      {q.data.items.map((p) => (
        <PlaybookEditor key={p.id} pb={p} canEdit={canEdit} />
      ))}
    </div>
  );
}

function PlaybookEditor({ pb, canEdit }: { pb: Pb; canEdit: boolean }) {
  const t = useTranslations("success.pb");
  const td = useTranslations("success.drawer.outcomes");
  const toast = useToast();
  const cache = useQueryClient();
  const [d, setD] = useState({ name: pb.name, enabled: pb.enabled, trigger: pb.trigger, steps: pb.steps });
  const dirty = JSON.stringify(d) !== JSON.stringify({ name: pb.name, enabled: pb.enabled, trigger: pb.trigger, steps: pb.steps });
  const save = useMutation({
    mutationFn: () => api.put(`/success/playbooks/${pb.id}`, d),
    onSuccess: () => (toast(t("saved")), void cache.invalidateQueries({ queryKey: SUCCESS_KEY })),
  });
  const setStep = (i: number, patch: Partial<PbStep>) => setD({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
  const usesThreshold = pb.trigger.kind !== "overdue";
  return (
    <section className={styles.pbCard} aria-label={pb.name}>
      <div className="row">
        <b>{d.name}</b>
        <span className="spacer" />
        <Switch checked={d.enabled} disabled={!canEdit} label={`${t("enabled")} ${pb.name}`} onChange={(v) => setD({ ...d, enabled: v })} />
      </div>
      <p className="small">
        <span className="muted">{t("when")} · </span>
        {t(`trigger.${pb.trigger.kind}` as "trigger.usage_drop", { n: d.trigger.threshold, days: d.trigger.days })}
      </p>
      {canEdit && (
        <div className="row">
          {usesThreshold && <Input label={t("threshold")} type="number" min={0} max={100} value={d.trigger.threshold} onChange={(e) => setD({ ...d, trigger: { ...d.trigger, threshold: Math.min(100, num(e.target.value)) } })} />}
          <Input label={t("days")} type="number" min={1} max={30} value={d.trigger.days} onChange={(e) => setD({ ...d, trigger: { ...d.trigger, days: Math.min(30, Math.max(1, num(e.target.value))) } })} />
        </div>
      )}
      <div className="stack-tight" aria-label={t("steps")}>
        {d.steps.map((s, i) => (
          <div key={i} className={styles.stepRow}>
            <span className={styles.mark}>{i + 1}</span>
            <Select aria-label={`${t("stepKind")} ${i + 1}`} disabled={!canEdit} value={s.kind} onChange={(e) => setStep(i, { kind: e.target.value as PbStep["kind"], ...(e.target.value === "task" ? {} : { branches: undefined }) })}>
              {(["email", "task", "wait"] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </Select>
            <div className="stack-tight">
              <input className="input" aria-label={`${t("stepTitle")} ${i + 1}`} disabled={!canEdit} value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} />
              {s.kind === "email" && canEdit && <Textarea label={t("body")} value={s.body ?? ""} onChange={(e) => setStep(i, { body: e.target.value })} />}
            </div>
            <input className="input" type="number" min={0} max={90} aria-label={`${t("stepDays")} ${i + 1}`} disabled={!canEdit || s.kind === "email"} value={s.days} onChange={(e) => setStep(i, { days: Math.min(90, num(e.target.value)) })} />
            {canEdit ? (
              <Button size="small" variant="ghost" disabled={d.steps.length <= 1} onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}>
                {t("remove")}
              </Button>
            ) : (
              <span />
            )}
            {s.kind === "task" && (
              <div className={styles.branches}>
                {OUTCOMES.map((o) => (
                  <label key={o} className="row small muted">
                    {t("branchTo", { outcome: td(o) })}
                    <select
                      className="input"
                      style={{ width: "auto" }}
                      disabled={!canEdit}
                      value={s.branches?.[o] === undefined ? "" : String(s.branches[o])}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = { ...(s.branches ?? {}) };
                        if (v === "") delete next[o];
                        else next[o] = v === "close" ? "close" : Number(v);
                        setStep(i, { branches: Object.keys(next).length ? next : undefined });
                      }}
                    >
                      <option value="">{t("nextDefault")}</option>
                      {d.steps.map((_, j) =>
                        j === i ? null : (
                          <option key={j} value={j}>
                            {t("stepN", { n: j + 1 })}
                          </option>
                        ),
                      )}
                      <option value="close">{t("closeOpt")}</option>
                    </select>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="row">
        <span className="muted small">{t("matching", { n: pb.matching, active: pb.active })}</span>
        <span className="spacer" />
        {canEdit && (
          <>
            <Button size="small" onClick={() => setD({ ...d, steps: [...d.steps, { kind: "task", title: "", days: 2 }] })} disabled={d.steps.length >= 20}>
              {t("addStep")}
            </Button>
            <Button size="small" variant="primary" disabled={!dirty || save.isPending || d.steps.some((s) => s.title.trim().length < 2)} onClick={() => save.mutate()}>
              {t("save")}
            </Button>
          </>
        )}
      </div>
      <InlineError error={save.error} />
    </section>
  );
}
