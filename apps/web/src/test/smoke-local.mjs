// ใช้กับ API และเว็บในเครื่องเท่านั้น · สร้างข้อมูลสมมติแยก Workspace ไม่แก้ข้อมูลเดิม
import assert from "node:assert/strict";

const origin = "http://127.0.0.1:3000";
const cookies = new Map();
async function call(path, body, method = body === undefined ? "GET" : "POST") {
  const headers = {
    cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["x-csrf-token"] = cookies.get("fm_csrf");
  }
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [key, ...value] = cookie.split(";")[0].split("=");
    cookies.set(key, value.join("="));
  }
  assert(
    response.ok,
    `${path}: ${response.status} ${response.ok ? "" : await response.text()}`,
  );
  return response.status === 204 ? undefined : response.json();
}

await call("/auth/csrf");
const tag = Date.now().toString(36);
const email = `web-${tag}@example.com`;
const password = "WebTest2026";
const slug = `web-${tag}`;
await call("/auth/signup", {
  email,
  password,
  displayName: "ผู้ทดสอบเว็บ",
  acceptTerms: true,
});
await call("/workspaces", { name: "ทีมทดสอบเว็บ", slug });
await call(`/w/${slug}/projects`, {
  name: "แผนพัฒนาตัวอย่าง",
  key: "DE",
  startDate: "2026-11-05",
  goliveDate: "2027-04-21",
});
await call("/auth/logout", {});
await call("/auth/login", { email, password, remember: false });
assert.equal((await call("/me")).displayName, "ผู้ทดสอบเว็บ");
assert.equal((await call("/me/workspaces")).items[0].slug, slug);
assert.equal((await call(`/w/${slug}/projects`)).items[0].key, "DE");
assert(
  (await call(`/w/${slug}/projects/DE/my-permissions`)).permissions.includes(
    "project.settings",
  ),
);
const publicRoutes = [
  "/",
  "/pricing",
  "/legal/terms",
  "/login",
  "/signup",
  "/forgot-password",
  "/join/sample",
  "/onboarding",
  "/dev/ui",
];
const workspaceRoutes = [
  "",
  "/my-tasks",
  "/inbox",
  "/search",
  "/profile",
  "/members",
  "/admin",
  "/admin/security",
  "/new-project",
  "/import",
  "/billing",
  "/billing/profile",
];
const projectRoutes = [
  "",
  "/table",
  "/board",
  "/timeline",
  "/gantt",
  "/calendar",
  "/members",
  "/files",
  "/backlog",
  "/dashboard",
  "/reports",
  "/settings",
  "/settings/workflow",
  "/plan-changes",
  "/automation",
];
const paths = [
  ...publicRoutes,
  ...workspaceRoutes.map((path) => `/work/${slug}${path}`),
  ...projectRoutes.map((path) => `/work/${slug}/p/DE${path}`),
];
for (const path of paths) {
  const response = await fetch(`${origin}${path}`, {
    headers: {
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    },
    redirect: "manual",
  });
  assert.equal(response.status, 200, path);
}
const anonymous = await fetch(`${origin}/w/${slug}/p/DE?issue=DE-1`, {
  redirect: "manual",
});
assert.equal(anonymous.status, 307);
assert(anonymous.headers.get("location")?.includes("/login?returnTo="));
console.log(
  JSON.stringify(
    {
      routesPassed: paths.length,
      realApiLogin: true,
      anonymousRedirect: true,
      email,
      password,
      workspace: slug,
      projectUrl: `${origin}/w/${slug}/p/DE`,
    },
    null,
    2,
  ),
);
