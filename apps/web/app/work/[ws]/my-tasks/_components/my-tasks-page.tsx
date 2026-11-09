"use client";

import { useRef, useState, type DragEvent, type TouchEvent } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Filter, Flag, Plus, Search } from "lucide-react";
import { useIsMobile } from "@/lib/use-mobile";
import { CalendarClock, ChevronDown } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import type { FormOptions, GroupBy, MyIssues, Tab, TaskGroup, TaskItem } from "./types";
import { StatusBadge, taskHref, useDueText } from "./shared";
import styles from "./hmt.module.css";
import { FALLBACK_PROJECT_COLOR } from "@/lib/colors";

const TABS: Tab[] = ["assigned", "reviewer", "watching", "created"];
const GROUPS: GroupBy[] = ["due", "project", "status"];
const GROUP_COLOR: Record<string, string> = { late: "var(--danger)", today: "var(--warning-solid)", this_week: "var(--chart-primary)", next_week: "var(--accent-teal)", later: "var(--chart-neutral)", none: "var(--chart-neutral)", done_today: "var(--success-solid)" };
const DROPPABLE = new Set(["today", "this_week", "next_week"]);
const REASONS = ["scope_added", "waiting_input", "blocked_by_dependency", "estimate_wrong", "other"] as const;

/** วันที่ปลายทางเมื่อวางงานที่หัวกลุ่ม · กลุ่มสัปดาห์ = วันทำการสุดท้าย (ศุกร์) ของช่วงนั้น */
export function dropTarget(group: TaskGroup): string | null {
  if (!group.range || !DROPPABLE.has(group.key)) return null;
  if (group.key === "today") return group.range.from;
  const d = new Date(`${group.range.to}T12:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 2 : dow === 6 ? 1 : 0));
  return d.toISOString().slice(0, 10);
}

/** Man-Day ต่อวัน (จ.–ศ.) ของสัปดาห์นี้: Man-Day ÷ วันทำงานในช่วงงาน ÷ จำนวนผู้รับผิดชอบ (ไม่หักวันหยุดบริษัท) */
export function weekLoad(items: TaskItem[], weekStart: string) {
  const day = (i: number) => new Date(Date.parse(`${weekStart}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
  const working = (a: string, b: string) => {
    let n = 0;
    for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86_400_000) {
      const w = new Date(t).getUTCDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  };
  return Array.from({ length: 5 }, (_, i) => day(i)).map((d) =>
    items.reduce((sum, i) => {
      if (i.status.category === "done" || !i.estimateMd || !i.planStart || !i.planEnd || d < i.planStart || d > i.planEnd) return sum;
      return sum + i.estimateMd / Math.max(1, working(i.planStart, i.planEnd)) / Math.max(1, i.assignees.length);
    }, 0),
  );
}

export function weekStartOf(today: string) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function MyTasksPage({ ws }: { ws: string }) {
  const t = useTranslations("home-my-tasks.tasks");
  const { me, projects: myProjects } = useWorkspace();
  const firstProject = myProjects[0];
  const cache = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("assigned");
  const mobile = useIsMobile();
  const [groupChoice, setGroup] = useState<GroupBy>("due");
  // M2 มือถือจัดกลุ่มตาม Due เสมอ
  const group: GroupBy = mobile ? "due" : groupChoice;
  const [project, setProject] = useState("");
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({ "due:later": true, "due:none": true });
  const [dueFor, setDueFor] = useState<{ item: TaskItem; date: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dragKey = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const year: YearFormat = me.yearFormat;
  const base = `/w/${encodeURIComponent(ws)}`;
  const params = new URLSearchParams({ tab, group });
  if (project) params.set("projectKey", project);
  const list = useQuery({ queryKey: ["my-tasks", ws, params.toString()], queryFn: () => api.get<MyIssues>(`${base}/my-issues?${params}`) });
  // ชิปโปรเจกต์ใช้ข้อมูลทั้งแท็บ (ไม่กรอง) เพื่อให้ชิปยังอยู่เมื่อเลือกโปรเจกต์ใดโปรเจกต์หนึ่ง
  const all = useQuery({ queryKey: ["my-tasks", ws, `${tab}:projects`], queryFn: () => api.get<MyIssues>(`${base}/my-issues?tab=${tab}&group=project`) });
  const refresh = () => cache.invalidateQueries({ queryKey: ["my-tasks", ws] });

  async function setDone(item: TaskItem, done: boolean) {
    if (busy) return;
    setBusy(item.key);
    try {
      const opts = await cache.fetchQuery({ queryKey: ["form-options", ws, item.project.key], queryFn: () => api.get<FormOptions>(`${base}/projects/${encodeURIComponent(item.project.key)}/form-options`), staleTime: 60_000 });
      const type = opts.issueTypes.find((x) => x.name === item.type) ?? opts.issueTypes[0];
      const target = type?.statuses.find((s) => s.category === (done ? "done" : "todo"));
      if (!target) {
        toast({ message: t("noDoneStatus") });
        return;
      }
      await api.patch(`${base}/issues/${encodeURIComponent(item.key)}`, { statusId: target.id }, item.version);
      toast({ message: t(done ? "closed" : "reopened", { key: item.key }) });
    } catch (e) {
      toast({ message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  function onDrop(e: DragEvent, g: TaskGroup) {
    e.preventDefault();
    setOver(null);
    const target = dropTarget(g);
    const item = list.data?.groups.flatMap((x) => x.items).find((i) => i.key === dragKey.current);
    dragKey.current = null;
    if (target && item && item.planEnd !== target) setDueFor({ item, date: target });
  }

  if (list.isPending) return <div className={styles.body}><LoadingState /></div>;
  if (list.error) return <div className={styles.body}>{list.error instanceof ApiError && list.error.status === 403 ? <Forbidden /> : <ErrorState error={list.error} retry={() => list.refetch()} />}</div>;
  const data = list.data;
  if (mobile) return <MobileTasks data={data} ws={ws} name={me.displayName} year={year} tab={tab} setTab={(k) => { setTab(k); setProject(""); }} busy={busy} onToggle={(item, done) => void setDone(item, done)} />;
  const everything = data.groups.flatMap((g) => g.items);
  const open = everything.filter((i) => i.status.category !== "done");
  const estSum = open.reduce((n, i) => n + (i.estimateMd ?? 0) / Math.max(1, i.assignees.length), 0);
  const count = (k: string) => data.groups.find((g) => g.key === k)?.count ?? 0;
  const byProject = (all.data?.groups ?? [])
    .map((g) => {
      const items = g.items.filter((i) => i.status.category !== "done");
      return { key: g.key, name: g.label, color: g.items[0]?.project.color ?? FALLBACK_PROJECT_COLOR, n: items.length, md: items.reduce((n, i) => n + (i.estimateMd ?? 0), 0) };
    })
    .filter((p) => p.n);
  const maxProject = Math.max(1, ...byProject.map((x) => x.n));
  const wk = weekLoad(open, weekStartOf(data.today));
  const maxWk = Math.max(1, ...wk);
  const dayNames = t.raw("days") as string[];

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <div>
            <h1 className={styles.title} style={{ fontSize: 22 }}>{t("title")}</h1>
            <div className={styles.sub}>
              {t("owner", { name: me.displayName })} · <b>{t("openCount", { count: data.counts[tab] })}</b> · {t("estSum", { md: estSum.toFixed(1) })}
            </div>
          </div>
          {firstProject && <Link className="button button-primary" href={`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(firstProject.key)}?new=1`}>{t("newTask")}</Link>}
        </div>
        <div className={styles.filters}>
          <div className={styles.tabsScroll} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }} role="group" aria-label={t("title")}>
            {TABS.map((k) => (
              <button key={k} type="button" className={styles.chip} aria-pressed={tab === k} onClick={() => { setTab(k); setProject(""); }}>
                <span>{t(`tabs.${k}`)}</span> <span>{data.counts[k]}</span>
              </button>
            ))}
            {byProject.length > 1 && (
              <>
                <span className={styles.sep} />
                <button type="button" className={styles.chip} aria-pressed={!project} onClick={() => setProject("")}>{t("allProjects")}</button>
                {byProject.map((p) => (
                  <button type="button" key={p.key} className={styles.chip} aria-pressed={project === p.key} onClick={() => setProject(p.key)}>
                    <span className={styles.dot} style={{ background: p.color, width: 9, height: 9 }} />{p.name}
                  </button>
                ))}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12 }}>{t("groupBy")}</span>
            <div className={styles.seg} role="group" aria-label={t("groupBy")}>
              {GROUPS.map((g) => <button type="button" key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>{t(`group.${g}`)}</button>)}
            </div>
          </div>
        </div>
      </header>
      <div className={styles.body} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" }}>
        <section className={styles.card} style={{ flex: "999 1 620px", overflow: "hidden" }} aria-label={t("title")}>
          {everything.length === 0 && <EmptyState title={project ? t("emptyFiltered") : t("empty")} description={t("emptyHint")} />}
          {everything.length > 0 && data.groups.map((g) => {
            const id = `${group}:${g.key}`;
            const isClosed = !!closedGroups[id];
            const target = group === "due" ? dropTarget(g) : null;
            const sub = g.range
              ? g.range.to && g.range.to !== g.range.from
                ? t("range", { from: formatDate(g.range.from, year), to: formatDate(g.range.to, year) })
                : g.range.to
                  ? formatDate(g.range.from, year)
                  : t("rangeFrom", { from: formatDate(g.range.from, year) })
              : "";
            return (
              <div key={id} role="group" aria-label={g.label}>
                <button
                  type="button"
                  className={`${styles.gh} ${over === id ? styles.over : ""}`}
                  aria-expanded={!isClosed}
                  aria-label={t(isClosed ? "expand" : "collapse", { name: g.label })}
                  data-drop={target ?? undefined}
                  onClick={() => setClosedGroups((c) => ({ ...c, [id]: !c[id] }))}
                  onDragOver={(e) => { if (target && dragKey.current) { e.preventDefault(); setOver(id); } }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => onDrop(e, g)}
                >
                  <ChevronDown size={16} aria-hidden style={{ transform: isClosed ? "rotate(-90deg)" : undefined }} />
                  <span className={styles.dot} style={{ background: group === "due" ? GROUP_COLOR[g.key] : (g.items[0]?.project.color ?? FALLBACK_PROJECT_COLOR) }} />
                  <span className={styles.ghName} style={{ color: g.key === "late" ? "var(--danger-text)" : undefined }}>{g.label}</span>
                  <Badge>{g.count}</Badge>
                  <span className={styles.ghSub}>{sub}</span>
                </button>
                {!isClosed && g.items.map((i) => (
                  <TaskRow key={i.key} item={i} ws={ws} year={year} busy={busy === i.key} onToggle={(done) => setDone(i, done)} onMove={() => setDueFor({ item: i, date: i.planEnd ?? data.today })} onDragStart={() => { dragKey.current = i.key; }} />
                ))}
                {!isClosed && g.items.length === 0 && <div className={styles.empty}>{t("groupEmpty")}</div>}
              </div>
            );
          })}
        </section>
        <aside style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <section className={styles.card} aria-label={t("summaryTitle")}>
            <div className={styles.chead}><h2>{t("summaryTitle")}</h2></div>
            <div className={styles.twoCol}>
              <div><span className={`muted ${styles.small}`}>{t("summary.late")}</span><b style={{ color: "var(--danger-text)" }}>{count("late")}</b></div>
              <div><span className={`muted ${styles.small}`}>{t("summary.today")}</span><b style={{ color: "var(--warning-text)" }}>{count("today")}</b></div>
              <div><span className={`muted ${styles.small}`}>{t("summary.week")}</span><b>{count("this_week") + count("today")}</b></div>
              <div><span className={`muted ${styles.small}`}>{t("summary.done")}</span><b style={{ color: "var(--success-text)" }}>{count("done_today")}</b></div>
            </div>
          </section>
          {byProject.length > 0 && (
            <section className={styles.card}>
              <div className={styles.chead}><h2>{t("byProject")}</h2></div>
              <div className={styles.mod}>
                {byProject.map((p) => (
                  <div key={p.key}>
                    <div className={styles.modLine}>
                      <span style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}><span className={styles.dot} style={{ background: p.color }} />{p.name}</span>
                      <span>{t("byProjectLine", { count: p.n, md: p.md.toFixed(1) })}</span>
                    </div>
                    <div className={styles.bar} style={{ height: 6 }}><div style={{ width: `${Math.round((p.n / maxProject) * 100)}%`, background: p.color }} /></div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className={styles.card}>
            <div className={styles.chead}><h2>{t("weekTitle")}</h2><span style={{ fontSize: 12, fontWeight: 600 }}>{t("weekTotal", { md: wk.reduce((a, b) => a + b, 0).toFixed(1) })}</span></div>
            <div className={styles.chart} style={{ height: 90, gap: 10 }} role="img" aria-label={t("weekChart", { days: wk.map((v, i) => `${dayNames[i]} ${v.toFixed(1)}`).join(" ") })}>
              <span className={styles.cap} style={{ bottom: Math.round((1 / maxWk) * 70) }} />
              {wk.map((v, i) => <div className={styles.chartCol} key={i}><i style={{ height: Math.max(3, Math.round((v / maxWk) * 70)), background: v > 1 ? "var(--warning-solid)" : "var(--chart-primary-soft)", maxWidth: 32 }} /></div>)}
            </div>
            <div className={styles.chartLabels} style={{ gap: 10, paddingBottom: 14 }}>{dayNames.map((d) => <span key={d}>{d}</span>)}</div>
          </section>
          <div className={`muted ${styles.small}`} style={{ padding: "0 4px" }}>{t("hint")}</div>
        </aside>
      </div>
      {dueFor && <DueDialog ws={ws} item={dueFor.item} initial={dueFor.date} onClose={() => setDueFor(null)} onDone={async () => { setDueFor(null); await refresh(); }} />}
    </>
  );
}

const MOBILE_FILTERS = { focus: ["late", "today"], week: ["late", "today", "this_week"], all: ["late", "today", "this_week", "next_week", "later", "none"] } as const;

/** M2 · มือถือ: หัว My Tasks + ค้นหา/ตัวกรอง, ชิปช่วงเวลา, รายการกะทัดรัดตามกลุ่ม Due, ปุ่มสร้างลอย */
function MobileTasks({ data, ws, name, year, tab, setTab, busy, onToggle }: {
  data: MyIssues; ws: string; name: string; year: YearFormat; tab: Tab; setTab: (tab: Tab) => void;
  busy: string | null; onToggle: (item: TaskItem, done: boolean) => void;
}) {
  const t = useTranslations("home-my-tasks.tasks");
  const { openSearch, projects } = useWorkspace();
  const dueText = useDueText();
  const [range, setRange] = useState<keyof typeof MOBILE_FILTERS>("focus");
  const [showTabs, setShowTabs] = useState(false);
  const count = (keys: readonly string[]) => data.groups.filter((g) => keys.includes(g.key)).reduce((n, g) => n + g.items.filter((i) => i.status.category !== "done").length, 0);
  const groups = data.groups.filter((g) => (MOBILE_FILTERS[range] as readonly string[]).includes(g.key) && g.items.length);
  const first = projects[0];
  return (
    <div className={styles.mTasks}>
      <header className={styles.mHeadCol}>
        <div className={styles.mHeadRow}>
          <h1 className={styles.mTitle} style={{ fontSize: 22, flex: 1 }}>{t("title")} <span className={styles.mOwner}>· {name}</span></h1>
          <button type="button" className={styles.mIcon} aria-label={t("search")} onClick={() => openSearch?.()}><Search size={22} aria-hidden="true" /></button>
          <button type="button" className={styles.mIcon} aria-label={t("filter")} aria-expanded={showTabs} onClick={() => setShowTabs((v) => !v)}><Filter size={22} aria-hidden="true" /></button>
        </div>
        {showTabs && (
          <div className={styles.mChips} role="group" aria-label={t("title")}>
            {TABS.map((k) => <button key={k} type="button" className={styles.chip} aria-pressed={tab === k} onClick={() => setTab(k)}>{t(`tabs.${k}`)} {data.counts[k]}</button>)}
          </div>
        )}
        <div className={styles.mChips} role="group" aria-label={t("rangeLabel")}>
          {(Object.keys(MOBILE_FILTERS) as (keyof typeof MOBILE_FILTERS)[]).map((k) => <button key={k} type="button" className={styles.chip} aria-pressed={range === k} onClick={() => setRange(k)}>{t(`mobileRange.${k}`)} · {count(MOBILE_FILTERS[k])}</button>)}
        </div>
      </header>
      {groups.length === 0 && <EmptyState title={t("empty")} description={t("emptyHint")} />}
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.label}>
          <div className={styles.mGroup}><span style={{ background: GROUP_COLOR[g.key] ?? "var(--chart-neutral)" }} /><b style={{ color: g.key === "late" ? "var(--danger-text)" : undefined }}>{g.label}</b><span className="muted">{g.items.length}</span></div>
          {g.items.map((i) => {
            const done = i.status.category === "done";
            const due = dueText(i, year);
            return (
              <div key={i.key} className={styles.mItem}>
                <input type="checkbox" checked={done} disabled={busy === i.key} aria-label={t(done ? "markUndone" : "markDone", { title: i.title })} onChange={(e) => onToggle(i, e.target.checked)} />
                <Link href={taskHref(ws, i.project.key, i.key)} className={styles.mItemMain}>
                  <span className={styles.mItemTitle} style={done ? { textDecoration: "line-through", color: "var(--muted)" } : undefined}>{i.title}</span>
                  <span className={styles.mItemMeta}><span className={styles.mType} aria-hidden="true" />{i.key} · <span className={styles.mProjDot} style={{ background: i.project.color ?? FALLBACK_PROJECT_COLOR }} />{i.project.name}</span>
                </Link>
                <span className={`${styles.mDue} ${due.cls}`}>{due.text}</span>
              </div>
            );
          })}
        </div>
      ))}
      <p className={styles.mHint}>{t("mobileHint")}</p>
      {first && <Link className={styles.fab} href={`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(first.key)}?new=1`} aria-label={t("newTask")}><Plus size={26} aria-hidden="true" /></Link>}
    </div>
  );
}

function TaskRow({ item, ws, year, busy, onToggle, onMove, onDragStart }: { item: TaskItem; ws: string; year: YearFormat; busy: boolean; onToggle: (done: boolean) => void; onMove: () => void; onDragStart: () => void }) {
  const t = useTranslations("home-my-tasks.tasks");
  const tp = useTranslations("common.priority");
  const dueText = useDueText();
  const done = item.status.category === "done";
  const due = dueText(item, year);
  const start = useRef<number | null>(null);
  // มือถือ: ปัดซ้าย = เลื่อน Due · ปัดขวา = ปิดงาน (ปุ่มที่แถวทำแบบเดียวกันสำหรับคีย์บอร์ด / screen reader)
  const touchStart = (e: TouchEvent) => { start.current = e.touches[0].clientX; };
  const touchEnd = (e: TouchEvent) => {
    if (start.current === null) return;
    const dx = e.changedTouches[0].clientX - start.current;
    start.current = null;
    if (dx < -80 && !done) onMove();
    else if (dx > 80 && !done) onToggle(true);
  };
  return (
    <div className={styles.tr} draggable={!done} onDragStart={onDragStart} onTouchStart={touchStart} onTouchEnd={touchEnd} data-testid={`task-${item.key}`}>
      <input type="checkbox" checked={done} disabled={busy} aria-label={t(done ? "markUndone" : "markDone", { title: item.title })} onChange={(e) => onToggle(e.target.checked)} style={{ width: 18, height: 18, margin: 0 }} />
      <div style={{ minWidth: 0 }}>
        <Link className={`${styles.rowTitle} ${done ? styles.strike : ""}`} href={taskHref(ws, item.project.key, item.key)}>{item.title}</Link>
        <div className={styles.rowMeta}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: item.project.color ?? FALLBACK_PROJECT_COLOR }} />
          <span>{item.key}</span><span>·</span><span>{item.project.name}</span>
          {item.parentKey && <Badge>{t("subtask")}</Badge>}
        </div>
      </div>
      <span className="hideMobile"><StatusBadge category={item.status.category} name={item.status.name} /></span>
      <span className={`hideMobile ${styles["pr-" + item.priority]}`} style={{ fontSize: 12, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 }}><Flag size={13} aria-hidden="true" />{tp(item.priority)}</span>
      <span className={`${styles.dt} ${due.cls}`}>{due.text}</span>
      <span className="muted hideMobile" style={{ fontSize: 11, textAlign: "right" }}>{item.estimateMd ? t("estimate", { md: item.estimateMd }) : t("noEstimate")}</span>
      <Button size="icon" variant="ghost" aria-label={t("moveDueFor", { key: item.key })} disabled={done || busy} onClick={onMove}><CalendarClock size={16} aria-hidden /></Button>
    </div>
  );
}

/** เปลี่ยน Due ตรง (`PATCH planEnd`) · 403 `due_change_requires_approval` → สลับเป็นฟอร์มขอเลื่อน Due (K3) */
function DueDialog({ ws, item, initial, onClose, onDone }: { ws: string; item: TaskItem; initial: string; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("home-my-tasks.tasks.dueDialog");
  const tt = useTranslations("home-my-tasks.tasks");
  const toast = useToast();
  const [date, setDate] = useState(initial);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("scope_added");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const base = `/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(item.key)}`;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      if (needsApproval) {
        await api.post(`${base}/due-requests`, { requestedDue: date, reasonCode: reason, detail: detail || undefined });
        toast({ message: t("requested", { key: item.key }) });
      } else {
        await api.patch(base, { planEnd: date }, item.version);
        toast({ message: tt("dueChanged", { key: item.key, date: formatDate(date) }) });
      }
      onDone();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "due_change_requires_approval") setNeedsApproval(true);
      else setError(failure);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog open title={needsApproval ? t("requestTitle") : t("title")} description={t("description", { key: item.key, title: item.title })} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <form className={styles.stack} onSubmit={submit}>
        {needsApproval && <p className="muted" role="status">{t("needsApproval")}</p>}
        <Input label={t("newDue")} type="date" required value={date} onChange={(e) => setDate(e.target.value)} disabled={pending} />
        {needsApproval && (
          <>
            <Select label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
              {REASONS.map((c) => <option key={c} value={c}>{t(`reasons.${c}`)}</option>)}
            </Select>
            <label className="field">{t("detail")}<textarea className="input" required={reason === "other"} value={detail} maxLength={2000} onChange={(e) => setDetail(e.target.value)} /></label>
          </>
        )}
        {!!error && <ErrorState error={error} />}
        <div className={styles.dialogActions}>
          <Button onClick={onClose} disabled={pending}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending}>{needsApproval ? t("send") : t("save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
