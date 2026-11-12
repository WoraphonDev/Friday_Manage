"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { clsx } from "clsx";
import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Chip, Empty, ErrorBlock, Popover, TableSkeleton } from "@/components/kit";
import { Button, Pill } from "@/components/ui";
import { useFmt } from "../../workspaces/_parts/format";
import styles from "../changelog.module.css";
import { HideDialog } from "./HideDialog";
import { PanelPreview, useAudienceLabel, useStatusLabel } from "./labels";
import { type ChangelogData, type Entry, type EntryStatus, KIND_TONE, type NpsSummary, npsTone, signed, STATUS_TONE } from "./types";

type Filter = "all" | Exclude<EntryStatus, "hidden">;

/** แท็บ Changelog: KPI · ตารางรายการพร้อมยอดเห็น / คลิก · ตัวอย่างที่ลูกค้าเห็น (บอร์ด 17) */
export function ChangelogTab({
  query,
  nps,
  canWrite,
  onEdit,
  write,
}: {
  query: UseQueryResult<ChangelogData>;
  /** undefined = บทบาทนี้ไม่เห็น NPS (ซ่อนการ์ด) · null = กำลังโหลด */
  nps: NpsSummary | null | undefined;
  canWrite: boolean;
  onEdit: (e: Entry) => void;
  write: ReactNode;
}) {
  const t = useTranslations("cl");
  const fmt = useFmt();
  const status = useStatusLabel();
  const audience = useAudienceLabel();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [hiding, setHiding] = useState<Entry | null>(null);
  const data = query.data;
  const items = (data?.items ?? []).filter((i) => filter === "all" || i.status === filter);
  const preview = data?.items.find((i) => i.id === selected) ?? data?.items.find((i) => i.status === "published") ?? data?.items[0] ?? null;
  const k = data?.kpis;
  return (
    <>
      <section className={styles.kpis} aria-label="KPI">
        <div className={clsx("card", styles.kpi)}>
          <span className={styles.kpiLabel}>{t("kpi.published")}</span>
          <b className={styles.kpiValue}>{k ? fmt.num(k.published30) : "—"}</b>
          <span className={styles.kpiSub}>{k ? t("kpi.publishedSub", k.byKind) : ""}</span>
        </div>
        <div className={clsx("card", styles.kpi)}>
          <span className={styles.kpiLabel}>{t("kpi.readers")}</span>
          <b className={styles.kpiValue}>{k?.readersPct != null ? `${k.readersPct}%` : "—"}</b>
          <span className={styles.kpiSub}>{t("kpi.readersSub")}</span>
        </div>
        <div className={clsx("card", styles.kpi)}>
          <span className={styles.kpiLabel}>{t("kpi.clicks")}</span>
          <b className={styles.kpiValue}>{k?.clickPct != null ? `${k.clickPct}%` : "—"}</b>
          <span className={styles.kpiSub}>{t("kpi.clicksSub")}</span>
        </div>
        {nps !== undefined && (
          <div className={clsx("card", styles.kpi)}>
            <span className={styles.kpiLabel}>{t("kpi.nps")}</span>
            <b className={styles.kpiValue}>{signed(nps?.score ?? null)}</b>
            <span className={styles.kpiSub}>
              {nps?.delta != null ? (
                <>
                  <Pill tone={npsTone(nps.delta)}>{signed(nps.delta)}</Pill> {t("kpi.npsSub")}
                </>
              ) : nps && nps.score === null ? (
                t("kpi.npsNone")
              ) : null}
            </span>
          </div>
        )}
      </section>
      <div className={styles.split}>
        <section className={clsx("card", styles.flush, styles.main)}>
          <div className={styles.cardHead}>
            <h2 className="card-title">{t("table.title")}</h2>
            {(["all", "published", "scheduled", "draft"] as const).map((f) => (
              <Chip key={f} pressed={filter === f} onClick={() => setFilter(f)}>
                {t(`filter.${f}`)}
              </Chip>
            ))}
            <span className="muted small push-end">{t("table.spotlightNote")}</span>
          </div>
          {query.isPending ? (
            <TableSkeleton rows={4} cols={7} />
          ) : query.error ? (
            <ErrorBlock error={query.error} retry={() => void query.refetch()} />
          ) : !data!.items.length ? (
            <Empty title={t("table.empty")} description={t("table.emptyDesc")} action={write} />
          ) : !items.length ? (
            <Empty title={t("table.emptyFilter")} onClearFilters={() => setFilter("all")} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("table.col.title")}</th>
                    <th scope="col">{t("table.col.kind")}</th>
                    <th scope="col">{t("table.col.audience")}</th>
                    <th scope="col">{t("table.col.status")}</th>
                    <th scope="col">{t("table.col.published")}</th>
                    <th scope="col" className="num">
                      {t("table.col.views")}
                    </th>
                    <th scope="col" className="num">
                      {t("table.col.clicks")}
                    </th>
                    {canWrite && (
                      <th scope="col">
                        <span className="sr-only">{t("table.col.actions")}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => {
                    const live = e.status === "published";
                    return (
                      <tr key={e.id} className={clsx(preview?.id === e.id && styles.rowOn)}>
                        <td>
                          <button type="button" className={styles.rowTitle} aria-label={t("table.open", { title: e.title })} onClick={() => (setSelected(e.id), canWrite && onEdit(e))}>
                            <b>{e.title}</b>
                          </button>
                          <span className="cell-sub" style={{ display: "block" }}>
                            {e.devIssueKey ? t("table.fromTicket", { key: e.devIssueKey }) : e.audience === "flag" && e.audienceFlag ? t("table.flagSub", { flag: e.audienceFlag }) : e.summary}
                          </span>
                        </td>
                        <td>
                          <span className="row">
                            <Pill tone={KIND_TONE[e.kind]}>{t(`kind.${e.kind}`)}</Pill>
                            {e.spotlight && <Pill tone="inf">{t("table.spotlight")}</Pill>}
                          </span>
                        </td>
                        <td>{audience(e)}</td>
                        <td>
                          <Pill tone={STATUS_TONE[e.status]}>{status(e)}</Pill>
                        </td>
                        <td className="nowrap">{live ? fmt.date(e.displayDate ?? e.publishedAt) : "—"}</td>
                        <td className="num">{live ? `${fmt.num(e.views)}${e.viewPct !== null ? ` (${e.viewPct}%)` : ""}` : "—"}</td>
                        <td className="num">{live && e.clickPct !== null ? `${e.clickPct}%` : "—"}</td>
                        {canWrite && (
                          <td>
                            {e.status !== "hidden" && (
                              <Popover
                                label={e.title}
                                trigger={({ toggle, open }) => (
                                  <Button variant="ghost" size="icon" aria-label={t("table.hideLabel", { title: e.title })} aria-expanded={open} onClick={toggle}>
                                    <MoreHorizontal size={16} />
                                  </Button>
                                )}
                              >
                                {(close) => (
                                  <button type="button" className="menu-item" onClick={() => (close(), setHiding(e))}>
                                    {t("table.hide")}
                                  </button>
                                )}
                              </Popover>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <aside className={clsx("card", styles.side)} aria-label={t("preview.title")}>
          <h2 className="card-title">{t("preview.title")}</h2>
          {preview ? <PanelPreview entry={preview} /> : <p className="muted small">{t("preview.empty")}</p>}
          <dl className={styles.kv}>
            <dt>{t("preview.dot")}</dt>
            <dd>{t("preview.dotValue")}</dd>
            <dt>{t("preview.excluded")}</dt>
            <dd>{t("preview.excludedValue")}</dd>
            <dt>{t("preview.lang")}</dt>
            <dd>{t("preview.langValue")}</dd>
          </dl>
          <p className="muted small">{t("preview.public")}</p>
        </aside>
      </div>
      {hiding && <HideDialog entry={hiding} onClose={() => setHiding(null)} />}
    </>
  );
}
