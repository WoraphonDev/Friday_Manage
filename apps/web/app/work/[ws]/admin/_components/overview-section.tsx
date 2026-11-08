"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Button, EmptyState, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { formatDate } from "@/lib/format";
import { Card } from "./shared";
import { errorText, formatBytes, workPath, wsPath, type AdminOverview } from "./types";
import styles from "./admin.module.css";

/** เรื่องที่ต้องดำเนินการ → แท็บที่แก้ได้ */
const ACTION_TARGET: Record<string, { section: string; tone: string }> = {
  access_requests_pending: { section: "members", tone: "warn" },
  mfa_missing: { section: "security", tone: "bad" },
  over_capacity: { section: "load", tone: "warn" },
  seats_near_limit: { section: "bill", tone: "neu" },
  trial_ending: { section: "bill", tone: "neu" },
};

function Meter({ value, max }: { value: number; max: number }) {
  return <div className={styles.meter} aria-hidden="true"><span style={{ width: `${Math.min(100, max ? (value / max) * 100 : 0)}%` }} /></div>;
}

export function OverviewSection({ ws, data }: { ws: string; data: AdminOverview }) {
  const t = useTranslations("admin-automation.admin.overview");
  const { me } = useWorkspace();
  const num = useFormatter();
  const base = wsPath(ws);
  const pct = data.users.active ? Math.round((data.users.activeLast7Days / data.users.active) * 100) : 0;
  const max = Math.max(1, ...data.weeklyActiveUsers.map((w) => w.users));
  const first = data.weeklyActiveUsers[0]?.users ?? 0;
  const last = data.weeklyActiveUsers.at(-1)?.users ?? 0;
  return (
    <>
      <div className={styles.kpis}>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("users")}</span>
          <b>{data.users.active} {data.users.seatLimit === null ? <small>{t("noLimit")}</small> : <small>{t("seats", { n: data.users.seatLimit })}</small>}</b>
          {data.users.seatLimit !== null && <Meter value={data.users.active} max={data.users.seatLimit} />}
        </div>
        <div className={styles.kp}><span className={styles.muted}>{t("projects")}</span><b>{data.projects.active}</b><span className={`${styles.muted} ${styles.small}`}>{t("archived", { n: data.projects.archived })}</span></div>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("storage")}</span>
          <b>{formatBytes(data.storage.usedBytes)} <small>{data.storage.limitBytes === null ? t("noLimit") : `/ ${formatBytes(data.storage.limitBytes)}`}</small></b>
          {data.storage.limitBytes !== null && <Meter value={data.storage.usedBytes} max={data.storage.limitBytes} />}
        </div>
        <div className={styles.kp}><span className={styles.muted}>{t("active7d")}</span><b>{t("people", { n: data.users.activeLast7Days })}</b><span className={`${styles.muted} ${styles.small}`}>{t("ofUsers", { pct })}</span></div>
        <div className={styles.kp}><span className={styles.muted}>{t("issues")}</span><b>{num.number(data.issues.total)}</b><span className={`${styles.muted} ${styles.small}`}>{t("open", { n: num.number(data.issues.open) })}</span></div>
      </div>
      {/* Canvas: เรื่องที่ต้องทำกับกราฟผู้ใช้อยู่แถวเดียวกัน */}
      <div className={styles.split}>
      <Card title={t("actions")} actions={data.actions.length > 0 && <span className={`${styles.pill} ${styles.bad}`}>{data.actions.length}</span>}>
        {data.actions.length ? (
          data.actions.map((a) => {
            const target = ACTION_TARGET[a.code] ?? { section: "overview", tone: "neu" };
            return (
              <div key={a.code} className={styles.alert}>
                <span className={`${styles.pill} ${styles[target.tone]}`}>{t(`action.${a.code}`)}</span>
                <span className={styles.grow}>{a.message}</span>
                <Link className="button button-secondary button-small" href={target.section === "members" ? `/work/${encodeURIComponent(ws)}/members` : `/work/${encodeURIComponent(ws)}/admin/${target.section}`}>{t("view")}</Link>
              </div>
            );
          })
        ) : (
          <span className={styles.muted}>{t("noActions")}</span>
        )}
      </Card>
      <Card title={t("wauTitle")}>
        {data.weeklyActiveUsers.length ? (
          <>
            <div className={styles.bars} role="img" aria-label={t("wauAria", { from: first, to: last })}>
              {data.weeklyActiveUsers.map((w) => (
                <div key={w.week}>
                  <b>{w.users}</b>
                  <span style={{ height: `${(w.users / max) * 80}%` }} />
                  {formatDate(w.week, me.yearFormat)}
                </div>
              ))}
            </div>
            <span className={styles.muted}>{t("wauHint", { from: first, to: last })}</span>
          </>
        ) : (
          <span className={styles.muted}>{t("wauEmpty")}</span>
        )}
      </Card>
      </div>
    </>
  );
}

export function ProjectsSection({ ws, data }: { ws: string; data: AdminOverview }) {
  const t = useTranslations("admin-automation.admin.projects");
  const { me, projects } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const joined = new Map(projects.map((p) => [p.key, p.joined]));
  async function join(key: string) {
    setBusy(key);
    try {
      await api.post(`${wsPath(ws)}/projects/${encodeURIComponent(key)}/join-as-admin`);
      toast({ message: t("joined", { key }) });
      await cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card title={t("title")} label={t("title")}>
      {data.projectList.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <div style={{ margin: "-16px -18px" }}>
          {data.projectList.map((p) => {
            // ไม่อยู่ในรายการโปรเจกต์ของฉัน (เช่น Archive แล้ว) = เปิดดูได้แต่ไม่มีปุ่มเข้าร่วม
            const isMember = joined.get(p.key) ?? true;
            return (
              <div key={p.id} className={styles.proj}>
                <span className={styles.key}>{p.key}</span>
                <span style={{ minWidth: 0 }}>
                  <b>{p.name}</b>
                  <div className={styles.muted}>{t("pm", { name: p.pm?.displayName ?? t("noPm") })}</div>
                </span>
                <span className={`${styles.pill} ${p.visibility === "private" ? styles.ent : styles.neu} ${styles.hs}`}>{t(p.visibility === "private" ? "private" : "workspace")}</span>
                <span className={`${styles.pill} ${p.status === "archived" ? styles.neu : styles.ok} ${styles.hs}`}>{t(p.status === "archived" ? "statusArchived" : "statusActive")}</span>
                <span className={`${styles.muted} ${styles.hs}`}>{t("members", { n: p.memberCount })}</span>
                <span className={`${styles.muted} ${styles.hs}`}>{p.lastActivityAt ? formatDate(p.lastActivityAt, me.yearFormat) : t("noActivity")}</span>
                <span className={styles.chips}>
                  {isMember ? (
                    <Link className="button button-secondary button-small" href={`${workPath(ws)}/p/${encodeURIComponent(p.key)}`}>{t("open")}</Link>
                  ) : (
                    <Button size="small" variant="primary" disabled={busy === p.key} onClick={() => void join(p.key)}>{t("join")}</Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <span className={styles.muted}>{t("hint")}</span>
    </Card>
  );
}
