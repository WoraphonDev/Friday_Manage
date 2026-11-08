import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import kanban from "../../messages/th/kanban.json";
import { KanbanBoard } from "../../app/work/[ws]/p/[key]/board/_components/kanban-board";
import type { BoardCard, BoardData, MoveBody } from "../../app/work/[ws]/p/[key]/board/_components/types";
import { moveLocal } from "../../app/work/[ws]/p/[key]/board/_components/types";

const person = { id: "dev-one", displayName: "ผู้ทดสอบหนึ่ง", initials: "ท1" };
function card(key: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return { key, title: `งานตัวอย่าง ${key}`, type: { name: "Task", color: "#1d4ed8" }, status: { id: "todo", name: "To do", category: "todo" }, module: { id: "module-one", name: "ระบบบัญชีตัวอย่าง", color: "#1d4ed8" }, phase: { id: "phase-one", name: "กลุ่มงานตัวอย่าง" }, parentKey: null, sprintId: null, priority: "high", planStart: "2026-11-01", planEnd: "2026-11-03", due: { state: "overdue", days: 2 }, assignees: [person], subtasks: null, comments: 2, rank: key, version: 3, ...overrides };
}
function initialBoard(): BoardData {
  return { project: { key: "DE", name: "แผนตัวอย่าง" }, board: "standard", today: "2026-11-05", hiddenDone: 7, bugStatusColumns: [{ status: "Verified", column: "Review" }], columns: [
    { id: "todo", name: "To do", category: "todo", count: 3, wip: { limit: null, current: 3, exceeded: false }, cards: [card("DE-1"), card("DE-2", { module: { id: "module-two", name: "ระบบรายงานตัวอย่าง", color: "#0f766e" }, assignees: [], priority: "low" }), card("DE-3", { parentKey: "DE-1", module: null, priority: "medium" })] },
    { id: "progress", name: "In progress", category: "in_progress", count: 1, wip: { limit: 1, current: 2, exceeded: true }, cards: [card("DE-4", { status: { id: "progress", name: "In progress", category: "in_progress" }, subtasks: { done: 1, total: 3 } })] },
    { id: "review", name: "Review", category: "in_progress", count: 1, wip: { limit: 3, current: 1, exceeded: false }, cards: [card("DE-5", { type: { name: "Bug", color: "#dc2626" }, status: { id: "bug-verified", name: "Verified", category: "in_progress" } })] },
    { id: "done", name: "Done", category: "done", count: 0, wip: { limit: null, current: 0, exceeded: false }, cards: [] },
  ] };
}
let data: BoardData;
let requests: URL[];
let moves: { key: string; body: MoveBody; etag: string | null; csrf: string | null }[];
function mount(ws = "sample", projectKey = "DE") {
  return renderWithProviders(<KanbanBoard ws={ws} projectKey={projectKey} />, { messages: { kanban } });
}
const article = (key: string) => screen.getByRole("article", { name: `การ์ด ${key}` });
const column = (name: string) => screen.getByRole("region", { name: `คอลัมน์ ${name}` });
const errorResponse = (status: number, code: string, details = {}) => HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", details, requestId: "req_kanban_001" } }, { status });

beforeEach(() => {
  navigation.pathname = "/work/sample/p/DE/board";
  data = initialBoard(); requests = []; moves = [];
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/board", ({ request }) => { requests.push(new URL(request.url)); return HttpResponse.json(data); }),
    http.post("*/api/v1/w/:ws/issues/:key/move", async ({ request, params }) => {
      const body = await request.json() as MoveBody;
      moves.push({ key: String(params.key), body, etag: request.headers.get("if-match"), csrf: request.headers.get("x-csrf-token") });
      const source = data.columns.find((column) => column.cards.some((card) => card.key === params.key))!;
      const item = source.cards.find((card) => card.key === params.key)!;
      source.cards = source.cards.filter((card) => card !== item);
      const target = data.columns.find((column) => column.id === body.statusId) ?? data.columns.find((column) => column.id === "review")!;
      item.status = { id: body.statusId, name: body.statusId === "bug-verified" ? "Verified" : target.name, category: target.category };
      item.version++;
      const index = body.beforeKey ? target.cards.findIndex((card) => card.key === body.beforeKey) : target.cards.length;
      target.cards.splice(index, 0, item);
      data.columns.forEach((column) => { column.count = column.cards.length; });
      return HttpResponse.json({ version: item.version, warnings: [] });
    }),
  );
});

describe("Kanban", () => {
  it("แสดงคอลัมน์ WIP และการ์ดครบ พร้อมลิงก์เปิด Drawer", async () => {
    mount();
    expect(screen.getAllByLabelText("กำลังโหลด…")[0]).toBeInTheDocument();
    await screen.findByRole("article", { name: "การ์ด DE-1" });
    expect(screen.getByText("WIP 2/1")).toBeInTheDocument();
    expect(within(article("DE-4")).getByTitle("Sub-task 1/3")).toBeInTheDocument();
    expect(within(article("DE-1")).getByTitle("คอมเมนต์ 2")).toBeInTheDocument();
    expect(within(article("DE-1")).getByText("เลย 2 วัน")).toBeInTheDocument();
    expect(within(article("DE-5")).getByText("Verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "งานตัวอย่าง DE-1" })).toHaveAttribute("href", "/work/sample/p/DE/board?issue=DE-1");
    expect(screen.getAllByRole("link", { name: "+ เพิ่มการ์ด" })).toHaveLength(4);
  });

  it("ย้ายด้วย keyboard แล้วเลิกทำคืนสถานะ Bug จริง ใช้ CSRF และ If-Match รุ่นใหม่", async () => {
    const user = userEvent.setup(); mount();
    const button = await screen.findByRole("button", { name: "ย้าย DE-5 ไปคอลัมน์ขวา" });
    button.focus(); await user.keyboard("{Enter}");
    await screen.findByText("ย้าย DE-5 ไป Done แล้ว");
    expect(moves[0]).toMatchObject({ key: "DE-5", body: { statusId: "done" }, etag: '"3"', csrf: "test-csrf" });
    await user.click(screen.getByRole("button", { name: "เลิกทำ" }));
    await screen.findByText("เลิกทำการย้าย DE-5 แล้ว");
    expect(moves[1]).toMatchObject({ body: { statusId: "bug-verified" }, etag: '"4"' });
    expect(within(column("Review")).getByText("Verified")).toBeInTheDocument();
  });

  it("ลากเรียงในคอลัมน์ และข้ามคอลัมน์ ส่งเพื่อนบ้าน beforeKey/afterKey", async () => {
    mount(); await screen.findByRole("article", { name: "การ์ด DE-2" });
    const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(article("DE-2"), { dataTransfer: transfer });
    fireEvent.dragOver(article("DE-1"), { dataTransfer: transfer });
    fireEvent.drop(article("DE-1"), { dataTransfer: transfer });
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0].body).toEqual({ statusId: "todo", beforeKey: "DE-1" });
    await screen.findByText("เรียงลำดับ DE-2 แล้ว");
    await waitFor(() => expect(screen.getByRole("button", { name: "ย้าย DE-1 ไปคอลัมน์ขวา" })).toBeEnabled());
    fireEvent.dragStart(article("DE-1"), { dataTransfer: transfer });
    fireEvent.dragOver(column("In progress"), { dataTransfer: transfer });
    fireEvent.drop(column("In progress"), { dataTransfer: transfer });
    await waitFor(() => expect(moves).toHaveLength(2));
    expect(moves[1].body).toEqual({ statusId: "progress", afterKey: "DE-4" });
    await waitFor(() => expect(within(column("In progress")).getByText("งานตัวอย่าง DE-1")).toBeInTheDocument());
  });

  it("ปุ่มขึ้นลงเรียงลำดับได้โดยไม่ต้องลาก และป้องกันการวางตัวเอง", async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole("button", { name: "เลื่อน DE-2 ขึ้น" }));
    await screen.findByText("เรียงลำดับ DE-2 แล้ว");
    expect(moves[0].body).toEqual({ statusId: "todo", beforeKey: "DE-1" });
    await user.click(screen.getByRole("button", { name: "เลื่อน DE-2 ลง" }));
    await waitFor(() => expect(moves).toHaveLength(2));
    expect(moves[1].body).toEqual({ statusId: "todo", afterKey: "DE-1", beforeKey: "DE-3" });
  });

  it("422 subtasks_incomplete ต้องยืนยันก่อนส่ง confirm และยกเลิกได้", async () => {
    const user = userEvent.setup(); let calls: MoveBody[] = [];
    server.use(http.post("*/api/v1/w/:ws/issues/:key/move", async ({ request }) => {
      const body = await request.json() as MoveBody; calls.push(body);
      return body.confirm ? HttpResponse.json({ version: 4, warnings: [{ code: "subtasks_incomplete", message: "ยังมีงานย่อยที่ไม่เสร็จ" }] }) : errorResponse(422, "subtasks_incomplete", { open: 2, confirmable: true });
    }));
    mount(); await user.click(await screen.findByRole("button", { name: "ย้าย DE-5 ไปคอลัมน์ขวา" }));
    await screen.findByRole("dialog", { name: "Sub-task ยังไม่เสร็จ" });
    expect(calls).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "ย้าย DE-5 ไปคอลัมน์ขวา" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "ยืนยันย้าย" }));
    await waitFor(() => expect(calls.at(-1)?.confirm).toBe(true));
    await screen.findByText(/ย้าย DE-5 ไป Done แล้ว · ยังมีงานย่อย/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("มือถือเลือกคอลัมน์และใช้ Dialog ย้ายไปคอลัมน์ที่ต้องการได้", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    await user.click(within(screen.getByRole("group", { name: "คอลัมน์" })).getByRole("button", { name: /In progress/ }));
    expect(column("In progress")).toHaveAttribute("data-mobile-active", "true");
    await user.click(within(article("DE-4")).getByRole("button", { name: "ย้ายไป…" }));
    const dialog = await screen.findByRole("dialog", { name: "ย้ายงาน DE-4" });
    expect(within(dialog).getByRole("button", { name: /In progress/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    await waitFor(() => expect(moves[0].body.statusId).toBe("review"));
  });

  it("Module filter และ Swimlane Module/Assignee/Priority จัดกลุ่มฝั่งหน้าเว็บ", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    await user.click(within(screen.getByRole("group", { name: "ตัวกรอง Module" })).getByRole("button", { name: /ระบบรายงานตัวอย่าง/ }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(article("DE-2")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "คอลัมน์" })).getByRole("button", { name: "To do 1" })).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    await user.click(within(screen.getByRole("group", { name: "ตัวกรอง Module" })).getByRole("button", { name: /ทั้งหมด/ }));
    await user.selectOptions(screen.getByLabelText("Swimlane"), "module");
    expect(screen.getByRole("heading", { name: /ไม่ระบุ Module/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Swimlane"), "assignee");
    expect(screen.getByRole("heading", { name: /ผู้ทดสอบหนึ่ง/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /ยังไม่ระบุผู้รับผิดชอบ/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Swimlane"), "priority");
    expect(screen.getByRole("heading", { name: /Medium/ })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(5);
    expect(requests).toHaveLength(1);
  });

  it("ส่งตัวกรองงานของฉัน/overdue/ระดับงาน และสลับ Show older", async () => {
    const user = userEvent.setup(); mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    await user.click(screen.getByRole("button", { name: "งานของฉัน" }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("assignee")).toBe("me"));
    await user.click(await screen.findByRole("button", { name: "เลยกำหนด" }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("overdue")).toBe("true"));
    await user.selectOptions(await screen.findByLabelText("แสดง"), "subtask");
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("level")).toBe("subtask"));
    await user.click(await screen.findByRole("button", { name: /แสดงงานเก่า \(7\)/ }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("showOlderDone")).toBe("true"));
    await user.click(await screen.findByRole("button", { name: "ซ่อนงานที่เสร็จเกิน 7 วัน" }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("showOlderDone")).toBe("false"));
  });

  it("สลับบอร์ด Bug ด้วย URL และเก็บ query ของ Drawer", async () => {
    const user = userEvent.setup(); navigation.search = "issue=DE-1";
    const view = mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    await user.selectOptions(screen.getByLabelText("ประเภทบอร์ด"), "bug");
    expect(router.replace).toHaveBeenCalledWith("/work/sample/p/DE/board?issue=DE-1&type=bug", { scroll: false });
    navigation.search = "type=bug";
    view.rerender(<KanbanBoard ws="sample" projectKey="DE" />);
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("type")).toBe("bug"));
  });

  it("ไม่มี issue.edit/create จะซ่อนปุ่มเขียนและปิดการลาก", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ role: "viewer", guestViewer: false, permissions: ["project.view"] })));
    mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    expect(article("DE-1")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: /ย้าย DE-/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "+ เพิ่มการ์ด" })).not.toBeInTheDocument();
    expect(moves).toHaveLength(0);
  });

  it("403 และ Guest Viewer แสดงสถานะไม่มีสิทธิ์", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ role: "viewer", guestViewer: true, permissions: ["project.view"] })));
    mount(); await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง");
    expect(requests).toHaveLength(0);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it.each(["permissions", "board"])("HTTP403 จาก %s ไม่แสดงข้อมูลบอร์ด", async (source) => {
    server.use(http.get(source === "permissions" ? "*/api/v1/w/:ws/projects/:key/my-permissions" : "*/api/v1/w/:ws/projects/:key/board", () => errorResponse(403, "forbidden")));
    mount(); await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("เปิดตัวกรองบนมือถือ และกันคำขอย้ายซ้ำระหว่างรอ API", async () => {
    const user = userEvent.setup(); let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    server.use(http.post("*/api/v1/w/:ws/issues/:key/move", async () => { calls++; await pending; return HttpResponse.json({ version: 4, warnings: [] }); }));
    mount(); const button = await screen.findByRole("button", { name: "ย้าย DE-1 ไปคอลัมน์ขวา" });
    const filters = screen.getByRole("button", { name: "ตัวกรอง" });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    await user.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(1));
    // การ์ดย้ายไปคอลัมน์ใหม่ทันทีระหว่างรอ API และปุ่มย้ายถูกปิดกันกดซ้ำ
    expect(within(column("In progress")).getByRole("article", { name: "การ์ด DE-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ย้าย DE-1 ไปคอลัมน์ขวา" })).toBeDisabled();
    release();
    await screen.findByText("ย้าย DE-1 ไป In progress แล้ว");
    expect(calls).toBe(1);
  });

  it("โหลดผิดพลาดแสดง requestId และลองอีกครั้งได้", async () => {
    const user = userEvent.setup(); let fail = true;
    server.use(http.get("*/api/v1/w/:ws/projects/:key/board", () => fail ? errorResponse(500, "failed") : HttpResponse.json(data)));
    mount(); await screen.findByText(/req_kanban_001/);
    expect(screen.getByRole("alert")).toHaveTextContent("ข้อผิดพลาดทดสอบ");
    fail = false;
    await user.click(screen.getByRole("button", { name: "ลองอีกครั้ง" }));
    await screen.findByRole("article", { name: "การ์ด DE-1" });
  });

  it("บอร์ดว่างและคอลัมน์ว่างมีสถานะและปุ่มสร้างตามสิทธิ์", async () => {
    data.columns.forEach((column) => { column.cards = []; column.count = 0; });
    mount(); await screen.findByText("ยังไม่มีงานบนบอร์ด");
    expect(screen.getByRole("link", { name: "+ สร้างงาน" })).toHaveAttribute("href", "/work/sample/p/DE/board?new=1&type=task");
    expect(screen.getAllByText("ไม่มีงานในคอลัมน์นี้")).toHaveLength(4);
  });

  it("move conflict แสดงคำแนะนำ/requestId และไม่ย้ายการ์ดใน UI ล่วงหน้า", async () => {
    const user = userEvent.setup(); server.use(http.post("*/api/v1/w/:ws/issues/:key/move", () => errorResponse(409, "conflict")));
    mount(); await user.click(await screen.findByRole("button", { name: "ย้าย DE-1 ไปคอลัมน์ขวา" }));
    // toast สีแดงที่หายเอง · บอร์ดโหลดค่าล่าสุดให้เอง
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("งานนี้มีการเปลี่ยนแปลงแล้ว โหลดข้อมูลล่าสุดก่อนย้ายอีกครั้ง");
    expect(alert).not.toHaveTextContent("req_kanban_001"); // 4xx ผู้ใช้แก้เองได้ ไม่แสดงรหัสอ้างอิง (ผู้ใช้ขอ 2026-11-09)
    expect(within(column("To do")).getByText("งานตัวอย่าง DE-1")).toBeInTheDocument();
  });

  it("เรียงลำดับตามการ์ดที่มองเห็นเมื่อกรอง Module", async () => {
    const user = userEvent.setup();
    data.columns[0].cards[2].module = data.columns[0].cards[0].module;
    mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    await user.click(within(screen.getByRole("group", { name: "ตัวกรอง Module" })).getByRole("button", { name: /ระบบบัญชีตัวอย่าง/ }));
    expect(screen.queryByRole("article", { name: "การ์ด DE-2" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เลื่อน DE-1 ลง" }));
    await waitFor(() => expect(moves[0].body).toEqual({ statusId: "todo", afterKey: "DE-3" }));
    await waitFor(() => expect(within(column("To do")).getAllByRole("article").map((item) => item.getAttribute("aria-label"))).toEqual(["การ์ด DE-3", "การ์ด DE-1"]));
  });

  it("Undo กลับ Done เปิดยืนยัน Sub-task และคง version ล่าสุด", async () => {
    const user = userEvent.setup();
    const parent = data.columns[2].cards.pop()!;
    parent.status = { id: "done", name: "Done", category: "done" };
    data.columns[3].cards.push(parent);
    const calls: { body: MoveBody; etag: string | null }[] = [];
    server.use(http.post("*/api/v1/w/:ws/issues/:key/move", async ({ request }) => {
      const body = await request.json() as MoveBody; calls.push({ body, etag: request.headers.get("if-match") });
      if (body.statusId === "done" && !body.confirm) return errorResponse(422, "subtasks_incomplete", { open: 2, confirmable: true });
      data.columns.forEach((column) => { column.cards = column.cards.filter((item) => item.key !== parent.key); });
      const target = data.columns.find((column) => column.id === body.statusId)!;
      parent.version++; parent.status = { id: target.id, name: target.name, category: target.category }; target.cards.push(parent);
      return HttpResponse.json({ version: parent.version, warnings: [] });
    }));
    mount(); await user.click(await screen.findByRole("button", { name: "ย้าย DE-5 ไปคอลัมน์ซ้าย" }));
    await screen.findByText("ย้าย DE-5 ไป Review แล้ว");
    await user.click(screen.getByRole("button", { name: "เลิกทำ" }));
    await screen.findByRole("dialog", { name: "Sub-task ยังไม่เสร็จ" });
    await user.click(screen.getByRole("button", { name: "ยืนยันย้าย" }));
    await screen.findByText("เลิกทำการย้าย DE-5 แล้ว");
    expect(calls).toMatchObject([{ body: { statusId: "review" }, etag: '\"3\"' }, { body: { statusId: "done" }, etag: '\"4\"' }, { body: { statusId: "done", confirm: true }, etag: '\"4\"' }]);
  });

  it("เปลี่ยนโปรเจกต์แล้วล้างตัวกรองและ Undo ของโปรเจกต์เก่า", async () => {
    const user = userEvent.setup(); const view = mount();
    await screen.findByRole("article", { name: "การ์ด DE-2" });
    await user.click(within(screen.getByRole("group", { name: "ตัวกรอง Module" })).getByRole("button", { name: /ระบบรายงานตัวอย่าง/ }));
    await user.click(screen.getByRole("button", { name: "ย้าย DE-2 ไปคอลัมน์ขวา" }));
    await screen.findByText("ย้าย DE-2 ไป In progress แล้ว");
    expect(screen.getByRole("button", { name: "เลิกทำ" })).toBeInTheDocument();
    data = initialBoard();
    view.rerender(<KanbanBoard ws="other" projectKey="XY" />);
    await screen.findByRole("article", { name: "การ์ด DE-1" });
    expect(screen.queryByRole("button", { name: "เลิกทำ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(5);
    expect(moves).toHaveLength(1);
  });

  it("แยก cache ตาม Workspace และ Project", async () => {
    const view = mount(); await screen.findByRole("article", { name: "การ์ด DE-1" });
    data = { ...initialBoard(), columns: initialBoard().columns.map((column) => ({ ...column, cards: [] })) };
    view.rerender(<KanbanBoard ws="other" projectKey="XY" />);
    await screen.findByText("ยังไม่มีงานบนบอร์ด");
    expect(screen.queryByRole("article", { name: "การ์ด DE-1" })).not.toBeInTheDocument();
    expect(requests.at(-1)?.pathname).toContain("/w/other/projects/XY/board");
  });
});

describe("moveLocal (ย้ายบนจอก่อน API ตอบ)", () => {
  const keys = (board: BoardData, id: string) => board.columns.find((c) => c.id === id)!.cards.map((c) => c.key);
  it("วางตาม beforeKey / afterKey / ท้ายคอลัมน์ และเปลี่ยนสถานะตามคอลัมน์", () => {
    const board = initialBoard();
    expect(keys(moveLocal(board, "DE-3", { statusId: "todo", beforeKey: "DE-1" })!, "todo")).toEqual(["DE-3", "DE-1", "DE-2"]);
    expect(keys(moveLocal(board, "DE-1", { statusId: "progress", afterKey: "DE-4" })!, "progress")).toEqual(["DE-4", "DE-1"]);
    const done = moveLocal(board, "DE-2", { statusId: "done" })!;
    expect(keys(done, "done")).toEqual(["DE-2"]);
    expect(keys(done, "todo")).toEqual(["DE-1", "DE-3"]);
    expect(done.columns[3].cards[0].status).toEqual({ id: "done", name: "Done", category: "done" });
    // ไม่แก้ข้อมูลเดิม (ใช้คืนค่าเมื่อ API ล้มเหลว)
    expect(keys(board, "todo")).toEqual(["DE-1", "DE-2", "DE-3"]);
  });
  it("Bug คงสถานะจริง และสถานะที่ไม่ใช่คอลัมน์คืน null", () => {
    const board = initialBoard();
    expect(moveLocal(board, "DE-5", { statusId: "done" })!.columns[3].cards[0].status.name).toBe("Verified");
    expect(moveLocal(board, "DE-5", { statusId: "bug-verified" })).toBeNull();
  });
});
