"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge, ErrorState, Forbidden, LoadingState, NotFound } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { adminKey, isForbidden, isSection, NAV_GROUPS, workPath, wsPath, type AdminOverview, type Section } from "./types";
import { OverviewSection, ProjectsSection } from "./overview-section";
import { StandardsSection, TeamsSection, WorkloadSection } from "./org-sections";
import { AuditSection, DataSection, SecuritySection } from "./security-sections";
import { BillingSection, IntegrationsSection, NotifySection } from "./channel-sections";
import { NotifyTemplates } from "./notify-templates";
import { TrashBrowser, WorkspaceTrashHead } from "@/features/trash";
import styles from "./admin.module.css";

/** N1 · Admin Console (Owner / Admin ของ Workspace เท่านั้น · 04-permissions `ws.settings`) */
export function AdminConsole({ ws, section }: { ws: string; section?: string }) {
  const t = useTranslations("admin-automation.admin");
  const tt = useTranslations("trash");
  const { workspace, me } = useWorkspace();
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  // ภาพรวมใช้ทั้งป้ายเมนู (จำนวนเรื่องที่ต้องทำ) และแท็บแดชบอร์ด/โปรเจกต์/แพ็กเกจ
  const overview = useQuery({ queryKey: adminKey(ws, "overview"), queryFn: () => api.get<AdminOverview>(`${wsPath(ws)}/admin/overview`), enabled: isAdmin });
  // ถังขยะ (Z1 · W23) เป็นเมนูของ feature trash จึงไม่อยู่ใน SECTIONS ของ W18
  const current: Section | "trash" | null = section === undefined ? "overview" : section === "trash" ? "trash" : isSection(section) ? section : null;

  if (!current) return <NotFound />;
  // สมาชิกทั่วไปและ Guest ไม่เห็น Admin Console เลย (ไม่เรียก API)
  if (!isAdmin || isForbidden(overview.error)) return <div className={styles.body}><Forbidden /></div>;
  if (current === "notify-templates") return <NotifyTemplates ws={ws} />;

  const base = `${workPath(ws)}/admin`;
  const actions = overview.data?.actions.length ?? 0;
  return (
    <div className={styles.body}>
      <nav className={styles.nav} aria-label={t("navLabel")}>
        {/* Canvas N1: หัวเมนูบอก Workspace และแพ็กเกจที่ใช้อยู่ */}
        <div className={styles.navHead}>
          <b>{workspace.name}</b>
          <span className={styles.muted}>{workspace.slug}</span>
          {overview.data && (
            <span className={`${styles.pill} ${overview.data.plan.status === "trialing" ? styles.warn : styles.neu}`}>
              {overview.data.plan.status === "trialing" && overview.data.plan.trialEndsAt
                ? t("planTrial", { plan: overview.data.plan.name, date: formatDate(overview.data.plan.trialEndsAt, me.yearFormat) })
                : overview.data.plan.name}
            </span>
          )}
        </div>
        {NAV_GROUPS.map((g) => (
          <div key={g.key} style={{ display: "contents" }}>
            <div className={styles.navSec} aria-hidden="true">{t(`nav.${g.key}`)}</div>
            {g.items.map((s) => (
              <Link key={s} href={`${base}/${s}`} className={styles.snav} aria-current={s === current ? "page" : undefined}>
                {t(`nav.${s}`)}
                {s === "overview" && actions > 0 && <span className={styles.badgeBad} aria-label={t("actionsBadge", { n: actions })}>{actions}</span>}
              </Link>
            ))}
            {g.key === "groupGov" && (
              <Link href={`${base}/trash`} className={styles.snav} aria-current={current === "trash" ? "page" : undefined}>
                {tt("nav")}
                <Badge tone="purple">{tt("new")}</Badge>
              </Link>
            )}
          </div>
        ))}
        <Link href={`${workPath(ws)}/members`} className={styles.snav}>{t("nav.members")}</Link>
      </nav>
      <div className={styles.main}>
        {current === "trash" ? (
          <TrashBrowser
            ws={ws}
            heading={(list) => (
              <div className={styles.head}>
                <h1 id="admin-heading">{tt("title")}</h1>
                <div className={styles.muted}>
                  <WorkspaceTrashHead ws={ws} days={list?.trashDays ?? 30} />
                </div>
              </div>
            )}
          />
        ) : (
        <>
        <div className={styles.head}>
          <h1 id="admin-heading">{t(`nav.${current}`)}</h1>
          <div className={styles.muted}>{t(`desc.${current}`)}</div>
        </div>
        {(current === "overview" || current === "projects" || current === "bill") && !overview.data ? (
          overview.error ? <ErrorState error={overview.error} retry={() => void overview.refetch()} /> : <LoadingState />
        ) : (
          <>
            {current === "overview" && <OverviewSection ws={ws} data={overview.data!} />}
            {current === "projects" && <ProjectsSection ws={ws} data={overview.data!} />}
            {current === "teams" && <TeamsSection ws={ws} />}
            {current === "std" && <StandardsSection ws={ws} />}
            {current === "load" && <WorkloadSection ws={ws} />}
            {current === "security" && <SecuritySection ws={ws} />}
            {current === "audit" && <AuditSection ws={ws} />}
            {current === "data" && <DataSection ws={ws} />}
            {current === "notify" && <NotifySection ws={ws} />}
            {current === "integ" && <IntegrationsSection ws={ws} />}
            {current === "bill" && <BillingSection ws={ws} data={overview.data!} />}
          </>
        )}
        </>
        )}
      </div>
    </div>
  );
}
