"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Avatar, AvatarStack, Badge, ErrorState, Forbidden, LoadingState, Select } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import type { Overview, OverviewItem } from "./types";
import styles from "./ot.module.css";

type ListKey = keyof Overview["lists"];
const LIST_KEYS: ListKey[] = ["overdue", "dueToday", "laterThisWeek", "doneLast7Days"];
const CAT_COLOR = { todo: "#8a94a0", in_progress: "#3b82f6", done: "#15803d" } as const;

export function OverviewPage({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("overview-table.overview");
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [moduleId, setModuleId] = useState("");
  const [list, setList] = useState<ListKey>("overdue");
  const [chart, setChart] = useState<"daily" | "burnup">("daily");
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const params = new URLSearchParams({ scope });
  if (moduleId) params.set("moduleId", moduleId);
  const q = useQuery({ queryKey: ["overview", ws, projectKey, params.toString()], queryFn: () => api.get<Overview>(`${base}/overview?${params}`) });
  if (q.isPending) return <div className={styles.page}><LoadingState /></div>;
  if (q.error) return <div className={styles.page}>{q.error instanceof ApiError && q.error.status === 403 ? <Forbidden /> : <ErrorState error={q.error} retry={() => q.refetch()} />}</div>;
  const d = q.data;
  const p = d.progress;
  const h = d.health;
  const href = (key: string) => `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}?issue=${encodeURIComponent(key)}`;
  const tableHref = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/table${list === "overdue" ? "?overdue=true" : ""}`;
  const delta = (n: number) => t("kpi.delta", { sign: n > 0 ? "+" : "", n });
  const kpiValue: Record<ListKey, number> = { overdue: d.kpis.overdue, dueToday: d.kpis.dueToday, laterThisWeek: d.kpis.laterThisWeek, doneLast7Days: d.kpis.doneLast7Days };
  const kpiSub: Record<ListKey, string> = {
    overdue: delta(d.kpis.overdueDelta),
    dueToday: formatDate(d.today, year),
    laterThisWeek: t("kpi.range", { from: formatDate(d.kpis.laterThisWeekRange.from, year), to: formatDate(d.kpis.laterThisWeekRange.to, year) }),
    doneLast7Days: delta(d.kpis.doneDelta),
  };
  const items = d.lists[list];
  const maxDaily = Math.max(1, ...d.doneDaily.map((x) => x.count));
  const total7 = d.doneDaily.reduce((n, x) => n + x.count, 0);
  const statusTotal = d.statusBreakdown.columns.reduce((n, c) => n + c.count, 0);

  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <div className={styles.seg} role="group" aria-label={t("scope.label")}>
          {(["all", "mine"] as const).map((s) => <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>{t(`scope.${s}`)}</button>)}
        </div>
        <Select aria-label={t("moduleFilter")} size="small" value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          <option value="">{t("allModules")}</option>
          {d.modules.filter((m) => m.id).map((m) => <option key={m.id} value={m.id!}>{m.name}</option>)}
        </Select>
      </div>

      <div className={styles.top}>
        <section className={`${styles.card} ${styles.stat}`} aria-label={t("progressTitle")}>
          <span className="muted">{t("progressTitle")}</span>
          <b>{t("tasksDone", { done: p.tasks.done, total: p.tasks.total })}</b>
          <div className={styles.progress}><div style={{ width: `${p.pct}%` }} /></div>
          <span className={`${styles.muted} ${styles.small}`}>{t("mdDone", { done: p.md.done, total: p.md.total, pct: p.md.pct })}</span>
        </section>
        <section className={`${styles.card} ${styles.stat}`}>
          <span className="muted">{t("timeTitle")}</span>
          <b>{t("timeValue", { pct: p.time.pct, elapsed: p.time.elapsedWorkingDays, total: p.time.totalWorkingDays })}</b>
          <div className={styles.progress}><div style={{ width: `${p.time.pct}%`, background: "#94a3b8" }} /></div>
        </section>
        <section className={`${styles.card} ${styles.stat}`}>
          <span className="muted">{t("doneTitle")}</span>
          <b>{p.pct}%</b>
        </section>
        <section className={`${styles.card} ${styles.stat}`}>
          <span className="muted">{t("remainTitle")}</span>
          <b>{t("remainValue", { days: p.remainingWorkingDays })}</b>
          <span className={`${styles.muted} ${styles.small}`}>{p.lastPlanEnd ? t("lastPlanEnd", { date: formatDate(p.lastPlanEnd, year) }) : t("noPlan")}</span>
        </section>
        <section className={`${styles.card} ${styles.stat}`}>
          <span className="muted">{t("nextMilestone")}</span>
          {p.nextMilestone ? <><b style={{ fontSize: 16 }}>{p.nextMilestone.name}</b><span className={`${styles.muted} ${styles.small}`}>{t("milestoneIn", { date: formatDate(p.nextMilestone.date, year), days: p.nextMilestone.daysLeft })}</span></> : <span>{t("noMilestone")}</span>}
        </section>
      </div>

      <section className={`${styles.health} ${styles[h.level]}`} role="status" aria-label={t("health.title", { level: t(`health.levels.${h.level}`) })}>
        <div>
          <b>{t("health.title", { level: t(`health.levels.${h.level}`) })}</b>
          <div className={styles.small}>
            {t("health.behind", { count: h.behindPlan })} · {t("health.overdue", { count: h.overdue.count })}
            {h.overdue.topAssignee ? ` ${t("health.top", { name: h.overdue.topAssignee.person.displayName, count: h.overdue.topAssignee.count })}` : ""}
            {h.capacity.weeksNeeded !== null ? ` · ${t("health.capacity", { need: h.capacity.weeksNeeded, left: h.capacity.weeksLeft })}` : ""}
            {` · ${t("health.gap", { planned: h.plannedPct, actual: h.actualPct })}`}
          </div>
        </div>
      </section>

      <div className={styles.cols}>
        <div className={styles.main}>
          <section className={styles.card}>
            <div className={styles.kpis} role="group" aria-label="KPI">
              {LIST_KEYS.map((k) => (
                <button key={k} type="button" className={styles.kpi} aria-pressed={list === k} onClick={() => setList(k)}>
                  <span className="muted">{t(`kpi.${k}`)}</span>
                  <b style={{ color: k === "overdue" && kpiValue[k] ? "#b91c1c" : undefined }}>{kpiValue[k]}</b>
                  <span className={`${styles.muted} ${styles.small}`}>{kpiSub[k]}</span>
                </button>
              ))}
            </div>
            <div className={styles.chead}>
              <h2>{t(`kpi.${list}`)} <span className="muted" style={{ fontWeight: 500 }}>{t("listCount", { count: kpiValue[list] })}</span></h2>
              <Link href={tableHref} style={{ fontSize: 13 }}>{t("openInTable")}</Link>
            </div>
            {!items.length && <div className={styles.empty}>{t("listEmpty")}</div>}
            {items.map((i) => <ListRow key={i.key} i={i} href={href} year={year} />)}
          </section>

          <section className={styles.card}>
            <div className={styles.chead}>
              <h2>{t("chartTitle")} <span className="muted" style={{ fontWeight: 500 }}>{t("chartSub")}</span></h2>
              <div className={styles.seg}>{(["daily", "burnup"] as const).map((c) => <button key={c} type="button" aria-pressed={chart === c} onClick={() => setChart(c)}>{t(c)}</button>)}</div>
            </div>
            {chart === "daily" ? (
              <>
                <div className={styles.chart} role="img" aria-label={t("dailyLabel", { values: d.doneDaily.map((x) => `${formatDate(x.date, year)} ${x.count}`).join(", ") })}>
                  {d.doneDaily.map((x) => <div key={x.date}><span className={styles.small}>{x.count}</span><i style={{ height: Math.max(3, Math.round((x.count / maxDaily) * 90)), opacity: x.workingDay ? 1 : 0.4 }} /></div>)}
                </div>
                <div className={styles.labels}>{d.doneDaily.map((x) => <span key={x.date}>{formatDate(x.date, year).split(" ").slice(0, 2).join(" ")}</span>)}</div>
                <div className={styles.empty} style={{ paddingTop: 0 }}>{t("chartNote", { total: total7, prev: d.kpis.doneLast7Days - d.kpis.doneDelta })}</div>
              </>
            ) : <Burnup d={d} />}
          </section>
        </div>

        <aside className={styles.side}>
          <section className={styles.card}>
            <div className={styles.chead}><h2>{t("info")}</h2></div>
            <div className={styles.list}>
              {d.project.description && <div><div className={`${styles.muted} ${styles.small}`}>{t("goal")}</div>{d.project.description}</div>}
              {!!d.project.scope.inScope.length && <div><div className={`${styles.muted} ${styles.small}`}>{t("inScope")}</div><ul style={{ margin: 0, paddingLeft: 18 }}>{d.project.scope.inScope.map((x) => <li key={x}>{x}</li>)}</ul></div>}
              {!!d.project.scope.outScope.length && <div><div className={`${styles.muted} ${styles.small}`}>{t("outScope")}</div><ul style={{ margin: 0, paddingLeft: 18 }}>{d.project.scope.outScope.map((x) => <li key={x}>{x}</li>)}</ul></div>}
              {d.project.owner && <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`${styles.muted} ${styles.small}`}>{t("owner")}</span><Avatar size="small" person={d.project.owner} />{d.project.owner.displayName}</div>}
              {d.project.clientName && <div><span className={`${styles.muted} ${styles.small}`}>{t("client")}</span> {d.project.clientName}</div>}
              <div className={`${styles.muted} ${styles.small}`}>{t("members", { count: d.project.memberCount, modules: d.project.moduleCount })}</div>
            </div>
          </section>
          <section className={styles.card} aria-label={t("byModule")}>
            <div className={styles.chead}><h2>{t("byModule")}</h2></div>
            <div className={styles.list}>
              {d.modules.map((m) => (
                <div key={m.id ?? "none"}>
                  <div className={styles.line}><span style={{ fontWeight: 600 }}>{m.name}</span><span><b>{m.pct}%</b> <span className="muted">· {m.done}/{m.total}</span>{m.overdue > 0 && <span className={styles.late}> · {t("moduleLate", { count: m.overdue })}</span>}{m.notStarted && <span className="muted"> · {t("notStarted")}</span>}</span></div>
                  <div className={styles.progress} style={{ height: 6 }}><div style={{ width: `${m.pct}%`, background: m.color ?? "var(--primary)" }} /></div>
                </div>
              ))}
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.chead}><h2>{t("statusTitle")}</h2><span className="muted">{t("statusTotal", { count: statusTotal })}</span></div>
            <div className={styles.list}>
              <div className={styles.progress} style={{ display: "flex" }}>{d.statusBreakdown.columns.map((c) => <div key={c.id} style={{ width: `${c.pct}%`, background: CAT_COLOR[c.category] }} title={c.name} />)}</div>
              {d.statusBreakdown.columns.map((c) => <div className={styles.line} key={c.id}><span style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ width: 9, height: 9, borderRadius: "50%", background: CAT_COLOR[c.category] }} />{c.name}</span><b>{c.count}</b></div>)}
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.chead}><h2>{t("milestones")}</h2><Link href={`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/timeline`} style={{ fontSize: 13 }}>{t("timeline")}</Link></div>
            <div className={styles.list}>
              {d.milestones.map((m) => (
                <div key={m.id} className={styles.line}>
                  <div><b>{m.name}</b><div className={`${styles.muted} ${styles.small}`}>{t("milestoneLine", { date: formatDate(m.date, year), pct: m.donePct })} ({t(`milestoneBasis.${m.basis}`)})</div></div>
                  <Badge tone={m.daysLeft < 0 ? "neutral" : m.daysLeft <= 14 ? "amber" : "blue"}>{m.daysLeft >= 0 ? t("daysLeft", { days: m.daysLeft }) : t("daysPast", { days: -m.daysLeft })}</Badge>
                </div>
              ))}
            </div>
          </section>
          {d.workloadThisWeek && (
            <section className={styles.card}>
              <div className={styles.chead}><h2>{t("workload")} <span className="muted" style={{ fontWeight: 500 }}>· {formatDate(d.workloadThisWeek.from, year)} – {formatDate(d.workloadThisWeek.to, year)}</span></h2><Link href={`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/members`} style={{ fontSize: 13 }}>{t("seeAll")}</Link></div>
              <div className={styles.list}>
                {d.workloadThisWeek.people.map((w) => (
                  <div key={w.person.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <Avatar size="small" person={w.person} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={styles.line}><span>{w.person.displayName}</span><span className={w.over ? styles.late : "muted"}>{t("workloadLine", { md: w.md, cap: w.capacityMd, pct: w.utilizationPct ?? 0 })}</span></div>
                      <div className={styles.progress} style={{ height: 6 }}><div style={{ width: `${Math.min(100, w.utilizationPct ?? 0)}%`, background: w.over ? "#ea580c" : "#93b4f5" }} /></div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className={styles.card}>
            <div className={styles.chead}><h2>{t("activity")}</h2></div>
            {!d.activity.length && <div className={styles.empty}>{t("activityEmpty")}</div>}
            {d.activity.slice(0, 8).map((a) => (
              <div key={a.id} className={styles.row} style={{ alignItems: "flex-start" }}>
                <Avatar size="small" person={a.actor ?? { id: a.id, displayName: a.actorKind === "user" ? t("hidden") : t("system") }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  <b>{a.actor?.displayName ?? t("system")}</b> {t.has(`verbs.${a.verb}` as never) ? t(`verbs.${a.verb}` as never) : t("verbs.other")} {a.field ? `${a.field} ` : ""}{a.issue && <Link href={href(a.issue.key)}>{a.issue.key} {a.issue.title}</Link>}
                  <div className={`${styles.muted} ${styles.small}`}>{formatDate(a.createdAt, year)}</div>
                </div>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ListRow({ i, href, year }: { i: OverviewItem; href: (key: string) => string; year: YearFormat }) {
  const t = useTranslations("overview-table.overview");
  const open = i.canOpen !== false;
  return (
    <div className={styles.row}>
      <span className={styles.small} style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{i.key}</span>
      {open ? <Link className={styles.rowTitle} href={href(i.key)}>{i.title}</Link> : <span className={styles.rowTitle}>{i.title}</span>}
      {i.module && <Badge tone="blue">{i.module.name}</Badge>}
      {i.completedOn ? <span className={`${styles.muted} ${styles.small}`}>{t("doneOn", { date: formatDate(i.completedOn, year) })}</span> : i.lateDays > 0 ? <span className={styles.late}>{t("lateDays", { days: i.lateDays })}</span> : <span className={styles.small}>{formatDate(i.planEnd, year)}</span>}
      {!!i.assignees?.length && <AvatarStack people={i.assignees} />}
    </div>
  );
}

function Burnup({ d }: { d: Overview }) {
  const t = useTranslations("overview-table.overview");
  const pts = d.burnup.points;
  const W = 520, H = 140, max = Math.max(1, d.burnup.total, ...pts.map((p) => p.planned));
  const x = (i: number) => (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * W);
  const y = (v: number) => H - (v / max) * H;
  const line = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
  return (
    <div style={{ padding: "12px 18px" }}>
      <svg viewBox={`0 0 ${W} ${H + 4}`} width="100%" height={H + 4} role="img" aria-label={t("burnupLabel", { unit: d.burnup.unit === "md" ? "MD" : "งาน" })}>
        <line x1={0} x2={W} y1={y(d.burnup.total)} y2={y(d.burnup.total)} stroke="#cbd5e1" strokeDasharray="4 4" />
        <polyline fill="none" stroke="#94a3b8" strokeWidth={2} points={line(pts.map((p) => p.planned))} />
        <polyline fill="none" stroke="#1d4ed8" strokeWidth={2.5} points={line(pts.map((p) => p.done))} />
      </svg>
      <div className={styles.bar} style={{ fontSize: 12 }}><span style={{ color: "#94a3b8" }}>— {t("planned")}</span><span style={{ color: "#1d4ed8" }}>— {t("actual")}</span></div>
    </div>
  );
}
