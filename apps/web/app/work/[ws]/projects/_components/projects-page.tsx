"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Folder, Plus } from "lucide-react";
import { LoadingState } from "@/components/ui";
import { MobileHeader } from "@/components/shell/mobile-header";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { FALLBACK_PROJECT_COLOR } from "@/lib/colors";
import { formatDate } from "@/lib/format";
import type { HomeData } from "../../my-tasks/_components/types";

type Filter = "all" | "mine" | "risk";

/**
 * รายการโปรเจกต์ (ต้นแบบ u.projects · ฐาน B): หัวใหญ่ · ตัวเลือกแบบแบ่งช่อง · การ์ดโปรเจกต์พร้อมความคืบหน้า · ปุ่มสร้างโปรเจกต์ลอย
 * รายชื่อจาก Workspace (ทุกโปรเจกต์ที่เข้าถึงได้) · ความคืบหน้า / สุขภาพ / งานของฉัน จาก /home (cache เดียวกับหน้าหลัก)
 * ต้นแบบแบ่ง "ติดดาว" แต่ระบบยังไม่มีการติดดาว จึงใช้ "มีงานของฉัน" แทน
 */
export function ProjectsPage({ ws }: { ws: string }) {
  const t = useTranslations("home-my-tasks.projectsPage");
  const th = useTranslations("home-my-tasks.home");
  const { workspace, projects } = useWorkspace();
  const home = useQuery({ queryKey: ["home", ws], queryFn: () => api.get<HomeData>(`/w/${encodeURIComponent(ws)}/home`) });
  const [filter, setFilter] = useState<Filter>("all");
  const stats = new Map((home.data?.projects ?? []).map((p) => [p.key, p]));
  const risky = (key: string) => ["at_risk", "off_track"].includes(stats.get(key)?.health.level ?? "");
  const mine = (key: string) => (stats.get(key)?.myTasks ?? 0) > 0;
  const counts: Record<Filter, number> = { all: projects.length, mine: projects.filter((p) => mine(p.key)).length, risk: projects.filter((p) => risky(p.key)).length };
  const list = projects.filter((p) => filter === "all" || (filter === "mine" ? mine(p.key) : risky(p.key)));
  const base = `/work/${encodeURIComponent(ws)}`;
  return (
    <div className="m-page">
      <MobileHeader title={t("title")} subtitle={t("subtitle", { name: workspace.name, count: projects.length })} />
      <div className="m-seg" role="group" aria-label={t("filterLabel")}>
        {(["all", "mine", "risk"] as const).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`filters.${f}`)} <small>{counts[f]}</small>
          </button>
        ))}
      </div>
      {home.isPending && projects.length === 0 ? (
        <LoadingState />
      ) : list.length === 0 ? (
        <div className="m-empty" style={{ marginTop: 12 }}>{t("empty")}</div>
      ) : (
        <div className="m-cards" style={{ paddingTop: 12 }}>
          {list.map((p) => {
            const s = stats.get(p.key);
            const level = s?.health.level;
            return (
              <Link key={p.key} className="m-card" href={`${base}/p/${encodeURIComponent(p.key)}`}>
                <div className="m-card-top">
                  <span className="m-proj-icon" style={{ background: p.color ?? FALLBACK_PROJECT_COLOR }}>{p.key.slice(0, 2)}</span>
                  {(level === "at_risk" || level === "off_track") && (
                    <span className={`m-pill ${level === "off_track" ? "m-pill-bad" : "m-pill-warn"}`}>{th(`mobileHealth.${level}`)}</span>
                  )}
                  <span className="m-key" style={{ marginLeft: "auto" }}>{p.key}</span>
                </div>
                <h3>{p.name}</h3>
                <div className="m-sm m-muted">
                  {s ? th("mobileProgress", { pct: s.progressPct }) : formatDate(p.startDate)}
                  {s?.overdue ? ` · ${t("overdue", { count: s.overdue })}` : ""}
                </div>
                {s && <div className="m-progress" role="presentation"><i style={{ width: `${Math.max(0, Math.min(100, s.progressPct))}%` }} /></div>}
                <div className="m-card-bot">
                  <Folder size={16} aria-hidden="true" />
                  <span>{th("mobileMine", { count: s?.myTasks ?? 0 })}</span>
                  <span className="m-spacer" />
                  <span>{s?.daysToGolive != null && s.daysToGolive >= 0 ? t("golive", { days: s.daysToGolive }) : t("goliveDate", { date: formatDate(p.goliveDate) })}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {workspace.role !== "guest" && (
        <Link className="m-fab" href={`${base}/new-project`}>
          <Plus size={22} aria-hidden="true" />{t("create")}
        </Link>
      )}
    </div>
  );
}
