"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useReauth } from "@/components/dialogs";
import { Drawer, ErrorBlock, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import styles from "../abuse.module.css";
import { ABUSE_KEY, type Action, type CaseDetail, type DecideResult, type Dur, OUTCOME_TONE, primaryAction, scoreClass, timeLeft } from "./types";

/** ส่งคำตัดสิน (แผงขวา / แถบต้องทำ / หลายเคส) · แตะกุญแจผ่าน useReauth · คืนผลเพื่อพาไปเคสถัดไป */
export function useDecide(onDone?: (r: DecideResult) => void) {
  const t = useTranslations("abuse");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  return useMutation({
    mutationFn: (v: { ids: string[]; action: Action; reason: string }) => run(() => api.post<DecideResult>("/abuse/cases/decide", v), t("action.label")),
    onSuccess: (r) => {
      toast(r.outcome === "blocked" ? t("toast.blocked", { count: r.blocks.length }) : t(`toast.${r.outcome}`));
      void cache.invalidateQueries({ queryKey: ABUSE_KEY });
      void cache.invalidateQueries({ queryKey: ["ops", "overview"] });
      onDone?.(r);
    },
  });
}

export function useDur() {
  const t = useTranslations("abuse.dur");
  return (d: Dur | null) => (d ? t(d.unit, { n: d.n }) : "—");
}

/** แผงขวา (storyboard ขั้น 2): ที่มาของคะแนน · ข้อมูล Workspace ที่ใช้ตัดสิน · ปุ่มตามประเภท · ตัดสินแล้วไปเคสถัดไปเอง */
export function CaseDrawer({ id, onClose, onNext }: { id: string; onClose: () => void; onNext: (id: string | null) => void }) {
  const t = useTranslations("abuse");
  const td = useTranslations("abuse.drawer");
  const fmt = useFmt();
  const durText = useDur();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: [...ABUSE_KEY, "case", id], queryFn: () => api.get<CaseDetail>(`/abuse/cases/${id}`) });
  const decide = useDecide((r) => {
    setReason("");
    toast(r.next ? td("nextDone") : td("allDone"));
    onNext(r.next);
  });
  const c = q.data;
  const open = c && c.status !== "closed";
  const paying = c?.workspaces.find((w) => w.paying && !w.deleted);
  const ok = reason.trim().length >= 3 && !decide.isPending;
  const send = (action: Action) => c && decide.mutate({ ids: [c.id], action, reason: reason.trim() });
  const primary = c ? primaryAction(c.kind) : null;
  const left = c ? timeLeft(c.confirmBy) : null;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={c ? `${c.label}` : td("title", { number: "" })} description={c ? `${td("title", { number: c.number })} · ${t(`kind.${c.kind}`)}` : undefined}>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        c && (
          <div className="stack">
            <div className={styles.caseRow}>
              <span className={scoreClass(c.score, true)} aria-label={`${t("col.score")} ${c.score}`}>
                {c.score}
              </span>
              <div className={styles.caseText}>
                <div className={styles.caseTitle}>
                  <Pill tone="neu">{t(`kind.${c.kind}`)}</Pill>
                  {c.status === "auto_suspended" && <Pill tone="bad">{left ? t("suspendedLeft", { left: durText(left) }) : t("suspendedOver")}</Pill>}
                  {c.status === "open" && <Pill tone="warn">{t("status.open")}</Pill>}
                  {c.outcome && <Pill tone={OUTCOME_TONE[c.outcome]}>{t(`outcome.${c.outcome}`)}</Pill>}
                </div>
                <span className="muted small">{fmt.dateTime(c.createdAt)}</span>
              </div>
            </div>

            <section className={styles.section} aria-label={td("signals")}>
              <h3 className={styles.sectionTitle}>{td("signals")}</h3>
              <ul className={styles.signals}>
                {c.signals.map((s) => (
                  <li key={s.rule}>
                    <span>{s.detail}</span>
                    <span className={styles.points}>+{s.points}</span>
                  </li>
                ))}
              </ul>
            </section>

            {!!c.workspaces.length && (
              <section className={styles.section} aria-label={td("workspace")}>
                <h3 className={styles.sectionTitle}>{c.workspaceTotal > 1 ? td("workspaces", { count: c.workspaceTotal }) : td("workspace")}</h3>
                {c.workspaces.map((w) => (
                  <div key={w.id} className={styles.wsCard}>
                    <div className="row">
                      <b>{w.name}</b>
                      <span className="muted small mono">{w.slug}</span>
                      {w.deleted ? <Pill tone="bad">{td("deleted")}</Pill> : w.status === "suspended" ? <Pill tone="bad">{td("suspended")}</Pill> : null}
                      {!w.deleted && (
                        <Link className="link-button small push-end" href={`/workspaces/${w.id}`}>
                          {td("open")}
                        </Link>
                      )}
                    </div>
                    <dl className={styles.facts}>
                      <dt>{td("created")}</dt>
                      <dd>
                        {fmt.dateTime(w.createdAt)}
                        {w.ip && <span className="muted mono"> · {td("ip")} {w.ip}</span>}
                      </dd>
                      <dt>{td("plan")}</dt>
                      <dd>
                        {planLabel(w.plan)} · {w.paying ? td("paying") : w.paidEver ? td("paidEver") : td("neverPaid")}
                      </dd>
                      <dt>{td("wsStatus")}</dt>
                      <dd>
                        {td("members", { n: w.members })} · {td("invites", { n: fmt.num(w.pendingInvites) })} · {td("projects", { n: w.projects })}
                      </dd>
                      {w.ownerEmail && (
                        <>
                          <dt>Owner</dt>
                          <dd className="mono small">{w.ownerEmail}</dd>
                        </>
                      )}
                    </dl>
                  </div>
                ))}
                {c.workspaceTotal > c.workspaces.length && <span className="muted small">{td("more", { count: c.workspaceTotal - c.workspaces.length })}</span>}
              </section>
            )}

            {c.userTotal > 1 && (
              <section className={styles.section} aria-label={td("users", { count: c.userTotal })}>
                <h3 className={styles.sectionTitle}>{td("users", { count: c.userTotal })}</h3>
                <ul className="plain-list small">
                  {c.users.map((u) => (
                    <li key={u.id}>
                      <span className="mono">{u.email}</span> · <span className="muted">{u.verified ? td("verified") : td("unverified")}</span>
                    </li>
                  ))}
                </ul>
                {c.userTotal > c.users.length && <span className="muted small">{td("more", { count: c.userTotal - c.users.length })}</span>}
              </section>
            )}

            {open ? (
              <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && primary && !paying && send(primary.action))}>
                {paying && (
                  <Notice tone="warn">
                    {td("payingNote", { name: paying.name })}{" "}
                    <Link className="link-button" href={`/workspaces/${paying.id}`}>
                      {td("open")}
                    </Link>
                  </Notice>
                )}
                {primary?.action === "block" && !paying && (
                  <p className="muted small">
                    {c.blockable.ip || c.blockable.domains.length
                      ? td("willBlock", { what: [...(c.blockable.ip ? [td("willBlockIp", { ip: c.blockable.ip })] : []), ...c.blockable.domains.map((d) => td("willBlockDomain", { domain: d }))].join(" · ") })
                      : td("nothingToBlock")}
                  </p>
                )}
                <Textarea label={td("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
                <InlineError error={decide.error} />
                <div className={styles.actions}>
                  <Button disabled={!ok} onClick={() => send("dismiss")}>
                    {t("dismiss")}
                  </Button>
                  <Button disabled={!ok || !!paying} onClick={() => send("verify_identity")}>
                    {t("action.verify")}
                  </Button>
                  {primary?.action === "block" && (
                    <Button disabled={!ok || !!paying} onClick={() => send("suspend")}>
                      {t("action.suspend")}
                    </Button>
                  )}
                  {primary && (
                    <Button type="submit" variant="danger" disabled={!ok || !!paying}>
                      {t(`action.${primary.key}`)}
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              c.outcome && (
                <Notice tone={c.outcome === "dismissed" ? "ok" : "info"}>
                  {td("decided", { outcome: t(`outcome.${c.outcome}`), by: c.decidedBy ?? "—", at: fmt.dateTime(c.decidedAt) })}
                  {c.reason && <div className="small">{c.reason}</div>}
                </Notice>
              )
            )}
          </div>
        )
      )}
    </Drawer>
  );
}
