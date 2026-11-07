'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Button, Dialog, Input, Select, LoadingState, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure, PersonView } from './shared';
import { issuePath, issueQuery, type DueImpact, type Issue, type Scope } from './types';
import styles from './issue-drawer.module.css';

export function DueRequest({ scope, issue, initialDue, onClose }: { scope: Scope; issue: Issue; initialDue: string; onClose: () => void }) {
  const t = useTranslations('issue-drawer');
  const cache = useQueryClient(); const toast = useToast();
  const [due, setDue] = useState(initialDue);
  const [reason, setReason] = useState('scope_added');
  const [detail, setDetail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(due) && !!issue.planEnd && due > issue.planEnd;
  const endpoint = issuePath(scope.ws, issue.key);
  const impact = useQuery({ queryKey: [...issueQuery(scope.ws, issue.key), 'due-preview', due], queryFn: ({ signal }) => api.get<DueImpact>(`${endpoint}/due-requests/preview?due=${encodeURIComponent(due)}`, { signal }), enabled: valid });
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !valid || !impact.data || impact.isFetching || impact.error || !impact.data.approvers.length) return;
    lock.current = true; setPending(true); setError(null);
    try { await api.post(`${endpoint}/due-requests`, { requestedDue: due, reasonCode: reason, detail }); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issue.key) }); toast({ message: t('dueRequested') }); onClose(); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  const mark = (ok: boolean) => <span className={ok ? styles.impOk : styles.impWarn} aria-hidden="true">{ok ? '✓' : '!'}</span>;
  return <Dialog open title={t('requestDueTitle')} description={t('requestDueDescription', { key: issue.key })} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    {/* K3: Due ปัจจุบัน → Due ใหม่, เหตุผล, รายละเอียด, กล่องผลกระทบ (✓ / !), ผู้อนุมัติ */}
    <form className={styles.stack} onSubmit={submit} style={{ gap: 14 }}>
      <div className={styles.dueRow}>
        <label className="field">{t('currentDueLabel')}<input className="input" readOnly value={formatDate(issue.planEnd, scope.yearFormat)} /></label>
        <span aria-hidden="true" className={styles.dueArrow}>→</span>
        <Input label={t('requestedDue')} type="date" required value={due} onChange={(event) => setDue(event.target.value)} disabled={pending} />
      </div>
      {!!due && !valid && <p className="field-error">{t('dueMustBeLater')}</p>}
      <Select label={t('reason')} required value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending}>{['scope_added', 'waiting_input', 'blocked_by_dependency', 'estimate_wrong', 'other'].map((code) => <option value={code} key={code}>{t(`reasons.${code}`)}</option>)}</Select>
      <label className="field">{t('reasonDetail')}<textarea className="input" required={reason === 'other'} value={detail} maxLength={2000} onChange={(event) => setDetail(event.target.value)} disabled={pending} /></label>
      {impact.isFetching && valid && <LoadingState />}
      {!!impact.error && valid && <Failure error={impact.error} />}
      {impact.data && valid && !impact.isFetching && <>
        <div className={styles.impactBox}>
          <div className={styles.k}>{t('impactTitle')}</div>
          <div className={styles.imp}>{mark(false)}<span>{t('addedWorkingDays', { days: impact.data.addedWorkingDays })}</span></div>
          {impact.data.workload.map((work, index) => <div className={styles.imp} key={work.person?.id ?? index}>{mark(!work.overloaded)}<span><b>{work.person?.displayName ?? t('system')}</b> · {t('workloadValue', { md: work.otherWorkMd, capacity: work.capacityMd })}{work.overlapping.length > 0 && <> · {work.overlapping.map((other, i) => <span key={other.key}>{i > 0 && ', '}<button type="button" className={styles.textLink} onClick={() => { onClose(); scope.navigate(other.key); }}>{other.key} · {other.title}</button></span>)}</>}</span></div>)}
          {impact.data.dependents.filter((item) => item.affected).length === 0
            ? <div className={styles.imp}>{mark(true)}<span>{t('noDependentImpact', { key: issue.key })}</span></div>
            : impact.data.dependents.filter((item) => item.affected).map((item) => <div className={styles.imp} key={item.key}>{mark(false)}<span>{t('dependentImpact', { key: item.key, title: item.title })}</span></div>)}
          {impact.data.milestones.map((milestone) => <div className={styles.imp} key={milestone.id}>{mark(milestone.onTime)}<span>{t(milestone.onTime ? 'milestoneOnTime' : 'milestoneLate', { name: milestone.name, date: formatDate(milestone.date, scope.yearFormat) })}</span></div>)}
          <div className={styles.imp}>{mark(impact.data.goLive.onTime)}<span>{t(impact.data.goLive.onTime ? 'goLiveOnTime' : 'goLiveLate', { date: formatDate(impact.data.goLive.date, scope.yearFormat) })}</span></div>
          {impact.data.parent?.exceeded && <div className={styles.imp}>{mark(false)}<span>{t('parentDueExceeded', { key: impact.data.parent.key })}</span></div>}
          {impact.data.warnings.map((warning) => <div className={styles.imp} key={warning.code}>{mark(false)}<span>{warning.message}</span></div>)}
        </div>
        <div className={styles.approverLine} aria-label={t('approvers')}>{impact.data.approvers.length ? <>{impact.data.approvers.map((person) => <PersonView key={person.id} person={person} />)}<span className="muted">{t('sendToNote')}</span></> : <p className={styles.warningText}>{t('noApprover')}</p>}</div>
      </>}
      {!!error && <Failure error={error} />}
      <div className={`${styles.dialogActions} ${styles.dueFooter}`}><Button disabled={pending} onClick={onClose}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={pending || !valid || impact.isFetching || !!impact.error || !impact.data?.approvers.length}>{pending ? t('saving') : t('sendRequest')}</Button></div>
    </form>
  </Dialog>;
}
