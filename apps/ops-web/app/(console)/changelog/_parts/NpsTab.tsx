"use client";

import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { ExportDialog } from "@/components/dialogs";
import { Chip, Empty, ErrorBlock, Notice, TableSkeleton } from "@/components/kit";
import { Button, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import styles from "../changelog.module.css";
import { FollowUpDrawer } from "./FollowUpDrawer";
import { type Group, NPS_KEY, type NpsResponse, type NpsSummary, npsTone, type Range, scoreTone, signed } from "./types";

/** แท็บ NPS (บอร์ด 17): คะแนน · สัดส่วน 3 กลุ่ม · แนวโน้มรายเดือน · แยกแพ็กเกจ · ความเห็นพร้อมตัวกรอง · ติดตาม (U6) · ส่งออก (G9) */
export function NpsTab({ range, seesComments, exporting, onExportingChange }: { range: Range; seesComments: boolean; exporting: boolean; onExportingChange: (o: boolean) => void }) {
  const t = useTranslations("cl.nps");
  const tt = useTranslations("cl.topic");
  const tr = useTranslations("cl.role");
  const fmt = useFmt();
  const f = useFormatter();
  const [group, setGroup] = useState<Group>("all");
  const [withText, setWithText] = useState(false);
  const [open, setOpen] = useState<NpsResponse | null>(null);
  const sum = useQuery({ queryKey: [...NPS_KEY, "summary", range], queryFn: () => api.get<NpsSummary>(`/nps/summary?range=${range}`) });
  const list = useQuery({
    queryKey: [...NPS_KEY, "responses", range, group, withText],
    queryFn: () => api.get<{ items: NpsResponse[] }>(`/nps/responses?range=${range}&group=${group}${withText ? "&withComment=true" : ""}`),
    enabled: seesComments,
  });
  const s = sum.data;
  const topic = (x: string) => (tt.has(x as never) ? tt(x as never) : x);
  const month = (m: string) => f.dateTime(new Date(`${m}-01T00:00:00+07:00`), { month: "short" });
  const max = Math.max(1, ...(s?.monthly.map((m) => Math.abs(m.score ?? 0)) ?? [1]));
  const pct = (n: number) => `${n}%`;

  if (sum.isPending) return <TableSkeleton rows={4} cols={4} />;
  if (sum.error) return <ErrorBlock error={sum.error} retry={() => void sum.refetch()} />;
  const data = s!;
  return (
    <>
      <div className={styles.npsRow}>
        <section className={clsx("card", styles.npsCard)} aria-label={t("label")}>
          <span className="muted small">{t("label")}</span>
          <div className={styles.npsBig}>
            <span className={styles.npsScore}>{signed(data.score)}</span>
            {data.delta !== null && <Pill tone={npsTone(data.delta)}>{t("delta", { delta: signed(data.delta) })}</Pill>}
          </div>
          <div className={styles.bar} role="img" aria-label={`${t("promoters")} ${pct(data.promotersPct)} · ${t("passives")} ${pct(data.passivesPct)} · ${t("detractors")} ${pct(data.detractorsPct)}`}>
            <span className={styles.barPro} style={{ width: `${data.promotersPct}%` }} />
            <span className={styles.barPas} style={{ width: `${data.passivesPct}%` }} />
            <span className={styles.barDet} style={{ width: `${data.detractorsPct}%` }} />
          </div>
          <div className={clsx("small", styles.barLegend)}>
            <span>
              {t("promoters")} <b className="num">{pct(data.promotersPct)}</b>
            </span>
            <span className="muted">
              {t("passives")} <b className="num">{pct(data.passivesPct)}</b>
            </span>
            <span className={styles.detText}>
              {t("detractors")} <b className="num">{pct(data.detractorsPct)}</b>
            </span>
          </div>
          <dl className={styles.kv}>
            <dt>{t("asked")}</dt>
            <dd className="num">{t("askedValue", { asked: fmt.num(data.asked), answered: fmt.num(data.answered), pct: data.asked ? Math.round((data.answered / data.asked) * 100) : 0 })}</dd>
            <dt>{t("dismissed")}</dt>
            <dd className="num">{fmt.num(data.dismissed)}</dd>
            <dt>{t("open")}</dt>
            <dd>
              <Pill tone={data.openDetractors ? "warn" : "neu"}>{data.openDetractors}</Pill>
            </dd>
          </dl>
        </section>
        <section className={clsx("card", styles.npsCard)} aria-label={t("trend")}>
          <h2 className="card-title">{t("trend")}</h2>
          <div className={styles.trend}>
            {data.monthly.map((m) => (
              <div key={m.month} className={styles.trendCol}>
                <span className={clsx("num small", styles.trendValue)}>{m.score === null ? t("trendNone") : signed(m.score)}</span>
                <div className={styles.trendBar} style={{ height: `${m.score === null ? 2 : Math.max(4, Math.round((Math.abs(m.score) / max) * 96))}px` }} />
                <span className="muted small">{month(m.month)}</span>
              </div>
            ))}
          </div>
        </section>
        <section className={clsx("card", styles.flush, styles.npsCard)} aria-label={t("byPlan")}>
          <div className={styles.cardHead}>
            <h2 className="card-title">{t("byPlan")}</h2>
          </div>
          {data.byPlan.length ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("plan")}</th>
                    <th scope="col" className="num">
                      {t("answered")}
                    </th>
                    <th scope="col">NPS</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPlan.map((p) => (
                    <tr key={p.plan ?? "none"}>
                      <td>{p.plan ? planLabel(p.plan) : t("noPlan")}</td>
                      <td className="num">{fmt.num(p.answered)}</td>
                      <td>
                        <Pill tone={npsTone(p.score)}>{signed(p.score)}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small" style={{ padding: "0 16px" }}>
              {t("empty")}
            </p>
          )}
        </section>
      </div>
      {seesComments ? (
        <section className={clsx("card", styles.flush)} aria-label={t("comments")}>
          <div className={styles.cardHead}>
            <h2 className="card-title">{t("comments")}</h2>
            <Chip pressed={group === "all"} onClick={() => setGroup("all")}>
              {t("chipAll", { n: data.answered })}
            </Chip>
            <Chip pressed={group === "detractor"} onClick={() => setGroup("detractor")}>
              {t("chipDetractor", { n: data.groups.detractor })}
            </Chip>
            <Chip pressed={group === "passive"} onClick={() => setGroup("passive")}>
              {t("chipPassive", { n: data.groups.passive })}
            </Chip>
            <Chip pressed={group === "promoter"} onClick={() => setGroup("promoter")}>
              {t("chipPromoter", { n: data.groups.promoter })}
            </Chip>
            <Chip pressed={withText} onClick={() => setWithText((v) => !v)}>
              {t("chipText")}
            </Chip>
            {data.topics.length > 0 && <span className="muted small push-end">{t("topics", { list: data.topics.map((x) => `${topic(x.topic)} ${x.count}`).join(" · ") })}</span>}
          </div>
          {list.isPending ? (
            <TableSkeleton rows={4} cols={7} />
          ) : list.error ? (
            <ErrorBlock error={list.error} retry={() => void list.refetch()} />
          ) : !list.data.items.length ? (
            <Empty title={data.answered ? t("commentsEmpty") : t("empty")} description={data.answered ? undefined : t("emptyDesc")} onClearFilters={group !== "all" || withText ? () => (setGroup("all"), setWithText(false)) : undefined} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.score")}</th>
                    <th scope="col">{t("col.comment")}</th>
                    <th scope="col">{t("col.workspace")}</th>
                    <th scope="col">{t("col.role")}</th>
                    <th scope="col">{t("col.plan")}</th>
                    <th scope="col">{t("col.at")}</th>
                    <th scope="col">{t("col.follow")}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((r) => (
                    <tr key={r.id} className={clsx(open?.id === r.id && styles.rowOn)}>
                      <td>
                        <Pill tone={scoreTone(r.score)} className="num">
                          {r.score}
                        </Pill>
                      </td>
                      <td className={styles.comment}>{r.comment ?? t("noComment")}</td>
                      <td>{r.workspace.name}</td>
                      <td>{tr.has(r.role as never) ? tr(r.role as never) : r.role}</td>
                      <td>{planLabel(r.plan)}</td>
                      <td className="nowrap">{fmt.date(r.createdAt)}</td>
                      <td>
                        {r.ticket ? (
                          <button type="button" className={styles.pillButton} onClick={() => setOpen(r)}>
                            <Pill tone="inf">{t("ticket", { n: r.ticket.number })}</Pill>
                          </button>
                        ) : r.followUpStatus === "done" ? (
                          <button type="button" className={styles.pillButton} onClick={() => setOpen(r)}>
                            <Pill>{t("followed")}</Pill>
                          </button>
                        ) : (
                          <Button size="small" aria-label={t("followLabel", { score: r.score, ws: r.workspace.name })} onClick={() => setOpen(r)}>
                            {t("follow")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <Notice tone="info">{t("aggregateOnly")}</Notice>
      )}
      {open && <FollowUpDrawer id={open.id} onClose={() => setOpen(null)} />}
      <ExportDialog
        open={exporting}
        onOpenChange={onExportingChange}
        title={seesComments ? t("exportTitle") : t("exportTrend")}
        filename={seesComments ? `friday-nps-${range}.csv` : `friday-nps-monthly.csv`}
        rows={
          seesComments
            ? (list.data?.items ?? []).map((r) => ({ at: r.createdAt, score: r.score, comment: r.comment ?? "", workspace: r.workspace.name, role: r.role, plan: planLabel(r.plan), topics: r.topics.map(topic).join(" "), follow: r.ticket ? `#${r.ticket.number}` : r.followUpStatus }))
            : data.monthly.map((m) => ({ month: m.month, answered: m.answered, score: m.score ?? "" }))
        }
        columns={
          seesComments
            ? [
                { key: "at", label: t("col.at") },
                { key: "score", label: t("col.score") },
                { key: "comment", label: t("exportCol.comment"), pii: true },
                { key: "workspace", label: t("exportCol.workspace") },
                { key: "role", label: t("col.role") },
                { key: "plan", label: t("col.plan") },
                { key: "topics", label: t("exportCol.topics") },
                { key: "follow", label: t("col.follow") },
              ]
            : [
                { key: "month", label: t("exportCol.month") },
                { key: "answered", label: t("exportCol.answered") },
                { key: "score", label: t("exportCol.score") },
              ]
        }
      />
    </>
  );
}
