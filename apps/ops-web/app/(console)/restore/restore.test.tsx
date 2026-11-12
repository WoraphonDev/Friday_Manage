import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { RestorePage } from "./RestorePage";

// ข้อมูลสมมติเท่านั้น
const WS = "90000000-0000-4000-8000-000000000001";
const TK = "91000000-0000-4000-8000-000000000001";
const TK2 = "91000000-0000-4000-8000-000000000002";
const PW = "92000000-0000-4000-8000-000000000001";
const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset * day).toISOString();

const summary = { pendingWorkspaces: 3, pendingSoon: 1, restored30d: { total: 6, issue: 4, project: 1, file: 0, workspace: 1 }, purgeTonight: { issues: 41, projects: 2, runsAt: "04:30" }, backupDays: 35 };
const ticket: { id: string; number: number; subject: string; status: string; requesterEmail: string; requesterRole: string; eligible: boolean; reason: string | null } = { id: TK, number: 530, subject: "ลบงานผิดทั้ง Sprint", status: "open", requesterEmail: "ops@orbit.example.com", requesterRole: "admin", eligible: true, reason: null };
const memberTicket = { ...ticket, id: TK2, number: 531, subject: "ขอกู้งาน", requesterEmail: "dev@orbit.example.com", requesterRole: "member", eligible: false, reason: "ผู้แจ้งไม่ใช่ Owner / Admin ของ Workspace" };
const keys = Array.from({ length: 37 }, (_, i) => `DP-${39 + i}`);
const items = [
  { type: "issue", id: "i1", ids: keys.map((_, i) => `i${i + 1}`), count: 37, keys, projects: ["DP"], subtasks: 12, project: { key: "DP", name: "Payment Gateway v2" }, deletedBy: { name: "ดนัย", role: "admin" }, deletedAt: iso(-1), purgeAt: iso(29), daysLeft: 29 },
  { type: "project", id: "p1", ids: ["p1"], count: 1, project: { key: "MKT", name: "Marketing Site 2026" }, counts: { issues: 74, files: 24 }, keyTaken: true, deletedBy: { name: "ปิยะ", role: "owner" }, deletedAt: iso(-10), purgeAt: iso(20), daysLeft: 20 },
  { type: "issue", id: "i99", ids: ["i99"], count: 1, keys: ["OMA-77"], projects: ["OMA"], subtasks: 0, project: { key: "OMA", name: "Orbit Mobile App" }, deletedBy: { name: "ปิยะ", role: "owner" }, deletedAt: iso(-23), purgeAt: iso(7), daysLeft: 7 },
  { type: "file", id: "f1", ids: ["f1", "f2", "f3"], count: 3, sizeBytes: 214 * 1024 ** 2, folder: "Assets", project: { key: "WR", name: "Website Revamp" }, deletedBy: { name: "สมชาย", role: "member" }, deletedAt: iso(-28), purgeAt: iso(2), daysLeft: 2 },
];
const list = (tk = ticket) => ({ workspace: { id: WS, slug: "orbit", name: "Orbit Apps", deleted: false }, ticket: tk, trashDays: 30, counts: { all: 4, project: 1, issue: 2, file: 1 }, items });
const pendingWs = {
  id: PW, slug: "technova", name: "TechNova", members: 12, plan: "team_s", planStatus: "canceled", deletedAt: iso(-27), deletedBy: { name: "ผู้ใช้สมมติ", role: "owner" },
  purgeAfter: iso(3), daysLeft: 3, extendedDays: 14, extendLeft: 16, tickets: [{ id: TK, number: 529, subject: "ขอกู้คืน", status: "open" }], pendingApprovals: [],
};
const quiet = { ...pendingWs, id: "92000000-0000-4000-8000-000000000002", slug: "bangsue", name: "Bangsue Data", members: 41, plan: "team_l", purgeAfter: iso(15), daysLeft: 15, extendedDays: 0, tickets: [] };

const record = () => {
  const calls: { path: string; body: unknown }[] = [];
  const on = (path: string, res: () => Response) => http.post(`${OPS}${path}`, async ({ request }) => (calls.push({ path, body: await request.json().catch(() => null) }), res()));
  return { calls, on };
};

const page = (search = "", overrides: Parameters<typeof server.use> = []) => {
  navigation.pathname = "/restore";
  navigation.search = search;
  // ตัวที่ test ส่งมาก่อน: MSW ใช้ handler ตัวแรกที่ตรงในกลุ่มเดียวกัน
  server.use(
    ...overrides,
    http.get(`${OPS}/restore/summary`, () => HttpResponse.json(summary)),
    http.get(`${OPS}/restore/workspaces`, () => HttpResponse.json({ items: [pendingWs, quiet], extendLimitDays: 30 })),
    http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [{ id: WS, name: "Orbit Apps", slug: "orbit" }] })),
    http.get(`${OPS}/restore/tickets`, () => HttpResponse.json({ workspace: { id: WS, slug: "orbit", name: "Orbit Apps", deleted: false }, items: [ticket, memberTicket] })),
    http.get(`${OPS}/restore/trash`, ({ request }) => HttpResponse.json(list(new URL(request.url).searchParams.get("ticketId") === TK2 ? memberTicket : ticket))),
    http.get(`${OPS}/restore/history`, () => HttpResponse.json({ items: [] })),
  );
  return renderWithProviders(
    <AppShell>
      <RestorePage />
    </AppShell>,
  );
};

async function searchFor(ticketId = TK) {
  await userEvent.type(await screen.findByLabelText("Workspace *"), "orbit");
  await userEvent.click(await screen.findByRole("option", { name: "Orbit Apps" }));
  const select = await screen.findByLabelText("Ticket *");
  await waitFor(() => expect(select).not.toBeDisabled());
  await userEvent.selectOptions(select, ticketId);
  await userEvent.click(screen.getByRole("button", { name: "ค้นหา" }));
}

describe("กู้คืนข้อมูลลูกค้า (บอร์ด 21)", () => {
  it("การ์ดสรุป · ต้องเลือก Workspace + Ticket ก่อน · ตารางสรุปไม่มีชื่องาน · เหลือ ≤ 3 วันเป็นสีแดง · กรองชนิด", async () => {
    asRole("support");
    page();
    expect(await screen.findByText("41 งาน · 2 โปรเจกต์")).toBeInTheDocument();
    expect(screen.getByText("งาน 4 · โปรเจกต์ 1 · Workspace 1")).toBeInTheDocument();
    expect(screen.getByText("35 วัน")).toBeInTheDocument();
    expect(screen.getByText("เลือก Workspace และ Ticket ของลูกค้าก่อน")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ค้นหา" })).toBeDisabled();
    await searchFor();
    expect(await screen.findByText("อยู่ในถังขยะของ Orbit Apps")).toBeInTheDocument();
    expect(screen.getByText("ชุด 37 งาน")).toBeInTheDocument();
    expect(screen.getByText("DP-39 … DP-75 · Sub-task 12 · ชื่องานเห็นเมื่อเข้าบัญชีเพื่อช่วยเหลือ")).toBeInTheDocument();
    expect(screen.getByText("งาน 74 · ไฟล์ 24 · Key ซ้ำกับโปรเจกต์ปัจจุบัน")).toBeInTheDocument();
    expect(screen.getByText("3 ไฟล์ · 214 MB")).toBeInTheDocument();
    expect(screen.getByText("ดนัย · Admin")).toBeInTheDocument();
    const fileRow = screen.getByText("3 ไฟล์ · 214 MB").closest("tr")!;
    expect(within(fileRow).getByText(/./, { selector: ".pill.bad" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "โปรเจกต์" }));
    expect(screen.queryByText("ชุด 37 งาน")).not.toBeInTheDocument();
    expect(screen.getByText("MKT · Marketing Site 2026")).toBeInTheDocument();
    // Workspace ที่รอลบถาวรอยู่ต่อท้ายในแท็บแรก (ตามบอร์ด)
    expect(screen.getByText("TechNova")).toBeInTheDocument();
  });

  it("Ticket จากสมาชิกธรรมดา: แจ้งเหตุผลและปิดปุ่มกู้คืน", async () => {
    asRole("support");
    page();
    await searchFor(TK2);
    expect(await screen.findByText("กู้คืนไม่ได้จาก Ticket นี้")).toBeInTheDocument();
    expect(screen.getByText(/ผู้แจ้งไม่ใช่ Owner \/ Admin ของ Workspace/)).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /^กู้คืน/ }).filter((x) => x.closest("tbody") && x.closest("table")?.textContent?.includes("ชุด 37 งาน"))) expect(b).toBeDisabled();
  });

  it("Z6: กู้ทั้งชุดพร้อมเหตุผล แจ้งอีเมล และตอบ Ticket", async () => {
    asRole("support");
    const r = record();
    page("", [r.on("/restore", () => HttpResponse.json({ type: "issue", restored: 37, items: [], notified: 2, replied: true }))]);
    await searchFor();
    await userEvent.click(await screen.findByRole("button", { name: "กู้คืนทั้งชุด" }));
    const drawer = await screen.findByRole("dialog", { name: "กู้คืนให้ Orbit Apps" });
    expect(within(drawer).getByText("งาน 37 · Sub-task 12 · ไฟล์แนบ คอมเมนต์และประวัติ")).toBeInTheDocument();
    expect(within(drawer).getByText("Admin ของ Workspace")).toBeInTheDocument();
    const submit = within(drawer).getByRole("button", { name: "กู้คืน 37 งาน" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("เหตุผล (ลูกค้าเห็นใน Audit log) *"), "ลูกค้าแจ้งว่าลบทั้ง Sprint ผิด");
    await userEvent.click(within(drawer).getByLabelText("ตอบ Ticket #530 ว่ากู้คืนแล้วพร้อมรายการ"));
    await userEvent.click(submit);
    await waitFor(() => expect(r.calls).toHaveLength(1));
    expect(r.calls[0]!.body).toEqual({ workspaceId: WS, ticketId: TK, type: "issue", ids: keys.map((_, i) => `i${i + 1}`), reason: "ลูกค้าแจ้งว่าลบทั้ง Sprint ผิด", notify: true, replyTicket: false });
    expect(await screen.findByText("กู้คืนให้ Orbit Apps แล้ว")).toBeInTheDocument();
  });

  it("Z6 โปรเจกต์ Key ซ้ำ: ใส่ Key ที่ ops-api แนะนำเมื่อชน แล้วส่ง newKey", async () => {
    asRole("support");
    let n = 0;
    const r = record();
    page("", [r.on("/restore", () => (++n === 1 ? opsError(409, "key_taken", "Project Key นี้มีใน Workspace แล้ว", { key: "MKT2", suggestedKey: "MKT3" }) : HttpResponse.json({ type: "project", restored: 1, items: [], notified: 0, replied: false })))]);
    await searchFor();
    const row = (await screen.findByText("MKT · Marketing Site 2026")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "กู้คืน" }));
    const drawer = await screen.findByRole("dialog");
    const key = within(drawer).getByLabelText("Key ใหม่ *");
    expect(key).toHaveValue("MKT2");
    await userEvent.type(within(drawer).getByLabelText(/เหตุผล/), "Owner ขอโปรเจกต์คืน");
    await userEvent.click(within(drawer).getByRole("button", { name: "กู้คืนโปรเจกต์" }));
    expect(await within(drawer).findByText("Project Key นี้มีใน Workspace แล้ว")).toBeInTheDocument();
    expect(key).toHaveValue("MKT3");
    await userEvent.click(within(drawer).getByRole("button", { name: "กู้คืนโปรเจกต์" }));
    await waitFor(() => expect(r.calls).toHaveLength(2));
    expect(r.calls[1]!.body).toMatchObject({ type: "project", ids: ["p1"], newKey: "MKT3" });
  });

  it("Z9: ค้นเลขงานที่ลบถาวรแล้ว แสดงวันลบและขั้นตอนกู้จากสำรอง (ปุ่มเฟส 3 ปิดอยู่)", async () => {
    asRole("support");
    page("", [http.get(`${OPS}/restore/lookup`, () => HttpResponse.json({ q: "DP-12", kind: "issue", status: "purged", deletedAt: iso(-40), purgedAt: "2026-10-02T21:30:00.000Z", trashDays: 30, backupDays: 35 }))]);
    await searchFor();
    await userEvent.type(await screen.findByLabelText("ค้นด้วยเลขงาน / Key"), "dp-12");
    await userEvent.click(screen.getByRole("button", { name: "ตรวจ" }));
    expect(await screen.findByText(/DP-12 ถูกลบถาวรแล้วเมื่อ/)).toBeInTheDocument();
    expect(screen.getByText("เกินระยะถังขยะ 30 วัน · ไม่อยู่ในฐานข้อมูลแล้ว")).toBeInTheDocument();
    expect(screen.getByText(/สำรองข้อมูลย้อนหลังได้ 35 วัน/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ขอกู้จากสำรองข้อมูล (เฟส 3)" })).toBeDisabled();
  });

  it("Workspace ที่รอลบถาวร: ≤ 7 วันเป็นสีแดง · ไม่มี Ticket กู้คืนไม่ได้ · Z7 ยืดรวมเกิน 30 วันเปลี่ยนเป็นส่งขออนุมัติ", async () => {
    asRole("support");
    const r = record();
    page("tab=pending", [r.on(`/restore/workspaces/${PW}/extend`, () => HttpResponse.json({ workspaceId: PW, purgeAfter: iso(10), extendedDays: 21, notified: 1 }))]);
    const row = (await screen.findByText("TechNova")).closest("tr")!;
    expect(within(row).getByText("Team S (ยกเลิกแล้ว)")).toBeInTheDocument();
    expect(within(row).getByText(/อีก 3 วัน/).className).toContain("bad");
    expect(within(row).getByText("ยืดแล้ว 14 วัน")).toBeInTheDocument();
    const quietRow = screen.getByText("Bangsue Data").closest("tr")!;
    expect(within(quietRow).queryByRole("button", { name: "กู้คืน" })).not.toBeInTheDocument();
    expect(within(quietRow).getByRole("button", { name: "ยืดเวลา" })).toBeDisabled();

    await userEvent.click(within(row).getByRole("button", { name: "ยืดเวลา" }));
    const dlg = await screen.findByRole("dialog", { name: "ยืดเวลาก่อนลบถาวร · TechNova" });
    expect(within(dlg).getByText(/ยืดแล้ว 14 วัน/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "30 วัน" }));
    expect(within(dlg).getByText("ยืดรวม 44 วัน เกิน 30 วัน → ส่งขออนุมัติ (G7)")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "ส่งขออนุมัติ" })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "7 วัน" }));
    await userEvent.type(within(dlg).getByLabelText("เหตุผล *"), "Owner ขอเวลาส่งออกข้อมูล");
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืดเวลา" }));
    await waitFor(() => expect(r.calls).toHaveLength(1));
    expect(r.calls[0]!.body).toEqual({ days: 7, ticketId: TK, reason: "Owner ขอเวลาส่งออกข้อมูล", notify: true });
  });

  it("Z8: กู้ Workspace แทนลูกค้าส่งขออนุมัติพร้อมเหตุผล", async () => {
    asRole("support");
    const r = record();
    page("tab=pending", [
      http.get(`${OPS}/restore/tickets`, () => HttpResponse.json({ workspace: { id: PW, slug: "technova", name: "TechNova", deleted: true }, items: [{ ...ticket, number: 529, subject: "ขอกู้คืน", requesterEmail: "pm@technova.example.com", requesterRole: "owner" }] })),
      r.on(`/restore/workspaces/${PW}/restore`, () =>
        HttpResponse.json({ pendingApproval: { id: "a1", kind: "restore.workspace", status: "pending", reason: "Owner ยืนยันว่าลบผิด", amountSatang: null, payload: { rule: "กู้ Workspace แทนลูกค้าต้องอนุมัติทุกครั้ง" }, workspaceId: PW, expiresAt: iso(2), canSelfApprove: false } }, { status: 202 }),
      ),
    ]);
    const row = (await screen.findByText("TechNova")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "กู้คืน" }));
    const dlg = await screen.findByRole("dialog", { name: "กู้คืน Workspace TechNova แทนลูกค้า?" });
    expect(await within(dlg).findByText(/pm@technova.example.com/)).toBeInTheDocument();
    expect(within(dlg).getByText("สถานะ Free · ข้อมูลเกินแพ็กเกจเป็นอ่านอย่างเดียว · สมาชิกเข้าได้ทันที")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล *"), "Owner ยืนยันว่าลบผิด");
    await userEvent.click(within(dlg).getByRole("button", { name: /ส่งขออนุมัติ/ }));
    await waitFor(() => expect(r.calls).toHaveLength(1));
    expect(r.calls[0]!.body).toEqual({ ticketId: TK, reason: "Owner ยืนยันว่าลบผิด" });
    expect(await screen.findByText("กู้ Workspace แทนลูกค้าต้องอนุมัติทุกครั้ง")).toBeInTheDocument();
  });

  it("วิศวกรอ่านอย่างเดียว · การเงินไม่มีสิทธิ์ · Error แสดง requestId · เปลี่ยนแท็บด้วย URL", async () => {
    asRole("engineer");
    const { unmount } = page();
    expect(await screen.findByText("บทบาทของคุณดูได้อย่างเดียว · กู้คืนและยืดเวลาโดย Support หรือ Owner")).toBeInTheDocument();
    await searchFor();
    expect(await screen.findByText("ชุด 37 งาน")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "กู้คืนทั้งชุด" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ยืดเวลา" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "ประวัติการกู้คืน" }));
    expect(router.replace).toHaveBeenCalledWith("/restore?tab=history");
    unmount();

    asRole("finance");
    const f = page();
    expect(await screen.findByText("บทบาท การเงิน ดูหน้านี้ไม่ได้")).toBeInTheDocument();
    expect(screen.queryByText("41 งาน · 2 โปรเจกต์")).not.toBeInTheDocument();
    f.unmount();

    asRole("support");
    page("tab=history", [http.get(`${OPS}/restore/history`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req_9f2c"))]);
    expect(await screen.findByText(/req_9f2c/)).toBeInTheDocument();
  });
});
