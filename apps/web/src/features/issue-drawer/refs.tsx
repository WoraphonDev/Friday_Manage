'use client';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { Named } from './types';
import styles from './issue-drawer.module.css';

/** รูปแบบเดียวกับ API (FR-02.3, NFR-01, SCR-203) · ตรวจก่อนส่งเพื่อบอกผู้ใช้ทันที */
export const REQUIREMENT_CODE = /^N?FR-[A-Z0-9][A-Z0-9._-]{0,30}$/;
export const SCREEN_CODE = /^SCR-[A-Z0-9][A-Z0-9._-]{0,30}$/;

type Kind = 'requirement' | 'screen';
const PATTERN: Record<Kind, RegExp> = { requirement: REQUIREMENT_CODE, screen: SCREEN_CODE };

/** ชิปรหัส + ปุ่ม "+ FR / NFR" / "+ Screen" (Canvas B › Requirement, C › Requirement / Screen) */
export function CodeChips({ kinds, values, suggestions, editable, busy, onChange }: {
  kinds: Kind[];
  values: Record<Kind, string[]>;
  suggestions?: Partial<Record<Kind, string[]>>;
  editable: boolean;
  busy?: boolean;
  onChange: (kind: Kind, codes: string[]) => void;
}) {
  const t = useTranslations('issue-drawer.refs');
  const [adding, setAdding] = useState<Kind | null>(null);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const listId = useId();
  const chips = kinds.flatMap((kind) => values[kind].map((code) => ({ kind, code })));
  function commit(kind: Kind) {
    const code = text.trim().toUpperCase();
    if (!code) { setAdding(null); return; }
    if (!PATTERN[kind].test(code)) { setInvalid(true); return; }
    if (!values[kind].includes(code)) onChange(kind, [...values[kind], code]);
    setText(''); setInvalid(false); setAdding(null);
  }
  if (!editable && !chips.length) return <span className="muted">—</span>;
  return <div className={styles.refChips}>
    {chips.map(({ kind, code }) => <span key={`${kind}-${code}`} className={styles.chipx}>{code}
      {editable && <button type="button" className={styles.chipxX} disabled={busy} aria-label={t('remove', { code })} onClick={() => onChange(kind, values[kind].filter((value) => value !== code))}><X size={12} aria-hidden="true" /></button>}
    </span>)}
    {editable && (adding ? <span className={styles.refAdd}>
      <input className={`input ${styles.refInput}`} autoFocus list={listId} aria-label={t(`${adding}Input`)} placeholder={t(`${adding}Placeholder`)} aria-invalid={invalid || undefined} value={text} disabled={busy}
        onChange={(event) => { setText(event.target.value); setInvalid(false); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(adding); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setText(''); setInvalid(false); setAdding(null); }
        }}
        onBlur={() => { if (!text.trim()) setAdding(null); }} />
      <datalist id={listId}>{(suggestions?.[adding] ?? []).filter((code) => !values[adding].includes(code)).map((code) => <option key={code} value={code} />)}</datalist>
      {invalid && <span className="field-error" role="alert">{t(`${adding}Invalid`)}</span>}
    </span> : kinds.map((kind) => <button key={kind} type="button" className={styles.prb} disabled={busy} onClick={() => { setAdding(kind); setText(''); setInvalid(false); }}>{t(`add_${kind}`)}</button>))}
  </div>;
}

/** Label ของโปรเจกต์: ชิปสี + "+ Label" เลือกจากรายการที่ตั้งใน Settings */
export function LabelChips({ options, value, editable, busy, onChange }: {
  options: Named[]; value: string[]; editable: boolean; busy?: boolean; onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('issue-drawer.refs');
  const [adding, setAdding] = useState(false);
  const chosen = value.map((id) => options.find((label) => label.id === id) ?? { id, name: id, color: null });
  const rest = options.filter((label) => !value.includes(label.id));
  if (!editable && !chosen.length) return <span className="muted">—</span>;
  return <div className={styles.refChips}>
    {chosen.map((label) => <span key={label.id} className={styles.chipx} style={label.color ? { borderColor: label.color, color: label.color } : undefined}>{label.name}
      {editable && <button type="button" className={styles.chipxX} disabled={busy} aria-label={t('remove', { code: label.name })} onClick={() => onChange(value.filter((id) => id !== label.id))}><X size={12} aria-hidden="true" /></button>}
    </span>)}
    {editable && (adding
      ? <select className={`input ${styles.refInput}`} autoFocus aria-label={t('labelInput')} defaultValue="" disabled={busy}
          onChange={(event) => { if (event.target.value) onChange([...value, event.target.value]); setAdding(false); }}
          onBlur={() => setAdding(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setAdding(false); } }}>
          <option value="" disabled>{t('chooseLabel')}</option>
          {rest.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
        </select>
      : rest.length > 0
        ? <button type="button" className={styles.prb} disabled={busy} onClick={() => setAdding(true)}>{t('add_label')}</button>
        : !options.length && <span className="muted" style={{ fontSize: 11 }}>{t('noLabels')}</span>)}
  </div>;
}
