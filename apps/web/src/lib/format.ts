import { differenceInCalendarDays, isValid, parseISO } from "date-fns";
import common from "../../messages/th/common.json";

export type YearFormat = "BE" | "CE";
const locale = (year: YearFormat) =>
  `th-TH-u-ca-${year === "BE" ? "buddhist" : "gregory"}`;

export function formatDate(
  value: string | Date | null | undefined,
  year: YearFormat = "BE",
  fullYear = false,
) {
  if (!value) return common.format.unknownDate;
  const date =
    typeof value === "string"
      ? parseISO(value.length === 10 ? `${value}T12:00:00+07:00` : value)
      : value;
  if (!isValid(date)) return common.format.unknownDate;
  return new Intl.DateTimeFormat(locale(year), {
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
  common.format.manDay.replace(
    "{value}",
    new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value),
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
  return days > 0
    ? common.format.overdue.replace("{days}", String(days))
    : days === 0
      ? common.format.today
      : formatDate(due);
}
