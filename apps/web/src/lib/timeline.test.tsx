// W07 · Timeline · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import tl from "../../messages/th/timeline.json";
import { PX_PER_DAY, TimelineView, addDays, toDay, type TLRow, type TimelineData } from "../../app/w/[ws]/p/[key]/timeline/_components/timeline-view";

const person = (id: string, displayName: string) => ({ id, displayName });
const row = (key: string, start: string, end: string, over: Partial<TLRow> = {}): TLRow => ({ key, type: "Task", title: `งาน ${key}`, status: { name: "In progress", category: "in_progress" }, start, end, progressPct: 40, lateDays: 0, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")], subtasks: [], ...over });
function data(): TimelineData {
  const sum = { progressPct: 30, lateDays: 0, taskCount: 2 };
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", startDate: "2026-11-02", goliveDate: "2027-01-29" },
    today: "2026-12-02",
    range: { from: "2026-11-02", to: "2027-01-29" },
    lastEnd: "2026-12-18",
    sprints: [{ id: "sp1", number: 1, name: "Sprint 1", startDate: "2026-11-30", endDate: "2026-12-11", status: "active" }],
    milestones: [{ id: "ms1", name: "Go-live ระยะแรก", date: "2026-12-18", moduleId: null }],
    modules: [{ id: "m-a", name: "Module A", color: "#1d4ed8", start: "2026-11-30", end: "2026-12-18", ...sum, groups: [{ phase: { id: "ph1" }, name: "กลุ่มงานแรก", start: "2026-11-30", end: "2026-12-18", ...sum, tasks: [row("DE-1", "2026-11-30", "2026-12-04", { subtasks: [row("DE-2", "2026-12-01", "2026-12-02")] }), row("DE-3", "2026-12-07", "2026-12-18", { lateDays: 3, status: { name: "To do", category: "todo" }, assignees: [] })] }] }],
    unscheduled: [{ key: "DE-9", type: "Task", title: "งานยังไม่มีวัน", moduleId: "m-a", parentKey: null }],
  };
}

let patches: { key: string; body: Record<string, unknown>; etag: string | null }[];
let requests: Record<string, unknown>[];
let d: TimelineData;
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "guest_view_limited" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w07_001" } }, { status });

beforeEach(() => {
  patches = []; requests = []; d = data();
  navigation.pathname = "/w/sample/p/DE/timeline";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/timeline", () => HttpResponse.json(d)),
    http.get("*/api/v1/w/:ws/issues/:key", () => HttpResponse.json({ version: 5 })),
    http.patch("*/api/v1/w/:ws/issues/:key", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ key: String(params.key), body, etag: request.headers.get("if-match") });
      if (params.key === "DE-3" && body.planEnd && !body.planChangeReason) return HttpResponse.json({ error: { code: "plan_change_reason_required", message: "ต้องใส่เหตุผล" } }, { status: 400 });
      if (params.key === "DE-2" && body.planEnd) return HttpResponse.json({ error: { code: "due_change_requires_approval", message: "ต้องขออนุมัติ" } }, { status: 403 });
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/v1/w/:ws/issues/:key/due-requests", async ({ request }) => { requests.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ id: "dr" }, { status: 201 }); }),
  );
});
const mount = () => renderWithProviders(<WorkspaceShell ws="sample"><TimelineView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { timeline: tl } });
const bar = (key: string) => screen.getByTestId(`bar-${key}`);
const px = (el: HTMLElement, prop: "left" | "width") => Number(el.style[prop].replace("px", ""));

describe("Timeline (4)", () => {
  it("หัวแกนแบบ Gantt, Milestone, เส้นวันนี้, Module › กลุ่มงาน › Task › Sub-task · Unscheduled", async () => {
    mount();
    // หัวแกนเหมือน Gantt: ช่วงสัปดาห์ด้านบน และทุกวันพร้อมตัวย่อวัน (มุมมอง Day)
    const axis = await screen.findByTestId("axis");
    expect(axis.querySelectorAll("[title*='–']").length).toBeGreaterThan(0);
    expect(axis.querySelectorAll("b").length).toBeGreaterThan(27);
    expect(screen.getAllByText("Go-live ระยะแรก").length).toBeGreaterThan(0);
    expect(screen.getByText(/วันนี้ \(/)).toBeInTheDocument();
    expect(bar("DE-1")).toHaveAccessibleName(/DE-1 งาน DE-1: .* · ผู้พัฒนาหนึ่ง/);
    expect(bar("DE-3")).toHaveAccessibleName(/เลยกำหนด 3 วัน/);
    expect(bar("DE-2")).toBeInTheDocument();
    expect(screen.getByTestId("unscheduled-DE-9")).toHaveTextContent("งานยังไม่มีวัน");
    // ความกว้าง bar = จำนวนวัน × px/วัน (เริ่มที่ Day เหมือน Gantt)
    expect(px(bar("DE-1"), "width")).toBe(5 * PX_PER_DAY.day);
  });

  it("Day / Week / Month เปลี่ยนสเกล · ยุบ / ขยายได้ทุกระดับ", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("bar-DE-1");
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(px(bar("DE-1"), "width")).toBe(5 * PX_PER_DAY.week);
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(px(bar("DE-1"), "width")).toBe(5 * PX_PER_DAY.month);
    await user.click(screen.getByRole("button", { name: "ย่อ DE-1" }));
    expect(screen.queryByTestId("bar-DE-2")).not.toBeInTheDocument();
    // Module › Task › Sub-task: ไม่มีแถวกลุ่มงานแล้ว (ผู้ใช้ตัดสิน 2026-11-08)
    expect(screen.queryByRole("button", { name: /กลุ่มงานแรก/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ย่อ Module A" }));
    expect(screen.queryByTestId("bar-DE-1")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ขยาย Module A" }));
    expect(screen.getByTestId("bar-DE-1")).toBeInTheDocument();
    // ปุ่มระดับ: Module = ย่อทุก Module · + Sub-task = เปิดทั้งหมด
    const levels = within(screen.getByRole("group", { name: "ระดับที่แสดง" }));
    await user.click(levels.getByRole("button", { name: "Module" }));
    expect(screen.queryByTestId("bar-DE-1")).not.toBeInTheDocument();
    await user.click(levels.getByRole("button", { name: "+ Sub-task" }));
    expect(screen.getByTestId("bar-DE-2")).toBeInTheDocument();
  });

  it("ลาก bar = เลื่อนทั้งช่วง · ลากขอบ = ปรับความยาว → PATCH พร้อม If-Match ล่าสุด", async () => {
    mount();
    const b = await screen.findByTestId("bar-DE-1");
    fireEvent.mouseDown(b, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 100 + 3 * PX_PER_DAY.day });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(patches[0]).toEqual({ key: "DE-1", body: { planStart: "2026-12-03", planEnd: "2026-12-07" }, etag: '"5"' }));
    fireEvent.mouseDown(screen.getByTestId("end-DE-1"), { button: 0, clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 200 + 2 * PX_PER_DAY.day });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(patches[1]?.body).toEqual({ planEnd: "2026-12-06" }));
    fireEvent.mouseDown(screen.getByTestId("start-DE-1"), { button: 0, clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 200 - PX_PER_DAY.day });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(patches[2]?.body).toEqual({ planStart: "2026-11-29" }));
  });

  it("แป้นพิมพ์: ← → เลื่อน 1 วัน · Shift + → ขยายวันจบ", async () => {
    const user = userEvent.setup();
    mount();
    (await screen.findByTestId("bar-DE-1")).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(patches[0]?.body).toEqual({ planStart: "2026-12-01", planEnd: "2026-12-05" }));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(patches[1]?.body).toEqual({ planEnd: "2026-12-05" }));
  });

  it("หลัง Baseline ถามเหตุผลแล้วส่งซ้ำ · ไม่มีสิทธิ์เลื่อน Due → ฟอร์มขอเลื่อน (K3)", async () => {
    const user = userEvent.setup();
    mount();
    (await screen.findByTestId("bar-DE-3")).focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const dialog = await screen.findByRole("dialog", { name: "เหตุผลที่แก้แผน" });
    await user.type(within(dialog).getByRole("textbox"), "ลูกค้าขอเพิ่ม");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ planEnd: "2026-12-19", planChangeReason: "ลูกค้าขอเพิ่ม" }));
    bar("DE-2").focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const req = await screen.findByRole("dialog", { name: "ขอเลื่อน Due" });
    await user.selectOptions(within(req).getByLabelText("เหตุผล"), "waiting_input");
    await user.click(within(req).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(requests).toEqual([{ requestedDue: "2026-12-03", reasonCode: "waiting_input" }]));
    expect(await screen.findByText("ส่งคำขอเลื่อน Due ของ DE-2 แล้ว")).toBeInTheDocument();
  });

  it("ลากงาน Unscheduled ไปวางบนแถว = กำหนดวันเริ่มตามตำแหน่งที่วาง", async () => {
    mount();
    const chip = await screen.findByTestId("unscheduled-DE-9");
    const lane = bar("DE-1").parentElement!;
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 36, width: 1000, height: 36, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.dragStart(chip);
    fireEvent.dragOver(lane);
    const drop = createEvent.drop(lane);
    Object.defineProperty(drop, "clientX", { value: 10 * PX_PER_DAY.day + 2 });
    fireEvent(lane, drop);
    // แกนเริ่มวันที่ 1 ของเดือน (1 พ.ย. 2569) → วันที่ 10 = 11 พ.ย.
    await waitFor(() => expect(patches[0]).toEqual({ key: "DE-9", body: { planStart: "2026-11-11", planEnd: "2026-11-11" }, etag: '"5"' }));
  });

  it("สีตาม Module / Status / Assignee", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("bar-DE-3");
    expect(bar("DE-3").style.background).toBe("rgb(29, 78, 216)");
    await user.selectOptions(screen.getByLabelText("สีตาม"), "status");
    expect(bar("DE-3").style.background).toBe("rgb(138, 148, 160)");
    await user.selectOptions(screen.getByLabelText("สีตาม"), "assignee");
    expect(bar("DE-3").style.background).toBe("rgb(148, 163, 184)"); // ไม่มีผู้รับผิดชอบ = เทา
  });

  it("Guest: ไม่มีชื่อคน ไม่มีสีตาม Assignee ลากไม่ได้ และเปิดได้เฉพาะงานที่แชร์", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: null, guestViewer: true, permissions: ["project.view"] })));
    const g = data();
    g.modules[0].groups[0].tasks = [{ ...row("DE-1", "2026-11-30", "2026-12-04"), assignees: undefined, canOpen: false }, { ...row("DE-3", "2026-12-07", "2026-12-18"), assignees: undefined, canOpen: true }];
    d = g;
    mount();
    await screen.findByTestId("bar-DE-1");
    expect(bar("DE-1")).not.toHaveAccessibleName(/ผู้พัฒนาหนึ่ง/);
    expect(screen.queryByTestId("end-DE-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "งาน DE-1" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "งาน DE-3" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Assignee/ })).not.toBeInTheDocument();
  });

  it("ว่าง · Error มี requestId · 403", async () => {
    d = { ...data(), modules: [], unscheduled: [] };
    const a = mount();
    expect(await screen.findByText("ยังไม่มีงานที่ลงแผน")).toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/timeline", () => errorBody(500)));
    const b = mount();
    expect(await screen.findByText(/req_w07_001/)).toBeInTheDocument();
    b.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/timeline", () => errorBody(403)));
    mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("ตัวช่วยวันที่", () => {
    expect(toDay("2026-12-02", "2026-11-30")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

it("เพิ่ม Milestone ใน Timeline แล้วรีเฟรชโดยไม่ไป Settings", async () => {
  const user = userEvent.setup(); server.use(http.post("*/api/v1/w/:ws/projects/:key/milestones", async ({ request }) => { const body = await request.json() as { name: string; date: string; moduleId: string | null }; expect(body).toEqual({ name: "เป้าหมายใหม่", date: "2026-12-02", moduleId: "m-a" }); d.milestones.push({ id: "ms-new", ...body }); return HttpResponse.json({ id: "ms-new", ...body }, { status: 201 }); }));
  mount(); await user.click(await screen.findByRole("button", { name: "+ Milestone" })); const dialog = within(screen.getByRole("dialog", { name: "เพิ่ม Milestone" })); await user.type(dialog.getByLabelText("ชื่อ Milestone"), "เป้าหมายใหม่"); await user.selectOptions(dialog.getByLabelText("Module"), "m-a"); await user.click(dialog.getByRole("button", { name: "เพิ่ม" })); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument()); expect(screen.getByText("เป้าหมายใหม่")).toBeInTheDocument(); expect(navigation.pathname).toBe("/w/sample/p/DE/timeline");
});
