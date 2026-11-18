// รอบ 4 · H4–H7 ทำกับหลาย Workspace (เลือกข้ามหน้า · เลือกตามตัวกรอง · ตรวจก่อนทำ · ผลรายแถว · คูปองจริง) · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import type { BulkPreview, BulkResult, WsRow } from "./_parts/types";
import { WorkspacesList } from "./WorkspacesList";

const row = (i: number, over: Partial<WsRow> = {}): WsRow => ({
  id: `10000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, slug: `demo-${i}`, name: `เดโม ${i}`, status: "active", suspensionMode: null, createdAt: "2026-03-14T03:00:00.000Z", plan: "team_s", subStatus: "trialing", cycle: "monthly",
  trialEndsAt: "2026-12-01T00:00:00.000Z", periodEnd: null, seats: 3, seatLimit: 10, projects: 1, active30: 2, lastActiveAt: null, storageBytes: 1024, integrations: [], health: 60, mrr: 0, paymentState: "ok", buyer: { key: null, name: null, company: false, count: 1 }, test: { isTest: false, flag: null, auto: false, suggest: null, reason: null, by: null, at: null }, ...over,
});
/** หน้าแรก 3 ราย · หน้าสอง 2 ราย (ตอบตาม offset) */
const PAGE1 = [row(1), row(2), row(3)];
const PAGE2 = [row(4), row(5)];

function setup(opts: { preview?: (b: Record<string, unknown>) => BulkPreview; result?: BulkResult; total?: number } = {}) {
  const previews: Record<string, unknown>[] = [];
  const applied: Record<string, unknown>[] = [];
  const asked: URLSearchParams[] = [];
  server.use(
    http.get(`${OPS}/workspaces`, ({ request }) => {
      const u = new URL(request.url);
      asked.push(u.searchParams);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      return HttpResponse.json({ items: offset ? PAGE2 : PAGE1, total: opts.total ?? 5, limit: 50, offset, sort: "recent_activity" });
    }),
    http.post(`${OPS}/workspaces/bulk/preview`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      previews.push(b);
      return HttpResponse.json(
        opts.preview?.(b) ?? {
          action: b.action, total: 5, counts: { ok: 3, approval: 1, skip: 1 },
          rows: [{ workspaceId: "x", name: "เดโม 5", slug: "demo-5", verdict: "skip", reason: "ทดลองหมด 10 พ.ย. แล้ว", code: "trial_ended" }],
          limits: { discountPct: 25, discountCycles: 6, trialDays: 21, trialTimes: 3 }, coupon: null,
        },
      );
    }),
    http.post(`${OPS}/workspaces/bulk/apply`, async ({ request }) => {
      applied.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        opts.result ?? {
          batchId: "b0c4d2e1-0000-4000-8000-000000000000", startedAt: "2026-11-16T03:42:00.000Z", finishedAt: "2026-11-16T03:42:38.000Z",
          counts: { done: 3, pending: 1, skipped: 1, failed: 0 },
          rows: [
            { workspaceId: "1", name: "เดโม 1", slug: "demo-1", result: "done", detail: "ทดลองถึง 8 ธ.ค.", approvalId: null },
            { workspaceId: "4", name: "เดโม 4", slug: "demo-4", result: "pending", detail: "รวม 35 วัน (วงเงิน 21)", approvalId: "a1b2c3d4-0000-4000-8000-000000000000" },
            { workspaceId: "5", name: "เดโม 5", slug: "demo-5", result: "skipped", detail: "ทดลองหมด 10 พ.ย. แล้ว", approvalId: null },
          ],
        },
      );
    }),
  );
  navigation.pathname = "/workspaces";
  renderWithProviders(
    <AppShell>
      <WorkspacesList />
    </AppShell>,
  );
  return { previews, applied, asked };
}

describe("H4 · เลือกหลายราย", () => {
  it("ช่องหัวตารางเลือกทั้งหน้า · เลือกข้ามหน้าสะสม · เปลี่ยนตัวกรองแล้วล้าง", async () => {
    setup({ total: 60 });
    await userEvent.click(await screen.findByLabelText("เลือกทุกแถวในหน้านี้"));
    expect(screen.getByText("เลือก 3 รายการในหน้านี้")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "เลือกทั้งหมด 60 รายการตามตัวกรอง" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ถัดไป" }));
    await userEvent.click(await screen.findByLabelText("เลือก เดโม 4"));
    expect(screen.getByText("เลือก 4 Workspace")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ก่อนหน้า" }));
    expect(await screen.findByLabelText("เลือก เดโม 1")).toBeChecked();
    // แพ็กเกจและฟีเจอร์อยู่ในปุ่ม "ตัวกรอง" (โครงหน้า Ops)
    await userEvent.click(screen.getByRole("button", { name: /^ตัวกรอง/ }));
    await userEvent.click(screen.getByRole("button", { name: "Team M" }));
    await waitFor(() => expect(screen.queryByText(/^เลือก \d+ (Workspace|รายการ)/)).not.toBeInTheDocument());
  });

  it("เลือกทั้งหมดตามตัวกรอง → ส่ง filter ไปตรวจและทำ (ไม่ส่ง ids) · ผลรายแถว + CSV + ไปคำขออนุมัติ", async () => {
    asRole("support");
    const { previews, applied } = setup();
    // แพ็กเกจและฟีเจอร์อยู่ในปุ่ม "ตัวกรอง" (โครงหน้า Ops)
    await userEvent.click(await screen.findByRole("button", { name: /^ตัวกรอง/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Team S" }));
    await userEvent.click(await screen.findByLabelText("เลือกทุกแถวในหน้านี้"));
    await userEvent.click(screen.getByRole("button", { name: "เลือกทั้งหมด 5 รายการตามตัวกรอง" }));
    expect(screen.getByText("เลือกทั้งหมด 5 รายการตามตัวกรอง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ขยายทดลองใช้" }));
    const dlg = await screen.findByRole("dialog", { name: "ขยายทดลองใช้ 5 Workspace" });
    expect(within(dlg).getByText(/ตามตัวกรอง "Team S"/)).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByTestId("bulk-ok")).toHaveTextContent("3"));
    expect(within(dlg).getByTestId("bulk-approval")).toHaveTextContent("1");
    expect(within(dlg).getByText(/รวมเกิน 21 วัน หรือขยายครั้งที่ 4/)).toBeInTheDocument();
    expect(within(dlg).getByText(/ทดลองหมดแล้ว 1/)).toBeInTheDocument();
    expect(previews.at(-1)).toMatchObject({ action: "extend_trial", days: 7, filter: { plan: "team_s" } });
    expect(previews.at(-1)).not.toHaveProperty("ids");
    await userEvent.click(within(dlg).getByRole("button", { name: "14 วัน" }));
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ days: 14 }));
    expect(within(dlg).getByText("1 รายการส่งเป็นคำขออนุมัติแยกรายละ 1 คำขอ (G7)")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ลูกค้าเห็นใน Audit log)"), "ชดเชยระบบช้า");
    await userEvent.click(within(dlg).getByLabelText("อีเมลแจ้ง Owner ของแต่ละ Workspace"));
    await userEvent.click(within(dlg).getByRole("button", { name: "ขยาย 4 รายการ" }));
    const res = await screen.findByRole("dialog", { name: "ขยายทดลองใช้ · เสร็จแล้ว" });
    expect(applied[0]).toMatchObject({ action: "extend_trial", days: 14, filter: { plan: "team_s" }, reason: "ชดเชยระบบช้า", notifyOwners: true });
    expect(within(res).getByText(/ใช้เวลา 38 วินาที/)).toBeInTheDocument();
    expect(within(res).getAllByText("สำเร็จ 3").length).toBeGreaterThan(0);
    // ค่าเริ่มต้นแสดงรายการที่รออนุมัติก่อน
    expect(within(res).getByText(/คำขอ #a1b2c3d4/)).toBeInTheDocument();
    expect(within(res).queryByText("ทดลองถึง 8 ธ.ค.")).not.toBeInTheDocument();
    await userEvent.click(within(res).getByRole("button", { name: "ทั้งหมด" }));
    expect(within(res).getByText("ทดลองถึง 8 ธ.ค.")).toBeInTheDocument();
    expect(within(res).getByText("ผลเก็บใน Audit log ชุด #BULK-b0c4d2e1")).toBeInTheDocument();
    expect(within(res).getByRole("button", { name: "ดาวน์โหลดผล CSV" })).toBeInTheDocument();
    server.use(http.get(`${OPS}/approvals`, () => HttpResponse.json({ items: [], singleApprover: true })));
    await userEvent.click(within(res).getByRole("button", { name: "ดูคำขออนุมัติ 1" }));
    expect(await screen.findByRole("dialog", { name: /รออนุมัติ|คำขออนุมัติ/ })).toBeInTheDocument();
  });

  it("เลือกเป็นรายแถวส่ง ids · เกิน 1,000 รายแสดงข้อความจากเซิร์ฟเวอร์", async () => {
    asRole("support");
    const { previews } = setup();
    server.use(http.post(`${OPS}/workspaces/bulk/preview`, async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      previews.push(b);
      return opsError(422, "bulk_too_many", "ตัวกรองนี้มีเกิน 1,000 รายการ · กรองให้แคบลงก่อน");
    }));
    await userEvent.click(await screen.findByLabelText("เลือก เดโม 2"));
    await userEvent.click(screen.getByRole("button", { name: "ขยายทดลองใช้" }));
    const dlg = await screen.findByRole("dialog", { name: "ขยายทดลองใช้ 1 Workspace" });
    expect(await within(dlg).findByText(/เกิน 1,000 รายการ/)).toBeInTheDocument();
    expect(previews.at(-1)).toMatchObject({ ids: [row(2).id] });
    expect(within(dlg).getByRole("button", { name: /ขยาย \d+ รายการ/ })).toBeDisabled();
  });

  it("ป้ายระงับบอกโหมด", async () => {
    server.use(http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [row(1, { status: "suspended", suspensionMode: "read_only" }), row(2, { status: "suspended", suspensionMode: "full" })], total: 2, limit: 50, offset: 0, sort: "recent_activity" })));
    navigation.pathname = "/workspaces";
    renderWithProviders(
      <AppShell>
        <WorkspacesList />
      </AppShell>,
    );
    expect(await screen.findByText("ระงับ · อ่านอย่างเดียว")).toBeInTheDocument();
    expect(screen.getByText("ระงับ · ปิดทั้งหมด")).toBeInTheDocument();
  });

  it("ส่งประกาศตามตัวกรองยังไม่รองรับ: ปุ่มปิดพร้อมเหตุผล", async () => {
    setup();
    await userEvent.click(await screen.findByLabelText("เลือกทุกแถวในหน้านี้"));
    await userEvent.click(screen.getByRole("button", { name: "เลือกทั้งหมด 5 รายการตามตัวกรอง" }));
    expect(screen.getByRole("button", { name: "ส่งประกาศ" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "เลือกเฉพาะที่ติ๊กไว้" }));
    expect(screen.getByRole("button", { name: "ส่งประกาศ" })).toBeEnabled();
  });
});

describe("H7 · ให้คูปองหรือส่วนลดหลายราย", () => {
  const coupons = [
    { id: "c0000000-0000-4000-8000-000000000001", code: "WELCOME20", kind: "percent", value: 20, duration: "repeating", durationCycles: 3, maxRedemptions: 500, expiresOn: "2026-12-31", state: "active", used: 88 },
    { id: "c0000000-0000-4000-8000-000000000002", code: "OLD10", kind: "percent", value: 10, duration: "once", durationCycles: null, maxRedemptions: null, expiresOn: null, state: "expired", used: 3 },
  ];

  it("ใช้คูปองที่มีอยู่: เลือกจากคูปองที่เปิดใช้ · ส่ง couponId · วงเงินจากสิทธิ์จริงของพนักงาน", async () => {
    asRole("finance");
    server.use(
      http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: { ...staff.finance, limits: { ...staff.finance.limits, discountPct: 25, discountCycles: 6 } } })),
      http.get(`${OPS}/promotions`, () => HttpResponse.json({ plans: [], pendingPrices: [], coupons, summary: { activeCoupons: 1, discountThisMonthSatang: 0 } })),
    );
    const { previews, applied } = setup({ result: { batchId: "c1d2e3f4-0000-4000-8000-000000000000", startedAt: "2026-11-16T03:00:00.000Z", finishedAt: "2026-11-16T03:00:02.000Z", counts: { done: 2, pending: 0, skipped: 0, failed: 0 }, rows: [] } });
    await userEvent.click(await screen.findByLabelText("เลือก เดโม 1"));
    await userEvent.click(screen.getByLabelText("เลือก เดโม 2"));
    await userEvent.click(screen.getByRole("button", { name: "ให้คูปองหรือส่วนลด" }));
    const dlg = await screen.findByRole("dialog", { name: "ให้คูปองหรือส่วนลด · 2 Workspace" });
    expect(within(dlg).getByText("C3 · เดโม 1, เดโม 2")).toBeInTheDocument();
    const select = await within(dlg).findByLabelText("คูปอง");
    expect(within(select).getByRole("option", { name: /WELCOME20 · ลด 20% 3 รอบ · เหลือ 412 สิทธิ์ · หมด 31 ธ.ค./ })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /OLD10/ })).not.toBeInTheDocument();
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ action: "coupon", couponId: coupons[0].id, ids: [row(1).id, row(2).id] }));
    expect(within(dlg).getByText(/วงเงินของคุณ: ส่วนลดไม่เกิน 25% และ 6 รอบ/)).toBeInTheDocument();
    expect(within(dlg).queryByText(/30%/)).not.toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ลูกค้างานสัมมนา");
    await userEvent.click(within(dlg).getByRole("button", { name: "ให้คูปอง 4 ราย" }));
    await screen.findByRole("dialog", { name: "ให้คูปอง · เสร็จแล้ว" });
    expect(applied[0]).toMatchObject({ action: "coupon", couponId: coupons[0].id, reason: "ลูกค้างานสัมมนา" });
  });

  it("ส่วนลดเฉพาะราย: ส่ง percent / months", async () => {
    asRole("finance");
    server.use(http.get(`${OPS}/promotions`, () => HttpResponse.json({ plans: [], pendingPrices: [], coupons: [], summary: { activeCoupons: 0, discountThisMonthSatang: 0 } })));
    const { previews, applied } = setup();
    await userEvent.click(await screen.findByLabelText("เลือก เดโม 3"));
    await userEvent.click(screen.getByRole("button", { name: "ให้คูปองหรือส่วนลด" }));
    const dlg = await screen.findByRole("dialog", { name: "ให้คูปองหรือส่วนลด · 1 Workspace" });
    expect(await within(dlg).findByText("ยังไม่มีคูปองที่เปิดใช้")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("radio", { name: /ส่วนลดเฉพาะรายนี้/ }));
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ action: "discount", percent: 15, months: 6, ids: [row(3).id] }));
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "ลูกค้าเก่า");
    await userEvent.click(within(dlg).getByRole("button", { name: "ให้ส่วนลด 4 ราย" }));
    await screen.findByRole("dialog", { name: "ให้ส่วนลด · เสร็จแล้ว" });
    expect(applied[0]).toMatchObject({ action: "discount", percent: 15, months: 6 });
  });
});
