"use client";

import { useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, SlidersHorizontal, Bug, CheckSquare, ChevronLeft, ChevronRight, Flag, ListChecks, MessageCircle, Plus, Zap } from "lucide-react";
import { AvatarStack, Badge, Button, Dialog, EmptyState, ErrorState, FloatingNotice, Forbidden, LoadingState, Select } from "@/components/ui";
import { api, ApiError, isConfirmCancelled } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { moveLocal, positionIntent, type BoardCard, type BoardColumn, type BoardData, type MoveBody, type MoveIntent, type MoveResult, type Swimlane } from "./types";
import styles from "./kanban.module.css";

type Notice = { message: string; undo?: () => Promise<void> };

interface BoardProps { ws: string; projectKey: string; yearFormat?: YearFormat }

type DropTarget = { lane: string; column: string; before?: string };

/**
 * FLIP: หลังทุก render การ์ด ([data-flip]) ที่ตำแหน่งเปลี่ยนจะเลื่อนจากที่เดิมไปที่ใหม่แทนการกระโดด
 * ตำแหน่งวัดเทียบกับแถวคอลัมน์ ([data-flip-root]) รวมระยะเลื่อนแนวนอน การเลื่อนหน้าจอจึงไม่ทำให้การ์ดขยับเอง
 */
function useFlip(root: RefObject<HTMLElement | null>) {
  const last = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const board = root.current;
    if (!board) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, { x: number; y: number }>();
    board.querySelectorAll<HTMLElement>("[data-flip]").forEach((node) => {
      const scope = node.closest<HTMLElement>("[data-flip-root]");
      if (!scope || !node.offsetParent) return; // การ์ดที่ซ่อนระหว่างลาก
      const box = node.getBoundingClientRect();
      const base = scope.getBoundingClientRect();
      const pos = { x: box.left - base.left + scope.scrollLeft, y: box.top - base.top };
      const id = node.dataset.flip!;
      next.set(id, pos);
      const prev = last.current.get(id);
      if (reduce || !prev || typeof node.animate !== "function") return;
      const dx = prev.x - pos.x;
      const dy = prev.y - pos.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
    });
    last.current = next;
  });
}

export function KanbanBoard(props: BoardProps) {
  return <ScopedBoard key={`${props.ws}/${props.projectKey}`} {...props} />;
}

function ScopedBoard({ ws, projectKey, yearFormat = "BE" }: BoardProps) {
  const t = useTranslations("kanban");
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const cache = useQueryClient();
  const isBug = search.get("type") === "bug";
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [level, setLevel] = useState("all");
  const [moduleId, setModuleId] = useState("");
  const [mine, setMine] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [older, setOlder] = useState(false);
  const [swimlane, setSwimlane] = useState<Swimlane>("none");
  const [mobileColumn, setMobileColumn] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const moveLock = useRef(false);
  const dragKey = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [slotHeight, setSlotHeight] = useState(0);
  const [landed, setLanded] = useState<string | null>(null);
  const landedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dropped = useRef(false);
  const boardRef = useRef<HTMLElement>(null);
  useFlip(boardRef);
  const [picker, setPicker] = useState<BoardCard | null>(null);
  const [confirmation, setConfirmation] = useState<{ intent: MoveIntent; count: number; undoAction: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const endpoint = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const boardKey = ["kanban", ws, projectKey];
  const permissions = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`) });
  const params = new URLSearchParams({ level, showOlderDone: String(older) });
  if (isBug) params.set("type", "bug");
  if (mine) params.set("assignee", "me");
  if (overdue) params.set("overdue", "true");
  // Module กรองฝั่งหน้าเว็บ เพื่อให้ chips ยังคงแสดงจำนวนและ Module อื่นได้
  const boardQueryKey = [...boardKey, params.toString()];
  const board = useQuery({
    queryKey: boardQueryKey,
    queryFn: () => api.get<BoardData>(`${endpoint}/board?${params}`),
    enabled: !!permissions.data && !permissions.data.guestViewer,
  });
  const canEdit = permissions.data?.permissions.includes("issue.edit") ?? false;
  const canCreate = permissions.data?.permissions.includes("issue.create") ?? false;
  const data = board.data;
  const activeColumn = data?.columns.some((column) => column.id === mobileColumn) ? mobileColumn : data?.columns[0]?.id;
  const hasFilters = moduleId || mine || overdue || level !== "all";
  const href = (key?: string, statusId?: string, targetModuleId?: string | null) => {
    const next = new URLSearchParams(search);
    next.delete("issue"); next.delete("new");
    next.delete("statusId"); next.delete("moduleId"); next.delete("phaseId");
    if (key) next.set("issue", key);
    else {
      next.set("new", "1"); next.set("type", isBug ? "bug" : "task");
      if (statusId) next.set("statusId", statusId);
      if (targetModuleId || moduleId) next.set("moduleId", targetModuleId || moduleId);
    }
    return `${pathname}?${next}`;
  };
  function switchBoard(value: string) {
    const next = new URLSearchParams(search);
    if (value === "bug") next.set("type", "bug"); else next.delete("type");
    setModuleId(""); setMobileColumn(null); setPicker(null); setConfirmation(null); setNotice(null); setMoveError(null);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }
  function clearDrag() { dragKey.current = null; setDragging(null); setDropTarget(null); }
  async function send(key: string, body: MoveBody, version: number) {
    return api.request<MoveResult>(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(key)}/move`, { method: "POST", body, etag: version });
  }
  async function undoMove(intent: MoveIntent, version: number) {
    await performMove({ card: { ...intent.card, version }, body: intent.undo, targetName: intent.card.status.name, undo: intent.body }, false, true);
  }
  async function performMove(intent: MoveIntent, confirm = false, undoAction = false) {
    if (!canEdit || moveLock.current) return;
    moveLock.current = true; setMoving(true); setMoveError(null); setNotice(null); setPicker(null);
    // ย้ายบนจอทันทีไม่ต้องรอ API (ทำก่อน await แรก จึงทันก่อนช่องว่างที่ลากหายไป) · ล้มเหลวคืนตำแหน่งเดิม
    const snapshot = cache.getQueryData<BoardData>(boardQueryKey);
    const local = snapshot ? moveLocal(snapshot, intent.card.key, intent.body) : null;
    if (local) {
      cache.setQueryData(boardQueryKey, local);
      clearTimeout(landedTimer.current);
      setLanded(intent.card.key);
      landedTimer.current = setTimeout(() => setLanded(null), 700);
    }
    try {
      const result = await send(intent.card.key, { ...intent.body, ...(confirm ? { confirm: true } : {}) }, intent.card.version);
      setConfirmation(null);
      const message = undoAction ? t("undone", { key: intent.card.key }) : intent.body.statusId === intent.card.status.id
        ? t("reordered", { key: intent.card.key }) : t("moved", { key: intent.card.key, column: intent.targetName });
      setNotice({ message: [message, ...result.warnings.map((w) => w.message)].join(" · "), undo: undoAction ? undefined : () => undoMove(intent, result.version) });
      await cache.invalidateQueries({ queryKey: boardKey });
    } catch (error) {
      if (snapshot && local) cache.setQueryData(boardQueryKey, snapshot);
      // กดยกเลิกในกล่องยืนยันกลาง (เช่น Acceptance criteria ยังไม่ครบ): คืนการ์ดเงียบ ๆ ไม่แสดงข้อผิดพลาด
      if (isConfirmCancelled(error)) return;
      if (error instanceof ApiError && error.code === "subtasks_incomplete" && error.details.confirmable === true) {
        setConfirmation({ intent, count: Number(error.details.open ?? 0), undoAction });
      } else {
        setConfirmation(null); setMoveError(error);
        if (error instanceof ApiError && error.status === 409) await cache.invalidateQueries({ queryKey: boardKey });
      }
    } finally { moveLock.current = false; setMoving(false); clearDrag(); }
  }
  function move(key: string, columnId: string, beforeKey?: string) {
    if (!data || !canEdit || moveLock.current) return;
    const intent = positionIntent(data, key, columnId, beforeKey);
    if (intent) void performMove(intent);
  }
  /**
   * ตำแหน่งวางจากตำแหน่งเมาส์: บนการ์ดดูครึ่งบน/ล่าง · ช่องว่างระหว่างการ์ดหรือตัวช่องว่างเองใช้จุดกึ่งกลางการ์ด
   * จึงไม่กระโดดไปท้ายคอลัมน์ตอนเมาส์ผ่านช่องห่างระหว่างการ์ด
   */
  function beforeFrom(event: DragEvent): string | undefined {
    const cards = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-card]")).filter((el) => el.dataset.card !== dragKey.current);
    const over = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    const y = Number.isFinite(event.clientY) ? event.clientY : 0;
    if (over && over.dataset.card !== dragKey.current) {
      const box = over.getBoundingClientRect();
      if (y <= box.top + box.height / 2) return over.dataset.card;
      return cards[cards.indexOf(over) + 1]?.dataset.card;
    }
    return cards.find((el) => { const box = el.getBoundingClientRect(); return box.top + box.height / 2 > y; })?.dataset.card;
  }
  function dragOver(event: DragEvent, lane: string, columnId: string) {
    if (!dragKey.current || !canEdit || moveLock.current) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    const before = beforeFrom(event);
    setDropTarget((current) => current && current.lane === lane && current.column === columnId && current.before === before ? current : { lane, column: columnId, before });
  }
  function drop(event: DragEvent, columnId: string) {
    if (!dragKey.current || !canEdit || moveLock.current) return;
    event.preventDefault(); event.stopPropagation();
    dropped.current = true;
    move(dragKey.current, columnId, beforeFrom(event));
    // คงช่องว่างไว้จนข้อมูลที่ย้ายแล้ว render ก่อน (react-query แจ้งใน tick ถัดไป) การ์ดจึงไม่กระพริบกลับที่เดิม
    setTimeout(() => { dropped.current = false; clearDrag(); }, 0);
  }
  const error = permissions.error ?? board.error;
  if ((error instanceof ApiError && error.status === 403) || permissions.data?.guestViewer) return <Forbidden />;
  if (error) return <ErrorState error={error} retry={() => { void permissions.refetch(); void board.refetch(); }} />;
  if (!data || !permissions.data) return <LoadingState />;

  const cards = data.columns.flatMap((column) => column.cards);
  // เรียงตามชื่อ ชิป Module จึงไม่สลับที่เมื่อการ์ดย้ายคอลัมน์
  const modules = Array.from(new Map(cards.filter((card) => card.module).map((card) => [card.module!.id, card.module!])).values()).sort((a, b) => a.name.localeCompare(b.name, "th"));
  const filtered = cards.filter((card) => !moduleId || card.module?.id === moduleId);
  const priorityOrder = ["urgent", "high", "medium", "low"] as const;
  const groups: { id: string; name: string }[] = swimlane === "module"
    ? [...modules.map((m) => ({ id: m.id, name: m.name })), ...(filtered.some((card) => !card.module) ? [{ id: "none", name: t("noModule") }] : [])]
    : swimlane === "assignee"
      ? [...Array.from(new Map(filtered.flatMap((card) => card.assignees).map((person) => [person.id, person])).values()).map((person) => ({ id: person.id, name: person.displayName })), ...(filtered.some((card) => !card.assignees.length) ? [{ id: "none", name: t("unassigned") }] : [])]
      : swimlane === "priority" ? priorityOrder.map((priority) => ({ id: priority, name: t(`priorityValues.${priority}`) })) : [{ id: "all", name: "" }];
  function inGroup(card: BoardCard, id: string) {
    return swimlane === "none" || (swimlane === "module" ? (card.module?.id ?? "none") === id : swimlane === "priority" ? card.priority === id : id === "none" ? !card.assignees.length : card.assignees.some((person) => person.id === id));
  }
  const dueText = (card: BoardCard) => card.status.category === "done" ? t("completed")
    : card.due?.state === "overdue" ? t("dueOverdue", { days: card.due.days })
      : card.due?.state === "today" ? t("dueToday")
        : card.due?.state === "soon" ? t("dueSoon", { days: card.due.days })
          : card.planEnd ? formatDate(card.planEnd, yearFormat) : t("noDue");

  function renderCard(card: BoardCard, column: BoardColumn, columnIndex: number, laneCards: BoardCard[], lane: string) {
    const visibleIndex = laneCards.findIndex((item) => item.key === card.key);
    const TypeIcon = card.type.name === "Bug" ? Bug : card.type.name === "Spike" ? Zap : CheckSquare;
    return <article key={card.key} aria-label={t("card", { key: card.key })} data-card={card.key} data-flip={`${lane}:${card.key}`}
      className={`${styles.card} ${card.status.category === "done" ? styles.completed : ""} ${dragging === card.key ? styles.lifted : ""} ${landed === card.key && !dragging ? styles.landed : ""}`}
      draggable={canEdit && !moving}
      onDragStart={(event) => {
        if (!canEdit || moving) { event.preventDefault(); return; }
        dragKey.current = card.key; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", card.key);
        const height = event.currentTarget.getBoundingClientRect().height;
        // ซ่อนการ์ดเดิมหลัง browser ถ่ายภาพการ์ดที่ลากแล้ว (ซ่อนใน dragstart เลยจะยกเลิกการลาก) · ช่องว่างขึ้นแทนที่เดิมพอดี
        setTimeout(() => {
          if (dragKey.current !== card.key) return;
          setSlotHeight(height); setDragging(card.key);
          setDropTarget((current) => current ?? { lane, column: column.id, before: laneCards[visibleIndex + 1]?.key });
        }, 0);
      }}
      onDragEnd={() => { if (!dropped.current) clearDrag(); }}>
      {/* Canvas Kanban: แถวบน = ไอคอนประเภท, Key, Module, ธง Priority · มือถือ M7 ชื่องานขึ้นก่อน */}
      <div className={styles.cardTop}>
        <span className={styles.typeIcon} style={{ background: card.type.color }} title={card.parentKey ? t("typeValues.subtask") : t.has(`typeValues.${card.type.name}`) ? t(`typeValues.${card.type.name}`) : card.type.name}><TypeIcon size={12} aria-hidden="true" /></span>
        <span className={styles.key}>{card.key}</span>
        {card.module && <span className={styles.module} style={{ background: `${card.module.color ?? "#1d4ed8"}1a`, color: card.module.color ?? "#1d4ed8" }}>{card.module.name}</span>}
        {card.type.name === "Bug" && <Badge tone="red">{card.status.name}</Badge>}
        <span className={`${styles.priority} ${styles[card.priority]}`} role="img" aria-label={t(`priorityValues.${card.priority}`)} title={t(`priorityValues.${card.priority}`)}><Flag size={14} aria-hidden="true" /></span>
      </div>
      {card.parentKey && <Link className={styles.parent} href={href(card.parentKey)}>↳ {card.parentKey}</Link>}
      <Link className={styles.cardTitle} href={href(card.key)} draggable={false}>{card.title}</Link>
      <div className={styles.cardMeta}>
        <span className={`${styles.due} ${card.due?.state === "overdue" ? styles.late : card.due?.state === "today" ? styles.today : ""}`} title={card.planEnd ? t("dueDate", { date: formatDate(card.planEnd, yearFormat, true) }) : undefined}>{dueText(card)}</span>
        {card.subtasks && <span className={styles.meta} title={t("subtaskProgress", card.subtasks)}><ListChecks size={14} aria-hidden="true" />{card.subtasks.done}/{card.subtasks.total}</span>}
        {card.comments > 0 && <span className={styles.meta} title={t("comments", { count: card.comments })}><MessageCircle size={14} aria-hidden="true" />{card.comments}</span>}
        <span className={styles.avatars}><AvatarStack people={card.assignees} /></span>
        {canEdit && <Button size="small" className={styles.mobileMove} aria-haspopup="dialog" onClick={() => setPicker(card)} disabled={moving}>{t("moveTo")}</Button>}
      </div>
      {canEdit && <div className={styles.moveActions}>
        <Button size="small" aria-label={t("left", { key: card.key })} disabled={moving || columnIndex === 0} onClick={() => move(card.key, data!.columns[columnIndex - 1].id)}><ChevronLeft size={16} aria-hidden="true" /></Button>
        <Button size="small" aria-label={t("right", { key: card.key })} disabled={moving || columnIndex === data!.columns.length - 1} onClick={() => move(card.key, data!.columns[columnIndex + 1].id)}><ChevronRight size={16} aria-hidden="true" /></Button>
        <Button size="small" className={styles.reorder} aria-label={t("up", { key: card.key })} disabled={moving || visibleIndex === 0} onClick={() => move(card.key, column.id, laneCards[visibleIndex - 1].key)}><ArrowUp size={14} aria-hidden="true" /></Button>
        <Button size="small" className={styles.reorder} aria-label={t("down", { key: card.key })} disabled={moving || visibleIndex === laneCards.length - 1} onClick={() => move(card.key, column.id, laneCards[visibleIndex + 2]?.key)}><ArrowDown size={14} aria-hidden="true" /></Button>
        <span className={styles.dragHint}>{t("dragHint")}</span>
      </div>}
    </article>;
  }

  return <section ref={boardRef} className={styles.board} aria-label={t("title")} aria-busy={moving}>
    {/* Canvas Kanban: แถวแรก = ชิป Module + งานของฉัน / Overdue · แถวสอง = แสดง, Swimlane, Reset */}
    <div className={`${styles.moduleFilters} ${filtersOpen ? styles.expanded : ""}`} role="group" aria-label={t("modules")}>
      <Button className={`${styles.chip} ${!moduleId ? styles.selected : ""}`} aria-pressed={!moduleId} onClick={() => setModuleId("")}>{t("allModules")} <span>{cards.length}</span></Button>
      {modules.map((module) => <Button key={module.id} className={`${styles.chip} ${moduleId === module.id ? styles.selected : ""}`} aria-pressed={moduleId === module.id} onClick={() => setModuleId(module.id)}><span className={styles.dot} style={{ background: module.color ?? "#1d4ed8" }} />{module.name} <span>{cards.filter((card) => card.module?.id === module.id).length}</span></Button>)}
      <span className={styles.sep} aria-hidden="true" />
      <Button className={`${styles.chip} ${styles.secondaryFilter} ${mine ? styles.selected : ""}`} aria-pressed={mine} onClick={() => setMine(!mine)}>{t("mine")}</Button>
      <Button className={`${styles.chip} ${styles.secondaryFilter} ${overdue ? styles.selected : ""}`} aria-pressed={overdue} onClick={() => setOverdue(!overdue)}>{t("overdue")}</Button>
    </div>
    <div className={`${styles.toolbar} ${filtersOpen ? styles.filtersOpen : ""}`}>
      <div className={styles.filters}>
        <Select size="small" aria-label={t("boardType")} value={isBug ? "bug" : "standard"} onChange={(event) => switchBoard(event.target.value)} disabled={moving}><option value="standard">{t("standard")}</option><option value="bug">{t("bug")}</option></Select>
      </div>
      <div className={`${styles.filters} ${styles.advancedFilters}`}>
        <Select size="small" prefix={t("level")} aria-label={t("level")} value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">{t("allLevels")}</option><option value="task">{t("tasks")}</option><option value="subtask">{t("subtasks")}</option></Select>
        <Select size="small" prefix={t("swimlane")} aria-label={t("swimlane")} value={swimlane} onChange={(event) => setSwimlane(event.target.value as Swimlane)}><option value="none">{t("none")}</option><option value="module">{t("module")}</option><option value="assignee">{t("assignee")}</option><option value="priority">{t("priority")}</option></Select>
        {hasFilters && <Button variant="ghost" onClick={() => { setModuleId(""); setMine(false); setOverdue(false); setLevel("all"); }}>{t("reset")}</Button>}
      </div>
    </div>
    {notice && <FloatingNotice><span>{notice.message}</span>{notice.undo && <Button size="small" disabled={moving} onClick={() => void notice.undo?.()}>{t("undo")}</Button>}<Button size="small" variant="ghost" aria-label={t("close")} onClick={() => setNotice(null)}>×</Button></FloatingNotice>}
    {!!moveError && <FloatingNotice tone="error"><strong>{t("moveFailed")}</strong><span>{moveError instanceof ApiError && moveError.status === 409 ? t("conflict") : moveError instanceof Error ? moveError.message : t("moveFailed")}</span>{moveError instanceof ApiError && moveError.requestId && <code>{t("requestId", { id: moveError.requestId })}</code>}<Button size="small" onClick={() => { setMoveError(null); void board.refetch(); }}>{t("loadLatest")}</Button></FloatingNotice>}
    <div className={styles.mobileColumns} role="group" aria-label={t("columns")}>
      {data.columns.map((column) => <Button key={column.id} className={`${styles.chip} ${column.id === activeColumn ? styles.selected : ""}`} aria-pressed={column.id === activeColumn} onClick={() => setMobileColumn(column.id)}><span className={`${styles.dot} ${styles[column.category]}`} />{column.name} <span>{column.cards.filter((card) => filtered.includes(card)).length}</span></Button>)}
      <Button className={styles.mobileFilterToggle} aria-expanded={filtersOpen} aria-label={t("filters")} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} aria-hidden="true" /></Button>
    </div>
    {!filtered.length && <EmptyState title={t(hasFilters ? "filteredEmpty" : "emptyTitle")} description={hasFilters ? undefined : t("emptyDescription")} action={hasFilters ? <Button onClick={() => { setModuleId(""); setMine(false); setOverdue(false); setLevel("all"); }}>{t("reset")}</Button> : canCreate ? <Link className="button button-primary" href={href()}>{t("new")}</Link> : undefined} />}
    {groups.filter((group) => swimlane === "none" || filtered.some((card) => inGroup(card, group.id))).map((group) => <section key={group.id} className={styles.lane} aria-label={group.name || undefined}>
      {group.name && <h2 className={styles.laneTitle}>{group.name}<span>{filtered.filter((card) => inGroup(card, group.id)).length}</span></h2>}
      <div className={styles.columns} data-flip-root>
        {data.columns.map((column, columnIndex) => { const laneCards = column.cards.filter((card) => filtered.includes(card) && inGroup(card, group.id)); const slot = !!dragging && dropTarget?.lane === group.id && dropTarget.column === column.id; const items = laneCards.map((card) => renderCard(card, column, columnIndex, laneCards, group.id));
          if (slot) { const at = dropTarget.before ? laneCards.findIndex((card) => card.key === dropTarget.before) : -1; items.splice(at < 0 ? items.length : at, 0, <div key="slot" className={styles.slot} style={{ height: slotHeight }} data-flip={`${group.id}:${dragging}`} aria-hidden="true" />); }
          return <section key={column.id} aria-label={t("column", { name: column.name })} data-mobile-active={column.id === activeColumn} className={`${styles.column} ${column.wip.exceeded ? styles.exceeded : ""} ${slot ? styles.dropColumn : ""}`}
          onDragOver={(event) => dragOver(event, group.id, column.id)} onDrop={(event) => drop(event, column.id)}>
          <header className={styles.columnHeader}><span className={`${styles.dot} ${styles[column.category]}`} /><h3>{column.name}</h3><span className={styles.count}>{column.cards.filter((card) => filtered.includes(card) && inGroup(card, group.id)).length}</span>{column.wip.limit !== null && <span className={`${styles.wip} ${column.wip.exceeded ? styles.wipOver : ""}`}>{t("wip", { current: column.wip.current, limit: column.wip.limit })}</span>}{canCreate && <Link className={styles.colAdd} href={href(undefined, column.id, swimlane === "module" ? group.id : undefined)} aria-label={t("addCardTo", { name: column.name })}><Plus size={16} aria-hidden="true" /></Link>}</header>
          {column.wip.exceeded && <p className={styles.mobileWip} role="status">{t("overWip", { current: column.wip.current, limit: column.wip.limit! })}</p>}
          <div className={styles.cardList}>{items}
            {!laneCards.length && !slot && <p className={styles.emptyColumn}>{t("emptyColumn")}</p>}
          </div>
          {column.category === "done" && (older || data.hiddenDone > 0) && <Button className={styles.older} variant="ghost" onClick={() => setOlder(!older)}>{older ? t("hideOlder") : t("showOlder", { count: data.hiddenDone })}</Button>}
          {canCreate && <Link className={styles.addCard} href={href(undefined, column.id, swimlane === "module" ? group.id : undefined)}>{t("addCard")}</Link>}
        </section>; })}
      </div>
    </section>)}
    <p className={styles.boardHint}>{t("boardHint")}</p><p className={styles.mobileHint}>{t("mobileHint")}</p>
    {!!data.bugStatusColumns.length && <p className={styles.boardHint}>{t("bugMapping", { mapping: data.bugStatusColumns.map((item) => `${item.status} → ${item.column}`).join(" · ") })}</p>}
    <Dialog open={!!picker} onOpenChange={(open) => { if (!open) setPicker(null); }} title={t("moveCard", { key: picker?.key ?? "" })} description={picker?.title}>
      <div className={styles.moveOptions}>{data.columns.map((column) => <Button key={column.id} disabled={moving || column.cards.some((card) => card.key === picker?.key)} onClick={() => { if (picker) move(picker.key, column.id); }}>{column.name}{column.cards.some((card) => card.key === picker?.key) && <span className="muted">{t("currentColumn")}</span>}</Button>)}</div>
    </Dialog>
    <Dialog open={!!confirmation} onOpenChange={(open) => { if (!open && !moving) setConfirmation(null); }} title={t("confirmTitle")} description={confirmation ? t("confirmDescription", { key: confirmation.intent.card.key, count: confirmation.count, column: confirmation.intent.targetName }) : undefined}>
      <div className={styles.dialogActions}><Button disabled={moving} onClick={() => setConfirmation(null)}>{t("cancel")}</Button><Button variant="primary" disabled={moving} onClick={() => { if (confirmation) void performMove(confirmation.intent, true, confirmation.undoAction); }}>{t("confirm")}</Button></div>
    </Dialog>
  </section>;
}
