import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { asRole, OPS, server } from "@/test/server";
import { SystemPage } from "./SystemPage";

const base = {
  versions: { web: "1.4.2", api: "1.4.2", ops: "0.3.0" },
  api: {
    probes: 2880,
    uptimePct: 99.97,
    avgMs: 84,
    p95Ms: 210,
    last: { ok: true, ms: 80, at: Date.now() },
    hours: Array.from({ length: 24 }, (_, i) => ({
      from: new Date(Date.now() - (24 - i) * 3_600_000).toISOString(),
      probes: 120,
      up: 120,
      avgMs: 80,
    })),
    errorRate: null,
    errorHours: Array.from({ length: 24 }, (_, i) => ({ from: new Date(Date.now() - (24 - i) * 3_600_000).toISOString(), total: 0, errors: 0, ratePct: null, over: false })),
    alert: null,
    alertSettings: { thresholdPct: 2, windowMin: 5, minRequests: 200, push: true, email: true, autoIncident: false },
  },
  database: { ok: true, ms: 3 },
  queue: {
    configured: true,
    waiting: 4,
    active: 1,
    delayed: 2,
    failed: 3,
    completed: 900,
  },
  deliveries: [{ channel: "email", total: 120, sent: 118, failed: 2, pending: 0 }],
  heavyWorkspaces: [
    {
      id: "10000000-0000-4000-8000-00000000000a",
      slug: "siam-demo",
      name: "สยามเดโม",
      apiCalls: 48_000,
      webhookCalls: 900,
      automationRuns: 1200,
      storageBytes: 5_368_709_120,
      activeUsers: 18,
    },
  ],
  incidents: [
    {
      id: "i1",
      title: "แจ้งเตือน LINE ล่าช้า",
      status: "monitoring",
      impact: "minor",
      startedAt: "2026-11-09T02:00:00.000Z",
      internal: false,
    },
  ],
};

describe("สถานะระบบ", () => {
  it("แสดงตัวเลข API คิว การส่ง และลูกค้าที่ใช้ทรัพยากรมาก", async () => {
    asRole("engineer");
    server.use(http.get(`${OPS}/system/status`, () => HttpResponse.json(base)));
    renderWithProviders(<SystemPage />);
    expect(await screen.findByText("99.97%")).toBeInTheDocument();
    expect(screen.getByText("ทุกบริการปกติ")).toBeInTheDocument();
    expect(screen.getByText("84 ms")).toBeInTheDocument();
    expect(screen.getByText("ยังอ่านตัวนับ 5xx ของ API ไม่ได้")).toBeInTheDocument();
    expect(screen.getByText("Error rate 5 นาที")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "สยามเดโม" })).toHaveAttribute("href", "/workspaces/10000000-0000-4000-8000-00000000000a");
    expect(screen.getByText("แจ้งเตือน LINE ล่าช้า")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "แจ้งเหตุขัดข้องถึงลูกค้า" })).toHaveAttribute("href", "/incidents?new=1");
  });

  it("API ล่ม · คิวยังไม่ได้เชื่อม", async () => {
    asRole("engineer");
    server.use(
      http.get(`${OPS}/system/status`, () =>
        HttpResponse.json({
          ...base,
          api: { ...base.api, last: { ok: false, ms: 0, at: Date.now() } },
          queue: { configured: false },
          deliveries: [],
          heavyWorkspaces: [],
          incidents: [],
        }),
      ),
    );
    renderWithProviders(<SystemPage />);
    expect(await screen.findByText("API ตอบไม่ได้")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่เชื่อมคิว (ตั้ง VALKEY_URL)")).toBeInTheDocument();
    expect(screen.getByText("ไม่มีเหตุขัดข้อง")).toBeInTheDocument();
  });

  // S10–S11 · Error rate จากตัวนับ 5xx ของ API · ข้อมูลสมมติ
  const overStatus = {
    ...base,
    api: {
      ...base.api,
      errorRate: { at: new Date().toISOString(), ratePct: 3.4, errors: 214, total: 6290, windowMin: 5, topRoute: "POST /w/:ws/issues", p95Ms: 412, thresholdPct: 2, minRequests: 200, over: true, overMinutes: 6 },
      errorHours: base.api.errorHours.map((h, i) => (i === 23 ? { ...h, total: 6290, errors: 214, ratePct: 3.4, over: true } : { ...h, total: 5000, errors: 50, ratePct: 1, over: false })),
      alert: {
        id: "al-1",
        startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        details: { ratePct: 3.4, errors: 214, total: 6290, windowMin: 5, topRoute: "POST /w/:ws/issues", p95Ms: 412, peakPct: 3.4, normalSince: null },
        lastNotifiedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        acknowledgedAt: null,
        acknowledgedBy: null,
        incidentId: null,
      },
    },
  };

  it("S10 Error rate เกิน: การ์ดสีแดง เกินมากี่นาที · ป้ายแดงบอกเส้นทาง · แท่งแดงในกราฟ · เปิดเหตุขัดข้อง", async () => {
    asRole("engineer");
    const posted: string[] = [];
    server.use(
      http.get(`${OPS}/system/status`, () => HttpResponse.json(overStatus)),
      http.post(`${OPS}/system/alerts/:id/incident`, ({ params }) => (posted.push(String(params.id)), HttpResponse.json({ incidentId: "in-9", created: true }, { status: 201 }))),
    );
    renderWithProviders(<SystemPage />);
    expect(await screen.findByText("3.4%")).toBeInTheDocument();
    expect(screen.getByText("เกณฑ์ 2% · เกินมา 6 นาที")).toBeInTheDocument();
    const notice = screen.getByRole("alert");
    expect(within(notice).getByText("Error rate เกินเกณฑ์")).toBeInTheDocument();
    expect(notice).toHaveTextContent("5xx 214 จาก 6,290 คำขอใน 5 นาที · ส่วนใหญ่จาก POST /w/:ws/issues · แจ้ง Push ถึงวิศวกรและ Owner แล้ว");
    expect(screen.queryByText("ทุกบริการปกติ")).toBeNull();
    const chart = screen.getByRole("img", { name: "Error rate · 24 ชม." });
    expect(chart.querySelectorAll("[data-over]")).toHaveLength(1);
    expect(screen.getByText("แท่งแดง = เกินเกณฑ์ 2%")).toBeInTheDocument();
    await userEvent.click(await within(notice).findByRole("button", { name: "เปิดเหตุขัดข้อง" }));
    await waitFor(() => expect(posted).toEqual(["al-1"]));
  });

  it("S11 ตั้งเกณฑ์แจ้งเตือน: ค่าเดิมในฟอร์ม · บันทึกส่งค่าตัวเลข · ค่าผิดกดบันทึกไม่ได้", async () => {
    asRole("engineer");
    let saved: unknown = null;
    server.use(
      http.get(`${OPS}/system/status`, () => HttpResponse.json(overStatus)),
      http.put(`${OPS}/system/alert-settings`, async ({ request }) => ((saved = await request.json()), HttpResponse.json({ saved: true, settings: saved }))),
    );
    renderWithProviders(<SystemPage />);
    await userEvent.click(await screen.findByRole("button", { name: "ตั้งเกณฑ์แจ้งเตือน" }));
    const dialog = await screen.findByRole("dialog", { name: "ตั้งเกณฑ์แจ้งเตือน Error rate" });
    expect(within(dialog).getByText("คิดจากคำขอที่ API ตอบ 5xx")).toBeInTheDocument();
    const threshold = within(dialog).getByLabelText("แจ้งเมื่อเกิน (%)");
    expect(threshold).toHaveValue(2);
    expect(within(dialog).getByLabelText("Push มือถือ · วิศวกรและ Owner")).toBeChecked();
    expect(within(dialog).getByLabelText("เปิดเหตุขัดข้องแบบภายในให้อัตโนมัติ (ไม่ประกาศลูกค้า)")).not.toBeChecked();
    expect(within(dialog).getByText('แจ้งซ้ำทุก 30 นาทีถ้ายังเกิน · กลับมาปกติ 10 นาทีแล้วแจ้ง "กลับมาปกติ"')).toBeInTheDocument();
    await userEvent.clear(threshold);
    expect(within(dialog).getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await userEvent.type(threshold, "2.5");
    await userEvent.selectOptions(within(dialog).getByLabelText("ต่อเนื่อง"), "10");
    await userEvent.click(within(dialog).getByLabelText("อีเมล · วิศวกรและ Owner"));
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(saved).toEqual({ thresholdPct: 2.5, windowMin: 10, minRequests: 200, push: true, email: false, autoIncident: false }));
  });
});
