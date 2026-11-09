import { formatDate, type YearFormat, localeNumberFormat } from "@/lib/format";

export const num = (n: number) => localeNumberFormat({ maximumFractionDigits: 2 }).format(n);

/** ค่าในเซลล์ตัวอย่าง / ค่าก่อน-หลังใน diff ให้อ่านง่าย */
export function showValue(v: unknown, year: YearFormat): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map((x) => showValue(x, year)).join(", ") : "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return formatDate(v.slice(0, 10), year);
  if (typeof v === "number") return num(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
