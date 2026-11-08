'use client';
// ชิ้นส่วนของหน้า Task v2 (Canvas B2 / C2 / D2 · ผู้ใช้ตัดสิน 2026-11-08) ที่ใช้ทั้งหน้าดูและหน้าสร้างงาน
import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, Paperclip, X } from 'lucide-react';
import { Button, useToast } from '@/components/ui';
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

/** ปุ่มแนบไฟล์: อัปโหลดเข้า Files ของโปรเจกต์ แล้วแนบกับงาน / คอมเมนต์ / ผลทดสอบทันที */
export function AttachButton({ scope, attach, onUploaded, label, multiple = true, size = 'small', disabled = false }: {
  scope: Scope; attach?: { targetType: 'issue' | 'comment' | 'test_run'; target: string };
  onUploaded: (files: UploadedFile[]) => void | Promise<void>; label?: ReactNode; multiple?: boolean; size?: 'small' | 'default'; disabled?: boolean;
}) {
  const t = useTranslations('issue-drawer');
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function upload(list: FileList | null) {
    if (!list?.length || busy) return;
    setBusy(true);
    try {
      const done: UploadedFile[] = [];
      for (const file of Array.from(list)) done.push(await uploadToProject(scope.ws, scope.projectKey, file, attach));
      await onUploaded(done);
      toast({ message: t('filesAttached', { count: done.length }) });
    } catch (error) { toast({ message: error instanceof Error && error.message ? error.message : t('uploadFailed') }); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <>
    <input ref={input} type="file" hidden multiple={multiple} onChange={(event) => void upload(event.target.files)} aria-hidden="true" tabIndex={-1} />
    <Button type="button" size={size === 'small' ? 'small' : undefined} disabled={busy || disabled} onClick={() => input.current?.click()}><Paperclip size={14} aria-hidden="true" />{busy ? t('uploading') : label ?? t('attach')}</Button>
  </>;
}

/** รายการที่ยังไม่บันทึก (หน้าสร้างงาน): พิมพ์แล้ว Enter เพื่อเพิ่ม · แต่ละรายการมีป้ายบอกประเภท */
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
