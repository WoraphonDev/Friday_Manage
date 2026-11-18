import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { PrivacyPage } from "./PrivacyPage";

const R = "80000000-0000-4000-8000-000000000001";
const E = "80000000-0000-4000-8000-000000000002";
const B = "81000000-0000-4000-8000-000000000001";
const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset * day).toISOString();
const base = { userId: "u1", workspaceIds: [], details: null, receivedAt: iso(-24), completedAt: null, rejectionReason: null, approvalRequestId: null, overdue: false, workspaces: [] };
const exportReq = { ...base, id: R, number: 21, requestType: "export", requesterEmail: "pm@northwind.example.com", dueDate: iso(4).slice(0, 10), identity: "unverified", step: 1, status: "open", stepLabel: "รับคำขอ", daysLeft: 4 };
const eraseReq = {
  ...base,
  id: E,
  number: 19,
  requestType: "erase",
  requesterEmail: "former.dev@example.com",
  dueDate: iso(6).slice(0, 10),
  identity: "email_match",
  step: 3,
  status: "open",
  stepLabel: "ตรวจขอบเขต",
  daysLeft: 6,
  workspaces: [{ id: "w1", name: "ลูเมนสตูดิโอ", slug: "lumen" }],
};
const doneReq = {
  ...base,
  id: "r3",
  number: 12,
  requestType: "access",
  requesterEmail: "a@example.com",
  dueDate: iso(-10).slice(0, 10),
  identity: "link_confirmed",
  step: 5,
  status: "completed",
  stepLabel: "แจ้งผล",
  daysLeft: -10,
  receivedAt: iso(-20),
  completedAt: iso(-14),
};
const pd = { requestedAt: iso(-26), system: false, legalHold: false, unpaidInvoices: 0, purgeApproval: null, purgeApproved: false };
const pendingDeletes = [
  { ...pd, id: "w9", slug: "old-demo", name: "โอลด์เดโม", purgeAt: iso(4), daysLeft: 4, requestedBy: { name: "นที ส.", email: "owner@old-demo.example.com", role: "owner" } },
  { ...pd, id: "w8", slug: "held-demo", name: "เฮลด์เดโม", purgeAt: iso(10), daysLeft: 10, requestedBy: null, system: true, legalHold: true },
];
const hold = {
  id: "h1",
  workspaceId: "w8",
  scope: "workspace",
  userIds: [],
  userEmails: [],
  reason: "ข้อพิพาทการชำระเงิน",
  reference: "คดีสมมติ 1/2569",
  reviewOn: iso(80).slice(0, 10),
  notifyCustomer: false,
  createdAt: iso(-3),
  createdByName: "แอดมินตัวอย่าง",
  releasedAt: null,
  releaseReason: null,
  workspace: { id: "w8", name: "เฮลด์เดโม", slug: "held-demo" },
  active: true,
  releaseApproval: null,
};
const rrow = (key: string, label: string, days: number, min: number, max: number, enforced = true) => ({ key, label, enforced, note: enforced ? null : "ยังไม่มีงานลบอัตโนมัติ · ใช้เป็นนโยบายที่ประกาศ", days, defaultDays: days, min, max, pendingApproval: null });
const retention = {
  rows: [
    rrow("workspaceDataDays", "ข้อมูลงานของ Workspace ที่ยกเลิก", 90, 30, 365, false),
    rrow("trashDays", "ถังขยะ (งาน / ไฟล์ที่ลบ)", 30, 7, 90),
    rrow("systemLogDays", "Log ระบบ (IP, User agent)", 90, 30, 365),
    rrow("staffAuditDays", "Audit log ของทีม Friday", 730, 365, 3650, false),
  ],
  taxYears: 5,
  lastRun: { at: iso(-0.3), logRows: 12000, sessionRows: 430, systemLogDays: 90 },
};
const reauthHandlers = (onVerify: () => void) => [
  http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
  http.post(`${OPS}/auth/reauth/verify`, () => (onVerify(), HttpResponse.json({ reauthed: true }))),
];
const pendingApproval = (kind: string, rule: string) => HttpResponse.json({ pendingApproval: { id: "ap-9", kind, reason: "x", expiresAt: iso(1), amountSatang: null, payload: { rule }, canSelfApprove: false } }, { status: 202 });
const steps = (cur: number) => ["รับคำขอ", "ยืนยันตัวตน", "ตรวจขอบเขต", "ดำเนินการ", "แจ้งผล"].map((label, i) => ({ step: i + 1, label, done: cur > i + 1 }));
const scope = { memberships: [{ id: "w1", slug: "lumen", name: "ลูเมนสตูดิโอ", role: "member", status: "active", soleOwner: false }], soleOwner: [], invoicesKept: 0 };
const breach = {
  id: B,
  number: 3,
  discoveredAt: iso(-1),
  description: "ลิงก์ส่งออกข้อมูลถูกส่งผิดอีเมล (ข้อมูลสมมติ)",
  dataTypes: ["ชื่อ", "อีเมล"],
  affectedCount: 23,
  workspaceIds: ["w1"],
  risk: "medium",
  assessment: null,
  containment: "ปิดลิงก์แล้ว",
  containedAt: iso(-0.9),
  pdpcNotifiedAt: null,
  subjectsNotifiedAt: null,
  closedAt: null,
  pdpcDeadline: iso(2),
  mustNotifyPdpc: true,
  hoursLeft: 48,
  overdue: false,
};

const page = (search = "") => {
  navigation.pathname = "/privacy";
  navigation.search = search;
  server.use(
    http.get(`${OPS}/privacy/requests`, requestsRes([eraseReq, exportReq, doneReq])),
    http.get(`${OPS}/privacy/requests/${R}`, () => HttpResponse.json({ request: exportReq, steps: steps(1), history: [], scope, erasePlan: null })),
    http.get(`${OPS}/privacy/requests/${E}`, () =>
      HttpResponse.json({
        request: eraseReq,
        steps: steps(3),
        history: [{ at: iso(-20), action: "privacy.request_created", text: "รับคำขอ #19", staffName: "ซัพพอร์ตตัวอย่าง", approvedBy: null }],
        scope,
        erasePlan: { remove: ["บัญชีผู้ใช้ รูปโปรไฟล์"], anonymize: ["งานและคอมเมนต์: เปลี่ยนชื่อ"], keep: [], backupDays: 35, blockers: [] },
      }),
    ),
    http.get(`${OPS}/privacy/pending-deletes`, () => HttpResponse.json({ items: pendingDeletes, graceDays: 30 })),
    http.get(`${OPS}/privacy/legal-holds`, () => HttpResponse.json({ items: [hold] })),
    http.get(`${OPS}/privacy/retention`, () => HttpResponse.json(retention)),
    http.get(`${OPS}/privacy/breaches`, () => HttpResponse.json({ items: [breach] })),
    http.get(`${OPS}/privacy/breaches/${B}`, () => HttpResponse.json({ breach, workspaces: [{ id: "w1", slug: "lumen", name: "ลูเมนสตูดิโอ" }], log: [] })),
  );
  return renderWithProviders(
    <AppShell>
      <PrivacyPage />
    </AppShell>,
  );
};
const record = () => {
  const calls: { path: string; body: unknown }[] = [];
  const on = (method: "post" | "patch", path: string, res: () => Response = () => HttpResponse.json({ sent: true, request: { ...exportReq, id: "new", number: 25 }, forwardToOwner: false })) =>
    http[method](`${OPS}/${path}`, async ({ request }) => (calls.push({ path, body: await request.json().catch(() => null) }), res()));
  return { calls, on };
};


/** จำลอง ops-api › privacy/requests: กรองสถานะที่ server + ตัวเลขสรุป (ช่วง 1) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requestsRes = (all: any[]) => ({ request }: { request: Request }) => {
  const st = new URL(request.url).searchParams.get("status") ?? "open";
  const items = all.filter((r) => st === "all" || r.status === st);
  const open = all.filter((r) => r.status === "open");
  const done = all.filter((r) => r.status === "completed" && r.completedAt);
  const avgDays = done.length ? Math.round(done.reduce((n, r) => n + (Date.parse(r.completedAt) - Date.parse(r.receivedAt)) / 86_400_000, 0) / done.length) : null;
  const count = (x: string) => all.filter((r) => r.status === x).length;
  return HttpResponse.json({
    items,
    total: items.length,
    counts: { open: count("open"), completed: count("completed"), rejected: count("rejected"), all: all.length },
    stats: { open: open.length, dueSoon: open.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 7).length, overdue: open.filter((r) => r.daysLeft < 0).length, avgDays },
  });
};

describe("คำขอ PDPA", () => {
  it("สรุป · ตาราง · กรอง · ครบกำหนด · Workspace ที่รอลบ", async () => {
    asRole("support");
    page();
    expect(await screen.findByText("DSR-0019")).toBeInTheDocument();
    const stats = screen.getByText("ใกล้ครบกำหนด (≤ 7 วัน)").closest(".stat")!;
    expect(within(stats as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("6 วัน")).toBeInTheDocument();
    expect(screen.getByText("เหลือ 4 วัน")).toBeInTheDocument();
    expect(screen.queryByText("DSR-0012")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "DSR-0021" }));
    expect(router.replace).toHaveBeenCalledWith(`/privacy?request=${R}`);
    await userEvent.click(screen.getByRole("button", { name: /^เสร็จแล้ว/ }));
    expect(await screen.findByText("DSR-0012")).toBeInTheDocument();
    expect(screen.getByText("โอลด์เดโม")).toBeInTheDocument();
    expect(screen.getByText(/· อีก 4 วัน$/)).toBeInTheDocument();
    // Support อ่านได้ แต่ไม่เห็นปุ่มของ Owner
    expect(screen.queryByRole("button", { name: "ลบทันที" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ตั้ง Legal hold" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /แก้ระยะเก็บ/ })).not.toBeInTheDocument();
    // Support ไม่เห็นเหตุละเมิด (Owner / วิศวกร / ผู้ตรวจ)
    expect(screen.queryByText("ลิงก์ส่งออกข้อมูลถูกส่งผิดอีเมล (ข้อมูลสมมติ)")).not.toBeInTheDocument();
  });

  it("A3 บันทึกคำขอที่มาทางอีเมล", async () => {
    asRole("support");
    const { calls, on } = record();
    server.use(on("post", "privacy/requests"));
    page();
    await userEvent.click(await screen.findByRole("button", { name: "บันทึกคำขอที่มาทางอีเมล" }));
    const dlg = await screen.findByRole("dialog", { name: "บันทึกคำขอ PDPA" });
    await userEvent.type(within(dlg).getByLabelText("ผู้ขอ (อีเมล)"), "somchai@example.com");
    await userEvent.click(within(dlg).getByLabelText("อีเมลตรงกับบัญชี"));
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls[0]?.body).toMatchObject({ requestType: "export", requesterEmail: "somchai@example.com", identity: "email_match", workspaceIds: [], acknowledge: true }));
    expect(router.replace).toHaveBeenCalledWith("/privacy?request=new");
  });

  it("ยืนยันตัวตน → ขั้นถัดไป · ปฏิเสธ (A5)", async () => {
    asRole("support");
    const { calls, on } = record();
    server.use(on("post", `privacy/requests/${R}/verify`), on("post", `privacy/requests/${R}/reject`));
    page(`request=${R}`);
    const drawer = await screen.findByRole("dialog", { name: /DSR-0021/ });
    expect(within(drawer).getByRole("button", { name: "ดำเนินการขั้นถัดไป" })).toBeDisabled();
    await userEvent.click(within(drawer).getByRole("button", { name: "ยืนยันผ่านลิงก์แล้ว" }));
    await waitFor(() => expect(calls[0]).toEqual({ path: `privacy/requests/${R}/verify`, body: { method: "link_confirmed" } }));

    await userEvent.click(within(drawer).getByRole("button", { name: "ปฏิเสธพร้อมเหตุผล" }));
    const dlg = await screen.findByRole("dialog", { name: "ปฏิเสธขอสำเนา / ส่งออก?" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผลตามกฎหมาย"), "ไม่สามารถยืนยันตัวตนได้");
    await userEvent.type(within(dlg).getByLabelText("ข้อความถึงผู้ขอ"), "เราไม่สามารถยืนยันตัวตนของคุณได้");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่ง" }));
    await waitFor(() => expect(calls[1]?.body).toEqual({ legalBasis: "ไม่สามารถยืนยันตัวตนได้", message: "เราไม่สามารถยืนยันตัวตนของคุณได้" }));
  });

  it("A6 ลบตามคำขอ: พิมพ์ยืนยัน · แตะกุญแจ · ส่งให้คนที่สองอนุมัติ", async () => {
    asRole("support");
    let reauthed = false;
    let body: unknown = null;
    server.use(
      http.post(`${OPS}/privacy/requests/${E}/erase`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = await request.json();
        return HttpResponse.json(
          { pendingApproval: { id: "ap-1", kind: "privacy.erase", reason: "x", expiresAt: iso(1), amountSatang: null, payload: { rule: "ลบข้อมูลตามคำขอ PDPA ต้องมีคนที่สองอนุมัติเสมอ" }, canSelfApprove: false } },
          { status: 202 },
        );
      }),
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page(`request=${E}`);
    const drawer = await screen.findByRole("dialog", { name: /DSR-0019/ });
    expect(within(drawer).getByText("บัญชีผู้ใช้ รูปโปรไฟล์")).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "ลบตามคำขอ (ต้องมีคนที่สองอนุมัติ)" }));
    const dlg = await screen.findByRole("dialog", { name: "ลบข้อมูลของ former.dev@example.com" });
    const submit = within(dlg).getByRole("button", { name: "ส่งให้คนที่สองอนุมัติ" });
    await userEvent.type(within(dlg).getByLabelText(/พิมพ์ ลบข้อมูล/), "ลบข้อมูล");
    await userEvent.type(within(dlg).getByLabelText(/เหตุผล/), "ผู้ขอยืนยันตัวตนแล้ว");
    await userEvent.click(submit);
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(body).toEqual({ confirm: "ลบข้อมูล", reason: "ผู้ขอยืนยันตัวตนแล้ว" });
  });
});

describe("Legal hold · การเก็บข้อมูล · Workspace ที่รอลบ (H10–H13)", () => {
  it("H10 การ์ดที่รอลบแสดงข้อมูลจริง · Legal hold · นโยบาย · ตัวเลขสรุป", async () => {
    asRole("admin");
    page();
    const card = (await screen.findByRole("heading", { name: "Workspace ที่รอลบ" })).closest("section")!;
    expect(await within(card as HTMLElement).findByText("โอลด์เดโม")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("นที ส. (owner)")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("ระบบ")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("หยุดไว้ · Legal hold")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByRole("button", { name: "ดู Legal hold" })).toBeInTheDocument();
    // ลบทันทีเฉพาะแถวที่ไม่ติด hold
    expect(within(card as HTMLElement).getAllByRole("button", { name: "ลบทันที" })).toHaveLength(1);
    expect(within(card as HTMLElement).getByRole("link", { name: "ยืดเวลา" })).toHaveAttribute("href", "/restore?tab=pending");
    const holds = screen.getByRole("heading", { name: "Legal hold" }).closest("section")!;
    expect(within(holds as HTMLElement).getByText("ข้อพิพาทการชำระเงิน · คดีสมมติ 1/2569")).toBeInTheDocument();
    expect(within(holds as HTMLElement).getByText("ทั้ง Workspace")).toBeInTheDocument();
    const policy = screen.getByRole("heading", { name: "นโยบายการเก็บข้อมูล" }).closest("section")!;
    expect(within(policy as HTMLElement).getByText("2 ปี")).toBeInTheDocument();
    expect(within(policy as HTMLElement).getByText("ตามกฎหมาย แก้ไม่ได้")).toBeInTheDocument();
    expect(within(policy as HTMLElement).getAllByText("ยังไม่มีงานลบอัตโนมัติ · ใช้เป็นนโยบายที่ประกาศ")).toHaveLength(2);
    const kpi = screen.getByText("ข้อมูลที่ลบตามนโยบายเมื่อคืน").closest(".stat")!;
    expect(await within(kpi as HTMLElement).findByText("12,430 แถว")).toBeInTheDocument();
    expect(within(kpi as HTMLElement).getByText("Log ระบบเก่ากว่า 90 วัน")).toBeInTheDocument();
    expect(within(screen.getByText("Workspace รอลบ").closest(".stat") as HTMLElement).getByText("ลบคืนนี้ 0")).toBeInTheDocument();
  });

  it("H11 ตั้ง Legal hold เฉพาะผู้ใช้บางคน · แตะกุญแจ · ไม่แจ้งลูกค้าเป็นค่าเริ่มต้น", async () => {
    asRole("admin");
    let reauthed = false;
    let body: unknown = null;
    server.use(
      http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [{ id: "w1", name: "ลูเมนสตูดิโอ", slug: "lumen" }] })),
      http.post(`${OPS}/privacy/legal-holds`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = await request.json();
        return HttpResponse.json({ hold: { id: "h2" }, notified: 0, heldRequests: 1 });
      }),
      ...reauthHandlers(() => (reauthed = true)),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    await userEvent.click(await screen.findByRole("button", { name: "ตั้ง Legal hold" }));
    const drawer = await screen.findByRole("dialog", { name: "ตั้ง Legal hold" });
    await userEvent.type(within(drawer).getByLabelText("Workspace"), "lu");
    await userEvent.click(await within(drawer).findByRole("option", { name: "ลูเมนสตูดิโอ" }));
    await userEvent.click(within(drawer).getByLabelText(/เฉพาะผู้ใช้บางคน/));
    await userEvent.type(within(drawer).getByLabelText("อีเมลสมาชิก"), "dev@lumen.example.com{Enter}");
    expect(within(drawer).getByText("dev@lumen.example.com")).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("เลขอ้างอิง"), "หนังสือสมมติ 12");
    expect(within(drawer).getByLabelText(/แจ้งลูกค้า/)).not.toBeChecked();
    await userEvent.click(within(drawer).getByRole("button", { name: "ตั้ง Legal hold" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(body).toEqual({ workspaceId: "w1", scope: "users", userEmails: ["dev@lumen.example.com"], reason: "ข้อพิพาทการชำระเงิน", reference: "หนังสือสมมติ 12", notifyCustomer: false }));
  });

  it("H12 ลดระยะเก็บ: ประมาณจำนวนแถว → ส่งขออนุมัติ (202)", async () => {
    asRole("admin");
    let reauthed = false;
    let body: unknown = null;
    server.use(
      http.get(`${OPS}/privacy/retention/estimate`, ({ request }) => HttpResponse.json({ key: "systemLogDays", days: Number(new URL(request.url).searchParams.get("days")), rows: 1800000 })),
      http.put(`${OPS}/privacy/retention`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = await request.json();
        return pendingApproval("privacy.retention_shorten", "ลดระยะเก็บข้อมูลต้องมีคนที่สองอนุมัติ");
      }),
      ...reauthHandlers(() => (reauthed = true)),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    await userEvent.click(await screen.findByRole("button", { name: "แก้ระยะเก็บ Log ระบบ (IP, User agent)" }));
    const dlg = await screen.findByRole("dialog", { name: "แก้ระยะเก็บ · Log ระบบ (IP, User agent)" });
    const input = within(dlg).getByLabelText("เก็บนาน (วัน)");
    await userEvent.clear(input);
    await userEvent.type(input, "30");
    expect(await within(dlg).findByText(/คืนนี้ 04:00 จะลบข้อมูลที่เก่ากว่า 30 วัน ประมาณ 1,800,000 แถว/)).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText(/เหตุผล/), "ลดข้อมูลส่วนบุคคลตามผลตรวจ DPO");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งขออนุมัติ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(body).toEqual({ key: "systemLogDays", days: 30, reason: "ลดข้อมูลส่วนบุคคลตามผลตรวจ DPO" });
  });

  it("H13 ลบถาวรทันที: Ticket จาก Owner · พิมพ์ slug · ส่งให้คนที่สองอนุมัติ", async () => {
    asRole("admin");
    let reauthed = false;
    let body: unknown = null;
    server.use(
      http.get(`${OPS}/privacy/pending-deletes/w9`, () =>
        HttpResponse.json({
          workspace: { id: "w9", slug: "old-demo", name: "โอลด์เดโม", purgeAt: iso(4) },
          remove: { projects: 4, issues: 312, bytes: 1.2 * 1024 ** 3, members: 6 },
          keepYears: 5,
          tickets: [
            { id: "t1", number: 541, subject: "ขอให้ลบข้อมูลทันที (สมมติ)", status: "open", fromOwner: true },
            { id: "t2", number: 530, subject: "สอบถามทั่วไป", status: "open", fromOwner: false },
          ],
          checks: { legalHold: false, unpaidInvoices: 0 },
        }),
      ),
      http.post(`${OPS}/privacy/pending-deletes/w9/purge-now`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = await request.json();
        return pendingApproval("privacy.purge_now", "ลบถาวรทันทีต้องมีคนที่สองอนุมัติเสมอ");
      }),
      ...reauthHandlers(() => (reauthed = true)),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    await userEvent.click(await screen.findByRole("button", { name: "ลบทันที" }));
    const dlg = await screen.findByRole("dialog", { name: "ลบ โอลด์เดโม ถาวรทันที" });
    expect(await within(dlg).findByText("มี Ticket จาก Owner ขอให้ลบทันที")).toBeInTheDocument();
    expect(within(dlg).getByText(/โปรเจกต์ 4 · งาน 312 · ไฟล์ 1.2 GB · สมาชิก 6 คน/)).toBeInTheDocument();
    expect(within(dlg).getAllByRole("option")).toHaveLength(1);
    const submit = within(dlg).getByRole("button", { name: "ส่งขออนุมัติลบถาวร" });
    await userEvent.type(within(dlg).getByLabelText(/เหตุผล/), "Owner ขอทาง Ticket #541");
    await userEvent.type(within(dlg).getByLabelText(/พิมพ์ old-demo/), "old-dem");
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText(/พิมพ์ old-demo/), "o");
    await userEvent.click(submit);
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(body).toEqual({ ticketId: "t1", confirmSlug: "old-demo", reason: "Owner ขอทาง Ticket #541" });
  });

  it("คำขอลบของผู้ใช้ที่ติด Legal hold ขึ้น \"รอ Legal hold\" และปุ่มลบใช้ไม่ได้", async () => {
    asRole("support");
    const held = { ...eraseReq, legalHold: true };
    page(`request=${E}`);
    server.use(
      http.get(`${OPS}/privacy/requests`, requestsRes([held, exportReq])),
      http.get(`${OPS}/privacy/requests/${E}`, () =>
        HttpResponse.json({ request: held, steps: steps(3), history: [], scope, erasePlan: { remove: ["บัญชีผู้ใช้"], anonymize: [], keep: [], backupDays: 35, blockers: [{ code: "legal_hold", workspace: null }] } }),
      ),
    );
    const drawer = await screen.findByRole("dialog", { name: /DSR-0019/ });
    expect(await within(drawer).findByRole("button", { name: "ลบตามคำขอ (ต้องมีคนที่สองอนุมัติ)" })).toBeDisabled();
    expect(within(drawer).getAllByText("รอ Legal hold").length).toBeGreaterThan(0);
    expect(within(document.querySelector("table")!).getByText("รอ Legal hold")).toBeInTheDocument();
  });
});

describe("เหตุละเมิดข้อมูล", () => {
  it("วิศวกรเห็นเฉพาะเหตุละเมิด · แจ้งเหตุใหม่ (A4)", async () => {
    asRole("engineer");
    const { calls, on } = record();
    server.use(on("post", "privacy/breaches", () => HttpResponse.json({ ...breach, id: "nb", number: 4 })));
    page();
    expect(await screen.findByText("ลิงก์ส่งออกข้อมูลถูกส่งผิดอีเมล (ข้อมูลสมมติ)")).toBeInTheDocument();
    expect(screen.getByText("เหลือ 48 ชม.")).toBeInTheDocument();
    expect(screen.queryByText("คำขอจากเจ้าของข้อมูล")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "แจ้งเหตุละเมิดข้อมูล" }));
    const drawer = await screen.findByRole("dialog", { name: "เหตุละเมิดข้อมูลส่วนบุคคล" });
    expect(within(drawer).getByText(/ต้องแจ้ง สคส. ภายใน 72 ชม. นับจากรู้ · เหลือ 7[12]:/)).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("เกิดอะไรขึ้น"), "ส่งไฟล์รายชื่อผิดผู้รับ (สมมติ)");
    await userEvent.type(within(drawer).getByLabelText("ข้อมูลที่กระทบ"), "ชื่อ, อีเมล");
    await userEvent.click(within(drawer).getByRole("button", { name: "สูง" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls[0]?.body).toMatchObject({ description: "ส่งไฟล์รายชื่อผิดผู้รับ (สมมติ)", dataTypes: ["ชื่อ", "อีเมล"], risk: "high", workspaceIds: [] }));
    expect(router.replace).toHaveBeenCalledWith("/privacy?breach=nb");
  });

  it("Owner บันทึกการแจ้ง สคส. · ปิดเหตุได้เมื่อครบเงื่อนไข", async () => {
    asRole("admin");
    const { calls, on } = record();
    server.use(on("post", `privacy/breaches/${B}/pdpc-notified`));
    page(`breach=${B}`);
    const drawer = await screen.findByRole("dialog", { name: "เหตุละเมิดข้อมูล #3" });
    expect(within(drawer).getByRole("button", { name: "ปิดเหตุ" })).toBeDisabled();
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึกว่าแจ้ง สคส. แล้ว" }));
    const dlg = await screen.findByRole("dialog", { name: "แจ้ง สคส. แล้ว · เหตุ #3" });
    await userEvent.type(within(dlg).getByLabelText("ข้อความ / บันทึก"), "ส่งแบบฟอร์มออนไลน์แล้ว");
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(calls[0]).toEqual({ path: `privacy/breaches/${B}/pdpc-notified`, body: { note: "ส่งแบบฟอร์มออนไลน์แล้ว" } }));
  });

  it("Finance ไม่มีสิทธิ์", async () => {
    asRole("finance");
    page();
    expect(await screen.findByText(/ดูหน้านี้ไม่ได้/)).toBeInTheDocument();
  });
});
