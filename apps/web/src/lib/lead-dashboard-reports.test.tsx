// W15 · Lead Dashboard (O1) และ Reports (O2) · ข้อมูลสมมติเท่านั้น
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import messages from "../../messages/th/lead-dashboard-reports.json";
import ot from "../../messages/th/overview-table.json";
import { overview } from "@/test/overview-fixture";
import { OverviewPage } from "../../app/w/[ws]/p/[key]/table/_components/overview";
import { heatLevel } from "../../app/w/[ws]/p/[key]/dashboard/_components/workload-heatmap";
import { ReportsView } from "../../app/w/[ws]/p/[key]/reports/_components/reports-view";
import { addDays, type ForecastResponse, type ModuleStat, type ModulesResponse, type RisksResponse, type TraceabilityResponse, type WeeklyReport, type WorkloadCell, type WorkloadResponse } from "../../app/w/[ws]/p/[key]/dashboard/_components/types";

// วันนี้สมมติ: พ. 2 ธ.ค. 2569 → สัปดาห์นี้เริ่ม 30 พ.ย.
const NOW = new Date("2026-12-02T10:00:00+07:00");
const THIS_WEEK = "2026-11-30";
const devA = { id: "dev-a", displayName: "ผู้พัฒนาตัวอย่างหนึ่ง", initials: "ผน", avatarUrl: null };
const devB = { id: "dev-b", displayName: "ผู้พัฒนาตัวอย่างสอง", initials: "ผส", avatarUrl: null };
const errorBody = (status: number) => HttpResponse.json({ error: { code: "server_error", message: "ข้อผิดพลาดทดสอบ", details: {}, requestId: "req_w15_001" } }, { status });

function mod(id: string | null, name: string, over: Partial<ModuleStat> = {}): ModuleStat {
  return { id, name, taskCount: 10, doneCount: 2, totalMd: 20, doneMd: 4, remainingMd: 16, progressPct: 20, overdue: 0, planStart: "2026-11-05", plannedEnd: "2027-01-26", milestone: null, targetDate: "2027-01-26", velocityMdPerWeek: 2.5, forecastEnd: "2027-01-28", forecastReason: null, slipDays: 2, status: "at_risk", ...over };
}
const modulesData = (): ModulesResponse => ({
  asOf: "2026-12-02",
  project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", goliveDate: "2027-01-29" },
  summary: { taskCount: 30, totalMd: 70, doneMd: 10, remainingMd: 60, progressPct: 14, capacityMdPerWeek: 10, requiredWeeks: 6, weeksToGoLive: 4.6, gapWeeks: 1.4, forecastEnd: "2027-02-20", forecastReason: null, status: "off_track" },
  velocity: { windowDays: 28, note: "" },
  modules: [
    mod("mod-a", "ระบบตัวอย่าง A", { overdue: 3 }),
    mod("mod-b", "ระบบตัวอย่าง B", { planStart: "2026-12-10", plannedEnd: "2027-02-25", totalMd: 45, forecastEnd: null, forecastReason: "no_velocity", slipDays: null, status: "no_forecast", doneCount: 0, doneMd: 0, progressPct: 0 }),
    mod("mod-c", "ระบบตัวอย่าง C", { planStart: "2026-11-02", plannedEnd: "2026-11-20", totalMd: 5, doneCount: 10, doneMd: 5, remainingMd: 0, progressPct: 100, status: "done", forecastEnd: "2026-11-19", slipDays: -1, milestone: { name: "ส่งมอบชุดแรก", date: "2026-11-20" } }),
  ],
});
const risksData = (): RisksResponse => ({
  project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" }, asOf: "2026-12-02", counts: { high: 1, medium: 1, low: 0 },
  items: [
    { kind: "overdue", severity: "high", title: "งานเลยกำหนด 3 งาน", detail: "เก่าสุดเลย 9 วัน · ผู้พัฒนาตัวอย่างหนึ่ง 3", count: 3, issueKeys: ["DE-11", "DE-12", "DE-13"] },
    { kind: "capacity_over", severity: "medium", title: "คนที่งานเกิน capacity สัปดาห์นี้ 2 คน", detail: "ผู้พัฒนาตัวอย่างหนึ่ง 12/5 MD", count: 2, issueKeys: [] },
  ],
});
function weekly(week: string): WeeklyReport {
  const start = week;
  const past = start < THIS_WEEK;
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" },
    week: { start, end: addDays(start, 6), label: `${start} – ${addDays(start, 4)}`, draft: !past, asOf: past ? addDays(start, 6) : "2026-12-02" },
    status: "off_track",
    totals: { doneCount: 8, taskCount: 30, usedMd: 10, totalMd: 70, overdue: 3 },
    thisWeek: {
      done: { count: past ? 1 : 4, md: past ? 2 : 9, keys: ["DE-5"] }, inProgress: 6, inReview: 2,
      overdue: { count: 3, byAssignee: [{ id: "dev-a", displayName: devA.displayName, count: 3 }] },
      newBugs: [{ key: "DE-40", title: "ปุ่มตัวอย่างไม่ตอบสนอง", status: "To do" }], fixedBugs: [],
    },
    nextWeek: {
      start: addDays(start, 7), end: addDays(start, 13),
      starting: past ? { count: 5, md: 12, byModule: [{ name: "ระบบตัวอย่าง A", count: 5 }] } : { count: 7, md: 15.5, byModule: [{ name: "ระบบตัวอย่าง A", count: 4 }, { name: "ระบบตัวอย่าง B", count: 3 }] },
      holidays: past ? [] : [{ date: "2026-12-07", name: "วันหยุดตัวอย่าง" }],
      sprintEvents: past ? [] : [{ date: "2026-12-11", type: "sprint_end", name: "Sprint 3" }],
    },
    risks: risksData().items,
    needsHelp: { unassigned: { count: 1, keys: ["DE-30"] } },
    text: `รายงานประจำสัปดาห์ · แผนพัฒนาผลิตภัณฑ์ · ${start}`,
  };
}
function workloadData(from: string): WorkloadResponse {
  const buckets = Array.from({ length: 24 }, (_, i) => ({ start: addDays(from, 7 * i), end: addDays(from, 7 * i + 6) }));
  const empty = (): WorkloadCell => ({ value: 0, capacity: 5, utilizationPct: 0, over: false, leaveDays: 0, issues: [] });
  const cellsA = buckets.map(empty);
  cellsA[0] = { value: 2, capacity: 5, utilizationPct: 40, over: false, leaveDays: 0, issues: [{ key: "DE-10", title: "งานตัวอย่าง 10", value: 2 }] };
  cellsA[4] = { value: 12, capacity: 5, utilizationPct: 240, over: true, leaveDays: 0, issues: [{ key: "DE-11", title: "งานตัวอย่าง 11", value: 8 }, { key: "DE-12", title: "งานตัวอย่าง 12", value: 4 }] };
  cellsA[5] = { value: 4.5, capacity: 5, utilizationPct: 90, over: false, leaveDays: 0, issues: [{ key: "DE-11", title: "งานตัวอย่าง 11", value: 4.5 }] };
  const cellsB = buckets.map(empty);
  cellsB[4] = { value: 7, capacity: 4, utilizationPct: 175, over: true, leaveDays: 1, issues: [{ key: "DE-20", title: "งานตัวอย่าง 20", value: 7 }] };
  return {
    range: { from, to: addDays(from, 167) }, unit: "md", buckets,
    people: [
      { person: devA, position: "Dev", projectRole: "member", capacityHoursWeek: 40, cells: cellsA, total: { value: 18.5, capacity: 120 } },
      { person: devB, position: "Dev", projectRole: "member", capacityHoursWeek: 40, cells: cellsB, total: { value: 7, capacity: 119 } },
    ],
  };
}
const forecastData = (): ForecastResponse => {
  const base = modulesData();
  const series = [
    { weekStart: "2026-11-23", weekEnd: "2026-11-29", plannedMd: 6, doneMd: 4 },
    { weekStart: "2026-11-30", weekEnd: "2026-12-06", plannedMd: 5, doneMd: 2 },
  ];
  return { ...base, weekly: series, modules: base.modules.map((m) => ({ ...m, weekly: series })) };
};
const issue = (key: string, category: "todo" | "in_progress" | "done", result: string | null = null) => ({ key, title: `งานตัวอย่าง ${key}`, type: "Task", status: { name: category, category }, latestTest: result ? { result, runNo: 1, environment: "UAT", passed: 1, total: 1, at: "2026-11-30T03:00:00Z" } : null });
const traceData = (): TraceabilityResponse => ({
  project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" },
  summary: { requirements: { total: 2, uncovered: 0, untested: 0, partial: 0, passed: 1, failed: 1, blocked: 0 }, screens: { total: 1 }, issuesWithoutRequirement: { count: 2, keys: ["DE-50", "DE-51"] } },
  requirements: [
    { code: "FR-01", kind: "FR", title: "ผู้ใช้เข้าสู่ระบบได้", result: "passed", issues: [issue("DE-1", "done", "passed"), issue("DE-2", "done", "passed")] },
    { code: "NFR-01", kind: "NFR", title: "หน้าแรกโหลดเร็ว", result: "failed", issues: [issue("DE-3", "in_progress", "failed")] },
  ],
  screens: [{ code: "SCR-01", name: "หน้าเข้าสู่ระบบ", result: "passed", issues: [issue("DE-1", "done", "passed")] }],
});

let requests: string[];
let sends: number;
const viewer = { ...permissions, role: "viewer" as const, permissions: ["project.view", "project.workload.view", "project.reports.view"] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requests = []; sends = 0;
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/overview", () => HttpResponse.json(overview())),
    http.get("*/api/v1/w/:ws/projects/:key/insights/risks", () => HttpResponse.json(risksData())),
    http.get("*/api/v1/w/:ws/projects/:key/insights/modules", () => HttpResponse.json(modulesData())),
    http.get("*/api/v1/w/:ws/projects/:key/workload", ({ request }) => {
      const url = new URL(request.url); requests.push(`workload?${url.searchParams}`);
      return HttpResponse.json(workloadData(url.searchParams.get("from")!));
    }),
    http.get("*/api/v1/w/:ws/projects/:key/reports/weekly", ({ request }) => {
      const week = new URL(request.url).searchParams.get("week")!; requests.push(`weekly?${week}`);
      return HttpResponse.json(weekly(week));
    }),
    http.get("*/api/v1/w/:ws/projects/:key/report-schedule", () => HttpResponse.json({ schedule: { reportType: "weekly", weekday: 5, time: "16:00", channels: ["email"], recipients: ["dev-a", "dev-b"] } })),
    http.post("*/api/v1/w/:ws/projects/:key/reports/:action", ({ params }) => { requests.push(`post:${params.action}`); sends++; return HttpResponse.json({ sent: 2 }); }),
    http.get("*/api/v1/w/:ws/projects/:key/reports/module-forecast", () => HttpResponse.json(forecastData())),
    http.get("*/api/v1/w/:ws/projects/:key/reports/traceability", ({ request }) => {
      const url = new URL(request.url); requests.push(`trace?${url.searchParams}`);
      return HttpResponse.json(traceData());
    }),
  );
});
afterEach(() => { vi.useRealTimers(); });

// ส่วนแผนอยู่ในหน้า Overview (รวมเป็นหน้าเดียว 2026-11-08) จึง mount หน้า Overview จริง
const mountDashboard = () => { navigation.pathname = "/w/sample/p/DE"; navigation.search = ""; return renderWithProviders(<WorkspaceShell ws="sample"><OverviewPage ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { "lead-dashboard-reports": messages, "overview-table": ot } }); };
const mountReports = (search = "") => { navigation.pathname = "/w/sample/p/DE/reports"; navigation.search = search; return renderWithProviders(<WorkspaceShell ws="sample"><ReportsView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { "lead-dashboard-reports": messages } }); };

describe("แผนทั้งโปรเจกต์ใน Overview (O1)", () => {
  it("ตัวเลขแผนในการ์ดสรุป, ความเสี่ยงพร้อมลิงก์งาน และปุ่มรายงานบนแถบเครื่องมือ", async () => {
    mountDashboard();
    const required = await screen.findByRole("group", { name: "ต้องใช้จริงตาม capacity" });
    expect(required).toHaveTextContent("≈ 6 สัปดาห์");
    expect(required).toHaveTextContent("60 MD ที่เหลือ ÷ 10 MD/สัปดาห์ · เกินเวลาที่เหลือถึง Go-live 1.4 สัปดาห์");
    // งานทั้งหมด / % อยู่ในการ์ดสรุปของ Overview แล้ว · ไม่ซ้ำในแถวตัวเลขแผน
    expect(screen.queryByRole("group", { name: "งานทั้งหมด" })).not.toBeInTheDocument();
    expect(required.closest("section")).toHaveAttribute("aria-label", "ความคืบหน้าโครงการ");
    expect(screen.getByRole("group", { name: "Man-Day ตามแผน" })).toHaveTextContent("70เสร็จ 10 · เหลือ 60 MD");
    expect(screen.getByRole("group", { name: "ช่วงแผน" })).toHaveTextContent("≈ 17 สัปดาห์");
    // สัปดาห์นี้มาจากรายงานของสัปดาห์ก่อน (nextWeek) · สัปดาห์หน้ามาจากรายงานสัปดาห์นี้
    await waitFor(() => expect(screen.getByRole("group", { name: "เริ่มสัปดาห์นี้ / หน้า" })).toHaveTextContent("5 / 7 งาน12 MD / 15.5 MD · Overdue 3"));
    expect(requests).toEqual(expect.arrayContaining([`weekly?${THIS_WEEK}`, "weekly?2026-11-23"]));
    expect(screen.queryByRole("heading", { name: "แผนทั้งโปรเจกต์" })).not.toBeInTheDocument();

    const risks = screen.getByRole("region", { name: "ความเสี่ยงที่ระบบพบในแผน" });
    // หน้าเดียว: ตาราง Module แทน Progress by Module, ลิงก์ Health พาไปความเสี่ยง และไม่มีหัว "แผนทั้งโปรเจกต์" แยก
    expect(screen.queryByRole("region", { name: "Progress by Module" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดูความเสี่ยงในแผน" })).toHaveAttribute("href", "#planning");
    expect(document.getElementById("planning")).toBe(risks);
    expect(within(risks).getAllByRole("listitem")).toHaveLength(2);
    expect(within(risks).getByRole("img", { name: "ความเสี่ยงสูง" })).toHaveTextContent("!");
    expect(within(risks).getByRole("link", { name: "DE-12" })).toHaveAttribute("href", "/w/sample/p/DE?issue=DE-12");
    expect(within(risks).getByRole("link", { name: "ดูงานใน Table" })).toHaveAttribute("href", "/w/sample/p/DE/table");
    expect(within(risks).getByRole("link", { name: "ดู Workload" })).toHaveAttribute("href", "/w/sample/p/DE/members");
    expect(screen.getByRole("link", { name: "สร้างรายงานประจำสัปดาห์" })).toHaveAttribute("href", "/w/sample/p/DE/reports");
    expect(screen.getByRole("link", { name: "Import / Export" })).toHaveAttribute("href", "/w/sample/p/DE/table?io=import");
  });

  it("Heatmap Workload: 24 สัปดาห์, สีตามสัดส่วน capacity, ค่าสูงสุด และคลิกช่องดูงาน", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined }); mountDashboard();
    const heat = await screen.findByRole("table", { name: "Workload รายสัปดาห์" });
    expect(requests).toContain("workload?from=2026-11-02&to=2027-04-18&group=week&unit=md");
    expect(within(heat).getAllByRole("columnheader")).toHaveLength(26);
    expect(within(heat).getByText("30/11")).toHaveAttribute("aria-current", "date");
    const rowA = within(heat).getByRole("row", { name: devA.displayName });
    expect(rowA).toHaveTextContent("3 งาน");
    expect(rowA).toHaveTextContent("2.4×");
    expect(within(rowA).getByRole("button", { name: `${devA.displayName} · สัปดาห์ 30/11 · 12 MD / 5` })).toHaveAttribute("data-level", "critical");
    expect(within(rowA).getByRole("button", { name: `${devA.displayName} · สัปดาห์ 7/12 · 4.5 MD / 5` })).toHaveAttribute("data-level", "full");
    expect(within(rowA).getByRole("button", { name: `${devA.displayName} · สัปดาห์ 2/11 · 2 MD / 5` })).toHaveAttribute("data-level", "low");
    const rowB = within(heat).getByRole("row", { name: devB.displayName });
    expect(within(rowB).getByRole("button", { name: `${devB.displayName} · สัปดาห์ 30/11 · 7 MD / 4 · ลา 1 วัน` })).toHaveAttribute("data-level", "over");

    await user.click(within(rowA).getByRole("button", { name: `${devA.displayName} · สัปดาห์ 30/11 · 12 MD / 5` }));
    const panel = screen.getByRole("region", { name: /งานของ ผู้พัฒนาตัวอย่างหนึ่ง สัปดาห์/ });
    expect(within(panel).getByRole("link", { name: "DE-11" })).toHaveAttribute("href", "/w/sample/p/DE?issue=DE-11");
    expect(panel).toHaveTextContent("8 MD");
    await user.click(within(panel).getByRole("button", { name: "ปิด" }));
    expect(screen.queryByRole("region", { name: /งานของ/ })).not.toBeInTheDocument();
  });

  it("ระดับสี heatmap", () => {
    expect(heatLevel(0, 5)).toBe("empty");
    expect(heatLevel(4, 5)).toBe("low");
    expect(heatLevel(5, 5)).toBe("full");
    expect(heatLevel(10, 5)).toBe("over");
    expect(heatLevel(10.5, 5)).toBe("critical");
    expect(heatLevel(1, 0)).toBe("critical");
  });

  it("ตาราง Module: เรียงตามวันเริ่ม / Man-Day, ความคืบหน้า และวันจบที่คาด", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined }); mountDashboard();
    const table = await screen.findByRole("table", { name: "Module" });
    const names = () => within(table).getAllByRole("row").slice(1).map((row) => row.getAttribute("aria-label"));
    expect(names()).toEqual(["ระบบตัวอย่าง C", "ระบบตัวอย่าง A", "ระบบตัวอย่าง B"]);
    const rowA = within(table).getByRole("row", { name: "ระบบตัวอย่าง A" });
    expect(rowA).toHaveTextContent("Overdue 3");
    expect(rowA).toHaveTextContent("+2 วัน");
    expect(within(rowA).getByRole("meter", { name: "ความคืบหน้า ระบบตัวอย่าง A" })).toHaveAttribute("aria-valuenow", "20");
    expect(within(table).getByRole("row", { name: "ระบบตัวอย่าง B" })).toHaveTextContent("ยังไม่มีงานเสร็จใน 28 วัน");
    expect(within(table).getByRole("row", { name: "ระบบตัวอย่าง C" })).toHaveTextContent("เสร็จแล้ว");
    await user.click(screen.getByRole("button", { name: "ตาม Man-Day" }));
    expect(screen.getByRole("button", { name: "ตาม Man-Day" })).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(["ระบบตัวอย่าง B", "ระบบตัวอย่าง A", "ระบบตัวอย่าง C"]);
  });

  it("สถานะ: กำลังโหลด, ว่าง, Error พร้อม requestId และไม่มีสิทธิ์", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/insights/modules", () => HttpResponse.json({ ...modulesData(), summary: { ...modulesData().summary, taskCount: 0 }, modules: [] })));
    const first = mountDashboard();
    expect(screen.getAllByLabelText("กำลังโหลด…").length).toBeGreaterThan(0);
    expect(await screen.findByText("ยังไม่มีงานในแผน")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import แผนจาก Excel" })).toHaveAttribute("href", "/w/sample/p/DE/table?io=import");
    first.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/insights/risks", () => errorBody(500)));
    const second = mountDashboard();
    expect(await screen.findByText("รหัสอ้างอิง: req_w15_001")).toBeInTheDocument();
    second.unmount();

    // ไม่มีสิทธิ์: ส่วนแผนใน Overview ไม่แสดงเลย (ไม่ขึ้นหน้าไม่มีสิทธิ์กลาง Overview) และกลับไปใช้ Progress by Module เดิม
    server.use(http.get("*/api/v1/w/:ws/projects/:key/insights/risks", () => HttpResponse.json({ error: { code: "forbidden", message: "ไม่มีสิทธิ์", details: {}, requestId: "req_w15_002" } }, { status: 403 })));
    const third = mountDashboard();
    await waitFor(() => expect(screen.queryByRole("region", { name: "ความเสี่ยงที่ระบบพบในแผน" })).not.toBeInTheDocument());
    expect(await screen.findByRole("region", { name: "Progress by Module" })).toBeInTheDocument();
    expect(screen.queryByText("คุณยังไม่มีสิทธิ์เข้าถึง")).not.toBeInTheDocument();
    third.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...viewer, guestViewer: true, permissions: ["project.view"] })));
    requests = [];
    mountDashboard();
    await screen.findByRole("region", { name: "Progress by Module" });
    expect(screen.queryByRole("region", { name: "ความเสี่ยงที่ระบบพบในแผน" })).not.toBeInTheDocument();
    expect(requests.filter((r) => r.startsWith("workload"))).toHaveLength(0);
  });

  it("Workload โหลดไม่ได้แสดง Error ในการ์ดโดยไม่บล็อกส่วนอื่น", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/workload", () => errorBody(500)));
    mountDashboard();
    const card = await screen.findByRole("region", { name: "Workload รายสัปดาห์" });
    expect(await within(card).findByText("รหัสอ้างอิง: req_w15_001")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "ความเสี่ยงที่ระบบพบในแผน" })).toBeInTheDocument();
  });
});

describe("Reports (O2)", () => {
  it("รายงานประจำสัปดาห์: เนื้อหาจากข้อมูลจริง, ลิงก์งาน และรอบส่ง", async () => {
    mountReports();
    const doc = await screen.findByRole("article", { name: "รายงานประจำสัปดาห์" });
    expect(doc).toHaveTextContent("แผนพัฒนาผลิตภัณฑ์ · สัปดาห์");
    expect(doc).toHaveTextContent("ร่าง ณ");
    expect(doc).toHaveTextContent("8 / 30 งาน");
    expect(doc).toHaveTextContent("10 / 70");
    expect(doc).toHaveTextContent("เสร็จแล้ว 4 งาน (9 MD) · กำลังทำ 6 งาน · รอ Review 2 งาน");
    expect(doc).toHaveTextContent(`งานเลยกำหนด 3 งาน: ${devA.displayName} 3`);
    expect(within(doc).getByRole("link", { name: "DE-40" })).toHaveAttribute("href", "/w/sample/p/DE/reports?issue=DE-40");
    expect(doc).toHaveTextContent("หยุด 7 ธ.ค. 69");
    expect(doc).toHaveTextContent("เริ่มตามแผน 7 งาน (15.5 MD): ระบบตัวอย่าง A 4 · ระบบตัวอย่าง B 3");
    expect(doc).toHaveTextContent("ปิด Sprint 3 11 ธ.ค. 69");
    expect(within(doc).getByRole("table")).toHaveTextContent("งานเลยกำหนด 3 งาน");
    expect(doc).toHaveTextContent("งานที่ใกล้เริ่มแต่ยังไม่มีผู้รับผิดชอบ 1 งาน: DE-30");
    expect(await within(doc).findByText(/ส่งอัตโนมัติทุกวันศุกร์ 16:00/)).toBeInTheDocument();
    expect(screen.getByText("ส่งถึง: 2 คนตามรอบส่ง")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "รายงานประจำสัปดาห์" })).toHaveAttribute("aria-current", "page");
  });

  it("เลือกรอบรายงานย้อนหลัง, แก้และคัดลอกข้อความ, ส่งตอนนี้ (Admin)", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined }); mountReports();
    await screen.findByRole("article", { name: "รายงานประจำสัปดาห์" });
    await user.click(screen.getByRole("button", { name: "ส่งตอนนี้" }));
    expect(await screen.findByText("ส่งรายงานให้ 2 คนแล้ว")).toBeInTheDocument();
    expect(requests).toContain("post:weekly:send");

    await user.click(screen.getByRole("button", { name: "แก้ข้อความ" }));
    const editor = screen.getByLabelText("ข้อความที่จะคัดลอก");
    expect(editor).toHaveValue(`รายงานประจำสัปดาห์ · แผนพัฒนาผลิตภัณฑ์ · ${THIS_WEEK}`);
    await user.type(editor, " · เพิ่มหมายเหตุ");
    await user.click(screen.getByRole("button", { name: "คัดลอกข้อความ" }));
    expect(await screen.findByText("คัดลอกข้อความแล้ว")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(`รายงานประจำสัปดาห์ · แผนพัฒนาผลิตภัณฑ์ · ${THIS_WEEK} · เพิ่มหมายเหตุ`);

    await user.selectOptions(screen.getByLabelText("รอบรายงาน"), "2026-11-23");
    expect(await screen.findByText(/ข้อมูล ณ/)).toBeInTheDocument();
    expect(requests).toContain("weekly?2026-11-23");
    expect(screen.getByRole("article", { name: "รายงานประจำสัปดาห์" })).toHaveTextContent("เสร็จแล้ว 1 งาน (2 MD)");
    // ส่งได้เฉพาะสัปดาห์ปัจจุบัน (API ส่งรายงานสัปดาห์นี้)
    expect(screen.queryByRole("button", { name: "ส่งตอนนี้" })).not.toBeInTheDocument();
    expect(sends).toBe(1);
  });

  it("Viewer ไม่เห็นปุ่มส่ง · Guest เห็นหน้าไม่มีสิทธิ์ · Error แสดง requestId", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json(viewer)));
    const first = mountReports();
    await screen.findByRole("article", { name: "รายงานประจำสัปดาห์" });
    expect(screen.queryByRole("button", { name: "ส่งตอนนี้" })).not.toBeInTheDocument();
    first.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/reports/weekly", () => errorBody(500)));
    const second = mountReports();
    expect(await screen.findByText("รหัสอ้างอิง: req_w15_001")).toBeInTheDocument();
    second.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...viewer, guestViewer: true, permissions: ["project.view"] })));
    mountReports();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
  });

  it("Plan vs Actual ราย Module: กราฟรายสัปดาห์และตารางส่วนต่าง", async () => {
    mountReports("report=pva");
    const table = await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Plan vs Actual ราย Module" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("img", { name: "2 สัปดาห์ล่าสุด: แผน 11 MD · เสร็จจริง 6 MD" })).toBeInTheDocument();
    expect(screen.getAllByTestId("pva-week")).toHaveLength(2);
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("ระบบตัวอย่าง A2 / 10204");
    expect(rows[1]).toHaveTextContent("+2 วัน");
    expect(rows[2]).toHaveTextContent("ยังไม่เริ่ม");
    expect(rows[3]).toHaveTextContent("เป้า ส่งมอบชุดแรก");
    expect(rows[3]).toHaveTextContent("เร็วกว่า 1 วัน");
    expect(screen.getByRole("link", { name: "อัปเดต Actual จาก Excel" })).toHaveAttribute("href", "/w/sample/p/DE/table?io=import");
  });

  it("Traceability: KPI, ตาราง FR × งาน, ตัวกรองประเภท / ผลทดสอบ และงานที่ไม่มี FR", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined }); mountReports();
    await user.click(await screen.findByRole("button", { name: "Requirement Traceability" }));
    const table = await screen.findByRole("table");
    expect(screen.getByRole("group", { name: "Requirement ทั้งหมด" })).toHaveTextContent("2");
    expect(screen.getByRole("group", { name: "งานที่ไม่มี FR" })).toHaveTextContent("2");
    expect(screen.getByRole("group", { name: "งานที่อ้างถึงเสร็จแล้ว" })).toHaveTextContent("67%");
    expect(screen.queryByText("ยังไม่ได้นำเข้ารายการ FR จาก SRS")).not.toBeInTheDocument();
    const fr = within(table).getByRole("row", { name: /^FR-01/ });
    expect(fr).toHaveTextContent("SCR-01");
    expect(fr).toHaveTextContent("ผ่าน");
    expect(within(fr).getByRole("meter", { name: "ความคืบหน้า FR-01" })).toHaveAttribute("aria-valuenow", "100");
    expect(within(fr).getByRole("link", { name: "DE-1" })).toHaveAttribute("href", "/w/sample/p/DE/reports?issue=DE-1");
    expect(within(table).getByRole("row", { name: /^NFR-01/ })).toHaveTextContent("ไม่ผ่าน");
    expect(within(table).getByRole("link", { name: "ระบุ FR" })).toHaveAttribute("href", "/w/sample/p/DE/reports?issue=DE-50");

    await user.click(screen.getByRole("button", { name: "NFR" }));
    await waitFor(() => expect(requests).toContain("trace?kind=NFR"));
    await user.selectOptions(screen.getByLabelText("ผลทดสอบ"), "failed");
    await waitFor(() => expect(requests).toContain("trace?kind=NFR&result=failed"));
  });

  it("Traceability ยังไม่มี Requirement แสดงแถบนำเข้า FR", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/reports/traceability", () => HttpResponse.json({ ...traceData(), summary: { ...traceData().summary, requirements: { total: 0, uncovered: 0, untested: 0, partial: 0, passed: 0, failed: 0, blocked: 0 } }, requirements: [], screens: [] })));
    mountReports("report=trace");
    expect(await screen.findByText("ยังไม่ได้นำเข้ารายการ FR จาก SRS")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "นำเข้ารายการ FR" })).toHaveAttribute("href", "/w/sample/p/DE/table?io=import");
  });
});
