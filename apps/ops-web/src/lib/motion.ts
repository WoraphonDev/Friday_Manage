"use client";
/* คัดลอกจาก apps/web/src/lib/motion.ts (แอปแยกแพ็กเกจกัน ไม่มีแพ็กเกจกลาง) · แก้ที่หนึ่งให้แก้อีกที่ด้วย */
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

/** part (เฉพาะ Ops) = วัดชิ้นในรายการที่เลือกแทนทั้งรายการ เช่น แถบล่างของหน้า /m ที่ไฮไลต์เฉพาะไอคอน */
export function useSlidingIndicator<T extends HTMLElement>(itemSelector: string, part?: string): RefCallback<T> {
  return useCallback((box: T | null) => {
    if (!box || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let shown = false;
    let lastActive: Element | null = null;
    let movingTimer = 0;
    const activeSelector = ACTIVE_STATES.map((state) => `${itemSelector}${state}`).join(", ");
    const measure = () => {
      frame = 0;
      const item = box.querySelector<HTMLElement>(activeSelector);
      const active = item && part ? item.querySelector<Element>(part) : item;
      // offsetParent เป็น null = รายการถูกซ่อน (เช่น แท็บ desktop บนมือถือ)
      if (!item || !active || item.offsetParent === null) {
        box.removeAttribute("data-indicator");
        shown = false;
        return;
      }
      const outer = box.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      // ::before / ::after วางจากขอบในของกรอบ (ถัดจาก border) จึงหักความหนา border ออก (clientLeft / clientTop)
      box.style.setProperty("--ind-x", `${rect.left - outer.left - box.clientLeft + box.scrollLeft}px`);
      box.style.setProperty("--ind-y", `${rect.top - outer.top - box.clientTop + box.scrollTop}px`);
      box.style.setProperty("--ind-w", `${rect.width}px`);
      box.style.setProperty("--ind-h", `${rect.height}px`);
      // เลือกรายการใหม่: บอก CSS ว่ากำลังเลื่อน (data-moving) ให้พื้นทึบของรายการอื่นจางลงชั่วคราว แถบที่เลื่อนจะไม่ถูกบังระหว่างทาง
      if (shown && lastActive && lastActive !== active && box.getAttribute("data-indicator") === "on") {
        box.setAttribute("data-moving", "");
        clearTimeout(movingTimer);
        movingTimer = window.setTimeout(() => box.removeAttribute("data-moving"), motionMs("--motion-dur", box));
      }
      lastActive = active;
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
    // (เฉพาะ Ops) กล่องที่อยู่ใน Modal วัดครั้งแรกระหว่าง Modal ย่อ (scale 0.98) · ResizeObserver ไม่เห็น scale จึงวัดใหม่เมื่อ animation ของกรอบที่ครอบอยู่จบ
    const settled = (e: Event) => {
      if (e.target instanceof Node && e.target !== box && e.target.contains(box)) schedule();
    };
    window.addEventListener("animationend", settled, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("animationend", settled, true);
      clearTimeout(movingTimer);
    };
  }, [itemSelector, part]);
}

/**
 * (เฉพาะ Ops) "เงา" ของ Modal / Drawer ที่ถูกถอดออกทันที · หน้าใน Ops ส่วนใหญ่เปิด Modal ด้วยการ render (`{editing && <Drawer open …/>}`)
 * และปิดด้วยการเลิก render ทำให้ Radix ไม่มีโอกาสเล่น animation ปิด (Radix เล่นได้เฉพาะตอน open เปลี่ยนเป็น false)
 * ref นี้จึงคัดลอกกล่องไว้ตอนถูกถอด แล้ววางสำเนาที่กดไม่ได้ (inert · aria-hidden) ให้เล่น data-state="closed" จนจบแล้วลบทิ้ง
 * ถอดหลัง Radix ปิดเองแล้ว (data-state เป็น closed อยู่แล้ว) หรือปิดการเคลื่อนไหว = ไม่ทำอะไร
 */
export function useExitGhost<T extends HTMLElement>(): RefCallback<T> {
  return useCallback((node: T | null) => {
    if (!node) return;
    return () => {
      if (motionDisabled() || node.getAttribute("data-state") !== "open") return;
      const scrollTop = node.scrollTop;
      // รอให้ React commit จบก่อน: ยังอยู่ในหน้า = ไม่ได้ถอดจริง (Strict Mode ใน dev ถอด-ติด ref ซ้ำตอนเปิด)
      queueMicrotask(() => {
        if (node.isConnected) return;
        const ghost = node.cloneNode(true) as HTMLElement;
        // ค่าที่พิมพ์ในช่องกรอกไม่ติดมากับ cloneNode · คัดลอกเองให้สำเนาเหมือนตอนก่อนปิด
        const from = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
        ghost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach((field, i) => {
          const source = from[i];
          if (!source) return;
          if (field instanceof HTMLInputElement && source instanceof HTMLInputElement) field.checked = source.checked;
          field.value = source.value;
        });
        ghost.removeAttribute("id");
        ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
        ghost.setAttribute("data-state", "closed");
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        ghost.style.pointerEvents = "none";
        document.body.appendChild(ghost);
        ghost.scrollTop = scrollTop;
        const remove = () => ghost.remove();
        ghost.addEventListener("animationend", (e) => e.target === ghost && remove());
        setTimeout(remove, exitDelay() + 200);
      });
    };
  }, []);
}
