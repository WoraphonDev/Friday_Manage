'use client';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Avatar, Button, Input, LoadingState, ErrorState, Dialog } from '@/components/ui';
import { api } from '@/lib/api';
import { BodyText, Failure, PersonView, when } from './shared';
import { type MentionPicks, toDisplay, toStored } from './mentions';
import { filesPageHref, issuePath, issueQuery, previewBase, projectPath, type Activity, type Comment, type Feed, type Scope } from './types';
import { FilePreview, useFilePreview } from '@/components/file-preview';
import type { UploadedFile } from '@/lib/upload';
import { AttachButton } from './task-v2';
import { X } from 'lucide-react';
import styles from './issue-drawer.module.css';

/**
 * mode = comments: คอมเมนต์อย่างเดียว (กลางหน้า Task) พร้อมช่องเขียน
 * mode = log: ประวัติการเปลี่ยนแปลงอย่างเดียว ล่าสุดก่อน (กล่องด้านขวา) · แยกกันตามที่ผู้ใช้ขอ 2026-11-08
 */
export function ActivityPanel({ scope, issueKey, mode = 'comments', showFeed = true, showComposer = true, compact = false }: { scope: Scope; issueKey: string; mode?: 'comments' | 'log'; showFeed?: boolean; showComposer?: boolean; compact?: boolean }) {
  const t = useTranslations('issue-drawer');
  const cache = useQueryClient();
  const endpoint = issuePath(scope.ws, issueKey);
  const log = mode === 'log';
  const queryKey = [...issueQuery(scope.ws, issueKey), log ? 'activity-log' : 'comments'];
  const feed = useInfiniteQuery({
    queryKey, initialPageParam: '', enabled: showFeed,
    queryFn: async ({ pageParam, signal }): Promise<Feed> => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : '';
      if (log) return api.get<Feed>(`${endpoint}/activity?only=activity&order=desc&limit=20${cursor}`, { signal });
      const page = await api.get<{ items: Omit<Comment, 'kind'>[]; nextCursor: string | null }>(`${endpoint}/comments?limit=30${cursor}`, { signal });
      return { items: page.items.map((item) => ({ ...item, kind: 'comment' as const })), nextCursor: page.nextCursor };
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [body, setBody] = useState('');
  // ชื่อที่เลือกจากรายการ mention → userId · แปลงเป็นรูปแบบที่ API ต้องการตอนส่ง
  const [picks, setPicks] = useState<MentionPicks>(new Map());
  const [editPicks, setEditPicks] = useState<MentionPicks>(new Map());
  // ไฟล์ / รูปที่แนบกับคอมเมนต์ (ผู้ใช้ขอ 2026-11-08): อัปโหลดก่อน แล้วผูกกับคอมเมนต์หลังส่ง
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [editing, setEditing] = useState<Comment | null>(null);
  const [editBody, setEditBody] = useState('');
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const preview = useFilePreview();
  const commentable = scope.access.permissions.includes('issue.comment');
  const tail = /@([^@\n]*)$/.exec(body);
  // กล่องเลือกคน: ลูกศรขึ้นลงเลือก · Enter / Tab ใส่ชื่อ · Esc ปิดจนกว่าจะพิมพ์ @ ใหม่
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const suggestions = tail && closedAt !== tail.index && ![...picks.keys()].some((name) => tail[1].startsWith(`${name} `)) ? scope.people.filter((person) => person.displayName.toLocaleLowerCase().includes(tail[1].toLocaleLowerCase())).slice(0, 8) : [];
  const current = suggestions.length ? Math.min(active, suggestions.length - 1) : 0;
  function pick(person: (typeof scope.people)[number]) {
    setBody(body.slice(0, body.lastIndexOf('@')) + `@${person.displayName} `);
    setPicks((now) => new Map(now).set(person.displayName, person.id));
    setActive(0);
    textarea.current?.focus();
  }
  function mentionKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!suggestions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((current + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); }
    else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(suggestions[current]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosedAt(tail?.index ?? null); }
  }
  async function change(action: () => Promise<unknown>, success?: () => void) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { await action(); success?.(); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issueKey) }); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  function value(field: string | null, raw: unknown): string {
    if (raw === null || raw === undefined) return t('notSet');
    if (Array.isArray(raw)) return raw.length ? raw.map((item) => value(field, item)).join(', ') : t('notSet');
    // Label เก็บเป็น id · ใช้ชื่อจากรายการ Label ของโปรเจกต์ที่ Drawer โหลดไว้
    if (field === 'labelIds') {
      const labels = cache.getQueryData<{ items: { id: string; name: string }[] }>(['issue-options', scope.ws, scope.projectKey, 'labels'])?.items;
      const label = labels?.find((item) => item.id === raw);
      if (label) return label.name;
    }
    if (typeof raw === 'object') return t('dataChanged');
    const person = scope.people.find((p) => p.id === raw);
    // กลุ่มมาจาก form-options ที่หน้า Task / หน้าสร้างโหลดไว้
    const groups = [['issue-options', scope.ws, scope.projectKey, 'form-options'], ['issue-form-options', scope.ws, scope.projectKey]].flatMap((queryKey) => cache.getQueryData<{ phases?: { id: string; name: string }[] }>(queryKey)?.phases ?? []);
    const named = [...(scope.project?.modules ?? []), ...(scope.project?.statuses ?? []), ...(scope.project?.sprints ?? []), ...(scope.project?.phases ?? []), ...groups].find((item) => item.id === raw);
    if (person) return person.displayName;
    if (named) return named.name;
    if (field === 'priority' && t.has(`priority.${raw}`)) return t(`priority.${raw}`);
    if (typeof raw === 'boolean') return t(raw ? 'yes' : 'no');
    return /^[\da-f-]{36}$/i.test(String(raw)) ? t('dataChanged') : String(raw);
  }
  function checklistText(oldValue: unknown, newValue: unknown) {
    type Item = { text?: string; done?: boolean; kind?: string; ids?: unknown };
    const before = (oldValue ?? null) as Item | null; const after = (newValue ?? null) as Item | null;
    const kind = (after ?? before)?.kind === 'acceptance' ? 'Acceptance criteria' : 'Checklist';
    if (before?.ids) return t('checklistLog.reordered', { kind });
    if (!before && after?.text) return t('checklistLog.added', { kind, text: after.text });
    if (before?.text && !after) return t('checklistLog.removed', { kind, text: before.text });
    if (before && after && before.done !== after.done) return t(after.done ? 'checklistLog.checked' : 'checklistLog.unchecked', { kind, text: after.text ?? '' });
    if (before?.text && after?.text && before.text !== after.text) return t('checklistLog.renamed', { kind, old: before.text, new: after.text });
    return null;
  }
  function activityText(item: Activity) {
    const verb = t.has(`verbs.${item.verb}`) ? t(`verbs.${item.verb}`) : t('updated');
    if (!item.field) return verb;
    if (item.field === 'checklist') { const text = checklistText(item.old, item.new); if (text) return text; }
    // Custom field บันทึกเป็น cf:<id> · ชื่อมาจากชุดฟิลด์ของโปรเจกต์ (ฟิลด์ที่ถูกลบแล้วใช้คำกลาง)
    const custom = item.field.startsWith('cf:') ? scope.project?.customFields?.find((f) => `cf:${f.id}` === item.field)?.name : undefined;
    const field = custom ?? (t.has(`fields.${item.field}`) ? t(`fields.${item.field}`) : t('issueData'));
    return t('changeDescription', { verb, field, old: value(item.field, item.old), new: value(item.field, item.new) });
  }
  if (showFeed && feed.error) return <ErrorState error={feed.error} retry={() => void feed.refetch()} />;
  if (showFeed && !feed.data) return <LoadingState />;
  const items = feed.data?.pages.flatMap((page) => page.items) ?? [];
  if (log) return <div className={styles.logBox}>
    {items.length === 0 && <p className="muted">{t('noHistory')}</p>}
    <ol className={styles.logList}>{items.map((item) => item.kind === 'activity' && <li key={item.id} className={styles.logItem}>
      <div className={styles.logHead}><PersonView person={item.actor} /><time dateTime={item.createdAt}>{when(item.createdAt, scope.yearFormat)}</time></div>
      <p className={styles.logText} title={activityText(item)}>{activityText(item)}</p>
    </li>)}</ol>
    {feed.hasNextPage && <Button size="small" variant="ghost" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>{t('loadMore')}</Button>}
  </div>;
  return <div className={styles.stack}>
    {showFeed && <>
    {items.length === 0 && <p className="muted">{t('noComments')}</p>}
    <ol className={styles.feed}>{items.map((item) => <li key={`${item.kind}-${item.id}`} className={styles.feedItem}>
      <div className={styles.feedHeading}><PersonView person={item.kind === 'comment' ? item.author : item.actor} /><time dateTime={item.createdAt}>{when(item.createdAt, scope.yearFormat)}</time></div>
      {item.kind === 'activity' ? <p className={styles.activityText}>{activityText(item)}</p> : <div className={styles.commentBody}>
        {item.deletedAt ? <p className="muted">{t(item.deletionReason === 'admin' ? 'deletedByAdmin' : 'deletedComment')}</p> : <BodyText>{item.body ?? ''}</BodyText>}
        {/* กดไฟล์แนบ = ป๊อปอัปดูตัวอย่าง (ผู้ใช้ขอ 2026-11-08) */}
        {!item.deletedAt && !!item.files?.length && <div className={styles.fileChips}>{item.files.map((file, index) => <button type="button" key={file.id} className={`${styles.chipSoft} ${styles.chipButton}`} aria-label={t('previewFile', { name: file.name })} onClick={() => preview.open(item.files!, index)}>{file.name}</button>)}</div>}
        {item.editedAt && !item.deletedAt && <small className="muted">{t('edited')}</small>}
        <div className={styles.actions}>{item.canEdit && <Button size="small" variant="ghost" disabled={pending} onClick={() => { const shown = toDisplay(item.body ?? ''); setEditing(item); setEditBody(shown.text); setEditPicks(shown.picks); }}>{t('editComment')}</Button>}{item.canDelete && <Button size="small" variant="ghost" disabled={pending} onClick={() => setDeleting(item)}>{t('deleteComment')}</Button>}</div>
      </div>}
    </li>)}</ol>
    {feed.hasNextPage && <Button disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>{t('loadMore')}</Button>}
    </>}
    {showComposer && commentable && <form className={`${styles.composer}${compact ? ` ${styles.compactComposer}` : ''}`} onSubmit={(event) => { event.preventDefault(); void change(async () => { const created = await api.post<Comment>(`${endpoint}/comments`, { body: toStored(body, picks) }); for (const file of files) await api.post(`${projectPath(scope.ws, scope.projectKey)}/files/${file.id}/attachments`, { targetType: 'comment', target: created.id }); }, () => { setBody(''); setPicks(new Map()); setFiles([]); }); }}>
      <label className="field"><span className={compact ? "sr-only" : undefined}>{t('writeComment')}</span><textarea ref={textarea} rows={compact ? 1 : undefined} placeholder={compact ? t('commentPlaceholder') : undefined} className="input" required maxLength={20000} value={body} onChange={(event) => { setBody(event.target.value); setActive(0); }} onKeyDown={mentionKeys} role={suggestions.length ? 'combobox' : undefined} aria-expanded={suggestions.length ? true : undefined} aria-controls={suggestions.length ? `${issueKey}-mentions` : undefined} aria-activedescendant={suggestions.length ? `${issueKey}-mention-${suggestions[current].id}` : undefined} disabled={pending} /></label>
      {suggestions.length > 0 && <ul className={styles.mentionOptions} id={`${issueKey}-mentions`} role="listbox" aria-label={t('mentionMembers')}>{suggestions.map((person, index) => <li key={person.id} id={`${issueKey}-mention-${person.id}`} role="option" aria-label={person.displayName} aria-selected={index === current} className={styles.mentionOption} onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); pick(person); }}><Avatar person={person} size="small" /><span>{person.displayName}</span></li>)}</ul>}
      {files.length > 0 && <div className={styles.fileChips}>{files.map((file) => <span key={file.id} className={styles.chipSoft}>{file.name}<button type="button" className={styles.chipX} aria-label={t('removeItem', { text: file.name })} onClick={() => setFiles(files.filter((item) => item.id !== file.id))}><X size={12} aria-hidden="true" /></button></span>)}</div>}
      <div className={styles.composerFooter}>{!compact && <AttachButton scope={scope} label={t('attachToComment')} disabled={pending} onUploaded={(added) => setFiles((current) => [...current, ...added])} />}<span className="muted">{t('markdownHint')}</span><Button type="submit" variant="primary" disabled={pending || !body.trim()}>{t('send')}</Button></div>
    </form>}
    {!!error && <Failure error={error} />}
    {preview.props && <FilePreview {...preview.props} base={previewBase(scope)} filesHref={filesPageHref(scope)} />}
    <Dialog open={!!editing} title={t('editComment')} onOpenChange={(open) => { if (!open && !pending) setEditing(null); }}>
      <form className={styles.stack} onSubmit={(event) => { event.preventDefault(); if (editing) void change(() => api.request(`${endpoint}/comments/${editing.id}`, { method: 'PATCH', body: { body: toStored(editBody, editPicks) } }), () => setEditing(null)); }}>
        <label className="field">{t('comment')}<textarea className="input" required maxLength={20000} value={editBody} onChange={(event) => setEditBody(event.target.value)} /></label><Button type="submit" variant="primary" disabled={pending || !editBody.trim()}>{t('save')}</Button>{!!error && <Failure error={error} />}
      </form>
    </Dialog>
    <Dialog open={!!deleting} title={t('deleteComment')} description={t('deleteCommentDescription')} onOpenChange={(open) => { if (!open && !pending) setDeleting(null); }}>
      <div className={styles.actions}><Button disabled={pending} onClick={() => setDeleting(null)}>{t('cancel')}</Button><Button variant="danger" disabled={pending} onClick={() => { if (deleting) void change(() => api.delete(`${endpoint}/comments/${deleting.id}`), () => setDeleting(null)); }}>{t('deleteComment')}</Button></div>{!!error && <Failure error={error} />}
    </Dialog>
  </div>;
}
