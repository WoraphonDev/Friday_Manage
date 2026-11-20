// O54 · Lead และดีล · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { LeadsPage } from "./LeadsPage";

const base = { contactTitle: null, phone: null, needs: [], message: null, lostReason: null, valueSatang: null, seats: null, ownerId: null, owner: null, nextAction: null, nextAt: null, workspaceId: null, accountId: null, closedAt: null };
const lanna = { ...base, id: "l1", number: 1, company: "บริษัท ลานนาเทค จำกัด", contactName: "คุณวรรณา", email: "wanna@lannatech.example", teamSize: 150, needs: ["sso", "annual_contract"], message: "อยากได้ SSO และสัญญารายปี", source: "form", stage: "new", createdAt: new Date(Date.now() - 26 * 3_600_000).toISOString(), late: true };
const river = { ...base, id: "l2", number: 2, company: "Riverbank Media", contactName: null, email: "owner@riverbank.example.com", teamSize: 38, source: "trial", stage: "new", createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), late: false };
const orchid = { ...base, id: "l3", number: 3, company: "Orchid Insurance", contactName: "คุณสมศรี", email: "somsri@orchid.example", teamSize: 220, seats: 220, valueSatang: 79_200_000, source: "form", stage: "contacted", ownerId: "00000000-0000-4000-8000-000000000001", owner: "แอดมินตัวอย่าง", nextAction: "ส่งเอกสาร security", nextAt: "2026-11-21", createdAt: new Date().toISOString() };
const stages = { new: { n: 2, value: 0 }, contacted: { n: 15, value: 79_200_000 }, demo: { n: 9, value: 0 }, proposal: { n: 6, value: 0 }, won: { n: 4, value: 0 }, lost: { n: 7, value: 0 } };
const summary = { open: 46, pipelineSatang: 320_000_000, won90: 4, lost90: 7, stages, todo: { items: [lanna, river], uncontacted: 2, late: 1, due: 0 } };

function page() {
  navigation.pathname = "/leads";
  navigation.search = "";
  server.use(
    http.get(`${OPS}/leads/summary`, () => HttpResponse.json(summary)),
    http.get(`${OPS}/leads`, () => HttpResponse.json({ items: [orchid], total: 1 })),
    http.get(`${OPS}/leads/l3`, () => HttpResponse.json({ ...orchid, trial: null, notes: [{ id: "n1", kind: "call", body: "สนใจ 220 ที่นั่ง", nextAction: "ส่งเอกสาร security", nextAt: "2026-11-21", createdAt: new Date().toISOString(), by: "แอดมินตัวอย่าง" }] })),
    http.get(`${OPS}/leads/l1`, () => HttpResponse.json({ ...lanna, ownerId: "x", owner: "แอดมินตัวอย่าง", trial: null, notes: [] })),
  );
  return renderWithProviders(
    <AppShell>
      <LeadsPage />
    </AppShell>,
  );
}

describe("Lead และดีล", () => {
  it("ขั้น 1: ตัวเลขหัวหน้า · Lead ใหม่บนสุด (เกิน 1 วันทำการเด่น) · แท็บขั้นพร้อมจำนวน · ตาราง", async () => {
    asRole("admin");
    page();
    expect(await screen.findByText("เปิดอยู่ 46 · มูลค่าคาดการณ์ ฿3,200,000/ปี · ปิดได้ 90 วัน: ชนะ 4 แพ้ 7")).toBeInTheDocument();
    const todo = await screen.findByRole("region", { name: "ต้องทำตอนนี้" });
    expect(within(todo).getByText("ยังไม่ติดต่อ 2 (เกิน 1 วันทำการ 1) · นัดถึงวันนี้ 0")).toBeInTheDocument();
    const r = within(todo).getByRole("article", { name: "บริษัท ลานนาเทค จำกัด" });
    expect(within(r).getByText("เกิน 1 วันทำการ")).toBeInTheDocument();
    expect(within(todo).getByText("38 ที่นั่งใช้งานจริง")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ติดต่อแล้ว\s*15/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("ส่งเอกสาร security")).toBeInTheDocument();
  });

  it("Support ไม่มีสิทธิ์", async () => {
    asRole("support");
    page();
    expect(await screen.findByText(/หน้านี้เปิดให้ Owner/)).toBeInTheDocument();
  });

  it("รับเรื่องจากแถบต้องทำ แล้วเปิดแผงขวา", async () => {
    asRole("admin");
    let claimed = false;
    server.use(http.post(`${OPS}/leads/l1/claim`, () => ((claimed = true), HttpResponse.json({ id: "l1" }))));
    page();
    await userEvent.click(within(await screen.findByRole("article", { name: "บริษัท ลานนาเทค จำกัด" })).getByRole("button", { name: "รับเรื่อง" }));
    await waitFor(() => expect(claimed).toBe(true));
    expect(await screen.findByRole("dialog", { name: "บริษัท ลานนาเทค จำกัด" })).toBeInTheDocument();
  });

  it("ขั้น 2: บันทึกการคุยต้องกำหนดทำต่อ · แพ้ต้องเลือกเหตุผล", async () => {
    asRole("admin");
    const sent: unknown[] = [];
    server.use(
      http.post(`${OPS}/leads/l3/notes`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json(orchid))),
      http.patch(`${OPS}/leads/l3`, async ({ request }) => (sent.push(await request.json()), HttpResponse.json({ ...orchid, stage: "lost" }))),
    );
    page();
    await userEvent.click(await screen.findByText("Orchid Insurance"));
    const drawer = await screen.findByRole("dialog", { name: "Orchid Insurance" });
    expect(within(drawer).getByText("สนใจ 220 ที่นั่ง")).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("คุยอะไรไป"), "ส่งเอกสารแล้ว รอทีม IT ตรวจ");
    const save = within(drawer).getByRole("button", { name: "บันทึกและตั้งทำต่อ" });
    expect(save).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("ทำต่อ"), "โทรตามผลตรวจ");
    await userEvent.click(save);
    await waitFor(() => expect(sent[0]).toMatchObject({ kind: "call", body: "ส่งเอกสารแล้ว รอทีม IT ตรวจ", nextAction: "โทรตามผลตรวจ", nextAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
    await userEvent.click(within(drawer).getByRole("button", { name: "แพ้ (ใส่เหตุผล)" }));
    const dlg = await screen.findByRole("dialog", { name: "ปิดดีล Orchid Insurance เป็นแพ้" });
    await userEvent.selectOptions(within(dlg).getByLabelText("เหตุผล"), "competitor");
    await userEvent.click(within(dlg).getByRole("button", { name: "แพ้ (ใส่เหตุผล)" }));
    await waitFor(() => expect(sent[1]).toEqual({ stage: "lost", lostReason: "competitor" }));
  });

  it("เกณฑ์ Lead จากลูกค้าทดลอง: ที่นั่ง · ดูตารางราคากี่วัน (0 = ไม่ใช้) · กดติดต่อฝ่ายขาย Enterprise", async () => {
    asRole("admin");
    let sent: unknown = null;
    page();
    server.use(
      http.get(`${OPS}/leads/settings`, () => HttpResponse.json({ trialSeats: 20, pricingDays: 2, enterpriseClick: true })),
      http.put(`${OPS}/leads/settings`, async ({ request }) => ((sent = await request.json()), HttpResponse.json(sent as Record<string, unknown>))),
    );
    await userEvent.click(await screen.findByRole("button", { name: "เกณฑ์ Lead จากลูกค้าทดลอง" }));
    const days = await screen.findByLabelText("เปิดดูตารางราคาในแอปตั้งแต่ (วัน)");
    expect(days).toHaveValue(2);
    await userEvent.clear(days);
    await userEvent.type(days, "0");
    await userEvent.click(screen.getByRole("switch", { name: 'กด "ติดต่อฝ่ายขาย" ของ Enterprise ในแอป' }));
    await userEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(sent).toEqual({ trialSeats: 20, pricingDays: 0, enterpriseClick: false }));
  });
});
