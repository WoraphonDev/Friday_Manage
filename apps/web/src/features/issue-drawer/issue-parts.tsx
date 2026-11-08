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
import { IssuePicker, useProjectIssues } from './task-v2';
import styles from './issue-drawer.module.css';

export function Checklist({ scope, issueKey }: { scope: Scope; issueKey: string }) {
  const t = useTranslations('issue-drawer');
  const canEdit = !scope.access.guestViewer && scope.access.permissions.includes('issue.edit') && scope.project?.status !== 'archived';
  const cache = useQueryClient();
  const endpoint = `${issuePath(scope.ws, issueKey)}/checklist`;
  const queryKey = [...issueQuery(scope.ws, issueKey), 'checklist'];
  const query = useQuery({ queryKey, queryFn: () => api.get<{ items: ChecklistItem[] }>(endpoint) });
  // ช่องเพิ่มแยกต่อกล่อง: พิมพ์ในกล่องไหน รายการเป็นประเภทนั้น (ผู้ใช้ขอ 2026-11-08)
  const [texts, setTexts] = useState<Record<'acceptance' | 'checklist', string>>({ acceptance: '', checklist: '' });
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  async function change(action: () => Promise<unknown>, success?: () => void) {
    if (!canEdit || lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { await action(); success?.(); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issueKey) }); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  const items = query.data.items;
  const done = items.filter((item) => item.done).length;
  // C2: Acceptance criteria (เกณฑ์ที่ QA / Reviewer ตรวจ) และ Checklist (ขั้นตอนของผู้ทำงาน) แสดงสองกล่องเสมอ
  const fitHeight = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  const doneByName = (id: string | null) => (id ? scope.people.find((person) => person.id === id)?.displayName ?? null : null);
  const row = (item: ChecklistItem, index: number) => { const editing = canEdit && edit?.id === item.id; return <div key={item.id} className={`${styles.checkRow} ${editing ? styles.checkRowEditing : ''}`}>
        <input type="checkbox" checked={item.done} aria-label={item.text} disabled={pending || !canEdit} onChange={(event) => void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { done: event.target.checked } }))} />
        <span className={`${styles.kindTag} ${item.kind === 'acceptance' ? styles.kindAcceptance : styles.kindChecklist}`}>{item.kind === 'acceptance' ? 'Acceptance' : 'Checklist'}</span>
        {editing && edit ? <form className={styles.checkEdit} onSubmit={(event) => { event.preventDefault(); if (edit.text.trim()) void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { text: edit.text.trim() } }), () => setEdit(null)); }}>
            {/* แก้ในแถวเดิม: ช่องสูงตามข้อความ (ข้อความยาวไม่ถูกซ่อน) · Enter บันทึก · Shift+Enter ขึ้นบรรทัดใหม่ · Esc ยกเลิก */}
            <textarea className="input" rows={1} autoFocus aria-label={t('checklistText')} value={edit.text} ref={fitHeight}
              onChange={(event) => { setEdit({ ...edit, text: event.target.value }); fitHeight(event.target); }}
              onFocus={(event) => event.target.setSelectionRange(event.target.value.length, event.target.value.length)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); setEdit(null); }
                // ไม่บันทึกระหว่างพิมพ์ภาษาไทยผ่าน IME ที่ยังไม่จบคำ
                else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
              }}
              required maxLength={5000} disabled={pending} />
            <Button type="submit" size="small" variant="primary" disabled={pending || !edit.text.trim()}>{t('save')}</Button>
            <Button size="small" onClick={() => setEdit(null)} disabled={pending}>{t('cancel')}</Button>
          </form>
          : <button disabled={!canEdit} className={styles.checkText} onClick={() => setEdit({ id: item.id, text: item.text })}>
            {/* ขีดฆ่าเฉพาะข้อความ · คนติ๊กและวันที่ไม่ขีดฆ่า */}
            <span className={item.done ? styles.checked : undefined}>{item.text}</span>
            {item.done && item.doneAt && <small className={styles.checkMeta}>{doneByName(item.doneBy) ? t('checkDoneBy', { name: doneByName(item.doneBy)!, date: formatDate(item.doneAt, scope.yearFormat) }) : formatDate(item.doneAt, scope.yearFormat)}</small>}
          </button>}
        {canEdit && !editing && <div className={styles.actions}>
          <Button variant="ghost" size="icon" aria-label={t('itemUp', { text: item.text })} disabled={pending || index === 0} onClick={() => { const ids = items.map((value) => value.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); }}><ArrowUp size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('itemDown', { text: item.text })} disabled={pending || index === items.length - 1} onClick={() => { const ids = items.map((value) => value.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); }}><ArrowDown size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('deleteChecklist', { text: item.text })} disabled={pending} onClick={() => void change(() => api.delete(`${endpoint}/${item.id}`))}><Trash2 size={14} /></Button>
        </div>}
      </div>; };
  const box = (kindName: 'acceptance' | 'checklist') => {
    const rows = items.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === kindName);
    const doneCount = rows.filter(({ item }) => item.done).length;
    return <section key={kindName} className={`${styles.checkBox} ${kindName === 'acceptance' ? styles.checkBoxAcceptance : ''}`} aria-label={t(kindName === 'acceptance' ? 'acceptance' : 'checklist')}>
      <h4 className={styles.checkHead}>{t(kindName === 'acceptance' ? 'acceptance' : 'checklist')} <span className="muted">{doneCount}/{rows.length}</span><span className={styles.checkHint}>{t(kindName === 'acceptance' ? 'acceptanceHint' : 'checklistHint')}</span></h4>
      {kindName === 'acceptance' && rows.length > 0 && <p className={styles.checkWarn}>{t('acceptanceDoneRule')}</p>}
      {rows.map(({ item, index }) => row(item, index))}
      {rows.length === 0 && !canEdit && <p className="muted">{t(kindName === 'acceptance' ? 'noAcceptance' : 'noChecklist')}</p>}
      {canEdit && <form className={styles.quickAdd} onSubmit={(event) => { event.preventDefault(); const text = texts[kindName].trim(); if (text) void change(() => api.post(endpoint, { text, kind: kindName }), () => setTexts((all) => ({ ...all, [kindName]: '' }))); }}>
        <input className={styles.dashed} aria-label={t(kindName === 'acceptance' ? 'addAcceptance' : 'addChecklist')} placeholder={t(kindName === 'acceptance' ? 'addAcceptancePlaceholder' : 'addChecklistPlaceholder')} maxLength={5000} value={texts[kindName]} onChange={(event) => setTexts((all) => ({ ...all, [kindName]: event.target.value }))} disabled={pending} />
        <Button type="submit" size="small" disabled={pending || !texts[kindName].trim()}>{t('add')}</Button>
      </form>}
    </section>;
  };
  return <div className={styles.stack} style={{ gap: 10 }}>
    {box('acceptance')}{box('checklist')}
    <span className="sr-only" role="status">{t('checklistProgress', { done, total: items.length })}</span>
    {!!error && <Failure error={error} />}
  </div>;
}

export function DependencyPanel({ scope, issueKey }: { scope: Scope; issueKey: string }) {
  const t = useTranslations('issue-drawer');
  const canEdit = !scope.access.guestViewer && scope.access.permissions.includes('issue.edit') && scope.project?.status !== 'archived';
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
  const projectIssues = useProjectIssues(scope, adding);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  async function change(action: () => Promise<Dependencies>) {
    if (!canEdit || lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { const result = await action(); setKey(''); result.warnings?.forEach((warning) => toast({ message: warning.message })); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issueKey) }); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  // Canvas C: แถว "Blocked by / Blocks" เป็นชิป · ฟอร์มเพิ่มเปิดจากปุ่ม
  // ยังไม่มีทั้งสองฝั่ง: ย่อเหลือบรรทัดเดียว ไม่ต้องแสดงสองแถวว่าง
  const none = !query.data.blockedBy.length && !query.data.blocking.length && !adding;
  if (none) return <div className={styles.emptyLine}><span className="muted">{t('noDependenciesYet')}</span>{canEdit && <Button size="small" variant="ghost" className={styles.addAction} onClick={() => setAdding(true)}>{t('addDependency')}</Button>}</div>;
  return <div className={styles.stack} style={{ gap: 6 }}>
    {(['blockedBy', 'blocking'] as const).map((side) => <div className={styles.depRow} key={side}>
      <span className={styles.k}>{t(side)}</span>
      <div className={styles.chips}>
        {query.data[side].length === 0 && <span className="muted">{t('noDependencies')}</span>}
        {query.data[side].map((item) => <span className={`${styles.depChip} ${item.status.category === 'done' ? styles.sDone : item.status.category === 'in_progress' ? styles.sProg : styles.sTodo}`} key={item.key}>
          <button className={styles.depLink} onClick={() => scope.navigate(item.key)} title={`${item.status.name} · ${item.type} · ${t('lagValue', { days: item.lagDays })}`}>{item.key} {item.title}{item.planEnd && ` · ${formatDate(item.planEnd, scope.yearFormat)}`}</button>
          {canEdit && <button className={styles.chipX} disabled={pending} aria-label={t('removeDependency', { key: item.key })} onClick={() => void change(() => api.delete<Dependencies>(endpoint, { body: { [side === 'blockedBy' ? 'predecessorKey' : 'successorKey']: item.key } }))}><Trash2 size={12} /></button>}
        </span>)}
      </div>
    </div>)}
    {canEdit && (!adding ? <Button size="small" variant="ghost" className={styles.addAction} style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>{t('addDependency')}</Button> : <form className={styles.formGrid} onSubmit={(event) => { event.preventDefault(); void change(() => api.post<Dependencies>(endpoint, { [direction]: key.trim(), type, lagDays: Number(lagDays) })); }}>
      {/* C2: ค้นหาด้วยรหัสหรือชื่องาน แทนการพิมพ์รหัสเอง */}
      <div className="field"><span className={styles.fieldLabel}>{t('dependencyKey')}</span><IssuePicker label={t('dependencyKey')} value={key || null} issues={(projectIssues.data?.items ?? []).filter((item) => item.key !== issueKey)} onChange={setKey} placeholder={t('searchIssue')} /></div>
      <Select label={t('direction')} value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="predecessorKey">{t('blockedBy')}</option><option value="successorKey">{t('blocking')}</option></Select>
      <Select label={t('dependencyType')} value={type} onChange={(event) => setType(event.target.value)}>{['FS', 'SS', 'FF', 'SF'].map((value) => <option key={value}>{value}</option>)}</Select>
      <Input type="number" label={t('lagDays')} value={lagDays} min={-32768} max={32767} step={1} required onChange={(event) => setLagDays(event.target.value)} />
      <Button type="submit" disabled={pending || !key}>{t('addDependency')}</Button>
    </form>)}
    {!!error && <Failure error={error} />}
  </div>;
}
