// O55 · ใบเสนอราคาสำหรับลูกค้า · ข้อมูลสมมติเท่านั้น
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { QuotePage } from "../../app/(public)/_components/quote";

const quote = { number: "QT-2611-0007", company: "บริษัท ลานนาเทค จำกัด", status: "sent", seats: 150, months: 12, pricePerSeatSatang: 33_000, subtotalSatang: 59_400_000, vatSatang: 4_158_000, totalSatang: 63_558_000, entitlements: { sso: true, api_rpm: 600 }, sla: { first: { n: 1, unit: "h" }, resolve: { n: 8, unit: "h" } }, contractStart: null, validUntil: "2026-12-19", acceptedBy: null };

describe("ใบเสนอราคาสำหรับลูกค้า", () => {
  it("แสดงยอด + สิทธิ์ · ตอบรับต้องมีชื่อ ตำแหน่ง และยอมรับ", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.get("*/api/v1/auth/csrf", () => HttpResponse.json({ csrfToken: "t" })),
      http.get("*/api/v1/public/quotes/:token", () => HttpResponse.json(quote)),
      http.post("*/api/v1/public/quotes/:token/accept", async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ ...quote, status: "accepted", acceptedBy: "คุณสมชาย" }))),
    );
    renderWithProviders(<QuotePage token="TokenForTest_0123456789abcd" />);
    expect(await screen.findByRole("heading", { name: "ใบเสนอราคา QT-2611-0007" })).toBeInTheDocument();
    expect(screen.getByText("ถึง บริษัท ลานนาเทค จำกัด")).toBeInTheDocument();
    expect(screen.getByText(/635,580/)).toBeInTheDocument();
    expect(screen.getByText(/SSO · API 600 ครั้ง\/นาที · SLA ตอบครั้งแรก 1 ชม. · แก้ไข 8 ชม./)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "ตอบรับ" });
    await userEvent.type(screen.getByLabelText("ชื่อผู้ลงนาม"), "คุณสมชาย");
    await userEvent.type(screen.getByLabelText("ตำแหน่ง"), "CFO");
    expect(btn).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/ยอมรับราคาและเงื่อนไข/));
    await userEvent.click(btn);
    expect(await screen.findByText("ตอบรับแล้ว")).toBeInTheDocument();
    await waitFor(() => expect(body).toEqual({ name: "คุณสมชาย", title: "CFO", agree: true }));
  });

  it("ลิงก์ผิดบอกไม่พบ", async () => {
    server.use(http.get("*/api/v1/public/quotes/:token", () => HttpResponse.json({ error: { code: "quote_not_found", message: "ไม่พบ" } }, { status: 404 })));
    renderWithProviders(<QuotePage token="WrongToken_0123456789abcdXYZ" />);
    expect(await screen.findByText("ไม่พบใบเสนอราคา หรือลิงก์ถูกเปลี่ยนแล้ว")).toBeInTheDocument();
  });
});
