// O41 · R1 บัญชีเครดิตในหน้ารายละเอียดลูกค้า · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { asRole, OPS, server } from "@/test/server";
import { CreditCard } from "./_parts/Credit";

const WS = "10000000-0000-4000-8000-000000000041";
const LEDGER = {
  balanceSatang: 57_100,
  items: [
    { id: "c3", at: "2026-11-13T03:00:00.000Z", amountSatang: -96_300, balanceSatang: 57_100, source: "applied", note: "ใช้ชำระ FRI-2611-0034", invoice: { id: "i3", number: "FRI-2611-0034" }, creditNote: null, staff: null },
    { id: "c2", at: "2026-11-12T03:00:00.000Z", amountSatang: 128_400, balanceSatang: 153_400, source: "credit_note", note: "คิดค่าบริการซ้ำเดือน ต.ค.", invoice: { id: "i2", number: "FRI-2610-0007" }, creditNote: { id: "n2", number: "CN-2611-0002" }, staff: "การเงินตัวอย่าง" },
    { id: "c1", at: "2026-11-03T03:00:00.000Z", amountSatang: 25_000, balanceSatang: 25_000, source: "overpayment", note: "โอนเกิน", invoice: { id: "i1", number: "FRI-2611-0012" }, creditNote: null, staff: null },
  ],
  next: { date: "2026-12-01T00:00:00.000Z", plan: "team_m", totalSatang: 321_000, creditSatang: 57_100, payableSatang: 263_900 },
};

function setup() {
  const refunds: unknown[] = [];
  server.use(
    http.get(`${OPS}/credits`, () => HttpResponse.json(LEDGER)),
    http.post(`${OPS}/credits\\:refund`, async ({ request }) => {
      refunds.push(await request.json());
      return HttpResponse.json({ refundedSatang: 57_100, balanceSatang: 0 });
    }),
  );
  return { refunds };
}

describe("บัญชีเครดิต (R1)", () => {
  it("ประวัติพร้อมที่มาและคงเหลือ · สรุปใบถัดไปที่หักเครดิตแล้ว", async () => {
    asRole("finance");
    setup();
    renderWithProviders(<CreditCard id={WS} name="ออร์บิทเดโม" />);
    const table = await screen.findByRole("table", { name: "บัญชีเครดิต" });
    expect(within(table).getByText("ใช้ชำระ FRI-2611-0034")).toBeInTheDocument();
    expect(within(table).getByText("ใบลดหนี้")).toBeInTheDocument();
    expect(within(table).getByText(/CN-2611-0002/)).toBeInTheDocument();
    expect(within(table).getByText("−963.00")).toBeInTheDocument();
    expect(within(table).getByText("+1,284.00")).toBeInTheDocument();
    expect(screen.getByText("฿2,639.00")).toBeInTheDocument();
    expect(screen.getByText(/คงเหลือ ฿571.00/)).toBeInTheDocument();
  });

  it("คืนเป็นเงิน: ไม่เกินคงเหลือ · ส่งยอดเป็นสตางค์พร้อมเหตุผล", async () => {
    asRole("finance");
    const { refunds } = setup();
    renderWithProviders(<CreditCard id={WS} name="ออร์บิทเดโม" />);
    await userEvent.click(await screen.findByRole("button", { name: "คืนเป็นเงิน" }));
    const dlg = await screen.findByRole("dialog", { name: "คืนเครดิตเป็นเงิน · ออร์บิทเดโม" });
    expect(within(dlg).getByText("คืนได้ไม่เกิน ฿571.00")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ลูกค้าเห็นใน Audit log)"), "ลูกค้าเลิกใช้บางส่วน");
    await userEvent.click(within(dlg).getByRole("button", { name: "คืนเป็นเงิน" }));
    await waitFor(() => expect(refunds).toEqual([{ workspaceId: WS, amountSatang: 57_100, reason: "ลูกค้าเลิกใช้บางส่วน" }]));
  });

  it("Support เห็นประวัติแต่ไม่เห็นปุ่มเพิ่ม / คืน", async () => {
    asRole("support");
    setup();
    renderWithProviders(<CreditCard id={WS} name="ออร์บิทเดโม" />);
    await screen.findByRole("table", { name: "บัญชีเครดิต" });
    expect(screen.queryByRole("button", { name: "คืนเป็นเงิน" })).toBeNull();
    expect(screen.queryByRole("button", { name: "เพิ่มเครดิต" })).toBeNull();
  });
});
