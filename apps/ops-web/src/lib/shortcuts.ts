"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * ปุ่มลัดของ Friday Ops (ช่วง 2 · ทำงานเร็ว)
 * ชุดหลักเหมือนกันทุกหน้า: J / K เลื่อน · Enter เปิด · Esc ปิด · / ค้นในหน้า · X เลือกแถว · [ ] เปลี่ยนหน้า · ? ดูปุ่มลัด
 * ไม่ทำงานตอนพิมพ์ในช่องข้อความ ยกเว้นที่ตั้ง `inInput` (เช่น ⌘↵ ส่ง)
 * ตารางหลังแผงที่เปิดอยู่ (Drawer / Modal) ไม่รับปุ่มลัดของรายการ (`list: true`)
 */
export interface Shortcut {
  /** "j" · "enter" · "mod+enter" · "shift+mod+enter" · "?" · "/" · "[" · "1" */
  keys: string;
  /** คำอธิบายในหน้าต่าง "?" · ไม่ใส่ = ไม่แสดง */
  label?: string;
  /** กลุ่มในหน้าต่าง "?" */
  group?: "global" | "page";
  /** ทำงานตอนโฟกัสอยู่ในช่องข้อความด้วย */
  inInput?: boolean;
  /** ปุ่มของรายการ: ไม่ทำงานเมื่อมีแผงหรือหน้าต่างเปิดทับ */
  list?: boolean;
  run: (e: KeyboardEvent) => void;
}

// รายการที่กำลังลงทะเบียนอยู่ (ใช้แสดงในหน้าต่าง "?")
let mounted: Shortcut[][] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
let snapshot: Shortcut[] = [];
const getSnapshot = () => snapshot;
const rebuild = () => ((snapshot = mounted.flat().filter((s) => s.label)), emit());

const typing = (el: EventTarget | null) => el instanceof HTMLElement && !!el.closest("input, textarea, select, [contenteditable='true']");
/** มีแผง / หน้าต่างเปิดอยู่ (Radix ใส่ role=dialog) */
export const overlayOpen = () => typeof document !== "undefined" && !!document.querySelector("[role='dialog'][data-state='open'], .popover[data-state='open']");

export function matches(keys: string, e: KeyboardEvent) {
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop()!;
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  if (mod !== (e.metaKey || e.ctrlKey)) return false;
  if (e.altKey) return false;
  // ตัวอักษร / สัญลักษณ์ที่ต้องกด Shift อยู่แล้ว (?) ไม่ตรวจ Shift
  if (key.length === 1 && !/[a-z0-9]/.test(key)) return e.key === key;
  if (shift !== e.shiftKey) return false;
  return e.key.toLowerCase() === key;
}

/** ลงทะเบียนปุ่มลัดขณะ component ยังอยู่บนหน้า · defs อ่านค่าล่าสุดทุกครั้งที่กด (ไม่ต้องใส่ deps) */
export function useShortcuts(defs: Shortcut[], enabled = true) {
  const ref = useRef(defs);
  ref.current = defs;
  useEffect(() => {
    if (!enabled) return;
    const list = ref.current;
    mounted = [...mounted, list];
    rebuild();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      for (const s of ref.current) {
        if (!matches(s.keys, e)) continue;
        if (!s.inInput && typing(e.target)) continue;
        if (s.list && overlayOpen()) continue;
        e.preventDefault();
        s.run(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      mounted = mounted.filter((x) => x !== list);
      rebuild();
    };
  }, [enabled]);
}

/** ปุ่มลัดที่ใช้ได้ตอนนี้ (หน้าต่าง "?") */
export const useActiveShortcuts = () => useSyncExternalStore(subscribe, getSnapshot, () => snapshot);

/**
 * เลื่อนในตารางด้วย J / K · Enter เปิด · X เลือก (ช่วง 2)
 * แถวที่เลือกอยู่ใส่ `data-active` · เลื่อนให้เห็นเสมอ
 */
export function useRowNav<T>(rows: T[], opts: { onOpen?: (row: T) => void; onToggle?: (row: T) => void; labels: { down: string; open: string; toggle?: string } }) {
  const [active, setActive] = useState(-1);
  const max = rows.length - 1;
  // ข้อมูลเปลี่ยน (เปลี่ยนหน้า / ตัวกรอง) ไม่ให้ชี้เกินรายการ
  const index = Math.min(active, max);
  const move = (d: number) => {
    const next = Math.max(0, Math.min(max, (index < 0 ? -1 : index) + d));
    setActive(next);
    requestAnimationFrame(() => document.querySelector(`[data-row-index="${next}"]`)?.scrollIntoView?.({ block: "nearest" }));
  };
  useShortcuts([
    { keys: "j", label: opts.labels.down, group: "global", list: true, run: () => move(1) },
    { keys: "k", list: true, run: () => move(-1) },
    ...(opts.onOpen ? [{ keys: "enter", label: opts.labels.open, group: "global" as const, list: true, run: () => index >= 0 && opts.onOpen!(rows[index]) }] : []),
    ...(opts.onToggle ? [{ keys: "x", label: opts.labels.toggle, group: "global" as const, list: true, run: () => index >= 0 && opts.onToggle!(rows[index]) }] : []),
  ]);
  return { active: index, setActive, rowProps: (i: number) => ({ "data-row-index": i, "data-active": i === index ? true : undefined }) };
}

/**
 * แถวไม่กระโดดเมื่อรายการรีเฟรชเอง (ช่วง 2): แถวใหม่ยังไม่แสดงจนกว่าจะกด "แสดง" · แถวที่หายไป (มีคนรับ / ปิดแล้ว) เอาออกตามปกติ
 * resetKey เปลี่ยน (ตัวกรอง / หน้า) = เริ่มนับใหม่
 */
export function useStableRows<T extends { id: string }>(items: T[] | undefined, resetKey: string) {
  const [known, setKnown] = useState<{ key: string; ids: Set<string> } | null>(null);
  const current = known && known.key === resetKey ? known.ids : null;
  useEffect(() => {
    if (items && !current) setKnown({ key: resetKey, ids: new Set(items.map((i) => i.id)) });
  }, [items, current, resetKey]);
  const rows = !items ? [] : current ? items.filter((i) => current.has(i.id)) : items;
  const fresh = items && current ? items.filter((i) => !current.has(i.id)).length : 0;
  const reveal = () => items && setKnown({ key: resetKey, ids: new Set(items.map((i) => i.id)) });
  return { rows, fresh, reveal };
}
