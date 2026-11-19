'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { Button, Input, Select, EmptyState, ErrorState, LoadingState, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure } from './shared';
import { issuePath, issueQuery, type ChecklistItem, type Dependencies, type Scope } from './types';
import { IssuePicker, useProjectIssues } from './task-v2';
import styles from './issue-drawer.module.css';
import { statusTone } from '@/lib/status';

type CheckKind = 'acceptance' | 'checklist';
// ข้อที่เพิ่งติ๊กค้างที่เดิมแบบขีดฆ่าก่อน (เห็นทันถ้ากดผิด) แล้วค่อยเลื่อนลงกลุ่มที่เสร็จ · ความเร็วตามชุดกลาง --motion-dur
const SETTLE_HOLD_MS = 700;
const SETTLE_LEAVE_MS = 550;
const foldKey = (kind: CheckKind) => `friday:checklist-done-open:${kind}`;

/** ข้อความยาวเกิน 2 บรรทัดตัดไว้ · ปุ่ม "เพิ่มเติม" แสดงเฉพาะเมื่อถูกตัดจริง
 *  บอกตำแหน่งท้ายบรรทัดที่ 2 ให้กรอบแถว (--clamp-end) เพื่อวางปุ่มต่อจาก "…" (ผู้ใช้ขอ 2026-11-19) · ปุ่มซ้อนในปุ่มข้อความไม่ได้ จึงวางทับแทน */
function useClamped(expanded: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => {
      setOverflow(el.scrollHeight > el.clientHeight + 1);
      el.closest<HTMLElement>('[data-check-body]')?.style.setProperty('--clamp-end', `${el.offsetTop + el.offsetHeight}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  return { ref, overflow };
}

function CheckText({ text, done, expanded, className }: { text: string; done: boolean; expanded: boolean; className?: string }) {
  const { ref, overflow } = useClamped(expanded);
  return <span ref={ref} data-overflow={overflow || undefined} className={[done ? className : undefined, expanded ? undefined : styles.clamp2].filter(Boolean).join(' ') || undefined}>{text}</span>;
}

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
  // แบบ C (ผู้ใช้เลือก 2026-11-19): ข้อที่เสร็จพับไว้ท้ายกล่อง · กล่องที่ครบแล้วเหลือบรรทัดเดียว · ข้อความยาวตัด 2 บรรทัด
  const [settling, setSettling] = useState<Map<string, 'hold' | 'leave'>>(new Map());
  const timers = useRef<number[]>([]);
  const [doneOpen, setDoneOpen] = useState<Record<CheckKind, boolean>>({ acceptance: false, checklist: false });
  const [completeOpen, setCompleteOpen] = useState<Record<CheckKind, boolean>>({ acceptance: false, checklist: false });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  // จำว่าเปิดกลุ่มที่เสร็จไว้หรือไม่ ต่อเบราว์เซอร์ (อ่านหลัง mount เพื่อไม่ให้ต่างจากฝั่ง server)
  useEffect(() => {
    try { setDoneOpen({ acceptance: localStorage.getItem(foldKey('acceptance')) === '1', checklist: localStorage.getItem(foldKey('checklist')) === '1' }); } catch { /* ใช้ค่าเริ่มต้น: พับ */ }
  }, []);
  useEffect(() => () => { timers.current.forEach((id) => window.clearTimeout(id)); }, []);
  // ปุ่ม "เพิ่มเติม" ขึ้นกับว่าข้อความถูกตัดจริงไหม · วัดจาก data-overflow ที่ CheckText ตั้งไว้
  useLayoutEffect(() => {
    const ids = new Set([...(listRef.current?.querySelectorAll<HTMLElement>('[data-check-id]') ?? [])].filter((el) => el.querySelector('[data-overflow]')).map((el) => el.dataset.checkId!));
    if (ids.size !== overflowing.size || [...ids].some((id) => !overflowing.has(id))) setOverflowing(ids);
  });
  function toggleDone(kind: CheckKind) {
    const open = !doneOpen[kind];
    setDoneOpen((all) => ({ ...all, [kind]: open }));
    if (!open) setCompleteOpen((all) => ({ ...all, [kind]: false }));
    try { if (open) localStorage.setItem(foldKey(kind), '1'); else localStorage.removeItem(foldKey(kind)); } catch { /* ไม่จำก็ใช้งานได้ */ }
  }
  function settle(id: string) {
    setSettling((now) => new Map(now).set(id, 'hold'));
    timers.current.push(window.setTimeout(() => setSettling((now) => now.has(id) ? new Map(now).set(id, 'leave') : now), SETTLE_HOLD_MS));
    timers.current.push(window.setTimeout(() => setSettling((now) => { const next = new Map(now); next.delete(id); return next; }), SETTLE_HOLD_MS + SETTLE_LEAVE_MS));
  }
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
  // ลูกศรเลื่อนสลับกับข้อที่ยังไม่เสร็จข้างเคียงในกล่องเดียวกัน (prev / next) · ส่งลำดับทั้งหมดให้ API เหมือนเดิม
  const swap = (a: string, b: string) => { const ids = items.map((value) => value.id); const i = ids.indexOf(a); const j = ids.indexOf(b); [ids[i], ids[j]] = [ids[j], ids[i]]; void change(() => api.post(`${endpoint}/reorder`, { ids })); };
  const row = (item: ChecklistItem, prev?: ChecklistItem, next?: ChecklistItem) => { const editing = canEdit && edit?.id === item.id; const phase = settling.get(item.id); const open = expanded.has(item.id); return <div key={item.id} data-check-id={item.id} className={[styles.checkRow, editing ? styles.checkRowEditing : '', phase === 'leave' ? styles.checkLeaving : '', item.done && !phase ? 'motion-in' : ''].filter(Boolean).join(' ')}>
        <input type="checkbox" checked={item.done} aria-label={item.text} disabled={pending || !canEdit} onChange={(event) => { const done = event.target.checked; void change(() => api.request(`${endpoint}/${item.id}`, { method: 'PATCH', body: { done } }), () => { if (done) settle(item.id); }); }} />
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
          : <div className={styles.checkBody} data-check-body=""><button disabled={!canEdit} className={styles.checkText} onClick={() => setEdit({ id: item.id, text: item.text })}>
            {/* ขีดฆ่าเฉพาะข้อความ · คนติ๊กและวันที่ไม่ขีดฆ่า */}
            <CheckText text={item.text} done={item.done} expanded={open} className={styles.checked} />
            {item.done && item.doneAt && <small className={styles.checkMeta}>{doneByName(item.doneBy) ? t('checkDoneBy', { name: doneByName(item.doneBy)!, date: formatDate(item.doneAt, scope.yearFormat) }) : formatDate(item.doneAt, scope.yearFormat)}</small>}
          </button>
          {(open || overflowing.has(item.id)) && <button type="button" className={open ? styles.checkMore : `${styles.checkMore} ${styles.checkMoreInline}`} aria-expanded={open} aria-label={t(open ? 'checkShowLessOf' : 'checkShowMoreOf', { text: item.text })} onClick={() => setExpanded((now) => { const nextSet = new Set(now); if (open) nextSet.delete(item.id); else nextSet.add(item.id); return nextSet; })}>{t(open ? 'checkShowLess' : 'checkShowMore')}</button>}</div>}
        {canEdit && !editing && <div className={styles.actions}>
          {!item.done && <>
          <Button variant="ghost" size="icon" aria-label={t('itemUp', { text: item.text })} disabled={pending || !prev} onClick={() => prev && swap(prev.id, item.id)}><ArrowUp size={14} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('itemDown', { text: item.text })} disabled={pending || !next} onClick={() => next && swap(item.id, next.id)}><ArrowDown size={14} /></Button>
          </>}
          <Button variant="ghost" size="icon" aria-label={t('deleteChecklist', { text: item.text })} disabled={pending} onClick={() => void change(() => api.delete(`${endpoint}/${item.id}`))}><Trash2 size={14} /></Button>
        </div>}
      </div>; };
  const box = (kindName: CheckKind) => {
    const all = items.filter((item) => item.kind === kindName);
    const doneCount = all.filter((item) => item.done).length;
    const title = t(kindName === 'acceptance' ? 'acceptance' : 'checklist');
    // ข้อที่ยังไม่เสร็จ (รวมข้อที่เพิ่งติ๊กและกำลังจะย้าย) เรียงตามลำดับที่ตั้งไว้ · ข้อที่เสร็จเรียงตามเวลาที่ติ๊ก ล่าสุดก่อน
    const active = all.filter((item) => !item.done || settling.has(item.id));
    const movable = active.filter((item) => !item.done);
    const finished = all.filter((item) => item.done && !settling.has(item.id)).sort((x, y) => (y.doneAt ?? '').localeCompare(x.doneAt ?? ''));
    const complete = all.length > 0 && active.length === 0;
    // C3: ติ๊กครบแล้ว กล่องเหลือบรรทัดเดียว กด "ดูรายการ" เพื่อกางทั้งหมด
    if (complete && !completeOpen[kindName]) return <section key={kindName} className={`${styles.checkBox} ${kindName === 'acceptance' ? styles.checkBoxAcceptance : ''}`} aria-label={title}>
      <button type="button" className={`${styles.checkComplete} motion-in`} aria-expanded={false} onClick={() => { setCompleteOpen((now) => ({ ...now, [kindName]: true })); setDoneOpen((now) => ({ ...now, [kindName]: true })); }}>
        <Check size={15} aria-hidden="true" /><span>{t('checkComplete', { title, count: all.length })}</span><span className={styles.checkFoldHint}>{t('checkViewItems')}</span>
      </button>
    </section>;
    const showDone = doneOpen[kindName];
    return <section key={kindName} className={`${styles.checkBox} ${kindName === 'acceptance' ? styles.checkBoxAcceptance : ''}`} aria-label={title}>
      <h4 className={styles.checkHead}>{title} <span className="muted">{doneCount}/{all.length}</span><span className={styles.checkHint}>{t(kindName === 'acceptance' ? 'acceptanceHint' : 'checklistHint')}</span></h4>
      {all.length > 0 && <div className={styles.checkBar} aria-hidden="true"><i style={{ width: `${Math.round((doneCount / all.length) * 100)}%` }} /></div>}
      {kindName === 'acceptance' && all.length > 0 && !complete && <p className={styles.checkWarn}>{t('acceptanceDoneRule')}</p>}
      {active.map((item) => { const at = movable.indexOf(item); return row(item, at > 0 ? movable[at - 1] : undefined, at >= 0 ? movable[at + 1] : undefined); })}
      {finished.length > 0 && <button type="button" className={`${styles.checkFold} ${settling.size ? styles.checkFoldFlash : ''}`} aria-expanded={showDone} onClick={() => complete ? setCompleteOpen((now) => ({ ...now, [kindName]: false })) : toggleDone(kindName)}>
        {showDone ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>{t(kindName === 'acceptance' ? 'acceptancePassedCount' : 'checklistDoneCount', { count: finished.length })}</span>
        <span className={styles.checkFoldHint}>{t(showDone ? 'hideDone' : 'showDone')}</span>
      </button>}
      {showDone && finished.map((item) => row(item))}
      {all.length === 0 && !canEdit && <p className="muted">{t(kindName === 'acceptance' ? 'noAcceptance' : 'noChecklist')}</p>}
      {canEdit && <form className={styles.quickAdd} onSubmit={(event) => { event.preventDefault(); const text = texts[kindName].trim(); if (text) void change(() => api.post(endpoint, { text, kind: kindName }), () => setTexts((all) => ({ ...all, [kindName]: '' }))); }}>
        <input className={styles.dashed} aria-label={t(kindName === 'acceptance' ? 'addAcceptance' : 'addChecklist')} placeholder={t(kindName === 'acceptance' ? 'addAcceptancePlaceholder' : 'addChecklistPlaceholder')} maxLength={5000} value={texts[kindName]} onChange={(event) => setTexts((all) => ({ ...all, [kindName]: event.target.value }))} disabled={pending} />
        <Button type="submit" size="small" disabled={pending || !texts[kindName].trim()}>{t('add')}</Button>
      </form>}
    </section>;
  };
  return <div ref={listRef} className={styles.stack} style={{ gap: 10 }}>
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
        {query.data[side].map((item) => <span className={`${styles.depChip} ${({ todo: styles.sTodo, in_progress: styles.sProg, review: styles.sRev, blocked: styles.sBlk, done: styles.sDone, cancelled: styles.sCan } as const)[statusTone(item.status.category, item.status.name)]}`} key={item.key}>
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
