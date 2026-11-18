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
    expect(await screen.findByText("อยู่ในบัญชี", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("ทีมตัวอย่าง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ออกจากบัญชีลูกค้า" }));
    await waitFor(() => expect(ended).toBe(mySessionId));
  });

  // H8 · นับถอยหลังจาก expires_at ของเซิร์ฟเวอร์ (นาฬิกาเครื่องเร็วไป 1 ชม. ก็ยังนับถูก)
  const withExpiry = (leftMs: number, serverSkewMs = 0) => {
    const serverNow = Date.now() - serverSkewMs;
    return { items: openSessions(staff.support.id).map((x) => ({ ...x, startedAt: new Date(serverNow - 20 * 60_000).toISOString(), expiresAt: new Date(serverNow + leftMs).toISOString() })), serverTime: new Date(serverNow).toISOString() };
  };

  it("H8: นับถอยหลังตามนาฬิกาเซิร์ฟเวอร์ · บอกเวลาหมด · ยังไม่เตือนเมื่อเหลือมาก", async () => {
    asRole("support");
    server.use(http.get(`${OPS}/support-sessions`, () => HttpResponse.json(withExpiry(30 * 60_000, 3_600_000))));
    shell();
    const count = await screen.findByTestId("session-countdown");
    expect(count.textContent).toMatch(/^(30:00|29:5\d)$/);
    expect(screen.getByText(/^ถึง /)).toBeInTheDocument();
    expect(screen.queryByText(/เหลือ 5 นาทีในบัญชี/)).not.toBeInTheDocument();
  });

  it("H8: เหลือ ≤ 5 นาที → Toast พร้อม \"ขยาย 30 นาที\" เปิดหน้าต่างขยายเวลา (H9) · ส่งจำนวนนาทีและเหตุผล", async () => {
    asRole("support");
    let body: Record<string, unknown> = {};
    server.use(
      http.get(`${OPS}/support-sessions`, () => HttpResponse.json(withExpiry(4 * 60_000))),
      http.get(`${OPS}/workspaces/:id`, () => HttpResponse.json({ supportAccess: { until: "2026-11-20T10:00:00.000Z", maxMode: "read", notifyAdmins: true, active: true } })),
      http.post(`${OPS}/support-sessions/:id/extend`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ session: { ...openSessions(staff.support.id)[0], expiresAt: new Date(Date.now() + 34 * 60_000).toISOString() }, notified: 1 });
      }),
    );
    shell();
    expect(await screen.findByText("เหลือ 5 นาทีในบัญชี ทีมตัวอย่าง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ขยาย 30 นาที" }));
    const dlg = await screen.findByRole("dialog", { name: "ขยายเวลาในบัญชี ทีมตัวอย่าง" });
    expect(await within(dlg).findByText(/ลูกค้าอนุญาตถึง/)).toBeInTheDocument();
    expect(within(dlg).getByText(/รวมได้ไม่เกิน 2 ชม. ต่อครั้งที่เข้า/)).toBeInTheDocument();
    expect(within(dlg).getByText("Owner และ Admin ของลูกค้าได้อีเมลแจ้งการขยาย (เหมือนตอนเริ่ม)")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ขยายเวลา" }));
    expect(await within(dlg).findByText("ระบุเหตุผลอย่างน้อย 5 ตัวอักษร")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "15 นาที" }));
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ยังตรวจเรื่องสิทธิ์โปรเจกต์ไม่เสร็จ");
    await userEvent.click(within(dlg).getByRole("button", { name: "ขยายเวลา" }));
    await waitFor(() => expect(body).toEqual({ minutes: 15, reason: "ยังตรวจเรื่องสิทธิ์โปรเจกต์ไม่เสร็จ" }));
    expect(await screen.findByText(/ขยายเวลาถึง .+ แล้ว/)).toBeInTheDocument();
  });

  it("H9: ขยายเกิน 2 ชม. → แสดงข้อความจากเซิร์ฟเวอร์", async () => {
    asRole("support");
    server.use(
      http.get(`${OPS}/support-sessions`, () => HttpResponse.json(withExpiry(50 * 60_000))),
      http.get(`${OPS}/workspaces/:id`, () => opsError(403, "forbidden", "ไม่มีสิทธิ์")),
      http.post(`${OPS}/support-sessions/:id/extend`, () => opsError(422, "session_max_reached", "รวมได้ไม่เกิน 2 ชม. ต่อครั้งที่เข้า · ออกแล้วเข้าใหม่พร้อมเหตุผล")),
    );
    shell();
    await userEvent.click(await screen.findByRole("button", { name: "ขยายเวลา" }));
    const dlg = await screen.findByRole("dialog", { name: "ขยายเวลาในบัญชี ทีมตัวอย่าง" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ต้องการเวลาเพิ่ม");
    await userEvent.click(within(dlg).getByRole("button", { name: "ขยายเวลา" }));
    expect(await within(dlg).findByText(/ออกแล้วเข้าใหม่พร้อมเหตุผล/)).toBeInTheDocument();
  });

  it("H8: ถึงเวลาหมด → Toast หมดเวลาพร้อมเวลาที่ใช้ · แถบหาย", async () => {
    asRole("support");
    let calls = 0;
    server.use(http.get(`${OPS}/support-sessions`, () => (calls++ === 0 ? HttpResponse.json(withExpiry(1500)) : HttpResponse.json({ items: [], serverTime: new Date().toISOString() }))));
    shell();
    await screen.findByTestId("session-countdown");
    expect(await screen.findByText(/หมดเวลาเข้าบัญชี ทีมตัวอย่าง แล้ว · ใช้เวลา 20 นาที/, undefined, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("session-countdown")).not.toBeInTheDocument());
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

  it("ช่วง 2: ? แสดงปุ่มลัด · / โฟกัสช่องค้นหาของหน้า", async () => {
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    await userEvent.keyboard("?");
    const help = await screen.findByRole("dialog", { name: "ปุ่มลัด" });
    expect(within(help).getByText("เลื่อนลง")).toBeInTheDocument();
    expect(within(help).getByText("ค้นทั้งระบบ")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "ปุ่มลัด" })).not.toBeInTheDocument());
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
    expect(await screen.findByText("แตะ Passkey เพื่อยืนยัน")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "แตะ Passkey" }));
    expect(await screen.findByText("อนุมัติแล้ว")).toBeInTheDocument();
    expect(approveCalls).toBe(2);
  });

  it("ยืนยันตัวตนซ้ำ (G4) ด้วยรหัส 6 หลักเมื่อตั้งแอป Authenticator แล้ว · Passkey เป็นปุ่มรอง", async () => {
    let approveCalls = 0;
    let code: unknown;
    server.use(
      http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: staff.admin, methods: { totp: true, totpEnabledAt: "2026-11-18T00:00:00Z", keys: [] } })),
      http.get(`${OPS}/approvals`, () =>
        HttpResponse.json({
          items: [{ id: "ap-1", kind: "billing.refund", reason: "ลูกค้าย้ายไปใช้เครื่องมืออื่น", amountSatang: 1_400_000, payload: {}, requestedBy: "someone", requesterName: "การเงินตัวอย่าง", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: "pending", canSelfApprove: false }],
          singleApprover: false,
        }),
      ),
      http.post(`${OPS}/approvals/ap-1/approve`, () => (++approveCalls === 1 ? opsError(401, "reauth_required", "ยืนยันตัวตนอีกครั้ง") : HttpResponse.json({ approval: {}, result: {} }))),
      http.post(`${OPS}/auth/reauth/totp`, async ({ request }) => ((code = await request.json()), HttpResponse.json({ reauthed: true, expiresInSeconds: 900 }))),
    );
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    await userEvent.click(await screen.findByRole("button", { name: /การแจ้งเตือน/ }));
    await userEvent.click(screen.getByRole("button", { name: /รออนุมัติ/ }));
    const card = await screen.findByRole("article", { name: "คืนเงิน" });
    await userEvent.click(within(card).getByRole("button", { name: "อนุมัติ" }));
    expect(await screen.findByText("ยืนยันตัวตนอีกครั้ง")).toBeInTheDocument();
    // ไม่มี Passkey ในบัญชี: ไม่มีปุ่มแตะ Passkey
    expect(screen.queryByRole("button", { name: "แตะ Passkey แทน" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("รหัส 6 หลักจากแอป Authenticator"), "135790");
    await userEvent.click(screen.getByRole("button", { name: "ยืนยัน" }));
    expect(await screen.findByText("อนุมัติแล้ว")).toBeInTheDocument();
    expect(code).toEqual({ code: "135790" });
    expect(approveCalls).toBe(2);
    expect(startAuthentication).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getByRole("button", { name: "แตะ Passkey แทน" }));
    await waitFor(() => expect(screen.queryByText("เซสชันหมดอายุ")).not.toBeInTheDocument());
    expect(screen.getByText("เนื้อหาของหน้า")).toBeInTheDocument();
  });

  it("ทำต่อด้วยรหัสผ่าน + รหัส 6 หลัก (เครื่องที่ไม่มี Passkey)", async () => {
    const sent: unknown[] = [];
    server.use(
      http.post(`${OPS}/auth/login/password`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ mfaToken: "mfa-token-123", email: staff.admin.email }))),
      http.post(`${OPS}/auth/login/totp`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ staff: staff.admin }))),
    );
    shell();
    await screen.findByText("เนื้อหาของหน้า");
    act(() => void window.dispatchEvent(new CustomEvent(OPS_UNAUTHORIZED)));
    await screen.findByText("เซสชันหมดอายุ");
    await userEvent.type(screen.getByLabelText("รหัสผ่าน"), "correct-horse-battery");
    await userEvent.type(screen.getByLabelText("รหัส 6 หลัก"), "246810");
    await userEvent.click(screen.getByRole("button", { name: "ทำต่อจากหน้าเดิม" }));
    await waitFor(() => expect(screen.queryByText("เซสชันหมดอายุ")).not.toBeInTheDocument());
    expect(sent).toEqual([{ email: staff.admin.email, password: "correct-horse-battery" }, { mfaToken: "mfa-token-123", code: "246810" }]);
    expect(startAuthentication).not.toHaveBeenCalled();
  });
});
