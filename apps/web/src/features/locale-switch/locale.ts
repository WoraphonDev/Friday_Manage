// W21 · ค่ากลางของภาษาระบบ (TH / EN) ใช้ได้ทั้ง server และ client
import type { YearFormat } from "@/lib/format";

export const LOCALES = ["th", "en"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "th";

/** ชื่อ cookie ตามที่ next-intl ใช้ เพื่อให้ middleware ของ next-intl อ่านได้ถ้าเพิ่มภายหลัง */
export const LOCALE_COOKIE = "NEXT_LOCALE";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const isLocale = (value: unknown): value is AppLocale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);

/** ค่าเริ่มต้นตาม Canvas R3: ภาษาไทย = พ.ศ. · English = ค.ศ. */
export const defaultYearFormat = (locale: AppLocale): YearFormat =>
  locale === "en" ? "CE" : "BE";

/** รูปแบบปีที่ใช้จริง: ค่าที่ผู้ใช้ตั้งไว้ก่อน ถ้าไม่มี (หน้าสาธารณะ) ใช้ค่าเริ่มต้นของภาษา */
export const effectiveYearFormat = (
  locale: AppLocale,
  saved?: YearFormat | null,
): YearFormat => saved ?? defaultYearFormat(locale);

/** locale ของ Intl ที่รวมปฏิทิน เช่น en-US + gregory → "Nov 5, 2026" · th-TH + buddhist → "5 พ.ย. 2569" */
export const dateLocale = (locale: AppLocale, year: YearFormat) =>
  `${locale === "en" ? "en-US" : "th-TH"}-u-ca-${year === "BE" ? "buddhist" : "gregory"}`;

/** ชื่อภาษาเป็นภาษาของตัวเอง (endonym) ไม่แปล เพื่อให้ผู้ใช้หาภาษาของตัวเองเจอเสมอ */
export const LANGUAGE_NAMES: Record<AppLocale, string> = {
  th: "ไทย",
  en: "English",
};
