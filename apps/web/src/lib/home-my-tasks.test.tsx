// W03 · Home และ My Tasks · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { asMobile } from "@/test/mobile";
import { server } from "@/test/server";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import hmt from "../../messages/th/home-my-tasks.json";
import { HomePage } from "../../app/work/[ws]/my-tasks/_components/home-page";
import { MyTasksPage, dropTarget, weekLoad, weekStartOf } from "../../app/work/[ws]/my-tasks/_components/my-tasks-page";
import type { HomeData, MyIssues, TaskItem } from "../../app/work/[ws]/my-tasks/_components/types";

const person = (id: string, displayName: string) => ({ id, displayName, initials: displayName.slice(0, 2) });
const errorBody = (status: number, code: string) => HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", requestId: "req_w03_001" } }, { status });

function homeData(): HomeData {
  return {
    today: "2026-12-02",
    week: { start: "2026-11-30", end: "2026-12-06" },
    summary: {
      dueToday: { team: 2, mine: 1, keys: ["DE-35", "DE-60"] },
      overdue: { team: 7, mine: 4, byAssignee: [{ person: person("u1", "ผู้พัฒนาหนึ่ง"), count: 4 }, { person: person("u2", "ผู้พัฒนาสอง"), count: 3 }] },
      dueThisWeek: { team: 7, mine: 2, until: "2026-12-04" },
      inProgress: { mine: 3 },
      waitingReview: 1,
      unreadMentions: { count: 1, latestFrom: "ผู้ทดสอบ" },
      pendingApprovals: 1,
    },
    waiting: {
      approvals: [{ id: "req-1", requester: { id: "u1", displayName: "ผู้พัฒนาหนึ่ง" }, requestedDue: "2026-12-04", previousDue: "2026-12-01", issue: { key: "DE-30", title: "ข้อมูลวงเงินตัวอย่าง", planEnd: "2026-12-01" }, project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" }, canDecide: true, status: "pending" }],
      reviews: [{ key: "DE-91", title: "ส่งออกรายงานตัวอย่าง", project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" }, status: { name: "Review", category: "in_progress" }, planEnd: "2026-11-25", from: person("u2", "ผู้พัฒนาสอง") }],
    },
    projects: [{ key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", color: "#334155", goliveDate: "2027-04-21", daysToGolive: 140, progressPct: 22, overdue: 7, myTasks: 4, health: { level: "off_track", gapPct: 12 } }],
    recent: [{ key: "DE-39", title: "ฟอร์มตัวอย่าง", project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" }, verb: "updated", at: "2026-12-02T03:00:00Z" }],
    upcoming: [{ date: "2026-12-07", type: "holiday", title: "วันหยุดตัวอย่าง", project: null }],
    workload: { week: { start: "2026-11-30", end: "2026-12-06" }, team: { md: 12, capacityMd: 10, utilizationPct: 120 }, mine: null, people: [{ person: person("u1", "ผู้พัฒนาหนึ่ง"), md: 8, capacityMd: 5, utilizationPct: 160 }, { person: person("u2", "ผู้พัฒนาสอง"), md: 4, capacityMd: 5, utilizationPct: 80 }] },
  };
}

function task(key: string, over: Partial<TaskItem> = {}): TaskItem {
  return { key, title: `งานตัวอย่าง ${key}`, type: "Task", project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", color: "#334155" }, status: { id: "st-prog", name: "In progress", category: "in_progress" }, priority: "high", planStart: "2026-11-30", planEnd: "2026-11-30", due: { state: "overdue", days: 2 }, estimateMd: 2, parentKey: null, subtasks: null, assignees: [person("sample-lead", "หัวหน้าทีมตัวอย่าง")], version: 3, ...over };
}
function tasks(): MyIssues {
  return {
    today: "2026-12-02",
    tab: "assigned",
    group: "due",
    counts: { assigned: 3, reviewer: 1, watching: 0, created: 5 },
    total: 3,
    groups: [
      { key: "late", label: "เลยกำหนด", count: 1, items: [task("DE-23")] },
      { key: "today", label: "วันนี้", range: { from: "2026-12-02", to: "2026-12-02" }, count: 1, items: [task("DE-35", { planEnd: "2026-12-02", due: { state: "today", days: 0 }, priority: "urgent" })] },
      // ฉันเป็น BA และ QA ไม่ใช่ Dev: อยู่ในแท็บนี้ แต่ Man-Day ไม่นับเป็นของฉัน
      { key: "this_week", label: "สัปดาห์นี้", range: { from: "2026-12-03", to: "2026-12-06" }, count: 1, items: [task("DE-50", { planEnd: "2026-12-04", due: { state: "later", days: 2 }, estimateMd: 5, myRoles: ["ba", "qa"] })] },
      { key: "next_week", label: "สัปดาห์หน้า", range: { from: "2026-12-07", to: "2026-12-13" }, count: 1, items: [task("DE-40", { planStart: "2026-12-08", planEnd: "2026-12-09", due: { state: "later", days: 7 }, priority: "low", parentKey: "DE-39" })] },
      { key: "later", label: "ภายหลัง", range: { from: "2026-12-14", to: "" }, count: 0, items: [] },
      { key: "none", label: "ไม่มีวันที่", count: 0, items: [] },
      { key: "done_today", label: "เสร็จวันนี้", range: { from: "2026-12-02", to: "2026-12-02" }, count: 0, items: [] },
    ],
  };
}

const mount = (ui: React.ReactElement) => renderWithProviders(<WorkspaceShell ws="sample">{ui}</WorkspaceShell>, { messages: { "home-my-tasks": hmt } });
let decisions: string[];
let patches: { key: string; body: Record<string, unknown>; etag: string | null }[];
let dueRequests: Record<string, unknown>[];

beforeEach(() => {
  decisions = [];
  patches = [];
  dueRequests = [];
  server.use(
    http.get("*/api/v1/w/:ws/home", () => HttpResponse.json(homeData())),
    http.get("*/api/v1/me/notifications", () => HttpResponse.json({ items: [{ id: "n1", eventType: "issue.mentioned", actor: { id: "u3", displayName: "ผู้ทดสอบ" }, payload: { issueKey: "DE-525", title: "บั๊กตัวอย่าง", message: "ช่วยดูหน่อยครับ" }, readAt: null, createdAt: "2026-12-02T02:00:00Z" }, { id: "n2", eventType: "member.joined", actor: { id: "u4", displayName: "สมาชิกใหม่ตัวอย่าง" }, payload: { email: "new@example.com" }, readAt: "2026-12-02T03:00:00Z", createdAt: "2026-12-02T01:00:00Z" }, { id: "n3", eventType: "sprint.started", actor: null, payload: {}, readAt: "2026-12-02T03:00:00Z", createdAt: "2026-12-01T01:00:00Z" }] })),
    http.post("*/api/v1/w/:ws/due-requests/:id/:action", ({ params }) => { decisions.push(`${params.action}:${params.id}`); return HttpResponse.json({ ok: true }); }),
    http.get("*/api/v1/w/:ws/my-issues", ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("group") === "project") return HttpResponse.json({ ...tasks(), group: "project", groups: [{ key: "DE", label: "แผนพัฒนาผลิตภัณฑ์", count: 3, items: tasks().groups.flatMap((g) => g.items) }, { key: "OT", label: "โปรเจกต์อื่น", count: 1, items: [task("OT-1", { project: { key: "OT", name: "โปรเจกต์อื่น", color: "#0f766e" } })] }] });
      if (url.searchParams.get("tab") === "watching") return HttpResponse.json({ ...tasks(), tab: "watching", total: 0, groups: tasks().groups.map((g) => ({ ...g, count: 0, items: [] })) });
      return HttpResponse.json(tasks());
    }),
    http.get("*/api/v1/w/:ws/projects/:key/form-options", () => HttpResponse.json({ issueTypes: [{ name: "Task", statuses: [{ id: "st-todo", name: "To do", category: "todo" }, { id: "st-prog", name: "In progress", category: "in_progress" }, { id: "st-done", name: "Done", category: "done" }] }] })),
    http.patch("*/api/v1/w/:ws/issues/:key", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ key: String(params.key), body, etag: request.headers.get("if-match") });
      if (body.planEnd && params.key === "DE-23") return errorBody(403, "due_change_requires_approval");
      return HttpResponse.json({ ok: true });
    }),
    http.post("*/api/v1/w/:ws/issues/:key/due-requests", async ({ request }) => { dueRequests.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ id: "dr-1" }, { status: 201 }); }),
  );
});

describe("Home (E / M5)", () => {
  it("แสดงสรุป KPI, สิ่งที่รอ, โปรเจกต์, Review, Inbox, 30 วันข้างหน้า และ Workload", async () => {
    mount(<HomePage ws="sample" />);
    expect(await screen.findByRole("heading", { level: 1, name: /หัวหน้าทีมตัวอย่าง/ })).toBeInTheDocument();
    expect(screen.getByTestId("summary-line")).toHaveTextContent("2 งาน ครบกำหนดวันนี้ และ 7 งาน เลยกำหนด");
    expect(screen.getByRole("link", { name: /ครบกำหนดวันนี้ \(ทีม\)/ })).toHaveTextContent("DE-35, DE-60");
    expect(screen.getByRole("link", { name: /Overdue \(ทีม\)/ })).toHaveTextContent("ผู้พัฒนาหนึ่ง 4 · ผู้พัฒนาสอง 3");
    expect(screen.getByRole("link", { name: /ผู้พัฒนาหนึ่ง ขอเลื่อน Due · DE-30/ })).toHaveAttribute("href", "/work/sample/p/DE/board?issue=DE-30");
    const project = screen.getByRole("link", { name: /แผนพัฒนาผลิตภัณฑ์.*Off track/s });
    expect(project).toHaveAttribute("href", "/work/sample/p/DE");
    expect(within(project).getByText("22%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /DE-39 ฟอร์มตัวอย่าง/ })).toBeInTheDocument();
    expect(await screen.findByText("บั๊กตัวอย่าง", { exact: false })).toBeInTheDocument();
    // เหตุการณ์ที่ไม่มีงานปลายทางต้องเป็นประโยคครบ ไม่ค้างที่ "ใน"
    const inbox = document.getElementById("inbox")!;
    expect(within(inbox).getByText("สมาชิกใหม่ตัวอย่าง").parentElement).toHaveTextContent(/^สมาชิกใหม่ตัวอย่าง เข้าร่วม Workspace แล้ว$/);
    expect(within(inbox).getByText("ระบบ").parentElement).toHaveTextContent(/^ระบบ มีความเคลื่อนไหว$/);
    expect(screen.getByText(/วันหยุด · วันหยุดตัวอย่าง/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Man-Day ต่อคน.*ผู้พัฒนาหนึ่ง 8/ })).toBeInTheDocument();
  });

  it("อนุมัติ / ปฏิเสธคำขอเลื่อน Due จาก Home แล้วโหลดข้อมูลใหม่", async () => {
    const user = userEvent.setup();
    mount(<HomePage ws="sample" />);
    await user.click(await screen.findByRole("button", { name: "อนุมัติ DE-30" }));
    await waitFor(() => expect(decisions).toEqual(["approve:req-1"]));
    expect(await screen.findByText("อนุมัติคำขอของ DE-30 แล้ว")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ปฏิเสธ DE-30" }));
    await waitFor(() => expect(decisions).toEqual(["approve:req-1", "reject:req-1"]));
  });

  it("มือถือ (M5): หัวขาวพร้อมค้นหา, KPI 3 ช่อง และอนุมัติคำขอจากการ์ด", async () => {
    const restore = asMobile();
    try {
      const user = userEvent.setup();
      mount(<HomePage ws="sample" />);
      expect(await screen.findByRole("button", { name: "ค้นหา" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "รอคุณอนุมัติ" })).toBeInTheDocument();
      expect(screen.queryByTestId("summary-line")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "อนุมัติ DE-30" }));
      await waitFor(() => expect(decisions).toEqual(["approve:req-1"]));
    } finally { restore(); }
  });

  it("30 วันข้างหน้า: วันเดียวกันรวมกลุ่ม แสดง 6 รายการแรกแล้วกดดูที่เหลือ", async () => {
    const user = userEvent.setup();
    const d = homeData();
    d.upcoming = [
      { date: "2026-12-04", type: "phase_end", title: "กลุ่มงานตัวอย่าง 1", project: "โปรเจกต์สมมติ" },
      { date: "2026-12-04", type: "phase_end", title: "กลุ่มงานตัวอย่าง 2", project: "โปรเจกต์สมมติ" },
      { date: "2026-12-04", type: "sprint_end", title: "Sprint ตัวอย่าง", project: "โปรเจกต์สมมติ" },
      ...Array.from({ length: 5 }, (_, i) => ({ date: `2026-12-1${i}`, type: "milestone" as const, title: `Milestone ตัวอย่าง ${i + 1}`, project: "โปรเจกต์สมมติ" })),
    ];
    server.use(http.get("*/api/v1/w/:ws/home", () => HttpResponse.json(d)));
    mount(<HomePage ws="sample" />);
    expect(await screen.findByText("กลุ่มงานครบ · กลุ่มงานตัวอย่าง 1")).toBeInTheDocument();
    // 3 รายการวันที่ 4 ใช้ป้าย "อีก 2 วัน" ป้ายเดียว
    expect(screen.getAllByText("อีก 2 วัน")).toHaveLength(1);
    expect(screen.getByText("Milestone · Milestone ตัวอย่าง 3")).toBeInTheDocument();
    expect(screen.queryByText("Milestone · Milestone ตัวอย่าง 4")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ดูอีก 2 รายการ" }));
    expect(screen.getByText("Milestone · Milestone ตัวอย่าง 5")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "แสดงน้อยลง" }));
    expect(screen.queryByText("Milestone · Milestone ตัวอย่าง 5")).not.toBeInTheDocument();
  });

  it("ไม่มีสิทธิ์ตัดสินคำขอ = ไม่มีปุ่ม · ไม่มีอะไรรอ = สถานะว่าง", async () => {
    const d = homeData();
    d.waiting.approvals[0].canDecide = false;
    server.use(http.get("*/api/v1/w/:ws/home", () => HttpResponse.json(d)));
    mount(<HomePage ws="sample" />);
    await screen.findByRole("link", { name: /ผู้พัฒนาหนึ่ง ขอเลื่อน Due/ });
    expect(screen.queryByRole("button", { name: "อนุมัติ DE-30" })).not.toBeInTheDocument();
  });

  it("ไม่มีอะไรรอ = สถานะว่าง", async () => {
    const empty = homeData();
    empty.waiting = { approvals: [], reviews: [] };
    server.use(http.get("*/api/v1/w/:ws/home", () => HttpResponse.json(empty)));
    mount(<HomePage ws="sample" />);
    expect(await screen.findByText("ไม่มีอะไรรอคุณวันนี้")).toBeInTheDocument();
    expect(screen.getByText("ไม่มีงานรอ Review")).toBeInTheDocument();
  });

  it("Error แสดง requestId · 403 แสดงหน้าไม่มีสิทธิ์", async () => {
    server.use(http.get("*/api/v1/w/:ws/home", () => errorBody(500, "internal_error")));
    const first = mount(<HomePage ws="sample" />);
    expect(await screen.findByText(/req_w03_001/)).toBeInTheDocument();
    first.unmount();
    server.use(http.get("*/api/v1/w/:ws/home", () => errorBody(403, "forbidden")));
    mount(<HomePage ws="sample" />);
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });
});

describe("My Tasks (F / M2)", () => {
  it("แท็บพร้อมจำนวน · จัดกลุ่มตาม Due · กลุ่ม \"ภายหลัง\" และ \"ไม่มีวันที่\" ย่อไว้ · สรุปของฉัน", async () => {
    mount(<MyTasksPage ws="sample" />);
    expect(await screen.findByRole("button", { name: /มอบหมายให้ฉัน 3/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /ฉันสร้าง 5/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ย่อกลุ่ม เลยกำหนด" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "ขยายกลุ่ม ภายหลัง" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: "งานตัวอย่าง DE-23" })).toHaveAttribute("href", "/work/sample/p/DE/board?issue=DE-23");
    expect(within(screen.getByTestId("task-DE-23")).getByText("เลย 2 วัน")).toBeInTheDocument();
    expect(within(screen.getByTestId("task-DE-40")).getByText("Sub-task")).toBeInTheDocument();
    // ป้ายบทบาทของฉัน: BA / QA · งานที่เป็น Dev ไม่มีป้าย
    expect(within(screen.getByTestId("task-DE-50")).getByTitle("ฉันเป็น QA / Reviewer ของงานนี้")).toHaveTextContent("QA");
    expect(within(screen.getByTestId("task-DE-50")).getByText("BA")).toBeInTheDocument();
    expect(within(screen.getByTestId("task-DE-23")).queryByText("QA")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ฉันเป็น QA \/ Reviewer 1/ })).toBeInTheDocument();
    // Man-Day รวมไม่นับ 5 MD ของ DE-50 (2 + 2 + 2)
    expect(screen.getByText(/Man-Day รวม 6.0 MD/)).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "สรุปของฉัน" });
    expect(within(summary).getByText("Overdue").nextSibling).toHaveTextContent("1");
    // ชิปโปรเจกต์จากข้อมูลทั้งแท็บ
    expect(await screen.findByRole("button", { name: /โปรเจกต์อื่น/ })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "ย่อกลุ่ม เลยกำหนด" }));
    expect(screen.queryByTestId("task-DE-23")).not.toBeInTheDocument();
  });

  it("ติ๊กเพื่อปิดงาน = PATCH statusId ของสถานะ Done พร้อม If-Match", async () => {
    const user = userEvent.setup();
    mount(<MyTasksPage ws="sample" />);
    await user.click(await screen.findByRole("checkbox", { name: "ทำเครื่องหมายว่าเสร็จ: งานตัวอย่าง DE-35" }));
    await waitFor(() => expect(patches).toEqual([{ key: "DE-35", body: { statusId: "st-done" }, etag: '"3"' }]));
    expect(await screen.findByText("ปิดงาน DE-35 แล้ว")).toBeInTheDocument();
  });

  it("BA / SA ที่เปลี่ยนสถานะไม่ได้ (canMove: false) = ช่องติ๊กปิดพร้อมคำอธิบาย", async () => {
    const data = tasks();
    data.groups[2]!.items[0] = { ...data.groups[2]!.items[0]!, canMove: false };
    server.use(http.get("*/api/v1/w/:ws/my-issues", () => HttpResponse.json(data)));
    mount(<MyTasksPage ws="sample" />);
    const box = await screen.findByRole("checkbox", { name: "ทำเครื่องหมายว่าเสร็จ: งานตัวอย่าง DE-50" });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("title", "เปลี่ยนสถานะได้เฉพาะ Dev / QA ของงานนี้");
    expect(screen.getByRole("checkbox", { name: "ทำเครื่องหมายว่าเสร็จ: งานตัวอย่าง DE-35" })).toBeEnabled();
  });

  it("กลุ่มที่มีงานเกิน 30 งาน แสดง 30 งานแรกแล้วกดดูที่เหลือ", async () => {
    const user = userEvent.setup();
    const many = tasks();
    many.groups[0] = { ...many.groups[0], count: 33, items: Array.from({ length: 33 }, (_, i) => task(`DE-${100 + i}`)) };
    server.use(http.get("*/api/v1/w/:ws/my-issues", () => HttpResponse.json(many)));
    mount(<MyTasksPage ws="sample" />);
    expect(await screen.findByTestId("task-DE-129")).toBeInTheDocument();
    expect(screen.queryByTestId("task-DE-130")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ดูอีก 3 งาน" }));
    expect(screen.getByTestId("task-DE-132")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "แสดงน้อยลง" }));
    expect(screen.queryByTestId("task-DE-132")).not.toBeInTheDocument();
  });

  it("ลากงานไปวางที่หัวกลุ่ม \"สัปดาห์หน้า\" = เปลี่ยน Due เป็นวันศุกร์ของสัปดาห์นั้น", async () => {
    const user = userEvent.setup();
    mount(<MyTasksPage ws="sample" />);
    const row = await screen.findByTestId("task-DE-35");
    const header = screen.getByRole("button", { name: "ย่อกลุ่ม สัปดาห์หน้า" });
    fireEvent.dragStart(row);
    fireEvent.dragOver(header);
    fireEvent.drop(header);
    const dialog = await screen.findByRole("dialog", { name: "เลื่อน Due" });
    expect(within(dialog).getByLabelText("Due ใหม่")).toHaveValue("2026-12-11");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(patches).toEqual([{ key: "DE-35", body: { planEnd: "2026-12-11" }, etag: '"3"' }]));
  });

  it("ต้องขออนุมัติ (403 due_change_requires_approval) → เปลี่ยนเป็นฟอร์มขอเลื่อน Due (K3)", async () => {
    const user = userEvent.setup();
    mount(<MyTasksPage ws="sample" />);
    await user.click(await screen.findByRole("button", { name: "เลื่อน Due ของ DE-23" }));
    let dialog = await screen.findByRole("dialog", { name: "เลื่อน Due" });
    await user.clear(within(dialog).getByLabelText("Due ใหม่"));
    await user.type(within(dialog).getByLabelText("Due ใหม่"), "2026-12-09");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    dialog = await screen.findByRole("dialog", { name: "ขอเลื่อน Due" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("ต้องขออนุมัติ");
    await user.selectOptions(within(dialog).getByLabelText("เหตุผล"), "waiting_input");
    await user.click(within(dialog).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(dueRequests).toEqual([{ requestedDue: "2026-12-09", reasonCode: "waiting_input" }]));
    expect(await screen.findByText("ส่งคำขอเลื่อน Due ของ DE-23 แล้ว")).toBeInTheDocument();
  });

  it("แท็บที่ไม่มีงาน = สถานะว่าง · Error มี requestId · 403", async () => {
    const user = userEvent.setup();
    const r = mount(<MyTasksPage ws="sample" />);
    await user.click(await screen.findByRole("button", { name: /Watching 0/ }));
    expect(await screen.findByText("ไม่มีงานในมุมมองนี้")).toBeInTheDocument();
    r.unmount();
    server.use(http.get("*/api/v1/w/:ws/my-issues", () => errorBody(500, "internal_error")));
    const e = mount(<MyTasksPage ws="sample" />);
    expect(await screen.findByText(/req_w03_001/)).toBeInTheDocument();
    e.unmount();
    server.use(http.get("*/api/v1/w/:ws/my-issues", () => errorBody(403, "forbidden")));
    mount(<MyTasksPage ws="sample" />);
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("ตัวช่วย: วันปลายทางของกลุ่ม และ Man-Day ต่อวัน", () => {
    expect(dropTarget({ key: "next_week", label: "", range: { from: "2026-12-07", to: "2026-12-13" }, count: 0, items: [] })).toBe("2026-12-11");
    expect(dropTarget({ key: "today", label: "", range: { from: "2026-12-02", to: "2026-12-02" }, count: 0, items: [] })).toBe("2026-12-02");
    expect(dropTarget({ key: "late", label: "", count: 0, items: [] })).toBeNull();
    expect(weekStartOf("2026-12-02")).toBe("2026-11-30");
    // 4 MD ใน 2 วันทำงาน 2 คน = 1 MD/วัน/คน
    expect(weekLoad([task("X-1", { planStart: "2026-12-01", planEnd: "2026-12-02", estimateMd: 4, assignees: [person("a", "ก"), person("b", "ข")] })], "2026-11-30")).toEqual([0, 1, 1, 0, 0]);
    // งานที่ฉันเป็นแค่ QA ไม่นับเป็นภาระ · เป็นทั้ง Dev และ QA นับ
    expect(weekLoad([task("X-2", { planStart: "2026-12-01", planEnd: "2026-12-01", estimateMd: 1, myRoles: ["qa"] })], "2026-11-30")).toEqual([0, 0, 0, 0, 0]);
    expect(weekLoad([task("X-3", { planStart: "2026-12-01", planEnd: "2026-12-01", estimateMd: 1, myRoles: ["dev", "qa"] })], "2026-11-30")).toEqual([0, 1, 0, 0, 0]);
  });
});
