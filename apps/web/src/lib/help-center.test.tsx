// W26 · ศูนย์ช่วยเหลือ · แผงช่วยเหลือ · ติดต่อ Support · Ticket ของฉัน (X1–X6 · T12) · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { asMobile } from "@/test/mobile";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { ArticleView } from "@/features/help-panel/article";
import { useContactSupport, type ContactWorkspace } from "@/features/help-panel/contact";
import { HelpHome } from "@/features/help-panel/home";
import { articleUrl, splitCallouts, tocOf } from "@/features/help-panel/markdown";
import { routeOf } from "@/features/help-panel/shared";
import { TicketsPage } from "@/features/help-panel/tickets";
import type { ArticleDetail, HelpArticleSummary, SupportTicket, TicketDetail, TicketList } from "@/features/help-panel/shared";
import h from "../../messages/th/help.json";

const owner: ContactWorkspace = { slug: "sample", name: "ทีมตัวอย่าง", role: "owner" };
const member: ContactWorkspace = { ...owner, role: "member" };
const guest: ContactWorkspace = { ...owner, role: "guest" };

const summary = (slug: string, title: string, over: Partial<HelpArticleSummary> = {}): HelpArticleSummary => ({
  id: `a-${slug}`, slug, title, summary: null, category: { slug: "notifications", name: "แจ้งเตือน LINE และอีเมล" }, visibility: "public", appRoutes: [], readMinutes: 3, updatedAt: "2026-11-08T03:00:00Z", publishedAt: "2026-11-01T03:00:00Z", ...over,
});
const lineApprove = summary("line-approve", "ผูก LINE เพื่อรับแจ้งเตือนและอนุมัติคำขอเลื่อน Due", { snippet: "…หัวหน้าทีมกด อนุมัติ / ปฏิเสธ จากข้อความใน LINE…" });
const dueRequest = summary("due-request", "ขอเลื่อน Due และใครเป็นผู้อนุมัติ", { category: { slug: "getting-started", name: "เริ่มต้นใช้งาน" } });
const internal = summary("internal-sso", "ตั้งค่า SSO สำหรับองค์กร", { visibility: "signed_in" });
const body = [
  "โหมดอัปเดตใช้เมื่อมีโปรเจกต์อยู่แล้ว",
  "## ก่อนเริ่ม",
  "- ต้องเป็น **Project Owner**",
  "## ขั้นตอน",
  "1. เปิด [ถังขยะ](app:/admin/trash)",
  "2. อ่าน [คู่มือภายนอก](https://docs.example.com/guide) หรือ [ลิงก์อันตราย](javascript:alert(1))",
  ":::warning",
  "ถ้าคอลัมน์ **Parent Key** ว่าง Sub-task จะกลายเป็น Task",
  ":::",
].join("\n");
const detail: ArticleDetail = { article: { ...summary("import-excel-update", "นำเข้าแผนงานจาก Excel แบบอัปเดต", { category: { slug: "import-export", name: "นำเข้า / ส่งออก Excel" } }), body, hasEnglish: false }, related: [lineApprove, internal] };

const ticket = (id: string, over: Partial<SupportTicket> = {}): SupportTicket => ({
  id, number: 531, subject: "LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์", category: "notification", status: "open", mine: true, requester: { id: "sample-lead", name: "หัวหน้าทีมตัวอย่าง" },
  createdAt: "2026-11-12T03:12:00Z", updatedAt: "2026-11-12T03:12:00Z", lastMessageAt: "2026-11-12T03:40:00Z", firstResponseDueAt: "2026-11-12T07:12:00Z", firstRespondedAt: null, solvedAt: null, closedAt: null, dev: null, canReply: true, canClose: true, canReopen: false, ...over,
});
const list = (items: SupportTicket[], over: Partial<TicketList> = {}): TicketList => ({ items, openMine: 2, canContact: true, canViewWorkspace: true, plan: { code: "team_l", name: "Team L" }, sla: { first: { n: 4, unit: "h" }, resolve: { n: 2, unit: "d" } }, ...over });

let articleCalls: URL[];
let feedback: unknown[];
let created: Record<string, unknown>[];
let accessCalls: unknown[];
let ticketPosts: { action: string; body: unknown }[];
let ticketScopes: string[];
let tickets: TicketList;
let ticketDetails: Record<string, TicketDetail>;

beforeEach(() => {
  articleCalls = [];
  feedback = [];
  created = [];
  accessCalls = [];
  ticketPosts = [];
  ticketScopes = [];
  tickets = list([ticket("t1")]);
  ticketDetails = {
    t1: {
      ticket: ticket("t1"),
      messages: [
        { id: "m1", author: "me", authorName: "หัวหน้าทีมตัวอย่าง", body: "ตั้งแต่เมื่อวานกลุ่ม LINE ไม่ได้รับแจ้งเตือน", createdAt: "2026-11-12T03:12:00Z", files: [{ name: "screen.png", size: 5, mime: "image/png", url: "/api/v1/storage/download/tok" }], context: { page: "แผนพัฒนา › Gantt", requestId: "req_9c41e2", impact: "team" }, article: null },
        { id: "m2", author: "staff", authorName: null, body: "ได้รับเรื่องแล้วครับ", createdAt: "2026-11-12T03:40:00Z", files: [], context: null, article: null },
        { id: "m3", author: "system", authorName: null, body: "ส่งเรื่องให้ทีมพัฒนาตรวจแล้ว", createdAt: "2026-11-12T03:50:00Z", files: [], context: null, article: null },
      ],
    },
  };
  server.use(
    http.get("*/api/v1/help/categories", () =>
      HttpResponse.json({ items: [{ id: "c1", slug: "getting-started", name: "เริ่มต้นใช้งาน", articles: 9 }, { id: "c2", slug: "notifications", name: "แจ้งเตือน LINE และอีเมล", articles: 7 }] }),
    ),
    http.get("*/api/v1/help/articles", ({ request }) => {
      const url = new URL(request.url);
      articleCalls.push(url);
      const q = url.searchParams.get("q");
      if (q === "ลบ sprint") return HttpResponse.json({ items: [], total: 0, terms: ["ลบ", "sprint"], partial: false });
      if (q) return HttpResponse.json({ items: [lineApprove, dueRequest, internal], total: 3, terms: q.toLowerCase().split(/\s+/), partial: false });
      if (url.searchParams.get("route")) return HttpResponse.json({ items: [dueRequest], total: 1, fallback: false });
      if (url.searchParams.get("category")) return HttpResponse.json({ items: [lineApprove, internal], total: 2 });
      return HttpResponse.json({ items: [lineApprove, dueRequest, internal], total: 3 });
    }),
    http.get("*/api/v1/help/articles/:slug", ({ params }) =>
      params.slug === "import-excel-update" ? HttpResponse.json(detail) : params.slug === "internal-sso" ? HttpResponse.json({ article: { ...internal, body: "ภายใน", hasEnglish: false }, related: [] }) : HttpResponse.json({ error: { code: "help_article_not_found", message: "ไม่พบบทความนี้" } }, { status: 404 }),
    ),
    http.post("*/api/v1/help/articles/:slug", async ({ params, request }) => {
      feedback.push({ slug: params.slug, ...((await request.json()) as object) });
      return HttpResponse.json({ ok: true });
    }),
    http.get("*/api/v1/w/:ws/support/tickets", ({ request }) => {
      ticketScopes.push(new URL(request.url).searchParams.get("scope") ?? "");
      return HttpResponse.json(tickets, { headers: { "X-Request-Id": "req_abc123" } });
    }),
    http.get("*/api/v1/w/:ws/support/tickets/:id", ({ params }) => HttpResponse.json(ticketDetails[String(params.id)])),
    http.post("*/api/v1/w/:ws/support/tickets", async ({ request }) => {
      const b = (await request.json()) as Record<string, unknown>;
      created.push(b);
      return HttpResponse.json({ ticket: ticket("t-new", { number: 532 }), sla: { first: { n: 4, unit: "h" }, open: true }, emailed: true }, { status: 201 });
    }),
    http.post("*/api/v1/w/:ws/support/tickets/:action", async ({ params, request }) => {
      const action = String(params.action);
      ticketPosts.push({ action, body: await request.json().catch(() => null) });
      return HttpResponse.json({ status: action.endsWith(":close") ? "closed" : "open" });
    }),
    http.post("*/api/v1/w/:ws/support/tickets/:id/messages", async ({ params, request }) => {
      ticketPosts.push({ action: `${params.id}/messages`, body: await request.json() });
      return HttpResponse.json({ status: "open", reopened: false }, { status: 201 });
    }),
    http.post("*/api/v1/w/:ws/support/attachments", () => HttpResponse.json({ method: "PUT", url: "http://127.0.0.1:3001/api/v1/storage/upload/tok-1", headers: { "content-type": "application/octet-stream" }, uploadToken: "upload-token-1", maxBytes: 10485760 }, { status: 201 })),
    http.put("*/api/v1/storage/upload/:token", () => new HttpResponse(null, { status: 204 })),
    http.put("*/api/v1/w/:ws/support-access", async ({ request }) => {
      accessCalls.push(await request.json());
      return HttpResponse.json({ enabled: true });
    }),
  );
});

describe("ตัวช่วย", () => {
  it("รหัสหน้าในแอปจาก path ใช้แนะนำบทความ (X4)", () => {
    expect(routeOf("/work/sample/p/DE/gantt")).toBe("gantt");
    expect(routeOf("/work/sample/p/DE/board")).toBe("kanban");
    expect(routeOf("/work/sample/p/DE")).toBe("overview");
    expect(routeOf("/work/sample")).toBe("home");
    expect(routeOf("/work/sample/my-tasks")).toBe("my-tasks");
    expect(routeOf("/work/sample/admin/trash")).toBe("admin.trash");
  });
  it("Markdown: แยกกล่องเตือน · สารบัญจาก ## · ลิงก์ app:/ ใช้ Workspace ปัจจุบัน · ตัดโปรโตคอลอันตราย", () => {
    expect(splitCallouts(body).map((b) => b.kind)).toEqual(["md", "callout"]);
    expect(tocOf(body).map((x) => x.text)).toEqual(["ก่อนเริ่ม", "ขั้นตอน"]);
    expect(articleUrl("app:/admin/trash", "/work/sample")).toBe("/work/sample/admin/trash");
    expect(articleUrl("app:/admin/trash", null)).toBe("/login?next=%2Fadmin%2Ftrash");
    expect(articleUrl("javascript:alert(1)", "/work/sample")).toBe("");
    expect(articleUrl("data:text/html,x", "/work/sample", "image")).toBe("");
    expect(articleUrl("https://cdn.example.com/a.png", null, "image")).toBe("https://cdn.example.com/a.png");
  });
});

describe("X1 / X2 · ศูนย์ช่วยเหลือ", () => {
  it("หมวด · ยอดนิยม · SLA ตามแพ็กเกจ · ติดต่อ Support · Ticket ของฉัน · สถานะระบบ", async () => {
    renderWithProviders(<HelpHome base="/work/sample/help" workspace={owner} />);
    expect(await screen.findByRole("link", { name: /เริ่มต้นใช้งาน\s*9 บทความ/ })).toHaveAttribute("href", "/work/sample/help?category=getting-started");
    expect(await screen.findByRole("link", { name: /ผูก LINE เพื่อรับแจ้งเตือน/ })).toHaveAttribute("href", "/work/sample/help/line-approve");
    expect(await screen.findByText("ทีม Support ตอบภายใน 4 ชั่วโมงทำการ (Team L)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: h.home.contact })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ticket ของฉัน · เปิดอยู่ 2" })).toHaveAttribute("href", "/work/sample/help/tickets");
    expect(screen.getByText(h.home.statusOk)).toBeInTheDocument();
    expect(articleCalls.some((u) => u.searchParams.get("sort") === "popular" && u.searchParams.get("limit") === "5")).toBe(true);
  });

  it("ค้นหา: หน่วง 250 ms · ไฮไลต์คำที่ตรง · จำนวนบทความ · ปุ่ม / ไปที่ช่องค้นหา", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HelpHome base="/work/sample/help" workspace={owner} />);
    const box = await screen.findByRole("searchbox", { name: h.home.searchLabel });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(box).toHaveFocus();
    await user.type(box, "อนุมัติ due");
    await screen.findByText("3 บทความ", { selector: "p" , exact: false });
    const marks = document.querySelectorAll("mark");
    expect([...marks].map((m) => m.textContent?.toLowerCase())).toEqual(expect.arrayContaining(["อนุมัติ", "due"]));
    const queries = articleCalls.filter((u) => u.searchParams.get("q"));
    expect(queries.map((u) => u.searchParams.get("q"))).toEqual(["อนุมัติ due"]);
    expect(queries[0].searchParams.get("suggest")).toBeNull();
  });

  it("ค้นไม่พบ: ชวนถามทีม Support · เปิดฟอร์มพร้อมคำค้นแล้วนับใน Ticket ที่เปิดต่อ", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HelpHome base="/work/sample/help" workspace={owner} />);
    await user.click(await screen.findByRole("button", { name: h.home.chip3 }));
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "ลบ sprint");
    expect(await screen.findByRole("heading", { name: 'ยังไม่มีบทความเรื่อง "ลบ sprint"' })).toBeInTheDocument();
    expect(screen.getByText(h.results.missNote)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: h.results.ask }));
    const dialog = await screen.findByRole("dialog", { name: h.contact.title });
    expect(within(dialog).getByText('ต่อจากคำค้น "ลบ sprint"')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(`${h.contact.subject} *`)).toHaveValue("ลบ sprint");
    await user.selectOptions(within(dialog).getByLabelText(`${h.contact.category} *`), "how_to");
    await user.type(within(dialog).getByLabelText(`${h.contact.body} *`), "ลบ Sprint ที่สร้างผิดได้อย่างไร");
    await user.click(within(dialog).getByRole("button", { name: h.contact.send }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ subject: "ลบ sprint", category: "how_to", searchQuery: "ลบ sprint" });
  });

  it("ดูตามหมวด (?category=)", async () => {
    navigation.search = "category=notifications";
    renderWithProviders(<HelpHome base="/work/sample/help" workspace={owner} />);
    expect(await screen.findByRole("heading", { name: "แจ้งเตือน LINE และอีเมล" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: h.home.allCategories })).toHaveAttribute("href", "/work/sample/help");
    expect(articleCalls.some((u) => u.searchParams.get("category") === "notifications")).toBe(true);
  });

  it("Guest เห็นศูนย์ช่วยเหลือแต่ไม่เห็นปุ่มติดต่อ Support และไม่โหลด Ticket", async () => {
    renderWithProviders(<HelpHome base="/work/sample/help" workspace={guest} />);
    expect(await screen.findByText(h.home.guestHint)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: h.home.contact })).not.toBeInTheDocument();
    expect(ticketScopes).toEqual([]);
  });

  it("หน้าสาธารณะ: ไม่มีปุ่มติดต่อ (ชวนเข้าสู่ระบบ) · ไม่แสดงบทความเฉพาะผู้เข้าสู่ระบบ", async () => {
    renderWithProviders(<HelpHome base="/help" publicOnly />);
    expect(await screen.findByRole("link", { name: h.public.login })).toHaveAttribute("href", "/login");
    await screen.findByRole("link", { name: /ผูก LINE/ });
    expect(screen.queryByText(internal.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: h.home.contact })).not.toBeInTheDocument();
  });
});

describe("X3 · หน้าบทความ", () => {
  it("เนื้อหา Markdown: สารบัญ · กล่องเตือน · ลิงก์ในแอปของ Workspace · ลิงก์ภายนอกเปิดแท็บใหม่ · ตัดลิงก์อันตราย · บทความที่เกี่ยวข้อง", async () => {
    renderWithProviders(<ArticleView slug="import-excel-update" base="/work/sample/help" workspace={owner} />);
    expect(await screen.findByRole("heading", { level: 1, name: "นำเข้าแผนงานจาก Excel แบบอัปเดต" })).toBeInTheDocument();
    expect(screen.getByText(/อ่าน 3 นาที/)).toBeInTheDocument();
    const toc = screen.getByRole("navigation", { name: h.article.toc });
    expect(within(toc).getByRole("link", { name: "ก่อนเริ่ม" })).toHaveAttribute("href", `#${screen.getByRole("heading", { name: "ก่อนเริ่ม" }).id}`);
    expect(screen.getByRole("note", { name: h.callout.warning })).toHaveTextContent("Parent Key");
    expect(screen.getByRole("link", { name: "ถังขยะ" })).toHaveAttribute("href", "/work/sample/admin/trash");
    const ext = screen.getByRole("link", { name: "คู่มือภายนอก" });
    expect(ext).toHaveAttribute("target", "_blank");
    expect(ext).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "ลิงก์อันตราย" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: h.article.related })).getByRole("link", { name: lineApprove.title })).toHaveAttribute("href", "/work/sample/help/line-approve");
  });

  it("โหวตช่วยได้ / ยังไม่ช่วย + ความเห็น · ติดต่อ Support พร้อมแนบบทความ", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ArticleView slug="import-excel-update" base="/work/sample/help" workspace={member} />);
    await user.click(await screen.findByRole("button", { name: h.article.no }));
    await user.type(screen.getByLabelText(h.article.missing), "ไฟล์มีหลายชีต");
    await user.click(screen.getByRole("button", { name: h.article.contactWith }));
    const dialog = await screen.findByRole("dialog", { name: h.contact.title });
    expect(within(dialog).getByText("แนบบทความ: นำเข้าแผนงานจาก Excel แบบอัปเดต")).toBeInTheDocument();
    // สมาชิกทั่วไปไม่มีช่องเปิดสิทธิ์เข้าบัญชี (Owner เท่านั้น)
    expect(within(dialog).queryByText(h.contact.access)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(`${h.contact.subject} *`), "ไฟล์หลายชีต");
    await user.selectOptions(within(dialog).getByLabelText(`${h.contact.category} *`), "import");
    await user.type(within(dialog).getByLabelText(`${h.contact.body} *`), "ไม่รู้ว่าต้องใช้ชีตไหน");
    await user.click(within(dialog).getByRole("button", { name: h.contact.send }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ articleSlug: "import-excel-update" });
    await user.click(await within(dialog).findByText(h.contact.close, { selector: "button" }));
    await user.click(screen.getByRole("button", { name: h.article.sendFeedback }));
    await screen.findByText(h.article.thanks);
    expect(feedback).toEqual([{ slug: "import-excel-update:feedback", helpful: false, comment: "ไฟล์มีหลายชีต" }]);
  });

  it("กดช่วยได้ส่งโหวตทันที", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ArticleView slug="import-excel-update" base="/help" publicOnly />);
    await user.click(await screen.findByRole("button", { name: h.article.yes }));
    await screen.findByText(h.article.thanks);
    expect(feedback).toEqual([{ slug: "import-excel-update:feedback", helpful: true }]);
  });

  it("หน้าสาธารณะ: ลิงก์ในแอปพาไปเข้าสู่ระบบ · ไม่มีปุ่มติดต่อ · บทความเฉพาะผู้เข้าสู่ระบบไม่แสดง · ไม่พบ = 404", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<ArticleView slug="import-excel-update" base="/help" publicOnly />);
    expect(await screen.findByRole("link", { name: "ถังขยะ" })).toHaveAttribute("href", "/login?next=%2Fadmin%2Ftrash");
    expect(screen.queryByRole("link", { name: internal.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: h.article.no }));
    expect(screen.queryByRole("button", { name: h.article.contactWith })).not.toBeInTheDocument();
    unmount();
    const second = renderWithProviders(<ArticleView slug="internal-sso" base="/help" publicOnly />);
    expect(await screen.findByRole("heading", { name: h.article.notFound })).toBeInTheDocument();
    second.unmount();
    renderWithProviders(<ArticleView slug="missing" base="/work/sample/help" workspace={owner} />);
    expect(await screen.findByRole("heading", { name: h.article.notFound })).toBeInTheDocument();
  });
});

function ContactHarness({ workspace }: { workspace: ContactWorkspace }) {
  const contact = useContactSupport(workspace);
  return (
    <>
      <button type="button" onClick={() => contact.open({ page: "แผนพัฒนา › Gantt", path: "/work/sample/p/DE/gantt" })}>
        เปิดฟอร์ม
      </button>
      {contact.element}
    </>
  );
}

describe("X5 · ติดต่อ Support", () => {
  it("แนะนำบทความระหว่างพิมพ์ · ต้องกรอกครบ · ไฟล์เกิน 10 MB · แนบไฟล์ + หน้า + requestId · Owner เปิดสิทธิ์เข้าบัญชี 7 วัน · หน้าส่งแล้ว", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ContactHarness workspace={owner} />);
    await user.click(screen.getByRole("button", { name: "เปิดฟอร์ม" }));
    const dialog = await screen.findByRole("dialog", { name: h.contact.title });
    expect(await within(dialog).findByText("ทีมตัวอย่าง · Team L · ตอบภายใน 4 ชั่วโมงทำการ")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: h.contact.send }));
    expect(within(dialog).getAllByRole("alert").length).toBeGreaterThan(0);
    expect(created).toEqual([]);
    await user.type(within(dialog).getByLabelText(`${h.contact.subject} *`), "LINE ไม่แจ้งเตือน");
    expect(await within(dialog).findByText(h.contact.suggestions)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: lineApprove.title })).toHaveAttribute("href", "/work/sample/help/line-approve");
    expect(articleCalls.find((u) => u.searchParams.get("q") === "LINE ไม่แจ้งเตือน")?.searchParams.get("suggest")).toBe("1");
    await user.selectOptions(within(dialog).getByLabelText(`${h.contact.category} *`), "notification");
    await user.selectOptions(within(dialog).getByLabelText(h.contact.impact), "team");
    await user.type(within(dialog).getByLabelText(`${h.contact.body} *`), "กลุ่มทีมตัวอย่างไม่ได้รับแจ้งเตือน");
    const fileInput = within(dialog).getByLabelText(h.contact.attach, { selector: "input" });
    const big = new File(["x"], "big.mov", { type: "video/quicktime" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    await user.upload(fileInput, big);
    expect(within(dialog).getByText("ไฟล์ big.mov ใหญ่เกิน 10 MB")).toBeInTheDocument();
    await user.upload(fileInput, new File(["12345"], "screen.png", { type: "image/png" }));
    expect(within(dialog).getByText("screen.png")).toBeInTheDocument();
    expect(within(dialog).getByText("แนบหน้าที่เปิดอยู่ (แผนพัฒนา › Gantt) และรหัสคำขอล่าสุด req_abc123 เพื่อให้ตรวจได้เร็ว")).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(h.contact.access));
    await user.click(within(dialog).getByRole("button", { name: h.contact.send }));
    expect(await within(dialog).findByRole("heading", { name: "ส่งเรื่องแล้ว · #532" })).toBeInTheDocument();
    expect(within(dialog).getByText("ทีม Support ตอบภายใน 4 ชั่วโมงทำการ ทางอีเมลและในหน้า Ticket ของฉัน")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: h.contact.view })).toHaveAttribute("href", "/work/sample/help/tickets?ticket=t-new");
    expect(created[0]).toEqual({
      subject: "LINE ไม่แจ้งเตือน", category: "notification", impact: "team", body: "กลุ่มทีมตัวอย่างไม่ได้รับแจ้งเตือน",
      attachments: [{ uploadToken: "upload-token-1" }],
      context: { page: "แผนพัฒนา › Gantt", path: "/work/sample/p/DE/gantt", requestId: "req_abc123" },
    });
    expect(accessCalls).toEqual([{ enabled: true, duration: "7d", maxMode: "read" }]);
  });

  it("ไม่ติ๊กแนบหน้า = ไม่ส่งบริบท · API ปฏิเสธ (Guest) แสดงข้อความของ API", async () => {
    server.use(http.post("*/api/v1/w/:ws/support/tickets", () => HttpResponse.json({ error: { code: "guest_cannot_contact_support", message: "Guest เปิด Ticket ไม่ได้ · ถาม Owner หรือผู้ที่เชิญคุณเข้า Workspace" } }, { status: 403 })));
    const user = userEvent.setup();
    renderWithProviders(<ContactHarness workspace={member} />);
    await user.click(screen.getByRole("button", { name: "เปิดฟอร์ม" }));
    const dialog = await screen.findByRole("dialog", { name: h.contact.title });
    await user.type(within(dialog).getByLabelText(`${h.contact.subject} *`), "ขอสิทธิ์");
    await user.selectOptions(within(dialog).getByLabelText(`${h.contact.category} *`), "account");
    await user.type(within(dialog).getByLabelText(`${h.contact.body} *`), "ทดสอบ");
    await user.click(within(dialog).getByRole("checkbox", { name: /แนบหน้าที่เปิดอยู่/ }));
    await user.click(within(dialog).getByRole("button", { name: h.contact.send }));
    expect(await within(dialog).findByText("Guest เปิด Ticket ไม่ได้ · ถาม Owner หรือผู้ที่เชิญคุณเข้า Workspace")).toBeInTheDocument();
  });

  it("มือถือ: เปิดเป็นหน้าเต็มจอ", async () => {
    const restore = asMobile();
    try {
      const user = userEvent.setup();
      renderWithProviders(<ContactHarness workspace={member} />);
      await user.click(screen.getByRole("button", { name: "เปิดฟอร์ม" }));
      expect(router.push).toHaveBeenCalledWith(`/work/sample/help/contact?${new URLSearchParams({ page: "แผนพัฒนา › Gantt", path: "/work/sample/p/DE/gantt" })}`);
    } finally {
      restore();
    }
  });
});

describe("X4 · แผงช่วยเหลือใน shell", () => {
  it("ปุ่ม ? บนแถบบน · คีย์ ? เปิดแผง · ไม่ทำงานขณะพิมพ์ · แนะนำบทความตามหน้า (Gantt) · ทางลัด · ยังติดอยู่", async () => {
    navigation.pathname = "/work/sample/p/DE/gantt";
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <input aria-label="ช่องทดสอบ" />
      </WorkspaceShell>,
    );
    const field = await screen.findByLabelText("ช่องทดสอบ");
    expect(screen.getByRole("button", { name: h.panel.open })).toBeInTheDocument();
    field.focus();
    fireEvent.keyDown(field, { key: "?" });
    expect(screen.queryByRole("dialog", { name: h.panel.title })).not.toBeInTheDocument();
    expect(articleCalls).toEqual([]);
    act(() => field.blur());
    fireEvent.keyDown(document.body, { key: "?" });
    const panel = await screen.findByRole("dialog", { name: h.panel.title });
    expect(await within(panel).findByText("แนะนำสำหรับหน้านี้ · Gantt")).toBeInTheDocument();
    expect(await within(panel).findByRole("link", { name: dueRequest.title })).toHaveAttribute("href", "/work/sample/help/due-request");
    expect(articleCalls.find((u) => u.searchParams.get("route"))?.searchParams.get("route")).toBe("gantt");
    expect(within(panel).getByRole("link", { name: h.panel.openFull })).toHaveAttribute("href", "/work/sample/help");
    expect(within(panel).getByRole("link", { name: h.panel.allHelp })).toHaveAttribute("href", "/work/sample/help");
    await userEvent.setup().click(within(panel).getByRole("button", { name: new RegExp(h.panel.keys) }));
    expect(within(panel).getByText(h.panel.keyList.palette)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: h.home.contact })).toBeInTheDocument();
    expect(await within(panel).findByRole("link", { name: "Ticket ของฉัน · เปิดอยู่ 2" })).toBeInTheDocument();
  });

  it("แผงช่วยเหลือ: ค้นหาในแผง · ติดต่อ Support แนบหน้าที่เปิดอยู่ (ชื่อโปรเจกต์ › หน้า)", async () => {
    navigation.pathname = "/work/sample/p/DE/gantt";
    const user = userEvent.setup();
    renderWithProviders(<WorkspaceShell ws="sample"><div /></WorkspaceShell>);
    await user.click(await screen.findByRole("button", { name: h.panel.open }));
    const panel = await screen.findByRole("dialog", { name: h.panel.title });
    await user.click(await within(panel).findByRole("button", { name: h.home.contact }));
    const dialog = await screen.findByRole("dialog", { name: h.contact.title });
    expect(await within(dialog).findByText(/แนบหน้าที่เปิดอยู่ \(แผนพัฒนาผลิตภัณฑ์ › Gantt\)/)).toBeInTheDocument();
  });
});

describe("X6 · Ticket ของฉัน (T12)", () => {
  it("รายการ + รายละเอียด: สถานะ · ตอบภายใน · ขั้นความคืบหน้า · ข้อความของทีมแสดงเป็นทีม Friday · ระบบอยู่กลาง · แนบหน้า + requestId · ไฟล์ · ตอบ", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketsPage workspace={owner} />);
    const listEl = await screen.findByRole("list", { name: h.tickets.listLabel });
    expect(within(listEl).getByText(h.status.open)).toBeInTheDocument();
    const detailEl = await screen.findByRole("region", { name: "#531 LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์" });
    expect(within(detailEl).getByText(/ตอบภายใน/)).toBeInTheDocument();
    expect(within(detailEl).getByText(h.tickets.steps.review).closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(detailEl).queryByText(h.tickets.steps.dev)).not.toBeInTheDocument();
    expect(within(detailEl).getByText(h.tickets.team)).toBeInTheDocument();
    expect(within(detailEl).getByText("ส่งเรื่องให้ทีมพัฒนาตรวจแล้ว")).toBeInTheDocument();
    expect(within(detailEl).getByText("แนบ: หน้า แผนพัฒนา › Gantt · req_9c41e2")).toBeInTheDocument();
    expect(within(detailEl).getByRole("link", { name: "screen.png" })).toHaveAttribute("href", "/api/v1/storage/download/tok");
    await user.type(within(detailEl).getByLabelText(h.tickets.replyLabel), "ลองเชิญบอทใหม่แล้ว");
    await user.click(within(detailEl).getByRole("button", { name: h.tickets.send }));
    await waitFor(() => expect(ticketPosts).toEqual([{ action: "t1/messages", body: { body: "ลองเชิญบอทใหม่แล้ว", attachments: [] } }]));
    await user.click(within(detailEl).getByRole("button", { name: h.tickets.closeTicket }));
    await waitFor(() => expect(ticketPosts.at(-1)?.action).toBe("t1:close"));
  });

  it("Owner สลับดูทั้ง Workspace · สมาชิกไม่เห็นตัวสลับ", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<TicketsPage workspace={owner} />);
    await user.click(await screen.findByRole("button", { name: h.tickets.workspace }));
    await waitFor(() => expect(ticketScopes).toContain("workspace"));
    unmount();
    tickets = list([ticket("t1")], { canViewWorkspace: false });
    renderWithProviders(<TicketsPage workspace={member} />);
    await screen.findByRole("list", { name: h.tickets.listLabel });
    expect(screen.queryByRole("button", { name: h.tickets.workspace })).not.toBeInTheDocument();
  });

  it("T12: ส่งทีมพัฒนาแล้วแก้แล้ว · ยังพบปัญหา (เปิดใหม่) / แก้แล้ว ขอบคุณ (ปิด) · เลือกจาก ?ticket=", async () => {
    const fixed = ticket("t2", { number: 512, subject: "นำเข้า Excel แล้ว Sub-task หายบางส่วน", status: "solved", firstRespondedAt: "2026-11-05T02:00:00Z", firstResponseDueAt: null, solvedAt: "2026-11-12T08:05:00Z", dev: { sentAt: "2026-11-05T02:00:00Z", fixed: true }, canReply: true, canClose: true, canReopen: true });
    tickets = list([ticket("t1"), fixed]);
    ticketDetails.t2 = { ticket: fixed, messages: [{ id: "m9", author: "staff", authorName: null, body: "ปัญหาที่แจ้งแก้แล้วและใช้งานได้", createdAt: "2026-11-12T08:20:00Z", files: [], context: null, article: null }] };
    navigation.search = "ticket=t2";
    const user = userEvent.setup();
    renderWithProviders(<TicketsPage workspace={owner} />);
    const detailEl = await screen.findByRole("region", { name: "#512 นำเข้า Excel แล้ว Sub-task หายบางส่วน" });
    const steps = [...detailEl.querySelectorAll("ol li")];
    expect(steps.map((li) => li.textContent?.split(" · ")[0])).toEqual(Object.values(h.tickets.steps));
    for (const li of steps) expect(li.className).toMatch(/stepDone/);
    expect(within(detailEl).getByText("เรื่องนี้ปิดเองใน 7 วันถ้าไม่มีการตอบกลับ")).toBeInTheDocument();
    expect(within(detailEl).queryByLabelText(h.tickets.replyLabel)).not.toBeInTheDocument();
    await user.click(within(detailEl).getByRole("button", { name: h.tickets.stillIssue }));
    await waitFor(() => expect(ticketPosts.at(-1)?.action).toBe("t2:reopen"));
    await user.click(within(detailEl).getByRole("button", { name: h.tickets.thanks }));
    await waitFor(() => expect(ticketPosts.at(-1)?.action).toBe("t2:close"));
  });

  it("ปิดแล้วแต่ยังเปิดใหม่ได้ · ปิดถาวร · ว่าง", async () => {
    const closed = ticket("t3", { status: "closed", closedAt: "2026-11-12T08:00:00Z", canReply: false, canClose: false, canReopen: true });
    tickets = list([closed]);
    ticketDetails.t3 = { ticket: closed, messages: [] };
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<TicketsPage workspace={owner} />);
    await user.click(await screen.findByRole("button", { name: h.tickets.reopen }));
    await waitFor(() => expect(ticketPosts.at(-1)?.action).toBe("t3:reopen"));
    unmount();
    tickets = list([], { openMine: 0 });
    renderWithProviders(<TicketsPage workspace={owner} />);
    expect(await screen.findByRole("heading", { name: h.tickets.empty })).toBeInTheDocument();
  });

  it("มือถือ: รายการก่อน แตะแล้วเห็นรายละเอียดเต็มจอพร้อมปุ่มกลับ", async () => {
    const restore = asMobile();
    try {
      const user = userEvent.setup();
      const { rerender } = renderWithProviders(<TicketsPage workspace={owner} />);
      await user.click(await screen.findByRole("button", { name: /LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์/ }));
      expect(router.replace).toHaveBeenCalledWith("/work/sample?ticket=t1", { scroll: false });
      navigation.search = "ticket=t1";
      rerender(<TicketsPage workspace={owner} />);
      expect(await screen.findByRole("region", { name: "#531 LINE ไม่แจ้งเตือนในกลุ่มโปรเจกต์" })).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: h.tickets.listLabel })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: h.tickets.back }));
      expect(router.replace).toHaveBeenLastCalledWith("/work/sample", { scroll: false });
    } finally {
      restore();
    }
  });

  it("ข้อผิดพลาดของรายการแสดง requestId (5xx)", async () => {
    server.use(http.get("*/api/v1/w/:ws/support/tickets", () => HttpResponse.json({ error: { code: "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w26_err" } }, { status: 500 })));
    renderWithProviders(<TicketsPage workspace={owner} />);
    expect(await screen.findByText("รหัสอ้างอิง: req_w26_err")).toBeInTheDocument();
  });
});
