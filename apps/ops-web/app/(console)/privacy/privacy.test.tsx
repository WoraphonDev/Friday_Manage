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
    http.get(`${OPS}/privacy/requests`, () => HttpResponse.json({ items: [eraseReq, exportReq, doneReq] })),
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
    http.get(`${OPS}/privacy/pending-deletes`, () => HttpResponse.json({ items: [{ id: "w9", slug: "old-demo", name: "โอลด์เดโม", requestedAt: iso(-26), purgeAt: iso(4), requestedBy: "owner@old-demo.example.com" }] })),
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
    await userEvent.click(screen.getByRole("button", { name: "เสร็จแล้ว" }));
    expect(screen.getByText("DSR-0012")).toBeInTheDocument();
    expect(screen.getByText("โอลด์เดโม")).toBeInTheDocument();
    expect(screen.getByText("อีก 4 วัน")).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(body).toEqual({ confirm: "ลบข้อมูล", reason: "ผู้ขอยืนยันตัวตนแล้ว" });
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
