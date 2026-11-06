'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Eye, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { AvatarStack, Badge, Button, Combobox, DatePicker, Dialog, Input, PriorityTag, Select, StatusPill, useToast, LoadingState, ErrorState } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { ActivityPanel } from './activity';
import { Checklist, DependencyPanel } from './issue-parts';
import { DueRequest } from './due-request';
import { BodyText, Failure, InlineText, Section } from './shared';
import { issuePath, issueQuery, projectPath, type Issue, type Named, type PublicPerson, type Scope } from './types';
import styles from './issue-drawer.module.css';

export function IssuePanel({ scope, issue, siblings = [], onDeleted }: { scope: Scope; issue: Issue; siblings?: Issue[]; onDeleted: (parentKey: string | null) => void }) {
  const t = useTranslations('issue-drawer');
  const cache = useQueryClient(); const toast = useToast();
  const endpoint = issuePath(scope.ws, issue.key);
  const key = issueQuery(scope.ws, issue.key);
  const canEdit = !scope.access.guestViewer && scope.access.permissions.includes('issue.edit') && scope.project?.status !== 'archived';
  const canDelete = !scope.access.guestViewer && scope.access.permissions.includes('issue.delete');
  const guest = scope.access.guestViewer;
  const [tab, setTab] = useState('details');
  const [moreProperties, setMoreProperties] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [reasonIntent, setReasonIntent] = useState<Record<string, unknown> | null>(null);
  const [planReason, setPlanReason] = useState('');
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelDue, setCancelDue] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const phases = useQuery({ queryKey: ['issue-options', scope.ws, scope.projectKey, 'phases', issue.moduleId], queryFn: ({ signal }) => api.get<{ items: Named[] }>(`${projectPath(scope.ws, scope.projectKey)}/modules/${encodeURIComponent(issue.moduleId!)}/phases`, { signal }), enabled: canEdit && !!issue.moduleId });
  const watchers = useQuery({ queryKey: [...key, 'watchers'], queryFn: ({ signal }) => api.get<{ items: { person: PublicPerson | null }[]; watching: boolean }>(`${endpoint}/watchers`, { signal }) });
  const impact = useQuery({ queryKey: [...key, 'delete-impact'], queryFn: () => api.get<{ counts: { subtasks: number; files: number; dependencies: number } }>(`${endpoint}/delete-impact`), enabled: deleteOpen && canDelete });
  const type = scope.project?.issueTypes?.find((type) => type.name === issue.type);
  const statuses = scope.project?.statuses?.filter((status) => status.workflowId === type?.workflowId) ?? [];
  const index = siblings.findIndex((item) => item.key === issue.key);
  async function refresh() {
    await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: ['kanban', scope.ws, scope.projectKey] }), cache.invalidateQueries({ queryKey: ['issue-drawer-list', scope.ws, scope.projectKey] })]);
    if (issue.parentKey) await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issue.parentKey) });
  }
  async function action(fn: () => Promise<unknown>, success?: (result: unknown) => void): Promise<boolean> {
    if (lock.current || conflict) return false;
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await fn() as Issue | undefined;
      if (result?.version) cache.setQueryData(key, (old: Issue | undefined) => old ? { ...old, ...result } : result);
      result?.warnings?.forEach((warning) => toast({ message: warning.message }));
      success?.(result);
      await refresh(); return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) setConflict(failure);
      else setError(failure);
      return false;
    } finally { lock.current = false; setBusy(false); }
  }
  async function patch(body: Record<string, unknown>, withReason = false): Promise<boolean> {
    if (!canEdit) return false;
    const saved = await action(async () => {
      try { return await api.patch<Issue>(endpoint, { ...body, ...(withReason ? { planChangeReason: planReason } : {}) }, issue.version); }
      catch (failure) {
        if (failure instanceof ApiError && failure.code === 'due_change_requires_approval' && failure.details.canRequest) { setDue(String(failure.details.requestedDue)); }
        if (failure instanceof ApiError && failure.code === 'plan_change_reason_required') { setReasonIntent(body); setPlanReason(''); }
        throw failure;
      }
    });
    if (saved) { setReasonIntent(null); setPlanReason(''); }
    return saved;
  }
  async function move(statusId: string, confirm = false) {
    await action(async () => {
      try { return await api.request<Issue>(`${endpoint}/move`, { method: 'POST', etag: issue.version, body: { statusId, confirm } }); }
      catch (failure) { if (failure instanceof ApiError && failure.code === 'subtasks_incomplete' && failure.details.confirmable) setConfirmStatus(statusId); throw failure; }
    }, () => setConfirmStatus(null));
  }
  const disabled = busy || !!conflict;
  const fieldSelect = (field: string, value: string | null | undefined, values: { id: string; name: string }[], change?: (value: string) => void, allowNone = true) => <Select label={t(`fields.${field}`)} value={value ?? ''} disabled={!canEdit || disabled} onChange={(event) => change ? change(event.target.value) : void patch({ [field]: event.target.value || null })}>
    {(allowNone || !value) && <option value="" disabled={!allowNone}>{t('notSet')}</option>}{values.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
  </Select>;
  const people = scope.people.map((person) => ({ id: person.id, name: person.displayName }));
  const pending = issue.pendingDueRequest;
  return <div className={styles.panel} aria-busy={busy}>
    <div className={styles.topbar}><div className={styles.actions}><Badge tone={issue.type === 'Bug' ? 'red' : 'blue'}>{issue.parentKey ? t('subtask') : t(`types.${issue.type}`)}</Badge><span className="muted">{issue.key}</span>{issue.type === 'Bug' && issue.reopenCount > 0 && <Badge tone="amber">{t('reopenedCount', { count: issue.reopenCount })}</Badge>}</div>
      <div className={styles.actions}>{watchers.data && <Button size="small" variant="ghost" disabled={disabled} aria-pressed={watchers.data.watching} onClick={() => void action(() => watchers.data!.watching ? api.delete(`${endpoint}/watch`) : api.post(`${endpoint}/watch`))}><Eye size={15} />{t(watchers.data.watching ? 'watching' : 'watch')} <span>{watchers.data.items.length}</span></Button>}
        {canDelete && <Button size="small" variant="ghost" aria-label={t('deleteIssue')} disabled={disabled} onClick={() => setDeleteOpen(true)}><Trash2 size={15} /></Button>}
      </div>
    </div>
    {issue.parentKey && <div className={styles.siblingBar}><button className={styles.textLink} onClick={() => scope.navigate(issue.parentKey!)}>↳ {issue.parentKey}</button><div className={styles.actions}><Button size="icon" variant="ghost" aria-label={t('previousSubtask')} disabled={index <= 0} onClick={() => scope.navigate(siblings[index - 1].key)}><ChevronLeft size={16} /></Button><Button size="icon" variant="ghost" aria-label={t('nextSubtask')} disabled={index < 0 || index >= siblings.length - 1} onClick={() => scope.navigate(siblings[index + 1].key)}><ChevronRight size={16} /></Button></div></div>}
    <div className={styles.title}><InlineText label={t('fields.title')} value={issue.title} enabled={canEdit} busy={disabled} onSave={(title) => patch({ title })} /></div>
    {conflict && <div role="alert" className={styles.conflict}><strong>{t('conflictTitle')}</strong><p>{t('conflictDescription')}</p>{!!(conflict.latest as Issue | undefined)?.title && <p>{t('latestTitle', { title: (conflict.latest as Issue).title })}</p>}{conflict.requestId && <code>{t('requestId', { id: conflict.requestId })}</code>}<Button size="small" onClick={async () => { await cache.invalidateQueries({ queryKey: key }); setConflict(null); setError(null); }}>{t('loadLatest')}</Button></div>}
    {!!error && <Failure error={error} />}
    {pending && !guest && <div className={styles.pending}><strong>{t('pendingDue', { date: formatDate(pending.requestedDue, scope.yearFormat, true) })}</strong><p>{t('waitingApproval')}</p>{pending.requesterId === scope.meId && <Button size="small" disabled={disabled} onClick={() => setCancelDue(true)}>{t('cancelRequest')}</Button>}</div>}
    {scope.project?.status === 'archived' && <p className={styles.notice}>{t('archived')}</p>}
    <div className={styles.layout}><div className={styles.main}>
      <div className={styles.tabs} role="tablist" aria-label={t('issueSections')}>{['details', ...(canEdit ? ['checklist', 'dependencies'] : []), 'activity'].map((value) => <button key={value} id={`${issue.key}-${value}-tab`} role="tab" aria-selected={tab === value} aria-controls={`${issue.key}-${value}-panel`} tabIndex={tab === value ? 0 : -1} onKeyDown={(event) => { const tabs = ['details', ...(canEdit ? ['checklist', 'dependencies'] : []), 'activity']; const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (offset) { event.preventDefault(); const next = tabs[(tabs.indexOf(value) + offset + tabs.length) % tabs.length]; setTab(next); document.getElementById(`${issue.key}-${next}-tab`)?.focus(); } }} onClick={() => setTab(value)}>{t(value)}</button>)}</div>
      <div role="tabpanel" id={`${issue.key}-${tab}-panel`} aria-labelledby={`${issue.key}-${tab}-tab`} className={styles.tabPanel}>
        {tab === 'details' && <div className={styles.stack}>
          <Section title={t('description')}><BodyText>{issue.description || t('noDescription')}</BodyText>{canEdit && <InlineText label={t('editDescription')} displayValue={t('editDescription')} value={issue.description ?? ''} enabled busy={disabled} multiline onSave={(description) => patch({ description: description || null })} />}</Section>
          {issue.type === 'Bug' && ['steps', 'expected', 'actual', 'browser', 'found_in'].map((name) => <Section key={name} title={t(`detailFields.${name}`)}>{canEdit ? <InlineText label={t(`detailFields.${name}`)} value={String(issue.details[name] ?? '')} enabled multiline busy={disabled} onSave={(value) => patch({ details: { ...issue.details, [name]: name === 'timebox_hours' ? Number(value) : value }, ...(name === 'timebox_hours' ? { estimateMd: Number(value) / 8 } : {}) })} /> : <BodyText>{String(issue.details[name] ?? t('notSet'))}</BodyText>}</Section>)}
          {issue.type === 'Story' && ['as_a', 'i_want', 'so_that'].map((name) => <Section key={name} title={t(`detailFields.${name}`)}>{canEdit ? <InlineText label={t(`detailFields.${name}`)} value={String(issue.details[name] ?? '')} enabled multiline busy={disabled} onSave={(value) => patch({ details: { ...issue.details, [name]: name === 'timebox_hours' ? Number(value) : value }, ...(name === 'timebox_hours' ? { estimateMd: Number(value) / 8 } : {}) })} /> : <BodyText>{String(issue.details[name] ?? t('notSet'))}</BodyText>}</Section>)}
          {issue.type === 'Spike' && ['question', 'timebox_hours', 'deliverable'].map((name) => <Section key={name} title={t(`detailFields.${name}`)}>{canEdit ? <InlineText label={t(`detailFields.${name}`)} value={String(issue.details[name] ?? '')} enabled multiline busy={disabled} onSave={(value) => patch({ details: { ...issue.details, [name]: name === 'timebox_hours' ? Number(value) : value }, ...(name === 'timebox_hours' ? { estimateMd: Number(value) / 8 } : {}) })} /> : <BodyText>{String(issue.details[name] ?? t('notSet'))}</BodyText>}</Section>)}
          {!issue.parentKey && <Section title={t('subtasks')} action={scope.access.permissions.includes('issue.create') && <Button size="small" variant="ghost" onClick={() => scope.createSubtask(issue)}><Plus size={14} />{t('addSubtask')}</Button>}>
            {(issue.subtasks ?? []).length === 0 && <p className="muted">{t('noSubtasks')}</p>}
            {issue.subtasks?.map((child) => <button key={child.key} className={styles.subtaskRow} onClick={() => scope.navigate(child.key)}><StatusPill status={child.status.category} label={child.status.name} /><span><small>{child.key}</small><strong>{child.title}</strong></span>{child.estimateMd !== null && <span className="muted">{t('md', { value: child.estimateMd })}</span>}<ChevronRight size={16} /></button>)}
          </Section>}
          {!guest && <Section title={t('watchers')}><div className={styles.people}>{watchers.data?.items.map((entry, index) => entry.person && <span key={entry.person.id ?? index} className={styles.watcher}>{entry.person.displayName}</span>)}</div></Section>}
        </div>}
        {tab === 'checklist' && canEdit && <Checklist scope={scope} issueKey={issue.key} />}
        {tab === 'dependencies' && canEdit && <DependencyPanel scope={scope} issueKey={issue.key} />}
        {tab === 'activity' && <ActivityPanel scope={scope} issueKey={issue.key} />}
      </div>
    </div>
    <aside className={styles.sidebar} aria-label={t('properties')}>
      {fieldSelect('statusId', issue.status.id, statuses.length ? statuses : [issue.status], (value) => void move(value), false)}
      {issue.type === 'Bug' && issue.status.category === 'done' && canEdit && <Button size="small" onClick={() => setReopenOpen(true)} disabled={disabled}><RotateCcw size={14} />{t('reopen')}</Button>}
      {!guest && (canEdit ? <Combobox label={t('fields.assigneeIds')} multiple options={scope.people} value={issue.assigneeIds ?? []} onValueChange={(ids) => { if (!disabled) void action(() => api.request<Issue>(`${endpoint}/assignees`, { method: 'PUT', etag: issue.version, body: { assigneeIds: ids } })); }} /> : <div><span className={styles.label}>{t('fields.assigneeIds')}</span><AvatarStack people={scope.people.filter((person) => issue.assigneeIds?.includes(person.id))} /></div>)}
      {fieldSelect('priority', issue.priority, ['urgent', 'high', 'medium', 'low'].map((id) => ({ id, name: t(`priority.${id}`) })), undefined, false)}
      {canEdit ? <DatePicker label={t('fields.planEnd')} value={issue.planEnd ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (disabled) return; if (value && issue.planEnd && value > issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly')) setDue(value); else void patch({ planEnd: value || null }); }} /> : <p><span className={styles.label}>{t('fields.planEnd')}</span>{formatDate(issue.planEnd, scope.yearFormat)}</p>}
      {canEdit && issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly') && !pending && <Button size="small" disabled={disabled} onClick={() => setDue('')}>{t('requestDue')}</Button>}
      <InlineText label={t('fields.progressPct')} type="number" min={0} max={100} value={issue.progressPct?.toString() ?? ''} enabled={canEdit} busy={disabled} onSave={(value) => patch({ progressPct: value ? Number(value) : null })} />
      <button className={styles.propertiesToggle} aria-expanded={moreProperties} aria-controls={`${issue.key}-more-properties`} onClick={() => setMoreProperties((value) => !value)}>{t('moreProperties')} <span aria-hidden="true">{moreProperties ? '−' : '+'}</span></button>
      <div id={`${issue.key}-more-properties`} className={`${styles.extraProperties} ${moreProperties ? styles.expandedProperties : ''}`}>
      {fieldSelect('size', issue.size, ['XS','S','M','L','XL'].map((id) => ({ id, name: id })))}
      {canEdit ? <DatePicker label={t('fields.planStart')} value={issue.planStart ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (!disabled) void patch({ planStart: value || null }); }} /> : <p><span className={styles.label}>{t('fields.planStart')}</span>{formatDate(issue.planStart, scope.yearFormat)}</p>}
      <InlineText label={t('fields.estimateMd')} type="number" step={0.25} min={0.25} max={9999} value={issue.estimateMd?.toString() ?? ''} enabled={canEdit} busy={disabled} onSave={(value) => patch({ estimateMd: value ? Number(value) : null })} />
      {!issue.parentKey ? <>{fieldSelect('moduleId', issue.moduleId, scope.project?.modules ?? [], (value) => void patch({ moduleId: value, phaseId: null }), false)}{canEdit && phases.error ? <Failure error={phases.error} /> : fieldSelect('phaseId', issue.phaseId, phases.data?.items ?? [])}{fieldSelect('sprintId', issue.sprintId, scope.project?.sprints ?? [])}</> : <div className={styles.inherited}><span className={styles.label}>{t('inherited')}</span><p>{scope.project?.modules.find((module) => module.id === issue.moduleId)?.name ?? t('notSet')}</p><p>{scope.project?.sprints.find((sprint) => sprint.id === issue.sprintId)?.name ?? t('backlog')}</p></div>}
      {!guest && ['baId', 'reviewerId', 'testerId'].map((field) => <div key={field}>{fieldSelect(field, issue[field as 'baId'], people)}</div>)}
      {issue.type === 'Bug' && <>{fieldSelect('severity', issue.severity, ['critical', 'major', 'minor'].map((id) => ({ id, name: t(`severity.${id}`) })), undefined, false)}{fieldSelect('environment', issue.environment, ['local', 'sit', 'uat', 'production'].map((id) => ({ id, name: t(`environment.${id}`) })), undefined, false)}</>}
      {!guest && canEdit && <label className={styles.checkboxLabel}><input type="checkbox" checked={issue.sharedWithGuests} disabled={disabled} onChange={(event) => void patch({ sharedWithGuests: event.target.checked })} />{t('sharedWithGuests')}</label>}
      <small className="muted">{t('updatedAt', { date: formatDate(issue.updatedAt, scope.yearFormat, true) })}</small>
      </div>
    </aside></div>
    {due !== null && <DueRequest key={`${issue.key}-${due}`} scope={scope} issue={issue} initialDue={due} onClose={() => { setDue(null); setError(null); }} />}
    <Dialog open={!!reasonIntent} title={t('planReasonTitle')} description={t('planReasonDescription')} onOpenChange={(open) => { if (!open && !busy) setReasonIntent(null); }}><form className={styles.stack} onSubmit={(event) => { event.preventDefault(); if (reasonIntent) void patch(reasonIntent, true); }}><Input label={t('planReason')} required value={planReason} maxLength={1000} onChange={(event) => setPlanReason(event.target.value)} /><Button type="submit" variant="primary" disabled={busy || !planReason.trim()}>{t('save')}</Button>{!!error && <Failure error={error} />}</form></Dialog>
    <Dialog open={!!confirmStatus} title={t('incompleteTitle')} description={t('incompleteDescription')} onOpenChange={(open) => { if (!open && !busy) { setConfirmStatus(null); setError(null); } }}><div className={styles.dialogActions}><Button disabled={busy} onClick={() => { setConfirmStatus(null); setError(null); }}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { if (confirmStatus) void move(confirmStatus, true); }}>{t('confirmMove')}</Button></div></Dialog>
    <Dialog open={deleteOpen} title={t('deleteIssue')} description={t('deleteIssueDescription', { key: issue.key })} onOpenChange={(open) => { if (!open && !busy) setDeleteOpen(false); }}>
      {impact.isLoading && <LoadingState />}{impact.error && <ErrorState error={impact.error} retry={() => void impact.refetch()} />}{impact.data && <p className={styles.impact}>{t('deleteImpact', { ...impact.data.counts })}</p>}<p className="muted">{t('restoreThirtyDays')}</p>
      <div className={styles.dialogActions}><Button disabled={busy} onClick={() => setDeleteOpen(false)}>{t('cancel')}</Button><Button variant="danger" disabled={disabled || !impact.data || !!impact.error} onClick={() => void action(() => api.delete(endpoint), () => { const deletedKey = issue.key; toast({ message: t('issueDeleted', { key: deletedKey }), undo: async () => { await api.post(`${endpoint}/restore`); await refresh(); scope.navigate(deletedKey); } }); setDeleteOpen(false); onDeleted(issue.parentKey); })}>{t('confirmDelete', { count: 1 + (impact.data?.counts.subtasks ?? 0) })}</Button></div>{!!error && <Failure error={error} />}
    </Dialog>
    <Dialog open={cancelDue} title={t('cancelRequest')} onOpenChange={(open) => { if (!open && !busy) setCancelDue(false); }}><div className={styles.dialogActions}><Button disabled={busy} onClick={() => setCancelDue(false)}>{t('back')}</Button><Button variant="danger" disabled={disabled} onClick={() => { if (pending) void action(() => api.post(`/w/${encodeURIComponent(scope.ws)}/due-requests/${encodeURIComponent(pending.id)}/cancel`, {}), () => setCancelDue(false)); }}>{t('cancelRequest')}</Button></div></Dialog>
    <Dialog open={reopenOpen} title={t('reopen')} description={t('reopenDescription')} onOpenChange={(open) => { if (!open && !busy) setReopenOpen(false); }}><div className={styles.dialogActions}><Button disabled={busy} onClick={() => setReopenOpen(false)}>{t('cancel')}</Button><Button variant="primary" disabled={disabled} onClick={() => void action(() => api.post(`${endpoint}/reopen`), () => setReopenOpen(false))}>{t('reopen')}</Button></div></Dialog>
  </div>;
}
