'use client';
// ส่วนย่อยของ Drawer รายละเอียดงานตาม Canvas C / D / K2 (แถวคุณสมบัติ, Sub-task, Development, ไฟล์แนบ, Bug)
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { GitBranch } from 'lucide-react';
import { Avatar, Button, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { BodyText, InlineText } from './shared';
import { TestRuns } from './test-runs';
import { AttachButton } from './task-v2';
import { issuePath, projectPath, type Issue, type Scope } from './types';
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
  const late = !done && !!child.planEnd && child.planEnd < today;
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
    <TestRuns scope={scope} issue={issue} kind="unit" embedded />
  </div>;
}

interface Attached { id: string; name: string; mime: string | null; kind: 'upload' | 'link'; linkUrl: string | null; uploader: { displayName: string } | null; createdAt: string }
export function Attachments({ scope, issue }: { scope: Scope; issue: Issue }) {
  const t = useTranslations('issue-drawer');
  const canAttach = !scope.access.guestViewer && scope.access.permissions.includes('issue.edit') && scope.project?.status !== 'archived';
  const files = useQuery({ queryKey: ['issue-files', scope.ws, issue.key], queryFn: ({ signal }) => api.get<{ items: Attached[] }>(`${projectPath(scope.ws, scope.projectKey)}/files?target=${encodeURIComponent(`issue:${issue.key}`)}`, { signal }), retry: false });
  if (files.error) return null;
  const items = files.data?.items ?? [];
  const ext = (f: Attached) => (f.name.split('.').pop() ?? '').slice(0, 4).toUpperCase();
  const tone = (e: string) => e === 'PDF' ? styles.fPdf : ['XLSX', 'XLS', 'CSV'].includes(e) ? styles.fXls : ['PNG', 'JPG', 'JPEG', 'GIF', 'MP4'].includes(e) ? styles.fImg : styles.fDoc;
  return <div className={styles.blk}>
    <h3>{t('attachments')} <span className="muted" style={{ fontWeight: 500 }}>{items.length}</span>{canAttach && <span style={{ marginLeft: 'auto' }}><AttachButton scope={scope} attach={{ targetType: 'issue', target: issue.key }} onUploaded={async () => { await files.refetch(); }} /></span>}</h3>
    {!items.length && files.data && <p className="muted">{t('noAttachments')}</p>}
    <div className={styles.files}>
      {items.map((f) => <a key={f.id} className={styles.file} href={f.kind === 'link' && f.linkUrl ? f.linkUrl : `/w/${encodeURIComponent(scope.ws)}/p/${encodeURIComponent(scope.projectKey)}/files?file=${f.id}`} target={f.kind === 'link' ? '_blank' : undefined} rel="noopener noreferrer">
        <span className={`${styles.fIcon} ${tone(ext(f))}`}>{ext(f) || 'FILE'}</span>
        <span style={{ minWidth: 0 }}><b>{f.name}</b><small className="muted">{f.uploader?.displayName ?? ''} · {formatDate(f.createdAt, scope.yearFormat)}</small></span>
      </a>)}
    </div>
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
