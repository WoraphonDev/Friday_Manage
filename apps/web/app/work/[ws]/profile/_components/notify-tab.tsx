"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge, Button, ConfirmDialog, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { errorText, SectionError, Switch, workPath, wsPath } from "./shared";
import { type LineStatus, type LinkCode, type NotifySettings, type PrefChannel, type PrefGroup, type Prefs, profileKeys } from "./types";
import styles from "./profile.module.css";

const GROUPS: PrefGroup[] = ["assigned", "activity", "schedule", "project"];
const CHANNELS: PrefChannel[] = ["in_app", "email", "line"];
/** ช่วงงดส่งตาม Canvas I (ค่าเริ่มต้นของ API เดียวกัน) */
const QUIET = { quietStart: "20:00", quietEnd: "08:00" };
const SETTINGS_DEFAULT = { dueReminder: "1d_and_today", digest: "workdays", ...QUIET, quietOnHolidays: true, autoWatch: true } as const;
type SettingsDraft = Pick<NotifySettings, "dueReminder" | "digest" | "quietStart" | "quietEnd" | "quietOnHolidays" | "autoWatch">;
const cellKey = (eventType: string, channel: PrefChannel) => `${eventType}|${channel}`;

export function NotifyTab({ ws }: { ws: string }) {
  const t = useTranslations("profile.notify");
  const tc = useTranslations("common.app");
  // ชื่อเหตุการณ์จาก API เป็นภาษาไทย · แปลตาม eventType (W21) · เหตุการณ์ใหม่ที่ยังไม่มีคำแปลใช้ข้อความจาก API
  const evKey = (r: { eventType: string }) => `events.${r.eventType.replace(/\./g, "_")}`;
  const evLabel = (r: { eventType: string; label: string }) => (t.has(`${evKey(r)}.label` as "title") ? t(`${evKey(r)}.label` as "title") : r.label);
  const evHint = (r: { eventType: string; hint?: string | null }) => (t.has(`${evKey(r)}.hint` as "title") ? t(`${evKey(r)}.hint` as "title") : r.hint);
  const { me, projects } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const prefs = useQuery({ queryKey: profileKeys.prefs(ws), queryFn: () => api.get<Prefs>(`/me/notification-prefs?workspace=${encodeURIComponent(ws)}`) });
  const settings = useQuery({ queryKey: profileKeys.settings(ws), queryFn: () => api.get<NotifySettings>(`/me/notification-settings?workspace=${encodeURIComponent(ws)}`) });
  const line = useQuery({ queryKey: profileKeys.line, queryFn: () => api.get<LineStatus>("/me/line") });
  const [cells, setCells] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!prefs.data) return;
    setCells(Object.fromEntries(prefs.data.rows.flatMap((r) => CHANNELS.map((c) => [cellKey(r.eventType, c), r.channels[c].enabled]))));
  }, [prefs.data]);
  useEffect(() => {
    if (settings.data) setDraft({ dueReminder: settings.data.dueReminder, digest: settings.data.digest, quietStart: settings.data.quietStart, quietEnd: settings.data.quietEnd, quietOnHolidays: settings.data.quietOnHolidays, autoWatch: settings.data.autoWatch });
  }, [settings.data]);

  if (prefs.isPending || settings.isPending) return <LoadingState />;
  const failed = prefs.error ?? settings.error;
  if (failed) return <SectionError error={failed} retry={() => { void prefs.refetch(); void settings.refetch(); }} />;
  if (!draft || !prefs.data || !settings.data) return <LoadingState />;
  const saved = settings.data;
  const rows = prefs.data.rows;
  const emailOn = rows.some((r) => cells[cellKey(r.eventType, "email")]);
  const quietOn = draft.quietStart !== null;
  const teamProject = projects.find((p) => p.joined);

  async function save() {
    setPending(true);
    try {
      // ส่งทั้งเมทริกซ์ (ยกเว้นช่องที่ล็อก) เพื่อให้ค่าที่เห็นเป็นค่าที่ตัวส่งใช้จริง (บันทึกผล A20)
      const body = rows.flatMap((r) => CHANNELS.filter((c) => !r.channels[c].locked).map((c) => ({ eventType: r.eventType, channel: c, enabled: !!cells[cellKey(r.eventType, c)] })));
      const [p, s] = await Promise.all([
        api.put<Prefs>("/me/notification-prefs", { workspace: ws, prefs: body }),
        api.put<NotifySettings>("/me/notification-settings", { workspace: ws, ...draft }),
      ]);
      cache.setQueryData(profileKeys.prefs(ws), p);
      cache.setQueryData(profileKeys.settings(ws), s);
      toast({ message: t("saved") });
    } catch (e) {
      toast({ message: errorText(e, tc("unknownError")) });
    } finally {
      setPending(false);
    }
  }
  async function reset() {
    setPending(true);
    try {
      const [p, s] = await Promise.all([
        api.put<Prefs>("/me/notification-prefs", { workspace: ws, prefs: [], reset: true }),
        api.put<NotifySettings>("/me/notification-settings", { workspace: ws, ...SETTINGS_DEFAULT }),
      ]);
      cache.setQueryData(profileKeys.prefs(ws), p);
      cache.setQueryData(profileKeys.settings(ws), s);
      toast({ message: t("resetDone") });
    } catch (e) {
      toast({ message: errorText(e, tc("unknownError")) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className={styles.notifyHead}>
        <div>
          <h2>{t("title")}</h2>
          <div className={styles.muted} style={{ fontSize: 12 }}>{t("description")}</div>
        </div>
        <div className={styles.channels}>
          <div className={styles.chn}>
            <span className={styles.chnIcon} style={{ background: "#475569" }} aria-hidden="true">IN</span>
            <div className={styles.chnText}><div className={styles.chnTitle}>{t("inAppTitle")}</div><div className={cn(styles.muted, styles.small)}>{t("inAppHint")}</div></div>
          </div>
          <div className={styles.chn}>
            <span className={styles.chnIcon} style={{ background: "#5B3FC4" }} aria-hidden="true">@</span>
            <div className={styles.chnText}><div className={styles.chnTitle}>Email</div><div className={cn(styles.muted, styles.small)} style={{ overflowWrap: "anywhere" }}>{me.email}</div></div>
            <Badge tone={emailOn ? "green" : "neutral"}>{emailOn ? t("on") : t("off")}</Badge>
          </div>
          <div className={styles.chn}>
            <span className={styles.chnIcon} style={{ background: "#15803D" }} aria-hidden="true">LN</span>
            <div className={styles.chnText}>
              <div className={styles.chnTitle}>{t("lineTitle")}</div>
              <div className={cn(styles.muted, styles.small)}>{line.data?.linked ? t("lineLinkedAs", { name: line.data.displayName ?? "LINE" }) : t("lineNotLinked")}</div>
            </div>
            <Button size="small" aria-expanded={lineOpen} onClick={() => setLineOpen(!lineOpen)}>{t("manage")}</Button>
          </div>
          <div className={cn(styles.chn, styles.dashed)}>
            <span className={styles.chnIcon} style={{ background: "#334155" }} aria-hidden="true">WH</span>
            <div className={styles.chnText}><div className={styles.chnTitle}>{t("teamTitle")}</div><div className={cn(styles.muted, styles.small)}>{t("teamHint")}</div></div>
            {teamProject && <Link className="button button-secondary button-small" href={`${workPath(ws)}/p/${encodeURIComponent(teamProject.key)}/settings/notify`}>{t("view")}</Link>}
          </div>
        </div>
        {lineOpen && <LinePanel ws={ws} status={line.data} />}
      </div>

      <div className={styles.matrixScroll}>
        <div className={styles.matrix} role="table" aria-label={t("matrixLabel")}>
          <div className={cn(styles.mx, styles.h)} role="row">
            <div role="columnheader">{t("event")}</div>
            {CHANNELS.map((c) => <div role="columnheader" key={c}>{t(`channel.${c}`)}</div>)}
          </div>
          {GROUPS.map((g) => {
            const list = rows.filter((r) => r.group === g);
            if (!list.length) return null;
            return (
              <div role="rowgroup" key={g}>
                <div className={cn(styles.mx, styles.g)} role="row"><div role="rowheader">{t(`group.${g}`)}</div></div>
                {list.map((r) => (
                  <div className={styles.mx} role="row" key={r.eventType}>
                    <div role="rowheader" style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{evLabel(r)}</div>
                      {r.hint && <div className={cn(styles.muted, styles.small)}>{evHint(r)}</div>}
                    </div>
                    {CHANNELS.map((c) => {
                      const locked = r.channels[c].locked;
                      return (
                        <span role="cell" key={c} style={{ display: "flex", justifyContent: "center" }}>
                          <input
                            type="checkbox"
                            className={styles.cb}
                            checked={locked || !!cells[cellKey(r.eventType, c)]}
                            disabled={locked}
                            title={locked ? t("locked") : undefined}
                            aria-label={t("cellLabel", { event: evLabel(r), channel: t(`channel.${c}`) })}
                            onChange={(e) => setCells({ ...cells, [cellKey(r.eventType, c)]: e.target.checked })}
                          />
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.prefSettings}>
        <Select label={t("dueReminder")} value={draft.dueReminder} onChange={(e) => setDraft({ ...draft, dueReminder: e.target.value as SettingsDraft["dueReminder"] })}>
          <option value="1d_and_today">{t("due.1d_and_today")}</option>
          <option value="3d">{t("due.3d")}</option>
          <option value="today_only">{t("due.today_only")}</option>
        </Select>
        <Select label={t("digest")} value={draft.digest} onChange={(e) => setDraft({ ...draft, digest: e.target.value as SettingsDraft["digest"] })}>
          <option value="workdays">{t("digestOption.workdays")}</option>
          <option value="daily">{t("digestOption.daily")}</option>
        </Select>
        <div className={styles.switchRow}>
          <Switch
            checked={quietOn}
            label={t("quietLabel")}
            onChange={(on) => setDraft({ ...draft, ...(on ? { quietStart: saved.quietStart ?? QUIET.quietStart, quietEnd: saved.quietEnd ?? QUIET.quietEnd, quietOnHolidays: true } : { quietStart: null, quietEnd: null, quietOnHolidays: false }) })}
          />
          <div>
            <div className={styles.lb}>{t("quietTitle", { start: draft.quietStart ?? QUIET.quietStart, end: draft.quietEnd ?? QUIET.quietEnd })}</div>
            <div className={cn(styles.muted, styles.small)}>{t("quietHint")}</div>
          </div>
        </div>
        <div className={styles.switchRow}>
          <Switch checked={draft.autoWatch} label="Auto-watch" onChange={(on) => setDraft({ ...draft, autoWatch: on })} />
          <div>
            <div className={styles.lb}>Auto-watch</div>
            <div className={cn(styles.muted, styles.small)}>{t("autoWatchHint")}</div>
          </div>
        </div>
      </div>
      <div className={styles.who}>
        <div>{t("whoTitle")}</div>
        <div>{t("whoBody")} · <span className={styles.muted}>{t("whoSelf")}</span></div>
      </div>
      <div className={styles.notifyActions}>
        <Button disabled={pending} onClick={() => void reset()}>{t("reset")}</Button>
        <Button variant="primary" disabled={pending} onClick={() => void save()}>{pending ? tc("saving") : tc("save")}</Button>
      </div>
    </div>
  );
}

/** ผูก LINE: รหัส 6 หลัก 10 นาที · ระหว่างรอผู้ใช้ส่งรหัสในแชต OA ถามสถานะซ้ำทุก 5 วินาทีจนผูกสำเร็จ */
function LinePanel({ ws, status }: { ws: string; status: LineStatus | undefined }) {
  const t = useTranslations("profile.line");
  const tc = useTranslations("common.app");
  const cache = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState<LinkCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  // boundAt ตอนขอรหัส: ผูกบัญชีใหม่ทับบัญชีเดิมได้ จึงดูว่า boundAt เปลี่ยนแทนการดูแค่ linked
  const [baseline, setBaseline] = useState<string | null>(null);
  const linked = !!status?.linked;
  const waiting = !!code;
  useQuery({
    queryKey: profileKeys.line,
    queryFn: () => api.get<LineStatus>("/me/line"),
    enabled: waiting,
    refetchInterval: waiting ? 5000 : false,
  });
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  useEffect(() => {
    if (code && linked && status?.boundAt !== baseline) {
      // ผูกสำเร็จแล้ว รหัสใช้ไม่ได้อีก จึงไม่แสดงต่อ
      setCode(null);
      toast({ message: t("linkedToast") });
    }
  }, [linked, code, baseline, status?.boundAt, toast, t]);
  async function newCode() {
    setBusy(true);
    try {
      setBaseline(status?.boundAt ?? null);
      setCode(await api.post<LinkCode>("/me/line/link-code"));
      setNow(Date.now());
    } catch (e) {
      toast({ message: errorText(e, tc("unknownError")) });
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      await api.post("/me/line/test", { workspace: ws });
      toast({ message: t("testSent") });
    } catch (e) {
      toast({ message: errorText(e, tc("unknownError")) });
    } finally {
      setBusy(false);
    }
  }
  const left = code ? Math.max(0, Math.ceil((new Date(code.expiresAt).getTime() - now) / 60000)) : 0;
  const expired = !!code && new Date(code.expiresAt).getTime() <= now;
  return (
    <div className={styles.linePanel} role="region" aria-label={t("title")}>
      <div className={styles.linePanelHead}><b>{t("title")}</b><span className={cn(styles.muted, styles.small)}>{t("oneAccount")}</span></div>
      <div className={styles.steps}>
        <div className={styles.step}><Badge tone="green">1</Badge><b>{t("step1")}</b><span className={cn(styles.muted, styles.small)}>{t("step1Hint")}</span></div>
        <div className={styles.step}>
          <Badge tone="green">2</Badge>
          <b>{t("step2")}</b>
          {code && !expired ? (
            <>
              <span className={styles.code} aria-label={t("codeLabel")}>{`${code.code.slice(0, 3)} ${code.code.slice(3)}`}</span>
              <span className={cn(styles.muted, styles.small)}>{t("expiresIn", { minutes: left })}</span>
            </>
          ) : (
            <span className={cn(styles.muted, styles.small)}>{expired ? t("expired") : t("noCode")}</span>
          )}
          <Button size="small" disabled={busy} onClick={() => void newCode()}>{code ? t("newCode") : t("getCode")}</Button>
        </div>
        <div className={styles.step}><Badge tone="green">3</Badge><b>{t("step3")}</b><span className={cn(styles.muted, styles.small)}>{waiting && !expired ? t("waiting") : t("step3Hint")}</span></div>
      </div>
      {linked && (
        <div className={styles.actionsStart}>
          <Button disabled={busy} onClick={() => void test()}>{t("test")}</Button>
          <Button disabled={busy} className={styles.danger} onClick={() => setUnlinking(true)}>{t("unlink")}</Button>
        </div>
      )}
      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        title={t("unlinkTitle")}
        description={t("unlinkDescription")}
        confirmLabel={t("unlink")}
        successMessage={t("unlinked")}
        onConfirm={async () => {
          await api.delete("/me/line");
          await cache.invalidateQueries({ queryKey: profileKeys.line });
        }}
      />
    </div>
  );
}
