import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { MobileFrame } from "./_parts/MobileFrame";
import { ApprovalsMobile } from "./approvals/ApprovalsMobile";
import { IncidentsMobile } from "./incidents/IncidentsMobile";
import { PaymentsMobile } from "./payments/PaymentsMobile";

// ข้อมูลสมมติเท่านั้น
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const approval = {
  id: "ap-1",
  kind: "billing.refund",
  requestedBy: "00000000-0000-4000-8000-000000000003",
  requesterName: "การเงินตัวอย่าง",
  reason: "ลูกค้าโอนซ้ำ ยอดตรงกับใบแจ้งหนี้",
  rule: "ต้องอนุมัติ: คืนเงินเกิน ฿10,000",
  summary: { kind: "money", satang: 1_260_000 },
  createdAt: ago(40),
  expiresAt: new Date(now + 47 * 3_600_000).toISOString(),
  canSelfApprove: false,
  workspace: { id: "w-1", name: "คณิตแล็บ", createdAt: "2026-10-28T03:00:00.000Z", plan: "team_s", paidInvoices: 1, refunds: 0 },
};
const incident = {
  id: "in-1",
  title: "นำเข้า Excel ช้ากว่าปกติ",
  impact: "partial",
  status: "investigating",
  services: ["import_export"],
  internal: false,
  startedAt: ago(22),
  resolvedAt: null,
  updates: [{ id: "u-1", status: "investigating", message: "กำลังตรวจสอบ · เปิดเหตุจากแจ้งเตือนอัตโนมัติ", createdAt: ago(22) }],
};
const pay = (id: string, reason: string, actions: { yes: string | null; no: string | null }, extra: Record<string, unknown> = {}) => ({
  id,
  reason,
  suggestion: "ถามลูกค้าว่าโอนในนามใคร แล้วผ่านถ้ายืนยันได้",
  expectedSatang: 321_000,
  receivedSatang: 321_000,
  hasSlip: true,
  waitingSince: ago(180),
  minutesLeft: 55,
  nearSla: true,
  workspace: { id: "w-2", name: "ลูเมนสตูดิโอ", slug: "lumen" },
  invoice: { id: "i-1", number: "FRI-2569-0012" },
  actions,
  ...extra,
});

const calls: { path: string; body: unknown }[] = [];
const record = (status = 200) => async ({ request }: { request: Request }) => {
  calls.push({ path: new URL(request.url).pathname.replace(/^.*\/ops-api/, ""), body: await request.json().catch(() => null) });
  return HttpResponse.json({ ok: true }, { status });
};
function handlers() {
  calls.length = 0;
  server.use(
    http.get(`${OPS}/push`, () => HttpResponse.json({ enabled: true, publicKey: "BElq", devices: 0 })),
    http.get(`${OPS}/m/approvals`, () => HttpResponse.json({ items: [approval], decidedToday: [{ id: "ap-0", kind: "billing.credit", status: "approved", workspace: "ออร์บิท", summary: { kind: "money", satang: 200_000 } }] })),
    http.post(`${OPS}/approvals/:id/approve`, record()),
    http.post(`${OPS}/approvals/:id/reject`, record()),
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, record()),
    http.get(`${OPS}/incidents`, () => HttpResponse.json({ items: [incident], subscribers: 214 })),
    http.post(`${OPS}/incidents/:id/updates`, async (ctx) => (await record()(ctx), HttpResponse.json({ id: "in-1", status: "identified", notified: 214 }))),
    http.get(`${OPS}/m/payments`, () =>
      HttpResponse.json({
        items: [pay("p-1", "payer_name_mismatch", { yes: "confirm", no: "reject" }), pay("p-2", "unmatched", { yes: null, no: null }, { nearSla: false, minutesLeft: 200 })],
        stats: { autoPct: 91, confirmedToday: 22, nearSla: 1 },
        slaHours: 4,
      }),
    ),
    http.post(`${OPS}/payments/:id/confirm`, record()),
  );
}
const at = (path: string, search = "") => ((navigation.pathname = path), (navigation.search = search));

describe("Friday Ops บนมือถือ (O25)", () => {
  it("M6.1 รายการรออนุมัติ · ตัดสินแล้ววันนี้ · แถบล่างตามบทบาท · การ์ดเปิดแจ้งเตือน", async () => {
    handlers();
    asRole("admin");
    at("/m/approvals");
    renderWithProviders(
      <MobileFrame>
        <ApprovalsMobile />
      </MobileFrame>,
    );
    expect(await screen.findByText("คณิตแล็บ")).toBeInTheDocument();
    expect(screen.getByText("฿12,600")).toBeInTheDocument();
    expect(screen.getByText("ต้องอนุมัติ: คืนเงินเกิน ฿10,000")).toBeInTheDocument();
    expect(screen.getByText("ตัดสินแล้ววันนี้")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Friday Ops บนมือถือ" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["อนุมัติ", "คิวชำระ", "เหตุขัดข้อง", "เมนู"]);
    expect(await screen.findByText("แจ้งเตือนในมือถือ")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /คณิตแล็บ/ }));
    expect(router.replace).toHaveBeenCalledWith("/m/approvals?id=ap-1");
  });

  it("M6.1 รายละเอียด: ข้อมูลลูกค้าพอตัดสิน · อนุมัติต้องยืนยันด้วย Passkey ทุกครั้ง · หน้าผล", async () => {
    handlers();
    asRole("admin");
    at("/m/approvals", "id=ap-1");
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    renderWithProviders(<ApprovalsMobile />);
    expect(await screen.findByText("ลูกค้าโอนซ้ำ ยอดตรงกับใบแจ้งหนี้")).toBeInTheDocument();
    expect(screen.getByText(/จ่าย 1 รอบ · ไม่เคยขอคืน/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "อนุมัติ" }));
    const sheet = screen.getByRole("dialog", { name: "ยืนยันด้วย Passkey ในมือถือ" });
    await userEvent.click(within(sheet).getByRole("button", { name: "ยืนยันและอนุมัติ" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["/auth/reauth/verify", "/approvals/ap-1/approve"]));
    expect(await screen.findByText("อนุมัติคืนเงิน คณิตแล็บ แล้ว")).toBeInTheDocument();
    expect(screen.getByText("บันทึกใน Audit log · แจ้งผู้ขอแล้ว")).toBeInTheDocument();
  });

  it("M6.1 ไม่อนุมัติ · การเงินเปิดหน้าอนุมัติไม่ได้", async () => {
    handlers();
    asRole("admin");
    at("/m/approvals", "id=ap-1");
    const { unmount } = renderWithProviders(<ApprovalsMobile />);
    await userEvent.click(await screen.findByRole("button", { name: "ไม่อนุมัติ" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["/approvals/ap-1/reject"]));
    expect(await screen.findByText("ไม่อนุมัติคืนเงิน คณิตแล็บ")).toBeInTheDocument();
    unmount();
    asRole("finance");
    renderWithProviders(<ApprovalsMobile />);
    expect(await screen.findByText(/^หน้านี้เปิดให้ Owner/)).toBeInTheDocument();
  });

  it("M6.2 เปลี่ยนสถานะแล้วข้อความแนะนำเปลี่ยนตาม · แก้ต่อได้ · เผยแพร่พร้อมอีเมลผู้ติดตาม", async () => {
    handlers();
    asRole("engineer");
    at("/m/incidents");
    renderWithProviders(<IncidentsMobile />);
    expect(await screen.findByText("นำเข้า Excel ช้ากว่าปกติ")).toBeInTheDocument();
    expect(screen.getByText(/กระทบ: นำเข้า \/ ส่งออก · ผลกระทบบางส่วน/)).toBeInTheDocument();
    const box = screen.getByLabelText("ข้อความถึงลูกค้า");
    expect(box).toHaveValue("พบสาเหตุแล้ว กำลังแก้ไข");
    await userEvent.click(screen.getByRole("button", { name: "กำลังติดตาม" }));
    expect(box).toHaveValue("ระบบกลับมาทำงานปกติแล้ว กำลังติดตามต่ออีก 1 ชั่วโมง");
    await userEvent.type(box, " ไฟล์ที่ค้างนำเข้าครบแล้ว");
    expect(screen.getByRole("switch", { name: "อีเมลถึงผู้ติดตาม (214)" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("button", { name: "เผยแพร่อัปเดต" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/incidents/in-1/updates")?.body).toEqual({ status: "monitoring", message: "ระบบกลับมาทำงานปกติแล้ว กำลังติดตามต่ออีก 1 ชั่วโมง ไฟล์ที่ค้างนำเข้าครบแล้ว", notifySubscribers: true, showBanner: false }),
    );
    expect(await screen.findByRole("button", { name: "✓ เผยแพร่แล้ว · ส่งอีเมล 214 คน" })).toBeDisabled();
  });

  it("M6.2 Owner ดูได้อย่างเดียว", async () => {
    handlers();
    asRole("admin");
    server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: { id: "o", email: "o@example.com", name: "เจ้าของ", role: "admin", roles: ["owner"], effectiveRoles: ["owner"], elevated: [] } })));
    at("/m/incidents");
    renderWithProviders(<IncidentsMobile />);
    expect(await screen.findByText("ดูได้อย่างเดียว · อัปเดตได้เฉพาะวิศวกร / Support")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "เผยแพร่อัปเดต" })).toBeNull();
  });

  it("M6.3 การ์ดบอกคำแนะนำ · ตัดสินจาก bottom sheet · กรณีซับซ้อนทำต่อบนคอมพิวเตอร์", async () => {
    handlers();
    asRole("finance");
    at("/m/payments", "id=p-1");
    const { unmount } = renderWithProviders(<PaymentsMobile />);
    expect(await screen.findByText("91%")).toBeInTheDocument();
    expect(screen.getByText("เหลือ 55 นาที")).toBeInTheDocument();
    const sheet = screen.getByRole("dialog", { name: "ลูเมนสตูดิโอ" });
    expect(within(sheet).getByText("ยอดตรงกับใบแจ้งหนี้")).toBeInTheDocument();
    expect(within(sheet).getByText("ชื่อผู้โอนไม่ตรงกับลูกค้า")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "ผ่าน" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/payments/p-1/confirm")?.body).toEqual({ note: "ตัดสินบนมือถือ" }));
    unmount();
    at("/m/payments", "id=p-2");
    renderWithProviders(<PaymentsMobile />);
    const s2 = await screen.findByRole("dialog", { name: "ลูเมนสตูดิโอ" });
    expect(within(s2).queryByRole("button", { name: "ผ่าน" })).toBeNull();
    expect(within(s2).getByRole("link", { name: "ทำต่อบนคอมพิวเตอร์" })).toHaveAttribute("href", "/payments?tab=verify");
  });

  it("M6.3 Owner ดูได้อย่างเดียว · error ตาม M1", async () => {
    handlers();
    asRole("admin");
    server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: { id: "o", email: "o@example.com", name: "เจ้าของ", role: "admin", roles: ["owner"], effectiveRoles: ["owner"], elevated: [] } })));
    at("/m/payments", "id=p-1");
    const { unmount } = renderWithProviders(<PaymentsMobile />);
    const sheet = await screen.findByRole("dialog", { name: "ลูเมนสตูดิโอ" });
    expect(within(sheet).queryByRole("button", { name: "ผ่าน" })).toBeNull();
    unmount();
    server.use(http.get(`${OPS}/m/payments`, () => opsError(500, "internal", "ระบบขัดข้อง", undefined, "req-m-1")));
    renderWithProviders(<PaymentsMobile />);
    expect(await screen.findByText(/req-m-1/)).toBeInTheDocument();
  });
});
