'use client';
import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Button, Input, Select, EmptyState, ErrorState, LoadingState, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure } from './shared';
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
  // Canvas C: Acceptance criteria และ Checklist แยกหัวข้อ · ปุ่มเลื่อน/ลบแสดงเมื่อชี้ · เพิ่มด้วยช่องเส้นประ
  const row = (item: ChecklistItem, index: number) => <div key={item.id} className={styles.checkRow}>
        <input type="checkbox" checked={item.done} aria-label={item.text} disabled={pending} onChange={(event) => void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { done: event.target.checked } }))} />
        {edit?.id === item.id ? <form className={styles.grow} onSubmit={(event) => { event.preventDefault(); void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { text: edit.text } }), () => setEdit(null)); }}><Input aria-label={t('checklistText')} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} required maxLength={5000} /><Button type="submit" size="small" disabled={pending}>{t('save')}</Button><Button size="small" onClick={() => setEdit(null)}>{t('cancel')}</Button></form>
          : <button className={`${styles.checkText} ${item.done ? styles.checked : ''}`} onClick={() => setEdit({ id: item.id, text: item.text })}>{item.text}<small>{t(item.kind)}{item.doneAt && ` · ${formatDate(item.doneAt, scope.yearFormat)}`}</small></button>}
        <div className={styles.actions}>
          <Button variant="ghost" size="icon" aria-label={t('itemUp', { text: item.text })} disabled={pending || index === 0} onClick={() => { const ids = items.map((value) => value.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); }}><ArrowUp size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('itemDown', { text: item.text })} disabled={pending || index === items.length - 1} onClick={() => { const ids = items.map((value) => value.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); }}><ArrowDown size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('deleteChecklist', { text: item.text })} disabled={pending} onClick={() => void change(() => api.delete(`${endpoint}/${item.id}`))}><Trash2 size={14} /></Button>
        </div>
      </div>;
  const groups = (['acceptance', 'checklist'] as const).map((kindName) => ({ kindName, rows: items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === kindName) }));
  return <div className={styles.stack} style={{ gap: 10 }}>
    {groups.filter((g) => g.rows.length).map((g) => <div key={g.kindName} className={styles.checkGroup}>
      <div className={styles.checkHead}>{g.kindName === 'acceptance' ? t('acceptance') : t('checklistProgress', { done: g.rows.filter(({ item }) => item.done).length, total: g.rows.length })}</div>
      {g.rows.map(({ item, index }) => row(item, index))}
    </div>)}
    {items.length === 0 && <p className="muted">{t('noChecklist')}</p>}
    <span className="sr-only" role="status">{t('checklistProgress', { done, total: items.length })}</span>
    <form className={styles.quickAdd} onSubmit={(event) => { event.preventDefault(); void change(() => api.post(endpoint, { text, kind }), () => setText('')); }}>
      <input className={styles.dashed} aria-label={t('checklistText')} placeholder={t('addChecklistPlaceholder')} required maxLength={5000} value={text} onChange={(event) => setText(event.target.value)} disabled={pending} />
      <select className={styles.kindSelect} aria-label={t('kind')} value={kind} onChange={(event) => setKind(event.target.value)} disabled={pending}><option value="checklist">{t('checklist')}</option><option value="acceptance">{t('acceptance')}</option></select>
      <Button type="submit" size="small" disabled={pending || !text.trim()}>{t('add')}</Button>
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
  const [adding, setAdding] = useState(false);
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
  // Canvas C: แถว "Blocked by / Blocks" เป็นชิป · ฟอร์มเพิ่มเปิดจากปุ่ม
  return <div className={styles.stack} style={{ gap: 6 }}>
    {(['blockedBy', 'blocking'] as const).map((side) => <div className={styles.depRow} key={side}>
      <span className={styles.k}>{t(side)}</span>
      <div className={styles.chips}>
        {query.data[side].length === 0 && <span className="muted">{t('noDependencies')}</span>}
        {query.data[side].map((item) => <span className={`${styles.depChip} ${item.status.category === 'done' ? styles.sDone : item.status.category === 'in_progress' ? styles.sProg : styles.sTodo}`} key={item.key}>
          <button className={styles.depLink} onClick={() => scope.navigate(item.key)} title={`${item.status.name} · ${item.type} · ${t('lagValue', { days: item.lagDays })}`}>{item.key} {item.title}{item.planEnd && ` · ${formatDate(item.planEnd, scope.yearFormat)}`}</button>
          <button className={styles.chipX} disabled={pending} aria-label={t('removeDependency', { key: item.key })} onClick={() => void change(() => api.delete<Dependencies>(endpoint, { body: { [side === 'blockedBy' ? 'predecessorKey' : 'successorKey']: item.key } }))}><Trash2 size={12} /></button>
        </span>)}
      </div>
    </div>)}
    {!adding ? <Button size="small" variant="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>{t('addDependency')}</Button> : <form className={styles.formGrid} onSubmit={(event) => { event.preventDefault(); void change(() => api.post<Dependencies>(endpoint, { [direction]: key.trim(), type, lagDays: Number(lagDays) })); }}>
      <Input label={t('dependencyKey')} required pattern="[A-Za-z][A-Za-z0-9]{1,9}-[0-9]+" value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} />
      <Select label={t('direction')} value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="predecessorKey">{t('blockedBy')}</option><option value="successorKey">{t('blocking')}</option></Select>
      <Select label={t('dependencyType')} value={type} onChange={(event) => setType(event.target.value)}>{['FS', 'SS', 'FF', 'SF'].map((value) => <option key={value}>{value}</option>)}</Select>
      <Input type="number" label={t('lagDays')} value={lagDays} min={-32768} max={32767} step={1} required onChange={(event) => setLagDays(event.target.value)} />
      <Button type="submit" disabled={pending}>{t('addDependency')}</Button>
    </form>}
    {!!error && <Failure error={error} />}
  </div>;
}
