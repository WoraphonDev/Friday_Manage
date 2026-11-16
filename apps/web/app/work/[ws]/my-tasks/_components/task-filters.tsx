"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Search, X } from "lucide-react";
import { STATUS_CATEGORIES } from "@/lib/status";
import { DEFAULT_ITEM_COLOR } from "@/lib/colors";
import type { TaskItem } from "./types";
import styles from "./hmt.module.css";

/** ตัวกรองของ My Tasks · กรองในหน้าเว็บเพราะ API ส่งงานของแท็บมาครบอยู่แล้ว · modules เก็บ id ("none" = งานที่ไม่มี Module) */
export interface TaskFilter {
  q: string;
  statuses: string[];
  modules: string[];
}
export const EMPTY_FILTER: TaskFilter = { q: "", statuses: [], modules: [] };
const NO_MODULE = "none";

export const isFiltering = (f: TaskFilter) => !!f.q.trim() || f.statuses.length > 0 || f.modules.length > 0;

export function matchesFilter(item: TaskItem, f: TaskFilter) {
  const q = f.q.trim().toLowerCase();
  if (q && !item.title.toLowerCase().includes(q) && !item.key.toLowerCase().includes(q)) return false;
  if (f.statuses.length && !f.statuses.includes(item.status.name)) return false;
  if (f.modules.length && !f.modules.includes(item.module?.id ?? NO_MODULE)) return false;
  return true;
}

/** จำตัวกรองต่อ Workspace ในเบราว์เซอร์ เปิดหน้าใหม่ยังอยู่ · อ่านหลัง mount เพื่อไม่ให้ HTML จาก server ไม่ตรงกัน */
export function useTaskFilter(ws: string) {
  const storageKey = `friday:my-tasks-filter:${ws}`;
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_FILTER);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const v = raw ? (JSON.parse(raw) as Partial<TaskFilter>) : null;
      if (v) setFilter({ q: typeof v.q === "string" ? v.q : "", statuses: Array.isArray(v.statuses) ? v.statuses.filter((x) => typeof x === "string") : [], modules: Array.isArray(v.modules) ? v.modules.filter((x) => typeof x === "string") : [] });
    } catch {
      // เบราว์เซอร์ปิด storage ไว้ ใช้ค่าว่าง
    }
    loaded.current = true;
  }, [storageKey]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      if (isFiltering(filter)) localStorage.setItem(storageKey, JSON.stringify(filter));
      else localStorage.removeItem(storageKey);
    } catch {
      // ไม่มี storage ก็ยังกรองได้ แค่ไม่จำ
    }
  }, [filter, storageKey]);
  return [filter, setFilter] as const;
}

/** ไฮไลต์คำค้นในชื่องาน */
export function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i} className={styles.hit}>{text.slice(i, i + needle.length)}</mark>);
    at = i + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

interface Option { value: string; label: string; count: number; color?: string; group?: string }

const CAT_ORDER = new Map<string, number>(STATUS_CATEGORIES.map((c, i) => [c, i]));

function statusOptions(items: TaskItem[], selected: string[]): Option[] {
  const map = new Map<string, Option & { cat: number }>();
  for (const i of items) {
    const o = map.get(i.status.name) ?? { value: i.status.name, label: i.status.name, count: 0, cat: CAT_ORDER.get(i.status.category) ?? 9 };
    o.count++;
    map.set(i.status.name, o);
  }
  // สถานะที่เลือกไว้แต่ไม่มีงานในแท็บนี้ยังต้องเห็นเพื่อเอาติ๊กออกได้
  for (const s of selected) if (!map.has(s)) map.set(s, { value: s, label: s, count: 0, cat: 9 });
  return [...map.values()].sort((a, b) => a.cat - b.cat || a.label.localeCompare(b.label));
}

function moduleOptions(items: TaskItem[], selected: string[], noneLabel: string): Option[] {
  const map = new Map<string, Option>();
  const multi = new Set(items.map((i) => i.project.key)).size > 1;
  for (const i of items) {
    const id = i.module?.id ?? NO_MODULE;
    const o = map.get(id) ?? { value: id, label: i.module?.name ?? noneLabel, count: 0, color: i.module ? (i.module.color ?? DEFAULT_ITEM_COLOR) : undefined, group: multi && i.module ? i.project.name : undefined };
    o.count++;
    map.set(id, o);
  }
  for (const s of selected) if (!map.has(s)) map.set(s, { value: s, label: s === NO_MODULE ? noneLabel : "—", count: 0 });
  // เรียงตามโปรเจกต์แล้วชื่อ Module · "ไม่มี Module" อยู่ท้าย
  return [...map.values()].sort((a, b) => Number(a.value === NO_MODULE) - Number(b.value === NO_MODULE) || (a.group ?? "").localeCompare(b.group ?? "") || a.label.localeCompare(b.label));
}

function FilterMenu({ label, options, selected, onChange, searchable }: { label: string; options: Option[]; selected: string[]; onChange: (v: string[]) => void; searchable?: boolean }) {
  const t = useTranslations("home-my-tasks.tasks.filters");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const names = selected.map((v) => options.find((o) => o.value === v)?.label ?? v);
  const text = names.length === 0 ? label : names.length === 1 ? `${label}: ${names[0]}` : `${label}: ${names[0]} +${names.length - 1}`;
  const shown = q.trim() ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : options;
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  let lastGroup: string | undefined;
  return (
    <div ref={ref} className={styles.ddWrap}>
      <button type="button" className={`${styles.dd} ${selected.length ? styles.ddOn : ""}`} aria-haspopup="true" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((o) => !o)}>
        <span className={styles.ddText}>{text}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className={`${styles.menu} motion-in`} role="group" aria-label={label}>
          {searchable && (
            <label className={styles.menuSearch}>
              <Search size={13} aria-hidden="true" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchIn", { name: label })} aria-label={t("searchIn", { name: label })} autoFocus />
            </label>
          )}
          <div className={styles.menuList}>
            {shown.length === 0 && <div className={styles.menuEmpty}>{t("noOptions")}</div>}
            {shown.map((o) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={o.value}>
                  {head && <div className={styles.menuLab}>{head}</div>}
                  <label className={styles.opt}>
                    <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                    {o.color && <span className={styles.sw} style={{ background: o.color }} />}
                    <span className={styles.optLabel}>{o.label}</span>
                    <span className={styles.optN}>{o.count}</span>
                  </label>
                </div>
              );
            })}
          </div>
          <div className={styles.menuFoot}>
            <button type="button" onClick={() => onChange([])} disabled={!selected.length}>{t("clear")}</button>
            <button type="button" onClick={() => onChange([...new Set([...selected, ...shown.map((o) => o.value)])])}>{t("selectAll")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** แถวตัวกรอง: ค้นหา + สถานะ + Module + ล้างตัวกรอง + จำนวนที่แสดง */
export function FilterBar({ items, filter, onChange, shown, total, compact }: { items: TaskItem[]; filter: TaskFilter; onChange: (f: TaskFilter) => void; shown: number; total: number; compact?: boolean }) {
  const t = useTranslations("home-my-tasks.tasks.filters");
  const active = isFiltering(filter);
  return (
    <div className={`${styles.tools} ${compact ? styles.toolsCompact : ""}`} role="search">
      <label className={styles.search}>
        <Search size={14} aria-hidden="true" />
        <input type="search" value={filter.q} onChange={(e) => onChange({ ...filter, q: e.target.value })} placeholder={t("searchPlaceholder")} aria-label={t("searchLabel")} />
        {filter.q && <button type="button" className={styles.searchClear} aria-label={t("clearSearch")} onClick={() => onChange({ ...filter, q: "" })}><X size={13} aria-hidden="true" /></button>}
      </label>
      <div className={styles.ddRow}>
        <FilterMenu label={t("status")} options={statusOptions(items, filter.statuses)} selected={filter.statuses} onChange={(statuses) => onChange({ ...filter, statuses })} />
        <FilterMenu label={t("module")} options={moduleOptions(items, filter.modules, t("noModule"))} selected={filter.modules} onChange={(modules) => onChange({ ...filter, modules })} searchable />
      </div>
      {active && <button type="button" className={styles.clearLink} onClick={() => onChange(EMPTY_FILTER)}>{t("clearAll")}</button>}
      <span className={styles.shown} aria-live="polite">{active ? t.rich("shownOf", { shown, total, b: (c) => <b>{c}</b> }) : t.rich("shownAll", { total, b: (c) => <b>{c}</b> })}</span>
    </div>
  );
}
