'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Badge, Button, Input, Select, LoadingState, ErrorState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure } from './shared';
import { issuePath, issueQuery, type Issue, type Scope } from './types';
import styles from './issue-drawer.module.css';

interface TestRun {
  id: string; runNo: number; result: 'passed' | 'failed' | 'blocked';
  passedCount: number | null; totalCount: number | null; environment: string | null;
  commitSha: string | null; note: string | null; tester: { displayName: string } | null;
  createdAt: string; bugs: { key: string; title: string }[]; files: { id: string; name: string }[];
}

/** ผลทดสอบของ Sub-task ใช้ API ที่มีอยู่ เพื่อไม่ให้แท็บ M4 เป็นเพียงปุ่มว่าง */
export function TestRuns({ scope, issue, canEdit }: { scope: Scope; issue: Issue; canEdit: boolean }) {
  const t = useTranslations('issue-drawer.qa');
  const cache = useQueryClient();
  const endpoint = `${issuePath(scope.ws, issue.key)}/test-runs`;
  const queryKey = [...issueQuery(scope.ws, issue.key), 'test-runs'];
  const query = useQuery({ queryKey, queryFn: () => api.get<{ items: TestRun[] }>(endpoint) });
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<TestRun['result']>('passed');
  const [environment, setEnvironment] = useState('sit');
  const [passed, setPassed] = useState(''); const [total, setTotal] = useState('');
  const [note, setNote] = useState(''); const [commit, setCommit] = useState('');
  const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try {
      await api.post(endpoint, { result, environment, note: note.trim(), ...(commit.trim() ? { commitSha: commit.trim() } : {}), ...(passed !== '' && total !== '' ? { passedCount: Number(passed), totalCount: Number(total) } : {}) });
      await cache.invalidateQueries({ queryKey }); setEditing(false); setNote(''); setCommit(''); setPassed(''); setTotal('');
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
  return <div className={styles.blk}>
    <h3>{t('title')}{canEdit && !editing && <Button size="small" style={{ marginLeft: 'auto' }} onClick={() => { setError(null); setEditing(true); }}>{t('add')}</Button>}</h3>
    {query.isPending && <LoadingState />}{query.error != null && <ErrorState error={query.error} retry={() => void query.refetch()} />}
    {query.data?.items.length === 0 && <p className="muted">{t('empty')}</p>}
    {query.data?.items.map((run) => <article key={run.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><strong>#{run.runNo}</strong><Badge tone={run.result === 'passed' ? 'green' : run.result === 'failed' ? 'red' : 'amber'}>{t(run.result)}</Badge>{run.totalCount != null && <span>{run.passedCount}/{run.totalCount}</span>}<span className="muted">{run.environment?.toUpperCase()} · {formatDate(run.createdAt.slice(0, 10), scope.yearFormat)}</span></div>
      {run.tester && <p className="muted">{run.tester.displayName}{run.commitSha && ` · ${run.commitSha.slice(0, 7)}`}</p>}
      {run.note && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{run.note}</p>}
      {run.files.length > 0 && <p className="muted">{t('evidence')}: {run.files.map((file, index) => <span key={file.id}>{index > 0 && ', '}<a href={`/w/${encodeURIComponent(scope.ws)}/p/${encodeURIComponent(scope.projectKey)}/files?file=${encodeURIComponent(file.id)}`}>{file.name}</a></span>)}</p>}
      {run.bugs.map((bug) => <Button key={bug.key} size="small" onClick={() => scope.navigate(bug.key)}>{bug.key} · {bug.title}</Button>)}
      {run.result === 'failed' && !run.bugs.length && scope.access.permissions.includes('issue.create') && scope.project?.status !== 'archived' && <Button size="small" disabled={pending} onClick={() => void createBug(run)}>{t('createBug')}</Button>}
    </article>)}
    {editing && <form onSubmit={save} className={styles.stack}>
      <Select label={t('result')} value={result} onChange={(e) => setResult(e.target.value as TestRun['result'])} disabled={pending}>{(['passed', 'failed', 'blocked'] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Select>
      <div className={styles.grid2}><Input type="number" min={0} max={total === '' ? 32767 : Number(total)} label={t('passedCount')} value={passed} onChange={(e) => setPassed(e.target.value)} required={total !== ''} disabled={pending} /><Input type="number" min={passed === '' ? 0 : Number(passed)} max={32767} label={t('totalCount')} value={total} onChange={(e) => setTotal(e.target.value)} required={passed !== ''} disabled={pending} /></div>
      <Select label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} disabled={pending}>{['local', 'sit', 'uat', 'production'].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</Select>
      <Input label="Commit SHA" pattern="[0-9a-fA-F]{7,40}" value={commit} onChange={(e) => setCommit(e.target.value)} disabled={pending} />
      <label>{t('note')}<textarea className="input" style={{ width: '100%', minHeight: 80 }} value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} disabled={pending} /></label>
      <div className={styles.dialogActions}><Button type="button" onClick={() => setEditing(false)} disabled={pending}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={pending}>{t('save')}</Button></div>
    </form>}
    {error != null && <Failure error={error} />}
  </div>;
}
