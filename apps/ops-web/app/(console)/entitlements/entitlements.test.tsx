import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { Shell } from "@/features/shell/Shell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { EntitlementsPage } from "./EntitlementsPage";
import type { Matrix, Overview } from "./_parts/types";

// ข้อมูลสมมติเท่านั้น
const row = (seats: number | null, projects: number | null, gb: number | null, runs: number | null, rpm: number, days: number | null, paid: boolean, ent = false) => ({
  seats, projects, storage_gb_per_member: gb, automation_runs: runs, api_rpm: rpm, history_days: days,
  gantt: paid, import_update: paid, channels: paid, automation: paid, api: paid, guests: true, sso: ent, sla: ent,
});
const matrix: Matrix = {
  free: row(5, 3, 1, 100, 0, 30, false),
  team_s: row(10, null, 10, 5000, 60, 365, true),
  team_m: row(25, null, 10, 20000, 120, 365, true),
  team_l: row(50, null, 10, 50000, 300, 1095, true),
  enterprise: row(null, null, null, null, 1000, null, true, true),
};
const keys: Overview["keys"] = [
  { key: "seats", kind: "limit", unit: "count", enforced: true },
  { key: "projects", kind: "limit", unit: "count", enforced: true },
  { key: "storage_gb_per_member", kind: "limit", unit: "gb_per_member", enforced: true },
  { key: "automation_runs", kind: "limit", unit: "per_month", enforced: true },
  { key: "api_rpm", kind: "limit", unit: "per_minute", enforced: true },
  { key: "history_days", kind: "limit", unit: "days", enforced: false },
  ...(["gantt", "import_update", "channels", "automation", "api", "guests", "sso", "sla"] as const).map((key) => ({ key, kind: "feature" as const, enforced: !["gantt", "sso", "sla"].includes(key) })),
];
const in3days = new Date(Date.now() + 3 * 86_400_000).toISOString();
const overview: Overview = {
  keys,
  overrideKeys: ["seats", "storage_gb", "api_rpm", "automation_runs", "sso"],
  plans: [
    { code: "free", name: "Free", customers: 120 },
    { code: "team_s", name: "Team S", customers: 41 },
    { code: "team_m", name: "Team M", customers: 18 },
    { code: "team_l", name: "Team L", customers: 6 },
    { code: "enterprise", name: "Enterprise", customers: 2 },
  ],
  current: { version: 3, effectiveAt: "2026-11-01T03:00:00.000Z", matrix, reason: "ปรับ Automation", createdBy: "การเงินตัวอย่าง", approvedBy: "แอดมินตัวอย่าง" },
  scheduled: [],
  pending: [],
  overrides: [
    { id: "ov-1", workspace: { id: "w-1", name: "สยามเดโม", slug: "siam-demo", plan: "team_m" }, key: "seats", base: 25, value: 30, expiresAt: "2026-12-31T16:59:59.000Z", contractRef: null, reason: "ทีมเพิ่มชั่วคราว", createdBy: "แอดมินตัวอย่าง", approvedBy: null, status: "active" },
    { id: "ov-2", workspace: { id: "w-2", name: "โนวาเดโม", slug: "nova-demo", plan: "enterprise" }, key: "seats", base: null, value: 120, expiresAt: null, contractRef: "ENT-DEMO-004", reason: "สัญญา Enterprise", createdBy: "แอดมินตัวอย่าง", approvedBy: "แอดมินตัวอย่าง", status: "contract" },
    { id: "ov-3", workspace: { id: "w-3", name: "คณิตแล็บเดโม", slug: "kanit-demo", plan: "team_l" }, key: "sso", base: false, value: true, expiresAt: in3days, contractRef: null, reason: "ทดลองก่อนซื้อ", createdBy: "การเงินตัวอย่าง", approvedBy: "แอดมินตัวอย่าง", status: "expiring" },
  ],
  nearLimit: [
    { workspace: { id: "w-4", name: "เชียงใหม่คราฟต์เดโม", slug: "craft-demo" }, plan: "team_s", key: "seats", used: 9, limit: 10, ratio: 0.9, etaDays: 12, referredAt: null },
    { workspace: { id: "w-5", name: "พิกเซลเดโม", slug: "pixel-demo" }, plan: "team_s", key: "storage", used: 46 * 1024 ** 3, limit: 50 * 1024 ** 3, ratio: 0.92, etaDays: null, referredAt: "2026-11-09T03:00:00.000Z" },
  ],
};

const calls: { method: string; path: string; body?: unknown }[] = [];
function handlers(data: Overview = overview) {
  calls.length = 0;
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname.replace(/^.*\/ops-api/, ""), body: text ? JSON.parse(text) : undefined });
  };
  server.use(
    http.get(`${OPS}/entitlements`, () => HttpResponse.json(data)),
    http.get(`${OPS}/entitlements/versions`, () =>
      HttpResponse.json({
        items: [
          { version: 3, effectiveAt: "2026-11-01T00:00:00+07:00", reason: "ปรับ Automation", restoredFrom: null, createdBy: "การเงินตัวอย่าง", approvedBy: "แอดมินตัวอย่าง", status: "current", changes: [{ plan: "team_s", key: "automation_runs", from: 3000, to: 5000, reduced: false }] },
          { version: 2, effectiveAt: "2026-07-01T00:00:00+07:00", reason: "เพิ่ม Guest", restoredFrom: null, createdBy: "แอดมินตัวอย่าง", approvedBy: null, status: "past", changes: [{ plan: "free", key: "guests", from: false, to: true, reduced: false }] },
          { version: 1, effectiveAt: "2026-05-01T00:00:00+07:00", reason: "เปิดตัว", restoredFrom: null, createdBy: null, approvedBy: null, status: "past", changes: [] },
        ],
      }),
    ),
    http.post(`${OPS}/entitlements/preview`, async ({ request }) => {
      const body = (await request.json()) as { matrix: Matrix };
      return HttpResponse.json({
        fromVersion: 3,
        nextVersion: 4,
        changes: [{ plan: "team_s", key: "seats", from: 10, to: body.matrix.team_s.seats, reduced: true }],
        affected: [{ plan: "team_s", key: "seats", from: 10, to: body.matrix.team_s.seats, workspaces: 7, examples: [{ id: "w-4", name: "เชียงใหม่คราฟต์เดโม" }] }],
        affectedTotal: 7,
      });
    }),
    http.post(`${OPS}/entitlements/versions*`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ pendingApproval: { id: "ap-9", kind: "entitlements.version", reason: "x", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), amountSatang: null, payload: { rule: "บันทึกสิทธิ์เป็นเวอร์ชันใหม่ต้องมีคนอนุมัติ" }, canSelfApprove: false } }, { status: 202 });
    }),
    http.post(`${OPS}/entitlements/overrides`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ id: "ov-new" }, { status: 201 });
    }),
    http.post(`${OPS}/entitlements/overrides/:id/revoke`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ revoked: true });
    }),
    http.post(`${OPS}/entitlements/near-limit/:id/refer`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ referredAt: new Date().toISOString() });
    }),
    http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [{ id: "w-1", name: "สยามเดโม", slug: "siam-demo", plan: "team_m", seats: 22 }] })),
  );
}
const view = () => {
  navigation.pathname = "/entitlements";
  return renderWithProviders(
    <Shell>
      <EntitlementsPage />
    </Shell>,
  );
};

describe("สิทธิ์และขีดจำกัด (O21)", () => {
  it("ตาราง Matrix · Override · ใกล้ชนเพดาน ตาม Canvas", async () => {
    handlers();
    view();
    expect(await screen.findByText(/^เวอร์ชัน 3 · ใช้ตั้งแต่ 1 พ.ย. 2569/)).toBeInTheDocument();
    const table = screen.getAllByRole("table")[0];
    const seats = within(table).getByRole("row", { name: /ที่นั่ง seats/ });
    expect(within(seats).getAllByRole("cell").map((c) => c.textContent)).toEqual(["5", "10", "25", "50", "ตามสัญญา"]);
    const api = within(table).getByRole("row", { name: /API ต่อนาที/ });
    expect(within(api).getAllByRole("cell")[0]).toHaveTextContent("—");
    expect(within(within(table).getByRole("row", { name: /SSO/ })).getByText("ยังไม่บังคับในแอป")).toBeInTheDocument();
    expect(screen.getByText("ตามสัญญา ENT-DEMO-004")).toBeInTheDocument();
    expect(screen.getByText("เหลือ 3 วัน")).toBeInTheDocument();
    expect(screen.getByText("9/10")).toBeInTheDocument();
    expect(screen.getByText("~12 วัน")).toBeInTheDocument();
    expect(screen.getByText("ส่งแล้ว 9 พ.ย. 2569")).toBeInTheDocument();
    // ลูกค้า Enterprise 2 ราย (หัวตาราง) + ใกล้ชนเพดาน 2 ราย
    expect(screen.getAllByText("2 ราย")).toHaveLength(2);
  });

  it("Support ไม่เห็นหน้านี้ · วิศวกรแก้ตารางไม่ได้แต่ปรับเฉพาะรายได้", async () => {
    handlers();
    asRole("support");
    const { unmount } = view();
    expect(await screen.findByText("หน้านี้เปิดให้ Owner · การเงิน · วิศวกร")).toBeInTheDocument();
    unmount();
    asRole("engineer");
    view();
    await screen.findByText("สยามเดโม");
    expect(screen.queryByRole("button", { name: /แก้ไขสิทธิ์/ })).toBeNull();
    expect(screen.getByRole("button", { name: /เพิ่มการปรับเฉพาะราย/ })).toBeInTheDocument();
  });

  it("แก้ตาราง → P2 แสดงลูกค้าที่กระทบ → ส่งขออนุมัติ", async () => {
    handlers();
    asRole("finance");
    view();
    await userEvent.click(await screen.findByRole("button", { name: /แก้ไขสิทธิ์/ }));
    const input = screen.getByLabelText("ที่นั่ง · Team S");
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    expect(input.closest("td")).toHaveClass("cell-dirty");
    await userEvent.click(screen.getByRole("button", { name: /บันทึกเป็นเวอร์ชันใหม่ · แก้ 1 ช่อง/ }));
    const dlg = await screen.findByRole("dialog", { name: "บันทึกเป็นเวอร์ชัน 4" });
    expect(await within(dlg).findByText("กระทบ 7 ราย ที่ใช้เกินค่าใหม่หรือใช้ฟีเจอร์นี้อยู่ · เชียงใหม่คราฟต์เดโม")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ลูกค้า Team S ขาดทุน");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งขออนุมัติ" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    const sent = calls.find((c) => c.path === "/entitlements/versions")!.body as { matrix: Matrix; effectiveAt: string | null; reason: string };
    expect(sent.matrix.team_s.seats).toBe(5);
    expect(sent.matrix.team_m.seats).toBe(25);
    expect(sent).toMatchObject({ effectiveAt: null, reason: "ลูกค้า Team S ขาดทุน" });
  });

  it("เพิ่มการปรับเฉพาะราย: เกิน 20% เตือนว่าต้องอนุมัติ · ส่งวันหมดอายุตามเวลาไทย", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: /เพิ่มการปรับเฉพาะราย/ }));
    const dlg = await screen.findByRole("dialog", { name: "เพิ่มการปรับเฉพาะราย" });
    await userEvent.type(within(dlg).getByLabelText("Workspace"), "สยาม");
    await userEvent.click(await within(dlg).findByRole("button", { name: /สยามเดโม · siam-demo/ }));
    expect(within(dlg).getByLabelText("แพ็กเกจให้")).toHaveValue("25");
    await userEvent.type(within(dlg).getByLabelText("ปรับเป็น"), "35");
    expect(within(dlg).getByText("รายการนี้ต้องให้ Owner อนุมัติ: เกินแพ็กเกจเกิน 20%")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("หมดอายุ"), "2026-12-31");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ลูกค้าเห็นใน Audit log)"), "ทีมเพิ่มชั่วคราว");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งขออนุมัติ" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/entitlements/overrides")).toBe(true));
    expect(calls.find((c) => c.path === "/entitlements/overrides")!.body).toEqual({ workspaceId: "w-1", key: "seats", value: 35, expiresAt: "2026-12-31T23:59:59+07:00", contractRef: null, reason: "ทีมเพิ่มชั่วคราว" });
  });

  it("ยกเลิกการปรับเฉพาะราย · ส่งให้ทีมขาย", async () => {
    handlers();
    view();
    const rowEl = (await screen.findByText("สยามเดโม")).closest("tr")!;
    await userEvent.click(within(rowEl).getByRole("button", { name: "ยกเลิกการปรับ" }));
    const dlg = await screen.findByRole("dialog");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ย้ายไป Team L แล้ว");
    await userEvent.click(within(dlg).getByRole("button", { name: "ยกเลิกการปรับ" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/entitlements/overrides/ov-1/revoke")?.body).toEqual({ reason: "ย้ายไป Team L แล้ว" }));
    await userEvent.click(screen.getByRole("button", { name: "ส่งให้ทีมขาย" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/entitlements/near-limit/w-4/refer")?.body).toEqual({ key: "seats" }));
  });

  it("P3 ประวัติ: ดูความต่าง · กู้เวอร์ชันเก่า", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: /ดูประวัติการแก้/ }));
    const drawer = await screen.findByRole("dialog", { name: "ประวัติสิทธิ์และขีดจำกัด" });
    expect(await within(drawer).findByText("ใช้อยู่")).toBeInTheDocument();
    await userEvent.click(within(drawer).getAllByRole("button", { name: "ดูความต่าง" })[0]);
    expect(within(drawer).getByText(/Automation ต่อเดือน · Team S/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getAllByRole("button", { name: "กู้เป็นเวอร์ชันใหม่" })[0]);
    const dlg = await screen.findByRole("dialog", { name: "กู้เวอร์ชัน 2 เป็นเวอร์ชันใหม่" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ย้อนกลับ");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งขออนุมัติ" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/entitlements/versions/2/restore")?.body).toEqual({ reason: "ย้อนกลับ" }));
  });
});
