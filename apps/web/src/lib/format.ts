import { differenceInCalendarDays, isValid, parseISO } from "date-fns";
import commonTh from "../../messages/th/common.json";
import commonEn from "../../messages/en/common.json";

export type YearFormat = "BE" | "CE";
type DateLocale = "th" | "en";

/**
 * ภาษาของวันที่ = ภาษาของหน้า (`<html lang>` ที่ layout ตั้งจากภาษาของผู้ใช้) · ฝั่ง server ใช้ไทย
 * ใช้ค่าจาก DOM แทน hook เพราะ formatDate ถูกเรียกเป็นฟังก์ชันธรรมดาทั่วทั้งแอป
 */
export const pageLocale = (): DateLocale =>
  typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "th";
const intlLocale = (year: YearFormat, lang: DateLocale = pageLocale()) =>
  `${lang === "en" ? "en-US" : "th-TH"}-u-ca-${year === "BE" ? "buddhist" : "gregory"}`;
const strings = (lang: DateLocale = pageLocale()) => (lang === "en" ? commonEn.format : commonTh.format);

export function formatDate(
  value: string | Date | null | undefined,
  year: YearFormat = "BE",
  fullYear = false,
) {
  if (!value) return strings().unknownDate;
  const date =
    typeof value === "string"
      ? parseISO(value.length === 10 ? `${value}T12:00:00+07:00` : value)
      : value;
  if (!isValid(date)) return strings().unknownDate;
  return new Intl.DateTimeFormat(intlLocale(year), {
    day: "numeric",
    month: "short",
    year: fullYear ? "numeric" : "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(date);
}

export function formatDateRange(
  start: string | null,
  end: string | null,
  year: YearFormat = "BE",
) {
  return start === end
    ? formatDate(start, year)
    : `${formatDate(start, year)} – ${formatDate(end, year)}`;
}
export const formatManDay = (value: number) =>
  strings().manDay.replace(
    "{value}",
    new Intl.NumberFormat(pageLocale() === "en" ? "en-US" : "th-TH", { maximumFractionDigits: 2 }).format(value),
  );
export const today = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
export function formatOverdue(due: string, now = today()) {
  const days = differenceInCalendarDays(parseISO(now), parseISO(due));
  const lang = pageLocale();
  // ข้อความ EN ใช้รูปพหูพจน์ของ ICU จึงประกอบเองแทนการแทนค่า {days}
  const late = lang === "en" ? `${days} day${days === 1 ? "" : "s"} overdue` : strings(lang).overdue.replace("{days}", String(days));
  return days > 0 ? late : days === 0 ? strings(lang).today : formatDate(due);
}
