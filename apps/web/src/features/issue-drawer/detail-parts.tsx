'use client';
// ส่วนย่อยของ Drawer รายละเอียดงานตาม Canvas C / D / K2 (แถวคุณสมบัติ, Sub-task, Development, ไฟล์แนบ, Bug)
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { GitBranch } from 'lucide-react';
import { AttachmentList, Avatar, Button, DropOverlay, isImageFile, useFileDrop, useToast, type AttachmentRow } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { BodyText, InlineText } from './shared';
import { TestRuns } from './test-runs';
import { AttachButton, useProjectUploads } from './task-v2';
import { filesPageHref, type Issue, issuePath, previewBase, projectPath, type Scope } from './types';
import { FilePreview, useFilePreview } from '@/components/file-preview';
import styles from './issue-drawer.module.css';

/** แถว "ชื่อ : ค่า" ในการ์ดคุณสมบัติ · ช่องแก้ไขข้างในยังมี label ของตัวเองสำหรับโปรแกรมอ่านหน้าจอ */
export function PropRow({ k, children, keep = false }: { k: string; children: ReactNode; keep?: boolean }) {
  // keep = แสดงบนมือถือเสมอ (M4: ผู้รับผิดชอบ, Priority, Progress) · แถวอื่นซ่อนจนกดดูทั้งหมด
  return <div className={`${styles.pr}${keep ? ` ${styles.mKeep}` : ''}`}><span className={styles.k}>{k}</span><div className={styles.pv}>{children}</div></div>;
}

export function SubtaskRow({ scope, child, canEdit, onChanged, pillTone }: {
  scope: Scope; child: Issue; canEdit: boolean; onChanged: () => Promise<void>; pillTone: (category: string, name: string) => string;
}) {
  const t = useTranslations('issue-drawer');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const done = child.status.category === 'done';
  const who = scope.people.find((person) => child.assigneeIds?.includes(person.id));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const due = child.dueDate !== undefined ? child.dueDate : child.planEnd;
  const late = !done && !!due && due < today;
  // ติ๊กเสร็จ = ย้ายไปสถานะกลุ่ม done ตัวแรกของ Workflow (ยกเลิก = กลุ่ม todo ตัวแรก)
  async function toggle(next: boolean) {
    const type = scope.project?.issueTypes?.find((item) => item.name === child.type);
    const target = scope.project?.statuses?.find((status) => status.workflowId === type?.workflowId && status.category === (next ? 'done' : 'todo'));
    if (!target || busy) return;
    setBusy(true);
    try { await api.request(`${issuePath(scope.ws, child.key)}/move`, { method: 'POST', etag: child.version, body: { statusId: target.id, confirm: false } }); }
    catch (error) { toast({ message: error instanceof Error ? error.message : t('error') }); }
    finally { setBusy(false); await onChanged(); }
  }
  return <div className={styles.sub}>
    <input type="checkbox" checked={done} disabled={!canEdit || busy} aria-label={t('markSubtaskDone', { title: child.title })} onChange={(event) => void toggle(event.target.checked)} />
    <span className={`muted ${styles.hideS}`}>{child.key}</span>
    <button className={`${styles.subName}${done ? ` ${styles.checked}` : ''}`} aria-label={`${child.key} ${child.title}`} title={child.title} onClick={() => scope.navigate(child.key)}>{child.title}</button>
    <span>{who ? <Avatar size="small" person={who} /> : null}</span>
    <span className={late ? styles.dueLate : styles.due}>{child.planEnd ? formatDate(child.planEnd, scope.yearFormat) : ''}</span>
    <span className={styles.hideS}><span className={`${styles.pill} ${pillTone(child.status.category, child.status.name)}`}>{child.status.name}</span></span>
  </div>;
}

/** พิมพ์ชื่อแล้วกด Enter เพื่อสร้าง Sub-task ทันที · ฟอร์มเต็มยังเปิดได้จากปุ่มข้าง ๆ */
export function QuickSubtask({ scope, parent, onCreated, onFullForm }: { scope: Scope; parent: Issue; onCreated: () => Promise<void>; onFullForm: () => void }) {
  const t = useTranslations('issue-drawer');
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.post<Issue>(`${projectPath(scope.ws, scope.projectKey)}/issues`, { type: 'Task', parentKey: parent.key, title: title.trim() });
      setTitle('');
      toast({ message: t('subtaskCreated', { key: created.key }) });
      await onCreated();
    } catch (error) {
      // ประเภทงานบังคับฟิลด์เพิ่ม → เปิดฟอร์มเต็มแทน
      if (error instanceof ApiError && error.status === 400) onFullForm();
      else toast({ message: error instanceof Error ? error.message : t('error') });
    } finally { setBusy(false); }
  }
  return <div className={styles.quickAdd}>
    <input className={styles.dashed} value={title} disabled={busy} aria-label={t('quickSubtask')} placeholder={t('quickSubtaskPlaceholder')} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} />
    <Button size="small" variant="ghost" className={styles.addAction} onClick={onFullForm}>{t('addSubtask')}</Button>
  </div>;
}

interface GitInfo {
  commits: { sha: string; shortSha: string; message: string; author: string | null; committedAt: string; url: string | null; repository: string }[];
  pullRequests: { number: number; title: string; state: string; sourceBranch: string; url: string | null; repository: string; reviewStatus: string | null }[];
}
export function Development({ scope, issue }: { scope: Scope; issue: Issue }) {
  const t = useTranslations('issue-drawer');
  const toast = useToast();
  const git = useQuery({ queryKey: ['issue-git', scope.ws, issue.key], queryFn: ({ signal }) => api.get<GitInfo>(`${issuePath(scope.ws, issue.key)}/git`, { signal }), retry: false });
  // ชื่อ branch แนะนำ: รหัสงาน + ชื่อภาษาอังกฤษที่ตัดเหลือตัวอักษรที่ใช้ใน branch ได้
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const branch = git.data?.pullRequests[0]?.sourceBranch ?? `feature/${issue.key}${slug ? `-${slug}` : ''}`;
  const repo = git.data?.pullRequests[0]?.repository ?? git.data?.commits[0]?.repository;
  const latest = git.data?.commits[0];
  return <div className={styles.blk}>
    <h3>Development {repo && <span className="muted" style={{ fontWeight: 500, fontSize: 11 }}>GitHub · {repo}</span>}</h3>
    {/* Git อ่านไม่ได้ (ยังไม่เชื่อม / ไม่มีสิทธิ์) ยังแนบผล Unit test ได้ */}
    {!git.error && <div className={styles.dev}>
      <div className={styles.branch}><GitBranch size={15} aria-hidden="true" /><code>{branch}</code><Button size="small" onClick={() => { void navigator.clipboard?.writeText(branch).then(() => toast({ message: t('branchCopied') })); }}>Copy</Button></div>
      {git.data?.pullRequests.map((pr) => <div key={`${pr.repository}#${pr.number}`} className={styles.prLine}><span className={`${styles.pill} ${pr.state === 'merged' ? styles.sDone : pr.state === 'closed' ? styles.sTodo : styles.sProg}`}>{pr.state}</span>{pr.url ? <a href={pr.url} target="_blank" rel="noopener noreferrer">#{pr.number} {pr.title}</a> : <span>#{pr.number} {pr.title}</span>}</div>)}
      {latest ? <>
        <div className="muted">{t('commitsCount', { count: git.data!.commits.length })}</div>
        {git.data!.commits.map((commit) => <div key={`${commit.repository}/${commit.sha}`} className={styles.commitLine}>
          {commit.url ? <a href={commit.url} target="_blank" rel="noopener noreferrer"><code>{commit.shortSha || commit.sha.slice(0, 7)}</code></a> : <code>{commit.shortSha || commit.sha.slice(0, 7)}</code>}
          <span title={commit.message}>{commit.message.split('\n')[0]}</span>
          <small className="muted">{commit.author}{commit.author ? ' · ' : ''}<time dateTime={commit.committedAt}>{formatDate(commit.committedAt.slice(0, 10), scope.yearFormat)}</time></small>
        </div>)}
      </> : git.data && <div className="muted">{t('noGit')}</div>}
    </div>}
    {/* C2 / D2: ผล Unit test ที่ Dev แนบเอง (ผู้ใช้ตัดสิน 2026-11-08) */}
    <div id={`${issue.key}-unit-tests`}><TestRuns scope={scope} issue={issue} kind="unit" embedded /></div>
  </div>;
}

interface Attached { id: string; name: string; mime: string | null; size?: number | null; kind: 'upload' | 'link'; linkUrl: string | null; uploader: { displayName: string } | null; createdAt: string }
/** ไฟล์แนบของงาน: แสดงเป็นรายการพร้อมรูปย่อ · ลากไฟล์มาวางในหัวข้อนี้ได้ · ✕ = ถอดออกจากงาน (ไฟล์ยังอยู่ในหน้า Files) */
export function Attachments({ scope, issue }: { scope: Scope; issue: Issue }) {
  const t = useTranslations('issue-drawer');
  const ta = useTranslations('common.attach');
  const toast = useToast();
  const canAttach = !scope.access.guestViewer && scope.access.permissions.includes('issue.edit') && scope.project?.status !== 'archived';
  const preview = useFilePreview();
  const files = useQuery({ queryKey: ['issue-files', scope.ws, issue.key], queryFn: ({ signal }) => api.get<{ items: Attached[] }>(`${projectPath(scope.ws, scope.projectKey)}/files?target=${encodeURIComponent(`issue:${issue.key}`)}`, { signal }), retry: false });
  const target = { targetType: 'issue' as const, target: issue.key };
  const uploads = useProjectUploads(scope, { attach: target, onUploaded: async () => { await files.refetch(); } });
  const drop = useFileDrop(uploads.add, canAttach);
  const [hidden, setHidden] = useState<string[]>([]);
  if (files.error) return null;
  const base = projectPath(scope.ws, scope.projectKey);
  const items = (files.data?.items ?? []).filter((f) => !hidden.includes(f.id));
  const uploadsList = items.filter((f) => f.kind !== 'link');
  async function detach(file: Attached) {
    const path = `${base}/files/${encodeURIComponent(file.id)}/attachments`;
    setHidden((current) => [...current, file.id]);
    try {
      await api.delete(path, { body: target });
      await files.refetch();
      toast({ message: ta('removed', { name: file.name }), undo: async () => { await api.post(path, target); await files.refetch(); } });
    } catch (error) {
      toast({ message: error instanceof Error && error.message ? error.message : t('uploadFailed'), tone: 'error' });
    } finally { setHidden((current) => current.filter((id) => id !== file.id)); }
  }
  const rows: AttachmentRow[] = items.map((f) => ({
    key: f.id,
    name: f.name,
    thumb: f.kind !== 'link' && isImageFile(f) ? `${previewBase(scope)}/files/${encodeURIComponent(f.id)}/download?inline=1` : null,
    meta: [f.uploader?.displayName, formatDate(f.createdAt, scope.yearFormat)].filter(Boolean).join(' · '),
    // ลิงก์ภายนอกเปิดแท็บใหม่ · ไฟล์ที่อัปโหลดเปิดป๊อปอัปดูตัวอย่าง
    onOpen: () => f.kind === 'link' && f.linkUrl ? void window.open(f.linkUrl, '_blank', 'noopener,noreferrer') : preview.open(uploadsList, uploadsList.findIndex((u) => u.id === f.id)),
    onRemove: canAttach ? () => void detach(f) : undefined,
  }));
  return <div id={`${issue.key}-files`} className={`${styles.blk} file-drop-target`} {...drop.bind}>
    <DropOverlay count={drop.dragging} hint={t('dropHintIssue')} />
    <h3>{t('attachments')} <span className="muted" style={{ fontWeight: 500 }}>{items.length}</span>{canAttach && <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>{uploads.status && <span className="muted" role="status" style={{ fontSize: 11, fontWeight: 500 }}>{uploads.status}</span>}<AttachButton onFiles={uploads.add} /></span>}</h3>
    {!items.length && !uploads.rows.length && files.data && <p className="muted">{t('noAttachments')}</p>}
    <AttachmentList rows={[...rows, ...uploads.rows]} label={t('attachments')} />
    {preview.props && <FilePreview {...preview.props} base={previewBase(scope)} filesHref={filesPageHref(scope)} />}
  </div>;
}

/** K2: ขั้นตอนทำซ้ำ และผลที่ควรเป็น / ผลจริง วางคู่กัน (เขียว / แดง) */
export function BugDetails({ issue, canEdit, disabled, save }: { issue: Issue; canEdit: boolean; disabled: boolean; save: (name: string, value: string) => Promise<boolean> }) {
  const t = useTranslations('issue-drawer');
  const field = (name: string) => canEdit
    ? <InlineText label={t(`detailFields.${name}`)} value={String(issue.details[name] ?? '')} enabled multiline busy={disabled} onSave={(value) => save(name, value)} />
    : <BodyText>{String(issue.details[name] ?? t('notSet'))}</BodyText>;
  return <div className={`${styles.blk} ${styles.bugFields}`}>
    <div><div className={styles.k}>{t('detailFields.steps')}</div>{field('steps')}</div>
    <div className={styles.pair}>
      <div className={styles.expected}><div className={styles.k}>{t('detailFields.expected')}</div>{field('expected')}</div>
      <div className={styles.actualBox}><div className={styles.k}>{t('detailFields.actual')}</div>{field('actual')}</div>
    </div>
    <div className={styles.pair}>
      <div><div className={styles.k}>{t('detailFields.browser')}</div>{field('browser')}</div>
      <div><div className={styles.k}>{t('detailFields.found_in')}</div>{field('found_in')}</div>
    </div>
  </div>;
}
