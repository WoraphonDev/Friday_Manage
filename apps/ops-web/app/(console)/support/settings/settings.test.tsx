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
    expect(screen.getByText(/วันพ่อแห่งชาติ/)).toBeInTheDocument();
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
