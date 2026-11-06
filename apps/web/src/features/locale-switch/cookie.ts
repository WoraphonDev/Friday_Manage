// W21 · cookie ภาษาฝั่ง browser (หน้าสาธารณะใช้ cookie อย่างเดียว · ล็อกอินแล้วบันทึกที่บัญชีด้วย)
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  type AppLocale,
} from "./locale";

export function readLocaleCookie(): AppLocale | null {
  if (typeof document === "undefined") return null;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  return isLocale(value) ? value : null;
}

export function writeLocaleCookie(locale: AppLocale) {
  if (typeof document === "undefined") return;
  // SameSite=Lax พอ เพราะเป็นค่าการแสดงผล ไม่ใช่ค่าที่ต้องกันการปลอมคำขอ
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}
