'use client';
import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from 'react';
import { Avatar } from '@/components/ui';
import type { MentionPicks } from './mentions';
import type { Scope } from './types';

type Person = Scope['people'][number];
import styles from './issue-drawer.module.css';

/**
 * ช่องพิมพ์ที่ @mention ได้ ใช้ร่วมกันระหว่างช่องเขียนคอมเมนต์และหน้าต่างแก้คอมเมนต์ (เดิมแก้แล้ว @ ไม่ได้ · ผู้ใช้ทัก 2026-11-19)
 * ดู @ ก่อนเคอร์เซอร์ ไม่ใช่ท้ายข้อความ เพื่อแทรกชื่อกลางประโยคตอนแก้ได้
 * กล่องเลือกคน: ลูกศรขึ้นลงเลือก · Enter / Tab ใส่ชื่อ · Esc ปิดจนกว่าจะพิมพ์ @ ใหม่
 */
export function useMentionInput(people: Person[], label: string) {
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<MentionPicks>(new Map());
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const moveCaret = useRef<number | null>(null);
  const id = useId();
  // ย้ายเคอร์เซอร์ไปหลังชื่อที่เพิ่งใส่ หลัง React เขียนค่าใหม่ลงช่องแล้ว
  useLayoutEffect(() => {
    if (moveCaret.current === null || !ref.current) return;
    ref.current.setSelectionRange(moveCaret.current, moveCaret.current);
    moveCaret.current = null;
  });
  const tail = /@([^@\n]*)$/.exec(text.slice(0, caret));
  const suggestions = tail && closedAt !== tail.index && ![...picks.keys()].some((name) => tail[1].startsWith(`${name} `)) ? people.filter((person) => person.displayName.toLocaleLowerCase().includes(tail[1].toLocaleLowerCase())).slice(0, 8) : [];
  const current = suggestions.length ? Math.min(active, suggestions.length - 1) : 0;
  const open = suggestions.length > 0;

  function reset(next = '', nextPicks: MentionPicks = new Map()) {
    setText(next); setPicks(nextPicks); setCaret(next.length); setActive(0); setClosedAt(null);
  }
  function pick(person: Person) {
    if (!tail) return;
    const inserted = `@${person.displayName} `;
    setText(text.slice(0, tail.index) + inserted + text.slice(caret));
    setPicks((now) => new Map(now).set(person.displayName, person.id));
    setCaret(tail.index + inserted.length);
    moveCaret.current = tail.index + inserted.length;
    setActive(0);
    ref.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((current + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); }
    else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(suggestions[current]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosedAt(tail?.index ?? null); }
  }
  const inputProps = {
    ref, value: text, onKeyDown,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setText(event.target.value); setCaret(event.target.selectionStart); setActive(0); },
    // คลิกหรือกดลูกศรย้ายเคอร์เซอร์ → ดู @ ตรงตำแหน่งใหม่
    onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart),
    role: open ? 'combobox' as const : undefined,
    'aria-expanded': open ? true : undefined,
    'aria-controls': open ? `${id}-list` : undefined,
    'aria-activedescendant': open ? `${id}-${suggestions[current].id}` : undefined,
  };
  const menu = (className = styles.mentionOptions) => open && <ul className={className} id={`${id}-list`} role="listbox" aria-label={label}>{suggestions.map((person, index) => <li key={person.id} id={`${id}-${person.id}`} role="option" aria-label={person.displayName} aria-selected={index === current} className={styles.mentionOption} onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); pick(person); }}><Avatar person={person} size="small" /><span>{person.displayName}</span></li>)}</ul>;
  return { text, picks, reset, inputProps, menu };
}
