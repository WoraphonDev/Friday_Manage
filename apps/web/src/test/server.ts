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
