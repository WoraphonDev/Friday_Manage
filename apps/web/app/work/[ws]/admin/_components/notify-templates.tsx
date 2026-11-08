"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorState, LoadingState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { Switch } from "./shared";
import { adminKey, workPath, wsPath, type Preview, type PreviewMessage } from "./types";
import styles from "./notify.module.css";

/** เหตุการณ์ที่ API มีตัวอย่างข้อมูล (A25 › SAMPLES) ตามลำดับใน Canvas */
export const PREVIEW_EVENTS = [
  { event: "issue.assigned", key: "assign" },
  { event: "due_request.created", key: "due" },
  { event: "bug.created", key: "bug" },
  { event: "digest.daily", key: "digest" },
] as const;

/** N2 · หน้าตาข้อความแจ้งเตือน (ดูอย่างเดียว · Admin) */
export function NotifyTemplates({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.templates");
  const { me } = useWorkspace();
  const [picked, setPicked] = useState<(typeof PREVIEW_EVENTS)[number]>(PREVIEW_EVENTS[1]);
  // null = ใช้ค่าโหมดปลอดภัยของ Workspace · สวิตช์ในหน้านี้เปลี่ยนแค่ตัวอย่าง ไม่บันทึก
  const [safe, setSafe] = useState<boolean | null>(null);
  const url = (channel: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ channel, ...extra });
    if (safe !== null) p.set("safe", String(safe));
    return `${wsPath(ws)}/notification-templates/${picked.event}/preview?${p}`;
  };
  const email = useQuery({ queryKey: adminKey(ws, "preview", picked.event, "email", String(safe)), queryFn: () => api.get<Preview>(url("email")) });
  const hook = useQuery({ queryKey: adminKey(ws, "preview", picked.event, "webhook", String(safe)), queryFn: () => api.get<Preview>(url("webhook", { format: "json" })) });
  const error = email.error ?? hook.error;
  const data = email.data;
  const isSafe = safe ?? data?.safeMode ?? true;
  const m = data?.message;
  const subject = (data?.rendered as { subject?: string } | undefined)?.subject ?? "";

  return (
    <div className={styles.page}>
      <nav className={styles.crumb} aria-label={t("crumbLabel")}>
        <Link href={`${workPath(ws)}/admin`}>{t("crumbAdmin")}</Link> › <Link href={`${workPath(ws)}/admin/notify`}>{t("crumbNotify")}</Link> › <span>{t("crumbTemplate")}</span>
      </nav>
      <div className={styles.top}>
        <div>
          <h1>{t("title")}</h1>
          <div className={styles.muted}>{t("description")}</div>
        </div>
        <div className={styles.safe}>
          <Switch checked={isSafe} label={t("safe")} onChange={setSafe} />
          <div>
            <b>{t("safe")}</b>
            <div className={styles.muted}>{t("safeHint")}</div>
          </div>
        </div>
      </div>
      <div className={styles.chips} role="group" aria-label={t("events")}>
        {PREVIEW_EVENTS.map((e) => (
          <button key={e.event} type="button" className={styles.chip} aria-pressed={picked.event === e.event} onClick={() => setPicked(e)}>
            {t(`ev_${e.key}`)} <span className={styles.chipTo}>· {t(`to_${e.key}`)}</span>
          </button>
        ))}
      </div>
      {error ? (
        <ErrorState error={error} retry={() => { void email.refetch(); void hook.refetch(); }} />
      ) : !m || !hook.data ? (
        <LoadingState />
      ) : (
        <div className={styles.cols}>
          <div className={styles.col}>
            <div className={styles.lbl}>{t("line")} <span className={styles.tag}>{t(`line_${picked.key}`)}</span></div>
            <div className={styles.phone} aria-label={t("lineAria")} role="figure">
              <div className={styles.oa}>
                <span className={styles.oaav} aria-hidden="true">F</span>
                <div className={styles.flex}>
                  <div className={styles.fh} style={{ background: m.color }}>{m.head}</div>
                  <div className={styles.fb}>
                    <b className={styles.fTitle}>{m.title}</b>
                    <span className={styles.muted}>{m.project}</span>
                    <Details m={m} safe={isSafe} />
                  </div>
                  {m.buttons.map((b) => <span key={b.label} className={styles.fbtn}>{b.label}</span>)}
                </div>
              </div>
              <div className={styles.lineNote}>{picked.key === "due" ? t("lineNoteDue") : t("lineNote")}</div>
            </div>
          </div>
          <div className={styles.col}>
            <div className={styles.lbl}>{t("email")} <span className={styles.tag}>{t(`mail_${picked.key}`)}</span></div>
            <div className={styles.mail} aria-label={t("emailAria")} role="figure">
              <div className={styles.mh}>
                <div><span className={styles.muted}>{t("from")}</span> Friday Manage</div>
                <div><span className={styles.muted}>{t("to")}</span> {me.email}</div>
                <div className={styles.subject}>{subject}</div>
              </div>
              <div className={styles.mb}>
                <div className={styles.bar} style={{ background: m.color }} />
                <div className={styles.mTitle}>{m.head}: {m.title}</div>
                <div className={styles.muted}>{m.project}</div>
                <Details m={m} safe={isSafe} table />
                <div><span className={styles.mbtn}>{m.buttons[0]?.label ?? t("open")}</span></div>
                <div className={`${styles.muted} ${styles.foot}`}>{t("why")}</div>
              </div>
            </div>
          </div>
          <div className={styles.col}>
            <div className={styles.lbl}>{t("webhook")} <span className={styles.tag}>{t(`hook_${picked.key}`)}</span></div>
            <div className={styles.hook} aria-label={t("webhookAria")} role="figure">
              <div className={styles.emb} style={{ borderTopColor: m.color }}>
                <b>{m.head}</b>
                <span className={styles.embTitle}>{m.title}</span>
                <span className={styles.embMuted}>{m.project}</span>
                {!isSafe && m.rows.length > 0 && (
                  <div className={styles.embGrid}>
                    {m.rows.map(([k, v]) => <div key={k}><div className={styles.embMuted}>{k}</div><b>{v}</b></div>)}
                  </div>
                )}
              </div>
              <div className={styles.embMuted}>{t("webhookNote")}</div>
              <div className={styles.embLabel}>{t("payload")}</div>
              <pre className={styles.code} aria-label={t("payload")}>{JSON.stringify(hook.data.rendered, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
      <div className={styles.notes}>
        <div><b>{t("noteWhoTitle")}</b><div className={styles.muted}>{t("noteWho")}</div></div>
        <div><b>{t("noteButtonsTitle")}</b><div className={styles.muted}>{t("noteButtons")}</div></div>
        <div><b>{t("noteLangTitle")}</b><div className={styles.muted}>{t("noteLang")}</div></div>
      </div>
    </div>
  );
}

function Details({ m, safe, table }: { m: PreviewMessage; safe: boolean; table?: boolean }) {
  const t = useTranslations("admin-automation.templates");
  if (safe) return <span className={styles.muted}>{t("safeBody")}</span>;
  return (
    <>
      {table ? (
        <table className={styles.table}>
          <tbody>{m.rows.map(([k, v]) => <tr key={k}><td className={styles.muted}>{k}</td><td><b>{v}</b></td></tr>)}</tbody>
        </table>
      ) : (
        m.rows.map(([k, v]) => <div key={k} className={styles.fr}><span className={styles.muted}>{k}</span><b>{v}</b></div>)
      )}
      {m.note && <div className={styles.note}>“{m.note}”</div>}
    </>
  );
}
