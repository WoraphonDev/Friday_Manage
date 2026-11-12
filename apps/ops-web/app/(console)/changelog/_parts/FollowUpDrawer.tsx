"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Drawer, ErrorBlock, Notice } from "@/components/kit";
import { Button, InlineError, Input, LoadingState, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { healthTone, planLabel, useFmt } from "../../workspaces/_parts/format";
import styles from "../changelog.module.css";
import { NPS_KEY, type NpsDetail, scoreTone } from "./types";

/**
 * U6 · ติดตามความเห็น NPS (Owner / Support) · ความเห็นไม่ส่งถึงใคร ทีมตอบลูกค้าผ่าน Ticket เท่านั้น
 * หัวข้อ / บันทึกภายใน / ทำเครื่องหมายว่าติดตามแล้ว · เปิด Ticket ติดตาม (T1 ที่เติมข้อความให้แก้ก่อนสร้าง)
 */
export function FollowUpDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations("cl.followUp");
  const tr = useTranslations("cl.role");
  const tc = useTranslations("cl.settingsDialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...NPS_KEY, "response", id], queryFn: () => api.get<NpsDetail>(`/nps/responses/${id}`) });
  const d = q.data;
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftTag, setDraftTag] = useState("");
  const [ticketForm, setTicketForm] = useState<{ subject: string; body: string } | null>(null);
  useEffect(() => {
    if (!d) return;
    setTags(d.tags);
    setNote(d.note ?? "");
  }, [d]);
  const refresh = () => cache.invalidateQueries({ queryKey: NPS_KEY });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<NpsDetail>(`/nps/responses/${id}`, body),
    onSuccess: () => {
      toast(t("saved"));
      void refresh();
    },
  });
  const ticket = useMutation({
    mutationFn: (body: { subject: string; body: string }) => api.post<NpsDetail>(`/nps/responses/${id}/ticket`, body),
    onSuccess: (r) => {
      toast(t("ticketDone", { n: r.ticket?.number ?? "" }));
      setTicketForm(null);
      void refresh();
    },
  });
  const role = (r: string) => (tr.has(r as never) ? tr(r as never) : r);
  const changed = !!d && (note !== (d.note ?? "") || tags.join("|") !== d.tags.join("|"));
  const addTag = () => {
    const v = draftTag.trim();
    if (v && !tags.includes(v) && tags.length < 10) setTags([...tags, v]);
    setDraftTag("");
    setAdding(false);
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={d ? t("title", { score: d.score, ws: d.workspace.name }) : "…"}
      description={d ? t("desc", { role: role(d.role), plan: planLabel(d.plan), at: fmt.dateTime(d.createdAt) }) : undefined}
    >
      {q.isPending ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="dialog-body">
          {d!.comment && <blockquote className={styles.quote}>“{d!.comment}”</blockquote>}
          <dl className={styles.kvg}>
            <dt>{t("previous")}</dt>
            <dd>{d!.context.previous ? t("previousValue", { score: d!.context.previous.score, at: fmt.date(d!.context.previous.at) }) : "—"}</dd>
            <dt>{t("health")}</dt>
            <dd>{d!.context.health !== null ? <Pill tone={healthTone(d!.context.health)}>{d!.context.health}</Pill> : "—"}</dd>
            <dt>{t("tickets")}</dt>
            <dd>{d!.context.tickets90.latest ? t("ticketsValue", { count: d!.context.tickets90.count, n: d!.context.tickets90.latest.number, subject: d!.context.tickets90.latest.subject }) : "0"}</dd>
            <dt>{t("members")}</dt>
            <dd>{t("membersValue", { n: d!.context.members })}</dd>
          </dl>
          <div className="field">
            <span className="field-label">{t("tags")}</span>
            <div className="row">
              {tags.map((x) => (
                <span key={x} className="chip chip-static">
                  {x}
                  <button type="button" className={styles.chipX} aria-label={t("removeTag", { tag: x })} onClick={() => setTags(tags.filter((y) => y !== x))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              {adding ? (
                <input
                  className="input input-narrow"
                  aria-label={t("tagInput")}
                  autoFocus
                  maxLength={40}
                  value={draftTag}
                  onChange={(e) => setDraftTag(e.target.value)}
                  onBlur={addTag}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                    if (e.key === "Escape") setAdding(false);
                  }}
                />
              ) : (
                <button type="button" className="chip" onClick={() => setAdding(true)}>
                  {t("addTag")}
                </button>
              )}
            </div>
          </div>
          <Textarea label={t("note")} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          {changed && (
            <div>
              <Button disabled={patch.isPending} onClick={() => patch.mutate({ tags, note: note.trim() || null })}>
                {t("save")}
              </Button>
            </div>
          )}
          <Notice tone="info">{t("info")}</Notice>
          {d!.ticket && (
            <p className="small">
              <Link href={`/support?ticket=${d!.ticket.id}`}>{t("ticketLink", { n: d!.ticket.number })}</Link>
            </p>
          )}
          {ticketForm && (
            <form
              className={styles.ticketForm}
              onSubmit={(e) => {
                e.preventDefault();
                ticket.mutate(ticketForm);
              }}
            >
              <Input label={t("ticketSubject")} value={ticketForm.subject} maxLength={200} onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })} />
              <Textarea label={t("ticketBody")} rows={4} value={ticketForm.body} onChange={(e) => setTicketForm({ ...ticketForm, body: e.target.value })} />
              <InlineError error={ticket.error} />
              <div className="row">
                <Button onClick={() => setTicketForm(null)}>{tc("cancel")}</Button>
                <Button type="submit" variant="primary" disabled={ticket.isPending || ticketForm.subject.trim().length < 3 || !ticketForm.body.trim()}>
                  {t("ticketCreate")}
                </Button>
              </div>
            </form>
          )}
          <InlineError error={patch.error} />
          <div className="dialog-actions">
            <Pill tone={scoreTone(d!.score)} className="push-start num">
              {d!.score}
            </Pill>
            <Button disabled={patch.isPending} onClick={() => patch.mutate({ followUpStatus: d!.followUpStatus === "done" ? "open" : "done" })}>
              {d!.followUpStatus === "done" ? t("reopen") : t("markDone")}
            </Button>
            {!d!.ticket && !ticketForm && (
              <Button
                variant="primary"
                onClick={() =>
                  setTicketForm({
                    subject: t("subjectDefault", { score: d!.score, ws: d!.workspace.name }),
                    body: d!.comment ? t("bodyDefault", { score: d!.score, comment: d!.comment }) : t("bodyNoComment", { score: d!.score }),
                  })
                }
              >
                {t("openTicket")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
