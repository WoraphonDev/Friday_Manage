"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { Chip, Empty, ErrorBlock, NoAccess, Notice, PageHead, TableSkeleton } from "@/components/kit";
import { Button, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";
import { NotifyDialog } from "./_components/NotifyDialog";
import { ResolveDialog } from "./_components/ResolveDialog";
import { SettingsDialog } from "./_components/SettingsDialog";
import { BRIDGE_KEY, type Filter, type LinkRow, type Overview, type Settings, severityTone, useStatusLabel } from "./_components/types";
import styles from "./bugs.module.css";

const FILTERS: Filter[] = ["open", "to_notify", "not_fixed", "closed30"];

/** บอร์ด 20 · ส่งบั๊กให้ทีมพัฒนา (O36) · Owner / Support / วิศวกรเห็น · แจ้งลูกค้าเฉพาะ Support · ตั้งค่าการเชื่อมต่อเฉพาะ Owner / วิศวกร */
export function BugsPage() {
  const t = useTranslations("bugs.page");
  const fmt = useFmt();
  const label = useStatusLabel();
  const me = useMe().data;
  const allowed = hasAny(me, "owner", "support", "engineer");
  const [filter, setFilter] = useState<Filter>("open");
  const [dialog, setDialog] = useState<{ kind: "notify"; linkId: string } | { kind: "resolve"; link: LinkRow } | { kind: "settings" } | null>(null);
  const overview = useQuery({
    queryKey: [...BRIDGE_KEY, "overview"],
    queryFn: () => api.get<Overview>("/dev-bridge/overview"),
    enabled: !!me && allowed,
  });
  const links = useQuery({
    queryKey: [...BRIDGE_KEY, "links", filter],
    queryFn: () => api.get<{ items: LinkRow[]; counts: Record<Filter, number> }>(`/dev-bridge/links?filter=${filter}`),
    enabled: !!me && allowed,
    placeholderData: keepPreviousData,
  });
  if (me && !allowed) return <NoAccess need={["owner", "support", "engineer"]} mine={rolesOf(me)} />;
  const o = overview.data;
  const conn: Settings | undefined = o?.connection;
  const canNotify = !!o?.canNotify && hasAny(me, "support");
  const counts = links.data?.counts;
  const na = t("kpi.na");

  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          <>
            <Button onClick={() => setDialog({ kind: "settings" })} disabled={!conn}>
              {t("settings")}
            </Button>
            {conn?.projectUrl && (
              <a className="button" href={conn.projectUrl} target="_blank" rel="noreferrer noopener">
                {t("openProject")}
              </a>
            )}
          </>
        }
      />
      {conn && !conn.configured && (
        <Notice tone="warn" title={t("notConfigured")}>
          {t("notConfiguredDesc")}
        </Notice>
      )}
      {o?.released.map((r) => (
        <div key={r.linkId} className={styles.banner} role="status">
          <Check size={18} aria-hidden="true" />
          <b>{t("released", { key: r.issueKey, n: r.tickets })}</b>
          {canNotify && (
            <Button size="small" variant="primary" className="push-end" onClick={() => setDialog({ kind: "notify", linkId: r.linkId })}>
              {t("notifyBanner")}
            </Button>
          )}
        </div>
      ))}

      <section className="stats" aria-label="KPI">
        {overview.isPending ? (
          <TableSkeleton rows={1} cols={4} />
        ) : overview.error ? (
          <ErrorBlock error={overview.error} retry={() => void overview.refetch()} />
        ) : (
          o && (
            <>
              <div className="stat">
                <span className="muted small">{t("kpi.open")}</span>
                <b>{fmt.num(o.kpi.openBugs)}</b>
                <span className="muted small">
                  {t("kpi.openNote", {
                    s1: o.kpi.bySeverity.S1,
                    s2: o.kpi.bySeverity.S2,
                    s3: o.kpi.bySeverity.S3,
                    s4: o.kpi.bySeverity.S4,
                  })}
                </span>
              </div>
              <div className="stat">
                <span className="muted small">{t("kpi.waiting")}</span>
                <b>{fmt.num(o.kpi.ticketsWaiting)}</b>
                <span className="muted small">{t("kpi.waitingNote", { n: o.kpi.workspaces })}</span>
              </div>
              <div className={o.kpi.avgFixDaysS2 != null && o.kpi.avgFixDaysS2 > 3 ? "stat stat-warn" : "stat"}>
                <span className="muted small">{t("kpi.fix")}</span>
                <b>{o.kpi.avgFixDaysS2 == null ? na : t("kpi.fixValue", { n: o.kpi.avgFixDaysS2 })}</b>
                <span className="muted small">{t("kpi.fixNote")}</span>
              </div>
              <div className={o.kpi.toNotify > 0 ? "stat stat-warn" : "stat"}>
                <span className="muted small">{t("kpi.toNotify")}</span>
                <b>{fmt.num(o.kpi.toNotify)}</b>
                <span className="muted small">{t("kpi.toNotifyNote")}</span>
              </div>
            </>
          )
        )}
      </section>

      <div className={styles.layout}>
        <section className="card">
          <div className={styles.filters} role="group" aria-label={t("filter.label")}>
            {FILTERS.map((f) => (
              <Chip key={f} pressed={filter === f} onClick={() => setFilter(f)}>
                {t(`filter.${f}`)}
                {counts ? ` · ${counts[f]}` : ""}
              </Chip>
            ))}
            <span className="muted small push-end">{t("sortNote")}</span>
          </div>
          {links.isPending ? (
            <TableSkeleton rows={5} cols={9} />
          ) : links.error ? (
            <ErrorBlock error={links.error} retry={() => void links.refetch()} />
          ) : !links.data.items.length ? (
            filter === "open" ? (
              <Empty ok title={t("emptyOpen")} description={t("emptyOpenDesc")} />
            ) : (
              <Empty title={t("empty")} />
            )
          ) : (
            <div className="tbl-wrap">
              <table className={`tbl ${styles.table}`}>
                <thead>
                  <tr>
                    <th scope="col">{t("col.key")}</th>
                    <th scope="col" className={styles.colTitle}>
                      {t("col.title")}
                    </th>
                    <th scope="col">{t("col.severity")}</th>
                    <th scope="col">{t("col.status")}</th>
                    <th scope="col">{t("col.tickets")}</th>
                    <th scope="col">{t("col.workspaces")}</th>
                    <th scope="col">{t("col.sent")}</th>
                    <th scope="col">{t("col.due")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("col.action")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {links.data.items.map((l) => {
                    const st = label(l);
                    const toNotify = l.statusCategory === "done" && l.unnotified > 0;
                    return (
                      <tr key={l.id} className={toNotify ? styles.rowHot : undefined}>
                        <td className="mono nowrap">{l.issueKey}</td>
                        <td className="cell-main">{l.title}</td>
                        <td>
                          <Pill tone={severityTone(l.severity)}>{l.severity}</Pill>
                        </td>
                        <td>
                          <Pill tone={st.tone}>{st.text}</Pill>
                        </td>
                        <td className="num">{l.tickets}</td>
                        <td className="small">{l.workspaces.join(", ") || "—"}</td>
                        <td className="nowrap">{fmt.date(l.createdAt)}</td>
                        <td className="nowrap">{l.dueDate ? fmt.date(l.dueDate) : "—"}</td>
                        <td className="nowrap">
                          {canNotify && toNotify && (
                            <Button size="small" variant="primary" onClick={() => setDialog({ kind: "notify", linkId: l.id })}>
                              {t("notifyN", { n: l.unnotified })}
                            </Button>
                          )}
                          {canNotify && !!l.resolution && l.unnotified > 0 && (
                            <Button size="small" onClick={() => setDialog({ kind: "resolve", link: l })}>
                              {t("notify")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card" aria-label={t("connection")}>
          <h2 className="card-title">{t("connection")}</h2>
          {conn ? (
            <dl className={styles.kv}>
              <dt>{t("workspace")}</dt>
              <dd>{conn.workspaceSlug ?? "—"}</dd>
              <dt>{t("project")}</dt>
              <dd>{conn.projectKey ?? "—"}</dd>
              <dt>{t("token")}</dt>
              <dd>
                {!conn.tokenHint ? (
                  <Pill tone="warn">{t("tokenNone")}</Pill>
                ) : conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() < Date.now() ? (
                  <Pill tone="bad">{t("tokenExpired", { date: fmt.date(conn.tokenExpiresAt) })}</Pill>
                ) : (
                  <Pill tone="ok">{conn.tokenExpiresAt ? t("tokenOk", { date: fmt.date(conn.tokenExpiresAt) }) : t("tokenNoExpiry")}</Pill>
                )}
              </dd>
              <dt>{t("webhook")}</dt>
              <dd>{conn.lastWebhookAt ? fmt.ago(conn.lastWebhookAt) : t("never")}</dd>
              {conn.lastTestAt && (
                <>
                  <dt>{t("lastTest")}</dt>
                  <dd>
                    <Pill tone={conn.lastTestOk ? "ok" : "bad"}>{conn.lastTestOk ? t("testOk") : t("testFail")}</Pill>
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <TableSkeleton rows={4} cols={2} />
          )}
          <p className={styles.note}>{t("privacy")}</p>
        </aside>
      </div>

      {dialog?.kind === "notify" && <NotifyDialog linkId={dialog.linkId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "resolve" && <ResolveDialog link={dialog.link} onClose={() => setDialog(null)} />}
      {dialog?.kind === "settings" && conn && <SettingsDialog settings={conn} onClose={() => setDialog(null)} />}
    </>
  );
}
