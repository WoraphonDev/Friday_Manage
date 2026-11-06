import { screen } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { emptyMetrics } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { asRole, OPS, opsError, server } from "@/test/server";
import { Shell } from "../shell/Shell";
import { Overview } from "./Overview";

const view = () => renderWithProviders(
  <Shell>
    <Overview />
  </Shell>,
);

describe("ภาพรวมธุรกิจ (ops/metrics)", () => {
  it("แสดง KPI จาก metrics (เงินเป็นสตางค์) และรายการต้องดูแล", async () => {
    view();
    expect(await screen.findByText("฿184,500")).toBeInTheDocument();
    expect(screen.getByText("S 4 · M 2 · L 1")).toBeInTheDocument();
    expect(screen.getByText("รับชำระ 30 วัน ฿50,000")).toBeInTheDocument();
    expect(screen.getByText("หมดช่วงทดลองแล้ว 1")).toBeInTheDocument();
    expect(screen.getByText("การชำระเงิน 2 รายการรอตรวจ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ตรวจ" })).toHaveAttribute("href", "/payments");
    expect(screen.getByText("1 Workspace ค้างชำระ")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "ดูลูกค้า" })[0]).toHaveAttribute("href", "/workspaces?status=past_due");
  });

  it("Support ไม่เห็นปุ่มไปตรวจการชำระเงิน", async () => {
    asRole("support");
    view();
    expect(await screen.findByText("1 Workspace ค้างชำระ")).toBeInTheDocument();
    expect(screen.queryByText("การชำระเงิน 2 รายการรอตรวจ")).not.toBeInTheDocument();
  });

  it("ไม่มีเรื่องต้องดูแล: สถานะว่าง", async () => {
    server.use(http.get(`${OPS}/metrics`, () => HttpResponse.json(emptyMetrics)));
    view();
    expect(await screen.findByText("ไม่มีเรื่องต้องดูแลวันนี้")).toBeInTheDocument();
  });

  it("กำลังโหลด", async () => {
    server.use(
      http.get(`${OPS}/metrics`, async () => {
        await delay("infinite");
        return HttpResponse.json(emptyMetrics);
      }),
    );
    view();
    expect(await screen.findByText("ภาพรวมธุรกิจ")).toBeInTheDocument();
    expect(screen.getByLabelText("กำลังโหลด…")).toHaveAttribute("aria-busy", "true");
  });

  it("Error พร้อมรหัสอ้างอิง", async () => {
    server.use(http.get(`${OPS}/metrics`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req-metrics-9")));
    view();
    expect(await screen.findByText("รหัสอ้างอิง: req-metrics-9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ลองอีกครั้ง" })).toBeInTheDocument();
  });
});
