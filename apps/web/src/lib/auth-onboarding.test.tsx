// W01 · Login / สมัคร / ลืมรหัสผ่าน / รับคำเชิญ / Onboarding · ทดสอบกับ MSW (ข้อมูลสมมติเท่านั้น)
// วางไว้ใต้ src/ เพราะ vitest ของเว็บค้นเฉพาะ src/**/*.test.* (ไฟล์ใหม่ใน src/lib เพิ่มได้ตาม README)
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import messages from "../../messages/th/auth-onboarding.json";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { server } from "@/test/server";
import { LoginForm } from "../../app/(auth)/login/_components/login-form";
import { SignupForm } from "../../app/(auth)/signup/_components/signup-form";
import { ForgotPasswordFlow } from "../../app/(auth)/forgot-password/_components/forgot-password-flow";
import { JoinInvite } from "../../app/(auth)/join/[token]/_components/join-invite";
import { OnboardingWizard, slugify } from "../../app/(auth)/onboarding/_components/onboarding-wizard";

const render = (ui: React.ReactElement) => renderWithProviders(ui, { messages: { "auth-onboarding": messages } });
const apiError = (status: number, code: string, message: string, details: Record<string, unknown> = {}, requestId = "req_test01") =>
  HttpResponse.json({ error: { code, message, details, requestId } }, { status });

type Captured = { method: string; path: string; body: unknown }[];
afterEach(() => server.events.removeAllListeners());
function capture(calls: Captured) {
  server.events.on("request:start", async ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1/auth/csrf") return;
    const text = request.method === "GET" ? "" : await request.clone().text();
    calls.push({ method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : undefined });
  });
}
async function pasteCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.click(screen.getByLabelText("หลักที่ 1"));
  await user.paste(code);
}

describe("J1 · เข้าสู่ระบบ", () => {
  it("รหัสถูก → เปิด Workspace แรก และส่ง remember ตามที่ติ๊ก", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.post("*/api/v1/auth/login", () => HttpResponse.json({ id: "u1" })),
      http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ slug: "friday-dev" }, { slug: "other" }] })),
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText("อีเมล"), "lead@example.com");
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    await user.click(screen.getByRole("checkbox", { name: "จดจำฉันไว้ 30 วัน" }));
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/w/friday-dev"));
    expect(calls.find((c) => c.path === "/api/v1/auth/login")?.body).toEqual({ email: "lead@example.com", password: "Friday2026", remember: false });
  });

  it("กลับไปหน้าเดิมจาก returnTo · ไม่มี Workspace ไป Onboarding · กัน returnTo นอกเว็บ", async () => {
    server.use(http.post("*/api/v1/auth/login", () => HttpResponse.json({ id: "u1" })));
    const user = userEvent.setup();
    navigation.search = "returnTo=%2Fw%2Ffriday-dev%2Fp%2FDP%2Fboard";
    const first = render(<LoginForm />);
    await user.type(screen.getByLabelText("อีเมล"), "lead@example.com");
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/w/friday-dev/p/DP/board"));
    first.unmount();

    navigation.search = "returnTo=%2F%2Fevil.example.com";
    server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [] })));
    render(<LoginForm />);
    await user.type(screen.getByLabelText("อีเมล"), "new@example.com");
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/onboarding"));
  });

  it("ช่องว่างไม่ส่งคำขอ · รหัสผิดบอกจำนวนครั้งที่เหลือพร้อม requestId · บัญชีถูกล็อก", async () => {
    const calls: Captured = [];
    capture(calls);
    let attempt = 0;
    server.use(
      http.post("*/api/v1/auth/login", () =>
        ++attempt === 1
          ? apiError(401, "invalid_credentials", "อีเมลหรือรหัสผ่านไม่ถูกต้อง", { attemptsLeft: 4, lockoutMinutes: 15 })
          : apiError(429, "account_locked", "บัญชีถูกล็อก", { lockedUntil: "2026-12-01T03:15:00.000Z" }),
      ),
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    expect(screen.getAllByText("กรอกช่องนี้")).toHaveLength(2);
    expect(calls).toHaveLength(0);

    await user.type(screen.getByLabelText("อีเมล"), "lead@example.com");
    await user.type(screen.getByLabelText("รหัสผ่าน"), "wrong");
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("ลองได้อีก 4 ครั้งก่อนบัญชีถูกล็อก 15 นาที");
    expect(alert).toHaveTextContent("req_test01");
    expect(screen.getByLabelText("รหัสผ่าน")).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    expect(await screen.findByText(/ลองใหม่ได้หลัง 10:15 น\./)).toBeInTheDocument();
  });

  it("2FA: รหัส 6 หลัก + จำอุปกรณ์ · รหัสผิดแจ้งเตือน · token หมดอายุกลับขั้นแรก", async () => {
    const calls: Captured = [];
    capture(calls);
    let mfa = 0;
    server.use(
      http.post("*/api/v1/auth/login", () => HttpResponse.json({ mfaRequired: true, mfaToken: "mfa-1", email: "lead@example.com" })),
      http.post("*/api/v1/auth/login/mfa", () => {
        mfa++;
        if (mfa === 1) return apiError(401, "invalid_mfa_code", "รหัสยืนยันไม่ถูกต้อง", { attemptsLeft: 3, lockoutMinutes: 15 });
        if (mfa === 2) return HttpResponse.json({ id: "u1" });
        return apiError(401, "mfa_token_invalid", "หมดเวลา");
      }),
      http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ slug: "friday-dev" }] })),
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText("อีเมล"), "lead@example.com");
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    expect(await screen.findByRole("heading", { name: "ยืนยันตัวตน 2 ขั้นตอน" })).toBeInTheDocument();
    expect(screen.getByText(/Authenticator ของ lead@example.com/)).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "ยืนยันและเข้าสู่ระบบ" });
    expect(submit).toBeDisabled();

    await pasteCode(user, "123456");
    await user.click(screen.getByRole("checkbox", { name: "ไม่ต้องถามอีกบนอุปกรณ์นี้ 30 วัน" }));
    await user.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("รหัสยืนยันไม่ถูกต้อง");
    expect(calls.find((c) => c.path === "/api/v1/auth/login/mfa")?.body).toEqual({ mfaToken: "mfa-1", code: "123456", trustDevice: true });

    await user.click(screen.getByRole("button", { name: "ยืนยันและเข้าสู่ระบบ" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/w/friday-dev"));
  });

  it("Backup code แจ้งจำนวนที่เหลือ · mfaToken หมดอายุกลับไปขั้นรหัสผ่าน", async () => {
    let mfa = 0;
    server.use(
      http.post("*/api/v1/auth/login", () => HttpResponse.json({ mfaRequired: true, mfaToken: "mfa-2", email: "dev@example.com" })),
      http.post("*/api/v1/auth/login/mfa", () =>
        ++mfa === 1 ? apiError(401, "mfa_token_invalid", "หมดเวลา") : HttpResponse.json({ id: "u1", backupCodesLeft: 7 }),
      ),
      http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ slug: "friday-dev" }] })),
    );
    const user = userEvent.setup();
    render(<LoginForm />);
    const login = async () => {
      await user.type(screen.getByLabelText("อีเมล"), "dev@example.com");
      await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
      await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
      await user.click(await screen.findByRole("button", { name: "ใช้ Backup code" }));
      await user.type(screen.getByLabelText("Backup code"), "ABCD-EFGH");
      await user.click(screen.getByRole("button", { name: "ยืนยันและเข้าสู่ระบบ" }));
    };
    await login();
    expect(await screen.findByText("ขั้นตอนยืนยันตัวตนหมดเวลา · เข้าสู่ระบบใหม่อีกครั้ง")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "เข้าสู่ระบบ" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("อีเมล"));
    await login();
    expect(await screen.findByText("เข้าสู่ระบบด้วย Backup code แล้ว · เหลืออีก 7 รหัส")).toBeInTheDocument();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/w/friday-dev"));
  });

  it("OAuth: ปุ่มชี้ไป API พร้อม returnTo · error จากผู้ให้บริการ · 2FA ผ่าน fragment", async () => {
    navigation.search = "error=oauth_email_unverified&returnTo=%2Fw%2Ffriday-dev";
    const user = userEvent.setup();
    const first = render(<LoginForm />);
    expect(screen.getByRole("alert")).toHaveTextContent("อีเมลในบัญชีผู้ให้บริการยังไม่ได้ยืนยัน");
    expect(screen.getByRole("link", { name: /Google/ })).toHaveAttribute(
      "href",
      "/api/v1/auth/oauth/google/start?next=%2Fw%2Ffriday-dev&remember=true",
    );
    await user.click(screen.getByRole("checkbox", { name: "จดจำฉันไว้ 30 วัน" }));
    expect(screen.getByRole("link", { name: /Microsoft/ })).toHaveAttribute("href", "/api/v1/auth/oauth/microsoft/start?next=%2Fw%2Ffriday-dev");
    expect(screen.getByRole("button", { name: "SSO ขององค์กร (SAML)" })).toBeDisabled();
    first.unmount();

    navigation.search = "";
    window.history.replaceState(null, "", "/login#mfaToken=oauth-mfa&email=lead%40example.com&next=%2Fw%2Ffriday-dev%2Finbox");
    render(<LoginForm />);
    expect(await screen.findByRole("heading", { name: "ยืนยันตัวตน 2 ขั้นตอน" })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/");
  });
});

describe("J2 · สมัครและยืนยันอีเมล", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, email = "new@example.com") {
    await user.type(screen.getByLabelText("ชื่อที่แสดง"), "ผู้ทดสอบ");
    await user.type(screen.getByLabelText("อีเมลที่ทำงาน"), email);
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    await user.click(screen.getByRole("checkbox"));
  }

  it("ตรวจฟอร์มก่อนส่ง และแสดงเงื่อนไขรหัสผ่านแบบสด", async () => {
    const calls: Captured = [];
    capture(calls);
    const user = userEvent.setup();
    render(<SignupForm />);
    await user.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
    expect(screen.getByText("ต้องยอมรับข้อกำหนดก่อนสร้างบัญชี")).toBeInTheDocument();
    expect(screen.getByText("รหัสผ่านยังไม่ครบเงื่อนไข")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    const rules = screen.getByRole("list", { name: "เงื่อนไขรหัสผ่าน" });
    expect(within(rules).getByText("อย่างน้อย 8 ตัวอักษร").closest("li")).toHaveAttribute("data-ok", "true");
    expect(within(rules).getByText("มีอักขระพิเศษ (แนะนำ)").closest("li")).toHaveAttribute("data-ok", "false");
    expect(screen.getByText("ความปลอดภัย: ดี")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ข้อกำหนดการใช้งาน" })).toHaveAttribute("href", "/legal/terms");
  });

  it("สมัครแล้วยืนยันด้วยรหัส 6 หลัก → Onboarding · นับถอยหลังก่อนส่งใหม่", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.post("*/api/v1/auth/signup", () => HttpResponse.json({ id: "u1", email: "new@example.com", displayName: "ผู้ทดสอบ" }, { status: 201 })),
      http.post("*/api/v1/auth/verify-email", async ({ request }) =>
        ((await request.json()) as { code: string }).code === "000000"
          ? apiError(400, "invalid_token", "ลิงก์หรือรหัสไม่ถูกต้อง")
          : HttpResponse.json({ emailVerified: true }),
      ),
    );
    const user = userEvent.setup();
    render(<SignupForm />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
    expect(await screen.findByRole("heading", { name: "ยืนยันอีเมลของคุณ" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/auth/signup")?.body).toEqual({
      email: "new@example.com",
      password: "Friday2026",
      displayName: "ผู้ทดสอบ",
      acceptTerms: true,
    });
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    // ส่งอีเมลได้ตามปกติ = ไม่มีปุ่มข้าม
    expect(screen.queryByRole("button", { name: "ข้ามไปก่อน ยืนยันภายหลัง" })).not.toBeInTheDocument();
    expect(screen.getByText("1:00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ส่งรหัสใหม่" })).not.toBeInTheDocument();

    await pasteCode(user, "000000");
    await user.click(screen.getByRole("button", { name: "ยืนยันและตั้งค่า Workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("รหัสไม่ถูกต้องหรือหมดอายุแล้ว");
    await pasteCode(user, "482913");
    await user.click(screen.getByRole("button", { name: "ยืนยันและตั้งค่า Workspace" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
    expect(calls.filter((c) => c.path === "/api/v1/auth/verify-email").at(-1)?.body).toEqual({ code: "482913" });
  });

  it("ยังไม่ได้ตั้ง SMTP: บอกว่ารหัสยังไม่ถูกส่ง และข้ามไปก่อนแล้วยืนยันภายหลังได้", async () => {
    server.use(http.post("*/api/v1/auth/signup", () => HttpResponse.json({ id: "u1", email: "new@example.com", displayName: "ผู้ทดสอบ", emailDelivery: false }, { status: 201 })));
    const user = userEvent.setup();
    render(<SignupForm />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
    expect(await screen.findByText(/ระบบยังไม่ได้ตั้งค่าการส่งอีเมล/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ข้ามไปก่อน ยืนยันภายหลัง" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/onboarding"));
  });

  it("อีเมลซ้ำ → บอกที่ช่องพร้อมลิงก์เข้าสู่ระบบ (คง returnTo)", async () => {
    navigation.search = "returnTo=%2Fjoin%2Ftok";
    server.use(http.post("*/api/v1/auth/signup", () => apiError(409, "email_taken", "อีเมลนี้มีบัญชีแล้ว")));
    const user = userEvent.setup();
    render(<SignupForm />);
    await fill(user, "lead@example.com");
    await user.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
    expect(await screen.findByText("อีเมลนี้มีบัญชีแล้ว")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เข้าสู่ระบบแทน" })).toHaveAttribute("href", "/login?returnTo=%2Fjoin%2Ftok");
  });

  it("เปลี่ยนอีเมลระหว่างยืนยัน: ส่งรหัสไปอีเมลใหม่และยืนยันผ่าน me/email:confirm", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.post("*/api/v1/auth/signup", () => HttpResponse.json({ id: "u1" }, { status: 201 })),
      http.post("*/api/v1/me/email:change", () => HttpResponse.json({ pendingEmail: "fixed@example.com", retryAfter: 60 }, { status: 202 })),
      http.post("*/api/v1/me/email:confirm", () => HttpResponse.json({ emailVerified: true, email: "fixed@example.com" })),
    );
    navigation.search = "returnTo=%2Fjoin%2Ftok";
    const user = userEvent.setup();
    render(<SignupForm />);
    await fill(user, "typo@example.con");
    await user.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
    await user.click(await screen.findByRole("button", { name: "เปลี่ยนอีเมล" }));
    await user.type(screen.getByLabelText("อีเมลใหม่"), "fixed@example.com");
    await user.click(screen.getByRole("button", { name: "ส่งรหัสไปที่อีเมลใหม่" }));
    expect(await screen.findByText("fixed@example.com")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/me/email:change")?.body).toEqual({ newEmail: "fixed@example.com", password: "Friday2026" });
    await pasteCode(user, "111222");
    await user.click(screen.getByRole("button", { name: "ยืนยันและตั้งค่า Workspace" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/join/tok"));
    expect(calls.find((c) => c.path === "/api/v1/me/email:confirm")?.body).toEqual({ code: "111222" });
  });

  it("ลิงก์ยืนยันในอีเมล ?token= ใช้ได้ครั้งเดียว · ลิงก์เสียบอกพร้อม requestId", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(http.post("*/api/v1/auth/verify-email", () => HttpResponse.json({ emailVerified: true })));
    navigation.search = "token=link-token-123";
    const first = render(<SignupForm />);
    expect(await screen.findByRole("heading", { name: "ยืนยันอีเมลเรียบร้อย" })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/v1/auth/verify-email")).toEqual([
      { method: "POST", path: "/api/v1/auth/verify-email", body: { token: "link-token-123" } },
    ]);
    first.unmount();

    server.use(http.post("*/api/v1/auth/verify-email", () => apiError(400, "invalid_token", "ลิงก์หรือรหัสไม่ถูกต้อง", {}, "req_link9")));
    render(<SignupForm />);
    expect(await screen.findByRole("heading", { name: "ลิงก์ยืนยันอีเมลไม่ถูกต้องหรือหมดอายุแล้ว" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("req_link9");
  });
});

describe("J3 · ลืมรหัสผ่าน", () => {
  it("ขอลิงก์ → หน้าตรวจอีเมล · ใช้อีเมลอื่นกลับขั้นแรก", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(http.post("*/api/v1/auth/password/forgot", () => HttpResponse.json({ retryAfter: 60 }, { status: 202 })));
    const user = userEvent.setup();
    render(<ForgotPasswordFlow />);
    expect(screen.getByRole("img", { name: "ขั้นที่ 1 จาก 3" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("อีเมล"), "lead@example.com");
    await user.click(screen.getByRole("button", { name: "ส่งลิงก์รีเซ็ตรหัสผ่าน" }));
    expect(await screen.findByRole("heading", { name: "ตรวจสอบอีเมลของคุณ" })).toBeInTheDocument();
    expect(screen.getByText("lead@example.com")).toBeInTheDocument();
    expect(calls[0].body).toEqual({ email: "lead@example.com" });
    await user.click(screen.getByRole("button", { name: "ใช้อีเมลอื่น" }));
    expect(screen.getByRole("heading", { name: "ลืมรหัสผ่าน?" })).toBeInTheDocument();
  });

  it("ตั้งรหัสใหม่จากลิงก์ตามนโยบายของ Workspace และออกจากระบบทุกเครื่อง", async () => {
    const calls: Captured = [];
    capture(calls);
    navigation.search = "token=reset-abc";
    server.use(
      http.get("*/api/v1/auth/password/reset", () =>
        HttpResponse.json({ email: "lead@example.com", expiresAt: "2026-12-01T03:30:00Z", policy: { minLength: 10, requireSpecial: true } }),
      ),
      http.post("*/api/v1/auth/password/reset", () => HttpResponse.json({ ok: true, email: "lead@example.com", loggedOutSessions: 2 })),
    );
    const user = userEvent.setup();
    render(<ForgotPasswordFlow />);
    expect(await screen.findByText("สำหรับ lead@example.com")).toBeInTheDocument();
    expect(screen.getByText("อย่างน้อย 10 ตัวอักษร")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "บันทึกรหัสผ่านใหม่" });
    await user.type(screen.getByLabelText("รหัสผ่านใหม่"), "Friday2026");
    await user.type(screen.getByLabelText("ยืนยันรหัสผ่านใหม่"), "Friday2026");
    expect(save).toBeDisabled(); // นโยบายบังคับอักขระพิเศษ
    await user.type(screen.getByLabelText("รหัสผ่านใหม่"), "#");
    expect(screen.getByText("รหัสผ่านไม่ตรงกัน")).toBeInTheDocument();
    await user.type(screen.getByLabelText("ยืนยันรหัสผ่านใหม่"), "#");
    expect(screen.getByText("✓ ตรงกัน")).toBeInTheDocument();
    await user.click(save);
    expect(await screen.findByRole("heading", { name: "เปลี่ยนรหัสผ่านเรียบร้อย" })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ token: "reset-abc", newPassword: "Friday2026#", logoutAll: true });
    expect(screen.getByRole("link", { name: "เข้าสู่ระบบ" })).toHaveAttribute("href", "/login");
  });

  it("ลิงก์หมดอายุ → ขอลิงก์ใหม่", async () => {
    navigation.search = "token=old";
    server.use(http.get("*/api/v1/auth/password/reset", () => apiError(400, "invalid_token", "ลิงก์ไม่ถูกต้อง")));
    const user = userEvent.setup();
    render(<ForgotPasswordFlow />);
    expect(await screen.findByRole("heading", { name: "ลิงก์นี้ใช้ไม่ได้แล้ว" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ขอลิงก์ใหม่" }));
    expect(router.replace).toHaveBeenCalledWith("/forgot-password");
  });
});

describe("J4 · รับคำเชิญ", () => {
  const invitation = {
    status: "pending",
    email: "kl@example.com",
    workspace: { name: "Friday Workspace", slug: "friday-dev" },
    invitedBy: "Mick",
    workspaceRole: "member",
    project: { key: "DP", name: "Development Plan" },
    projectRole: "member",
    message: "ยินดีต้อนรับครับ",
    expiresAt: new Date(Date.now() + 5 * 86_400_000 - 60_000).toISOString(),
  };
  const anonymous = () => http.get("*/api/v1/me", () => apiError(401, "unauthenticated", "กรุณาเข้าสู่ระบบ"));

  it("กำลังโหลด → ผู้ใช้ใหม่สร้างบัญชีด้วยอีเมลที่ล็อกไว้แล้วตอบรับ", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.get("*/api/v1/invitations/:token", () => HttpResponse.json(invitation)),
      anonymous(),
      http.post("*/api/v1/auth/signup", () => HttpResponse.json({ id: "u2" }, { status: 201 })),
      http.post("*/api/v1/invitations/:token/accept", () => HttpResponse.json({ workspace: { slug: "friday-dev", name: "Friday Workspace" }, role: "member" })),
    );
    const user = userEvent.setup();
    render(<JoinInvite token="tok-1" />);
    expect(screen.getAllByLabelText("กำลังโหลด…").length).toBeGreaterThan(0);
    expect(await screen.findByRole("heading", { name: "Mick เชิญคุณเข้าร่วม Friday Workspace" })).toBeInTheDocument();
    expect(screen.getByText("Development Plan · Member")).toBeInTheDocument();
    expect(screen.getByText("คำเชิญส่งถึง kl@example.com · หมดอายุใน 5 วัน")).toBeInTheDocument();
    expect(screen.getByLabelText("อีเมล")).toHaveValue("kl@example.com");
    expect(screen.getByLabelText("อีเมล")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "ปฏิเสธคำเชิญ" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เข้าสู่ระบบเพื่อตอบรับ" })).toHaveAttribute("href", "/login?returnTo=%2Fjoin%2Ftok-1");

    await user.type(screen.getByLabelText("ชื่อที่แสดง"), "KL");
    await user.type(screen.getByLabelText("รหัสผ่าน"), "Friday2026");
    const accept = screen.getByRole("button", { name: "ตอบรับและเข้าร่วม" });
    expect(accept).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(accept);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/w/friday-dev"));
    expect(calls.find((c) => c.path === "/api/v1/auth/signup")?.body).toEqual({
      email: "kl@example.com",
      password: "Friday2026",
      displayName: "KL",
      acceptTerms: true,
    });
    expect(calls.some((c) => c.path === "/api/v1/invitations/tok-1/accept")).toBe(true);
  });

  it("มีบัญชีอยู่แล้ว → เข้าร่วม หรือปฏิเสธคำเชิญ", async () => {
    server.use(
      http.get("*/api/v1/invitations/:token", () => HttpResponse.json(invitation)),
      http.get("*/api/v1/me", () => HttpResponse.json({ id: "u2", email: "KL@example.com", displayName: "KL" })),
      http.post("*/api/v1/invitations/:token/decline", () => HttpResponse.json({ status: "declined" })),
    );
    const user = userEvent.setup();
    render(<JoinInvite token="tok-2" />);
    expect(await screen.findByText("KL@example.com · เข้าสู่ระบบอยู่")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "เข้าร่วม Friday Workspace" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "ปฏิเสธคำเชิญ" }));
    expect(await screen.findByText("ปฏิเสธคำเชิญแล้ว")).toBeInTheDocument();
  });

  it("403: บัญชีที่ล็อกอินอยู่ไม่ใช่อีเมลที่ถูกเชิญ → ออกแล้วเข้าสู่ระบบใหม่", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.get("*/api/v1/invitations/:token", () => HttpResponse.json(invitation)),
      http.get("*/api/v1/me", () => HttpResponse.json({ id: "u9", email: "other@example.com", displayName: "Other" })),
      http.post("*/api/v1/auth/logout", () => new HttpResponse(null, { status: 204 })),
    );
    const user = userEvent.setup();
    render(<JoinInvite token="tok-3" />);
    expect(await screen.findByText("คำเชิญนี้ส่งถึงอีเมลอื่น")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /เข้าร่วม/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เข้าสู่ระบบด้วยบัญชีอื่น" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?returnTo=%2Fjoin%2Ftok-3"));
    expect(calls.some((c) => c.path === "/api/v1/auth/logout")).toBe(true);
  });

  it("ลิงก์หมดอายุ (410) ทั้งตอนเปิดและตอนกดตอบรับ", async () => {
    server.use(
      http.get("*/api/v1/invitations/:token", ({ params }) =>
        HttpResponse.json(params.token === "dead" ? { ...invitation, status: "expired", expiresAt: "2026-11-30T05:00:00Z" } : invitation),
      ),
      http.get("*/api/v1/me", () => HttpResponse.json({ id: "u2", email: "kl@example.com", displayName: "KL" })),
      http.post("*/api/v1/invitations/:token/accept", () => apiError(410, "invitation_expired", "ลิงก์คำเชิญนี้หมดอายุแล้ว")),
    );
    const user = userEvent.setup();
    const first = render(<JoinInvite token="dead" />);
    expect(await screen.findByRole("heading", { name: "ลิงก์คำเชิญนี้หมดอายุแล้ว" })).toBeInTheDocument();
    expect(screen.getByText(/หมดอายุเมื่อ 30 พ\.ย\. 2569/)).toBeInTheDocument();
    first.unmount();

    render(<JoinInvite token="live" />);
    await user.click(await screen.findByRole("button", { name: "เข้าร่วม Friday Workspace" }));
    expect(await screen.findByRole("heading", { name: "ลิงก์คำเชิญนี้หมดอายุแล้ว" })).toBeInTheDocument();
  });

  it("ไม่พบคำเชิญ (404) และ error อื่นแสดง requestId", async () => {
    server.use(http.get("*/api/v1/invitations/:token", ({ params }) =>
      params.token === "missing" ? apiError(404, "not_found", "ไม่พบคำเชิญ") : apiError(500, "internal", "ระบบขัดข้อง", {}, "req_boom"),
    ), anonymous());
    const first = render(<JoinInvite token="missing" />);
    expect(await screen.findByText("ตรวจลิงก์อีกครั้ง หรือขอลิงก์ใหม่จากผู้เชิญ")).toBeInTheDocument();
    first.unmount();
    render(<JoinInvite token="broken" />);
    expect(await screen.findByText(/req_boom/)).toBeInTheDocument();
  });
});

describe("J5 · Onboarding", () => {
  it("slug จากชื่อ", () => {
    expect(slugify("Friday Workspace!")).toBe("friday-workspace");
    expect(slugify("ทีมพัฒนา")).toBe("");
  });

  it("สร้าง Workspace → ทีม → เชิญตาม Role → เปิดโปรเจกต์ตัวอย่าง", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.get("*/api/v1/me", () => HttpResponse.json({ id: "u1", email: "lead@example.com", displayName: "Mick" })),
      http.get("*/api/v1/workspaces/slug-available", ({ request }) =>
        HttpResponse.json({ slug: new URL(request.url).searchParams.get("slug"), available: true }),
      ),
      http.post("*/api/v1/workspaces", () => HttpResponse.json({ id: "w1", slug: "friday-dev", name: "Friday Dev", role: "owner" }, { status: 201 })),
      http.post("*/api/v1/w/:ws/invitations", async ({ request }) => {
        const body = (await request.json()) as { emails: string[] };
        return HttpResponse.json({ items: body.emails.map((email) => ({ email, status: email.startsWith("old") ? "already_member" : "invited" })) }, { status: 201 });
      }),
      http.post("*/api/v1/w/:ws/projects/sample", () => HttpResponse.json({ key: "DEMO", sample: true }, { status: 201 })),
    );
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    expect(screen.getAllByLabelText("กำลังโหลด…").length).toBeGreaterThan(0);
    await user.type(await screen.findByLabelText("ชื่อ Workspace"), "Friday Dev");
    expect(screen.getByLabelText("ชื่อใน URL")).toHaveValue("friday-dev");
    expect(await screen.findByText("✓ ใช้ได้")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));

    expect(await screen.findByRole("heading", { name: "บอกเราเกี่ยวกับทีมของคุณ" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/v1/workspaces")?.body).toEqual({ name: "Friday Dev", slug: "friday-dev" });
    await user.click(screen.getByRole("button", { name: /Waterfall/ }));
    expect(screen.getByRole("button", { name: /Waterfall/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));

    expect(await screen.findByRole("heading", { name: "เชิญทีมของคุณ" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("อีเมลสมาชิกคนที่ 1"), "dev@example.com");
    await user.type(screen.getByLabelText("อีเมลสมาชิกคนที่ 2"), "not-an-email");
    expect(screen.getByRole("alert")).toHaveTextContent("อีเมลไม่ถูกต้อง: not-an-email");
    expect(screen.getByRole("button", { name: "ส่งคำเชิญและไปต่อ" })).toBeDisabled();
    await user.clear(screen.getByLabelText("อีเมลสมาชิกคนที่ 2"));
    await user.type(screen.getByLabelText("อีเมลสมาชิกคนที่ 2"), "pm@example.com");
    await user.selectOptions(screen.getByLabelText("Role ของสมาชิกคนที่ 2"), "admin");
    await user.click(screen.getByRole("button", { name: "+ เพิ่มอีกคน" }));
    await user.type(screen.getByLabelText("อีเมลสมาชิกคนที่ 4"), "old@example.com");
    await user.click(screen.getByRole("button", { name: "ส่งคำเชิญและไปต่อ" }));

    expect(await screen.findByRole("heading", { name: "เริ่มโปรเจกต์แรก" })).toBeInTheDocument();
    expect(screen.getByText("ส่งคำเชิญแล้ว 2 คน · old@example.com เป็นสมาชิกอยู่แล้ว")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/v1/w/friday-dev/invitations").map((c) => c.body)).toEqual([
      { emails: ["dev@example.com", "old@example.com"], workspaceRole: "member" },
      { emails: ["pm@example.com"], workspaceRole: "admin" },
    ]);
    await user.click(screen.getByRole("button", { name: "เปิดโปรเจกต์ตัวอย่าง" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/w/friday-dev/p/DEMO"));
  });

  it("URL ซ้ำบล็อกการไปต่อ · ข้ามการเชิญ · สร้างโปรเจกต์ใหม่ส่งวิธีทำงานต่อ · ย้อนกลับไม่สร้าง Workspace ซ้ำ", async () => {
    const calls: Captured = [];
    capture(calls);
    server.use(
      http.get("*/api/v1/me", () => HttpResponse.json({ id: "u1", email: "lead@example.com", displayName: "Mick" })),
      http.get("*/api/v1/workspaces/slug-available", ({ request }) => {
        const slug = new URL(request.url).searchParams.get("slug");
        return HttpResponse.json({ slug, available: slug !== "taken" });
      }),
      http.post("*/api/v1/workspaces", () => HttpResponse.json({ id: "w1", slug: "my-team", name: "My Team", role: "owner" }, { status: 201 })),
    );
    const user = userEvent.setup();
    render(<OnboardingWizard />);
    await user.type(await screen.findByLabelText("ชื่อ Workspace"), "Taken");
    expect(await screen.findByText("URL นี้มีคนใช้แล้ว")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ถัดไป →" })).toBeDisabled();
    await user.clear(screen.getByLabelText("ชื่อใน URL"));
    await user.type(screen.getByLabelText("ชื่อใน URL"), "-team");
    expect(await screen.findByText(/ใช้ได้เฉพาะ a–z/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("ชื่อใน URL"));
    await user.type(screen.getByLabelText("ชื่อใน URL"), "my-team");
    expect(await screen.findByText("✓ ใช้ได้")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));
    await user.click(await screen.findByRole("button", { name: "← ย้อนกลับ" }));
    expect(screen.getByText("สร้าง My Team แล้ว · ไปต่อได้เลย")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป →" }));
    await user.click(await screen.findByRole("button", { name: "ข้ามไปก่อน" }));
    await user.click(await screen.findByRole("button", { name: "ข้ามไปก่อน" }));
    await user.click(await screen.findByRole("button", { name: /สร้างโปรเจกต์ใหม่/ }));
    await user.click(screen.getByRole("button", { name: "ไปสร้างโปรเจกต์" }));
    expect(router.push).toHaveBeenCalledWith("/w/my-team/new-project?method=scrum");
    expect(calls.filter((c) => c.path === "/api/v1/workspaces" && c.method === "POST")).toHaveLength(1);
  });

  it("โหลดข้อมูลผู้ใช้ไม่ได้ → Error พร้อม requestId และลองใหม่ได้", async () => {
    server.use(http.get("*/api/v1/me", () => apiError(500, "internal", "ระบบขัดข้อง", {}, "req_me500")));
    render(<OnboardingWizard />);
    expect(await screen.findByText(/req_me500/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ลองอีกครั้ง/ })).toBeInTheDocument();
  });
});
