import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Staff } from "@/lib/types";
import { metrics, staff } from "./fixtures";

export const OPS = "*/ops-api";

/** พนักงานที่ล็อกอินอยู่ (ops/auth/me) · test เปลี่ยนบทบาทด้วย `asRole()` */
export function asRole(role: Staff["role"]) {
  server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff[role] })));
}
/** error รูปแบบเดียวกับ ops-api (ErrorFilter) */
export const opsError = (status: number, code: string, message: string, details?: unknown, requestId?: string) =>
  HttpResponse.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, { status, headers: requestId ? { "x-request-id": requestId } : undefined });

export const handlers = [
  http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff.admin })),
  http.get(`${OPS}/metrics`, () => HttpResponse.json(metrics)),
  http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: [] })),
];
export const server = setupServer(...handlers);
