import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { RefundsPage } from "../refunds/RefundsPage";
import { BillingPage } from "./BillingPage";

const ws = { id: "w1", slug: "orbit", name: "Orbit Apps" };
const exc = (over: Record<string, unknown> = {}) => ({
  id: "p1", reason: "wht_not_declared", suggestion: "ขอ 50 ทวิ จากลูกค้า", method: "transfer", expectedSatang: 321_000, receivedSatang: 312_000, hasSlip: true, waitingSince: new Date().toISOString(),
  invoice: { id: "i1", number: "FRI-2611-0001", status: "pending_review", amountDue: 321_000, dueDate: "2026-11-20" }, workspace: ws,
  timeline: [{ at: new Date().toISOString(), action: "billing.slip_uploaded", actorKind: "user", summary: "แนบสลิป" }], ...over,
});
const base = (items = [exc()]) =>
  server.use(
    http.get(`${OPS}/payments/exceptions`, () => HttpResponse.json({ items, payments30d: 120 })),
    http.get(`${OPS}/payments`, () => HttpResponse.json({ items: [{ id: "p9", method: "transfer", amount: 107_000, hasSlip: true, createdAt: new Date().toISOString(), exceptionReason: null, invoice: { id: "i9", number: "FRI-2611-0009", amountDue: 107_000 }, workspace: { id: "w9", name: "Kanit Labs" } }] })),
    http.get(`${OPS}/overdue`, () => HttpResponse.json({ items: [{ id: "i5", number: "FRI-2611-0005", amountDue: 321_000, dueDate: "2026-11-02", daysOverdue: 8, workspace: { name: "Pixel Forge" }, events: [], reminders: { email: 3, line: 1, phone: 0 }, nextStep: { day: 14, step: "suspended", on: "2026-11-16" }, needsHuman: true }], totalSatang: 321_000 })),
  );
const page = (search = "") => {
  navigation.pathname = "/payments";
  navigation.search = search;
  return renderWithProviders(
    <AppShell>
      <BillingPage />
    </AppShell>,
  );
};
const reauth = () => {
  let ok = false;
  server.use(
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((ok = true), HttpResponse.json({ reauthed: true }))),
  );
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  return () => ok;
};

describe("กรณีผิดปกติ", () => {
  it("คิวแสดงยอดที่ต้องได้ / ได้รับ · แผงตัดสินผ่าน", async () => {
    asRole("finance");
    base();
    let confirmed = false;
    server.use(http.post(`${OPS}/payments/p1/confirm`, () => ((confirmed = true), HttpResponse.json({ status: "confirmed" }))));
    page();
    expect(await screen.findByText("จาก 120 รายการใน 30 วัน ระบบยืนยันเองได้ · เหลือกรณีผิดปกติ 1 รายการ")).toBeInTheDocument();
    expect(screen.getByText("฿3,210")).toBeInTheDocument();
    expect(screen.getByText("฿3,120")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "หัก ณ ที่จ่ายไม่ได้แจ้ง" }));
    const panel = await screen.findByRole("dialog", { name: /หัก ณ ที่จ่ายไม่ได้แจ้ง · Orbit Apps/ });
    expect(within(panel).getByText(/แนบสลิป/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "ผ่าน" }));
    await waitFor(() => expect(confirmed).toBe(true));
  });

  it("ไม่ผ่าน (B6) ส่งข้อความถึงลูกค้า · ผูกใบอื่น (B7) บอกยอดเกิน / ขาด", async () => {
    asRole("finance");
    base([exc({ reason: "unmatched", receivedSatang: 400_000 })]);
    let match: Record<string, unknown> = {};
    let reject: Record<string, unknown> = {};
    server.use(
      http.get(`${OPS}/invoices`, () => HttpResponse.json({ items: [{ id: "i2", number: "FRI-2611-0002", status: "open", amountDue: 321_000, dueDate: "2026-12-01", workspace: { id: "w1" } }], total: 1 })),
      http.post(`${OPS}/payments/p1/match`, async ({ request }) => ((match = (await request.json()) as Record<string, unknown>), HttpResponse.json({ settled: true }))),
      http.post(`${OPS}/payments/p1/reject`, async ({ request }) => ((reject = (await request.json()) as Record<string, unknown>), HttpResponse.json({ status: "rejected" }))),
    );
    page();
    await userEvent.click(await screen.findByRole("button", { name: "เงินเข้าไม่มีใบแจ้งหนี้" }));
    let panel = await screen.findByRole("dialog", { name: /Orbit Apps/ });
    await userEvent.click(within(panel).getByRole("button", { name: "ผูกกับใบแจ้งหนี้อื่น" }));
    const b7 = await screen.findByRole("dialog", { name: "เลือกใบแจ้งหนี้ให้เงินเข้า ฿4,000" });
    expect(await within(b7).findByText("เกิน ฿790")).toBeInTheDocument();
    await userEvent.click(within(b7).getByRole("radio"));
    await userEvent.type(within(b7).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "Ref.1 ตรงกับใบนี้");
    await userEvent.click(within(b7).getByRole("button", { name: "ผูกและผ่าน" }));
    await waitFor(() => expect(match).toEqual({ invoiceId: "i2", reason: "Ref.1 ตรงกับใบนี้" }));

    await userEvent.click(await screen.findByRole("button", { name: "เงินเข้าไม่มีใบแจ้งหนี้" }));
    panel = await screen.findByRole("dialog", { name: /Orbit Apps/ });
    await userEvent.click(within(panel).getByRole("button", { name: "ไม่ผ่าน · แจ้งลูกค้า" }));
    const b6 = await screen.findByRole("dialog", { name: "แจ้ง Orbit Apps ว่าสลิปไม่ผ่าน" });
    await userEvent.click(within(b6).getByRole("button", { name: "ส่งถึงลูกค้า" }));
    await waitFor(() => expect(reject).toMatchObject({ reason: "เงินเข้าไม่มีใบแจ้งหนี้", message: expect.stringContaining("สลิปที่ส่งมาตรวจไม่ผ่าน") }));
  });

  it("จ่ายซ้ำ: ไม่มีปุ่มผ่าน · เก็บเป็นเครดิต", async () => {
    asRole("finance");
    base([exc({ reason: "double_payment", receivedSatang: 321_000, invoice: { id: "i1", number: "FRI-2611-0001", status: "paid", amountDue: 321_000, dueDate: "2026-11-20" } })]);
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/payments/p1/to-credit`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ creditSatang: 321_000 }))));
    page();
    await userEvent.click(await screen.findByRole("button", { name: "จ่ายซ้ำ" }));
    const panel = await screen.findByRole("dialog", { name: /จ่ายซ้ำ/ });
    expect(within(panel).queryByRole("button", { name: "ผ่าน" })).not.toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText(/เหตุผล/), "ลูกค้าจ่ายซ้ำ เก็บไว้รอบหน้า");
    await userEvent.click(within(panel).getByRole("button", { name: "เก็บเป็นเครดิต" }));
    await waitFor(() => expect(body).toEqual({ reason: "ลูกค้าจ่ายซ้ำ เก็บไว้รอบหน้า" }));
  });

  it("ผู้ตรวจอ่านได้แต่ตัดสินไม่ได้ · Support เปิดหน้านี้ไม่ได้", async () => {
    asRole("auditor");
    base();
    page();
    expect(await screen.findByText("Kanit Labs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ผ่าน" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /สร้างใบแจ้งหนี้ด้วยมือ/ })).not.toBeInTheDocument();
  });

  it("Support เปิดตรง ๆ ไม่ได้", async () => {
    asRole("support");
    base();
    page();
    expect(await screen.findByText("บทบาท Support ดูหน้านี้ไม่ได้")).toBeInTheDocument();
  });
});

describe("ใบแจ้งหนี้ ค้างชำระ ภาษี รายได้", () => {
  const invoices = () =>
    server.use(
      http.get(`${OPS}/invoices`, () => HttpResponse.json({ items: [{ id: "i3", number: "FRI-2611-0003", status: "paid", total: 321_000, whtAmount: 0, amountDue: 321_000, poNumber: "PO-1", dueDate: "2026-11-01", paidAt: "2026-10-30", workspace: ws, taxDocumentStatus: "issued", hasCreditNote: false }], total: 1 })),
      http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [ws], total: 1, limit: 6, offset: 0, sort: "newest" })),
    );

  it("สร้างใบแจ้งหนี้ (B1): คำนวณยอดตามรายการ ส่วนลด หัก ณ ที่จ่าย", async () => {
    asRole("finance");
    base();
    invoices();
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/invoices`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ invoice: { number: "FRI-2611-0010" }, sent: 2 }, { status: 201 }))));
    page("tab=invoices");
    await userEvent.click(await screen.findByRole("button", { name: /สร้างใบแจ้งหนี้ด้วยมือ/ }));
    const d = await screen.findByRole("dialog", { name: "สร้างใบแจ้งหนี้" });
    await userEvent.type(within(d).getByLabelText("Workspace"), "orbit");
    await userEvent.click(await within(d).findByRole("button", { name: /Orbit Apps/ }));
    await userEvent.type(within(d).getByLabelText("รายละเอียด 1"), "ค่าอบรม");
    await userEvent.type(within(d).getByLabelText("ราคา/หน่วย (บาท)"), "10000");
    await userEvent.click(within(d).getByLabelText("ลูกค้าหัก ณ ที่จ่าย 3%"));
    // 10,000 + VAT 700 − 300 = 10,400
    expect(within(within(d).getByRole("table", { name: "ยอดชำระ" })).getByText("฿10,400")).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "ออกและส่งให้ลูกค้า" }));
    await waitFor(() => expect(body).toMatchObject({ workspaceId: "w1", items: [{ description: "ค่าอบรม", qty: 1, unitSatang: 1_000_000 }], wht: true, discountPct: 0, send: true }));
  });

  it("ยกเลิกใบที่ชำระแล้ว (B2) แบบคืนเงินเกินวงเงิน → ส่งขออนุมัติ (G7)", async () => {
    asRole("finance");
    base();
    invoices();
    server.use(http.post(`${OPS}/invoices/i3/void`, () => HttpResponse.json({ pendingApproval: { id: "ap", kind: "billing.refund", reason: "x", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), amountSatang: 321_000, payload: { rule: "คืนเงินเกิน ฿10,000" }, canSelfApprove: false } }, { status: 202 })));
    page("tab=invoices");
    const rowEl = (await screen.findByText("FRI-2611-0003")).closest("tr")!;
    await userEvent.click(within(rowEl).getByRole("button", { name: "ยกเลิก" }));
    const d = await screen.findByRole("dialog", { name: "ยกเลิก FRI-2611-0003?" });
    await userEvent.click(within(d).getByRole("radio", { name: /^คืนเงิน ·/ }));
    await userEvent.type(within(d).getByLabelText("สาเหตุ (แสดงในใบลดหนี้)"), "ยกเลิกสัญญา");
    await userEvent.click(within(d).getByRole("button", { name: "ยกเลิกใบแจ้งหนี้" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
  });

  it("ค้างชำระ: บันทึกการโทรต้องมีผล (B3) · ขยายเวลา (B4)", async () => {
    asRole("finance");
    base();
    let contact: Record<string, unknown> = {};
    let extend: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/invoices/i5/contact`, async ({ request }) => ((contact = (await request.json()) as Record<string, unknown>), HttpResponse.json({ ok: true }))),
      http.post(`${OPS}/invoices/i5/extend`, async ({ request }) => ((extend = (await request.json()) as Record<string, unknown>), HttpResponse.json({ ok: true }))),
    );
    page("tab=overdue");
    expect(await screen.findByText("ต้องให้คนดู")).toBeInTheDocument();
    expect(screen.getByText("อีเมล 3 · LINE 1 · โทร 0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ติดต่อ" }));
    const d = await screen.findByRole("dialog", { name: "ติดต่อ Pixel Forge" });
    await userEvent.click(within(d).getByRole("button", { name: "บันทึกการโทร" }));
    const save = within(d).getByRole("button", { name: "บันทึก / ส่ง" });
    expect(save).toBeDisabled();
    await userEvent.type(within(d).getByLabelText("ผลการติดต่อ"), "ไม่มีคนรับ");
    await userEvent.click(save);
    await waitFor(() => expect(contact).toEqual({ channel: "phone", result: "ไม่มีคนรับ" }));
    await userEvent.click(screen.getByRole("button", { name: "ขยายเวลา" }));
    const e = await screen.findByRole("dialog", { name: "ขยายเวลาชำระ Pixel Forge" });
    await userEvent.type(within(e).getByLabelText("ครบกำหนดใหม่"), "2026-11-20");
    await userEvent.type(within(e).getByLabelText("เหตุผล"), "รอ PO จากฝ่ายจัดซื้อ");
    await userEvent.click(within(e).getByRole("button", { name: "ขยายเวลา" }));
    await waitFor(() => expect(extend).toEqual({ dueDate: "2026-11-20", reason: "รอ PO จากฝ่ายจัดซื้อ", notify: true }));
  });

  it("ภาษี: ส่ง e-Tax ใหม่ · สรุปภาษีขาย", async () => {
    asRole("finance");
    base();
    let retried = false;
    server.use(
      http.get(`${OPS}/tax`, () => HttpResponse.json({ etax: [{ id: "d1", number: "TX-2611-0001", docType: "tax_invoice_receipt", status: "failed", createdAt: "2026-11-01", invoice: "FRI-2611-0001", workspace: ws }], wht: [], whtPendingSatang: 0, salesVat: { month: "2026-11", vatRegistered: true, invoices: 4, subtotalSatang: 1_200_000, vatSatang: 84_000, whtSatang: 0, creditNoteVatSatang: 7_000, netVatSatang: 77_000 } })),
      http.post(`${OPS}/tax-documents/d1/retry`, () => ((retried = true), HttpResponse.json({ status: "pending" }))),
    );
    page("tab=tax");
    expect(await screen.findByText("฿770")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ส่งใหม่" }));
    await waitFor(() => expect(retried).toBe(true));
  });

  it("รายงานรายได้: ปิดงวดต้องแตะกุญแจ · ส่งออก (B8) เป็นลิงก์ไฟล์ของ ops-api", async () => {
    asRole("finance");
    base();
    const ok = reauth();
    let closed = "";
    server.use(
      http.get(`${OPS}/revenue`, () => HttpResponse.json({ months: [{ month: "2026-10", recognizedSatang: 1_000_000, cashSatang: 900_000, vatSatang: 63_000, whtSatang: 0, feesSatang: 0, refundsSatang: 0, deferredSatang: 0, closed: false }, { month: "2099-12", recognizedSatang: 0, cashSatang: 0, vatSatang: 0, whtSatang: 0, feesSatang: 0, refundsSatang: 0, deferredSatang: 0, closed: false }] })),
      http.post(`${OPS}/revenue/close`, async ({ request }) => (ok() ? ((closed = ((await request.json()) as { month: string }).month), HttpResponse.json({ closed: true })) : opsError(401, "reauth_required", "แตะ Security key"))),
    );
    page("tab=revenue");
    await userEvent.click(await screen.findByRole("button", { name: "ปิดงวด" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "ปิดงวด 2026-10?" })).getByRole("button", { name: "ยืนยัน" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(closed).toBe("2026-10"));
    let sent: unknown = null;
    server.use(
      http.get(`${OPS}/revenue/export/delivery`, () => HttpResponse.json({ recipients: ["acc@office.example.com"], autoDay: 5, history: [{ at: "2026-11-05T02:00:00Z", month: "2026-10", detail: "x", staffName: null }] })),
      http.post(`${OPS}/revenue/export/send`, async ({ request }) => ((sent = await request.json()), HttpResponse.json({ sent: 1, to: ["acc@office.example.com"] }))),
    );
    await userEvent.click(screen.getByRole("button", { name: "ส่งออกรายงานให้บัญชี" }));
    const d = await screen.findByRole("dialog", { name: "ส่งออกให้สำนักงานบัญชี" });
    expect(await within(d).findByText("ส่งถึง acc@office.example.com")).toBeInTheDocument();
    expect(within(d).getByText(/ส่งอัตโนมัติทุกวันที่ 5/)).toBeInTheDocument();
    expect(within(d).getByText(/โดย ระบบอัตโนมัติ/)).toBeInTheDocument();
    expect(within(d).getByRole("link", { name: "ดาวน์โหลดใบลดหนี้ (CSV)" }).getAttribute("href")).toMatch(/^\/ops-api\/revenue\/export\?month=\d{4}-\d{2}&type=credit_notes$/);
    // ส่งเฉพาะรายการขายและใบลดหนี้
    await userEvent.click(within(d).getByLabelText("50 ทวิ ที่ได้รับ (CSV)"));
    await userEvent.click(within(d).getByRole("button", { name: "ส่งอีเมล" }));
    await waitFor(() => expect(sent).toMatchObject({ types: ["sales", "credit_notes"] }));
    expect(await screen.findByText("ส่งไฟล์ถึง acc@office.example.com แล้ว")).toBeInTheDocument();
  });

  it("ส่งออก (B8): ยังไม่ตั้งอีเมลสำนักงานบัญชี → ดาวน์โหลดได้อย่างเดียว · ผู้ตรวจไม่มีปุ่มส่ง", async () => {
    asRole("auditor");
    base();
    server.use(
      http.get(`${OPS}/revenue`, () => HttpResponse.json({ months: [] })),
      http.get(`${OPS}/revenue/export/delivery`, () => HttpResponse.json({ recipients: [], autoDay: 5, history: [] })),
    );
    page("tab=revenue");
    await userEvent.click(await screen.findByRole("button", { name: "ส่งออกรายงานให้บัญชี" }));
    const d = await screen.findByRole("dialog", { name: "ส่งออกให้สำนักงานบัญชี" });
    expect(await within(d).findByText(/ยังไม่ได้ตั้งอีเมลสำนักงานบัญชี/)).toBeInTheDocument();
    expect(within(d).queryByRole("button", { name: "ส่งอีเมล" })).not.toBeInTheDocument();
  });
});

describe("คืนเงินและอนุมัติ", () => {
  const refunds = () =>
    server.use(
      http.get(`${OPS}/refunds`, () =>
        HttpResponse.json({
          pending: [{ id: "ap-1", kind: "billing.refund", amountSatang: 1_400_000, reason: "ลูกค้าย้ายไปใช้เครื่องมืออื่น", requestedBy: "การเงินตัวอย่าง", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
          history: [{ id: "h1", at: "2026-11-05", type: "refund", ref: "CN-2611-0001", reason: "ชดเชยระบบล่ม", amountSatang: 107_000, requestedBy: "การเงินตัวอย่าง", approvedBy: null, invoice: "FRI-2611-0001", workspace: ws }],
        }),
      ),
    );
  const view = () => {
    navigation.pathname = "/refunds";
    return renderWithProviders(
      <AppShell>
        <RefundsPage />
      </AppShell>,
    );
  };

  it("Owner อนุมัติ (แตะกุญแจ) · ไม่อนุมัติต้องใส่เหตุผล", async () => {
    refunds();
    const ok = reauth();
    let approved = false;
    let note = "";
    server.use(
      http.post(`${OPS}/approvals/ap-1/approve`, () => (ok() ? ((approved = true), HttpResponse.json({ approval: {} })) : opsError(401, "reauth_required", "แตะ Security key"))),
      http.post(`${OPS}/approvals/ap-1/reject`, async ({ request }) => ((note = ((await request.json()) as { note: string }).note), HttpResponse.json({ approval: {} }))),
    );
    view();
    const card = await screen.findByRole("article", { name: "คืนเงิน" });
    expect(within(card).getByText("คืนเงิน · ฿14,000")).toBeInTheDocument();
    expect(screen.getByText("CN-2611-0001")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "อนุมัติ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(approved).toBe(true));
    await userEvent.click(within(card).getByRole("button", { name: "ไม่อนุมัติ" }));
    const d = await screen.findByRole("dialog", { name: /ไม่อนุมัติ/ });
    await userEvent.type(within(d).getByLabelText("เหตุผลที่ไม่อนุมัติ (ผู้ขอเห็น)"), "ให้เป็นเครดิตแทน");
    await userEvent.click(within(d).getByRole("button", { name: "ไม่อนุมัติ" }));
    await waitFor(() => expect(note).toBe("ให้เป็นเครดิตแทน"));
  });

  it("การเงินขอคืนเงินอ้างใบแจ้งหนี้ที่ชำระแล้ว · ไม่มีปุ่มอนุมัติ", async () => {
    asRole("finance");
    refunds();
    let body: Record<string, unknown> = {};
    server.use(
      http.get(`${OPS}/invoices`, () => HttpResponse.json({ items: [{ id: "i3", number: "FRI-2611-0003", amountDue: 321_000, workspace: ws }], total: 1 })),
      http.post(`${OPS}/refunds`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ creditNote: { number: "CN-2611-0002" } }))),
    );
    view();
    const card = await screen.findByRole("article", { name: "คืนเงิน" });
    expect(within(card).queryByRole("button", { name: "อนุมัติ" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /ขอคืนเงิน \/ ให้เครดิต/ }));
    const d = await screen.findByRole("dialog", { name: "ประเภท" });
    await userEvent.type(within(d).getByLabelText("ใบแจ้งหนี้ที่ชำระแล้ว"), "FRI");
    await userEvent.click(await within(d).findByRole("button", { name: /FRI-2611-0003/ }));
    await userEvent.type(within(d).getByLabelText("ยอด (บาท · รวม VAT)"), "1070");
    await userEvent.type(within(d).getByLabelText("เหตุผล (ลูกค้าเห็นในใบลดหนี้)"), "ชดเชยนำเข้า Excel ล่ม");
    await userEvent.click(within(d).getByRole("button", { name: "ส่งขออนุมัติ" }));
    await waitFor(() => expect(body).toEqual({ invoiceId: "i3", amountSatang: 107_000, method: "bank_transfer", reason: "ชดเชยนำเข้า Excel ล่ม" }));
    expect(await screen.findByText("ออกใบลดหนี้ CN-2611-0002 แล้ว")).toBeInTheDocument();
  });
});
