"use client";
import { useCallback, type RefCallback } from "react";

/** เครื่องตั้ง "ลดการเคลื่อนไหว" หรืออยู่ใน test (ไม่ให้ตัวเลขระหว่างนับไปชนกับการค้นข้อความใน test) */
export function motionDisabled() {
  if (process.env.NODE_ENV === "test") return true;
  return typeof window === "undefined" || !window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** อ่านค่าเวลาจาก token --motion-* เป็นมิลลิวินาที · ตัวย่อ CSS ตอน build เขียน 550ms เป็น .55s จึงต้องดูหน่วย */
export function motionMs(token: string, element: Element = document.documentElement) {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith("ms") ? n : value.endsWith("s") ? n * 1000 : n;
}

/** เวลาที่ต้องรอให้ animation ปิด (Drawer / Dialog) เล่นจบก่อนถอด component ออก · 0 เมื่อปิดการเคลื่อนไหว */
export function exitDelay() {
  return motionDisabled() ? 0 : motionMs("--motion-dur");
}

/**
 * แถบไฮไลต์ที่เลื่อนตามรายการที่เลือก (sidebar, แถบแท็บ, เมนูหัวข้อ, ปุ่มสลับมุมมอง) · วัดตำแหน่งรายการที่เลือกตาม ACTIVE_STATES
 * ใช้กับกลุ่มที่เลือกได้ทีละรายการเท่านั้น (ชิปกรองที่กดได้หลายอันใช้ไม่ได้ เพราะวัดเฉพาะรายการแรกที่เลือก)
 * แล้วเขียนเป็น --ind-x/y/w/h บนกล่อง + data-indicator ให้ CSS วาดด้วย ::before/::after
 * "jump" = วางครั้งแรก (ไม่เลื่อนมาจากมุมซ้ายบน) · "on" = เลื่อนแบบ transition · ไม่มีรายการที่เลือก = ถอด data-indicator กลับไปใช้สีเดิมของรายการ
 * คืน callback ref (React 19 รับ cleanup จาก ref ได้) เพราะกล่องอาจขึ้นทีหลัง เช่น แถบแท็บโปรเจกต์ที่รอข้อมูลโปรเจกต์ก่อน
 */
/** รูปแบบ "รายการที่เลือกอยู่" ที่ระบบใช้: ลิงก์ (aria-current) · แท็บ Radix (data-state) · ปุ่มสลับ (aria-pressed) · แท็บ/ตัวเลือกเอง (aria-selected, aria-checked) */
const ACTIVE_STATES = ['[aria-current="page"]', '[data-state="active"]', '[aria-pressed="true"]', '[aria-selected="true"]', '[aria-checked="true"]'];

export function useSlidingIndicator<T extends HTMLElement>(itemSelector: string): RefCallback<T> {
  return useCallback((box: T | null) => {
    if (!box || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let shown = false;
    const activeSelector = ACTIVE_STATES.map((state) => `${itemSelector}${state}`).join(", ");
    const measure = () => {
      frame = 0;
      const active = box.querySelector<HTMLElement>(activeSelector);
      // offsetParent เป็น null = รายการถูกซ่อน (เช่น แท็บ desktop บนมือถือ)
      if (!active || active.offsetParent === null) {
        box.removeAttribute("data-indicator");
        shown = false;
        return;
      }
      const outer = box.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      box.style.setProperty("--ind-x", `${rect.left - outer.left + box.scrollLeft}px`);
      box.style.setProperty("--ind-y", `${rect.top - outer.top + box.scrollTop}px`);
      box.style.setProperty("--ind-w", `${rect.width}px`);
      box.style.setProperty("--ind-h", `${rect.height}px`);
      if (shown) return;
      shown = true;
      box.setAttribute("data-indicator", "jump");
      // เปิด transition หลังเบราว์เซอร์วาดตำแหน่งแรกแล้ว
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (shown) box.setAttribute("data-indicator", "on");
      }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // ขนาดรายการเปลี่ยนได้โดยกล่องไม่เปลี่ยน (ฟอนต์โหลดเสร็จ, ตัวเลขแจ้งเตือน) จึงดูทุกรายการด้วย
    const resize = new ResizeObserver(schedule);
    const watchItems = () => box.querySelectorAll(itemSelector).forEach((item) => resize.observe(item));
    resize.observe(box);
    watchItems();
    const mutation = new MutationObserver(() => {
      watchItems();
      schedule();
    });
    mutation.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "data-state", "aria-pressed", "aria-selected", "aria-checked"] });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [itemSelector]);
}
