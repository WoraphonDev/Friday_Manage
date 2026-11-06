// W21 · เลือกภาษาของคำขอ: ค่าในบัญชี → cookie → Accept-Language → ไทย
import { DEFAULT_LOCALE, isLocale, type AppLocale } from "./locale";

/** อ่าน Accept-Language ตามค่า q แล้วคืนภาษาแรกที่ระบบรองรับ (เทียบแค่ภาษาหลัก เช่น en-GB → en) */
export function parseAcceptLanguage(
  header: string | null | undefined,
): AppLocale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return {
        language: tag.trim().toLowerCase().split("-")[0],
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((item) => item.language && item.quality > 0)
    // เรียง q มากก่อน ถ้าเท่ากันคงลำดับเดิมตามที่เบราว์เซอร์ส่ง
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return ranked.map((item) => item.language).find(isLocale) ?? null;
}

export interface LocaleSources {
  /** `users.locale` จาก GET /me (ถ้ารู้แล้ว) */
  userLocale?: string | null;
  /** ค่า cookie `NEXT_LOCALE` */
  cookie?: string | null;
  /** header `Accept-Language` */
  acceptLanguage?: string | null;
}

export function resolveLocale({
  userLocale,
  cookie,
  acceptLanguage,
}: LocaleSources = {}): AppLocale {
  if (isLocale(userLocale)) return userLocale;
  if (isLocale(cookie)) return cookie;
  return parseAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
