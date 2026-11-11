// W13 · Project Settings (L2) และสร้างโปรเจกต์ (A) · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { router } from "@/test/router";
import { permissions, workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import json from "../../messages/th/project-settings-new.json";
import { ProjectSettings, generalChanges } from "../../app/work/[ws]/p/[key]/settings/_components/project-settings";
import { bugColumns } from "../../app/work/[ws]/p/[key]/settings/_components/workflow-section";
import type { ProjectDetail, Workflow } from "../../app/work/[ws]/p/[key]/settings/_components/types";
import { NewProjectWizard } from "../../app/work/[ws]/new-project/_components/new-project-wizard";
import { spanDays, sprintCount, suggestKey } from "../../app/work/[ws]/new-project/_components/plan";

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1", key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", clientName: null, description: null, color: "#334155",
  startDate: "2026-11-05", goliveDate: "2027-04-21", timezone: "Asia/Bangkok", visibility: "private", status: "active",
  archivedAt: null, ownerUserId: "sample-lead", sprintLengthWeeks: 2, estimateUnit: "man_day", progressMethod: "weighted",
  sizeMdMap: null, holidayCalendarId: null, workStart: null, workEnd: null, timeLogEnabled: false, version: 3, myRole: "admin", ...over,
});
const st = (id: string, workflowId: string, name: string, category: "todo" | "in_progress" | "done", sort: number, issueCount = 0, boardColumnId: string | null = null) =>
  ({ id, workflowId, name, category, boardColumnId, wipLimit: null, sort, issueCount });
const workflows = (): Workflow[] => [
  {
    id: "wf-std", name: "มาตรฐาน", kind: "standard",
    issueTypes: [{ id: "t-story", name: "Story", enabled: true }, { id: "t-task", name: "Task", enabled: true }],
    statuses: [st("s-todo", "wf-std", "To do", "todo", 0, 4), st("s-prog", "wf-std", "In progress", "in_progress", 1), st("s-rev", "wf-std", "Review", "in_progress", 2), st("s-done", "wf-std", "Done", "done", 3)],
    rules: [{ id: "r1", ruleType: "subtasks_done", config: {}, enabled: true }],
    catalog: [
      { ruleType: "subtasks_done", title: "ย้ายไป Done ไม่ได้ถ้า Sub-task ยังไม่เสร็จครบ", description: "เตือน", configured: true, enabled: true },
      { ruleType: "reviewer_required", title: "ย้ายไป Review ต้องมี Reviewer", description: "ถาม Reviewer", configured: false, enabled: false },
    ],
  },
  {
    id: "wf-bug", name: "Bug", kind: "bug", issueTypes: [{ id: "t-bug", name: "Bug", enabled: true }],
    statuses: [st("b-open", "wf-bug", "Open", "todo", 0, 0, "s-todo"), st("b-fixed", "wf-bug", "Fixed", "in_progress", 1, 0, "s-rev"), st("b-ver", "wf-bug", "Verified", "in_progress", 2, 0, "s-rev"), st("b-closed", "wf-bug", "Closed", "done", 3, 0, "s-done")],
    rules: [], catalog: [{ ruleType: "fix_reference_required", title: "ส่ง Fixed ต้องระบุ Commit หรือ PR ที่แก้", description: "หลักฐาน", configured: false, enabled: false }],
  },
];
const members = [
  { userId: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง", email: "lead@example.com", role: "admin", isOwner: true, isGuest: false, active: true },
  { userId: "u-dev", displayName: "ผู้พัฒนาหนึ่ง", email: "dev1@example.com", role: "member", isOwner: false, isGuest: false, active: true },
  { userId: "u-guest", displayName: "ลูกค้าตัวอย่าง", email: null, role: "viewer", isOwner: false, isGuest: true, active: true },
];

type Call = { method: string; path: string; body: unknown; ifMatch: string | null };
let calls: Call[];
let current: ProjectDetail;
const errorBody = (status: number, code = status === 403 ? "forbidden" : "internal_error") =>
  HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", requestId: "req_w13_001", details: {} } }, { status });
const record = async (request: Request) => {
  const text = await request.text();
  calls.push({ method: request.method, path: new URL(request.url).pathname.replace("/api/v1", ""), body: text ? JSON.parse(text) : undefined, ifMatch: request.headers.get("if-match") });
};
const mutation = (status = 200, body: Record<string, unknown> = { ok: true }) => async ({ request }: { request: Request }) => {
  await record(request);
  return status === 204 ? new HttpResponse(null, { status }) : HttpResponse.json(body, { status });
};
const P = "*/api/v1/w/:ws/projects/:key";

beforeEach(() => {
  calls = [];
  current = project();
  server.use(
    http.get(P, () => HttpResponse.json(current, { headers: { ETag: `"${current.version}"` } })),
    http.patch(P, async ({ request }) => {
      await record(request);
      current = { ...current, ...(calls.at(-1)!.body as object), version: current.version + 1 };
      return HttpResponse.json(current);
    }),
    http.get(`${P}/members`, () => HttpResponse.json({ items: members, canInvite: true, canManage: true })),
    http.get("*/api/v1/w/:ws/holiday-calendars", () => HttpResponse.json({ items: [{ id: "cal-1", name: "ปฏิทินธนาคารตัวอย่าง", isDefault: true }] })),
    http.get(`${P}/workflows`, () => HttpResponse.json({ items: workflows() })),
    http.patch(`${P}/workflows/:id/statuses/:sid`, mutation()),
    http.delete(`${P}/workflows/:id/statuses/:sid`, mutation()),
    http.post(`${P}/workflows/:id/statuses/reorder`, mutation()),
    http.post(`${P}/workflows/:id/statuses`, mutation(201)),
    http.post(`${P}/workflows/:id/rules`, mutation(201)),
    http.patch(`${P}/workflows/:id/rules/:rid`, mutation()),
    http.get(`${P}/issue-types`, () => HttpResponse.json({
      items: [
        { id: "t-story", name: "Story", color: "#15803D", workflow: { id: "wf-std", name: "มาตรฐาน" }, requiredFields: ["title", "size"], enabled: true, issueCount: 2 },
        { id: "t-spike", name: "Spike", color: "#7C3AED", workflow: { id: "wf-std", name: "มาตรฐาน" }, requiredFields: ["title"], enabled: true, issueCount: 0 },
      ],
      requiredFieldOptions: [{ key: "title", label: "ชื่อ" }, { key: "module", label: "Module" }, { key: "size", label: "Size" }],
    })),
    http.patch(`${P}/issue-types/:id`, mutation()),
    http.get(`${P}/custom-fields`, () => HttpResponse.json({ items: [{ id: "f1", name: "Release version", fieldType: "select", options: { choices: [{ id: "c1", label: "1.0" }] } }] })),
    http.post(`${P}/custom-fields`, mutation(201)),
    http.patch(`${P}/custom-fields/:id`, mutation()),
    http.delete(`${P}/custom-fields/:id`, mutation(204)),
    http.get(`${P}/field-profile`, () => HttpResponse.json(fieldProfile)),
    http.put(`${P}/field-profile`, mutation()),
    http.get(`${P}/labels`, () => HttpResponse.json({ items: [{ id: "l1", name: "frontend", color: "#1d4ed8", issueCount: 3 }] })),
    http.post(`${P}/labels`, mutation(201)),
    http.get(`${P}/modules`, () => HttpResponse.json({ items: [
      { id: "m-a", name: "Module A", color: "#1d4ed8", owner: { id: "u-dev", displayName: "ผู้พัฒนาหนึ่ง" }, issueCount: 5, phases: [] },
      { id: "m-b", name: "Module B", color: null, owner: null, issueCount: 0, phases: [] },
    ] })),
    http.post(`${P}/modules`, mutation(201)),
    http.post(`${P}/modules/reorder`, mutation()),
    http.patch(`${P}/modules/:id`, mutation()),
    http.delete(`${P}/modules/:id`, mutation()),
    http.put(`${P}/role-permissions`, mutation()),
    http.get(`${P}/delete-impact`, () => HttpResponse.json({ key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", issues: 74, files: 24, members: 3, trashDays: 30, canDelete: true })),
    http.delete(P, mutation(200, { key: "DE", deletedAt: "2026-11-06T00:00:00Z" })),
    http.post(`${P}/archive`, mutation()),
    http.post(`${P}/transfer`, mutation()),
  );
});

const ALL_OPTIONAL = Object.fromEntries(["ba", "sa", "reviewer", "priority", "size", "actual", "progress", "requirements", "screens", "labels", "remark"].map((f) => [f, { task: "optional", subtask: "optional" }]));
const fieldProfile = {
  fieldProfile: { fields: ALL_OPTIONAL, columns: ["dev", "ba", "sa", "status", "size", "start", "end", "actualStart", "actualEnd", "progress", "remark", "cf:f1"], template: { id: "development", name: "Development", builtin: true } },
  customFields: [{ id: "f1", name: "Release version", fieldType: "select", options: { choices: [{ id: "c1", label: "1.0" }] }, taskMode: "optional", subtaskMode: "optional", sort: 0 }],
};
const mount = (ui: React.ReactElement) => renderWithProviders(<WorkspaceShell ws="sample">{ui}</WorkspaceShell>, { messages: { "project-settings-new": json } });
const settings = (section?: string) => mount(<ProjectSettings ws="sample" projectKey="DE" section={section} />);

describe("Project Settings (L2)", () => {
  it("เมนู 8 หมวด + Import / Export 3 เมนู + Automation · หมวดที่ API ยังไม่มีแสดงว่ายังไม่เปิด · หมวดที่ไม่รู้จัก = ไม่พบหน้า", async () => {
    const a = settings("notify");
    const nav = await screen.findByRole("navigation", { name: "หมวดการตั้งค่า" });
    expect(within(nav).getAllByRole("link")).toHaveLength(12);
    // Import / Export อยู่ใน Settings ด้วย (ผู้ใช้ตัดสิน 2026-11-09)
    expect(within(nav).getByRole("link", { name: "อัปเดตแผนจาก Excel" })).toHaveAttribute("href", "/work/sample/p/DE/settings/import");
    expect(within(nav).getByRole("link", { name: "Export แผน + Timeline" })).toHaveAttribute("href", "/work/sample/p/DE/settings/export");
    expect(within(nav).getByRole("link", { name: "การแก้ไขแผน" })).toHaveAttribute("href", "/work/sample/p/DE/settings/plan-changes");
    expect(within(nav).getByRole("link", { name: "การแจ้งเตือน" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Workflow" })).toHaveAttribute("href", "/work/sample/p/DE/settings/workflow");
    expect(within(nav).getByRole("link", { name: /Automation/ })).toHaveAttribute("href", "/work/sample/p/DE/automation");
    expect(screen.getByText("ยังไม่เปิดใช้งาน")).toBeInTheDocument();
    a.unmount();
    settings("integ");
    expect(await screen.findByText(/การเชื่อม GitHub พร้อมใช้งาน/)).toBeInTheDocument();
  });

  it("ทั่วไป: ส่งเฉพาะฟิลด์ที่เปลี่ยนพร้อม If-Match · Size → MD · Time log · 409 แสดงให้โหลดค่าล่าสุด", async () => {
    const user = userEvent.setup();
    settings();
    const name = await screen.findByLabelText("ชื่อโปรเจกต์");
    expect(screen.getByText(/ตอนนี้ใช้ค่าของ Workspace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await user.clear(name);
    await user.type(name, "แผนพัฒนาใหม่");
    fireEvent.change(screen.getByLabelText("Man-Day ของ XL"), { target: { value: "10" } });
    await user.click(screen.getByRole("switch", { name: "บันทึกเวลาทำงาน (Time log)" }));
    await waitFor(() => expect(screen.getByLabelText("ปฏิทินวันหยุด")).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("ปฏิทินวันหยุด"), "cal-1");
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE", ifMatch: '"3"' }));
    expect(calls[0].body).toEqual({ name: "แผนพัฒนาใหม่", sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 10 }, holidayCalendarId: "cal-1", timeLogEnabled: true });
    expect(await screen.findByText("บันทึกการตั้งค่าแล้ว")).toBeInTheDocument();

    server.use(http.patch(P, () => HttpResponse.json({ error: { code: "conflict", message: "ถูกแก้โดยคนอื่น", details: { latest: project({ name: "ชื่อจากอีกคน", version: 9 }) } } }, { status: 409 })));
    const field = await screen.findByLabelText("ชื่อโปรเจกต์");
    await user.clear(field);
    await user.type(field, "ชื่อของฉัน");
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    await user.click(await screen.findByRole("button", { name: /โหลดค่าล่าสุด/ }));
    expect(await screen.findByDisplayValue("ชื่อจากอีกคน")).toBeInTheDocument();
  });

  it("ทั่วไป: เปลี่ยน Key แล้วไป URL ใหม่ · Go-live ก่อนวันเริ่มไม่ส่ง", async () => {
    const user = userEvent.setup();
    settings("general");
    fireEvent.change(await screen.findByLabelText("Go-live"), { target: { value: "2026-10-01" } });
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    expect(await screen.findByText("วัน Go-live ต้องไม่ก่อนวันเริ่ม")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Go-live"), { target: { value: "2027-04-21" } });
    const key = screen.getByLabelText("Project Key");
    await user.clear(key);
    await user.type(key, "dp");
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/work/sample/p/DP/settings/general"));
    expect(calls[0].body).toEqual({ key: "DP" });
  });

  it("Workflow: แก้ชื่อ / ลำดับ / ลบสถานะที่มีงาน (เลือกปลายทาง) · กฎ · Workflow ของ Bug บอกคอลัมน์บนบอร์ด", async () => {
    const user = userEvent.setup();
    settings("workflow");
    const name = await screen.findByLabelText("ชื่อสถานะ Review");
    await user.clear(name);
    await user.type(name, "Code review");
    fireEvent.blur(name);
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/workflows/wf-std/statuses/s-rev", body: { name: "Code review" }, ifMatch: null }));
    // หมวดครบ 6 แบบ (2026-11-11) · เลือกสีเองและกลับไปใช้สีตามหมวด
    const category = screen.getByLabelText("หมวดของสถานะ Review");
    expect(within(category).getAllByRole("option").map((o) => o.textContent)).toEqual(["To do", "In progress", "Review / QA", "Blocked / On hold", "Done", "Cancelled / Rejected"]);
    await user.selectOptions(category, "review");
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/workflows/wf-std/statuses/s-rev", body: { category: "review" } }));
    await user.click(screen.getByRole("button", { name: "สีของสถานะ Review" }));
    await user.click(await screen.findByRole("button", { name: "#e8762a" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/workflows/wf-std/statuses/s-rev", body: { color: "#e8762a" } }));
    await user.click(screen.getByRole("button", { name: "สีของสถานะ Review" }));
    await user.click(await screen.findByRole("button", { name: "ใช้สีตามหมวด" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { color: null } }));
    expect(screen.getByText("ยกเลิก / ไม่ผ่าน · ปิดงาน ไม่เลยกำหนด และไม่นับในความคืบหน้า")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เลื่อน Done ขึ้น" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ path: "/w/sample/projects/DE/workflows/wf-std/statuses/reorder", body: { ids: ["s-todo", "s-prog", "s-done", "s-rev"] } }));
    await user.click(screen.getByRole("button", { name: "ลบสถานะ To do" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/มีงาน 4 งาน/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("ย้ายงานไปที่"), "s-done");
    await user.click(within(dialog).getByRole("button", { name: "ลบสถานะ" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/projects/DE/workflows/wf-std/statuses/s-todo", body: { moveTo: "s-done" } }));
    await user.click(screen.getByRole("checkbox", { name: /ย้ายไป Review ต้องมี Reviewer/ }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/workflows/wf-std/rules", body: { ruleType: "reviewer_required", enabled: true } }));
    await user.click(screen.getByRole("checkbox", { name: /Sub-task ยังไม่เสร็จครบ/ }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/workflows/wf-std/rules/r1", body: { enabled: false } }));
    await user.click(screen.getByRole("button", { name: "Bug" }));
    expect(screen.getByText("Open → To do · Fixed, Verified → Review · Closed → Done")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ เพิ่มสถานะ" }));
    const add = await screen.findByRole("dialog", { name: "เพิ่มสถานะ" });
    await user.type(within(add).getByLabelText("ชื่อสถานะ"), "Reopened");
    await user.click(within(add).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/workflows/wf-bug/statuses", body: { name: "Reopened", category: "in_progress" } }));
  });

  it("ประเภทงาน + ฟิลด์: เปิดปิด, ฟิลด์บังคับ, Custom field แบบตัวเลือก, Label", async () => {
    const user = userEvent.setup();
    settings("types");
    expect(await screen.findByText("ฟิลด์บังคับ: ชื่อ, Size")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "เปิดใช้ Spike" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/issue-types/t-spike", body: { enabled: false } }));
    await user.click(screen.getAllByRole("button", { name: "แก้ฟิลด์" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "ฟิลด์บังคับของ Story" });
    expect(within(dialog).getByRole("checkbox", { name: "ชื่อ" })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: "Module" }));
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ path: "/w/sample/projects/DE/issue-types/t-story", body: { requiredFields: ["title", "size", "module"] } }));
    expect(screen.getByText("Release version (ตัวเลือก)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ เพิ่มฟิลด์" }));
    const field = await screen.findByRole("dialog", { name: "เพิ่ม Custom field" });
    await user.type(within(field).getByLabelText("ชื่อฟิลด์"), "ช่องทาง");
    await user.selectOptions(within(field).getByLabelText("ชนิด"), "select");
    await user.type(within(field).getByLabelText("ตัวเลือก"), "เว็บ, มือถือ");
    await user.click(within(field).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", body: { name: "ช่องทาง", fieldType: "select", options: { choices: [{ label: "เว็บ" }, { label: "มือถือ" }] } } }));
    await user.click(screen.getByRole("button", { name: "+ เพิ่ม Label" }));
    const label = await screen.findByRole("dialog", { name: "เพิ่ม Label" });
    await user.type(within(label).getByLabelText("ชื่อ Label"), "hotfix");
    await user.click(within(label).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/labels", body: { name: "hotfix", color: "#5b3fc4" } }));
    await user.click(screen.getByRole("button", { name: "ลบ Release version" }));
    await user.click(within(await screen.findByRole("dialog", { name: "ลบ Release version" })).getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/projects/DE/custom-fields/f1" }));
  });

  it("ชุดฟิลด์ของ Task / Sub-task: บอกที่มา Template · ซ่อนแล้วคอลัมน์หาย · บังคับ · เรียงคอลัมน์ · โหมดของ Custom field", async () => {
    const user = userEvent.setup();
    settings("types");
    expect(await screen.findByText("สร้างจาก Template Development")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "บันทึกชุดฟิลด์" });
    expect(save).toBeDisabled();
    // Actual / Progress ระบบตั้งค่าให้ จึงเลือก "บังคับ" ไม่ได้
    expect(within(screen.getByLabelText("Progress ระดับ Task")).getByRole("option", { name: "บังคับ" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Business Analyst ระดับ Task"), "hidden");
    await user.selectOptions(screen.getByLabelText("Business Analyst ระดับ Sub-task"), "hidden");
    expect(screen.getByRole("checkbox", { name: "แสดง Business Analyst เป็นคอลัมน์ใน Table" })).toBeDisabled();
    const order = screen.getByRole("list", { name: "ลำดับคอลัมน์ใน Table" });
    expect(within(order).queryByText("BA")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Size ระดับ Task"), "required");
    await user.selectOptions(screen.getByLabelText("Size ระดับ Sub-task"), "hidden");
    await user.click(screen.getByRole("button", { name: "เลื่อน สถานะ ขึ้น" }));
    await user.selectOptions(screen.getByLabelText("Release version ระดับ Sub-task"), "hidden");
    await user.click(screen.getByRole("checkbox", { name: "แสดง Label เป็นคอลัมน์ใน Table" }));
    await user.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/w/sample/projects/DE/field-profile",
      body: {
        fields: { ba: { task: "hidden", subtask: "hidden" }, size: { task: "required", subtask: "hidden" }, sa: { task: "optional", subtask: "optional" } },
        columns: ["dev", "status", "sa", "size", "start", "end", "actualStart", "actualEnd", "progress", "remark", "cf:f1", "labels"],
      },
    }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path.endsWith("/custom-fields/f1"))).toMatchObject({ body: { taskMode: "optional", subtaskMode: "hidden" } }));
    expect(await screen.findByText("บันทึกชุดฟิลด์แล้ว")).toBeInTheDocument();
  });

  it("Modules: เปลี่ยน Owner, เรียงลำดับ, ลบ Module ที่มีงานต้องเลือกปลายทาง, เพิ่ม", async () => {
    const user = userEvent.setup();
    settings("modules");
    await user.selectOptions(await screen.findByLabelText("Owner ของ Module B"), "u-dev");
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/modules/m-b", body: { ownerUserId: "u-dev" } }));
    await user.click(screen.getByRole("button", { name: "เลื่อน Module B ขึ้น" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ path: "/w/sample/projects/DE/modules/reorder", body: { ids: ["m-b", "m-a"] } }));
    await user.click(screen.getByRole("button", { name: "ลบ Module Module A" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "ลบ Module" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/projects/DE/modules/m-a", body: { moveTo: "m-b" } }));
    await user.click(screen.getByRole("button", { name: "+ เพิ่ม Module" }));
    const add = await screen.findByRole("dialog", { name: "เพิ่ม Module" });
    await user.type(within(add).getByLabelText("ชื่อ Module"), "รายงาน");
    await user.click(within(add).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/modules", body: { name: "รายงาน" } }));
  });

  it("สิทธิ์ของ Role: ตาราง 10 แถว · Admin เปิดเสมอ · เปลี่ยนแล้ว PUT · ล้มเหลวคืนค่าเดิม", async () => {
    const user = userEvent.setup();
    settings("perms");
    const table = await screen.findByRole("table", { name: "สิทธิ์ของแต่ละ Role" });
    expect(within(table).getAllByRole("row")).toHaveLength(11);
    expect(within(table).getByRole("checkbox", { name: "ลบงาน สำหรับ Admin" })).toBeDisabled();
    expect(within(table).getByRole("checkbox", { name: "สร้างและแก้ไขงาน สำหรับ Member" })).toBeChecked();
    expect(within(table).getByRole("checkbox", { name: "สร้างและแก้ไขงาน สำหรับ Viewer" })).not.toBeChecked();
    const due = within(table).getByRole("checkbox", { name: "เปลี่ยน Due โดยไม่ต้องขออนุมัติ สำหรับ Member" });
    await user.click(due);
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PUT", path: "/w/sample/projects/DE/role-permissions", body: { role: "member", permission: "issue.change_due_directly", allowed: true } }));
    expect(due).toBeChecked();
    server.use(http.put(`${P}/role-permissions`, () => errorBody(500)));
    const invite = within(table).getByRole("checkbox", { name: "เชิญสมาชิกเข้าโปรเจกต์ สำหรับ Viewer" });
    await user.click(invite);
    expect(await screen.findByText(/req_w13_001/)).toBeInTheDocument();
    expect(invite).not.toBeChecked();
  });

  it("Danger zone: Archive, โอน, ลบต้องพิมพ์ Key ให้ตรง", async () => {
    const user = userEvent.setup();
    server.use(http.get(`${P}/my-permissions`, () => HttpResponse.json({ ...permissions, permissions: [...permissions.permissions, "project.archive"] })));
    settings("danger");
    expect(await screen.findByText(/ลบงาน 74 งาน, ไฟล์ 24 ไฟล์, สมาชิก 3 คน/)).toBeInTheDocument();
    const del = screen.getByRole("button", { name: "ลบโปรเจกต์" });
    expect(del).toBeDisabled();
    await user.type(screen.getByLabelText("พิมพ์ DE เพื่อยืนยัน"), "de");
    await user.click(del);
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "DELETE", path: "/w/sample/projects/DE", body: { confirmKey: "de" } }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/work/sample"));

    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/archive" }));

    await user.click(screen.getByRole("button", { name: "โอนให้…" }));
    const transfer = await screen.findByRole("dialog", { name: "โอนความเป็นเจ้าของ" });
    // Guest และเจ้าของเดิมไม่อยู่ในรายชื่อ
    expect(within(transfer).getAllByRole("option").map((o) => o.textContent)).toEqual(["ผู้พัฒนาหนึ่ง"]);
    await user.click(within(transfer).getByRole("button", { name: "โอนความเป็นเจ้าของ" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/transfer", body: { userId: "u-dev" } }));
  });

  it("สถานะ: Error พร้อม requestId · ไม่มี project.settings = ไม่มีสิทธิ์ · Guest ได้ 403 รายแท็บ", async () => {
    server.use(http.get(P, () => errorBody(500)));
    const a = settings();
    expect(await screen.findByText(/req_w13_001/)).toBeInTheDocument();
    a.unmount();
    server.resetHandlers();
    server.use(
      http.get(P, () => HttpResponse.json(project())),
      http.get(`${P}/my-permissions`, () => HttpResponse.json({ ...permissions, role: "member", permissions: ["project.view", "issue.create"] })),
    );
    const b = settings("workflow");
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
    b.unmount();
    server.use(
      http.get(`${P}/my-permissions`, () => HttpResponse.json(permissions)),
      http.get(`${P}/members`, () => HttpResponse.json({ items: [] })),
      http.get(`${P}/modules`, () => errorBody(403, "guest_settings_hidden")),
    );
    settings("modules");
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("ฟังก์ชันช่วย: ส่งเฉพาะค่าที่เปลี่ยน · คอลัมน์ของ Bug", () => {
    const p = project({ sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 12 } });
    expect(generalChanges(p, { name: p.name, key: "de", startDate: p.startDate, goliveDate: p.goliveDate, visibility: "workspace", estimateUnit: "man_day", sprintLengthWeeks: "", sizeMdMap: { XS: "1", S: "3", M: "5", L: "8", XL: "12" }, holidayCalendarId: "", workStart: "09:30", workEnd: "", timeLogEnabled: false })).toEqual({ visibility: "workspace", sprintLengthWeeks: null, workStart: "09:30" });
    const [std, bug] = workflows();
    expect(bugColumns(bug, std)).toBe("Open → To do · Fixed, Verified → Review · Closed → Done");
  });
});

describe("สร้างโปรเจกต์ (Wizard 5 ขั้น)", () => {
  let created: Record<string, unknown> | null;
  beforeEach(() => {
    created = null;
    server.use(
      // Template ในตัว + ขององค์กร (สมาชิกทุกคนเห็น) · Template ที่ config ผิดไม่แสดง
      http.get("*/api/v1/w/:ws/projects/template-catalog", () => HttpResponse.json({
        categories: ["software", "service", "operations"],
        items: [
          { id: "development", source: "builtin", category: "software", name: "Development", description: null, config: {}, invalid: false, usageCount: null },
          { id: "tpl-ops", source: "workspace", category: "operations", name: "งานปฏิบัติการ", description: "ชุดฟิลด์สั้น", config: {}, invalid: false, usageCount: 2 },
          { id: "tpl-bad", source: "workspace", category: "service", name: "Template เสีย", description: null, config: {}, invalid: true, usageCount: 0 },
        ],
      })),
      http.get("*/api/v1/w/:ws/projects/key-available", ({ request }) => {
        const key = new URL(request.url).searchParams.get("key");
        return HttpResponse.json({ key, available: key !== "DE" });
      }),
      http.get("*/api/v1/w/:ws/members", () => HttpResponse.json({ items: [
        { userId: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง", email: "lead@example.com", role: "owner", status: "active", jobTitle: null, capacityHoursWeek: 40 },
        { userId: "u-dev", displayName: "ผู้พัฒนาหนึ่ง", email: "dev1@example.com", role: "member", status: "active", jobTitle: "Backend Dev", capacityHoursWeek: 32 },
        { userId: "u-guest", displayName: "ลูกค้าตัวอย่าง", email: "client@example.com", role: "guest", status: "active", jobTitle: null, capacityHoursWeek: null },
      ] })),
      http.post("*/api/v1/w/:ws/projects", async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...project({ key: String(created.key) }), created: { modules: 2, statuses: 4, milestones: 1, sprints: 0, members: 3, holidays: 0, scopeItems: 1, customFields: 0, labels: 0 } }, { status: 201 });
      }),
    );
  });
  const wizard = () => mount(<NewProjectWizard ws="sample" />);

  it("ครบ 5 ขั้น: Key จากชื่อ, Template, ระยะเวลา, Scope + Module, ทีม, Workflow แล้วส่ง POST w/projects", async () => {
    const user = userEvent.setup();
    wizard();
    await user.click(await screen.findByRole("button", { name: "ถัดไป →" }));
    expect(screen.getAllByText("ต้องกรอก").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("ชื่อโปรเจกต์ *"), "Delivery Engine");
    expect(screen.getByLabelText("Project Key *")).toHaveValue("DE");
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));
    expect(await screen.findByText("Project Key DE มีใน Workspace แล้ว")).toBeInTheDocument();
    const key = screen.getByLabelText("Project Key *");
    await user.clear(key);
    await user.type(key, "dlv");
    await user.click(screen.getByRole("button", { name: /Kanban/ }));
    expect(screen.getByRole("button", { name: /Kanban/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "สี ม่วง" }));
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));

    expect(await screen.findByRole("heading", { name: "ระยะเวลา" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("วันเริ่มต้น *"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("วันสิ้นสุดเป้าหมาย (Go-live) *"), { target: { value: "2026-11-15" } });
    expect(screen.getByText(/ระยะเวลา 14 วัน · 10 วันทำการ/)).toBeInTheDocument();
    expect(screen.queryByText("ความยาว Sprint")).not.toBeInTheDocument(); // Kanban ไม่มี Sprint
    await user.click(screen.getByRole("button", { name: "+ เพิ่ม Milestone" }));
    await user.type(screen.getByLabelText("ชื่อ Milestone ที่ 1"), "Go-live");
    fireEvent.change(screen.getByLabelText("วันที่หยุด"), { target: { value: "2026-11-13" } });
    await user.type(screen.getByLabelText("ชื่อวันหยุด"), "วันหยุดบริษัท");
    await user.click(screen.getByRole("button", { name: "+ เพิ่มวันหยุดบริษัท" }));
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));

    await user.type(await screen.findByLabelText("In-scope (สิ่งที่จะทำ)"), "ระบบสั่งงาน{Enter}");
    await user.type(screen.getByLabelText("Module เริ่มต้น"), "Module A{Enter}Module B{Enter}");
    expect(screen.getByRole("button", { name: "ลบ Module Module B" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Deliverables"), "ระบบเว็บ{Enter}คู่มือ");
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));

    await user.type(await screen.findByLabelText(/พิมพ์ชื่อหรืออีเมลเพื่อเชิญ/), "dev1@example.com, คนนอก");
    await waitFor(() => expect(screen.getByRole("button", { name: "เพิ่ม" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "เพิ่ม" }));
    expect(await screen.findByTestId("member-u-dev")).toHaveTextContent("ผู้พัฒนาหนึ่ง");
    expect(await screen.findByText(/ไม่พบ คนนอก ใน Workspace/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Role ของ ผู้พัฒนาหนึ่ง"), "viewer");
    await user.click(screen.getByRole("button", { name: /ทุกคนในองค์กรดูได้/ }));
    expect(screen.getByText("2 คน · 32 ชม./สัปดาห์")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));

    expect(await screen.findByText(/WIP 5/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("ชื่อสถานะใหม่"), "QA{Enter}");
    await user.click(screen.getByLabelText("ถ่วงน้ำหนักด้วย Estimate"));
    await user.click(screen.getByRole("button", { name: "สร้างโปรเจกต์" }));
    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toEqual({
      name: "Delivery Engine", key: "DLV", color: "#7C3AED", startDate: "2026-11-02", goliveDate: "2026-11-15", timezone: "Asia/Bangkok",
      visibility: "workspace", extraHolidays: [{ date: "2026-11-13", name: "วันหยุดบริษัท" }], sprintLengthWeeks: null,
      modules: ["Module A", "Module B"], milestones: [{ name: "Go-live", date: "2026-11-15" }],
      scope: { in: ["ระบบสั่งงาน"], deliverables: ["ระบบเว็บ", "คู่มือ"] },
      members: [{ userId: "u-dev", role: "viewer", position: "BE", capacityHoursWeek: 32 }],
      workflow: ["To do", { name: "In progress", wipLimit: 5 }, { name: "Review", wipLimit: 3 }, "QA", "Done"],
      estimateUnit: "man_day", progressMethod: "weighted", builtinTemplate: "kanban",
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/work/sample/p/DLV"));
  });

  it("สร้างเลยจากขั้น 2 · Scrum สร้าง Sprint · Go-live ก่อนวันเริ่มไม่ผ่าน · Error จาก API แสดง requestId", async () => {
    const user = userEvent.setup();
    wizard();
    await user.type(await screen.findByLabelText("ชื่อโปรเจกต์ *"), "Sample Project");
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));
    fireEvent.change(await screen.findByLabelText("วันเริ่มต้น *"), { target: { value: "2026-11-04" } });
    fireEvent.change(screen.getByLabelText("วันสิ้นสุดเป้าหมาย (Go-live) *"), { target: { value: "2026-11-01" } });
    await user.click(screen.getByRole("button", { name: "สร้างเลย (ตั้งค่าที่เหลือทีหลัง)" }));
    expect(await screen.findByText("วัน Go-live ต้องไม่ก่อนวันเริ่ม")).toBeInTheDocument();
    expect(created).toBeNull();
    fireEvent.change(screen.getByLabelText("วันสิ้นสุดเป้าหมาย (Go-live) *"), { target: { value: "2026-12-21" } });
    expect(screen.getByText(/รวม 4 Sprint/)).toBeInTheDocument();
    expect(screen.getByText("Sprint 1–4 (2 สัปดาห์)")).toBeInTheDocument();
    server.use(http.post("*/api/v1/w/:ws/projects", () => errorBody(500)));
    await user.click(screen.getByRole("button", { name: "สร้างเลย (ตั้งค่าที่เหลือทีหลัง)" }));
    expect(await screen.findByText(/req_w13_001/)).toBeInTheDocument();
    server.use(http.post("*/api/v1/w/:ws/projects", async ({ request }) => { created = (await request.json()) as Record<string, unknown>; return HttpResponse.json({ key: "SP", created: { modules: 0, statuses: 4, milestones: 0, sprints: 4, members: 1 } }, { status: 201 }); }));
    await user.click(screen.getByRole("button", { name: "สร้างเลย (ตั้งค่าที่เหลือทีหลัง)" }));
    // ค่าเริ่มต้น = Template Development (ชุดฟิลด์ของแผนพัฒนา) · Sprint 2 สัปดาห์ · ความคืบหน้าถ่วงน้ำหนัก
    await waitFor(() => expect(created).toMatchObject({ key: "SP", sprintLengthWeeks: 2, workflow: ["To do", "In progress", "Review", "Done"], builtinTemplate: "development", progressMethod: "weighted" }));
  });

  it("Template จัดตามหมวด: Development เลือกไว้ก่อน · Template ขององค์กรอยู่หมวดของตัวเอง · เลือกแล้วส่ง templateId", async () => {
    const user = userEvent.setup();
    wizard();
    const software = await screen.findByRole("group", { name: "Template · Software development" });
    expect(within(software).getAllByRole("button").map((b) => b.querySelector("b")?.textContent)).toEqual(["Development", "Scrum", "Kanban", "Waterfall", "Blank"]);
    expect(within(software).getByRole("button", { name: /^Development/ })).toHaveAttribute("aria-pressed", "true");
    const ops = await screen.findByRole("group", { name: "Template · Operations" });
    expect(screen.queryByRole("group", { name: "Template · Service management" })).not.toBeInTheDocument();
    expect(screen.queryByText("Template เสีย")).not.toBeInTheDocument();
    await user.click(within(ops).getByRole("button", { name: /งานปฏิบัติการ/ }));
    await user.type(screen.getByLabelText("ชื่อโปรเจกต์ *"), "Ops Board");
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));
    fireEvent.change(await screen.findByLabelText("วันเริ่มต้น *"), { target: { value: "2026-11-09" } });
    fireEvent.change(screen.getByLabelText("วันสิ้นสุดเป้าหมาย (Go-live) *"), { target: { value: "2026-12-30" } });
    await user.click(screen.getByRole("button", { name: "สร้างเลย (ตั้งค่าที่เหลือทีหลัง)" }));
    await waitFor(() => expect(created).toMatchObject({ key: "OB", templateId: "tpl-ops" }));
    expect(created).not.toHaveProperty("builtinTemplate");
  });

  it("บันทึกร่างในเครื่อง · Guest สร้างโปรเจกต์ไม่ได้", async () => {
    const user = userEvent.setup();
    const a = wizard();
    await user.type(await screen.findByLabelText("ชื่อโปรเจกต์ *"), "Draft Plan");
    await user.click(screen.getByRole("button", { name: "บันทึกร่าง" }));
    expect(await screen.findByText("บันทึกร่างไว้ในเครื่องนี้แล้ว")).toBeInTheDocument();
    a.unmount();
    const b = wizard();
    expect(await screen.findByDisplayValue("Draft Plan")).toBeInTheDocument();
    b.unmount();
    window.localStorage.clear();
    server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role: "guest" }] })));
    wizard();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("ฟังก์ชันช่วย: Key จากชื่อ, วันทำการ, จำนวน Sprint", () => {
    expect(suggestKey("Development Plan 2026-11")).toBe("DP");
    expect(suggestKey("ระบบจองคิว")).toBe("");
    expect(suggestKey("Booking")).toBe("BOO");
    expect(spanDays("2026-11-02", "2026-11-15")).toEqual({ calendar: 14, working: 10 });
    expect(spanDays("2026-11-15", "2026-11-02")).toBeNull();
    expect(sprintCount("2026-11-04", "2026-12-21", 2)).toBe(4);
    expect(sprintCount("2026-11-04", "2026-12-20", 2)).toBe(3);
    expect(sprintCount("2026-11-04", "2026-12-20", null)).toBe(0);
  });
});
