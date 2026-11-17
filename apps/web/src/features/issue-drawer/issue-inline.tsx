'use client';
import { useQuery } from '@tanstack/react-query';
import { NextIntlClientProvider, useLocale, useMessages } from 'next-intl';
import drawerMessages from '../../../messages/th/issue-drawer.json';
import { ErrorState, Forbidden, LoadingState, NotFound } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/query';
import type { Permissions, Person } from '@/lib/types';
import { IssuePanel } from './issue-panel';
import { issuePath, issueQuery, projectPath, type Issue, type ProjectMeta, type Scope } from './types';
import styles from './issue-drawer.module.css';

/**
 * รายละเอียดงานแบบวางในหน้า (ไม่ใช่ Drawer) · ผู้ใช้ขอ 2026-11-17 ให้ popup รายงานงานที่จะเสร็จแสดงงานในหน้าต่างเดียวกัน
 * ใช้ IssuePanel ชุดเดียวกับ Drawer: ดู / แก้ / คอมเมนต์ตามสิทธิ์เดิม
 * onNavigate: เปิดงานอื่นจากในแผง (Sub-task, งานแม่) · onCreateSubtask: ฟอร์มสร้าง Sub-task ยังอยู่ใน Drawer
 */
export function IssueInline(props: { ws: string; projectKey: string; meId: string; yearFormat: 'BE' | 'CE'; issueKey: string; onNavigate: (key: string) => void; onClose: () => void; onCreateSubtask: (parentKey: string) => void }) {
  const messages = useMessages();
  const locale = useLocale();
  return <NextIntlClientProvider locale={locale} messages={{ ...messages, 'issue-drawer': messages['issue-drawer'] ?? drawerMessages }}><Inline {...props} /></NextIntlClientProvider>;
}

function Inline({ ws, projectKey, meId, yearFormat, issueKey, onNavigate, onClose, onCreateSubtask }: Parameters<typeof IssueInline>[0]) {
  const endpoint = projectPath(ws, projectKey);
  const permissions = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${endpoint}/my-permissions`) });
  const guest = permissions.data?.guestViewer ?? false;
  const project = useQuery({ queryKey: queryKeys.project(ws, projectKey), queryFn: () => api.get<ProjectMeta>(endpoint), enabled: !!permissions.data && !guest });
  const issue = useQuery({ queryKey: issueQuery(ws, issueKey), queryFn: ({ signal }) => api.get<Issue>(issuePath(ws, issueKey), { signal }), enabled: !!permissions.data });
  const members = useQuery({ queryKey: ['issue-members', ws, projectKey], queryFn: () => api.get<{ items: (Person & { userId?: string })[] }>(`${endpoint}/members`), enabled: !!permissions.data && !guest && !!issue.data });
  // Sub-task เลื่อนดูงานพี่น้องได้เหมือนใน Drawer
  const parentKey = issue.data?.parentKey ?? null;
  const parent = useQuery({ queryKey: issueQuery(ws, parentKey ?? ''), queryFn: ({ signal }) => api.get<Issue>(issuePath(ws, parentKey!), { signal }), enabled: !!parentKey });
  const people = (members.data?.items ?? []).map((person) => ({ ...person, id: person.userId ?? person.id }));
  const scope: Scope = { ws, projectKey, meId, yearFormat, access: permissions.data ?? { role: null, guestViewer: false, permissions: [] }, project: project.data, people, navigate: onNavigate, createSubtask: (value) => onCreateSubtask(value.key) };

  const error = permissions.error ?? (!guest ? project.error : null) ?? issue.error;
  let body;
  if (error instanceof ApiError && error.status === 403) body = <Forbidden />;
  else if (error instanceof ApiError && (error.status === 404 || error.status === 410)) body = <NotFound />;
  else if (error) body = <ErrorState error={error} retry={() => { void permissions.refetch(); void project.refetch(); void issue.refetch(); }} />;
  else if (!issue.data || permissions.isPending || (!guest && project.isPending)) body = <LoadingState />;
  else body = <IssuePanel key={issue.data.key} scope={scope} issue={issue.data} siblings={parent.data?.subtasks ?? []} onClose={onClose} onDeleted={(key) => (key ? onNavigate(key) : onClose())} />;
  return <div className={styles.root}>{body}</div>;
}
