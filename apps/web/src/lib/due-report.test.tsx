// รายงานงานที่จะเสร็จ (ผู้ใช้ขอ 2026-11-17) · ข้อมูลสมมติเท่านั้น
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import messages from "../../messages/th/lead-dashboard-reports.json";
import { ReportsView } from "../../app/work/[ws]/p/[key]/reports/_components/reports-view";
import type { DueReportResponse } from "../../app/work/[ws]/p/[key]/reports/_components/due-report";
import { DueButton, DuePopup } from "../../app/work/[ws]/p/[key]/reports/_components/due-popup";
import { fixture } from "@/features/issue-drawer/fixtures.test-support";
import { permissions } from "@/test/fixtures";

// วันนี้สมมติ: อ. 17 พ.ย. 2569 → สัปดาห์นี้ 16–22 พ.ย.
const NOW = new Date("2026-11-17T10:00:00+07:00");
const ba = { id: "ba-1", displayName: "นักวิเคราะห์ตัวอย่าง", initials: "นว", avatarUrl: null };
const sa = { id: "sa-1", displayName: "ผู้ออกแบบระบบตัวอย่าง", initials: "ผอ", avatarUrl: null };
const devA = { id: "dev-a", displayName: "ผู้พัฒนาตัวอย่างหนึ่ง", initials: "ผน", avatarUrl: null };
const devB = { id: "dev-b", displayName: "ผู้พัฒนาตัวอย่างสอง", initials: "ผส", avatarUrl: null };
const pay = { id: "mod-pay", name: "ระบบชำระตัวอย่าง", color: null };

function dueData(): DueReportResponse {
  return {
    range: { from: "2026-11-16", to: "2026-11-22" },
    asOf: "2026-11-17",
    options: {
      modules: [{ ...pay, count: 6 }, { id: "none", name: null, color: null, count: 1 }],
      ba: [{ ...ba, count: 5 }], sa: [{ ...sa, count: 4 }], dev: [{ ...devA, count: 3 }, { ...devB, count: 2 }],
    },
    summary: { taskCount: 3, md: 6.5, doneCount: 1, atRiskCount: 1, lateCount: 1 },
    tasks: [
      { id: "i1", key: "DE-12", title: "หน้าเลือกช่องทางตัวอย่าง", type: "Task", parentKey: null, module: pay, phase: "Sprint 3", ba, sa, devs: [devA, devB], estimateMd: 2, planStart: "2026-11-10", planEnd: "2026-11-16", progressPct: 60, status: { name: "In Progress", category: "in_progress" }, state: "late" },
      { id: "i2", key: "DE-18", title: "ทดสอบตัวอย่าง", type: "Sub-task", parentKey: "DE-12", module: pay, phase: "Sprint 3", ba, sa: null, devs: [devA], estimateMd: 1.5, planStart: "2026-11-16", planEnd: "2026-11-19", progressPct: 100, status: { name: "Done", category: "done" }, state: "done" },
      { id: "i3", key: "DE-20", title: "ใบเสร็จตัวอย่าง", type: "Task", parentKey: null, module: null, phase: null, ba: null, sa: null, devs: [], estimateMd: 3, planStart: "2026-11-12", planEnd: "2026-11-19", progressPct: 10, status: { name: "To do", category: "todo" }, state: "at_risk" },
    ],
    planSummary: { groupCount: 1, md: 18, progressPct: 67, slipCount: 1 },
    plans: [{
      module: pay, phase: { id: "ph-3", name: "Sprint 3" }, taskCount: 6, doneCount: 4, totalMd: 18, doneMd: 12, progressPct: 67,
      plannedEnd: "2026-11-21", forecastEnd: "2026-11-24", forecastReason: null, slipDays: 1, status: "at_risk",
      tasks: [{ key: "DE-12", title: "หน้าเลือกช่องทางตัวอย่าง", devs: [devA], estimateMd: 2, planEnd: "2026-11-16", progressPct: 60, state: "late" }],
    }],
    velocity: { windowDays: 28 },
  };
}

let requests: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requests = [];
  router.replace.mockClear();
  server.use(http.get("*/api/v1/w/:ws/projects/:key/reports/due", ({ request }) => {
    requests.push(new URL(request.url).searchParams.toString());
    return HttpResponse.json(dueData());
  }));
});
afterEach(() => { vi.useRealTimers(); });

const mount = (search: string) => { navigation.pathname = "/work/sample/p/DE/reports"; navigation.search = search; return renderWithProviders(<WorkspaceShell ws="sample"><ReportsView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { "lead-dashboard-reports": messages } }); };
const lastUrl = () => new URLSearchParams(String(router.replace.mock.calls.at(-1)?.[0]).split("?")[1]);

describe("รายงานงานที่จะเสร็จ", () => {
  it("เมนู 'งานที่จะเสร็จ' เปิดมุมมอง Task: ค่าเริ่มต้นสัปดาห์นี้, ตัวเลขสรุป, กลุ่มรายวัน และลิงก์งาน", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mount("");
    await user.click(await screen.findByRole("button", { name: "งานที่จะเสร็จ" }));
    const table = await screen.findByRole("table");
    expect(requests[0]).toBe("from=2026-11-16&to=2026-11-22");
    expect(screen.getByRole("radio", { name: "Task ที่จะเสร็จ" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("งานที่จะเสร็จ", { selector: "dt" }).parentElement).toHaveTextContent("3 งาน");
    expect(screen.getByText("เสี่ยงไม่ทัน").parentElement).toHaveTextContent("2 งาน");
    expect(screen.getByText("เลยกำหนดแล้ว 1 งาน")).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("1 งาน · 2 MD");
    expect(rows[2]).toHaveTextContent("DE-12");
    expect(rows[2]).toHaveTextContent(ba.displayName);
    expect(rows[2]).toHaveTextContent("เลยกำหนด");
    expect(rows[3]).toHaveTextContent("2 งาน · 4.5 MD");
    expect(rows[4]).toHaveTextContent("Sub-task ของ DE-12");
    expect(rows[4]).toHaveTextContent("Done");
    expect(rows[5]).toHaveTextContent("ไม่ระบุ Module");
    expect(rows[5]).toHaveTextContent("เสี่ยง");
    expect(within(rows[2]).getByRole("link", { name: "DE-12" })).toHaveAttribute("href", expect.stringContaining("issue=DE-12"));
  });

  it("ตัวกรองจากลิงก์ส่งไป API · เลือก DEV เพิ่มแล้วบันทึกลง URL", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mount("report=due&from=2026-11-16&to=2026-11-30&m=mod-pay&ba=ba-1");
    await screen.findByRole("table");
    expect(requests[0]).toBe("from=2026-11-16&to=2026-11-30&modules=mod-pay&ba=ba-1");
    expect(screen.getByRole("button", { name: /^Module: ระบบชำระตัวอย่าง/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^DEV/ }));
    const menu = screen.getByRole("group", { name: "DEV" });
    await user.click(within(menu).getByRole("checkbox", { name: /ผู้พัฒนาตัวอย่างสอง/ }));
    const url = lastUrl();
    expect(url.get("report")).toBe("due");
    expect(url.get("m")).toBe("mod-pay");
    expect(url.get("ba")).toBe("ba-1");
    expect(url.get("dev")).toBe("dev-b");
    expect(url.get("from")).toBe("2026-11-16");
  });

  it("เลือกช่วงวันที่ด้วยปุ่มลัดหรือกรอกเอง · ช่วงกลับด้านกดใช้ไม่ได้", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mount("report=due");
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /^ช่วงวันที่ Plan End/ }));
    const dialog = screen.getByRole("dialog", { name: "ช่วงวันที่ Plan End" });
    expect(within(dialog).getByRole("button", { name: "สัปดาห์นี้" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(dialog).getByRole("button", { name: "เดือนหน้า" }));
    await user.click(within(dialog).getByRole("button", { name: "ใช้ช่วงนี้" }));
    expect(lastUrl().get("from")).toBe("2026-12-01");
    expect(lastUrl().get("to")).toBe("2026-12-31");

    await user.click(screen.getByRole("button", { name: /^ช่วงวันที่ Plan End/ }));
    const again = screen.getByRole("dialog", { name: "ช่วงวันที่ Plan End" });
    const from = within(again).getByLabelText("จาก");
    await user.clear(from);
    await user.type(from, "2026-12-25");
    const to = within(again).getByLabelText("ถึง");
    await user.clear(to);
    await user.type(to, "2026-12-01");
    expect(within(again).getByText("วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด")).toBeInTheDocument();
    expect(within(again).getByRole("button", { name: "ใช้ช่วงนี้" })).toBeDisabled();
  });

  it("มุมมอง Plan: Module › Phase, คาดวันจบ, ช้ากว่าแผน และกางดูงานในกลุ่ม", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mount("report=due&view=plan");
    const table = await screen.findByRole("table");
    expect(screen.getByRole("radio", { name: "Plan ที่จะเสร็จ" })).toHaveAttribute("aria-checked", "true");
    const row = within(table).getAllByRole("row")[1];
    expect(row).toHaveTextContent("ระบบชำระตัวอย่าง› Sprint 3");
    expect(row).toHaveTextContent("4 / 6");
    expect(row).toHaveTextContent("12 / 18");
    expect(row).toHaveTextContent("67%");
    expect(row).toHaveTextContent("ช้า 1 วันทำการ");
    expect(within(table).queryByRole("link", { name: "DE-12" })).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { expanded: false }));
    expect(within(table).getByRole("link", { name: "DE-12" })).toBeInTheDocument();
    expect(screen.getByText(/ความเร็วจริงของ Module ใน 28 วันล่าสุด/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Task ที่จะเสร็จ" }));
    expect(lastUrl().get("view")).toBe("task");
  });

  it("ไม่มีงานในช่วงแสดงข้อความว่าง · API ปฏิเสธสิทธิ์แสดงหน้าไม่มีสิทธิ์", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/reports/due", () => HttpResponse.json({ ...dueData(), tasks: [], summary: { taskCount: 0, md: 0, doneCount: 0, atRiskCount: 0, lateCount: 0 } })));
    const view = mount("report=due");
    expect(await screen.findByText("ไม่มีงานที่ Plan End อยู่ในช่วงนี้")).toBeInTheDocument();
    view.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/reports/due", () => HttpResponse.json({ error: { code: "forbidden", message: "ไม่มีสิทธิ์", details: {}, requestId: "req_due_1" } }, { status: 403 })));
    mount("report=due");
    await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
    expect(await screen.findByText(/ไม่มีสิทธิ์/)).toBeInTheDocument();
  });
});

describe("ปุ่มและ popup งานที่จะเสร็จจาก Overview", () => {
  const mountPopup = (search: string) => { navigation.pathname = "/work/sample/p/DE"; navigation.search = search; return renderWithProviders(<WorkspaceShell ws="sample"><DueButton /><DuePopup ws="sample" projectKey="DE" projectName="แผนพัฒนาตัวอย่าง" /></WorkspaceShell>, { messages: { "lead-dashboard-reports": messages } }); };

  it("กดปุ่มแล้วเปิด popup ผ่าน URL · ตัวกรองใช้ชื่อขึ้นต้นด้วย d ไม่ชนกับหน้า Overview", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mountPopup("");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "งานที่จะเสร็จ" }));
    expect(lastUrl().get("due")).toBe("1");

    const view = mountPopup("due=1&dfrom=2026-11-16&dto=2026-11-30&ddev=dev-a&view=board");
    const dialog = await screen.findByRole("dialog", { name: "งานที่จะเสร็จ" });
    await within(dialog).findByRole("table");
    expect(requests.at(-1)).toBe("from=2026-11-16&to=2026-11-30&dev=dev-a");
    await user.click(within(dialog).getByRole("radio", { name: "Plan ที่จะเสร็จ" }));
    const url = lastUrl();
    expect(url.get("dview")).toBe("plan");
    expect(url.get("view")).toBe("board");
    expect(url.has("report")).toBe(false);
    view.unmount();
  });

  it("กดงานแล้วรายละเอียดเปิดใน popup เดียวกัน ไม่ใช้ Drawer", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mountPopup("due=1");
    const dialog = await screen.findByRole("dialog", { name: "งานที่จะเสร็จ" });
    await user.click(await within(dialog).findByRole("button", { name: /DE-20/ }));
    expect(lastUrl().get("dissue")).toBe("DE-20");
    expect(lastUrl().has("issue")).toBe(false);
    expect(within(dialog).queryByRole("link", { name: "DE-12" })).not.toBeInTheDocument();
  });

  it("เปิดงานอยู่: ตารางย่อ, แผงรายละเอียด, ปิดแผง และเปิดเต็มหน้า", async () => {
    const f = fixture();
    server.use(...f.handlers, http.get("*/api/v1/w/:ws/projects/:key/reports/due", () => HttpResponse.json({ ...dueData(), tasks: dueData().tasks.map((x, i) => (i === 0 ? { ...x, key: "DE-1" } : x)) })));
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mountPopup("due=1&dissue=DE-1&dfrom=2026-11-16&dto=2026-11-22");
    const dialog = await screen.findByRole("dialog", { name: "งานที่จะเสร็จ" });
    expect(await within(dialog).findByRole("button", { name: "งานตัวอย่าง DE-1" })).toBeInTheDocument();
    const table = within(dialog).getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getByRole("button", { name: /DE-1 / })).toHaveAttribute("aria-current", "true");

    await user.click(within(dialog).getByRole("button", { name: "เปิดเต็มหน้า" }));
    let url = lastUrl();
    expect(url.get("issue")).toBe("DE-1");
    expect(url.has("due")).toBe(false);
    expect(url.has("dissue")).toBe(false);
    expect(url.has("dfrom")).toBe(false);

    const close = within(dialog).getAllByRole("button", { name: "ปิด" });
    // ปุ่มปิดตัวแรกคือของ popup · ตัวที่สองคือของแผงงาน
    await user.click(close[close.length - 1]);
    url = lastUrl();
    expect(url.get("due")).toBe("1");
    expect(url.has("dissue")).toBe(false);
  });
});

describe("เมนูรายงานตามสิทธิ์", () => {
  const withPerms = (list: string[]) => server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "member", permissions: list })));

  it("ปิดรายงานงานที่จะเสร็จ: เมนูไม่แสดง", async () => {
    withPerms(["project.view", "project.workload.view", "project.reports.view"]);
    mount("");
    expect(await screen.findByRole("button", { name: "รายงานประจำสัปดาห์" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "งานที่จะเสร็จ" })).not.toBeInTheDocument();
  });

  it("เปิดเฉพาะรายงานงานที่จะเสร็จ: เมนูเหลือรายการเดียว", async () => {
    withPerms(["project.view", "project.workload.view", "project.reports.due"]);
    mount("report=weekly");
    expect(await screen.findByRole("button", { name: "งานที่จะเสร็จ" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "รายงานประจำสัปดาห์" })).not.toBeInTheDocument();
  });
});
