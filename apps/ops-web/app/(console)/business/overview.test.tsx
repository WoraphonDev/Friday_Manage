import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { overview } from "@/test/fixtures";
import { asRole, OPS, server } from "@/test/server";
import MainPage from "../page";

const history = Array.from({ length: 12 }, (_, i) => ({ month: `${i < 1 ? 2025 : 2026}-${String(((i + 11) % 12) + 1).padStart(2, "0")}`, mrrSatang: 10_000_000 + i * 700_000 }));
history[11] = { month: "2026-11", mrrSatang: 18_450_000 };
const data = {
  ...overview,
  money: {
    ...overview.money,
    startMrr: 17_000_000,
    netNewMrr: 1_450_000,
    movement: { new: { count: 2, mrrDelta: 1_200_000 }, upgrade: { count: 1, mrrDelta: 500_000 }, cancel: { count: 1, mrrDelta: -250_000 } },
    churn: { logoPct: 12.5, revenuePct: 1.5, paymentFailures: 0 },
    nrrPct: 104,
    mrrHistory: history,
  },
};
const rows = [
  { id: "w1", name: "ภูผาซอฟต์", plan: "team_m", seats: 10, active30: 3, health: 32, mrr: 690_000, paymentState: "ok" },
  { id: "w2", name: "ลูเมนสตูดิโอ", plan: "team_s", seats: 5, active30: 5, health: 41, mrr: 290_000, paymentState: "overdue", healthParts: { usage: 100, payment: 0, support: 100, growth: 50 }, overdueInvoices: 2, openTickets: 0, seats30dAgo: 5 },
  { id: "w4", name: "ออร์บิทแอปส์", plan: "team_l", seats: 20, active30: 18, health: 46, mrr: 1_100_000, paymentState: "ok", healthParts: { usage: 90, payment: 100, support: 0, growth: 0 }, overdueInvoices: 0, openTickets: 5, seats30dAgo: 30 },
  { id: "w3", name: "แข็งแรงดี", plan: "team_l", seats: 20, active30: 19, health: 88, mrr: 1_500_000, paymentState: "ok" },
];
const usage = {
  days: 30,
  projects: { active: 2184, total: 3020 },
  issues: { created: 48210, closed: 41377 },
  comments: { total: 126904, mentions: 31220 },
  files: { uploaded: 9412, bytes: 412 * 1024 ** 3 },
  line: { total: 188330, sentPct: 99.9 },
  automation: { runs: 64021, workspaces: 38 },
  api: { calls: 2_100_000, tokens: 91 },
  imports: { total: 318, failed: 14, failedPct: 4.4 },
  payingWorkspaces: 214,
  featureAdoption: [
    { feature: "table", workspaces: 210, pct: 98.1 },
    { feature: "gantt", workspaces: 131, pct: 61.2 },
  ],
};
const now = new Date().toISOString();
const feed = [
  { kind: "signup", at: now, workspace: { id: "w9", name: "สยามโรโบติกส์" }, data: { plan: "team_m", trial: true, members: 8 } },
  { kind: "payment", at: now, workspace: { id: "w8", name: "นอร์ทวินด์" }, data: { method: "transfer", invoice: "FRI-2611-0007", verifiedBy: "staff" } },
  { kind: "upgrade", at: now, workspace: { id: "w7", name: "สยามโค้ด" }, data: { from: "team_s", to: "team_m" } },
  { kind: "cancel", at: "2026-01-02T03:00:00.000Z", workspace: { id: "w6", name: "พิกเซลฟอร์จ" }, data: { from: "team_m", to: null, reason: "project_ended" } },
  { kind: "staff", at: "2026-01-01T03:00:00.000Z", workspace: null, data: { action: "metrics.cost_rates_set", staff: "Olive Owner", reason: "ปรับค่า LINE" } },
];
const page = (d: object = data) => {
  server.use(
    http.get(`${OPS}/overview`, () => HttpResponse.json(d)),
    http.get(`${OPS}/overview/usage`, () => HttpResponse.json(usage)),
    http.get(`${OPS}/overview/feed`, () => HttpResponse.json({ items: feed })),
    http.get(`${OPS}/workspaces`, ({ request }) => {
      const u = new URL(request.url);
      if (u.searchParams.get("sort") === "health") return HttpResponse.json({ items: rows, total: 3 });
      return HttpResponse.json({ items: [], total: { free: 412, team_s: 96, team_m: 71, team_l: 35, enterprise: 12 }[u.searchParams.get("plan") ?? "free"] });
    }),
    http.get(`${OPS}/system/status`, () =>
      HttpResponse.json({ api: { probes: 100, uptimePct: 99.98, p95Ms: 182, last: { ok: true } }, database: { ok: true, ms: 3 }, queue: { configured: true, failed: 0 }, deliveries: [{ channel: "email", total: 1000, sent: 996, failed: 4 }] }),
    ),
  );
  return renderWithProviders(<MainPage />);
};

describe("ภาพรวม", () => {
  it("การเงินเห็นตัวเลขเงิน กราฟ MRR 12 เดือน ความเคลื่อนไหว และงานของการเงิน", async () => {
    asRole("finance");
    page();
    const kpi = await screen.findByRole("region", { name: "KPI" });
    expect(within(kpi).getByText("฿184,500")).toBeInTheDocument();
    expect(within(kpi).getByText("+8.5%")).toBeInTheDocument();
    expect(within(kpi).getByText("104%")).toBeInTheDocument();
    const chart = screen.getByRole("list", { name: "รายได้ประจำ (MRR) 12 เดือน" });
    expect(within(chart).getAllByRole("listitem")).toHaveLength(12);
    // ป้ายค่าเฉพาะเดือนล่าสุด · hover แท่งอื่นเห็นค่า
    await userEvent.hover(within(chart).getAllByRole("listitem")[0]!);
    expect(within(chart).getByText(/฿100,000$/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "ดูเป็นตาราง" })[0]!);
    expect(screen.getByRole("table", { name: "รายได้ประจำ (MRR) 12 เดือน" })).toBeInTheDocument();
    expect(screen.getByText("+฿12,000")).toBeInTheDocument();
    expect(screen.getByText("−฿2,500")).toBeInTheDocument();
    const todo = screen.getByRole("region", { name: "ต้องจัดการวันนี้" });
    expect(within(todo).getByText("การชำระเงินผิดปกติ (ระบบยืนยันเองไม่ได้)")).toBeInTheDocument();
    expect(within(todo).queryByText("Ticket ที่ยังไม่มีคนรับ")).not.toBeInTheDocument();
    expect(await screen.findByText("ภูผาซอฟต์")).toBeInTheDocument();
    expect(screen.queryByText("แข็งแรงดี")).not.toBeInTheDocument();
    expect(screen.getByText("ใช้งาน 3 / 10 คนใน 30 วัน")).toBeInTheDocument();
    expect(screen.getByText("ค้างชำระ 2 ใบ")).toBeInTheDocument();
    // Support เสียคะแนน 20 · ทีมหด 15 → สาเหตุหลักคือ Ticket
    expect(screen.getByText("Ticket ค้าง 5 เรื่อง")).toBeInTheDocument();
    expect(await screen.findByText("412")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "สถานะระบบ" })).not.toBeInTheDocument();
  });

  it("Support ไม่เห็นตัวเลขเงิน เห็นงานของ Support", async () => {
    asRole("support");
    page({ ...data, money: null });
    expect(await screen.findByText("กำลังทดลองใช้")).toBeInTheDocument();
    expect(screen.queryByText("MRR")).not.toBeInTheDocument();
    const todo = screen.getByRole("region", { name: "ต้องจัดการวันนี้" });
    expect(within(todo).getByText("Ticket ที่ยังไม่มีคนรับ")).toBeInTheDocument();
    expect(within(todo).getByText("เหตุขัดข้องที่เปิดอยู่")).toBeInTheDocument();
    expect(within(todo).queryByText("สลิปรอตรวจ")).not.toBeInTheDocument();
  });

  it("วิศวกรเห็นสถานะระบบ", async () => {
    asRole("engineer");
    page({ ...data, money: null });
    const sys = await screen.findByRole("region", { name: "สถานะระบบ" });
    expect(await within(sys).findByText("99.98%")).toBeInTheDocument();
    expect(within(sys).getByText("99.6%")).toBeInTheDocument();
  });

  it("การใช้งาน 30 วัน และกิจกรรมล่าสุด", async () => {
    asRole("admin");
    page();
    const u = await screen.findByRole("region", { name: "การใช้งานระบบของลูกค้า 30 วัน" });
    expect(await within(u).findByText("2,184")).toBeInTheDocument();
    expect(within(u).getByText("จาก 3,020 โปรเจกต์")).toBeInTheDocument();
    expect(within(u).getByText("412 GB")).toBeInTheDocument();
    expect(within(u).getByText("ส่งถึง 99.9%")).toBeInTheDocument();
    expect(within(u).getByText("ล้ม 14 (4.4%)")).toBeInTheDocument();
    expect(within(u).getByText("% ของ Workspace ที่จ่ายเงิน (214 ราย) ซึ่งใช้ฟีเจอร์นี้ใน 30 วัน")).toBeInTheDocument();
    expect(within(u).getByText("61.2%")).toBeInTheDocument();
    const f = screen.getByRole("region", { name: "กิจกรรมล่าสุด" });
    expect(await within(f).findByText("สยามโรโบติกส์ เริ่มทดลองใช้ Team M (8 คน)")).toBeInTheDocument();
    expect(within(f).getByRole("link", { name: "ยืนยันการชำระเงินของ นอร์ทวินด์ · ใบแจ้งหนี้ FRI-2611-0007" })).toHaveAttribute("href", "/workspaces/w8");
    expect(within(f).getByText("สยามโค้ด เปลี่ยนจาก Team S เป็น Team M")).toBeInTheDocument();
    expect(within(f).getByText("พิกเซลฟอร์จ ยกเลิกแพ็กเกจ · เหตุผล: โปรเจกต์จบแล้ว")).toBeInTheDocument();
    expect(within(f).getByText("Olive Owner: ปรับค่า LINE")).toBeInTheDocument();
    expect(within(f).getAllByText("ระบบ").length).toBeGreaterThan(0);
  });

  it("กิจกรรมล่าสุดว่าง และ Error ของการใช้งาน", async () => {
    asRole("support");
    page({ ...data, money: null });
    server.use(
      http.get(`${OPS}/overview/feed`, () => HttpResponse.json({ items: [] })),
      http.get(`${OPS}/overview/usage`, () => HttpResponse.json({ error: { code: "internal", message: "ล้ม", requestId: "req-u1" } }, { status: 500 })),
    );
    expect(await screen.findByText("ยังไม่มีกิจกรรม")).toBeInTheDocument();
    const u = screen.getByRole("region", { name: "การใช้งานระบบของลูกค้า 30 วัน" });
    expect(await within(u).findByText(/req-u1/)).toBeInTheDocument();
  });
});
