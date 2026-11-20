import { api } from "@/lib/api";

/** เหตุการณ์การใช้งาน (POST /w/:ws/events) · ส่งแล้วไม่รอและไม่แจ้ง error เพราะไม่ใช่งานของผู้ใช้ */
export type ProductEvent =
  | { name: "pricing.viewed"; props: { placement: "billing_plans" | "billing_dialog" } }
  | { name: "upgrade.prompt_clicked"; props: { placement: string; planFrom?: string; planTo?: string } };

export function trackEvents(ws: string, events: ProductEvent[]) {
  void api.post(`/w/${encodeURIComponent(ws)}/events`, { events }).catch(() => undefined);
}
