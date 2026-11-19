"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer, ErrorBlock, Modal, Seg, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Pill, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../../workspaces/_parts/format";

export const LEADS_KEY = ["ops", "leads"] as const;
export const STAGES = ["new", "contacted", "demo", "proposal", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
const LOST = ["price", "missing_feature", "competitor", "no_budget", "silent"] as const;
const KINDS = ["call", "email", "meeting", "note"] as const;

export interface Lead {
  id: string;
  number: number;
  company: string;
  contactName: string | null;
  contactTitle: string | null;
  email: string | null;
  phone: string | null;
  teamSize: number | null;
  needs: string[];
  message: string | null;
  source: "form" | "trial" | "manual";
  stage: Stage;
  lostReason: string | null;
  valueSatang: number | null;
  seats: number | null;
  ownerId: string | null;
  owner: string | null;
  nextAction: string | null;
  nextAt: string | null;
  workspaceId: string | null;
  accountId: string | null;
  createdAt: string;
  closedAt: string | null;
}
interface Detail extends Lead {
  notes: { id: string; kind: string; body: string; nextAction: string | null; nextAt: string | null; createdAt: string; by: string | null }[];
  trial: { id: string; name: string; slug: string; plan: string | null; seats: number; active14: number; projects: number } | null;
}

const tomorrow = () => new Date(Date.now() + 31 * 3_600_000).toISOString().slice(0, 10);

/** แผงขวา (storyboard ขั้น 2): ผู้ติดต่อ · การใช้งาน Workspace ทดลอง · บันทึกการคุย (ต้องกำหนดทำต่อทุกครั้ง) · ขั้นของดีล */
export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("leads");
  const td = useTranslations("leads.drawer");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...LEADS_KEY, "lead", id], queryFn: () => api.get<Detail>(`/leads/${id}`) });
  const [kind, setKind] = useState<(typeof KINDS)[number]>("call");
  const [body, setBody] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextAt, setNextAt] = useState(tomorrow());
  const [value, setValue] = useState<string | null>(null);
  const [losing, setLosing] = useState(false);
  const done = () => void cache.invalidateQueries({ queryKey: LEADS_KEY });
  const note = useMutation({
    mutationFn: () => api.post(`/leads/${id}/notes`, { kind, body: body.trim(), nextAction: nextAction.trim(), nextAt }),
    onSuccess: () => (toast(td("saved")), setBody(""), setNextAction(""), done()),
  });
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patch<Detail>(`/leads/${id}`, b),
    onSuccess: (r) => (toast(r.stage === "won" ? td("wonDone") : td("updated")), setValue(null), done()),
  });
  const d = q.data;
  const closed = d?.stage === "won" || d?.stage === "lost";
  const okNote = body.trim().length >= 2 && nextAction.trim().length >= 2 && !!nextAt && !note.isPending;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={d?.company ?? t("title")}
      description={d ? [t(`stage.${d.stage}`), t(`source.${d.source}`), d.owner ? td("owner", { name: d.owner }) : td("noOwner")].join(" · ") : undefined}
      wide
    >
      {q.isPending ? (
        <TableSkeleton rows={5} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        d && (
          <div className="stack">
            {!closed && (
              <div className="row">
                <Select aria-label={td("stage")} value={d.stage} onChange={(e) => patch.mutate({ stage: e.target.value })}>
                  {STAGES.filter((s) => s !== "won" && s !== "lost").map((s) => (
                    <option key={s} value={s}>
                      {t(`stage.${s}`)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {closed && <Pill tone={d.stage === "won" ? "ok" : "neu"}>{td("closedAs", { stage: t(`stage.${d.stage}`), reason: d.lostReason ? ` · ${t(`lostReason.${d.lostReason}` as "lostReason.price")}` : "" })}</Pill>}
            <dl className="promo-kv">
              <dt>{td("contact")}</dt>
              <dd>{[d.contactName, d.contactTitle].filter(Boolean).join(" · ") || "—"}</dd>
              <dt>{td("email")}</dt>
              <dd className="mono small">{[d.email, d.phone].filter(Boolean).join(" · ") || "—"}</dd>
              <dt>{td("team")}</dt>
              <dd>{d.teamSize ? td("teamN", { n: fmt.num(d.teamSize) }) : "—"}</dd>
              {d.needs.length > 0 && (
                <>
                  <dt>{td("needs")}</dt>
                  <dd>{d.needs.map((n) => t(`needs.${n}` as "needs.sso")).join(" · ")}</dd>
                </>
              )}
              {d.message && (
                <>
                  <dt>{td("message")}</dt>
                  <dd className="small">{d.message}</dd>
                </>
              )}
              <dt>{td("trial")}</dt>
              <dd>
                {d.trial ? (
                  <Link className="link-button" href={`/workspaces/${d.trial.id}`}>
                    {d.trial.name} · {td("trialLine", { plan: planLabel(d.trial.plan), seats: d.trial.seats, active: d.trial.active14, projects: d.trial.projects })}
                  </Link>
                ) : (
                  <span className="muted">{td("noTrial")}</span>
                )}
              </dd>
            </dl>
            {!closed && (
              <div className="row">
                <Input label={td("value")} type="number" min={0} value={value ?? (d.valueSatang != null ? String(d.valueSatang / 100) : "")} onChange={(e) => setValue(e.target.value)} />
                <Button disabled={value === null || patch.isPending} onClick={() => patch.mutate({ valueSatang: value === "" ? null : Math.round(Number(value) * 100) })}>
                  {td("saveDeal")}
                </Button>
              </div>
            )}
            <section aria-label={td("notes")} className="stack-tight">
              <h3 className="card-title">{td("notes")}</h3>
              {!closed && (
                <form className="stack-tight" onSubmit={(e) => (e.preventDefault(), okNote && note.mutate())}>
                  <Seg label={td("notes")} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: td(`kind.${k}`) }))} />
                  <Textarea label={td("body")} value={body} onChange={(e) => setBody(e.target.value)} />
                  <div className="row">
                    <Input label={td("nextAction")} value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
                    <Input label={td("nextAt")} type="date" value={nextAt} onChange={(e) => setNextAt(e.target.value)} />
                  </div>
                  <InlineError error={note.error} />
                  <div className="row">
                    <span className="spacer" />
                    <Button type="submit" variant="primary" disabled={!okNote}>
                      {td("save")}
                    </Button>
                  </div>
                </form>
              )}
              <ul className="timeline">
                {d.notes.map((n) => (
                  <li key={n.id} className="timeline-item">
                    <span className="muted small">
                      {td(`kind.${n.kind}` as "kind.call")} · {fmt.dateTime(n.createdAt)}
                      {n.by ? ` · ${n.by}` : ""}
                    </span>
                    <span>{n.body}</span>
                    {n.nextAction && <span className="small">{td("nextLine", { action: n.nextAction, date: n.nextAt ? fmt.date(n.nextAt) : "" })}</span>}
                  </li>
                ))}
              </ul>
            </section>
            <InlineError error={patch.error} />
            <div className="dialog-actions">
              {!closed && (
                <>
                  <Button onClick={() => setLosing(true)}>{td("lost")}</Button>
                  <Button disabled={patch.isPending} onClick={() => patch.mutate({ stage: "won" })}>
                    {td("won")}
                  </Button>
                  {/* O55: ปุ่มหลักของดีลคือสร้างใบเสนอราคา (storyboard ขั้น 2) */}
                  <Link className="button button-primary" href={`/quotes?new=1&lead=${d.id}&company=${encodeURIComponent(d.company)}`}>
                    {td("quote")}
                  </Link>
                </>
              )}
              {d.accountId && (
                <Link className="button" href={`/accounts/${d.accountId}`}>
                  {td("account")}
                </Link>
              )}
            </div>
          </div>
        )
      )}
      {losing && d && <LostDialog lead={d} onClose={() => setLosing(false)} onDone={done} />}
    </Drawer>
  );
}

function LostDialog({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("leads");
  const td = useTranslations("leads.drawer");
  const tc = useTranslations("common.dialog");
  const [reason, setReason] = useState<(typeof LOST)[number]>("price");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => api.patch(`/leads/${lead.id}`, { stage: "lost", lostReason: reason, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => (onDone(), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={td("lostTitle", { company: lead.company })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), !m.isPending && m.mutate())}>
        <Select label={td("lostReason")} value={reason} onChange={(e) => setReason(e.target.value as (typeof LOST)[number])}>
          {LOST.map((r) => (
            <option key={r} value={r}>
              {t(`lostReason.${r}`)}
            </option>
          ))}
        </Select>
        <Textarea label={tc("reason")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={m.isPending}>
            {td("lost")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
