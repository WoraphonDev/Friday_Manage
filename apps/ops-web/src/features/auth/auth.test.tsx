import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { router } from "@/test/router";
import { OPS, opsError, server } from "@/test/server";
import { EnrollForm, EnrollPage } from "./EnrollForm";
import { LoginForm } from "./LoginForm";
import { LoginMethods } from "./LoginMethods";

const loginOptions = { challenge: "sample-challenge", rpId: "localhost", allowCredentials: [] };
const assertion = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "x", authenticatorData: "y", signature: "z" }, clientExtensionResults: {} };

const fillPassword = async (email: string, password = "correct-horse-battery") => {
  await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), email);
  await userEvent.type(screen.getByLabelText("รหัสผ่าน"), password);
  await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
};

describe("Login ด้วยรหัสผ่าน + แอป Authenticator", () => {
  it("รหัสผ่าน → รหัส 6 หลัก → หน้าจอสำเร็จ แล้วเข้าหน้าหลัก", async () => {
    let step1: unknown;
    let step2: unknown;
    server.use(
      http.post(`${OPS}/auth/login/password`, async ({ request }) => {
        step1 = await request.json();
        return HttpResponse.json({ mfaToken: "signed-mfa-token", email: "support@example.com" });
      }),
      http.post(`${OPS}/auth/login/totp`, async ({ request }) => {
        step2 = await request.json();
        return HttpResponse.json({ staff: staff.support });
      }),
    );
    renderWithProviders(<LoginForm />);
    await fillPassword("support@example.com");
    expect(step1).toEqual({ email: "support@example.com", password: "correct-horse-battery" });
    expect(await screen.findByText("ยืนยันขั้นที่ 2")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("รหัส 6 หลัก"), "48a2190");
    expect(screen.getByLabelText("รหัส 6 หลัก")).toHaveValue("482190");
    await userEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(step2).toEqual({ mfaToken: "signed-mfa-token", code: "482190" });
    expect(screen.getByText("เข้าสู่ระบบแล้ว")).toBeInTheDocument();
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("รหัสผ่านผิด: แสดงข้อความจาก ops-api พร้อมรหัสอ้างอิง · ไม่ไปขั้นรหัส 6 หลัก", async () => {
    server.use(http.post(`${OPS}/auth/login/password`, () => opsError(401, "login_failed", "อีเมลหรือรหัสผ่านไม่ถูกต้อง", undefined, "req-login-1")));
    renderWithProviders(<LoginForm />);
    await fillPassword("someone@example.com", "wrong");
    expect(await screen.findByText("อีเมลหรือรหัสผ่านไม่ถูกต้อง")).toBeInTheDocument();
    expect(screen.getByText("รหัสอ้างอิง: req-login-1")).toBeInTheDocument();
    expect(screen.queryByLabelText("รหัส 6 หลัก")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("รหัส 6 หลักหมดเวลา: กลับไปขั้นรหัสผ่าน", async () => {
    server.use(
      http.post(`${OPS}/auth/login/password`, () => HttpResponse.json({ mfaToken: "m".repeat(12), email: "a@example.com" })),
      http.post(`${OPS}/auth/login/totp`, () => opsError(400, "mfa_expired", "หมดเวลาใส่รหัส 6 หลัก · เริ่มเข้าสู่ระบบใหม่")),
    );
    renderWithProviders(<LoginForm />);
    await fillPassword("a@example.com");
    await userEvent.type(await screen.findByLabelText("รหัส 6 หลัก"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบ" }));
    expect(await screen.findByText(/หมดเวลาใส่รหัส 6 หลัก/)).toBeInTheDocument();
    expect(screen.getByLabelText("รหัสผ่าน")).toBeInTheDocument();
  });

  it("อีเมลผิดรูปแบบ / ไม่กรอกรหัสผ่าน ไม่ส่งคำขอ", async () => {
    const called = vi.fn();
    server.use(http.post(`${OPS}/auth/login/password`, () => (called(), HttpResponse.json({}))));
    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(screen.getByText("กรอกอีเมลให้ถูกต้อง")).toBeInTheDocument();
    expect(screen.getByText("กรอกรหัสผ่าน")).toBeInTheDocument();
    expect(called).not.toHaveBeenCalled();
  });
});

describe("Login ด้วย Passkey (ทางเลือก)", () => {
  it("ขอ options → ให้ key เซ็น → ส่ง challengeToken + response กลับ แล้วเข้าหน้าหลัก", async () => {
    let verifyBody: unknown;
    let optionsBody: unknown;
    server.use(
      http.post(`${OPS}/auth/login/options`, async ({ request }) => {
        optionsBody = await request.json();
        return HttpResponse.json({ options: loginOptions, challengeToken: "signed-login-token" });
      }),
      http.post(`${OPS}/auth/login/verify`, async ({ request }) => {
        verifyBody = await request.json();
        return HttpResponse.json({ staff: staff.support });
      }),
    );
    vi.mocked(startAuthentication).mockResolvedValue(assertion as never);
    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), "support@example.com");
    await userEvent.click(screen.getByRole("button", { name: "ใช้ Passkey ในเครื่องนี้" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(optionsBody).toEqual({ email: "support@example.com" });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: loginOptions });
    expect(verifyBody).toEqual({ challengeToken: "signed-login-token", response: assertion });
  });

  it("พนักงานที่ตั้งค่าไม่เสร็จ: บอกให้เปิดลิงก์เชิญอีกครั้ง", async () => {
    server.use(
      http.post(`${OPS}/auth/login/options`, () => HttpResponse.json({ options: loginOptions, challengeToken: "t" })),
      http.post(`${OPS}/auth/login/verify`, () => opsError(403, "enrollment_incomplete", "ลงทะเบียนกุญแจยังไม่ครบ")),
    );
    vi.mocked(startAuthentication).mockResolvedValue(assertion as never);
    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), "new@example.com");
    await userEvent.click(screen.getByRole("button", { name: "ใช้ Passkey ในเครื่องนี้" }));
    expect(await screen.findByText(/บัญชีนี้ยังตั้งค่าไม่เสร็จ/)).toBeInTheDocument();
  });

  it("ผู้ใช้กดยกเลิกที่ key: บอกให้ลองใหม่ ไม่ส่ง verify", async () => {
    const verify = vi.fn();
    server.use(
      http.post(`${OPS}/auth/login/options`, () => HttpResponse.json({ options: loginOptions, challengeToken: "t".repeat(12) })),
      http.post(`${OPS}/auth/login/verify`, () => {
        verify();
        return HttpResponse.json({});
      }),
    );
    vi.mocked(startAuthentication).mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), "someone@example.com");
    await userEvent.click(screen.getByRole("button", { name: "ใช้ Passkey ในเครื่องนี้" }));
    expect(await screen.findByText(/ยกเลิกหรือหมดเวลารอ Passkey/)).toBeInTheDocument();
    expect(verify).not.toHaveBeenCalled();
  });

  it("browser ไม่รองรับ Passkey: ซ่อนปุ่ม Passkey แต่ยังเข้าด้วยรหัสผ่านได้", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    renderWithProviders(<LoginForm />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "ใช้ Passkey ในเครื่องนี้" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "ถัดไป" })).toBeEnabled();
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
  });
});

describe("ตั้งรหัสผ่าน + แอป Authenticator", () => {
  const setup = { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Friday%20Ops:new@example.com?secret=JBSWY3DPEHPK3PXP", email: "new@example.com", setupToken: "signed-setup-token" };

  it("ลิงก์เชิญ: รหัสผ่าน ≥ 12 ตัว มีตัวพิมพ์ใหญ่ + ตัวเลข และตรงกัน → สแกน QR + รหัส 6 หลัก → เปิดใช้งาน", async () => {
    let setupBody: unknown;
    let verifyBody: unknown;
    server.use(
      http.post(`${OPS}/auth/password/setup`, async ({ request }) => {
        setupBody = await request.json();
        return HttpResponse.json(setup);
      }),
      http.post(`${OPS}/auth/password/verify`, async ({ request }) => {
        verifyBody = await request.json();
        return HttpResponse.json({ ok: true, status: "active" });
      }),
    );
    renderWithProviders(<EnrollPage token="sample-enroll-token-123" />);
    expect(screen.getByRole("heading", { name: "ตั้งค่าการเข้าระบบ" })).toBeInTheDocument();
    // แบบ C: ก่อนคลิกช่องเห็นแค่ข้อความสั้น · พิมพ์แล้วเงื่อนไขเลื่อนลงมา
    expect(screen.getByText("อย่างน้อย 12 ตัว มีตัวพิมพ์ใหญ่และตัวเลข")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "short");
    expect(screen.queryByText("อย่างน้อย 12 ตัว มีตัวพิมพ์ใหญ่และตัวเลข")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(screen.getByText("รหัสผ่านต้องยาวอย่างน้อย 12 ตัว")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "-but-long-now");
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(screen.getByText("รหัสผ่านยังไม่ครบเงื่อนไข")).toBeInTheDocument();
    expect(screen.getByText("อย่างน้อย 12 ตัวอักษร").closest("li")).toHaveAttribute("data-ok", "true");
    expect(screen.getByText("มีตัวพิมพ์ใหญ่").closest("li")).toHaveAttribute("data-ok", "false");
    await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "-X9");
    await userEvent.click(screen.getAllByRole("button", { name: "แสดงรหัสผ่าน" })[0]);
    expect(screen.getByLabelText("รหัสผ่านใหม่")).toHaveAttribute("type", "text");
    await userEvent.type(screen.getByLabelText("ยืนยันรหัสผ่าน"), "different-value!");
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(screen.getByText("รหัสผ่านทั้งสองช่องไม่ตรงกัน")).toBeInTheDocument();
    expect(setupBody).toBeUndefined();
    await userEvent.clear(screen.getByLabelText("ยืนยันรหัสผ่าน"));
    await userEvent.type(screen.getByLabelText("ยืนยันรหัสผ่าน"), "short-but-long-now-X9");
    expect(screen.getByText("✓ ตรงกัน")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(await screen.findByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    expect(setupBody).toEqual({ enrollToken: "sample-enroll-token-123" });
    await userEvent.type(screen.getByLabelText("รหัส 6 หลัก"), "135702");
    await userEvent.click(screen.getByRole("button", { name: "เปิดใช้งานบัญชี" }));
    expect(await screen.findByText("ตั้งค่าเสร็จแล้ว · เข้าสู่ระบบได้เลย")).toBeInTheDocument();
    expect(verifyBody).toEqual({ setupToken: "signed-setup-token", password: "short-but-long-now-X9", code: "135702" });
    expect(screen.getByRole("link", { name: "ไปหน้าเข้าสู่ระบบ" })).toHaveAttribute("href", "/login");
  });

  it("ลิงก์หมดอายุ: แสดง error ของ ops-api", async () => {
    server.use(http.post(`${OPS}/auth/password/setup`, () => opsError(401, "enroll_token_invalid", "ลิงก์ตั้งค่าไม่ถูกต้องหรือหมดอายุ · ขอลิงก์ใหม่จาก Owner")));
    renderWithProviders(<EnrollPage token="expired-token-000" />);
    await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "Long-enough-pass-1");
    await userEvent.type(screen.getByLabelText("ยืนยันรหัสผ่าน"), "Long-enough-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(await screen.findByText(/ลิงก์ตั้งค่าไม่ถูกต้องหรือหมดอายุ/)).toBeInTheDocument();
  });
});

describe("ลงทะเบียน Passkey / Security key", () => {
  const regOptions = { challenge: "reg-challenge", rp: { name: "Friday Ops", id: "localhost" }, user: { id: "u", name: "n", displayName: "d" }, pubKeyCredParams: [] };
  const attestation = { id: "cred-new", rawId: "cred-new", type: "public-key", response: { clientDataJSON: "a", attestationObject: "b" }, clientExtensionResults: {} };

  it("ด้วย enrollToken จากลิงก์: ส่งโทเค็นและชื่อ key แล้วพาไปหน้า Login", async () => {
    let optionsBody: unknown;
    let verifyBody: unknown;
    server.use(
      http.post(`${OPS}/auth/register/options`, async ({ request }) => {
        optionsBody = await request.json();
        return HttpResponse.json({ options: regOptions, challengeToken: "signed-reg-token" });
      }),
      http.post(`${OPS}/auth/register/verify`, async ({ request }) => {
        verifyBody = await request.json();
        keys += 1;
        return HttpResponse.json({ registered: true, credentialId: `cred-${keys}`, keys });
      }),
    );
    let keys = 0;
    vi.mocked(startRegistration).mockResolvedValue(attestation as never);
    renderWithProviders(<EnrollPage token="sample-enroll-token-123" />);
    await userEvent.click(screen.getByRole("button", { name: "ใช้ Passkey / Security key 2 อันแทน" }));
    expect(screen.getByLabelText("โทเค็นลงทะเบียน")).toHaveValue("sample-enroll-token-123");
    await userEvent.clear(screen.getByLabelText("ชื่อ key"));
    await userEvent.type(screen.getByLabelText("ชื่อ key"), "YubiKey หลัก");
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียน Passkey" }));
    expect(await screen.findByText("ลงทะเบียนสำเร็จ · บัญชีนี้มี 1 Passkey")).toBeInTheDocument();
    expect(optionsBody).toEqual({ enrollToken: "sample-enroll-token-123", name: "YubiKey หลัก" });
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: regOptions });
    expect(verifyBody).toEqual({ challengeToken: "signed-reg-token", response: attestation, name: "YubiKey หลัก" });
    // S2: ต้องมีกุญแจ 2 อันก่อนใช้งาน · อันที่สองใช้โทเค็นเดิม
    expect(screen.queryByRole("link", { name: "ไปหน้าเข้าสู่ระบบ" })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("ชื่อ key"));
    await userEvent.type(screen.getByLabelText("ชื่อ key"), "YubiKey สำรอง");
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียนกุญแจอันที่สอง" }));
    expect(await screen.findByText("ลงทะเบียนครบ 2 อันแล้ว · เข้าสู่ระบบได้เลย")).toBeInTheDocument();
    expect(optionsBody).toEqual({ enrollToken: "sample-enroll-token-123", name: "YubiKey สำรอง" });
    expect(screen.getByRole("link", { name: "ไปหน้าเข้าสู่ระบบ" })).toHaveAttribute("href", "/login");
  });

  it("โทเค็นหมดอายุ: แสดง error ของ ops-api", async () => {
    server.use(http.post(`${OPS}/auth/register/options`, () => opsError(401, "enroll_token_invalid", "โทเค็นลงทะเบียนไม่ถูกต้องหรือหมดอายุ")));
    renderWithProviders(<EnrollPage token="expired-token-000" />);
    await userEvent.click(screen.getByRole("button", { name: "ใช้ Passkey / Security key 2 อันแทน" }));
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียน Passkey" }));
    expect(await screen.findByText("โทเค็นลงทะเบียนไม่ถูกต้องหรือหมดอายุ")).toBeInTheDocument();
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("เพิ่ม key สำรองขณะล็อกอิน: ไม่ส่ง enrollToken · key ซ้ำแจ้งว่าลงทะเบียนแล้ว", async () => {
    let optionsBody: unknown;
    server.use(
      http.post(`${OPS}/auth/register/options`, async ({ request }) => {
        optionsBody = await request.json();
        return HttpResponse.json({ options: regOptions, challengeToken: "signed-reg-token" });
      }),
    );
    vi.mocked(startRegistration).mockRejectedValue(Object.assign(new Error("exists"), { name: "InvalidStateError" }));
    renderWithProviders(<EnrollForm mode="session" />);
    expect(screen.queryByLabelText("โทเค็นลงทะเบียน")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียน Passkey" }));
    expect(await screen.findByText("Passkey / Security key นี้ลงทะเบียนไว้แล้ว")).toBeInTheDocument();
    expect(optionsBody).toEqual({ name: "Passkey" });
  });
});

describe("เมนูบัญชี › วิธีเข้าระบบ", () => {
  it("บัญชีที่มีแต่ Passkey: ลบอันสุดท้ายไม่ได้ · ตั้งรหัสผ่านจากเมนูได้", async () => {
    server.use(
      http.get(`${OPS}/auth/me`, () =>
        HttpResponse.json({ staff: staff.admin, methods: { totp: false, totpEnabledAt: null, keys: [{ id: "cred-1", name: "MacBook", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null }] } }),
      ),
      http.post(`${OPS}/auth/password/setup`, () => HttpResponse.json({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", email: "a@example.com", setupToken: "setup-token-1" })),
    );
    renderWithProviders(<LoginMethods />);
    expect(await screen.findByText("ยังไม่ได้ตั้ง · ตอนนี้เข้าได้เฉพาะเครื่องที่มี Passkey")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ลบ MacBook" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "ตั้งค่า" }));
    await userEvent.type(screen.getByLabelText("รหัสผ่านใหม่"), "Long-enough-pass-1");
    await userEvent.type(screen.getByLabelText("ยืนยันรหัสผ่าน"), "Long-enough-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    expect(await screen.findByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "บันทึก" })).toBeDisabled();
  });

  it("ตั้งรหัสผ่าน + แอปแล้ว: ลบ Passkey อันสุดท้ายได้", async () => {
    let deleted = "";
    server.use(
      http.get(`${OPS}/auth/me`, () =>
        HttpResponse.json({ staff: staff.admin, methods: { totp: true, totpEnabledAt: "2026-11-18T00:00:00Z", keys: [{ id: "cred-1", name: "MacBook", createdAt: "2026-11-01T00:00:00Z", lastUsedAt: null }] } }),
      ),
      http.delete(`${OPS}/auth/keys/:id`, ({ params }) => ((deleted = String(params.id)), HttpResponse.json({ keys: 0 }))),
    );
    renderWithProviders(<LoginMethods />);
    await userEvent.click(await screen.findByRole("button", { name: "ลบ MacBook" }));
    await waitFor(() => expect(deleted).toBe("cred-1"));
    expect(screen.getByRole("button", { name: "ตั้งใหม่" })).toBeInTheDocument();
  });
});
