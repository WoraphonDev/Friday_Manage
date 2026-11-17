'use client';
// ชิ้นส่วนของหน้า Task v2 (Canvas B2 / C2 / D2 · ผู้ใช้ตัดสิน 2026-11-08) ที่ใช้ทั้งหน้าดูและหน้าสร้างงาน
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, Paperclip, X } from 'lucide-react';
import { Button, Select, isImageFile, useToast, type AttachmentRow } from '@/components/ui';
import { api } from '@/lib/api';
import { uploadToProject, type UploadedFile } from '@/lib/upload';
import { projectPath, type Issue, type Scope } from './types';
import styles from './issue-drawer.module.css';

/** รายการงานของโปรเจกต์สำหรับค้นหา (Dependency, Task แม่) · โหลดครั้งเดียวต่อโปรเจกต์ */
export function useProjectIssues(scope: Scope, enabled = true) {
  return useQuery({
    queryKey: ['issue-drawer-list', scope.ws, scope.projectKey, 'all'],
    queryFn: ({ signal }) => api.get<{ items: Issue[] }>(`${projectPath(scope.ws, scope.projectKey)}/issues?limit=500`, { signal }),
    enabled, staleTime: 30_000,
  });
}

/**
 * ช่องเลือกงานที่ค้นหาด้วยรหัสหรือชื่อ (D2: Task แม่ · C2: Dependency)
 * groups แบ่งหัวข้อในรายการ เช่น "Task ใน Module เดียวกัน"
 */
export function IssuePicker({ label, value, issues, onChange, placeholder, disabled = false, groupOf }: {
  label: string; value: string | null; issues: Issue[]; onChange: (key: string) => void;
  placeholder?: string; disabled?: boolean; groupOf?: (issue: Issue) => string;
}) {
  const t = useTranslations('issue-drawer');
  const [open, setOpen] = useState(false);
  const current = issues.find((issue) => issue.key === value);
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const group = groupOf?.(issue) ?? '';
    groups.set(group, [...(groups.get(group) ?? []), issue]);
  }
  return <Popover.Root open={open} onOpenChange={(next) => { if (!disabled) setOpen(next); }}>
    <Popover.Trigger asChild>
      <button type="button" className={styles.issuePick} aria-label={label} disabled={disabled}>
        {current ? <><span className="muted">{current.key}</span><span className={styles.issuePickTitle}>{current.title}</span></> : <span className="muted">{placeholder ?? t('pickIssue')}</span>}
        {!disabled && <ChevronDown size={14} aria-hidden="true" />}
      </button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="popover combobox-popover" sideOffset={6} align="start">
      <Command label={label} filter={(itemValue, search) => itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
        <Command.Input aria-label={t('searchIssue')} placeholder={t('searchIssue')} />
        <Command.List aria-label={label}>
          <Command.Empty>{t('noIssueFound')}</Command.Empty>
          {[...groups.entries()].map(([group, items]) => <Command.Group key={group || 'all'} heading={group || undefined}>
            {items.map((issue) => <Command.Item key={issue.key} value={`${issue.key} ${issue.title}`} onSelect={() => { onChange(issue.key); setOpen(false); }}>
              <span className="muted" style={{ minWidth: 56 }}>{issue.key}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
              {issue.key === value && <Check size={16} aria-hidden="true" />}
            </Command.Item>)}
          </Command.Group>)}
        </Command.List>
      </Command>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

type AttachTarget = { targetType: 'issue' | 'comment' | 'test_run'; target: string };
interface QueuedFile { key: string; file: File; name: string; size: number; thumb: string | null; id?: string; progress?: number | null }

/**
 * คิวอัปโหลดเข้า Files ของโปรเจกต์ · ทีละไฟล์ตามลำดับ มีความคืบหน้าและยกเลิกได้ (ลากวางหลายไฟล์ · 2026-11-17)
 * draft = ไฟล์รอแนบกับผลทดสอบ / คอมเมนต์ที่ยังไม่บันทึก: อยู่ในรายการจนบันทึก · เอาออก = ย้ายเข้าถังขยะ เพราะยังไม่มีงานไหนใช้
 * ไม่ใช่ draft = แนบกับเป้าหมายทันที แล้วหายจากคิวเมื่อเสร็จ ให้รายการจริงจาก API แสดงแทน
 */
export function useProjectUploads(scope: Scope, { attach, onUploaded, draft = false }: { attach?: AttachTarget; onUploaded?: (files: UploadedFile[]) => void | Promise<void>; draft?: boolean } = {}) {
  const t = useTranslations('issue-drawer');
  const ta = useTranslations('common.attach');
  const toast = useToast();
  const [items, setItems] = useState<QueuedFile[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const aborts = useRef(new Map<string, () => void>());
  const dropped = useRef(new Set<string>());
  const thumbs = useRef(new Set<string>());
  const done = useRef(onUploaded);
  useEffect(() => { done.current = onUploaded; });
  useEffect(() => () => {
    for (const abort of aborts.current.values()) abort();
    for (const url of thumbs.current) URL.revokeObjectURL(url);
  }, []);
  const base = projectPath(scope.ws, scope.projectKey);
  const patch = (key: string, next: Partial<QueuedFile>) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...next } : item));
  const forget = (key: string) => setItems((current) => current.filter((item) => item.key !== key));
  const trash = (id: string) => api.delete(`${base}/files/${encodeURIComponent(id)}`).catch(() => undefined);

  function add(files: File[]) {
    if (!files.length) return;
    const batch: QueuedFile[] = files.map((file) => {
      const thumb = isImageFile(file) ? URL.createObjectURL(file) : null;
      if (thumb) thumbs.current.add(thumb);
      return { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name: file.name, size: file.size, thumb, progress: null };
    });
    setItems((current) => [...current, ...batch]);
    chain.current = chain.current.then(async () => {
      const uploaded: UploadedFile[] = [];
      let failure: unknown = null;
      for (const entry of batch) {
        if (dropped.current.has(entry.key)) continue;
        patch(entry.key, { progress: 0 });
        try {
          const file = await uploadToProject(scope.ws, scope.projectKey, entry.file, attach, {
            onProgress: (loaded) => patch(entry.key, { progress: entry.size ? Math.min(1, loaded / entry.size) : 1 }),
            register: (abort) => aborts.current.set(entry.key, abort),
          });
          // กด ✕ ตอนไฟล์ขึ้นเสร็จพอดี: ไฟล์ถูกสร้างแล้ว จึงย้ายเข้าถังขยะตามที่ผู้ใช้ตั้งใจ
          if (dropped.current.has(entry.key)) { void trash(file.id); continue; }
          uploaded.push(file);
          if (draft) patch(entry.key, { id: file.id, progress: undefined });
        } catch (error) {
          if (!dropped.current.has(entry.key)) { failure = error; forget(entry.key); }
        } finally { aborts.current.delete(entry.key); }
      }
      if (uploaded.length) {
        try { await done.current?.(uploaded); } catch { /* รีเฟรชรายการไม่สำเร็จ ไฟล์ขึ้นแล้ว */ }
        if (!draft) setItems((current) => current.filter((item) => !batch.some((entry) => entry.key === item.key)));
        toast({ message: t('filesAttached', { count: uploaded.length }) });
      }
      if (failure) toast({ message: failure instanceof Error && failure.message ? failure.message : t('uploadFailed'), tone: 'error' });
    }).catch(() => undefined);
  }

  function remove(key: string) {
    const item = items.find((entry) => entry.key === key);
    if (!item) return;
    dropped.current.add(key);
    aborts.current.get(key)?.();
    forget(key);
    if (!item.id) return;
    const id = item.id;
    void trash(id);
    toast({
      message: ta('removed', { name: item.name }),
      undo: async () => {
        await api.post(`${base}/files/${encodeURIComponent(id)}/restore`);
        setItems((current) => [...current, { ...item, key: `${key}-r` }]);
      },
    });
  }

  const pending = items.filter((item) => item.progress !== undefined);
  return {
    add,
    remove,
    /** หลังบันทึกแล้ว: ไฟล์ผูกกับผลทดสอบ / คอมเมนต์แล้ว เคลียร์รายการอย่างเดียว */
    clear: () => setItems([]),
    /** กดยกเลิกฟอร์ม: ไฟล์ร่างที่ขึ้นแล้วไม่มีใครใช้ ย้ายเข้าถังขยะ */
    discard() {
      for (const item of items) {
        dropped.current.add(item.key);
        aborts.current.get(item.key)?.();
        if (item.id) void trash(item.id);
      }
      setItems([]);
    },
    files: items.filter((item) => item.id).map((item) => ({ id: item.id!, name: item.name })),
    busy: pending.length > 0,
    status: pending.length ? ta('uploadingCount', { done: items.length - pending.length, total: items.length }) : null,
    rows: items.map((item): AttachmentRow => ({ key: item.key, name: item.name, size: item.size, thumb: item.thumb, progress: item.progress, onRemove: () => remove(item.key) })),
  };
}

/** ปุ่มแนบไฟล์: เปิดหน้าต่างเลือกไฟล์ (เลือกได้หลายไฟล์) · ลากวาง / วางจากคลิปบอร์ดอยู่ที่กล่องที่ครอบปุ่มนี้ */
export function AttachButton({ onFiles, label, multiple = true, size = 'small', disabled = false }: {
  onFiles: (files: File[]) => void; label?: ReactNode; multiple?: boolean; size?: 'small' | 'default'; disabled?: boolean;
}) {
  const t = useTranslations('issue-drawer');
  const ta = useTranslations('common.attach');
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" hidden multiple={multiple} onChange={(event) => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} aria-hidden="true" tabIndex={-1} />
    <Button type="button" size={size === 'small' ? 'small' : undefined} disabled={disabled} title={ta('pasteHint')} onClick={() => input.current?.click()}><Paperclip size={14} aria-hidden="true" />{label ?? t('attach')}</Button>
  </>;
}

export function DraftList({ label, placeholder, items, onChange, tag, tone }: {
  label: string; placeholder: string; items: string[]; onChange: (items: string[]) => void; tag: string; tone: 'acceptance' | 'checklist';
}) {
  const t = useTranslations('issue-drawer');
  const [text, setText] = useState('');
  return <div className={styles.draftList}>
    {items.map((item, index) => <div key={`${index}-${item}`} className={styles.draftItem}>
      <span className={`${styles.kindTag} ${tone === 'acceptance' ? styles.kindAcceptance : styles.kindChecklist}`}>{tag}</span>
      <span className={styles.grow}>{item}</span>
      <button type="button" className={styles.chipX} aria-label={t('removeItem', { text: item })} onClick={() => onChange(items.filter((_, i) => i !== index))}><X size={14} aria-hidden="true" /></button>
    </div>)}
    <input className={styles.dashed} aria-label={label} placeholder={placeholder} value={text} maxLength={5000}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (text.trim()) { onChange([...items, text.trim()]); setText(''); } } }} />
  </div>;
}

type Group = { id: string; name: string; moduleId: string };

/**
 * กลุ่มของ Task ภายใต้ Module (ไม่บังคับ · ผู้ใช้ขอ 2026-11-08): Module → กลุ่ม → Task → Sub-task
 * สร้างกลุ่มใหม่ได้จากตรงนี้ (คนที่สร้าง Task ได้) · ย้าย Task ไปกลุ่มอื่นแล้ว Sub-task ตามไปเอง (API)
 * ไม่ใช้ <form> ซ้อน เพราะหน้าสร้าง Task เป็น form อยู่แล้ว
 */
export function GroupSelect({ scope, moduleId, value, groups, disabled = false, onChange }: {
  scope: Scope; moduleId: string | null; value: string | null; groups: Group[]; disabled?: boolean; onChange: (id: string | null) => void;
}) {
  const t = useTranslations('issue-drawer');
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [made, setMade] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perms = scope.access.permissions;
  const canCreate = !scope.access.guestViewer && (perms.includes('issue.create') || perms.includes('project.settings')) && scope.project?.status !== 'archived';
  if (!moduleId) return <span className="muted">{t('groupNeedsModule')}</span>;
  const list = [...groups.filter((group) => group.moduleId === moduleId), ...made.filter((group) => group.moduleId === moduleId && !groups.some((item) => item.id === group.id))];
  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true); setError(null);
    try {
      const group = await api.post<Group>(`${projectPath(scope.ws, scope.projectKey)}/modules/${moduleId}/phases`, { name: trimmed });
      setMade((current) => [...current, group]); setAdding(false); setName('');
      onChange(group.id);
      // รายการกลุ่มอยู่ในข้อมูลโปรเจกต์ / form-options / Table ของโปรเจกต์นี้
      await cache.invalidateQueries({ predicate: (query) => query.queryKey.includes(scope.projectKey) && !query.queryKey.includes('issue-parent') });
    } catch { setError(t('groupCreateFailed')); }
    finally { setBusy(false); }
  }
  if (adding) return <div className={styles.groupNew}>
    <input className="input" autoFocus aria-label={t('groupName')} placeholder={t('groupNamePlaceholder')} maxLength={120} value={name} disabled={busy}
      onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void create(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAdding(false); }
      }} />
    <Button size="small" variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>{t('add')}</Button>
    <Button size="small" disabled={busy} onClick={() => setAdding(false)}>{t('cancel')}</Button>
    {error && <span className="field-error">{error}</span>}
  </div>;
  return <Select label={t('group')} value={value ?? ''} disabled={disabled} onChange={(event) => {
    if (event.target.value === '__new') { setAdding(true); return; }
    onChange(event.target.value || null);
  }}>
    <option value="">{t('noGroup')}</option>
    {list.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
    {canCreate && <option value="__new">{t('newGroup')}</option>}
  </Select>;
}
