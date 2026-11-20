'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { NextIntlClientProvider, useLocale, useMessages, useTranslations } from 'next-intl';
import { Button, Dialog, LoadingState, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import th from '../../../messages/th/issue-move.json';
import en from '../../../messages/en/issue-move.json';
import styles from './move-dialog.module.css';

interface Named { id: string; name: string }
export interface MovePreview {
  source: { key: string; name: string };
  target: { key: string; name: string; visibility: 'private' | 'workspace' };
  issues: { key: string; newKey: string; title: string; subtask: boolean }[];
  count: number;
  subtasks: number;
  pulled: string[];
  types: { from: Named; to: Named | null; byName: boolean; count: number }[];
  typeOptions: Named[];
  statuses: { key: string; typeName: string; from: Named & { category: string }; to: Named | null; byName: boolean; suggested: Named | null; options: (Named & { category: string })[]; count: number }[];
  modules: Named[];
  labels: { create: string[] };
  dropped: { requirements: string[]; screens: string[]; milestones: string[]; customFields: string[]; dependencies: { issue: string; other: string }[]; dueRequests: number };
  people: { outside: Named[]; canInvite: boolean };
  files: { move: number; keep: number; folder: string };
}
export interface MoveResult { key: string; moved: { from: string; to: string }[]; target: { key: string; name: string } }
interface ProjectItem { key: string; name: string; joined?: boolean; archivedAt?: string | null; pausedAt?: string | null }

type Props = { ws: string; sourceKey: string; keys: string[]; open: boolean; onOpenChange: (open: boolean) => void; onMoved: (result: MoveResult) => void };

/** หน้าต่างย้ายงานข้ามโปรเจกต์ (storyboard 2026-11-20) · ใช้ทั้งเมนู ⋯ ของหน้างานและแถบเลือกหลายงานในแท็บ Table */
export function MoveIssuesDialog(props: Props) {
  const messages = useMessages();
  const locale = useLocale();
  return (
    <NextIntlClientProvider locale={locale} messages={{ ...messages, 'issue-move': messages['issue-move'] ?? (locale === 'en' ? en : th) }}>
      <MoveDialog {...props} />
    </NextIntlClientProvider>
  );
}

function MoveDialog({ ws, sourceKey, keys, open, onOpenChange, onMoved }: Props) {
  const t = useTranslations('issue-move');
  const base = `/w/${encodeURIComponent(ws)}`;
  const [target, setTarget] = useState('');
  const [types, setTypes] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [moduleId, setModuleId] = useState('');
  const [addMembers, setAddMembers] = useState(true);
  useEffect(() => { if (!open) { setTarget(''); setTypes({}); setStatuses({}); setModuleId(''); setAddMembers(true); } }, [open]);

  const projects = useQuery({
    queryKey: ['move-targets', ws],
    queryFn: () => api.get<{ items: ProjectItem[] }>(`${base}/projects`),
    enabled: open,
  });
  const targets = (projects.data?.items ?? []).filter((p) => p.key !== sourceKey && p.joined !== false && !p.archivedAt && !p.pausedAt);
  const typeMap = Object.fromEntries(Object.entries(types).filter(([, v]) => v));
  const preview = useQuery({
    queryKey: ['move-preview', ws, keys.join(','), target, JSON.stringify(typeMap)],
    // ประเภทที่เลือกเปลี่ยนตัวเลือกสถานะ จึงดูใหม่ทุกครั้งที่เลือกประเภท
    queryFn: () => api.post<MovePreview>(`${base}/issues/move/preview`, { keys, targetProjectKey: target, typeMap }),
    enabled: open && !!target,
    retry: false,
  });
  const p = preview.data;
  // สถานะที่ต้องใช้: ที่เลือกเอง > ตรงชื่อ > ค่าแนะนำในหมวดเดียวกัน
  const statusOf = (row: MovePreview['statuses'][number]) => statuses[row.key] ?? row.to?.id ?? row.suggested?.id ?? '';
  const typeOf = (row: MovePreview['types'][number]) => types[row.from.id] ?? row.to?.id ?? '';
  const ready = !!p && p.types.every((r) => typeOf(r)) && p.statuses.every((r) => statusOf(r));

  const move = useMutation({
    mutationFn: () => api.post<MoveResult>(`${base}/issues/move`, {
      keys, targetProjectKey: target,
      typeMap: Object.fromEntries(p!.types.map((r) => [r.from.id, typeOf(r)])),
      statusMap: Object.fromEntries(p!.statuses.map((r) => [r.key, statusOf(r)])),
      moduleId: moduleId || null,
      addMembers: !!p!.people.canInvite && addMembers,
    }),
    onSuccess: (r) => { onOpenChange(false); onMoved(r); },
  });

  const lost = useMemo(() => {
    if (!p) return [];
    const d = p.dropped;
    return [
      d.requirements.length && t('lostRequirements', { codes: d.requirements.join(', ') }),
      d.screens.length && t('lostScreens', { codes: d.screens.join(', ') }),
      d.milestones.length && t('lostMilestones', { names: d.milestones.join(', ') }),
      d.customFields.length && t('lostFields', { names: d.customFields.map((n) => `"${n}"`).join(', ') }),
      d.dependencies.length && t('lostDeps', { keys: [...new Set(d.dependencies.map((x) => x.other))].join(', ') }),
      d.dueRequests && t('lostDue', { count: d.dueRequests }),
    ].filter((x): x is string => !!x);
  }, [p, t]);

  const title = keys.length === 1 ? t('titleOne', { key: keys[0] }) : t('titleMany', { count: keys.length });
  const error = preview.error ?? move.error;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!move.isPending) onOpenChange(next); }} title={title} size="medium">
      <div className={styles.stack}>
        <Select label={t('target')} value={target} onChange={(e) => { setTarget(e.target.value); setTypes({}); setStatuses({}); setModuleId(''); }} disabled={projects.isPending}>
          <option value="">{targets.length || projects.isPending ? t('pickTarget') : t('noTargets')}</option>
          {targets.map((x) => <option key={x.key} value={x.key}>{`${x.key} · ${x.name}`}</option>)}
        </Select>

        {target && preview.isPending && <LoadingState />}
        {error instanceof ApiError && <p className={styles.error} role="alert">{error.message}</p>}

        {p && (
          <>
            <div className={styles.ok}>
              <b>{keys.length === 1 ? t('newKey', { key: p.issues[0].key, newKey: p.issues[0].newKey }) : t('newKeys', { count: p.count, first: p.issues[0].newKey, last: p.issues.at(-1)!.newKey })}</b>
              {p.count > 1 && keys.length === 1 && <span>{t('withSubtasks', { count: p.count, keys: p.issues.map((i) => `${i.key} → ${i.newKey}`).join(' · ') })}</span>}
              {p.pulled.length > 0 && keys.length > 1 && <span>{t('pulled', { keys: p.pulled.join(', ') })}</span>}
              <span className={styles.muted}>{t('oldLinks')}</span>
            </div>

            <table className={styles.map}>
              <tbody>
                {p.types.map((r) => (
                  <tr key={r.from.id}>
                    <th scope="row">{t('mapType')}</th>
                    <td>
                      <span>{r.from.name}</span><span className={styles.arrow} aria-hidden>→</span>
                      <Select size="small" aria-label={`${t('mapType')} ${r.from.name}`} value={typeOf(r)} onChange={(e) => { setTypes((m) => ({ ...m, [r.from.id]: e.target.value })); setStatuses({}); }}>
                        {!typeOf(r) && <option value="">{t('chooseType')}</option>}
                        {p.typeOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </Select>
                      {r.byName && !types[r.from.id] ? <span className={styles.tagOk}>{t('sameName')}</span> : !r.to && <span className={styles.tagWarn}>{t('choose')}</span>}
                    </td>
                  </tr>
                ))}
                {p.statuses.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{p.types.length > 1 ? `${t('mapStatus')} · ${r.typeName}` : t('mapStatus')}</th>
                    <td>
                      <span>{r.from.name}</span><span className={styles.arrow} aria-hidden>→</span>
                      <Select size="small" aria-label={`${t('mapStatus')} ${r.typeName} ${r.from.name}`} value={statusOf(r)} onChange={(e) => setStatuses((m) => ({ ...m, [r.key]: e.target.value }))}>
                        {!statusOf(r) && <option value="">{t('chooseStatus')}</option>}
                        {r.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </Select>
                      {r.byName && !statuses[r.key] ? <span className={styles.tagOk}>{t('sameName')}</span> : !r.to && <span className={styles.tagWarn}>{t('choose')}</span>}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">{t('mapModule')}</th>
                  <td>
                    <Select size="small" aria-label={t('mapModule')} value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
                      <option value="">{t('noModule')}</option>
                      {p.modules.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  </td>
                </tr>
                <tr><th scope="row">{t('mapSprint')}</th><td>{t('toBacklog')} <span className={styles.muted}>({t('sprintNote')})</span></td></tr>
                {p.labels.create.length > 0 && <tr><th scope="row">{t('mapLabel')}</th><td>{t('labelsCreate', { names: p.labels.create.join(', ') })}</td></tr>}
              </tbody>
            </table>

            {(lost.length > 0 || p.people.outside.length > 0) && (
              <div className={styles.warn}>
                {lost.length > 0 && <b>{t('lostTitle', { count: lost.length })}</b>}
                {lost.length > 0 && <ul>{lost.map((x) => <li key={x}>{x}</li>)}</ul>}
                {p.people.outside.length > 0 && (
                  <div className={styles.people}>
                    <span>{t('outsiders', { names: p.people.outside.map((x) => x.name).join(', '), project: p.target.key })}</span>
                    {p.people.canInvite ? (
                      <label className={styles.check}><input type="checkbox" checked={addMembers} onChange={(e) => setAddMembers(e.target.checked)} /> {addMembers ? t('addMembers', { project: p.target.key }) : t('removePeople')}</label>
                    ) : <span>{t('cannotInvite', { project: p.target.key })}</span>}
                  </div>
                )}
              </div>
            )}
            {p.files.move + p.files.keep > 0 && (
              <p className={styles.muted}>
                {p.files.move > 0 && t('files', { move: p.files.move, folder: p.files.folder })}
                {p.files.move > 0 && p.files.keep > 0 && ' · '}
                {p.files.keep > 0 && t('filesKeep', { count: p.files.keep })}
              </p>
            )}
          </>
        )}

        <div className={styles.actions}>
          <Button disabled={move.isPending} onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!ready || move.isPending} onClick={() => move.mutate()}>{move.isPending ? t('moving') : t('submit', { count: p?.count ?? keys.length })}</Button>
        </div>
      </div>
    </Dialog>
  );
}
