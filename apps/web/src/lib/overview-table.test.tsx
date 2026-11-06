// W05 · Overview และ Table · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import ot from "../../messages/th/overview-table.json";
import { OverviewPage } from "../../app/w/[ws]/p/[key]/table/_components/overview";
import { TableView, buildDisplay } from "../../app/w/[ws]/p/[key]/table/_components/table-view";
import type { Overview, Row, TableData } from "../../app/w/[ws]/p/[key]/table/_components/types";

const person = (id: string, displayName: string) => ({ id, displayName });
function overview(): Overview {
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", clientName: "ลูกค้าตัวอย่าง", description: "ระบบตัวอย่างครบวงจร", status: "active", startDate: "2026-11-05", goliveDate: "2027-04-21", progressMethod: "weighted", owner: person("u0", "หัวหน้าตัวอย่าง"), memberCount: 12, moduleCount: 2, scope: { inScope: ["ระบบวงเงิน"], outScope: ["ระบบบัญชีเดิม"], deliverables: [], acceptance: [], assumptions: [] } },
    today: "2026-12-02",
    progress: { pct: 22, tasks: { done: 72, total: 334 }, md: { done: 189, total: 944, pct: 20 }, time: { elapsedWorkingDays: 20, totalWorkingDays: 111, pct: 18 }, remainingWorkingDays: 91, lastPlanEnd: "2027-04-21", nextMilestone: { id: "m1", name: "Go-live ระยะแรก", date: "2027-01-26", daysLeft: 55 } },
    health: { level: "off_track", plannedPct: 30, actualPct: 20, gapPct: 10, behindPlan: 45, overdue: { count: 7, topAssignee: { person: person("u1", "ผู้พัฒนาหนึ่ง"), count: 4 } }, capacity: { remainingMd: 700, teamMdPerWeek: 24, weeksNeeded: 29, weeksLeft: 24 } },
    kpis: { total: 334, done: 72, overdue: 7, overdueDelta: 2, dueToday: 2, laterThisWeek: 5, laterThisWeekRange: { from: "2026-12-03", to: "2026-12-06" }, doneLast7Days: 15, doneDelta: 4 },
    lists: {
      overdue: [{ key: "DE-23", type: "Task", title: "งานที่เลยกำหนด", status: { name: "In progress", category: "in_progress" }, module: { id: "m-a", name: "Module A", color: "#1d4ed8" }, phase: null, parentKey: null, planEnd: "2026-11-23", lateDays: 9, completedOn: null, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")] }],
      dueToday: [{ key: "DE-35", type: "Task", title: "งานครบวันนี้", status: { name: "To do", category: "todo" }, module: null, phase: null, parentKey: null, planEnd: "2026-12-02", lateDays: 0, completedOn: null, assignees: [] }],
      laterThisWeek: [],
      doneLast7Days: [],
    },
    doneDaily: [0, 1, 2, 3, 4, 5, 0].map((count, i) => ({ date: `2026-11-${String(26 + i).padStart(2, "0")}`.replace("2026-11-31", "2026-12-01").replace("2026-11-32", "2026-12-02"), count, workingDay: true })),
    burnup: { unit: "md", total: 944, points: [{ weekStart: "2026-11-02", weekEnd: "2026-11-08", planned: 50, done: 40 }, { weekStart: "2026-11-09", weekEnd: "2026-11-15", planned: 120, done: 100 }] },
    modules: [{ id: "m-a", name: "Module A", color: "#1d4ed8", pct: 30, done: 10, total: 40, overdue: 3, notStarted: false }, { id: "m-b", name: "Module B", color: null, pct: 0, done: 0, total: 20, overdue: 0, notStarted: true }],
    statusBreakdown: { columns: [{ id: "todo", name: "To do", category: "todo", count: 200, pct: 60 }, { id: "done", name: "Done", category: "done", count: 134, pct: 40 }] },
    milestones: [{ id: "m1", name: "Go-live ระยะแรก", date: "2027-01-26", daysLeft: 55, linkedIssues: 3, donePct: 40, basis: "linked" }],
    workloadThisWeek: { from: "2026-11-30", to: "2026-12-06", people: [{ person: person("u1", "ผู้พัฒนาหนึ่ง"), md: 6, capacityMd: 5, utilizationPct: 120, over: true }] },
    activity: [{ id: "a1", issue: { key: "DE-23", title: "งานที่เลยกำหนด" }, actor: person("u1", "ผู้พัฒนาหนึ่ง"), actorKind: "user", verb: "updated", field: "statusId", createdAt: "2026-12-02T02:00:00Z" }],
  };
}
const agg = (n = 1) => ({ taskCount: n, subtaskCount: 0, doneCount: 0, estimateMd: 3, progressPct: 10 });
function row(key: string, over: Partial<Row> = {}): Row {
  return { id: `id-${key}`, key, type: "Task", parentKey: null, title: `งาน ${key}`, status: { id: "st-todo", name: "To do", category: "todo" }, priority: "medium", moduleId: "m-a", phaseId: null, size: "S", estimateMd: 3, progressPct: 0, planStart: "2026-12-01", planEnd: "2026-12-03", actualStart: null, actualEnd: null, version: 2, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")], ba: null, ...over };
}
function table(items: Row[] = [row("DE-1"), row("DE-2", { parentKey: "DE-1" }), row("DE-3", { moduleId: "m-b" })]): TableData {
  return { items, nextCursor: null, summary: { ...agg(2), subtaskCount: 1 }, modules: [{ id: "m-a", name: "Module A", color: "#1d4ed8", ...agg(), phases: [{ id: null, name: null, ...agg() }] }, { id: "m-b", name: "Module B", color: null, ...agg(), phases: [{ id: null, name: null, ...agg() }] }, { id: null, name: null, color: null, ...agg(0), phases: [{ id: null, name: null, ...agg(0) }] }] };
}

let urls: URL[];
let patches: { key: string; body: Record<string, unknown>; etag: string | null }[];
let bulks: Record<string, unknown>[];
let views: { id: string; name: string; filters: Record<string, string>; shared: boolean; mine?: boolean }[];
let tableData: TableData;
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w05_001" } }, { status });

beforeEach(() => {
  urls = []; patches = []; bulks = []; views = []; tableData = table();
  navigation.pathname = "/w/sample/p/DE";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/overview", ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json(overview()); }),
    http.get("*/api/v1/w/:ws/projects/:key/issues", ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json(tableData); }),
    http.get("*/api/v1/w/:ws/projects/:key/form-options", () => HttpResponse.json({ issueTypes: [{ name: "Task", statuses: [{ id: "st-todo", name: "To do", category: "todo" }, { id: "st-done", name: "Done", category: "done" }] }], modules: [{ id: "m-a", name: "Module A" }, { id: "m-b", name: "Module B" }], members: [person("u1", "ผู้พัฒนาหนึ่ง"), person("u2", "ผู้พัฒนาสอง")] })),
    http.get("*/api/v1/w/:ws/projects/:key/saved-views", () => HttpResponse.json({ items: views })),
    http.post("*/api/v1/w/:ws/projects/:key/saved-views", async ({ request }) => { const b = (await request.json()) as { name: string; filters: Record<string, string>; shared: boolean }; views.push({ id: `v${views.length + 1}`, ...b, mine: true }); return HttpResponse.json(views.at(-1), { status: 201 }); }),
    http.patch("*/api/v1/w/:ws/issues/:key", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ key: String(params.key), body, etag: request.headers.get("if-match") });
      if (body.planEnd && !body.planChangeReason) return HttpResponse.json({ error: { code: "plan_change_reason_required", message: "ต้องใส่เหตุผล" } }, { status: 400 });
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/v1/w/:ws/projects/:key/issues/bulk", async ({ request }) => { const b = (await request.json()) as { keys: string[] }; bulks.push(b); return HttpResponse.json({ results: b.keys.map((key) => ({ key, ok: true })) }); }),
  );
});
const mount = (ui: React.ReactElement) => renderWithProviders(<WorkspaceShell ws="sample">{ui}</WorkspaceShell>, { messages: { "overview-table": ot } });

describe("Overview (1 / M6)", () => {
  it("ความคืบหน้า, Health, KPI พร้อมรายการ, Module, Status, Milestone, Workload, Activity", async () => {
    mount(<OverviewPage ws="sample" projectKey="DE" />);
    expect(await screen.findByText("72 / 334 งาน")).toBeInTheDocument();
    expect(screen.getByText("Man-Day เสร็จ 189 / 944 (20%)")).toBeInTheDocument();
    const health = screen.getByRole("status", { name: "Health: Off track" });
    expect(health).toHaveTextContent("45 งานช้ากว่าแผน");
    expect(health).toHaveTextContent("(ผู้พัฒนาหนึ่ง 4)");
    expect(health).toHaveTextContent("≈ 29 สัปดาห์ แต่แผนมี ≈ 24 สัปดาห์");
    expect(screen.getByRole("button", { name: /Overdue7/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "งานที่เลยกำหนด" })).toHaveAttribute("href", "/w/sample/p/DE?issue=DE-23");
    expect(screen.getByText("เลย 9 วัน")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เปิดใน Table →" })).toHaveAttribute("href", "/w/sample/p/DE/table?overdue=true");
    await userEvent.setup().click(screen.getByRole("button", { name: /ครบกำหนดวันนี้2/ }));
    expect(screen.getByRole("link", { name: "งานครบวันนี้" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Progress by Module" })).getByText("Overdue 3", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText("Go-live ระยะแรก", { selector: "b" })).toHaveLength(2); // Milestone ถัดไป + รายการ Milestones
    expect(screen.getByText("6 / 5 MD · 120%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /งานที่เสร็จรายวัน/ })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Burn-up" }));
    expect(screen.getByRole("img", { name: /Burn-up รายสัปดาห์/ })).toBeInTheDocument();
  });

  it("เปลี่ยนมุมมอง งานของฉัน / Module ส่ง query ใหม่", async () => {
    const user = userEvent.setup();
    mount(<OverviewPage ws="sample" projectKey="DE" />);
    await user.click(await screen.findByRole("button", { name: "งานของฉัน" }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("scope")).toBe("mine"));
    await user.selectOptions(screen.getByLabelText("กรอง Module"), "m-b");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("moduleId")).toBe("m-b"));
  });

  it("Error มี requestId · 403", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/overview", () => errorBody(500)));
    const a = mount(<OverviewPage ws="sample" projectKey="DE" />);
    expect(await screen.findByText(/req_w05_001/)).toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/overview", () => errorBody(403)));
    mount(<OverviewPage ws="sample" projectKey="DE" />);
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });
});

describe("Table (2)", () => {
  it("Module › Task › Sub-task · ย่อ / ขยาย · ตัวกรองส่ง query", async () => {
    const user = userEvent.setup();
    navigation.search = "overdue=true";
    mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    expect(urls.at(-1)?.searchParams.get("overdue")).toBe("true");
    expect(urls.at(-1)?.searchParams.get("view")).toBe("table");
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows.findIndex((r) => r.includes("DE-2"))).toBe(rows.findIndex((r) => r.includes("DE-1")) + 1);
    await user.click(screen.getByRole("button", { name: "ย่อ Module A" }));
    expect(screen.queryByTestId("row-DE-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("row-DE-3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await user.selectOptions(screen.getByLabelText("Status"), "done");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("status")).toBe("done"));
    await user.selectOptions(screen.getByLabelText("Dev"), "me");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("assignee")).toBe("me"));
    await user.click(screen.getByRole("button", { name: "แสดงงานที่เสร็จ" }));
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("status")).toBe("todo,in_progress"));
  });

  it("แก้ในแถว: Status / Priority ส่ง If-Match · แก้แผนหลัง Baseline ถามเหตุผลแล้วส่งซ้ำ", async () => {
    const user = userEvent.setup();
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.selectOptions(await screen.findByLabelText("แก้ Status ของ DE-1"), "st-done");
    await waitFor(() => expect(patches[0]).toEqual({ key: "DE-1", body: { statusId: "st-done" }, etag: '"2"' }));
    await user.selectOptions(screen.getByLabelText("แก้ Priority ของ DE-1"), "urgent");
    await waitFor(() => expect(patches[1].body).toEqual({ priority: "urgent" }));
    const end = screen.getByLabelText("แก้ Plan End ของ DE-1");
    fireEvent.change(end, { target: { value: "2026-12-09" } });
    fireEvent.blur(end);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "ลูกค้าเพิ่มขอบเขต");
    await user.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ planEnd: "2026-12-09", planChangeReason: "ลูกค้าเพิ่มขอบเขต" }));
  });

  it("เลือกหลายแถว → ย้าย Module / Due / Assignee และลบต้องพิมพ์ยืนยัน", async () => {
    const user = userEvent.setup();
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.click(await screen.findByLabelText("เลือก DE-1"));
    await user.click(screen.getByLabelText("เลือก DE-3"));
    const bar = screen.getByRole("region", { name: "2 รายการที่เลือก" });
    await user.selectOptions(within(bar).getByLabelText("ย้าย Module"), "m-b");
    await user.click(within(bar).getAllByRole("button", { name: "ใช้" })[0]);
    await waitFor(() => expect(bulks[0]).toEqual({ keys: ["DE-1", "DE-3"], set: { moduleId: "m-b" } }));
    expect(await screen.findByText("แก้ 2 งานแล้ว")).toBeInTheDocument();
    await user.click(screen.getByLabelText("เลือกทั้งหมดที่แสดง"));
    await user.click(within(screen.getByRole("region", { name: "3 รายการที่เลือก" })).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "ลบงานที่เลือก" });
    const go = within(dialog).getByRole("button", { name: "Delete" });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "ลบ 3 งาน");
    await user.click(go);
    await waitFor(() => expect(bulks.at(-1)).toEqual({ keys: ["DE-1", "DE-2", "DE-3"], delete: true, confirmText: "ลบ 3 งาน" }));
  });

  it("ไม่มีสิทธิ์แก้ = ไม่มีช่องเลือกและช่องแก้ · Guest = 403", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "viewer", permissions: ["project.view"] })));
    const a = mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    expect(screen.queryByLabelText("เลือก DE-1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("แก้ Status ของ DE-1")).not.toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, guestViewer: true, permissions: ["project.view"] })));
    mount(<TableView ws="sample" projectKey="DE" />);
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("Saved view: บันทึกตัวกรองปัจจุบันแล้วเลือกใช้ได้", async () => {
    const user = userEvent.setup();
    mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    await user.click(screen.getByRole("button", { name: "Overdue" }));
    await user.click(screen.getByRole("button", { name: "+ Save view" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("ชื่อ View"), "งานเลยกำหนด");
    await user.click(within(dialog).getByRole("button", { name: "ใช้" }));
    expect(await screen.findByRole("button", { name: "งานเลยกำหนด" })).toBeInTheDocument();
    expect(views[0]).toMatchObject({ name: "งานเลยกำหนด", filters: { overdue: "true" }, shared: false });
    await user.click(screen.getByRole("button", { name: "All tasks" }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("overdue")).toBeNull());
    await user.click(screen.getByRole("button", { name: "งานเลยกำหนด" }));
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("overdue")).toBe("true"));
  });

  it("300+ แถว render เฉพาะส่วนที่เห็น (virtualized) · ว่าง · Error", async () => {
    tableData = table(Array.from({ length: 450 }, (_, i) => row(`DE-${i + 1}`)));
    const a = mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    expect(screen.queryByTestId("row-DE-400")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeLessThan(120);
    const scroll = screen.getByTestId("table-scroll");
    fireEvent.scroll(scroll, { target: { scrollTop: 44 * 390 } });
    expect(await screen.findByTestId("row-DE-390")).toBeInTheDocument();
    expect(screen.queryByTestId("row-DE-1")).not.toBeInTheDocument();
    a.unmount();
    tableData = table([]);
    const b = mount(<TableView ws="sample" projectKey="DE" />);
    expect(await screen.findByText("ยังไม่มีงานในโปรเจกต์")).toBeInTheDocument();
    b.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/issues", () => errorBody(500)));
    mount(<TableView ws="sample" projectKey="DE" />);
    expect(await screen.findByText(/req_w05_001/)).toBeInTheDocument();
  });

  it("buildDisplay จัด Sub-task ต่อท้ายแม่ และซ่อน Module ที่ย่อ", () => {
    const d = buildDisplay(table(), new Set(["m-b"]), "-", "-");
    expect(d.map((x) => (x.kind === "issue" ? x.row.key : `${x.kind}:${x.kind === "module" ? x.name : ""}`))).toEqual(["module:Module A", "DE-1", "DE-2", "module:Module B"]);
  });
});
