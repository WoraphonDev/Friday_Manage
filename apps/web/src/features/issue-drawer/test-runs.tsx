'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Badge, Button, Input, Select, LoadingState, ErrorState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { UploadedFile } from '@/lib/upload';
import { Failure } from './shared';
import { AttachButton } from './task-v2';
import { filesPageHref, issuePath, issueQuery, previewBase, type Issue, type Scope } from './types';
import { FilePreview, useFilePreview } from '@/components/file-preview';
import styles from './issue-drawer.module.css';

interface TestRun {
  id: string; kind?: 'qa' | 'unit'; runNo: number; result: 'passed' | 'failed' | 'blocked';
  passedCount: number | null; totalCount: number | null; coveragePct?: number | null; environment: string | null;
  commitSha: string | null; note: string | null; tester: { displayName: string } | null;
  createdAt: string; bugs: { key: string; title: string }[]; files: { id: string; name: string }[];
}

/**
 * ผลทดสอบของงาน (Task และ Sub-task · ผู้ใช้ตัดสิน 2026-11-08)
 * kind = qa: ผลทดสอบของ QA / Reviewer · kind = unit: ผล Unit test ที่ Dev แนบเองในส่วน Development (แสดงเฉย ๆ ไม่บล็อกการย้ายงาน)
 */
export function TestRuns({ scope, issue, kind = 'qa', embedded = false }: { scope: Scope; issue: Issue; kind?: 'qa' | 'unit'; embedded?: boolean }) {
  // API บังคับ issue.record_test ไม่ใช่ issue.edit: ผู้ทดสอบ / Dev บันทึกผลได้แม้แก้งานไม่ได้
  const canRecord = !scope.access.guestViewer && scope.access.permissions.includes('issue.record_test') && scope.project?.status !== 'archived';
  const t = useTranslations('issue-drawer.qa');
  const cache = useQueryClient();
  const endpoint = `${issuePath(scope.ws, issue.key)}/test-runs`;
  const queryKey = [...issueQuery(scope.ws, issue.key), 'test-runs'];
  const query = useQuery({ queryKey, queryFn: () => api.get<{ items: TestRun[] }>(endpoint) });
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<TestRun['result']>('passed');
  const [environment, setEnvironment] = useState('sit');
  // ผู้ตรวจ: ค่าเริ่มต้น = QA / Reviewer ของงาน ถ้าไม่มี = คนที่บันทึก
  // QA หลายคน: ฉันเป็นหนึ่งใน QA ก็บันทึกในชื่อฉัน · ไม่ใช่ใช้ QA คนแรก
  const defaultTester = (scope.meId && issue.reviewerIds?.includes(scope.meId) ? scope.meId : issue.reviewerId) ?? scope.meId;
  const [tester, setTester] = useState(defaultTester);
  const [passed, setPassed] = useState(''); const [total, setTotal] = useState('');
  const [coverage, setCoverage] = useState('');
  const [note, setNote] = useState(''); const [commit, setCommit] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const unit = kind === 'unit';
  const runs = (query.data?.items ?? []).filter((run) => (run.kind ?? 'qa') === kind);
  function reset() { setEditing(false); setNote(''); setCommit(''); setPassed(''); setTotal(''); setCoverage(''); setFiles([]); setResult('passed'); setTester(defaultTester); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canRecord || lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      // ผลตรวจของ Reviewer เก็บแค่ ผ่าน/ไม่ผ่าน, ผู้ตรวจ, Environment, บันทึก/ขั้นตอนที่พบปัญหา และไฟล์ · จำนวนเคส / Commit / Coverage เป็นของ Unit test
      await api.post(endpoint, {
        kind, result, note: note.trim(), fileIds: files.map((file) => file.id),
        ...(unit
          ? {
              ...(commit.trim() ? { commitSha: commit.trim() } : {}),
              ...(passed !== '' && total !== '' ? { passedCount: Number(passed), totalCount: Number(total) } : {}),
              ...(coverage !== '' ? { coveragePct: Number(coverage) } : {}),
            }
          : { environment, ...(tester ? { testerId: tester } : {}) }),
      });
      await cache.invalidateQueries({ queryKey }); reset();
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  async function createBug(run: TestRun) {
    if (lock.current || (!scope.access.permissions.includes('issue.create') || scope.project?.status === 'archived')) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const bug = await api.post<Issue>(`${endpoint}/${run.id}/create-bug`, {});
      await Promise.all([cache.invalidateQueries({ queryKey }), cache.invalidateQueries({ queryKey: ['table', scope.ws, scope.projectKey] }), cache.invalidateQueries({ queryKey: ['kanban', scope.ws, scope.projectKey] })]);
      scope.navigate(bug.key);
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  const preview = useFilePreview();
  const body = <>
    {query.isPending && <LoadingState />}{query.error != null && <ErrorState error={query.error} retry={() => void query.refetch()} />}
    {query.data && runs.length === 0 && !editing && <p className="muted">{t(unit ? 'unitEmpty' : 'empty')}</p>}
    {runs.map((run) => <article key={run.id} className={styles.runCard}>
      <div className={styles.runHead}><strong>{t('round', { number: run.runNo })}</strong><Badge tone={run.result === 'passed' ? 'green' : run.result === 'failed' ? 'red' : 'amber'}>{t(run.result)}{run.totalCount != null && ` ${run.passedCount}/${run.totalCount}`}</Badge>
        {run.coveragePct != null && <span className={styles.chipSoft}>Coverage {run.coveragePct}%</span>}
        {run.commitSha && <code className="muted">{run.commitSha.slice(0, 7)}</code>}
        <span className={`muted ${styles.runMeta}`}>{run.tester && (unit ? run.tester.displayName : t('checkedBy', { name: run.tester.displayName }))}{run.tester && ' · '}{formatDate(run.createdAt.slice(0, 10), scope.yearFormat)}{run.environment && !unit && ` · ${run.environment.toUpperCase()}`}</span></div>
      {run.note && <div className={styles.runNote}>{!unit && <span className={styles.runNoteLabel}>{t(run.result === 'passed' ? 'noteLabel' : 'stepsLabel')}</span>}<p>{run.note}</p></div>}
      {run.files.length > 0 && <div className={styles.fileChips}>{run.files.map((file, index) => <button type="button" key={file.id} className={`${styles.chipSoft} ${styles.chipButton}`} aria-label={t('previewFile', { name: file.name })} onClick={() => preview.open(run.files, index)}>{file.name}</button>)}</div>}
      {run.bugs.map((bug) => <Button key={bug.key} size="small" onClick={() => scope.navigate(bug.key)}>{bug.key} · {bug.title}</Button>)}
      {!unit && run.result === 'failed' && !run.bugs.length && scope.access.permissions.includes('issue.create') && scope.project?.status !== 'archived' && <Button size="small" disabled={pending} onClick={() => void createBug(run)}>{t('createBug')}</Button>}
    </article>)}
    {editing && <form onSubmit={save} className={`${styles.stack} ${styles.runForm}`}>
      <div className="field"><span>{t('result')}</span>
        <div className={styles.resultPick} role="radiogroup" aria-label={t('result')}>
          {(unit ? (['passed', 'failed', 'blocked'] as const) : (['passed', 'failed'] as const)).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={result === value} data-result={value} className={styles.resultOpt} disabled={pending} onClick={() => setResult(value)}>{t(value)}</button>
          ))}
        </div>
      </div>
      {unit ? <>
        <div className={styles.grid2}><Input type="number" min={0} max={total === '' ? 32767 : Number(total)} label={t('passedCount')} value={passed} onChange={(e) => setPassed(e.target.value)} required={total !== ''} disabled={pending} /><Input type="number" min={passed === '' ? 0 : Number(passed)} max={32767} label={t('totalCount')} value={total} onChange={(e) => setTotal(e.target.value)} required={passed !== ''} disabled={pending} /></div>
        <Input type="number" min={0} max={100} step={0.01} label={t('coverage')} value={coverage} onChange={(e) => setCoverage(e.target.value)} disabled={pending} />
        <Input label="Commit SHA" pattern="[0-9a-fA-F]{7,40}" value={commit} onChange={(e) => setCommit(e.target.value)} disabled={pending} />
      </> : <div className={styles.grid2}>
        <Select label={t('checker')} value={tester} onChange={(e) => setTester(e.target.value)} disabled={pending}>
          {!scope.people.some((person) => person.id === tester) && <option value={tester}>{t('me')}</option>}
          {scope.people.map((person) => <option key={person.id} value={person.id}>{person.displayName}{person.id === scope.meId ? ` (${t('me')})` : ''}</option>)}
        </Select>
        <Select label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} disabled={pending}>{['local', 'sit', 'uat', 'production'].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</Select>
      </div>}
      <label className="field">{t(unit ? 'unitNote' : result === 'passed' ? 'noteLabel' : 'stepsLabel')}
        <textarea className="input" style={{ width: '100%', minHeight: 70 }} value={note} maxLength={5000} required={!unit && result === 'failed'} placeholder={!unit && result === 'failed' ? t('stepsPlaceholder') : undefined} onChange={(e) => setNote(e.target.value)} disabled={pending} />
      </label>
      <div className={styles.fileChips}>
        {files.map((file) => <span key={file.id} className={styles.chipSoft}>{file.name}<button type="button" className={styles.chipX} aria-label={t('removeFile', { name: file.name })} onClick={() => setFiles(files.filter((item) => item.id !== file.id))}><X size={12} aria-hidden="true" /></button></span>)}
        <AttachButton scope={scope} label={t(unit ? 'attachReport' : 'attachEvidence')} disabled={pending} onUploaded={(added) => setFiles((current) => [...current, ...added])} />
      </div>
      <div className={styles.dialogActions}><Button type="button" onClick={reset} disabled={pending}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={pending}>{t('save')}</Button></div>
    </form>}
    {error != null && <Failure error={error} />}
    {preview.props && <FilePreview {...preview.props} base={previewBase(scope)} filesHref={filesPageHref(scope)} />}
  </>;
  const addButton = canRecord && !editing && <Button size="small" style={{ marginLeft: 'auto' }} onClick={() => { setError(null); setEditing(true); }}>{t(unit ? 'addUnit' : 'add')}</Button>;
  // embedded = กล่องผล Unit test ในส่วน Development · ไม่ใช่ = หัวข้อผลทดสอบ QA ของงาน
  return embedded
    ? <div className={styles.unitBox}><div className={styles.runHead}><strong>{t('unitTitle')}</strong><span className="muted">{t('rounds', { count: runs.length })}</span>{addButton}</div>{body}</div>
    : <div className={styles.blk}><h3>{t('title')} <span className="muted" style={{ fontWeight: 500 }}>{t('rounds', { count: runs.length })}</span>{addButton}</h3>{body}</div>;
}
