// W05 · Overview และ Table · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { overview } from "@/test/overview-fixture";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import ot from "../../messages/th/overview-table.json";
import ldr from "../../messages/th/lead-dashboard-reports.json";
import { OverviewPage } from "../../app/work/[ws]/p/[key]/table/_components/overview";
import { TableView, buildDisplay, stuckGroups } from "../../app/work/[ws]/p/[key]/table/_components/table-view";
import type { Overview, Row, TableData } from "../../app/work/[ws]/p/[key]/table/_components/types";

const person = (id: string, displayName: string) => ({ id, displayName });
const agg = (n = 1) => ({ taskCount: n, subtaskCount: 0, doneCount: 0, estimateMd: 3, progressPct: 10 });
function row(key: string, over: Partial<Row> = {}): Row {
  return { id: `id-${key}`, key, type: "Task", parentKey: null, title: `งาน ${key}`, status: { id: "st-todo", name: "To do", category: "todo" }, priority: "medium", moduleId: "m-a", phaseId: null, size: "S", estimateMd: 3, progressPct: 0, planStart: "2026-12-01", planEnd: "2026-12-03", actualStart: null, actualEnd: null, version: 2, assignees: [person("u1", "ผู้พัฒนาหนึ่ง")], ba: null, ...over };
}
function table(items: Row[] = [row("DE-1", { requirements: ["FR-01.2"], screens: ["SCR-101"] }), row("DE-2", { parentKey: "DE-1" }), row("DE-3", { moduleId: "m-b" })]): TableData {
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
  navigation.pathname = "/work/sample/p/DE";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/overview", ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json(overview()); }),
    // ตรวจโครง Overview พื้นฐาน (ไม่มีสิทธิ์ดู Workload) · ส่วนแผนที่รวมเข้ามาตรวจใน lead-dashboard-reports.test.tsx
    http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, permissions: permissions.permissions.filter((p) => p !== "project.workload.view") })),
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
const mount = (ui: React.ReactElement) => renderWithProviders(<WorkspaceShell ws="sample">{ui}</WorkspaceShell>, { messages: { "overview-table": ot, "lead-dashboard-reports": ldr } });

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
    expect(screen.getByRole("link", { name: "งานที่เลยกำหนด" })).toHaveAttribute("href", "/work/sample/p/DE?issue=DE-23");
    expect(screen.getByText("เลย 9 วัน")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เปิดใน Table →" })).toHaveAttribute("href", "/work/sample/p/DE/table?overdue=true");
    expect(screen.getByRole("img", { name: "ความคืบหน้าโครงการ 22 เปอร์เซ็นต์" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Overdue7/ })).toHaveTextContent("เลยกำหนดส่งและยังไม่ Done");
    await userEvent.setup().click(screen.getByRole("button", { name: /Due today2/ }));
    expect(screen.getByRole("link", { name: "งานครบวันนี้" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Progress by Module" })).getByText("Overdue 3", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText("Go-live ระยะแรก")).toHaveLength(3); // Milestone ถัดไป (จอใหญ่ + การ์ดมือถือ M6) + รายการ Milestones
    // M6: ความเสี่ยงสร้างจาก Health / Module บนมือถือ
    expect(screen.getByText("ผู้พัฒนาหนึ่ง มีงาน Overdue 4 งาน")).toBeInTheDocument();
    // ไม่มีสิทธิ์ดู Workload: ใช้การ์ด Workload สัปดาห์นี้ และไม่มีส่วนแผน (ความเสี่ยง, ตาราง Module, ปุ่มรายงาน)
    expect(screen.getByText("6 / 5 MD · 120%")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ความเสี่ยงที่ระบบพบในแผน" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ดูความเสี่ยงในแผน" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "สร้างรายงานประจำสัปดาห์" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /งานที่เสร็จรายวัน/ })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Burn-up" }));
    expect(screen.getByRole("img", { name: /Burn-up รายสัปดาห์/ })).toBeInTheDocument();
  });

  it("ติ๊ก checkbox ในรายการแล้วปิดงานด้วยสถานะ Done ของประเภทงานพร้อม version ล่าสุด", async () => {
    server.use(http.get("*/api/v1/w/:ws/issues/:key", () => HttpResponse.json({ key: "DE-23", type: "Task", version: 7 })));
    const user = userEvent.setup();
    mount(<OverviewPage ws="sample" projectKey="DE" />);
    await user.click(await screen.findByRole("checkbox", { name: "ทำเครื่องหมายว่าเสร็จ: งานที่เลยกำหนด" }));
    await waitFor(() => expect(patches).toEqual([{ key: "DE-23", body: { statusId: "st-done" }, etag: '"7"' }]));
    expect(await screen.findByText("ปิดงาน DE-23 แล้ว")).toBeInTheDocument();
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
    // Actual แยกเป็นสองคอลัมน์ · ตารางกว้างตามคอลัมน์ที่เปิด (เลื่อนแนวนอนในกล่อง)
    expect(screen.getByRole("columnheader", { name: "Actual Start" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actual End" })).toBeInTheDocument();
    // หัวตารางแยกเป็นตารางของตัวเอง (ติดใต้ top bar) กว้างเท่าตัวตารางเสมอ คอลัมน์จึงตรงกัน
    const [head, body] = screen.getAllByRole("table");
    expect(Number.parseInt(body.style.minWidth)).toBeGreaterThan(1100);
    expect(head.style.minWidth).toBe(body.style.minWidth);
    // FR / Screen ซ่อนไว้ก่อน เปิดได้จากเมนู Columns
    expect(screen.queryByRole("columnheader", { name: "FR / Screen" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("checkbox", { name: "FR / Screen" }));
    expect(screen.getByRole("columnheader", { name: "FR / Screen" })).toBeInTheDocument();
    expect(within(screen.getByTestId("row-DE-1")).getByText("FR-01.2 · SCR-101")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("searchbox", { name: "ค้นหางาน, รหัส DP-…, FR หรือ SCR" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ย่อ Module A" }));
    expect(screen.queryByTestId("row-DE-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("row-DE-3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    // Status / Priority / ระดับ อยู่ในแผง Filter ตาม Canvas
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.selectOptions(screen.getByLabelText("Status"), "done");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("status")).toBe("done"));
    expect(screen.getByRole("button", { name: /Filter/ })).toHaveTextContent("Filter1");
    await user.keyboard("{Escape}");
    await user.selectOptions(screen.getByLabelText("Dev"), "me");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("assignee")).toBe("me"));
    await user.selectOptions(screen.getByLabelText("BA"), "u2");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("ba")).toBe("u2"));
    await user.click(screen.getByRole("checkbox", { name: "Show completed" }));
    await user.click(screen.getByRole("button", { name: /Filter/ }));
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("status")).toBe("todo,in_progress"));
  });

  it("คอลัมน์ตามชุดฟิลด์ของโปรเจกต์: ลำดับ, ฟิลด์ที่ซ่อน, Custom field · ซ่อนเฉพาะระดับ Sub-task · เลือกคอลัมน์เองจำในเครื่อง", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    const opt = { task: "optional", subtask: "optional" };
    server.use(http.get("*/api/v1/w/:ws/projects/:key", () => HttpResponse.json({
      key: "DE",
      fieldProfile: {
        fields: { ba: { task: "hidden", subtask: "hidden" }, sa: opt, reviewer: opt, priority: opt, size: { task: "required", subtask: "hidden" }, actual: opt, progress: opt, requirements: opt, screens: opt, labels: opt, remark: opt },
        columns: ["dev", "status", "cf:cf1", "size", "end"],
        template: { id: "t1", name: "งานปฏิบัติการ", builtin: false },
      },
      customFields: [{ id: "cf1", name: "ลูกค้า", fieldType: "select", options: { choices: [{ id: "k1", label: "ร้าน ก" }, { id: "k2", label: "ร้าน ข" }] }, taskMode: "optional", subtaskMode: "optional" }],
    })));
    tableData = table([row("DE-1", { customFields: { cf1: "k1" } }), row("DE-2", { parentKey: "DE-1", size: "XS" })]);
    const a = mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "ลูกค้า" })).toBeInTheDocument());
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Dev", "Status", "ลูกค้า", "Size · MD", "Plan End"]);
    // BA ซ่อนทั้งสองระดับ: ไม่มีตัวกรอง BA · Size ยังใช้ใน Task จึงกรองได้
    expect(screen.queryByLabelText("BA")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Size")).toBeInTheDocument();
    expect(within(screen.getByTestId("row-DE-1")).getByText("ร้าน ก")).toBeInTheDocument();
    // Size ซ่อนในระดับ Sub-task: แถว Sub-task ไม่แสดงค่าและแก้ไม่ได้
    expect(within(screen.getByTestId("row-DE-2")).queryByRole("button", { name: /แก้ Size/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("row-DE-2")).getByTitle("ไม่ใช้ในระดับนี้")).toBeInTheDocument();
    // แก้ค่า Custom field ในแถว
    await user.click(within(screen.getByTestId("row-DE-1")).getByRole("button", { name: "แก้ ลูกค้า ของ DE-1" }));
    await user.click(await screen.findByRole("button", { name: "ร้าน ข" }));
    await waitFor(() => expect(patches.at(-1)).toMatchObject({ key: "DE-1", body: { customFields: { cf1: "k2" } }, etag: '"2"' }));
    // เมนู Columns: BA ซ่อนทั้งสองระดับจึงไม่มีให้เลือก · เปิด SA เพิ่มแล้วจำไว้ในเครื่อง
    await user.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.queryByRole("checkbox", { name: "BA" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "SA" }));
    expect(screen.getByRole("columnheader", { name: "SA" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    a.unmount();
    mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "SA" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("button", { name: "คืนค่าตามโปรเจกต์" }));
    expect(screen.queryByRole("columnheader", { name: "SA" })).not.toBeInTheDocument();
    window.localStorage.clear();
  });

  it("แก้ในแถว: Status ส่ง If-Match · แก้แผนหลัง Baseline ถามเหตุผลแล้วส่งซ้ำ", async () => {
    const user = userEvent.setup();
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.selectOptions(await screen.findByLabelText("แก้ Status ของ DE-1"), "st-done");
    await waitFor(() => expect(patches[0]).toEqual({ key: "DE-1", body: { statusId: "st-done" }, etag: '"2"' }));
    // Plan End แสดงเป็นข้อความ กดแล้วจึงเป็นช่องวันที่
    await user.click(screen.getByRole("button", { name: "แก้ Plan End ของ DE-1" }));
    const end = screen.getByLabelText("แก้ Plan End ของ DE-1");
    fireEvent.change(end, { target: { value: "2026-12-09" } });
    fireEvent.blur(end);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "ลูกค้าเพิ่มขอบเขต");
    await user.click(within(dialog).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ planEnd: "2026-12-09", planChangeReason: "ลูกค้าเพิ่มขอบเขต" }));
  });

  it("แก้ Dev / BA / Size / Plan Start / Actual Start ในแถว และเพิ่ม Sub-task ใต้ Task", async () => {
    const user = userEvent.setup(); const created: unknown[] = [];
    server.use(http.post("*/api/v1/w/:ws/projects/:key/issues", async ({ request }) => { created.push(await request.json()); return HttpResponse.json({ key: `DE-${90 + created.length}` }, { status: 201 }); }));
    mount(<TableView ws="sample" projectKey="DE" />);
    // Dev หลายคน: ส่งครั้งเดียวเมื่อกดเสร็จ ไม่ส่งทุกคลิก
    await user.click(await screen.findByRole("button", { name: "แก้ Dev ของ DE-1" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("option", { name: /ผู้พัฒนาสอง/ }));
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "เสร็จ" }));
    await waitFor(() => expect(patches.at(-1)).toEqual({ key: "DE-1", body: { assigneeIds: ["u1", "u2"] }, etag: '"2"' }));
    await user.click(screen.getByRole("button", { name: "แก้ BA ของ DE-1" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("option", { name: /ผู้พัฒนาสอง/ }));
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ baId: "u2" }));
    await user.click(screen.getByRole("button", { name: "แก้ Size · MD ของ DE-1" }));
    await user.click(await screen.findByRole("button", { name: "L" }));
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ size: "L" }));
    await user.click(screen.getByRole("button", { name: "แก้ Size · MD ของ DE-1" }));
    const md = await screen.findByLabelText("Man-Day"); await user.clear(md); await user.type(md, "4.5{Enter}");
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ estimateMd: 4.5 }));
    for (const [field, body] of [["Plan Start", { planStart: "2026-12-02" }], ["Actual Start", { actualStart: "2026-11-02" }]] as const) {
      await user.click(screen.getByRole("button", { name: `แก้ ${field} ของ DE-1` }));
      const input = screen.getByLabelText(`แก้ ${field} ของ DE-1`);
      fireEvent.change(input, { target: { value: Object.values(body)[0] } });
      fireEvent.blur(input);
      await waitFor(() => expect(patches.at(-1)?.body).toEqual(body));
    }
    // + Sub-task เฉพาะแถว Task · Enter สร้างแล้วพิมพ์ต่อได้ · Esc ปิด
    expect(screen.queryByRole("button", { name: "เพิ่ม Sub-task ใน DE-2" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เพิ่ม Sub-task ใน DE-1" }));
    const title = screen.getByLabelText("ชื่อ Sub-task ใหม่ใน DE-1");
    await user.type(title, "เขียน test{Enter}");
    await waitFor(() => expect(created).toEqual([{ type: "Task", parentKey: "DE-1", title: "เขียน test" }]));
    expect(title).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("ชื่อ Sub-task ใหม่ใน DE-1")).not.toBeInTheDocument();
  });

  it("หมายเหตุ: แสดงในคอลัมน์ · แก้ใน Textarea แล้วบันทึกด้วย ⌘/Ctrl+Enter · ล้างข้อความ = null", async () => {
    const user = userEvent.setup();
    tableData = table([row("DE-1", { remark: "รอข้อมูลจากทีมบัญชี\nบรรทัดที่สอง" }), row("DE-3", { moduleId: "m-b" })]);
    mount(<TableView ws="sample" projectKey="DE" />);
    expect(await screen.findByRole("columnheader", { name: "หมายเหตุ" })).toBeInTheDocument();
    expect(screen.getByTitle(/รอข้อมูลจากทีมบัญชี/)).toHaveTextContent("รอข้อมูลจากทีมบัญชี");
    await user.click(screen.getByRole("button", { name: "แก้ หมายเหตุ ของ DE-3" }));
    const box = within(await screen.findByRole("dialog")).getByRole("textbox", { name: "แก้ หมายเหตุ ของ DE-3" });
    await user.type(box, "ลูกค้าขอเลื่อน{Shift>}{Enter}{/Shift}รอยืนยัน");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(patches.at(-1)).toEqual({ key: "DE-3", body: { remark: "ลูกค้าขอเลื่อน\nรอยืนยัน" }, etag: '"2"' }));
    await user.click(screen.getByRole("button", { name: "แก้ หมายเหตุ ของ DE-1" }));
    const filled = within(await screen.findByRole("dialog")).getByRole("textbox");
    await user.clear(filled);
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ remark: null }));
  });

  it("Module / กลุ่มที่ดูอยู่ค้างใต้หัวตารางเมื่อเลื่อนผ่านแถวของมัน", () => {
    const data = table([row("DE-1", { phaseId: "p-1" }), row("DE-3", { moduleId: "m-b" })]);
    data.modules[0].phases.push({ ...data.modules[0].phases[0], id: "p-1", name: "Sprint 1" });
    const display = buildDisplay(data, new Set(), "-", "-");
    // แต่ละแถวสูง 40px เริ่มที่ y = 0 · หัวตารางสิ้นสุดที่ line
    const box = document.createElement("div");
    box.innerHTML = `<table><tbody>${display.map((_, i) => `<tr data-i="${i}"></tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("tr").forEach((tr, i) => { tr.getBoundingClientRect = () => ({ top: i * 40 - 1000, bottom: i * 40 + 40 - 1000 }) as DOMRect; });
    const at = (kind: string, name?: string) => display.findIndex((d) => d.kind === kind && (!name || ("name" in d && d.name === name)));
    const lineAt = (i: number) => i * 40 - 1000 + 1;
    expect(stuckGroups(box, display, -1000, 0)).toEqual({ module: null, phase: null });
    expect(stuckGroups(box, display, lineAt(display.findIndex((d) => d.kind === "issue" && d.row.key === "DE-1")), -1000)).toEqual({ module: at("module", "Module A"), phase: at("phase") });
    expect(stuckGroups(box, display, lineAt(display.findIndex((d) => d.kind === "issue" && d.row.key === "DE-3")), -1000)).toEqual({ module: at("module", "Module B"), phase: null });
  });

  it("เลือกหลายแถว → ย้าย Module / Due / Assignee และลบต้องพิมพ์ยืนยัน", async () => {
    const user = userEvent.setup();
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.click(await screen.findByLabelText("เลือก DE-1"));
    await user.click(screen.getByLabelText("เลือก DE-3"));
    const bar = screen.getByRole("region", { name: "2 รายการที่เลือก" });
    await user.click(within(bar).getByRole("button", { name: "ย้าย Module" }));
    await user.selectOptions(within(bar).getByLabelText("ย้าย Module"), "m-b");
    await user.click(within(bar).getByRole("button", { name: "ใช้" }));
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

  it("Status แบบหลายงานแก้ทีละงานพร้อม version · Group by Status", async () => {
    const user = userEvent.setup();
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.click(await screen.findByLabelText("เลือก DE-1"));
    await user.click(screen.getByLabelText("เลือก DE-3"));
    const bar = screen.getByRole("region", { name: "2 รายการที่เลือก" });
    await user.click(within(bar).getByRole("button", { name: "Status" }));
    await user.selectOptions(within(bar).getByLabelText("Status"), "st-done");
    await user.click(within(bar).getByRole("button", { name: "ใช้" }));
    await waitFor(() => expect(patches.map((p) => [p.key, p.body.statusId, p.etag]).sort()).toEqual([["DE-1", "st-done", '"2"'], ["DE-3", "st-done", '"2"']]));
    await user.selectOptions(screen.getByLabelText("Group by"), "status");
    expect(screen.getByRole("button", { name: "ย่อ To do" })).toBeInTheDocument();
  });

  it("300+ แถว render เฉพาะส่วนที่เห็น (virtualized) · ว่าง · Error", async () => {
    tableData = table(Array.from({ length: 450 }, (_, i) => row(`DE-${i + 1}`)));
    const a = mount(<TableView ws="sample" projectKey="DE" />);
    await screen.findByTestId("row-DE-1");
    expect(screen.queryByTestId("row-DE-400")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeLessThan(120);
    // ตารางใช้ scroll ของหน้า: จำลองว่าขอบบนตัวตารางเลื่อนพ้นหัวตารางขึ้นไป 390 แถว
    const scroll = screen.getByTestId("table-scroll");
    scroll.getBoundingClientRect = () => ({ top: -38 * 390, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: -38 * 390, toJSON: () => ({}) });
    fireEvent.scroll(window);
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

  it("buildDisplay จัด Sub-task ต่อท้ายแม่, มีแถวเพิ่มงาน + สรุปท้าย Module และซ่อน Module ที่ย่อ", () => {
    const d = buildDisplay(table(), new Set(["m-b"]), "-", "-");
    expect(d.map((x) => (x.kind === "issue" ? x.row.key : `${x.kind}:${x.kind === "module" ? x.name : ""}`))).toEqual(["module:Module A", "DE-1", "DE-2", "add:", "foot:", "module:Module B"]);
  });
});

describe("จัดโครงงานใน Table", () => {
  it("เพิ่ม Module ว่างแล้วเห็นทางเพิ่ม Task ใน Module นั้นทันที", async () => {
    const user = userEvent.setup(); const creates: unknown[] = [];
    server.use(http.post("*/api/v1/w/:ws/projects/:key/modules", async ({ request }) => {
      creates.push(await request.json()); tableData.modules.push({ id: "m-new", name: "Module ใหม่", color: "#1d4ed8", ...agg(0), phases: [{ id: null, name: null, ...agg(0) }] });
      return HttpResponse.json({ id: "m-new" }, { status: 201 });
    }));
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.click(await screen.findByRole("button", { name: "+ Module" }));
    await user.type(screen.getByLabelText("ชื่อ Module"), "Module ใหม่");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(creates).toEqual([{ name: "Module ใหม่", color: "#5b3fc4" }]);
    expect(screen.getByRole("link", { name: "+ เพิ่ม Task ใน Module ใหม่" })).toHaveAttribute("href", "/work/sample/p/DE/table?new=1&type=task&moduleId=m-new");
  });
  it("กลุ่ม (ไม่บังคับ): เพิ่มกลุ่มจากเมนู Module แล้วเพิ่ม Task ในกลุ่มนั้น · ลบกลุ่มแล้วงานไม่มีกลุ่ม", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/w/:ws/projects/:key/modules/:id/phases", async ({ request }) => {
        expect(await request.json()).toEqual({ name: "กลุ่มใหม่" }); tableData.modules[0].phases.unshift({ id: "ph-new", name: "กลุ่มใหม่", ...agg(0) }); return HttpResponse.json({ id: "ph-new" }, { status: 201 });
      }),
      http.delete("*/api/v1/w/:ws/projects/:key/modules/:id/phases/:phase", async ({ request, params }) => {
        expect(await request.json()).toEqual({ moveTo: "none" }); tableData.modules[0].phases = tableData.modules[0].phases.filter((p) => p.id !== params.phase); return HttpResponse.json({ movedIssues: 0, moveTo: null });
      }),
    );
    mount(<TableView ws="sample" projectKey="DE" />);
    await user.click(await screen.findByRole("button", { name: "จัดการ Module Module A" }));
    await user.click(screen.getByRole("button", { name: "เพิ่มกลุ่ม" }));
    await user.type(screen.getByLabelText("ชื่อกลุ่ม"), "กลุ่มใหม่");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "+ เพิ่ม Task ใน กลุ่มใหม่" })).toHaveAttribute("href", "/work/sample/p/DE/table?new=1&type=task&moduleId=m-a&phaseId=ph-new");
    // Task ที่ไม่มีกลุ่มอยู่ใต้ Module ก่อนหัวกลุ่ม
    const add = screen.getByRole("link", { name: "+ เพิ่ม Task ใน Module A" });
    expect(add.getAttribute("href")).not.toContain("phaseId=");
    await user.click(screen.getByRole("button", { name: "จัดการกลุ่ม กลุ่มใหม่" }));
    await user.click(screen.getByRole("button", { name: "ลบกลุ่ม" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "ลบกลุ่ม" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "+ เพิ่ม Task ใน กลุ่มใหม่" })).not.toBeInTheDocument());
  });
  it("เมื่อบันทึกไม่ผ่านคงข้อมูลและ requestId ให้แก้", async () => {
    const user = userEvent.setup(); server.use(http.post("*/api/v1/w/:ws/projects/:key/modules", () => errorBody(500)));
    mount(<TableView ws="sample" projectKey="DE" />); await user.click(await screen.findByRole("button", { name: "+ Module" })); await user.type(screen.getByLabelText("ชื่อ Module"), "ยังไม่สำเร็จ"); await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "เพิ่ม" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("req_w05_001"); expect(screen.getByLabelText("ชื่อ Module")).toHaveValue("ยังไม่สำเร็จ");
  });
  it("Sprint และ Backlog ใช้ตัวกรองที่ API รองรับ", async () => {
    const user = userEvent.setup(); mount(<TableView ws="sample" projectKey="DE" />); await user.click(await screen.findByRole("button", { name: "Sprint ปัจจุบัน" })); await waitFor(() => expect(urls.some((u) => u.searchParams.get("sprint") === "current")).toBe(true)); await user.click(screen.getByRole("button", { name: "Backlog" })); await waitFor(() => expect(urls.some((u) => u.searchParams.get("sprint") === "none")).toBe(true));
  });
});


it("เพิ่ม Module ในตาราง 450 แถวแล้วเลื่อนไปเห็นกลุ่มใหม่ที่อยู่นอกช่วง virtualized", async () => {
  const user = userEvent.setup(); tableData = table(Array.from({ length: 450 }, (_, index) => row(`DE-${index + 1}`)));
  server.use(http.post("*/api/v1/w/:ws/projects/:key/modules", () => {
    tableData.modules.push({ id: "m-last", name: "กลุ่มท้ายตาราง", color: null, ...agg(0), phases: [{ id: null, name: null, ...agg(0) }] });
    return HttpResponse.json({ id: "m-last" }, { status: 201 });
  }));
  mount(<TableView ws="sample" projectKey="DE" />); await user.click(await screen.findByRole("button", { name: "+ Module" })); await user.type(screen.getByLabelText("ชื่อ Module"), "กลุ่มท้ายตาราง"); await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "เพิ่ม" }));
  expect(await screen.findByRole("link", { name: "+ เพิ่ม Task ใน กลุ่มท้ายตาราง" })).toBeInTheDocument();
});
