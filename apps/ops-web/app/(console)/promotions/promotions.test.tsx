import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "@/features/shell/Shell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { PromotionsPage } from "./PromotionsPage";
import type { Coupon, Overview, PlanRow } from "./_parts/types";

// ข้อมูลสมมติเท่านั้น (ชื่อลูกค้า / โค้ด / ราคาไม่ใช่ของจริง)
const plan = (code: PlanRow["code"], name: string, monthly: number | null, over: Partial<PlanRow> = {}): PlanRow => ({
  code, name, defaultName: name, monthlySatang: monthly, yearlySatang: monthly === null ? null : monthly * 10, yearlyCustom: false, yearlyMonths: 10,
  listed: true, openForSignup: true, seatLimit: 10, storageGbPerMember: 10, projects: null, customers: 0, grandfathered: 0, version: 1, priceEditable: code.startsWith("team_"), ...over,
});
const coupon = (over: Partial<Coupon>): Coupon => ({
  id: "c-1", code: "LAUNCH20", description: "เปิดตัว · ลูกค้าใหม่", kind: "percent", value: 20, duration: "repeating", durationCycles: 6, planCodes: ["team_s", "team_m", "team_l"],
  maxRedemptions: 100, expiresOn: "2026-12-31", newCustomersOnly: true, stackable: false, status: "active", state: "active", used: 84, pending: 2, discountGivenSatang: 1_234_500,
  retention: { ended: 11, eligible: 11, kept: 10, rate: 10 / 11 }, createdAt: "2026-10-01T03:00:00Z", createdBy: "การเงินตัวอย่าง", activatedAt: "2026-10-01T03:00:00Z", disabledAt: null, disableReason: null, pendingApproval: false, ...over,
});
const overview: Overview = {
  plans: [
    plan("free", "Free", 0, { seatLimit: 5, projects: 3, storageGbPerMember: 1, customers: 412 }),
    plan("team_s", "Team S", 150_000, { customers: 96 }),
    plan("team_m", "Team M", 300_000, { seatLimit: 25, customers: 71, grandfathered: 12 }),
    plan("team_l", "Team L", 550_000, { seatLimit: 50, customers: 35, openForSignup: false }),
    plan("enterprise", "Enterprise", null, { seatLimit: null, storageGbPerMember: null, customers: 12 }),
  ],
  pendingPrices: [],
  coupons: [
    coupon({}),
    coupon({ id: "c-2", code: "STARTUP50", description: "โครงการสตาร์ตอัป", value: 50, durationCycles: 12, planCodes: ["team_s", "team_m"], maxRedemptions: 50, used: 17, pending: 0, retention: { ended: 0, eligible: 0, kept: 0, rate: null } }),
    coupon({ id: "c-3", code: "EDU-FREE", description: "สถาบันการศึกษา", kind: "free_months", value: 6, duration: "once", durationCycles: null, planCodes: ["team_m"], maxRedemptions: null, expiresOn: null, used: 6, pending: 0 }),
    coupon({ id: "c-4", code: "WINBACK", description: "ลูกค้าที่ยกเลิกไปแล้ว", kind: "amount", value: 100_000, duration: "once", durationCycles: null, maxRedemptions: 40, used: 3, pending: 0 }),
    coupon({ id: "c-5", code: "NEWYEAR2570", description: "โปรปีใหม่", value: 25, durationCycles: 3, status: "draft", state: "draft", used: 0, pending: 0, maxRedemptions: 200, retention: { ended: 0, eligible: 0, kept: 0, rate: null } }),
  ],
  summary: { activeCoupons: 4, discountThisMonthSatang: 1_824_000 },
};

const calls: { method: string; path: string; body?: unknown }[] = [];
const record = async (request: Request) => {
  const text = await request.text();
  calls.push({ method: request.method, path: new URL(request.url).pathname.replace(/^.*\/ops-api/, ""), body: text ? JSON.parse(text) : undefined });
};
const pendingApproval = (kind: string) => ({ id: "ap-1", kind, reason: "x", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), amountSatang: null, payload: { rule: "ต้องมีคนอนุมัติ" }, canSelfApprove: false });

function handlers(data: Overview = overview) {
  calls.length = 0;
  server.use(
    http.get(`${OPS}/promotions`, () => HttpResponse.json(data)),
    http.get(`${OPS}/promotions/price-history`, () =>
      HttpResponse.json({
        items: [
          { id: "v-2", plan: "team_m", planName: "Team M", version: 2, displayName: "Team M", monthlySatang: 350_000, yearlySatang: null, listed: true, openForSignup: true, existingPolicy: "grandfather", existingFrom: null, effectiveAt: "2026-11-10T03:00:00Z", reason: "ปรับราคาตามต้นทุน", createdBy: "การเงินตัวอย่าง", approvedBy: "แอดมินตัวอย่าง", status: "current", changes: [{ field: "monthly", from: 300_000, to: 350_000 }] },
          { id: "v-1", plan: "team_m", planName: "Team M", version: 1, displayName: null, monthlySatang: null, yearlySatang: null, listed: true, openForSignup: true, existingPolicy: "grandfather", existingFrom: null, effectiveAt: "2026-01-01T00:00:00+07:00", reason: "เวอร์ชันเริ่มต้น (ราคาเดิม)", createdBy: null, approvedBy: null, status: "past", changes: [] },
        ],
      }),
    ),
    http.get(`${OPS}/promotions/coupons/:id/redemptions`, () =>
      HttpResponse.json({
        items: [
          { workspace: { id: "w-1", name: "สยามเดโม", slug: "siam-demo" }, status: "ended", cyclesTotal: 6, cyclesUsed: 6, discountSatang: 360_000, createdAt: "2026-05-01T03:00:00Z", endedAt: "2026-11-01T03:00:00Z", keptPaying: true },
          { workspace: { id: "w-2", name: "โนวาเดโม", slug: "nova-demo" }, status: "active", cyclesTotal: 6, cyclesUsed: 2, discountSatang: 120_000, createdAt: "2026-09-01T03:00:00Z", endedAt: null, keptPaying: null },
        ],
      }),
    ),
    http.get(`${OPS}/announcements`, () => HttpResponse.json({ items: [], bannerDays: 30 })),
  );
}
const view = () => {
  navigation.pathname = "/promotions";
  return renderWithProviders(
    <Shell>
      <PromotionsPage />
    </Shell>,
  );
};
/** G4: ครั้งแรกตอบ reauth_required · แตะกุญแจแล้วผ่าน */
function reauth() {
  let ok = false;
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  server.use(
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((ok = true), HttpResponse.json({ reauthed: true }))),
  );
  return () => ok;
}

beforeEach(() => {
  calls.length = 0;
});

describe("แพ็กเกจและโปรโมชัน (O20)", () => {
  it("การ์ดแพ็กเกจ · ตารางคูปอง · อัตราจ่ายต่อหลังหมดส่วนลด ตาม Canvas", async () => {
    handlers();
    view();
    const m = await screen.findByRole("article", { name: "Team M" });
    expect(within(m).getByText("฿3,000")).toBeInTheDocument();
    expect(within(m).getByText("≤ 25 คน")).toBeInTheDocument();
    expect(within(m).getByText("· ราคาเดิม 12 ราย")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Enterprise" })).getByText("ตามใบเสนอราคา")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Team L" })).getByText("ปิดรับสมัครใหม่")).toBeInTheDocument();
    expect(screen.getByText("ใช้งานอยู่ 4 · ส่วนลดที่ให้ไปเดือนนี้ ฿18,240")).toBeInTheDocument();
    const row = (code: string) => screen.getByText(code).closest("tr")!;
    expect(within(row("LAUNCH20")).getByText("6 รอบแรก")).toBeInTheDocument();
    expect(within(row("LAUNCH20")).getByText("Team ทุกขนาด")).toBeInTheDocument();
    expect(within(row("LAUNCH20")).getByText("91%")).toBeInTheDocument();
    expect(within(row("LAUNCH20")).getByText("10/11 ราย")).toBeInTheDocument();
    expect(within(row("LAUNCH20")).getByText("รอชำระ 2")).toBeInTheDocument();
    expect(within(row("STARTUP50")).getByText("—")).toBeInTheDocument();
    expect(within(row("STARTUP50")).getByText("Team S, Team M")).toBeInTheDocument();
    expect(within(row("EDU-FREE")).getByText("ฟรี 6 เดือน")).toBeInTheDocument();
    expect(within(row("EDU-FREE")).getByText("6 / ไม่จำกัด")).toBeInTheDocument();
    expect(within(row("EDU-FREE")).getByText("ไม่หมดอายุ")).toBeInTheDocument();
    expect(within(row("WINBACK")).getByText("฿1,000")).toBeInTheDocument();
    expect(within(row("WINBACK")).getByText("ครั้งเดียว")).toBeInTheDocument();
    expect(within(row("NEWYEAR2570")).getByText("ร่าง")).toBeInTheDocument();
  });

  it("Support ไม่เห็นหน้านี้ · การเงินเห็นปุ่มแก้ไขและสร้างคูปอง", async () => {
    handlers();
    asRole("support");
    const { unmount } = view();
    expect(await screen.findByText("หน้านี้เปิดให้ Owner · การเงิน")).toBeInTheDocument();
    unmount();
    asRole("finance");
    view();
    expect(await screen.findByRole("button", { name: "แก้ไข Team S" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /สร้างคูปอง/ })).toBeInTheDocument();
  });

  it("ว่าง: ไม่มีคูปอง · ล้ม: แสดง requestId", async () => {
    handlers({ ...overview, coupons: [] });
    const { unmount } = view();
    expect(await screen.findByText("ยังไม่มีคูปอง")).toBeInTheDocument();
    unmount();
    server.use(http.get(`${OPS}/promotions`, () => opsError(500, "internal", "ระบบขัดข้อง", undefined, "req-o20-1")));
    view();
    expect(await screen.findByText(/req-o20-1/)).toBeInTheDocument();
  });

  it("P1 เปลี่ยนราคา: แตะกุญแจ (G4) → ส่งขออนุมัติ พร้อมนโยบายลูกค้าเดิม", async () => {
    handlers();
    const ok = reauth();
    server.use(
      http.post(`${OPS}/promotions/plans/:code`, async ({ request }) => {
        if (!ok()) return opsError(401, "reauth_required", "แตะ Security key");
        await record(request);
        return HttpResponse.json({ pendingApproval: pendingApproval("promotions.plan_price") }, { status: 202 });
      }),
    );
    view();
    await userEvent.click(await screen.findByRole("button", { name: "แก้ไข Team M" }));
    const d = await screen.findByRole("dialog", { name: "แก้ไข Team M" });
    expect(within(d).getByText("ลูกค้าใช้อยู่ 71 ราย")).toBeInTheDocument();
    expect(within(d).getByLabelText("รหัส")).toHaveValue("team_m");
    // ยังไม่เปลี่ยนราคา: ตัวเลือกลูกค้าเดิมกดไม่ได้
    expect(within(d).getByLabelText(/ลูกค้าเดิมเปลี่ยนตามรอบถัดไป/)).toBeDisabled();
    const price = within(d).getByLabelText("ราคา / เดือน (บาท) *");
    await userEvent.clear(price);
    await userEvent.type(price, "3500");
    await userEvent.click(within(d).getByLabelText(/ลูกค้าเดิมเปลี่ยนตามรอบถัดไป/));
    await userEvent.type(within(d).getByLabelText("เหตุผล *"), "ปรับราคาตามต้นทุน");
    await userEvent.click(within(d).getByRole("button", { name: "บันทึก" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/promotions/plans/team_m")!.body).toEqual({
      displayName: "Team M", monthlySatang: 350_000, yearlySatang: null, listed: true, openForSignup: true, existingPolicy: "next_cycle", reason: "ปรับราคาตามต้นทุน",
    });
  });

  it("P1 แก้ชื่อ / ซ่อนจากหน้าราคา (ไม่เปลี่ยนราคา) → บันทึกเป็นเวอร์ชันใหม่ทันที", async () => {
    handlers();
    server.use(
      http.post(`${OPS}/promotions/plans/:code`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ version: 3 });
      }),
    );
    view();
    await userEvent.click(await screen.findByRole("button", { name: "แก้ไข Enterprise" }));
    const d = await screen.findByRole("dialog", { name: "แก้ไข Enterprise" });
    expect(within(d).getByLabelText("ราคา / เดือน (บาท) *")).toBeDisabled();
    await userEvent.click(within(d).getByLabelText("แสดงในหน้าราคา"));
    await userEvent.type(within(d).getByLabelText("เหตุผล *"), "ขายผ่านทีมขายเท่านั้น");
    await userEvent.click(within(d).getByRole("button", { name: "บันทึก" }));
    expect(await screen.findByText("บันทึก Enterprise เป็นเวอร์ชัน 3 แล้ว")).toBeInTheDocument();
    expect(calls[0].body).toEqual({ displayName: "Enterprise", monthlySatang: null, yearlySatang: null, listed: false, openForSignup: true, existingPolicy: "grandfather", reason: "ขายผ่านทีมขายเท่านั้น" });
  });

  it("สร้างคูปอง: ตัวอย่างที่ลูกค้าเห็น · บันทึกร่าง · โค้ดซ้ำแสดงใต้ช่อง", async () => {
    handlers();
    let taken = true;
    server.use(
      http.post(`${OPS}/promotions/coupons`, async ({ request }) => {
        await record(request);
        if (taken) return opsError(409, "coupon_code_taken", "โค้ดนี้มีอยู่แล้ว");
        return HttpResponse.json({ coupon: coupon({ id: "c-9", code: "NEWYEAR2571", status: "draft", state: "draft" }) }, { status: 201 });
      }),
    );
    view();
    await userEvent.click(await screen.findByRole("button", { name: /สร้างคูปอง/ }));
    const d = await screen.findByRole("dialog", { name: "สร้างคูปองใหม่" });
    await userEvent.type(within(d).getByLabelText("โค้ด"), "newyear2571");
    expect(within(d).getByLabelText("โค้ด")).toHaveValue("NEWYEAR2571");
    await userEvent.type(within(d).getByLabelText("ส่วนลด (%)"), "25");
    await userEvent.type(within(d).getByLabelText("หมดอายุ"), "2027-01-31");
    expect(within(d).getByText("ลด 25% 3 รอบบิลแรก · ใช้ได้ถึง 31 ม.ค. 2570")).toBeInTheDocument();
    await userEvent.click(within(d).getByLabelText("เฉพาะลูกค้าใหม่ (ยังไม่เคยจ่ายเงิน)"));
    await userEvent.click(within(d).getByRole("button", { name: "บันทึกร่าง" }));
    expect(await within(d).findByText("โค้ดนี้มีอยู่แล้ว")).toBeInTheDocument();
    taken = false;
    await userEvent.click(within(d).getByRole("button", { name: "บันทึกร่าง" }));
    expect(await screen.findByText("บันทึกร่าง NEWYEAR2571 แล้ว")).toBeInTheDocument();
    expect(calls.at(-1)!.body).toEqual({
      code: "NEWYEAR2571", description: null, kind: "percent", value: 25, duration: "repeating", durationCycles: 3, planCodes: ["team_s", "team_m", "team_l"],
      maxRedemptions: null, expiresOn: "2027-01-31", newCustomersOnly: true, stackable: false,
    });
  });

  it("สร้างคูปองใช้ฟรี N เดือนแล้วเปิดใช้: แตะกุญแจ → เกินวงเงินส่งขออนุมัติ · ข้อผิดพลาดของช่องจาก API", async () => {
    handlers();
    const ok = reauth();
    let invalid = true;
    server.use(
      http.post(`${OPS}/promotions/coupons`, async ({ request }) => {
        if (!ok()) return opsError(401, "reauth_required", "แตะ Security key");
        await record(request);
        if (invalid) return opsError(400, "validation_failed", "ข้อมูลไม่ถูกต้อง", [{ path: "value", message: "ใช้ฟรีได้ไม่เกิน 24 เดือน" }]);
        return HttpResponse.json({ coupon: coupon({ id: "c-9", code: "EDU-2027", kind: "free_months", status: "draft", state: "draft" }), pendingApproval: pendingApproval("promotions.coupon_activate") }, { status: 202 });
      }),
    );
    view();
    await userEvent.click(await screen.findByRole("button", { name: /สร้างคูปอง/ }));
    const d = await screen.findByRole("dialog", { name: "สร้างคูปองใหม่" });
    await userEvent.type(within(d).getByLabelText("โค้ด"), "EDU-2027");
    await userEvent.click(within(d).getByRole("button", { name: "ใช้ฟรี N เดือน" }));
    await userEvent.type(within(d).getByLabelText("จำนวนเดือนที่ใช้ฟรี"), "2");
    expect(within(d).getByText("ใช้ฟรี 2 เดือน แล้วจ่ายราคาปกติ")).toBeInTheDocument();
    expect(within(d).getByLabelText("ใช้คู่กับคูปองอื่นได้")).toBeDisabled();
    await userEvent.click(within(d).getByLabelText("Team L"));
    await userEvent.click(within(d).getByRole("button", { name: "เปิดใช้คูปอง" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    expect(await within(d).findByText("ใช้ฟรีได้ไม่เกิน 24 เดือน")).toBeInTheDocument();
    invalid = false;
    await userEvent.click(within(d).getByRole("button", { name: "เปิดใช้คูปอง" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(calls.at(-1)!.body).toMatchObject({ code: "EDU-2027", kind: "free_months", value: 2, duration: "once", durationCycles: null, planCodes: ["team_s", "team_m"], stackable: false, activate: true });
  });

  it("P4 ตั้งค่า: ปิดคูปองพร้อมเหตุผล · แก้วันหมดอายุ · ดูลูกค้าที่ใช้", async () => {
    handlers();
    server.use(
      http.post(`${OPS}/promotions/coupons/:id/disable`, async ({ request }) => (await record(request), HttpResponse.json({ coupon: coupon({ status: "disabled", state: "disabled" }) }))),
      http.patch(`${OPS}/promotions/coupons/:id`, async ({ request }) => (await record(request), HttpResponse.json({ coupon: coupon({}) }))),
    );
    view();
    const menu = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "ตั้งค่าคูปอง LAUNCH20" }));
      return screen.findByRole("menu");
    };
    await userEvent.click(within(await menu()).getByRole("menuitem", { name: /ปิดคูปองก่อนกำหนด/ }));
    const dlg = await screen.findByRole("dialog", { name: "ปิดคูปอง LAUNCH20 ก่อนกำหนด?" });
    expect(within(dlg).getByText("ลูกค้าใหม่ใช้โค้ดนี้ไม่ได้อีก · คนที่ใช้แล้วยังได้ส่วนลดครบรอบ")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "งบโปรโมชันหมด");
    await userEvent.click(within(dlg).getByRole("button", { name: "ปิดคูปอง" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/promotions/coupons/c-1/disable")?.body).toEqual({ reason: "งบโปรโมชันหมด" }));

    await userEvent.click(within(await menu()).getByRole("menuitem", { name: /แก้วันหมดอายุ/ }));
    const exp = await screen.findByRole("dialog", { name: "แก้วันหมดอายุ LAUNCH20" });
    await userEvent.clear(within(exp).getByLabelText("หมดอายุ"));
    await userEvent.click(within(exp).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ expiresOn: null }));

    await userEvent.click(within(await menu()).getByRole("menuitem", { name: "ดูลูกค้าที่ใช้ (86)" }));
    const drawer = await screen.findByRole("dialog", { name: "ลูกค้าที่ใช้ LAUNCH20" });
    expect(await within(drawer).findByRole("link", { name: "สยามเดโม" })).toHaveAttribute("href", "/workspaces/w-1");
    expect(within(drawer).getByText("6 / 6")).toBeInTheDocument();
    expect(within(drawer).getByText("จ่ายต่อ")).toBeInTheDocument();
    expect(within(drawer).getByText("หมดส่วนลดแล้ว")).toBeInTheDocument();
  });

  it("P4 ร่าง: คัดลอกเป็นคูปองใหม่ (โค้ดว่าง) · เปิดใช้จากเมนู", async () => {
    handlers();
    server.use(http.post(`${OPS}/promotions/coupons/:id/activate`, async ({ request }) => (await record(request), HttpResponse.json({ coupon: coupon({ id: "c-5", code: "NEWYEAR2570" }) }))));
    view();
    await userEvent.click(await screen.findByRole("button", { name: "ตั้งค่าคูปอง NEWYEAR2570" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "คัดลอกเป็นคูปองใหม่" }));
    const d = await screen.findByRole("dialog", { name: "สร้างคูปองใหม่" });
    expect(within(d).getByLabelText("โค้ด")).toHaveValue("");
    expect(within(d).getByLabelText("ส่วนลด (%)")).toHaveValue("25");
    await userEvent.click(within(d).getByRole("button", { name: "ยกเลิก" }));
    await userEvent.click(screen.getByRole("button", { name: "ตั้งค่าคูปอง NEWYEAR2570" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "เปิดใช้คูปอง" }));
    expect(await screen.findByText("เปิดใช้ NEWYEAR2570 แล้ว")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/promotions/coupons/c-5/activate")).toBeTruthy();
  });

  it("แท็บประวัติราคา · ประกาศถึงลูกค้า (Owner) · แคมเปญยังไม่เปิด", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("tab", { name: "ประวัติราคา" }));
    const row = (await screen.findByText("ปรับราคาตามต้นทุน")).closest("tr")!;
    expect(within(row).getByText("ใช้อยู่")).toBeInTheDocument();
    expect(within(row).getByText("฿3,500")).toBeInTheDocument();
    expect(within(row).getByText("อนุมัติโดย แอดมินตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByText("เวอร์ชันเริ่มต้น")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "ประกาศถึงลูกค้า" }));
    expect(await screen.findByText("ยังไม่มีประกาศ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ส่งประกาศใหม่" })).toHaveAttribute("href", "/workspaces");
    await userEvent.click(screen.getByRole("tab", { name: "แคมเปญ" }));
    expect(screen.getByText("แคมเปญยังไม่เปิดใช้")).toBeInTheDocument();
  });

  it("การเงินเปิดแท็บประกาศ: เห็นว่าเปิดให้ Owner เท่านั้น", async () => {
    handlers();
    asRole("finance");
    view();
    await userEvent.click(await screen.findByRole("tab", { name: "ประกาศถึงลูกค้า" }));
    expect(await screen.findByText("ประวัติประกาศถึงลูกค้าเปิดให้ Owner เท่านั้น")).toBeInTheDocument();
  });
});
