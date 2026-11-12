"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { hasAny } from "@/components/access";
import { NoAccess, Notice, PageHead, Tabs } from "@/components/kit";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { History } from "./_parts/History";
import { Pending } from "./_parts/Pending";
import { Search } from "./_parts/Search";
import type { PendingWorkspace, Summary } from "./_parts/types";

type Tab = "search" | "pending" | "history";
const TABS: Tab[] = ["search", "pending", "history"];

/**
 * บอร์ด 21 · กู้คืนข้อมูลลูกค้า (design/proposals/phase3/05-restore-data.html · O31)
 * Support / Owner กู้คืนและยืดเวลา · วิศวกรและผู้ตรวจอ่านอย่างเดียว · การเงินไม่มีเมนูนี้ · ops-api ตรวจสิทธิ์ซ้ำ
 */
export function RestorePage() {
  const t = useTranslations("rst");
  const me = useMe().data;
  const params = useSearchParams();
  const router = useRouter();
  const canRead = hasAny(me, "owner", "support", "engineer", "auditor");
  const canAct = hasAny(me, "owner", "support");
  const tab = (TABS as string[]).includes(params?.get("tab") ?? "") ? (params!.get("tab") as Tab) : "search";
  const summary = useQuery({ queryKey: ["ops", "restore", "summary"], queryFn: () => api.get<Summary>("/restore/summary"), enabled: !!me && canRead });
  const pending = useQuery({ queryKey: ["ops", "restore", "workspaces"], queryFn: () => api.get<{ items: PendingWorkspace[]; extendLimitDays: number }>("/restore/workspaces"), enabled: !!me && canRead });
  if (me && !canRead) return <NoAccess need={["owner", "support", "engineer", "auditor"]} />;
  const s = summary.data;
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} />
      {s && (
        <section className="stats" aria-label={t("title")}>
          <div className="stat">
            <span className="muted small">{t("stats.pending")}</span>
            <b className="num">{s.pendingWorkspaces}</b>
            <span className="muted small">{t("stats.pendingSoon", { n: s.pendingSoon })}</span>
          </div>
          <div className="stat">
            <span className="muted small">{t("stats.restored")}</span>
            <b className="num">{s.restored30d.total}</b>
            <span className="muted small">{t("stats.restoredSub", s.restored30d)}</span>
          </div>
          <div className="stat">
            <span className="muted small">{t("stats.tonight")}</span>
            <b className="num">{t("stats.tonightValue", s.purgeTonight)}</b>
            <span className="muted small">{t("stats.tonightSub", { time: s.purgeTonight.runsAt })}</span>
          </div>
          <div className="stat">
            <span className="muted small">{t("stats.backup")}</span>
            <b className="num">{t("stats.backupValue", { n: s.backupDays })}</b>
            <span className="muted small">{t("stats.backupSub")}</span>
          </div>
        </section>
      )}
      <Tabs
        label={t("tabs.label")}
        value={tab}
        onChange={(v) => router.replace(v === "search" ? "/restore" : `/restore?tab=${v}`)}
        tabs={[
          { value: "search", label: t("tabs.search") },
          {
            value: "pending",
            label: (
              <>
                {t("tabs.pending")} {pending.data ? <span className="pill neu">{pending.data.items.length}</span> : null}
              </>
            ),
          },
          { value: "history", label: t("tabs.history") },
        ]}
      />
      {me && !canAct && <Notice tone="info" title={t("readOnly")} />}
      {/* ตามบอร์ด 21: แท็บแรกแสดงการค้นและ Workspace ที่รอลบถาวรต่อกัน */}
      {tab === "search" && <Search canAct={canAct} />}
      {(tab === "search" || tab === "pending") && <Pending query={pending} canAct={canAct} />}
      {tab === "history" && <History />}
    </>
  );
}
