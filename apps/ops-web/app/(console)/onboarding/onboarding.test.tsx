// O34 · Onboarding checklist ใน Friday Ops (บอร์ด 18 · V5 · V7) · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { OnboardingCard } from "./OnboardingCard";
import { OnboardingPage } from "./OnboardingPage";
import type { OnboardingDetail, OnboardingOverview, StuckRow } from "./types";

const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const wsPixel = "10000000-0000-4000-8000-0000000000a1";
const row = (over: Partial<StuckRow>): StuckRow => ({
  id: wsPixel, name: "Pixel Forge", slug: "pixel-forge", members: 4, createdAt: ago(5), plan: "team_s", subStatus: "trialing", trialDaysLeft: 9,
  done: 2, stuckStep: "team", stuckDays: 5, lastActiveAt: ago(1), followup: null, ...over,
});
const overview: OnboardingOverview = {
  days: 30,
  version: 1,
  kpis: { newWorkspaces: 214, trial: 168, free: 46, completedPct: 22, avgDaysToComplete: 4.2, activatedPct: 38, stuckOver3: 3, stuckUnassigned: 2 },
  funnel: [
    { key: "first_project", passed: 214, pct: 100, avgDays: 0, drop: null },
    { key: "issues", passed: 175, pct: 82, avgDays: 1, drop: -18 },
    { key: "team", passed: 98, pct: 46, avgDays: 3, drop: -36 },
    { key: "assign_due", passed: 88, pct: 41, avgDays: 3, drop: -5 },
    { key: "status_update", passed: 83, pct: 39, avgDays: 4, drop: -2 },
    { key: "notifications", passed: 47, pct: 22, avgDays: 6, drop: -17 },
  ],
  insights: { biggestDrop: { key: "team", drop: -36, paidPassedPct: 41, paidOtherPct: 3 }, notificationsPct: 22 },
  stuck: [
    row({}),
    row({ id: "w2", name: "Kanit Labs", slug: "kanit-labs", members: 1, stuckStep: "issues", stuckDays: 3, trialDaysLeft: 11 }),
    row({ id: "w3", name: "ภูผา ซอฟต์", slug: "phupha", members: 6, plan: "team_s", subStatus: "active", trialDaysLeft: null, stuckStep: "notifications", stuckDays: 4, followup: { assigneeId: "s1", assigneeName: "Support A", status: "emailed", lastEmailedAt: ago(2) } }),
    row({ id: "w4", name: "Lumen Studio", slug: "lumen", stuckStep: "team", stuckDays: 6, trialDaysLeft: 6 }),
  ],
  inactive: [row({ id: "w5", name: "Northwind Dev", slug: "northwind", plan: "free", subStatus: "active", trialDaysLeft: null, stuckDays: 12, lastActiveAt: ago(20) })],
};
const detail: OnboardingDetail = {
  workspace: { id: wsPixel, name: "Pixel Forge", slug: "pixel-forge", createdAt: ago(5), members: 2, plan: "team_s", subStatus: "trialing", trialDaysLeft: 9, lastActiveAt: ago(1) },
  owner: { name: "คุณพิกเซล", email: "owner@pixelforge.example", suppressed: false },
  version: 1, done: 2, total: 6, complete: false, stuckStep: "team", stuckDays: 5, inactive: false,
  steps: [
    { key: "first_project", doneAt: ago(5), meta: { count: 1 } },
    { key: "issues", doneAt: ago(5), meta: { count: 46, imported: 46 } },
    { key: "team", doneAt: null, meta: {} },
    { key: "assign_due", doneAt: null, meta: {} },
    { key: "status_update", doneAt: null, meta: {} },
    { key: "notifications", doneAt: null, meta: {} },
  ],
  signals: { pendingInvites: 2, oldestInviteAt: ago(4), acceptedInvites: 1, active7d: 2, activeDays7d: 3, openTickets: 0, acquisition: { source: "blog", medium: "seo", via: "signup" } },
  followup: null,
  assignees: [{ id: "00000000-0000-4000-8000-000000000002", name: "Support A" }],
};
const canned = { items: [{ id: "c-other", title: "ทั่วไป", body: "สวัสดี", tag: null }, { id: "c-team", title: "คำเชิญยังไม่ถูกตอบรับ", body: "ทีม {ชื่อ Workspace} มีงานพร้อมแล้ว · คุณ{ชื่อผู้แจ้ง}", tag: "onboarding" }] };

function view(over: Partial<OnboardingDetail> = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  server.use(
    http.get(`${OPS}/onboarding`, ({ request }) => (calls.push({ method: "GET", url: request.url, body: null }), HttpResponse.json(overview))),
    http.get(`${OPS}/onboarding/workspaces/:id`, () => HttpResponse.json({ ...detail, ...over })),
    http.get(`${OPS}/support/canned-replies`, () => HttpResponse.json(canned)),
    http.put(`${OPS}/onboarding/workspaces/:id/followup`, async ({ request }) => (calls.push({ method: "PUT", url: request.url, body: await request.json() }), HttpResponse.json({ followup: {} }))),
    http.post(`${OPS}/onboarding/workspaces/:id/email`, async ({ request }) => (calls.push({ method: "POST", url: request.url, body: await request.json() }), HttpResponse.json({ followup: {} }))),
  );
  navigation.pathname = "/onboarding";
  renderWithProviders(
    <AppShell>
      <OnboardingPage />
    </AppShell>,
  );
  return calls;
}

describe("Onboarding checklist (บอร์ด 18)", () => {
  it("KPI · แถบผ่านแต่ละขั้นพร้อมจำนวนที่หลุดและเวลาเฉลี่ย · ข้อสังเกต · เมนูเปิดใช้แล้ว · ไม่มีปุ่มแก้ขั้นตอน (V6)", async () => {
    const calls = view();
    expect(await screen.findByText("214")).toBeInTheDocument();
    expect(screen.getByText("ทดลอง 168 · Free 46")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "KPI" })).getByText("22%")).toBeInTheDocument();
    expect(screen.getByText("เฉลี่ย 4.2 วัน")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่มีคนติดตาม 2")).toBeInTheDocument();
    const funnel = screen.getByRole("list", { name: "ผ่านแต่ละขั้น" });
    const third = within(funnel).getAllByRole("listitem")[2];
    expect(third).toHaveTextContent("3. สมาชิก ≥ 3");
    expect(third).toHaveTextContent("46%");
    expect(third).toHaveTextContent("−36");
    expect(third).toHaveTextContent("3 วัน");
    expect(screen.getByText(/หลุดมากสุดที่ สมาชิก ≥ 3 \(−36\) · Workspace ที่ผ่านขั้นนี้จ่ายเงิน 41% ส่วนที่ไม่ผ่านจ่าย 3%/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "แก้ขั้นตอน" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Onboarding checklist/ })).toHaveAttribute("href", "/onboarding");
    await userEvent.click(screen.getByRole("button", { name: "90 วัน" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/onboarding?days=90"))).toBe(true));
  });

  it("ตารางลูกค้าที่ติดพร้อมตัวกรอง: เกิน 3 วัน · ทดลองเหลือ ≤ 7 วัน · ยังไม่มีคนติดตาม · ตามขั้น · หยุดใช้", async () => {
    view();
    const table = (await screen.findByText("Pixel Forge")).closest("table")!;
    // ค่าเริ่มต้น: ติดเกิน 3 วัน (Kanit Labs ติด 3 วันพอดีไม่นับ)
    expect(within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["Pixel Forgepixel-forge · 4 คน", "ภูผา ซอฟต์phupha · 6 คน", "Lumen Studiolumen · 4 คน"]);
    expect(within(table).getByText("ทดลอง · เหลือ 9 วัน")).toBeInTheDocument();
    expect(within(table).getByText(/ส่งอีเมลแล้ว/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ทดลองใช้เหลือ ≤ 7 วัน · 1" }));
    expect(screen.getByText("Lumen Studio")).toBeInTheDocument();
    expect(screen.queryByText("Pixel Forge")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ยังไม่มีคนติดตาม · 2" }));
    expect(screen.queryByText("ภูผา ซอฟต์")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ขั้น 3 · 2" }));
    expect(screen.getByText("Pixel Forge")).toBeInTheDocument();
    expect(screen.queryByText("Kanit Labs")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "หยุดใช้ · 1" }));
    expect(screen.getByText("Northwind Dev")).toBeInTheDocument();
  });

  it("ติดตาม (V5): ลำดับขั้นและสัญญาณ · เลือกข้อความสำเร็จรูปแล้วเห็นตัวอย่างอีเมลที่แทนตัวแปร · ส่งอีเมล", async () => {
    const calls = view();
    const pixel = (await screen.findByText("Pixel Forge")).closest("tr")!;
    await userEvent.click(within(pixel).getByRole("button", { name: "ติดตาม" }));
    const drawer = await screen.findByRole("dialog", { name: "ติดตาม Pixel Forge" });
    expect(await within(drawer).findByText("2. งาน ≥ 10")).toBeInTheDocument();
    expect(within(drawer).getByText(/นำเข้า Excel 46 งาน/)).toBeInTheDocument();
    expect(within(drawer).getByText(/ติดมา 5 วัน · ตอบรับแล้ว 1 · คำเชิญค้าง 2/)).toBeInTheDocument();
    expect(within(drawer).getByText("2 คน · เข้า 3 วันใน 7 วัน")).toBeInTheDocument();
    expect(within(drawer).getByText("blog / seo")).toBeInTheDocument();
    expect(within(drawer).getByText(/owner@pixelforge.example/)).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "ส่งอีเมล" })).toBeDisabled();
    // ข้อความของ Onboarding ขึ้นก่อน
    const select = await within(drawer).findByLabelText("ข้อความสำเร็จรูป");
    await waitFor(() => expect(within(select as HTMLSelectElement).getAllByRole("option").map((o) => o.textContent)).toEqual(["— เขียนเอง —", "คำเชิญยังไม่ถูกตอบรับ", "ทั่วไป"]));
    await userEvent.selectOptions(select, "c-team");
    expect(within(drawer).getByText("ทีม Pixel Forge มีงานพร้อมแล้ว · คุณคุณพิกเซล")).toBeInTheDocument();
    await userEvent.selectOptions(within(drawer).getByLabelText("ผู้ติดตาม"), "Support A");
    await userEvent.type(within(drawer).getByLabelText(/บันทึกภายใน/), "นำเข้าแผนแล้ว");
    await userEvent.click(within(drawer).getByRole("button", { name: "ส่งอีเมล" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ subject: "คำเชิญยังไม่ถูกตอบรับ", body: "ทีม {ชื่อ Workspace} มีงานพร้อมแล้ว · คุณ{ชื่อผู้แจ้ง}", cannedId: "c-team", assigneeId: "00000000-0000-4000-8000-000000000002", note: "นำเข้าแผนแล้ว" });
    expect(await screen.findByText("ส่งอีเมลเข้าคิวแล้ว")).toBeInTheDocument();
  });

  it("บันทึกอย่างเดียว · Owner อยู่ในรายชื่อไม่ส่ง / ส่งไปแล้วใน 7 วัน = ปุ่มส่งปิด · Error จาก API แสดงในฟอร์ม", async () => {
    const calls = view({ owner: { name: "คุณพิกเซล", email: "owner@pixelforge.example", suppressed: true } });
    await userEvent.click(within((await screen.findByText("Pixel Forge")).closest("tr")!).getByRole("button", { name: "ติดตาม" }));
    const drawer = await screen.findByRole("dialog", { name: "ติดตาม Pixel Forge" });
    expect(await within(drawer).findByText(/อยู่ในรายชื่อไม่ส่ง/)).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("หัวข้ออีเมล"), "ช่วยเริ่มใช้งาน");
    await userEvent.type(within(drawer).getByLabelText("ข้อความ"), "สวัสดี");
    expect(within(drawer).getByRole("button", { name: "ส่งอีเมล" })).toBeDisabled();
    await userEvent.selectOptions(within(drawer).getByLabelText("สถานะการติดตาม"), "no_reply");
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึกอย่างเดียว" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ assigneeId: null, status: "no_reply", note: null }));

    server.use(http.put(`${OPS}/onboarding/workspaces/:id/followup`, () => opsError(422, "invalid_assignee", "ผู้ติดตามต้องเป็นพนักงาน Owner หรือ Support ที่ใช้งานอยู่")));
    await userEvent.click(within((await screen.findByText("Pixel Forge")).closest("tr")!).getByRole("button", { name: "ติดตาม" }));
    const again = await screen.findByRole("dialog", { name: "ติดตาม Pixel Forge" });
    await within(again).findByText("1. Workspace + โปรเจกต์แรก");
    await userEvent.click(within(again).getByRole("button", { name: "บันทึกอย่างเดียว" }));
    expect(await within(again).findByText(/ผู้ติดตามต้องเป็นพนักงาน/)).toBeInTheDocument();
  });

  it("ส่งไปแล้วไม่ถึง 7 วัน: บอกวันที่ส่งได้อีกครั้ง", async () => {
    view({ followup: { assigneeId: null, assigneeName: null, status: "emailed", note: null, lastEmailedAt: ago(2), emailsSent: 1, nextEmailAt: new Date(Date.now() + 5 * 86_400_000).toISOString() } });
    await userEvent.click(within((await screen.findByText("Pixel Forge")).closest("tr")!).getByRole("button", { name: "ติดตาม" }));
    const drawer = await screen.findByRole("dialog", { name: "ติดตาม Pixel Forge" });
    expect(await within(drawer).findByText(/ส่งครั้งถัดไปได้/)).toBeInTheDocument();
  });

  it("สิทธิ์: การเงินอ่านอย่างเดียว (ไม่มีปุ่มติดตาม) · วิศวกรไม่เห็นหน้าและเมนู", async () => {
    asRole("finance");
    view();
    await screen.findByText("Pixel Forge");
    expect(screen.queryByRole("button", { name: "ติดตาม" })).not.toBeInTheDocument();
    expect(screen.getByText(/ดูได้อย่างเดียว/)).toBeInTheDocument();
  });

  it("วิศวกรได้หน้าไม่มีสิทธิ์และไม่เรียก API", async () => {
    asRole("engineer");
    const calls = view();
    expect(await screen.findByText(/ดูหน้านี้ไม่ได้/)).toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(screen.queryByRole("link", { name: /Onboarding checklist/ })).not.toBeInTheDocument();
  });
});

describe("การ์ด Onboarding ในรายละเอียดลูกค้า (V7)", () => {
  it("ยังไม่ครบ: 3 / 6 · ติดที่ขั้นไหนกี่วัน · ผู้ติดตาม · ปุ่มติดตามเปิด V5", async () => {
    server.use(
      http.get(`${OPS}/onboarding/workspaces/:id`, () => HttpResponse.json({ ...detail, done: 3, followup: { ...detail, assigneeId: "s", assigneeName: "Support C", status: "open", note: null, lastEmailedAt: null, emailsSent: 0, nextEmailAt: null } })),
      http.get(`${OPS}/support/canned-replies`, () => HttpResponse.json(canned)),
    );
    renderWithProviders(<OnboardingCard workspaceId={wsPixel} />);
    const card = await screen.findByRole("region", { name: "Onboarding" });
    expect(within(card).getByText("3 / 6")).toBeInTheDocument();
    expect(within(card).getByText("3. สมาชิก ≥ 3 · 5 วัน")).toBeInTheDocument();
    expect(within(card).getByText("Support C")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "ติดตาม" }));
    expect(await screen.findByRole("dialog", { name: "ติดตาม Pixel Forge" })).toBeInTheDocument();
  });

  it("ครบแล้ว หรือโหลดไม่ได้ = ไม่แสดงการ์ด", async () => {
    let hits = 0;
    server.use(http.get(`${OPS}/onboarding/workspaces/:id`, () => (hits++, opsError(403, "forbidden", "ไม่มีสิทธิ์"))));
    renderWithProviders(<OnboardingCard workspaceId={wsPixel} />);
    await waitFor(() => expect(hits).toBe(1));
    expect(screen.queryByRole("region", { name: "Onboarding" })).not.toBeInTheDocument();
    // ครบแล้ว (ค่าเริ่มต้นของ test server)
    server.resetHandlers();
    renderWithProviders(<OnboardingCard workspaceId="10000000-0000-4000-8000-0000000000a2" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "Onboarding" })).not.toBeInTheDocument();
  });
});
