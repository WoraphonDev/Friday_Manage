'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Info, Plus, Trash2, X } from 'lucide-react';
import { Button, Combobox, DatePicker, Dialog, DrawerClose, Input, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Failure } from './shared';
import { CodeChips, LabelChips } from './refs';
import { PropRow } from './detail-parts';
import { DraftList, IssuePicker, useProjectIssues } from './task-v2';
import { issuePath, projectPath, type FormOptions, type Issue, type IssueType, type Scope } from './types';
import styles from './issue-drawer.module.css';

type ChildDraft = { id: string; title: string; size: string; assigneeId: string; planEnd: string };
type Draft = {
  type: IssueType; subtask: boolean; parentKey: string; title: string; description: string; moduleId: string; phaseId: string; statusId: string; priority: string;
  assigneeIds: string[]; baId: string; saId: string; reviewerId: string; size: string; estimateMd: string; planStart: string; planEnd: string;
  severity: string; environment: string; details: Record<string, string>; acceptance: string[]; checklist: string[]; blockedBy: string[]; children: ChildDraft[];
  shared: boolean; requirements: string[]; screens: string[]; labelIds: string[]; watcherIds: string[];
};
const supported: IssueType[] = ['Task', 'Story', 'Bug', 'Spike'];
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL'];
const LIST_FIELDS = ['assigneeIds', 'requirements', 'screens', 'labelIds', 'watcherIds', 'acceptance', 'checklist', 'blockedBy'] as const;
function removeDraft(key: string) { try { localStorage.removeItem(key); } catch { /* storage access must not block server writes */ } }
const defaultDraft = (type: IssueType, parent?: Issue | null): Draft => ({
  type, subtask: !!parent, parentKey: parent?.key ?? '', title: '', description: '', moduleId: parent?.moduleId ?? '', phaseId: parent?.phaseId ?? '', statusId: '', priority: 'medium',
  assigneeIds: [], baId: '', saId: '', reviewerId: '', size: 'M', estimateMd: '', planStart: '', planEnd: '', severity: 'major', environment: 'sit', details: {},
  acceptance: [], checklist: [], blockedBy: [], children: [], shared: false, requirements: [], screens: [], labelIds: [], watcherIds: [],
});
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
    for (const name of LIST_FIELDS) {
      const list = saved.data[name];
      if (Array.isArray(list) && list.every((id: unknown) => typeof id === 'string')) clean[name] = list;
    }
    if (saved.data.details && typeof saved.data.details === 'object' && !Array.isArray(saved.data.details)) clean.details = Object.fromEntries(Object.entries(saved.data.details).filter((entry) => typeof entry[1] === 'string')) as Record<string, string>;
    if (Array.isArray(saved.data.children)) clean.children = saved.data.children.filter((child: ChildDraft) => child && ['id', 'title', 'size', 'assigneeId', 'planEnd'].every((field) => typeof child[field as keyof ChildDraft] === 'string'));
    return clean;
  } catch { return null; }
}

/**
 * B2: สร้างงานใช้หน้าตาเดียวกับหน้าดู Task (C2) · ผู้ใช้ตัดสิน 2026-11-08
 * ซ้าย = ชื่อ คำอธิบาย Acceptance criteria / Checklist / Sub-task / Dependency · ขวา = ผู้รับผิดชอบ / แผนงาน / กลุ่มงาน
 * ไฟล์แนบ ผลทดสอบ Development และคอมเมนต์ เพิ่มได้หลังสร้าง (หน้าเปลี่ยนเป็นหน้าดู Task)
 */
export function CreateIssue({ scope, options, parent, initialType = 'Task', initialContext, onCreated, onClose, registerClose }: {
  scope: Scope; options: FormOptions; parent?: Issue | null; initialType?: IssueType;
  initialContext?: { moduleId?: string; phaseId?: string; statusId?: string };
  /** เดิม modal = K1 · ตอนนี้ใช้หน้าตาเดียวกันทุกที่ คงไว้ให้ผู้เรียกเดิมส่งได้ */
  layout?: 'drawer' | 'modal';
  onCreated: (issue: Issue) => void; onClose: () => void; registerClose: (handler: (() => void) | null) => void;
}) {
  const t = useTranslations('issue-drawer'); const toast = useToast();
  const cache = useQueryClient();
  const initialModule = options.modules.find((module) => module.id === initialContext?.moduleId);
  const initialPhases = options.phases?.filter((phase) => phase.moduleId === initialModule?.id) ?? initialModule?.phases ?? [];
  const initialPhase = initialPhases.find((phase) => phase.id === initialContext?.phaseId);
  const initialStatus = options.issueTypes.find((type) => type.name === initialType)?.statuses?.find((status) => status.id === initialContext?.statusId);
  const freshDraft = (type: IssueType): Draft => ({ ...defaultDraft(type, parent), ...(!parent ? { moduleId: initialModule?.id ?? '', phaseId: initialPhase?.id ?? '', statusId: initialStatus?.id ?? '' } : {}) });
  // ร่างที่เริ่มใน Module หนึ่งต้องไม่ไปแทนร่างของอีก Module
  const contextKey = initialModule ? `:${initialModule.id}:${initialPhase?.id ?? ''}` : initialStatus ? `:status:${initialStatus.id}` : '';
  const draftKey = `friday:issue-draft:${scope.ws}:${scope.projectKey}:${scope.meId}${contextKey}`;
  const [restored] = useState(() => parent ? null : readDraft(draftKey, freshDraft(initialType)));
  const [draft, setDraft] = useState<Draft>(() => restored ?? freshDraft(initialType));
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
  const projectIssues = useProjectIssues(scope);
  const parents = (projectIssues.data?.items ?? []).filter((issue) => !issue.parentKey);
  const dirty = JSON.stringify(draft) !== JSON.stringify(freshDraft(initialType));
  useEffect(() => { registerClose(() => { if (dirty || created.current) setCloseOpen(true); else onClose(); }); return () => registerClose(null); }, [dirty, onClose, registerClose]);
  function set<K extends keyof Draft>(name: K, value: Draft[K]) { setDraft((previous) => ({ ...previous, [name]: value })); }
  const setDetail = (name: string, value: string) => setDraft((previous) => ({ ...previous, details: { ...previous.details, [name]: value } }));
  function switchType(value: IssueType) { setDraft((previous) => ({ ...previous, type: value, statusId: '', ...(['Story', 'Spike'].includes(value) ? { subtask: false, parentKey: '' } : {}) })); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !type || (draft.subtask && (!parentIssue.data || parentIssue.error || parentIssue.data.parentKey))) return;
    if (!created.current && required.has('acceptance_criteria') && !draft.acceptance.length) { setError(new Error(t('acceptanceRequired'))); return; }
    lock.current = true; setPending(true); setError(null);
    try {
      if (!created.current) {
        const details: Record<string, unknown> = { ...draft.details };
        if (draft.type === 'Spike' && details.timebox_hours) details.timebox_hours = Number(details.timebox_hours);
        const estimateMd = draft.type === 'Spike' ? Number(details.timebox_hours) / 8 : draft.estimateMd ? Number(draft.estimateMd) : options.sizeMdMap[draft.size];
        const input = {
          type: draft.type, title: draft.title.trim(), description: draft.description, priority: draft.priority,
          // Sprint ไม่อยู่ในหน้า Task แล้ว (ผู้ใช้ตัดสิน 2026-11-08) งานใหม่เข้า Backlog แล้วจัดเข้า Sprint ที่หน้า Backlog
          ...(draft.subtask ? { parentKey: draft.parentKey.trim() } : { moduleId: draft.moduleId || undefined, phaseId: draft.phaseId || undefined }),
          statusId: draft.statusId || undefined, assigneeIds: draft.assigneeIds, baId: draft.baId || undefined, saId: draft.saId || undefined, reviewerId: draft.reviewerId || undefined,
          size: draft.type === 'Spike' ? undefined : draft.size || undefined, estimateMd: estimateMd || undefined, planStart: draft.planStart || undefined, planEnd: draft.planEnd || undefined,
          ...((draft.type === 'Bug' || required.has('severity') || required.has('environment')) ? { severity: draft.severity, environment: draft.environment } : {}), details, sharedWithGuests: draft.shared,
          requirements: draft.requirements, screens: draft.screens,
          // Label / ผู้ติดตามที่ถูกลบออกจากโปรเจกต์ระหว่างเก็บร่าง ไม่ส่งไปให้ API ปฏิเสธทั้งฟอร์ม
          labelIds: draft.labelIds.filter((id) => options.labels.some((label) => label.id === id)),
          watcherIds: draft.watcherIds.filter((id) => options.members.some((person) => person.id === id)),
        };
        created.current = await api.post<Issue>(`${projectEndpoint}/issues`, input);
        setPartial(created.current);
        removeDraft(draftKey);
        created.current.warnings?.forEach((warning) => toast({ message: warning.message }));
      }
      const issue = created.current;
      async function once(id: string, action: () => Promise<unknown>) { if (!completed.current.has(id)) { await action(); completed.current.add(id); } }
      if (!draft.subtask) for (const child of draft.children) await once(`child-${child.id}`, () => api.post(`${projectEndpoint}/issues`, { type: 'Task', parentKey: issue.key, title: child.title.trim(), size: child.size, assigneeIds: child.assigneeId ? [child.assigneeId] : [], ...(child.planEnd ? { planEnd: child.planEnd } : {}) }));
      for (const [kind, items] of [['acceptance', draft.acceptance], ['checklist', draft.checklist]] as const) {
        for (const [index, text] of items.entries()) await once(`${kind}-${index}`, () => api.post(`${issuePath(scope.ws, issue.key)}/checklist`, { text, kind }));
      }
      for (const peer of [...new Set(draft.blockedBy)]) await once(`dependency-${peer}`, () => api.post(`${issuePath(scope.ws, issue.key)}/dependencies`, { predecessorKey: peer, type: 'FS', lagDays: 0 }));
      await Promise.all(['table', 'overview', 'kanban', 'timeline', 'gantt', 'calendar', 'backlog', 'issue-drawer-list'].map((key) => cache.invalidateQueries({ queryKey: [key, scope.ws, scope.projectKey] })));
      if (continueCreating) { toast({ message: t('issueCreated', { key: issue.key }) }); created.current = null; completed.current.clear(); setPartial(null); setDraft(freshDraft(draft.type)); form.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus(); }
      else onCreated(issue);
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  // Browser / Found in เป็นข้อความบรรทัดเดียวตาม K1 · ช่องอื่นเป็นหลายบรรทัด
  const singleLine = new Set(['browser', 'found_in']);
  const detailInput = (name: string, isRequired = false, numeric = false) => <label className="field" key={name}>{t.has(`detailFields.${name}`) ? t(`detailFields.${name}`) : name}{isRequired ? ' *' : ''}{numeric ? <input className="input" type="number" min={2} step={2} required={isRequired} value={draft.details[name] ?? ''} onChange={(event) => setDetail(name, event.target.value)} /> : singleLine.has(name) ? <input className="input" required={isRequired} value={draft.details[name] ?? ''} onChange={(event) => setDetail(name, event.target.value)} /> : <textarea className={`input ${name === 'steps' ? styles.taSteps : styles.taShort}`} required={isRequired} value={draft.details[name] ?? ''} onChange={(event) => setDetail(name, event.target.value)} />}</label>;
  const canSubtask = draft.type === 'Task' || draft.type === 'Bug';
  const isBug = draft.type === 'Bug';
  const parentRow = draft.subtask ? parentIssue.data : null;
  const moduleId = parentRow ? parentRow.moduleId : draft.moduleId;
  const mod = options.modules.find((module) => module.id === moduleId);
  const modColor = mod?.color ?? '#1d4ed8';
  const people = options.members.map((person) => ({ id: person.id, name: person.displayName }));
  const personSelect = (name: 'baId' | 'saId' | 'reviewerId', label: string) => <Select label={label} value={draft[name]} onChange={(event) => set(name, event.target.value)}><option value="">{t('notSet')}</option>{people.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</Select>;
  const sizeOptions = Object.entries(options.sizeMdMap).sort(([a], [b]) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
  const mdValue = draft.type === 'Spike' ? (draft.details.timebox_hours ? Number(draft.details.timebox_hours) / 8 : '') : draft.estimateMd || (options.sizeMdMap[draft.size] ?? '').toString();
  const bugSection = <div className={styles.typeSection}>
    <div className={styles.grid2}>{detailInput('browser')}{detailInput('found_in')}</div>
    {detailInput('steps', required.has('steps'))}
    <div className={styles.grid2}>{detailInput('expected')}{detailInput('actual')}</div>
  </div>;
  const storySection = <div className={styles.typeSection}>{detailInput('as_a')}{detailInput('i_want', required.has('user_story'))}{detailInput('so_that')}</div>;
  const spikeSection = <div className={styles.typeSection}>{detailInput('question', required.has('question'))}{detailInput('timebox_hours', required.has('timebox'), true)}{detailInput('deliverable')}</div>;
  const showBug = isBug || required.has('steps');
  const showStory = draft.type === 'Story' || required.has('user_story');
  const showSpike = draft.type === 'Spike' || required.has('question') || required.has('timebox');
  const submitLabel = pending ? t('creating') : partial ? t('retryRemaining') : t('createType', { type: draft.subtask ? t('subtask') : t(`types.${draft.type}`) });
  const submitDisabled = pending || !type || (draft.subtask && (!parentIssue.data || !!parentIssue.error || !!parentIssue.data.parentKey));
  const cancel = () => { if (dirty || partial) setCloseOpen(true); else onClose(); };
  const updateChild = (id: string, patch: Partial<ChildDraft>) => set('children', draft.children.map((row) => row.id === id ? { ...row, ...patch } : row));
  return <>
    {/* แถบหัวเหมือนหน้าดู Task: ตำแหน่งงาน + ประเภท + Task / Sub-task + ปิด · Sub-task ที่เปิดจาก Task ใช้หัวของ Drawer ชั้นสอง */}
    {!parent && <div className={styles.dhead}>
      <nav aria-label={t('breadcrumb')} className={styles.crumb}>
        {mod && <span className={styles.modPill} style={{ background: `${modColor}1a`, color: modColor }}>{mod.name}</span>}
        {parentRow && <><span className="muted">›</span><span>{parentRow.key}</span></>}
        {(mod || parentRow) && <span className="muted">›</span>}<strong>{draft.subtask ? t('newSubtask') : t('newOfType', { type: t(`types.${draft.type}`) })}</strong>
      </nav>
      <div className={styles.actions}>
        {!draft.subtask && availableTypes.length > 1 && <select className={styles.typeSelect} aria-label={t('issueType')} value={draft.type} onChange={(event) => switchType(event.target.value as IssueType)}>{availableTypes.map((option) => <option key={option.id} value={option.name}>{t(`types.${option.name}`)}</option>)}</select>}
        {canSubtask && <div className={styles.toggle} role="group" aria-label={t('createAs')}><button type="button" aria-pressed={!draft.subtask} onClick={() => set('subtask', false)}>{t(`types.${draft.type}`)}</button><button type="button" aria-pressed={draft.subtask} onClick={() => { set('subtask', true); set('children', []); }}>{t('subtask')}</button></div>}
        <DrawerClose asChild><Button size="icon" variant="ghost" aria-label={t('close')}><X size={18} /></Button></DrawerClose>
      </div>
    </div>}
    {restored && !partial && <p className={styles.notice} style={{ margin: '12px 24px 0' }}>{t('draftRestored')}</p>}
    {partial && <div className={styles.pending} style={{ margin: '12px 24px 0' }}><strong>{t('mainIssueCreated', { key: partial.key })}</strong><p>{t('resumeCreation')}</p><Button size="small" onClick={() => onCreated(partial)}>{t('openIssue', { key: partial.key })}</Button></div>}
    <form ref={form} className={styles.createForm} onSubmit={submit} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); form.current?.requestSubmit(); } }}>
      <fieldset disabled={pending || !!partial} className={styles.createFields}>
        <div className={styles.layout}>
          <div className={styles.main}>
            <div className={styles.createTitle}><Input name="title" label={draft.subtask ? t('subtaskName') : t('typeName', { type: t(`types.${draft.type}`) })} required maxLength={300} placeholder={t('titlePlaceholder')} value={draft.title} onChange={(event) => set('title', event.target.value)} /></div>
            <div className={styles.statusRow}>
              <select className={`${styles.statusPill} ${styles.sTodo}`} aria-label={t('fields.statusId')} value={draft.statusId} onChange={(event) => set('statusId', event.target.value)}>
                <option value="">{t('initialStatus')}</option>{type?.statuses?.map((status) => <option value={status.id} key={status.id}>{status.name}</option>)}
              </select>
            </div>
            {(showBug || showStory || showSpike) && <div className={styles.blk}>{showBug && bugSection}{showStory && storySection}{showSpike && spikeSection}</div>}
            <div className={styles.blk}>
              <h3>{t('description')}</h3>
              <textarea className={`input ${styles.editor}`} aria-label={t('description')} placeholder={t('descriptionPlaceholder')} value={draft.description} onChange={(event) => set('description', event.target.value)} maxLength={50000} />
              <small className="muted">{t('markdownHint')}</small>
            </div>
            <div className={styles.blk}>
              <section className={`${styles.checkBox} ${styles.checkBoxAcceptance}`} aria-label={t('acceptance')}>
                <h4 className={styles.checkHead}>{t('acceptance')}{required.has('acceptance_criteria') && <span className={styles.req}> *</span>}<span className={styles.checkHint}>{required.has('acceptance_criteria') ? t('acceptanceRequiredHint') : t('acceptanceHint')}</span></h4>
                <DraftList label={t('addAcceptance')} placeholder={t('addAcceptancePlaceholder')} items={draft.acceptance} onChange={(items) => set('acceptance', items)} tag="Acceptance" tone="acceptance" />
              </section>
              <section className={styles.checkBox} aria-label={t('checklist')}>
                <h4 className={styles.checkHead}>{t('checklist')}<span className={styles.checkHint}>{t('checklistHint')}</span></h4>
                <DraftList label={t('addChecklist')} placeholder={t('addChecklistPlaceholder')} items={draft.checklist} onChange={(items) => set('checklist', items)} tag="Checklist" tone="checklist" />
              </section>
            </div>
            {!draft.subtask && <div className={styles.blk}>
              <h3>{t('subtasks')}<Button size="small" variant="ghost" className={styles.addAction} style={{ marginLeft: 'auto' }} disabled={draft.children.length >= 20} onClick={() => set('children', [...draft.children, { id: crypto.randomUUID(), title: '', size: 'XS', assigneeId: '', planEnd: '' }])}><Plus size={14} />{t('addSubtask')}</Button></h3>
              {draft.children.length === 0 && <p className="muted">{t('subtaskCreateHint')}</p>}
              {draft.children.map((child, index) => <div className={styles.childRow} key={child.id}>
                <Input label={t('childTitle', { number: index + 1 })} required maxLength={300} value={child.title} onChange={(event) => updateChild(child.id, { title: event.target.value })} />
                <Select label={t('fields.size')} value={child.size} onChange={(event) => updateChild(child.id, { size: event.target.value })}>{sizeOptions.map(([size, md]) => <option value={size} key={size}>{size} · {t('md', { value: md })}</option>)}</Select>
                <Select label="Developer" value={child.assigneeId} onChange={(event) => updateChild(child.id, { assigneeId: event.target.value })}><option value="">{t('notSet')}</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</Select>
                <DatePicker compact label={t('fields.planEnd')} value={child.planEnd || undefined} yearFormat={scope.yearFormat} onValueChange={(value) => updateChild(child.id, { planEnd: value })} />
                <Button size="icon" variant="ghost" aria-label={t('removeChild', { number: index + 1 })} onClick={() => set('children', draft.children.filter((row) => row.id !== child.id))}><Trash2 size={14} /></Button>
              </div>)}
            </div>}
            {scope.access.permissions.includes('issue.edit') && <div className={styles.blk}>
              <h3>{t('dependencies')}</h3>
              {draft.blockedBy.length > 0 && <div className={styles.chips}>{draft.blockedBy.map((key) => { const item = projectIssues.data?.items.find((issue) => issue.key === key); return <span key={key} className={`${styles.depChip} ${styles.sTodo}`}><span className={styles.depLink}>{t('waitFor')} {key}{item ? ` ${item.title}` : ''}</span><button type="button" className={styles.chipX} aria-label={t('removeDependency', { key })} onClick={() => set('blockedBy', draft.blockedBy.filter((value) => value !== key))}><X size={12} /></button></span>; })}</div>}
              <IssuePicker label={t('dependencyKey')} value={null} placeholder={t('searchIssue')} issues={(projectIssues.data?.items ?? []).filter((issue) => !draft.blockedBy.includes(issue.key))} onChange={(key) => set('blockedBy', [...draft.blockedBy, key])} />
            </div>}
            <p className={styles.afterCreate}><Info size={15} aria-hidden="true" />{t('afterCreateNote')}</p>
          </div>

          <aside className={styles.sidebar} aria-label={t('properties')}><div className={`${styles.props} ${styles.propsAll}`}>
            <section className={styles.pgroup} aria-label={t('groupPeople')}>
              <h4 className={styles.pgTitle}>{t('groupPeople')}</h4>
              <PropRow k="Business Analyst">{personSelect('baId', 'Business Analyst')}</PropRow>
              <PropRow k="System Analyst">{personSelect('saId', 'System Analyst')}</PropRow>
              <PropRow k="Developer"><Combobox label={t('fields.assigneeIds')} multiple options={options.members} value={draft.assigneeIds} onValueChange={(ids) => { if (!lock.current && !created.current) set('assigneeIds', ids); }} /></PropRow>
              <PropRow k={t('qaReviewer')}>{personSelect('reviewerId', t('qaReviewer'))}</PropRow>
              <PropRow k={t('watchers')}><Combobox label={t('refs.watchers')} multiple options={options.members.filter((person) => person.id !== scope.meId)} value={draft.watcherIds} onValueChange={(ids) => { if (!lock.current && !created.current) set('watcherIds', ids); }} /></PropRow>
            </section>
            <section className={styles.pgroup} aria-label={t('groupPlan')}>
              <h4 className={styles.pgTitle}>{t('groupPlan')}</h4>
              <PropRow k="Size"><div className={styles.sizeRow}>
                <Select label={t('fields.size')} required={required.has('size')} disabled={draft.type === 'Spike'} value={draft.size} onChange={(event) => { set('size', event.target.value); set('estimateMd', ''); }}>{sizeOptions.map(([size]) => <option value={size} key={size}>{size}</option>)}</Select>
                <Input label={t('fields.estimateMd')} type="number" min={0.25} max={9999} step={0.25} readOnly={draft.type === 'Spike'} value={mdValue} onChange={(event) => set('estimateMd', event.target.value)} />
                <span className="muted">Man-Day</span>
              </div></PropRow>
              <div className={styles.planBox}>
                <span /><span className={styles.k}>{t('plan')}</span><span className={styles.k}>{t('actual')}</span>
                <span className="muted">{t('start')}</span>
                <span><DatePicker compact label={t('fields.planStart')} value={draft.planStart || undefined} yearFormat={scope.yearFormat} onValueChange={(value) => set('planStart', value)} /></span>
                <span className="muted">{t('afterStart')}</span>
                <span className="muted">{t('end')}</span>
                <span><DatePicker compact label={t('fields.planEnd')} value={draft.planEnd || undefined} min={draft.planStart || undefined} yearFormat={scope.yearFormat} onValueChange={(value) => set('planEnd', value)} /></span>
                <span className="muted">{t('afterStart')}</span>
              </div>
              <small className="muted">{t('endCalculated')}</small>
              {parentRow && <small className={styles.inherited}>{t('parentRange', { key: parentRow.key, start: formatDate(parentRow.planStart, scope.yearFormat), end: formatDate(parentRow.planEnd, scope.yearFormat) })}</small>}
            </section>
            <section className={styles.pgroup} aria-label={t('groupPlace')}>
              <h4 className={styles.pgTitle}>{t('groupPlace')}</h4>
              <PropRow k={t('fields.priority')}><Select label={t('fields.priority')} value={draft.priority} onChange={(event) => set('priority', event.target.value)}>{['urgent', 'high', 'medium', 'low'].map((priority) => <option value={priority} key={priority}>{t(`priority.${priority}`)}</option>)}</Select></PropRow>
              {(isBug || required.has('severity') || required.has('environment')) && <>
                <PropRow k={t('fields.severity')}><Select label={t('fields.severity')} required={required.has('severity')} value={draft.severity} onChange={(event) => set('severity', event.target.value)}>{['critical', 'major', 'minor'].map((value) => <option value={value} key={value}>{t(`severity.${value}`)}</option>)}</Select></PropRow>
                <PropRow k={t('fields.environment')}><Select label={t('fields.environment')} required={required.has('environment')} value={draft.environment} onChange={(event) => set('environment', event.target.value)}>{['local', 'sit', 'uat', 'production'].map((value) => <option value={value} key={value}>{t(`environment.${value}`)}</option>)}</Select></PropRow>
              </>}
              {draft.subtask ? <>
                <PropRow k={t('parentTask')}>{parent
                  ? <span>{parent.key} · {parent.title}</span>
                  : <IssuePicker label={t('parentTask')} value={draft.parentKey || null} issues={parents} groupOf={(issue) => options.modules.find((module) => module.id === issue.moduleId)?.name ?? t('notSet')} onChange={(key) => set('parentKey', key)} />}</PropRow>
                {parentIssue.error && <Failure error={parentIssue.error} />}{parentIssue.data?.parentKey && <p className="field-error">{t('parentMustBeTask')}</p>}
                <PropRow k="Module"><span><span className={styles.modPill} style={{ background: `${modColor}1a`, color: modColor }}>{mod?.name ?? t('notSet')}</span> <span className="muted" style={{ fontSize: 11 }}>{t('fromParent')}</span></span></PropRow>
              </> : <PropRow k="Module"><Select label={t('fields.moduleId')} required={required.has('module') || draft.type === 'Task'} value={draft.moduleId} onChange={(event) => { set('moduleId', event.target.value); set('phaseId', ''); }}><option value="">{t('choose')}</option>{options.modules.map((module) => <option value={module.id} key={module.id}>{module.name}</option>)}</Select></PropRow>}
              <PropRow k={t('refs.requirement')}><CodeChips kinds={['requirement']} editable values={{ requirement: draft.requirements, screen: [] }} suggestions={{ requirement: options.requirements?.map((r) => r.code) }} onChange={(_, codes) => set('requirements', codes)} /></PropRow>
              <PropRow k={t('refs.screen')}><CodeChips kinds={['screen']} editable values={{ requirement: [], screen: draft.screens }} suggestions={{ screen: options.screens?.map((r) => r.code) }} onChange={(_, codes) => set('screens', codes)} /></PropRow>
              <PropRow k={t('refs.labels')}><LabelChips options={options.labels} value={draft.labelIds} editable onChange={(ids) => set('labelIds', ids)} /></PropRow>
              <label className={styles.checkboxLabel}><input type="checkbox" checked={draft.shared} onChange={(event) => set('shared', event.target.checked)} />{t('sharedWithGuests')}</label>
            </section>
          </div></aside>
        </div>
      </fieldset>
      {!!error && <div style={{ padding: '0 24px' }}><Failure error={error} /></div>}
      <div className={styles.createFooter}>
        <label className={`${styles.checkboxLabel} ${styles.footLeft}`}><input type="checkbox" checked={continueCreating} disabled={pending || !!partial} onChange={(event) => setContinueCreating(event.target.checked)} />{t('continueCreating')}</label>
        <span className="muted">{t('createShortcut')}</span>
        <Button onClick={cancel} disabled={pending}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={submitDisabled}>{submitLabel}</Button>
      </div>
    </form>
    <Dialog open={closeOpen} title={t(partial ? 'partialCloseTitle' : 'unsavedTitle')} description={t(partial ? 'partialCloseDescription' : 'unsavedDescription')} onOpenChange={setCloseOpen}>
      {draftError && <p className="field-error">{t('draftSaveFailed')}</p>}<div className={styles.dialogActions}><Button onClick={() => setCloseOpen(false)}>{t('keepEditing')}</Button>{!partial && <Button onClick={() => { try { localStorage.setItem(draftKey, JSON.stringify({ expiresAt: Date.now() + 7 * 86400000, data: draft })); onClose(); } catch { setDraftError(true); } }}>{t('saveDraft')}</Button>}<Button variant="danger" onClick={() => { removeDraft(draftKey); onClose(); }}>{t(partial ? 'close' : 'discard')}</Button></div>
    </Dialog>
  </>;
}
