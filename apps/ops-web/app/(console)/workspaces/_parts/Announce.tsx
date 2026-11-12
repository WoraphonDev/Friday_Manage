"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer, Notice, Seg } from "@/components/kit";
import { Button, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "./format";

/** ตัวแปรที่ ops-api แทนด้วยชื่อ Workspace ของผู้รับ (announcements.service.ts › WS_VAR) */
export const WS_VAR = "{ชื่อ Workspace}";
/** แบนเนอร์แสดงกี่วัน (BANNER_DAYS ของ ops-api) */
const BANNER_DAYS = 30;
type Channel = "both" | "email" | "banner";
const CHANNELS: Record<Channel, ("email" | "banner")[]> = { both: ["email", "banner"], email: ["email"], banner: ["banner"] };

export interface Audience {
  workspaces: number;
  people: number;
  emails: number;
  suppressed: number;
  noRecipients: { id: string; name: string }[];
}
export interface AnnouncementItem {
  id: string;
  title: string | null;
  message: string;
  channels: ("email" | "banner")[];
  status: "scheduled" | "sent" | "cancelled" | "stopped" | "draft";
  scheduledAt: string | null;
  sentAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  createdBy: string | null;
  workspaces: { count: number; names: string[]; ids: string[] };
  recipients: number | null;
  email: { total: number; sent: number; suppressed: number; failed: number; waiting: number } | null;
  canCancel: boolean;
}

/** `datetime-local` (yyyy-mm-ddThh:mm) เป็นเวลาไทยเสมอ ไม่ขึ้นกับเครื่องของพนักงาน */
const bangkok = (local: string) => new Date(`${local}:00+07:00`);

/**
 * C8 · ส่งประกาศถึงลูกค้าที่เลือก (Drawer ด้านขวา · เปิดจาก Workspaces › เลือกหลายแถว › ส่งประกาศ)
 * ถึง Owner / Admin ของทุก Workspace ที่เลือก · ช่องทาง อีเมล / แบนเนอร์ / ทั้งสอง · ส่งตอนนี้หรือตั้งเวลา · ดูตัวอย่างและส่งทดสอบถึงตัวเองก่อน
 */
export function AnnounceDrawer({ workspaceIds, sampleName, onClose, onDone }: { workspaceIds: string[]; sampleName?: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ann.c8");
  const fmt = useFmt();
  const toast = useToast();
  const [channel, setChannel] = useState<Channel>("both");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [when, setWhen] = useState<"now" | "scheduled">("now");
  const [at, setAt] = useState("");
  const [touched, setTouched] = useState(false);
  const audience = useQuery({
    queryKey: ["ops", "announcements", "audience", [...workspaceIds].sort().join(",")],
    queryFn: () => api.post<Audience>("/announcements/audience", { workspaceIds }),
  });
  const name = sampleName ?? t("sampleWs");
  const fill = (s: string) => s.replaceAll(WS_VAR, name);
  const scheduledAt = when === "scheduled" && at ? bangkok(at) : null;
  const errors = {
    title: !title.trim() ? t("required") : undefined,
    message: !message.trim() ? t("required") : undefined,
    at: when === "scheduled" ? (!at ? t("atRequired") : scheduledAt && scheduledAt.getTime() <= Date.now() + 60_000 ? t("atPast") : undefined) : undefined,
  };
  const valid = !errors.title && !errors.message && !errors.at;
  const send = useMutation({
    mutationFn: () => api.post<AnnouncementItem>("/announcements", { workspaceIds, title: title.trim(), message: message.trim(), channels: CHANNELS[channel], scheduledAt: scheduledAt ? scheduledAt.toISOString() : null }),
    onSuccess: (r) => {
      toast({ message: r.status === "scheduled" ? t("scheduledDone", { date: fmt.dateTime(r.scheduledAt) }) : t("sent", { count: r.workspaces.count }) });
      onDone();
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ to: string }>("/announcements/test", { title: title.trim(), message: message.trim(), ...(workspaceIds[0] ? { workspaceId: workspaceIds[0] } : {}) }),
    onSuccess: (r) => toast({ message: t("testSent", { to: r.to }) }),
  });
  const a = audience.data;
  const emailOn = channel !== "banner";
  const bannerOn = channel !== "email";
  return (
    <Drawer
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={t("title", { count: workspaceIds.length })}
      description={a ? t("people", { count: a.people }) : audience.isPending ? t("counting") : undefined}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid) send.mutate();
        }}
      >
        <InlineError error={audience.error} />
        {a && emailOn && a.suppressed > 0 && <Notice tone="warn">{bannerOn ? t("suppressed", { count: a.suppressed }) : t("suppressedEmailOnly", { count: a.suppressed })}</Notice>}
        {a && a.noRecipients.length > 0 && <Notice tone="warn">{t("noRecipients", { names: a.noRecipients.map((w) => w.name).join(", ") })}</Notice>}
        <div className="field">
          <span className="field-label">{t("channel")}</span>
          <Seg label={t("channel")} value={channel} onChange={setChannel} options={[{ value: "email", label: t("email") }, { value: "banner", label: t("banner") }, { value: "both", label: t("both") }]} />
        </div>
        <Input label={`${t("subject")} *`} value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} error={touched ? errors.title : undefined} />
        <Textarea label={`${t("message")} *`} value={message} maxLength={2000} rows={5} onChange={(e) => setMessage(e.target.value)} error={touched ? errors.message : undefined} hint={touched && errors.message ? undefined : t("varHint", { var: WS_VAR })} />
        <div className="field">
          <span className="field-label">{t("when")}</span>
          <Seg label={t("when")} value={when} onChange={setWhen} options={[{ value: "now", label: t("now") }, { value: "scheduled", label: t("scheduled") }]} />
        </div>
        {when === "scheduled" && <Input type="datetime-local" label={t("at")} value={at} onChange={(e) => setAt(e.target.value)} error={touched || at ? errors.at : undefined} />}
        <p className="muted small">{t("info")}</p>
        <p className="muted small">{t("quiet", { days: BANNER_DAYS })}</p>

        <section className="stack" aria-label={t("preview")}>
          <div className="row">
            <b className="small">{t("preview")}</b>
            <span className="muted small">{t("previewFor", { name })}</span>
          </div>
          {!title.trim() || !message.trim() ? (
            <p className="muted small">{t("previewEmpty")}</p>
          ) : (
            <>
              {emailOn && (
                <div className="field" aria-label={t("previewEmail")}>
                  <span className="field-label">{t("previewEmail")}</span>
                  <div className="code-box small">
                    <b>{t("subjectPrefix", { title: fill(title.trim()) })}</b>
                    {"\n\n"}
                    {fill(message.trim())}
                  </div>
                </div>
              )}
              {bannerOn && (
                <div className="field" aria-label={t("previewBanner")}>
                  <span className="field-label">{t("previewBanner")}</span>
                  <Notice tone="info" icon={<Megaphone size={16} aria-hidden="true" />} title={`${t("previewFrom")} · ${fill(title.trim())}`}>
                    {fill(message.trim())}
                  </Notice>
                </div>
              )}
            </>
          )}
        </section>

        <InlineError error={send.error ?? test.error} />
        <div className="dialog-actions">
          <Button disabled={!title.trim() || !message.trim() || test.isPending} onClick={() => test.mutate()}>
            {t("test")}
          </Button>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={send.isPending || !audience.data}>
            {send.isPending ? t("sending") : when === "scheduled" ? t("schedule") : t("sendNow")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
