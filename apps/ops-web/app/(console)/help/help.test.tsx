// O35 · ศูนย์ช่วยเหลือของ Friday Ops: รายการ / KPI / แท็บ · ตัวแก้บทความ (บันทึกอัตโนมัติ เผยแพร่ ตัวอย่าง เวอร์ชัน) · X8 · X9 · ซ่อนตามบทบาท
// ข้อมูลสมมติเท่านั้น
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { SupportPage } from "../support/SupportPage";
import { ArticleEditor } from "./[id]/ArticleEditor";
import type { Article, ArticleDetail, ArticleRow, Category, Overview } from "./_components/types";
import { HelpPage } from "./HelpPage";

// หน้าเหล่านี้ยิงหลายคำขอพร้อมกัน · เครื่องที่โหลดสูง (build อื่นรันอยู่) ใช้เวลานานกว่าค่าเริ่มต้น 1 วินาที / 5 วินาที
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30000 });

const C1 = "c0000000-0000-4000-8000-000000000001";
const C2 = "c0000000-0000-4000-8000-000000000002";
const A1 = "a0000000-0000-4000-8000-000000000001";
const categories: Category[] = [
  { id: C1, slug: "import-export", name: "นำเข้า / ส่งออก Excel", nameEn: null, position: 1, articles: 6 },
  { id: C2, slug: "notifications", name: "แจ้งเตือน LINE และอีเมล", nameEn: null, position: 2, articles: 0 },
];
const overview: Overview = {
  kpi: { published: 64, review: 5, drafts: 3, searches30: 3912, misses30: 318, missPct: 8, deflectionPct: 71, helpfulPct: 86, votes30: 1140 },
  tabs: { articles: 72, misses: 23, review: 5 },
  topMisses: [
    { query: "ลบ sprint", searches: 41, tickets: 6, articleId: null },
    { query: "สีสถานะ", searches: 12, tickets: 0, articleId: A1 },
  ],
  canEdit: true,
};
const row = (over: Partial<ArticleRow>): ArticleRow => ({
  id: A1, slug: "import-excel-update", title: "นำเข้าแผนงานจาก Excel แบบอัปเดต", category: { id: C1, name: "นำเข้า / ส่งออก Excel" }, status: "published",
  needsReview: false, reviewReason: null, reads30: 1204, helpfulPct: 91, votes: 40, tickets: 4, updatedAt: "2026-11-08T03:00:00.000Z", owner: { id: "s1", name: "ซัพพอร์ตตัวอย่าง" }, hasDraft: false, ...over,
});
const rows = [row({}), row({ id: "a2", slug: "line-troubleshoot", title: "LINE ไม่แจ้งเตือน: ตรวจ 4 จุด", needsReview: true, reviewReason: "low_helpful", helpfulPct: 62, reads30: 412 }), row({ id: "a3", slug: "restore-deleted", title: "กู้คืนงานและโปรเจกต์ที่ลบผิด", status: "draft", helpfulPct: null, reads30: 0, owner: null })];

const article: Article = {
  id: A1, slug: "restore-deleted", status: "published", categoryId: C1, title: "กู้คืนงานและโปรเจกต์ที่ลบผิด", summary: "งานที่ลบอยู่ในถังขยะ 30 วัน",
  body: "## ลบผิดแล้วกู้คืนได้ไหม\nได้ภายใน **30 วัน** ดูที่ [ถังขยะ](app:/admin/trash)\n:::warning\nเกิน 30 วันแล้ว ติดต่อทีม Support\n:::\n- ข้อแรก\n- ข้อสอง",
  titleEn: null, summaryEn: null, bodyEn: null, visibility: "public", appRoutes: ["admin.trash"], keywords: "trash, restore", reviewAt: "2027-02-12",
  ownerId: null, piiCheckedAt: "2026-11-01T03:00:00.000Z", version: 3, publishedAt: "2026-11-01T03:00:00.000Z", draftSavedAt: null, hasDraft: false, updatedAt: "2026-11-01T03:00:00.000Z",
};
const detail: ArticleDetail = {
  article,
  versions: [
    { version: 3, publishedAt: "2026-11-01T03:00:00.000Z", publishedBy: "ซัพพอร์ตตัวอย่าง" },
    { version: 2, publishedAt: "2026-10-20T03:00:00.000Z", publishedBy: "แอดมินตัวอย่าง" },
  ],
  sourceTicket: { id: "t-530", number: 530 },
  canEdit: true,
};

type Call = { method: string; path: string; body: unknown };
function listPage(search = "") {
  const calls: Call[] = [];
  const rec = (method: string, path: string, body: unknown) => calls.push({ method, path, body });
  server.use(
    http.get(`${OPS}/help/overview`, () => HttpResponse.json(overview)),
    http.get(`${OPS}/help/categories`, () => HttpResponse.json({ items: categories })),
    http.get(`${OPS}/help/articles`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      rec("GET", `/help/articles?${q}`, null);
      if (q.get("review") === "1") return HttpResponse.json({ items: rows.filter((r) => r.needsReview) });
      if (q.get("status") === "draft") return HttpResponse.json({ items: rows.filter((r) => r.status === "draft") });
      if (q.get("q") === "ไม่มี") return HttpResponse.json({ items: [] });
      return HttpResponse.json({ items: rows });
    }),
    http.get(`${OPS}/help/misses`, () => HttpResponse.json({ items: [{ query: "ลบ sprint", searches: 41, tickets: 6, articleId: null, articleTitle: null, lastDay: "2026-11-11" }, { query: "สีสถานะ", searches: 12, tickets: 0, articleId: A1, articleTitle: "สีของสถานะงาน", lastDay: "2026-11-10" }] })),
    http.post(`${OPS}/help/articles`, async ({ request }) => (rec("POST", "/help/articles", await request.json()), HttpResponse.json({ article: { ...article, id: "new-1", status: "draft" } }, { status: 201 }))),
    http.put(`${OPS}/help/categories`, async ({ request }) => (rec("PUT", "/help/categories", await request.json()), HttpResponse.json({ items: categories }))),
    http.get(`${OPS}/help/from-ticket/:id`, () =>
      HttpResponse.json({ ticket: { id: "t-509", number: 509, subject: "LINE OA ไม่แจ้งเตือนในกลุ่ม", cause: "ปลายทางถูกลบที่ LINE", status: "solved" }, draft: { title: "LINE ไม่แจ้งเตือนในกลุ่ม: ตรวจ 4 จุด", body: "1. ตรวจว่ายังเชิญ Friday Manage เป็นสมาชิกกลุ่ม", categoryId: C2 } }),
    ),
    http.post(`${OPS}/help/from-ticket/:id`, async ({ request, params }) => (rec("POST", `/help/from-ticket/${params.id}`, await request.json()), HttpResponse.json({ article: { ...article, id: "from-509", status: "draft" } }, { status: 201 }))),
  );
  navigation.pathname = "/help";
  navigation.search = search;
  renderWithProviders(
    <AppShell>
      <HelpPage />
    </AppShell>,
  );
  return calls;
}

function editor(over: Partial<ArticleDetail> = {}) {
  const calls: Call[] = [];
  let current: ArticleDetail = { ...detail, ...over };
  server.use(
    http.get(`${OPS}/help/categories`, () => HttpResponse.json({ items: categories })),
    http.get(`${OPS}/help/articles/:id`, () => HttpResponse.json(current)),
    http.patch(`${OPS}/help/articles/:id`, async ({ request }) => {
      const body = (await request.json()) as Partial<Article>;
      calls.push({ method: "PATCH", path: "/help/articles/x", body });
      current = { ...current, article: { ...current.article, ...body, hasDraft: true } };
      return HttpResponse.json({ savedAt: "2026-11-12T03:42:00.000Z", article: current.article });
    }),
    http.post(`${OPS}/help/articles/:id/publish`, async ({ request }) => (calls.push({ method: "POST", path: "publish", body: await request.json() }), HttpResponse.json({ article: { ...current.article, version: 4, hasDraft: false } }))),
    http.post(`${OPS}/help/articles/:id/versions/:v/restore`, ({ params }) => (calls.push({ method: "POST", path: `restore/${params.v}`, body: null }), HttpResponse.json({ article: { ...current.article, version: 4 } }))),
    http.post(`${OPS}/help/articles/:id/archive`, () => (calls.push({ method: "POST", path: "archive", body: null }), HttpResponse.json({ article: { ...current.article, status: "archived" } }))),
    http.delete(`${OPS}/help/articles/:id`, () => (calls.push({ method: "DELETE", path: "delete", body: null }), HttpResponse.json({ deleted: true }))),
  );
  navigation.pathname = `/help/${A1}`;
  renderWithProviders(<ArticleEditor id={A1} />);
  return calls;
}

describe("ศูนย์ช่วยเหลือ · รายการบทความ (19)", () => {
  it("KPI · แท็บพร้อมจำนวน · ตาราง สถานะ / ช่วยได้ / ผู้ดูแล · เมนูเปิดใช้แล้ว", async () => {
    listPage();
    expect(await screen.findByText("3,912")).toBeInTheDocument();
    expect(screen.getByText("ต้องทบทวน 5 · ร่าง 3")).toBeInTheDocument();
    expect(screen.getByText("ไม่พบ 318 (8%)")).toBeInTheDocument();
    expect(screen.getByText("71%")).toBeInTheDocument();
    expect(screen.getByText("จากการโหวต 1,140 ครั้ง")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /คำค้นที่ไม่พบ 23/ })).toBeInTheDocument();
    const table = (await screen.findByText("นำเข้าแผนงานจาก Excel แบบอัปเดต")).closest("table")!;
    const trs = within(table).getAllByRole("row").slice(1);
    expect(trs).toHaveLength(3);
    expect(within(trs[0]!).getByText("/help/import-excel-update")).toBeInTheDocument();
    expect(within(trs[0]!).getByText("เผยแพร่")).toBeInTheDocument();
    expect(within(trs[0]!).getByText("91%")).toBeInTheDocument();
    expect(within(trs[1]!).getByText("ต้องทบทวน")).toBeInTheDocument();
    expect(within(trs[1]!).getByText("62%")).toHaveClass("warn");
    expect(within(trs[2]!).getByText("ร่าง")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ศูนย์ช่วยเหลือ" })).toHaveAttribute("href", "/help");
  });

  it("ตัวกรองส่งเงื่อนไขให้ ops-api · ว่างเพราะตัวกรองล้างได้", async () => {
    const calls = listPage();
    await screen.findByText("นำเข้าแผนงานจาก Excel แบบอัปเดต");
    await userEvent.click(screen.getByRole("button", { name: "ร่าง" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("status=draft"))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "ช่วยได้ต่ำกว่า 70%" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("lowHelpful=1"))).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText("หมวด"), C1);
    await waitFor(() => expect(calls.some((c) => c.path.includes(`category=${C1}`))).toBe(true));
    await userEvent.type(screen.getByLabelText("ค้นชื่อบทความ"), "ไม่มี");
    expect(await screen.findByText("ไม่มีบทความที่ตรงตัวกรอง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ล้างตัวกรอง" }));
    expect(await screen.findByText("นำเข้าแผนงานจาก Excel แบบอัปเดต")).toBeInTheDocument();
  });

  it("คำค้นที่ไม่พบบ่อย → เขียนบทความ: สร้างร่างจากคำค้นแล้วเปิดตัวแก้ · แท็บคำค้นที่ไม่พบ / ต้องทบทวน", async () => {
    const calls = listPage();
    const card = await screen.findByRole("complementary", { name: "คำค้นที่ไม่พบบ่อย" });
    expect(await within(card).findByText("41 ครั้ง · เปิด Ticket ต่อ 6")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "มีบทความแล้ว" })).toHaveAttribute("href", `/help/${A1}`);
    await userEvent.click(within(card).getByRole("button", { name: "เขียนบทความ" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ title: "ลบ sprint", categoryId: C1, fromQuery: "ลบ sprint" }));
    expect(router.push).toHaveBeenCalledWith("/help/new-1");

    await userEvent.click(screen.getByRole("tab", { name: /คำค้นที่ไม่พบ/ }));
    const misses = (await screen.findByText("\"สีสถานะ\"")).closest("table")!;
    expect(within(misses).getByRole("link", { name: "สีของสถานะงาน" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /ต้องทบทวน/ }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("review=1"))).toBe(true));
    expect(await screen.findByText("LINE ไม่แจ้งเตือน: ตรวจ 4 จุด")).toBeInTheDocument();
    expect(screen.queryByText("นำเข้าแผนงานจาก Excel แบบอัปเดต")).not.toBeInTheDocument();
  });

  it("เขียนบทความใหม่: ถามหัวข้อ + หมวดแล้วสร้างร่าง", async () => {
    const calls = listPage();
    await userEvent.click(await screen.findByRole("button", { name: "เขียนบทความ" }));
    const dlg = await screen.findByRole("dialog", { name: "เขียนบทความใหม่" });
    const submit = within(dlg).getByRole("button", { name: "สร้างร่างและเปิดตัวแก้" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "ตั้งวันหยุดบริษัท");
    await userEvent.selectOptions(within(dlg).getByLabelText("หมวด *"), C2);
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ title: "ตั้งวันหยุดบริษัท", categoryId: C2 }));
    expect(router.push).toHaveBeenCalledWith("/help/new-1");
  });

  it("X8 · ?fromTicket เปิด Modal พร้อมร่างจาก Ticket · เตือนข้อมูลส่วนบุคคล · สร้างแล้วเปิดตัวแก้", async () => {
    const calls = listPage("fromTicket=t-509");
    const dlg = await screen.findByRole("dialog", { name: "สร้างบทความจาก #509" });
    expect(within(dlg).getByText("LINE OA ไม่แจ้งเตือนในกลุ่ม · ปิดแล้ว · สาเหตุ: ปลายทางถูกลบที่ LINE")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("หัวข้อ *")).toHaveValue("LINE ไม่แจ้งเตือนในกลุ่ม: ตรวจ 4 จุด");
    expect(within(dlg).getByLabelText("หมวด *")).toHaveValue(C2);
    expect(within(dlg).getByRole("alert")).toHaveTextContent("ลบชื่อลูกค้า อีเมล ชื่องาน");
    const link = within(dlg).getByLabelText('ผูกบทความกับ Ticket นี้ (นับใน "Ticket ที่อ้างถึง")');
    expect(link).toBeChecked();
    await userEvent.click(link);
    await userEvent.click(within(dlg).getByRole("button", { name: "สร้างร่างและเปิดตัวแก้" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/help/from-ticket/t-509")?.body).toEqual({ title: "LINE ไม่แจ้งเตือนในกลุ่ม: ตรวจ 4 จุด", categoryId: C2, body: "1. ตรวจว่ายังเชิญ Friday Manage เป็นสมาชิกกลุ่ม", link: false }),
    );
    expect(router.push).toHaveBeenCalledWith("/help/from-509");
  });

  it("X9 · เรียงลำดับ แก้ชื่อ เพิ่ม ลบได้เฉพาะหมวดที่ไม่มีบทความ แล้วบันทึกครั้งเดียว", async () => {
    const calls = listPage();
    await userEvent.click(await screen.findByRole("button", { name: "จัดการหมวด" }));
    const dlg = await screen.findByRole("dialog", { name: "จัดการหมวด" });
    expect(within(dlg).queryByRole("button", { name: "ลบหมวด นำเข้า / ส่งออก Excel" })).not.toBeInTheDocument();
    expect(within(dlg).getByText("6 บทความ")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "เลื่อน แจ้งเตือน LINE และอีเมล ขึ้น" }));
    await userEvent.click(within(dlg).getAllByRole("button", { name: "แก้ชื่อ" })[1]!);
    const input = within(dlg).getByLabelText("ชื่อหมวด นำเข้า / ส่งออก Excel");
    await userEvent.clear(input);
    await userEvent.type(input, "Excel");
    await userEvent.click(within(dlg).getByRole("button", { name: "+ เพิ่มหมวด" }));
    const added = within(dlg).getByLabelText("ชื่อหมวด หมวดใหม่");
    await userEvent.clear(added);
    expect(within(dlg).getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await userEvent.type(added, "API");
    await userEvent.click(within(dlg).getByRole("button", { name: "ลบหมวด แจ้งเตือน LINE และอีเมล" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ items: [{ id: C1, name: "Excel", slug: "import-export" }, { name: "API" }] }),
    );
  });

  it("X9 · ops-api ไม่ให้ลบหมวดที่ยังมีบทความ: แสดงข้อความในกล่อง", async () => {
    listPage();
    server.use(http.put(`${OPS}/help/categories`, () => opsError(409, "category_has_articles", "หมวดนี้ยังมีบทความ")));
    await userEvent.click(await screen.findByRole("button", { name: "จัดการหมวด" }));
    const dlg = await screen.findByRole("dialog", { name: "จัดการหมวด" });
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    expect(await within(dlg).findByText("หมวดนี้ยังมีบทความ")).toBeInTheDocument();
  });

  it("บทบาทอื่น (การเงิน) อ่านอย่างเดียว: ไม่มีปุ่มเขียน / จัดการหมวด / เขียนจากคำค้น · X8 ไม่เปิด", async () => {
    asRole("finance");
    listPage("fromTicket=t-509");
    expect(await screen.findByText("Owner และ Support เขียนและเผยแพร่บทความได้", { exact: false })).toBeInTheDocument();
    expect(await screen.findByText("นำเข้าแผนงานจาก Excel แบบอัปเดต")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "เขียนบทความ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "จัดการหมวด" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ops-api ล้ม: แสดงรหัสอ้างอิงในส่วนที่ล้ม", async () => {
    listPage();
    server.use(http.get(`${OPS}/help/articles`, () => opsError(500, "internal_error", "ระบบขัดข้อง", undefined, "req-help-500")));
    expect(await screen.findByText(/req-help-500/)).toBeInTheDocument();
  });
});

describe("ตัวแก้บทความ (19b)", () => {
  it("บันทึกร่างอัตโนมัติเฉพาะช่องที่แก้ · แสดงเวลาที่บันทึก", { timeout: 10000 }, async () => {
    const calls = editor();
    const title = await screen.findByLabelText("หัวข้อ *");
    expect(screen.getByRole("link", { name: "#530" })).toHaveAttribute("href", "/support?ticket=t-530");
    await userEvent.type(title, " (ฉบับใหม่)");
    await userEvent.click(screen.getByRole("button", { name: "Gantt" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1), { timeout: 4000 });
    expect(calls[0]!.body).toEqual({ title: "กู้คืนงานและโปรเจกต์ที่ลบผิด (ฉบับใหม่)", appRoutes: ["admin.trash", "gantt"] });
    expect(await screen.findByText(/บันทึกอัตโนมัติ 10:42/)).toBeInTheDocument();
  });

  it("ดูตัวอย่าง: หัวข้อ ตัวหนา ลิงก์ในแอป กล่องเตือน และรายการ · ไม่ฉีด HTML", async () => {
    editor({ article: { ...article, body: `${article.body}\n<script>alert(1)</script> [x](javascript:alert(1))` } });
    await screen.findByLabelText("หัวข้อ *");
    await userEvent.click(screen.getByRole("button", { name: "ดูตัวอย่าง" }));
    expect(screen.getByRole("heading", { name: "ลบผิดแล้วกู้คืนได้ไหม" })).toBeInTheDocument();
    expect(screen.getByText("30 วัน").tagName).toBe("STRONG");
    expect(screen.getByTitle("/admin/trash")).toHaveTextContent("ถังขยะ ↗");
    expect(screen.getByRole("note")).toHaveTextContent("เกิน 30 วันแล้ว ติดต่อทีม Support");
    expect(screen.getByRole("note")).toHaveAttribute("data-callout", "warning");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "x" })).not.toBeInTheDocument();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });

  it("แถบเครื่องมือแทรก Markdown (กล่องเตือน / ลิงก์ในแอป)", async () => {
    editor({ article: { ...article, body: "" } });
    await screen.findByLabelText("หัวข้อ *");
    const toolbar = screen.getByRole("toolbar", { name: "เครื่องมือจัดรูปแบบ" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "ลิงก์ไปหน้าในแอป" }));
    expect(screen.getByLabelText("เนื้อหา *")).toHaveValue("[ถังขยะ](app:/admin/trash)");
    await userEvent.click(within(toolbar).getByRole("button", { name: "กล่องเตือน" }));
    expect(screen.getByLabelText("เนื้อหา *")).toHaveValue("[ถังขยะ](app:/admin/trash)\n:::warning\nข้อความเตือน\n:::");
  });

  it("เผยแพร่ต้องติ๊กตรวจข้อมูลลูกค้า · ส่ง piiChecked", async () => {
    const calls = editor();
    await screen.findByLabelText("หัวข้อ *");
    await userEvent.click(screen.getByRole("button", { name: "เผยแพร่ฉบับแก้" }));
    const dlg = await screen.findByRole("dialog", { name: 'เผยแพร่ "กู้คืนงานและโปรเจกต์ที่ลบผิด"?' });
    expect(within(dlg).getByText("ลูกค้าเห็นทันทีในศูนย์ช่วยเหลือ และหน้าสาธารณะ")).toBeInTheDocument();
    const go = within(dlg).getByRole("button", { name: "เผยแพร่" });
    expect(go).toBeDisabled();
    await userEvent.click(within(dlg).getByLabelText("ตรวจแล้วไม่มีข้อมูลลูกค้า (ชื่อ อีเมล ชื่องาน ภาพหน้าจอจริง)"));
    await userEvent.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === "publish")?.body).toEqual({ piiChecked: true }));
    expect(await screen.findByText("เผยแพร่แล้ว")).toBeInTheDocument();
  });

  it("ประวัติเวอร์ชัน: ย้อนกลับเวอร์ชันเก่า (เผยแพร่เป็นเวอร์ชันใหม่) · ปัจจุบันไม่มีปุ่ม", async () => {
    const calls = editor();
    await screen.findByLabelText("หัวข้อ *");
    await userEvent.click(screen.getByRole("button", { name: "2 เวอร์ชัน" }));
    const drawer = await screen.findByRole("dialog", { name: "เวอร์ชันที่เผยแพร่" });
    expect(within(drawer).getByText("ปัจจุบัน")).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "ย้อนกลับ เวอร์ชัน 2" }));
    await waitFor(() => expect(calls.some((c) => c.path === "restore/2")).toBe(true));
    expect(await screen.findByText("เผยแพร่เวอร์ชัน 2 อีกครั้งแล้ว")).toBeInTheDocument();
  });

  it("ลบบทความ: ยืนยันแล้วกลับไปรายการ", async () => {
    const calls = editor();
    await screen.findByLabelText("หัวข้อ *");
    await userEvent.click(screen.getByRole("button", { name: "ลบบทความ" }));
    const dlg = await screen.findByRole("dialog", { name: 'ลบบทความ "กู้คืนงานและโปรเจกต์ที่ลบผิด"?' });
    await userEvent.click(within(dlg).getByRole("button", { name: "ลบบทความ" }));
    await waitFor(() => expect(calls.some((c) => c.path === "delete")).toBe(true));
    expect(router.push).toHaveBeenCalledWith("/help");
  });

  it("บทบาทอื่นอ่านอย่างเดียว: ไม่มีเผยแพร่ / ลบ / แถบเครื่องมือ และไม่บันทึกอัตโนมัติ", async () => {
    asRole("engineer");
    editor({ canEdit: false });
    expect(await screen.findByText("อ่านอย่างเดียว · Owner และ Support แก้ไขได้")).toBeInTheDocument();
    expect(screen.getByLabelText("หัวข้อ *")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "เผยแพร่ฉบับแก้" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ลบบทความ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("ไม่พบบทความ: บอกและพากลับรายการ", async () => {
    server.use(http.get(`${OPS}/help/articles/:id`, () => opsError(404, "not_found", "ไม่พบบทความ")), http.get(`${OPS}/help/categories`, () => HttpResponse.json({ items: categories })));
    renderWithProviders(<ArticleEditor id="missing" />);
    expect(await screen.findByText("ไม่พบบทความนี้")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "กลับไปรายการบทความ" })).toHaveAttribute("href", "/help");
  });
});

describe("T5 · ปิดเรื่องแล้วสร้างบทความ (คำขอนอก lane ใน SupportPage)", () => {
  it("ติ๊ก \"สร้างบทความในศูนย์ช่วยเหลือจากเรื่องนี้\" → ปิดเรื่องแล้วเปิด /help?fromTicket", async () => {
    asRole("support");
    const T = "70000000-0000-4000-8000-000000000009";
    const ticket = { id: T, number: 509, subject: "LINE OA ไม่แจ้งเตือนในกลุ่ม", status: "open", priority: "normal", channel: "in_app", requesterEmail: "pm@sample.example.com", createdAt: "2026-11-09T02:00:00.000Z", firstResponseDueAt: null, assigneeId: null, assigneeName: null, workspace: null, slaBreached: false };
    server.use(
      http.get(`${OPS}/tickets`, () => HttpResponse.json({ items: [ticket], summary: { open: 1, unassigned: 1, breached: 0, firstResponseMinutes: null, csat: null } })),
      http.get(`${OPS}/tickets/stats`, () => HttpResponse.json({ items: [] })),
      http.get(`${OPS}/tickets/${T}`, () => HttpResponse.json({ ticket: { ...ticket, cause: null, csat: null, assignee: null, category: "notification", requesterName: null }, messages: [], customer: null })),
      http.get(`${OPS}/support/team`, () => HttpResponse.json({ mode: "least", items: [] })),
      http.get(`${OPS}/support/canned-replies`, () => HttpResponse.json({ items: [] })),
      http.post(`${OPS}/tickets/${T}/solve`, () => HttpResponse.json({ id: T, status: "solved" })),
    );
    navigation.pathname = "/support";
    navigation.search = `ticket=${T}`;
    renderWithProviders(<SupportPage />);
    await userEvent.click(await screen.findByRole("button", { name: "ปิดเรื่อง" }));
    const dlg = await screen.findByRole("dialog", { name: "ปิด #509?" });
    await userEvent.type(within(dlg).getByLabelText("ผลลัพธ์ (ส่งถึงลูกค้า)"), "เชิญบอทเข้ากลุ่มใหม่");
    await userEvent.type(within(dlg).getByLabelText("สาเหตุจริง"), "บอทถูกลบออกจากกลุ่ม");
    await userEvent.click(within(dlg).getByLabelText("สร้างบทความในศูนย์ช่วยเหลือจากเรื่องนี้"));
    await userEvent.click(within(dlg).getByRole("button", { name: "ปิดเรื่อง" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/help?fromTicket=${T}`));
  });
});
