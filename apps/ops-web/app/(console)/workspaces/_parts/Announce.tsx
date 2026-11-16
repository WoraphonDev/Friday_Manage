"use client";

import { useMutation, useQueries } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer, Notice, Seg } from "@/components/kit";
import { useReauth } from "@/components/dialogs";
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
  /** ส่งชุดละ 50 ฉบับต่อนาที (S8) */
  minutes?: number;
  /** เกิน 1,000 Workspace ต้องแตะกุญแจ */
  needsReauth?: boolean;
}
/** ตัวกรองของหน้า Workspaces ที่ส่งต่อให้ประกาศ "ตามตัวกรอง" (S8) · ตรงกับ AnnouncementFilter ของ ops-api */
export interface AnnounceFilter {
  plan?: "free" | "team_s" | "team_m" | "team_l" | "enterprise";
  status?: "trial" | "active" | "suspended" | "pending_delete" | "trialing" | "canceled" | "past_due";
  q?: string;
  feature?: "line" | "webhook" | "github" | "api_token" | "automation" | "import" | "no_project";
}
type Mode = "selected" | "filter" | "all";
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
  /** S8 · ตามตัวกรอง / ทุกราย ยังไม่มีรายชื่อจนกว่าจะส่ง */
  target?: { mode: Mode; filter: AnnounceFilter | null };
  recipients: number | null;
  email: { total: number; sent: number; suppressed: number; failed: number; waiting: number } | null;
  canCancel: boolean;
}

/** `datetime-local` (yyyy-mm-ddThh:mm) เป็นเวลาไทยเสมอ ไม่ขึ้นกับเครื่องของพนักงาน */
const bangkok = (local: string) => new Date(`${local}:00+07:00`);

/** ตัวกรองเป็นข้อความ เช่น "Team S, ทดลองใช้ · ไม่รวมที่ระงับ" */
function useFilterText() {
  const t = useTranslations("ann.c8");
  return (f: AnnounceFilter) => {
    const parts = [f.plan && t(`filterLabels.plan.${f.plan}`), f.status && t(`filterLabels.status.${f.status}`), f.feature && t(`filterLabels.feature.${f.feature}`), f.q && t("filterQ", { q: f.q })].filter(Boolean);
    const base = parts.length ? parts.join(", ") : t("filterNone");
    return f.status ? base : `${base} · ${t("notSuspended")}`;
  };
}

/**
 * C8 · ส่งประกาศถึงลูกค้า (Drawer ด้านขวา · เปิดจาก Workspaces › เลือกหลายแถว › ส่งประกาศ)
 * ผู้รับ (S8): ที่เลือกไว้ · ทุก Workspace ตามตัวกรองของหน้า Workspaces (`filter` · หารายชื่อตอนส่ง) · ลูกค้าทุกราย · เกิน 1,000 รายต้องแตะกุญแจ
 * ถึง Owner / Admin · ช่องทาง อีเมล / แบนเนอร์ / ทั้งสอง · ส่งตอนนี้หรือตั้งเวลา · ดูตัวอย่างและส่งทดสอบถึงตัวเองก่อน
 */
export function AnnounceDrawer({ workspaceIds, filter, sampleName, onClose, onDone }: { workspaceIds: string[]; filter?: AnnounceFilter; sampleName?: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ann.c8");
  const fmt = useFmt();
  const toast = useToast();
  const reauth = useReauth();
  const filterText = useFilterText();
  const modes: Mode[] = [...(workspaceIds.length ? (["selected"] as const) : []), ...(filter ? (["filter"] as const) : []), "all"];
  const [mode, setMode] = useState<Mode>(modes[0]);
  const [channel, setChannel] = useState<Channel>("both");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [when, setWhen] = useState<"now" | "scheduled">("now");
  const [at, setAt] = useState("");
  const [touched, setTouched] = useState(false);
  // ที่เลือกไว้ส่งรูปเดิม (ไม่มี targetMode) · ตามตัวกรอง / ทุกราย ส่งโหมดไปให้ ops-api หารายชื่อ
  const targetOf = (m: Mode) => (m === "selected" ? { workspaceIds } : m === "filter" ? { targetMode: "filter" as const, filter } : { targetMode: "all" as const });
  const counts = useQueries({
    queries: modes.map((m) => ({
      queryKey: ["ops", "announcements", "audience", m, m === "selected" ? [...workspaceIds].sort().join(",") : m === "filter" ? JSON.stringify(filter) : ""],
      queryFn: () => api.post<Audience>("/announcements/audience", targetOf(m)),
    })),
  });
  const audience = counts[modes.indexOf(mode)];
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
    mutationFn: () =>
      reauth.run(
        () => api.post<AnnouncementItem>("/announcements", { ...targetOf(mode), title: title.trim(), message: message.trim(), channels: CHANNELS[channel], scheduledAt: scheduledAt ? scheduledAt.toISOString() : null }),
        t("reauthLabel", { count: audience.data?.workspaces ?? 0 }),
      ),
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
      title={t("title")}
      description={`C8 · ${t("subtitle")}${a ? ` · ${t("people", { count: a.people })}` : audience.isPending ? ` · ${t("counting")}` : ""}`}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid) send.mutate();
        }}
      >
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("to")}</legend>
          {modes.map((m, i) => {
            const n = counts[i].data?.workspaces;
            const hint = m === "selected" ? t("mode.selectedHint", { count: fmt.num(workspaceIds.length) }) : n == null ? t("mode.counting") : m === "filter" ? t("mode.filterHint", { filter: filterText(filter!), count: fmt.num(n) }) : t("mode.allHint", { count: fmt.num(n) });
            return (
              <label key={m} className="check">
                <input type="radio" name="c8-to" checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  {t(`mode.${m}`)}
                  <span className="muted small" style={{ display: "block" }}>
                    {hint}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <InlineError error={audience.error} />
        {a && emailOn && a.suppressed > 0 && <Notice tone="warn">{bannerOn ? t("suppressed", { count: a.suppressed }) : t("suppressedEmailOnly", { count: a.suppressed })}</Notice>}
        {a && mode === "selected" && a.noRecipients.length > 0 && <Notice tone="warn">{t("noRecipients", { names: a.noRecipients.map((w) => w.name).join(", ") })}</Notice>}
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
        {a && <Notice tone="info">{emailOn ? t("estimate", { ws: fmt.num(a.workspaces), people: fmt.num(a.people), minutes: fmt.num(Math.max(1, a.minutes ?? 1)) }) : t("estimateBanner", { ws: fmt.num(a.workspaces), people: fmt.num(a.people) })}</Notice>}
        {a?.needsReauth && <p className="muted small">{t("reauthNote")}</p>}
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
