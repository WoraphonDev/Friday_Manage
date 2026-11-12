"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { Chip, Empty, ErrorBlock, NoAccess, PageHead, Seg, TableSkeleton } from "@/components/kit";
import { Button, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { planLabel, useFmt } from "../workspaces/_parts/format";
import { canFollow, canRead } from "./access";
import { FollowDrawer } from "./FollowDrawer";
import { onbKey, type OnboardingOverview, STEPS, type StuckRow } from "./types";
import styles from "./onboarding.module.css";

type Days = "7" | "30" | "90";
type Filter = "over3" | "trial7" | "unassigned" | "step" | "all" | "inactive";

/**
 * Onboarding checklist (O34 · บอร์ด 18) · เมนู แพ็กเกจและการตลาด › Onboarding checklist
 * ไม่มีปุ่ม "แก้ขั้นตอน" (V6) ตามคำตัดสิน 12 พ.ย. 2569: ขั้นแก้ในไฟล์ของ API ก่อน
 */
export function OnboardingPage() {
  const t = useTranslations("onb");
  const fmt = useFmt();
  const intl = useFormatter();
  // ส่ง now เอง (ไม่พึ่งค่า fallback ของ next-intl ที่เตือนใน console)
  const ago = (iso: string | null) => (iso ? intl.relativeTime(new Date(iso), new Date()) : "—");
  const me = useMe().data;
  const [days, setDays] = useState<Days>("30");
  const [filter, setFilter] = useState<Filter>("over3");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: onbKey(Number(days)), queryFn: () => api.get<OnboardingOverview>(`/onboarding?days=${days}`), enabled: !!me && canRead(me) });
  const d = q.data;
  // ขั้นที่มีคนติดมากที่สุด ใช้เป็นตัวกรอง "ขั้น n"
  const topStep = useMemo(() => {
    if (!d?.stuck.length) return null;
    const count = new Map<string, number>();
    for (const r of d.stuck) if (r.stuckStep) count.set(r.stuckStep, (count.get(r.stuckStep) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0] ?? null;
  }, [d]);
  if (me && !canRead(me)) return <NoAccess need={["owner", "support", "finance", "auditor"]} mine={rolesOf(me)} />;
  const follow = canFollow(me);

  const rowsOf = (f: Filter): StuckRow[] => {
    if (!d) return [];
    switch (f) {
      case "over3":
        return d.stuck.filter((r) => r.stuckDays > 3);
      case "trial7":
        return d.stuck.filter((r) => r.trialDaysLeft != null && r.trialDaysLeft <= 7);
      case "unassigned":
        return d.stuck.filter((r) => r.stuckDays > 3 && !r.followup?.assigneeId);
      case "step":
        return d.stuck.filter((r) => r.stuckStep === topStep?.[0]);
      case "inactive":
        return d.inactive;
      default:
        return d.stuck;
    }
  };
  const rows = rowsOf(filter);
  const stepLabel = (key: string | null) => (key ? t("stepN", { index: STEPS.indexOf(key as never) + 1, label: t(`steps.${key}` as "steps.team") }) : "—");

  function exportCsv() {
    if (!d) return;
    const head = [t("col.ws"), "slug", t("col.created"), t("col.plan"), t("col.step"), t("col.since"), t("col.last"), t("col.assignee")];
    const lines = [...d.stuck, ...d.inactive].map((r) => [r.name, r.slug, r.createdAt.slice(0, 10), planLabel(r.plan), stepLabel(r.stuckStep), String(r.stuckDays), r.lastActiveAt?.slice(0, 10) ?? "", r.followup?.assigneeName ?? ""]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${v.replaceAll('"', '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    a.download = `onboarding-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc", { days })}
        actions={
          <>
            <Seg label={t("range")} value={days} onChange={setDays} options={(["7", "30", "90"] as const).map((v) => ({ value: v, label: t("days", { n: v }) }))} />
            <Button onClick={exportCsv} disabled={!d}>
              {t("export")}
            </Button>
          </>
        }
      />
      {q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !d ? (
        <section className="card">
          <TableSkeleton rows={5} cols={6} />
        </section>
      ) : (
        <>
          <section className="stats" aria-label="KPI">
            <div className="stat">
              <span className="muted small">{t("kpi.new")}</span>
              <b>{fmt.num(d.kpis.newWorkspaces)}</b>
              <span className="muted small">{t("kpi.newNote", { trial: d.kpis.trial, free: d.kpis.free })}</span>
            </div>
            <div className="stat">
              <span className="muted small">{t("kpi.complete")}</span>
              <b>{d.kpis.completedPct}%</b>
              <span className="muted small">{d.kpis.avgDaysToComplete != null ? t("kpi.completeNote", { days: d.kpis.avgDaysToComplete }) : "—"}</span>
            </div>
            <div className="stat">
              <span className="muted small">{t("kpi.activated")}</span>
              <b>{d.kpis.activatedPct}%</b>
              <span className="muted small">{t("kpi.activatedNote")}</span>
            </div>
            <div className="stat">
              <span className="muted small">{t("kpi.stuck")}</span>
              <b>{fmt.num(d.kpis.stuckOver3)}</b>
              <span className="muted small">{t("kpi.stuckNote", { n: d.kpis.stuckUnassigned })}</span>
            </div>
          </section>

          <div className={styles.split}>
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">{t("funnel")}</h2>
                <span className="card-sub">{t("funnelSub")}</span>
              </div>
              <ol className={styles.funnel} aria-label={t("funnel")}>
                {d.funnel.map((f, i) => {
                  const worst = d.insights.biggestDrop?.key === f.key;
                  return (
                    <li key={f.key}>
                      <span className={styles.fLabel}>{stepLabel(f.key)}</span>
                      <span className={styles.track} aria-hidden="true">
                        <span className={worst ? styles.fillBad : styles.fill} style={{ width: `${f.pct}%` }} />
                      </span>
                      <b className={styles.fPct}>{f.pct}%</b>
                      <span className={worst ? styles.fDropBad : styles.fDrop}>{i === 0 || f.drop == null ? "—" : f.drop === 0 ? "0" : `−${Math.abs(f.drop)}`}</span>
                      <span className={styles.fDays}>{f.avgDays != null ? t("avgDays", { n: Math.round(f.avgDays) }) : "—"}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">{t("insights")}</h2>
              </div>
              <div className={styles.insights}>
                <p className={styles.insightWarn}>
                  {d.insights.biggestDrop
                    ? t("insightDrop", { step: t(`steps.${d.insights.biggestDrop.key}` as "steps.team"), drop: `−${Math.abs(d.insights.biggestDrop.drop)}`, passed: d.insights.biggestDrop.paidPassedPct, other: d.insights.biggestDrop.paidOtherPct })
                    : t("insightNoDrop")}
                </p>
                <p className={styles.insightInfo}>{t("insightNotify", { pct: d.insights.notificationsPct })}</p>
                {hasAny(me, "owner", "finance", "auditor") && (
                  <Link className="small" href="/business/funnel">
                    {t("fullFunnel")}
                  </Link>
                )}
              </div>
            </section>
          </div>

          <section className="card">
            <div className={styles.tableHead}>
              <h2 className="card-title">{t("stuckTitle")}</h2>
              <div className="row" role="group" aria-label={t("filters")}>
                <Chip pressed={filter === "over3"} onClick={() => setFilter("over3")}>
                  {t("filter.over3", { n: rowsOf("over3").length })}
                </Chip>
                <Chip pressed={filter === "trial7"} onClick={() => setFilter("trial7")}>
                  {t("filter.trial7", { n: rowsOf("trial7").length })}
                </Chip>
                <Chip pressed={filter === "unassigned"} onClick={() => setFilter("unassigned")}>
                  {t("filter.unassigned", { n: rowsOf("unassigned").length })}
                </Chip>
                {topStep && (
                  <Chip pressed={filter === "step"} onClick={() => setFilter("step")}>
                    {t("filter.step", { index: STEPS.indexOf(topStep[0] as never) + 1, n: topStep[1] })}
                  </Chip>
                )}
                <Chip pressed={filter === "all"} onClick={() => setFilter("all")}>
                  {t("filter.all", { n: d.stuck.length })}
                </Chip>
                <Chip pressed={filter === "inactive"} onClick={() => setFilter("inactive")}>
                  {t("filter.inactive", { n: d.inactive.length })}
                </Chip>
              </div>
            </div>
            {!rows.length ? (
              <Empty title={t("empty")} description={t("emptyDesc")} />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t("col.ws")}</th>
                      <th scope="col">{t("col.created")}</th>
                      <th scope="col">{t("col.plan")}</th>
                      <th scope="col">{t("col.step")}</th>
                      <th scope="col">{t("col.since")}</th>
                      <th scope="col">{t("col.last")}</th>
                      <th scope="col">{t("col.assignee")}</th>
                      <th scope="col">
                        <span className="sr-only">{t("col.action")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link className="cell-main" href={`/workspaces/${r.id}`}>
                            {r.name}
                          </Link>
                          <span className="cell-sub" style={{ display: "block" }}>
                            {r.slug} · {t("members", { n: r.members })}
                          </span>
                        </td>
                        <td className="num">{fmt.date(r.createdAt)}</td>
                        <td>{r.trialDaysLeft != null ? <Pill tone="warn">{t("trialLeft", { n: r.trialDaysLeft })}</Pill> : <Pill tone={r.plan === "free" ? "neu" : "ok"}>{planLabel(r.plan)}</Pill>}</td>
                        <td>{stepLabel(r.stuckStep)}</td>
                        <td>
                          <Pill tone={r.stuckDays > 7 ? "bad" : r.stuckDays > 3 ? "warn" : "neu"}>{t("days", { n: r.stuckDays })}</Pill>
                        </td>
                        <td>{ago(r.lastActiveAt)}</td>
                        <td>{r.followup?.assigneeName ?? "—"}</td>
                        <td>
                          {r.followup && r.followup.status !== "open" ? (
                            <button type="button" className={styles.statusButton} onClick={() => setOpen(r.id)} disabled={!follow}>
                              <Pill tone={r.followup.status === "emailed" ? "inf" : r.followup.status === "replied" || r.followup.status === "done" ? "ok" : "neu"}>
                                {r.followup.status === "emailed" && r.followup.lastEmailedAt ? t("emailedAt", { date: fmt.date(r.followup.lastEmailedAt) }) : t(`status.${r.followup.status}`)}
                              </Pill>
                            </button>
                          ) : (
                            follow && (
                              <Button size="small" onClick={() => setOpen(r.id)}>
                                {t("follow")}
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <div className={styles.notes}>
            <p>{t("notes.source")}</p>
            <p>{t("notes.since")}</p>
            {!follow && <p>{t("notes.readOnly")}</p>}
          </div>
        </>
      )}
      {open && <FollowDrawer workspaceId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
