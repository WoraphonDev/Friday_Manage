"use client";

// หน้าต่างแก้คอลัมน์ของตาราง ER ทั้งชุด (แนว 2 ที่ผู้ใช้เลือก 2026-11-20) · แผงขวากว้าง 272px ใส่ทุกช่องไม่พอ
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { GripVertical, Plus, X } from "lucide-react";
import { Button, Dialog } from "@/components/ui";
import { cn } from "@/lib/utils";
import { COLUMN_TYPE_GROUPS, isFk, isKnownType, isPk, keyOf, takesLength, type Column } from "./types";
import styles from "./diagrams.module.css";

/** ตัวเลือก "พิมพ์เอง" ในรายการชนิดข้อมูล */
const CUSTOM = "__custom";
export const MAX_COLUMNS = 80;

export function ColumnEditorDialog({
  open, onOpenChange, tableName, onTableName, columns, onColumns,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  tableName: string; onTableName: (v: string) => void;
  columns: Column[]; onColumns: (next: Column[]) => void;
}) {
  const t = useTranslations("diagrams.panel");
  /** แถวที่เพิ่งเลือก "พิมพ์เอง" และยังไม่ได้พิมพ์ */
  const [customRows, setCustomRows] = useState<Set<number>>(new Set());
  const [drag, setDrag] = useState<number | null>(null);
  const [, rerender] = useState(0);
  const focusRow = useRef<number | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    if (!open) setCustomRows(new Set());
  }, [open]);
  // โฟกัสช่องชื่อของแถวที่เพิ่ง Enter ไปหา / เพิ่งเพิ่ม
  useEffect(() => {
    if (focusRow.current == null) return;
    body.current?.querySelectorAll<HTMLInputElement>("input[data-col-name]")[focusRow.current]?.focus();
    focusRow.current = null;
  });

  const edit = (i: number, patch: Partial<Column>) => onColumns(columns.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = () => {
    if (columns.length >= MAX_COLUMNS) return;
    focusRow.current = columns.length;
    onColumns([...columns, { name: "", type: "", key: null }]);
  };
  const remove = (i: number) => {
    setCustomRows(new Set());
    onColumns(columns.filter((_, j) => j !== i));
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...columns];
    const [c] = next.splice(from, 1);
    next.splice(to, 0, c);
    setCustomRows(new Set());
    onColumns(next);
  };
  /** Enter = ไปแถวถัดไป · แถวสุดท้ายเพิ่มแถวใหม่ */
  const onEnter = (i: number) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (i < columns.length - 1) {
      focusRow.current = i + 1;
      rerender((x) => x + 1); // ย้ายโฟกัสหลัง render
    } else add();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="wide" title={t("columnsTitle")}>
      <div className={styles.colEditor}>
        <label className={styles.colEditorName}>
          <span>{t("tableName")}</span>
          <input className={styles.mini} value={tableName} maxLength={500} onChange={(e) => onTableName(e.target.value)} />
        </label>
        <div className={styles.colGridWrap}>
          <table className={styles.colGrid}>
            <thead>
              <tr>
                <th aria-label={t("reorder")} />
                <th>{t("columnName")}</th>
                <th>{t("columnType")}</th>
                <th>{t("columnLengthFull")}</th>
                <th>{t("columnDefault")}</th>
                <th className={styles.colGridC}><span className={styles.colPk}>PK</span></th>
                <th className={styles.colGridC}><span className={styles.colFk}>FK</span></th>
                <th className={styles.colGridC} title="Unique"><span className={styles.colUq}>UQ</span></th>
                <th className={styles.colGridC}>NULL</th>
                <th aria-label={t("removeColumn")} />
              </tr>
            </thead>
            <tbody ref={body}>
              {columns.map((c, i) => {
                const pk = isPk(c);
                const fk = isFk(c);
                const custom = customRows.has(i) || (!!c.type && !isKnownType(c.type));
                const lengthOn = takesLength(c.type);
                const n = c.name || t("columnN", { n: i + 1 });
                return (
                  <tr
                    key={i}
                    className={cn(drag === i && styles.colDragging)}
                    onDragOver={(e) => { if (drag != null) e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); if (drag != null) move(drag, i); setDrag(null); }}
                  >
                    <td className={styles.colGrip} draggable onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDrag(null)} title={t("reorder")}>
                      <GripVertical size={14} aria-hidden />
                    </td>
                    <td><input data-col-name className={styles.mini} aria-label={t("columnName")} placeholder={t("columnName")} value={c.name} maxLength={80} onChange={(e) => edit(i, { name: e.target.value })} onKeyDown={onEnter(i)} /></td>
                    <td>
                      {custom ? (
                        <input className={styles.mini} autoFocus={customRows.has(i)} aria-label={t("columnType")} placeholder={t("columnTypeCustom")} value={c.type} maxLength={40} onChange={(e) => edit(i, { type: e.target.value })} onKeyDown={onEnter(i)}
                          onBlur={() => { if (customRows.has(i)) setCustomRows((s) => { const x = new Set(s); x.delete(i); return x; }); }} />
                      ) : (
                        <select className={styles.mini} aria-label={t("columnType")} value={c.type} onChange={(e) => {
                          if (e.target.value === CUSTOM) { setCustomRows((s) => new Set(s).add(i)); return; }
                          // ชนิดที่ไม่รับความยาว (int, uuid ฯลฯ) ล้างความยาวเดิมทิ้ง ไม่ให้ค้างเป็น int(20)
                          edit(i, { type: e.target.value, ...(takesLength(e.target.value) ? {} : { length: undefined }) });
                        }}>
                          <option value="">—</option>
                          {COLUMN_TYPE_GROUPS.map((g) => (
                            <optgroup key={g.key} label={t(`typeGroup.${g.key}`)}>
                              {g.types.map((x) => <option key={x} value={x}>{x}</option>)}
                            </optgroup>
                          ))}
                          <option value={CUSTOM}>{t("columnTypeOther")}</option>
                        </select>
                      )}
                    </td>
                    <td><input className={styles.mini} aria-label={t("columnLength")} title={t("columnLengthHint")} placeholder={lengthOn ? "20" : "—"} value={lengthOn ? (c.length ?? "") : ""} disabled={!lengthOn} maxLength={20} onChange={(e) => edit(i, { length: e.target.value || undefined })} onKeyDown={onEnter(i)} /></td>
                    <td><input className={cn(styles.mini, styles.monoInput)} aria-label={t("columnDefault")} title={t("columnDefaultHint")} placeholder={t("columnDefaultNone")} value={c.defaultValue ?? ""} maxLength={60} onChange={(e) => edit(i, { defaultValue: e.target.value || undefined })} onKeyDown={onEnter(i)} /></td>
                    <td className={styles.colGridC}>
                      {/* PK เป็น Unique และ NOT NULL อยู่แล้ว */}
                      <input type="checkbox" aria-label={`PK ${n}`} checked={pk} onChange={(e) => edit(i, { key: keyOf(e.target.checked, fk), ...(e.target.checked ? { nullable: undefined, unique: undefined } : {}) })} />
                    </td>
                    <td className={styles.colGridC}><input type="checkbox" aria-label={`FK ${n}`} checked={fk} onChange={(e) => edit(i, { key: keyOf(pk, e.target.checked) })} /></td>
                    <td className={styles.colGridC}><input type="checkbox" className={styles.uqCheck} aria-label={`Unique ${n}`} checked={!!c.unique && !pk} disabled={pk} title={pk ? t("pkIsUnique") : undefined} onChange={(e) => edit(i, { unique: e.target.checked || undefined })} /></td>
                    <td className={styles.colGridC}><input type="checkbox" aria-label={`NULL ${n}`} checked={!!c.nullable && !pk} disabled={pk} onChange={(e) => edit(i, { nullable: e.target.checked || undefined })} /></td>
                    <td><button type="button" className={styles.iconBtn} aria-label={t("removeColumnN", { name: n })} onClick={() => remove(i)}><X size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!columns.length && <p className={styles.hint}>{t("noColumns")}</p>}
        </div>
        <div className={styles.colEditorFoot}>
          <Button size="small" disabled={columns.length >= MAX_COLUMNS} onClick={add}><Plus size={14} /> {t("addColumn")}</Button>
          <span className={styles.colEditorKeys}>{t("columnKeys")}</span>
          <Button size="small" variant="primary" onClick={() => onOpenChange(false)}>{t("done")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
