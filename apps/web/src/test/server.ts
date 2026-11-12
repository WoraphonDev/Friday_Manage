import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { me, permissions, projects, summary, workspaces } from "./fixtures";

export const handlers = [
  http.get("*/api/v1/auth/csrf", () =>
    HttpResponse.json({ csrfToken: "test-csrf" }),
  ),
  http.get("*/api/v1/me", () => HttpResponse.json(me)),
  http.get("*/api/v1/me/workspaces", () =>
    HttpResponse.json({ items: workspaces }),
  ),
  http.get("*/api/v1/me/notifications/summary", () =>
    HttpResponse.json(summary),
  ),
  // ข้อมูล Workspace (shell อ่านสถานะระงับ C6)
  http.get("*/api/v1/w/:ws", () => HttpResponse.json({ suspension: null })),
  // แบนเนอร์ประกาศจากทีม Friday (O24) · Owner / Admin เรียกจาก shell
  http.get("*/api/v1/w/:ws/announcements", () =>
    HttpResponse.json({ items: [] }),
  ),
  // มีอะไรใหม่ / Spotlight / NPS (W24) · shell เรียกทุกหน้า · ค่าเริ่มต้น = ไม่มีอะไรแสดง
  http.get("*/api/v1/me/whats-new", () =>
    HttpResponse.json({ items: [], unseen: 0, seenAt: null, hidden: false }),
  ),
  http.get("*/api/v1/me/spotlight", () => HttpResponse.json({ item: null })),
  http.get("*/api/v1/me/nps-prompt", () =>
    HttpResponse.json({ ask: false, reason: "not_sampled" }),
  ),
  // Onboarding checklist (W25) · ปุ่มท้าย Sidebar เรียกจาก shell · ค่าเริ่มต้น = ไม่แสดง (Workspace เก่า)
  http.get("*/api/v1/w/:ws/onboarding", () =>
    HttpResponse.json({ scope: "workspace", version: 1, eligible: false }),
  ),
  http.get("*/api/v1/w/:ws/projects", () =>
    HttpResponse.json({ items: projects }),
  ),
  http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () =>
    HttpResponse.json(permissions),
  ),
  http.get("*/api/v1/w/:ws/projects/:key", () =>
    HttpResponse.json(projects[0], { headers: { ETag: '"1"' } }),
  ),
];
export const server = setupServer(...handlers);
