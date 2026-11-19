"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Sidebar ย่อเหลือแถบไอคอน (ผู้ใช้เลือกแบบ A + C จาก mockup 2026-11-19)
 * - ผู้ใช้กดย่อ/กางเอง → จำไว้ในเบราว์เซอร์เครื่องนี้ (ผู้ใช้เลือก "ในเครื่อง" ไม่ต้องเก็บในบัญชี)
 * - หน้าที่ต้องการพื้นที่กว้าง (Timeline, Gantt, Diagram) ย่อให้เอง เว้นแต่ผู้ใช้เคยกางเองในหน้าแบบนั้น
 */
const PREF_KEY = "fm-sidebar";
const AUTO_KEY = "fm-sidebar-auto";

/** หน้าที่ย่อ Sidebar ให้อัตโนมัติ */
export function isWidePage(pathname: string): boolean {
  return /\/p\/[^/]+\/(timeline|gantt|diagrams)(\/|$)/.test(pathname);
}

// localStorage อาจใช้ไม่ได้ (โหมดส่วนตัว / ปิด storage) → ใช้ค่าเริ่มต้นแทน ไม่ให้ทั้ง shell พัง
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // จำไม่ได้ก็ยังย่อ/กางได้ในหน้านี้
  }
}

export function useSidebarRail(pathname: string) {
  // shell แสดง Sidebar หลังโหลดข้อมูลบน client แล้วเท่านั้น จึงอ่าน localStorage ตอนสร้าง state ได้โดยไม่ชนกับ HTML จาก server
  const [pinnedRail, setPinnedRail] = useState(() => typeof window !== "undefined" && read(PREF_KEY) === "rail");
  const [autoOff, setAutoOff] = useState(() => typeof window !== "undefined" && read(AUTO_KEY) === "off");
  const wide = isWidePage(pathname);
  const rail = pinnedRail || (wide && !autoOff);

  const toggle = useCallback(() => {
    if (rail) {
      setPinnedRail(false);
      write(PREF_KEY, null);
      // กางเองในหน้ากว้าง = ไม่อยากให้ย่ออัตโนมัติอีก
      if (wide) {
        setAutoOff(true);
        write(AUTO_KEY, "off");
      }
    } else {
      setPinnedRail(true);
      write(PREF_KEY, "rail");
      // ย่อเองในหน้ากว้าง = เปิดการย่ออัตโนมัติกลับมา (ทางเดียวที่ปิดค่า "ไม่ย่อให้" ได้)
      if (wide) {
        setAutoOff(false);
        write(AUTO_KEY, null);
      }
    }
  }, [rail, wide]);

  // คีย์ลัด [ (ไม่ทำงานขณะพิมพ์ หรือเมื่อกดคู่กับปุ่มอื่น)
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "[" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      event.preventDefault();
      toggle();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { rail, toggle };
}
