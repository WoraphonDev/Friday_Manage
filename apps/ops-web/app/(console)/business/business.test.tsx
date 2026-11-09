import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { overview } from "@/test/fixtures";
import { asRole, OPS, server } from "@/test/server";
import { BusinessPage } from "./BusinessPage";

const W = (id: string, name: string) => ({ id, slug: id, name });
const biz = {
  computedAt: "2026-11-10T02:00:00.000Z",
  mrrSatang: 1_401_000,
  payingWorkspaces: 4,
  arpaSatang: 350_250,
  margin: {
    marginPct: 81,
    revenueSatang: 1_401_000,
    costSatang: 266_190,
    infraMonth: "2026-11",
    infraSatang: 100_000,
    byPlan: [
      { plan: "team_s", customers: 1, revenueSatang: 1_000, costSatang: 50_000, marginPct: -4900 },
      { plan: "team_m", customers: 1, revenueSatang: 300_000, costSatang: 60_000, marginPct: 80 },
    ],
  },
  customers: { top: [], unprofitable: [{ workspace: W("w-e", "อีอีสตูดิโอ"), plan: "team_s", revenueSatang: 1_000, costSatang: 50_000, grossSatang: -49_000, marginPct: -4900 }] },
  funnel: { windowDays: 90, signups: 100, emailVerified: 90, firstProject: 70, secondMember: 30, activated: 25, paid: 10 },
  trialConversion: { ended: 58, converted: 13, pct: 22.4 },
  cohorts: [{ month: "2026-05", customers: 18, retention: [100, 89, 83] }],
  channels: [
    { source: "google", newPaying: 4, spendSatang: 4_800_000, cacSatang: 1_200_000, paybackMonths: 4.3 },
    { source: "referral", newPaying: 3, spendSatang: 0, cacSatang: 0, paybackMonths: 0 },
  ],
  ltvSatang: 8_400_000,
  monthlyRevenueChurnPct: 1.8,
  cancellationReasons: [
    { reason: "too_expensive", n: 3, kept: 1 },
    { reason: "missing_feature", n: 1, kept: 0 },
  ],
  featureAdoption: [{ feature: "gantt", workspaces: 2, pct: 50 }],
  upgradeReady: [{ workspace: W("w-a", "เอเอซอฟต์"), plan: "team_m", signals: [{ code: "seats_near_limit", message: "ที่นั่ง 21 / 25 (84%)" }] }],
  arAging: { d0_30: 0, d31_60: 321_000, d60plus: 0, notDue: 1_070 },
  deferredRevenueSatang: 5_036_986,
  forecast: [
    { month: "2026-12", mrrSatang: 1_500_000 },
    { month: "2027-01", mrrSatang: 1_600_000 },
    { month: "2027-02", mrrSatang: 1_700_000 },
  ],
};
const costs = {
  rates: [
    { resource: "line_message", kind: "unit", current: { resource: "line_message", unitCostSatang: "4", pct: null, effectiveFrom: "2026-01-01" }, scheduled: [], history: [] },
    { resource: "email", kind: "unit", current: { resource: "email", unitCostSatang: "1", pct: null, effectiveFrom: "2026-01-01" }, scheduled: [], history: [] },
    { resource: "storage_gb_month", kind: "unit", current: null, scheduled: [], history: [] },
    { resource: "payment_fee_card", kind: "pct", current: { resource: "payment_fee_card", unitCostSatang: null, pct: "3.65", effectiveFrom: "2026-01-01" }, scheduled: [], history: [] },
    { resource: "payment_fee_promptpay", kind: "pct", current: null, scheduled: [], history: [] },
    { resource: "etax_doc", kind: "unit", current: null, scheduled: [], history: [] },
    { resource: "slip_check", kind: "unit", current: null, scheduled: [], history: [] },
  ],
  infra: [{ month: "2026-11", category: "aws", amountSatang: 100_000 }],
  allocation: "x",
};
const page = () => {
  server.use(
    http.get(`${OPS}/business`, () => HttpResponse.json(biz)),
    http.get(`${OPS}/overview`, () => HttpResponse.json({ ...overview, money: { ...overview.money, nrrPct: 122.2 } })),
    http.get(`${OPS}/costs`, () => HttpResponse.json(costs)),
    http.get(`${OPS}/marketing-costs`, () => HttpResponse.json({ month: "2026-11", items: [{ source: "google", amountSatang: 4_800_000, note: null }], sources: ["google", "facebook"], totalSatang: 4_800_000 })),
  );
  return renderWithProviders(<BusinessPage />);
};

describe("ธุรกิจและกำไร", () => {
  it("ผู้ตรวจเห็นทุกการ์ด แต่แก้ไม่ได้", async () => {
    asRole("auditor");
    page();
    const kpi = await screen.findByRole("region", { name: "KPI" });
    expect(within(kpi).getByText("81%")).toBeInTheDocument();
    expect(within(kpi).getByText("122.2%")).toBeInTheDocument();
    // ค่าหาลูกค้าเฉลี่ย ฿48,000 ÷ 7 ราย
    expect(within(kpi).getByText("฿6,857")).toBeInTheDocument();
    expect(within(kpi).getByText("22.4%")).toBeInTheDocument();
    expect(screen.getAllByText("อีอีสตูดิโอ").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 ราย").length).toBeGreaterThan(0);
    // Funnel: ขั้นที่หลุดมากสุด (ชวนเพื่อนร่วมทีม −57%)
    expect(screen.getByText("−57%")).toBeInTheDocument();
    expect(screen.getByTitle("พ.ค. 2569 เดือน 1: ยังจ่าย 89%")).toHaveTextContent("89%");
    expect(screen.getByText("7×")).toBeInTheDocument();
    expect(screen.getByText("ไม่มีต้นทุน")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("ที่นั่ง 21 / 25 (84%)")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "คาดการณ์ MRR" })).toBeInTheDocument();
    expect(await screen.findByText("3.65%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ตั้งค่าต้นทุน" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "กรอกค่าการตลาดเดือนนี้" })).not.toBeInTheDocument();
  });

  it("B10 กรอกค่าการตลาด", async () => {
    asRole("finance");
    let body: unknown = null;
    server.use(http.put(`${OPS}/marketing-costs`, async ({ request }) => ((body = await request.json()), HttpResponse.json({}))));
    page();
    await userEvent.click(await screen.findByRole("button", { name: "กรอกค่าการตลาดเดือนนี้" }));
    const dlg = await screen.findByRole("dialog", { name: /ค่าการตลาด/ });
    expect(await within(dlg).findByDisplayValue("48000")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("ค่าใช้จ่าย (บาท) facebook"), "22000");
    await userEvent.click(within(dlg).getByRole("button", { name: "เพิ่มช่องทาง" }));
    await userEvent.type(within(dlg).getByLabelText("ช่องทาง (utm_source) 3"), "seo");
    await userEvent.type(within(dlg).getByLabelText("ค่าใช้จ่าย (บาท) seo"), "15000");
    expect(within(dlg).getByText("รวม ฿85,000")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await waitFor(() =>
      expect(body).toEqual({
        month: expect.stringMatching(/^\d{4}-\d{2}$/),
        items: [
          { source: "google", amountSatang: 4_800_000 },
          { source: "facebook", amountSatang: 2_200_000 },
          { source: "seo", amountSatang: 1_500_000 },
        ],
      }),
    );
  });

  it("B9 ตั้งค่าต้นทุน: ส่งเฉพาะช่องที่แก้", async () => {
    asRole("finance");
    let rates: unknown = null;
    let infra: unknown = null;
    server.use(
      http.put(`${OPS}/costs/rates`, async ({ request }) => ((rates = await request.json()), HttpResponse.json(costs))),
      http.put(`${OPS}/costs/infra`, async ({ request }) => ((infra = await request.json()), HttpResponse.json(costs))),
    );
    page();
    await userEvent.click(await screen.findByRole("button", { name: "ตั้งค่าต้นทุน" }));
    const drawer = await screen.findByRole("dialog", { name: "ต้นทุนต่อหน่วย" });
    const line = await within(drawer).findByLabelText("ข้อความ LINE (เกินโควตาฟรี)");
    expect(line).toHaveValue("0.04");
    await userEvent.clear(line);
    await userEvent.type(line, "0.05");
    await userEvent.clear(within(drawer).getByLabelText("ค่าธรรมเนียม PromptPay"));
    await userEvent.type(within(drawer).getByLabelText("ค่าธรรมเนียม PromptPay"), "1.65");
    await userEvent.type(within(drawer).getByLabelText("เหตุผลที่เปลี่ยนต้นทุนต่อหน่วย"), "ราคาใหม่จากผู้ให้บริการ");
    const aws = within(drawer).getByLabelText("AWS");
    await userEvent.clear(aws);
    await userEvent.type(aws, "1500");
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(infra).toEqual({ month: "2026-11", items: [{ category: "aws", amountSatang: 150_000 }] }));
    expect(rates).toMatchObject({
      reason: "ราคาใหม่จากผู้ให้บริการ",
      rates: [
        { resource: "line_message", unitCostSatang: 5 },
        { resource: "payment_fee_promptpay", pct: 1.65 },
      ],
    });
  });

  it("Owner / การเงินสั่งคำนวณใหม่ได้", async () => {
    asRole("finance");
    let refreshed = false;
    page();
    server.use(http.get(`${OPS}/business`, ({ request }) => ((refreshed ||= new URL(request.url).searchParams.get("refresh") === "true"), HttpResponse.json(biz))));
    await userEvent.click(await screen.findByRole("button", { name: "คำนวณใหม่" }));
    expect(await screen.findByText("คำนวณใหม่แล้ว")).toBeInTheDocument();
    await waitFor(() => expect(refreshed).toBe(true));
  });

  it("Support ไม่มีสิทธิ์", async () => {
    asRole("support");
    page();
    expect(await screen.findByText(/ดูหน้านี้ไม่ได้/)).toBeInTheDocument();
  });
});
