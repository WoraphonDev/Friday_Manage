// O55 · ใบเสนอราคาและสัญญา · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { bangkokToday } from "@/lib/format";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { QuotesPage } from "./QuotesPage";

// วันที่ตามเวลาไทย · ใช้วันที่ UTC แล้วช่วงเช้าของไทยนับได้ 3 วันจน test ล้มใน CI
const soon = new Date(Date.parse(`${bangkokToday()}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
const base = {
  seats: 150, months: 12, pricePerSeatSatang: 33_000, listPerSeatSatang: 40_000, subtotalSatang: 59_400_000, vatSatang: 4_158_000, totalSatang: 63_558_000, discountPct: 17.5,
  entitlements: { sso: true, api_rpm: 600 }, sla: { first: { n: 1, unit: "h" }, resolve: { n: 8, unit: "h" } }, contractStart: null, validUntil: soon, approvedAt: null, approvedBy: null, approvalStatus: null,
  sentAt: null, viewCount: 0, lastViewedAt: null, acceptedAt: null, acceptance: null, changeRequest: null, setup: {}, accountId: "a1", leadId: "l1", workspaceId: null, workspaceName: null, createdBy: "ฟิน", createdAt: new Date().toISOString(),
};
const pending = { ...base, id: "q1", number: "QT-2611-0007", status: "draft", company: "ลานนาเทค", approvalStatus: "pending", reason: "approval" };
const expiring = { ...base, id: "q2", number: "QT-2610-0004", status: "sent", company: "Orchid Insurance", totalSatang: 84_744_000, viewCount: 3, lastViewedAt: new Date().toISOString(), reason: "expiring", discountPct: 0 };
const accepted = {
  ...base, id: "q3", number: "QT-2611-0002", status: "accepted", company: "Kestrel Labs", acceptedAt: new Date().toISOString(), acceptance: { name: "คุณสมชาย", title: "CFO", po: "PO-88213" },
  setup: { contract: { status: "done", at: "" }, entitlements: { status: "waiting", at: "", error: "รอผูก Workspace ของลูกค้า" }, sla: { status: "done", at: "" }, invoice: { status: "failed", at: "", error: "ลูกค้ายังไม่ได้กรอกข้อมูลออกใบกำกับภาษี" }, renewal: { status: "done", at: "" }, lead: { status: "done", at: "" } },
};

function page(search = "") {
  navigation.pathname = "/quotes";
  navigation.search = search;
  server.use(
    http.get(`${OPS}/quotes/summary`, () => HttpResponse.json({ sent: 6, sentValueSatang: 210_000_000, accepted90: 4, contracts: 18, todo: [pending, expiring], tabs: { draft: 2, sent: 6, accepted: 22, closed: 9 }, canApprove: true })),
    http.get(`${OPS}/quotes`, () => HttpResponse.json({ items: [expiring], total: 1 })),
    http.get(`${OPS}/quotes/settings`, () => HttpResponse.json({ listPerSeatSatang: 40_000, validDays: 30 })),
    http.get(`${OPS}/quotes/q2`, () => HttpResponse.json(expiring)),
    http.get(`${OPS}/quotes/q3`, () => HttpResponse.json(accepted)),
  );
  return renderWithProviders(
    <AppShell>
      <QuotesPage />
    </AppShell>,
  );
}

describe("ใบเสนอราคาและสัญญา", () => {
  it("ขั้น 2: ตัวเลขหัวหน้า · รออนุมัติและใกล้หมดอายุบนสุด · ลูกค้าเปิดดูกี่ครั้ง", async () => {
    asRole("finance");
    page();
    expect(await screen.findByText("ส่งแล้วรอตอบ 6 · ฿2,100,000 · ตอบรับ 90 วัน 4 ใบ · สัญญาที่มีผลอยู่ 18")).toBeInTheDocument();
    const todo = await screen.findByRole("region", { name: "ต้องทำตอนนี้" });
    expect(within(todo).getByText("QT-2611-0007 · ลานนาเทค · ส่วนลด 17.5%")).toBeInTheDocument();
    expect(within(todo).getByText("รออนุมัติ")).toBeInTheDocument();
    expect(within(todo).getByText("QT-2610-0004 · Orchid Insurance · ลูกค้าเปิดดู 3 ครั้ง")).toBeInTheDocument();
    expect(within(todo).getByText("หมดใน 2 วัน")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ตอบรับ\s*22/ })).toBeInTheDocument();
  });

  it("ขั้น 1: สร้างจาก Lead · ตัวอย่างเอกสารคิดยอด + VAT · ส่วนลดเกินวงเงินบอกว่าต้องขออนุมัติ", async () => {
    asRole("finance");
    let body: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/quotes`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ ...pending, id: "q9" }))));
    page("new=1&lead=l1&company=ลานนาเทค");
    const ed = await screen.findByRole("dialog", { name: "ใบเสนอราคาใหม่" });
    expect(within(ed).getByText("ลานนาเทค · จาก Lead")).toBeInTheDocument();
    await userEvent.clear(within(ed).getByLabelText("ที่นั่ง"));
    await userEvent.type(within(ed).getByLabelText("ที่นั่ง"), "150");
    await userEvent.type(within(ed).getByLabelText("ราคา/ที่นั่ง/เดือน (บาท)"), "330");
    const preview = within(ed).getByRole("region", { name: "ตัวอย่างเอกสาร" });
    expect(within(preview).getByText("฿594,000")).toBeInTheDocument();
    expect(within(preview).getByText("฿635,580")).toBeInTheDocument();
    expect(within(preview).getByText(/ส่วนลด 17.5% จากราคาปกติ · วงเงินของคุณ 30%/)).toBeInTheDocument();
    await userEvent.clear(within(ed).getByLabelText("ราคา/ที่นั่ง/เดือน (บาท)"));
    await userEvent.type(within(ed).getByLabelText("ราคา/ที่นั่ง/เดือน (บาท)"), "250");
    expect(within(preview).getByText(/เกินวงเงิน · ส่งแล้วจะขออนุมัติ Owner ก่อน/)).toBeInTheDocument();
    await userEvent.click(within(ed).getByRole("button", { name: "บันทึกร่าง" }));
    await waitFor(() => expect(body).toMatchObject({ leadId: "l1", seats: 150, months: 12, pricePerSeatSatang: 25_000, entitlements: { sso: true, api_rpm: 600 }, sla: { first: { n: 1, unit: "h" }, resolve: { n: 8, unit: "h" } } }));
  });

  it("ส่งใบที่ส่งแล้ว = ส่งลิงก์ใหม่ · เห็นลิงก์ให้คัดลอก", async () => {
    asRole("finance");
    server.use(http.post(`${OPS}/quotes/q2/send`, () => HttpResponse.json({ ...expiring, link: "http://localhost:3000/quote/TokenForTest_0123456789abcd", emailed: 1 })));
    page();
    await userEvent.click(await screen.findByText("Orchid Insurance", { selector: "td" }));
    const drawer = await screen.findByRole("dialog", { name: "QT-2610-0004 · Orchid Insurance" });
    await userEvent.click(within(drawer).getByRole("button", { name: "ส่งลิงก์ใหม่" }));
    expect(await within(drawer).findByText("http://localhost:3000/quote/TokenForTest_0123456789abcd")).toBeInTheDocument();
  });

  it("ขั้น 3: ตอบรับแล้วเห็นขั้นที่ระบบทำต่อให้ · ขั้นล้มลองใหม่ได้ · ผูก Workspace", async () => {
    asRole("finance");
    let retried = false;
    server.use(http.post(`${OPS}/quotes/q3/setup`, () => ((retried = true), HttpResponse.json(accepted))));
    page("quote=q3");
    const drawer = await screen.findByRole("dialog", { name: "QT-2611-0002 · Kestrel Labs" });
    expect(within(drawer).getByText(/ลงนามโดย คุณสมชาย \(CFO\) · .* · PO-88213/)).toBeInTheDocument();
    const steps = within(drawer).getByRole("region", { name: "ระบบทำต่อให้" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(6);
    expect(within(steps).getByText(/ลูกค้ายังไม่ได้กรอกข้อมูลออกใบกำกับภาษี/)).toBeInTheDocument();
    await userEvent.click(within(steps).getByRole("button", { name: "ลองใหม่" }));
    await waitFor(() => expect(retried).toBe(true));
    expect(within(steps).getByRole("button", { name: "ผูก Workspace" })).toBeInTheDocument();
  });
});
