import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { Shell } from "@/features/shell/Shell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { DeliveriesPage } from "./DeliveriesPage";
import type { Detail, Item, ListResponse, Suppression } from "./_parts/types";

// ข้อมูลสมมติเท่านั้น
const ws = { id: "w-1", name: "ออร์บิทเดโม", slug: "orbit-demo" };
const at = "2026-11-10T02:41:02.000Z";
const items: Item[] = [
  { id: "d-1", createdAt: at, channel: "webhook", to: "Discord dev-alerts", workspace: ws, event: { type: "bug.created", issueKey: "DP-118" }, status: "fail", attempts: 4 },
  { id: "d-2", createdAt: at, channel: "email", to: "ops@orbit.example.com", workspace: ws, event: { type: "issue.assigned", issueKey: "DP-117" }, status: "ok", attempts: 1 },
  { id: "d-3", createdAt: at, channel: "line_group", to: "กลุ่ม LINE · Dev", workspace: ws, event: { type: "digest.daily", issueKey: null }, status: "quiet", attempts: 0 },
];
const list: ListResponse = {
  stats: { total: 18402, byChannel: { email: 11230, line: 6901, webhook: 271 }, deliveredPct: 99.4, failed: { total: 41, email: 8, line: 0, webhook: 33 }, waitingQuiet: 1208, suppressed: 3, bouncePct: 0.3 },
  items,
  nextBefore: null,
};
const detail: Detail = {
  ...items[0],
  sentAt: null,
  lastError: "Webhook ตอบ HTTP 404",
  response: { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' },
  log: [
    { at, kind: "attempt_failed", attempt: 1, status: 404, message: "Webhook ตอบ HTTP 404" },
    { at, kind: "attempt_failed", attempt: 4, status: 404, message: "Webhook ตอบ HTTP 404", final: true },
    { at, kind: "paused" },
  ],
  webhook: { id: "h-1", name: "Discord dev-alerts", status: "paused" },
  suppression: null,
  content: { view: null, request: { method: "POST", url: "https://discord.com/api/webhooks/••••/••••", headers: { "content-type": "application/json" }, body: null } },
  contentAccess: { allowed: false, reason: "no_grant" },
  canResend: true,
  resendRequested: false,
  event: { type: "bug.created", issueKey: "DP-118", projectKey: "DP" },
};
const suppressed: Suppression[] = [{ id: "s-1", email: "qa@orbit.example.com", reason: "hard_bounce", detail: "smtp; 550 user unknown", source: "ses", workspace: { id: "w-1", name: "ออร์บิทเดโม" }, since: "2026-11-07T02:00:00.000Z" }];

const calls: { method: string; path: string; body?: unknown }[] = [];
let lastQuery = "";
function handlers() {
  calls.length = 0;
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname.replace(/^.*\/ops-api/, ""), body: text ? JSON.parse(text) : undefined });
  };
  server.use(
    http.get(`${OPS}/deliveries`, ({ request }) => {
      lastQuery = new URL(request.url).search;
      return HttpResponse.json(list);
    }),
    http.get(`${OPS}/deliveries/:id`, () => HttpResponse.json(detail)),
    http.post(`${OPS}/deliveries/:id/resend`, async ({ request }) => (await record(request), HttpResponse.json({ resendRequested: true }))),
    http.post(`${OPS}/deliveries/:id/attach`, async ({ request }) => (await record(request), HttpResponse.json({ ticketNumber: 509 }))),
    http.get(`${OPS}/email-suppressions`, () => HttpResponse.json({ items: suppressed })),
    http.post(`${OPS}/email-suppressions/:id/remove`, async ({ request }) => (await record(request), HttpResponse.json({ removed: true }))),
  );
}
const view = () => {
  navigation.pathname = "/deliveries";
  return renderWithProviders(
    <Shell>
      <DeliveriesPage />
    </Shell>,
  );
};

describe("ประวัติการส่งแจ้งเตือน (O23)", () => {
  it("สรุป 24 ชม. · ตาราง · รายละเอียดของรายการแรก ตาม Canvas", async () => {
    handlers();
    view();
    expect(await screen.findByText("18,402")).toBeInTheDocument();
    expect(screen.getByText("Email 11,230 · LINE 6,901 · Webhook 271")).toBeInTheDocument();
    expect(screen.getByText("99.4%")).toBeInTheDocument();
    expect(screen.getByText("Bug ใหม่ DP-118")).toBeInTheDocument();
    expect(screen.getByText("รอช่วงงดส่ง")).toBeInTheDocument();
    const aside = screen.getByRole("complementary", { name: "รายละเอียดการส่ง" });
    expect(await within(aside).findByText("ล้ม 4/4")).toBeInTheDocument();
    expect(within(aside).getByText('HTTP 404 {"message": "Unknown Webhook", "code": 10015}')).toBeInTheDocument();
    expect(within(aside).getByText(/ครั้งที่ 4 · HTTP 404 · Webhook ตอบ HTTP 404 · หยุดลอง/)).toBeInTheDocument();
    expect(within(aside).getByText(/น่าจะถูกลบที่ปลายทางแล้ว/)).toBeInTheDocument();
    expect(await screen.findByText("Bounce ถาวร (กล่องไม่มีอยู่)")).toBeInTheDocument();
  });

  it("ค้นหา · กรองช่องทาง · กรองสถานะ ส่งเป็น query", async () => {
    handlers();
    view();
    await screen.findByText("18,402");
    await userEvent.click(screen.getByRole("button", { name: "Webhook" }));
    await waitFor(() => expect(lastQuery).toContain("channel=webhook"));
    await userEvent.selectOptions(screen.getByLabelText("สถานะ"), "fail");
    await waitFor(() => expect(lastQuery).toContain("status=fail"));
    await userEvent.type(screen.getByLabelText("ค้นหา"), "orbit");
    await waitFor(() => expect(lastQuery).toContain("q=orbit"));
  });

  it("Y6 ดูข้อความ: Request ซ่อน URL / เนื้อหา · บอกว่าลูกค้ายังไม่เปิดสิทธิ์", async () => {
    handlers();
    view();
    const aside = await screen.findByRole("complementary", { name: "รายละเอียดการส่ง" });
    await userEvent.click(await within(aside).findByRole("button", { name: "ดูข้อความที่ส่ง" }));
    const dlg = await screen.findByRole("dialog", { name: "ข้อความที่ส่ง · Webhook" });
    expect(within(dlg).getByText(/POST https:\/\/discord\.com\/api\/webhooks\/••••\/••••/)).toBeInTheDocument();
    expect(within(dlg).getByText(/ลูกค้ายังไม่ได้เปิดสิทธิ์/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Response" }));
    expect(within(dlg).getByText(/Unknown Webhook/)).toBeInTheDocument();
  });

  it("ส่งซ้ำ · แนบใน Ticket", async () => {
    handlers();
    view();
    const aside = await screen.findByRole("complementary", { name: "รายละเอียดการส่ง" });
    await userEvent.click(await within(aside).findByRole("button", { name: "ส่งซ้ำ" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/deliveries/d-1/resend")).toBe(true));
    await userEvent.click(within(aside).getByRole("button", { name: "แนบใน Ticket" }));
    const dlg = await screen.findByRole("dialog", { name: "แนบการส่งนี้ใน Ticket" });
    await userEvent.type(within(dlg).getByLabelText("เลข Ticket"), "509");
    await userEvent.click(within(dlg).getByRole("button", { name: "แนบ" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/deliveries/d-1/attach")?.body).toEqual({ ticketNumber: 509 }));
  });

  it("วิศวกร: ไม่มีปุ่มแนบใน Ticket และเอาอีเมลออกจากรายการไม่ได้ · การเงินไม่เห็นหน้านี้", async () => {
    handlers();
    asRole("engineer");
    const { unmount } = view();
    const aside = await screen.findByRole("complementary", { name: "รายละเอียดการส่ง" });
    await within(aside).findByRole("button", { name: "ดูข้อความที่ส่ง" });
    expect(within(aside).queryByRole("button", { name: "แนบใน Ticket" })).toBeNull();
    await screen.findByText("Bounce ถาวร (กล่องไม่มีอยู่)");
    expect(screen.queryByRole("button", { name: "เอาออกจากรายการ" })).toBeNull();
    unmount();
    asRole("finance");
    view();
    expect(await screen.findByText(/^หน้านี้เปิดให้ Owner/)).toBeInTheDocument();
  });

  it("Y7 เอาอีเมลออกจากรายการไม่ส่ง ต้องมีเหตุผล", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: "เอาออกจากรายการ" }));
    const dlg = await screen.findByRole("dialog", { name: "ส่งอีเมลถึง qa@orbit.example.com อีกครั้ง?" });
    expect(within(dlg).getByText("ถูกเพิ่มเพราะ Bounce ถาวร (กล่องไม่มีอยู่) · 7 พ.ย. 2569")).toBeInTheDocument();
    const submit = within(dlg).getByRole("button", { name: "เอาออก" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ลูกค้ายืนยันใน Ticket #509");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.path === "/email-suppressions/s-1/remove")?.body).toEqual({ reason: "ลูกค้ายืนยันใน Ticket #509" }));
  });

  it("ว่าง / error แสดงสถานะตาม M1", async () => {
    handlers();
    server.use(http.get(`${OPS}/deliveries`, () => opsError(500, "internal", "ระบบขัดข้อง", undefined, "req-dlv-1")));
    view();
    expect(await screen.findByText(/req-dlv-1/)).toBeInTheDocument();
  });
});
