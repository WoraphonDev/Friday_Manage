import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { Shell } from "@/features/shell/Shell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import type { Canned, Config, SettingsView } from "./_parts/types";
import { SupportSettingsPage } from "./SupportSettingsPage";

// ข้อมูลสมมติเท่านั้น
const hours = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ open: i < 5, from: "09:00", to: "18:00" }));
const config: Config = {
  mode: "least",
  defaultCap: 8,
  skipUnavailable: true,
  reopenDays: 7,
  onAway: "queue",
  sla: {
    free: { first: { n: 2, unit: "d" }, resolve: null },
    team_s: { first: { n: 4, unit: "h" }, resolve: { n: 3, unit: "d" } },
    team_m: { first: { n: 4, unit: "h" }, resolve: { n: 3, unit: "d" } },
    team_l: { first: { n: 2, unit: "h" }, resolve: { n: 2, unit: "d" } },
    enterprise: { first: { n: 1, unit: "h" }, resolve: { n: 1, unit: "d" } },
  },
  hours,
  thaiHolidays: true,
  offlineOnLogout: true,
  idleOffline: true,
  idleMinutes: 15,
  redispatch: true,
  reopenToQueue: true,
};
// รอบ 4 · S1 ปฏิทินวันหยุดของระบบ (ข้อมูลสมมติ)
let holidayList = {
  configured: true,
  syncedAt: "2026-11-15T23:00:00.000Z",
  failure: null as null | { since: string | null; message: string },
  year: null,
  items: [
    { date: "2026-12-05", name: "วันพ่อแห่งชาติ", origin: "bot" },
    { date: "2027-01-02", name: "หยุดพิเศษ (ครม.)", origin: "manual" },
  ],
};
const preview = {
  year: 2027,
  total: 19,
  items: [
    { kind: "new", date: "2027-01-01", name: "วันขึ้นปีใหม่" },
    { kind: "new", date: "2027-02-12", name: "วันมาฆบูชา" },
    { kind: "changed", date: "2027-04-07", name: "วันจักรี (ชดเชย)", from: "2027-04-06" },
    { kind: "same", date: "2027-05-01", name: "วันแรงงาน" },
  ],
  counts: { new: 2, changed: 1, removed: 0, renamed: 0, origin: 0, same: 1 },
  impact: { projects: 41, workspaces: 18, issues: 230 },
  changedDates: 4,
};
const view = (canEdit: boolean): SettingsView => ({
  config,
  rules: [
    { id: "r-1", position: 1, plans: ["enterprise"], categories: [], target: "acct", priority: "high", enabled: true },
    { id: "r-2", position: 2, plans: [], categories: ["billing", "tax_invoice", "payment"], target: "fin", priority: "normal", enabled: true },
    { id: "r-3", position: 3, plans: [], categories: [], target: "all", priority: "normal", enabled: false },
  ],
  agents: [
    { staffId: "a-1", name: "ซัพพอร์ตเอ", email: "a@friday.example.com", groups: ["l1", "lead"], cap: null, presence: "online", presenceNote: null, load: 5, accounts: [] },
    { staffId: "a-2", name: "ซัพพอร์ตบี", email: "b@friday.example.com", groups: ["l2"], cap: 6, presence: "busy", presenceNote: null, load: 6, accounts: [{ id: "w-1", name: "เทคโนวาเดโม" }] },
  ],
  warnPct: 25,
  holidays: { count: 3, upcoming: [{ date: "2026-12-05", name: "วันพ่อแห่งชาติ" }] },
  updatedAt: null,
  updatedBy: null,
  canEdit,
});
const canned: Canned[] = [{ id: "c-1", title: "ขอข้อมูลเพิ่ม", body: "ขอ requestId ของ {เลข Ticket}", tag: "ทั่วไป", uses: 88, archivedAt: null, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "เจ้าของ" }];

const calls: { method: string; path: string; body?: unknown }[] = [];
function handlers(canEdit = true) {
  calls.length = 0;
  const record = (status = 200, reply: Record<string, unknown> = { ok: true }) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.push({ method: request.method, path: new URL(request.url).pathname.replace(/^.*\/ops-api/, ""), body: text ? JSON.parse(text) : undefined });
      return HttpResponse.json(reply, { status });
    };
  server.use(
    http.get(`${OPS}/support/settings`, () => HttpResponse.json(view(canEdit))),
    http.get(`${OPS}/support/canned-replies`, () => HttpResponse.json({ items: canned })),
    http.put(`${OPS}/support/settings`, record(200, { saved: true, changes: ["x"] })),
    http.post(`${OPS}/support/rules/preview`, () => HttpResponse.json({ matches: 3 })),
    http.post(`${OPS}/support/rules`, record(201, { rule: {} })),
    http.post(`${OPS}/support/rules/reorder`, record()),
    http.patch(`${OPS}/support/rules/:id`, record()),
    http.delete(`${OPS}/support/rules/:id`, record()),
    http.post(`${OPS}/support/canned-replies`, record(201, { item: {} })),
    http.post(`${OPS}/support/canned-replies/:id/archive`, record()),
    http.get(`${OPS}/support/holidays`, () => HttpResponse.json(holidayList)),
    http.post(`${OPS}/support/holidays/impact`, () => HttpResponse.json({ projects: 41, workspaces: 18, issues: 12 })),
    http.post(`${OPS}/support/holidays/bot/preview`, () => HttpResponse.json(preview)),
    http.post(`${OPS}/support/holidays/bot/apply`, record(200, { saved: 19, added: [], removed: [], changed: 3, slaUpdated: 2 })),
    http.post(`${OPS}/support/holidays`, record(201, { holiday: {} })),
    http.delete(`${OPS}/support/holidays/:date`, record(200, { deleted: true })),
  );
}
const render = () => {
  navigation.pathname = "/support/settings";
  return renderWithProviders(
    <Shell>
      <SupportSettingsPage />
    </Shell>,
  );
};

describe("ตั้งค่าการแจกงาน Support (O22)", () => {
  it("แสดงตาม Canvas: วิธีแจก · กฎ · SLA · เวลาทำการ · พนักงาน · ข้อความสำเร็จรูป", async () => {
    handlers();
    asRole("admin");
    render();
    expect(await screen.findByRole("radio", { name: /งานน้อยที่สุดก่อน \(แนะนำ\)/ })).toBeChecked();
    expect(screen.getByText("ลูกค้าแพ็กเกจ Enterprise")).toBeInTheDocument();
    expect(screen.getByText("ประเภท = การเงิน, ใบกำกับภาษี, การชำระเงิน")).toBeInTheDocument();
    expect(screen.getByText("เรื่องอื่นทั้งหมด")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "เปิดใช้กฎข้อ 3" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("ทุกช่องทาง + LINE ของผู้ดูแลบัญชี")).toBeInTheDocument();
    expect(screen.getByText(/เตือนผู้รับผิดชอบเมื่อเหลือเวลา 25%/)).toBeInTheDocument();
    expect(await screen.findByText(/วันพ่อแห่งชาติ/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "ซัพพอร์ตเอ อยู่กลุ่มหัวหน้าทีม" })).toBeChecked();
    expect(screen.getByText("เทคโนวาเดโม")).toBeInTheDocument();
    expect(await screen.findByText("ขอข้อมูลเพิ่ม")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "บันทึก" })).toBeDisabled();
  });

  it("แก้แล้วบันทึกทั้งหน้า: วิธีแจก · SLA · เวลาทำการ · กลุ่ม/เพดานรายคน · ยกเลิกคืนค่าเดิม", async () => {
    handlers();
    asRole("admin");
    render();
    await userEvent.click(await screen.findByRole("radio", { name: /วนตามลำดับ/ }));
    expect(screen.getByText("มีการแก้ที่ยังไม่บันทึก")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(screen.getByRole("radio", { name: /งานน้อยที่สุดก่อน/ })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: /วนตามลำดับ/ }));
    await userEvent.selectOptions(screen.getByLabelText("Free · ปิดเรื่อง (เป้าหมาย) · หน่วย"), "d");
    await userEvent.click(screen.getByRole("switch", { name: "เปิดทำการวันเสาร์" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "ซัพพอร์ตบี อยู่กลุ่มการเงิน" }));
    const cap = screen.getByLabelText("เพดานงานของ ซัพพอร์ตเอ");
    await userEvent.type(cap, "5");
    await userEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    const body = calls.find((c) => c.method === "PUT")!.body as { config: Config; agents: unknown[] };
    expect(body.config).toMatchObject({ mode: "round", sla: { free: { first: { n: 2, unit: "d" }, resolve: { n: 1, unit: "d" } } } });
    expect(body.config.hours[5]).toEqual({ open: true, from: "09:00", to: "18:00" });
    expect(body.agents).toEqual([
      { staffId: "a-1", groups: ["l1", "lead"], cap: 5 },
      { staffId: "a-2", groups: ["l2", "fin"], cap: 6 },
    ]);
  });

  it("T6 เพิ่มกฎ: เลือกเงื่อนไข · นับ Ticket ที่ตรง · บันทึก · เปิด/ปิด · เรียง · ลบ", async () => {
    handlers();
    asRole("admin");
    render();
    await userEvent.click(await screen.findByRole("button", { name: "เพิ่มกฎ" }));
    const drawer = await screen.findByRole("dialog", { name: "กฎใหม่" });
    await userEvent.click(within(drawer).getByRole("button", { name: "Enterprise" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "การเงิน" }));
    await userEvent.selectOptions(within(drawer).getByLabelText("แจกให้"), "acct");
    expect(within(drawer).getByText("ถ้าไม่อยู่: คิวกลาง")).toBeInTheDocument();
    await userEvent.selectOptions(within(drawer).getByLabelText("ความสำคัญเริ่มต้น"), "high");
    expect(await within(drawer).findByText(/ตรงกับ Ticket ที่เปิดอยู่ 3 รายการ/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึกกฎ" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/support/rules")?.body).toEqual({ plans: ["enterprise"], categories: ["billing"], target: "acct", priority: "high" }));

    await userEvent.click(screen.getByRole("switch", { name: "เปิดใช้กฎข้อ 3" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/support/rules/r-3", body: { enabled: true } }));
    await userEvent.click(screen.getByRole("button", { name: "เลื่อนกฎข้อ 2 ขึ้น" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/support/rules/reorder")?.body).toEqual({ ids: ["r-2", "r-1", "r-3"] }));
    await userEvent.click(screen.getByRole("button", { name: "ลบกฎข้อ 1" }));
    const dlg = await screen.findByRole("dialog", { name: "ลบกฎข้อ 1?" });
    await userEvent.click(within(dlg).getByRole("button", { name: "ลบกฎข้อ 1" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/support/rules/r-1"));
  });

  it("ข้อความสำเร็จรูป: เพิ่มพร้อมตัวแปร · เลิกใช้", async () => {
    handlers();
    asRole("admin");
    render();
    await userEvent.click(await screen.findByRole("button", { name: "เพิ่มข้อความ" }));
    const dlg = await screen.findByRole("dialog", { name: "เพิ่มข้อความสำเร็จรูป" });
    await userEvent.type(within(dlg).getByLabelText("ชื่อ"), "ขอบคุณ");
    await userEvent.type(within(dlg).getByLabelText("ข้อความ"), "ขอบคุณคุณ");
    await userEvent.click(within(dlg).getByRole("button", { name: "ใส่ {ชื่อผู้แจ้ง}" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/support/canned-replies")?.body).toEqual({ title: "ขอบคุณ", body: "ขอบคุณคุณ{ชื่อผู้แจ้ง}" }));
    await userEvent.click(screen.getByRole("button", { name: "เลิกใช้" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/support/canned-replies/c-1/archive")).toBe(true));
  });

  it("S4 เมื่อพนักงานไม่อยู่: ออฟไลน์อัตโนมัติ · นาที · เรื่องที่ถืออยู่ · แจกใหม่ · ลูกค้าตอบเรื่องที่ปิดแล้ว", async () => {
    handlers();
    asRole("admin");
    render();
    const card = await screen.findByRole("region", { name: "เมื่อพนักงานไม่อยู่" });
    expect(within(card).getByRole("checkbox", { name: "ออกจากระบบ หรือหมดเวลาเข้าระบบ (8 ชม.)" })).toBeChecked();
    expect(within(card).getByRole("radio", { name: "คืนงานเข้าคิวกลางอัตโนมัติ" })).toBeChecked();
    await userEvent.selectOptions(within(card).getByLabelText("นานกี่นาทีถึงถือว่าไม่มีการใช้งาน"), "30");
    await userEvent.click(within(card).getByRole("radio", { name: "ถามหัวหน้าทีมก่อน" }));
    await userEvent.click(within(card).getByRole("switch", { name: "แจกเรื่องในคิวกลางใหม่อัตโนมัติ" }));
    await userEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect((calls.find((c) => c.method === "PUT")!.body as { config: Config }).config).toMatchObject({ idleMinutes: 30, onAway: "ask_lead", redispatch: false, reopenToQueue: true, offlineOnLogout: true });
    await userEvent.click(within(card).getByRole("checkbox", { name: "ไม่มีการใช้งานนาน" }));
    expect(within(card).getByLabelText("นานกี่นาทีถึงถือว่าไม่มีการใช้งาน")).toBeDisabled();
  });

  it("S1–S2 ปฏิทินวันหยุดของระบบ: ป้ายที่มา · ดึงจาก ธปท. ตรวจก่อนบันทึก · เพิ่ม / ลบเอง (Support แก้ได้)", async () => {
    handlers(false);
    asRole("support");
    render();
    const cal = await screen.findByRole("group", { name: "ปฏิทินวันหยุดของระบบ" });
    expect(await within(cal).findByText("วันพ่อแห่งชาติ")).toBeInTheDocument();
    expect(within(cal).getByText(/5 ธ\.ค\. 2569 \(ส\.\)/)).toBeInTheDocument();
    expect(within(cal).getByText("เพิ่มเอง")).toBeInTheDocument();
    expect(within(cal).getByText(/^ตรงกับ ธปท\. · ดึงล่าสุด/)).toBeInTheDocument();

    await userEvent.click(within(cal).getByRole("button", { name: "ดึงจาก ธปท. ตอนนี้" }));
    const dlg = await screen.findByRole("dialog", { name: "ดึงวันหยุดจาก ธปท." });
    expect(await within(dlg).findByText("วันมาฆบูชา")).toBeInTheDocument();
    expect(within(dlg).getByText(/6 เม\.ย\. 2570 \(อ\.\) → 7 เม\.ย\. 2570 \(พ\.\)/)).toBeInTheDocument();
    expect(within(dlg).queryByText("วันแรงงาน")).toBeNull();
    expect(within(dlg).getByText(/41 โปรเจกต์ใน 18 Workspace ใช้ปฏิทินของระบบ/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "SLA ของ Ticket ที่เปิดอยู่คิดตามปฏิทินใหม่" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก 19 วัน" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/support/holidays/bot/apply")?.body).toMatchObject({ recalc: true, sla: false }));

    await userEvent.click(within(cal).getByRole("button", { name: "เพิ่มวันหยุดเอง" }));
    const add = await screen.findByRole("dialog", { name: "เพิ่มวันหยุดเอง" });
    await userEvent.type(within(add).getByLabelText("วันที่"), "2027-03-03");
    await userEvent.type(within(add).getByLabelText("ชื่อวันหยุด"), "หยุดพิเศษสมมติ");
    expect(await within(add).findByText(/งาน 12 งานจะคำนวณใหม่/)).toBeInTheDocument();
    await userEvent.click(within(add).getByRole("button", { name: "เพิ่มวันหยุด" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/support/holidays" && c.method === "POST")?.body).toEqual({ date: "2027-03-03", name: "หยุดพิเศษสมมติ", recalc: true, sla: true }));

    await userEvent.click(within(cal).getByRole("button", { name: "ลบ หยุดพิเศษ (ครม.)" }));
    const del = await screen.findByRole("dialog", { name: "ลบวันหยุด หยุดพิเศษ (ครม.)?" });
    await userEvent.click(within(del).getByRole("checkbox", { name: "คำนวณ Plan End ใหม่และแจ้ง PM ของโปรเจกต์ที่มีงานเลื่อน" }));
    await userEvent.click(within(del).getByRole("button", { name: "ลบวันหยุด" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE" && c.path.startsWith("/support/holidays"))?.path).toBe("/support/holidays/2027-01-02"));
  });

  it("S1 ยังไม่ตั้ง Client ID / ดึงไม่สำเร็จ: บอกสถานะ · ปุ่มดึงปิด · เพิ่มเองได้", async () => {
    handlers();
    holidayList = { ...holidayList, configured: false };
    asRole("admin");
    const { unmount } = render();
    const cal = await screen.findByRole("group", { name: "ปฏิทินวันหยุดของระบบ" });
    expect(await within(cal).findByText("ยังไม่เชื่อม API ธปท.")).toBeInTheDocument();
    expect(within(cal).getByRole("button", { name: "ดึงจาก ธปท. ตอนนี้" })).toBeDisabled();
    expect(within(cal).getByRole("button", { name: "เพิ่มวันหยุดเอง" })).toBeEnabled();
    unmount();
    holidayList = { ...holidayList, configured: true, failure: { since: "2026-11-14T23:00:00.000Z", message: "ธปท. ตอบ HTTP 500" } };
    render();
    const again = await screen.findByRole("group", { name: "ปฏิทินวันหยุดของระบบ" });
    expect(await within(again).findByText(/^ดึงไม่สำเร็จตั้งแต่/)).toBeInTheDocument();
    expect(within(again).getByText(/ใช้ข้อมูลเดิมต่อ · เพิ่มวันหยุดเองได้เสมอ · สาเหตุ: ธปท\. ตอบ HTTP 500/)).toBeInTheDocument();
    holidayList = { ...holidayList, failure: null };
  });

  it("Support ดูได้อย่างเดียว · การเงินเข้าไม่ได้ · error ตาม M1", async () => {
    handlers(false);
    asRole("support");
    const { unmount } = render();
    expect(await screen.findByText("ดูได้อย่างเดียว · แก้ได้เฉพาะ Owner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "บันทึก" })).toBeNull();
    expect(screen.queryByRole("button", { name: "เพิ่มกฎ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "เพิ่มข้อความ" })).toBeNull();
    expect(screen.getByRole("radio", { name: /วนตามลำดับ/ })).toBeDisabled();
    unmount();
    asRole("finance");
    const f = render();
    expect(await screen.findByText(/^หน้านี้เปิดให้ Owner/)).toBeInTheDocument();
    f.unmount();
    server.use(http.get(`${OPS}/support/settings`, () => opsError(500, "internal", "ระบบขัดข้อง", undefined, "req-sset-1")));
    asRole("admin");
    render();
    expect(await screen.findByText(/req-sset-1/)).toBeInTheDocument();
  });
});
