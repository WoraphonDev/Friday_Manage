import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { payId, payments, whtId } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { Shell } from "../shell/Shell";
import { Payments } from "./Payments";

const view = () => {
  navigation.pathname = "/payments";
  return renderWithProviders(
    <Shell>
      <Payments />
    </Shell>,
  );
};
const queries: string[] = [];
function list(items = payments) {
  queries.length = 0;
  server.use(
    http.get(`${OPS}/payments`, ({ request }) => {
      queries.push(new URL(request.url).search);
      return HttpResponse.json({ items });
    }),
  );
}

describe("ตรวจสลิปและ 50 ทวิ", () => {
  it("แสดงสลิปและ 50 ทวิที่รอตรวจ พร้อมลิงก์ไฟล์", async () => {
    list();
    view();
    const slip = await screen.findByTestId(`slip-${payId}`);
    expect(within(slip).getByText("สลิปโอน")).toBeInTheDocument();
    expect(within(slip).getByText("฿3,120")).toBeInTheDocument();
    expect(within(slip).getByText(/โอนเงิน · ใบแจ้งหนี้ ฿3,210 · หัก ณ ที่จ่าย ฿90/)).toBeInTheDocument();
    expect(within(slip).getByRole("link", { name: "ดูไฟล์" })).toHaveAttribute("href", `/ops-api/payments/${payId}/slip`);
    const wht = screen.getByTestId(`wht-${whtId}`);
    expect(within(wht).getByText("หนังสือรับรองการหักภาษี ณ ที่จ่าย ฿90", { exact: false })).toBeInTheDocument();
    expect(within(wht).getByRole("link", { name: "ดูไฟล์" })).toHaveAttribute("href", `/ops-api/wht-certificates/${whtId}/file`);
    expect(queries[0]).toBe("?status=pending_review");
  });

  it("ยอดในสลิปไม่ตรงยอดที่ต้องชำระ: เตือนในแถว", async () => {
    list([{ ...payments[0], amount: 150_000, whtCertificates: [] }]);
    view();
    expect(await screen.findByText(/ยอดไม่ตรงใบแจ้งหนี้ \(ต้องชำระ ฿3,120\)/)).toBeInTheDocument();
  });

  it("ยืนยันรับเงิน → ผลแสดงในแถว", async () => {
    list();
    let confirmed = "";
    server.use(
      http.post(`${OPS}/payments/:id/confirm`, ({ params }) => {
        confirmed = String(params.id);
        return HttpResponse.json({ id: params.id, status: "confirmed" });
      }),
    );
    view();
    const slip = await screen.findByTestId(`slip-${payId}`);
    await userEvent.click(within(slip).getByRole("button", { name: "ยืนยันรับเงิน" }));
    expect(await within(slip).findByText("ผ่าน · ออกใบกำกับภาษีแล้ว")).toBeInTheDocument();
    expect(confirmed).toBe(payId);
  });

  it("ไม่ผ่าน: ต้องมีเหตุผล · เลิกสิทธิ์แพ็กเกจชั่วคราวแสดงในผล", async () => {
    list();
    let body: unknown;
    server.use(
      http.post(`${OPS}/payments/:id/reject`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: payId, status: "rejected", revoked: true });
      }),
    );
    view();
    const slip = await screen.findByTestId(`slip-${payId}`);
    await userEvent.click(within(slip).getByRole("button", { name: "ไม่ผ่าน" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "ไม่ผ่าน" }));
    expect(within(dialog).getByText("ระบุเหตุผลอย่างน้อย 3 ตัวอักษร")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("เหตุผล"), "ยอดในสลิปไม่ตรง");
    await userEvent.click(within(dialog).getByRole("button", { name: "ไม่ผ่าน" }));
    expect(await within(slip).findByText("ไม่ผ่าน · เลิกสิทธิ์แพ็กเกจชั่วคราวแล้ว")).toBeInTheDocument();
    expect(body).toEqual({ reason: "ยอดในสลิปไม่ตรง" });
  });

  it("50 ทวิ: รับเอกสาร และปฏิเสธพร้อมเหตุผล", async () => {
    list();
    let confirmed = "";
    let rejectBody: unknown;
    server.use(
      http.post(`${OPS}/wht-certificates/:id/confirm`, ({ params }) => {
        confirmed = String(params.id);
        return HttpResponse.json({ id: params.id, status: "confirmed" });
      }),
      http.post(`${OPS}/wht-certificates/:id/reject`, async ({ request }) => {
        rejectBody = await request.json();
        return opsError(409, "already_reviewed", "ตรวจ 50 ทวิ ฉบับนี้แล้ว");
      }),
    );
    view();
    const wht = await screen.findByTestId(`wht-${whtId}`);
    await userEvent.click(within(wht).getByRole("button", { name: "ไม่ผ่าน" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("เหตุผล"), "เลขผู้เสียภาษีไม่ตรง");
    await userEvent.click(within(dialog).getByRole("button", { name: "ไม่ผ่าน" }));
    expect(await within(dialog).findByText("ตรวจ 50 ทวิ ฉบับนี้แล้ว")).toBeInTheDocument();
    expect(rejectBody).toEqual({ reason: "เลขผู้เสียภาษีไม่ตรง" });
    await userEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await userEvent.click(within(wht).getByRole("button", { name: "รับเอกสาร" }));
    expect(await within(wht).findByText("รับเอกสารแล้ว")).toBeInTheDocument();
    expect(confirmed).toBe(whtId);
  });

  it("ดูสถานะอื่น: ไม่มีปุ่มตรวจ แสดงสถานะ", async () => {
    list();
    view();
    await screen.findByTestId(`slip-${payId}`);
    list([{ ...payments[0], status: "confirmed", whtCertificates: [{ id: whtId, status: "confirmed", createdAt: payments[0].createdAt }] }]);
    await userEvent.selectOptions(screen.getByLabelText("สถานะ"), "confirmed");
    await waitFor(() => expect(queries.at(-1)).toBe("?status=confirmed"));
    const slip = await screen.findByTestId(`slip-${payId}`);
    expect(within(slip).getByText("ยืนยันแล้ว")).toBeInTheDocument();
    expect(within(slip).queryByRole("button", { name: "ยืนยันรับเงิน" })).not.toBeInTheDocument();
  });

  it("ไม่มีรายการ: สถานะว่าง", async () => {
    list([]);
    view();
    expect(await screen.findByText("ไม่มีรายการ")).toBeInTheDocument();
  });

  it("ops-api ตอบ 403 forbidden: แสดงหน้าไม่มีสิทธิ์ตาม details.need", async () => {
    server.use(http.get(`${OPS}/payments`, () => opsError(403, "forbidden", "ไม่มีสิทธิ์ทำรายการนี้", { role: "support", need: ["finance"] })));
    view();
    expect(await screen.findByText("ไม่มีสิทธิ์เข้าหน้านี้")).toBeInTheDocument();
    expect(screen.getByText(/หน้านี้สำหรับบทบาท Finance/)).toBeInTheDocument();
  });

  it("Support เปิดหน้านี้ตรง ๆ: ไม่มีสิทธิ์ และไม่เรียก ops/payments", async () => {
    asRole("support");
    let called = false;
    server.use(
      http.get(`${OPS}/payments`, () => {
        called = true;
        return HttpResponse.json({ items: [] });
      }),
    );
    view();
    expect(await screen.findByText("บทบาท Support ดูหน้านี้ไม่ได้")).toBeInTheDocument();
    expect(called).toBe(false);
  });
});
