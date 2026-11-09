import { screen } from "@testing-library/react";
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
  deliveries: [
    { channel: "email", total: 120, sent: 118, failed: 2, pending: 0 },
  ],
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
    expect(
      screen.getByText("รอเชื่อม GlitchTip / CloudWatch"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "สยามเดโม" })).toHaveAttribute(
      "href",
      "/workspaces/10000000-0000-4000-8000-00000000000a",
    );
    expect(screen.getByText("แจ้งเตือน LINE ล่าช้า")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "แจ้งเหตุขัดข้องถึงลูกค้า" }),
    ).toHaveAttribute("href", "/incidents?new=1");
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
    expect(
      screen.getByText("ยังไม่เชื่อมคิว (ตั้ง VALKEY_URL)"),
    ).toBeInTheDocument();
    expect(screen.getByText("ไม่มีเหตุขัดข้อง")).toBeInTheDocument();
  });
});
