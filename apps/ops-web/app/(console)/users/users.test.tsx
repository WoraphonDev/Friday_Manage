import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { UsersPage } from "./UsersPage";

const U = "20000000-0000-4000-8000-000000000001";
const row = { id: U, email: "pm@siam-demo.example.com", displayName: "PM", locale: "th", yearFormat: "BE", timezone: "Asia/Bangkok", status: "locked", login: ["password"], mfaEnabled: true, lineBound: false, workspaces: 2, firstWorkspace: "สยามเดโม", lastSeenAt: null };
const detail = { ...row, emailVerifiedAt: "2026-03-01T00:00:00.000Z", createdAt: "2026-03-01T00:00:00.000Z", line: null, memberships: [{ id: "w1", slug: "siam-demo", name: "สยามเดโม", role: "admin", status: "active" }], sessions: [], tickets: [{ id: "t1", number: 515, subject: "ล็อกอินไม่ได้", status: "open" }] };
const page = (search = "") => {
  navigation.pathname = "/users";
  navigation.search = search;
  server.use(
    http.get(`${OPS}/users`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get("q") === "none" ? { items: [], total: 0 } : { items: [row], total: 1 })),
    http.get(`${OPS}/users/${U}`, () => HttpResponse.json(detail)),
  );
  return renderWithProviders(
    <AppShell>
      <UsersPage />
    </AppShell>,
  );
};
const reauth = () => {
  let ok = false;
  server.use(
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((ok = true), HttpResponse.json({ reauthed: true }))),
  );
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  return () => ok;
};

describe("ผู้ใช้ทั้งหมด", () => {
  it("ค้น · กรองสถานะ · กดแถวเปิดรายละเอียด", async () => {
    asRole("support");
    page();
    expect(await screen.findByText("สยามเดโม (+1)")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("ล็อก")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "pm@siam-demo.example.com" }));
    expect(router.replace).toHaveBeenCalledWith(`/users?id=${U}`);
    await userEvent.type(screen.getByLabelText("ค้นหาอีเมลหรือชื่อ"), "none");
    expect(await screen.findByText("ไม่พบผู้ใช้")).toBeInTheDocument();
  });

  it("ปลดล็อก (G5): ต้องมี Ticket และเหตุผล", async () => {
    asRole("support");
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/users/${U}/unlock`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ id: U, status: "unlocked" }))));
    page(`id=${U}`);
    const drawer = await screen.findByRole("dialog", { name: "pm@siam-demo.example.com" });
    expect(within(drawer).getByText("#515 · ล็อกอินไม่ได้")).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "ปลดล็อกบัญชี" }));
    const dlg = await screen.findByRole("dialog", { name: "ปลดล็อกบัญชี pm@siam-demo.example.com?" });
    await userEvent.type(within(dlg).getByLabelText("Ticket ที่เกี่ยวข้อง"), "#515");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ผู้ใช้ยืนยันตัวตนแล้ว");
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(body).toEqual({ reason: "ผู้ใช้ยืนยันตัวตนแล้ว", ticketNo: "#515" }));
  });

  it("รีเซ็ต 2FA (C10): หลักฐาน ≥ 2 ข้อ · แตะกุญแจ", async () => {
    asRole("support");
    const ok = reauth();
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/users/${U}/reset-2fa`, async ({ request }) => (ok() ? ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ id: U, mfaEnabled: false })) : opsError(401, "reauth_required", "แตะ Security key"))));
    page(`id=${U}`);
    const drawer = await screen.findByRole("dialog", { name: "pm@siam-demo.example.com" });
    await userEvent.click(within(drawer).getByRole("button", { name: "รีเซ็ต 2FA" }));
    const dlg = await screen.findByRole("dialog", { name: "รีเซ็ต 2FA ของ pm@siam-demo.example.com?" });
    await userEvent.click(within(dlg).getByLabelText("ตอบจากอีเมลของบัญชีนี้ใน Ticket"));
    await userEvent.type(within(dlg).getByLabelText("Ticket ที่เกี่ยวข้อง"), "#515");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "เปลี่ยนโทรศัพท์");
    expect(within(dlg).getByRole("button", { name: "รีเซ็ต 2FA" })).toBeDisabled();
    await userEvent.click(within(dlg).getByLabelText("Owner ของ Workspace ยืนยันใน Ticket"));
    await userEvent.click(within(dlg).getByRole("button", { name: "รีเซ็ต 2FA" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(body).toEqual({ ticketNo: "#515", reason: "เปลี่ยนโทรศัพท์", proofs: ["email_reply", "workspace_owner"] }));
  });

  it("ปิดบัญชี (C12): แสดงผลกระทบรายพื้นที่ · พิมพ์อีเมลยืนยัน · Owner คนเดียวได้ error จาก ops-api", async () => {
    asRole("support");
    reauth();
    server.use(http.post(`${OPS}/users/${U}/close`, () => opsError(409, "sole_owner", "ผู้ใช้นี้เป็น Owner คนเดียวของ Workspace · โอนความเป็นเจ้าของก่อน")));
    page(`id=${U}`);
    const drawer = await screen.findByRole("dialog", { name: "pm@siam-demo.example.com" });
    await userEvent.click(within(drawer).getByRole("button", { name: "ปิดบัญชีทั้งระบบ" }));
    const dlg = await screen.findByRole("dialog", { name: "ปิดบัญชี pm@siam-demo.example.com?" });
    expect(within(within(dlg).getByRole("table", { name: "ผลกระทบ" })).getByText("สยามเดโม")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("Ticket ที่เกี่ยวข้อง"), "#520");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "สแปมคำเชิญ");
    await userEvent.type(within(dlg).getByLabelText("พิมพ์อีเมลของบัญชีเพื่อยืนยัน"), "pm@siam-demo.example.com");
    await userEvent.click(within(dlg).getByRole("button", { name: "ปิดบัญชี" }));
    expect(await screen.findByText(/โอนความเป็นเจ้าของก่อน/)).toBeInTheDocument();
  });

  it("Owner อ่านได้แต่ไม่มีปุ่มทำรายการถ้าไม่มีบทบาท Support · การเงินเปิดไม่ได้", async () => {
    server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: { id: "o", email: "o@example.com", name: "Owner ล้วน", role: "admin", roles: ["owner"], elevated: [], effectiveRoles: ["owner"] } })));
    page(`id=${U}`);
    const drawer = await screen.findByRole("dialog", { name: "pm@siam-demo.example.com" });
    expect(within(drawer).queryByRole("button", { name: "ปลดล็อกบัญชี" })).not.toBeInTheDocument();
  });

  it("การเงินเปิดหน้าผู้ใช้ไม่ได้", async () => {
    asRole("finance");
    page();
    expect(await screen.findByText("บทบาท การเงิน ดูหน้านี้ไม่ได้")).toBeInTheDocument();
  });
});
