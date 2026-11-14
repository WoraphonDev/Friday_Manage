"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/*
 * การเคลื่อนไหวของหน้าสาธารณะ (R1) · ใช้ CSS + Web Animations API ไม่เพิ่ม library
 * ทุกอย่างหยุดเองเมื่อเครื่องตั้ง "ลดการเคลื่อนไหว" และเนื้อหาแสดงครบตั้งแต่ server render (ไม่รอ JavaScript)
 */

export const EASE = "cubic-bezier(.2,.8,.2,1)";
export const SPRING = "cubic-bezier(.34,1.56,.64,1)";
const REDUCE = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCE);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/** เล่น animation แบบปลอดภัย: ไม่มี element.animate (jsdom, เบราว์เซอร์เก่า) หรือผู้ใช้ลดการเคลื่อนไหว = ไม่เล่น */
export function play(el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  if (!el || typeof (el as HTMLElement).animate !== "function" || prefersReducedMotion()) return null;
  return el.animate(keyframes, options);
}

export const rise = (px = 16): Keyframe[] => [
  { opacity: 0, transform: `translateY(${px}px)` },
  { opacity: 1, transform: "none" },
];

/**
 * เผยส่วนที่มี data-reveal เมื่อเลื่อนมาใกล้จอ · ชิ้นที่เห็นอยู่แล้วตอนเปิดหน้าไม่เล่นซ้ำ (กันกระพริบ)
 * ชิ้นในแถวเดียวกันเหลื่อมเวลากันทีละ 90ms
 */
export function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined" || prefersReducedMotion()) return;
    let first = true;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (first && entry.isIntersecting) io.unobserve(entry.target);
          if (first || !entry.isIntersecting) continue;
          io.unobserve(entry.target);
          const row = [...(entry.target.parentElement?.children ?? [])].filter((c) => c.hasAttribute("data-reveal"));
          const i = Math.max(0, row.indexOf(entry.target));
          play(entry.target, rise(22), { duration: 620, delay: (i % 3) * 90, easing: EASE, fill: "backwards" });
        }
        first = false;
      },
      // ขอบล่างขยาย 40px: เริ่มเล่นก่อนโผล่ให้เห็นเล็กน้อย จึงไม่เห็นภาพนิ่งแวบก่อนเล่น
      { rootMargin: "0px 0px 40px 0px", threshold: 0.15 },
    );
    el.querySelectorAll("[data-reveal]").forEach((target) => io.observe(target));
    return () => io.disconnect();
  }, [root]);
}

/** เรียก callback ครั้งเดียวเมื่อ element เข้ามาในจอ */
export function useInViewOnce(ref: RefObject<HTMLElement | null>, onEnter: () => void) {
  const callback = useRef(onEnter);
  useEffect(() => {
    callback.current = onEnter;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        callback.current();
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
}

/**
 * ลำดับขั้นของภาพเล็กในการ์ดฟีเจอร์ · ค่าเริ่มต้นคือขั้นสุดท้าย (ภาพครบตั้งแต่โหลด)
 * start() เริ่มจากขั้น 0 แล้วเดินตาม delays · ระหว่างเล่นอยู่กด start ซ้ำไม่มีผล
 */
export function useSequence(delays: readonly number[]) {
  const total = delays.length;
  const [step, setStep] = useState(total);
  const timers = useRef<number[]>([]);
  const busyUntil = useRef(0);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const start = useCallback(() => {
    if (prefersReducedMotion() || Date.now() < busyUntil.current) return;
    timers.current.forEach((id) => window.clearTimeout(id));
    busyUntil.current = Date.now() + (delays[total - 1] ?? 0) + 400;
    setStep(0);
    timers.current = delays.map((ms, i) => window.setTimeout(() => setStep(i + 1), ms));
  }, [delays, total]);
  return { step, start };
}
