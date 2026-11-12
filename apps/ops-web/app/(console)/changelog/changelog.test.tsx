// O33 · หน้า Changelog และ NPS: ตาราง / เขียน / ซ่อน · NPS ตัวเลขรวม / ความเห็น / ติดตาม / ตั้งค่า · ซ่อนปุ่มตามบทบาท · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { ChangelogPage } from "./ChangelogPage";
import type { ChangelogData, Entry, NpsDetail, NpsResponse, NpsSettings, NpsSummary } from "./_parts/types";

const entry = (over: Partial<Entry>): Entry => ({
  id: "e-1", kind: "new", title: "ขอเลื่อน Due ผ่าน LINE ได้แล้ว", summary: "กดอนุมัติ / ปฏิเสธจากข้อความใน LINE ได้ทันที", body: "", titleEn: null, summaryEn: null, bodyEn: null,
  mediaUrl: null, mediaKind: null, mediaAlt: null, ctaLabel: "ผูก LINE", ctaLabelEn: null, ctaPath: "/profile?tab=notify", audience: "all", audiencePlans: [], audienceFlag: null,
  spotlight: true, showPublic: true, status: "published", displayDate: null, publishedAt: "2026-11-10T02:00:00.000Z", hiddenAt: null, hideReason: null,
  createdAt: "2026-11-09T02:00:00.000Z", updatedAt: "2026-11-10T02:00:00.000Z", views: 1284, clicks: 231, viewPct: 61, clickPct: 18, flagWorkspaces: null, createdBy: "แอดมินตัวอย่าง", devIssueKey: null, ...over,
});
const changelog: ChangelogData = {
  items: [
    entry({}),
    entry({ id: "e-2", kind: "improved", title: "Gantt ลากหลายงานพร้อมกัน", summary: "เลือกหลายแถวแล้วเลื่อนวันทีเดียว", audience: "plans", audiencePlans: ["team_s", "team_m", "team_l", "enterprise"], spotlight: false, status: "scheduled", publishedAt: "2026-11-15T02:00:00.000Z", views: 0, clicks: 0, viewPct: 0, clickPct: null, ctaLabel: null, ctaPath: null }),
    entry({ id: "e-3", kind: "fixed", title: "นำเข้า Excel: เตือนเมื่อคอลัมน์ Parent Key ว่าง", spotlight: false, devIssueKey: "FM-482", views: 980, viewPct: 46, clickPct: null, ctaLabel: null, ctaPath: null }),
    entry({ id: "e-4", title: "หน้ารวมสำหรับเจ้าของบริษัท", spotlight: false, audience: "flag", audienceFlag: "reports.owner_dashboard", flagWorkspaces: 21, status: "draft", publishedAt: null, views: 0, clicks: 0, viewPct: null, clickPct: null }),
  ],
  kpis: { published30: 6, byKind: { new: 3, improved: 2, fixed: 1 }, activeUsers30: 2100, readers30: 1218, readersPct: 58, clickPct: 14 },
};
const summary: NpsSummary = {
  range: "90d", score: 32, delta: 4, answered: 95, asked: 412, dismissed: 248, promotersPct: 48, passivesPct: 36, detractorsPct: 16,
  groups: { detractor: 15, passive: 34, promoter: 46 }, openDetractors: 4,
  monthly: [
    { month: "2026-06", answered: 10, score: 22 }, { month: "2026-07", answered: 12, score: 25 }, { month: "2026-08", answered: 14, score: 24 },
    { month: "2026-09", answered: 15, score: 28 }, { month: "2026-10", answered: 20, score: 30 }, { month: "2026-11", answered: 24, score: 32 },
  ],
  byPlan: [{ plan: "free", answered: 31, score: 12 }, { plan: "team_s", answered: 28, score: 28 }],
  topics: [{ topic: "speed", count: 6 }, { topic: "price", count: 4 }],
};
const response = (over: Partial<NpsResponse>): NpsResponse => ({
  id: "r-1", score: 3, comment: "Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน", topics: ["speed"], tags: [], role: "admin", plan: "team_s", createdAt: "2026-11-11T07:12:00.000Z",
  followUpStatus: "open", note: null, followedUpAt: null, followedUpBy: null, workspace: { id: "w-1", name: "Kanit Labs", slug: "kanit-labs" }, ticket: null, ...over,
});
const responses = [response({}), response({ id: "r-2", score: 10, comment: "ขอเลื่อน Due ผ่าน LINE ช่วยทีมได้มาก", workspace: { id: "w-2", name: "สยามโค้ด", slug: "siam-code" }, ticket: { id: "t-1", number: 521 } })];
const detail: NpsDetail = { ...responses[0], context: { previous: { score: 7, at: "2026-08-02T03:00:00.000Z" }, health: 52, members: 6, tickets90: { count: 1, latest: { number: 488, subject: "Gantt โหลดช้า", status: "closed" } } } };
const settings: NpsSettings = {
  enabled: true, audience: "admins", firstAfterDays: 30, repeatDays: 90, samplePct: 50, excludeTrialDays: 14, excludeTicketDays: 7, excludeSpotlightDay: true, excludeShortMobile: false,
  question: "คุณจะแนะนำ Friday Manage ให้เพื่อนหรือเพื่อนร่วมงานไหม", questionEn: null,
  followUps: { detractor: "อะไรที่เราควรปรับให้ดีขึ้นที่สุด", passive: "อะไรที่จะทำให้ให้ 10 คะแนน", promoter: "ชอบอะไรที่สุด" }, followUpsEn: null,
  topics: ["speed", "usability", "missing_feature", "price", "mobile"], updatedAt: "2026-11-12T00:00:00.000Z",
};

const calls: { method: string; path: string; body?: unknown }[] = [];
const record = async (request: Request) => {
  const text = await request.text();
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname.replace(/^.*\/ops-api/, "") + url.search, body: text ? JSON.parse(text) : undefined });
};
function handlers(data: ChangelogData = changelog) {
  server.use(
    http.get(`${OPS}/changelog`, () => HttpResponse.json(data)),
    http.post(`${OPS}/changelog`, async ({ request }) => (await record(request), HttpResponse.json({ item: entry({ id: "e-new", title: "ใหม่" }), spotlightMovedFrom: "ขอเลื่อน Due ผ่าน LINE ได้แล้ว" }, { status: 201 }))),
    http.put(`${OPS}/changelog/:id`, async ({ request }) => (await record(request), HttpResponse.json({ item: entry({}), spotlightMovedFrom: null }))),
    http.post(`${OPS}/changelog/:id/hide`, async ({ request }) => (await record(request), HttpResponse.json(entry({ status: "hidden" })))),
    http.get(`${OPS}/nps/summary`, () => HttpResponse.json(summary)),
    http.get(`${OPS}/nps/responses`, async ({ request }) => (await record(request), HttpResponse.json({ items: responses }))),
    http.get(`${OPS}/nps/responses/:id`, () => HttpResponse.json(detail)),
    http.patch(`${OPS}/nps/responses/:id`, async ({ request }) => (await record(request), HttpResponse.json(detail))),
    http.post(`${OPS}/nps/responses/:id/ticket`, async ({ request }) => (await record(request), HttpResponse.json({ ...detail, ticket: { id: "t-9", number: 530 } }))),
    http.get(`${OPS}/nps/settings`, () => HttpResponse.json({ settings, eligible: { admins: 280, members: 900 }, canEdit: true })),
    http.put(`${OPS}/nps/settings`, async ({ request }) => (await record(request), HttpResponse.json({ settings, eligible: { admins: 280, members: 900 }, canEdit: true }))),
    http.get(`${OPS}/feature-flags`, () => HttpResponse.json({ items: [{ id: "f-1", key: "reports.owner_dashboard", description: null, defaultOn: false, createdAt: "", updatedAt: "", overrides: [] }] })),
  );
}
function view(search = "") {
  navigation.pathname = "/changelog";
  navigation.search = search;
  renderWithProviders(
    <AppShell>
      <ChangelogPage />
    </AppShell>,
  );
}

beforeEach(() => {
  calls.length = 0;
});

describe("Changelog (บอร์ด 17)", () => {
  it("KPI · ตารางพร้อมสถานะ ใครเห็น ยอดเห็น / คลิก · ตัวอย่างที่ลูกค้าเห็น · เมนูเปิดใช้แล้ว", async () => {
    handlers();
    view();
    const table = (await screen.findByText("Gantt ลากหลายงานพร้อมกัน")).closest("table")!;
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("Spotlight")).toBeInTheDocument();
    expect(within(rows[0]).getByText("ทุกแพ็กเกจ")).toBeInTheDocument();
    expect(within(rows[0]).getByText("1,284 (61%)")).toBeInTheDocument();
    expect(within(rows[0]).getByText("18%")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Team ขึ้นไป")).toBeInTheDocument();
    expect(within(rows[1]).getByText(/^ตั้งเวลา /)).toBeInTheDocument();
    expect(within(rows[2]).getByText("มาจาก FM-482")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Workspace ที่เปิด flag (21)")).toBeInTheDocument();
    expect(within(rows[3]).getByText("ร่าง")).toBeInTheDocument();
    expect(screen.getByText("ใหม่ 3 · ปรับปรุง 2 · แก้ไข 1")).toBeInTheDocument();
    expect(screen.getByText("58%")).toBeInTheDocument();
    expect(await screen.findByText("+32")).toBeInTheDocument();
    const aside = screen.getByRole("complementary", { name: "ลูกค้าเห็นแบบนี้" });
    expect(within(aside).getByText("ขอเลื่อน Due ผ่าน LINE ได้แล้ว")).toBeInTheDocument();
    expect(within(aside).getByText("ผูก LINE")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Changelog และ NPS" })).toHaveAttribute("href", "/changelog");
    expect(screen.getByRole("link", { name: "ธุรกิจและกำไร › เหตุผลที่ยกเลิก" })).toHaveAttribute("href", "/business");
    // กรองสถานะ
    await userEvent.click(screen.getByRole("button", { name: "ร่าง" }));
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("เขียนรายการใหม่ (U4): ตรวจช่องบังคับ · ตามแพ็กเกจ · Spotlight ที่มีอยู่แล้วเตือน · เผยแพร่ → ส่งค่าครบ", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: "เขียนรายการใหม่" }));
    const dlg = await screen.findByRole("dialog", { name: "เขียนรายการ Changelog" });
    await userEvent.click(within(dlg).getByRole("button", { name: "เผยแพร่ทันที" }));
    expect(within(dlg).getByText("กรอกหัวข้อและสรุปสั้น")).toBeInTheDocument();
    expect(calls).toEqual([]);
    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "สรุปงานประจำวันทางอีเมล");
    await userEvent.type(within(dlg).getByLabelText("สรุปสั้น (แสดงในแผง) *"), "งานครบกำหนดวันนี้รวมในอีเมลเดียว");
    expect(within(dlg).getByText(/^ไม่เกิน 140 ตัวอักษร · \d+\/140$/)).toBeInTheDocument();
    await userEvent.selectOptions(within(dlg).getByLabelText('ปุ่ม "ลองใช้" พาไป'), "/profile?tab=notify");
    await userEvent.type(within(dlg).getByLabelText('ข้อความปุ่ม "ลองใช้"'), "ตั้งค่าอีเมล");
    await userEvent.click(within(dlg).getByRole("radio", { name: /ตามแพ็กเกจ/ }));
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "Team M" }));
    await userEvent.click(within(dlg).getByRole("checkbox", { name: /แสดงเป็น Spotlight/ }));
    expect(within(dlg).getByText(/ตอนนี้ "ขอเลื่อน Due ผ่าน LINE ได้แล้ว" เป็น Spotlight อยู่/)).toBeInTheDocument();
    expect(within(dlg).getByText("ภาษาอังกฤษ: ยังไม่ได้เขียน · ผู้ใช้ภาษาอังกฤษจะเห็นฉบับไทย")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ดูตัวอย่าง" }));
    const pv = await screen.findByRole("dialog", { name: "ตัวอย่างในแอปลูกค้า" });
    expect(within(pv).getByText("สรุปงานประจำวันทางอีเมล")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(await screen.findByRole("dialog", { name: "เขียนรายการ Changelog" })).getByRole("button", { name: "เผยแพร่ทันที" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/changelog",
      body: { kind: "new", title: "สรุปงานประจำวันทางอีเมล", summary: "งานครบกำหนดวันนี้รวมในอีเมลเดียว", ctaPath: "/profile?tab=notify", ctaLabel: "ตั้งค่าอีเมล", audience: "plans", audiencePlans: ["team_m"], spotlight: true, action: "publish", publishAt: null, titleEn: null },
    });
    expect(await screen.findByText('ย้าย Spotlight จาก "ขอเลื่อน Due ผ่าน LINE ได้แล้ว" มาที่รายการนี้แล้ว')).toBeInTheDocument();
  });

  it("แก้รายการที่เผยแพร่แล้ว: ไม่มีปุ่มบันทึกร่าง · บันทึกการแก้ไข = PUT action publish", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: "เปิด ขอเลื่อน Due ผ่าน LINE ได้แล้ว" }));
    const dlg = await screen.findByRole("dialog", { name: "แก้รายการ Changelog" });
    expect(within(dlg).queryByRole("button", { name: "บันทึกร่าง" })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึกการแก้ไข" }));
    await waitFor(() => expect(calls).toEqual([expect.objectContaining({ method: "PUT", path: "/changelog/e-1", body: expect.objectContaining({ action: "publish" }) })]));
  });

  it("ซ่อน (U7): ต้องใส่เหตุผล → ส่ง hide", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: "ซ่อน Gantt ลากหลายงานพร้อมกัน" }));
    await userEvent.click(await screen.findByRole("button", { name: "ซ่อน" }));
    const dlg = await screen.findByRole("dialog", { name: 'ซ่อน "Gantt ลากหลายงานพร้อมกัน"?' });
    expect(within(dlg).getByText(/ตั้งเวลาไว้ .+ · ยังไม่มีใครเห็น/)).toBeInTheDocument();
    expect(within(dlg).getByText("รายการที่เผยแพร่แล้วซ่อนได้ แต่คนที่เปิดอ่านไปแล้วจะไม่ได้รับแจ้งว่าถูกถอน")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ซ่อนรายการ" }));
    expect(calls).toEqual([]);
    await userEvent.type(within(dlg).getByLabelText("เหตุผล"), "เลื่อนเปิดฟีเจอร์ไปสัปดาห์หน้า");
    await userEvent.click(within(dlg).getByRole("button", { name: "ซ่อนรายการ" }));
    await waitFor(() => expect(calls).toEqual([{ method: "POST", path: "/changelog/e-2/hide", body: { reason: "เลื่อนเปิดฟีเจอร์ไปสัปดาห์หน้า" } }]));
    expect(await screen.findByText('ซ่อน "Gantt ลากหลายงานพร้อมกัน" แล้ว')).toBeInTheDocument();
  });

  it("บทบาท: วิศวกรอ่านตารางได้ ไม่เห็นปุ่มเขียน / ซ่อน / แท็บ NPS", async () => {
    asRole("engineer");
    handlers();
    view();
    expect(await screen.findByText("Gantt ลากหลายงานพร้อมกัน")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "เขียนรายการใหม่" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ตั้งค่าแบบสำรวจ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ซ่อน / })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /NPS/ })).not.toBeInTheDocument();
    expect(screen.queryByText("NPS 90 วัน")).not.toBeInTheDocument();
  });

  it("ว่าง: ชวนเขียนรายการแรก · โหลดไม่สำเร็จแสดง requestId", async () => {
    handlers({ ...changelog, items: [] });
    view();
    expect(await screen.findByText("ยังไม่มีรายการ")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "เขียนรายการใหม่" })).toHaveLength(2);
  });

  it("โหลดไม่สำเร็จ: แสดง requestId และปุ่มลองใหม่", async () => {
    handlers();
    server.use(http.get(`${OPS}/changelog`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req_cl01")));
    view();
    expect(await screen.findByText(/req_cl01/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ลองใหม่" })).toBeInTheDocument();
  });
});

describe("NPS (บอร์ด 17)", () => {
  it("ตัวเลขรวม · แนวโน้ม · แยกแพ็กเกจ · ความเห็นพร้อมตัวกรอง · ลิงก์คำตอบตอนยกเลิก", async () => {
    handlers();
    view("tab=nps");
    expect(await screen.findByText("48%")).toBeInTheDocument();
    expect(screen.getByText("+4 จากช่วงก่อน")).toBeInTheDocument();
    expect(screen.getByText("412 / 95 (23%)")).toBeInTheDocument();
    expect(screen.getByText("248")).toBeInTheDocument();
    expect(screen.getByText("หัวข้อที่พูดถึงบ่อย: ความเร็ว 6 · ราคา 4")).toBeInTheDocument();
    const plans = screen.getByRole("region", { name: "แยกตามแพ็กเกจ" });
    expect(within(plans).getByText("Free")).toBeInTheDocument();
    expect(within(plans).getByText("+12")).toBeInTheDocument();
    const comments = screen.getByRole("region", { name: "ความเห็น" });
    expect(await within(comments).findByText("Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน")).toBeInTheDocument();
    expect(within(comments).getByText("Ticket #521")).toBeInTheDocument();
    await userEvent.click(within(comments).getByRole("button", { name: "ไม่พอใจ 0–6 · 15" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/nps/responses?range=90d&group=detractor")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "12 เดือน" }));
    await waitFor(() => expect(calls.some((c) => c.path.startsWith("/nps/responses?range=12m"))).toBe(true));
    expect(screen.getByRole("link", { name: "คำตอบตอนยกเลิก ↗" })).toHaveAttribute("href", "/business");
  });

  it("การเงิน / ผู้ตรวจ: เห็นตัวเลขรวมเท่านั้น (ไม่โหลดความเห็น)", async () => {
    asRole("finance");
    handlers();
    view("tab=nps");
    expect((await screen.findAllByText("+32")).length).toBeGreaterThan(0);
    expect(screen.getByText("บทบาทของคุณเห็นเฉพาะตัวเลขรวม · ความเห็นพร้อมชื่อ Workspace เปิดให้ Owner และ Support")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ความเห็น" })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith("/nps/responses"))).toEqual([]);
    expect(screen.queryByRole("button", { name: "ตั้งค่าแบบสำรวจ" })).not.toBeInTheDocument();
  });

  it("ติดตาม (U6): ข้อมูลประกอบ · เพิ่มหัวข้อ + บันทึกภายใน · ทำเครื่องหมายว่าติดตามแล้ว · เปิด Ticket ที่เติมข้อความ", async () => {
    asRole("support");
    handlers();
    view("tab=nps");
    await userEvent.click(await screen.findByRole("button", { name: "ติดตามความเห็นคะแนน 3 ของ Kanit Labs" }));
    const dlg = await screen.findByRole("dialog", { name: "ความเห็นคะแนน 3 · Kanit Labs" });
    expect(await within(dlg).findByText(/^7 \(/)).toBeInTheDocument();
    expect(within(dlg).getByText("52")).toBeInTheDocument();
    expect(within(dlg).getByText("1 · #488 Gantt โหลดช้า")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "+ เพิ่ม" }));
    await userEvent.type(within(dlg).getByLabelText("หัวข้อใหม่"), "Gantt{Enter}");
    await userEvent.type(within(dlg).getByLabelText("บันทึกภายใน"), "ส่งต่อทีมพัฒนาแล้วใน FM-455");
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: "/nps/responses/r-1", body: { tags: ["Gantt"], note: "ส่งต่อทีมพัฒนาแล้วใน FM-455" } }));
    await userEvent.click(within(dlg).getByRole("button", { name: "ทำเครื่องหมายว่าติดตามแล้ว" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ followUpStatus: "done" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "เปิด Ticket ติดตาม" }));
    expect(within(dlg).getByLabelText("หัวข้อ Ticket")).toHaveValue("ติดตามความเห็น NPS คะแนน 3 · Kanit Labs");
    expect(within(dlg).getByLabelText("ข้อความ")).toHaveValue('ความเห็นจากแบบสำรวจ NPS (คะแนน 3):\n"Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน"');
    await userEvent.click(within(dlg).getByRole("button", { name: "สร้าง Ticket" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.path).toBe("/nps/responses/r-1/ticket"));
    expect(await screen.findByText("เปิด Ticket #530 แล้ว")).toBeInTheDocument();
  });

  it("ตั้งค่าแบบสำรวจ (U5): Owner แก้ได้ · ประมาณจำนวนที่ถามต่อเดือน · บันทึก", async () => {
    handlers();
    view("tab=nps");
    await userEvent.click(await screen.findByRole("button", { name: "ตั้งค่าแบบสำรวจ" }));
    const dlg = await screen.findByRole("dialog", { name: "ตั้งค่าแบบสำรวจ NPS" });
    expect(await within(dlg).findByText(/คาดว่าจะถามประมาณ/)).toHaveTextContent("คาดว่าจะถามประมาณ 47 คน/เดือน จาก Owner และ Admin ที่เข้าเกณฑ์ 280 คน");
    expect(within(dlg).getByRole("checkbox", { name: "Workspace ที่ทดลองใช้ยังไม่ถึง 14 วัน" })).toBeChecked();
    expect(within(dlg).getByRole("checkbox", { name: "ผู้ใช้บนมือถือที่ใช้งานไม่ถึง 2 นาที" })).not.toBeChecked();
    await userEvent.selectOptions(within(dlg).getByLabelText("สุ่มถาม"), "100");
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "ผู้ที่มี Ticket เปิดอยู่ หรือเพิ่งปิดภายใน 7 วัน" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/nps/settings", body: { samplePct: 100, excludeTicketDays: null, audience: "admins" } }));
    expect((calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>).updatedAt).toBeUndefined();
    expect(await screen.findByText("บันทึกตั้งค่าแบบสำรวจแล้ว")).toBeInTheDocument();
  });
});
