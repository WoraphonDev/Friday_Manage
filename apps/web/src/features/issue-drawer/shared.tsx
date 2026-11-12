'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'next-intl';
import { ApiError, isConfirmCancelled, supportId } from '@/lib/api';
import { Avatar, Button, Input } from '@/components/ui';
import type { PublicPerson } from './types';
import styles from './issue-drawer.module.css';
import { intlLocale } from '@/lib/format';
import { forDisplay } from './mentions';
import { remarkSoftBreaks } from '@/lib/soft-breaks';

export function BodyText({ children }: { children: string }) {
  return <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm, remarkSoftBreaks]} skipHtml components={{
    a: ({ href, children }) => /^[\da-f-]{36}$/i.test(href ?? '') ? <span className={styles.mention}>{children}</span> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ src, alt }) => <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" />,
  }}>{forDisplay(children)}</Markdown></div>;
}
export function Failure({ error }: { error: unknown }) {
  const t = useTranslations('issue-drawer');
  // ผู้ใช้กดยกเลิกในกล่องยืนยันกลางเอง ไม่ใช่ข้อผิดพลาด
  if (isConfirmCancelled(error)) return null;
  return <div role="alert" className={styles.error}><span>{error instanceof Error ? error.message : t('error')}</span>{error instanceof ApiError && supportId(error) && <code>{t('requestId', { id: supportId(error) ?? "" })}</code>}</div>;
}
export function PersonView({ person }: { person: PublicPerson | null }) {
  const t = useTranslations('issue-drawer');
  return <span className={styles.person}>{person && <Avatar size="small" person={{ ...person, id: person.id ?? 'hidden-team' }} />}<span>{person?.displayName ?? t('system')}</span></span>;
}
export function InlineText({ label, value, enabled, multiline = false, type = 'text', min, max, step, displayValue, busy, onSave }: {
  label: string; value: string; enabled: boolean; multiline?: boolean; type?: string; min?: string | number; max?: string | number; step?: string | number; displayValue?: string; busy?: boolean; onSave: (value: string) => Promise<boolean>;
}) {
  const t = useTranslations('issue-drawer');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (editing && draft === value) setEditing(false); }, [value]);
  async function save() { if (await onSave(draft)) setEditing(false); }
  if (!editing) return <div className={styles.inlineField}>{!displayValue && <span className={styles.label}>{label}</span>}<button className={displayValue ? `${styles.editValue} ${styles.editAction}` : styles.editValue} disabled={!enabled || busy} onClick={() => { setDraft(value); setEditing(true); }}>{displayValue ?? (value || t('notSet'))}</button></div>;
  return <form className={multiline ? styles.inlineField : `${styles.inlineField} ${styles.inlineRow}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    {multiline ? <label className="field">{label}<textarea className="input" autoFocus value={draft} maxLength={50000} onChange={(event) => setDraft(event.target.value)} disabled={busy} /></label> : <Input label={label} autoFocus type={type} min={min} max={max} step={step} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} />}
    <div className={styles.actions}><Button size="small" type="submit" variant="primary" disabled={busy}>{t('save')}</Button><Button size="small" disabled={busy} onClick={() => setEditing(false)}>{t('cancel')}</Button></div>
  </form>;
}
export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className={styles.section}><div className={styles.sectionHeading}><h3>{title}</h3>{action}</div>{children}</section>;
}
export function when(value: string, yearFormat: 'BE' | 'CE') {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(intlLocale(yearFormat), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }).format(date);
}
