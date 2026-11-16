'use client';
import { Fragment, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { api } from '@/lib/api';
import styles from './issue-drawer.module.css';

/** ระบบติดตามงานภายนอกที่ Admin ตั้งไว้ (Admin › Integrations) · urlTemplate มี {id} */
export interface IssueTracker { name: string; urlTemplate: string }

export const issueTrackersKey = (ws: string) => ['issue-trackers', ws] as const;
export function useIssueTrackers(ws: string, enabled = true) {
  return useQuery({ enabled, queryKey: issueTrackersKey(ws), queryFn: ({ signal }) => api.get<{ items: IssueTracker[] }>(`/w/${encodeURIComponent(ws)}/issue-trackers`, { signal }), staleTime: 5 * 60_000, select: (r) => r.items });
}

// เลขงานต้องมีตัวเลขอย่างน้อยหนึ่งตัว (Redmine 111004, Jira ABC-123) · คำธรรมดาหลังเลขจึงไม่กลายเป็นลิงก์
const ID = String.raw`(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]*`;
const MD_LINK = String.raw`\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)`;
const URL_RE = String.raw`https?:\/\/[^\s<>"']+`;
const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (v: string) => new RegExp(`^${ID}$`).test(v);
const anchor = (key: string, href: string, label: ReactNode) => <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>;

/**
 * ข้อความหมายเหตุ → ข้อความ + ลิงก์ · คงตัวอักษรตามที่พิมพ์ (จุลภาค ช่องว่าง ขึ้นบรรทัด)
 * - "<ชื่อระบบ> # : 111004 , 111005" → เลขแต่ละตัวลิงก์ตาม urlTemplate ของระบบนั้น
 * - "[ชื่อ](https://…)" → ลิงก์ชื่อ · URL เปล่า → ลิงก์ (รับเฉพาะ http/https)
 */
export function linkRemark(text: string, trackers: readonly IssueTracker[]): ReactNode[] {
  const byName = new Map(trackers.map((x) => [x.name.toLowerCase(), x]));
  const names = trackers.map((x) => escape(x.name)).sort((a, b) => b.length - a.length).join('|');
  const ref = names ? String.raw`(?<![\p{L}\p{N}])(${names})([ \t]*#[ \t]*:?[ \t]*)(${ID}(?:[ \t]*,?[ \t]*${ID})*)|` : '';
  // กลุ่ม: 1-3 = เลขงาน (มีเมื่อตั้งระบบไว้) · ถัดไป = [ชื่อ](URL) · สุดท้าย = URL เปล่า
  const re = new RegExp(`${ref}${MD_LINK}|(${URL_RE})`, 'giu');
  const g = names ? 3 : 0;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index;
    out.push(text.slice(last, at));
    last = at + m[0].length;
    if (names && m[1]) {
      const tracker = byName.get(m[1].toLowerCase())!;
      out.push(m[1] + m[2]);
      m[3].split(/([A-Za-z0-9][A-Za-z0-9_-]*)/).forEach((piece, i) => out.push(i % 2 && isId(piece) ? anchor(`${at}-${i}`, tracker.urlTemplate.replaceAll('{id}', encodeURIComponent(piece)), piece) : piece));
    } else if (m[g + 1]) {
      out.push(anchor(`${at}`, m[g + 2], m[g + 1]));
    } else {
      // จุดหรือวงเล็บท้ายประโยคไม่ใช่ส่วนของ URL
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      out.push(anchor(`${at}`, url, url));
      last = at + url.length;
    }
  }
  out.push(text.slice(last));
  return out.filter((part) => part !== '').map((part, i) => (typeof part === 'string' ? <Fragment key={`t${i}`}>{part}</Fragment> : part));
}

export function RemarkText({ text, className, trackers }: { text: string; className?: string; trackers: readonly IssueTracker[] }) {
  return <p className={className}>{linkRemark(text, trackers)}</p>;
}

/** แยกเลขงานที่ผู้ใช้กรอก (คั่นด้วยจุลภาคหรือช่องว่าง) · ตัวที่ไม่ใช่เลขงานคืนใน invalid */
export function parseIds(input: string) {
  const all = input.split(/[\s,]+/).filter(Boolean);
  return { ids: [...new Set(all.filter(isId))], invalid: all.filter((x) => !isId(x)) };
}

/** ต่อเลขงานท้ายบรรทัด "<ชื่อระบบ> # : …" เดิม · ยังไม่มีบรรทัดนี้ = ขึ้นบรรทัดใหม่ · เลขที่มีอยู่แล้วไม่ซ้ำ */
export function addTrackerIds(text: string, name: string, ids: string[]) {
  const lines = text.split('\n');
  const head = new RegExp(String.raw`^[ \t]*${escape(name)}[ \t]*#`, 'iu');
  const index = lines.findLastIndex((line) => head.test(line));
  if (index < 0) return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${name} # : ${ids.join(' , ')}`;
  const line = lines[index].trimEnd();
  const has = new Set(line.slice(line.indexOf('#') + 1).split(/[\s,:]+/).filter(Boolean));
  const fresh = ids.filter((id) => !has.has(id));
  if (fresh.length) lines[index] = /#[ \t]*:?$/.test(line) ? `${line}${line.endsWith(':') ? '' : ' :'} ${fresh.join(' , ')}` : `${line} , ${fresh.join(' , ')}`;
  return lines.join('\n');
}

/** แทรกลิงก์ที่ตำแหน่งเคอร์เซอร์ · มีชื่อ = [ชื่อ](URL) · เว้นวรรคให้ถ้าติดตัวอักษร */
export function insertLink(text: string, start: number, end: number, url: string, label: string) {
  const name = label.replace(/[[\]\n]/g, ' ').trim();
  const snippet = name ? `[${name}](${url})` : url;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^\s/.test(after) ? ' ' : '';
  const next = `${before}${pre}${snippet}${post}${after}`;
  return { text: next, cursor: before.length + pre.length + snippet.length };
}

export const isWebUrl = (value: string) => {
  try { const u = new URL(value); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !/\s/.test(value); } catch { return false; }
};

type Mode = { kind: 'tracker'; tracker: IssueTracker } | { kind: 'link' } | null;

/** ปุ่ม "แทรกลิงก์ ▾" ใต้ช่องแก้หมายเหตุ · เลขงานของระบบที่ Admin ตั้งไว้ หรือลิงก์ภายนอก */
export function RemarkLinkTools({ trackers, draft, setDraft, textarea }: { trackers: readonly IssueTracker[]; draft: string; setDraft: (value: string) => void; textarea: () => HTMLTextAreaElement | null }) {
  const t = useTranslations('issue-drawer.remarkLinks');
  const [mode, setMode] = useState<Mode>(null);
  const [ids, setIds] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  function open(next: Mode) { setMode(next); setIds(''); setUrl(''); setLabel(''); setError(null); }
  function focus(cursor: number) {
    requestAnimationFrame(() => { const box = textarea(); if (box) { box.focus(); box.setSelectionRange(cursor, cursor); } });
  }
  function add() {
    if (mode?.kind === 'tracker') {
      const parsed = parseIds(ids);
      if (!parsed.ids.length || parsed.invalid.length) return setError(t('invalidIds'));
      const next = addTrackerIds(draft, mode.tracker.name, parsed.ids);
      setDraft(next); open(null); focus(next.length);
    } else if (mode?.kind === 'link') {
      const value = url.trim();
      if (!isWebUrl(value)) return setError(t('invalidUrl'));
      const box = textarea();
      const r = insertLink(draft, box?.selectionStart ?? draft.length, box?.selectionEnd ?? draft.length, value, label);
      setDraft(r.text); open(null); focus(r.cursor);
    }
  }
  // อยู่ใน <form> ของช่องหมายเหตุ · Enter ในช่องย่อยต้องเพิ่มลิงก์ ไม่ใช่บันทึกหมายเหตุ
  const onKey = (event: React.KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); add(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); open(null); } };
  return <>
    <span className={styles.remarkSep} aria-hidden />
    <Popover.Root>
      <Popover.Trigger asChild><Button size="small" variant="ghost" className={styles.remarkInsert}>{t('insert')}<ChevronDown size={14} aria-hidden /></Button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="popover project-menu" sideOffset={6} align="start" aria-label={t('insert')}>
        {trackers.length > 0 && <div className={styles.menuLabel}>{t('trackersGroup')}</div>}
        {trackers.map((tracker) => <Popover.Close asChild key={tracker.name}><button type="button" className="menu-item" onClick={() => open({ kind: 'tracker', tracker })}>{tracker.name}</button></Popover.Close>)}
        {trackers.length > 0 && <hr className={styles.menuSep} />}
        <Popover.Close asChild><button type="button" className="menu-item" onClick={() => open({ kind: 'link' })}>{t('externalLink')}</button></Popover.Close>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    {mode && <div className={`${styles.remarkPanel} motion-in`} role="group" aria-label={t('insert')} onKeyDown={onKey}>
      {mode.kind === 'tracker'
        ? <Input label={t('idsLabel', { name: mode.tracker.name })} autoFocus inputMode="text" value={ids} placeholder="111004, 111005" onChange={(event) => { setIds(event.target.value); setError(null); }} />
        : <>
          <Input label="URL" autoFocus type="url" value={url} placeholder="https://" onChange={(event) => { setUrl(event.target.value); setError(null); }} />
          <Input label={t('linkLabel')} value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} />
        </>}
      {error && <span role="alert" className={styles.remarkError}>{error}</span>}
      <div className={styles.actions}><Button size="small" variant="primary" onClick={add}>{t('add')}</Button><Button size="small" onClick={() => open(null)}>{t('close')}</Button></div>
    </div>}
  </>;
}
