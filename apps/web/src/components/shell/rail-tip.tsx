"use client";

import { useEffect, useState, type FocusEvent, type PointerEvent } from "react";

function focusVisible(el: Element) {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

interface Tip {
  text: string;
  top: number;
  left: number;
}

/**
 * ชื่อเมนูข้างไอคอนเมื่อ Sidebar ย่ออยู่ · วางแบบ fixed นอก Sidebar เพราะ Sidebar เลื่อนได้ (overflow) จะตัด tooltip ที่ยื่นออกไป
 * ชื่อมาจาก data-tip → aria-label → ข้อความในปุ่ม · ผู้ใช้ screen reader ได้ชื่อจากลิงก์อยู่แล้ว จึงซ่อน tooltip จาก a11y tree
 */
export function useRailTip(rail: boolean) {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    if (!rail) setTip(null);
  }, [rail]);

  function show(target: EventTarget) {
    if (!rail || !(target instanceof Element)) return;
    const el = target.closest<HTMLElement>("[data-tip], .nav-link, .workspace-switch");
    const text = el && (el.dataset.tip ?? el.getAttribute("aria-label") ?? el.textContent?.trim());
    if (!el || !text) return setTip(null);
    const box = el.getBoundingClientRect();
    setTip({ text, top: box.top + box.height / 2, left: box.right + 10 });
  }
  const hide = () => setTip(null);

  return {
    handlers: {
      onPointerOver: (event: PointerEvent) => show(event.target),
      onPointerLeave: hide,
      onPointerDown: hide,
      // โฟกัสจากคีย์บอร์ดเท่านั้น (คลิกเมาส์ก็ได้โฟกัส แต่ hover แสดงให้แล้ว)
      onFocus: (event: FocusEvent) => {
        if (event.target instanceof Element && focusVisible(event.target)) show(event.target);
      },
      onBlur: hide,
      onScroll: hide,
    },
    tip: tip && (
      <div className="rail-tip" aria-hidden="true" style={{ top: tip.top, left: tip.left }}>
        {tip.text}
      </div>
    ),
  };
}
