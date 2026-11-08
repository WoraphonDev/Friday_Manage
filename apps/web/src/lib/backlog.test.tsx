// W12 · Backlog + Sprint planning · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import backlog from "../../messages/th/backlog.json";
import { BacklogView } from "../../app/w/[ws]/p/[key]/backlog/_components/backlog-view";
import type { BacklogData, BacklogIssue, MoveBody, Sprint } from "../../app/w/[ws]/p/[key]/backlog/_components/types";

const devA = { id: "dev-a", displayName: "ผู้พัฒนาตัวอย่างหนึ่ง", initials: "ผน" };
const devB = { id: "dev-b", displayName: "ผู้พัฒนาตัวอย่างสอง", initials: "ผส" };
const stats = (over: Partial<Sprint["stats"]> = {}) => ({ totalMd: 0, remainingMd: 0, doneMd: 0, issueCount: 0, doneCount: 0, unestimatedCount: 0, ...over });
function issue(key: string, sprintId: string | null, over: Partial<BacklogIssue> = {}): BacklogIssue {
  return { id: `id-${key}`, key, title: `งานตัวอย่าง ${key}`, type: "Task", parentId: null, rank: key, sprintId, moduleId: "mod-a", size: "M", estimateMd: 3, priority: "medium", planStart: null, planEnd: null, progressPct: 0, status: { id: "todo", name: "To do", category: "todo" }, assigneeIds: ["dev-a"], version: 2, subtasks: [], ...over };
}
function sprint(id: string, number: number, status: Sprint["status"], issues: BacklogIssue[], over: Partial<Sprint> = {}): Sprint {
  return {
    id, number, name: `Sprint ${number}`, goal: null, startDate: "2026-11-02", endDate: "2026-11-13", status, issues,
    stats: stats({ totalMd: issues.reduce((sum, item) => sum + (item.estimateMd ?? 0), 0), issueCount: issues.length }),
    capacity: { capacityMd: 20, committedMd: issues.reduce((sum, item) => sum + (item.estimateMd ?? 0), 0), unassignedMd: 0, unavailableAssigneeMd: 0, overloaded: false, workingDays: 10, people: [{ person: devA, capacityHoursWeek: 40, capacityMd: 10, committedMd: 6, leaveDays: 0, overloaded: false }, { person: devB, capacityHoursWeek: 40, capacityMd: 10, committedMd: 0, leaveDays: 1, overloaded: false }] },
    burndown: null, ...over,
  };
}
function initial(): BacklogData {
  const activeIssues = [issue("DE-1", "sp-1", { status: { id: "done", name: "Done", category: "done" }, estimateMd: 2 }), issue("DE-2", "sp-1", { type: "Bug" }), issue("DE-3", "sp-1", { subtasks: [issue("DE-4", "sp-1", { parentId: "id-DE-3" })] })];
  return {
    projectKey: "DE", asOf: "2026-11-05", permissions: { canManageSprints: true, canMoveIssues: true },
    sprints: [
      sprint("sp-1", 1, "active", activeIssues, {
        goal: "ปิดงานตัวอย่างชุดแรก",
        stats: stats({ totalMd: 11, remainingMd: 9, doneMd: 2, issueCount: 4, doneCount: 1 }),
        burndown: { sprintId: "sp-1", asOf: "2026-11-05", baselineMd: 10, ideal: [
          { date: "2026-11-01", remainingMd: 10 }, { date: "2026-11-02", remainingMd: 9 }, { date: "2026-11-03", remainingMd: 8 }, { date: "2026-11-04", remainingMd: 7 }, { date: "2026-11-05", remainingMd: 6 }, { date: "2026-11-06", remainingMd: 5 },
          { date: "2026-11-07", remainingMd: 5 }, { date: "2026-11-08", remainingMd: 5 }, { date: "2026-11-09", remainingMd: 4 }, { date: "2026-11-10", remainingMd: 3 }, { date: "2026-11-11", remainingMd: 2 }, { date: "2026-11-12", remainingMd: 1 }, { date: "2026-11-13", remainingMd: 0 }],
          actual: [{ date: "2026-11-02", remainingMd: 10, doneMd: 0, issueCount: 4, doneCount: 0 }, { date: "2026-11-05", remainingMd: 9, doneMd: 2, issueCount: 4, doneCount: 1 }] },
      }),
      sprint("sp-2", 2, "planning", [issue("DE-5", "sp-2"), issue("DE-6", "sp-2", { estimateMd: null, assigneeIds: ["dev-b"] })], { startDate: "2026-11-16", endDate: "2026-11-27", stats: stats({ totalMd: 3, issueCount: 2, unestimatedCount: 1 }) }),
    ],
    backlog: { issues: [issue("DE-7", null), issue("DE-8", null, { type: "Bug", moduleId: "mod-b" }), issue("DE-9", null, { estimateMd: null })], stats: stats({ totalMd: 6, issueCount: 3, unestimatedCount: 1 }) },
  };
}

let data: BacklogData;
let moves: { key: string; body: MoveBody; etag: string | null; csrf: string | null }[];
let posts: { path: string; body: unknown }[];
const perms = { ...permissions, permissions: [...permissions.permissions, "sprint.manage"] };
const errorBody = (status: number, code: string) => HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", details: {}, requestId: "req_w12_001" } }, { status });
function findList(key: string) {
  if (data.backlog.issues.some((item) => item.key === key)) return data.backlog.issues;
  return data.sprints.find((item) => item.issues.some((row) => row.key === key))!.issues;
}

beforeEach(() => {
  navigation.pathname = "/w/sample/p/DE/backlog";
  data = initial(); moves = []; posts = [];
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json(perms)),
    http.get("*/api/v1/w/:ws/projects/:key/backlog", () => HttpResponse.json(data)),
    http.get("*/api/v1/w/:ws/projects/:key/modules", () => HttpResponse.json({ items: [{ id: "mod-a", name: "ระบบตัวอย่าง A", color: "#1D4ED8" }, { id: "mod-b", name: "ระบบตัวอย่าง B", color: "#0F766E" }] })),
    http.get("*/api/v1/w/:ws/projects/:key/members", () => HttpResponse.json({ items: [{ userId: "dev-a", displayName: devA.displayName, initials: devA.initials, avatarUrl: null }] })),
    http.post("*/api/v1/w/:ws/issues/:key/move", async ({ request, params }) => {
      const body = await request.json() as MoveBody;
      const key = String(params.key);
      moves.push({ key, body, etag: request.headers.get("if-match"), csrf: request.headers.get("x-csrf-token") });
      const source = findList(key);
      const item = source.splice(source.findIndex((row) => row.key === key), 1)[0];
      item.sprintId = body.sprintId; item.version++;
      const target = body.sprintId === null ? data.backlog.issues : data.sprints.find((row) => row.id === body.sprintId)!.issues;
      const index = body.beforeKey ? target.findIndex((row) => row.key === body.beforeKey) : target.length;
      target.splice(index, 0, item);
      return HttpResponse.json({ key, version: item.version, warnings: [] });
    }),
    http.post("*/api/v1/w/:ws/projects/:key/sprints", async ({ request }) => { posts.push({ path: "create", body: await request.json() }); return HttpResponse.json({ id: "sp-3" }, { status: 201 }); }),
    http.post("*/api/v1/w/:ws/projects/:key/sprints/:id/start", ({ params }) => { posts.push({ path: `start:${params.id}`, body: null }); return HttpResponse.json({ id: params.id, status: "active" }); }),
    http.post("*/api/v1/w/:ws/projects/:key/sprints/:id/complete", async ({ request, params }) => {
      posts.push({ path: `complete:${params.id}`, body: await request.json() });
      return HttpResponse.json({ id: params.id, name: "Sprint 1", status: "completed", moved: { tasks: 2, subtasks: 1, destination: null } });
    }),
    http.patch("*/api/v1/w/:ws/projects/:key/sprints/:id", async ({ request, params }) => { posts.push({ path: `patch:${params.id}`, body: await request.json() }); return HttpResponse.json({ id: params.id }); }),
  );
});
const mount = () => renderWithProviders(<WorkspaceShell ws="sample"><BacklogView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { backlog } });
const row = (key: string) => screen.getByRole("listitem", { name: `งาน ${key}` });
const list = (name: string) => screen.getByRole("list", { name: `รายการงานใน ${name}` });
const keysIn = (name: string) => within(list(name)).queryAllByRole("listitem").map((item) => item.getAttribute("data-key"));

describe("Backlog + Sprint planning (W12)", () => {
  it("แสดง Sprint ที่กำลังทำพร้อม Burndown, Sprint วางแผนพร้อม capacity และ Backlog", async () => {
    mount();
    expect(await screen.findByRole("region", { name: "Sprint 1 (Active)" })).toBeInTheDocument();
    const active = screen.getByRole("region", { name: "Sprint 1 (Active)" });
    expect(within(active).getByText("ปิดงานตัวอย่างชุดแรก")).toBeInTheDocument();
    expect(within(active).getByText(/เหลือ 7 วันทำการ/)).toBeInTheDocument();
    expect(within(active).getByText("1 / 4")).toBeInTheDocument();
    expect(within(active).getByText("2 / 11")).toBeInTheDocument();
    expect(within(active).getByRole("img", { name: "Burndown: เหลือ 9 MD จาก 10 MD" })).toBeInTheDocument();
    expect(within(active).getByTestId("burndown-actual")).toHaveAttribute("points");
    expect(within(active).getByRole("link", { name: "เปิดบอร์ด" })).toHaveAttribute("href", "/w/sample/p/DE/board");

    const planning = screen.getByRole("region", { name: "Sprint 2 (Planning)" });
    expect(within(planning).getByRole("meter", { name: "Commit vs capacity" })).toHaveAttribute("aria-valuenow", "3");
    expect(within(planning).getAllByText("3 / 20 MD").length).toBeGreaterThan(0);
    expect(within(planning).getByText(/1 งานยังไม่ประเมิน Man-Day/)).toBeInTheDocument();
    expect(within(planning).getByRole("list", { name: "Capacity รายคน" })).toHaveTextContent("ลา 1 วัน");
    expect(within(row("DE-6")).getByTitle("ยังไม่ประเมิน Man-Day")).toHaveTextContent("?");
    expect(within(row("DE-6")).getByRole("img", { name: devB.displayName })).toBeInTheDocument();

    expect(screen.getByText("3 งาน · 6 MD · 1 งานยังไม่ประเมิน")).toBeInTheDocument();
    expect(within(row("DE-7")).getByRole("link", { name: "งานตัวอย่าง DE-7" })).toHaveAttribute("href", "/w/sample/p/DE/backlog?issue=DE-7");
    expect(await within(row("DE-8")).findByText("ระบบตัวอย่าง B")).toBeInTheDocument();
  });

  it("ปุ่มย้ายจาก Backlog ไป Sprint ส่ง sprintId + ลำดับ, CSRF และ If-Match แล้วเลิกทำได้", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await within(await screen.findByRole("listitem", { name: "งาน DE-7" })).findByRole("button", { name: "↑ Sprint 2" }));
    await screen.findByText("ย้าย DE-7 ไป Sprint 2 แล้ว");
    expect(moves[0]).toMatchObject({ key: "DE-7", body: { sprintId: "sp-2", afterKey: "DE-6" }, etag: '"2"', csrf: "test-csrf" });
    await waitFor(() => expect(keysIn("Sprint 2")).toEqual(["DE-5", "DE-6", "DE-7"]));
    await user.click(screen.getByRole("button", { name: "เลิกทำ" }));
    await screen.findByText("เลิกทำการย้าย DE-7 แล้ว");
    expect(moves[1]).toMatchObject({ body: { sprintId: null, beforeKey: "DE-8" }, etag: '"3"' });
    await waitFor(() => expect(keysIn("Backlog")).toEqual(["DE-7", "DE-8", "DE-9"]));
  });

  it("ลากงานระหว่าง Sprint กับ Backlog และลากเรียงลำดับใน Backlog", async () => {
    mount(); await screen.findByRole("listitem", { name: "งาน DE-9" });
    const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(row("DE-9"), { dataTransfer: transfer });
    fireEvent.dragOver(row("DE-7"), { dataTransfer: transfer });
    fireEvent.drop(row("DE-7"), { dataTransfer: transfer });
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0].body).toEqual({ sprintId: null, beforeKey: "DE-7" });
    await screen.findByText("เรียงลำดับ DE-9 แล้ว");
    await waitFor(() => expect(keysIn("Backlog")).toEqual(["DE-9", "DE-7", "DE-8"]));

    fireEvent.dragStart(row("DE-5"), { dataTransfer: transfer });
    fireEvent.dragOver(list("Backlog"), { dataTransfer: transfer });
    fireEvent.drop(list("Backlog"), { dataTransfer: transfer });
    await waitFor(() => expect(moves).toHaveLength(2));
    expect(moves[1].body).toEqual({ sprintId: null, afterKey: "DE-8" });
    await screen.findByText("ย้าย DE-5 ไป Backlog แล้ว");
  });

  it("ใช้คีย์บอร์ดผ่าน Dialog ตัวเลือก: เลื่อนขึ้นลงและย้ายไป Sprint ที่ต้องการ", async () => {
    const user = userEvent.setup(); mount();
    const options = await screen.findByRole("button", { name: "ตัวเลือกการย้าย DE-8" });
    options.focus(); await user.keyboard("{Enter}");
    let dialog = await screen.findByRole("dialog", { name: "ย้ายงาน DE-8" });
    expect(within(dialog).getByRole("button", { name: /Backlog/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "↑ เลื่อนขึ้น" }));
    await screen.findByText("เรียงลำดับ DE-8 แล้ว");
    expect(moves[0].body).toEqual({ sprintId: null, beforeKey: "DE-7" });
    await waitFor(() => expect(screen.getByRole("button", { name: "ตัวเลือกการย้าย DE-7" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "ตัวเลือกการย้าย DE-7" }));
    dialog = await screen.findByRole("dialog", { name: "ย้ายงาน DE-7" });
    await user.click(within(dialog).getByRole("button", { name: "Sprint 1" }));
    await waitFor(() => expect(moves).toHaveLength(2));
    expect(moves[1].body).toMatchObject({ sprintId: "sp-1" });
  });

  it("409 จาก If-Match แสดงข้อความชนกันพร้อม requestId (toast ที่ปิดได้ / หายเอง) และโหลดค่าล่าสุดเอง", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/api/v1/w/:ws/issues/:key/move", () => errorBody(409, "version_conflict")));
    mount();
    await user.click(await within(await screen.findByRole("listitem", { name: "งาน DE-5" })).findByRole("button", { name: "↓ Backlog" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("งานนี้ถูกแก้ไขโดยคนอื่นแล้ว");
    expect(alert).toHaveTextContent("รหัสคำขอ req_w12_001");
    await user.click(within(alert).getByRole("button", { name: "ปิด" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("Complete sprint เลือกปลายทางของงานค้างและบันทึก Retrospective", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "Complete sprint" }));
    const dialog = await screen.findByRole("dialog", { name: "ปิด Sprint 1" });
    expect(within(dialog).getByText("1 งาน · 2 MD")).toBeInTheDocument();
    expect(within(dialog).getByText("3 งาน · 9 MD")).toBeInTheDocument();
    expect(within(dialog).getByText("งานที่ไม่เสร็จ 2 งาน ย้ายไปที่")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Sprint 2 (แนะนำ)" })).toBeChecked();
    expect(within(dialog).getByText("DE-2 · DE-3")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "กลับไป Backlog" }));
    await user.type(within(dialog).getByRole("textbox"), "ทดสอบบันทึกหลัง Sprint");
    await user.click(within(dialog).getByRole("button", { name: "ปิด Sprint และย้ายงาน" }));
    await screen.findByText("ปิด Sprint 1 แล้ว · ย้ายงานค้าง 2 งาน (Sub-task 1) ไป Backlog");
    expect(posts).toContainEqual({ path: "complete:sp-1", body: { moveIncompleteTo: "backlog", retrospective: "ทดสอบบันทึกหลัง Sprint" } });
  });

  it("Start sprint ปิดไว้เมื่อมี Sprint ที่กำลังทำ และเริ่มได้เมื่อไม่มี พร้อมเตือนเกิน capacity", async () => {
    const user = userEvent.setup();
    data.sprints = [data.sprints[1]];
    data.sprints[0].capacity = { ...data.sprints[0].capacity, capacityMd: 2, overloaded: true };
    mount();
    const planning = await screen.findByRole("region", { name: "Sprint 2 (Planning)" });
    expect(within(planning).getByText(/^เกิน capacity 1 MD · ควรย้ายงานบางส่วนกลับ Backlog/)).toBeInTheDocument();
    await user.click(within(planning).getByRole("button", { name: "Start sprint" }));
    const dialog = await screen.findByRole("dialog", { name: "เริ่ม Sprint 2" });
    expect(within(dialog).getByText(/งานเกิน capacity 1 MD/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Start sprint" }));
    await screen.findByText("เริ่ม Sprint 2 แล้ว");
    expect(posts).toContainEqual({ path: "start:sp-2", body: null });
  });

  it("Start sprint ถูกปิดเมื่อมี Sprint active และแก้ Sprint goal ได้ (PATCH เมื่อออกจากช่อง)", async () => {
    const user = userEvent.setup(); mount();
    const planning = await screen.findByRole("region", { name: "Sprint 2 (Planning)" });
    expect(within(planning).getByRole("button", { name: "Start sprint" })).toBeDisabled();
    const goal = within(planning).getByRole("textbox", { name: "Sprint goal" });
    await user.type(goal, "เป้าหมายตัวอย่าง");
    await user.tab();
    await waitFor(() => expect(posts).toContainEqual({ path: "patch:sp-2", body: { goal: "เป้าหมายตัวอย่าง" } }));
  });

  it("สร้าง Sprint ใหม่ต่อจาก Sprint ล่าสุด", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "+ สร้าง Sprint" }));
    const dialog = await screen.findByRole("dialog", { name: "สร้าง Sprint ใหม่" });
    expect(within(dialog).getByLabelText("ชื่อ Sprint")).toHaveValue("Sprint 3");
    expect(within(dialog).getByLabelText("วันเริ่ม")).toHaveValue("2026-11-28");
    expect(within(dialog).getByLabelText("วันจบ")).toHaveValue("2026-12-11");
    await user.click(within(dialog).getByRole("button", { name: "สร้าง Sprint" }));
    await screen.findByText("สร้าง Sprint 3 แล้ว");
    expect(posts).toContainEqual({ path: "create", body: { name: "Sprint 3", startDate: "2026-11-28", endDate: "2026-12-11", goal: null } });
  });

  it("ตัวกรองประเภทงานและ Module", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("listitem", { name: "งาน DE-7" });
    await user.click(within(screen.getByRole("group", { name: "ประเภทงาน" })).getByRole("button", { name: "Bug" }));
    expect(keysIn("Backlog")).toEqual(["DE-8"]);
    expect(within(list("Sprint 2")).getByText("ไม่พบงานตามตัวกรองนี้")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ล้างตัวกรอง" }));
    await screen.findByRole("option", { name: "ระบบตัวอย่าง A" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Module" }), "mod-b");
    expect(keysIn("Backlog")).toEqual(["DE-8"]);
  });

  it("Viewer ไม่เห็นปุ่มย้าย / จัดการ Sprint และลากไม่ได้", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ role: "viewer", guestViewer: false, permissions: ["project.view"] })));
    mount();
    await screen.findByRole("listitem", { name: "งาน DE-7" });
    expect(row("DE-7")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: /ตัวเลือกการย้าย/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete sprint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ สร้าง Sprint" })).not.toBeInTheDocument();
    expect(screen.getByText("ยังไม่ได้ตั้งเป้าหมาย", { selector: "p" })).toBeInTheDocument();
  });

  it("สถานะ: กำลังโหลด, ว่าง, Error พร้อม requestId และ 403", async () => {
    data = { ...initial(), sprints: [], backlog: { issues: [], stats: stats() } };
    const first = mount();
    expect(screen.getAllByLabelText("กำลังโหลด…").length).toBeGreaterThan(0);
    expect(await screen.findByText("ยังไม่มี Sprint และงานใน Backlog")).toBeInTheDocument();
    first.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/backlog", () => errorBody(500, "internal_error")));
    const second = mount();
    expect(await screen.findByText("รหัสอ้างอิง: req_w12_001")).toBeInTheDocument();
    second.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/backlog", () => errorBody(403, "forbidden")));
    mount();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
  });

  it("Guest Viewer เห็นหน้าไม่มีสิทธิ์โดยไม่เรียก backlog", async () => {
    let called = false;
    server.use(
      http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ role: "viewer", guestViewer: true, permissions: ["project.view"] })),
      http.get("*/api/v1/w/:ws/projects/:key/backlog", () => { called = true; return HttpResponse.json(data); }),
    );
    mount();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(called).toBe(false);
  });
});
