// W22 · หน้าชำระเงินฝั่งลูกค้า + แบบสอบถามตอนยกเลิก · ข้อมูลสมมติเท่านั้น (ไม่มีเลขบัญชี / เลขผู้เสียภาษีจริง)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import type { Usage } from "@/features/plan-limits";
import checkoutMessages from "../../../messages/th/checkout.json";
import sp from "../../../messages/th/saas-pages.json";
import type { BillingProfile, CheckoutResult, Invoice } from "../../../app/work/[ws]/billing/_components/types";
import { Checkout } from "./Checkout";
import { CancelSurvey } from "./CancelSurvey";

const stripe = vi.hoisted(() => ({ enabled: true, confirm: vi.fn(), mount: vi.fn() }));
vi.mock("./stripe", () => ({
  STRIPE_KEY: "pk_test_sample",
  loadStripe: async () =>
    stripe.enabled ? { elements: () => ({ create: () => ({ mount: stripe.mount, destroy: () => undefined, on: () => undefined }) }), confirmCardPayment: stripe.confirm } : null,
}));

const messages = { checkout: checkoutMessages, "saas-pages": sp };
const plan = (code: string, name: string, seatLimit: number | null, monthly: number | null) => ({ code, name, seatLimit, guestsFree: true, projectLimit: null, storageGbPerMember: 10, priceMonthlySatang: monthly, priceYearlySatang: monthly === null ? null : monthly * 10, contactSales: false, features: [] });
const plansBody = { currency: "THB", vatRate: 0.07, vatIncluded: false, trialDays: 14, yearlyMonths: 10, items: [plan("free", "Free", 5, 0), plan("team_s", "Team S", 10, 150_000), plan("team_m", "Team M", 25, 300_000), plan("team_l", "Team L", 50, 550_000)] };
const PRICE: Record<string, number> = { team_s: 150_000, team_m: 300_000, team_l: 550_000 };
let vatRegistered = true;
function quoteFor(url: URL) {
  const p = url.searchParams.get("plan")!;
  const cycle = url.searchParams.get("cycle") ?? "monthly";
  const wht = url.searchParams.get("wht") === "true";
  const subtotal = PRICE[p]! * (cycle === "yearly" ? 10 : 1);
  const vat = vatRegistered ? Math.round(subtotal * 0.07) : 0;
  const whtAmount = wht ? Math.round(subtotal * 0.03) : 0;
  return { plan: p, planName: p, cycle, wht, subtotal, vat, total: subtotal + vat, whtAmount, amountDue: subtotal + vat - whtAmount, currentPlan: "team_s", vatRegistered, documentType: vatRegistered ? "tax_invoice_receipt" : "receipt" };
}
const usage: Usage = {
  plan: { code: "team_s", name: "Team S" },
  status: "active",
  trial: null,
  seats: { used: 12, limit: 25, ratio: 0.48, over: false },
  projects: { used: 4, limit: null, ratio: 0, over: false },
  storage: { used: 0, limit: null, ratio: 0, over: false, usedGb: 1.2, limitGb: 250 },
  canManageBilling: true,
};
const profileBody: BillingProfile = { companyName: "บริษัท ตัวอย่าง จำกัด", taxId: "0000000000000", branchType: "head", branchNo: null, address: "ที่อยู่ตัวอย่าง", taxEmail: "account@example.com", whtEnabled: false };
const INV = "11111111-2222-4333-8444-555555555555";
const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: INV, number: "FRI-2611-0001", periodStart: "2026-11-06", periodEnd: "2026-12-05", subtotal: 300_000, vat: 21_000, total: 321_000, whtAmount: 0, amountDue: 321_000, poNumber: null,
  status: "open", dueDate: "2026-11-13", paidAt: null, createdAt: "2026-11-06T03:00:00Z", method: "card", paymentStatus: "pending", hasSlip: false,
  pdfUrl: `/api/v1/w/sample/billing/invoices/${INV}.pdf`, taxDocument: null, whtCertificate: null, whtDueBy: null, ...over,
});
const errorBody = (status: number, requestId = "req_w22_001") => HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId } }, { status });

let calls: { method: string; path: string; body: unknown; key: string | null }[];
let currentInvoice: Invoice;
let profile: BillingProfile | null;
const record = async (request: Request) => {
  const url = new URL(request.url);
  const type = request.headers.get("content-type") ?? "";
  const body = type.includes("multipart") ? Object.fromEntries((await request.formData()).entries()) : await request.text().then((t) => (t ? JSON.parse(t) : undefined));
  calls.push({ method: request.method, path: url.pathname.replace("/api/v1", "") + url.search, body, key: request.headers.get("idempotency-key") });
};
const checkoutResult = (method: "card" | "promptpay" | "transfer", body: { wht?: boolean }): CheckoutResult => {
  const { method: _m, paymentStatus: _p, hasSlip: _h, pdfUrl: _u, taxDocument: _t, whtCertificate: _w, whtDueBy: _d, ...inv } = invoice({ whtAmount: body.wht ? 9_000 : 0, amountDue: body.wht ? 312_000 : 321_000 });
  void [_m, _p, _h, _u, _t, _w, _d];
  return {
    invoice: inv,
    payment: { id: "pay-1", method, status: "pending", amount: inv.amountDue },
    ...(method === "card" ? { card: { clientSecret: "pi_sample_secret_sample" } } : {}),
    ...(method === "promptpay" ? { promptpay: { qrPayload: "00020101021230SAMPLEPAYLOAD5303764", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } } : {}),
    ...(method === "transfer" ? { transfer: { bank: "ธนาคารตัวอย่าง", accountNo: "000-0-00000-0", accountName: "บริษัทตัวอย่าง (ทดสอบ)", reference: "FRI-2611-0001", dueDate: "2026-11-13", amount: inv.amountDue } } : {}),
    replayed: false,
  };
};

beforeEach(() => {
  calls = [];
  profile = profileBody;
  vatRegistered = true;
  currentInvoice = invoice();
  stripe.enabled = true;
  stripe.confirm.mockReset();
  stripe.confirm.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
  navigation.pathname = "/work/sample/billing/checkout";
  server.use(
    http.get("*/api/v1/public/plans", () => HttpResponse.json(plansBody)),
    http.get("*/api/v1/w/:ws/usage", () => HttpResponse.json(usage)),
    http.get("*/api/v1/w/:ws/billing/profile", () => HttpResponse.json({ profile })),
    http.put("*/api/v1/w/:ws/billing/profile", async ({ request }) => (await record(request), HttpResponse.json({ profile: calls.at(-1)!.body }))),
    http.get("*/api/v1/w/:ws/billing/quote", ({ request }) => HttpResponse.json(quoteFor(new URL(request.url)))),
    http.post("*/api/v1/w/:ws/billing/checkout", async ({ request }) => {
      await record(request);
      const body = calls.at(-1)!.body as { method: "card" | "promptpay" | "transfer"; wht?: boolean };
      currentInvoice = invoice({ method: body.method });
      return HttpResponse.json(checkoutResult(body.method, body));
    }),
    http.get("*/api/v1/w/:ws/billing/invoices/:id", () => HttpResponse.json(currentInvoice)),
    http.post("*/api/v1/w/:ws/billing/invoices/:id/slip", async ({ request }) => (await record(request), HttpResponse.json({ ...currentInvoice, status: "pending_review", hasSlip: true }))),
  );
});

const asRole = (role: "owner" | "admin" | "member") => server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role }, workspaces[1]] })));
const mount = (props: { plan?: string; cycle?: string } = {}) =>
  renderWithProviders(
    <WorkspaceShell ws="sample">
      <Checkout ws="sample" initialPlan={props.plan} initialCycle={props.cycle} />
    </WorkspaceShell>,
    { messages },
  );
const summary = () => screen.getByRole("complementary", { name: "สรุปยอด" });

describe("ชำระเงิน (W22)", () => {
  it("หน้าตาตาม Canvas: ข้อมูลภาษีเดิม · PromptPay เป็นค่าเริ่มต้น · สรุปยอด VAT", async () => {
    mount({ plan: "team_m" });
    expect(await screen.findByRole("heading", { level: 1, name: /ชำระเงินแพ็กเกจ Team M/ })).toBeInTheDocument();
    expect(screen.getByText("รอชำระ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ย้อนกลับ" })).toHaveAttribute("href", "/work/sample/billing");
    expect(await screen.findByLabelText("ชื่อนิติบุคคล")).toHaveValue("บริษัท ตัวอย่าง จำกัด");
    expect(screen.getByText("ใช้ข้อมูลจากครั้งก่อน แก้ได้")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /PromptPay QR/ })).toHaveAttribute("aria-checked", "true");
    const s = summary();
    expect(within(s).getByText("Team M · รายเดือน")).toBeInTheDocument();
    expect(await within(s).findByText("฿3,000")).toBeInTheDocument();
    expect(within(s).getByText("VAT 7%")).toBeInTheDocument();
    expect(within(s).getByText("฿210")).toBeInTheDocument();
    expect(within(s).getAllByText("฿3,210").length).toBeGreaterThan(0);
    expect(within(s).getByText("ได้ e-Tax invoice ทางอีเมลทันทีที่ชำระ")).toBeInTheDocument();
  });

  it("บัตร: ส่ง profile + checkout พร้อม Idempotency-Key ยืนยันกับผู้ให้บริการแล้ว poll จนชำระแล้ว", async () => {
    server.use(http.get("*/api/v1/w/:ws/billing/invoices/:id", () => HttpResponse.json(invoice({ status: "paid", paidAt: "2026-11-06T03:01:00Z", taxDocument: { id: "tx-1", number: "TX-1", status: "issued", sentAt: null, pdfUrl: "/api/v1/w/sample/billing/tax-documents/tx-1.pdf" } }))));
    const user = userEvent.setup();
    mount({ plan: "team_m" });
    await user.click(await screen.findByRole("radio", { name: /บัตรเครดิต/ }));
    await waitFor(() => expect(stripe.mount).toHaveBeenCalled());
    expect(screen.getByText("ตัดบัตรนี้อัตโนมัติทุกรอบบิล (ยกเลิกได้ทุกเมื่อ)")).toBeInTheDocument();
    await user.type(screen.getByLabelText("เลขที่ใบสั่งซื้อ (PO) ถ้ามี"), "PO-001");
    await user.click(await within(summary()).findByRole("button", { name: "ชำระ ฿3,210" }));
    expect(await screen.findByRole("heading", { level: 1, name: "ชำระเงินเรียบร้อย" })).toBeInTheDocument();
    expect(screen.getByText(/ได้รับยืนยันจากผู้ให้บริการบัตรเมื่อ/)).toBeInTheDocument();
    expect(screen.getByText("ใบกำกับภาษี e-Tax invoice ส่งไปที่ account@example.com แล้ว")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดาวน์โหลดใบเสร็จ / ใบกำกับภาษี" })).toHaveAttribute("href", "/api/v1/w/sample/billing/tax-documents/tx-1.pdf");
    expect(screen.getByRole("link", { name: "กลับไปที่ Workspace" })).toHaveAttribute("href", "/work/sample");
    const [put, post] = calls;
    expect(put).toMatchObject({ method: "PUT", path: "/w/sample/billing/profile", body: { companyName: "บริษัท ตัวอย่าง จำกัด", branchType: "head", branchNo: null, whtEnabled: false } });
    expect(post).toMatchObject({ method: "POST", path: "/w/sample/billing/checkout", body: { plan: "team_m", cycle: "monthly", method: "card", wht: false, poNumber: "PO-001" } });
    expect(post!.key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(stripe.confirm).toHaveBeenCalledWith("pi_sample_secret_sample", expect.objectContaining({ payment_method: expect.objectContaining({ billing_details: { name: "บริษัท ตัวอย่าง จำกัด", email: "account@example.com" } }) }));
  });

  it("Idempotency-Key: ใช้ซ้ำเมื่อ retry หลัง 5xx · ได้ key ใหม่เมื่อเปลี่ยนรายละเอียด", async () => {
    let fail = 1;
    server.use(
      http.post("*/api/v1/w/:ws/billing/checkout", async ({ request }) => {
        await record(request);
        if (fail-- > 0) return errorBody(500, "req_w22_checkout");
        return HttpResponse.json(checkoutResult("card", {}));
      }),
    );
    stripe.confirm.mockResolvedValue({ error: { message: "บัตรถูกปฏิเสธ (ทดสอบ)" } });
    const user = userEvent.setup();
    mount({ plan: "team_s" });
    await user.click(await screen.findByRole("radio", { name: /บัตรเครดิต/ }));
    await user.click(await within(summary()).findByRole("button", { name: "ชำระ ฿1,605" }));
    expect(await within(summary()).findByText(/req_w22_checkout/)).toBeInTheDocument();
    await user.click(within(summary()).getByRole("button", { name: "ชำระ ฿1,605" }));
    expect(await within(summary()).findByText("บัตรถูกปฏิเสธ (ทดสอบ)")).toBeInTheDocument();
    const posts = calls.filter((c) => c.path.endsWith("/checkout"));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.key).toBe(posts[0]!.key);
    // ระหว่างรอชำระเลือกแพ็กเกจไม่ได้ · เปลี่ยนรายละเอียดแล้วเลือกใหม่ = คำขอใหม่
    expect(within(summary()).queryByLabelText("แพ็กเกจ")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เปลี่ยนรายละเอียด" }));
    await user.selectOptions(within(summary()).getByLabelText("แพ็กเกจ"), "team_m");
    await user.click(await within(summary()).findByRole("button", { name: "ชำระ ฿3,210" }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/checkout"))).toHaveLength(3));
    const third = calls.filter((c) => c.path.endsWith("/checkout"))[2]!;
    expect(third.key).not.toBe(posts[0]!.key);
    expect(third.body).toMatchObject({ plan: "team_m" });
  });

  it("ตรวจข้อมูลภาษีก่อนส่ง · ไม่มี profile = ฟอร์มว่าง · บุคคลธรรมดาหัก ณ ที่จ่ายไม่ได้", async () => {
    profile = null;
    const user = userEvent.setup();
    mount();
    const name = await screen.findByLabelText("ชื่อนิติบุคคล");
    expect(name).toHaveValue("");
    // 12 คน → แนะนำ Team M
    expect(within(summary()).getByLabelText("แพ็กเกจ")).toHaveValue("team_m");
    await user.type(screen.getByLabelText("เลขประจำตัวผู้เสียภาษี (13 หลัก)"), "12345");
    await user.selectOptions(screen.getByLabelText("สาขา"), "branch");
    await user.click(await within(summary()).findByRole("button", { name: "สร้าง QR" }));
    expect(screen.getByText("เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก")).toBeInTheDocument();
    expect(screen.getByText("รหัสสาขาต้องเป็นตัวเลข 5 หลัก")).toBeInTheDocument();
    expect(screen.getByText("อีเมลไม่ถูกต้อง")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "บุคคลธรรมดา" }));
    expect(screen.getByLabelText("ชื่อ-นามสกุล")).toBeInTheDocument();
    expect(screen.queryByLabelText("สาขา")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "บริษัทของคุณหักภาษี ณ ที่จ่าย 3%" })).toBeDisabled();
    expect(screen.getByText("บุคคลธรรมดาไม่หักภาษี ณ ที่จ่าย")).toBeInTheDocument();
  });

  it("หัก ณ ที่จ่าย 3% ปิดบัตร · PromptPay QR หน้าเปลี่ยนเองเมื่อเงินเข้า", async () => {
    const user = userEvent.setup();
    mount({ plan: "team_m" });
    await user.click(await screen.findByRole("radio", { name: /บัตรเครดิต/ }));
    await user.click(screen.getByRole("switch", { name: "บริษัทของคุณหักภาษี ณ ที่จ่าย 3%" }));
    // บัตรตัดเต็มยอด → ใช้ไม่ได้ และย้ายไป PromptPay
    const card = screen.getByRole("radio", { name: /บัตรเครดิต/ });
    expect(card).toBeDisabled();
    expect(within(card).getByText("ใช้ไม่ได้เมื่อหัก ณ ที่จ่าย เพราะตัดบัตรเต็มยอด")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /PromptPay QR/ })).toHaveAttribute("aria-checked", "true");
    expect(await within(summary()).findByText("−฿90")).toBeInTheDocument();
    expect(within(summary()).getByText("฿3,120")).toBeInTheDocument();
    await user.click(within(summary()).getByRole("button", { name: "สร้าง QR" }));
    expect(await screen.findByRole("img", { name: "QR PromptPay ยอด ฿3,120" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/svg\+xml/));
    expect(screen.getByRole("status")).toHaveTextContent("รอรับเงิน… หน้านี้จะเปลี่ยนเองเมื่อธนาคารแจ้งยอด ไม่ต้องส่งสลิป");
    expect(screen.getByRole("timer")).toHaveTextContent(/QR หมดอายุใน 1[45]:\d\d นาที/);
    expect(screen.getByRole("link", { name: "บันทึกรูป QR" })).toHaveAttribute("download", "promptpay-FRI-2611-0001.svg");
    expect(screen.getByText(/ใบแจ้งหนี้ FRI-2611-0001/)).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith("/checkout"))!.body).toMatchObject({ method: "promptpay", wht: true });
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ whtEnabled: true });
    await user.click(within(summary()).getByRole("button", { name: "ฉันสแกนจ่ายแล้ว" }));
    expect(await within(summary()).findByText(/ยังไม่ได้รับเงิน/)).toBeInTheDocument();
    // ธนาคารแจ้งยอด → poll เห็น paid แล้วเปลี่ยนหน้าเองโดยไม่ต้องกด
    currentInvoice = invoice({ status: "paid", method: "promptpay", paidAt: "2026-11-06T03:05:00Z" });
    expect(await screen.findByRole("heading", { level: 1, name: "ชำระเงินเรียบร้อย" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/ได้รับยืนยันจากธนาคารผ่าน PromptPay/)).toBeInTheDocument();
    expect(screen.getByText(/ส่ง 50 ทวิ ภายใน 30 วัน/)).toBeInTheDocument();
  });

  it("โอนเข้าบัญชี: เลขบัญชีคัดลอกได้ · ใบแจ้งหนี้ PDF · แนบสลิปพร้อมยอด → รอตรวจและใช้งานได้ทันที", async () => {
    const user = userEvent.setup();
    mount({ plan: "team_m", cycle: "yearly" });
    await user.click(await screen.findByRole("radio", { name: /โอนเข้าบัญชี/ }));
    expect(within(summary()).getByText("Team M · รายปี")).toBeInTheDocument();
    expect((await within(summary()).findAllByText("฿32,100")).length).toBe(2);
    await user.click(within(summary()).getByRole("button", { name: "ขอเลขบัญชี" }));
    expect(await screen.findByText("ธนาคารตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "คัดลอก เลขที่บัญชี" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดาวน์โหลดใบแจ้งหนี้ FRI-2611-0001 (PDF)" })).toHaveAttribute("href", `/api/v1/w/sample/billing/invoices/${INV}.pdf`);
    const send = within(summary()).getByRole("button", { name: "อัปโหลดสลิป" });
    expect(send).toBeDisabled();
    await user.upload(screen.getByLabelText("สลิปการโอน"), new File(["slip"], "slip.png", { type: "image/png" }));
    await user.type(screen.getByLabelText("ยอดที่โอน (บาท)"), "3,210");
    await user.click(send);
    expect(await screen.findByRole("heading", { level: 1, name: "ได้รับสลิปแล้ว ใช้งานได้ทันที" })).toBeInTheDocument();
    expect(screen.getByText("ใบกำกับภาษีส่งไปที่ account@example.com หลังตรวจสลิปผ่าน")).toBeInTheDocument();
    const slip = calls.find((c) => c.path.endsWith("/slip"))!;
    expect(slip.path).toBe(`/w/sample/billing/invoices/${INV}/slip`);
    expect(slip.body).toMatchObject({ amount: "321000" });
    expect(calls.find((c) => c.path.endsWith("/checkout"))!.body).toMatchObject({ method: "transfer", cycle: "yearly", wht: false });
  });

  it("บริษัทยังไม่จด VAT: ซ่อนบรรทัด VAT และใช้คำว่าใบเสร็จ", async () => {
    vatRegistered = false;
    server.use(http.get("*/api/v1/w/:ws/billing/invoices/:id", () => HttpResponse.json(invoice({ status: "paid", vat: 0, total: 300_000, amountDue: 300_000, paidAt: "2026-11-06T03:01:00Z" }))));
    const user = userEvent.setup();
    mount({ plan: "team_m" });
    const s = await screen.findByRole("complementary", { name: "สรุปยอด" });
    expect(await within(s).findByText("ราคาแพ็กเกจ")).toBeInTheDocument();
    expect(within(summary()).queryByText("VAT 7%")).not.toBeInTheDocument();
    expect(within(summary()).getAllByText("฿3,000").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 2, name: "ข้อมูลออกใบเสร็จ" })).toBeInTheDocument();
    expect(screen.getByLabelText("อีเมลรับใบเสร็จ")).toBeInTheDocument();
    expect(within(summary()).getByText("ได้ใบเสร็จทางอีเมลทันทีที่ชำระ")).toBeInTheDocument();
    await user.click(within(summary()).getByRole("button", { name: "สร้าง QR" }));
    expect(await screen.findByText("ใบเสร็จส่งไปที่ account@example.com แล้ว", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("ไม่ได้ตั้งกุญแจผู้ให้บริการบัตร: บอกโหมดทดสอบ", async () => {
    stripe.enabled = false;
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("radio", { name: /บัตรเครดิต/ }));
    expect(await screen.findByText(/โหมดทดสอบ/)).toBeInTheDocument();
  });

  it("สิทธิ์: Member ไม่มีสิทธิ์โดยไม่เรียก API · 403 · 500 มี requestId", async () => {
    asRole("member");
    const urls: string[] = [];
    server.use(http.get("*/api/v1/w/:ws/billing/profile", ({ request }) => (urls.push(request.url), HttpResponse.json({ profile }))));
    const first = mount();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(urls).toHaveLength(0);
    first.unmount();
    asRole("admin");
    server.use(http.get("*/api/v1/w/:ws/billing/profile", () => errorBody(403)));
    const second = mount();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    second.unmount();
    server.use(http.get("*/api/v1/w/:ws/billing/profile", () => errorBody(500, "req_w22_profile")));
    mount();
    expect(await screen.findByText(/req_w22_profile/)).toBeInTheDocument();
  });
});

describe("แบบสอบถามตอนยกเลิก (W22)", () => {
  const open = (isOwner = true) => {
    const onCancelled = vi.fn();
    server.use(
      http.post("*/api/v1/w/:ws/cancellation-feedback", async ({ request }) => (await record(request), HttpResponse.json({ id: "fb-1" }))),
      http.post("*/api/v1/w/:ws/billing/subscription/cancel", async ({ request }) => (await record(request), HttpResponse.json({ status: "canceled" }))),
    );
    renderWithProviders(<CancelSurvey open onOpenChange={() => undefined} base="/w/sample" until="6 ธ.ค. 2569" isOwner={isOwner} onCancelled={onCancelled} />, { messages });
    return onCancelled;
  };

  it("เลือกเหตุผล ฟีเจอร์ที่ขาด แล้วยกเลิก: ส่งแบบสอบถามก่อนยกเลิกจริง", async () => {
    const user = userEvent.setup();
    const onCancelled = open();
    const dlg = await screen.findByRole("dialog", { name: "ยกเลิกแพ็กเกจ?" });
    expect(within(dlg).getByText("ใช้ต่อได้ถึง 6 ธ.ค. 2569 แล้วกลับเป็น Free · ข้อมูลยังอยู่ครบ")).toBeInTheDocument();
    await user.click(within(dlg).getByLabelText("ขาดฟีเจอร์ที่ต้องใช้"));
    await user.type(within(dlg).getByLabelText("ฟีเจอร์ที่ขาด"), "บันทึกเวลา");
    await user.click(within(dlg).getByRole("button", { name: "ยกเลิกแพ็กเกจ" }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
    expect(calls.map((c) => c.path)).toEqual(["/w/sample/cancellation-feedback", "/w/sample/billing/subscription/cancel"]);
    expect(calls[0]!.body).toEqual({ reason: "missing_feature", outcome: "canceled", missingFeature: "บันทึกเวลา" });
  });

  it("ย้ายไปเครื่องมืออื่นแล้วเปลี่ยนใจ: บันทึกว่าอยู่ต่อ ไม่ยกเลิก", async () => {
    const user = userEvent.setup();
    const onCancelled = open();
    const dlg = await screen.findByRole("dialog", { name: "ยกเลิกแพ็กเกจ?" });
    await user.click(within(dlg).getByLabelText("ย้ายไปใช้เครื่องมืออื่น"));
    await user.type(within(dlg).getByLabelText("ย้ายไปใช้อะไร"), "เครื่องมือสมมติ");
    await user.click(within(dlg).getByRole("button", { name: "ใช้ต่อ" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ reason: "switched_tool", outcome: "kept", switchedTo: "เครื่องมือสมมติ" });
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("ไม่ตอบแบบสอบถามก็ยกเลิกได้ · ไม่ใช่ Owner ไม่ส่งแบบสอบถาม", async () => {
    const user = userEvent.setup();
    open(false);
    const dlg = await screen.findByRole("dialog", { name: "ยกเลิกแพ็กเกจ?" });
    await user.click(within(dlg).getByLabelText("ราคาแพงเกินไป"));
    await user.click(within(dlg).getByRole("button", { name: "ยกเลิกแพ็กเกจ" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["/w/sample/billing/subscription/cancel"]));
  });
});
