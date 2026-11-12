"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Drawer, ErrorBlock, Notice } from "@/components/kit";
import { Button, InlineError, Input, LoadingState, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../workspaces/_parts/format";
import { type CannedReply, type FollowupStatus, onbDetailKey, type OnboardingDetail } from "./types";
import styles from "./onboarding.module.css";

const STATUSES: FollowupStatus[] = ["open", "emailed", "no_reply", "replied", "done"];
/** ตัวแปรเดียวกับ ops-api (fillVars) · แสดงตัวอย่างก่อนส่ง */
const fill = (text: string, ws: string, customer: string) => text.replaceAll("{ชื่อ Workspace}", ws).replaceAll("{ชื่อผู้แจ้ง}", customer);

/**
 * ติดตามลูกค้าที่ติด (V5 · Drawer ด้านขวา) · เปิดจากตารางลูกค้าที่ติด และการ์ด Onboarding ในรายละเอียดลูกค้า (V7)
 * ส่งอีเมลด้วยมือ (คำตัดสิน 12 พ.ย. 2569) 1 ครั้งต่อ 7 วัน · บันทึกภายในลูกค้าไม่เห็น
 */
export function FollowDrawer({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useTranslations("onb");
  const td = useTranslations("onb.drawer");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: onbDetailKey(workspaceId), queryFn: () => api.get<OnboardingDetail>(`/onboarding/workspaces/${workspaceId}`) });
  const canned = useQuery({ queryKey: ["ops", "support", "canned"], queryFn: () => api.get<{ items: CannedReply[] }>("/support/canned-replies") });
  const d = q.data;
  const [assigneeId, setAssigneeId] = useState("");
  const [status, setStatus] = useState<FollowupStatus>("open");
  const [note, setNote] = useState("");
  const [cannedId, setCannedId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (!d) return;
    setAssigneeId(d.followup?.assigneeId ?? "");
    setStatus(d.followup?.status ?? "open");
    setNote(d.followup?.note ?? "");
  }, [d]);
  const refresh = () => void cache.invalidateQueries({ queryKey: ["ops", "onboarding"] });
  const save = useMutation({
    mutationFn: () => api.put(`/onboarding/workspaces/${workspaceId}/followup`, { assigneeId: assigneeId || null, status, note: note.trim() || null }),
    onSuccess: () => {
      toast({ message: td("saved") });
      refresh();
      onClose();
    },
  });
  const send = useMutation({
    mutationFn: () => api.post(`/onboarding/workspaces/${workspaceId}/email`, { subject, body, ...(cannedId ? { cannedId } : {}), assigneeId: assigneeId || null, note: note.trim() || null }),
    onSuccess: () => {
      toast({ message: td("sent") });
      refresh();
      onClose();
    },
  });
  // ข้อความสำเร็จรูปของ Onboarding ขึ้นก่อน
  const replies = [...(canned.data?.items ?? [])].sort((a, b) => Number(b.tag === "onboarding") - Number(a.tag === "onboarding"));
  function pick(id: string) {
    setCannedId(id);
    const c = replies.find((r) => r.id === id);
    if (c) {
      setSubject(c.title);
      setBody(c.body);
    }
  }
  const tooSoon = !!d?.followup?.nextEmailAt && new Date(d.followup.nextEmailAt).getTime() > Date.now();
  const canSend = !!d && !!d.owner && !d.owner.suppressed && !tooSoon && !!subject.trim() && !!body.trim();
  const title = d ? td("title", { name: d.workspace.name }) : t("follow");
  const sig = d?.signals;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={
        d ? (
          <>
            {d.workspace.trialDaysLeft != null ? td("trial", { plan: planLabel(d.workspace.plan), n: d.workspace.trialDaysLeft }) : planLabel(d.workspace.plan)}
            {d.owner?.email ? ` · ${td("owner", { email: d.owner.email })}` : ""}
          </>
        ) : undefined
      }
    >
      {q.isPending ? (
        <LoadingState />
      ) : q.error || !d ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <form className={styles.drawerBody} onSubmit={(e) => (e.preventDefault(), canSend && send.mutate())}>
          <section aria-label={td("progress")}>
            <div className={styles.label}>{td("progress")}</div>
            <ol className={styles.progress}>
              {d.steps.map((s, i) => {
                const stuck = d.stuckStep === s.key;
                return (
                  <li key={s.key}>
                    <span className={s.doneAt ? styles.dotDone : stuck ? styles.dotStuck : styles.dotTodo} aria-hidden="true" />
                    <b>{t("stepN", { index: i + 1, label: t(`steps.${s.key}` as "steps.team") })}</b>
                    <span className="muted small">
                      {s.doneAt
                        ? [fmt.dateTime(s.doneAt), s.meta.imported ? td("imported", { n: s.meta.imported }) : ""].filter(Boolean).join(" · ")
                        : stuck
                          ? [
                              td("stuckFor", { n: d.stuckDays }),
                              s.key === "team" ? td("accepted", { n: sig!.acceptedInvites }) : "",
                              s.key === "team" && sig!.pendingInvites ? td("pending", { n: sig!.pendingInvites, date: fmt.date(sig!.oldestInviteAt) }) : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
            {d.complete && <Notice tone="ok" title={td("complete")} />}
          </section>
          <div className="kvs">
            <div className="kv">
              <span className="muted">{td("active7d")}</span>
              <span>{td("active7dValue", { n: sig!.active7d, days: sig!.activeDays7d })}</span>
            </div>
            <div className="kv">
              <span className="muted">{td("source")}</span>
              <span>
                {sig!.acquisition
                  ? [sig!.acquisition.source, sig!.acquisition.medium].filter(Boolean).join(" / ") || td(`via.${sig!.acquisition.via === "invited_user" ? "invited_user" : "signup"}`)
                  : td("sourceNone")}
              </span>
            </div>
            <div className="kv">
              <span className="muted">{td("tickets")}</span>
              <span>{sig!.openTickets ? td("ticketsOpen", { n: sig!.openTickets }) : td("ticketsNone")}</span>
            </div>
          </div>
          <div className={styles.twoCol}>
            <Select label={td("assignee")} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">{td("noAssignee")}</option>
              {d.assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <Select label={td("canned")} value={cannedId} onChange={(e) => pick(e.target.value)}>
              <option value="">{td("cannedNone")}</option>
              {replies.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </Select>
          </div>
          <Input label={td("subject")} value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} />
          <Textarea label={td("body")} hint={td("vars")} value={body} rows={5} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
          {(subject || body) && (
            <div className={styles.preview} aria-label={td("previewHidden")}>
              <div className={styles.previewHead}>{d.owner?.email ? td("preview", { to: d.owner.email }) : td("previewHidden")}</div>
              <div className={styles.previewBody}>
                <b>{fill(subject, d.workspace.name, d.owner?.name ?? "")}</b>
                <p>{fill(body, d.workspace.name, d.owner?.name ?? "")}</p>
              </div>
            </div>
          )}
          <Textarea label={td("note")} hint={td("noteHint")} value={note} rows={3} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <Select label={td("statusLabel")} value={status} onChange={(e) => setStatus(e.target.value as FollowupStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
          {d.owner?.suppressed ? <Notice tone="warn" title={td("suppressed")} /> : <p className={styles.rule}>{td("rule")}</p>}
          {tooSoon && <Notice tone="info" title={td("nextEmail", { date: fmt.dateTime(d.followup!.nextEmailAt) })} />}
          <InlineError error={save.error ?? send.error} />
          <div className={styles.drawerFoot}>
            <span className="muted small">{td("auditNote")}</span>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {td("save")}
            </Button>
            <Button type="submit" variant="primary" disabled={!canSend || send.isPending}>
              {td("send")}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
