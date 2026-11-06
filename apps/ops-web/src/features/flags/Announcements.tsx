"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog, EmptyState, ErrorState, InlineError, Input, LoadingState, Pill, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { keys } from "@/lib/query";
import type { Announcement } from "@/lib/types";

type Channels = "banner" | "banner_email" | "email";
const toChannels = (c: Channels): Announcement["channels"] => (c === "banner_email" ? ["banner", "email"] : [c]);
const fromChannels = (c: Announcement["channels"]): Channels => (c.includes("banner") && c.includes("email") ? "banner_email" : c.includes("email") ? "email" : "banner");
/** `datetime-local` (เวลาเครื่อง) ↔ ISO ที่ ops-api รับ */
const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function AnnouncementForm({ initial, onSaved, submitLabel }: { initial?: Announcement; onSaved: () => void; submitLabel?: (scheduled: boolean) => string }) {
  const t = useTranslations("ops");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [audience, setAudience] = useState<Announcement["audience"]>(initial?.audience ?? "all");
  const [channels, setChannels] = useState<Channels>(initial ? fromChannels(initial.channels) : "banner_email");
  const [at, setAt] = useState(toLocal(initial?.scheduledAt ?? null));
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const body = { message: message.trim(), audience, channels: toChannels(channels), scheduledAt: at ? new Date(at).toISOString() : null };
      return initial ? api.patch(`/announcements/${initial.id}`, body) : api.post("/announcements", body);
    },
    onSuccess: () => {
      setMessage("");
      setAt("");
      setTouched(false);
      onSaved();
    },
  });
  const empty = !message.trim();
  return (
    <form
      className="stack-10"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!empty) save.mutate();
      }}
    >
      <Input label={t("ann.message")} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} error={touched && empty ? t("ann.messageRequired") : undefined} />
      <div className="ann-row">
        <Select aria-label={t("ann.audience")} value={audience} onChange={(e) => setAudience(e.target.value as Announcement["audience"])}>
          <option value="all">{t("ann.all")}</option>
          <option value="owners_admins">{t("ann.owners_admins")}</option>
        </Select>
        <Select aria-label={t("ann.channels")} value={channels} onChange={(e) => setChannels(e.target.value as Channels)}>
          <option value="banner_email">{t("ann.bannerEmail")}</option>
          <option value="banner">{t("ann.banner")}</option>
          <option value="email">{t("ann.email")}</option>
        </Select>
        <Input aria-label={t("ann.scheduledAt")} title={t("ann.scheduledAt")} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {submitLabel ? submitLabel(!!at) : at ? t("ann.schedule") : t("ann.draft")}
        </Button>
      </div>
      <InlineError error={save.error} />
    </form>
  );
}

export function Announcements() {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const [editing, setEditing] = useState<Announcement | null>(null);
  const q = useQuery({ queryKey: keys.announcements, queryFn: () => api.get<{ items: Announcement[] }>("/announcements") });
  const refresh = () => cache.invalidateQueries({ queryKey: keys.announcements });
  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/announcements/${id}/publish`),
    onSuccess: () => {
      toast(t("ann.published"));
      void refresh();
    },
    onError: (e) => toast(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/announcements/${id}`),
    onSuccess: () => {
      toast(t("ann.deleted"));
      void refresh();
    },
    onError: (e) => toast(e.message),
  });
  return (
    <section className="card">
      <div className="ch">
        <h2>{t("ann.title")}</h2>
      </div>
      <div className="padded-form">
        <AnnouncementForm
          onSaved={() => {
            toast(t("ann.created"));
            void refresh();
          }}
        />
      </div>
      {q.isPending ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title={t("ann.empty")} />
      ) : (
        [...q.data.items].reverse().map((a) => (
          <div className="pr" key={a.id}>
            <div className="grow-260">
              <span>{a.message}</span>
              <div className="muted small">
                {t(`ann.${a.audience}`)} · {t(`ann.${fromChannels(a.channels) === "banner_email" ? "bannerEmail" : fromChannels(a.channels)}`)}
              </div>
            </div>
            <Pill tone={a.sentAt ? "ok" : a.scheduledAt ? "inf" : "neu"}>{a.sentAt ? t("ann.sent", { date: formatDateTime(a.sentAt) }) : a.scheduledAt ? t("ann.scheduled", { date: formatDateTime(a.scheduledAt) }) : t("ann.isDraft")}</Pill>
            {!a.sentAt && (
              <span className="row-6">
                <Button size="small" onClick={() => setEditing(a)}>
                  {t("ann.edit")}
                </Button>
                <Button size="small" disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>
                  {t("ann.delete")}
                </Button>
                <Button size="small" variant="primary" disabled={publish.isPending} onClick={() => publish.mutate(a.id)}>
                  {t("ann.publish")}
                </Button>
              </span>
            )}
          </div>
        ))
      )}
      {editing && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)} title={t("ann.editTitle")}>
          <AnnouncementForm
            initial={editing}
            submitLabel={() => t("ui.save")}
            onSaved={() => {
              toast(t("ann.saved"));
              setEditing(null);
              void refresh();
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
