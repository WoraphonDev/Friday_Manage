// W19 · Landing, ราคา, ชำระเงิน, เกินแพ็กเกจ, กฎหมาย + Cookie · ข้อมูลสมมติเท่านั้น (ไม่มีเลขบัญชี/เลขผู้เสียภาษีจริง)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { AutomationQuotaBanner, FeatureLock, LegalUpdateBanner, PlanLimitHost, UsageBanner, type Usage } from "@/features/plan-limits";
import sp from "../../messages/th/saas-pages.json";
import checkoutMessages from "../../messages/th/checkout.json";
import { Landing, PricingPage } from "../../app/(public)/_components/landing";
import { LegalView } from "../../app/(public)/_components/legal";
import { CONSENT_KEY, CookieConsent } from "../../app/(public)/_components/cookie-consent";
import { SiteFooter } from "../../app/(public)/_components/site";
import { Billing } from "../../app/work/[ws]/billing/_components/billing";
import type { BillingProfile, CheckoutResult, Invoice } from "../../app/work/[ws]/billing/_components/types";

const messages = { "saas-pages": sp, checkout: checkoutMessages };
const TEAM = ["kanban", "table", "calendar", "notifications_in_app", "notifications_email", "gantt", "workload", "sprints", "reports", "import_excel", "automation", "line_oa", "webhooks", "git_integration"];
const plan = (code: string, name: string, seatLimit: number | null, monthly: number | null, over: object = {}) => ({
  code, name, seatLimit, guestsFree: true, projectLimit: null, storageGbPerMember: 10, priceMonthlySatang: monthly, priceYearlySatang: monthly === null ? null : monthly * 10, contactSales: false, features: TEAM, ...over,
});
const plansBody = {
  currency: "THB", vatRate: 0.07, vatIncluded: false, trialDays: 14, yearlyMonths: 10,
  items: [
    plan("free", "Free", 5, 0, { projectLimit: 3, storageGbPerMember: 1, priceYearlySatang: 0, features: TEAM.slice(0, 5) }),
    plan("team_s", "Team S", 10, 150_000),
    plan("team_m", "Team M", 25, 300_000),
    plan("team_l", "Team L", 50, 550_000),
    plan("enterprise", "Enterprise", null, null, { contactSales: true, storageGbPerMember: null }),
  ],
};
const PRICE: Record<string, number> = { team_s: 150_000, team_m: 300_000, team_l: 550_000 };
const NAME: Record<string, string> = { team_s: "Team S", team_m: "Team M", team_l: "Team L" };
function quoteFor(url: URL) {
  const p = url.searchParams.get("plan")!;
  const cycle = url.searchParams.get("cycle") ?? "monthly";
  const wht = url.searchParams.get("wht") === "true";
  const subtotal = PRICE[p] * (cycle === "yearly" ? 10 : 1);
  const vat = Math.round(subtotal * 0.07);
  const whtAmount = wht ? Math.round(subtotal * 0.03) : 0;
  return { plan: p, planName: NAME[p], cycle, wht, subtotal, vat, total: subtotal + vat, whtAmount, amountDue: subtotal + vat - whtAmount, currentPlan: "team_s" };
}
const usage = (over: Partial<Usage> = {}): Usage => ({
  plan: { code: "team_s", name: "Team S" }, status: "active", trial: null,
  seats: { used: 12, limit: 25, ratio: 0.48, over: false },
  projects: { used: 4, limit: null, ratio: 0, over: false },
  storage: { used: 0, limit: null, ratio: 0, over: false, usedGb: 1.2, limitGb: 250 },
  canManageBilling: true, ...over,
});
const profileBody: BillingProfile = { companyName: "บริษัท ตัวอย่าง จำกัด", taxId: "0000000000000", branchType: "head", branchNo: null, address: "ที่อยู่ตัวอย่าง", taxEmail: "account@example.com", whtEnabled: false };
const INV = "11111111-2222-4333-8444-555555555555";
const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: INV, number: "FRI-2611-0001", periodStart: "2026-11-06", periodEnd: "2026-12-05", subtotal: 300_000, vat: 21_000, total: 321_000, whtAmount: 0, amountDue: 321_000, poNumber: null,
  status: "open", dueDate: "2026-11-06", paidAt: null, createdAt: "2026-11-06T03:00:00Z", method: "card", paymentStatus: "pending", hasSlip: false,
  pdfUrl: `/api/v1/w/sample/billing/invoices/${INV}.pdf`, taxDocument: null, whtCertificate: null, whtDueBy: null, ...over,
});
const errorBody = (status: number, requestId = "req_w19_001") => HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId } }, { status });

let calls: { method: string; path: string; body: unknown; key: string | null }[];
let currentInvoice: Invoice;
let profile: BillingProfile | null;
let usageBody: Usage;
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
  usageBody = usage();
  currentInvoice = invoice();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom */
  }
  navigation.pathname = "/work/sample/billing/checkout";
  server.use(
    http.get("*/api/v1/public/plans", () => HttpResponse.json(plansBody)),
    http.get("*/api/v1/w/:ws/usage", () => HttpResponse.json(usageBody)),
    http.get("*/api/v1/w/:ws/billing/profile", () => HttpResponse.json({ profile })),
    http.put("*/api/v1/w/:ws/billing/profile", async ({ request }) => {
      await record(request);
      return HttpResponse.json({ profile: calls.at(-1)!.body });
    }),
    http.get("*/api/v1/w/:ws/billing/quote", ({ request }) => HttpResponse.json(quoteFor(new URL(request.url)))),
    http.post("*/api/v1/w/:ws/billing/checkout", async ({ request }) => {
      await record(request);
      const body = calls.at(-1)!.body as { method: "card" | "promptpay" | "transfer"; wht?: boolean };
      currentInvoice = invoice({ method: body.method });
      return HttpResponse.json(checkoutResult(body.method, body));
    }),
    http.get("*/api/v1/w/:ws/billing/invoices/:id", () => HttpResponse.json(currentInvoice)),
    http.post("*/api/v1/w/:ws/billing/invoices/:id/:kind", async ({ request }) => {
      await record(request);
      return HttpResponse.json({ ...currentInvoice, status: "pending_review", hasSlip: true });
    }),
  );
});

const asRole = (role: "owner" | "admin" | "member" | "guest") =>
  server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role }, workspaces[1]] })));
const mountBilling = (props: { section?: string; plan?: string; cycle?: string } = {}) =>
  renderWithProviders(
    <WorkspaceShell ws="sample">
      <Billing ws="sample" {...props} />
    </WorkspaceShell>,
    { messages },
  );

// ---------------------------------------------------------------------------
// R1 · Landing + ราคา
// ---------------------------------------------------------------------------
describe("Landing + ราคา (R1)", () => {
  it("ฟีเจอร์, ราคาจาก public/plans, ขนาดทีมแนะนำแพ็กเกจ, รายปี, ตารางเปรียบเทียบ, FAQ และลิงก์กฎหมาย", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Landing />, { messages });
    expect(screen.getByRole("heading", { level: 1, name: "วางแผนเป็น Man-Day เห็นงานล้นก่อนส่งงานช้า" })).toBeInTheDocument();
    expect(screen.getByText("Workload ข้ามโปรเจกต์")).toBeInTheDocument();
    const s = await screen.findByRole("article", { name: "Team S" });
    expect(within(s).getByText("฿1,500")).toBeInTheDocument();
    expect(within(s).getByText("สูงสุด 10 คน")).toBeInTheDocument();
    expect(within(s).getByRole("link", { name: "ทดลอง 14 วัน" })).toHaveAttribute("href", "/signup?plan=team_s&cycle=monthly");
    const free = screen.getByRole("article", { name: "Free" });
    expect(within(free).getByText("3 โปรเจกต์")).toBeInTheDocument();
    expect(within(free).getByRole("link", { name: "เริ่มใช้ฟรี" })).toHaveAttribute("href", "/signup");
    const ent = screen.getByRole("article", { name: "Enterprise" });
    expect(within(ent).getByText("ตามสัญญา")).toBeInTheDocument();
    expect(within(ent).getByText("50 คนขึ้นไป")).toBeInTheDocument();
    expect(within(ent).getByRole("link", { name: "ติดต่อฝ่ายขาย" })).toBeInTheDocument();

    // ค่าเริ่มต้น 12 คน → Team M
    expect(screen.getByText("แนะนำ: Team M")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Team M" })).getByText("เหมาะกับทีมคุณ")).toBeInTheDocument();
    const slider = screen.getByLabelText("ทีมคุณมีกี่คน");
    // เลื่อนเป็น 3 คน → Free
    fireEvent.change(slider, { target: { value: "3" } });
    expect(screen.getByText("แนะนำ: Free")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "55" } });
    expect(screen.getByText("แนะนำ: Enterprise")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /รายปี/ }));
    expect(within(screen.getByRole("article", { name: "Team M" })).getByText("฿30,000")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Team M" })).getByText("/ ปี")).toBeInTheDocument();
    expect(screen.getByText("ลด 2 เดือน")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "เปรียบเทียบแพ็กเกจทั้งหมด" });
    const gantt = within(table).getByRole("rowheader", { name: "Gantt, Workload, Sprint" }).parentElement!;
    expect(within(gantt).getAllByRole("cell").map((c) => c.textContent)).toEqual(["–", "✓", "✓", "✓", "✓"]);
    const members = within(table).getByRole("rowheader", { name: "จำนวนคน (ไม่นับ Guest)" }).parentElement!;
    expect(within(members).getAllByRole("cell").map((c) => c.textContent)).toEqual(["5", "10", "25", "50", "50+"]);

    expect(screen.getByText("PromptPay ตัดเงินอัตโนมัติไหม")).toBeInTheDocument();
    const legal = screen.getByRole("navigation", { name: "ข้อกฎหมาย" });
    expect(within(legal).getByRole("link", { name: "ข้อกำหนดการใช้งาน" })).toHaveAttribute("href", "/legal/terms");
    expect(within(legal).getByRole("link", { name: "DPA" })).toHaveAttribute("href", "/legal/dpa");
    expect(screen.getByRole("link", { name: "เข้าสู่ระบบ" })).toHaveAttribute("href", "/login");
  });

  it("ภาพ Hero สลับ 4 มุมมองได้เอง และภาพเล็กของการ์ดฟีเจอร์ครบตั้งแต่โหลด (ไม่ต้องรอ animation)", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<Landing />, { messages });
    const preview = screen.getByRole("group", { name: "ภาพตัวอย่างหน้าจอ Kanban, Timeline, Gantt และ Workload" });
    expect(within(preview).getByRole("button", { name: "Kanban" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(preview).getByRole("button", { name: "Workload" }));
    expect(within(preview).getByRole("button", { name: "Workload" })).toHaveAttribute("aria-pressed", "true");
    expect(within(preview).getByRole("button", { name: "Kanban" })).toHaveAttribute("aria-pressed", "false");

    // หัวข้อไม่มีแท็ก <hl> หลุดออกมา และคำที่ขีดเส้นใต้อยู่ในหัวข้อ
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("วางแผนเป็น Man-Day เห็นงานล้นก่อนส่งงานช้า");
    expect(container.textContent).not.toContain("<hl>");

    // ขั้นสุดท้ายของแต่ละภาพ: Size M = 5 MD, แถวไฟล์ผิด, Sub-task 100%, อนุมัติเลื่อน Due แล้ว
    expect(screen.getByText("ศ. 20 พ.ย.")).toBeInTheDocument();
    expect(screen.getByText("31/11/2026")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("อนุมัติแล้ว · แจ้งกลุ่มทีม Dev แล้ว")).toBeInTheDocument();
  });

  it("เมนูมือถือ (แบบ A): เปิดแล้วมีลิงก์หน้า ภาษา ธีม และปุ่มทดลองใช้ · Esc ปิดและคืนโฟกัส", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Landing />, { messages });
    const button = screen.getByRole("button", { name: "เมนู" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("site-menu")).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = document.getElementById("site-menu")!;
    expect(within(menu).getByRole("link", { name: "ราคา" })).toHaveAttribute("href", "/pricing");
    expect(within(menu).getByRole("link", { name: "ศูนย์ช่วยเหลือ" })).toHaveAttribute("href", "/help");
    expect(within(menu).getByRole("group", { name: "ธีม" })).toBeInTheDocument();
    expect(within(menu).getByText("ภาษา")).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "ทดลองใช้ฟรี 14 วัน" })).toHaveAttribute("href", "/signup");
    await user.keyboard("{Escape}");
    expect(document.getElementById("site-menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("หัวข้อภาษาอังกฤษติดจุดไว้กับคำที่ขีดเส้นใต้", () => {
    renderWithProviders(<Landing />, { locale: "en" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Plan in Man-Days. See overload before delivery slips");
  });

  it("หน้า /pricing: กำลังโหลด และ Error พร้อม requestId", async () => {
    let fail = true;
    server.use(http.get("*/api/v1/public/plans", () => (fail ? errorBody(500, "req_w19_plans") : HttpResponse.json(plansBody))));
    const user = userEvent.setup();
    renderWithProviders(<PricingPage />, { messages });
    expect(screen.getByRole("heading", { level: 1, name: "ราคาเหมาตามขนาดทีม" })).toBeInTheDocument();
    expect(await screen.findByText(/req_w19_plans/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /ลองอีกครั้ง/ }));
    expect(await screen.findByRole("article", { name: "Team L" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R4 · กฎหมาย + Cookie
// ---------------------------------------------------------------------------
describe("กฎหมาย + Cookie (R4)", () => {
  const doc = (version: string) => ({
    id: `doc-${version}`, type: "terms", version, locale: "th", effectiveAt: "2026-12-01T00:00:00+07:00", summary: "ฉบับทดสอบ",
    body: `## คำนิยาม\nข้อความตัวอย่าง ${version}\n\n## การยกเลิก\nข้อความตัวอย่าง`,
    versions: [{ version: "1.1", effectiveAt: "2026-12-01T00:00:00+07:00" }, { version: "1.0", effectiveAt: "2026-06-01T00:00:00+07:00" }],
  });

  it("แสดงเอกสารจาก API พร้อมสารบัญ, เวอร์ชัน และเลือกฉบับเก่า", async () => {
    const urls: URL[] = [];
    server.use(http.get("*/api/v1/public/legal/:type", ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json(doc(url.searchParams.get("version") ?? "1.1"));
    }));
    const user = userEvent.setup();
    renderWithProviders(<LegalView type="terms" />, { messages });
    expect(await screen.findByRole("heading", { level: 1, name: "ข้อกำหนดการใช้งาน" })).toBeInTheDocument();
    expect(screen.getByText("เวอร์ชัน 1.1")).toBeInTheDocument();
    const toc = screen.getByRole("navigation", { name: "สารบัญ" });
    const link = within(toc).getByRole("link", { name: "การยกเลิก" });
    expect(screen.getByRole("heading", { level: 2, name: "การยกเลิก" }).id).toBe(link.getAttribute("href")!.slice(1));
    const tabs = screen.getByRole("navigation", { name: "เอกสาร" });
    expect(within(tabs).getByRole("link", { name: "ข้อกำหนดการใช้งาน" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "ผู้ให้บริการช่วง" })).toHaveAttribute("href", "/legal/subprocessors");
    await user.selectOptions(screen.getByLabelText(/ประวัติการแก้ไข/), "1.0");
    expect(await screen.findByText("ข้อความตัวอย่าง 1.0")).toBeInTheDocument();
    expect(urls.at(-1)!.searchParams.get("version")).toBe("1.0");
  });

  it("ยังไม่มีเอกสาร (404) แสดงโครงหัวข้อ · ผู้ให้บริการช่วงเป็นตาราง · 500 มี requestId", async () => {
    server.use(http.get("*/api/v1/public/legal/:type", ({ params }) =>
      params.type === "cookie" ? errorBody(500, "req_w19_legal") : HttpResponse.json({ error: { code: "legal_document_not_found", message: "ยังไม่มี" } }, { status: 404 })));
    const { unmount } = renderWithProviders(<LegalView type="privacy" />, { messages });
    expect(await screen.findByText(/เอกสารฉบับจริงยังไม่เผยแพร่/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "6. สิทธิของเจ้าของข้อมูล" })).toBeInTheDocument();
    unmount();
    const sub = renderWithProviders(<LegalView type="subprocessors" />, { messages });
    expect(await screen.findByText("LINE Messaging API")).toBeInTheDocument();
    expect(screen.getAllByText("รอประกาศ")).toHaveLength(6);
    sub.unmount();
    renderWithProviders(<LegalView type="cookie" />, { messages });
    expect(await screen.findByText(/req_w19_legal/)).toBeInTheDocument();
  });

  it("Cookie consent: ปฏิเสธ / ตั้งค่า / ยอมรับทั้งหมด เก็บในเบราว์เซอร์ และเปิดใหม่จาก footer", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<><CookieConsent /><SiteFooter /></>, { messages });
    const region = await screen.findByRole("region", { name: "การใช้คุกกี้" });
    // ปุ่มทั้งสามหน้าตาเดียวกัน (น้ำหนักเท่ากันตาม PDPA)
    const buttons = within(region).getAllByRole("button");
    expect(new Set(buttons.map((b) => b.className)).size).toBe(1);
    await user.click(within(region).getByRole("button", { name: "ปฏิเสธที่ไม่จำเป็น" }));
    expect(screen.queryByRole("region", { name: "การใช้คุกกี้" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CONSENT_KEY)!)).toMatchObject({ necessary: true, analytics: false, marketing: false });

    await user.click(screen.getByRole("button", { name: "ตั้งค่าคุกกี้" }));
    const again = screen.getByRole("region", { name: "การใช้คุกกี้" });
    expect(within(again).getByLabelText("จำเป็น (ปิดไม่ได้)")).toBeDisabled();
    await user.click(within(again).getByLabelText("วิเคราะห์การใช้งาน"));
    await user.click(within(again).getByRole("button", { name: "บันทึกการตั้งค่า" }));
    expect(JSON.parse(localStorage.getItem(CONSENT_KEY)!)).toMatchObject({ analytics: true, marketing: false });
    unmount();

    // ยินยอมแล้วไม่ถามซ้ำ
    renderWithProviders(<CookieConsent />, { messages });
    expect(screen.queryByRole("region", { name: "การใช้คุกกี้" })).not.toBeInTheDocument();
    localStorage.clear();
  });

  it("ยอมรับทั้งหมด", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CookieConsent />, { messages });
    await user.click(await screen.findByRole("button", { name: "ยอมรับทั้งหมด" }));
    expect(JSON.parse(localStorage.getItem(CONSENT_KEY)!)).toMatchObject({ analytics: true, marketing: true });
  });

  it("แบนเนอร์ข้อกำหนดเปลี่ยน: Owner กดรับทราบในนาม Workspace · Member ไม่เห็น", async () => {
    let accepted = false;
    server.use(
      http.get("*/api/v1/me/legal-acceptances", () => HttpResponse.json({ items: [
        { id: "doc-terms", type: "terms", version: "1.1", effectiveAt: "2026-12-01T00:00:00+07:00", summary: "เพิ่มผู้ให้บริการส่งอีเมล", accepted },
        { id: "doc-dpa", type: "dpa", version: "1.1", effectiveAt: "2026-12-01T00:00:00+07:00", summary: null, accepted },
        { id: "doc-cookie", type: "cookie", version: "1.0", effectiveAt: "2026-06-01T00:00:00+07:00", summary: null, accepted: false },
      ] })),
      http.post("*/api/v1/me/legal-acceptances", async ({ request }) => {
        await record(request);
        if (calls.length === 2) accepted = true;
        return HttpResponse.json({ alreadyAccepted: false }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<LegalUpdateBanner ws="sample" canManage />, { messages });
    expect(await screen.findByText("เราปรับปรุงข้อกำหนดการใช้งานและข้อตกลงการประมวลผลข้อมูล (DPA)")).toBeInTheDocument();
    expect(screen.getByText(/เพิ่มผู้ให้บริการส่งอีเมล/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "อ่านฉบับเต็ม" })).toHaveAttribute("href", "/legal/terms");
    await user.click(screen.getByRole("button", { name: "รับทราบ" }));
    await waitFor(() => expect(screen.queryByText(/เราปรับปรุง/)).not.toBeInTheDocument());
    expect(calls.map((c) => c.body)).toEqual([{ documentId: "doc-terms", workspace: "sample" }, { documentId: "doc-dpa", workspace: "sample" }]);
    unmount();
    renderWithProviders(<LegalUpdateBanner ws="sample" canManage={false} />, { messages });
    expect(screen.queryByText(/เราปรับปรุง/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R2 · ชำระเงิน
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// หน้า Billing
// ---------------------------------------------------------------------------
describe("แพ็กเกจ & Billing", () => {
  const overview = (status: "trialing" | "active" = "trialing") => ({
    plan: { code: "team_s", name: "Team S" },
    subscription: { status, cycle: "monthly", trialEndsAt: "2026-11-19T00:00:00Z", currentPeriodEnd: "2026-12-06T00:00:00+07:00", planCode: "team_s" },
    limits: { seats: 10, projects: null, storage_bytes: null },
    profile: profileBody,
  });
  let items: Invoice[];
  beforeEach(() => {
    navigation.pathname = "/work/sample/billing";
    items = [
      invoice({ method: "transfer", whtAmount: 9_000, amountDue: 312_000, whtDueBy: "2099-12-06" }),
      invoice({ id: "inv-paid", number: "FRI-2610-0002", status: "paid", method: "card", taxDocument: { id: "tx-1", number: "TX-2610-0002", status: "issued", sentAt: null, pdfUrl: "/api/v1/w/sample/billing/tax-documents/tx-1.pdf" } }),
    ];
    usageBody = usage({ status: "trialing", trial: { endsAt: "2026-11-19T00:00:00Z", daysLeft: 13, expired: false }, seats: { used: 9, limit: 25, ratio: 0.36, over: false } });
    server.use(
      http.get("*/api/v1/w/:ws/billing", () => HttpResponse.json(overview())),
      http.get("*/api/v1/w/:ws/billing/invoices", () => HttpResponse.json({ items })),
      http.post("*/api/v1/w/:ws/billing/subscription/cancel", async ({ request }) => {
        await record(request);
        return HttpResponse.json({ status: "canceled" });
      }),
    );
  });

  it("แพ็กเกจ + การใช้งาน + ใบแจ้งหนี้ · แนบสลิป, อัปโหลด 50 ทวิ, ยกเลิกแพ็กเกจ (Owner)", async () => {
    const user = userEvent.setup();
    mountBilling();
    expect(await screen.findByRole("heading", { level: 2, name: "Team S · เหลือ 13 วัน" })).toBeInTheDocument();
    expect(screen.getByText("ทดลองใช้")).toBeInTheDocument();
    expect(screen.getByText("9 / 25 คน")).toBeInTheDocument();
    expect(screen.getByText("1.2 / 250 GB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ชำระเงิน" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_s");
    expect(screen.getByText("บริษัท ตัวอย่าง จำกัด")).toBeInTheDocument();

    const rows = await screen.findAllByRole("listitem");
    const open = rows.find((r) => r.textContent?.includes("FRI-2611-0001"))!;
    expect(within(open).getByText("รอชำระ")).toBeInTheDocument();
    expect(within(open).getByText("฿3,120")).toBeInTheDocument();
    expect(within(open).getByRole("link", { name: "ใบแจ้งหนี้" })).toHaveAttribute("href", `/api/v1/w/sample/billing/invoices/${INV}.pdf`);
    const paid = rows.find((r) => r.textContent?.includes("FRI-2610-0002"))!;
    expect(within(paid).getByRole("link", { name: "ใบกำกับภาษี" })).toHaveAttribute("href", "/api/v1/w/sample/billing/tax-documents/tx-1.pdf");
    expect(within(paid).queryByRole("button")).not.toBeInTheDocument();

    const input = screen.getByLabelText("แนบสลิป", { selector: "input" });
    await user.click(within(open).getByRole("button", { name: "แนบสลิป" }));
    await user.upload(input, new File(["slip"], "slip.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/แนบสลิปของ FRI-2611-0001 แล้ว/)).toBeInTheDocument();
    await user.click(within(open).getByRole("button", { name: "อัปโหลด 50 ทวิ" }));
    await user.upload(screen.getByLabelText("อัปโหลด 50 ทวิ", { selector: "input" }), new File(["wht"], "wht.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/อัปโหลด 50 ทวิ ของ FRI-2611-0001 แล้ว/)).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual([`/w/sample/billing/invoices/${INV}/slip`, `/w/sample/billing/invoices/${INV}/wht-certificate`]);

    // W22: ยกเลิกผ่านแบบสอบถาม (ไม่ตอบก็ยกเลิกได้)
    await user.click(screen.getByRole("button", { name: "ยกเลิกแพ็กเกจ" }));
    const dialog = await screen.findByRole("dialog", { name: "ยกเลิกแพ็กเกจ?" });
    await user.click(within(dialog).getByRole("button", { name: "ยกเลิกแพ็กเกจ" }));
    await waitFor(() => expect(calls.at(-1)!.path).toBe("/w/sample/billing/subscription/cancel"));
  });

  it("Admin ไม่เห็นปุ่มยกเลิก · ไม่มีใบแจ้งหนี้ = ว่าง · Member ไม่มีสิทธิ์ · Error มี requestId", async () => {
    asRole("admin");
    items = [];
    const a = mountBilling();
    expect(await screen.findByText("ยังไม่มีใบแจ้งหนี้")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ยกเลิกแพ็กเกจ" })).not.toBeInTheDocument();
    a.unmount();
    asRole("member");
    const m = mountBilling();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    m.unmount();
    asRole("owner");
    server.use(http.get("*/api/v1/w/:ws/billing", () => errorBody(500, "req_w19_billing")));
    const e = mountBilling();
    expect(await screen.findByText(/req_w19_billing/)).toBeInTheDocument();
    e.unmount();
    mountBilling({ section: "nope" });
    expect(await screen.findByText("ไม่พบหน้านี้")).toBeInTheDocument();
  });

  it("ดูเปรียบเทียบแพ็กเกจอยู่ในระบบ (มี Sidebar) · ปุ่มไปหน้าชำระเงินของ Workspace ไม่ใช่หน้าสมัคร", async () => {
    const user = userEvent.setup();
    const o = mountBilling();
    expect(await screen.findByRole("link", { name: "ดูเปรียบเทียบแพ็กเกจ" })).toHaveAttribute("href", "/work/sample/billing/plans");
    o.unmount();

    navigation.pathname = "/work/sample/billing/plans";
    mountBilling({ section: "plans" });
    const card = async (name: string) => within(await screen.findByRole("article", { name }));
    // ทดลอง Team S อยู่ = ยังชำระเงินแพ็กเกจปัจจุบันได้
    expect((await card("Team S")).getByRole("link", { name: "ชำระเงินแพ็กเกจนี้" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_s&cycle=monthly");
    expect((await card("Team M")).getByRole("link", { name: "เลือกแพ็กเกจนี้" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_m&cycle=monthly");
    expect((await card("Free")).getByRole("link", { name: "เปลี่ยนเป็น Free" })).toHaveAttribute("href", "/work/sample/billing");
    expect(screen.queryByRole("link", { name: /ทดลอง 14 วัน/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /รายปี/ }));
    expect((await card("Team M")).getByRole("link", { name: "เลือกแพ็กเกจนี้" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_m&cycle=yearly");
    // อยู่ในกรอบของระบบ: มี Sidebar และปุ่มย้อนกลับ
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /ย้อนกลับ/ })).toBeInTheDocument();
  });

  it("ใช้แพ็กเกจอยู่แล้ว (จ่ายรายเดือน) = แพ็กเกจปัจจุบัน ไม่มีปุ่ม · เปลี่ยนเป็นรายปียังชำระได้", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/api/v1/w/:ws/billing", () => HttpResponse.json(overview("active"))));
    navigation.pathname = "/work/sample/billing/plans";
    mountBilling({ section: "plans" });
    const teamS = within(await screen.findByRole("article", { name: "Team S" }));
    expect(teamS.getByText("แพ็กเกจปัจจุบัน")).toHaveAttribute("aria-disabled", "true");
    expect(teamS.queryByRole("link")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /รายปี/ }));
    expect(within(screen.getByRole("article", { name: "Team S" })).getByRole("link", { name: "ชำระเงินแพ็กเกจนี้" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_s&cycle=yearly");
  });
});

// ---------------------------------------------------------------------------
// Q2 · เกินแพ็กเกจ (7 สถานการณ์)
// ---------------------------------------------------------------------------
describe("เกินแพ็กเกจ (Q2)", () => {
  const limitError = (details: object, message = "ข้อความจาก API (ทดสอบ)") => HttpResponse.json({ error: { code: "plan_limit_reached", message, details, requestId: "req_402" } }, { status: 402 });
  const trigger = async (details: object) => {
    server.use(http.post("*/api/v1/w/:ws/projects", () => limitError(details)));
    await act(async () => {
      await api.post("/w/sample/projects", {}).catch(() => undefined);
    });
  };

  it("1. ทีมโตเกินแพ็กเกจ (402 seats) · Owner เห็นทางออกและเปลี่ยนแพ็กเกจที่แนะนำ", async () => {
    navigation.pathname = "/work/sample/members";
    renderWithProviders(<PlanLimitHost />, { messages });
    await trigger({ kind: "seats", limit: 10, current: 12, increment: 1, plan: "team_s", suggestedPlan: "team_m", exits: ["deactivate_members", "upgrade"] });
    const dialog = await screen.findByRole("dialog", { name: "เชิญคนที่ 13 ไม่ได้ในตอนนี้" });
    expect(within(dialog).getByText(/Guest \(ลูกค้า\) ยังเชิญได้ไม่จำกัด/)).toBeInTheDocument();
    expect(within(dialog).getByText("12 / 10 คน")).toBeInTheDocument();
    expect(await within(dialog).findByText("Team M รองรับ 25 คน")).toBeInTheDocument();
    expect(await within(dialog).findByRole("link", { name: "เปลี่ยนเป็น Team M" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_m");
    expect(within(dialog).getByRole("link", { name: "ดูสมาชิกที่ไม่ใช้งาน" })).toHaveAttribute("href", "/work/sample/members");
  });

  it("2. Free ครบ 3 โปรเจกต์ · Member เห็น ขอให้ Admin อัปเกรด", async () => {
    usageBody = usage({ canManageBilling: false, plan: { code: "free", name: "Free" } });
    const user = userEvent.setup();
    renderWithProviders(<PlanLimitHost />, { messages });
    await trigger({ kind: "projects", limit: 3, current: 3, increment: 1, plan: "free", suggestedPlan: "team_s" });
    const dialog = await screen.findByRole("dialog", { name: "Free สร้างได้ 3 โปรเจกต์" });
    expect(within(dialog).getByText("แพ็กเกจ Free")).toBeInTheDocument();
    expect(within(dialog).getByText("3 / 3")).toBeInTheDocument();
    expect(within(dialog).getByText("โปรเจกต์ที่ Archive ไม่นับ และกู้คืนได้")).toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "ขอให้ Admin อัปเกรด" }));
    expect(await screen.findByText(/แจ้ง Owner หรือ Admin ของ Workspace โดยตรง/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: /เปลี่ยน/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "ไว้ทีหลัง" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("3. ฟีเจอร์ของแพ็กเกจเสียเงิน (Gantt บน Free) · ไม่ซ่อน tab แต่บอกทางออก", async () => {
    const { unmount } = renderWithProviders(<FeatureLock ws="sample" feature="Gantt" canManage><p>เนื้อหา Gantt ตัวอย่าง</p></FeatureLock>, { messages });
    expect(screen.getByRole("heading", { name: "Gantt ใช้ได้ในแพ็กเกจ Team" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "อัปเกรดเป็น Team" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_s");
    expect(screen.getByRole("link", { name: "ดูแพ็กเกจ" })).toHaveAttribute("href", "/work/sample/billing/plans");
    expect(screen.getByText("เนื้อหา Gantt ตัวอย่าง").parentElement).toHaveAttribute("aria-hidden", "true");
    unmount();
    renderWithProviders(<FeatureLock ws="sample" feature="Gantt" canManage={false} />, { messages });
    expect(screen.getByRole("button", { name: "ขอให้ Admin อัปเกรด" })).toBeInTheDocument();
  });

  it("4. ทดลองใช้ใกล้หมด · Owner เห็นตั้งแต่ 7 วัน · Member เห็นเฉพาะวันสุดท้ายและกดรับทราบได้", async () => {
    usageBody = usage({ status: "trialing", trial: { endsAt: "2026-11-09T00:00:00Z", daysLeft: 3, expired: false } });
    const owner = renderWithProviders(<UsageBanner ws="sample" />, { messages });
    expect(await screen.findByText("ทดลอง Team S เหลือ 3 วัน")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เลือกแพ็กเกจ" })).toHaveAttribute("href", "/work/sample/billing/checkout");
    owner.unmount();

    usageBody = usage({ canManageBilling: false, status: "trialing", trial: { endsAt: "2026-11-09T00:00:00Z", daysLeft: 3, expired: false } });
    const member3 = renderWithProviders(<UsageBanner ws="sample" />, { messages });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/ทดลอง Team S/)).not.toBeInTheDocument();
    member3.unmount();

    usageBody = usage({ canManageBilling: false, status: "trialing", trial: { endsAt: "2026-11-07T00:00:00Z", daysLeft: 1, expired: false } });
    const user = userEvent.setup();
    renderWithProviders(<UsageBanner ws="sample" />, { messages });
    expect(await screen.findByText("Owner กำลังตัดสินใจเรื่องแพ็กเกจ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "รับทราบ" }));
    expect(screen.queryByText("Owner กำลังตัดสินใจเรื่องแพ็กเกจ")).not.toBeInTheDocument();
  });

  it("5. ใบแจ้งหนี้ค้างชำระ + ทีมโตเกินแพ็กเกจ (แบนเนอร์จาก usage) · Guest ไม่เรียก API", async () => {
    usageBody = usage({ status: "past_due", seats: { used: 12, limit: 10, ratio: 1, over: true } });
    const { unmount } = renderWithProviders(<UsageBanner ws="sample" />, { messages });
    expect(await screen.findByText("มีใบแจ้งหนี้เลยกำหนดชำระ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดูใบแจ้งหนี้" })).toHaveAttribute("href", "/work/sample/billing");
    expect(screen.getByText("ทีมมี 12 คน เกิน Team S (10 คน)")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "เปลี่ยนเป็น Team M" })).toHaveAttribute("href", "/work/sample/billing/checkout?plan=team_m");
    unmount();
    const urls: string[] = [];
    server.use(http.get("*/api/v1/w/:ws/usage", ({ request }) => {
      urls.push(request.url);
      return HttpResponse.json(usageBody);
    }));
    renderWithProviders(<UsageBanner ws="sample" isGuest />, { messages });
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toHaveLength(0);
  });

  it("6. พื้นที่ไฟล์เต็ม (402 storage_bytes) · ลิงก์ไปไฟล์ของโปรเจกต์ที่เปิดอยู่", async () => {
    navigation.pathname = "/work/sample/p/DE/files";
    renderWithProviders(<PlanLimitHost />, { messages });
    await trigger({ kind: "storage_bytes", limit: 120 * 1024 ** 3, current: 120 * 1024 ** 3, increment: 85 * 1024 ** 2, plan: "team_l", suggestedPlan: "enterprise" });
    const dialog = await screen.findByRole("dialog", { name: "พื้นที่ไฟล์เต็ม" });
    expect(within(dialog).getByText("อัปโหลดไฟล์ขนาด 85 MB ไม่ได้ · ไฟล์เดิมทั้งหมดยังเปิดได้ตามปกติ")).toBeInTheDocument();
    expect(within(dialog).getByText("120 / 120 GB")).toBeInTheDocument();
    expect(await within(dialog).findByRole("link", { name: "จัดการไฟล์" })).toHaveAttribute("href", "/work/sample/p/DE/files");
    expect(within(dialog).getByRole("link", { name: "เปลี่ยนแพ็กเกจ" })).toHaveAttribute("href", "/work/sample/billing/checkout");
  });

  it("7. Automation ครบโควตา · ต่ำกว่าโควตาไม่แสดง", () => {
    const { unmount } = renderWithProviders(<AutomationQuotaBanner usage={{ runsThisMonth: 1000, quota: 1000 }} canManage href="/work/sample/p/DE/automation" />, { messages });
    expect(screen.getByText("Automation ทำงานครบ 1,000 ครั้งของเดือนนี้")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดูกฎที่ทำงานบ่อย" })).toHaveAttribute("href", "/work/sample/p/DE/automation");
    unmount();
    const below = renderWithProviders(<AutomationQuotaBanner usage={{ runsThisMonth: 999, quota: 1000 }} canManage />, { messages });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    below.unmount();
    renderWithProviders(<AutomationQuotaBanner usage={{ runsThisMonth: 1200, quota: 1000 }} canManage={false} />, { messages });
    expect(screen.getByText("แจ้ง Admin แล้ว")).toBeInTheDocument();
  });
});
