import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mySessionId, openSessions, staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { Shell } from "./Shell";

const nav = () => within(screen.getByRole("complementary", { name: "เมนูหลังบ้าน" }));

describe("Shell หลังบ้าน", () => {
  it("Admin เห็นทุกเมนู พร้อมจำนวนรอตรวจการชำระเงิน", async () => {
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    expect(await screen.findByText("เนื้อหา")).toBeInTheDocument();
    for (const name of ["ภาพรวม", "ลูกค้า (Workspace)", "การเข้าช่วยเหลือ", "Feature flags + ประกาศ"]) expect(nav().getByRole("link", { name })).toBeInTheDocument();
    expect(await within(nav().getByRole("link", { name: /การชำระเงิน/ })).findByText("2")).toHaveClass("pill");
    expect(nav().getByRole("link", { name: "ภาพรวม" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("แอดมินตัวอย่าง · Admin")).toBeInTheDocument();
  });

  it("Support ไม่เห็นเมนูการชำระเงินและ Feature flags", async () => {
    asRole("support");
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    await screen.findByText("เนื้อหา");
    expect(nav().queryByRole("link", { name: /การชำระเงิน/ })).not.toBeInTheDocument();
    expect(nav().queryByRole("link", { name: "Feature flags + ประกาศ" })).not.toBeInTheDocument();
    expect(nav().getByRole("link", { name: "การเข้าช่วยเหลือ" })).toBeInTheDocument();
  });

  it("Finance เปิด /flags ตรง ๆ ได้หน้าไม่มีสิทธิ์ (ไม่ render เนื้อหา)", async () => {
    asRole("finance");
    navigation.pathname = "/flags";
    renderWithProviders(<Shell>เนื้อหาลับ</Shell>);
    expect(await screen.findByText("ไม่มีสิทธิ์เข้าหน้านี้")).toBeInTheDocument();
    expect(screen.getByText(/หน้านี้สำหรับบทบาท Admin/)).toBeInTheDocument();
    expect(screen.queryByText("เนื้อหาลับ")).not.toBeInTheDocument();
  });

  it("ไม่มี session (401) → ไปหน้า Login", async () => {
    server.use(http.get(`${OPS}/auth/me`, () => opsError(401, "unauthorized", "ต้องเข้าสู่ระบบด้วย Security key")));
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("เนื้อหา")).not.toBeInTheDocument();
  });

  it("โหลดข้อมูลพนักงานไม่ได้: Error พร้อมรหัสอ้างอิง", async () => {
    server.use(http.get(`${OPS}/auth/me`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req-me-500")));
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    expect(await screen.findByText("เกิดข้อผิดพลาดภายในระบบ")).toBeInTheDocument();
    expect(screen.getByText("รหัสอ้างอิง: req-me-500")).toBeInTheDocument();
  });

  it("มี support session ของตัวเองเปิดอยู่: แถบเตือนด้านบน และกดออกจากบัญชีลูกค้าได้", async () => {
    asRole("support");
    let ended = "";
    server.use(
      http.get(`${OPS}/support-sessions`, () => HttpResponse.json({ items: ended ? [] : openSessions(staff.support.id) })),
      http.post(`${OPS}/support-sessions/:id/end`, ({ params }) => {
        ended = String(params.id);
        return HttpResponse.json({ session: {} });
      }),
    );
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    expect(await screen.findByText("คุณกำลังเข้าใช้ในฐานะทีมช่วยเหลือ")).toBeInTheDocument();
    expect(screen.getByText(/ทีมตัวอย่าง · อ่านอย่างเดียว · Ticket #1001/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ออกจากบัญชีลูกค้า" }));
    await waitFor(() => expect(ended).toBe(mySessionId));
    await waitFor(() => expect(screen.queryByText("คุณกำลังเข้าใช้ในฐานะทีมช่วยเหลือ")).not.toBeInTheDocument());
  });

  it("ออกจากระบบ: เรียก logout แล้วกลับหน้า Login", async () => {
    let called = false;
    server.use(
      http.post(`${OPS}/auth/logout`, () => {
        called = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    await userEvent.click(await screen.findByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(called).toBe(true);
  });

  it("เพิ่ม key สำรองเปิด Dialog ลงทะเบียนโดยไม่ต้องใช้โทเค็น", async () => {
    renderWithProviders(<Shell>เนื้อหา</Shell>);
    await userEvent.click(await screen.findByRole("button", { name: "เพิ่ม Security key สำรอง" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "ลงทะเบียน Security key" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("โทเค็นลงทะเบียน")).not.toBeInTheDocument();
  });
});
