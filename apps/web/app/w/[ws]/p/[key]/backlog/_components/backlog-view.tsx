"use client";

import { type DragEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bookmark, Bug, CheckSquare, ChevronDown, MoreHorizontal, Zap } from "lucide-react";
import { AvatarStack, Button, Dialog, EmptyState, ErrorState, FloatingNotice, Forbidden, Input, LoadingState, Select, useDismissToasts, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDateRange, today as todayIso, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import { BurndownChart } from "./burndown-chart";
import { listOf, placement, remainingWorkingDays, round, type BacklogData, type BacklogIssue, type CompleteResult, type Container, type MemberItem, type ModuleItem, type MoveBody, type MoveIntent, type MoveResult, type Sprint } from "./types";
import styles from "./backlog.module.css";

type Notice = { message: string; undo?: () => Promise<void> };
type TypeFilter = "all" | "Task" | "Bug";
interface ViewProps { ws: string; projectKey: string }

const TYPE_ICON: Record<string, { icon: typeof Bug; color: string }> = {
  Story: { icon: Bookmark, color: "#15803D" },
  Task: { icon: CheckSquare, color: "#1D4ED8" },
  Bug: { icon: Bug, color: "#DC2626" },
  Spike: { icon: Zap, color: "#7C3AED" },
};
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function BacklogView(props: ViewProps) {
  // แยก state ต่อ Workspace/Project เพื่อไม่ให้ notice หรือ dialog ค้างข้ามโปรเจกต์
  return <ScopedBacklog key={`${props.ws}/${props.projectKey}`} {...props} />;
}

function ScopedBacklog({ ws, projectKey }: ViewProps) {
  const t = useTranslations("backlog");
  const { me } = useWorkspace();
  const yearFormat: YearFormat = me.yearFormat;
  const search = useSearchParams();
  const pathname = usePathname();
  const cache = useQueryClient();
  const endpoint = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const backlogKey = ["backlog", ws, projectKey];
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [moduleId, setModuleId] = useState("");
  const [moving, setMoving] = useState(false);
  const moveLock = useRef(false);
  const dragKey = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ container: Container; before?: string } | null>(null);
  // แจ้งผลเป็น toast มุมขวาบน: ซ้อนกันได้ อันใหม่อยู่บน หายเอง (ผู้ใช้ขอ 2026-11-08)
  const toast = useToast();
  const dismissToasts = useDismissToasts();
  const noticeGroup = `backlog:${ws}:${projectKey}`;
  const setNotice = (next: Notice | null) => { if (next) toast({ ...next, group: noticeGroup }); }; // null = ไม่ต้องทำอะไร: ผลการย้ายหลายครั้งซ้อนกันได้
  // เปลี่ยนโปรเจกต์ / ออกจากหน้า: Undo ของบอร์ดเดิมไม่ค้าง
  useEffect(() => () => dismissToasts(noticeGroup), [dismissToasts, noticeGroup]);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [picker, setPicker] = useState<BacklogIssue | null>(null);
  const [showActive, setShowActive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState<Sprint | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const permissions = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`) });
  const allowed = !!permissions.data && !permissions.data.guestViewer;
  const backlog = useQuery({ queryKey: backlogKey, queryFn: () => api.get<BacklogData>(`${endpoint}/backlog`), enabled: allowed });
  // ชื่อ Module และคนไม่อยู่ใน issueDto ของ A06 · โหลดแยกและไม่บล็อกหน้าเมื่อโหลดไม่ได้
  const modules = useQuery({ queryKey: ["backlog-meta", ws, projectKey, "modules"], queryFn: () => api.get<{ items: ModuleItem[] }>(`${endpoint}/modules`), enabled: allowed });
  const members = useQuery({ queryKey: ["backlog-meta", ws, projectKey, "members"], queryFn: () => api.get<{ items: MemberItem[] }>(`${endpoint}/members`), enabled: allowed });

  const perms = permissions.data?.permissions ?? [];
  const canMove = perms.includes("issue.edit");
  const canManage = perms.includes("sprint.manage");
  const canCreate = perms.includes("issue.create");
  const data = backlog.data;

  const href = (key?: string) => {
    const next = new URLSearchParams(search);
    next.delete("issue"); next.delete("new");
    if (key) next.set("issue", key); else next.set("new", "1");
    return `${pathname}?${next}`;
  };
  const containerName = (container: Container) => container === null ? t("backlog") : (data?.sprints.find((sprint) => sprint.id === container)?.name ?? "");

  function clearDrag() { dragKey.current = null; setDragging(null); setDropTarget(null); }
  async function send(key: string, body: MoveBody, version: number) {
    return api.request<MoveResult>(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(key)}/move`, { method: "POST", body, etag: version });
  }
  async function performMove(intent: MoveIntent, undoAction = false) {
    if (!canMove || moveLock.current) return;
    moveLock.current = true; setMoving(true); setMoveError(null); setNotice(null); setPicker(null);
    try {
      const result = await send(intent.issue.key, intent.body, intent.issue.version);
      const message = undoAction ? t("undone", { key: intent.issue.key })
        : intent.body.sprintId === intent.issue.sprintId ? t("reordered", { key: intent.issue.key })
          : t("moved", { key: intent.issue.key, target: containerName(intent.body.sprintId) });
      const undo = undoAction ? undefined : () => performMove({ issue: { ...intent.issue, sprintId: intent.body.sprintId, version: result.version }, body: intent.undo, undo: intent.body }, true);
      setNotice({ message: [message, ...result.warnings.map((warning) => warning.message)].join(" · "), undo });
      await cache.invalidateQueries({ queryKey: backlogKey });
    } catch (error) {
      setMoveError(error);
      if (error instanceof ApiError && error.status === 409) await cache.invalidateQueries({ queryKey: backlogKey });
    } finally { moveLock.current = false; setMoving(false); clearDrag(); }
  }
  function move(key: string, target: Container, anchor?: { before?: string; after?: string }) {
    if (!data || !canMove || moveLock.current) return;
    const intent = placement(data, key, target, anchor);
    if (intent) void performMove(intent);
  }
  function dragOver(event: DragEvent, container: Container, before?: string) {
    if (!dragKey.current || !canMove || moveLock.current) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    setDropTarget({ container, before });
  }
  function drop(event: DragEvent, container: Container, before?: string) {
    if (!dragKey.current || !canMove || moveLock.current) return;
    event.preventDefault(); event.stopPropagation();
    move(dragKey.current, container, before ? { before } : undefined); clearDrag();
  }

  const error = permissions.error ?? backlog.error;
  if ((error instanceof ApiError && error.status === 403) || permissions.data?.guestViewer) return <Forbidden />;
  if (error) return <ErrorState error={error} retry={() => { void permissions.refetch(); void backlog.refetch(); }} />;
  if (!data || !permissions.data) return <LoadingState />;

  const moduleMap = new Map((modules.data?.items ?? []).map((item) => [item.id, item]));
  const people = new Map<string, Person>();
  for (const member of members.data?.items ?? []) people.set(member.userId, { id: member.userId, displayName: member.displayName, initials: member.initials, avatarUrl: member.avatarUrl });
  for (const sprint of data.sprints) for (const row of sprint.capacity.people) if (row.person && !people.has(row.person.id)) people.set(row.person.id, row.person);
  const active = data.sprints.find((sprint) => sprint.status === "active");
  const planning = data.sprints.filter((sprint) => sprint.status === "planning");
  // ปุ่มย้ายหลักจาก Backlog ไป Sprint ที่กำลังวางแผนลำดับแรก (Canvas: "↑ Sprint 4") ถ้าไม่มีใช้ Sprint ที่กำลังทำ
  const nextSprint = planning[0] ?? active;
  const visible = (issue: BacklogIssue) => (typeFilter === "all" || issue.type === typeFilter) && (!moduleId || issue.moduleId === moduleId);
  const hasFilters = typeFilter !== "all" || !!moduleId;
  const empty = !data.sprints.length && !data.backlog.issues.length;

  function renderRow(issue: BacklogIssue, container: Container) {
    const type = TYPE_ICON[issue.type] ?? TYPE_ICON.Task;
    const TypeIcon = type.icon;
    const module = issue.moduleId ? moduleMap.get(issue.moduleId) : undefined;
    const assignees = issue.assigneeIds.map((id) => people.get(id)).filter((person): person is Person => !!person);
    const primary: Container | undefined = container === null ? nextSprint?.id : null;
    return <div key={issue.key} role="listitem" aria-label={t("row", { key: issue.key })} data-key={issue.key}
      className={`${styles.item} ${dragging === issue.key ? styles.dragging : ""} ${dropTarget?.before === issue.key ? styles.dropBefore : ""} ${issue.status.category === "done" ? styles.done : ""}`}
      draggable={canMove && !moving}
      onDragStart={(event) => { if (!canMove || moving) { event.preventDefault(); return; } dragKey.current = issue.key; setDragging(issue.key); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", issue.key); }}
      onDragEnd={clearDrag}
      onDragOver={(event) => dragOver(event, container, issue.key)}
      onDrop={(event) => drop(event, container, issue.key)}>
      <span className={styles.handle} aria-hidden="true">⋮⋮</span>
      <span className={styles.typeIcon} style={{ background: type.color }} role="img" aria-label={issue.type}><TypeIcon size={12} aria-hidden="true" /></span>
      <Link className={styles.key} href={href(issue.key)} draggable={false}>{issue.key}</Link>
      <span className={styles.title}>
        <Link href={href(issue.key)} draggable={false}>{issue.title}</Link>
        {!!issue.subtasks?.length && <span className={styles.subtasks}>{t("subtaskCount", { count: issue.subtasks.length })}</span>}
      </span>
      <span className={styles.hideSmall}>{module && <span className={styles.module} style={{ color: module.color ?? "#1D4ED8", background: `${module.color ?? "#1D4ED8"}1A` }}>{module.name}</span>}</span>
      <span className={`${styles.md} ${issue.estimateMd === null ? styles.noEstimate : ""}`} title={issue.estimateMd === null ? t("unestimated") : t("manDay")}>{issue.estimateMd ?? "?"}</span>
      <span className={styles.hideSmall}>{assignees.length > 0 && <AvatarStack people={assignees} max={1} />}</span>
      <span className={styles.actions}>
        {canMove && primary !== undefined && <Button size="small" className={`${styles.moveButton} ${styles.hideSmall}`} disabled={moving} onClick={() => move(issue.key, primary)}>
          {primary === null ? t("toBacklog") : t("toSprint", { name: containerName(primary) })}
        </Button>}
        {canMove && <Button size="small" variant="ghost" aria-haspopup="dialog" aria-label={t("moveOptions", { key: issue.key })} disabled={moving} onClick={() => setPicker(issue)}><MoreHorizontal size={16} aria-hidden="true" /></Button>}
      </span>
    </div>;
  }

  function renderList(container: Container, issues: BacklogIssue[], emptyText: string) {
    const rows = issues.filter(visible);
    return <div role="list" aria-label={t("list", { name: containerName(container) })}
      className={`${styles.zone} ${dragging && dropTarget?.container === container ? styles.zoneOver : ""}`}
      onDragOver={(event) => dragOver(event, container)} onDrop={(event) => drop(event, container)}>
      {rows.map((issue) => renderRow(issue, container))}
      {!rows.length && <p className={styles.zoneEmpty}>{issues.length ? t("filteredEmpty") : emptyText}</p>}
    </div>;
  }

  function sprintDates(sprint: Sprint) {
    return formatDateRange(sprint.startDate, sprint.endDate, yearFormat);
  }

  const pickerList = picker ? (["backlog", ...data.sprints.map((sprint) => sprint.id)] as const) : [];
  const pickerSource = picker?.sprintId ?? null;
  const pickerRows = picker ? listOf(data, pickerSource).filter(visible) : [];
  const pickerIndex = picker ? pickerRows.findIndex((row) => row.key === picker.key) : -1;

  return <section className={styles.page} aria-label={t("title")} aria-busy={moving}>
    <div className={styles.toolbar}>
      <div className={styles.filters}>
        <div role="group" aria-label={t("typeFilter")} className={styles.filters}>
          {(["all", "Task", "Bug"] as const).map((value) => <Button key={value} className={`${styles.chip} ${typeFilter === value ? styles.selected : ""}`} aria-pressed={typeFilter === value} onClick={() => setTypeFilter(value)}>{value === "all" ? t("allTypes") : value}</Button>)}
        </div>
        <Select size="small" aria-label={t("module")} value={moduleId} onChange={(event) => setModuleId(event.target.value)}>
          <option value="">{t("allModules")}</option>
          {(modules.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        {hasFilters && <Button variant="ghost" onClick={() => { setTypeFilter("all"); setModuleId(""); }}>{t("reset")}</Button>}
      </div>
      <div className={styles.filters}>
        {canManage && <Button onClick={() => setCreating(true)}>{t("createSprint")}</Button>}
        {canCreate && <Link className="button button-primary" href={href()}>{t("createIssue")}</Link>}
      </div>
    </div>

    {!empty && <p className={styles.intro}>{t("intro")}</p>}
    {!!moveError && <FloatingNotice tone="error"><strong>{t("moveFailed")}</strong><span>{moveError instanceof ApiError && moveError.status === 409 ? t("conflict") : errorText(moveError, t("moveFailed"))}</span>{moveError instanceof ApiError && moveError.requestId && <code>{t("requestId", { id: moveError.requestId })}</code>}<Button size="small" onClick={() => { setMoveError(null); void backlog.refetch(); }}>{t("loadLatest")}</Button></FloatingNotice>}

    {empty && <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} action={canManage ? <Button variant="primary" onClick={() => setCreating(true)}>{t("createSprint")}</Button> : canCreate ? <Link className="button button-primary" href={href()}>{t("createIssue")}</Link> : undefined} />}

    {active && <section className={styles.card} aria-label={t("sprintRegion", { name: active.name, status: t("statusValues__active") })}>
      <header className={styles.head}>
        <span className={`${styles.status} ${styles.statusActive}`}>{t("statusValues__active")}</span>
        <h2>{active.name}</h2>
        <span className={styles.muted}>{sprintDates(active)}{remainingWorkingDays(active.burndown) !== null && ` · ${t("daysLeft", { count: remainingWorkingDays(active.burndown)! })}`}</span>
        <span className={styles.spacer} />
        <Link className="button" href={`/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/board`}>{t("openBoard")}</Link>
        {canManage && <Button variant="primary" className={styles.complete} onClick={() => setCompleting(active)}>{t("completeSprint")}</Button>}
      </header>
      <div className={styles.activeBody}>
        <div className={styles.activeInfo}>
          <div><span className={styles.label}>{t("goal")}</span><p className={styles.goal}>{active.goal || t("noGoal")}</p></div>
          <dl className={styles.stats}>
            <div><dt>{t("statIssues")}</dt><dd>{active.stats.doneCount} / {active.stats.issueCount}</dd></div>
            <div><dt>{t("statMd")}</dt><dd>{active.stats.doneMd} / {active.stats.totalMd}</dd></div>
            <div><dt>{t("statBugs")}</dt><dd>{active.issues.flatMap((issue) => [issue, ...(issue.subtasks ?? [])]).filter((issue) => issue.type === "Bug" && issue.status.category !== "done").length}</dd></div>
          </dl>
        </div>
        {active.burndown && <BurndownChart burndown={active.burndown} yearFormat={yearFormat} />}
      </div>
      <div className={styles.toggleRow}><Button size="small" variant="ghost" aria-expanded={showActive} onClick={() => setShowActive(!showActive)}>{showActive ? t("hideIssues") : t("showIssues", { count: active.issues.length })}</Button></div>
      {showActive && renderList(active.id, active.issues, t("sprintEmpty"))}
    </section>}

    {/* กางเฉพาะ Sprint ถัดไปตาม Canvas L1 · Sprint หลังจากนั้นพับเป็นแถวเดียว Backlog จึงอยู่ใกล้ให้ลากได้ */}
    {(() => {
      const card = (sprint: Sprint, index: number) => {
        const open = opened[sprint.id] ?? index === 0;
        return <PlanningSprint key={sprint.id} sprint={sprint} canManage={canManage} hasActive={!!active} isNext={index === 0} open={open} dates={sprintDates(sprint)}
          dropOver={dragging !== null && dropTarget?.container === sprint.id}
          onToggle={() => setOpened((old) => ({ ...old, [sprint.id]: !open }))}
          onDragOver={(event) => dragOver(event, sprint.id)} onDrop={(event) => drop(event, sprint.id)}
          onStart={() => setStarting(sprint)} saveGoal={async (goal) => { await api.request(`${endpoint}/sprints/${sprint.id}`, { method: "PATCH", body: { goal: goal || null } }); await cache.invalidateQueries({ queryKey: backlogKey }); }}>
          {renderList(sprint.id, sprint.issues, t("sprintEmpty"))}
        </PlanningSprint>;
      };
      // Sprint หลังจากนั้นเรียงต่อกันเป็นรายการเดียว (ไม่เว้นช่องทีละการ์ด)
      return <>{planning[0] && card(planning[0], 0)}{planning.length > 1 && <div className={styles.later}>{planning.slice(1).map((sprint, i) => card(sprint, i + 1))}</div>}</>;
    })()}

    {!empty && <section className={styles.card} aria-label={t("backlog")}>
      <header className={styles.head}>
        <h2>{t("backlog")}</h2>
        <span className={styles.muted}>{t("backlogSummary", { count: data.backlog.issues.length, md: data.backlog.stats.totalMd, unestimated: data.backlog.stats.unestimatedCount })}</span>
        <span className={styles.spacer} />
        <span className={`${styles.muted} ${styles.hideSmall}`}>{t("backlogHint")}</span>
      </header>
      {renderList(null, data.backlog.issues, t("backlogEmpty"))}
      {canCreate && <div className={styles.addRow}><Link href={href()}>{t("addIssue")}</Link></div>}
    </section>}

    <p className={styles.hint}>{t("pageHint")}</p>

    <Dialog open={!!picker} onOpenChange={(open) => { if (!open) setPicker(null); }} title={t("moveTitle", { key: picker?.key ?? "" })} description={picker?.title}>
      {picker && <div className={styles.options}>
        <div className={styles.optionRow}>
          <Button disabled={moving || pickerIndex <= 0} onClick={() => move(picker.key, pickerSource, { before: pickerRows[pickerIndex - 1]?.key })}>{t("moveUp")}</Button>
          <Button disabled={moving || pickerIndex < 0 || pickerIndex >= pickerRows.length - 1} onClick={() => move(picker.key, pickerSource, { after: pickerRows[pickerIndex + 1]?.key })}>{t("moveDown")}</Button>
        </div>
        <span className={styles.label}>{t("moveToLabel")}</span>
        {pickerList.map((id) => {
          const container = id === "backlog" ? null : id;
          const current = container === pickerSource;
          return <Button key={id} disabled={moving || current} onClick={() => move(picker.key, container)}>{containerName(container)}{current && <span className="muted">{t("current")}</span>}</Button>;
        })}
      </div>}
    </Dialog>
    {creating && <CreateSprintDialog endpoint={endpoint} data={data} onClose={() => setCreating(false)} onCreated={async (name) => { setCreating(false); setNotice({ message: t("created", { name }) }); await cache.invalidateQueries({ queryKey: backlogKey }); }} />}
    {starting && <StartSprintDialog endpoint={endpoint} sprint={starting} onClose={() => setStarting(null)} onStarted={async () => { const name = starting.name; setStarting(null); setNotice({ message: t("started", { name }) }); await cache.invalidateQueries({ queryKey: backlogKey }); }} />}
    {completing && <CompleteSprintDialog endpoint={endpoint} sprint={completing} planning={planning} onClose={() => setCompleting(null)} onCompleted={async (result) => {
      setCompleting(null);
      const target = result.moved.destination === null ? t("backlog") : (planning.find((sprint) => sprint.id === result.moved.destination)?.name ?? "");
      setNotice({ message: result.moved.tasks ? t("completed", { name: result.name, tasks: result.moved.tasks, subtasks: result.moved.subtasks, target }) : t("completedClean", { name: result.name }) });
      await cache.invalidateQueries({ queryKey: backlogKey });
    }} />}
  </section>;
}

function PlanningSprint({ sprint, canManage, hasActive, isNext, open, dropOver, dates, onToggle, onDragOver, onDrop, onStart, saveGoal, children }: {
  sprint: Sprint; canManage: boolean; hasActive: boolean; isNext: boolean; open: boolean; dropOver: boolean; dates: string;
  onToggle: () => void; onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void;
  onStart: () => void; saveGoal: (goal: string) => Promise<void>; children: ReactNode;
}) {
  const t = useTranslations("backlog");
  const [goal, setGoal] = useState(sprint.goal ?? "");
  const [goalError, setGoalError] = useState("");
  const capacity = sprint.capacity;
  const committed = capacity.committedMd;
  const ratio = capacity.capacityMd > 0 ? committed / capacity.capacityMd : committed > 0 ? 1 : 0;
  const over = round(committed - capacity.capacityMd);
  async function commitGoal() {
    if (goal.trim() === (sprint.goal ?? "")) return;
    setGoalError("");
    try { await saveGoal(goal.trim()); } catch (error) { setGoalError(errorText(error, t("saveFailed"))); }
  }
  // Sprint ที่พับไว้ยังรับงานที่ลากมาวางได้ทั้งการ์ด
  return <section className={`${styles.card}${!open && dropOver ? ` ${styles.cardOver}` : ""}`} aria-label={t("sprintRegion", { name: sprint.name, status: t("statusValues__planning") })}
    onDragOver={open ? undefined : onDragOver} onDrop={open ? undefined : onDrop}>
    <header className={`${styles.head}${open ? "" : ` ${styles.headCollapsed}`}`}>
      <button type="button" className={styles.toggle} aria-expanded={open} aria-label={t(open ? "collapseSprint" : "expandSprint", { name: sprint.name })} onClick={onToggle}>
        <ChevronDown size={16} aria-hidden="true" style={{ transform: open ? undefined : "rotate(-90deg)" }} />
      </button>
      <span className={`${styles.status} ${styles.statusPlanning}`}>{t("statusValues__planning")}</span>
      <h2>{sprint.name}</h2>
      <span className={styles.muted}>{dates} · {t("issueCount", { count: sprint.issues.length })}</span>
      <span className={styles.spacer} />
      {!open && <span className={capacity.overloaded ? styles.overText : styles.muted}>{t("capacityValue", { committed, capacity: capacity.capacityMd })}</span>}
      {/* เริ่มได้เฉพาะ Sprint ถัดไป ไม่ให้มีปุ่มเริ่มซ้ำทุก Sprint */}
      {canManage && isNext && <Button className={styles.startBtn} disabled={hasActive} title={hasActive ? t("activeExists") : undefined} onClick={onStart}>{t("startSprint")}</Button>}
    </header>
    {open && <>
    <div className={styles.planBody}>
      {canManage
        ? <div className={styles.goalField}><Input label={t("goal")} value={goal} maxLength={10000} placeholder={t("goalPlaceholder")} onChange={(event) => setGoal(event.target.value)} onBlur={() => void commitGoal()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} error={goalError || undefined} /></div>
        : <div><span className={styles.label}>{t("goal")}</span><p className={styles.goal}>{sprint.goal || t("noGoal")}</p></div>}
      <div className={styles.capacity}>
        <div className={styles.capacityHead}><span>{t("capacityTitle")}</span><strong className={capacity.overloaded ? styles.overText : undefined}>{t("capacityValue", { committed, capacity: capacity.capacityMd })}</strong></div>
        <div className={styles.capBar} role="meter" aria-label={t("capacityTitle")} aria-valuemin={0} aria-valuemax={capacity.capacityMd} aria-valuenow={committed} aria-valuetext={t("capacityValue", { committed, capacity: capacity.capacityMd })}>
          <div className={capacity.overloaded ? styles.capOver : ratio >= 0.8 ? styles.capGood : styles.capFill} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
        </div>
        <p className={`${styles.capNote} ${capacity.overloaded ? styles.overText : ""}`}>
          {capacity.overloaded ? t("capacityOver", { over }) : t("capacityNote", { capacity: capacity.capacityMd, people: capacity.people.length, days: capacity.workingDays })}
          {capacity.unassignedMd > 0 && ` · ${t("unassignedMd", { md: capacity.unassignedMd })}`}
          {sprint.stats.unestimatedCount > 0 && ` · ${t("unestimatedCount", { count: sprint.stats.unestimatedCount })}`}
        </p>
      </div>
    </div>
    {!!capacity.people.length && <ul className={styles.people} aria-label={t("peopleCapacity")}>
      {capacity.people.map((row, index) => <li key={row.person?.id ?? index} className={row.overloaded ? styles.overText : undefined} title={row.person?.displayName}>
        <span className={styles.initials}>{row.person?.initials ?? "?"}</span>
        <b>{row.committedMd}</b><span className={styles.muted}>/ {row.capacityMd} MD</span>
        {row.leaveDays > 0 && <span className={styles.muted}>{t("leave", { days: row.leaveDays })}</span>}
      </li>)}
    </ul>}
    {children}
    </>}
  </section>;
}

function DialogError({ error }: { error: unknown }) {
  const t = useTranslations("backlog");
  if (!error) return null;
  return <div className={styles.dialogError} role="alert"><span>{errorText(error, t("saveFailed"))}</span>{error instanceof ApiError && error.requestId && <code>{t("requestId", { id: error.requestId })}</code>}</div>;
}

function CreateSprintDialog({ endpoint, data, onClose, onCreated }: { endpoint: string; data: BacklogData; onClose: () => void; onCreated: (name: string) => Promise<void> }) {
  const t = useTranslations("backlog");
  const last = data.sprints.at(-1);
  const nextNumber = Math.max(0, ...data.sprints.map((sprint) => sprint.number)) + 1;
  // เริ่มวันถัดจาก Sprint ล่าสุด ยาว 2 สัปดาห์ตามธรรมเนียมทั่วไป ผู้ใช้แก้ได้
  const start = last && last.endDate >= data.asOf ? addDays(last.endDate, 1) : data.asOf || todayIso();
  const [name, setName] = useState(`Sprint ${nextNumber}`);
  const [startDate, setStartDate] = useState(start);
  const [endDate, setEndDate] = useState(addDays(start, 13));
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const invalidRange = !!startDate && !!endDate && endDate < startDate;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !startDate || !endDate || invalidRange) return;
    setPending(true); setError(null);
    try {
      await api.post(`${endpoint}/sprints`, { name: name.trim(), startDate, endDate, goal: goal.trim() || null });
      await onCreated(name.trim());
    } catch (failure) { setError(failure); } finally { setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={t("createTitle")}>
    <form className={styles.form} onSubmit={submit}>
      <Input label={t("sprintName")} value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} />
      <div className={styles.dateRow}>
        <Input label={t("startDate")} type="date" value={startDate} required onChange={(event) => setStartDate(event.target.value)} />
        <Input label={t("endDate")} type="date" value={endDate} required min={startDate} onChange={(event) => setEndDate(event.target.value)} error={invalidRange ? t("invalidRange") : undefined} />
      </div>
      <Input label={t("goal")} value={goal} maxLength={10000} placeholder={t("goalPlaceholder")} onChange={(event) => setGoal(event.target.value)} />
      <DialogError error={error} />
      <div className="dialog-actions"><Button disabled={pending} onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary" disabled={pending || !name.trim() || invalidRange}>{t("create")}</Button></div>
    </form>
  </Dialog>;
}

function StartSprintDialog({ endpoint, sprint, onClose, onStarted }: { endpoint: string; sprint: Sprint; onClose: () => void; onStarted: () => Promise<void> }) {
  const t = useTranslations("backlog");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function start() {
    setPending(true); setError(null);
    try { await api.post(`${endpoint}/sprints/${sprint.id}/start`); await onStarted(); } catch (failure) { setError(failure); } finally { setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={t("startTitle", { name: sprint.name })} description={t("startDescription", { count: sprint.issues.length, committed: sprint.capacity.committedMd, capacity: sprint.capacity.capacityMd })}>
    {sprint.capacity.overloaded && <p className={styles.warning} role="note">{t("startOverloaded", { over: round(sprint.capacity.committedMd - sprint.capacity.capacityMd) })}</p>}
    {sprint.stats.unestimatedCount > 0 && <p className={styles.warning} role="note">{t("unestimatedCount", { count: sprint.stats.unestimatedCount })}</p>}
    <DialogError error={error} />
    <div className="dialog-actions"><Button disabled={pending} onClick={onClose}>{t("cancel")}</Button><Button variant="primary" disabled={pending} onClick={() => void start()}>{t("startSprint")}</Button></div>
  </Dialog>;
}

function CompleteSprintDialog({ endpoint, sprint, planning, onClose, onCompleted }: { endpoint: string; sprint: Sprint; planning: Sprint[]; onClose: () => void; onCompleted: (result: CompleteResult) => Promise<void> }) {
  const t = useTranslations("backlog");
  const [destination, setDestination] = useState<string>(planning[0]?.id ?? "backlog");
  const [retrospective, setRetrospective] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // API ย้ายเฉพาะงานแม่ที่ยังไม่ Done (ลูกตามแม่) · งานแม่ที่ Done อยู่ Sprint เดิม
  const unfinished = sprint.issues.filter((issue) => issue.status.category !== "done");
  const shown = unfinished.slice(0, 10).map((issue) => issue.key);
  async function complete() {
    setPending(true); setError(null);
    try {
      const result = await api.post<CompleteResult>(`${endpoint}/sprints/${sprint.id}/complete`, { moveIncompleteTo: destination, retrospective: retrospective.trim() || null });
      await onCompleted({ ...result, name: result.name ?? sprint.name });
    } catch (failure) { setError(failure); } finally { setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }} title={t("completeTitle", { name: sprint.name })}>
    <dl className={styles.stats}>
      <div><dt>{t("doneLabel")}</dt><dd>{t("countMd", { count: sprint.stats.doneCount, md: sprint.stats.doneMd })}</dd></div>
      <div><dt>{t("notDoneLabel")}</dt><dd>{t("countMd", { count: sprint.stats.issueCount - sprint.stats.doneCount, md: sprint.stats.remainingMd })}</dd></div>
    </dl>
    {unfinished.length > 0 ? <fieldset className={styles.destination}>
      <legend>{t("moveUnfinished", { count: unfinished.length })}</legend>
      {planning.map((item, index) => <label key={item.id}><input type="radio" name="destination" value={item.id} checked={destination === item.id} onChange={() => setDestination(item.id)} />{index === 0 ? t("recommended", { name: item.name }) : item.name}</label>)}
      <label><input type="radio" name="destination" value="backlog" checked={destination === "backlog"} onChange={() => setDestination("backlog")} />{t("backToBacklog")}</label>
      <p className={styles.muted}>{shown.join(" · ")}{unfinished.length > shown.length && ` · ${t("more", { count: unfinished.length - shown.length })}`}</p>
    </fieldset> : <p className={styles.muted}>{t("allDone")}</p>}
    <label className={styles.retro}><span>{t("retrospective")}</span><textarea className="input" value={retrospective} maxLength={20000} placeholder={t("retroPlaceholder")} onChange={(event) => setRetrospective(event.target.value)} /></label>
    <DialogError error={error} />
    <div className="dialog-actions"><Button disabled={pending} onClick={onClose}>{t("cancel")}</Button><Button variant="primary" disabled={pending} onClick={() => void complete()}>{unfinished.length ? t("completeAndMove") : t("completeSprint")}</Button></div>
  </Dialog>;
}
