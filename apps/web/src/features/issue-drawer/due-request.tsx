'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Button, Dialog, Input, Select, LoadingState, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure, PersonView, Section } from './shared';
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
  return <Dialog open title={t('requestDueTitle')} description={t('requestDueDescription', { key: issue.key })} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <form className={styles.stack} onSubmit={submit}>
      <p className="muted">{t('currentDue', { date: formatDate(issue.planEnd, scope.yearFormat, true) })}</p>
      <Input label={t('requestedDue')} type="date" required value={due} onChange={(event) => setDue(event.target.value)} disabled={pending} />
      {!!due && !valid && <p className="field-error">{t('dueMustBeLater')}</p>}
      <Select label={t('reason')} required value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending}>{['scope_added', 'waiting_input', 'blocked_by_dependency', 'estimate_wrong', 'other'].map((code) => <option value={code} key={code}>{t(`reasons.${code}`)}</option>)}</Select>
      <label className="field">{t('reasonDetail')}<textarea className="input" required={reason === 'other'} value={detail} maxLength={2000} onChange={(event) => setDetail(event.target.value)} disabled={pending} /></label>
      {impact.isFetching && valid && <LoadingState />}
      {!!impact.error && valid && <Failure error={impact.error} />}
      {impact.data && valid && !impact.isFetching && <div className={styles.impact}>
        <Section title={t('impact')}><p>{t('addedWorkingDays', { days: impact.data.addedWorkingDays })}</p>
          {impact.data.workload.map((work, index) => <div className={styles.impactRow} key={work.person?.id ?? index}><PersonView person={work.person} /><p className={work.overloaded ? styles.warningText : 'muted'}>{t('workloadValue', { md: work.otherWorkMd, capacity: work.capacityMd })}</p>{work.overlapping.map((other) => <button type="button" className={styles.textLink} key={other.key} onClick={() => { onClose(); scope.navigate(other.key); }}>{other.key} · {other.title}</button>)}</div>)}
          {impact.data.dependents.filter((item) => item.affected).map((item) => <p key={item.key} className={styles.warningText}>{t('dependentImpact', { key: item.key, title: item.title })}</p>)}
          {impact.data.milestones.map((milestone) => <p key={milestone.id} className={!milestone.onTime ? styles.warningText : 'muted'}>{t(milestone.onTime ? 'milestoneOnTime' : 'milestoneLate', { name: milestone.name, date: formatDate(milestone.date, scope.yearFormat) })}</p>)}
          <p className={impact.data.goLive.onTime ? 'muted' : styles.warningText}>{t(impact.data.goLive.onTime ? 'goLiveOnTime' : 'goLiveLate', { date: formatDate(impact.data.goLive.date, scope.yearFormat) })}</p>
          {impact.data.parent?.exceeded && <p className={styles.warningText}>{t('parentDueExceeded', { key: impact.data.parent.key })}</p>}
          {impact.data.warnings.map((warning) => <p className={styles.warningText} key={warning.code}>{warning.message}</p>)}
        </Section>
        <Section title={t('approvers')}>{impact.data.approvers.length ? impact.data.approvers.map((person) => <PersonView key={person.id} person={person} />) : <p className={styles.warningText}>{t('noApprover')}</p>}</Section>
      </div>}
      {!!error && <Failure error={error} />}
      <div className={styles.dialogActions}><Button disabled={pending} onClick={onClose}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={pending || !valid || impact.isFetching || !!impact.error || !impact.data?.approvers.length}>{pending ? t('saving') : t('sendRequest')}</Button></div>
    </form>
  </Dialog>;
}
