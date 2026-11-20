import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { CustomerDetail } from "./[id]/CustomerDetail";
import type { Overview, WsRow } from "./_parts/types";
import { WorkspacesList } from "./WorkspacesList";

const WS = "10000000-0000-4000-8000-00000000000a";
const row = (over: Partial<WsRow>): WsRow => ({
  id: WS, slug: "siam-demo", name: "สยามเดโม", status: "active", createdAt: "2026-03-14T03:00:00.000Z", plan: "team_m", subStatus: "active", cycle: "monthly",
  trialEndsAt: null, periodEnd: null, seats: 21, seatLimit: 25, projects: 14, active30: 18, lastActiveAt: new Date().toISOString(), storageBytes: 12 * 1024 ** 3,
  integrations: ["line", "webhook"], health: 86, mrr: 300_000, paymentState: "ok", buyer: { key: null, name: null, company: false, count: 1 }, test: { isTest: false, flag: null, auto: false, suggest: null, reason: null, by: null, at: null }, ...over,
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
const shell = (ui: React.ReactElement, path: string, search = "") => {
  navigation.pathname = path;
  navigation.search = search;
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
    // แพ็กเกจและฟีเจอร์อยู่ในปุ่ม "ตัวกรอง" (โครงหน้า Ops)
    await userEvent.click(screen.getByRole("button", { name: /^ตัวกรอง/ }));
    await userEvent.click(screen.getByRole("button", { name: "Team M" }));
    await userEvent.click(screen.getByRole("button", { name: "LINE OA" }));
    await userEvent.selectOptions(screen.getByLabelText("เรียงตาม"), "health");
    await waitFor(() => expect(asked.at(-1)?.toString()).toContain("sort=health"));
    expect(asked.at(-1)?.get("plan")).toBe("team_m");
    expect(asked.at(-1)?.get("feature")).toBe("line");
  });

  it("ช่วง 3: แผงตัวกรองเลือกหลายแพ็กเกจ · สุขภาพ · MRR เป็นบาทส่งเป็นสตางค์ · ชิปเหนือตารางเอาออกได้", async () => {
    const asked: URLSearchParams[] = [];
    list((u) => (asked.push(u.searchParams), undefined));
    shell(<WorkspacesList />, "/workspaces");
    await screen.findByText("สยามเดโม");
    await userEvent.click(screen.getByRole("button", { name: /^ตัวกรอง/ }));
    await userEvent.click(screen.getByRole("button", { name: "Team M" }));
    await userEvent.click(screen.getByRole("button", { name: "Team L" }));
    await userEvent.click(screen.getByRole("button", { name: "ต่ำ (<40)" }));
    await userEvent.type(screen.getByLabelText("MRR (บาท) ต่ำสุด"), "1000");
    await waitFor(() => expect(asked.at(-1)?.get("mrrMin")).toBe("100000"));
    expect(asked.at(-1)?.get("plan")).toBe("team_m,team_l");
    expect(asked.at(-1)?.get("health")).toBe("low");
    expect(screen.getByRole("button", { name: /^ตัวกรอง \(3\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "เอาตัวกรอง สุขภาพ ออก" }));
    await waitFor(() => expect(asked.at(-1)?.get("health")).toBeNull());
  });

  it("ช่วง 1: ตัวกรองอ่านจาก URL (กดย้อนกลับแล้วยังอยู่ที่เดิม) และเขียนกลับเมื่อเปลี่ยน", async () => {
    const asked: URLSearchParams[] = [];
    list((u) => (asked.push(u.searchParams), undefined));
    shell(<WorkspacesList />, "/workspaces", "plan=team_m&page=1&sort=health");
    await screen.findByText("สยามเดโม");
    expect(asked.at(-1)?.get("plan")).toBe("team_m");
    expect(asked.at(-1)?.get("offset")).toBe("50");
    expect(asked.at(-1)?.get("sort")).toBe("health");
    await userEvent.click(screen.getByRole("tab", { name: "ทดลอง" }));
    expect(router.replace).toHaveBeenLastCalledWith("/workspaces?status=trialing&sort=health&plan=team_m", { scroll: false });
  });

  it("ช่วง 1: คอลัมน์ผู้ซื้อ · กด +1 Workspace แล้วกรองผู้ซื้อพร้อมแถวสรุปยอด", async () => {
    const asked: URLSearchParams[] = [];
    const buyer = { key: "t:0105500000009", name: "บจก. สยามเดโม", company: true, count: 2 };
    list((u) => {
      asked.push(u.searchParams);
      const items = [row({ buyer }), row({ id: "w2", slug: "siam-web", name: "สยามเดโม · เว็บ", buyer })];
      return u.searchParams.get("buyer")
        ? { items, total: 2, limit: 50, offset: 0, sort: "recent_activity", buyer: { key: buyer.key, name: buyer.name, workspaces: 2, seats: 42, seatLimit: 50, mrr: 600_000, openTickets: 1 } }
        : { items: [items[0]], total: 1, limit: 50, offset: 0, sort: "recent_activity", counts: { all: 1, paying: 1, trialing: 0, past_due: 0, suspended: 0 }, tests: { hidden: 3, suggested: 0 } };
    });
    shell(<WorkspacesList />, "/workspaces");
    expect(await screen.findByText("ลูกค้า 1 ราย · ซ่อน Workspace ทดสอบ 3")).toBeInTheDocument();
    expect(screen.getByText("บจก. สยามเดโม")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "+1 Workspace" }));
    await waitFor(() => expect(asked.at(-1)?.get("buyer")).toBe(buyer.key));
    const sum = await screen.findByRole("status", { name: "" });
    expect(sum).toHaveTextContent("MRR รวม ฿6,000");
    expect(screen.getByText("ผู้ซื้อ: บจก. สยามเดโม")).toBeInTheDocument();
  });

  it("ช่วง 1: ตรวจรายการที่ระบบเสนอ · เลือกทั้งหมดตามตัวกรอง · ชุดที่มีลูกค้าจ่ายเงินต้องยืนยันอีกครั้ง", async () => {
    asRole("support");
    const bodies: unknown[] = [];
    let first = true;
    list((u) =>
      u.searchParams.get("suggest")
        ? { items: [row({ id: "q1", slug: "qa-1", name: "QA Sprint", test: { isTest: false, flag: null, auto: false, suggest: "staff_domain", reason: null, by: null, at: null } })], total: 60, limit: 50, offset: 0, sort: "recent_activity" }
        : { items: [row({})], total: 1, limit: 50, offset: 0, sort: "recent_activity", tests: { hidden: 0, suggested: 60 } },
    );
    server.use(
      http.post(`${OPS}/workspaces/test-flag`, async ({ request }) => {
        const b = await request.json();
        bodies.push(b);
        if (first) return ((first = false), HttpResponse.json({ error: { code: "has_paying", message: "มี 1 Workspace ที่จ่ายเงินอยู่", details: { paying: 1 } } }, { status: 409 }));
        return HttpResponse.json({ updated: 60, paying: 1 });
      }),
    );
    shell(<WorkspacesList />, "/workspaces");
    await userEvent.click(await screen.findByRole("button", { name: "ตรวจในตาราง" }));
    expect(await screen.findByText("อีเมลทีม Friday", { selector: ".pill" })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("เลือกทุกแถวในหน้านี้"));
    await userEvent.click(screen.getByRole("button", { name: "เลือกทั้งหมด 60 รายการตามตัวกรอง" }));
    await userEvent.click(screen.getByRole("button", { name: "ติดป้ายทดสอบ" }));
    const dlg = await screen.findByRole("dialog", { name: 'ติดป้าย "ทดสอบ" 60 Workspace?' });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log ของทีม)"), "รอบทดสอบ Sprint");
    await userEvent.click(within(dlg).getByRole("button", { name: "ติดป้าย 60 รายการ" }));
    expect(await within(dlg).findByText("มี 1 Workspace ที่จ่ายเงินอยู่ในชุดนี้")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยันติดป้าย 60 รายการ" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toEqual({ filter: { suggest: "any" }, flag: "test", reason: "รอบทดสอบ Sprint", confirmPaying: false });
    expect(bodies[1]).toMatchObject({ confirmPaying: true });
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

  it("ยกเลิกส่วนลดเฉพาะราย (C3): ปุ่มในแถวส่วนลด · สรุปส่วนลดเดิม · ต้องมีเหตุผล · ไม่ต้องอนุมัติ", async () => {
    asRole("finance");
    const sub = overview().subscription!;
    detail(overview({ subscription: { ...sub, discount: { percent: 20, months: 3, cyclesLeft: 2, reason: "ลูกค้าเทียบราคากับเจ้าอื่น", setAt: "2026-11-20T03:00:00.000Z", setByName: "Fin Finance" } } }));
    let body: Record<string, unknown> | null = null;
    server.use(http.post(`${OPS}/workspaces/${WS}/discount/remove`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ removed: { percent: 20, cyclesLeft: 2 } }))));
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    expect(await screen.findByText("20% · เหลือ 2 รอบ")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ยกเลิกส่วนลด 20%" }));
    const dlg = await screen.findByRole("dialog", { name: "ยกเลิกส่วนลดของ สยามเดโม" });
    expect(within(dlg).getByText("ลูกค้าเทียบราคากับเจ้าอื่น")).toBeInTheDocument();
    expect(within(dlg).getByText(/Fin Finance/)).toBeInTheDocument();
    expect(within(dlg).getByText("ใบที่ออกไปแล้วและรอชำระ ยังได้ส่วนลดตามเดิม")).toBeInTheDocument();
    const submit = within(dlg).getByRole("button", { name: "ยกเลิกส่วนลด" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "เปลี่ยนเป็นสัญญารายปี");
    await userEvent.click(submit);
    await waitFor(() => expect(body).toEqual({ reason: "เปลี่ยนเป็นสัญญารายปี" }));
    expect(await screen.findByText("ยกเลิกส่วนลด 20% แล้ว · ใบถัดไปคิดราคาเต็ม")).toBeInTheDocument();
  });

  it("ยกเลิกส่วนลด: Support เห็นแถวส่วนลดแต่ไม่มีปุ่ม · ไม่มีส่วนลดก็ไม่มีปุ่ม", async () => {
    asRole("support");
    detail();
    shell(<CustomerDetail id={WS} />, `/workspaces/${WS}`);
    expect(await screen.findByText("20% · เหลือ 4 รอบ")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ยกเลิกส่วนลด/ })).not.toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
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
