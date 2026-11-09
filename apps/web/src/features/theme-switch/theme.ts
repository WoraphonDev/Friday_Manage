// ธีมสว่าง / มืด / ตามระบบ · เก็บใน cookie เพื่อให้ layout ฝั่ง server ส่งค่ามากับหน้าแรก
// ไม่เก็บที่บัญชี: เป็นค่าของอุปกรณ์ (เช่น มือถือมืด คอมพิวเตอร์สว่าง) และไม่ต้องแก้ API

export const THEME_PREFS = ["light", "dark", "system"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_COOKIE = "fm-theme";
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** ค่าเริ่มต้นคงหน้าตาเดิม (สว่าง) ผู้ใช้เลือกมืดหรือตามระบบได้เอง */
export const DEFAULT_THEME: ThemePref = "light";

export function isThemePref(value: unknown): value is ThemePref {
  return typeof value === "string" && (THEME_PREFS as readonly string[]).includes(value);
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

/**
 * สคริปต์ใน <head> ทำงานก่อนวาดหน้า: อ่าน data-theme-pref ที่ server ใส่ไว้ แล้วตั้ง data-theme
 * (ป้องกันหน้ากะพริบเป็นสีสว่างก่อนเข้าโหมดมืด) และฟังการเปลี่ยนโหมดของระบบเมื่อเลือก "ตามระบบ"
 * React ไม่ได้ถือ data-theme เอง จึงไม่ลบค่านี้ทิ้งตอน render ใหม่
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,q=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");function a(){var p=d.getAttribute("data-theme-pref");d.setAttribute("data-theme",p==="dark"||(p==="system"&&q&&q.matches)?"dark":"light")}a();if(q){q.addEventListener?q.addEventListener("change",a):q.addListener(a)}window.__fmApplyTheme=a})();`;

/** ตั้งธีมทันทีในหน้าที่เปิดอยู่ แล้วจำไว้ใน cookie สำหรับครั้งต่อไป */
export function applyThemePref(pref: ThemePref) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme-pref", pref);
  const systemDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", resolveTheme(pref, systemDark));
  // SameSite=Lax พอ เพราะเป็นค่าการแสดงผล ไม่ใช่ค่าที่ต้องกันการปลอมคำขอ
  document.cookie = `${THEME_COOKIE}=${pref}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
  window.dispatchEvent(new Event(THEME_EVENT));
}

export const THEME_EVENT = "fm-theme-change";

export function readThemePref(): ThemePref {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const value = document.documentElement.getAttribute("data-theme-pref");
  return isThemePref(value) ? value : DEFAULT_THEME;
}
