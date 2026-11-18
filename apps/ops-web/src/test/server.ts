import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { metrics, overview, staff } from "./fixtures";

export const OPS = "*/ops-api";

/** วิธีเข้าระบบเริ่มต้นของ test: มีแต่ Passkey (หน้าต่างยืนยันซ้ำแสดงปุ่มแตะ Passkey) · test ของรหัส 6 หลักเปลี่ยนเอง */
export const keyOnly = { totp: false, totpEnabledAt: null, keys: [{ id: "cred-1", name: "Passkey", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null }] };

/** พนักงานที่ล็อกอินอยู่ (ops/auth/me) · test เปลี่ยนบทบาทด้วย `asRole()` */
export function asRole(role: keyof typeof staff) {
  server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff[role], methods: keyOnly })));
}
/** error รูปแบบเดียวกับ ops-api (ErrorFilter) */
export const opsError = (status: number, code: string, message: string, details?: unknown, requestId?: string) =>
  HttpResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status, headers: requestId ? { "x-request-id": requestId } : undefined });

export const handlers = [
  // ช่วง 2 · กำลังดูโดย: ค่าเริ่มต้นไม่มีเพื่อนอยู่ (test ที่ต้องการใส่ handler ของตัวเอง)
  http.get(`${OPS}/presence`, () => HttpResponse.json({ items: [] })),
  http.post(`${OPS}/presence`, () => HttpResponse.json({ others: [] })),
  http.post(`${OPS}/presence/leave`, () => HttpResponse.json({ ok: true })),
  http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff.admin, methods: keyOnly })),
  http.get(`${OPS}/metrics`, () => HttpResponse.json(metrics)),
  http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: [] })),
  http.get(`${OPS}/overview`, () => HttpResponse.json(overview)),
  http.get(`${OPS}/approvals`, () => HttpResponse.json({ items: [], singleApprover: true })),
  // การ์ด Onboarding ในรายละเอียดลูกค้า (O34 · V7) · ค่าเริ่มต้น = ครบแล้ว (ไม่แสดงการ์ด)
  http.get(`${OPS}/onboarding/workspaces/:id`, () => HttpResponse.json({ complete: true, steps: [], done: 6, total: 6 })),
];
export const server = setupServer(...handlers);
