"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer, ErrorBlock, Modal, Seg, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import styles from "../success.module.css";

export const SUCCESS_KEY = ["ops", "success"] as const;
export const PARTS = ["usage", "payment", "support", "growth"] as const;
export type Part = (typeof PARTS)[number];
const OUTCOMES = ["reached", "no_answer", "will_cancel"] as const;
type Outcome = (typeof OUTCOMES)[number];

export interface PbStep {
  kind: "email" | "task" | "wait";
  title: string;
  body?: string;
  days: number;
  branches?: Partial<Record<Outcome, number | "close">>;
}
interface RunStep {
  id: string;
  stepIndex: number;
  kind: PbStep["kind"];
  title: string;
  status: "pending" | "done" | "skipped";
  outcome: string | null;
  note: string | null;
  dueOn: string | null;
  doneAt: string | null;
  assignee: string | null;
}
interface Detail {
  id: string;
  status: "active" | "recovered" | "churned" | "closed";
  closeReason: string | null;
  startedAt: string;
  owner: string | null;
  workspace: { id: string; name: string; slug: string; plan: string | null; createdAt: string; seats: number; ownerEmail: string | null; mrr: number | null };
  health: ({ score: number } & Record<Part, number>) | null;
  playbook: { id: string; key: string; name: string; steps: PbStep[] };
  steps: RunStep[];
}

export const healthClass = (n: number | null | undefined) => (n == null ? "" : n < 40 ? styles.bad : n < 60 ? styles.warn : styles.ok);
const barTone = (n: number) => (n < 40 ? "bad" : n < 60 ? "warn" : "primary");

/** แผงขวา (storyboard ขั้น 2): แถบคะแนน 4 ส่วน · checklist ของ Playbook · บันทึกผลขั้นปัจจุบัน แล้วระบบไปขั้นถัดไปหรือปิดให้ */
export function RunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("success");
  const td = useTranslations("success.drawer");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...SUCCESS_KEY, "run", id], queryFn: () => api.get<Detail>(`/success/runs/${id}`) });
  const [outcome, setOutcome] = useState<Outcome>("reached");
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const d = q.data;
  const current = d?.steps.find((s) => s.status === "pending");
  const save = useMutation({
    mutationFn: () => api.post(`/success/steps/${current!.id}/outcome`, { outcome, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => (toast(td("saved")), setNote(""), setOutcome("reached"), void cache.invalidateQueries({ queryKey: SUCCESS_KEY })),
  });
  const months = d ? Math.max(0, Math.floor((Date.now() - Date.parse(d.workspace.createdAt)) / (30 * 86_400_000))) : 0;
  const target = (b: number | "close" | undefined, i: number) => (b === "close" ? td("closeStep") : t("pb.stepN", { n: (b ?? i + 1) + 1 }));
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={d ? `${d.workspace.name} · ${planLabel(d.workspace.plan)}` : t("title")}
      description={d ? td("meta", { email: d.workspace.ownerEmail ?? "—", seats: d.workspace.seats, months }) : undefined}
      wide
    >
      {q.isPending ? (
        <TableSkeleton rows={5} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        d && (
          <div className="stack">
            <div className="row">
              <span className={`${styles.score} ${healthClass(d.health?.score)}`}>{td("health", { score: d.health?.score ?? "—" })}</span>
              <Pill tone={d.status === "active" ? "inf" : d.status === "recovered" ? "ok" : "neu"}>{td(`status.${d.status}`)}</Pill>
              {d.closeReason && <span className="muted small">{d.closeReason}</span>}
            </div>
            {d.health && (
              <ul className="hbars" aria-label={td("health", { score: d.health.score })}>
                {PARTS.map((p) => (
                  <li key={p}>
                    <span className="hbar-label">{t(`parts.${p}`)}</span>
                    <span className="hbar-track">
                      <span className={`hbar hbar-${barTone(d.health![p])}`} style={{ width: `${Math.max(1, d.health![p])}%` }} />
                    </span>
                    <span className="hbar-value">{d.health![p]}%</span>
                  </li>
                ))}
              </ul>
            )}
            <section aria-label={td("playbook", { name: d.playbook.name })}>
              <h3 className={styles.sectionTitle}>{td("playbook", { name: d.playbook.name })}</h3>
              <ol className={styles.steps}>
                {d.playbook.steps.map((ps, i) => {
                  const ran = [...d.steps].reverse().find((r) => r.stepIndex === i);
                  const isCurrent = current?.stepIndex === i;
                  return (
                    <li key={i} className={isCurrent ? styles.current : ran?.status === "done" ? styles.done : undefined}>
                      <span className={styles.mark} aria-hidden="true">
                        {ran?.status === "done" ? <Check size={14} /> : i + 1}
                      </span>
                      <div className={styles.stepBody}>
                        <b>{ps.title}</b>
                        <span className="muted small">
                          {[
                            ps.kind === "task" ? null : td("auto"),
                            ps.kind === "wait" ? t("wait", { days: ps.days }) : null,
                            ran?.assignee,
                            ran?.status === "done" && ran.doneAt ? fmt.date(ran.doneAt) : ran?.dueOn ? td("due", { date: fmt.date(ran.dueOn) }) : null,
                            ran?.outcome ? td(`outcomes.${ran.outcome}` as "outcomes.reached") : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {ran?.note && <span className="small">“{ran.note}”</span>}
                        {ps.kind === "task" && ps.branches && ran?.status !== "done" && (
                          <span className="muted small">{OUTCOMES.filter((o) => ps.branches?.[o] !== undefined).map((o) => td("branch", { outcome: td(`outcomes.${o}`), target: target(ps.branches?.[o], i) })).join(" · ")}</span>
                        )}
                        {isCurrent && current.kind === "task" && d.status === "active" && (
                          <form className="stack-tight" onSubmit={(e) => (e.preventDefault(), !save.isPending && save.mutate())}>
                            <Seg label={td("result")} value={outcome} onChange={setOutcome} options={OUTCOMES.map((o) => ({ value: o, label: td(`outcomes.${o}`) }))} />
                            <Textarea label={td("note")} value={note} onChange={(e) => setNote(e.target.value)} />
                            <InlineError error={save.error} />
                            <div className={styles.actions}>
                              <Button type="submit" variant="primary" disabled={save.isPending}>
                                {td("save")}
                              </Button>
                            </div>
                          </form>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
            <div className={styles.actions}>
              {d.status === "active" && <Button onClick={() => setClosing(true)}>{td("close")}</Button>}
              <Link className="button" href={`/workspaces/${d.workspace.id}`}>
                {td("openWs")}
              </Link>
            </div>
          </div>
        )
      )}
      {closing && d && <CloseDialog id={d.id} name={d.workspace.name} onClose={() => setClosing(false)} />}
    </Drawer>
  );
}

function CloseDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const td = useTranslations("success.drawer");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/success/runs/${id}/close`, { reason: reason.trim() }),
    onSuccess: () => (toast(td("closed")), void cache.invalidateQueries({ queryKey: SUCCESS_KEY }), onClose()),
  });
  const ok = reason.trim().length >= 3 && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={td("closeTitle", { name })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Textarea label={td("closeReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {td("close")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
