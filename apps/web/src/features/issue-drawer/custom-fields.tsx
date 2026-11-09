'use client';
// ค่า Custom field ในหน้า Task / Sub-task (ชุดฟิลด์ของโปรเจกต์ · ผู้ใช้ตัดสิน 2026-11-09)
import { useTranslations } from 'next-intl';
import { Combobox, DatePicker, Input, Select } from '@/components/ui';
import { customModeOf, customText, type CustomFieldDef, type Level } from '@/lib/field-profile';
import { formatDate } from '@/lib/format';
import type { Person } from '@/lib/types';
import { PropRow } from './detail-parts';
import { InlineText } from './shared';
import styles from './issue-drawer.module.css';

/** Custom field ที่แสดงในระดับนี้ (ไม่ได้ซ่อน) */
export const visibleCustomFields = (fields: CustomFieldDef[] | undefined, level: Level) => (fields ?? []).filter((f) => customModeOf(f, level) !== 'hidden');

/** หน้าดูงาน: แก้ทีละฟิลด์แล้วบันทึกทันที · ตัวเลือกหลายค่าใช้ช่องติ๊ก */
export function CustomFieldRows({ fields, level, values, people, editable, busy, yearFormat, onSave }: {
  fields: CustomFieldDef[]; level: Level; values: Record<string, unknown>; people: Person[]; editable: boolean; busy: boolean; yearFormat: 'BE' | 'CE';
  onSave: (fieldId: string, value: unknown) => Promise<boolean>;
}) {
  const t = useTranslations('issue-drawer');
  return <>{fields.map((f) => {
    const value = values[f.id] ?? null;
    const label = `${f.name}${customModeOf(f, level) === 'required' ? ' *' : ''}`;
    const text = customText(f, value, people, (iso) => formatDate(iso, yearFormat));
    if (!editable) return <PropRow key={f.id} k={label}><span>{text || <span className="muted">—</span>}</span></PropRow>;
    const choices = f.options?.choices ?? [];
    let control;
    switch (f.fieldType) {
      case 'text':
      case 'number':
        control = <InlineText label={f.name} type={f.fieldType === 'number' ? 'number' : 'text'} step="any" multiline={f.fieldType === 'text'} value={value === null ? '' : String(value)} displayValue={text || undefined} enabled busy={busy}
          onSave={(next) => onSave(f.id, next.trim() === '' ? null : f.fieldType === 'number' ? Number(next) : next)} />;
        break;
      case 'date':
        control = <DatePicker compact label={f.name} value={typeof value === 'string' ? value : undefined} yearFormat={yearFormat} onValueChange={(next) => { if (!busy) void onSave(f.id, next || null); }} />;
        break;
      case 'select':
        control = <Select label={f.name} value={typeof value === 'string' ? value : ''} disabled={busy} onChange={(e) => void onSave(f.id, e.target.value || null)}>
          <option value="">{t('notSet')}</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>;
        break;
      case 'multi_select': {
        const picked = Array.isArray(value) ? (value as string[]) : [];
        control = <div className={styles.cfChoices} role="group" aria-label={f.name}>{choices.map((c) => <label key={c.id} className={styles.checkboxLabel}>
          <input type="checkbox" disabled={busy} checked={picked.includes(c.id)} onChange={(e) => void onSave(f.id, e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />{c.label}
        </label>)}</div>;
        break;
      }
      case 'user':
        control = <Select label={f.name} value={typeof value === 'string' ? value : ''} disabled={busy} onChange={(e) => void onSave(f.id, e.target.value || null)}>
          <option value="">{t('notSet')}</option>{people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </Select>;
        break;
    }
    return <PropRow key={f.id} k={label}>{control}</PropRow>;
  })}</>;
}

/** หน้าสร้างงาน: ค่าอยู่ในร่าง ส่งไปพร้อมงาน · ฟิลด์บังคับใส่ required ให้เบราว์เซอร์เตือนก่อนส่ง */
export function CustomFieldInputs({ fields, level, values, people, yearFormat, onChange }: {
  fields: CustomFieldDef[]; level: Level; values: Record<string, unknown>; people: Person[]; yearFormat: 'BE' | 'CE';
  onChange: (fieldId: string, value: unknown) => void;
}) {
  const t = useTranslations('issue-drawer');
  return <>{fields.map((f) => {
    const required = customModeOf(f, level) === 'required';
    const value = values[f.id];
    const label = `${f.name}${required ? ' *' : ''}`;
    const choices = f.options?.choices ?? [];
    let control;
    switch (f.fieldType) {
      case 'text':
        control = <Input label={f.name} required={required} maxLength={5000} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(f.id, e.target.value)} />;
        break;
      case 'number':
        control = <Input label={f.name} type="number" step="any" required={required} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(f.id, e.target.value)} />;
        break;
      case 'date':
        control = <DatePicker compact label={f.name} value={typeof value === 'string' && value ? value : undefined} yearFormat={yearFormat} onValueChange={(next) => onChange(f.id, next)} />;
        break;
      case 'select':
        control = <Select label={f.name} required={required} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(f.id, e.target.value)}>
          <option value="">{t('notSet')}</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>;
        break;
      case 'multi_select': {
        const picked = Array.isArray(value) ? (value as string[]) : [];
        control = <div className={styles.cfChoices} role="group" aria-label={f.name}>{choices.map((c) => <label key={c.id} className={styles.checkboxLabel}>
          <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => onChange(f.id, e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />{c.label}
        </label>)}</div>;
        break;
      }
      case 'user':
        control = <Combobox label={f.name} options={people} value={typeof value === 'string' && value ? [value] : []} onValueChange={(ids) => onChange(f.id, ids[0] ?? '')} />;
        break;
    }
    return <PropRow key={f.id} k={label}>{control}</PropRow>;
  })}</>;
}

/** ร่างของหน้าสร้างงาน → ค่าที่ส่ง API (ตัดค่าว่าง, ตัวเลขเป็น number) */
export function customPayload(fields: CustomFieldDef[], level: Level, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (customModeOf(f, level) === 'hidden') continue;
    const v = values[f.id];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[f.id] = f.fieldType === 'number' ? Number(v) : v;
  }
  return out;
}
