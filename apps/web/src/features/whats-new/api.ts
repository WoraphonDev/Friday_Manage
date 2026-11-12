// มีอะไรใหม่ / Spotlight (A42 · apps/api/src/changelog) · ข้อมูลเขียนโดยทีม Friday ใน Friday Ops (O33)
import { useLocale } from "next-intl";

export type Kind = "new" | "improved" | "fixed";
export type Role = "owner" | "admin" | "member" | "guest";

export interface WhatsNewItem {
  id: string;
  kind: Kind;
  title: string;
  summary: string;
  body: string;
  titleEn: string | null;
  summaryEn: string | null;
  bodyEn: string | null;
  media: { url: string; kind: "image" | "video"; alt: string } | null;
  cta: { label: string; labelEn: string | null; path: string } | null;
  date: string;
  publishedAt: string;
  spotlight: boolean;
  unseen: boolean;
}
export interface WhatsNewList {
  items: WhatsNewItem[];
  unseen: number;
  seenAt: string | null;
  /** Guest / Workspace ที่ถูกระงับ: ไม่แสดงปุ่ม */
  hidden: boolean;
}

export const whatsNewKey = (ws: string) => ["whats-new", ws] as const;
export const spotlightKey = (ws: string) => ["spotlight", ws] as const;
export const listPath = (ws: string) => `/me/whats-new?workspace=${encodeURIComponent(ws)}`;

/** ฉบับอังกฤษไม่บังคับ (คำตัดสิน W24): ผู้ใช้ภาษาอังกฤษเห็นฉบับไทยถ้ายังไม่มี */
export function useLocalized() {
  const en = useLocale() === "en";
  return (item: WhatsNewItem) => ({
    title: (en && item.titleEn) || item.title,
    summary: (en && item.summaryEn) || item.summary,
    body: (en && item.bodyEn) || item.body,
    cta: item.cta ? { label: (en && item.cta.labelEn) || item.cta.label, path: item.cta.path } : null,
  });
}

/** ปุ่ม "ลองใช้" พาไปหน้าใน Workspace ปัจจุบัน · path จาก API ขึ้นต้นด้วย / เสมอ (O33 ตรวจแล้ว) */
export const ctaHref = (ws: string, path: string) => `/work/${encodeURIComponent(ws)}${path.startsWith("/") ? path : `/${path}`}`;

/** รายละเอียดแบบ markdown อย่างง่าย: บรรทัด "- " = ข้อในรายการ (Spotlight) · ที่เหลือเป็นย่อหน้า */
export function bodyParts(body: string) {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  return { steps: lines.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, "")), text: lines.filter((l) => !/^[-*•]\s+/.test(l)) };
}
