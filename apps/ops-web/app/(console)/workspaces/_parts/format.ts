import { useFormatter } from "next-intl";

/** ตัวช่วยแสดงผลที่หน้าลูกค้าใช้ร่วมกัน · เงินเป็นสตางค์ */
export function useFmt() {
  const f = useFormatter();
  return {
    money: (satang: number | null | undefined) => (satang == null ? "—" : f.number(satang / 100, { style: "currency", currency: "THB", maximumFractionDigits: 0 })),
    date: (iso: string | null | undefined) => (iso ? f.dateTime(new Date(iso), { dateStyle: "medium" }) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? f.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "—"),
    ago: (iso: string | null | undefined) => (iso ? f.relativeTime(new Date(iso), new Date()) : "—"),
    bytes: (n: number) => (n >= 1024 ** 3 ? `${f.number(n / 1024 ** 3, { maximumFractionDigits: 1 })} GB` : `${f.number(n / 1024 ** 2, { maximumFractionDigits: 0 })} MB`),
    num: (n: number) => f.number(n),
  };
}

export const PLAN_LABEL: Record<string, string> = { free: "Free", team_s: "Team S", team_m: "Team M", team_l: "Team L", enterprise: "Enterprise" };
export const planLabel = (p: string | null | undefined) => (p ? (PLAN_LABEL[p] ?? p) : "—");
export const healthTone = (n: number) => (n >= 70 ? "ok" : n >= 40 ? "warn" : "bad");
