import { startAuthentication } from "@simplewebauthn/browser";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { OPS_UNAUTHORIZED } from "@/lib/api";
import { mySessionId, openSessions, staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { AppShell } from "./AppShell";

const side = () => within(screen.getByRole("complementary", { name: "เมนูหลักของ Friday Ops" }));
const shell = () => renderWithProviders(<AppShell>เนื้อหาของหน้า</AppShell>);

describe("เมนูซ้ายตามบทบาท", () => {
  it("Owner ทีมเล็ก: เห็นทุกกลุ่ม · badge จากงานวันนี้ · เมนูเฟส 2–3 เป็น \"เร็ว ๆ นี้\"", async () => {
    shell();
    expect(await screen.findByText("เนื้อหาของหน้า")).toBeInTheDocument();
    expect(side().getByRole("link", { name: "ภาพรวม" })).toHaveAttribute("aria-current", "page");
    for (const name of ["Workspaces", "พนักงานและสิทธิ์", "Feature flags"]) expect(side().getByRole("link", { name })).toBeInTheDocument();
    expect(await side().findByLabelText("7 รายการรอ")).toBeInTheDocument();
    expect(side().getByRole("link", { name: /Lead และดีล/ })).toHaveAttribute("href", "/soon?f=leads");
    expect(within(side().getByRole("link", { name: /Lead และดีล/ })).getByText("เร็ว ๆ นี้")).toBeInTheDocument();
    expect(side().getByText("Owner · การเงิน · Support · วิศวกร")).toBeInTheDocument();
  });

  it("Support: ไม่เห็นเมนูเงินและพนักงาน · เห็น Ticket พร้อมจำนวนที่ยังไม่มีคนรับ", async () => {
    asRole("support");
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    expect(side().queryByRole("link", { name: /รายได้และใบแจ้งหนี้/ })).not.toBeInTheDocument();
    expect(side().queryByRole("link", { name: /พนักงานและสิทธิ์/ })).not.toBeInTheDocument();
    expect(await within(side().getByRole("link", { name: /Ticket/ })).findByText("6")).toBeInTheDocument();
  });

  it("วิศวกร: เห็นระบบ ไม่เห็น Support", async () => {
    asRole("engineer");
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    expect(side().getByRole("link", { name: "Feature flags" })).toBeInTheDocument();
    expect(side().queryByRole("link", { name: /Ticket/ })).not.toBeInTheDocument();
  });

  it("เปิดหน้าที่ไม่มีสิทธิ์จากลิงก์ตรง (S7): ไม่ render เนื้อหา · ไม่ใช่ Owner ไม่มีปุ่มสิทธิ์ฉุกเฉิน", async () => {
    asRole("finance");
    navigation.pathname = "/staff";
    shell();
    expect(await screen.findByText("บทบาท การเงิน ดูหน้านี้ไม่ได้")).toBeInTheDocument();
    expect(screen.getByText("หน้านี้เปิดให้ Owner · ผู้ตรวจ")).toBeInTheDocument();
    expect(screen.queryByText("เนื้อหาของหน้า")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "เปิดสิทธิ์ฉุกเฉิน" })).not.toBeInTheDocument();
  });

  it("ไม่มี session (401) → หน้า Login · โหลดไม่ได้ (S6) → แสดง requestId", async () => {
    server.use(http.get(`${OPS}/auth/me`, () => opsError(401, "unauthorized", "ต้องเข้าสู่ระบบ")));
    shell();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    server.use(http.get(`${OPS}/auth/me`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req-me-500")));
    shell();
    expect(await screen.findByText("เกิดข้อผิดพลาดภายในระบบ")).toBeInTheDocument();
    expect(screen.getByText(/req-me-500/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /คัดลอก/ })).toBeInTheDocument();
  });
});

describe("แถบแจ้งด้านบน (G11)", () => {
  it("อยู่ในบัญชีลูกค้า: แถบส้ม · ออกจากบัญชีได้", async () => {
    asRole("support");
    let ended = "";
    server.use(
      http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: ended ? [] : openSessions(staff.support.id) })),
      http.post(`${OPS}/support-sessions/:id/end`, ({ params }) => ((ended = String(params.id)), HttpResponse.json({ session: {} }))),
    );
    shell();
    expect(await screen.findByText("กำลังดูบัญชีลูกค้า")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ออกจากบัญชีลูกค้า" }));
    await waitFor(() => expect(ended).toBe(mySessionId));
  });

  it("เปิดสิทธิ์ฉุกเฉินอยู่: แถบแดง · ปิดก่อนหมดเวลาได้", async () => {
    let ended = false;
    server.use(
      http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: { ...staff.admin, roles: ["owner"], elevated: ["engineer"], effectiveRoles: ["owner", "engineer"] } })),
      http.get(`${OPS}/staff`, () => HttpResponse.json({ items: [{ id: staff.admin.id, elevations: [{ id: "el-1", role: "engineer", endsAt: new Date(Date.now() + 3_600_000).toISOString() }] }], singleApprover: true })),
      http.post(`${OPS}/staff/me/elevations/el-1/end`, () => ((ended = true), HttpResponse.json({ ended: true }))),
    );
    shell();
    expect(await screen.findByText("สิทธิ์ฉุกเฉิน: วิศวกร")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "ปิดสิทธิ์ฉุกเฉิน" }));
    await waitFor(() => expect(ended).toBe(true));
  });
});

describe("แถบบน", () => {
  it("ค้นหาทั้งระบบ (G1): Ctrl K · ค้นตามบทบาท · ↓ Enter เปิดผลลัพธ์", async () => {
    const asked: string[] = [];
    server.use(
      http.get(`${OPS}/workspaces`, ({ request }) => (asked.push(`ws:${new URL(request.url).searchParams.get("q")}`), HttpResponse.json({ items: [{ id: "w1", name: "Orbit Apps", slug: "orbit", plan: "team_s", subStatus: "active" }] }))),
      http.get(`${OPS}/users`, () => (asked.push("users"), HttpResponse.json({ items: [{ id: "u1", email: "ops@orbit.example.com", displayName: "Ops", firstWorkspace: "Orbit Apps" }] }))),
      http.get(`${OPS}/invoices`, () => HttpResponse.json({ items: [] })),
      http.get(`${OPS}/tickets`, () => HttpResponse.json({ items: [] })),
    );
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "ค้นหาทั้งระบบ" });
    await userEvent.type(box, "orbit");
    expect(await screen.findByRole("option", { name: "Orbit Apps, orbit · team_s" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /ops@orbit.example.com/ })).toBeInTheDocument();
    expect(asked).toContain("ws:orbit");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(router.push).toHaveBeenCalledWith("/users?id=u1");
  });

  it("Support ค้นไม่ถึงใบแจ้งหนี้", async () => {
    asRole("support");
    let invoices = false;
    server.use(
      http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [] })),
      http.get(`${OPS}/users`, () => HttpResponse.json({ items: [] })),
      http.get(`${OPS}/tickets`, () => HttpResponse.json({ items: [] })),
      http.get(`${OPS}/invoices`, () => ((invoices = true), HttpResponse.json({ items: [] }))),
    );
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    await userEvent.click(screen.getByRole("button", { name: "ค้นหาทั้งระบบ" }));
    await userEvent.type(await screen.findByRole("combobox"), "zz");
    expect(await screen.findByText('ไม่พบผลลัพธ์ของ "zz"')).toBeInTheDocument();
    expect(invoices).toBe(false);
  });

  it("แจ้งเตือน (G2) → คำขอที่ส่งถึงฉัน (G8) → อนุมัติ ต้องแตะกุญแจ (G4) แล้วทำซ้ำ", async () => {
    let approveCalls = 0;
    let reauthed = false;
    server.use(
      http.get(`${OPS}/approvals`, () =>
        HttpResponse.json({
          items: [{ id: "ap-1", kind: "billing.refund", reason: "ลูกค้าย้ายไปใช้เครื่องมืออื่น", amountSatang: 1_400_000, payload: { rule: "คืนเงินเกิน ฿10,000" }, requestedBy: "someone", requesterName: "การเงินตัวอย่าง", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: "pending", canSelfApprove: false }],
          singleApprover: false,
        }),
      ),
      http.post(`${OPS}/approvals/ap-1/approve`, () => (++approveCalls === 1 && !reauthed ? opsError(401, "reauth_required", "แตะ Security key เพื่อยืนยันตัวตนอีกครั้ง") : HttpResponse.json({ approval: {}, result: {} }))),
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re-token" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true, expiresInSeconds: 900 }))),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    await userEvent.click(await screen.findByRole("button", { name: /การแจ้งเตือน 6 รายการ/ }));
    await userEvent.click(screen.getByRole("button", { name: /รออนุมัติ 2 รายการ/ }));
    const card = await screen.findByRole("article", { name: "คืนเงิน" });
    expect(within(card).getByText("฿14,000.00")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "อนุมัติ" }));
    expect(await screen.findByText("แตะ Security key เพื่อยืนยัน")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "แตะกุญแจ" }));
    expect(await screen.findByText("อนุมัติแล้ว")).toBeInTheDocument();
    expect(approveCalls).toBe(2);
  });

  it("เมนูบัญชี (G3): ออกจากระบบ", async () => {
    let out = false;
    server.use(http.post(`${OPS}/auth/logout`, () => ((out = true), HttpResponse.json({ ok: true }))));
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    await userEvent.click(screen.getByRole("button", { name: "บัญชี แอดมินตัวอย่าง" }));
    expect(screen.getByRole("button", { name: /เปิดสิทธิ์ฉุกเฉิน/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /ออกจากระบบ/ }));
    await waitFor(() => expect(out).toBe(true));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});

describe("เซสชันหมดอายุ (S3)", () => {
  it("401 ระหว่างใช้งาน: ไม่ทิ้งหน้าเดิม · แตะกุญแจแล้วทำต่อ", async () => {
    server.use(
      http.post(`${OPS}/auth/login/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "login-token" })),
      http.post(`${OPS}/auth/login/verify`, () => HttpResponse.json({ staff: staff.admin })),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    act(() => void window.dispatchEvent(new CustomEvent(OPS_UNAUTHORIZED)));
    expect(await screen.findByText("เซสชันหมดอายุ")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    await userEvent.click(screen.getByRole("button", { name: "แตะ Security key เพื่อทำต่อจากหน้าเดิม" }));
    await waitFor(() => expect(screen.queryByText("เซสชันหมดอายุ")).not.toBeInTheDocument());
    expect(screen.getByText("เนื้อหาของหน้า")).toBeInTheDocument();
  });
});
