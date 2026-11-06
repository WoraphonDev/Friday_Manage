// W09 · Calendar · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import calendar from "../../messages/th/calendar.json";
import { CalendarView, addDays, mondayOf, monthDays, shiftMonth, type CalIssue, type CalendarData } from "../../app/w/[ws]/p/[key]/calendar/_components/calendar-view";

const person = (id: string, displayName: string) => ({ id, displayName });
const issue = (key: string, planEnd: string, over: Partial<CalIssue> = {}): CalIssue => ({
  key, type: "Task", title: `งาน ${key}`, status: { name: "To do", category: "todo" }, priority: "medium",
  planStart: null, planEnd, due: "upcoming", parentKey: null, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")], version: 1, ...over,
});
function december(): CalendarData {
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" },
    today: "2026-12-02",
    month: "2026-12",
    range: { from: "2026-11-30", to: "2027-01-03" },
    issues: [
      issue("DE-1", "2026-12-01", { planStart: "2026-12-01", due: "overdue", version: 3 }),
      issue("DE-2", "2026-12-02", { due: "today", status: { name: "In progress", category: "in_progress" }, version: 4 }),
      issue("DE-3", "2026-12-10", { planStart: "2026-12-07", version: 2 }),
      issue("DE-4", "2026-12-01", { due: "done", status: { name: "Done", category: "done" } }),
      issue("DE-5", "2026-12-15", { version: undefined }),
      ...["DE-6", "DE-7", "DE-8", "DE-9"].map((k) => issue(k, "2026-12-16")),
    ],
    sprints: [{ id: "sp1", number: 1, name: "Sprint 1", startDate: "2026-11-30", endDate: "2026-12-11", status: "active" }],
    milestones: [{ id: "ms1", name: "Sprint 1 Review", date: "2026-12-11" }],
    holidays: [
      { date: "2026-12-07", name: "วันหยุดทีม", scope: "project" },
      { date: "2026-12-10", name: "วันหยุดตัวอย่าง", scope: "workspace" },
    ],
    leaves: [
      { person: person("u2", "ผู้พัฒนาสอง"), leaveType: "ลาพักร้อน", startDate: "2026-12-03", endDate: "2026-12-04", halfDay: null, status: "approved" },
      { person: person("u3", "ผู้ทดสอบสาม"), leaveType: "ลากิจ", startDate: "2026-12-09", endDate: "2026-12-09", halfDay: "am", status: "pending" },
    ],
  };
}
const empty = (month: string): CalendarData => ({ ...december(), month, range: { from: monthDays(month)[0], to: monthDays(month).at(-1)! }, issues: [], sprints: [], milestones: [], holidays: [], leaves: [] });

let months: (string | null)[];
let patches: { key: string; body: Record<string, unknown>; etag: string | null }[];
let requests: Record<string, unknown>[];
let feeds: { id: string; projectKey: string | null; createdAt: string }[];
let deleted: string[];
let d: CalendarData;
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "guest_view_limited" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w09_001" } }, { status });

beforeEach(() => {
  months = []; patches = []; requests = []; deleted = []; d = december();
  feeds = [{ id: "f-other", projectKey: null, createdAt: "2026-11-01T03:00:00Z" }];
  navigation.pathname = "/w/sample/p/DE/calendar";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/calendar", ({ request }) => {
      const month = new URL(request.url).searchParams.get("month");
      months.push(month);
      return HttpResponse.json(!month || month === "2026-12" ? d : empty(month));
    }),
    http.get("*/api/v1/w/:ws/issues/:key", () => HttpResponse.json({ version: 9 })),
    http.patch("*/api/v1/w/:ws/issues/:key", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ key: String(params.key), body, etag: request.headers.get("if-match") });
      if (params.key === "DE-3" && !body.planChangeReason) return HttpResponse.json({ error: { code: "plan_change_reason_required", message: "ต้องใส่เหตุผล" } }, { status: 400 });
      if (params.key === "DE-5" && String(body.planEnd) > "2026-12-15") return HttpResponse.json({ error: { code: "due_change_requires_approval", message: "ต้องขออนุมัติ" } }, { status: 403 });
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/v1/w/:ws/issues/:key/due-requests", async ({ request }) => { requests.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ id: "dr" }, { status: 201 }); }),
    http.get("*/api/v1/me/calendar-feeds", () => HttpResponse.json({ items: feeds })),
    http.post("*/api/v1/me/calendar-feeds", async ({ request }) => {
      const body = (await request.json()) as { projectKey: string };
      const id = `f${feeds.length}`;
      feeds = [{ id, projectKey: body.projectKey, createdAt: "2026-12-02T03:00:00Z" }, ...feeds];
      return HttpResponse.json({ id, url: `https://friday.example/api/v1/ical/token${id}.ics`, projectKey: body.projectKey, workspace: "sample", createdAt: "2026-12-02T03:00:00Z" }, { status: 201 });
    }),
    http.delete("*/api/v1/me/calendar-feeds/:id", ({ params }) => { deleted.push(String(params.id)); feeds = feeds.filter((f) => f.id !== params.id); return HttpResponse.json({ revoked: true }); }),
  );
});
const mount = () => renderWithProviders(<WorkspaceShell ws="sample"><CalendarView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { calendar } });
const day = (iso: string) => screen.getByTestId(`day-${iso}`);
const task = (key: string) => screen.getByTestId(`task-${key}`);
function drag(key: string, to: string) {
  fireEvent.dragStart(task(key));
  fireEvent.dragOver(day(to));
  fireEvent.drop(day(to));
}

describe("Calendar (6)", () => {
  it("เดือน: งานบนวัน Due (เลยกำหนด / วันนี้), Sprint, Milestone, วันหยุด, วันลา และ +more", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("heading", { name: "ธันวาคม 2569" })).toBeInTheDocument();
    expect(months).toEqual([null]);
    expect(within(day("2026-12-01")).getByTestId("task-DE-1")).toHaveAccessibleName(/DE-1 งาน DE-1 · ครบกำหนด .* · เลยกำหนด/);
    expect(task("DE-2")).toHaveAccessibleName(/ครบกำหนดวันนี้/);
    expect(day("2026-12-02")).toHaveAttribute("aria-current", "date");
    expect(day("2026-11-30")).toHaveTextContent("Sprint 1 เริ่ม");
    expect(day("2026-12-11")).toHaveTextContent("Sprint 1 จบ");
    expect(day("2026-12-11")).toHaveTextContent("Sprint 1 Review");
    expect(day("2026-12-10")).toHaveAccessibleName(/วันหยุดตัวอย่าง/);
    expect(day("2026-12-07")).toHaveTextContent("วันหยุดทีม");
    expect(day("2026-12-03")).toHaveTextContent("ผู้พัฒนาสอง · ลาพักร้อน");
    expect(day("2026-12-04")).toHaveTextContent("ผู้พัฒนาสอง · ลาพักร้อน");
    expect(day("2026-12-09")).toHaveTextContent("ผู้ทดสอบสาม · ลากิจ · ครึ่งเช้า · รออนุมัติ");
    // ช่องเดือนเต็มสัปดาห์ จันทร์ 30 พ.ย. – อาทิตย์ 3 ม.ค.
    expect(day("2027-01-03")).toBeInTheDocument();
    // งาน Done ซ่อนเป็นค่าเริ่มต้น
    expect(screen.queryByTestId("task-DE-4")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("งานที่ Done แล้ว"));
    expect(task("DE-4")).toHaveAccessibleName(/Done/);
    await user.click(screen.getByLabelText("วันลาของสมาชิก"));
    expect(day("2026-12-03")).not.toHaveTextContent("ลาพักร้อน");
    // 4 งานในวันเดียว = แสดง 3 + ปุ่ม +1 more
    expect(screen.queryByTestId("task-DE-9")).not.toBeInTheDocument();
    await user.click(within(day("2026-12-16")).getByRole("button", { name: "+1 more" }));
    expect(task("DE-9")).toHaveAttribute("href", "/w/sample/p/DE/calendar?issue=DE-9");
    expect(screen.getByRole("link", { name: "+ Task" })).toHaveAttribute("href", "/w/sample/p/DE/calendar?new=1");
  });

  it("เลื่อนเดือน ก่อนหน้า / ถัดไป / Today", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "ธันวาคม 2569" });
    await user.click(screen.getByRole("button", { name: "เดือนถัดไป" }));
    expect(await screen.findByRole("heading", { name: "มกราคม 2570" })).toBeInTheDocument();
    expect(await screen.findByText("ยังไม่มีงานที่ครบกำหนดในช่วงนี้")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เดือนก่อนหน้า" }));
    await user.click(await screen.findByRole("button", { name: "เดือนก่อนหน้า" }));
    expect(await screen.findByRole("heading", { name: "พฤศจิกายน 2569" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByRole("heading", { name: "ธันวาคม 2569" })).toBeInTheDocument();
    expect(months.slice(0, 4)).toEqual([null, "2027-01", "2026-12", "2026-11"]);
  });

  it("สัปดาห์: 7 วันของสัปดาห์นี้ · เลื่อนทีละสัปดาห์", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("task-DE-1");
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId(/^day-/).map((el) => el.dataset.testid)).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"].map((x) => `day-${x}`));
    expect(screen.getByRole("heading", { name: /30 พ.ย. 69 – 6 ธ.ค. 69/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "สัปดาห์ถัดไป" }));
    expect(await screen.findByTestId("task-DE-3")).toBeInTheDocument();
    expect(screen.queryByTestId("task-DE-1")).not.toBeInTheDocument();
    expect(day("2026-12-13")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByTestId("task-DE-1")).toBeInTheDocument();
  });

  it("ลากงานไปวันอื่น = PATCH planEnd พร้อม If-Match · ไม่มี version อ่านงานก่อน · Due ก่อน Start เลื่อน Start ด้วย", async () => {
    mount();
    await screen.findByTestId("task-DE-2");
    drag("DE-2", "2026-12-05");
    await waitFor(() => expect(patches[0]).toEqual({ key: "DE-2", body: { planEnd: "2026-12-05" }, etag: '"4"' }));
    expect(await screen.findByText(/เลื่อน Due ของ DE-2 เป็น 5 ธ.ค. 69 แล้ว/)).toBeInTheDocument();
    drag("DE-5", "2026-12-14");
    await waitFor(() => expect(patches[1]).toEqual({ key: "DE-5", body: { planEnd: "2026-12-14" }, etag: '"9"' }));
    drag("DE-1", "2026-11-30");
    await waitFor(() => expect(patches[2]).toEqual({ key: "DE-1", body: { planStart: "2026-11-30", planEnd: "2026-11-30" }, etag: '"3"' }));
    // วางวันเดิม = ไม่ส่งอะไร
    drag("DE-2", "2026-12-02");
    expect(patches).toHaveLength(3);
  });

  it("แป้นพิมพ์ Alt + ลูกศร เลื่อน Due", async () => {
    const user = userEvent.setup();
    mount();
    (await screen.findByTestId("task-DE-2")).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await waitFor(() => expect(patches[0]?.body).toEqual({ planEnd: "2026-12-03" }));
    task("DE-2").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(patches[1]?.body).toEqual({ planEnd: "2026-12-09" }));
  });

  it("หลัง Baseline ถามเหตุผลแล้วส่งซ้ำ · ไม่มีสิทธิ์เลื่อน Due → ฟอร์มขอเลื่อน", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("task-DE-3");
    drag("DE-3", "2026-12-08");
    const dialog = await screen.findByRole("dialog", { name: "เหตุผลที่แก้แผน" });
    await user.type(within(dialog).getByRole("textbox"), "ลูกค้าขอเพิ่ม");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(patches.at(-1)).toEqual({ key: "DE-3", body: { planEnd: "2026-12-08", planChangeReason: "ลูกค้าขอเพิ่ม" }, etag: '"2"' }));
    drag("DE-5", "2026-12-18");
    const req = await screen.findByRole("dialog", { name: "ขอเลื่อน Due" });
    await user.selectOptions(within(req).getByLabelText("เหตุผล"), "waiting_input");
    await user.click(within(req).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(requests).toEqual([{ requestedDue: "2026-12-18", reasonCode: "waiting_input" }]));
    expect(await screen.findByText("ส่งคำขอเลื่อน Due ของ DE-5 แล้ว")).toBeInTheDocument();
  });

  it("ไม่มีสิทธิ์ issue.edit: ลากไม่ได้ ไม่มีปุ่ม + Task", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "viewer", permissions: ["project.view"] })));
    mount();
    await screen.findByTestId("task-DE-2");
    expect(task("DE-2")).toHaveAttribute("draggable", "false");
    drag("DE-2", "2026-12-05");
    expect(screen.queryByRole("link", { name: "+ Task" })).not.toBeInTheDocument();
    expect(screen.queryByText("ลากงานไปวันอื่นเพื่อเปลี่ยน Due")).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(patches).toHaveLength(0);
  });

  it("Subscribe iCal: สร้างลิงก์ คัดลอก เพิ่มใน Google Calendar · สร้างใหม่เพิกถอนอันเดิม · เพิกถอน", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Subscribe (iCal / Google Calendar)" }));
    const dialog = await screen.findByRole("dialog", { name: "Subscribe ปฏิทิน" });
    // ลิงก์ของทั้ง Workspace (projectKey null) ไม่นับเป็นของโปรเจกต์นี้
    expect(await within(dialog).findByText("ยังไม่มีลิงก์ของโปรเจกต์นี้")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "สร้างลิงก์ iCal" }));
    const input = await within(dialog).findByLabelText("ลิงก์ iCal");
    expect(input).toHaveValue("https://friday.example/api/v1/ical/tokenf1.ics");
    await user.click(within(dialog).getByRole("button", { name: "คัดลอก" }));
    expect(await navigator.clipboard.readText()).toBe("https://friday.example/api/v1/ical/tokenf1.ics");
    expect(await screen.findByText("คัดลอกลิงก์แล้ว")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "เพิ่มใน Google Calendar" })).toHaveAttribute("href", `https://calendar.google.com/calendar/r?cid=${encodeURIComponent("webcal://friday.example/api/v1/ical/tokenf1.ics")}`);
    await user.click(await within(dialog).findByRole("button", { name: "สร้างลิงก์ใหม่" }));
    await waitFor(() => expect(within(dialog).getByLabelText("ลิงก์ iCal")).toHaveValue("https://friday.example/api/v1/ical/tokenf2.ics"));
    expect(deleted).toEqual(["f1"]);
    await user.click(await within(dialog).findByRole("button", { name: "เพิกถอน" }));
    await waitFor(() => expect(deleted).toEqual(["f1", "f2"]));
    expect(await within(dialog).findByText("ยังไม่มีลิงก์ของโปรเจกต์นี้")).toBeInTheDocument();
  });

  it("Error มี requestId · 403 (Guest)", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/calendar", () => errorBody(500)));
    const a = mount();
    expect(await screen.findByText(/req_w09_001/)).toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/calendar", () => errorBody(403)));
    mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("ตัวช่วยวันที่", () => {
    expect(mondayOf("2026-12-06")).toBe("2026-11-30");
    expect(mondayOf("2026-11-30")).toBe("2026-11-30");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthDays("2026-12")).toHaveLength(35);
    expect(monthDays("2026-12")[0]).toBe("2026-11-30");
    expect(monthDays("2027-03")).toHaveLength(35);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
