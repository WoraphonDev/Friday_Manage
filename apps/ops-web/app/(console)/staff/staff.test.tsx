import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { StaffPage } from "./StaffPage";
import { DEFAULT_LIMITS, type StaffMember } from "./types";

const member = (over: Partial<StaffMember>): StaffMember => ({
  id: "s-1", email: "x@friday.example.com", name: "ตัวอย่าง", roles: ["support"], department: null, limits: DEFAULT_LIMITS, customLimits: null,
  status: "active", expiresAt: null, keys: [{ id: "k1", name: "YubiKey สีดำ", createdAt: "2026-03-02T03:00:00.000Z", lastUsedAt: new Date().toISOString() }, { id: "k2", name: "MacBook Touch ID", createdAt: "2026-03-05T03:00:00.000Z", lastUsedAt: null }],
  createdAt: "2026-03-01T03:00:00.000Z", elevations: [], ...over,
});
const team = [
  member({ id: staff.admin.id, email: staff.admin.email, name: staff.admin.name, roles: ["owner", "finance", "support"], department: "ผู้บริหาร" }),
  member({ id: "s-2", email: "support.b@friday.example.com", name: "Support B", roles: ["support"], department: "ปฏิบัติการ" }),
  member({ id: "s-3", email: "audit@office.example.com", name: "สำนักงานบัญชี", roles: ["auditor"], department: "ภายนอก", status: "invited", keys: [], expiresAt: "2027-02-09T16:59:59.000Z" }),
];
const page = () => {
  navigation.pathname = "/staff";
  server.use(http.get(`${OPS}/staff`, () => HttpResponse.json({ items: team, singleApprover: true })));
  return renderWithProviders(
    <AppShell>
      <StaffPage />
    </AppShell>,
  );
};
const reauthOk = () => {
  let reauthed = false;
  server.use(
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true, expiresInSeconds: 900 }))),
  );
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  return () => reauthed;
};

describe("หน้าพนักงาน (Owner)", () => {
  it("แถบเตือนผู้อนุมัติคนเดียว · หลายบทบาท · แผนก · กุญแจ · สถานะ", async () => {
    page();
    const table = (await screen.findByText("Support B")).closest("table")!;
    expect(screen.getByText("มีผู้อนุมัติคนเดียว (Owner)")).toBeInTheDocument();
    const owner = within(table).getByText(staff.admin.name).closest("tr")!;
    for (const r of ["Owner", "การเงิน", "Support"]) expect(within(owner).getByText(r)).toBeInTheDocument();
    const auditor = within(table).getByText("สำนักงานบัญชี").closest("tr")!;
    expect(within(auditor).getByText("ยังไม่ลงทะเบียน")).toBeInTheDocument();
    expect(within(auditor).getByText("รอลงทะเบียน")).toBeInTheDocument();
    expect(within(auditor).getByText(/หมดอายุ/)).toBeInTheDocument();
    expect(screen.getByText("ปฏิบัติการ · 1 คน")).toBeInTheDocument();
  });

  it("เพิ่ม Owner คนที่สอง (A1): เลือก Owner ไว้ · ต้องแตะกุญแจ · ได้ลิงก์ลงทะเบียน", async () => {
    const reauthed = reauthOk();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/staff`, async ({ request }) => {
        if (!reauthed()) return opsError(401, "reauth_required", "เพิ่มบทบาท Owner ต้องแตะ Security key อีกครั้ง");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ staff: { ...team[1], email: body.email }, enrollUrl: "http://localhost:3003/enroll?token=abc" }, { status: 201 });
      }),
    );
    page();
    await userEvent.click(await screen.findByRole("button", { name: "เพิ่ม Owner คนที่สอง" }));
    const drawer = await screen.findByRole("dialog", { name: "เชิญพนักงาน" });
    expect(within(drawer).getByRole("checkbox", { name: /Owner/ })).toBeChecked();
    expect(within(drawer).getByText("ต้องแตะกุญแจ")).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("อีเมลบริษัท"), "owner2@friday.example.com");
    await userEvent.type(within(drawer).getByLabelText("ชื่อที่แสดง"), "Owner สอง");
    await userEvent.click(within(drawer).getByRole("button", { name: "ส่งคำเชิญ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    expect(await screen.findByDisplayValue("http://localhost:3003/enroll?token=abc")).toBeInTheDocument();
    expect(body).toMatchObject({ email: "owner2@friday.example.com", name: "Owner สอง", roles: ["owner"] });
  });

  it("จัดการ (A2): ปรับวงเงินรายคนพร้อมเหตุผล · พักการใช้งานผ่าน G5", async () => {
    let patch: Record<string, unknown> = {};
    let status: Record<string, unknown> = {};
    server.use(
      http.patch(`${OPS}/staff/s-2`, async ({ request }) => ((patch = (await request.json()) as Record<string, unknown>), HttpResponse.json({ staff: team[1] }))),
      http.post(`${OPS}/staff/s-2/status`, async ({ request }) => ((status = (await request.json()) as Record<string, unknown>), HttpResponse.json({ staff: team[1] }))),
    );
    page();
    const row = (await screen.findByText("Support B")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "จัดการ" }));
    const drawer = await screen.findByRole("dialog", { name: "จัดการ Support B" });
    await userEvent.click(within(drawer).getByLabelText("ใช้ค่าเริ่มต้น"));
    const trial = within(drawer).getByLabelText("ขยายทดลองรวม (วัน)");
    await userEvent.clear(trial);
    await userEvent.type(trial, "45");
    await userEvent.type(within(drawer).getByLabelText("เหตุผลที่เปลี่ยน"), "ดูแลลูกค้า Enterprise");
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(patch).toMatchObject({ roles: ["support"], department: "ปฏิบัติการ", limits: { ...DEFAULT_LIMITS, trialDays: 45 }, reason: "ดูแลลูกค้า Enterprise" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "พักการใช้งานชั่วคราว (ลาพัก)" }));
    const confirm = await screen.findByRole("dialog", { name: "พักการใช้งาน Support B?" });
    await userEvent.type(within(confirm).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ลาพักร้อน 2 สัปดาห์");
    await userEvent.click(within(confirm).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(status).toEqual({ status: "suspended", reason: "ลาพักร้อน 2 สัปดาห์" }));
  });

  it("สิทธิ์ฉุกเฉิน (A12): เลือกบทบาทที่ไม่มี · เหตุผล ≥ 10 ตัว · แตะกุญแจ", async () => {
    const reauthed = reauthOk();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/staff/me/elevations`, async ({ request }) => {
        if (!reauthed()) return opsError(401, "reauth_required", "แตะ Security key");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ elevation: { id: "el-1" } }, { status: 201 });
      }),
    );
    page();
    await screen.findByText("Support B");
    await userEvent.click(screen.getAllByRole("button", { name: "เปิดสิทธิ์ฉุกเฉิน" })[0]);
    const dlg = await screen.findByRole("dialog", { name: /ให้ตัวเองชั่วคราว/ });
    // ตัวอย่าง Owner มีบทบาทอื่นครบแล้ว เหลือเปิดได้แค่ผู้ตรวจ
    expect(within(dlg).queryByRole("button", { name: "การเงิน" })).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "ผู้ตรวจ" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(dlg).getByRole("button", { name: "30 นาที" }));
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ระบบนำเข้าล่มนอกเวลา วิศวกรติดต่อไม่ได้");
    await userEvent.click(within(dlg).getByRole("button", { name: "เปิดสิทธิ์" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(body).toEqual({ role: "auditor", minutes: 30, reason: "ระบบนำเข้าล่มนอกเวลา วิศวกรติดต่อไม่ได้" }));
  });
});

describe("Audit log", () => {
  it("ผู้ตรวจ: อ่านได้ ไม่มีปุ่มจัดการ · กรองเฉพาะอนุมัติตัวเอง · ว่างเพราะตัวกรองล้างได้", async () => {
    asRole("auditor");
    const asked: string[] = [];
    server.use(
      http.get(`${OPS}/audit`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        asked.push(q.toString());
        if (q.get("selfApproved") === "true") return HttpResponse.json({ items: [] });
        return HttpResponse.json({ items: [{ id: "a1", staffId: staff.admin.id, staffName: staff.admin.name, roles: ["owner"], action: "approval.self_approved", targetType: "approval_request", targetId: null, workspaceId: null, reason: "workspace.discount", approvedBy: staff.admin.id, selfApproved: true, ip: null, createdAt: new Date().toISOString() }] });
      }),
    );
    navigation.search = "tab=audit";
    page();
    expect(await screen.findByText("approval.self_approved")).toBeInTheDocument();
    expect(screen.getByText("อนุมัติตัวเอง")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "เชิญพนักงาน" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: 'เฉพาะ "อนุมัติตัวเอง"' }));
    expect(await screen.findByText("ไม่มีรายการที่ตรงกับตัวกรอง")).toBeInTheDocument();
    expect(asked.at(-1)).toContain("selfApproved=true");
    await userEvent.click(screen.getByRole("button", { name: "ล้างตัวกรอง" }));
    expect(await screen.findByText("approval.self_approved")).toBeInTheDocument();
  });

  it("Support เปิด /staff ตรง ๆ ไม่ได้", async () => {
    asRole("support");
    page();
    expect(await screen.findByText("บทบาท Support ดูหน้านี้ไม่ได้")).toBeInTheDocument();
  });
});
