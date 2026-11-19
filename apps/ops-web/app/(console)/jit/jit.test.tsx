// O52 · ขอสิทธิ์ชั่วคราว · ข้อมูลสมมติเท่านั้น
import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { JitPage } from "./JitPage";

const min = 60_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const pending = { id: "r1", role: "finance", minutes: 60, ticketRef: "#1842", reason: "ลูกค้าแจ้งว่าโอนแล้วแต่ใบแจ้งหนี้ยังค้าง", createdAt: iso(-2 * min), expiresAt: iso(58 * min), staffId: "s1", staffName: "สมหญิง", staffRoles: ["support"] };
const active = { id: "e1", role: "auditor", kind: "approved", reason: "ตรวจสอบเอกสาร", ticketRef: null, startedAt: iso(-60 * min), endsAt: iso(125 * min), endedAt: null, staffId: "s2", staffName: "วิศวกร A", approvedBy: "แอดมินตัวอย่าง", endedBy: null, actions: 3 };
const glass = { ...active, id: "e2", role: "finance", kind: "break_glass", staffName: "แอดมินตัวอย่าง", approvedBy: null, endsAt: iso(-60 * min), endedAt: iso(-70 * min), endedBy: "แอดมินตัวอย่าง", actions: 0 };

function page(search = "", overview?: object) {
  navigation.pathname = "/jit";
  navigation.search = search;
  server.use(
    http.get(`${OPS}/jit`, () => HttpResponse.json(overview ?? { mine: { active: [], pending: [] }, pending: [pending], stats: { requested: 14, approved: 12, rejected: 2, waitMin: 6, active: 1 }, canApprove: true, singleApprover: false })),
    http.get(`${OPS}/jit/elevations`, ({ request }) => {
      const items = new URL(request.url).searchParams.get("tab") === "history" ? [glass] : [active];
      return HttpResponse.json({ items, total: items.length });
    }),
  );
  return renderWithProviders(
    <AppShell>
      <JitPage />
    </AppShell>,
  );
}

describe("ขอสิทธิ์ชั่วคราว", () => {
  it("Owner: ตัวเลข 30 วัน · คำขอรออนุมัติอยู่บนสุด · อนุมัติต้องแตะกุญแจ · ปฏิเสธพร้อมเหตุผล", async () => {
    asRole("admin");
    let reauthed = false;
    const sent: string[] = [];
    server.use(
      http.post(`${OPS}/approvals/r1/approve`, () => (reauthed ? (sent.push("approve"), HttpResponse.json({ ok: true })) : opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง"))),
      http.post(`${OPS}/approvals/r1/reject`, async ({ request }) => (sent.push(`reject:${((await request.json()) as { note?: string }).note}`), HttpResponse.json({ ok: true }))),
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    expect(await screen.findByText("เปิดอยู่ตอนนี้ 1 · 30 วัน: ขอ 14 · อนุมัติ 12 · ปฏิเสธ 2 · เฉลี่ยรออนุมัติ 6 นาที")).toBeInTheDocument();
    const row = await screen.findByRole("article", { name: "สมหญิง" });
    expect(within(row).getByText("สมหญิง (Support) ขอ การเงิน 1 ชม.")).toBeInTheDocument();
    expect(within(row).getByText(/Ticket #1842/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "อนุมัติ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(sent).toEqual(["approve"]));
    await userEvent.click(within(row).getByRole("button", { name: "ปฏิเสธ" }));
    const dlg = await screen.findByRole("dialog", { name: "ปฏิเสธคำขอของ สมหญิง" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ผู้ขอเห็น)"), "ให้การเงินดูแทน");
    await userEvent.click(within(dlg).getByRole("button", { name: "ปฏิเสธ" }));
    await waitFor(() => expect(sent).toEqual(["approve", "reject:ให้การเงินดูแทน"]));
  });

  it("ตารางเปิดอยู่ / ประวัติ: เหลือเวลา · ผู้อนุมัติ · สิทธิ์ฉุกเฉินของ Owner อยู่ตารางเดียวกัน · Owner ยกเลิกสิทธิ์ได้", async () => {
    asRole("admin");
    let ended = "";
    server.use(http.post(`${OPS}/staff/me/elevations/:id/end`, ({ params }) => ((ended = params.id as string), HttpResponse.json({ ended: true }))));
    page();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("เหลือ 2 ชม. 5 นาที")).toBeInTheDocument();
    expect(within(table).getByText("3 รายการใน Audit log")).toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "ยกเลิกสิทธิ์" }));
    await waitFor(() => expect(ended).toBe("e1"));
    await userEvent.click(screen.getByRole("tab", { name: /ประวัติ/ }));
    expect(await screen.findByText("สิทธิ์ฉุกเฉินของ Owner")).toBeInTheDocument();
    expect(screen.getByText("คืนโดย แอดมินตัวอย่าง")).toBeInTheDocument();
  });

  it("Support: กดขอสิทธิ์จากหน้าที่ไม่มีสิทธิ์ (?request=finance) · เลือกระยะเวลา · ผูก Ticket · ส่งให้ Owner", async () => {
    asRole("support");
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/jit/requests`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ pendingApproval: { id: "r9" } }, { status: 202 }))));
    page("request=finance", { mine: { active: [], pending: [] }, pending: [], stats: null, canApprove: false, singleApprover: false });
    expect(await screen.findByText("ของฉัน: ไม่มีสิทธิ์ที่เปิดอยู่")).toBeInTheDocument();
    const dlg = await screen.findByRole("dialog", { name: "ขอสิทธิ์ชั่วคราว" });
    expect(within(dlg).queryByRole("button", { name: "Owner" })).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "การเงิน" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(dlg).getByRole("button", { name: "4 ชม." }));
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ต้องดูใบแจ้งหนี้และสลิปของลูกค้า");
    await userEvent.type(within(dlg).getByLabelText("ผูกกับ Ticket (ไม่บังคับ)"), "#1842");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(body).toEqual({ role: "finance", minutes: 240, reason: "ต้องดูใบแจ้งหนี้และสลิปของลูกค้า", ticketRef: "#1842" }));
    expect(await screen.findByText("ส่งคำขอแล้ว · รอ Owner อนุมัติ")).toBeInTheDocument();
  });
});
