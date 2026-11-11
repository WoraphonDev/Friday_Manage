import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { readableColor, tint } from "@/lib/colors";

/**
 * หมวดของสถานะ (เพิ่ม review / blocked / cancelled เมื่อ 2026-11-11 ตามที่ผู้ใช้ขอ)
 * งานค้าง = ทุกหมวดยกเว้น done / cancelled · cancelled = ปิดงานแต่ไม่นับว่าเสร็จ
 */
export const STATUS_CATEGORIES = ["todo", "in_progress", "review", "blocked", "done", "cancelled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export const OPEN_CATEGORIES: StatusCategory[] = ["todo", "in_progress", "review", "blocked"];

export const isClosedCategory = (c: string | null | undefined) => c === "done" || c === "cancelled";

/** โทนสีของป้ายตามหมวด · สถานะชื่อ Review ที่ยังอยู่หมวด In progress (โปรเจกต์เก่า) ใช้สีม่วงเหมือนเดิม */
export type StatusTone = "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
export function statusTone(category: string | null | undefined, name?: string | null): StatusTone {
  if (category === "done" || category === "cancelled" || category === "review" || category === "blocked") return category;
  if (name && /review/i.test(name)) return "review";
  return category === "in_progress" ? "in_progress" : "todo";
}

const TONE_DOT: Record<StatusTone, string> = {
  todo: "var(--status-todo-dot)",
  in_progress: "var(--status-progress-dot)",
  review: "var(--status-review-dot)",
  blocked: "var(--status-blocked-dot)",
  done: "var(--status-done-dot)",
  cancelled: "var(--status-cancelled-dot)",
};
/** สีจุด / แถบของสถานะ: สีที่ผู้ใช้เลือก ถ้าไม่มีใช้ token ตามหมวด */
export const statusDotColor = (category: string | null | undefined, name?: string | null, color?: string | null) => color ?? TONE_DOT[statusTone(category, name)];

/** สีของสถานะที่ผู้ใช้เลือกเอง → style ของป้าย (พื้นจาง + ตัวอักษรอ่านได้ทั้งสองโหมด) · ไม่มีสี = ใช้ class ตามหมวด */
export function statusColorStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return { background: tint(color, 28), color: readableColor(color) };
}

/** จุด / แถบสีของสถานะ · ไม่มีสีที่เลือก = undefined (ใช้ token ตามหมวด) */
export const statusDotStyle = (color: string | null | undefined): CSSProperties | undefined => (color ? { background: color } : undefined);

/**
 * สีที่ผู้ใช้เลือกของแต่ละสถานะ · อ่านจากข้อมูลโปรเจกต์ที่ ProjectShell โหลดไว้ (ฟังการเปลี่ยนแปลงแต่ไม่ดึงเอง:
 * ข้อมูลชุดนี้ใช้ตัดสินสิทธิ์ใน Drawer ด้วย การดึงเองจาก Drawer ที่เปิดข้าม Workspace จะทำให้ข้อมูลปนกัน) · ไม่มีข้อมูล = สีตามหมวด
 */
export function useStatusColors(ws: string, projectKey: string): Map<string, string> {
  const project = useQuery({
    queryKey: queryKeys.project(ws, projectKey),
    queryFn: () => api.get<{ statuses?: { id: string; color?: string | null }[] }>(`/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`),
    enabled: false,
  });
  return new Map((project.data?.statuses ?? []).flatMap((s) => (s.color ? [[s.id, s.color] as const] : [])));
}

/** สีพื้นฐานให้เลือกในหน้าตั้งค่าสถานะ (hex เพราะเก็บในฐานข้อมูล · แสดงผลผ่าน tint / readableColor) */
export const STATUS_SWATCHES = ["#868c94", "#3b82f6", "#e8a917", "#9466e0", "#e8762a", "#e8496b", "#2fb27a", "#0f9aa8", "#5b3fc4", "#a9aeb5"] as const;
