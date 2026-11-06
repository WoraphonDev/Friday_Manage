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

const loginOptions = { challenge: "sample-challenge", rpId: "localhost", allowCredentials: [] };
const assertion = { id: "cred-1", rawId: "cred-1", type: "public-key", response: { clientDataJSON: "x", authenticatorData: "y", signature: "z" }, clientExtensionResults: {} };

describe("Login ด้วย Security key", () => {
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
    await userEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบด้วย Security key" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(optionsBody).toEqual({ email: "support@example.com" });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: loginOptions });
    expect(verifyBody).toEqual({ challengeToken: "signed-login-token", response: assertion });
  });

  it("ล็อกอินไม่ผ่าน: แสดงข้อความจาก ops-api พร้อมรหัสอ้างอิง", async () => {
    server.use(
      http.post(`${OPS}/auth/login/options`, () => HttpResponse.json({ options: loginOptions, challengeToken: "t".repeat(12) })),
      http.post(`${OPS}/auth/login/verify`, () => opsError(401, "login_failed", "เข้าสู่ระบบไม่สำเร็จ", undefined, "req-login-1")),
    );
    vi.mocked(startAuthentication).mockResolvedValue(assertion as never);
    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), "someone@example.com");
    await userEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบด้วย Security key" }));
    expect(await screen.findByText("เข้าสู่ระบบไม่สำเร็จ")).toBeInTheDocument();
    expect(screen.getByText("รหัสอ้างอิง: req-login-1")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
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
    await userEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบด้วย Security key" }));
    expect(await screen.findByText(/ยกเลิกหรือหมดเวลารอ Security key/)).toBeInTheDocument();
    expect(verify).not.toHaveBeenCalled();
  });

  it("อีเมลผิดรูปแบบไม่ส่งคำขอ · browser ไม่รองรับ WebAuthn ปิดปุ่ม", async () => {
    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("อีเมลพนักงาน"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "เข้าสู่ระบบด้วย Security key" }));
    expect(screen.getByText("กรอกอีเมลให้ถูกต้อง")).toBeInTheDocument();
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("browser ไม่รองรับ Security key", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    renderWithProviders(<LoginForm />);
    expect(await screen.findByText(/Browser นี้ไม่รองรับ Security key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "เข้าสู่ระบบด้วย Security key" })).toBeDisabled();
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
  });
});

describe("ลงทะเบียน Security key", () => {
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
        return HttpResponse.json({ registered: true, credentialId: "cred-new", keys: 1 });
      }),
    );
    vi.mocked(startRegistration).mockResolvedValue(attestation as never);
    renderWithProviders(<EnrollPage token="sample-enroll-token-123" />);
    expect(screen.getByLabelText("โทเค็นลงทะเบียน")).toHaveValue("sample-enroll-token-123");
    await userEvent.clear(screen.getByLabelText("ชื่อ key"));
    await userEvent.type(screen.getByLabelText("ชื่อ key"), "YubiKey หลัก");
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียน Security key" }));
    expect(await screen.findByText("ลงทะเบียนสำเร็จ · บัญชีนี้มี 1 key")).toBeInTheDocument();
    expect(optionsBody).toEqual({ enrollToken: "sample-enroll-token-123", name: "YubiKey หลัก" });
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: regOptions });
    expect(verifyBody).toEqual({ challengeToken: "signed-reg-token", response: attestation, name: "YubiKey หลัก" });
    expect(screen.getByRole("link", { name: "ไปหน้าเข้าสู่ระบบ" })).toHaveAttribute("href", "/login");
  });

  it("โทเค็นหมดอายุ: แสดง error ของ ops-api", async () => {
    server.use(http.post(`${OPS}/auth/register/options`, () => opsError(401, "enroll_token_invalid", "โทเค็นลงทะเบียนไม่ถูกต้องหรือหมดอายุ")));
    renderWithProviders(<EnrollPage token="expired-token-000" />);
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียน Security key" }));
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
    await userEvent.click(screen.getByRole("button", { name: "ลงทะเบียน Security key" }));
    expect(await screen.findByText("Security key นี้ลงทะเบียนไว้แล้ว")).toBeInTheDocument();
    expect(optionsBody).toEqual({ name: "Security key" });
  });
});
