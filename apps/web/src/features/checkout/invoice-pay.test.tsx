// W22b · หน้าชำระใบแจ้งหนี้ (โอน + แนบสลิป) · ข้อมูลสมมติเท่านั้น (ไม่มีเลขบัญชี / เลขผู้เสียภาษีจริง)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import checkoutMessages from "../../../messages/th/checkout.json";
import type { InvoiceDetail } from "../../../app/work/[ws]/billing/_components/types";
import { formatDate, today } from "@/lib/format";
import { InvoicePay } from "./InvoicePay";

// ผู้ให้บริการบัตรปลอม: ช่องแยก 3 ช่อง · confirmCardPayment ตั้งผลได้ต่อ test
const stripe = vi.hoisted(() => ({ enabled: true, confirm: vi.fn(), created: [] as string[], handlers: {} as Record<string, (e: unknown) => void> }));
vi.mock("./stripe", () => ({
  STRIPE_KEY: "pk_test_sample",
  loadStripe: async () =>
    stripe.enabled
      ? {
          elements: () => ({
            create: (type: string) => {
              stripe.created.push(type);
              return { mount: () => undefined, destroy: () => undefined, on: (_: string, h: (e: unknown) => void) => void (stripe.handlers[type] = h) };
            },
          }),
          confirmCardPayment: stripe.confirm,
        }
      : null,
}));

const INV = "11111111-2222-4333-8444-555555555555";
const transfer = { bank: "ธนาคารตัวอย่าง", accountNo: "000-0-00000-0", accountName: "บริษัทตัวอย่าง (ทดสอบ)", reference: "FRI-2611-0001", dueDate: "2026-11-23", amount: 980_000 };
const invoice = (over: Partial<InvoiceDetail> = {}): InvoiceDetail => ({
  id: INV, number: "FRI-2611-0001", periodStart: "2026-11-16", periodEnd: "2026-12-15", subtotal: 915_888, vat: 64_112, total: 980_000, whtAmount: 0, amountDue: 980_000, poNumber: null,
  status: "open", dueDate: "2026-11-23", paidAt: null, createdAt: "2026-11-16T03:00:00Z", method: "transfer", paymentStatus: "pending", hasSlip: false,
  pdfUrl: `/api/v1/w/sample/billing/invoices/${INV}.pdf`, taxDocument: null, whtCertificate: null, whtDueBy: null,
  plan: { code: "team_m", name: "Team M", cycle: "monthly" }, transfer, ...over,
});

let current: InvoiceDetail;
let slips: Record<string, FormDataEntryValue>[];
let pays: { renew?: boolean }[];
let qrRef: number;
let expiresAt: string;
beforeEach(() => {
  current = invoice();
  slips = [];
  pays = [];
  qrRef = 1;
  expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  stripe.enabled = true;
  stripe.created = [];
  stripe.confirm.mockReset();
  stripe.confirm.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
  navigation.pathname = `/work/sample/billing/invoices/${INV}`;
  server.use(
    http.get("*/api/v1/w/:ws/billing/invoices/:id", () => HttpResponse.json(current)),
    http.get("*/api/v1/w/:ws/billing/profile", () => HttpResponse.json({ profile: { companyName: "บริษัท ตัวอย่าง จำกัด", taxId: "0000000000000", branchType: "head", branchNo: null, address: "ที่อยู่ตัวอย่าง", taxEmail: "account@example.com", whtEnabled: false } })),
    http.post("*/api/v1/w/:ws/billing/invoices/:id/slip", async ({ request }) => {
      slips.push(Object.fromEntries((await request.formData()).entries()));
      current = invoice({ status: "pending_review", paymentStatus: "pending_review", hasSlip: true });
      return HttpResponse.json(current, { status: 201 });
    }),
    http.post("*/api/v1/w/:ws/billing/invoices/:id/pay", async ({ request }) => {
      const body = (await request.json()) as { renew?: boolean };
      pays.push(body);
      if (body.renew) {
        qrRef++;
        expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      }
      const base = { invoice: { id: INV, amountDue: current.amountDue }, payment: { id: "pay-1", method: current.method, status: "pending_review", amount: current.amountDue } };
      return HttpResponse.json(current.method === "card" ? { ...base, card: { clientSecret: "pi_sample_secret" } } : { ...base, promptpay: { qrPayload: `00020101SAMPLE-${qrRef}`, expiresAt } });
    }),
  );
});

const asRole = (role: "owner" | "admin" | "member") => server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role }, workspaces[1]] })));
const mount = (replace = false) =>
  renderWithProviders(
    <WorkspaceShell ws="sample">
      <InvoicePay ws="sample" id={INV} replace={replace} />
    </WorkspaceShell>,
    { messages: { checkout: checkoutMessages } },
  );

describe("หน้าชำระใบแจ้งหนี้ (W22b)", () => {
  it("ใบที่รอโอน: ยอด + ครบกำหนด · ① บัญชีคัดลอกได้ · ② แนบสลิป → รอตรวจ ใช้งานได้ทันที", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: /ชำระใบแจ้งหนี้ FRI-2611-0001/ })).toBeInTheDocument();
    expect(screen.getByText("รอชำระ")).toBeInTheDocument();
    expect(screen.getByText("Team M · รายเดือน · ครบกำหนด 23 พ.ย. 2569")).toBeInTheDocument();
    expect(screen.getByText("฿9,800")).toBeInTheDocument();

    const bank = screen.getByRole("region", { name: "โอนเข้าบัญชีนี้" });
    expect(within(bank).getByText("ธนาคารตัวอย่าง")).toBeInTheDocument();
    expect(within(bank).getByText("000-0-00000-0")).toBeInTheDocument();
    expect(within(bank).getByText("9,800.00")).toBeInTheDocument();
    expect(within(bank).getByRole("button", { name: "คัดลอก เลขอ้างอิง" })).toBeInTheDocument();
    expect(within(bank).getByRole("button", { name: "คัดลอก เลขที่บัญชี" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดาวน์โหลดใบแจ้งหนี้ FRI-2611-0001 (PDF)" })).toHaveAttribute("href", `/api/v1/w/sample/billing/invoices/${INV}.pdf`);

    const slip = screen.getByRole("region", { name: "โอนแล้ว? แนบสลิป" });
    const send = within(slip).getByRole("button", { name: "ส่งสลิป" });
    expect(send).toBeDisabled();
    // ยอดที่โอนกรอกยอดใบแจ้งหนี้ไว้ให้ แก้ได้
    expect(within(slip).getByLabelText("ยอดที่โอน (บาท)")).toHaveValue("9,800.00");
    await user.upload(screen.getByLabelText("สลิปการโอน"), new File(["slip"], "slip.png", { type: "image/png" }));
    expect(within(slip).getByText("slip.png")).toBeInTheDocument();
    expect(within(slip).getByRole("button", { name: "เปลี่ยนไฟล์" })).toBeInTheDocument();
    await user.click(send);

    expect(await screen.findByRole("heading", { level: 2, name: "ได้รับสลิปแล้ว ใช้งาน Team M ได้เลย" })).toBeInTheDocument();
    expect(screen.getByText("รอตรวจสลิป")).toBeInTheDocument();
    expect(screen.getByText("ใบกำกับภาษีส่งไปที่ account@example.com หลังตรวจสลิปผ่าน")).toBeInTheDocument();
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ amount: "980000" });
  });

  it("ไฟล์ผิดชนิด / ใหญ่เกิน 5 MB บอกทันทีโดยไม่ส่ง", async () => {
    const user = userEvent.setup({ applyAccept: false });
    mount();
    const input = await screen.findByLabelText("สลิปการโอน");
    await user.upload(input, new File(["x"], "slip.gif", { type: "image/gif" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("แนบได้เฉพาะ JPG, PNG หรือ PDF");
    const big = new File(["x"], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 + 1 });
    await user.upload(input, big);
    expect(await screen.findByRole("alert")).toHaveTextContent("ไฟล์ใหญ่เกิน 5 MB");
    expect(screen.getByRole("button", { name: "ส่งสลิป" })).toBeDisabled();
    expect(slips).toHaveLength(0);
  });

  it("รอตรวจ: แนบสลิปใหม่ได้ · ยกเลิกกลับไปหน้าสถานะ · เปิดจาก ?slip=new เห็นฟอร์มทันที", async () => {
    current = invoice({ status: "pending_review", paymentStatus: "pending_review", hasSlip: true });
    const user = userEvent.setup();
    const { unmount } = mount();
    expect(await screen.findByRole("heading", { level: 2, name: "ได้รับสลิปแล้ว ใช้งาน Team M ได้เลย" })).toBeInTheDocument();
    expect(screen.queryByLabelText("สลิปการโอน")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "แนบสลิปใหม่" }));
    expect(screen.getByRole("region", { name: "โอนเข้าบัญชีนี้" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(screen.getByRole("heading", { level: 2, name: "ได้รับสลิปแล้ว ใช้งาน Team M ได้เลย" })).toBeInTheDocument();
    unmount();

    mount(true);
    expect(await screen.findByRole("region", { name: "โอนแล้ว? แนบสลิป" })).toBeInTheDocument();
  });

  it("ชำระแล้ว: ไม่แสดงบัญชี · ดาวน์โหลดใบกำกับภาษี", async () => {
    current = invoice({ status: "paid", paidAt: "2026-11-17T03:00:00Z", transfer: null, taxDocument: { id: "doc-1", number: "TAX-0001", status: "issued", sentAt: null, pdfUrl: "/api/v1/w/sample/billing/tax-documents/doc-1.pdf" } });
    mount();
    expect(await screen.findByRole("heading", { level: 2, name: "ชำระเงินเรียบร้อย ใช้งาน Team M ได้เลย" })).toBeInTheDocument();
    expect(screen.getByText("ใบกำกับภาษี e-Tax invoice ส่งไปที่ account@example.com แล้ว")).toBeInTheDocument();
    expect(screen.getByText("ใช้ได้ถึง 15 ธ.ค. 2569")).toBeInTheDocument();
    expect(screen.getByText("ชำระแล้ว")).toBeInTheDocument();
    expect(screen.queryByText("000-0-00000-0")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดาวน์โหลดใบเสร็จ / ใบกำกับภาษี" })).toHaveAttribute("href", "/api/v1/w/sample/billing/tax-documents/doc-1.pdf");
  });

  it("ส่งสลิปพร้อมเวลาโอน (ใช้เป็นวันที่ของใบกำกับภาษี)", async () => {
    const user = userEvent.setup();
    mount();
    const when = await screen.findByLabelText("วันเวลาที่โอน");
    await user.clear(when);
    await user.type(when, "2026-11-16T10:42");
    await user.upload(screen.getByLabelText("สลิปการโอน"), new File(["slip"], "slip.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    await screen.findByRole("heading", { level: 2, name: "ได้รับสลิปแล้ว ใช้งาน Team M ได้เลย" });
    expect(slips[0]!.paidAt).toBe(new Date("2026-11-16T10:42").toISOString());
  });

  it("PromptPay: ① QR + นับถอยหลัง ② รอเงินเข้า · หมดอายุสร้างใหม่ในใบเดิม · เงินเข้าแล้วหน้าเปลี่ยนเอง", async () => {
    current = invoice({ method: "promptpay", transfer: null, dueDate: "2026-11-16" });
    const user = userEvent.setup();
    mount();
    const qr = await screen.findByRole("region", { name: "สแกน QR ด้วยแอปธนาคาร" });
    expect(await within(qr).findByRole("img", { name: "QR PromptPay ยอด ฿9,800" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/svg\+xml/));
    expect(within(qr).getByRole("timer")).toHaveTextContent(/หมดอายุใน 1[45]:\d\d/);
    expect(within(qr).getByRole("link", { name: "บันทึกรูป QR" })).toHaveAttribute("download", "promptpay-FRI-2611-0001.svg");
    const wait = screen.getByRole("region", { name: "รอยืนยันอัตโนมัติ" });
    expect(within(wait).getByRole("status")).toHaveTextContent("กำลังรอเงินเข้า…");
    await user.click(within(wait).getByRole("button", { name: "จ่ายแล้ว ตรวจสอบอีกครั้ง" }));
    expect(await within(wait).findByText(/ยังไม่ได้รับเงิน/)).toBeInTheDocument();
    expect(pays).toEqual([{}]);

    // ธนาคารแจ้งยอด → poll เห็น paid แล้วหน้าเปลี่ยนเอง
    current = invoice({ method: "promptpay", status: "paid", paidAt: "2026-11-16T03:05:00Z", transfer: null });
    expect(await screen.findByRole("heading", { level: 2, name: "ชำระเงินเรียบร้อย ใช้งาน Team M ได้เลย" }, { timeout: 6000 })).toBeInTheDocument();
  });

  it("PromptPay: QR หมดอายุ → สร้าง QR ใหม่ในใบเดิม แล้วนับถอยหลังใหม่", async () => {
    current = invoice({ method: "promptpay", transfer: null });
    expiresAt = new Date(Date.now() - 1000).toISOString();
    const user = userEvent.setup();
    mount();
    const qr = await screen.findByRole("region", { name: "สแกน QR ด้วยแอปธนาคาร" });
    expect(await within(qr).findByText("QR หมดอายุ")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "รอยืนยันอัตโนมัติ" })).toHaveTextContent("สร้าง QR ใหม่แล้วสแกนอีกครั้ง");
    await user.click(within(qr).getByRole("button", { name: "สร้าง QR ใหม่" }));
    expect(await within(qr).findByRole("timer")).toHaveTextContent(/หมดอายุใน 1[45]:\d\d/);
    expect(pays).toEqual([{}, { renew: true }]);
    expect(within(qr).getByRole("img")).toBeInTheDocument();
  });

  it("บัตร: ช่องของผู้ให้บริการแยก 3 ช่อง + ชื่อบนบัตร + อีเมล · ไม่ผ่านบอกเหตุผล ลองใหม่ในใบเดิม", async () => {
    current = invoice({ method: "card", transfer: null, dueDate: "2026-11-16" });
    stripe.confirm.mockResolvedValueOnce({ error: { message: "บัตรถูกปฏิเสธ (ทดสอบ)" } });
    const user = userEvent.setup();
    mount();
    const form = await screen.findByRole("region", { name: "ข้อมูลบัตร" });
    await waitFor(() => expect(stripe.created).toEqual(["cardNumber", "cardExpiry", "cardCvc"]));
    expect(within(form).getByText("หมายเลขบัตร")).toBeInTheDocument();
    expect(within(form).getByText("3 หลักหลังบัตร")).toBeInTheDocument();
    expect(within(form).getByLabelText("อีเมล")).toHaveValue("account@example.com");
    const confirm = screen.getByRole("region", { name: "ยืนยันการชำระ" });
    expect(within(confirm).getByText("ต่ออายุอัตโนมัติทุกเดือนด้วยบัตรนี้ · ยกเลิกได้ตลอด")).toBeInTheDocument();
    const pay = within(confirm).getByRole("button", { name: "ชำระ ฿9,800" });
    await user.click(pay);
    expect(within(form).getByText("กรอกช่องนี้")).toBeInTheDocument();
    expect(stripe.confirm).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText("ชื่อบนบัตร"), "SOMCHAI SAMPLE");
    await user.click(pay);
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("บัตรถูกปฏิเสธ (ทดสอบ)");
    expect(stripe.confirm).toHaveBeenCalledWith("pi_sample_secret", expect.objectContaining({ payment_method: expect.objectContaining({ billing_details: { name: "SOMCHAI SAMPLE", email: "account@example.com" } }) }));
    // ลองใหม่ด้วยใบเดิม → ผ่าน · หน้า poll จนชำระแล้ว
    current = invoice({ method: "card", status: "paid", paidAt: "2026-11-16T03:05:00Z", transfer: null });
    await user.click(pay);
    expect(await screen.findByRole("heading", { level: 2, name: "ชำระเงินเรียบร้อย ใช้งาน Team M ได้เลย" }, { timeout: 6000 })).toBeInTheDocument();
    expect(pays).toHaveLength(2);
  });

  it("บัตร: ไม่ได้ตั้งกุญแจผู้ให้บริการ บอกโหมดทดสอบ", async () => {
    current = invoice({ method: "card", transfer: null });
    stripe.enabled = false;
    mount();
    expect(await screen.findByText(/โหมดทดสอบ/)).toBeInTheDocument();
  });

  it("Member เปิดไม่ได้", async () => {
    asRole("member");
    const urls: string[] = [];
    server.use(http.get("*/api/v1/w/:ws/billing/invoices/:id", ({ request }) => (urls.push(request.url), HttpResponse.json(current))));
    mount();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: /ชำระใบแจ้งหนี้/ })).not.toBeInTheDocument();
    expect(urls).toHaveLength(0);
  });
});

describe("50 ทวิ ในหน้าใบแจ้งหนี้ (E11 · รอบ 4)", () => {
  // ใบที่ชำระแล้วแบบหัก ณ ที่จ่าย 3% · กำหนดส่ง = ชำระ + 30 วัน
  const addDays = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const paidWht = (over: Partial<InvoiceDetail> = {}) =>
    invoice({ status: "paid", paymentStatus: "confirmed", paidAt: "2026-11-02T03:00:00Z", subtotal: 1_500_000, vat: 105_000, total: 1_605_000, whtAmount: 45_000, amountDue: 1_560_000, whtDueBy: addDays(16), whtOverdue: false, transfer: null, ...over });
  let whts: { kind: "file" | "ewht"; body: unknown }[];
  beforeEach(() => {
    whts = [];
    server.use(
      http.post("*/api/v1/w/:ws/billing/invoices/:id/wht-certificate", async ({ request }) => {
        whts.push({ kind: "file", body: Object.fromEntries((await request.formData()).entries()) });
        current = paidWht({ whtCertificate: { id: "w1", status: "pending_review", source: "upload", rejectReason: null, ewhtRef: null, uploadedAt: "2026-11-16T07:20:00Z" } });
        return HttpResponse.json(current, { status: 201 });
      }),
      http.post("*/api/v1/w/:ws/billing/invoices/:id/wht-ewht", async ({ request }) => {
        const body = (await request.json()) as { reference: string };
        whts.push({ kind: "ewht", body });
        current = paidWht({ whtCertificate: { id: "w2", status: "pending_ewht", source: "ewht", rejectReason: null, ewhtRef: body.reference, uploadedAt: "2026-11-16T07:20:00Z" } });
        return HttpResponse.json(current, { status: 201 });
      }),
    );
  });

  it("แบนเนอร์กำหนดส่ง · ภาษีที่หัก 3% · สรุปใบแจ้งหนี้ · อัปโหลดไฟล์ → รอตรวจ", async () => {
    current = paidWht();
    const user = userEvent.setup();
    mount();
    const banner = await screen.findByText(`กรุณาส่ง 50 ทวิ ของใบนี้ภายใน ${formatDate(addDays(16), "BE", true)} (อีก 16 วัน) · ยอดถูกหัก ฿450.00`);
    expect(banner).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)" });
    expect(within(card).getByText("฿450.00 (3% ของ ฿15,000.00)")).toBeInTheDocument();
    expect(within(card).getByRole("radio", { name: /อัปโหลดไฟล์ 50 ทวิ/ })).toBeChecked();
    const summary = screen.getByRole("region", { name: "สรุปใบแจ้งหนี้" });
    expect(within(summary).getByText("−฿450.00")).toBeInTheDocument();
    expect(within(summary).getByText("ชำระแล้ว 2 พ.ย. 2569")).toBeInTheDocument();
    const send = within(card).getByRole("button", { name: "ส่ง 50 ทวิ" });
    expect(send).toBeDisabled();
    await user.upload(screen.getByLabelText("ไฟล์ 50 ทวิ"), new File(["wht"], "wht.pdf", { type: "application/pdf" }));
    expect(within(card).getByText("wht.pdf")).toBeInTheDocument();
    await user.click(send);
    expect(await within(card).findByText(/ได้รับไฟล์แล้ว รอตรวจ/)).toBeInTheDocument();
    expect(whts.map((w) => [w.kind, Object.keys(w.body as object)])).toEqual([["file", ["file"]]]);
    expect(screen.queryByText(/กรุณาส่ง 50 ทวิ/)).not.toBeInTheDocument();
  });

  it("หักผ่าน e-Withholding Tax: กรอกเลขอ้างอิง → รอยืนยันจากกรมสรรพากร", async () => {
    current = paidWht();
    const user = userEvent.setup();
    mount();
    const card = await screen.findByRole("region", { name: "หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)" });
    await user.click(within(card).getByRole("radio", { name: /หักผ่าน e-Withholding Tax/ }));
    expect(within(card).getByText("ธนาคารส่งข้อมูลให้กรมสรรพากรแล้ว ไม่ต้องอัปโหลด")).toBeInTheDocument();
    const send = within(card).getByRole("button", { name: "ส่ง 50 ทวิ" });
    await user.type(within(card).getByLabelText("เลขอ้างอิง e-WHT"), "EW");
    expect(send).toBeDisabled();
    await user.type(within(card).getByLabelText("เลขอ้างอิง e-WHT"), "HT-2611-0001");
    await user.click(send);
    expect(await within(card).findByText("รอยืนยันจากกรมสรรพากร")).toBeInTheDocument();
    expect(within(card).getByText("เลขอ้างอิง EWHT-2611-0001")).toBeInTheDocument();
    expect(whts).toEqual([{ kind: "ewht", body: { reference: "EWHT-2611-0001" } }]);
  });

  it("ไม่ผ่าน: เห็นสาเหตุและส่งใหม่ได้ · เลยกำหนดยังส่งได้", async () => {
    current = paidWht({ whtDueBy: addDays(-2), whtOverdue: true, whtCertificate: { id: "w0", status: "rejected", source: "upload", rejectReason: "ยอดเงินได้หรือภาษีที่หักไม่ตรงกับใบแจ้งหนี้", ewhtRef: null, uploadedAt: "2026-11-10T03:00:00Z" } });
    mount();
    expect(await screen.findByText(`เลยกำหนดส่ง 50 ทวิ ของใบนี้ (${formatDate(addDays(-2), "BE", true)}) แล้ว · ยังส่งได้ · ยอดถูกหัก ฿450.00`)).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)" });
    expect(within(card).getByRole("alert")).toHaveTextContent("50 ทวิ ที่ส่งมาไม่ผ่าน: ยอดเงินได้หรือภาษีที่หักไม่ตรงกับใบแจ้งหนี้");
    expect(within(card).getByRole("button", { name: "ส่ง 50 ทวิ" })).toBeInTheDocument();
  });

  it("ได้รับแล้ว / ปิดรายการ ไม่มีฟอร์ม · ใบที่ไม่หัก ณ ที่จ่ายไม่แสดง", async () => {
    current = paidWht({ whtCertificate: { id: "w3", status: "confirmed", source: "ewht", rejectReason: null, ewhtRef: "EW-1", uploadedAt: "2026-11-10T03:00:00Z" } });
    const { unmount } = mount();
    const card = await screen.findByRole("region", { name: "หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)" });
    expect(within(card).getByText(/e-WHT · ยืนยันแล้ว/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "ส่ง 50 ทวิ" })).not.toBeInTheDocument();
    expect(screen.queryByText(/กรุณาส่ง 50 ทวิ/)).not.toBeInTheDocument();
    unmount();
    current = invoice({ status: "paid", paidAt: "2026-11-02T03:00:00Z", transfer: null });
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: /ชำระใบแจ้งหนี้/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)" })).not.toBeInTheDocument();
  });
});
