// O56 · สคริปต์ดูแลข้อมูล · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { ScriptsPage } from "./ScriptsPage";

const scripts = [
  { key: "revoke_stale_sessions", table: "user_sessions", columns: ["revoked_at"], undoable: true, fields: [{ key: "days", kind: "number", min: 7, max: 365 }], lastRunAt: null, runs30: 0 },
  { key: "shift_plan_dates", table: "issues", columns: ["plan_start", "plan_end"], undoable: true, fields: [{ key: "projectKey", kind: "project" }, { key: "days", kind: "number" }, { key: "createdOn", kind: "date", optional: true }], lastRunAt: "2026-11-12T03:00:00Z", runs30: 2 },
];
const base = { workspaceId: "w1", workspaceName: "Nordlight", workspaceSlug: "nordlight", params: { days: 30 }, ticketRef: "#1907", requestedById: "x", approvedBy: null, undoOf: null, total: 312, progress: 0, changed: 0, error: null, createdAt: new Date().toISOString(), hasChanges: false, dryResult: { count: 17, ms: 800, sample: [] } };
const pending = { ...base, id: "r1", scriptKey: "revoke_stale_sessions", status: "pending_approval", reason: "ลูกค้าขอให้ล้าง session เก่า", requestedBy: "วิศวกร A", approvalRequestId: "ap1" };
const running = { ...base, id: "r2", scriptKey: "shift_plan_dates", status: "running", reason: "นำเข้าผิดสัปดาห์", requestedBy: "วิศวกร B", approvedBy: "แอดมินตัวอย่าง", progress: 137, total: 214 };
const done = { ...base, id: "r3", scriptKey: "revoke_stale_sessions", status: "done", reason: "x", requestedBy: "วิศวกร A", approvedBy: "แอดมินตัวอย่าง", changed: 17, hasChanges: true };

function page() {
  navigation.pathname = "/scripts";
  navigation.search = "";
  server.use(
    http.get(`${OPS}/scripts`, () => HttpResponse.json({ scripts, runs30: 41, undone30: 1, todo: [pending, running], canApprove: true })),
    http.get(`${OPS}/scripts/runs`, () => HttpResponse.json({ items: [done], total: 1 })),
    http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [{ id: "w1", name: "Nordlight", slug: "nordlight" }] })),
  );
  return renderWithProviders(
    <AppShell>
      <ScriptsPage />
    </AppShell>,
  );
}

describe("สคริปต์ดูแลข้อมูล", () => {
  it("ขั้น 1: รออนุมัติและกำลังรันอยู่บนสุด · รายการสคริปต์บอกข้อมูลที่แตะและย้อนกลับได้ไหม", async () => {
    asRole("admin");
    page();
    expect(await screen.findByText("สคริปต์ 2 ตัว · รัน 30 วัน 41 ครั้ง · ย้อนกลับ 1")).toBeInTheDocument();
    const todo = await screen.findByRole("region", { name: "ต้องทำตอนนี้" });
    const p = within(todo).getByRole("article", { name: "ล้าง session ค้าง" });
    expect(within(p).getByText("ทดลองรันแล้ว: เปลี่ยน 17 แถว")).toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "อนุมัติ" })).toBeInTheDocument();
    expect(within(within(todo).getByRole("article", { name: "เลื่อนวันแผนของงานในโปรเจกต์" })).getByText("137 / 214")).toBeInTheDocument();
    expect(screen.getByText("งาน (วันแผน)")).toBeInTheDocument();
  });

  it("ขั้น 2: ทดลองรันก่อน · แก้ค่าหลังทดลองต้องทดลองใหม่ · ขออนุมัติพร้อมเหตุผล", async () => {
    asRole("engineer");
    const sent: unknown[] = [];
    server.use(
      http.post(`${OPS}/scripts/revoke_stale_sessions/dry-run`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ ...base, id: "d1", scriptKey: "revoke_stale_sessions", status: "dry_run", reason: null, requestedBy: "วิศวกรตัวอย่าง", approvalRequestId: null, dryResult: { count: 3, ms: 12, sample: [{ id: "s1", label: "owner@nordlight.example.com · Chrome", before: { revoked_at: null }, after: { revoked_at: "2026-11-20T02:00:00Z" } }] } }))),
      http.post(`${OPS}/scripts/runs/d1/request`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ id: "d1" }, { status: 202 }))),
    );
    page();
    await userEvent.click((await screen.findAllByRole("button", { name: "รัน" }))[0]);
    const drawer = await screen.findByRole("dialog", { name: "ล้าง session ค้าง" });
    await userEvent.type(within(drawer).getByLabelText("Workspace"), "nord");
    await userEvent.click(await within(drawer).findByRole("button", { name: "Nordlight · nordlight" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "ทดลองรัน" }));
    await waitFor(() => expect(sent[0]).toEqual({ workspaceId: "w1", params: { days: 30 } }));
    expect(await within(drawer).findByText("จะเปลี่ยน 3 แถว")).toBeInTheDocument();
    expect(within(drawer).getByText("owner@nordlight.example.com · Chrome")).toBeInTheDocument();
    const days = within(drawer).getByLabelText("จำนวนวัน");
    await userEvent.type(days, "0");
    expect(within(drawer).getByText("แก้ค่าหลังทดลองแล้ว · ทดลองรันใหม่ก่อนขออนุมัติ")).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "ขออนุมัติรันจริง" })).not.toBeInTheDocument();
    await userEvent.clear(days);
    await userEvent.type(days, "30");
    await userEvent.type(within(drawer).getByLabelText("เหตุผล (คนอนุมัติเห็น)"), "พนักงานลูกค้าลาออก 3 คน");
    await userEvent.click(within(drawer).getByRole("button", { name: "ขออนุมัติรันจริง" }));
    await waitFor(() => expect(sent[1]).toEqual({ reason: "พนักงานลูกค้าลาออก 3 คน" }));
  });

  it("ขั้น 3: ประวัติการรัน · ย้อนกลับต้องใส่เหตุผล", async () => {
    asRole("engineer");
    let body: unknown = null;
    server.use(http.post(`${OPS}/scripts/runs/r3/undo`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ id: "u1" }, { status: 202 }))));
    page();
    await userEvent.click(await screen.findByRole("tab", { name: "ประวัติการรัน" }));
    expect(await screen.findByText("สำเร็จ · 17 แถว")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
    const dlg = await screen.findByRole("dialog", { name: "ย้อนกลับ ล้าง session ค้าง" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ลูกค้ายังใช้เครื่องสาขาอยู่");
    await userEvent.click(within(dlg).getByRole("button", { name: "ย้อนกลับ" }));
    await waitFor(() => expect(body).toEqual({ reason: "ลูกค้ายังใช้เครื่องสาขาอยู่" }));
  });

  it("สคริปต์ที่ย้อนไม่ได้: ติดป้าย · ต้องพิมพ์ slug ของ Workspace ก่อนขออนุมัติ", async () => {
    asRole("engineer");
    const resend = { key: "resend_failed_invitations", table: "invitations", columns: ["token_hash", "expires_at", "email_status"], undoable: false, fields: [], lastRunAt: null, runs30: 0 };
    const sent: unknown[] = [];
    page();
    server.use(
      http.get(`${OPS}/scripts`, () => HttpResponse.json({ scripts: [resend], runs30: 0, undone30: 0, todo: [], canApprove: false })),
      http.post(`${OPS}/scripts/resend_failed_invitations/dry-run`, () => HttpResponse.json({ ...base, id: "d2", scriptKey: "resend_failed_invitations", params: {}, status: "dry_run", reason: null, requestedBy: "วิศวกรตัวอย่าง", approvalRequestId: null, dryResult: { count: 1, ms: 5, sample: [{ id: "i1", label: "new@nordlight.example.com · ส่งไม่ผ่าน 2026-11-19 10:00", before: { email_status: "failed" }, after: { email_status: "ส่งใหม่" } }] } })),
      http.post(`${OPS}/scripts/runs/d2/request`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ id: "d2" }, { status: 202 }))),
    );
    const row = (await screen.findByText("ส่งอีเมลคำเชิญที่ส่งไม่ผ่านซ้ำ")).closest("tr")!;
    expect(within(row).getByText("ไม่ได้")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "รัน" }));
    const drawer = await screen.findByRole("dialog", { name: "ส่งอีเมลคำเชิญที่ส่งไม่ผ่านซ้ำ" });
    await userEvent.type(within(drawer).getByLabelText("Workspace"), "nord");
    await userEvent.click(await within(drawer).findByRole("button", { name: "Nordlight · nordlight" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "ทดลองรัน" }));
    expect(await within(drawer).findByText("จะเปลี่ยน 1 แถว")).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("เหตุผล (คนอนุมัติเห็น)"), "SMTP ล่มเมื่อวาน ลูกค้าไม่ได้รับคำเชิญ");
    expect(within(drawer).getByRole("button", { name: "ขออนุมัติรันจริง" })).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("พิมพ์ nordlight เพื่อยืนยัน (ย้อนกลับไม่ได้)"), "nordlight");
    await userEvent.click(within(drawer).getByRole("button", { name: "ขออนุมัติรันจริง" }));
    await waitFor(() => expect(sent[0]).toEqual({ reason: "SMTP ล่มเมื่อวาน ลูกค้าไม่ได้รับคำเชิญ", confirmSlug: "nordlight" }));
  });
});
