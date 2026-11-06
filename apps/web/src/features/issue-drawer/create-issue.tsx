'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Combobox, Dialog, Input, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure, Section } from './shared';
import { issuePath, projectPath, type FormOptions, type Issue, type IssueType, type Scope } from './types';
import styles from './issue-drawer.module.css';

type ChildDraft = { id: string; title: string; size: string; assigneeId: string; planEnd: string };
type Draft = { type: IssueType; subtask: boolean; parentKey: string; title: string; description: string; moduleId: string; phaseId: string; sprintId: string; statusId: string; priority: string; assigneeIds: string[]; baId: string; reviewerId: string; testerId: string; size: string; estimateMd: string; planStart: string; planEnd: string; severity: string; environment: string; details: Record<string, string>; acceptance: string; checklist: string; blockedBy: string; children: ChildDraft[]; shared: boolean };
const supported: IssueType[] = ['Task', 'Story', 'Bug', 'Spike'];
function removeDraft(key: string) { try { localStorage.removeItem(key); } catch { /* storage access must not block server writes */ } }
const lines = (value: string) => value.split('\n').map((line) => line.replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?/, '').trim()).filter(Boolean);
const defaultDraft = (type: IssueType, parent?: Issue | null): Draft => ({ type, subtask: !!parent, parentKey: parent?.key ?? '', title: '', description: '', moduleId: parent?.moduleId ?? '', phaseId: parent?.phaseId ?? '', sprintId: parent?.sprintId ?? '', statusId: '', priority: 'medium', assigneeIds: [], baId: '', reviewerId: '', testerId: '', size: 'M', estimateMd: '', planStart: '', planEnd: '', severity: 'major', environment: 'sit', details: {}, acceptance: '', checklist: '', blockedBy: '', children: [], shared: false });
function readDraft(key: string, fallback: Draft): Draft | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!saved || !Number.isFinite(saved.expiresAt) || saved.expiresAt < Date.now() || !saved.data || !supported.includes(saved.data.type)) return null;
    const clean = { ...fallback };
    for (const name of Object.keys(fallback) as (keyof Draft)[]) {
      const value = saved.data[name];
      if (typeof fallback[name] === 'string' && typeof value === 'string') Object.assign(clean, { [name]: value });
      if (typeof fallback[name] === 'boolean' && typeof value === 'boolean') Object.assign(clean, { [name]: value });
    }
    if (Array.isArray(saved.data.assigneeIds) && saved.data.assigneeIds.every((id: unknown) => typeof id === 'string')) clean.assigneeIds = saved.data.assigneeIds;
    if (saved.data.details && typeof saved.data.details === 'object' && !Array.isArray(saved.data.details)) clean.details = Object.fromEntries(Object.entries(saved.data.details).filter((entry) => typeof entry[1] === 'string')) as Record<string, string>;
    if (Array.isArray(saved.data.children)) clean.children = saved.data.children.filter((child: ChildDraft) => child && ['id','title','size','assigneeId','planEnd'].every((field) => typeof child[field as keyof ChildDraft] === 'string'));
    return clean;
  } catch { return null; }
}

export function CreateIssue({ scope, options, parent, initialType = 'Task', onCreated, onClose, registerClose }: {
  scope: Scope; options: FormOptions; parent?: Issue | null; initialType?: IssueType;
  onCreated: (issue: Issue) => void; onClose: () => void; registerClose: (handler: (() => void) | null) => void;
}) {
  const t = useTranslations('issue-drawer'); const toast = useToast();
  const draftKey = `friday:issue-draft:${scope.ws}:${scope.projectKey}:${scope.meId}`;
  const [restored] = useState(() => parent ? null : readDraft(draftKey, defaultDraft(initialType)));
  const [draft, setDraft] = useState<Draft>(() => restored ?? defaultDraft(initialType, parent));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [continueCreating, setContinueCreating] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [draftError, setDraftError] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const lock = useRef(false);
  const created = useRef<Issue | null>(null);
  const completed = useRef(new Set<string>());
  const [partial, setPartial] = useState<Issue | null>(null);
  const projectEndpoint = projectPath(scope.ws, scope.projectKey);
  const availableTypes = options.issueTypes.filter((type) => supported.includes(type.name as IssueType));
  const type = availableTypes.find((type) => type.name === draft.type);
  const required = new Set(type?.requiredFields ?? []);
  const parentKeyValid = new RegExp(`^${scope.projectKey}-[0-9]+$`, 'i').test(draft.parentKey);
  const parentIssue = useQuery({ queryKey: ['issue-parent', scope.ws, scope.projectKey, draft.parentKey], queryFn: ({ signal }) => api.get<Issue>(issuePath(scope.ws, draft.parentKey), { signal }), enabled: draft.subtask && parentKeyValid, initialData: parent?.key === draft.parentKey ? parent : undefined });
  const candidates = useQuery({ queryKey: ['issue-drawer-list', scope.ws, scope.projectKey, 'parents'], queryFn: ({ signal }) => api.get<{ items: Issue[] }>(`${projectEndpoint}/issues?level=task&limit=100`, { signal }), enabled: draft.subtask });
  const parents = candidates.data?.items.filter((issue) => !issue.parentKey) ?? [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(defaultDraft(initialType, parent));
  useEffect(() => { registerClose(() => { if (dirty || created.current) setCloseOpen(true); else onClose(); }); return () => registerClose(null); }, [dirty, onClose, registerClose]);
  function set<K extends keyof Draft>(name: K, value: Draft[K]) { setDraft((previous) => ({ ...previous, [name]: value })); }
  const setDetail = (name: string, value: string) => setDraft((previous) => ({ ...previous, details: { ...previous.details, [name]: value } }));
  function switchType(value: IssueType) { setDraft((previous) => ({ ...previous, type: value, statusId: '', ...(['Story','Spike'].includes(value) ? { subtask: false, parentKey: '' } : {}) })); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !type || (draft.subtask && (!parentIssue.data || parentIssue.error || parentIssue.data.parentKey))) return;
    if (!created.current && required.has('acceptance_criteria') && !lines(draft.acceptance).length) { setError(new Error(t('acceptanceRequired'))); return; }
    lock.current = true; setPending(true); setError(null);
    try {
      if (!created.current) {
        const details: Record<string, unknown> = { ...draft.details };
        if (draft.type === 'Spike' && details.timebox_hours) details.timebox_hours = Number(details.timebox_hours);
        const estimateMd = draft.type === 'Spike' ? Number(details.timebox_hours) / 8 : draft.estimateMd ? Number(draft.estimateMd) : options.sizeMdMap[draft.size];
        const input = {
          type: draft.type, title: draft.title.trim(), description: draft.description, priority: draft.priority,
          ...(draft.subtask ? { parentKey: draft.parentKey.trim() } : { moduleId: draft.moduleId || undefined, phaseId: draft.phaseId || undefined, sprintId: draft.sprintId || null }),
          statusId: draft.statusId || undefined, assigneeIds: draft.assigneeIds, baId: draft.baId || undefined, reviewerId: draft.reviewerId || undefined, testerId: draft.testerId || undefined,
          size: draft.type === 'Spike' ? undefined : draft.size || undefined, estimateMd: estimateMd || undefined, planStart: draft.planStart || undefined, planEnd: draft.planEnd || undefined,
          ...((draft.type === 'Bug' || required.has('severity') || required.has('environment')) ? { severity: draft.severity, environment: draft.environment } : {}), details, sharedWithGuests: draft.shared,
        };
        created.current = await api.post<Issue>(`${projectEndpoint}/issues`, input);
        setPartial(created.current);
        removeDraft(draftKey);
        created.current.warnings?.forEach((warning) => toast({ message: warning.message }));
      }
      const issue = created.current;
      async function once(id: string, action: () => Promise<unknown>) { if (!completed.current.has(id)) { await action(); completed.current.add(id); } }
      if (!draft.subtask) for (const child of draft.children) await once(`child-${child.id}`, () => api.post(`${projectEndpoint}/issues`, { type: 'Task', parentKey: issue.key, title: child.title.trim(), size: child.size, assigneeIds: child.assigneeId ? [child.assigneeId] : [], ...(child.planEnd ? { planEnd: child.planEnd } : {}) }));
      for (const [kind, content] of [['checklist', draft.checklist], ['acceptance', (draft.type === 'Story' || required.has('acceptance_criteria')) ? draft.acceptance : '']] as const) {
        for (const [index, text] of lines(content).entries()) await once(`${kind}-${index}`, () => api.post(`${issuePath(scope.ws, issue.key)}/checklist`, { text, kind }));
      }
      for (const peer of [...new Set(draft.blockedBy.split(/[\n,]/).map((key) => key.trim().toUpperCase()).filter(Boolean))]) await once(`dependency-${peer}`, () => api.post(`${issuePath(scope.ws, issue.key)}/dependencies`, { predecessorKey: peer, type: 'FS', lagDays: 0 }));
      if (continueCreating) { toast({ message: t('issueCreated', { key: issue.key }) }); created.current = null; completed.current.clear(); setPartial(null); setDraft(defaultDraft(draft.type, parent)); form.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus(); }
      else onCreated(issue);
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  const detailInput = (name: string, isRequired = false, numeric = false) => <label className="field" key={name}>{t.has(`detailFields.${name}`) ? t(`detailFields.${name}`) : name}{isRequired ? ' *' : ''}{numeric ? <input className="input" type="number" min={2} step={2} required={isRequired} value={draft.details[name] ?? ''} onChange={(event) => setDetail(name, event.target.value)} /> : <textarea className="input" required={isRequired} value={draft.details[name] ?? ''} onChange={(event) => setDetail(name, event.target.value)} />}</label>;
  const phases = options.phases?.filter((phase) => phase.moduleId === draft.moduleId) ?? options.modules.find((module) => module.id === draft.moduleId)?.phases ?? [];
  return <>
    {restored && !partial && <p className={styles.notice}>{t('draftRestored')}</p>}
    {partial && <div className={styles.pending}><strong>{t('mainIssueCreated', { key: partial.key })}</strong><p>{t('resumeCreation')}</p><Button size="small" onClick={() => onCreated(partial)}>{t('openIssue', { key: partial.key })}</Button></div>}
    <form ref={form} className={styles.createForm} onSubmit={submit} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); form.current?.requestSubmit(); } }}>
      <fieldset disabled={pending || !!partial} className={styles.createFields}>
        <div className={styles.typeChoices} role="group" aria-label={t('issueType')}>{availableTypes.map((option) => <Button key={option.id} aria-pressed={draft.type === option.name} className={draft.type === option.name ? styles.typeSelected : ''} onClick={() => switchType(option.name as IssueType)}>{t(`types.${option.name}`)}</Button>)}</div>
        {draft.type === 'Task' || draft.type === 'Bug' ? <label className={styles.checkboxLabel}><input type="checkbox" checked={draft.subtask} onChange={(event) => { set('subtask', event.target.checked); if (event.target.checked) set('children', []); }} />{t('createAsSubtask')}</label> : null}
        {draft.subtask && <div className={styles.stack}><Input label={t('parentKey')} value={draft.parentKey} required pattern={`${scope.projectKey}-[0-9]+`} onChange={(event) => set('parentKey', event.target.value.toUpperCase())} />
          {parents.length > 0 && <Select label={t('chooseParent')} value={parents.some((issue) => issue.key === draft.parentKey) ? draft.parentKey : ''} onChange={(event) => set('parentKey', event.target.value)}><option value="">{t('choose')}</option>{parents.map((parent) => <option key={parent.key} value={parent.key}>{parent.key} · {parent.title}</option>)}</Select>}
          {parentIssue.error && <Failure error={parentIssue.error} />}{parentIssue.data?.parentKey && <p className="field-error">{t('parentMustBeTask')}</p>}
          {parentIssue.data && !parentIssue.data.parentKey && <p className={styles.inherited}>{t('inheritsFrom', { key: parentIssue.data.key })} · {formatDate(parentIssue.data.planStart, scope.yearFormat)} – {formatDate(parentIssue.data.planEnd, scope.yearFormat)}</p>}
        </div>}
        {!draft.subtask && <div className={styles.formGrid}><Select label={t('fields.moduleId')} required={required.has('module') || draft.type === 'Task'} value={draft.moduleId} onChange={(event) => { set('moduleId', event.target.value); set('phaseId', ''); }}><option value="">{t('choose')}</option>{options.modules.map((module) => <option value={module.id} key={module.id}>{module.name}</option>)}</Select><Select label={t('fields.phaseId')} value={draft.phaseId} onChange={(event) => set('phaseId', event.target.value)}><option value="">{t('notSet')}</option>{phases.map((phase) => <option value={phase.id} key={phase.id}>{phase.name}</option>)}</Select><Select label={t('fields.sprintId')} value={draft.sprintId} onChange={(event) => set('sprintId', event.target.value)}><option value="">{t('backlog')}</option>{options.sprints.filter((sprint) => sprint.status !== 'completed').map((sprint) => <option value={sprint.id} key={sprint.id}>{sprint.name}</option>)}</Select></div>}
        <Input name="title" label={t('fields.title')} required maxLength={300} value={draft.title} onChange={(event) => set('title', event.target.value)} />
        <div className={styles.formGrid}><Select label={t('fields.statusId')} value={draft.statusId} onChange={(event) => set('statusId', event.target.value)}><option value="">{t('initialStatus')}</option>{type?.statuses?.map((status) => <option value={status.id} key={status.id}>{status.name}</option>)}</Select><Select label={t('fields.priority')} value={draft.priority} onChange={(event) => set('priority', event.target.value)}>{['urgent','high','medium','low'].map((priority) => <option value={priority} key={priority}>{t(`priority.${priority}`)}</option>)}</Select></div>
        <Combobox label={t('fields.assigneeIds')} multiple options={options.members} value={draft.assigneeIds} onValueChange={(ids) => { if (!lock.current && !created.current) set('assigneeIds', ids); }} />
        <div className={styles.formGrid}>{(['baId','reviewerId','testerId'] as const).map((name) => <Select key={name} label={t(`fields.${name}`)} value={draft[name]} onChange={(event) => set(name, event.target.value)}><option value="">{t('notSet')}</option>{options.members.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}</Select>)}</div>
        <div className={styles.formGrid}><Input type="date" label={t('fields.planStart')} value={draft.planStart} onChange={(event) => set('planStart', event.target.value)} /><Input type="date" label={t('fields.planEnd')} value={draft.planEnd} onChange={(event) => set('planEnd', event.target.value)} /><Select disabled={draft.type === 'Spike'} label={t('fields.size')} required={required.has('size')} value={draft.size} onChange={(event) => { set('size', event.target.value); set('estimateMd', ''); }}>{Object.entries(options.sizeMdMap).map(([size, md]) => <option value={size} key={size}>{size} · {t('md', { value: md })}</option>)}</Select><Input label={t('fields.estimateMd')} type="number" min={0.25} max={9999} step={0.25} readOnly={draft.type === 'Spike'} value={draft.type === 'Spike' ? (draft.details.timebox_hours ? Number(draft.details.timebox_hours) / 8 : '') : draft.estimateMd || (options.sizeMdMap[draft.size] ?? '').toString()} onChange={(event) => set('estimateMd', event.target.value)} /></div>
        <p className="muted">{t('endCalculated')}</p>
        <label className="field">{t('description')}<textarea className="input" value={draft.description} onChange={(event) => set('description', event.target.value)} maxLength={50000} /></label>
        {(draft.type === 'Bug' || required.has('severity') || required.has('environment') || required.has('steps')) && <><div className={styles.formGrid}><Select label={t('fields.severity')} required={required.has('severity')} value={draft.severity} onChange={(event) => set('severity', event.target.value)}>{['critical','major','minor'].map((value) => <option value={value} key={value}>{t(`severity.${value}`)}</option>)}</Select><Select label={t('fields.environment')} required={required.has('environment')} value={draft.environment} onChange={(event) => set('environment', event.target.value)}>{['local','sit','uat','production'].map((value) => <option value={value} key={value}>{t(`environment.${value}`)}</option>)}</Select></div>{detailInput('steps', required.has('steps'))}{detailInput('expected')}{detailInput('actual')}{detailInput('browser')}{detailInput('found_in')}</>}
        {(draft.type === 'Story' || required.has('user_story') || required.has('acceptance_criteria')) && <>{detailInput('as_a')}{detailInput('i_want', required.has('user_story'))}{detailInput('so_that')}<label className="field">{t('acceptance')}{required.has('acceptance_criteria') ? ' *' : ''}<textarea className="input" required={required.has('acceptance_criteria')} value={draft.acceptance} onChange={(event) => set('acceptance', event.target.value)} /></label></>}
        {(draft.type === 'Spike' || required.has('question') || required.has('timebox')) && <>{detailInput('question', required.has('question'))}{detailInput('timebox_hours', required.has('timebox'), true)}{detailInput('deliverable')}</>}
        {!draft.subtask && <Section title={t('subtasks')} action={<Button size="small" disabled={draft.children.length >= 20} onClick={() => set('children', [...draft.children, { id: crypto.randomUUID(), title: '', size: 'XS', assigneeId: '', planEnd: '' }])}><Plus size={14} />{t('addSubtask')}</Button>}>
          {draft.children.map((child, index) => <div className={styles.childDraft} key={child.id}><Input label={t('childTitle', { number: index + 1 })} required maxLength={300} value={child.title} onChange={(event) => set('children', draft.children.map((row) => row.id === child.id ? { ...row, title: event.target.value } : row))} /><Select label={t('fields.size')} value={child.size} onChange={(event) => set('children', draft.children.map((row) => row.id === child.id ? { ...row, size: event.target.value } : row))}>{Object.entries(options.sizeMdMap).map(([size, md]) => <option value={size} key={size}>{size} · {t('md', { value: md })}</option>)}</Select><Select label={t('fields.assigneeIds')} value={child.assigneeId} onChange={(event) => set('children', draft.children.map((row) => row.id === child.id ? { ...row, assigneeId: event.target.value } : row))}><option value="">{t('notSet')}</option>{options.members.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</Select><Input type="date" label={t('fields.planEnd')} value={child.planEnd} onChange={(event) => set('children', draft.children.map((row) => row.id === child.id ? { ...row, planEnd: event.target.value } : row))} /><Button size="icon" variant="ghost" aria-label={t('removeChild', { number: index + 1 })} onClick={() => set('children', draft.children.filter((row) => row.id !== child.id))}><Trash2 size={14} /></Button></div>)}
        </Section>}
        {scope.access.permissions.includes('issue.edit') && <><label className="field">{t('checklistLines')}<textarea className="input" value={draft.checklist} onChange={(event) => set('checklist', event.target.value)} /></label><Input label={t('blockedByKeys')} value={draft.blockedBy} onChange={(event) => set('blockedBy', event.target.value)} /></>}
        <label className={styles.checkboxLabel}><input type="checkbox" checked={draft.shared} onChange={(event) => set('shared', event.target.checked)} />{t('sharedWithGuests')}</label>
        <label className={styles.checkboxLabel}><input type="checkbox" checked={continueCreating} onChange={(event) => setContinueCreating(event.target.checked)} />{t('continueCreating')}</label>
      </fieldset>
      {!!error && <Failure error={error} />}
      <div className={styles.createFooter}><span className="muted">{t('createShortcut')}</span><Button onClick={() => { if (dirty || partial) setCloseOpen(true); else onClose(); }} disabled={pending}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={pending || !type || (draft.subtask && (!parentIssue.data || !!parentIssue.error || !!parentIssue.data.parentKey))}>{pending ? t('creating') : partial ? t('retryRemaining') : t('createType', { type: draft.subtask ? t('subtask') : t(`types.${draft.type}`) })}</Button></div>
    </form>
    <Dialog open={closeOpen} title={t(partial ? 'partialCloseTitle' : 'unsavedTitle')} description={t(partial ? 'partialCloseDescription' : 'unsavedDescription')} onOpenChange={setCloseOpen}>
      {draftError && <p className="field-error">{t('draftSaveFailed')}</p>}<div className={styles.dialogActions}><Button onClick={() => setCloseOpen(false)}>{t('keepEditing')}</Button>{!partial && <Button onClick={() => { try { localStorage.setItem(draftKey, JSON.stringify({ expiresAt: Date.now() + 7 * 86400000, data: draft })); onClose(); } catch { setDraftError(true); } }}>{t('saveDraft')}</Button>}<Button variant="danger" onClick={() => { removeDraft(draftKey); onClose(); }}>{t(partial ? 'close' : 'discard')}</Button></div>
    </Dialog>
  </>;
}
