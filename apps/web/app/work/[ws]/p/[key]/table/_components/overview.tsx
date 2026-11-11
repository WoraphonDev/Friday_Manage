"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Avatar, AvatarStack, Badge, ErrorState, Forbidden, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { PlanActions, PlanFacts, PlanModules, PlanRisks, PlanWorkload, usePlan } from "../../dashboard/_components/lead-dashboard";
import type { Overview, OverviewItem } from "./types";
import styles from "./ot.module.css";
import { DEFAULT_ITEM_COLOR, readableColor, tint } from "@/lib/colors";

type ListKey = keyof Overview["lists"];
const LIST_KEYS: ListKey[] = ["overdue", "dueToday", "laterThisWeek", "doneLast7Days"];
const CAT_COLOR = { todo: "var(--status-todo-dot)", in_progress: "var(--status-progress-dot)", done: "var(--status-done-dot)" } as const;
// Review อยู่กลุ่ม in_progress แต่มีสีของตัวเอง (แยกด้วยชื่อแบบเดียวกับป้ายสถานะใน Table)
const columnColor = (c: { name: string; category: keyof typeof CAT_COLOR }) => (/review/i.test(c.name) ? "var(--status-review-dot)" : CAT_COLOR[c.category]);
const KPI_DOT: Record<ListKey, string> = { overdue: "var(--danger)", dueToday: "var(--warning-solid)", laterThisWeek: "var(--chart-primary)", doneLast7Days: "var(--success-solid)" };

export function OverviewPage({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("overview-table.overview");
  const locale = useLocale();
  const { me } = useWorkspace();
  const toast = useToast();
  const cache = useQueryClient();
  const year: YearFormat = me.yearFormat;
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [moduleId, setModuleId] = useState("");
  const [list, setList] = useState<ListKey>("overdue");
  const [chart, setChart] = useState<"daily" | "burnup">("daily");
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const page = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const params = new URLSearchParams({ scope });
  if (moduleId) params.set("moduleId", moduleId);
  const q = useQuery({ queryKey: ["overview", ws, projectKey, params.toString()], queryFn: () => api.get<Overview>(`${base}/overview?${params}`) });
  // ข้อมูลแผนทั้งโปรเจกต์ (เดิมหน้าภาพรวม Lead) วางรวมในหน้าเดียว · ใช้สิทธิ์ดู Workload เหมือนหน้าเดิม
  const plan = usePlan(ws, projectKey);
  const canPlan = plan.allowed;
  // มาจาก #planning (ลิงก์ Health / /dashboard เดิม): เลื่อนหลังโหลดเสร็จ เพราะเบราว์เซอร์เลื่อนก่อนเนื้อหามีความสูงจริง
  const ready = !!q.data && !!plan.risks.data;
  useEffect(() => {
    if (ready && window.location.hash === "#planning") document.getElementById("planning")?.scrollIntoView({ block: "start" });
  }, [ready]);
  if (q.isPending) return <div className={styles.page}><LoadingState /></div>;
  if (q.error) return <div className={styles.page}>{q.error instanceof ApiError && q.error.status === 403 ? <Forbidden /> : <ErrorState error={q.error} retry={() => q.refetch()} />}</div>;
  const d = q.data;
  const p = d.progress;
  const h = d.health;
  const href = (key: string) => `${page}?issue=${encodeURIComponent(key)}`;
  const tableHref = `${page}/table${list === "overdue" ? "?overdue=true" : ""}`;
  const delta = (n: number, goodWhenUp: boolean) =>
    n === 0 ? null : <span className={(n > 0) === goodWhenUp ? styles.good : styles.bad}>{t(n > 0 ? "kpi.up" : "kpi.down", { n: Math.abs(n) })}</span>;
  const kpiValue: Record<ListKey, number> = { overdue: d.kpis.overdue, dueToday: d.kpis.dueToday, laterThisWeek: d.kpis.laterThisWeek, doneLast7Days: d.kpis.doneLast7Days };
  const kpiDelta: Record<ListKey, React.ReactNode> = { overdue: delta(d.kpis.overdueDelta, false), dueToday: null, laterThisWeek: null, doneLast7Days: delta(d.kpis.doneDelta, true) };
  const range = (from: string, to: string) => t("kpi.range", { from: formatDate(from, year), to: formatDate(to, year) });
  const firstDoneDay = d.doneDaily[0]?.date ?? d.today;
  const kpiSub: Record<ListKey, string> = {
    overdue: t("kpi.subOverdue"),
    dueToday: t("kpi.subToday", { date: formatDate(d.today, year) }),
    laterThisWeek: range(d.kpis.laterThisWeekRange.from, d.kpis.laterThisWeekRange.to),
    doneLast7Days: range(firstDoneDay, d.today),
  };
  const items = d.lists[list];
  const maxDaily = Math.max(1, ...d.doneDaily.map((x) => x.count));
  const total7 = d.doneDaily.reduce((n, x) => n + x.count, 0);
  const statusTotal = d.statusBreakdown.columns.reduce((n, c) => n + c.count, 0);
  const updatedAt = new Date(q.dataUpdatedAt);
  const ring = 2 * Math.PI * 38;
  // แกนกราฟใช้ชื่อวันแบบย่อตาม Canvas (พฤ. ศ. ส. …)
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "Asia/Bangkok" });

  // ติ๊กเสร็จจากรายการ: ใช้สถานะกลุ่ม done/todo ตัวแรกของประเภทงาน แบบเดียวกับ My Tasks
  async function toggleDone(i: OverviewItem, done: boolean) {
    if (busy) return;
    setBusy(i.key);
    try {
      const issue = await api.get<{ type: string; version: number }>(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(i.key)}`);
      const opts = await cache.fetchQuery({ queryKey: ["form-options", ws, projectKey], queryFn: () => api.get<{ issueTypes: { name: string; statuses: { id: string; category: string }[] }[] }>(`${base}/form-options`), staleTime: 60_000 });
      const type = opts.issueTypes.find((x) => x.name === issue.type) ?? opts.issueTypes[0];
      const target = type?.statuses.find((s) => s.category === (done ? "done" : "todo"));
      if (!target) return toast({ message: t("noDoneStatus") });
      await api.patch(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(i.key)}`, { statusId: target.id }, issue.version);
      toast({ message: t(done ? "doneMarked" : "undoneMarked", { key: i.key }) });
    } catch (e) {
      toast({ message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      await cache.invalidateQueries({ queryKey: ["overview", ws, projectKey] });
    }
  }

  return (
    <div className={styles.page}>
      <div className={`${styles.bar} ${styles.desktopOnly}`} style={{ justifyContent: "space-between" }}>
        <div className={`${styles.muted} ${styles.updated}`}>
          {t("updated", { time: `${String(updatedAt.getHours()).padStart(2, "0")}:${String(updatedAt.getMinutes()).padStart(2, "0")}`, date: formatDate(d.today, year) })}
        </div>
        <div className={styles.bar}>
          <div className={styles.seg} role="group" aria-label={t("scope.label")}>
            {(["all", "mine"] as const).map((s) => <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>{t(`scope.${s}`)}</button>)}
          </div>
          <Select aria-label={t("moduleFilter")} value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
            <option value="">{t("allModules")}</option>
            {d.modules.filter((m) => m.id).map((m) => <option key={m.id} value={m.id!}>{m.name}</option>)}
          </Select>
          <PlanActions plan={plan} />
        </div>
      </div>

      <MobileSummary d={d} time={`${String(updatedAt.getHours()).padStart(2, "0")}:${String(updatedAt.getMinutes()).padStart(2, "0")}`} year={year} />

      {/* Canvas Main: สรุปโครงการอยู่ในการ์ดเดียว (วงความคืบหน้า, เวลา/งาน, Go-live, Milestone, Health) */}
      <section className={`${styles.card} ${styles.summary} ${styles.desktopOnly}`} aria-label={t("progressTitle")}>
        <div className={styles.donutBox}>
          <svg width="92" height="92" viewBox="0 0 92 92" role="img" aria-label={t("progressLabel", { pct: p.pct })}>
            <circle cx="46" cy="46" r="38" fill="none" stroke="var(--subtle)" strokeWidth="10" />
            <circle cx="46" cy="46" r="38" fill="none" stroke="var(--chart-primary)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(ring * Math.min(100, p.pct)) / 100} ${ring}`} transform="rotate(-90 46 46)" />
            <text x="46" y="52" textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--foreground)">{p.pct}%</text>
          </svg>
          <div>
            <div className={styles.muted} style={{ fontSize: 12 }}>{t("progressTitle")}</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{t("tasksDone", { done: p.tasks.done, total: p.tasks.total })}</div>
            <div className={`${styles.muted} ${styles.small}`}>{t("mdDone", { done: p.md.done, total: p.md.total, pct: p.md.pct })}</div>
          </div>
        </div>
        <div className={styles.bars}>
          <div>
            <div className={styles.line}><span>{t("timeTitle")}</span><b>{t("timeValue", { pct: p.time.pct, elapsed: p.time.elapsedWorkingDays, total: p.time.totalWorkingDays })}</b></div>
            <div className={styles.progress} style={{ marginTop: 4 }}><div style={{ width: `${p.time.pct}%`, background: "var(--chart-neutral)" }} /></div>
          </div>
          <div>
            <div className={styles.line}><span>{t("doneTitle")}</span><b>{p.pct}%</b></div>
            <div className={styles.progress} style={{ marginTop: 4 }}><div style={{ width: `${p.pct}%` }} /></div>
          </div>
        </div>
        <div className={styles.facts}>
          <div>
            <div className={styles.muted} style={{ fontSize: 12 }}>{t("remainTitle")}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{t("remainValue", { days: p.remainingWorkingDays })}</div>
            <div className={`${styles.muted} ${styles.small}`}>{p.lastPlanEnd ? t("lastPlanEnd", { date: formatDate(p.lastPlanEnd, year) }) : t("noPlan")}</div>
          </div>
          <div>
            <div className={styles.muted} style={{ fontSize: 12 }}>{t("nextMilestone")}</div>
            {p.nextMilestone ? <><div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{p.nextMilestone.name}</div><div className={`${styles.muted} ${styles.small}`}>{t("milestoneIn", { date: formatDate(p.nextMilestone.date, year), days: p.nextMilestone.daysLeft })}</div></> : <div style={{ marginTop: 4 }}>{t("noMilestone")}</div>}
          </div>
        </div>
        <PlanFacts plan={plan} />
        <div className={`${styles.health} ${styles[h.level]}`} role="status" aria-label={t("health.title", { level: t(`health.levels.${h.level}`) })}>
          <div className={styles.healthTitle}><span className={styles.dot} />{t("health.title", { level: t(`health.levels.${h.level}`) })}</div>
          <div className={styles.healthText}>
            {t("health.behind", { count: h.behindPlan })} · {t("health.overdue", { count: h.overdue.count })}
            {h.overdue.topAssignee ? ` ${t("health.top", { name: h.overdue.topAssignee.person.displayName, count: h.overdue.topAssignee.count })}` : ""}
            {h.capacity.weeksNeeded !== null ? ` · ${t("health.capacity", { need: h.capacity.weeksNeeded, left: h.capacity.weeksLeft })}` : ""}
            {` · ${t("health.gap", { planned: h.plannedPct, actual: h.actualPct })}`}
            {canPlan && <> · <a href="#planning">{t("health.planLink")}</a></>}
          </div>
        </div>
      </section>

      <div className={`${styles.kpis} ${styles.desktopOnly}`} role="group" aria-label="KPI">
        {LIST_KEYS.map((k) => (
          <button key={k} type="button" className={styles.kpi} aria-pressed={list === k} onClick={() => setList(k)}>
            <span className={styles.kpiLabel}><span className={styles.dot} style={{ background: KPI_DOT[k] }} />{t(`kpi.${k}`)}</span>
            <span className={styles.kpiValue}><b>{kpiValue[k]}</b>{kpiDelta[k]}</span>
            <span className={`${styles.muted} ${styles.small}`}>{kpiSub[k]}</span>
          </button>
        ))}
      </div>

      <div className={styles.cols}>
        <div className={`${styles.main} ${styles.desktopOnly}`}>
          <section className={styles.card}>
            <div className={styles.chead}>
              <h2>{t(`kpi.${list}`)} <span className="muted" style={{ fontWeight: 500 }}>{t("listCount", { count: kpiValue[list] })}</span></h2>
              <Link href={tableHref} style={{ fontSize: 12, fontWeight: 500 }}>{t("openInTable")}</Link>
            </div>
            {!items.length && <div className={styles.empty}>{t("listEmpty")}</div>}
            {items.map((i) => <ListRow key={i.key} i={i} list={list} href={href} year={year} busy={busy === i.key} onToggle={(done) => void toggleDone(i, done)} />)}
            {kpiValue[list] > 0 && <div className={styles.listFoot}><Link href={tableHref}>{t("seeAllList", { count: kpiValue[list] })}</Link></div>}
          </section>

          <PlanModules plan={plan} />

          <section className={styles.card}>
            <div className={styles.chead}>
              <h2>{t("chartTitle")} <span className="muted" style={{ fontWeight: 500 }}>{t("chartSub")}</span></h2>
              <div className={styles.seg}>{(["daily", "burnup"] as const).map((c) => <button key={c} type="button" aria-pressed={chart === c} onClick={() => setChart(c)}>{t(c)}</button>)}</div>
            </div>
            {chart === "daily" ? (
              <div className={styles.chartBox}>
                <div className={styles.chart} role="img" aria-label={t("dailyLabel", { values: d.doneDaily.map((x) => `${formatDate(x.date, year)} ${x.count}`).join(", ") })}>
                  {d.doneDaily.map((x) => <div key={x.date}><span>{x.count}</span><i style={{ height: Math.max(3, Math.round((x.count / maxDaily) * 120)), background: x.workingDay ? (x.date === d.today ? "var(--chart-primary)" : "var(--chart-primary-soft)") : "var(--subtle)" }} /></div>)}
                </div>
                <div className={styles.labels}>{d.doneDaily.map((x) => <span key={x.date}>{weekday.format(new Date(`${x.date}T00:00:00+07:00`))}</span>)}</div>
                <div className={`${styles.muted} ${styles.small}`} style={{ marginTop: 10 }}>{t("chartNote", { total: total7, prev: d.kpis.doneLast7Days - d.kpis.doneDelta })}</div>
              </div>
            ) : <Burnup d={d} />}
          </section>

          <section className={styles.card}>
            <div className={styles.chead}>
              <h2>{t("info")}</h2>
              <Link className="button button-small" href={`${page}/settings`}>{t("edit")}</Link>
            </div>
            <div className={styles.info}>
              {d.project.description && <div style={{ gridColumn: "1/-1" }}><div className={styles.label}>{t("goal")}</div><div>{d.project.description}</div></div>}
              {!!d.project.scope.inScope.length && <div><div className={styles.label}>{t("inScope")}</div><ul>{d.project.scope.inScope.map((x) => <li key={x}>{x}</li>)}</ul></div>}
              {!!d.project.scope.outScope.length && <div><div className={styles.label}>{t("outScope")}</div><ul>{d.project.scope.outScope.map((x) => <li key={x}>{x}</li>)}</ul></div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {d.project.owner && <div><div className={styles.label}>{t("owner")}</div><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar size="small" person={d.project.owner} />{d.project.owner.displayName}</div></div>}
                {d.project.clientName && <div><div className={styles.label}>{t("client")}</div><div>{d.project.clientName}</div></div>}
                <div className={`${styles.muted} ${styles.small}`}>{t("members", { count: d.project.memberCount, modules: d.project.moduleCount })}</div>
              </div>
            </div>
          </section>

        </div>

        <aside className={styles.side}>
          <div className={styles.desktopOnly}><PlanRisks plan={plan} /></div>
          {!canPlan && <section className={styles.card} aria-label={t("byModule")}>
            <div className={styles.chead}><h2>{t("byModule")}</h2></div>
            <div className={styles.list} style={{ gap: 16 }}>
              {d.modules.map((m) => (
                <div key={m.id ?? "none"}>
                  <div className={styles.line}><span className={styles.modName}><span className={styles.dot} style={{ background: m.color ?? "var(--primary)", borderRadius: 3 }} />{m.name}</span><span><b>{m.pct}%</b> <span className="muted">· {m.done}/{m.total}</span></span></div>
                  <div className={styles.progress} style={{ marginTop: 6 }}><div style={{ width: `${m.pct}%`, background: m.color ?? "var(--primary)" }} /></div>
                  {(m.overdue > 0 || m.notStarted) && <div className={m.overdue > 0 ? styles.late : `${styles.muted} ${styles.small}`} style={{ marginTop: 4 }}>{m.overdue > 0 ? t("moduleLate", { count: m.overdue }) : t("notStarted")}</div>}
                </div>
              ))}
            </div>
          </section>}
          <section className={`${styles.card} ${styles.desktopOnly}`}>
            <div className={styles.chead}><h2>{t("statusTitle")}</h2><span className="muted" style={{ fontSize: 12 }}>{t("statusTotal", { count: statusTotal })}</span></div>
            <div style={{ padding: "16px 18px" }}>
              <div className={styles.stack} role="img" aria-label={d.statusBreakdown.columns.map((c) => `${c.name} ${c.count}`).join(", ")}>{d.statusBreakdown.columns.map((c) => <div key={c.id} style={{ width: `${c.pct}%`, background: columnColor(c) }} />)}</div>
              <div className={styles.legend}>
                {d.statusBreakdown.columns.map((c) => <div key={c.id}><span className={styles.dot} style={{ background: columnColor(c), borderRadius: 3 }} /><span style={{ flex: 1 }}>{c.name}</span><b>{c.count}</b></div>)}
              </div>
            </div>
          </section>
          <section className={`${styles.card} ${styles.desktopOnly}`}>
            <div className={styles.chead}><h2>{t("milestones")}</h2><Link href={`${page}/timeline`} style={{ fontSize: 12 }}>{t("timeline")}</Link></div>
            <div style={{ padding: "6px 0" }}>
              {!d.milestones.length && <div className={styles.empty}>{t("noMilestone")}</div>}
              {d.milestones.map((m) => (
                <div key={m.id} className={styles.mile}>
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1 13 7 7 13 1 7z" fill={m.daysLeft < 0 ? "var(--chart-neutral)" : "var(--chart-primary)"} /></svg>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>{m.name}</div><div className={`${styles.muted} ${styles.small}`}>{t("milestoneLine", { date: formatDate(m.date, year), pct: m.donePct })} ({t(`milestoneBasis.${m.basis}`)})</div></div>
                  <Badge>{m.daysLeft >= 0 ? t("daysLeft", { days: m.daysLeft }) : t("daysPast", { days: -m.daysLeft })}</Badge>
                </div>
              ))}
            </div>
          </section>
          {d.workloadThisWeek && !canPlan && (
            <section className={styles.card}>
              <div className={styles.chead}><h2>{t("workload")} <span className="muted" style={{ fontWeight: 500 }}>· {formatDate(d.workloadThisWeek.from, year)} – {formatDate(d.workloadThisWeek.to, year)}</span></h2><Link href={`${page}/members`} style={{ fontSize: 12 }}>{t("seeAll")}</Link></div>
              <div className={styles.list}>
                {d.workloadThisWeek.people.map((w) => (
                  <div key={w.person.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <Avatar size="small" person={w.person} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={styles.line}><span style={{ fontWeight: 500 }}>{w.person.displayName}</span><b className={w.over ? styles.bad : undefined}>{t("workloadLine", { md: w.md, cap: w.capacityMd, pct: w.utilizationPct ?? 0 })}</b></div>
                      <div className={styles.progress} style={{ height: 6, marginTop: 4 }}><div style={{ width: `${Math.min(100, w.utilizationPct ?? 0)}%`, background: w.over ? "var(--warning-solid)" : "var(--chart-primary-soft)" }} /></div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className={`${styles.card} ${styles.desktopOnly}`}>
            <div className={styles.chead}><h2>{t("activity")}</h2></div>
            <div style={{ padding: "6px 0" }}>
              {!d.activity.length && <div className={styles.empty}>{t("activityEmpty")}</div>}
              {d.activity.slice(0, 8).map((a) => (
                <div key={a.id} className={styles.act}>
                  <Avatar size="small" person={a.actor ?? { id: a.id, displayName: a.actorKind === "user" ? t("hidden") : t("system") }} />
                  <div style={{ fontSize: 12, minWidth: 0 }}>
                    <b>{a.actor?.displayName ?? t("system")}</b> {t.has(`verbs.${a.verb}` as never) ? t(`verbs.${a.verb}` as never) : t("verbs.other")} {a.field ? `${a.field} ` : ""}{a.issue && <Link href={href(a.issue.key)}>{a.issue.key} {a.issue.title}</Link>}
                    <div className={`${styles.muted} ${styles.small}`}>{formatDate(a.createdAt, year)}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
      {/* Workload รายสัปดาห์กว้างหลายเดือน จึงใช้เต็มความกว้าง · จอใหญ่เท่านั้นเหมือนหน้า O1 เดิม */}
      {canPlan && <div className={styles.desktopOnly}><PlanWorkload plan={plan} /></div>}

    </div>
  );
}

/** M6 · มือถือ: สรุปกะทัดรัด, Milestone ถัดไป และความเสี่ยง (ซ่อนบนจอใหญ่) */
function MobileSummary({ d, time, year }: { d: Overview; time: string; year: YearFormat }) {
  const t = useTranslations("overview-table.overview");
  const p = d.progress;
  const h = d.health;
  const tone = { on_track: styles.sDoneM, at_risk: styles.sRevM, off_track: styles.sLateM }[h.level];
  const risks: { text: string; sub?: string; color: string }[] = [];
  if (h.overdue.topAssignee) risks.push({ text: t("mobile.riskOverdue", { name: h.overdue.topAssignee.person.displayName, count: h.overdue.topAssignee.count }), color: "var(--danger)" });
  if (h.capacity.weeksNeeded !== null && h.capacity.weeksNeeded > h.capacity.weeksLeft) risks.push({ text: t("mobile.riskCapacity"), sub: t("health.capacity", { need: h.capacity.weeksNeeded, left: h.capacity.weeksLeft }), color: "var(--danger)" });
  for (const m of d.modules.filter((x) => x.overdue > 0).slice(0, 2)) risks.push({ text: t("mobile.riskModule", { name: m.name, count: m.overdue }), color: "var(--warning-solid)" });
  if (d.counts?.pendingDueRequests) risks.push({ text: t("mobile.riskPending", { count: d.counts.pendingDueRequests }), color: "var(--warning-solid)" });
  if (d.counts?.openBugs) risks.push({ text: t("mobile.riskBugs", { count: d.counts.openBugs }), color: "var(--warning-solid)" });
  const next = p.nextMilestone;
  return (
    <div className={styles.mobileOnly}>
      <section className={`${styles.card} ${styles.mcard}`} aria-label={t("progressTitle")}>
        <div className={styles.line}><span className={`${styles.mpill} ${tone}`}>{t(`health.levels.${h.level}`)}</span><span className={`${styles.muted} ${styles.small}`}>{t("mobile.updatedBy", { time })}</span></div>
        <div className={styles.mbig}><b>{p.pct}%</b><span className={styles.muted}>{t("mobile.line", { done: p.tasks.done, total: p.tasks.total, time: p.time.pct })}</span></div>
        <div className={styles.mtrack}><div style={{ width: `${p.pct}%` }} /><span style={{ left: `${p.time.pct}%` }} aria-hidden="true" /></div>
        <div className={styles.mtiles}>
          <div className={styles.mlate}><b>{d.kpis.overdue}</b>Overdue</div>
          {d.counts && <div><b>{d.counts.openBugs}</b>{t("mobile.openBugs")}</div>}
          {d.counts && <div><b>{d.counts.pendingDueRequests}</b>{t("mobile.pending")}</div>}
        </div>
      </section>
      {next && (
        <section className={`${styles.card} ${styles.mcard}`}>
          <h2 className={styles.mh}>{t("nextMilestone")}</h2>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div className={styles.mdate}><b>{Number(next.date.slice(8))}</b><span>{formatDate(next.date, year).split(" ")[1]}</span></div>
            <div><b>{next.name}</b><div className={`${styles.muted} ${styles.small}`}>{t("milestoneIn", { date: formatDate(next.date, year), days: next.daysLeft })}</div></div>
          </div>
        </section>
      )}
      <section className={`${styles.card} ${styles.mcard}`}>
        <h2 className={styles.mh}>{t("mobile.risks")}</h2>
        {!risks.length && <div className={`${styles.muted} ${styles.small}`}>{t("mobile.noRisks")}</div>}
        {risks.map((r) => (
          <div key={r.text} className={styles.risk}><span style={{ background: r.color }} /><div><div>{r.text}</div>{r.sub && <div className={`${styles.muted} ${styles.small}`}>{r.sub}</div>}</div></div>
        ))}
      </section>
    </div>
  );
}

function ListRow({ i, list, href, year, busy, onToggle }: { i: OverviewItem; list: ListKey; href: (key: string) => string; year: YearFormat; busy: boolean; onToggle: (done: boolean) => void }) {
  const t = useTranslations("overview-table.overview");
  const open = i.canOpen !== false;
  const done = i.status.category === "done" || !!i.completedOn;
  const color = i.module?.color ?? DEFAULT_ITEM_COLOR;
  const date = i.completedOn
    ? { text: t("doneOn", { date: formatDate(i.completedOn, year) }), cls: styles.dtDone }
    : i.lateDays > 0
      ? { text: t("lateDays", { days: i.lateDays }), cls: styles.dtLate }
      : list === "dueToday"
        ? { text: t("todayLabel"), cls: styles.dtToday }
        : { text: i.planEnd ? formatDate(i.planEnd, year) : "", cls: styles.dtWeek };
  const sub = [i.key, i.parentKey ? `↳ ${i.parentKey}` : null].filter(Boolean).join(" · ");
  return (
    <div className={styles.row}>
      {done
        ? <svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-label={t("doneTitle")} style={{ flex: "none" }}><circle cx="12" cy="12" r="10" fill="var(--success-solid)" /><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="var(--on-primary)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <input type="checkbox" className={styles.check} disabled={busy || !open} aria-label={t("markDone", { title: i.title })} onChange={(e) => onToggle(e.target.checked)} />}
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        {open ? <Link className={styles.rowTitle} href={href(i.key)}>{i.title}</Link> : <span className={styles.rowTitle}>{i.title}</span>}
        <div className={styles.rowMeta}>
          {i.module && <span className={styles.modPill} style={{ background: tint(color, 10), color: readableColor(color) }}>{i.module.name}</span>}
          <span className={`${styles.muted} ${styles.small}`}>{sub}</span>
        </div>
      </div>
      {date.text && <span className={`${styles.dt} ${date.cls}`}>{date.text}</span>}
      {!!i.assignees?.length && <AvatarStack people={i.assignees} max={2} />}
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
        <line x1={0} x2={W} y1={y(d.burnup.total)} y2={y(d.burnup.total)} stroke="var(--border-strong)" strokeDasharray="4 4" />
        <polyline fill="none" stroke="var(--chart-neutral)" strokeWidth={2} points={line(pts.map((p) => p.planned))} />
        <polyline fill="none" stroke="var(--chart-primary)" strokeWidth={2.5} points={line(pts.map((p) => p.done))} />
      </svg>
      <div className={styles.bar} style={{ fontSize: 11 }}><span style={{ color: "var(--muted)" }}>— {t("planned")}</span><span style={{ color: "var(--primary-text)" }}>— {t("actual")}</span></div>
    </div>
  );
}
