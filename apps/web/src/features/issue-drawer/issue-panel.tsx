'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronLeft, ChevronRight, Link2, MoreHorizontal, RotateCcw, Trash2, X } from 'lucide-react';
import { Avatar, AvatarStack, Badge, Button, Combobox, DatePicker, Dialog, DrawerClose, Input, Select, useToast, LoadingState, ErrorState } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { peopleForRole, type PickRole } from '@/lib/positions';
import { useIsMobile } from '@/lib/use-mobile';
import { TestRuns } from './test-runs';
import { ActivityPanel } from './activity';
import { Checklist, DependencyPanel } from './issue-parts';
import { DueRequest } from './due-request';
import { BodyText, Failure, InlineText } from './shared';
import { Attachments, BugDetails, Development, PropRow, QuickSubtask, SubtaskRow } from './detail-parts';
import { CodeChips, LabelChips } from './refs';
import { issuePath, issueQuery, projectPath, type Issue, type Named, type PublicPerson, type Scope } from './types';
import { GroupSelect, IssuePicker, useProjectIssues } from './task-v2';
import { CustomFieldRows, visibleCustomFields } from './custom-fields';
import { levelOf, requires, shows, type ProfileField } from '@/lib/field-profile';
import styles from './issue-drawer.module.css';
import { DEFAULT_ITEM_COLOR, readableColor, tint } from "@/lib/colors";
import { statusColorStyle, statusTone, useStatusColors, type StatusTone } from '@/lib/status';

/** API ขอเหตุผลการแก้แผน: ไม่ใช่ error ที่ต้องแสดง แต่เปิดกล่องให้กรอกเหตุผลแล้วบันทึกซ้ำ */
class NeedsPlanReason extends Error {}

export function IssuePanel({ scope, issue, siblings = [], onDeleted }: { scope: Scope; issue: Issue; siblings?: Issue[]; onDeleted: (parentKey: string | null) => void }) {
  const t = useTranslations('issue-drawer');
  const mobile = useIsMobile() && !!issue.parentKey && !scope.access.guestViewer;
  const [mobileTab, setMobileTab] = useState<'details' | 'tests' | 'commits' | 'comments'>('details');
  const cache = useQueryClient(); const toast = useToast();
  const endpoint = issuePath(scope.ws, issue.key);
  const key = issueQuery(scope.ws, issue.key);
  const canEdit = !scope.access.guestViewer && scope.access.permissions.includes('issue.edit') && scope.project?.status !== 'archived';
  // เปลี่ยนสถานะได้เฉพาะงานของตัวเอง (ผู้รับผิดชอบ / Reviewer / Tester) · Admin ได้ทุกงาน · API ตรวจซ้ำ
  const canMove = canEdit && issue.canMove !== false;
  const canDelete = !scope.access.guestViewer && scope.access.permissions.includes('issue.delete');
  const guest = scope.access.guestViewer;
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ApiError | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [reasonIntent, setReasonIntent] = useState<Record<string, unknown> | null>(null);
  const [planReason, setPlanReason] = useState('');
  const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [keepChildren, setKeepChildren] = useState(false);
  const [allProps, setAllProps] = useState(false);
  const [cancelDue, setCancelDue] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const watchers = useQuery({ queryKey: [...key, 'watchers'], queryFn: ({ signal }) => api.get<{ items: { person: PublicPerson | null }[]; watching: boolean }>(`${endpoint}/watchers`, { signal }) });
  // รายการ Label ของโปรเจกต์ใช้เฉพาะตอนแก้ · การแสดงผลใช้ชื่อ/สีที่มากับงาน
  const labelOptions = useQuery({ queryKey: ['issue-options', scope.ws, scope.projectKey, 'labels'], queryFn: ({ signal }) => api.get<{ items: Named[] }>(`${projectPath(scope.ws, scope.projectKey)}/labels`, { signal }), enabled: canEdit });
  // form-options ให้ทั้งรหัส FR / Screen และรายการกลุ่มของแต่ละ Module
  // Guest ที่เป็น Viewer ไม่เห็น Reports / Files จึงแสดงรหัสเป็นข้อความ
  const refHref = scope.access.guestViewer ? undefined : (kind: 'requirement' | 'screen', code: string) => {
    const base = `/work/${encodeURIComponent(scope.ws)}/p/${encodeURIComponent(scope.projectKey)}`;
    return kind === 'requirement' ? `${base}/reports?report=trace&fr=${encodeURIComponent(code)}` : `${base}/files?q=${encodeURIComponent(code)}`;
  };
  const refOptions = useQuery({ queryKey: ['issue-options', scope.ws, scope.projectKey, 'form-options'], queryFn: ({ signal }) => api.get<{ requirements?: { code: string }[]; screens?: { code: string }[]; phases?: { id: string; name: string; moduleId: string }[] }>(`${projectPath(scope.ws, scope.projectKey)}/form-options`, { signal }), enabled: !scope.access.guestViewer, staleTime: 60_000 });
  // D2: เปลี่ยน Task แม่ได้เฉพาะ Task ใน Module เดียวกัน (ผู้ใช้ตัดสิน 2026-11-08)
  const projectIssues = useProjectIssues(scope, canEdit && !!issue.parentKey);
  const impact = useQuery({ queryKey: [...key, 'delete-impact'], queryFn: () => api.get<{ counts: { subtasks: number; files: number; dependencies: number }; subtasks?: Issue[] }>(`${endpoint}/delete-impact`), enabled: deleteOpen && canDelete });
  const type = scope.project?.issueTypes?.find((type) => type.name === issue.type);
  const statuses = scope.project?.statuses?.filter((status) => status.workflowId === type?.workflowId) ?? [];
  const index = siblings.findIndex((item) => item.key === issue.key);
  async function refresh() {
    // ทุกมุมมองของโปรเจกต์ไม่พึ่ง realtime อย่างเดียว (เช่น ย้ายกลุ่มแล้วแถวต้องย้ายตามทันที
    // แก้ Man-Day / วันที่ใน drawer แล้วแถบใน Timeline / Gantt ต้องขยับตามโดยไม่ต้องรีเฟรชหน้า)
    const views = ['kanban', 'issue-drawer-list', 'table', 'overview', 'timeline', 'gantt', 'calendar', 'backlog'];
    await Promise.all([cache.invalidateQueries({ queryKey: key }), ...views.map((view) => cache.invalidateQueries({ queryKey: [view, scope.ws, scope.projectKey] }))]);
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
      // แผนหลังตั้ง Baseline: เปิดกล่องใส่เหตุผลแทนแถบ error แล้วบันทึกต่อ
      if (failure instanceof NeedsPlanReason) return false;
      if (failure instanceof ApiError && failure.status === 409) setConflict(failure);
      else setError(failure);
      return false;
    } finally { lock.current = false; setBusy(false); }
  }
  async function patch(body: Record<string, unknown>, withReason = false): Promise<boolean> {
    if (!canEdit) return false;
    const saved = await action(async () => {
      const payload = { ...body, ...(withReason ? { planChangeReason: planReason } : {}) };
      // Developer ใช้ PUT assignees (สัญญาเดิม) แต่ขอเหตุผลการแก้แผนแบบเดียวกัน
      try { return 'assigneeIds' in body && Object.keys(body).length === 1 ? await api.request<Issue>(`${endpoint}/assignees`, { method: 'PUT', etag: issue.version, body: payload }) : await api.patch<Issue>(endpoint, payload, issue.version); }
      catch (failure) {
        if (failure instanceof ApiError && failure.code === 'due_change_requires_approval' && failure.details.canRequest) { setDue(String(failure.details.requestedDue)); }
        if (failure instanceof ApiError && failure.code === 'plan_change_reason_required' && !withReason) { setReasonIntent(body); setPlanReason(''); throw new NeedsPlanReason(); }
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
  // รายชื่อในช่อง BA / SA / Dev / QA กรองตามตำแหน่งของสมาชิก (lib/positions) · คนที่เลือกไว้แล้วยังอยู่เสมอ
  const pick = (role: PickRole, selected: (string | null | undefined)[]) => peopleForRole(role, scope.people, selected).map((person) => ({ id: person.id, name: person.displayName }));
  const reviewerIds = issue.reviewerIds ?? (issue.reviewerId ? [issue.reviewerId] : []);
  const qas = reviewerIds.map((id) => scope.people.find((person) => person.id === id)).filter((person): person is NonNullable<typeof person> => !!person);
  // BA / SA แสดงรูปโปรไฟล์คนที่เลือกหน้าชื่อเหมือนช่อง Developer · ยังเป็น Select เดิมจึงเลือก "ยังไม่ระบุ" เพื่อล้างค่าได้
  const personSelect = (field: 'baId' | 'saId', value: string | null | undefined, values: { id: string; name: string }[]) => {
    const person = value ? scope.people.find((item) => item.id === value) : undefined;
    return <Select label={t(`fields.${field}`)} className={person ? styles.personSelect : undefined} prefix={person ? <Avatar size="small" person={person} /> : undefined} value={value ?? ''} disabled={!canEdit || disabled} onChange={(event) => void patch({ [field]: event.target.value || null })}>
      <option value="">{t('notSet')}</option>{values.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </Select>;
  };
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const pending = issue.pendingDueRequest;
  const mod = scope.project?.modules.find((item) => item.id === issue.moduleId);
  const modColor = mod?.color ?? DEFAULT_ITEM_COLOR;
  const groups = (refOptions.data?.phases ?? scope.project?.phases ?? []) as { id: string; name: string; moduleId: string }[];
  const groupName = issue.phaseId ? groups.find((group) => group.id === issue.phaseId)?.name ?? issue.group?.name ?? null : null;
  const doneStatus = statuses.find((status) => status.category === 'done');
  // K2: Bug ที่แก้แล้ว (สถานะหลังสถานะทำงานแรก เช่น Fixed) รอทดสอบซ้ำ · ผ่าน = สถานะถัดไปใน Workflow, ไม่ผ่าน = กลับสถานะทำงานแรก
  const statusIndex = statuses.findIndex((status) => status.id === issue.status.id);
  const firstWork = statuses.find((status) => status.category === 'in_progress');
  const awaitingRetest = issue.type === 'Bug' && (issue.status.category === 'in_progress' || issue.status.category === 'review') && !!firstWork && firstWork.id !== issue.status.id;
  const passStatus = statusIndex >= 0 ? statuses[statusIndex + 1] : undefined;
  const reworkStatus = firstWork && firstWork.id !== issue.status.id ? firstWork : undefined;
  const isDone = issue.status.category === 'done';
  const reporter = scope.people.find((person) => person.id === issue.reporterId);
  const isBug = issue.type === 'Bug';
  const subtasks = issue.subtasks ?? [];
  const subDone = subtasks.filter((child) => child.status.category === 'done').length;
  const canCreate = scope.access.permissions.includes('issue.create') && !guest;
  const devs = scope.people.filter((person) => issue.assigneeIds?.includes(person.id));
  const tones: Record<StatusTone, string> = { todo: styles.sTodo, in_progress: styles.sProg, review: styles.sRev, blocked: styles.sBlk, done: styles.sDone, cancelled: styles.sCan };
  const pillTone = (category: string, name: string) => tones[statusTone(category, name)];
  const statusColors = useStatusColors(scope.ws, scope.projectKey);
  const prioColor = { urgent: 'var(--danger-text)', high: 'var(--warning-text)', medium: 'var(--primary-text)', low: 'var(--muted)' }[issue.priority];
  const href = typeof window === 'undefined' ? '' : window.location.href;
  // ชุดฟิลด์ของโปรเจกต์ (Template): ซ่อนฟิลด์ที่ปิดในระดับนี้ · * = ฟิลด์บังคับ (Bug ใช้ฟิลด์บังคับของประเภทงาน)
  const level = levelOf(issue);
  const profile = scope.project?.fieldProfile;
  const show = (field: ProfileField) => shows(profile, field, level);
  const star = (field: ProfileField, label: string) => (!isBug && requires(profile, field, level) ? `${label} *` : label);
  const customFields = guest ? [] : visibleCustomFields(scope.project?.customFields, level);
  return <div className={`${styles.panel}${mobile ? ` ${styles.subtaskMobile}` : ''}`} aria-busy={busy}>
    {/* Canvas C/D/K2: แถบหัว Drawer = breadcrumb + Watch / ลิงก์ / ⋯ / ปิด */}
    <div className={styles.dhead}>
      <nav aria-label={t('breadcrumb')} className={styles.crumb}>
        {issue.type === 'Bug' && <span className={styles.bugIcon} aria-label={t('types.Bug')} role="img" />}
        {mod && <span className={styles.modPill} style={{ background: tint(modColor, 10), color: readableColor(modColor) }}>{mod.name}</span>}
        {issue.parentKey && <><span className="muted">›</span><button className={styles.textLink} onClick={() => scope.navigate(issue.parentKey!)}>{issue.parentKey}</button></>}
        <span className="muted">›</span><strong>{issue.key}</strong>
        {issue.parentKey && <span className={styles.typeBadge}>{t('subtask')}</span>}
        {issue.type !== 'Task' && !issue.parentKey && <span className={styles.typeBadge}>{t(`types.${issue.type}`)}</span>}
        {issue.type === 'Bug' && issue.reopenCount > 0 && <Badge tone="amber">{t('reopenedCount', { count: issue.reopenCount })}</Badge>}
      </nav>
      <div className={styles.actions}>
        {issue.parentKey && siblings.length > 0 && <span className={styles.wideOnly}>
          <Button size="icon" variant="ghost" aria-label={t('previousSubtask')} disabled={index <= 0} onClick={() => scope.navigate(siblings[index - 1].key)}><ChevronLeft size={16} /></Button>
          <span className="muted" style={{ fontSize: 11 }}>{index + 1}/{siblings.length}</span>
          <Button size="icon" variant="ghost" aria-label={t('nextSubtask')} disabled={index < 0 || index >= siblings.length - 1} onClick={() => scope.navigate(siblings[index + 1].key)}><ChevronRight size={16} /></Button>
        </span>}
        {watchers.data && <Button size="small" className={styles.wideOnly} disabled={disabled} aria-pressed={watchers.data.watching} onClick={() => void action(() => watchers.data!.watching ? api.delete(`${endpoint}/watch`) : api.post(`${endpoint}/watch`))}>{t(watchers.data.watching ? 'watching' : 'watch')} · {watchers.data.items.length}</Button>}
        <Button size="icon" variant="ghost" className={styles.wideOnly} aria-label={t('copyLink')} onClick={() => { void navigator.clipboard?.writeText(href).then(() => toast({ message: t('linkCopied') })); }}><Link2 size={16} /></Button>
        {(canDelete || (canEdit && issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly') && !pending)) && <Popover.Root>
          <Popover.Trigger asChild><Button size="icon" variant="ghost" aria-label={t('moreActions')}><MoreHorizontal size={16} /></Button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="popover project-menu" sideOffset={6} align="end">
            {canEdit && issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly') && !pending && <Popover.Close asChild><button className="menu-item" disabled={disabled} onClick={() => setDue('')}>{t('requestDue')}</button></Popover.Close>}
            {canDelete && <Popover.Close asChild><button className="menu-item" style={{ color: 'var(--danger-text)' }} aria-label={t('deleteIssue')} disabled={disabled} onClick={() => setDeleteOpen(true)}><Trash2 size={15} />{t('deleteIssue')}</button></Popover.Close>}
          </Popover.Content></Popover.Portal>
        </Popover.Root>}
        <DrawerClose asChild><Button size="icon" variant="ghost" aria-label={t('close')}><X size={18} /></Button></DrawerClose>
      </div>
    </div>

    <div className={styles.headBlock}>
      <div className={styles.title}><InlineText label={t('fields.title')} value={issue.title} enabled={canEdit} busy={disabled} onSave={(title) => patch({ title })} /></div>
      <div className={styles.statusRow}>
        <select className={`${styles.statusPill} ${pillTone(issue.status.category, issue.status.name)}`} style={statusColorStyle(statusColors.get(issue.status.id))} aria-label={t('fields.statusId')} value={issue.status.id} disabled={!canMove || disabled} title={canEdit && !canMove ? t('viewOnlyStatus') : undefined} onChange={(event) => void move(event.target.value)}>
          {(statuses.length ? statuses : [issue.status]).map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
        </select>
        {canMove && !isDone && doneStatus && issue.type !== 'Bug' && <Button size="small" className={styles.okButton} disabled={disabled} onClick={() => void move(doneStatus.id)}><Check size={15} />{t(mobile ? 'mobileComplete' : 'markComplete')}</Button>}
        {issue.type === 'Bug' && issue.status.category === 'done' && canEdit && <Button size="small" onClick={() => setReopenOpen(true)} disabled={disabled}><RotateCcw size={14} />{t('reopen')}</Button>}
        <span className={styles.meta}>{t('metaLine', { name: reporter?.displayName ?? t('system'), created: formatDate(issue.createdAt, scope.yearFormat), updated: formatDate(issue.updatedAt, scope.yearFormat, true) })}</span>
      </div>
      {conflict && <div role="alert" className={styles.conflict}><strong>{t('conflictTitle')}</strong><p>{t('conflictDescription')}</p>{!!(conflict.latest as Issue | undefined)?.title && <p>{t('latestTitle', { title: (conflict.latest as Issue).title })}</p>}{conflict.requestId && <code>{t('requestId', { id: conflict.requestId })}</code>}<Button size="small" onClick={async () => { await cache.invalidateQueries({ queryKey: key }); setConflict(null); setError(null); }}>{t('loadLatest')}</Button></div>}
      {!!error && <Failure error={error} />}
      {pending && !guest && <div className={styles.pending}><strong>{t('pendingDue', { date: formatDate(pending.requestedDue, scope.yearFormat, true) })}</strong><p>{t('waitingApproval')}</p>{pending.requesterId === scope.meId && <Button size="small" disabled={disabled} onClick={() => setCancelDue(true)}>{t('cancelRequest')}</Button>}</div>}
      {scope.project?.status === 'archived' && <p className={styles.notice}>{t('archived')}</p>}
    </div>

    <div className={styles.layout}><div className={styles.main}>
      {mobile && <div className={styles.tabs} role="tablist" aria-label={t('mobileTabs.label')}>
        {(['details', 'tests', 'commits', 'comments'] as const).map((tab) => <button key={tab} type="button" role="tab" id={`${issue.key}-tab-${tab}`} aria-selected={mobileTab === tab} tabIndex={mobileTab === tab ? 0 : -1} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const tabs = ['details', 'tests', 'commits', 'comments'] as const; const index = tabs.indexOf(tab); const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4]; setMobileTab(next); document.getElementById(`${issue.key}-tab-${next}`)?.focus();
        }} aria-controls={`${issue.key}-panel-${tab}`} onClick={() => setMobileTab(tab)}>{t(`mobileTabs.${tab}`)}</button>)}
      </div>}
      <div hidden={mobile && mobileTab !== 'details'} role={mobile ? 'tabpanel' : undefined} id={`${issue.key}-panel-details`} aria-labelledby={mobile ? `${issue.key}-tab-details` : undefined}>
      {(!isBug || issue.description) && <div className={styles.blk}>
        <h3>{t('description')}</h3>
        {/* ยังไม่มีคำอธิบาย: บรรทัดเดียวพร้อมปุ่มเพิ่ม แทนข้อความว่าง + ปุ่มแยกบรรทัด */}
        {issue.description ? <BodyText>{issue.description}</BodyText> : !canEdit && <p className="muted">{t('noDescription')}</p>}
        {canEdit && <InlineText label={t(issue.description ? 'editDescription' : 'addDescription')} displayValue={t(issue.description ? 'editDescription' : 'addDescription')} value={issue.description ?? ''} enabled busy={disabled} multiline onSave={(description) => patch({ description: description || null })} />}
      </div>}
      {/* หมายเหตุ (Remark) ของ Task / Sub-task แยกจากคำอธิบาย · ข้อความธรรมดา แก้ด้วย Textarea */}
      {issue.remark !== undefined && show('remark') && <div className={styles.blk}>
        <h3>{star('remark', t('remark'))}</h3>
        {issue.remark ? <p className={styles.remark}>{issue.remark}</p> : !canEdit && <p className="muted">{t('noRemark')}</p>}
        {canEdit && <InlineText label={t(issue.remark ? 'editRemark' : 'addRemark')} displayValue={t(issue.remark ? 'editRemark' : 'addRemark')} value={issue.remark ?? ''} enabled busy={disabled} multiline onSave={(remark) => patch({ remark: remark.trim() ? remark : null })} />}
      </div>}
      {awaitingRetest && canMove && passStatus && <div className={styles.verify} role="group" aria-label={t('verifyGroup')}>
        <div><strong>{t('verifyTitle', { status: issue.status.name })}</strong><p>{t('verifyDescription', { name: qas.map((person) => person.displayName).join(', ') || scope.people.find((person) => person.id === issue.testerId)?.displayName || t('qaReviewer') })}</p></div>
        <Button size="small" className={styles.okButton} disabled={disabled} onClick={() => void move(passStatus.id)}>{t('verified', { status: passStatus.name })}</Button>
        {reworkStatus && <Button size="small" className={styles.failButton} disabled={disabled} onClick={() => void move(reworkStatus.id)}>{t('notPassed')}</Button>}
      </div>}
      {issue.type === 'Bug' && <BugDetails issue={issue} canEdit={canEdit} disabled={disabled} save={(name, value) => patch({ details: { ...issue.details, [name]: value } })} />}
      {(['Story', 'Spike'] as const).includes(issue.type as 'Story') && <div className={`${styles.blk} ${styles.storyFields}`}>
        {(issue.type === 'Story' ? ['as_a', 'i_want', 'so_that'] : ['question', 'timebox_hours', 'deliverable']).map((name) => <div key={name}><div className={styles.k}>{t(`detailFields.${name}`)}</div>{canEdit ? <InlineText label={t(`detailFields.${name}`)} value={String(issue.details[name] ?? '')} enabled multiline busy={disabled} onSave={(value) => patch({ details: { ...issue.details, [name]: name === 'timebox_hours' ? Number(value) : value }, ...(name === 'timebox_hours' ? { estimateMd: Number(value) / 8 } : {}) })} /> : <BodyText>{String(issue.details[name] ?? t('notSet'))}</BodyText>}</div>)}
      </div>}
      {!guest && !isBug && <div className={styles.blk}><Checklist scope={scope} issueKey={issue.key} /></div>}
      {!issue.parentKey && !isBug && <div className={styles.blk}>
        <h3>{t('subtasks')} <span className="muted" style={{ fontWeight: 500 }}>{subDone}/{subtasks.length}</span><span className={styles.subBar}><span style={{ width: `${subtasks.length ? Math.round((subDone / subtasks.length) * 100) : 0}%` }} /></span><span className={styles.meta}>{t('subtaskProgressNote')}</span></h3>
        {subtasks.length === 0 && <p className="muted">{t('noSubtasks')}</p>}
        {subtasks.map((child) => <SubtaskRow key={child.key} scope={scope} child={child} canEdit={canEdit && child.canMove !== false} onChanged={refresh} pillTone={pillTone} />)}
        {canCreate && <QuickSubtask scope={scope} parent={issue} onCreated={refresh} onFullForm={() => scope.createSubtask(issue)} />}
      </div>}
      {!guest && <div className={styles.blk}><h3>{t('dependencies')}</h3><DependencyPanel scope={scope} issueKey={issue.key} /></div>}
      {!guest && <Attachments scope={scope} issue={issue} />}
      </div>
      {!guest && <div hidden={mobile && mobileTab !== 'tests'} role={mobile ? 'tabpanel' : undefined} id={`${issue.key}-panel-tests`} aria-labelledby={mobile ? `${issue.key}-tab-tests` : undefined}><TestRuns scope={scope} issue={issue} /></div>}
      {!guest && <div hidden={mobile && mobileTab !== 'commits'} role={mobile ? 'tabpanel' : undefined} id={`${issue.key}-panel-commits`} aria-labelledby={mobile ? `${issue.key}-tab-commits` : undefined}><Development scope={scope} issue={issue} /></div>}
      <div hidden={mobile && mobileTab !== 'comments'} role={mobile ? 'tabpanel' : undefined} id={`${issue.key}-panel-comments`} aria-labelledby={mobile ? `${issue.key}-tab-comments` : undefined}><div className={styles.blk} style={{ borderBottom: 0 }}><h3>{t('commentsTitle')}</h3><ActivityPanel scope={scope} issueKey={issue.key} showComposer={!mobile} /></div></div>
    </div>

    <aside className={styles.sidebar} aria-label={t('properties')}>
      {mobile && !allProps ? <div className={styles.props}>
        <PropRow keep k={t('fields.assigneeIds')}>{canEdit ? <Combobox label={t('fields.assigneeIds')} multiple options={peopleForRole('dev', scope.people, issue.assigneeIds ?? [])} value={issue.assigneeIds ?? []} onValueChange={(ids) => { if (!disabled) void patch({ assigneeIds: ids }); }} /> : <AvatarStack people={devs} />}</PropRow>
        <PropRow keep k="Due">{canEdit ? <DatePicker compact label={t('fields.planEnd')} value={issue.planEnd ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (disabled) return; if (value && issue.planEnd && value > issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly')) setDue(value); else void patch({ planEnd: value || null }); }} /> : formatDate(issue.planEnd, scope.yearFormat)}</PropRow>
        {/* มือถือ: QA Due ของโปรเจกต์แยก Dev / QA อยู่ในแถวหลักด้วย */}
        {issue.qaDue !== undefined && <PropRow keep k={t('qaDue')}>{canEdit ? <DatePicker compact label={t('qaDue')} value={issue.qaEnd ?? undefined} min={issue.planEnd ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (!disabled) void patch({ qaEnd: value || null }); }} /> : formatDate(issue.qaEnd ?? issue.qaDue, scope.yearFormat)}{!issue.qaEnd && issue.qaDue && <small className="muted"> {t('qaDueAuto', { date: formatDate(issue.qaDue, scope.yearFormat) })}</small>}</PropRow>}
        {show('priority') && <PropRow keep k={t('fields.priority')}>{fieldSelect('priority', issue.priority, ['urgent', 'high', 'medium', 'low'].map((id) => ({ id, name: t(`priority.${id}`) })), undefined, false)}</PropRow>}
        {show('progress') && <PropRow keep k="Progress"><span>{issue.progressPct == null ? t('notSet') : `${issue.progressPct}%`}</span></PropRow>}
        <button type="button" className={styles.propsToggle} aria-expanded={false} onClick={() => setAllProps(true)}>{t('moreProperties')}</button>
      </div> : <>

      <div className={`${styles.props}${allProps ? ` ${styles.propsAll}` : ''}`} id={`${issue.key}-props`}>
        {/* จัดเป็นกลุ่ม คน / แผนงาน / จัดกลุ่ม · สถานะอยู่ที่ปุ่มบนหัวแล้วจึงไม่ซ้ำในแผงนี้ (ผู้ใช้ขอ 2026-11-07) */}
        {/* C2 / D2: ผู้รับผิดชอบ / แผนงาน / กลุ่มงาน · QA กับ Reviewer รวมเป็นช่องเดียว (ผู้ใช้ตัดสิน 2026-11-08) */}
        {!guest && <section className={styles.pgroup} aria-label={t('groupPeople')}>
          <h4 className={styles.pgTitle}>{t('groupPeople')}</h4>
          {show('ba') && <PropRow k={star('ba', 'Business Analyst')}>{personSelect('baId', issue.baId, pick('ba', [issue.baId]))}</PropRow>}
          {show('sa') && <PropRow k={star('sa', 'System Analyst')}>{personSelect('saId', issue.saId, pick('sa', [issue.saId]))}</PropRow>}
          <PropRow keep k="Developer">{canEdit ? <Combobox label={t('fields.assigneeIds')} multiple options={peopleForRole('dev', scope.people, issue.assigneeIds ?? [])} value={issue.assigneeIds ?? []} onValueChange={(ids) => { if (!disabled) void patch({ assigneeIds: ids }); }} /> : <span className={styles.who}><AvatarStack people={devs} /></span>}</PropRow>
          {show('reviewer') && <PropRow k={star('reviewer', t('qaReviewer'))}>{canEdit ? <Combobox label={t('qaReviewer')} multiple options={peopleForRole('qa', scope.people, reviewerIds)} value={reviewerIds} onValueChange={(ids) => { if (!disabled) void patch({ reviewerIds: ids }); }} /> : <span className={styles.who}>{qas.length ? <AvatarStack people={qas} /> : <span className="muted">—</span>}</span>}</PropRow>}
          {isBug && <PropRow k={t('reporter')}><span className={styles.who}>{reporter ? <><Avatar size="small" person={reporter} />{reporter.displayName}</> : <span className="muted">—</span>}</span></PropRow>}
          <PropRow k={t('watchers')}><span className={styles.who}>{watchers.data?.items.length ? <AvatarStack max={5} people={watchers.data.items.flatMap((entry, i) => entry.person ? [{ ...entry.person, id: entry.person.id ?? `w${i}` }] : [])} /> : <span className="muted">—</span>}</span></PropRow>
        </section>}
        <section className={styles.pgroup} aria-label={t('groupPlan')}>
          <h4 className={styles.pgTitle}>{t('groupPlan')}</h4>
          {isBug && <PropRow k="Due">{canEdit ? <DatePicker compact label={t('fields.planEnd')} value={issue.planEnd ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (!disabled) void patch({ planEnd: value || null }); }} /> : formatDate(issue.planEnd, scope.yearFormat)}</PropRow>}
          {!isBug && <><PropRow k={show('size') ? star('size', 'Size') : 'Man-Day'}><div className={styles.sizeRow}>{show('size') && fieldSelect('size', issue.size, ['XS','S','M','L','XL'].map((id) => ({ id, name: id })))}<InlineText label={t('fields.estimateMd')} type="number" step={0.25} min={0.25} max={9999} value={issue.estimateMd?.toString() ?? ''} enabled={canEdit} busy={disabled} onSave={(value) => patch({ estimateMd: value ? Number(value) : null })} />{devs.length > 0 && <span className="muted">· {t('devCount', { count: devs.length })}</span>}</div></PropRow>
          <div className={`${styles.planBox}${show('actual') ? '' : ` ${styles.noActual}`}`}>
            <span /><span className={styles.k}>{t('plan')}</span>{show('actual') && <span className={styles.k}>{t('actual')}</span>}
            <span className="muted">{t('start')}</span>
            <span>{canEdit ? <DatePicker compact label={t('fields.planStart')} value={issue.planStart ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (!disabled) void patch({ planStart: value || null }); }} /> : formatDate(issue.planStart, scope.yearFormat)}</span>
            {/* Actual Start แก้เองได้ (เริ่มก่อนกดสถานะ) · Actual End ระบบตั้งเมื่อ Done */}
            {show('actual') && <span>{canEdit ? <DatePicker compact label={t('fields.actualStart')} value={issue.actualStart ?? undefined} max={issue.actualEnd ?? todayIso} yearFormat={scope.yearFormat} onValueChange={(value) => { if (!disabled && value) void patch({ actualStart: value }); }} /> : issue.actualStart ? formatDate(issue.actualStart, scope.yearFormat) : '—'}</span>}
            <span className="muted">{t('end')}</span>
            <span>{canEdit ? <DatePicker compact label={t('fields.planEnd')} value={issue.planEnd ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (disabled) return; if (value && issue.planEnd && value > issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly')) setDue(value); else void patch({ planEnd: value || null }); }} /> : formatDate(issue.planEnd, scope.yearFormat)}</span>
            {show('actual') && <span>{issue.actualEnd ? formatDate(issue.actualEnd, scope.yearFormat) : '—'}</span>}
            {/* โปรเจกต์แยก Dev / QA: Plan End = วันที่ Dev ส่ง QA · QA Due = วันที่ QA ต้องทดสอบเสร็จ (ไม่กรอก = อัตโนมัติ) */}
            {issue.qaDue !== undefined && <>
              <span className="muted">{t('qaDue')}</span>
              <span className={styles.qaDueCell}>
                {canEdit ? <DatePicker compact label={t('qaDue')} value={issue.qaEnd ?? undefined} min={issue.planEnd ?? undefined} yearFormat={scope.yearFormat} onValueChange={(value) => { if (!disabled) void patch({ qaEnd: value || null }); }} /> : formatDate(issue.qaEnd ?? issue.qaDue, scope.yearFormat)}
                {!issue.qaEnd && issue.qaDue && <small className="muted" title={t('qaDueAutoHint')}>{t('qaDueAuto', { date: formatDate(issue.qaDue, scope.yearFormat) })}</small>}
              </span>
            </>}
            {canEdit && issue.planEnd && !scope.access.permissions.includes('issue.change_due_directly') && !pending && <><span /><span className={styles.dueCell}><Button size="small" variant="ghost" className={styles.dueLink} disabled={disabled} onClick={() => setDue('')}>{t('requestDue')}</Button></span></>}
          </div>
          {show('progress') && <PropRow keep k="Progress"><div className={styles.progRow}><span className={styles.subBar} style={{ maxWidth: 'none' }}><span style={{ width: `${issue.progressPct ?? 0}%` }} /></span>{/* Task ที่มี Sub-task: API คำนวณให้และไม่รับค่าที่กรอก จึงแสดงอย่างเดียว */}{issue.progressFromSubtasks || subtasks.length ? <span title={t('subtaskProgressNote')}>{issue.progressPct ?? 0}% <span className={styles.meta}>{t('progressAuto')}</span></span> : <InlineText label={t('fields.progressPct')} type="number" min={0} max={100} value={issue.progressPct?.toString() ?? ''} enabled={canEdit} busy={disabled} onSave={(value) => patch({ progressPct: value ? Number(value) : null })} />}</div></PropRow>}</>}
        </section>
        <section className={styles.pgroup} aria-label={t('groupPlace')}>
          <h4 className={styles.pgTitle}>{t('groupPlace')}</h4>
          {show('priority') && <PropRow keep k={t('fields.priority')}><span className={styles.prio} style={{ color: prioColor }}>{fieldSelect('priority', issue.priority, ['urgent', 'high', 'medium', 'low'].map((id) => ({ id, name: t(`priority.${id}`) })), undefined, false)}</span></PropRow>}
          {issue.type === 'Bug' && <><PropRow k={t('fields.severity')}>{fieldSelect('severity', issue.severity, ['critical', 'major', 'minor'].map((id) => ({ id, name: t(`severity.${id}`) })), undefined, false)}</PropRow><PropRow k={t('fields.environment')}>{fieldSelect('environment', issue.environment, ['local', 'sit', 'uat', 'production'].map((id) => ({ id, name: t(`environment.${id}`) })), undefined, false)}</PropRow></>}
          {/* Task: เลือก Module ได้ · Sub-task: เปลี่ยน Task แม่ได้ (Module เดียวกัน) และใช้ Module ตามแม่ */}
          {issue.parentKey ? <>
            <PropRow k={t('parentTask')}>{canEdit
              ? <IssuePicker label={t('parentTask')} value={issue.parentKey} disabled={disabled} issues={(projectIssues.data?.items ?? []).filter((item) => !item.parentKey && item.moduleId === issue.moduleId)} groupOf={() => t('sameModuleTasks', { module: mod?.name ?? t('notSet') })} onChange={(key) => { if (key !== issue.parentKey) void patch({ parentKey: key }); }} />
              : <button type="button" className={styles.textLink} onClick={() => scope.navigate(issue.parentKey!)}>{issue.parentKey}</button>}</PropRow>
            <PropRow k="Module"><span><span className={styles.modPill} style={{ background: tint(modColor, 10), color: readableColor(modColor) }}>{mod?.name ?? t('notSet')}</span> <span className="muted" style={{ fontSize: 11 }}>{t('fromParent')}</span></span></PropRow>
            <PropRow k={t('group')}><span>{groupName ?? <span className="muted">{t('noGroup')}</span>} <span className="muted" style={{ fontSize: 11 }}>{t('fromParent')}</span></span></PropRow>
          </> : <>
            <PropRow k="Module">{fieldSelect('moduleId', issue.moduleId, scope.project?.modules ?? [], (value) => void patch({ moduleId: value, phaseId: null }), false)}</PropRow>
            {/* ย้าย Task ไปกลุ่มอื่น → Sub-task ย้ายตาม (API) */}
            <PropRow k={t('group')}>{canEdit
              ? <GroupSelect scope={scope} moduleId={issue.moduleId} value={issue.phaseId} groups={groups} disabled={disabled} onChange={(id) => { if (id !== issue.phaseId) void patch({ phaseId: id }); }} />
              : (groupName ?? <span className="muted">{t('noGroup')}</span>)}</PropRow>
          </>}
          {/* Requirement · Screen · Label แก้แล้วแทนทั้งชุด */}
          {show('requirements') && <PropRow k={star('requirements', t('refs.requirement'))}><CodeChips kinds={['requirement']} editable={canEdit} busy={disabled} values={{ requirement: issue.requirements ?? [], screen: [] }} suggestions={{ requirement: refOptions.data?.requirements?.map((r) => r.code) }} onChange={(_, codes) => void patch({ requirements: codes })} hrefOf={refHref} /></PropRow>}
          {show('screens') && <PropRow k={star('screens', t('refs.screen'))}><CodeChips kinds={['screen']} editable={canEdit} busy={disabled} values={{ requirement: [], screen: issue.screens ?? [] }} suggestions={{ screen: refOptions.data?.screens?.map((r) => r.code) }} onChange={(_, codes) => void patch({ screens: codes })} hrefOf={refHref} /></PropRow>}
          {show('labels') && <PropRow k={star('labels', t('refs.labels'))}><LabelChips options={labelOptions.data?.items ?? issue.labels ?? []} value={(issue.labels ?? []).map((label) => label.id)} editable={canEdit} busy={disabled} onChange={(ids) => void patch({ labelIds: ids })} /></PropRow>}
          {!guest && canEdit && <label className={styles.checkboxLabel}><input type="checkbox" checked={issue.sharedWithGuests} disabled={disabled} onChange={(event) => void patch({ sharedWithGuests: event.target.checked })} />{t('sharedWithGuests')}</label>}
        </section>
        {customFields.length > 0 && <section className={styles.pgroup} aria-label={t('groupCustom')}>
          <h4 className={styles.pgTitle}>{t('groupCustom')}</h4>
          <CustomFieldRows fields={customFields} level={level} values={issue.customFields ?? {}} people={scope.people} editable={canEdit} busy={disabled} yearFormat={scope.yearFormat}
            onSave={(fieldId, value) => patch({ customFields: { [fieldId]: value } })} />
        </section>}
      </div>
      <button type="button" className={styles.propsToggle} aria-expanded={allProps} aria-controls={`${issue.key}-props`} onClick={() => setAllProps((value) => !value)}>{t(allProps ? 'lessProperties' : 'moreProperties')}</button>
      </>}
      {/* ประวัติการเปลี่ยนแปลงแยกจากคอมเมนต์ อยู่กล่องด้านขวา (ผู้ใช้ขอ 2026-11-08) */}
      <section className={`${styles.pgroup} ${styles.historyBox}`} aria-label={t('historyTitle')}>
        <h4 className={styles.pgTitle}>{t('historyTitle')}</h4>
        <ActivityPanel scope={scope} issueKey={issue.key} mode="log" showComposer={false} />
      </section>
    </aside></div>
    {mobile && scope.access.permissions.includes('issue.comment') && <div className={styles.mobileComposer}><ActivityPanel scope={scope} issueKey={issue.key} showFeed={false} compact /></div>}
    {due !== null && <DueRequest key={`${issue.key}-${due}`} scope={scope} issue={issue} initialDue={due} onClose={() => { setDue(null); setError(null); }} />}
    <Dialog open={!!reasonIntent} title={t('planReasonTitle')} description={t('planReasonDescription')} onOpenChange={(open) => { if (!open && !busy) setReasonIntent(null); }}><form className={styles.stack} onSubmit={(event) => { event.preventDefault(); if (reasonIntent) void patch(reasonIntent, true); }}><Input label={t('planReason')} required value={planReason} maxLength={1000} onChange={(event) => setPlanReason(event.target.value)} /><Button type="submit" variant="primary" disabled={busy || !planReason.trim()}>{t('save')}</Button>{!!error && <Failure error={error} />}</form></Dialog>
    <Dialog open={!!confirmStatus} title={t('incompleteTitle')} description={t('incompleteDescription')} onOpenChange={(open) => { if (!open && !busy) { setConfirmStatus(null); setError(null); } }}><div className={styles.dialogActions}><Button disabled={busy} onClick={() => { setConfirmStatus(null); setError(null); }}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { if (confirmStatus) void move(confirmStatus, true); }}>{t('confirmMove')}</Button></div></Dialog>
    <Dialog open={deleteOpen} title={t('deleteIssueQuestion', { key: issue.key, title: issue.title })} description={`${issue.parentKey ? t('subtask') : t(`types.${issue.type}`)}${mod ? ` · ${mod.name}` : ''}`} onOpenChange={(open) => { if (!open && !busy) setDeleteOpen(false); }}>
      {/* P3 ระดับ 2: บอกผลกระทบเป็นตัวเลข ให้เลือกวิธีจัดการ Sub-task และปุ่มยืนยันบอกผล */}
      {impact.isLoading && <LoadingState />}{impact.error && <ErrorState error={impact.error} retry={() => void impact.refetch()} />}
      {impact.data && <div className={styles.impactBox}>
        <div className={styles.k}>{t('deleteLinked')}</div>
        <div className={styles.imp}><span className={styles.impWarn} aria-hidden="true">!</span><span>{t('deleteImpactSubtasks', { count: impact.data.counts.subtasks, done: (impact.data.subtasks ?? []).filter((child) => child.status.category === 'done').length })}</span></div>
        <div className={styles.imp}><span className={styles.impWarn} aria-hidden="true">!</span><span>{t('deleteImpact', { ...impact.data.counts })}</span></div>
      </div>}
      {impact.data && impact.data.counts.subtasks > 0 && <div className={styles.delOpts} role="radiogroup" aria-label={t('subtaskHandling')}>
        {(['delete', 'keep'] as const).map((value) => <label key={value} className={styles.delOpt}><input type="radio" name="subtask-handling" checked={keepChildren === (value === 'keep')} onChange={() => setKeepChildren(value === 'keep')} /><span><b>{t(`deleteOption.${value}`)}</b><small className="muted">{t(`deleteOptionHint.${value}`, { count: impact.data!.counts.subtasks, module: mod?.name ?? t('notSet') })}</small></span></label>)}
      </div>}
      <p className="muted">{t('restoreThirtyDaysShort')}</p>
      <div className={styles.dialogActions}><Button disabled={busy} onClick={() => setDeleteOpen(false)}>{t('cancel')}</Button><Button variant="danger" disabled={disabled || !impact.data || !!impact.error} onClick={() => void action(() => api.delete(keepChildren ? `${endpoint}?subtasks=keep` : endpoint), () => { const deletedKey = issue.key; toast({ message: t('issueDeleted', { key: deletedKey }), undo: async () => { await api.post(`${endpoint}/restore`); await refresh(); scope.navigate(deletedKey); } }); setDeleteOpen(false); onDeleted(issue.parentKey); })}>{keepChildren ? t('deleteOnlyTask', { type: t(`types.${issue.type}`) }) : impact.data?.counts.subtasks ? t('deleteWithSubtasks', { type: t(`types.${issue.type}`), count: impact.data.counts.subtasks }) : t('confirmDelete', { count: 1 })}</Button></div>{!!error && <Failure error={error} />}
    </Dialog>
    <Dialog open={cancelDue} title={t('cancelRequest')} onOpenChange={(open) => { if (!open && !busy) setCancelDue(false); }}><div className={styles.dialogActions}><Button disabled={busy} onClick={() => setCancelDue(false)}>{t('back')}</Button><Button variant="danger" disabled={disabled} onClick={() => { if (pending) void action(() => api.post(`/w/${encodeURIComponent(scope.ws)}/due-requests/${encodeURIComponent(pending.id)}/cancel`, {}), () => setCancelDue(false)); }}>{t('cancelRequest')}</Button></div></Dialog>
    <Dialog open={reopenOpen} title={t('reopen')} description={t('reopenDescription')} onOpenChange={(open) => { if (!open && !busy) setReopenOpen(false); }}><div className={styles.dialogActions}><Button disabled={busy} onClick={() => setReopenOpen(false)}>{t('cancel')}</Button><Button variant="primary" disabled={disabled} onClick={() => void action(() => api.post(`${endpoint}/reopen`), () => setReopenOpen(false))}>{t('reopen')}</Button></div></Dialog>
  </div>;
}
