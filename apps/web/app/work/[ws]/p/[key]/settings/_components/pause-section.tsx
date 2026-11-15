"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Member, ProjectDetail } from "./types";
import { projectEndpoint } from "./shared";
import styles from "./settings.module.css";

type Mode = "pause" | "viewers" | "resume";

/**
 * พักโปรเจกต์ (ผู้ใช้ขอ 2026-11-15 · mockup แบบ A)
 * ระหว่างพักเห็นได้เฉพาะ Owner / Admin ของโปรเจกต์, Owner / Admin ของ Workspace และสมาชิกที่เลือก · API ซ่อนผ่าน RLS
 */
export function PauseRow({ ws, projectKey, project, members, refresh }: { ws: string; projectKey: string; project: ProjectDetail; members: Member[]; refresh: () => Promise<void> }) {
  const t = useTranslations("project-settings-new.settings.danger.pause");
  const { me } = useWorkspace();
  const [mode, setMode] = useState<Mode | null>(null);
  const viewers = members.filter((m) => m.visibleWhilePaused && !m.alwaysSeesWhilePaused);

  return (
    <>
      {project.pausedAt ? (
        <div className={`${styles.dz} ${styles.dzPaused}`}>
          <div>
            <b>{t("pausedTitle")}</b>
            <div className={styles.pausedMeta}>
              {t("pausedSince", { date: formatDate(project.pausedAt, me.yearFormat, true) })}
              {" · "}
              {viewers.length ? t("viewersList", { names: viewers.map((m) => m.displayName).join(", ") }) : t("viewersNone")}
            </div>
          </div>
          <div className={styles.dzActions}>
            <Button onClick={() => setMode("viewers")}>{t("manageViewers")}</Button>
            <Button variant="primary" onClick={() => setMode("resume")}>{t("resume")}</Button>
          </div>
        </div>
      ) : (
        <div className={styles.dz}>
          <div>
            <b>{t("title")}</b>
            <div className={styles.muted}>{t("hint")}</div>
          </div>
          <Button onClick={() => setMode("pause")}>{t("pause")}</Button>
        </div>
      )}
      {mode && (
        <PauseDialog
          key={mode}
          mode={mode}
          ws={ws}
          projectKey={projectKey}
          project={project}
          members={members}
          onClose={() => setMode(null)}
          refresh={refresh}
        />
      )}
    </>
  );
}

function PauseDialog({
  mode,
  ws,
  projectKey,
  project,
  members,
  onClose,
  refresh,
}: {
  mode: Mode;
  ws: string;
  projectKey: string;
  project: ProjectDetail;
  members: Member[];
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const t = useTranslations("project-settings-new.settings.danger.pause");
  const toast = useToast();
  const base = projectEndpoint(ws, projectKey);
  const active = members.filter((m) => m.active);
  const always = active.filter((m) => m.alwaysSeesWhilePaused);
  const choosable = active.filter((m) => !m.alwaysSeesWhilePaused);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(choosable.filter((m) => m.visibleWhilePaused).map((m) => m.userId)));
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const hidden = choosable.filter((m) => !picked.has(m.userId));
  const hiddenTasks = hidden.reduce((sum, m) => sum + (m.openIssues ?? 0), 0);
  // ตอนเปิดต่อ แจ้งคนที่มองไม่เห็นอยู่ตอนนี้
  const resumeAudience = choosable.filter((m) => !m.visibleWhilePaused).length;

  function toggle(userId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    try {
      const text = message.trim() || undefined;
      if (mode === "pause") await api.post(`${base}/pause`, { viewerIds: [...picked], notify, message: notify ? text : undefined });
      else if (mode === "viewers") await api.put(`${base}/pause/viewers`, { viewerIds: [...picked] });
      else await api.post(`${base}/resume`, { notify, message: notify ? text : undefined });
      toast({ message: t(mode === "pause" ? "paused" : mode === "viewers" ? "viewersSaved" : "resumed", { name: project.name }) });
      await refresh();
      onClose();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : t("failed") });
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "pause" ? t("dialogTitle", { name: project.name }) : mode === "viewers" ? t("viewersTitle") : t("resumeTitle", { name: project.name });
  const description = mode === "pause" ? t("dialogHint") : mode === "viewers" ? t("viewersHint") : t("resumeHint");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={title} description={description} size="medium">
      <div className={styles.dialogForm}>
        {mode !== "resume" && (
          <>
            <section className={styles.pauseGroup} aria-label={t("alwaysTitle")}>
              <div className={styles.pauseGroupHead}>
                <b>{t("alwaysTitle")}</b>
                <span>{t("alwaysHint")}</span>
              </div>
              <ul className={styles.pauseList}>
                {always.map((m) => (
                  <li key={m.userId} className={styles.pauseRow}>
                    <span className={styles.pauseName}>
                      {m.displayName}
                      <small>{m.isOwner ? t("roleOwner") : m.role === "admin" ? t("roleAdmin") : t("roleWsAdmin")}</small>
                    </span>
                    <span className={styles.pauseSees}>{t("sees")}</span>
                  </li>
                ))}
                <li className={styles.pauseRow}>
                  <span className={styles.pauseName}>
                    {t("wsAdmins")}
                    <small>{t("wsAdminsHint")}</small>
                  </span>
                  <span className={styles.pauseSees}>{t("sees")}</span>
                </li>
              </ul>
            </section>
            <section className={styles.pauseGroup} aria-label={t("pickTitle")}>
              <div className={styles.pauseGroupHead}>
                <b>{t("pickTitle")}</b>
                <span>{t("pickCount", { picked: picked.size, total: choosable.length })}</span>
              </div>
              {choosable.length ? (
                <ul className={styles.pauseList}>
                  {choosable.map((m) => (
                    <li key={m.userId}>
                      <label className={styles.pauseRow}>
                        <input type="checkbox" checked={picked.has(m.userId)} onChange={() => toggle(m.userId)} />
                        <span className={styles.pauseName}>
                          {m.displayName}
                          <small>{m.isGuest ? t("guest") : t("openTasks", { count: m.openIssues ?? 0 })}</small>
                        </span>
                        <span className={styles.muted}>{t(`role.${m.role}`)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>{t("noChoosable")}</p>
              )}
            </section>
          </>
        )}
        {mode !== "viewers" && (
          <>
            <div className={styles.switchRow}>
              <button type="button" role="switch" className={styles.switch} aria-checked={notify} aria-label={t(mode === "pause" ? "notifyPause" : "notifyResume")} onClick={() => setNotify(!notify)}>
                <span />
              </button>
              <div>
                <b>{t(mode === "pause" ? "notifyPause" : "notifyResume")}</b>
                <div className={styles.muted}>{t("notifyHint")}</div>
              </div>
            </div>
            {notify && (
              <label className={styles.fld}>
                <span className={styles.lb}>{t("message")}</span>
                <textarea rows={3} maxLength={500} value={message} placeholder={t(mode === "pause" ? "messagePlaceholder" : "messagePlaceholderResume")} onChange={(e) => setMessage(e.target.value)} />
              </label>
            )}
          </>
        )}
        <p className={styles.pauseSummary}>
          {mode === "resume"
            ? t("resumeSummary", { count: resumeAudience })
            : hidden.length
              ? t("summary", { people: hidden.length, tasks: hiddenTasks })
              : t("summaryNone")}
        </p>
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {mode === "pause" ? t("pauseConfirm") : mode === "viewers" ? t("save") : t("resumeConfirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
