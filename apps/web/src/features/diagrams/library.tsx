"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { DEFAULT_FILTERS, groupIssues, Highlight, useIssueFilters, useIssueSearch, type SearchFilters } from "./link-dialog";
import { SHAPE_GROUPS, ShapeIcon, type GroupKey, type PaletteItem } from "./shapes";
import type { IssueOption } from "./types";
import styles from "./diagrams.module.css";

export const SHAPE_DRAG = "application/x-friday-shape";
export const ISSUE_DRAG = "application/x-friday-issue";

/** คลังด้านซ้าย: แท็บ "รูปทรง" (ลาก / คลิกเพื่อวาง) และแท็บ "งาน" (ลากงานมาวางเป็นกล่อง หรือวางทับกล่องเพื่อผูก) */
export function Library({ base, onAdd, inDiagram }: { base: string; onAdd: (item: PaletteItem) => void; inDiagram: Set<string> }) {
  const t = useTranslations("diagrams");
  const [tab, setTab] = useState<"shapes" | "tasks">("shapes");
  return (
    <div className={styles.library}>
      <div className={styles.libTabs} role="tablist" aria-label={t("palette.title")}>
        <button type="button" role="tab" aria-selected={tab === "shapes"} className={cn(tab === "shapes" && styles.libTabOn)} onClick={() => setTab("shapes")}>{t("palette.shapes")}</button>
        <button type="button" role="tab" aria-selected={tab === "tasks"} className={cn(tab === "tasks" && styles.libTabOn)} onClick={() => setTab("tasks")}>{t("palette.tasks")}</button>
      </div>
      {tab === "shapes" ? <ShapesTab onAdd={onAdd} /> : <TasksTab base={base} inDiagram={inDiagram} />}
    </div>
  );
}

function ShapesTab({ onAdd }: { onAdd: (item: PaletteItem) => void }) {
  const t = useTranslations("diagrams");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<GroupKey>>(() => new Set(["uml", "er"]));
  const name = (item: PaletteItem) => (item.type === "note" && item.preset?.color ? t("shapes.noteColor", { color: t(`colors.${item.preset.color}`) }) : t(`shapes.${item.type}`));
  const term = q.trim().toLowerCase();
  return (
    <div className={styles.libBody}>
      <input className={styles.paletteSearch} placeholder={t("palette.search")} aria-label={t("palette.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      <p className={styles.paletteHint}>{t("palette.hint")}</p>
      {SHAPE_GROUPS.map((g) => {
        const items = g.items.filter((it) => !term || name(it).toLowerCase().includes(term) || it.type.includes(term));
        if (!items.length) return null;
        const isOpen = !!term || !closed.has(g.key);
        return (
          <div key={g.key} className={styles.paletteGroup}>
            <button
              type="button"
              className={styles.paletteTitle}
              aria-expanded={isOpen}
              onClick={() => setClosed((cur) => {
                const next = new Set(cur);
                if (next.has(g.key)) next.delete(g.key);
                else next.add(g.key);
                return next;
              })}
            >
              {isOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              {t(`groups.${g.key}`)}
              <span>{items.length}</span>
            </button>
            {isOpen && (
              <div className={styles.paletteItems}>
                {items.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    draggable
                    className={styles.paletteItem}
                    title={t("palette.add", { shape: name(it) })}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SHAPE_DRAG, JSON.stringify(it));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => onAdd(it)}
                  >
                    <ShapeIcon item={it} />
                    <span>{name(it)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TasksTab({ base, inDiagram }: { base: string; inDiagram: Set<string> }) {
  const t = useTranslations("diagrams");
  const tStatus = useTranslations("common.status");
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const search = useIssueSearch(base, filters, true);
  const options = useIssueFilters(base, true);
  const items = useMemo(() => search.data?.pages.flatMap((p) => p.items) ?? [], [search.data]);
  const groups = groupIssues(items, t("link.noModule"));
  const statusText = (o: IssueOption) => (o.tone === "overdue" ? tStatus("overdue") : o.status);
  return (
    <div className={styles.libBody}>
      <input className={styles.paletteSearch} placeholder={t("link.searchShort")} aria-label={t("link.search")} value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
      <div className={styles.libFilters}>
        <select className={styles.miniSelect} aria-label="Module" value={filters.module[0] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, module: e.target.value ? [e.target.value] : [], phase: [] }))}>
          <option value="">{t("link.allModules")}</option>
          {options.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select
          className={styles.miniSelect}
          aria-label={t("link.status")}
          value={filters.status.length === 6 ? "all" : filters.status.includes("done") ? "done" : "open"}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value === "all" ? ["todo", "in_progress", "review", "blocked", "done", "cancelled"] : e.target.value === "done" ? ["done"] : DEFAULT_FILTERS.status }))}
        >
          <option value="open">{t("link.open")}</option>
          <option value="done">{tStatus("done")}</option>
          <option value="all">{t("link.allStatus")}</option>
        </select>
      </div>
      <p className={styles.paletteHint}>{t("palette.taskHint")}</p>
      <div className={styles.libTasks}>
        {!search.isLoading && !items.length && <div className={styles.optionEmpty}>{t("link.empty")}</div>}
        {groups.map((g) => (
          <div key={g.key} className={styles.paletteGroup}>
            <div className={styles.libTaskGroup}>{g.title} <span>{g.items.length}</span></div>
            {g.items.map((o) => (
              <div
                key={o.id}
                draggable
                role="button"
                tabIndex={0}
                className={cn(styles.libTask, o.level !== "task" && o.parentKey && styles.libTaskSub)}
                title={`${o.key} ${o.title} · ${statusText(o)}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(ISSUE_DRAG, JSON.stringify(o));
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <i className={cn(styles.dot, styles[`dot_${o.tone}`])} aria-hidden="true" />
                <b>{o.key}</b>
                <span className={styles.libTaskTitle}><Highlight text={o.title} q={filters.q} /></span>
                {inDiagram.has(o.id) && <span className={styles.inDiagram}>{t("palette.inDiagram")}</span>}
              </div>
            ))}
          </div>
        ))}
        {search.hasNextPage && <Button size="small" onClick={() => void search.fetchNextPage()} disabled={search.isFetchingNextPage}>{t("link.loadMore")}</Button>}
      </div>
    </div>
  );
}
