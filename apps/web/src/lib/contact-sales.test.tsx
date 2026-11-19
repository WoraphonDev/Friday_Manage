// O54 · ฟอร์มติดต่อฝ่ายขาย · ข้อมูลสมมติเท่านั้น
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { ContactSalesPage } from "../../app/(public)/_components/contact-sales";

describe("ฟอร์มติดต่อฝ่ายขาย", () => {
  it("ต้องยินยอมก่อนส่ง · ส่งข้อมูลครบแล้วขึ้นข้อความรับเรื่อง", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.get("*/api/v1/auth/csrf", () => HttpResponse.json({ csrfToken: "t" })),
      http.post("*/api/v1/public/contact-sales", async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ received: true }, { status: 202 }))),
    );
    renderWithProviders(<ContactSalesPage />);
    await userEvent.type(screen.getByLabelText("ชื่อบริษัท"), "บริษัท ลานนาเทค จำกัด");
    await userEvent.type(screen.getByLabelText("ชื่อผู้ติดต่อ"), "คุณวรรณา");
    await userEvent.type(screen.getByLabelText("อีเมลที่ทำงาน"), "wanna@lannatech.example");
    await userEvent.type(screen.getByLabelText("ขนาดทีม (คน)"), "150");
    await userEvent.click(screen.getByLabelText(/SSO/));
    const submit = screen.getByRole("button", { name: "ส่งข้อมูล" });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/ยินยอมให้ทีม Friday ติดต่อกลับ/));
    await userEvent.click(submit);
    expect(await screen.findByText("ได้รับข้อมูลแล้ว")).toBeInTheDocument();
    await waitFor(() => expect(body).toEqual({ company: "บริษัท ลานนาเทค จำกัด", contactName: "คุณวรรณา", email: "wanna@lannatech.example", teamSize: 150, needs: ["sso"], consent: true }));
  });
});
