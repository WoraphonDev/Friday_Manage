"use client";

import type { ReactNode } from "react";
import { NextIntlClientProvider, useLocale, useMessages, useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ChevronDown, X } from "lucide-react";
import thMessages from "../../../messages/th/field-profile.json";
import enMessages from "../../../messages/en/field-profile.json";
import {
  PROFILE_FIELDS, REQUIRABLE, STANDARD_COLUMNS,
  type CustomFieldType, type FieldMode, type FieldRule, type Level, type ProfileField,
} from "@/lib/field-profile";
import styles from "./field-profile.module.css";

const MODES: FieldMode[] = ["optional", "required", "hidden"];
const LEVELS: Level[] = ["task", "subtask"];
/** ฟิลด์ → คอลัมน์ Table ที่ฟิลด์นั้นคุม (FR กับ Screen ใช้คอลัมน์เดียวกัน) */
const FIELD_COLUMNS: Record<ProfileField, string[]> = {
  ba: ["ba"], sa: ["sa"], reviewer: ["reviewer"], priority: ["priority"], size: ["size"], actual: ["actualStart", "actualEnd"],
  progress: ["progress"], requirements: ["refs"], screens: ["refs"], labels: ["labels"], remark: ["remark"],
};

/** Custom field ในตัวแก้ · key = `cf:<id>` (โปรเจกต์) หรือ `cf:<ชื่อ>` (Template ที่ยังไม่มี id) */
export interface EditorCustomField { key: string; name: string; fieldType: CustomFieldType; taskMode: FieldMode; subtaskMode: FieldMode }
export interface EditorValue { fields: Record<ProfileField, FieldRule>; columns: string[]; custom: EditorCustomField[] }

/** ข้อความของตัวแก้ใช้ร่วมกันหลายหน้า (Settings, Admin) · หน้าที่ไม่ได้โหลด namespace นี้ใช้ข้อความในไฟล์ตามภาษาของหน้า (EN ทับไทย) */
export function FieldProfileMessages({ children }: { children: ReactNode }) {
  const messages = useMessages();
  const locale = useLocale();
  if (messages["field-profile"]) return <>{children}</>;
  return <NextIntlClientProvider locale={locale} messages={{ ...messages, "field-profile": locale === "en" ? { ...thMessages, ...enMessages } : thMessages }}>{children}</NextIntlClientProvider>;
}

export function FieldProfileEditor(props: { value: EditorValue; onChange: (next: EditorValue) => void; disabled?: boolean }) {
  return <FieldProfileMessages><Editor {...props} /></FieldProfileMessages>;
}

function Editor({ value, onChange, disabled = false }: { value: EditorValue; onChange: (next: EditorValue) => void; disabled?: boolean }) {
  const t = useTranslations("field-profile");
  const hiddenBoth = (r: FieldRule) => r.task === "hidden" && r.subtask === "hidden";
  const columnName = (c: string) => c.startsWith("cf:") ? (value.custom.find((f) => f.key === c)?.name ?? c.slice(3)) : t(`columns.${c}`);
  /** คอลัมน์ที่เลือกได้ตอนนี้ (ฟิลด์ไม่ได้ซ่อนทั้งสองระดับ) */
  const columnUsable = (c: string, fields = value.fields, custom = value.custom) => {
    if (c.startsWith("cf:")) { const f = custom.find((x) => x.key === c); return !!f && !hiddenBoth({ task: f.taskMode, subtask: f.subtaskMode }); }
    const deps = STANDARD_COLUMNS[c];
    return deps === undefined ? false : !deps || deps.some((d) => !hiddenBoth(fields[d]));
  };
  const emit = (next: Partial<EditorValue>) => {
    const merged = { ...value, ...next };
    // ซ่อนฟิลด์ทั้งสองระดับแล้วคอลัมน์ของมันหายไปด้วย (API ทำแบบเดียวกัน)
    onChange({ ...merged, columns: merged.columns.filter((c) => columnUsable(c, merged.fields, merged.custom)) });
  };
  const setMode = (field: ProfileField, level: Level, mode: FieldMode) => emit({ fields: { ...value.fields, [field]: { ...value.fields[field], [level]: mode } } });
  const setCustomMode = (key: string, level: Level, mode: FieldMode) =>
    emit({ custom: value.custom.map((f) => (f.key === key ? { ...f, [level === "task" ? "taskMode" : "subtaskMode"]: mode } : f)) });
  const toggleColumns = (cols: string[], on: boolean) =>
    emit({ columns: on ? [...value.columns, ...cols.filter((c) => !value.columns.includes(c))] : value.columns.filter((c) => !cols.includes(c)) });
  const move = (index: number, delta: number) => {
    const next = [...value.columns];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    emit({ columns: next });
  };
  const addable = [...Object.keys(STANDARD_COLUMNS), ...value.custom.map((f) => f.key)].filter((c) => !value.columns.includes(c) && columnUsable(c));

  const modeSelect = (label: string, mode: FieldMode, onSelect: (m: FieldMode) => void, requirable: boolean) => (
    <span className="select">
      <select aria-label={label} value={mode} disabled={disabled} onChange={(e) => onSelect(e.target.value as FieldMode)}>
        {MODES.map((m) => <option key={m} value={m} disabled={m === "required" && !requirable} title={m === "required" && !requirable ? t("editor.notRequirable") : undefined}>{t(`modes.${m}`)}</option>)}
      </select>
      <ChevronDown className="select-chevron" size={16} aria-hidden="true" />
    </span>
  );
  const columnCheck = (label: string, cols: string[], usable: boolean) => (
    <input type="checkbox" aria-label={t("editor.showColumn", { field: label })} disabled={disabled || !usable} checked={usable && cols.every((c) => value.columns.includes(c))} onChange={(e) => toggleColumns(cols, e.target.checked)} />
  );

  return (
    <div className={styles.editor}>
      <p className={styles.muted}>{t("editor.hint")}</p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr><th>{t("editor.field")}</th>{LEVELS.map((l) => <th key={l}>{t(`levels.${l}`)}</th>)}<th>{t("editor.column")}</th></tr>
          </thead>
          <tbody>
            <tr className={styles.core}><td colSpan={4}><b>{t("editor.core")}</b> <span className={styles.muted}>{t("editor.coreList")}</span></td></tr>
            {PROFILE_FIELDS.map((f) => {
              const label = t(`fields.${f}`);
              const rule = value.fields[f];
              return (
                <tr key={f} data-testid={`field-row-${f}`}>
                  <td>{label}</td>
                  {LEVELS.map((l) => <td key={l}>{modeSelect(t("editor.modeOf", { field: label, level: t(`levels.${l}`) }), rule[l], (m) => setMode(f, l, m), REQUIRABLE.has(f))}</td>)}
                  <td className={styles.center}>{columnCheck(label, FIELD_COLUMNS[f], !hiddenBoth(rule))}</td>
                </tr>
              );
            })}
            <tr className={styles.core}><td colSpan={4}><b>{t("editor.custom")}</b>{!value.custom.length && <span className={styles.muted}> · {t("editor.noCustom")}</span>}</td></tr>
            {value.custom.map((f) => (
              <tr key={f.key} data-testid={`custom-row-${f.name}`}>
                <td>{f.name} <span className={styles.muted}>({t(`fieldTypes.${f.fieldType}`)})</span></td>
                {LEVELS.map((l) => <td key={l}>{modeSelect(t("editor.modeOf", { field: f.name, level: t(`levels.${l}`) }), l === "task" ? f.taskMode : f.subtaskMode, (m) => setCustomMode(f.key, l, m), true)}</td>)}
                <td className={styles.center}>{columnCheck(f.name, [f.key], !hiddenBoth({ task: f.taskMode, subtask: f.subtaskMode }))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.muted}>{t("editor.requiredNote")}</p>

      <div className={styles.order}>
        <b>{t("editor.order")}</b>
        <span className={styles.muted}>{t("editor.orderHint")}</span>
        {!value.columns.length && <span className={styles.muted}>{t("editor.noColumns")}</span>}
        <ol className={styles.list} aria-label={t("editor.order")}>
          {value.columns.map((c, i) => (
            <li key={c} className={styles.item}>
              <span className={styles.num}>{i + 1}.</span>
              <span className={styles.grow}>{columnName(c)}</span>
              <button type="button" className={styles.icon} aria-label={t("editor.up", { name: columnName(c) })} disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
              <button type="button" className={styles.icon} aria-label={t("editor.down", { name: columnName(c) })} disabled={disabled || i === value.columns.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              <button type="button" className={styles.icon} aria-label={t("editor.showColumn", { field: columnName(c) })} disabled={disabled} onClick={() => toggleColumns([c], false)}><X size={14} /></button>
            </li>
          ))}
        </ol>
        {addable.length > 0 && (
          <span className="select" style={{ maxWidth: 260 }}>
            <select aria-label={t("values.choose")} value="" disabled={disabled} onChange={(e) => { if (e.target.value) toggleColumns([e.target.value], true); }}>
              <option value="">+ {t("editor.column")}</option>
              {addable.map((c) => <option key={c} value={c}>{columnName(c)}</option>)}
            </select>
            <ChevronDown className="select-chevron" size={16} aria-hidden="true" />
          </span>
        )}
      </div>
    </div>
  );
}

/** ชื่อ Template ที่โปรเจกต์ใช้ (แสดงในหัวข้อชุดฟิลด์) */
export function TemplateSource({ template }: { template?: { name: string } | null }) {
  return <FieldProfileMessages><Source template={template} /></FieldProfileMessages>;
}
function Source({ template }: { template?: { name: string } | null }) {
  const t = useTranslations("field-profile.editor");
  return <span className={styles.muted}>{template ? t("from", { name: template.name }) : t("fromNone")}</span>;
}
