import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { metrics, overview, staff } from "./fixtures";

export const OPS = "*/ops-api";

/** พนักงานที่ล็อกอินอยู่ (ops/auth/me) · test เปลี่ยนบทบาทด้วย `asRole()` */
export function asRole(role: keyof typeof staff) {
  server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff[role] })));
}
/** error รูปแบบเดียวกับ ops-api (ErrorFilter) */
export const opsError = (status: number, code: string, message: string, details?: unknown, requestId?: string) =>
  HttpResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status, headers: requestId ? { "x-request-id": requestId } : undefined });

export const handlers = [
  http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff.admin })),
  http.get(`${OPS}/metrics`, () => HttpResponse.json(metrics)),
  http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: [] })),
  http.get(`${OPS}/overview`, () => HttpResponse.json(overview)),
  http.get(`${OPS}/approvals`, () => HttpResponse.json({ items: [], singleApprover: true })),
  // การ์ด Onboarding ในรายละเอียดลูกค้า (O34 · V7) · ค่าเริ่มต้น = ครบแล้ว (ไม่แสดงการ์ด)
  http.get(`${OPS}/onboarding/workspaces/:id`, () => HttpResponse.json({ complete: true, steps: [], done: 6, total: 6 })),
];
export const server = setupServer(...handlers);
