"use client";

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { Avatar, Button, Dialog } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { chipOf, MAX_ISSUES_PER_NODE, type IssueChip, type IssueFilters, type IssueOption, type IssueSearch } from "./types";
import styles from "./diagrams.module.css";

export type StatusKey = "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
export interface SearchFilters {
  q: string;
  module: string[];
  phase: string[];
  status: StatusKey[];
  type: ("task" | "subtask" | "bug")[];
  assignee: string;
  sprint: string;
  overdue: boolean;
}
/** ค่าเริ่มต้น: งานที่ยังไม่เสร็จ · Task + Sub-task (Bug ติ๊กเพิ่มได้) */
export const DEFAULT_FILTERS: SearchFilters = { q: "", module: [], phase: [], status: ["todo", "in_progress", "review", "blocked"], type: ["task", "subtask"], assignee: "", sprint: "", overdue: false };

export function searchParams(f: SearchFilters, page: number) {
  const p = new URLSearchParams({ page: String(page) });
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.module.length) p.set("module", f.module.join(","));
  if (f.phase.length) p.set("phase", f.phase.join(","));
  if (f.status.length) p.set("status", f.status.join(","));
  if (f.type.length) p.set("type", f.type.join(","));
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.sprint) p.set("sprint", f.sprint);
  if (f.overdue) p.set("overdue", "true");
  return p;
}

/** ค้นงานแบบหน้าละ 50 ด้วยตัวกรองเดียวกับหน้า Table (ใช้ทั้งหน้าต่างผูกงานและแท็บ "งาน") */
export function useIssueSearch(base: string, filters: SearchFilters, enabled: boolean) {
  const [q, setQ] = useState(filters.q);
  useEffect(() => {
    const h = setTimeout(() => setQ(filters.q), 250);
    return () => clearTimeout(h);
  }, [filters.q]);
  const f = { ...filters, q };
  return useInfiniteQuery({
    queryKey: ["diagrams", "issue-search", base, f],
    queryFn: ({ pageParam }) => api.get<IssueSearch>(`${base}/diagram-issues?${searchParams(f, pageParam)}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled,
    staleTime: 15_000,
  });
}
export function useIssueFilters(base: string, enabled: boolean) {
  return useQuery({ queryKey: ["diagrams", "issue-filters", base], queryFn: () => api.get<IssueFilters>(`${base}/diagram-issue-filters`), enabled, staleTime: 60_000 });
}

/** ไฮไลต์คำค้นในชื่องาน */
export function Highlight({ text, q }: { text: string; q: string }) {
  const term = q.trim();
  if (!term) return <>{text}</>;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className={styles.hl}>{text.slice(i, i + term.length)}</mark>{text.slice(i + term.length)}</>;
}

/** จัดกลุ่ม Module › กลุ่ม ตามลำดับที่ API เรียงมาแล้ว */
export function groupIssues(items: IssueOption[], none: string) {
  const groups: { key: string; title: string; items: IssueOption[] }[] = [];
  for (const it of items) {
    const title = [it.module?.name ?? none, it.phase?.name].filter(Boolean).join(" › ");
    const key = `${it.module?.id ?? "-"}:${it.phase?.id ?? "-"}`;
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(it);
    else groups.push({ key, title, items: [it] });
  }
  return groups;
}

export function LinkDialog({
  open,
  onOpenChange,
  base,
  boxLabel,
  linked,
  issues,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  base: string;
  boxLabel: string;
  linked: string[];
  issues: Record<string, IssueChip>;
  onSave: (ids: string[], chips: IssueChip[]) => void;
}) {
  const t = useTranslations("diagrams.link");
  const tStatus = useTranslations("common.status");
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [picked, setPicked] = useState<string[]>(linked);
  const [found, setFound] = useState<Record<string, IssueChip>>({});
  useEffect(() => {
    if (open) {
      setPicked(linked);
      setFilters(DEFAULT_FILTERS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const search = useIssueSearch(base, filters, open);
  const options = useIssueFilters(base, open);
  const items = useMemo(() => search.data?.pages.flatMap((p) => p.items) ?? [], [search.data]);
  const total = search.data?.pages[0]?.total ?? 0;
  const groups = groupIssues(items, t("noModule"));
  const full = picked.length >= MAX_ISSUES_PER_NODE;
  const added = picked.filter((id) => !linked.includes(id)).length;
  const removed = linked.filter((id) => !picked.includes(id)).length;
  const toggleIn = <K extends "module" | "phase" | "status" | "type">(key: K, value: SearchFilters[K][number]) =>
    setFilters((f) => {
      const list = f[key] as string[];
      return { ...f, [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] };
    });
  const toggle = (o: IssueOption) => {
    setFound((cur) => ({ ...cur, [o.id]: chipOf(o) }));
    setPicked((cur) => (cur.includes(o.id) ? cur.filter((x) => x !== o.id) : cur.length >= MAX_ISSUES_PER_NODE ? cur : [...cur, o.id]));
  };
  const statusText = (o: { tone: string; status: string }) => (o.tone === "overdue" ? tStatus("overdue") : o.status);
  const phases = (options.data?.phases ?? []).filter((p) => !filters.module.length || filters.module.includes(p.moduleId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("title", { name: boxLabel || t("untitled") })} size="wide">
      <div className={styles.linkBody}>
        <aside className={styles.linkFilters} aria-label={t("filters")}>
          <FilterGroup title={t("shortcuts")}>
            <Check checked={filters.assignee === "me"} onChange={() => setFilters((f) => ({ ...f, assignee: f.assignee === "me" ? "" : "me" }))}>{t("mine")}</Check>
            <Check checked={filters.overdue} onChange={() => setFilters((f) => ({ ...f, overdue: !f.overdue }))}>{t("overdue")}</Check>
            <Check checked={filters.sprint === "current"} onChange={() => setFilters((f) => ({ ...f, sprint: f.sprint === "current" ? "" : "current" }))}>{t("currentSprint")}</Check>
          </FilterGroup>
          {!!options.data?.modules.length && (
            <FilterGroup title="Module">
              {options.data.modules.map((m) => <Check key={m.id} checked={filters.module.includes(m.id)} onChange={() => toggleIn("module", m.id)}>{m.name}</Check>)}
            </FilterGroup>
          )}
          {!!phases.length && (
            <FilterGroup title={t("group")}>
              {phases.slice(0, 30).map((p) => <Check key={p.id} checked={filters.phase.includes(p.id)} onChange={() => toggleIn("phase", p.id)}>{p.name}</Check>)}
            </FilterGroup>
          )}
          <FilterGroup title={t("status")}>
            {(["todo", "in_progress", "review", "blocked", "done", "cancelled"] as StatusKey[]).map((s) => <Check key={s} checked={filters.status.includes(s)} onChange={() => toggleIn("status", s)}>{tStatus(s)}</Check>)}
          </FilterGroup>
          <FilterGroup title={t("type")}>
            {(["task", "subtask", "bug"] as const).map((s) => <Check key={s} checked={filters.type.includes(s)} onChange={() => toggleIn("type", s)}>{t(`types.${s}`)}</Check>)}
          </FilterGroup>
        </aside>
        <div className={styles.linkMain}>
          <div className={styles.linkBar}>
            <label className={styles.searchBox}>
              <Search size={14} aria-hidden="true" />
              <input id="diagram-link-search" autoFocus placeholder={t("search")} aria-label={t("search")} value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
            </label>
            <select className={styles.miniSelect} aria-label={t("assignee")} value={filters.assignee === "me" ? "" : filters.assignee} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}>
              <option value="">{t("anyAssignee")}</option>
              {options.data?.people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
            <select className={styles.miniSelect} aria-label="Sprint" value={filters.sprint === "current" ? "" : filters.sprint} onChange={(e) => setFilters((f) => ({ ...f, sprint: e.target.value }))}>
              <option value="">{t("anySprint")}</option>
              {options.data?.sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span className={styles.linkCount} role="status">{search.isLoading ? t("searching") : t("found", { n: total })}</span>
          </div>
          <div className={styles.linkRows} role="listbox" aria-multiselectable="true" aria-label={t("results")}>
            {!search.isLoading && !items.length && <div className={styles.optionEmpty}>{t("empty")}</div>}
            {groups.map((g) => (
              <div key={g.key} role="group" aria-label={g.title}>
                <div className={styles.linkGroup}>{g.title} <span>· {g.items.length}</span></div>
                {g.items.map((o) => {
                  const on = picked.includes(o.id);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={!on && full}
                      className={cn(styles.linkRow, o.level !== "task" && o.parentKey && styles.linkSub, on && styles.linkRowOn)}
                      onClick={() => toggle(o)}
                    >
                      <span className={cn(styles.cb, on && styles.cbOn)} aria-hidden="true" />
                      <b>{o.key}</b>
                      <span className={styles.linkTitle}>
                        {o.level === "bug" && <span className={styles.bugMark}>Bug</span>}
                        <Highlight text={o.title} q={filters.q} />
                      </span>
                      <span className={cn(styles.chip, styles[`tone_${o.tone}`])}>{statusText(o)}</span>
                      <span className={styles.linkWho}>{o.assignee ? <><Avatar person={o.assignee} size="small" />{o.assignee.displayName}</> : <span className={styles.faint}>—</span>}</span>
                      <span className={cn(styles.linkDue, o.tone === "overdue" && styles.dueLate)}>{o.dueDate ? formatDate(o.dueDate) : ""}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {search.hasNextPage && (
              <div className={styles.loadMore}>
                <Button size="small" onClick={() => void search.fetchNextPage()} disabled={search.isFetchingNextPage}>{t("more", { shown: items.length, total })}</Button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={styles.linkFoot}>
        <span className={styles.faint}>
          {t("summary", { linked: linked.length, added, removed })}
          {full && <> · {t("max", { n: MAX_ISSUES_PER_NODE })}</>}
        </span>
        {picked.length > 0 && (
          <button type="button" className={styles.linkClear} onClick={() => setPicked([])}>
            <X size={12} aria-hidden="true" /> {t("clear")}
          </button>
        )}
        <span className={styles.spacer} />
        <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
        <Button
          variant="primary"
          onClick={() => {
            onSave(picked, picked.map((id) => found[id] ?? issues[id]).filter((c): c is IssueChip => !!c));
            onOpenChange(false);
          }}
        >
          {t("save", { n: picked.length })}
        </Button>
      </div>
    </Dialog>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className={styles.filterGroup}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}
function Check({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label className={styles.filterCheck}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}
