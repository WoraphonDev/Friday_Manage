// W08 · Gantt · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import gantt from "../../messages/th/gantt.json";
import { GanttView, SCALE_PX, depPath, type GRow, type GanttData, type Preview } from "../../app/work/[ws]/p/[key]/gantt/_components/gantt-view";

const person = (id: string, displayName: string) => ({ id, displayName });
const row = (key: string, start: string, end: string, over: Partial<GRow> = {}): GRow => ({ key, type: "Task", title: `งาน ${key}`, status: { name: "In progress", category: "in_progress" }, start, end, estimateMd: 2, progressPct: 40, lateDays: 0, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")], subtasks: [], critical: false, slackDays: 2, ...over });

function data(baseline: number | null): GanttData {
  const sum = { progressPct: 30, lateDays: 0, taskCount: 4 };
  const withBase = (r: GRow, start: string, end: string, slip: number) => (baseline ? { ...r, baseline: { start, end }, slipDays: slip } : r);
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", startDate: "2026-11-30", goliveDate: "2027-01-29" },
    today: "2026-12-02",
    range: { from: "2026-11-30", to: "2026-12-25" },
    lastEnd: "2026-12-18",
    sprints: [],
    milestones: [{ id: "ms1", name: "ทบทวนรอบแรก", date: "2026-12-11", moduleId: "m-a" }],
    modules: [{
      id: "m-a", name: "Module A", color: null, start: "2026-11-30", end: "2026-12-18", ...sum,
      groups: [{
        phase: { id: "ph1" }, name: "กลุ่มงานแรก", start: "2026-11-30", end: "2026-12-18", ...sum,
        tasks: [
          withBase(row("DE-1", "2026-11-30", "2026-12-04", { critical: true, slackDays: 0 }), "2026-11-30", "2026-12-04", 0),
          withBase(row("DE-3", "2026-12-07", "2026-12-11", { critical: true, slackDays: 0, lateDays: 2 }), "2026-12-03", "2026-12-08", 3),
          row("DE-4", "2026-12-01", "2026-12-09", { subtasks: [row("DE-5", "2026-12-01", "2026-12-03")] }),
          row("DE-6", "2026-12-09", "2026-12-10", { assignees: [] }),
        ],
      }],
    }],
    unscheduled: [{ key: "DE-9" }],
    baselines: [{ version: 2, name: "แผนรอบสอง", source: "manual", createdAt: "2026-11-20T03:00:00Z" }, { version: 1, name: "แผนแรก", source: "import", createdAt: "2026-11-01T03:00:00Z" }],
    baseline: baseline ? { version: baseline, name: baseline === 2 ? "แผนรอบสอง" : "แผนแรก", createdAt: "2026-11-20T03:00:00Z" } : null,
    dependencies: [
      { from: "DE-1", to: "DE-3", type: "FS", lagDays: 0, critical: true },
      { from: "DE-1", to: "DE-6", type: "FS", lagDays: 2, critical: false },
    ],
    criticalPath: { keys: ["DE-1", "DE-3"], startDate: "2026-11-30", endDate: "2026-12-11" },
    ignoredDependencies: 0,
  };
}

const preview: Preview = {
  items: [
    { key: "DE-3", title: "งาน DE-3", planStart: "2026-12-08", planEnd: "2026-12-14", previousStart: "2026-12-07", previousEnd: "2026-12-11", shiftDays: 1, because: ["DE-1"] },
    { key: "DE-6", title: "งาน DE-6", planStart: "2026-12-11", planEnd: "2026-12-14", previousStart: "2026-12-09", previousEnd: "2026-12-10", shiftDays: 2, because: ["DE-1"] },
    { key: "DE-5", title: "งาน DE-5", planStart: "2026-12-02", planEnd: "2026-12-04", previousStart: "2026-12-01", previousEnd: "2026-12-03", shiftDays: 1, because: [] },
  ],
  summary: { moved: 3, checked: 5 },
  projectEnd: { before: "2026-12-11", after: "2026-12-14" },
  warnings: [{ code: "golive_exceeded", message: "หลังเลื่อน งานสุดท้ายจบเลยวัน Go-live" }],
};

let gets: (string | null)[];
let patches: { key: string; body: Record<string, unknown>; etag: string | null }[];
let posts: { path: string; body: unknown }[];
let empty: boolean;
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "guest_view_limited" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w08_001" } }, { status });

beforeEach(() => {
  gets = []; patches = []; posts = []; empty = false;
  navigation.pathname = "/work/sample/p/DE/gantt";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/gantt", ({ request }) => {
      const b = new URL(request.url).searchParams.get("baseline");
      gets.push(b);
      const d = data(b ? Number(b.slice(1)) : null);
      return HttpResponse.json(empty ? { ...d, modules: [], milestones: [], unscheduled: [] } : d);
    }),
    http.post("*/api/v1/w/:ws/projects/:key/baselines", async ({ request }) => { posts.push({ path: "baselines", body: await request.json() }); return HttpResponse.json({ version: 3 }, { status: 201 }); }),
    http.post("*/api/v1/w/:ws/projects/:key/schedule/preview", () => HttpResponse.json(preview)),
    http.get("*/api/v1/w/:ws/issues/:key", () => HttpResponse.json({ version: 7 })),
    http.patch("*/api/v1/w/:ws/issues/:key", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ key: String(params.key), body, etag: request.headers.get("if-match") });
      if (params.key === "DE-5") return HttpResponse.json({ error: { code: "due_change_requires_approval", message: "ต้องขออนุมัติ" } }, { status: 403 });
      if (!body.planChangeReason) return HttpResponse.json({ error: { code: "plan_change_reason_required", message: "ต้องใส่เหตุผล" } }, { status: 400 });
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/v1/w/:ws/issues/:key/due-requests", async ({ request }) => { posts.push({ path: "due-requests", body: await request.json() }); return HttpResponse.json({ id: "dr" }, { status: 201 }); }),
  );
});
const mount = () => renderWithProviders(<WorkspaceShell ws="sample"><GanttView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { gantt } });
const bar = (key: string) => screen.getByTestId(`bar-${key}`);
const px = (el: Element, prop: "left" | "width") => Number((el as HTMLElement).style[prop].replace("px", ""));
const asViewer = () => server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "viewer", permissions: ["project.view"] })));

describe("Gantt (5)", () => {
  it("WBS: Module › กลุ่ม › Task › Sub-task (กลุ่มไม่บังคับ) พร้อมคอลัมน์ Owner / MD / Start / End / % / Pred. และ Milestone", async () => {
    mount();
    expect(await screen.findByTestId("bar-DE-1")).toBeInTheDocument();
    for (const w of ["1", "1.1", "1.1.1", "1.1.2", "1.1.3", "1.1.3.1", "1.1.4", "M1"]) expect(screen.getByText(w, { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("กลุ่มงานแรก")).toBeInTheDocument();
    expect(screen.getByTestId("pred-DE-3")).toHaveTextContent("1.1.1 FS");
    expect(screen.getByTestId("pred-DE-6")).toHaveTextContent("1.1.1 FS+2");
    expect(screen.getByRole("link", { name: "DE-3 งาน DE-3" })).toHaveAttribute("href", "/work/sample/p/DE/gantt?issue=DE-3");
    // งานแม่ (มี Sub-task) เป็น Summary bar · Sub-task เป็น bar
    expect(screen.getByRole("img", { name: /^DE-4 งาน DE-4:/ })).toBeInTheDocument();
    expect(screen.queryByTestId("bar-DE-4")).not.toBeInTheDocument();
    expect(bar("DE-5")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Milestone ทบทวนรอบแรก/ })).toBeInTheDocument();
    // Day = 21px ต่อวัน · 5 วัน − ขอบ 2px สองข้าง
    expect(px(bar("DE-1"), "width")).toBe(5 * SCALE_PX.day - 4);
    expect(screen.getByText(/1 งานยังไม่มีวันที่/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 งานเลยกำหนด");
  });

  it("Scale Day / Week / Month และ Expand level 1 / 2 / 3", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("bar-DE-1");
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(px(bar("DE-1"), "width")).toBe(5 * SCALE_PX.week);
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(px(bar("DE-1"), "width")).toBe(5 * SCALE_PX.month);
    // ระดับ 1 = Module · 2 = + Task · 3 = + Sub-task (ไม่มีชั้นกลุ่มงานแล้ว)
    await user.click(screen.getByRole("button", { name: "ระดับ 1" }));
    expect(screen.queryByTestId("bar-DE-1")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(bar("DE-1")).toBeInTheDocument();
    expect(screen.queryByTestId("bar-DE-5")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "3" }));
    expect(bar("DE-5")).toBeInTheDocument();
  });

  it("Dependency arrows และ Critical path · ปิด Critical path แล้วไม่เน้นสีแดง", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("bar-DE-1");
    expect(screen.getByTestId("dep-DE-1-DE-3")).toHaveAttribute("data-critical", "true");
    expect(screen.getByTestId("dep-DE-1-DE-6")).not.toHaveAttribute("data-critical");
    expect(bar("DE-1")).toHaveAttribute("data-critical", "true");
    expect(bar("DE-1")).toHaveAccessibleName(/อยู่บน Critical path/);
    expect(bar("DE-6")).toHaveAccessibleName(/เผื่อได้ 2 วันทำการ/);
    expect(screen.getByText(/Critical path 2 งาน/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Critical path" }));
    expect(screen.getByRole("button", { name: "Critical path" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("dep-DE-1-DE-3")).not.toHaveAttribute("data-critical");
    expect(bar("DE-1")).not.toHaveAttribute("data-critical");
  });

  it("เลยกำหนด: แดงจากหัวแถบถึงเส้นวันนี้ เฉพาะงานที่ยังไม่เสร็จ", async () => {
    // DE-1 (30 พ.ย.–4 ธ.ค.) คร่อมวันนี้ 2 ธ.ค. · DE-3 เลยกำหนดแต่เริ่ม 7 ธ.ค. หลังวันนี้ = ไม่มีแดง
    const withDe1 = (over: Partial<GRow>) => {
      const d = data(null);
      const tasks = d.modules[0]!.groups[0]!.tasks;
      tasks[0] = { ...tasks[0]!, ...over };
      server.use(http.get("*/api/v1/w/:ws/projects/:key/gantt", () => HttpResponse.json(d)));
    };
    withDe1({ lateDays: 1 });
    const first = mount();
    await screen.findByTestId("bar-DE-1");
    const red = parseFloat(screen.getByTestId("late-DE-1").style.width);
    expect(red).toBeGreaterThan(0);
    expect(red).toBeLessThan(parseFloat(bar("DE-1").style.width));
    expect(screen.queryByTestId("late-DE-3")).not.toBeInTheDocument();
    first.unmount();
    // ปิดงานแล้วไม่แดง แม้ยังมีวันที่เลย
    withDe1({ lateDays: 1, status: { name: "Done", category: "done" } });
    mount();
    await screen.findByTestId("bar-DE-1");
    expect(screen.queryByTestId("late-DE-1")).not.toBeInTheDocument();
  });

  it("แผน vs จริง: เลือก Baseline ล่าสุดให้ · เปลี่ยน version · แสดงแถบ Baseline และ slip · ปิดได้", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByTestId("baseline-DE-3")).toBeInTheDocument();
    expect(gets).toEqual([null, "v2"]);
    expect(bar("DE-3")).toHaveAccessibleName(/ช้ากว่า Baseline 3 วัน/);
    expect(screen.getByText("+3 วัน")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 งานช้ากว่า Baseline v2");
    await user.selectOptions(screen.getByLabelText("เทียบกับ Baseline"), "1");
    await waitFor(() => expect(gets.at(-1)).toBe("v1"));
    await user.click(screen.getByRole("button", { name: "แผน vs จริง" }));
    await waitFor(() => expect(screen.queryByTestId("baseline-DE-3")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("เทียบกับ Baseline")).not.toBeInTheDocument();
  });

  it("ตั้ง Baseline ใหม่ (project.baseline) แล้วเทียบกับ version ที่ได้", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "ตั้งเป็นแผนใหม่ (Baseline v3)" }));
    const dialog = await screen.findByRole("dialog", { name: "ตั้งเป็นแผนใหม่" });
    await user.type(within(dialog).getByLabelText("ชื่อ Baseline (ไม่บังคับ)"), "หลังเพิ่มขอบเขต");
    await user.click(within(dialog).getByRole("button", { name: "ตั้ง Baseline" }));
    await waitFor(() => expect(posts).toEqual([{ path: "baselines", body: { name: "หลังเพิ่มขอบเขต" } }]));
    expect(await screen.findByText("ตั้ง Baseline v3 แล้ว")).toBeInTheDocument();
    await waitFor(() => expect(gets.at(-1)).toBe("v3"));
  });

  it("Auto-schedule: ดูตัวอย่าง → ยืนยัน PATCH ทีละงานพร้อม If-Match · ถามเหตุผลครั้งเดียว · ต้องอนุมัติ → ขอเลื่อน Due", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Auto-schedule" }));
    const dialog = await screen.findByRole("dialog", { name: "Auto-schedule (ตัวอย่าง)" });
    expect(await within(dialog).findByTestId("preview-DE-3")).toHaveTextContent(/\+1 วันทำการ/);
    expect(within(dialog).getByTestId("preview-DE-6")).toHaveTextContent("เพราะ DE-1");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Go-live");
    expect(patches).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "ยืนยันเลื่อน 3 งาน" }));
    await user.type(await within(dialog).findByLabelText("เหตุผลที่แก้แผน"), "งานก่อนหน้าเลื่อน");
    await user.click(within(dialog).getByRole("button", { name: "บันทึกต่อ" }));
    expect(await within(dialog).findByText("เลื่อนแล้ว 2 งาน")).toBeInTheDocument();
    expect(patches).toEqual([
      { key: "DE-3", body: { planStart: "2026-12-08", planEnd: "2026-12-14" }, etag: '"7"' },
      { key: "DE-3", body: { planStart: "2026-12-08", planEnd: "2026-12-14", planChangeReason: "งานก่อนหน้าเลื่อน" }, etag: '"7"' },
      { key: "DE-6", body: { planStart: "2026-12-11", planEnd: "2026-12-14", planChangeReason: "งานก่อนหน้าเลื่อน" }, etag: '"7"' },
      { key: "DE-5", body: { planStart: "2026-12-02", planEnd: "2026-12-04", planChangeReason: "งานก่อนหน้าเลื่อน" }, etag: '"7"' },
    ]);
    await user.click(within(dialog).getByRole("button", { name: "ขอเลื่อน Due" }));
    const req = await screen.findByRole("dialog", { name: "ขอเลื่อน Due" });
    await user.click(within(req).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(posts).toEqual([{ path: "due-requests", body: { requestedDue: "2026-12-04", reasonCode: "blocked_by_dependency" } }]));
    expect(await screen.findByText("ส่งคำขอแล้ว")).toBeInTheDocument();
  });

  it("Viewer: ไม่เห็น Auto-schedule และตั้ง Baseline", async () => {
    asViewer();
    mount();
    await screen.findByTestId("bar-DE-1");
    expect(screen.queryByRole("button", { name: "Auto-schedule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ตั้งเป็นแผนใหม่/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Critical path" })).toBeInTheDocument();
  });

  it("ว่าง · Error มี requestId · 403 · Guest", async () => {
    empty = true;
    const a = mount();
    expect(await screen.findByText("ยังไม่มีงานที่ลงแผน")).toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/gantt", () => errorBody(500)));
    const b = mount();
    expect(await screen.findByText(/req_w08_001/)).toBeInTheDocument();
    b.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/gantt", () => errorBody(403)));
    const c = mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
    c.unmount();
    gets = [];
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: null, guestViewer: true, permissions: ["project.view"] })));
    mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
    expect(gets).toEqual([]);
  });

  it("เส้น Dependency: FS เข้าทางซ้ายของวันเริ่ม · FF เข้าทางขวาของวันจบ · ถอยกลับเมื่อชิดกัน", () => {
    expect(depPath("FS", { x0: 0, x1: 100, y: 18 }, { x0: 140, x1: 200, y: 54, top: 36 })).toEqual(["M100 18 H107 V54 H140", "M140 54 L134 50 L134 58 Z"]);
    expect(depPath("FS", { x0: 0, x1: 100, y: 18 }, { x0: 102, x1: 200, y: 54, top: 36 })[0]).toBe("M100 18 H107 V36 H94 V54 H102");
    expect(depPath("FF", { x0: 0, x1: 100, y: 18 }, { x0: 40, x1: 80, y: 54, top: 36 })).toEqual(["M100 18 H107 V54 H80", "M80 54 L86 50 L86 58 Z"]);
  });
});
