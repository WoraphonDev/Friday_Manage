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
import { InboxPage } from "../../app/w/[ws]/inbox/_components/inbox-page";
import type { Filter, InboxNotification } from "../../app/w/[ws]/inbox/_components/types";

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
    for (const [label, n] of [["ทั้งหมด", 3], ["ยังไม่อ่าน", 2], ["มอบหมาย", 1], ["Mention", 1], ["ความเคลื่อนไหว", 1], ["ใกล้ / เลยกำหนด", 0]] as const) expect(within(filters).getByRole("button", { name: `${label}${n}` })).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "รายการแจ้งเตือน" });
    expect(within(list).getByText("วันนี้")).toBeInTheDocument();
    expect(within(list).getByText("ก่อนหน้า")).toBeInTheDocument();
    expect(within(list).getAllByRole("img", { name: "ยังไม่อ่าน" })).toHaveLength(2);
    await userEvent.setup().click(within(filters).getByRole("button", { name: "Mention1" }));
    await waitFor(() => expect(lists.at(-1)?.searchParams.get("filter")).toBe("mention"));
    expect(lists.at(-1)?.searchParams.get("workspace")).toBe("sample");
  });

  it("เลือกรายการ → แผงรายละเอียด + ทำเครื่องหมายว่าอ่าน · รับทราบ · เตือนพรุ่งนี้", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: /ผู้พัฒนาหนึ่ง มอบหมายงานให้คุณ/ }));
    const detail = screen.getByRole("complementary", { name: "รายละเอียดการแจ้งเตือน" });
    expect(within(detail).getByRole("link", { name: /งานตัวอย่างหนึ่ง/ })).toHaveAttribute("href", "/w/sample/p/DE/board?issue=DE-1");
    expect(within(detail).getByText("คุณเป็นผู้รับผิดชอบ")).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("read:n1:{}"));
    await user.click(within(detail).getByRole("button", { name: "รับทราบ" }));
    await user.click(within(detail).getByRole("button", { name: "เตือนฉันพรุ่งนี้" }));
    await waitFor(() => expect(calls).toEqual(expect.arrayContaining(["done:n1:{}", 'snooze:n1:{"preset":"tomorrow"}'])));
    expect(await screen.findByText("จะเตือนอีกครั้งพรุ่งนี้")).toBeInTheDocument();
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
    expect(await within(pop).findByRole("link", { name: /ผู้พัฒนาหนึ่ง DE-1/ })).toHaveAttribute("href", "/w/sample/inbox?n=n1");
    await user.click(within(pop).getByRole("tab", { name: "Mention" }));
    await waitFor(() => expect(lists.at(-1)?.searchParams.get("filter")).toBe("mention"));
    expect(lists.at(-1)?.searchParams.get("workspace")).toBeNull(); // กระดิ่งรวมทุก Workspace
    await user.click(within(pop).getByRole("button", { name: "อ่านทั้งหมด" }));
    await waitFor(() => expect(calls).toContain("read-all:{}"));
    expect(within(pop).getByRole("link", { name: "เปิด Inbox ทั้งหมด →" })).toHaveAttribute("href", "/w/sample/inbox");
  });
});
