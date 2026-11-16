// รอบ 4 · O40 · แท็บใบกำกับภาษี / 50 ทวิ (E1–E4, E6–E9) · ข้อมูลสมมติเท่านั้น
import { startAuthentication } from "@simplewebauthn/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { BillingPage } from "./BillingPage";

const ws = (name: string, slug = name.toLowerCase().replace(/\s/g, "-")) => ({ id: `w-${slug}`, slug, name });
const now = new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const day = (n: number) => new Date(Date.now() + 7 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

const etaxItems = [
  { id: "j1", docKind: "tax_document", docId: "d1", number: "TX-2611-0047", docLabel: "ใบกำกับภาษี/ใบเสร็จ", workspace: ws("Kanok Logistics"), action: "issue", state: "failed", jobStatus: "failed", problem: "E-102 · เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก", attempts: 3, maxAttempts: 3, nextAttemptAt: null, at: now, submittedAt: null, replacement: null },
  { id: "j2", docKind: "tax_document", docId: "d31", number: "TX-2611-0031", docLabel: "ใบกำกับภาษี/ใบเสร็จ", workspace: ws("Lumen Studio"), action: "cancel", state: "cancel_pending", jobStatus: "pending", problem: "503 · ผู้ให้บริการปิดปรับปรุง", attempts: 2, maxAttempts: 3, nextAttemptAt: new Date(Date.now() + 600_000).toISOString(), at: now, submittedAt: null, replacement: "TX-2611-0052" },
  { id: "j3", docKind: "credit_note", docId: "c2", number: "CN-2611-0002", docLabel: "ใบลดหนี้", workspace: ws("Orbit Apps"), action: "issue", state: "waiting", jobStatus: "submitted", problem: null, attempts: 1, maxAttempts: 3, nextAttemptAt: null, at: ago(2), submittedAt: ago(2), replacement: null },
];
const whtItem = (over: Record<string, unknown>) => ({
  invoice: { id: "i21", number: "FRI-2611-0021", subtotal: 1_500_000 }, workspace: ws("Kanok Logistics"), whtAmount: 45_000, paidAt: ago(24 * 14), paidOn: day(-14), dueBy: day(16), daysLeft: 16,
  state: "waiting", certificate: null, requests: { count: 1, lastAt: ago(24 * 7), lastKind: "auto_7", today: false }, nextAuto: null, ...over,
});
const whtItems = [
  whtItem({}),
  whtItem({ invoice: { id: "i18", number: "FRI-2611-0018", subtotal: 3_000_000 }, workspace: ws("Orbit Apps"), whtAmount: 90_000, state: "review", certificate: { id: "c18", status: "pending_review", source: "upload", at: ago(20), rejectReason: null, ewhtRef: null, decidedAt: null, hasFile: true }, requests: { count: 0, lastAt: null, lastKind: null, today: false } }),
  whtItem({ invoice: { id: "i44", number: "FRI-2610-0044", subtotal: 1_000_000 }, workspace: ws("TechNova"), whtAmount: 30_000, dueBy: day(-1), daysLeft: -1, state: "overdue", requests: { count: 2, lastAt: ago(24), lastKind: "auto_30", today: false } }),
  whtItem({ invoice: { id: "i09", number: "FRI-2611-0009", subtotal: 5_000_000 }, workspace: ws("Bangsue Data"), whtAmount: 50_000, state: "received", certificate: { id: "c09", status: "confirmed", source: "ewht", at: ago(48), rejectReason: null, ewhtRef: "EWHT-1", decidedAt: ago(48), hasFile: false }, requests: { count: 0, lastAt: null, lastKind: null, today: false } }),
];
const overview = (over: Record<string, unknown> = {}) => ({
  month: day(0).slice(0, 7), closed: false, vatRegistered: true,
  kpi: {
    sales: { value: 26_330_000, vat: 1_843_100, tx: 61, rc: 0, dn: 1, cn: 2 },
    etax: { total: 64, done: 60, failed: 1, waiting: 2, pending: 0, cancelPending: 1, numbers: [] },
    wht: { total: 14, received: 9, waiting: 2, review: 1, overdue: 1, ewht: 1 },
    whtYear: { year: 2026, satang: 2_187_000 },
  },
  etax: { items: etaxItems, counts: { all: 3, failed: 1, cancel: 1, waiting: 1 } },
  wht: { items: whtItems, counts: { follow: 3, waiting: 1, review: 1, overdue: 1, ewht: 0, received: 1 } },
  sales: {
    lines: [
      { kind: "tax_invoice", count: 61, cancelled: 1, replaced: 1, first: "TX-2611-0001", last: "TX-2611-0062", value: 26_500_000, vat: 1_855_000 },
      { kind: "debit_note", count: 1, cancelled: 0, replaced: 0, first: "DN-2611-0001", last: "DN-2611-0001", value: 150_000, vat: 10_500 },
      { kind: "credit_note", count: 2, cancelled: 0, replaced: 0, first: "CN-2611-0001", last: "CN-2611-0002", value: -320_000, vat: -22_400 },
    ],
    net: { value: 26_330_000, vat: 1_843_100, total: 28_173_100 },
    checks: [
      { ok: true, level: "ok", code: "numbers", params: { range: "TX 0001–0062 · CN 0001–0002 · DN 0001" }, text: "" },
      { ok: false, level: "bad", code: "etax", params: { n: 4, numbers: "x" }, text: "" },
      { ok: true, level: "ok", code: "replacements", params: { n: 1 }, text: "" },
      { ok: false, level: "warn", code: "wht", params: { n: 3, amount: 195_000 }, text: "" },
      { ok: false, level: "warn", code: "zero_invoices", params: { n: 2 }, text: "" },
    ],
    rows: 64,
  },
  ...over,
});
const base = (data = overview()) =>
  server.use(
    http.get(`${OPS}/payments/exceptions`, () => HttpResponse.json({ items: [], payments30d: 0 })),
    http.get(`${OPS}/overdue`, () => HttpResponse.json({ items: [], totalSatang: 0 })),
    http.get(`${OPS}/tax`, () => HttpResponse.json(data)),
  );
const page = () => {
  navigation.pathname = "/payments";
  navigation.search = "tab=tax";
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

describe("E1 · การ์ดสรุปและรายงานภาษีขาย", () => {
  it("การ์ด 4 ช่อง · รายงานภาษีขายนับคู่ยกเลิก / ออกแทนครั้งเดียว · รายการตรวจก่อนปิดงวด", async () => {
    asRole("finance");
    base();
    page();
    expect(await screen.findByText("฿18,431.00")).toBeInTheDocument();
    expect(screen.getByText("ขาย 61 · เพิ่มหนี้ 1 · ลดหนี้ 2")).toBeInTheDocument();
    expect(screen.getByText("60 / 64 ฉบับ")).toBeInTheDocument();
    expect(screen.getByText("ล้ม 1 · รอผล 2 · รอแจ้งยกเลิก 1")).toBeInTheDocument();
    expect(screen.getByText("9 / 14 ใบ")).toBeInTheDocument();
    expect(screen.getByText("฿21,870.00")).toBeInTheDocument();
    const sales = screen.getByRole("table", { name: /^รายงานภาษีขาย · / });
    expect(within(sales).getByText("TX-2611-0001 – 0062")).toBeInTheDocument();
    expect(within(sales).getByText("ฉบับที่ยกเลิกแล้วออกแทนนับครั้งเดียว (1 คู่)")).toBeInTheDocument();
    expect(within(sales).getByText("18,431.00")).toBeInTheDocument();
    const checks = screen.getByRole("list", { name: "ตรวจก่อนปิดงวด" });
    expect(within(checks).getByText("เลขเอกสารต่อเนื่อง · TX 0001–0062 · CN 0001–0002 · DN 0001")).toBeInTheDocument();
    expect(within(checks).getByText("e-Tax ยังไม่ครบ 4 ฉบับ")).toBeInTheDocument();
    expect(within(checks).getByText("50 ทวิ ยังไม่ได้รับ 3 ใบ ฿1,950.00 (ไม่บล็อกการปิดงวด)")).toBeInTheDocument();
    expect(within(checks).getByText("ใบแจ้งหนี้ ฿0 จากคูปอง 2 ใบ ไม่ออกเอกสารภาษี จึงไม่อยู่ในรายงาน")).toBeInTheDocument();
  });

  it("ปิดงวดที่ e-Tax ยังไม่ครบต้องกรอกเหตุผลและแตะกุญแจ", async () => {
    asRole("finance");
    const last = (() => {
      const d = new Date(`${day(0).slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    base(overview({ month: last }));
    const ok = reauth();
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/revenue/close`, async ({ request }) => (ok() ? ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ closed: true })) : opsError(401, "reauth_required", "แตะ Security key"))));
    page();
    await screen.findByText("60 / 64 ฉบับ");
    fireEvent.change(screen.getByLabelText("เดือนของรายงาน"), { target: { value: last } });
    await userEvent.click(await screen.findByRole("button", { name: /^ปิดงวด / }));
    const d = await screen.findByRole("dialog", { name: /^ปิดงวด / });
    expect(within(d).getByText("e-Tax ของงวดนี้ยังไม่ครบ 4 ฉบับ · ปิดได้แต่ต้องกรอกเหตุผล")).toBeInTheDocument();
    const submit = within(d).getByRole("button", { name: "ปิดงวด" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(d).getByLabelText("เหตุผลที่ปิดงวดทั้งที่ e-Tax ยังไม่ครบ"), "ผู้ให้บริการปิดปรับปรุง ตามส่งเดือนหน้า");
    await userEvent.click(submit);
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(body).toEqual({ month: last, reason: "ผู้ให้บริการปิดปรับปรุง ตามส่งเดือนหน้า" }));
  });
});

describe("E1–E4 · เอกสาร e-Tax ที่ต้องดู", () => {
  it("ตารางเดียวทุกชนิด · ปุ่มตามสถานะ: ส่งใหม่ · แจ้งอีกครั้ง · ตรวจสถานะ · ขอข้อมูลใหม่", async () => {
    asRole("finance");
    base();
    const calls: { url: string; body: unknown }[] = [];
    const record = async ({ request }: { request: Request }) => (calls.push({ url: new URL(request.url).pathname, body: await request.json().catch(() => null) }), HttpResponse.json({ status: "pending", sent: 1 }));
    server.use(http.post(`${OPS}/etax/:kind/:id/:op`, record), http.post(`${OPS}/tax-documents/:id/request-info`, record));
    page();
    const table = await screen.findByRole("table", { name: "เอกสาร e-Tax ที่ต้องดู" });
    const row = (n: string) => within(table).getByText(n).closest("tr")!;
    expect(within(row("TX-2611-0047")).getByText("E-102 · เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ครบ 13 หลัก")).toBeInTheDocument();
    expect(within(row("TX-2611-0047")).getByText("ลองแล้ว 3 ครั้ง")).toBeInTheDocument();
    expect(within(row("TX-2611-0031")).getByText("ยกเลิก → TX-2611-0052")).toBeInTheDocument();
    expect(within(row("TX-2611-0031")).getByText("แจ้งยกเลิกไม่สำเร็จ: 503 · ผู้ให้บริการปิดปรับปรุง")).toBeInTheDocument();
    expect(within(row("TX-2611-0031")).getByText(/ครั้งที่ 3 จาก 3/)).toBeInTheDocument();
    expect(within(row("CN-2611-0002")).getByText("ใบลดหนี้")).toBeInTheDocument();
    await userEvent.click(within(row("TX-2611-0047")).getByRole("button", { name: "ส่งใหม่" }));
    await userEvent.click(within(row("TX-2611-0031")).getByRole("button", { name: "แจ้งอีกครั้ง" }));
    await userEvent.click(within(row("CN-2611-0002")).getByRole("button", { name: "ตรวจสถานะ" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual([
      { url: "/ops-api/etax/tax-document/d1/retry", body: { action: "issue" } },
      { url: "/ops-api/etax/tax-document/d31/retry", body: { action: "cancel" } },
      { url: "/ops-api/etax/credit-note/c2/check", body: {} },
    ]);
    await userEvent.click(within(row("TX-2611-0047")).getByRole("button", { name: "ขอข้อมูลใหม่" }));
    const info = await screen.findByRole("dialog", { name: "ขอข้อมูลออกใบกำกับภาษีใหม่ · TX-2611-0047" });
    await userEvent.click(within(info).getByRole("button", { name: "ส่งอีเมล" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/ops-api/tax-documents/d1/request-info", body: {} }));
    // ตัวกรอง
    await userEvent.click(screen.getByRole("button", { name: "รอแจ้งยกเลิก 1" }));
    expect(within(screen.getByRole("table", { name: "เอกสาร e-Tax ที่ต้องดู" })).getAllByRole("row")).toHaveLength(2);
  });

  it("E2 Drawer: ข้อมูลที่ล็อก ลำดับเหตุการณ์ งานที่ล้ม · E4 ยกเลิกที่ผู้ให้บริการแล้วต้องแตะกุญแจ", async () => {
    asRole("finance");
    base();
    const ok = reauth();
    let manual: unknown = null;
    server.use(
      http.get(`${OPS}/etax/tax-document/d31`, () =>
        HttpResponse.json({
          kind: "tax_document", id: "d31", number: "TX-2611-0031", docLabel: "ใบกำกับภาษี/ใบเสร็จ", status: "cancelled", cancelled: true, cancelReason: "ชื่อบริษัทผิด", issuedOn: "2026-11-03", providerRef: "ETX-88231",
          invoice: { id: "i31", number: "FRI-2611-0012", status: "paid", paidAt: now }, workspace: ws("Lumen Studio"), amount: { value: 1_200_000, vat: 84_000, total: 1_284_000 },
          buyer: { companyName: "บริษัท ลูเมน สตูดิโอ จำกัด", taxId: "0105559000001", branchType: "head", branchNo: null, address: "88/12" }, currentBuyer: null,
          replacement: { id: "d52", number: "TX-2611-0052", status: "issued", createdAt: now }, replaces: null,
          jobs: [{ id: "j2", action: "cancel", status: "pending", attempts: 2, maxAttempts: 3, lastError: "503 · ผู้ให้บริการปิดปรับปรุง", lastAttemptAt: now, nextAttemptAt: new Date(Date.now() + 600_000).toISOString(), providerRef: null, note: null }],
          state: { issue: "issued", cancel: "pending" },
          timeline: [{ at: now, action: "ops.tax_document_replaced", summary: "ยกเลิก TX-2611-0031 · ออกฉบับใหม่ TX-2611-0052 แทน", by: "ต้น", system: false }],
          pdf: "/tax-documents/d31/pdf",
        }),
      ),
      http.post(`${OPS}/etax/tax-document/d31/cancel-manual`, async ({ request }) => (ok() ? ((manual = await request.json()), HttpResponse.json({ status: "manual" })) : opsError(401, "reauth_required", "แตะ Security key"))),
    );
    page();
    const table = await screen.findByRole("table", { name: "เอกสาร e-Tax ที่ต้องดู" });
    await userEvent.click(within(table).getByRole("button", { name: "TX-2611-0031" }));
    const d = await screen.findByRole("dialog", { name: "TX-2611-0031 · ใบกำกับภาษี/ใบเสร็จ" });
    expect(await within(d).findByText("ยกเลิกในระบบแล้ว")).toBeInTheDocument();
    expect(within(d).getByText("รอแจ้งยกเลิกที่ผู้ให้บริการ")).toBeInTheDocument();
    expect(within(d).getByText(/บริษัท ลูเมน สตูดิโอ จำกัด · สำนักงานใหญ่/)).toBeInTheDocument();
    expect(within(d).getByText("ETX-88231")).toBeInTheDocument();
    expect(within(d).getByText("แจ้งยกเลิกที่ผู้ให้บริการ · ล้ม 2 ครั้ง")).toBeInTheDocument();
    expect(within(d).getByText(/ผลจากผู้ให้บริการที่มาหลังยกเลิก/)).toBeInTheDocument();
    expect(within(d).getByRole("link", { name: "ดาวน์โหลด PDF" })).toHaveAttribute("href", "/ops-api/tax-documents/d31/pdf");
    await userEvent.click(within(d).getByRole("button", { name: "ยกเลิกที่ผู้ให้บริการแล้ว" }));
    const e4 = await screen.findByRole("dialog", { name: "บันทึกว่ายกเลิกที่ผู้ให้บริการแล้ว" });
    await userEvent.type(within(e4).getByLabelText("เลขอ้างอิงการยกเลิกจากผู้ให้บริการ"), "CNL-2611-00418");
    await userEvent.type(within(e4).getByLabelText("เหตุผล"), "ผู้ให้บริการปิดปรับปรุงนาน ยกเลิกผ่านหน้าเว็บแทน");
    await userEvent.click(within(e4).getByRole("button", { name: "บันทึก" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(manual).toEqual({ reference: "CNL-2611-00418", reason: "ผู้ให้บริการปิดปรับปรุงนาน ยกเลิกผ่านหน้าเว็บแทน" }));
  });

  it("Owner / ผู้ตรวจอ่านอย่างเดียว: ไม่มีปุ่มส่งใหม่ ขอ 50 ทวิ หรือนำเข้า", async () => {
    asRole("auditor");
    base();
    page();
    const table = await screen.findByRole("table", { name: "เอกสาร e-Tax ที่ต้องดู" });
    expect(within(table).queryByRole("button", { name: "ส่งใหม่" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "นำเข้าไฟล์ e-WHT" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ขออีกครั้ง" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ประวัติ e-Tax ทั้งเดือน" })).toBeInTheDocument();
  });
});

describe("E7–E9 · 50 ทวิ", () => {
  it("ตาราง: รอรับ (ขอแล้วกี่ครั้ง) · รอตรวจ · เลยกำหนด · e-WHT ปิดเอง · E7 ขออีกครั้ง", async () => {
    asRole("finance");
    base();
    let body: unknown = null;
    server.use(
      http.get(`${OPS}/wht/i21`, () => HttpResponse.json({ ...whtItems[0], contacts: [{ email: "finance@kanok.example", name: null, role: "accounting" }, { email: "anan@kanok.example", name: "อนันต์ ก.", role: "owner" }], history: [{ kind: "auto_7", at: ago(24 * 7) }] })),
      http.post(`${OPS}/wht/i21/request`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ sent: ["finance@kanok.example"] }))),
    );
    page();
    const table = await screen.findByRole("table", { name: "หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ)" });
    const row = (n: string) => within(table).getByText(n).closest("tr")!;
    expect(within(row("FRI-2611-0021")).getByText("รอรับ")).toBeInTheDocument();
    expect(within(row("FRI-2611-0021")).getByText(/ขอแล้ว 1 ครั้ง · .* \(อัตโนมัติ\)/)).toBeInTheDocument();
    expect(within(row("FRI-2611-0021")).getByText("อีก 16 วัน")).toBeInTheDocument();
    expect(within(row("FRI-2610-0044")).getByText("เลยมา 1 วัน")).toBeInTheDocument();
    expect(within(row("FRI-2610-0044")).getByRole("button", { name: "ปิดว่าไม่ได้รับ" })).toBeInTheDocument();
    expect(within(row("FRI-2611-0018")).getByRole("button", { name: "ผ่าน" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ได้รับแล้ว 1" }));
    expect(await screen.findByText("e-WHT · ปิดเอง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ต้องติดตาม 3" }));
    await userEvent.click(within(row("FRI-2611-0021")).getByRole("button", { name: "ขออีกครั้ง" }));
    const d = await screen.findByRole("dialog", { name: "ขอ 50 ทวิ อีกครั้ง" });
    expect(await within(d).findByLabelText(/ผู้ติดต่อด้านบัญชี · finance@kanok.example/)).toBeChecked();
    expect(within(d).getByLabelText(/อนันต์ ก. · Owner · anan@kanok.example/)).not.toBeChecked();
    expect(within(d).getByText(/เรื่อง: ขอหนังสือรับรองการหักภาษี ณ ที่จ่าย \(50 ทวิ\) · FRI-2611-0021/)).toBeInTheDocument();
    await userEvent.type(within(d).getByLabelText("ข้อความเพิ่มเติม (ไม่บังคับ)"), "ต้องใช้ปิดงวด");
    await userEvent.click(within(d).getByRole("button", { name: "ส่งคำขอ" }));
    await waitFor(() => expect(body).toEqual({ recipients: ["finance@kanok.example"], message: "ต้องใช้ปิดงวด" }));
  });

  it("E8 ไม่ผ่านพร้อมสาเหตุ · อื่น ๆ ต้องกรอกเอง · ปิดว่าไม่ได้รับต้องมีเหตุผล", async () => {
    asRole("finance");
    base();
    const sent: { url: string; body: unknown }[] = [];
    const record = async ({ request }: { request: Request }) => (sent.push({ url: new URL(request.url).pathname, body: await request.json() }), HttpResponse.json({ status: "ok" }));
    server.use(http.post(`${OPS}/wht-certificates/c18/reject`, record), http.post(`${OPS}/wht/i44/close`, record));
    page();
    const table = await screen.findByRole("table", { name: "หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ)" });
    await userEvent.click(within(within(table).getByText("FRI-2611-0018").closest("tr")!).getByRole("button", { name: "ไม่ผ่าน" }));
    const d = await screen.findByRole("dialog", { name: "50 ทวิ ไม่ผ่าน" });
    await userEvent.click(within(d).getByLabelText(/^อื่น ๆ/));
    expect(within(d).getByRole("button", { name: "ยืนยันไม่ผ่าน" })).toBeDisabled();
    await userEvent.click(within(d).getByLabelText(/ยอดเงินได้หรือภาษีที่หักไม่ตรงกับใบแจ้งหนี้/));
    await userEvent.click(within(d).getByRole("button", { name: "ยืนยันไม่ผ่าน" }));
    await waitFor(() => expect(sent[0]).toEqual({ url: "/ops-api/wht-certificates/c18/reject", body: { code: "amount_mismatch" } }));
    await userEvent.click(within(within(table).getByText("FRI-2610-0044").closest("tr")!).getByRole("button", { name: "ปิดว่าไม่ได้รับ" }));
    const c = await screen.findByRole("dialog", { name: "ปิดว่าไม่ได้รับ · FRI-2610-0044" });
    expect(within(c).getByRole("button", { name: "ปิดว่าไม่ได้รับ" })).toBeDisabled();
    await userEvent.type(within(c).getByLabelText("เหตุผล"), "ตามแล้วลูกค้าไม่ส่ง");
    await userEvent.click(within(c).getByRole("button", { name: "ปิดว่าไม่ได้รับ" }));
    await waitFor(() => expect(sent[1]).toEqual({ url: "/ops-api/wht/i44/close", body: { reason: "ตามแล้วลูกค้าไม่ส่ง" } }));
  });

  it("E9 นำเข้าไฟล์ e-WHT: ดูผลจับคู่ · จับคู่เอง · ปิดรายการ", async () => {
    asRole("finance");
    base();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${OPS}/wht-ewht/import`, async ({ request }) => {
        const b = (await request.json()) as { matches: Record<string, string>; apply: boolean };
        bodies.push(b);
        const manual = b.matches["3"];
        return HttpResponse.json({
          rows: [
            { line: 2, payerTaxId: "0105561000001", payerName: "Bangsue Data", amount: 50_000, date: day(-2), reference: "EW-1", status: "matched", rate: 1, match: { invoiceId: "i09", number: "FRI-2611-0009", workspace: ws("Bangsue Data") } },
            manual
              ? { line: 3, payerTaxId: "0105560000009", payerName: "บริษัท เอ็มทีเค จำกัด", amount: 9_000, date: day(-9), reference: "EW-2", status: "matched", manual: true, match: { invoiceId: manual, number: "FRI-2610-0044", workspace: ws("TechNova") } }
              : { line: 3, payerTaxId: "0105560000009", payerName: "บริษัท เอ็มทีเค จำกัด", amount: 9_000, date: day(-9), reference: "EW-2", status: "unmatched", match: null },
          ],
          errors: [],
          period: { from: day(-9), to: day(-2) },
          matched: manual ? 2 : 1,
          closed: b.apply ? (manual ? 2 : 1) : 0,
        });
      }),
    );
    page();
    await userEvent.click(await screen.findByRole("button", { name: "นำเข้าไฟล์ e-WHT" }));
    const d = await screen.findByRole("dialog", { name: "นำเข้ารายการ e-Withholding Tax" });
    const file = new File(["payer_tax_id,payer_name,tax_amount,date,reference\n"], "ewht-2569-11.csv", { type: "text/csv" });
    await userEvent.upload(within(d).getByLabelText("เลือกไฟล์"), file);
    expect(await within(d).findByText("FRI-2611-0009")).toBeInTheDocument();
    expect(within(d).getByText("ไม่พบใบแจ้งหนี้")).toBeInTheDocument();
    expect(within(d).getByText("1% e-WHT")).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "จับคู่เอง" }));
    await userEvent.selectOptions(within(d).getByLabelText("เลือกใบแจ้งหนี้"), "i44");
    expect(await within(d).findByText("FRI-2610-0044")).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "ปิด 2 รายการ" }));
    await waitFor(() => expect(bodies.at(-1)).toMatchObject({ apply: true, matches: { "3": "i44" }, filename: "ewht-2569-11.csv" }));
    expect(await screen.findByText("ปิด 50 ทวิ ด้วย e-WHT 2 รายการ")).toBeInTheDocument();
  });
});

describe("E6 · ตั้งค่าผู้รับและวันส่ง", () => {
  it("เพิ่ม / ลบอีเมล (สูงสุด 5) · วันที่ 1–15 · รอปิดงวดหรือส่งฉบับร่าง · ทดลองส่งถึงอีเมลของฉัน", async () => {
    asRole("finance");
    base();
    let saved: unknown = null;
    let tested: unknown = null;
    server.use(
      http.get(`${OPS}/revenue/export/delivery`, () =>
        HttpResponse.json({ settings: { recipients: ["old@office.example.com"], auto: true, day: 5, time: "09:00", whenOpen: "wait", files: { salesTax: true, wht: true, zip: false }, source: "env" }, recipients: ["old@office.example.com"], autoDay: 5, next: null, closedMonths: [], history: [] }),
      ),
      http.put(`${OPS}/accounting/settings`, async ({ request }) => ((saved = await request.json()), HttpResponse.json({ ok: true }))),
      http.post(`${OPS}/accounting/settings/test`, async ({ request }) => ((tested = await request.json()), HttpResponse.json({ to: ["fin@friday.example.com"] }))),
    );
    page();
    await userEvent.click(await screen.findByRole("button", { name: "ส่งออกรายงานให้บัญชี" }));
    await userEvent.click(await within(await screen.findByRole("dialog", { name: "ส่งออกให้สำนักงานบัญชี" })).findByRole("button", { name: "ตั้งค่าผู้รับและวันส่ง" }));
    const d = await screen.findByRole("dialog", { name: "ตั้งค่าการส่งสำนักงานบัญชี" });
    expect(within(d).getByText(/ตอนนี้ใช้ค่าเดิมจาก environment/)).toBeInTheDocument();
    const input = within(d).getByLabelText("อีเมลผู้รับ");
    await userEvent.type(input, "not-an-email{Enter}");
    expect(within(d).getByText("อีเมลไม่ถูกต้อง")).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "account@sompong-acc.example{Enter}");
    await userEvent.click(within(d).getByRole("button", { name: "ลบ old@office.example.com" }));
    await userEvent.selectOptions(within(d).getByLabelText("วันที่ส่ง"), "7");
    expect(within(d).getAllByRole("option").filter((o) => o.parentElement === within(d).getByLabelText("วันที่ส่ง"))).toHaveLength(15);
    await userEvent.click(within(d).getByLabelText(/ส่งฉบับร่างตามกำหนด/));
    await userEvent.click(within(d).getByLabelText("เอกสารภาษีทั้งเดือน ZIP"));
    await userEvent.click(within(d).getByRole("button", { name: "ทดลองส่งถึงอีเมลของฉัน" }));
    await waitFor(() => expect(tested).toEqual({ types: ["sales_tax", "wht", "zip"] }));
    await userEvent.click(within(d).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(saved).toEqual({ recipients: ["account@sompong-acc.example"], auto: true, day: 7, time: "09:00", whenOpen: "draft", files: { salesTax: true, wht: true, zip: true } }));
  });
});
