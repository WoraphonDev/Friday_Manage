"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";

/** ฟีเจอร์ที่นับการใช้ (05-business-metrics › 1.2) · `api` นับที่ API จากคำขอด้วย token */
export type Feature = "table" | "kanban" | "gantt" | "timeline" | "calendar" | "workload" | "due_request" | "import" | "automation" | "saved_view" | "git" | "line" | "report";

/** เหตุการณ์การใช้งาน (POST /w/:ws/events) · ส่งแล้วไม่รอและไม่แจ้ง error เพราะไม่ใช่งานของผู้ใช้ */
export type ProductEvent =
  | { name: "feature.used"; props: { feature: Feature } }
  | { name: "pricing.viewed"; props: { placement: "billing_plans" | "billing_dialog" } }
  | { name: "upgrade.prompt_clicked"; props: { placement: string; planFrom?: string; planTo?: string } };

export function trackEvents(ws: string, events: ProductEvent[]) {
  void api.post(`/w/${encodeURIComponent(ws)}/events`, { events }).catch(() => undefined);
}

/** วันที่เวลาไทย (API นับครั้งแรกของวันตามเวลาไทย) */
const bangkokDay = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const sent = new Set<string>();

/**
 * ใช้ฟีเจอร์แล้ว · API นับครั้งแรกของวันต่อคนต่อฟีเจอร์อยู่แล้ว ฝั่งเว็บกันซ้ำในแท็บนี้อีกชั้นเพื่อไม่ยิงคำขอทุกครั้งที่เปลี่ยนหน้า
 * ไม่ส่งเนื้อหาของลูกค้า มีแค่ชื่อฟีเจอร์
 */
export function trackFeature(ws: string, feature: Feature) {
  const key = `${bangkokDay()}|${ws}|${feature}`;
  if (sent.has(key)) return;
  sent.add(key);
  trackEvents(ws, [{ name: "feature.used", props: { feature } }]);
}

/** ใช้ใน test: ล้างตัวกันซ้ำให้แต่ละ test ไม่ขึ้นกับลำดับ */
export function resetFeatureTracking() {
  sent.clear();
}

/** เปิดหน้าของฟีเจอร์ = ใช้ฟีเจอร์ · enabled = false ตอนยังไม่รู้ Workspace หรือไม่มีสิทธิ์ดู */
export function useFeatureUsed(ws: string | undefined, feature: Feature, enabled = true) {
  useEffect(() => {
    if (ws && enabled) trackFeature(ws, feature);
  }, [ws, feature, enabled]);
}
