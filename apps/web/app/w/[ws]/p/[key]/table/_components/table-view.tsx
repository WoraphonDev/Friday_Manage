"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronDown, X } from "lucide-react";
import { AvatarStack, Avatar, Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import type { Options, Row, SavedView, TableData } from "./types";
import styles from "./ot.module.css";

const ROW_H = 44;
/** เกินจำนวนนี้จะ render เฉพาะแถวที่อยู่ในจอ (virtualized) */
export const VIRTUAL_AFTER = 300;
const PAGE = 500;
const MAX_PAGES = 4;
const FILTER_KEYS = ["q", "status", "assignee", "priority", "level", "overdue", "hideDone"] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

type Display =
  | { kind: "module"; id: string; name: string; color: string | null; count: number; md: number; pct: number }
  | { kind: "phase"; id: string; name: string; count: number }
  | { kind: "issue"; row: Row; sub: boolean };

/** แถวที่แสดง: Module › กลุ่มงาน › Task › Sub-task (Sub-task ตามแม่ทันที) */
export function buildDisplay(data: TableData, collapsed: Set<string>, noModule: string, noPhase: string): Display[] {
  const out: Display[] = [];
  const keys = new Set(data.items.map((r) => r.key));
  const kids = new Map<string, Row[]>();
  for (const r of data.items) if (r.parentKey && keys.has(r.parentKey)) kids.set(r.parentKey, [...(kids.get(r.parentKey) ?? []), r]);
  for (const m of data.modules) {
    const mid = m.id ?? "none";
    const inModule = data.items.filter((r) => (r.moduleId ?? null) === m.id && !(r.parentKey && keys.has(r.parentKey)));
    if (!inModule.length) continue;
    out.push({ kind: "module", id: mid, name: m.name ?? noModule, color: m.color, count: m.taskCount, md: m.estimateMd, pct: m.progressPct });
    if (collapsed.has(mid)) continue;
    for (const ph of m.phases) {
      const roots = inModule.filter((r) => (r.phaseId ?? null) === ph.id);
      if (!roots.length) continue;
      if (ph.id || m.phases.some((x) => x.id && inModule.some((r) => r.phaseId === x.id))) out.push({ kind: "phase", id: `${mid}:${ph.id ?? "none"}`, name: ph.name ?? noPhase, count: roots.length });
      for (const r of roots) {
        out.push({ kind: "issue", row: r, sub: !!r.parentKey });
        for (const k of kids.get(r.key) ?? []) out.push({ kind: "issue", row: k, sub: true });
      }
    }
  }
  return out;
}

export function TableView({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("overview-table.table");
  const search = useSearchParams();
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const [filters, setFilters] = useState<Filters>(() => (search.get("overdue") === "true" ? { overdue: "true" } : {}));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reasonFor, setReasonFor] = useState<{ run: (reason: string) => Promise<void> } | null>(null);

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const canEdit = !!perms.data?.permissions.includes("issue.edit");
  const canDelete = !!perms.data?.permissions.includes("issue.delete") || perms.data?.role === "admin";
  const options = useQuery({ queryKey: ["form-options", ws, projectKey], queryFn: () => api.get<Options>(`${base}/form-options`), enabled: canEdit });
  const views = useQuery({ queryKey: ["saved-views", ws, projectKey], queryFn: () => api.get<{ items: SavedView[] }>(`${base}/saved-views`) });

  const params = new URLSearchParams({ view: "table", limit: String(PAGE), sort: "number" });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  else if (filters.hideDone) params.set("status", "todo,in_progress");
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.level) params.set("level", filters.level);
  if (filters.overdue) params.set("overdue", "true");
  const tableKey = ["table", ws, projectKey, params.toString()];
  const table = useQuery({
    queryKey: tableKey,
    queryFn: async () => {
      // โหลดต่อจนครบ (สูงสุด 2,000 แถว) · สรุปรวมมาจากหน้าแรก
      const first = await api.get<TableData>(`${base}/issues?${params}`);
      let cursor = first.nextCursor;
      for (let i = 1; cursor !== null && i < MAX_PAGES; i++) {
        const next = await api.get<TableData>(`${base}/issues?${params}&cursor=${encodeURIComponent(String(cursor))}`);
        first.items.push(...next.items);
        cursor = next.nextCursor;
      }
      return { ...first, nextCursor: cursor };
    },
    enabled: !!perms.data && !perms.data.guestViewer,
  });

  const display = useMemo(() => (table.data ? buildDisplay(table.data, collapsed, t("noModule"), t("noPhase")) : []), [table.data, collapsed, t]);
  const statuses = options.data?.issueTypes.find((x) => x.name === "Task")?.statuses ?? [];
  const reload = () => cache.invalidateQueries({ queryKey: ["table", ws, projectKey] });
  const set = (k: keyof Filters, v: string) => { setFilters((f) => ({ ...f, [k]: v || undefined })); setSelected(new Set()); };

  async function patch(row: Row, body: Record<string, unknown>, field: string) {
    const run = async (reason?: string) => {
      try {
        await api.patch(`/w/${encodeURIComponent(ws)}/issues/${encodeURIComponent(row.key)}`, reason ? { ...body, planChangeReason: reason } : body, row.version);
        toast({ message: t("saved", { key: row.key }) });
      } catch (e) {
        if (e instanceof ApiError && e.code === "plan_change_reason_required") { setReasonFor({ run: (r) => run(r) }); return; }
        toast({ message: e instanceof ApiError && e.status === 409 ? t("conflict") : e instanceof ApiError && e.code === "due_change_requires_approval" ? t("needsApproval") : e instanceof Error ? e.message : String(e) });
      }
      await reload();
    };
    void field;
    await run();
  }

  async function bulk(set: Record<string, unknown>, reason?: string): Promise<void> {
    const keys = [...selected];
    try {
      const r = await api.post<{ results: { key: string; ok: boolean; error?: { code: string } }[] }>(`${base}/issues/bulk`, { keys, set: reason ? { ...set, planChangeReason: reason } : set });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.some((f) => f.error?.code === "plan_change_reason_required") && !reason) { setReasonFor({ run: (rs) => bulk(set, rs) }); return; }
      toast({ message: failed.length ? t("bulkFailed", { count: failed.length }) : t("bulkDone", { count: keys.length }) });
      if (!failed.length) setSelected(new Set());
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : String(e) });
    }
    await reload();
  }

  if (perms.isPending || (table.isPending && table.fetchStatus !== "idle")) return <div className={styles.page}><LoadingState /></div>;
  if (perms.data?.guestViewer) return <div className={styles.page}><Forbidden /></div>;
  const err = perms.error ?? table.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => table.refetch()} />}</div>;
  const data = table.data!;
  const issueRows = display.filter((d): d is Extract<Display, { kind: "issue" }> => d.kind === "issue");
  const virtual = display.length > VIRTUAL_AFTER;
  const viewH = 640;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - 10) : 0;
  const end = virtual ? Math.min(display.length, start + Math.ceil(viewH / ROW_H) + 20) : display.length;
  const shown = display.slice(start, end);
  const allSelected = issueRows.length > 0 && issueRows.every((d) => selected.has(d.row.key));
  const filtered = FILTER_KEYS.some((k) => filters[k]);
  const s = data.summary;

  return (
    <div className={styles.page}>
      <div className={styles.bar} role="group" aria-label={t("views")}>
        <span className="muted">{t("views")}</span>
        <button type="button" className={styles.chip} aria-pressed={!filtered} onClick={() => setFilters({})}>{t("allTasks")}</button>
        {views.data?.items.map((v) => (
          <span key={v.id} style={{ display: "inline-flex", alignItems: "center" }}>
            <button type="button" className={styles.chip} aria-pressed={JSON.stringify(v.filters) === JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([, x]) => x)))} onClick={() => setFilters(v.filters as Filters)}>{v.name}</button>
            {v.mine !== false && <button type="button" className={styles.toggle} aria-label={t("deleteView", { name: v.name })} onClick={async () => { await api.delete(`${base}/saved-views/${v.id}`); await cache.invalidateQueries({ queryKey: ["saved-views", ws, projectKey] }); }}><X size={14} /></button>}
          </span>
        ))}
        <Button size="small" variant="ghost" onClick={() => setSaving(true)}>{t("saveView")}</Button>
      </div>

      <div className={styles.bar} role="group" aria-label={t("filters")}>
        <form onSubmit={(e) => { e.preventDefault(); set("q", String(new FormData(e.currentTarget).get("q") ?? "")); }}>
          <input className="input" name="q" aria-label={t("search")} placeholder={t("search")} defaultValue={filters.q ?? ""} style={{ minWidth: 220 }} />
        </form>
        <Select aria-label={t("status")} size="small" value={filters.status ?? ""} onChange={(e) => set("status", e.target.value)}>
          <option value="">{t("allStatus")}</option>
          {(["todo", "in_progress", "done"] as const).map((c) => <option key={c} value={c}>{t(`statusCategory.${c}`)}</option>)}
        </Select>
        <Select aria-label={t("assignee")} size="small" value={filters.assignee ?? ""} onChange={(e) => set("assignee", e.target.value)}>
          <option value="">{t("assignee")}: {t("anyone")}</option>
          <option value="me">{t("me")}</option>
          <option value="none">{t("none")}</option>
          {options.data?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
        </Select>
        <Select aria-label={t("priority")} size="small" value={filters.priority ?? ""} onChange={(e) => set("priority", e.target.value)}>
          <option value="">{t("anyPriority")}</option>
          {(["urgent", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select aria-label={t("level")} size="small" value={filters.level ?? ""} onChange={(e) => set("level", e.target.value)}>
          <option value="">{t("allLevels")}</option><option value="task">{t("tasks")}</option><option value="subtask">{t("subtasks")}</option>
        </Select>
        <button type="button" className={styles.chip} aria-pressed={!!filters.overdue} onClick={() => set("overdue", filters.overdue ? "" : "true")}>{t("overdue")}</button>
        <button type="button" className={styles.chip} aria-pressed={!filters.hideDone} onClick={() => set("hideDone", filters.hideDone ? "" : "1")}>{t("showDone")}</button>
        {filtered && <Button size="small" variant="ghost" onClick={() => setFilters({})}>{t("clear")}</Button>}
        <span style={{ flex: 1 }} />
        <Button size="small" onClick={() => setCollapsed(new Set())}>{t("expandAll")}</Button>
        <Button size="small" onClick={() => setCollapsed(new Set(data.modules.map((m) => m.id ?? "none")))}>{t("collapseAll")}</Button>
      </div>

      <section className={styles.card} style={{ overflow: "hidden" }}>
        {!data.items.length ? <EmptyState title={filtered ? t("emptyFiltered") : t("empty")} /> : (
          <div className={styles.tableWrap} style={virtual ? { height: viewH } : undefined} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="table-scroll">
            <table className={styles.table} aria-rowcount={display.length + 1}>
              <thead>
                <tr>
                  <th style={{ width: 34 }}>{canEdit && <input type="checkbox" aria-label={t("selectAll")} checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(issueRows.map((d) => d.row.key)) : new Set())} />}</th>
                  {(["name", "dev", "ba", "status", "priority", "size", "start", "end", "actual", "progress"] as const).map((c) => <th key={c}>{t(`cols.${c}`)}</th>)}
                </tr>
              </thead>
              <tbody>
                {virtual && start > 0 && <tr aria-hidden="true"><td colSpan={11} style={{ height: start * ROW_H, padding: 0 }} /></tr>}
                {shown.map((d) => d.kind === "module" ? (
                  <tr key={d.id} className={styles.moduleRow}>
                    <td />
                    <td colSpan={10}>
                      <button type="button" className={styles.toggle} aria-expanded={!collapsed.has(d.id)} aria-label={t(collapsed.has(d.id) ? "expand" : "collapse", { name: d.name })} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); return n; })}>
                        <ChevronDown size={16} style={{ transform: collapsed.has(d.id) ? "rotate(-90deg)" : undefined }} />
                      </button>{" "}
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: d.color ?? "#94a3b8", marginRight: 6 }} />
                      {d.name} <span className="muted" style={{ fontWeight: 500 }}>· {t("moduleSummary", { count: d.count, md: d.md })} · {d.pct}%</span>
                    </td>
                  </tr>
                ) : d.kind === "phase" ? (
                  <tr key={d.id} className={styles.phaseRow}><td /><td colSpan={10}>{d.name} <span className="muted">· {d.count}</span></td></tr>
                ) : (
                  <IssueRow key={d.row.key} row={d.row} sub={d.sub} ws={ws} projectKey={projectKey} year={year} canEdit={canEdit} statuses={statuses}
                    selected={selected.has(d.row.key)} onSelect={(on) => setSelected((c) => { const n = new Set(c); if (on) n.add(d.row.key); else n.delete(d.row.key); return n; })}
                    onPatch={(body, field) => patch(d.row, body, field)} />
                ))}
                {virtual && end < display.length && <tr aria-hidden="true"><td colSpan={11} style={{ height: (display.length - end) * ROW_H, padding: 0 }} /></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.foot}>
          {t("summary", { tasks: s.taskCount, subs: s.subtaskCount, done: s.doneCount, md: s.estimateMd, pct: s.progressPct })} · {t("rows", { shown: issueRows.length, total: data.items.length })}{virtual ? ` · ${t("virtualHint")}` : ""}
        </div>
      </section>

      {canEdit && selected.size > 0 && (
        <BulkBar count={selected.size} options={options.data} canDelete={canDelete} onApply={(set) => bulk(set)} onDelete={() => setDeleting(true)} onClear={() => setSelected(new Set())} />
      )}
      {saving && <SaveViewDialog onClose={() => setSaving(false)} onSave={async (name, shared) => {
        await api.post(`${base}/saved-views`, { name, viewType: "table", shared, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
        toast({ message: t("viewSaved", { name }) });
        setSaving(false);
        await cache.invalidateQueries({ queryKey: ["saved-views", ws, projectKey] });
      }} />}
      {deleting && <DeleteDialog count={selected.size} onClose={() => setDeleting(false)} onConfirm={async (confirmText) => {
        await api.post(`${base}/issues/bulk`, { keys: [...selected], delete: true, confirmText });
        toast({ message: t("deleted", { count: selected.size }) });
        setDeleting(false);
        setSelected(new Set());
        await reload();
      }} />}
      {reasonFor && <ReasonDialog onClose={() => setReasonFor(null)} onSubmit={async (r) => { const job = reasonFor; setReasonFor(null); await job.run(r); }} />}
    </div>
  );
}

function IssueRow({ row, sub, ws, projectKey, year, canEdit, statuses, selected, onSelect, onPatch }: {
  row: Row; sub: boolean; ws: string; projectKey: string; year: YearFormat; canEdit: boolean;
  statuses: { id: string; name: string }[]; selected: boolean; onSelect: (on: boolean) => void; onPatch: (body: Record<string, unknown>, field: string) => void;
}) {
  const t = useTranslations("overview-table.table");
  const href = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/table?issue=${encodeURIComponent(row.key)}`;
  const statusOptions = statuses.some((s) => s.id === row.status.id) ? statuses : [{ id: row.status.id, name: row.status.name }, ...statuses];
  return (
    <tr className={sub ? styles.sub : undefined} data-testid={`row-${row.key}`}>
      <td>{canEdit && <input type="checkbox" aria-label={t("select", { key: row.key })} checked={selected} onChange={(e) => onSelect(e.target.checked)} />}</td>
      <td><div className={styles.name}><span className={styles.key}>{row.key}</span><Link href={href} style={{ color: "var(--foreground)", textDecoration: row.status.category === "done" ? "line-through" : "none" }}>{row.title}</Link></div></td>
      <td>{row.assignees?.length ? <AvatarStack people={row.assignees} /> : <span className="muted">—</span>}</td>
      <td>{row.ba ? <Avatar size="small" person={row.ba} /> : <span className="muted">—</span>}</td>
      <td>
        {canEdit && statuses.length ? (
          <select className={styles.inline} aria-label={t("edit", { field: t("cols.status"), key: row.key })} value={row.status.id} onChange={(e) => onPatch({ statusId: e.target.value }, "status")}>
            {statusOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : row.status.name}
      </td>
      <td>
        {canEdit ? (
          <select className={styles.inline} aria-label={t("edit", { field: t("cols.priority"), key: row.key })} value={row.priority} onChange={(e) => onPatch({ priority: e.target.value }, "priority")}>
            {(["urgent", "high", "medium", "low"] as const).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : row.priority}
      </td>
      <td>{row.size ?? "—"}{row.estimateMd !== null ? ` · ${row.estimateMd}` : ""}</td>
      <td>{formatDate(row.planStart, year)}</td>
      <td>
        {canEdit ? <input className={styles.inline} type="date" aria-label={t("edit", { field: t("cols.end"), key: row.key })} defaultValue={row.planEnd ?? ""} onBlur={(e) => { if (e.target.value && e.target.value !== row.planEnd) onPatch({ planEnd: e.target.value }, "planEnd"); }} /> : formatDate(row.planEnd, year)}
      </td>
      <td className="muted">{row.actualStart ? `${formatDate(row.actualStart, year)}${row.actualEnd ? ` – ${formatDate(row.actualEnd, year)}` : ""}` : "—"}</td>
      <td>{row.progressPct ?? 0}%</td>
    </tr>
  );
}

function BulkBar({ count, options, canDelete, onApply, onDelete, onClear }: { count: number; options?: Options; canDelete: boolean; onApply: (set: Record<string, unknown>) => void; onDelete: () => void; onClear: () => void }) {
  const t = useTranslations("overview-table.table");
  const [moduleId, setModuleId] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  return (
    <div className={styles.bulk} role="region" aria-label={t("selected", { count })}>
      <b>{t("selected", { count })}</b>
      <select aria-label={t("bulkModule")} value={moduleId} onChange={(e) => setModuleId(e.target.value)}><option value="">{t("bulkModule")}</option>{options?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
      <Button size="small" disabled={!moduleId} onClick={() => onApply({ moduleId })}>{t("apply")}</Button>
      <input type="date" aria-label={t("bulkDue")} value={due} onChange={(e) => setDue(e.target.value)} />
      <Button size="small" disabled={!due} onClick={() => onApply({ planEnd: due })}>{t("apply")}</Button>
      <select aria-label={t("bulkAssignee")} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">{t("bulkAssignee")}</option>{options?.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>
      <Button size="small" disabled={!assignee} onClick={() => onApply({ assigneeIds: [assignee] })}>{t("apply")}</Button>
      {canDelete && <Button size="small" variant="danger" onClick={onDelete}>{t("delete")}</Button>}
      <Button size="small" variant="ghost" style={{ color: "#fff" }} onClick={onClear}>{t("unselect")}</Button>
    </div>
  );
}

function SaveViewDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, shared: boolean) => Promise<void> }) {
  const t = useTranslations("overview-table.table");
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  return (
    <Dialog open title={t("saveView")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void onSave(name.trim(), shared); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("viewName")} required value={name} onChange={(e) => setName(e.target.value)} />
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{t("viewShared")}</label>
        <Button type="submit" variant="primary">{t("apply")}</Button>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: (text: string) => Promise<void> }) {
  const t = useTranslations("overview-table.table");
  const phrase = `ลบ ${count} งาน`;
  const [text, setText] = useState("");
  return (
    <Dialog open title={t("deleteTitle")} description={t("deleteDescription")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (text === phrase) void onConfirm(text); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("deleteConfirm", { text: phrase })} value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="danger" disabled={text !== phrase}>{t("delete")}</Button>
      </form>
    </Dialog>
  );
}

function ReasonDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const t = useTranslations("overview-table.table");
  const [reason, setReason] = useState("");
  return (
    <Dialog open title={t("reason")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void onSubmit(reason.trim()); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label={t("reason")} required value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button type="submit" variant="primary">{t("apply")}</Button>
      </form>
    </Dialog>
  );
}

