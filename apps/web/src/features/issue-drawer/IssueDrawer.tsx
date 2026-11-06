'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { NextIntlClientProvider, useLocale, useMessages, useTranslations } from 'next-intl';
import drawerMessages from '../../../messages/th/issue-drawer.json';
import { useWorkspace } from '@/components/shell/workspace-shell';
import { Button, Dialog, Drawer, ErrorState, Forbidden, LoadingState, NotFound } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useIsMobile } from '@/lib/use-mobile';
import { queryKeys } from '@/lib/query';
import type { Permissions, Person } from '@/lib/types';
import { IssuePanel } from './issue-panel';
import { CreateIssue } from './create-issue';
import { Failure } from './shared';
import { issuePath, issueQuery, projectPath, type FormOptions, type Issue, type IssueType, type ProjectMeta, type Scope } from './types';
import styles from './issue-drawer.module.css';

export function IssueDrawer({ issueKey, onClose }: { issueKey?: string; onClose: () => void }) {
  const { workspace, me } = useWorkspace();
  const pathname = usePathname();
  const route = /^\/w\/[^/]+\/p\/([^/?]+)/.exec(pathname);
  const projectKey = route ? decodeURIComponent(route[1]) : issueKey?.replace(/-\d+$/, '') ?? '';
  return <IssueDrawerHost key={`${workspace.slug}/${projectKey}/${me.id}`} ws={workspace.slug} projectKey={projectKey} meId={me.id} yearFormat={me.yearFormat} issueKey={issueKey} onClose={onClose} />;
}

export function IssueDrawerHost({ ws, projectKey, meId, yearFormat = 'BE', issueKey, onClose }: {
  ws: string; projectKey: string; meId: string; yearFormat?: 'BE' | 'CE'; issueKey?: string; onClose: () => void;
}) {
  // ทุก state รวม draft/Undo ผูกกับผู้ใช้และโปรเจกต์ผ่าน key ของ wrapper
  const messages = useMessages();
  const locale = useLocale();
  return <NextIntlClientProvider locale={locale} messages={{ ...messages, 'issue-drawer': messages['issue-drawer'] ?? drawerMessages }}><ScopedDrawer key={`${ws}/${projectKey}/${meId}`} {...{ ws, projectKey, meId, yearFormat, issueKey, onClose }} /></NextIntlClientProvider>;
}
function ScopedDrawer({ ws, projectKey, meId, yearFormat, issueKey, onClose }: {
  ws: string; projectKey: string; meId: string; yearFormat: 'BE' | 'CE'; issueKey?: string; onClose: () => void;
}) {
  const t = useTranslations('issue-drawer');
  const mobile = useIsMobile();
  const router = useRouter(); const pathname = usePathname(); const search = useSearchParams();
  const cache = useQueryClient();
  const [activeKey, setActiveKey] = useState(issueKey);
  const rootName = useRef(issueKey);
  const [newParentKey, setNewParentKey] = useState<string | null>(() => search.get('new') === '1' ? search.get('parent') : null);
  const guard = useRef<(() => void) | null>(null);
  const registerClose = useCallback((handler: (() => void) | null) => { guard.current = handler; }, []);
  useEffect(() => setActiveKey(issueKey), [issueKey]);
  const endpoint = projectPath(ws, projectKey);
  const permissions = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`) });
  const guest = permissions.data?.guestViewer ?? false;
  const project = useQuery({ queryKey: queryKeys.project(ws, projectKey), queryFn: () => api.get<ProjectMeta>(endpoint), enabled: !!permissions.data && !guest });
  const issue = useQuery({ queryKey: issueQuery(ws, activeKey ?? ''), queryFn: ({ signal }) => api.get<Issue>(issuePath(ws, activeKey!), { signal }), enabled: !!permissions.data && !!activeKey });
  const members = useQuery({ queryKey: ['issue-members', ws, projectKey], queryFn: () => api.get<{ items: (Person & { userId?: string })[] }>(`${endpoint}/members`), enabled: !!permissions.data && !guest && (!!issue.data || (!activeKey && permissions.data.permissions.includes('issue.create'))) });
  const parentKey = newParentKey ?? issue.data?.parentKey ?? null;
  const parent = useQuery({ queryKey: issueQuery(ws, parentKey ?? ''), queryFn: ({ signal }) => api.get<Issue>(issuePath(ws, parentKey!), { signal }), enabled: !!permissions.data && !!parentKey });
  const creating = !activeKey || !!newParentKey;
  const canCreate = permissions.data?.permissions.includes('issue.create') && !guest && project.data?.status !== 'archived';
  const options = useQuery({ queryKey: ['issue-form-options', ws, projectKey], queryFn: () => api.get<FormOptions>(`${endpoint}/form-options`), enabled: creating && !!canCreate });
  const people = (members.data?.items ?? []).map((person) => ({ ...person, id: person.userId ?? person.id }));
  function replace(key?: string, newParent?: string) {
    const next = new URLSearchParams(search);
    next.delete('issue'); next.delete('new'); next.delete('parent'); next.delete('type'); next.delete('moduleId'); next.delete('phaseId'); next.delete('statusId');
    if (key) next.set('issue', key);
    if (newParent) { next.set('issue', newParent); next.set('new', '1'); next.set('parent', newParent); }
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }
  const navigate = (key: string) => { setActiveKey(key); setNewParentKey(null); replace(key); };
  const createSubtask = (value: Issue) => { setNewParentKey(value.key); setActiveKey(value.key); replace(undefined, value.key); };
  const closeNew = useCallback(() => {
    if (newParentKey) { setNewParentKey(null); setActiveKey(newParentKey); const next = new URLSearchParams(search); next.delete('new'); next.delete('parent'); next.set('issue', newParentKey); router.replace(`${pathname}?${next}`, { scroll: false }); }
    else onClose();
  }, [newParentKey, onClose, pathname, router, search]);
  const scope: Scope = { ws, projectKey, meId, yearFormat, access: permissions.data ?? { role: null, guestViewer: false, permissions: [] }, project: project.data, people, navigate, createSubtask };
  const nested = !!issue.data?.parentKey && !!parent.data && !creating;
  const rootIssue = (newParentKey || issue.data?.parentKey) && !parent.error ? parent.data : issue.data;
  if (rootIssue) rootName.current = rootIssue.key;
  useEffect(() => {
    if (!nested || !parent.data) return;
    const siblings = parent.data.subtasks ?? [];
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,button,a,[contenteditable="true"],[role="tab"],[role="dialog"] form')) return;
      const index = siblings.findIndex((item) => item.key === activeKey);
      const next = siblings[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (index >= 0 && next) { event.preventDefault(); navigate(next.key); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });
  async function created(value: Issue) { await cache.invalidateQueries({ queryKey: ['issue-drawer-list', ws, projectKey] }); navigate(value.key); }
  const requestedParam = search.get('type')?.toLowerCase();
  const requestedType: IssueType = requestedParam === 'bug' ? 'Bug' : requestedParam === 'story' ? 'Story' : requestedParam === 'spike' ? 'Spike' : 'Task';
  // B: "+ Task" ในหน้า Table/Kanban (type=task) และ Sub-task ใช้ Drawer · K1: "+ New" เลือกประเภทในหน้าต่างกลางจอ
  const createLayout: 'drawer' | 'modal' = newParentKey || requestedParam === 'task' ? 'drawer' : 'modal';
  const loading = permissions.isPending || (!guest && project.isPending) || (!!activeKey && issue.isPending) || (!!parentKey && parent.isPending);
  const error = permissions.error ?? (!guest ? project.error : null) ?? issue.error;
  function content() {
    if (error instanceof ApiError && error.status === 403) return <Forbidden />;
    if (error instanceof ApiError && error.status === 404) return <NotFound />;
    if (error instanceof ApiError && error.status === 410 && activeKey) return <DeletedIssue scope={scope} issueKey={activeKey} error={error} />;
    if (error) return <ErrorState error={error} retry={() => { void permissions.refetch(); void project.refetch(); void issue.refetch(); }} />;
    if (loading) return <LoadingState />;
    if (creating && !newParentKey) return createForm();
    if (!rootIssue) return <NotFound />;
    return <IssuePanel key={rootIssue.key} scope={scope} issue={rootIssue} onDeleted={(parentKey) => parentKey ? navigate(parentKey) : onClose()} />;
  }
  function createForm() {
    if (!canCreate) return <Forbidden />;
    if (options.error) return <ErrorState error={options.error} retry={() => void options.refetch()} />;
    if (!options.data || (newParentKey && !parent.data)) return <LoadingState />;
    return <CreateIssue key={`${newParentKey ?? 'root'}:${search.get('moduleId') ?? ''}:${search.get('phaseId') ?? ''}:${search.get('statusId') ?? ''}`} initialContext={{ moduleId: search.get('moduleId') ?? undefined, phaseId: search.get('phaseId') ?? undefined, statusId: search.get('statusId') ?? undefined }} layout={createLayout} scope={scope} options={options.data} parent={newParentKey ? parent.data : null} initialType={requestedType} onCreated={(issue) => void created(issue)} onClose={closeNew} registerClose={registerClose} />;
  }
  // ขนาดตาม Canvas: สร้างงาน = B (640), Bug = K2 (920 เต็มสูง), งานอื่น = C (860 ใต้หัวโปรเจกต์)
  const showingPanel = !(creating && !newParentKey) && !!rootIssue && !error && !loading;
  const modalCreate = creating && !newParentKey && createLayout === 'modal';
  // ฟอร์ม B มีแถบหัว + ปุ่มปิดของตัวเอง · ระหว่างโหลด / ไม่มีสิทธิ์ใช้หัวของ Drawer
  const createReady = creating && !newParentKey && !!canCreate && !!options.data && !options.error && !loading && !error;
  const closeRoot = (open: boolean) => { if (!open) { if (creating && !newParentKey && guard.current) guard.current(); else onClose(); } };
  const variant = creating && !newParentKey ? 'create' : rootIssue?.type === 'Bug' ? 'wide' : 'detail';
  return <>
    {modalCreate ? <Dialog open size="wide" title={t('newIssueIn', { project: project.data?.name ?? projectKey })} onOpenChange={closeRoot}><div className={styles.root}>{content()}</div></Dialog> :
    <Drawer open variant={variant} bare={showingPanel || createReady} title={creating && !newParentKey ? t('newIssue') : t('issueTitle', { key: rootIssue?.key ?? rootName.current ?? activeKey ?? '' })} onOpenChange={(open) => { if (!open) { if (creating && !newParentKey && guard.current) guard.current(); else onClose(); } }}>
      <div className={styles.root}>{content()}</div>
    </Drawer>}
    {nested && issue.data && <Drawer open depth={2} variant="detail" bare title={t('issueTitle', { key: issue.data.key })} parentLabel={mobile ? undefined : `${parent.data!.key} · ${parent.data!.title}`} onBack={() => navigate(parent.data!.key)} onOpenChange={(open) => { if (!open) navigate(parent.data!.key); }}><div className={styles.root}><IssuePanel key={issue.data.key} scope={scope} issue={issue.data} siblings={parent.data!.subtasks} onDeleted={(parentKey) => parentKey ? navigate(parentKey) : onClose()} /></div></Drawer>}
    {newParentKey && <Drawer open depth={2} variant="create" title={t('newSubtask')} parentLabel={parent.data ? `${parent.data.key} · ${parent.data.title}` : newParentKey} onBack={() => guard.current ? guard.current() : closeNew()} onOpenChange={(open) => { if (!open) { if (guard.current) guard.current(); else closeNew(); } }}><div className={styles.root}>{parent.error ? <ErrorState error={parent.error} retry={() => void parent.refetch()} /> : createForm()}</div></Drawer>}
  </>;
}
function DeletedIssue({ scope, issueKey, error }: { scope: Scope; issueKey: string; error: ApiError }) {
  const t = useTranslations('issue-drawer'); const cache = useQueryClient();
  const [pending, setPending] = useState(false); const [failure, setFailure] = useState<unknown>(null);
  const until = typeof error.details.restorableUntil === 'string' ? error.details.restorableUntil : null;
  const deletedBy = error.details.deletedBy as { displayName?: string } | null;
  async function restore() { if (pending) return; setPending(true); try { await api.post(`${issuePath(scope.ws, issueKey)}/restore`); await cache.invalidateQueries({ queryKey: issueQuery(scope.ws, issueKey) }); } catch (error) { setFailure(error); } finally { setPending(false); } }
  return <div className={styles.deleted}><h3>{t('deletedIssueTitle')}</h3><p>{t('deletedBy', { name: deletedBy?.displayName ?? t('system') })}</p>{until && <p>{t('restoreUntil', { date: formatDate(until, scope.yearFormat, true) })}</p>}{scope.access.permissions.includes('issue.delete') && until && Date.parse(until) > Date.now() && <Button variant="primary" disabled={pending} onClick={() => void restore()}>{t('restore')}</Button>}{!!failure && <Failure error={failure} />}</div>;
}
