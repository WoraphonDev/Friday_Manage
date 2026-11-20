"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Lock, LockOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { Avatar, Button, Dialog, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EdgeData } from "./edges";
import { DIAGRAM_ICONS, DiagramIcon } from "./icons";
import { useIssueFilters } from "./link-dialog";
import type { FlowNode } from "./ops";
import { ColumnEditorDialog, MAX_COLUMNS } from "./column-editor";
import { ColumnKeys, Progress, SHAPE_DEFS, SHAPE_GROUPS, sortChips } from "./shapes";
import { Swatches } from "./toolbars";
import { chipOf, columnTypeText, MARKERS, MAX_ISSUES_PER_NODE, type Column, type IssueChip, type IssueSearch, type Marker, type NodeData, type Shape } from "./types";
import styles from "./diagrams.module.css";

type PanelTab = "format" | "tasks";

export function NodePanel({
  node, tab, setTab, issues, onSnapshot, onPatch, onType, onLink, onUnlink, onCreateTask, canCreateTask, onDelete, iconFocus,
}: {
  node: FlowNode; tab: PanelTab; setTab: (t: PanelTab) => void; issues: Record<string, IssueChip>;
  onSnapshot: () => void; onPatch: (d: Partial<NodeData>, size?: { width?: number; height?: number }) => void; onType: (type: Shape) => void;
  onLink: () => void; onUnlink: (id: string) => void; onCreateTask: () => void; canCreateTask: boolean; onDelete: () => void; iconFocus: number;
}) {
  const t = useTranslations("diagrams");
  const tStatus = useTranslations("common.status");
  const type = node.type as Shape;
  const def = SHAPE_DEFS[type];
  const data = node.data;
  const typed = useRef(false);
  const once = () => {
    if (!typed.current) onSnapshot();
    typed.current = true;
  };
  const chips = data.issueIds.map((id) => issues[id]).filter((c): c is IssueChip => !!c);
  const statusText = (c: IssueChip) => (c.deleted ? t("tag.deleted") : c.tone === "overdue" ? tStatus("overdue") : c.status);
  const columns = data.columns ?? [];
  const setColumns = (next: Column[]) => onPatch({ columns: next });
  const [columnsOpen, setColumnsOpen] = useState(false);
  // undo ย้อนทั้งรอบที่เปิดหน้าต่างแก้คอลัมน์ได้ในครั้งเดียว
  const openColumns = () => { onSnapshot(); setColumnsOpen(true); };
  /** กล่องสูงพอให้เห็นทุกคอลัมน์ (ไม่ย่อเองถ้าผู้ใช้ขยายไว้) */
  const setTableColumns = (next: Column[]) => onPatch({ columns: next }, next.length > columns.length ? { height: Math.max(node.height ?? 0, 60 + next.length * 22) } : undefined);
  return (
    <div className={styles.panelInner}>
      <div className={styles.panelTabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === "format"} className={cn(tab === "format" && styles.panelTabOn)} onClick={() => setTab("format")}>{t("panel.format")}</button>
        <button type="button" role="tab" aria-selected={tab === "tasks"} className={cn(tab === "tasks" && styles.panelTabOn)} onClick={() => setTab("tasks")}>{t("panel.tasks", { n: data.issueIds.length })}</button>
      </div>
      {tab === "tasks" ? (
        <div className={styles.panelBody}>
          {data.issueIds.length > 1 && <Progress chips={chips} total={data.issueIds.length} />}
          {!data.issueIds.length && <p className={styles.hint}>{t("panel.noTasks")}</p>}
          {sortChips(chips).map((c) => (
            <div key={c.id} className={styles.linkedCard}>
              <div className={styles.linkedTop}>
                <b>{c.key}</b>
                <span className={cn(styles.chip, styles[`tone_${c.tone}`])}>{statusText(c)}</span>
                <button type="button" className={styles.iconBtn} aria-label={t("panel.unlinkOne", { key: c.key })} title={t("panel.unlink")} onClick={() => onUnlink(c.id)}><X size={13} /></button>
              </div>
              <div className={styles.linkedTitle}>{c.title}</div>
              <div className={styles.linkedMeta}>
                {c.assignee && <><Avatar person={c.assignee} size="small" />{c.assignee.displayName}</>}
                {c.dueDate && <span className={cn(c.tone === "overdue" && styles.dueLate)}>{t("panel.due", { date: formatDate(c.dueDate) })}</span>}
              </div>
            </div>
          ))}
          {data.issueIds.length > chips.length && <p className={styles.hint}>{t("tag.hiddenCount", { n: data.issueIds.length - chips.length })}</p>}
          <div className={styles.panelActions}>
            <Button size="small" variant="primary" onClick={onLink} disabled={data.issueIds.length >= MAX_ISSUES_PER_NODE && false}><Plus size={14} /> {t("panel.link")}</Button>
            {canCreateTask && <Button size="small" onClick={onCreateTask}><Plus size={14} /> {t("panel.createTask")}</Button>}
          </div>
          <p className={styles.hint}>{t("panel.linkHint", { n: MAX_ISSUES_PER_NODE })}</p>
        </div>
      ) : (
        <div className={styles.panelBody}>
          {def.kind !== "point" && (
            <label className={styles.field}>
              <span>{def.kind === "table" || def.kind === "enum" ? t("panel.tableName") : def.kind === "lane" || def.kind === "pool" ? t("panel.laneName") : t("panel.text")}</span>
              <textarea id="diagram-node-label" className={styles.textarea} rows={def.kind === "table" ? 1 : 3} maxLength={500} value={data.label} onFocus={() => (typed.current = false)} onChange={(e) => { once(); onPatch({ label: e.target.value }); }} />
            </label>
          )}
          <Select size="small" label={t("panel.shape")} value={type} onChange={(e) => onType(e.target.value as Shape)}>
            {SHAPE_GROUPS.map((g) => (
              <optgroup key={g.key} label={t(`groups.${g.key}`)}>
                {[...new Set(g.items.map((i) => i.type))].map((s) => <option key={s} value={s}>{t(`shapes.${s}`)}</option>)}
              </optgroup>
            ))}
          </Select>
          <div className={styles.field}><span>{t("bar.fill")}</span><Swatches label={t("bar.fill")} value={data.color} onChange={(c) => { onSnapshot(); onPatch({ color: c }); }} /></div>
          <div className={styles.field}>
            <span>{t("bar.border")}</span>
            <Swatches label={t("bar.borderColor")} value={data.stroke} onChange={(c) => { onSnapshot(); onPatch({ stroke: c }); }} />
            <div className={styles.segRow}>
              {(["solid", "dashed", "dotted", "none"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={(data.strokeStyle ?? "solid") === s} className={cn(styles.seg, (data.strokeStyle ?? "solid") === s && styles.segOn)} onClick={() => { onSnapshot(); onPatch({ strokeStyle: s }); }}>{t(`bar.line.${s}`)}</button>
              ))}
            </div>
          </div>
          <div className={styles.fieldRow}>
            <Select size="small" label={t("bar.fontSize")} value={String(data.fontSize ?? 13)} onChange={(e) => { onSnapshot(); onPatch({ fontSize: Number(e.target.value) }); }}>
              {[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
            <Select size="small" label={t("bar.align")} value={data.align ?? "center"} onChange={(e) => { onSnapshot(); onPatch({ align: e.target.value as NodeData["align"] }); }}>
              <option value="left">{t("bar.alignLeft")}</option><option value="center">{t("bar.alignCenter")}</option><option value="right">{t("bar.alignRight")}</option>
            </Select>
          </div>
          <label className={styles.check}><input type="checkbox" checked={!!data.bold} onChange={(e) => { onSnapshot(); onPatch({ bold: e.target.checked }); }} />{t("bar.bold")}</label>
          <IconPicker value={data.icon ?? null} focus={iconFocus} onChange={(icon) => { onSnapshot(); onPatch({ icon }); }} defaultIcon={def.icon} />

          {(def.kind === "table" || def.kind === "enum") && (
            <div className={styles.field}>
              <span>{def.kind === "enum" ? t("panel.values") : t("panel.columns")}</span>
              <div className={styles.columns}>
                {def.kind === "table" ? (
                  <>
                    {/* แผงแคบ จึงแสดงแค่รูปย่อ · แก้ทุกค่าในหน้าต่างแก้คอลัมน์ */}
                    {columns.length > 0 && (
                      <button type="button" className={styles.colSummary} onClick={openColumns} aria-label={t("panel.editColumns")}>
                        {columns.map((c, i) => (
                          <span key={i} className={styles.colSummaryRow}>
                            <ColumnKeys column={c} />
                            <span className={styles.colName}>{c.name || "—"}</span>
                            <span className={styles.colSummaryType}>{columnTypeText(c)}</span>
                          </span>
                        ))}
                      </button>
                    )}
                  </>
                ) : (
                  columns.map((c, i) => (
                    <div key={i} className={cn(styles.columnRow, styles.columnRowEnum)}>
                      <input className={styles.mini} aria-label={t("panel.columnName")} placeholder={t("panel.columnName")} value={c.name} maxLength={80} onFocus={() => (typed.current = false)} onChange={(e) => { once(); setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))); }} />
                      <button type="button" className={styles.iconBtn} aria-label={t("panel.removeColumn")} onClick={() => { onSnapshot(); setColumns(columns.filter((_, j) => j !== i)); }}><X size={14} /></button>
                    </div>
                  ))
                )}
                {def.kind === "table" ? (
                  <Button size="small" onClick={openColumns}><Pencil size={14} /> {t("panel.editColumns")}</Button>
                ) : (
                  <Button size="small" disabled={columns.length >= MAX_COLUMNS} onClick={() => { onSnapshot(); onPatch({ columns: [...columns, { name: "", type: "", key: null }] }, { height: Math.max(node.height ?? 0, 60 + (columns.length + 1) * 22) }); }}>
                    <Plus size={14} /> {t("panel.addValue")}
                  </Button>
                )}
              </div>
            </div>
          )}
          {def.kind === "table" && (
            <ColumnEditorDialog open={columnsOpen} onOpenChange={setColumnsOpen} tableName={data.label} onTableName={(label) => onPatch({ label })} columns={columns} onColumns={setTableColumns} />
          )}
          {def.kind === "pool" && (
            <div className={styles.field}>
              <span>{t("panel.lanes")}</span>
              <div className={styles.columns}>
                {(data.lanes ?? [t("defaults.lane", { n: 1 }), t("defaults.lane", { n: 2 })]).map((name, i, all) => (
                  <div key={i} className={cn(styles.columnRow, styles.columnRowEnum)}>
                    <input className={styles.mini} aria-label={t("panel.laneName")} value={name} maxLength={60} onFocus={() => (typed.current = false)} onChange={(e) => { once(); onPatch({ lanes: all.map((x, j) => (j === i ? e.target.value : x)) }); }} />
                    <button type="button" className={styles.iconBtn} aria-label={t("panel.removeLane")} disabled={all.length <= 1} onClick={() => { onSnapshot(); onPatch({ lanes: all.filter((_, j) => j !== i) }); }}><X size={14} /></button>
                  </div>
                ))}
                <Button size="small" disabled={(data.lanes?.length ?? 2) >= 12} onClick={() => { onSnapshot(); const all = data.lanes ?? [t("defaults.lane", { n: 1 }), t("defaults.lane", { n: 2 })]; onPatch({ lanes: [...all, t("defaults.lane", { n: all.length + 1 })] }, { height: (node.height ?? 360) + 120 }); }}>
                  <Plus size={14} /> {t("panel.addLane")}
                </Button>
              </div>
            </div>
          )}
          {def.kind === "class" && (
            <label className={styles.field}>
              <span>{t("panel.classBody")}</span>
              <textarea className={cn(styles.textarea, styles.mono)} rows={6} maxLength={2000} value={data.body ?? ""} placeholder={"- id: uuid\n- name: text\n---\n+ approve(): void"} onFocus={() => (typed.current = false)} onChange={(e) => { once(); onPatch({ body: e.target.value }); }} />
              <em className={styles.hint}>{t("panel.classHint")}</em>
            </label>
          )}
          <div className={styles.panelActions}>
            <Button size="small" onClick={() => { onSnapshot(); onPatch({ locked: !data.locked }); }}>{data.locked ? <><LockOpen size={14} /> {t("bar.unlock")}</> : <><Lock size={14} /> {t("bar.lock")}</>}</Button>
            <Button size="small" variant="danger" onClick={onDelete}><Trash2 size={14} /> {t("panel.deleteNode")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function IconPicker({ value, onChange, focus, defaultIcon }: { value: string | null; onChange: (icon: string | null) => void; focus: number; defaultIcon?: string }) {
  const t = useTranslations("diagrams.panel");
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  const term = q.trim().toLowerCase();
  const names = Object.entries(DIAGRAM_ICONS).filter(([name, d]) => !term || name.includes(term) || d.words.toLowerCase().includes(term)).map(([name]) => name);
  return (
    <div className={styles.field}>
      <span>{t("icon")}{defaultIcon && !value ? <em className={styles.optional}> · {t("iconDefault")}</em> : null}</span>
      <input ref={ref} className={styles.paletteSearch} placeholder={t("iconSearch")} aria-label={t("iconSearch")} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className={styles.iconGrid} role="radiogroup" aria-label={t("icon")}>
        <button type="button" role="radio" aria-checked={!value} className={cn(styles.iconCell, !value && styles.iconCellOn)} title={t("noIcon")} aria-label={t("noIcon")} onClick={() => onChange(null)}>—</button>
        {names.slice(0, 60).map((name) => (
          <button key={name} type="button" role="radio" aria-checked={value === name} className={cn(styles.iconCell, value === name && styles.iconCellOn)} title={`${name} · ${DIAGRAM_ICONS[name].words}`} aria-label={name} onClick={() => onChange(name)}>
            <DiagramIcon name={name} size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function EdgePanel({ data, onSnapshot, onPatch, onDelete }: { data: EdgeData; onSnapshot: () => void; onPatch: (d: Partial<EdgeData>) => void; onDelete: () => void }) {
  const t = useTranslations("diagrams.edge");
  const typed = useRef(false);
  return (
    <div className={styles.panelInner}>
      <div className={styles.panelTabs}><span className={styles.panelTabOn}>{t("title")}</span></div>
      <div className={styles.panelBody}>
        <Input id="diagram-edge-label" label={t("label")} placeholder={t("labelPlaceholder")} value={data.text ?? ""} maxLength={100} onFocus={() => (typed.current = false)} onChange={(e) => { if (!typed.current) onSnapshot(); typed.current = true; onPatch({ text: e.target.value }); }} />
        <Select size="small" label={t("pathLabel")} value={data.bend ? "bend" : (data.path ?? "smoothstep")} onChange={(e) => { onSnapshot(); onPatch(e.target.value === "bend" ? {} : { path: e.target.value as EdgeData["path"], bend: undefined }); }}>
          <option value="smoothstep">{t("path.smoothstep")}</option><option value="straight">{t("path.straight")}</option><option value="bezier">{t("path.bezier")}</option>
          {data.bend && <option value="bend">{t("path.bend")}</option>}
        </Select>
        <div className={styles.fieldRow}>
          {(["markerStart", "markerEnd"] as const).map((side) => (
            <Select key={side} size="small" label={t(side)} value={data[side] ?? (side === "markerEnd" ? "arrow" : "none")} onChange={(e) => { onSnapshot(); onPatch({ [side]: e.target.value as Marker, cardinality: undefined }); }}>
              {MARKERS.map((m) => <option key={m} value={m}>{t(`markers.${m}`)}</option>)}
            </Select>
          ))}
        </div>
        <Select size="small" label={t("width")} value={String(data.width ?? 1.5)} onChange={(e) => { onSnapshot(); onPatch({ width: Number(e.target.value) }); }}>
          {[1, 1.5, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
        </Select>
        <div className={styles.field}><span>{t("color")}</span><Swatches label={t("color")} value={data.color} onChange={(c) => { onSnapshot(); onPatch({ color: c }); }} /></div>
        <label className={styles.check}><input type="checkbox" checked={!!data.dashed} onChange={(e) => { onSnapshot(); onPatch({ dashed: e.target.checked }); }} />{t("dashed")}</label>
        <p className={styles.hint}>{t("bendHint")}</p>
        <Button size="small" variant="danger" onClick={onDelete}><Trash2 size={14} /> {t("delete")}</Button>
      </div>
    </div>
  );
}

/** สร้างงานใหม่จากกล่อง: ชื่อ = ข้อความในกล่อง · สร้างแล้วผูกให้เลย */
export function CreateTaskDialog({ open, onOpenChange, base, title, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; base: string; title: string; onCreated: (chip: IssueChip) => void }) {
  const t = useTranslations("diagrams.createTask");
  const filters = useIssueFilters(base, open);
  const [name, setName] = useState(title);
  const [moduleId, setModuleId] = useState("");
  const [phaseId, setPhaseId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) {
      setName(title);
      setError("");
      setPhaseId("");
    }
  }, [open, title]);
  useEffect(() => {
    if (!moduleId && filters.data?.modules[0]) setModuleId(filters.data.modules[0].id);
  }, [filters.data, moduleId]);
  const phases = (filters.data?.phases ?? []).filter((p) => p.moduleId === moduleId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("title")} description={t("description")}>
      <form
        className={styles.form}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return setError(t("nameRequired"));
          setPending(true);
          setError("");
          try {
            const created = await api.post<{ key: string }>(`${base}/issues`, { title: name.trim(), moduleId: moduleId || undefined, phaseId: phaseId || undefined });
            const found = await api.get<IssueSearch>(`${base}/diagram-issues?${new URLSearchParams({ q: created.key, status: "todo,in_progress,review,blocked,done,cancelled", type: "task,subtask,bug" })}`);
            const hit = found.items.find((i) => i.key === created.key);
            if (hit) onCreated(chipOf(hit));
            onOpenChange(false);
          } catch (err) {
            setError(err instanceof Error ? err.message : t("failed"));
          } finally {
            setPending(false);
          }
        }}
      >
        <Input id="diagram-task-title" label={t("name")} value={name} maxLength={300} onChange={(e) => setName(e.target.value)} />
        <Select label="Module" value={moduleId} onChange={(e) => { setModuleId(e.target.value); setPhaseId(""); }}>
          {filters.data?.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        {phases.length > 0 && (
          <Select label={t("group")} value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
            <option value="">{t("noGroup")}</option>
            {phases.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        {error && <p className={styles.err} role="alert">{error}</p>}
        <div className={styles.formActions}>
          <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending}>{t("submit")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
