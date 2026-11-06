"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Avatar, Badge, Button, EmptyState, ErrorState, Forbidden, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatManDay, type YearFormat } from "@/lib/format";
import type { HomeData, Health, InboxItem } from "./types";
import { bkkHour, projectHref, taskHref } from "./shared";
import styles from "./hmt.module.css";

const HEALTH_TONE = { on_track: "green", at_risk: "amber", off_track: "red", unknown: "neutral" } as const;
const HEALTH_ORDER: Record<Health, number> = { off_track: 0, at_risk: 1, on_track: 2, unknown: 3 };
const inboxHref = (ws: string) => `/w/${encodeURIComponent(ws)}/inbox`;

export function HomePage({ ws }: { ws: string }) {
  const t = useTranslations("home-my-tasks.home");
  const { me, workspace } = useWorkspace();
  const home = useQuery({ queryKey: ["home", ws], queryFn: () => api.get<HomeData>(`/w/${encodeURIComponent(ws)}/home`) });
  const guest = workspace.role === "guest";
  const inbox = useQuery({
    queryKey: ["home", ws, "inbox"],
    queryFn: () => api.get<{ items: InboxItem[] }>(`/me/notifications?workspace=${encodeURIComponent(ws)}&filter=all&limit=4`),
    enabled: !guest,
  });
  if (home.isPending) return <div className={styles.body}><LoadingState /></div>;
  if (home.error) {
    const e = home.error;
    return <div className={styles.body}>{e instanceof ApiError && e.status === 403 ? <Forbidden /> : <ErrorState error={e} retry={() => home.refetch()} />}</div>;
  }
  const d = home.data;
  const year: YearFormat = me.yearFormat;
  const hour = bkkHour();
  const greeting = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const s = d.summary;
  return (
    <>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <div>
            <div className="muted" style={{ fontSize: 13 }}>{formatDate(d.today, year, true)}</div>
            <h1 className={styles.title}>{t(`greeting.${greeting}`, { name: me.displayName })}</h1>
            <div className={styles.sub} data-testid="summary-line">
              {t("summaryLine", { dueToday: t("dueTodayCount", { count: s.dueToday.team }), overdue: t("overdueCount", { count: s.overdue.team }), reviews: t("reviewsCount", { count: s.waitingReview }), approvals: t("approvalsCount", { count: s.pendingApprovals }) })}
            </div>
            {guest && <div className={styles.sub}>{t("guestNote")}</div>}
          </div>
          {!guest && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link className="button button-secondary" href={`/w/${encodeURIComponent(ws)}/new-project`}>{t("newProject")}</Link>
            </div>
          )}
        </div>
      </header>
      <div className={styles.body}>
        <Kpis data={d} ws={ws} year={year} />
        <div className={styles.cols}>
          <div className={styles.colMain}>
            <Waiting data={d} ws={ws} />
            <Projects data={d} ws={ws} year={year} />
            <Recent data={d} ws={ws} />
          </div>
          <div className={styles.colSide}>
            <Reviews data={d} ws={ws} />
            {!guest && <InboxCard ws={ws} items={inbox.data?.items} loading={inbox.isPending} />}
            <Upcoming data={d} year={year} />
            {d.workload && <Workload data={d} ws={ws} />}
          </div>
        </div>
      </div>
    </>
  );
}

function Kpis({ data, ws, year }: { data: HomeData; ws: string; year: YearFormat }) {
  const t = useTranslations("home-my-tasks.home.kpi");
  const s = data.summary;
  const my = `/w/${encodeURIComponent(ws)}/my-tasks`;
  const byAssignee = s.overdue.byAssignee.filter((x) => x.person).map((x) => `${x.person!.displayName} ${x.count}`).join(" · ");
  return (
    <div className={styles.kpis}>
      <Link className={styles.kpi} href={my}>
        <span className={styles.kpiLabel}><span className={styles.dot} style={{ background: "#d97706" }} />{t("dueToday")}</span>
        <span className={styles.kpiValue}>{s.dueToday.team}</span>
        <span className={styles.kpiNote}>{s.dueToday.keys.join(", ") || t("none")}</span>
      </Link>
      <Link className={styles.kpi} href={my}>
        <span className={styles.kpiLabel}><span className={styles.dot} style={{ background: "#dc2626" }} />{t("overdue")}</span>
        <span className={styles.kpiValue} style={{ color: "#b91c1c" }}>{s.overdue.team}</span>
        <span className={styles.kpiNote}>{byAssignee || t("none")}</span>
      </Link>
      <Link className={styles.kpi} href={`/w/${encodeURIComponent(ws)}/my-tasks`}>
        <span className={styles.kpiLabel}><span className={styles.dot} style={{ background: "#2563eb" }} />{t("dueThisWeek")}</span>
        <span className={styles.kpiValue}>{s.dueThisWeek.team}</span>
        <span className={styles.kpiNote}>{t("untilDay", { date: formatDate(s.dueThisWeek.until, year) })}</span>
      </Link>
      <a className={styles.kpi} href="#review">
        <span className={styles.kpiLabel}><span className={styles.dot} style={{ background: "#f59e0b" }} />{t("review")}</span>
        <span className={styles.kpiValue}>{s.waitingReview}</span>
        <span className={styles.kpiNote}>{t("andApprovals", { count: s.pendingApprovals })}</span>
      </a>
      <a className={styles.kpi} href="#inbox">
        <span className={styles.kpiLabel}><span className={styles.dot} style={{ background: "#7c3aed" }} />{t("mentions")}</span>
        <span className={styles.kpiValue}>{s.unreadMentions.count}</span>
        <span className={styles.kpiNote}>{s.unreadMentions.latestFrom ? t("mentionsFrom", { name: s.unreadMentions.latestFrom }) : t("none")}</span>
      </a>
    </div>
  );
}

function Waiting({ data, ws }: { data: HomeData; ws: string }) {
  const t = useTranslations("home-my-tasks.home");
  const cache = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject"; key: string }) => api.post(`/w/${encodeURIComponent(ws)}/due-requests/${encodeURIComponent(id)}/${action}`, {}),
    onSuccess: async (_r, v) => {
      setError(null);
      toast({ message: t(v.action === "approve" ? "approved" : "rejected", { key: v.key }) });
      await cache.invalidateQueries({ queryKey: ["home", ws] });
    },
    onError: setError,
  });
  const rows = data.waiting.approvals;
  const empty = !rows.length && !data.waiting.reviews.length;
  return (
    <section className={styles.card} aria-labelledby="waiting-title">
      <div className={styles.chead}>
        <h2 id="waiting-title">{t("waitingTitle")} <span className="muted" style={{ fontWeight: 500 }}>· {t("waitingSub")}</span></h2>
        <Link href={`/w/${encodeURIComponent(ws)}/my-tasks`} style={{ fontSize: 13, fontWeight: 500 }}>{t("openMyTasks")}</Link>
      </div>
      {!!error && <div style={{ padding: 12 }}><ErrorState error={error} /></div>}
      {rows.map((r) => (
        <div className={styles.row} key={r.id}>
          <div className={styles.rowMain}>
            <Link className={styles.rowTitle} href={taskHref(ws, r.project.key, r.issue.key)}>{t("approvalRow", { name: r.requester?.displayName ?? "-", key: r.issue.key, title: r.issue.title })}</Link>
            <div className={styles.rowMeta}>
              <span>{r.project.name}</span>
              <span>{t("approvalDue", { from: formatDate(r.previousDue ?? r.issue.planEnd), to: formatDate(r.requestedDue) })}</span>
            </div>
          </div>
          <Badge tone="neutral">{t("waitingForApproval")}</Badge>
          {r.canDecide && (
            <div className={styles.actions}>
              <Button size="small" disabled={decide.isPending} aria-label={`${t("reject")} ${r.issue.key}`} onClick={() => decide.mutate({ id: r.id, action: "reject", key: r.issue.key })}>{t("reject")}</Button>
              <Button size="small" variant="primary" disabled={decide.isPending} aria-label={`${t("approve")} ${r.issue.key}`} onClick={() => decide.mutate({ id: r.id, action: "approve", key: r.issue.key })}>{t("approve")}</Button>
            </div>
          )}
        </div>
      ))}
      {data.waiting.reviews.map((r) => (
        <div className={styles.row} key={r.key}>
          <div className={styles.rowMain}>
            <Link className={styles.rowTitle} href={taskHref(ws, r.project.key, r.key)}>{t("reviewRow", { key: r.key, title: r.title })}</Link>
            <div className={styles.rowMeta}><span>{r.project.name}</span>{r.from && <span>{t("reviewFrom", { name: r.from.displayName })}</span>}</div>
          </div>
          <Badge tone="amber">{r.status.name}</Badge>
          <DueText planEnd={r.planEnd} today={data.today} />
        </div>
      ))}
      {empty && <EmptyState title={t("waitingEmpty")} description={t("waitingEmptyHint")} />}
      {!empty && <div className={styles.hint}>{t("waitingHint")}</div>}
    </section>
  );
}

function DueText({ planEnd, today }: { planEnd: string | null; today: string }) {
  const t = useTranslations("home-my-tasks.tasks.dueLabels");
  if (!planEnd) return <span className={`${styles.dt} muted`}>{t("none")}</span>;
  const days = Math.round((Date.parse(today) - Date.parse(planEnd)) / 86_400_000);
  if (days > 0) return <span className={`${styles.dt} ${styles.late}`}>{t("overdue", { days })}</span>;
  if (days === 0) return <span className={`${styles.dt} ${styles.today}`}>{t("today")}</span>;
  return <span className={styles.dt}>{formatDate(planEnd)}</span>;
}

function Projects({ data, ws, year }: { data: HomeData; ws: string; year: YearFormat }) {
  const t = useTranslations("home-my-tasks.home");
  const [sort, setSort] = useState<"golive" | "health" | "name">("golive");
  const list = [...data.projects].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "health" ? HEALTH_ORDER[a.health.level] - HEALTH_ORDER[b.health.level] : (a.goliveDate ?? "9999").localeCompare(b.goliveDate ?? "9999"));
  return (
    <section aria-labelledby="projects-title">
      <div className={styles.sectionHead}>
        <h2 id="projects-title">{t("myProjects")} <span className="muted" style={{ fontWeight: 500 }}>· {list.length}</span></h2>
        <Select aria-label={t("sortBy")} size="small" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          {(["golive", "health", "name"] as const).map((k) => <option key={k} value={k}>{t("sortBy")}: {t(`sort.${k}`)}</option>)}
        </Select>
      </div>
      {!list.length ? <EmptyState title={t("projectsEmpty")} description={t("projectsEmptyHint")} /> : (
        <div className={styles.pgrid}>
          {list.map((p) => {
            const color = p.color ?? "#334155";
            const go = p.daysToGolive === null ? t("noGolive") : p.daysToGolive >= 0 ? t("daysToGolive", { days: p.daysToGolive }) : t("golivePassed", { days: -p.daysToGolive });
            return (
              <Link className={styles.pc} key={p.key} href={projectHref(ws, p.key)}>
                <div className={styles.pcTop}>
                  <span className={styles.pcIcon} style={{ background: color }}>{p.key.slice(0, 2)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}><div className={styles.pcName}>{p.name}</div><div className="muted" style={{ fontSize: 12 }}>{t("projectRole", { key: p.key, count: p.myTasks })}</div></div>
                  <Badge tone={HEALTH_TONE[p.health.level]}>{t(`health.${p.health.level}`)}</Badge>
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}><span className="muted">{t("progress")}</span><b>{p.progressPct}%</b></div>
                  <div className={styles.bar}><div style={{ width: `${p.progressPct}%`, background: color }} /></div>
                </div>
                <div className={styles.stats}>
                  <div><span className="muted">{t("overdueShort")}</span><b style={{ color: p.overdue ? "#b91c1c" : undefined }}>{p.overdue}</b></div>
                  <div><span className="muted">{t("myTasksShort")}</span><b>{p.myTasks}</b></div>
                  <div><span className="muted">{t("goLive")}</span><b style={{ fontSize: 13 }}>{formatDate(p.goliveDate, year)}</b><span className="muted">{go}</span></div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Recent({ data, ws }: { data: HomeData; ws: string }) {
  const t = useTranslations("home-my-tasks.home");
  return (
    <section className={styles.card}>
      <div className={styles.chead}><h2>{t("recent")}</h2></div>
      {!data.recent.length ? <div className={styles.empty}>{t("recentEmpty")}</div> : (
        <div className={styles.chips}>
          {data.recent.map((r) => <Link key={r.key} className={styles.chipLink} href={taskHref(ws, r.project.key, r.key)}><span className="muted">{r.key}</span> {r.title}</Link>)}
        </div>
      )}
    </section>
  );
}

function Reviews({ data, ws }: { data: HomeData; ws: string }) {
  const t = useTranslations("home-my-tasks.home");
  return (
    <section className={styles.card} id="review">
      <div className={styles.chead}><h2>{t("reviewTitle")} <span className="muted" style={{ fontWeight: 500 }}>· {data.waiting.reviews.length}</span></h2></div>
      {!data.waiting.reviews.length && <div className={styles.empty}>{t("reviewEmpty")}</div>}
      {data.waiting.reviews.map((r) => (
        <Link className={styles.li} key={r.key} href={taskHref(ws, r.project.key, r.key)}>
          <Badge tone="amber">{r.status.name}</Badge>
          <div style={{ flex: 1, minWidth: 0 }}><div className={styles.liTitle}>{r.key} {r.title}</div><div className={`muted ${styles.small}`}>{r.from ? `${r.from.displayName} · ` : ""}{r.project.name}</div></div>
          <DueText planEnd={r.planEnd} today={data.today} />
        </Link>
      ))}
    </section>
  );
}

function InboxCard({ ws, items, loading }: { ws: string; items?: InboxItem[]; loading: boolean }) {
  const t = useTranslations("home-my-tasks.home");
  const fresh = items?.filter((i) => !i.readAt).length ?? 0;
  // คีย์ข้อความใช้ "__" แทน "." ของชื่อ Event (next-intl ใช้ "." แยกระดับ)
  const label = (type: string) => (type in EVENT_KEYS ? t(`events.${type.replace(/\./g, "__")}` as never) : t("events.other"));
  return (
    <section className={styles.card} id="inbox">
      <div className={styles.chead}>
        <h2>{t("inbox")} {fresh > 0 && <Badge tone="red">{t("inboxNew", { count: fresh })}</Badge>}</h2>
        <Link href={inboxHref(ws)} style={{ fontSize: 13 }}>{t("inboxAll")}</Link>
      </div>
      {loading && <div className={styles.empty}>…</div>}
      {!loading && !items?.length && <div className={styles.empty}>{t("inboxEmpty")}</div>}
      {items?.map((n) => {
        const name = n.actor?.displayName ?? t("inboxSystem");
        const target = [n.payload.issueKey, n.payload.title].filter(Boolean).join(" ");
        return (
          <Link className={styles.li} key={n.id} href={inboxHref(ws)}>
            <Avatar size="small" person={{ id: n.actor?.id ?? n.id, displayName: name }} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
              <div><b>{name}</b> {label(n.eventType)} <span style={{ fontWeight: 600 }}>{target}</span></div>
              {typeof n.payload.message === "string" && <div className={`muted ${styles.small}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>“{n.payload.message}”</div>}
              <div className={`muted ${styles.small}`}>{formatDate(n.createdAt)}</div>
            </div>
            {!n.readAt && <span className={styles.dot} style={{ background: "#1d4ed8", marginTop: 6 }} role="img" aria-label={t("inboxUnread")} />}
          </Link>
        );
      })}
    </section>
  );
}
const EVENT_KEYS: Record<string, true> = { "issue.assigned": true, "issue.commented": true, "issue.mentioned": true, "issue.status_changed": true, "issue.review_requested": true, "issue.due_soon": true, "issue.overdue": true, "due_request.created": true, "due_request.decided": true };

function Upcoming({ data, year }: { data: HomeData; year: YearFormat }) {
  const t = useTranslations("home-my-tasks.home");
  const parts = (iso: string) => ({ d: String(Number(iso.slice(8, 10))), m: formatDate(iso, year).split(" ")[1] ?? "" });
  return (
    <section className={styles.card}>
      <div className={styles.chead}><h2>{t("upcoming")} <span className="muted" style={{ fontWeight: 500 }}>· {t("upcomingSub")}</span></h2></div>
      {!data.upcoming.length && <div className={styles.empty}>{t("upcomingEmpty")}</div>}
      <div style={{ padding: "8px 0" }}>
        {data.upcoming.map((e, i) => {
          const days = Math.round((Date.parse(e.date) - Date.parse(data.today)) / 86_400_000);
          const p = parts(e.date);
          return (
            <div className={styles.upRow} key={`${e.date}-${e.type}-${i}`}>
              <div className={styles.upDate}><b>{p.d}</b><span className="muted" style={{ fontSize: 11 }}>{p.m}</span></div>
              <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="2.5" width="9" height="9" transform="rotate(45 7 7)" fill={e.type === "holiday" ? "#94a3b8" : "#1d4ed8"} /></svg>
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13 }}>{t(`upcomingTypes.${e.type}`)} · {e.title}</div>{e.project && <div className={`muted ${styles.small}`}>{e.project}</div>}</div>
              <Badge>{t("inDays", { days })}</Badge>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Workload({ data, ws }: { data: HomeData; ws: string }) {
  const t = useTranslations("home-my-tasks.home");
  const w = data.workload!;
  const people = w.people.slice(0, 6);
  const scale = Math.max(1, ...people.map((p) => p.md), ...people.map((p) => p.capacityMd));
  const h = (md: number) => Math.max(3, Math.round((md / scale) * 80));
  const cap = people.length ? Math.max(...people.map((p) => p.capacityMd)) : 0;
  const label = people.map((p) => `${p.person?.displayName ?? "-"} ${p.md}`).join(", ");
  return (
    <section className={styles.card}>
      <div className={styles.chead}>
        <h2>{t("workloadTitle")}</h2>
        <span style={{ fontSize: 13, fontWeight: 600, color: w.team.md > w.team.capacityMd ? "#b91c1c" : undefined }}>{t("workloadTotal", { md: w.team.md.toFixed(1), capacity: w.team.capacityMd.toFixed(0) })}</span>
      </div>
      <div className={styles.chart} role="img" aria-label={`${t("workloadChart")}: ${label}`}>
        {cap > 0 && <span className={styles.cap} style={{ bottom: h(cap) }} />}
        {people.map((p, i) => (
          <div className={styles.chartCol} key={p.person?.id ?? i}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{formatManDay(p.md).replace(/\s?MD$/, "")}</span>
            <i style={{ height: h(p.md), background: p.md > p.capacityMd ? "#ea580c" : "#93b4f5" }} />
          </div>
        ))}
      </div>
      <div className={styles.chartLabels}>{people.map((p, i) => <span key={p.person?.id ?? i} style={{ fontWeight: p.md > p.capacityMd ? 700 : 500, color: p.md > p.capacityMd ? "#b91c1c" : "#5f6873" }}>{p.person?.displayName ?? "-"}</span>)}</div>
      <div className={styles.hint}>{t("workloadNote")} · <Link href={`/w/${encodeURIComponent(ws)}/members`}>{t("workloadAll")}</Link></div>
    </section>
  );
}
