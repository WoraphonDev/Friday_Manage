// W04 · Inbox และกระดิ่ง · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { Bell } from "@/features/bell/Bell";
import ib from "../../messages/th/inbox-bell.json";
import { InboxPage } from "../../app/work/[ws]/inbox/_components/inbox-page";
import type { Filter, InboxNotification } from "../../app/work/[ws]/inbox/_components/types";

const now = new Date().toISOString();
const old = "2026-10-01T03:00:00Z";
function note(id: string, over: Partial<InboxNotification> = {}): InboxNotification {
  return { id, workspaceId: "sample-ws", eventType: "issue.assigned", category: "assign", actor: { id: "u1", displayName: "ผู้พัฒนาหนึ่ง" }, project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" }, payload: { issueKey: "DE-1", title: "งานตัวอย่างหนึ่ง" }, reason: "คุณเป็นผู้รับผิดชอบ", readAt: null, snoozedUntil: null, createdAt: now, issue: { key: "DE-1", title: "งานตัวอย่างหนึ่ง", type: "Task", status: { name: "To do", category: "todo" }, moduleName: "ระบบตัวอย่าง", planEnd: "2026-12-04", deleted: false, assignees: [{ id: "u1", displayName: "ผู้พัฒนาหนึ่ง" }] }, dueRequest: null, ...over };
}
const dueReq = note("n-due", { eventType: "due_request.created", category: "activity", payload: { issueKey: "DE-30", title: "ข้อมูลวงเงิน", message: "ขอเพิ่มอีก 2 วันทำการ", requestId: "req-1" }, reason: "คุณเป็นผู้อนุมัติ", issue: { key: "DE-30", title: "ข้อมูลวงเงิน", type: "Task", status: { name: "In progress", category: "in_progress" }, moduleName: null, planEnd: "2026-12-01", deleted: false, assignees: [] }, dueRequest: { id: "req-1", status: "pending", currentDue: "2026-12-01", requestedDue: "2026-12-04", reasonLabel: "ขอบเขตเพิ่ม", detail: null, decidedBy: null, canDecide: true } });
const mention = note("n-mention", { eventType: "issue.mentioned", category: "mention", payload: { issueKey: "DE-2", title: "บั๊กตัวอย่าง", message: "ช่วยดูหน่อยครับ" }, readAt: now, createdAt: old });
const counts: Record<Filter, number> = { all: 3, unread: 2, assign: 1, mention: 1, activity: 1, due: 0 };

let calls: string[];
let lists: URL[];
let page: InboxNotification[];
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w04_001" } }, { status });

beforeEach(() => {
  calls = [];
  lists = [];
  page = [note("n1"), dueReq, mention];
  server.use(
    http.get("*/api/v1/me/notifications", ({ request }) => {
      const url = new URL(request.url);
      lists.push(url);
      const f = url.searchParams.get("filter");
      const items = f === "mention" ? page.filter((n) => n.category === "mention") : f === "unread" ? page.filter((n) => !n.readAt) : page;
      return HttpResponse.json({ items: url.searchParams.get("cursor") ? [note("n-old", { createdAt: old, payload: { issueKey: "DE-9", title: "งานหน้าสอง" }, issue: null })] : items, counts, nextCursor: url.searchParams.get("cursor") ? null : f === "all" && url.searchParams.get("workspace") ? "cursor-1" : null });
    }),
    http.post("*/api/v1/me/notifications/:id/:action", async ({ params, request }) => { calls.push(`${params.action}:${params.id}:${await request.text()}`); return HttpResponse.json({ ok: true }); }),
    http.post("*/api/v1/me/notifications/read-all", async ({ request }) => { calls.push(`read-all:${await request.text()}`); return HttpResponse.json({ updated: 2 }); }),
    http.post("*/api/v1/w/:ws/due-requests/:id/:action", ({ params }) => { calls.push(`${params.action}:${params.id}`); return HttpResponse.json({ ok: true }); }),
  );
});
const mount = () => renderWithProviders(<WorkspaceShell ws="sample"><InboxPage ws="sample" /></WorkspaceShell>, { messages: { "inbox-bell": ib } });

describe("Inbox (G / M3)", () => {
  it("ตัวกรอง 6 แบบพร้อมจำนวน · จัดกลุ่มตามวัน · ยังไม่อ่านมีจุด", async () => {
    mount();
    const filters = await screen.findByRole("group", { name: "ตัวกรอง" });
    for (const [label, n] of [["ทั้งหมด", 3], ["ยังไม่อ่าน", 2], ["มอบหมาย / Review", 1], ["Mentions", 1], ["ความเคลื่อนไหวของงาน", 1], ["กำหนดส่ง", 0]] as const) expect(within(filters).getByRole("button", { name: `${label}${n}` })).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "รายการแจ้งเตือน" });
    expect(within(list).getByText("วันนี้")).toBeInTheDocument();
    expect(within(list).getByText("ก่อนหน้า")).toBeInTheDocument();
    expect(within(list).getAllByRole("img", { name: "ยังไม่อ่าน" })).toHaveLength(2);
    await userEvent.setup().click(within(filters).getByRole("button", { name: "Mentions1" }));
    await waitFor(() => expect(lists.at(-1)?.searchParams.get("filter")).toBe("mention"));
    expect(lists.at(-1)?.searchParams.get("workspace")).toBe("sample");
  });

  it("เลือกรายการ → แผงรายละเอียด + ทำเครื่องหมายว่าอ่าน · รับทราบ · เตือนพรุ่งนี้", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: /ผู้พัฒนาหนึ่ง มอบหมายงานให้คุณ/ }));
    const detail = screen.getByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(within(detail).getByRole("link", { name: /งานตัวอย่างหนึ่ง/ })).toHaveAttribute("href", "/work/sample/p/DE/board?issue=DE-1");
    expect(within(detail).getByText("คุณเป็นผู้รับผิดชอบ")).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("read:n1:{}"));
    await user.click(within(detail).getByRole("button", { name: "รับทราบ" }));
    await user.click(within(detail).getByRole("button", { name: "เตือนฉันพรุ่งนี้" }));
    await waitFor(() => expect(calls).toEqual(expect.arrayContaining(["done:n1:{}", 'snooze:n1:{"preset":"tomorrow"}'])));
    expect(await screen.findByText("จะเตือนอีกครั้งพรุ่งนี้")).toBeInTheDocument();
  });

  it("แท็บยังไม่อ่าน: เปิดรายการแล้วรายละเอียดยังอยู่หลังโหลดใหม่ (รายการแสดงเป็นอ่านแล้ว) จนกว่าจะเปลี่ยนแท็บ", async () => {
    const user = userEvent.setup();
    // API จริง: อ่านแล้วหลุดจากตัวกรอง unread
    let listsAtRead = Infinity;
    server.use(http.post("*/api/v1/me/notifications/:id/read", ({ params }) => { calls.push(`read:${params.id}`); listsAtRead = lists.length; page = page.map((n) => n.id === params.id ? { ...n, readAt: now } : n); return HttpResponse.json({ ok: true }); }));
    mount();
    await user.click(within(await screen.findByRole("group", { name: "ตัวกรอง" })).getByRole("button", { name: /^ยังไม่อ่าน/ }));
    await waitFor(() => expect(lists.at(-1)?.searchParams.get("filter")).toBe("unread"));
    await user.click(await screen.findByRole("button", { name: /ผู้พัฒนาหนึ่ง มอบหมายงานให้คุณ/ }));
    await waitFor(() => expect(calls).toContain("read:n1"));
    // รอให้รายการ unread โหลดใหม่หลังอ่าน (ผลไม่มี n1 แล้ว)
    await waitFor(() => expect(lists.length).toBeGreaterThan(listsAtRead));
    const detail = screen.getByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(within(detail).getByText("คุณเป็นผู้รับผิดชอบ")).toBeInTheDocument();
    const item = screen.getByRole("button", { name: /ผู้พัฒนาหนึ่ง มอบหมายงานให้คุณ/ });
    expect(item).toHaveAttribute("aria-current", "true");
    expect(within(item).queryByRole("img", { name: "ยังไม่อ่าน" })).not.toBeInTheDocument();
    // แถบตัวกรอง render ใหม่ระหว่างโหลดแท็บ จึงหาใหม่ทุกครั้ง
    const tab = async (name: RegExp) => user.click(within(await screen.findByRole("group", { name: "ตัวกรอง" })).getByRole("button", { name }));
    await tab(/^Mentions/);
    await waitFor(() => expect(lists.at(-1)?.searchParams.get("filter")).toBe("mention"));
    await tab(/^ยังไม่อ่าน/);
    await waitFor(() => expect(screen.queryByRole("button", { name: /ผู้พัฒนาหนึ่ง มอบหมายงานให้คุณ/ })).not.toBeInTheDocument());
  });

  it("คำขอเลื่อน Due: เห็นวันเดิม → วันใหม่ และอนุมัติ / ปฏิเสธได้เมื่อ canDecide", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: /ขอเลื่อนวันครบกำหนด/ }));
    const detail = screen.getByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(within(detail).getByText("“ขอเพิ่มอีก 2 วันทำการ”")).toBeInTheDocument();
    expect(within(detail).getByText(/เหตุผล: ขอบเขตเพิ่ม/)).toBeInTheDocument();
    await user.click(within(detail).getByRole("button", { name: "อนุมัติการเลื่อน" }));
    await waitFor(() => expect(calls).toContain("approve:req-1"));
    expect(await screen.findByText("อนุมัติการเลื่อน Due แล้ว")).toBeInTheDocument();
    await user.click(within(detail).getByRole("button", { name: "ปฏิเสธ" }));
    await waitFor(() => expect(calls).toContain("reject:req-1"));
  });

  it("ไม่มีสิทธิ์ตัดสิน / ตัดสินแล้ว = ไม่มีปุ่ม แสดงผลแทน", async () => {
    page = [{ ...dueReq, dueRequest: { ...dueReq.dueRequest!, status: "approved", canDecide: false, decidedBy: { id: "u9", displayName: "หัวหน้าตัวอย่าง" } } }];
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: /ขอเลื่อนวันครบกำหนด/ }));
    const detail = screen.getByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(within(detail).queryByRole("button", { name: "อนุมัติการเลื่อน" })).not.toBeInTheDocument();
    expect(within(detail).getByText("อนุมัติแล้วโดย หัวหน้าตัวอย่าง")).toBeInTheDocument();
  });

  it("Mark all as read ส่ง workspace · เปิดจากลิงก์ ?n= เลือกรายการทันที · โหลดหน้าถัดไป", async () => {
    navigation.search = "n=n-mention";
    const user = userEvent.setup();
    mount();
    const detail = await screen.findByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(await within(detail).findByText("“ช่วยดูหน่อยครับ”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(calls).toContain('read-all:{"workspace":"sample"}'));
    await user.click(screen.getByRole("button", { name: "โหลดเพิ่ม" }));
    expect(await screen.findByText(/งานหน้าสอง/)).toBeInTheDocument();
  });

  it("สรุปงานประจำวัน: รายการเดียวต่อวัน · แยกหัวข้อพร้อมลิงก์ไปงาน · งานเลยกำหนดของทีม", async () => {
    const user = userEvent.setup();
    const item = (issueKey: string, title: string, extra: object = {}) => ({ issueKey, title, planEnd: "2026-12-09", projectKey: "DE", ...extra });
    page = [
      note("n-daily", {
        eventType: "digest.daily",
        category: "due",
        actor: null,
        project: null,
        issue: null,
        payload: {
          date: "2026-12-09",
          title: "ข้อความไทยเดิม",
          dueToday: [item("DE-5", "งานครบวันนี้")],
          dueTodayCount: 1,
          overdue: [item("DE-6", "งานเลยกำหนด", { daysLate: 3 })],
          overdueCount: 25,
          dueSoon: [],
          dueSoonCount: 0,
          review: [item("DE-7", "งานรอตรวจ")],
          reviewCount: 1,
          team: [{ projectKey: "DE", projectName: "แผนพัฒนาผลิตภัณฑ์", count: 1, issues: [item("DE-8", "งานของทีม", { daysLate: 2, assignees: ["ผู้พัฒนาสอง"] })] }],
          teamCount: 1,
        },
        reason: "สรุปงานประจำวันของคุณ",
      }),
    ];
    mount();
    const row = await screen.findByRole("button", { name: /สรุปงานประจำวันของคุณ/ });
    expect(row).toHaveTextContent("ครบกำหนดวันนี้ 1 · เลยกำหนด 25 · รอ Review 1 · ทีมเลยกำหนด 1");
    await user.click(row);
    const detail = screen.getByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(within(within(detail).getByRole("region", { name: "ครบกำหนดวันนี้" })).getByRole("link", { name: /งานครบวันนี้/ })).toHaveAttribute("href", "/work/sample/p/DE/board?issue=DE-5");
    const late = within(detail).getByRole("region", { name: "เลยกำหนด" });
    expect(late).toHaveTextContent("เลย 3 วัน");
    expect(late).toHaveTextContent("และอีก 24 งาน");
    expect(within(detail).getByRole("region", { name: "งานเลยกำหนดของทีม · แผนพัฒนาผลิตภัณฑ์" })).toHaveTextContent("ผู้พัฒนาสอง");
    expect(within(detail).queryByRole("region", { name: "ใกล้ครบกำหนด" })).not.toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "เปิดงานของฉัน" })).toHaveAttribute("href", "/work/sample/my-tasks");
  });

  it("ว่าง · Error มี requestId · 403", async () => {
    page = [];
    const a = mount();
    expect(await screen.findByText("ไม่มีการแจ้งเตือนในหมวดนี้")).toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/me/notifications", () => errorBody(500)));
    const b = mount();
    expect(await screen.findByText(/req_w04_001/)).toBeInTheDocument();
    b.unmount();
    server.use(http.get("*/api/v1/me/notifications", () => errorBody(403)));
    mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });
});

describe("กระดิ่ง (K4)", () => {
  it("คลิกเปิดแผง: แท็บ ทั้งหมด / ยังไม่อ่าน / Mention · ลิงก์ไป Inbox ของรายการ · อ่านทั้งหมด", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Bell workspace="sample" unread={2} />, { messages: { "inbox-bell": ib } });
    await user.click(screen.getByRole("link", { name: "การแจ้งเตือน 2 รายการยังไม่อ่าน" }));
    const pop = await screen.findByRole("dialog", { name: "การแจ้งเตือน" });
    expect(await within(pop).findByRole("link", { name: /ผู้พัฒนาหนึ่ง DE-1/ })).toHaveAttribute("href", "/work/sample/inbox?n=n1");
    await user.click(within(pop).getByRole("tab", { name: "Mention" }));
    await waitFor(() => expect(lists.at(-1)?.searchParams.get("filter")).toBe("mention"));
    expect(lists.at(-1)?.searchParams.get("workspace")).toBeNull(); // กระดิ่งรวมทุก Workspace
    await user.click(within(pop).getByRole("button", { name: "อ่านทั้งหมด" }));
    await waitFor(() => expect(calls).toContain("read-all:{}"));
    expect(within(pop).getByRole("link", { name: "เปิด Inbox ทั้งหมด →" })).toHaveAttribute("href", "/work/sample/inbox");
  });
});

// รายงาน docs/reviews/ui-interaction-audit-2026-11-06.md · payload ตามรูปแบบที่ fanout ส่งจริง (issueTitle)
describe("กระดิ่ง · ข้อผิดพลาดและลิงก์ (UI-01 ถึง UI-04)", () => {
  const openBell = async () => {
    const user = userEvent.setup();
    renderWithProviders(<Bell workspace="sample" unread={1} />, { messages: { "inbox-bell": ib } });
    await user.click(screen.getByRole("link", { name: "การแจ้งเตือน 1 รายการยังไม่อ่าน" }));
    return { user, pop: await screen.findByRole("dialog", { name: "การแจ้งเตือน" }) };
  };

  it("UI-01: โหลดรายการไม่สำเร็จแสดงข้อความ + requestId · ลองใหม่แล้วแสดงรายการโดยไม่ reload", async () => {
    let fail = true;
    server.use(http.get("*/api/v1/me/notifications", () => (fail ? errorBody(503) : HttpResponse.json({ items: [note("n1")], nextCursor: null }))));
    const { user, pop } = await openBell();
    const alert = await within(pop).findByRole("alert");
    expect(alert).toHaveTextContent("ข้อผิดพลาดทดสอบ");
    expect(alert).toHaveTextContent("req_w04_001");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: /ลองอีกครั้ง/ }));
    expect(await within(pop).findByRole("link", { name: /DE-1/ })).toBeInTheDocument();
    expect(within(pop).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("UI-02: แสดงชื่องานจาก payload.issueTitle · Event อื่นยังใช้ title", async () => {
    server.use(http.get("*/api/v1/me/notifications", () => HttpResponse.json({ items: [
      { ...note("n-real"), payload: { issueKey: "DE-5", issueTitle: "งานจาก API จริง", actorName: "ผู้พัฒนาหนึ่ง" } },
      { ...note("n-other", { eventType: "import.completed", category: "activity" }), payload: { title: "นำเข้าเสร็จ" } },
    ], nextCursor: null })));
    const { pop } = await openBell();
    expect(await within(pop).findByRole("link", { name: /DE-5 งานจาก API จริง/ })).toBeInTheDocument();
    expect(within(pop).getByRole("link", { name: /นำเข้าเสร็จ/ })).toBeInTheDocument();
  });

  it("UI-03: รายการที่อ่านแล้วของอีก Workspace ลิงก์ไป Inbox ของ Workspace นั้น แม้ summary ไม่มีทีมนั้น", async () => {
    server.use(
      http.get("*/api/v1/me/notifications/summary", () => HttpResponse.json({ total: 0, workspaces: [] })),
      http.get("*/api/v1/me/notifications", () => HttpResponse.json({ items: [note("n-b", { workspaceId: "sample-ws-two", readAt: now })], nextCursor: null })),
    );
    const { pop } = await openBell();
    await waitFor(() => expect(within(pop).getByRole("link", { name: /DE-1/ })).toHaveAttribute("href", "/work/other/inbox?n=n-b"));
  });

  it("UI-04: อ่านทั้งหมดไม่สำเร็จแจ้งผู้ใช้ · ระหว่างรอกดซ้ำไม่ได้ · ลองใหม่ได้", async () => {
    let attempts = 0;
    server.use(http.post("*/api/v1/me/notifications/read-all", () => { attempts++; return errorBody(503); }));
    const { user, pop } = await openBell();
    const button = within(pop).getByRole("button", { name: "อ่านทั้งหมด" });
    await user.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("ข้อผิดพลาดทดสอบ");
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(attempts).toBe(2));
  });
});

describe("Inbox · เลือกรายการตาม ?n= (UI-05)", () => {
  const ui = () => <WorkspaceShell ws="sample"><InboxPage ws="sample" /></WorkspaceShell>;
  const detail = () => screen.findByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });

  it("?n= เปลี่ยนโดยไม่ remount เลือกรายการใหม่และอ่านรายการนั้น · ลบ query แล้วไม่เลือก", async () => {
    navigation.search = "?n=n1";
    const { rerender } = renderWithProviders(ui(), { messages: { "inbox-bell": ib } });
    expect(await within(await detail()).findByRole("link", { name: /งานตัวอย่างหนึ่ง/ })).toBeInTheDocument();
    navigation.search = "?n=n-due";
    rerender(ui());
    expect(await within(await detail()).findByText("“ขอเพิ่มอีก 2 วันทำการ”")).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("read:n-due:{}"));
    navigation.search = "";
    rerender(ui());
    expect(await within(await detail()).findByText(/เลือกการแจ้งเตือน/)).toBeInTheDocument();
  });

  it("ตัวกรองที่ซ่อนรายการเป้าหมายถูกล้าง · รายการที่อยู่หน้าถัดไปโหลดให้จนเจอ", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(ui(), { messages: { "inbox-bell": ib } });
    await user.click(await screen.findByRole("button", { name: "Mentions1" }));
    navigation.search = "?n=n1";
    rerender(ui());
    expect(await screen.findByRole("button", { name: "ทั้งหมด3" })).toHaveAttribute("aria-pressed", "true");
    expect(await within(await detail()).findByRole("link", { name: /งานตัวอย่างหนึ่ง/ })).toBeInTheDocument();
    navigation.search = "?n=n-old";
    rerender(ui());
    await waitFor(() => expect(lists.some((u) => u.searchParams.get("cursor") === "cursor-1")).toBe(true));
    expect(await screen.findByRole("button", { name: /งานหน้าสอง/ })).toHaveAttribute("aria-current", "true");
  });
});
