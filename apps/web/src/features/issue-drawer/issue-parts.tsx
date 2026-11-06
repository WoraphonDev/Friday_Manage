'use client';
import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Button, Input, Select, EmptyState, ErrorState, LoadingState, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure, Section } from './shared';
import { issuePath, issueQuery, type ChecklistItem, type Dependencies, type Scope } from './types';
import styles from './issue-drawer.module.css';

export function Checklist({ scope, issueKey }: { scope: Scope; issueKey: string }) {
  const t = useTranslations('issue-drawer');
  const cache = useQueryClient();
  const endpoint = `${issuePath(scope.ws, issueKey)}/checklist`;
  const queryKey = [...issueQuery(scope.ws, issueKey), 'checklist'];
  const query = useQuery({ queryKey, queryFn: () => api.get<{ items: ChecklistItem[] }>(endpoint) });
  const [text, setText] = useState('');
  const [kind, setKind] = useState('checklist');
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  async function change(action: () => Promise<unknown>, success?: () => void) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { await action(); success?.(); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issueKey) }); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  const items = query.data.items;
  const done = items.filter((item) => item.done).length;
  return <div className={styles.stack}>
    <Section title={t('checklistProgress', { done, total: items.length })}>
      <progress className={styles.progress} value={done} max={Math.max(1, items.length)} aria-label={t('checklist')} />
      {items.length === 0 && <p className="muted">{t('noChecklist')}</p>}
      {items.map((item, index) => <div key={item.id} className={styles.checkRow}>
        <input type="checkbox" checked={item.done} aria-label={item.text} disabled={pending} onChange={(event) => void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { done: event.target.checked } }))} />
        {edit?.id === item.id ? <form className={styles.grow} onSubmit={(event) => { event.preventDefault(); void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { text: edit.text } }), () => setEdit(null)); }}><Input aria-label={t('checklistText')} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} required maxLength={5000} /><Button type="submit" size="small" disabled={pending}>{t('save')}</Button><Button size="small" onClick={() => setEdit(null)}>{t('cancel')}</Button></form>
          : <button className={`${styles.checkText} ${item.done ? styles.checked : ''}`} onClick={() => setEdit({ id: item.id, text: item.text })}>{item.text}<small>{t(item.kind)}{item.doneAt && ` · ${formatDate(item.doneAt, scope.yearFormat)}`}</small></button>}
        <div className={styles.actions}>
          <Button variant="ghost" size="icon" aria-label={t('itemUp', { text: item.text })} disabled={pending || index === 0} onClick={() => { const ids = items.map((value) => value.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); }}><ArrowUp size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('itemDown', { text: item.text })} disabled={pending || index === items.length - 1} onClick={() => { const ids = items.map((value) => value.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); }}><ArrowDown size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('deleteChecklist', { text: item.text })} disabled={pending} onClick={() => void change(() => api.delete(`${endpoint}/${item.id}`))}><Trash2 size={14} /></Button>
        </div>
      </div>)}
    </Section>
    <form className={styles.addRow} onSubmit={(event) => { event.preventDefault(); void change(() => api.post(endpoint, { text, kind }), () => setText('')); }}>
      <Input label={t('checklistText')} required maxLength={5000} value={text} onChange={(event) => setText(event.target.value)} disabled={pending} />
      <Select label={t('kind')} value={kind} onChange={(event) => setKind(event.target.value)} disabled={pending}><option value="checklist">{t('checklist')}</option><option value="acceptance">{t('acceptance')}</option></Select>
      <Button type="submit" disabled={pending || !text.trim()}>{t('add')}</Button>
    </form>
    {!!error && <Failure error={error} />}
  </div>;
}

export function DependencyPanel({ scope, issueKey }: { scope: Scope; issueKey: string }) {
  const t = useTranslations('issue-drawer');
  const cache = useQueryClient();
  const toast = useToast();
  const endpoint = `${issuePath(scope.ws, issueKey)}/dependencies`;
  const queryKey = [...issueQuery(scope.ws, issueKey), 'dependencies'];
  const query = useQuery({ queryKey, queryFn: () => api.get<Dependencies>(endpoint) });
  const [key, setKey] = useState('');
  const [direction, setDirection] = useState<'predecessorKey' | 'successorKey'>('predecessorKey');
  const [type, setType] = useState('FS');
  const [lagDays, setLagDays] = useState('0');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  async function change(action: () => Promise<Dependencies>) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { const result = await action(); setKey(''); result.warnings?.forEach((warning) => toast({ message: warning.message })); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issueKey) }); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  return <div className={styles.stack}>
    {(['blockedBy', 'blocking'] as const).map((side) => <Section title={t(side)} key={side}>
      {query.data[side].length === 0 && <p className="muted">{t('noDependencies')}</p>}
      {query.data[side].map((item) => <div className={styles.dependency} key={item.key}>
        <button className={styles.issueLink} onClick={() => scope.navigate(item.key)}><strong>{item.key}</strong> {item.title}<small>{item.status.name} · {item.type} · {t('lagValue', { days: item.lagDays })}{item.planEnd && ` · ${formatDate(item.planEnd, scope.yearFormat)}`}</small></button>
        <Button variant="ghost" size="icon" disabled={pending} aria-label={t('removeDependency', { key: item.key })} onClick={() => void change(() => api.delete<Dependencies>(endpoint, { body: { [side === 'blockedBy' ? 'predecessorKey' : 'successorKey']: item.key } }))}><Trash2 size={14} /></Button>
      </div>)}
    </Section>)}
    <form className={styles.formGrid} onSubmit={(event) => { event.preventDefault(); void change(() => api.post<Dependencies>(endpoint, { [direction]: key.trim(), type, lagDays: Number(lagDays) })); }}>
      <Input label={t('dependencyKey')} required pattern="[A-Za-z][A-Za-z0-9]{1,9}-[0-9]+" value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} />
      <Select label={t('direction')} value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="predecessorKey">{t('blockedBy')}</option><option value="successorKey">{t('blocking')}</option></Select>
      <Select label={t('dependencyType')} value={type} onChange={(event) => setType(event.target.value)}>{['FS', 'SS', 'FF', 'SF'].map((value) => <option key={value}>{value}</option>)}</Select>
      <Input type="number" label={t('lagDays')} value={lagDays} min={-32768} max={32767} step={1} required onChange={(event) => setLagDays(event.target.value)} />
      <Button type="submit" disabled={pending}>{t('addDependency')}</Button>
    </form>
    {!!error && <Failure error={error} />}
  </div>;
}
