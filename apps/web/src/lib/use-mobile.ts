"use client";
import { useSyncExternalStore } from "react";

/** จอเล็กกว่า 760 px (เส้นแบ่งเดียวกับ CSS) · ใช้เลือกหน้าตามือถือ M2–M7 แทนการซ่อนด้วย CSS เพื่อไม่ให้เนื้อหาซ้ำใน DOM */
export const MOBILE_QUERY = "(max-width: 760px)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const list = window.matchMedia(MOBILE_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
