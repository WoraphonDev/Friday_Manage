import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { CustomerDetail } from "./[id]/CustomerDetail";
import type { Overview, WsRow } from "./_parts/types";
import { WorkspacesList } from "./WorkspacesList";

const WS = "10000000-0000-4000-8000-00000000000a";
const row = (over: Partial<WsRow>): WsRow => ({
  id: WS, slug: "siam-demo", name: "สยามเดโม", status: "active", createdAt: "2026-03-14T03:00:00.000Z", plan: "team_m", subStatus: "active", cycle: "monthly",
  trialEndsAt: null, periodEnd: null, seats: 21, seatLimit: 25, projects: 14, active30: 18, lastActiveAt: new Date().toISOString(), storageBytes: 12 * 1024 ** 3,
  integrations: ["line", "webhook"], health: 86, mrr: 300_000, paymentState: "ok", ...over,
});
const overview = (over: Partial<Overview> = {}): Overview => ({
  id: WS, slug: "siam-demo", name: "สยามเดโม", status: "active", createdAt: "2026-03-14T03:00:00.000Z", dataRegion: "th", legalName: "บริษัท สยามเดโม จำกัด",
  subscription: { plan: "team_m", status: "active", cycle: "monthly", trialEndsAt: null, currentPeriodEnd: "2026-12-01T00:00:00.000Z", paymentMethod: "promptpay", discount: { percent: 20, months: 4 }, seatLimit: 25 },
  usage: { members: 21, guests: 4, projects: 14, issues: 320, storageBytes: 1024, active30: 18, lastActiveAt: new Date().toISOString() },
  owners: [{ id: "u-own", email: "owner@siam-demo.example.com", displayName: "Owner", role: "owner" }],
  supportAccess: { until: "2026-12-31T00:00:00.000Z", maxMode: "write", notifyAdmins: true, active: true },
  supportSessions: [], invoices: [],
  health: { score: 86, parts: { usage: 72, payment: 100, support: 80, growth: 60 } },
  integrations: ["line"], topFeatures: ["gantt"], unusedFeatures: ["automation"],
  acquisition: { source: "google", medium: "cpc", campaign: null, referrerHost: null, via: "signup" },
  economics: { mrrSatang: 300_000, revenueSatang: 300_000, costSatang: 54_500, grossSatang: 245_500, marginPct: 82, costs: { lineMessages: { satang: 4000 }, infraShare: { satang: 50_000 } } },
  upgradeSignals: [{ code: "seats_near_limit", message: "ที่นั่ง 21 / 25 (84%)" }], notes: [], ...over,
});
const members = { seats: 21, items: [
  { id: "u-own", email: "owner@siam-demo.example.com", displayName: "Owner", role: "owner", jobTitle: null, status: "active", lastActiveAt: null, joinedAt: "2026-03-14T03:00:00.000Z", login: ["password"], mfaEnabled: true, locked: false, disabled: false },
  { id: "u-pm", email: "pm@siam-demo.example.com", displayName: "PM", role: "admin", jobTitle: "PM", status: "active", lastActiveAt: null, joinedAt: "2026-03-14T03:00:00.000Z", login: ["google"], mfaEnabled: false, locked: false, disabled: false },
], invitations: [], inviteLinks: { active: 0, nextExpiry: null } };

const list = (handler?: (u: URL) => unknown) =>
  server.use(http.get(`${OPS}/workspaces`, ({ request }) => HttpResponse.json(handler?.(new URL(request.url)) ?? { items: [row({}), row({ id: "w2", slug: "orbit-labs", name: "Orbit Labs", plan: "team_s", subStatus: "trialing", health: 35, mrr: 0, integrations: [] })], total: 2, limit: 50, offset: 0, sort: "recent_activity" })));
const shell = (ui: React.ReactElement, path: string) => {
  navigation.pathname = path;
  return renderWithProviders(<AppShell>{ui}</AppShell>);
};

describe("รายชื่อ Workspace", () => {
  it("ตาราง · ตัวกรองแพ็กเกจ / ฟีเจอร์ / เรียง ส่งไปที่ ops-api · การเงินเห็น MRR", async () => {
    const asked: URLSearchParams[] = [];
    list((u) => (asked.push(u.searchParams), undefined));
    shell(<WorkspacesList />, "/workspaces");
    const table = (await screen.findByText("สยามเดโม")).closest("table")!;
    expect(within(table).getByRole("columnheader", { name: "MRR" })).toBeInTheDocument();
    expect(within(table).getByText("฿3,000")).toBeInTheDocument();
    expect(within(table).getAllByText("21 / 25")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Team M" }));
    await userEvent.click(screen.getByRole("button", { name: "LINE OA" }));
    await userEvent.selectOptions(screen.getByLabelText("เรียงตาม"), "health");
    await waitFor(() => expect(asked.at(-1)?.toString()).toContain("sort=health"));
    expect(asked.at(-1)?.get("plan")).toBe("team_m");
    expect(asked.at(-1)?.get("feature")).toBe("line");
  });

  it("Support ไม่เห็นคอลัมน์ MRR และเรียงตาม MRR ไม่ได้ · ว่างเพราะตัวกรองล้างได้", async () => {
    asRole("support");
    list((u) => (u.searchParams.get("q") ? { items: [], total: 0, limit: 50, offset: 0, sort: "newest" } : undefined));
    shell(<WorkspacesList />, "/workspaces");
    const table = (await screen.findByText("สยามเดโม")).closest("table")!;
    expect(within(table).queryByRole("columnheader", { name: "MRR" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("เรียงตาม")).queryByRole("option", { name: "MRR มากสุด" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("ค้นหา Workspace (ชื่อหรือ slug)"), "zz");
    expect(await screen.findByText("ไม่มี Workspace ที่ตรงกับตัวกรอง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ล้างตัวกรอง" }));
    expect(await screen.findByText("สยามเดโม")).toBeInTheDocument();
  });

  it("เลือกหลายแถว → ขยายทดลองใช้ทุกราย (เรียกทีละราย) · โหลดไม่ได้แสดง requestId", async () => {
    const called: string[] = [];
    list();
    server.use(http.post(`${OPS}/workspaces/:id/extend-trial`, ({ params }) => (called.push(String(params.id)), HttpResponse.json({ trialEndsAt: "2026-12-01" }))));
    shell(<WorkspacesList />, "/workspaces");
    await userEvent.click(await screen.findByLabelText("เลือก สยามเดโม"));
    await userEvent.click(screen.getByLabelText("เลือก Orbit Labs"));
    expect(screen.getByText("เลือก 2 Workspace")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ขยายทดลองใช้" }));
    const dlg = await screen.findByRole("dialog", { name: "ขยายทดลองใช้ 2 Workspace" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "รอฝ่ายจัดซื้ออนุมัติ PO");
    await userEvent.click(within(dlg).getByRole("button", { name: "ขยายทดลองใช้" }));
    await waitFor(() => expect(called.sort()).toEqual([WS, "w2"].sort()));
    expect(await screen.findByText("ทำรายการแล้ว 2 ราย · ต้องอนุมัติ 0 · ไม่สำเร็จ 0")).toBeInTheDocument();
  });

  it("ops-api ล้ม: แสดง requestId", async () => {
    server.use(http.get(`${OPS}/workspaces`, () => opsError(500, "internal_error", "ระบบขัดข้อง", undefined, "req-ws-500")));
    shell(<WorkspacesList />, "/workspaces");
    expect(await screen.findByText(/req-ws-500/)).toBeInTheDocument();
  });
});

const detail = (ws = overview()) =>
  server.use(
    http.get(`${OPS}/workspaces/${WS}`, () => HttpResponse.json(ws)),
    http.get(`${OPS}/workspaces/${WS}/members`, () => HttpResponse.json(members)),
  );

describe("รายละเอียดลูกค้า", () => {
  it("หัวหน้า: แพ็กเกจ สุขภาพ เจ้าของ · ปุ่มตามบทบาท · การ์ดกำไรและสัญญาณ · แท็บโหลดแยกส่วน", async () => {
    detail();
    server.use(http.get(`${OPS}/workspaces/${WS}/usage`, () => opsError(500, "internal_error", "ล้ม", undefined, "req-usage")));
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    expect(await screen.findByRole("heading", { name: "สยามเดโม" })).toBeInTheDocument();
    expect(screen.getByText("สุขภาพ 86")).toBeInTheDocument();
    expect(screen.getByText(/owner@siam-demo.example.com/)).toBeInTheDocument();
    for (const name of ["เข้าบัญชีเพื่อช่วยเหลือ", "ให้ส่วนลด / คูปอง", "เปลี่ยนแพ็กเกจ", "ระงับ"]) expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();
    expect(screen.getByText("ที่นั่ง 21 / 25 (84%)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "การใช้งาน" }));
    expect(await screen.findByText(/req-usage/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "สยามเดโม" })).toBeInTheDocument();
  });

  it("Support: ไม่มีปุ่มเงิน · ไม่เห็นการ์ดกำไร · เข้าบัญชี (C1) ด้วย Ticket ในระบบ โหมดแก้ไขยังไม่เปิด", async () => {
    asRole("support");
    detail(overview({ economics: null }));
    let body: Record<string, unknown> = {};
    server.use(
      http.get(`${OPS}/tickets`, () => HttpResponse.json({ items: [{ id: "tk-1", number: 512, subject: "นำเข้า Excel แล้ววันที่เลื่อน" }] })),
      http.post(`${OPS}/workspaces/${WS}/support-sessions`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ session: {}, notified: 2 }, { status: 201 }))),
    );
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await screen.findByRole("heading", { name: "สยามเดโม" });
    expect(screen.queryByRole("button", { name: /ให้ส่วนลด/ })).not.toBeInTheDocument();
    expect(screen.queryByText("กำไรจากลูกค้ารายนี้")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /เข้าบัญชีเพื่อช่วยเหลือ/ }));
    const dlg = await screen.findByRole("dialog", { name: "เข้าบัญชี สยามเดโม" });
    expect(within(dlg).getByText("ยังไม่เปิด")).toBeInTheDocument();
    await userEvent.selectOptions(await within(dlg).findByLabelText("Ticket"), "tk-1");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ลูกค้าเห็นใน Audit log)"), "ตรวจไฟล์นำเข้าที่ลูกค้าแจ้ง");
    // ระยะเวลา: ค่าเริ่มต้น 1 ชม. · เลือก 30 นาที
    expect(within(dlg).getByRole("button", { name: "1 ชั่วโมง" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(dlg).getByRole("button", { name: "30 นาที" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "เข้าบัญชี" }));
    await waitFor(() => expect(body).toEqual({ ticketId: "tk-1", reason: "ตรวจไฟล์นำเข้าที่ลูกค้าแจ้ง", mode: "read", durationMinutes: 30 }));
    expect(await screen.findByText("เข้าบัญชีแล้ว · แจ้งลูกค้า 2 อีเมล")).toBeInTheDocument();
  });

  it("ลูกค้ายังไม่เปิดสิทธิ์ → ขอสิทธิ์จากลูกค้า (C2)", async () => {
    asRole("support");
    detail(overview({ supportAccess: null }));
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/workspaces/${WS}/support-access-request`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ sent: 1, owners: 1 }))));
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.click(await screen.findByRole("button", { name: /เข้าบัญชีเพื่อช่วยเหลือ/ }));
    const dlg = await screen.findByRole("dialog", { name: "ขอสิทธิ์เข้าบัญชี สยามเดโม" });
    await userEvent.type(within(dlg).getByLabelText("Ticket"), "#509");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ลูกค้าเห็นในอีเมล)"), "ตรวจ Webhook ที่ไม่ส่งเข้า Discord");
    expect(within(dlg).getByText(/ทีม Friday ขอเข้าดูบัญชี สยามเดโม/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(body).toEqual({ ticketNo: "#509", hours: 1, reason: "ตรวจ Webhook ที่ไม่ส่งเข้า Discord" }));
  });

  it("ส่วนลดเกินวงเงิน (C3) → 202 → แสดงส่งขออนุมัติ (G7)", async () => {
    asRole("finance");
    detail();
    server.use(http.post(`${OPS}/workspaces/${WS}/discount`, () => HttpResponse.json({ pendingApproval: { id: "ap-1", kind: "workspace.discount", reason: "x", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), amountSatang: null, payload: { rule: "ส่วนลดเกิน 30% หรือเกิน 12 รอบ" }, canSelfApprove: false } }, { status: 202 })));
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.click(await screen.findByRole("button", { name: "ให้ส่วนลด / คูปอง" }));
    const dlg = await screen.findByRole("dialog", { name: "ให้ส่วนลดกับ สยามเดโม" });
    const pct = within(dlg).getByLabelText("ส่วนลด (%)");
    await userEvent.clear(pct);
    await userEvent.type(pct, "40");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ต่อสัญญารายปี");
    await userEvent.click(within(dlg).getByRole("button", { name: "ให้ส่วนลด" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(screen.getByText("ส่วนลดเกิน 30% หรือเกิน 12 รอบ")).toBeInTheDocument();
  });

  it("เปลี่ยนแพ็กเกจ (C4): ตัวอย่างยอด · ที่นั่งเกินเลือกไม่ได้", async () => {
    asRole("finance");
    detail();
    server.use(
      http.get(`${OPS}/workspaces/${WS}/change-plan/preview`, ({ request }) => {
        const plan = new URL(request.url).searchParams.get("plan");
        if (plan === "team_s") return HttpResponse.json({ current: {}, next: {}, seatsInUse: 21, blocked: { code: "seats_exceed_plan", message: "ใช้อยู่ 21 คน เกินที่นั่งของ team_s (10)" }, contract: false, effective: "next_cycle", lines: [], subtotalSatang: 0, vatSatang: 0, totalSatang: 0 });
        return HttpResponse.json({ current: {}, next: {}, seatsInUse: 21, blocked: null, contract: false, effective: "now", lines: [{ label: "team_l 21 วันที่เหลือของรอบนี้", satang: 175_000 }], subtotalSatang: 175_000, vatSatang: 12_250, totalSatang: 187_250 });
      }),
    );
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.click(await screen.findByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    const dlg = await screen.findByRole("dialog", { name: "เปลี่ยนแพ็กเกจ สยามเดโม" });
    expect(await within(dlg).findByText("฿1,873")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Team S" }));
    expect(await within(dlg).findByText(/เกินที่นั่งของ team_s/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "เปลี่ยนแพ็กเกจ" })).toBeDisabled();
  });

  it("เปลี่ยนแพ็กเกจ (C4): อัปเกรดออกใบแจ้งหนี้ส่วนต่าง · ลดแพ็กเกจตั้งไว้รอบถัดไป", async () => {
    asRole("finance");
    detail();
    const pv = (effective: string, total: number) => ({ current: {}, next: {}, seatsInUse: 3, blocked: null, contract: false, effective, lines: total ? [{ label: "team_l 21 วันที่เหลือของรอบนี้", satang: total }] : [], subtotalSatang: total, vatSatang: 0, totalSatang: total });
    server.use(
      http.get(`${OPS}/workspaces/${WS}/change-plan/preview`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get("plan") === "team_s" ? pv("next_cycle", 0) : pv("now", 175_000))),
      http.post(`${OPS}/workspaces/${WS}/change-plan`, async ({ request }) => {
        const b = (await request.json()) as { plan: string };
        return HttpResponse.json(
          b.plan === "team_s"
            ? { plan: "team_s", effective: "next_cycle", effectiveAt: "2026-12-01T00:00:00+07:00", invoice: null, warnings: [] }
            : { plan: "team_l", effective: "now", invoice: { id: "i1", number: "FRI-2611-0042", amountDue: 175_000 }, warnings: [] },
        );
      }),
    );
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.click(await screen.findByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    let dlg = await screen.findByRole("dialog", { name: "เปลี่ยนแพ็กเกจ สยามเดโม" });
    expect(await within(dlg).findByText(/ออกใบแจ้งหนี้ส่วนต่าง/)).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ลูกค้าขอทาง Ticket");
    await userEvent.click(within(dlg).getByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    expect(await screen.findByText(/ออกใบแจ้งหนี้ FRI-2611-0042 ยอด ฿1,750/)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    dlg = await screen.findByRole("dialog", { name: "เปลี่ยนแพ็กเกจ สยามเดโม" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Team S" }));
    expect(await within(dlg).findByText(/มีผลเมื่อจบรอบบิลปัจจุบันเสมอ/)).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ทีมเล็กลง");
    await userEvent.click(within(dlg).getByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    expect(await screen.findByText(/ตั้งให้ลดเป็น Team S เมื่อจบรอบ/)).toBeInTheDocument();
  });

  it("ระงับ (C6): ต้องพิมพ์ slug · ยกเลิกระงับผ่าน G5", async () => {
    let body: Record<string, unknown> = {};
    detail();
    server.use(http.post(`${OPS}/workspaces/${WS}/suspend`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ id: WS, status: "suspended" }))));
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.click(await screen.findByRole("button", { name: "ระงับ" }));
    const dlg = await screen.findByRole("dialog", { name: "ระงับ สยามเดโม?" });
    await userEvent.type(within(dlg).getByLabelText("สาเหตุ"), "ผิดข้อตกลงการใช้งาน");
    // แบบปิดทั้งหมด + แก้ข้อความถึงลูกค้า + เปิดเองเมื่อชำระ
    await userEvent.click(within(dlg).getByRole("radio", { name: /ปิดทั้งหมด/ }));
    const msg = within(dlg).getByLabelText("ข้อความถึงลูกค้า");
    await userEvent.clear(msg);
    await userEvent.type(msg, "ผิดข้อตกลง ติดต่อทีม Friday");
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "ยกเลิกระงับเองเมื่อชำระเงินเข้า" }));
    const go = within(dlg).getByRole("button", { name: "ระงับ" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("พิมพ์ siam-demo เพื่อยืนยัน"), "siam-demo");
    await userEvent.click(go);
    await waitFor(() => expect(body).toEqual({ reason: "ผิดข้อตกลงการใช้งาน", mode: "full", message: "ผิดข้อตกลง ติดต่อทีม Friday", autoResume: true }));
  });

  it("โอนความเป็นเจ้าของ (C7): หลักฐานครบ · แตะกุญแจ · ส่งให้คนที่สองอนุมัติ", async () => {
    detail();
    let body: Record<string, unknown> = {};
    let reauthed = false;
    server.use(
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
      http.post(`${OPS}/workspaces/${WS}/transfer-owner`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "แตะ Security key");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ pendingApproval: { id: "ap-2", kind: "workspace.transfer_owner", reason: "x", expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(), amountSatang: null, payload: { rule: "โอนความเป็นเจ้าของต้องอนุมัติทุกครั้ง" }, canSelfApprove: false }, availableAt: "2026-11-17" }, { status: 202 });
      }),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.click(await screen.findByRole("tab", { name: /ผู้ใช้/ }));
    await userEvent.click(await screen.findByRole("button", { name: "โอนความเป็นเจ้าของ" }));
    const dlg = await screen.findByRole("dialog", { name: "โอนความเป็นเจ้าของ สยามเดโม" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Owner ใหม่ (ต้องเป็นสมาชิกอยู่แล้ว)"), "u-pm");
    await userEvent.click(within(dlg).getByLabelText(/หนังสือจากบริษัท/));
    await userEvent.click(within(dlg).getByLabelText(/ชื่อนิติบุคคล/));
    await userEvent.type(within(dlg).getByLabelText("Ticket"), "#503");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "Owner เดิมลาออก บริษัทแจ้งผ่าน Ticket");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งให้คนที่สองอนุมัติ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(body).toEqual({ newOwnerUserId: "u-pm", ticketNo: "#503", reason: "Owner เดิมลาออก บริษัทแจ้งผ่าน Ticket", evidence: { companyLetter: true, legalNameMatches: true } });
  });

  it("บันทึกภายใน: เพิ่มได้ · ลูกค้าไม่เห็น", async () => {
    detail();
    let text = "";
    server.use(http.post(`${OPS}/workspaces/${WS}/notes`, async ({ request }) => ((text = ((await request.json()) as { text: string }).text), HttpResponse.json({ id: "n1" }, { status: 201 }))));
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    await userEvent.type(await screen.findByLabelText("เพิ่มบันทึก"), "สนใจ Enterprise ไตรมาสหน้า");
    await userEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(text).toBe("สนใจ Enterprise ไตรมาสหน้า"));
    expect(screen.getByText("ลูกค้าไม่เห็นส่วนนี้")).toBeInTheDocument();
  });
});
