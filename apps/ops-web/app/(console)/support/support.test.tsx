import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { SupportPage } from "./SupportPage";

const T = "70000000-0000-4000-8000-000000000001";
const ws = {
  id: "10000000-0000-4000-8000-00000000000a",
  slug: "siam-demo",
  name: "สยามเดโม",
};
const row = {
  id: T,
  number: 512,
  subject: "นำเข้า Excel ไม่ได้",
  status: "open",
  priority: "high",
  channel: "email",
  requesterEmail: "pm@siam-demo.example.com",
  createdAt: "2026-11-09T02:00:00.000Z",
  firstResponseDueAt: "2026-11-09T06:00:00.000Z",
  assigneeId: null,
  assigneeName: null,
  workspace: ws,
  slaBreached: true,
};
const detail = {
  ticket: { ...row, cause: null, csat: null, assignee: null, category: "import", requesterName: "คุณพิม" },
  messages: [
    {
      id: "m1",
      authorKind: "customer",
      body: "กดนำเข้าแล้วค้าง",
      internal: false,
      createdAt: "2026-11-09T02:00:00.000Z",
      authorName: null,
    },
  ],
  customer: {
    ...ws,
    plan: "pro",
    seatLimit: 20,
    seats: 12,
    tickets90d: 3,
    unhappy90d: 1,
    accessUntil: null,
    accessGranted: false,
    accountManager: null,
    sla: { first: { n: 4, unit: "h" }, resolve: { n: 3, unit: "d" } },
  },
};
// O22 · ทีมตอนนี้ + ข้อความสำเร็จรูป (ข้อมูลสมมติ)
const team = {
  mode: "least",
  items: [
    { staffId: "00000000-0000-4000-8000-000000000002", name: "ซัพพอร์ตตัวอย่าง", groups: ["l1"], cap: 8, presence: "online", presenceNote: null, load: 5 },
    { staffId: "s-2", name: "ซัพพอร์ตสอง", groups: ["l2", "lead"], cap: 8, presence: "busy", presenceNote: "ประชุมถึง 11:00", load: 8 },
  ],
};
const canned = [
  { id: "c-1", title: "ขอข้อมูลเพิ่ม", body: "สวัสดีครับคุณ{ชื่อผู้แจ้ง} ขอ requestId ของเรื่อง {เลข Ticket} ที่ {ชื่อ Workspace}", tag: "ทั่วไป", uses: 88, archivedAt: null, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "เจ้าของ" },
  { id: "c-2", title: "Webhook ล้ม: ปลายทางถูกลบ", body: "ตรวจ URL ใน Discord", tag: "webhook", uses: 41, archivedAt: null, updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "เจ้าของ" },
];
const page = (search = "", extra: Parameters<typeof server.use> = []) => {
  navigation.pathname = "/support";
  navigation.search = search;
  // handler ของแต่ละ test มาก่อนค่าเริ่มต้น (MSW ใช้ตัวแรกที่ตรง)
  server.use(
    ...extra,
    http.get(`${OPS}/tickets`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      const items = q.get("assignee") === "none" || q.get("status") === "closed" ? [] : [row];
      return HttpResponse.json({
        items,
        summary: {
          open: 4,
          unassigned: 2,
          breached: 1,
          firstResponseMinutes: 42,
          csat: 4.6,
        },
      });
    }),
    http.get(`${OPS}/tickets/stats`, () =>
      HttpResponse.json({
        items: [
          {
            id: "s1",
            name: "ซัพพอร์ตตัวอย่าง",
            solved: 9,
            firstResponseMinutes: 30,
            resolutionHours: 5,
            withinSlaPct: 92,
            csat: 4.7,
          },
        ],
      }),
    ),
    http.get(`${OPS}/tickets/${T}`, () => HttpResponse.json(detail)),
    http.get(`${OPS}/support/team`, () => HttpResponse.json(team)),
    http.get(`${OPS}/support/canned-replies`, () => HttpResponse.json({ items: canned })),
  );
  return renderWithProviders(<SupportPage />);
};

describe("Support", () => {
  it("คิว Ticket เต็มความกว้าง · สรุป · กรองคิวกลาง · กดแถวเปิดแผง · ผลงานรายคนอยู่แท็บทีม", async () => {
    asRole("support");
    page();
    // คนตอบ Ticket เริ่มที่ "ของฉัน"
    expect(await screen.findByRole("tab", { name: "ของฉัน", selected: true })).toBeInTheDocument();
    expect(await screen.findByText("นำเข้า Excel ไม่ได้")).toBeInTheDocument();
    expect(screen.getByText(/เปิดอยู่ 4 · ยังไม่มีคนรับ 2 · เกิน SLA 1 · ตอบครั้งแรกเฉลี่ย 42 นาที · ความพึงพอใจ 4.6\/5/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ทีมตอนนี้" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /#512/ }));
    expect(router.replace).toHaveBeenCalledWith(`/support?ticket=${T}`);
    await userEvent.click(screen.getByRole("tab", { name: /คิวกลาง/ }));
    expect(await screen.findByText("คิวกลางว่าง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "ทีม" }));
    expect(await screen.findByRole("region", { name: "ทีมตอนนี้" })).toBeInTheDocument();
    expect(screen.getAllByText("ซัพพอร์ตตัวอย่าง").length).toBeGreaterThan(0);
  });

  it("บทสนทนาแบบแชท: ลูกค้าซ้าย · ทีมเราขวา · บันทึกภายในมีป้าย", async () => {
    asRole("support");
    const extra = [
      http.get(`${OPS}/tickets/${T}`, () =>
        HttpResponse.json({
          ...detail,
          messages: [
            detail.messages[0],
            { id: "m-2", authorKind: "staff", body: "ขอไฟล์ตัวอย่างครับ", internal: false, createdAt: "2026-11-09T02:10:00.000Z", authorName: "ซัพพอร์ตตัวอย่าง" },
            { id: "m-3", authorKind: "staff", body: "น่าจะแถวว่าง", internal: true, createdAt: "2026-11-09T02:11:00.000Z", authorName: "ซัพพอร์ตตัวอย่าง" },
          ],
        }),
      ),
    ];
    page(`ticket=${T}`, extra);
    const thread = await screen.findByRole("list", { name: "บทสนทนา" });
    expect(within(thread).getByText("กดนำเข้าแล้วค้าง").closest("li")).toHaveClass("bubble-them");
    expect(within(thread).getByText("ขอไฟล์ตัวอย่างครับ").closest("li")).toHaveClass("bubble-mine");
    const note = within(thread).getByText("น่าจะแถวว่าง").closest("li")!;
    expect(note).toHaveClass("bubble-mine", "bubble-note");
    expect(within(note).getByText("บันทึกภายใน")).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "#512 · นำเข้า Excel ไม่ได้" })).toBeInTheDocument();
  });

  it("รับเรื่อง · บันทึกภายใน · ปิดเรื่อง (T5)", async () => {
    asRole("support");
    const calls: { path: string; body: unknown }[] = [];
    const record = (path: string) => http.post(`${OPS}/tickets/${T}/${path}`, async ({ request }) => (calls.push({ path, body: await request.json().catch(() => null) }), HttpResponse.json({ ok: true })));
    server.use(record("claim"), record("messages"), record("solve"));
    page(`ticket=${T}`);
    expect(await screen.findByText("กดนำเข้าแล้วค้าง")).toBeInTheDocument();
    const aside = screen.getByRole("complementary", { name: "ลูกค้า" });
    expect(within(aside).getByText("ตอบภายใน 4 ชม. ทำการ")).toBeInTheDocument();
    expect(screen.getByText("นำเข้าข้อมูล")).toBeInTheDocument();
    expect(within(aside).getByText("ลูกค้ายังไม่เปิดสิทธิ์เข้าบัญชี")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "รับเรื่องนี้" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("claim"));

    await userEvent.click(screen.getByRole("button", { name: "บันทึกภายใน" }));
    await userEvent.type(screen.getByLabelText("บันทึกภายใน (ลูกค้าไม่เห็น)"), "ไฟล์มีแถวว่าง");
    await userEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "messages")?.body).toEqual({
        body: "ไฟล์มีแถวว่าง",
        internal: true,
        fromCustomer: false,
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "ปิดเรื่อง" }));
    const dlg = await screen.findByRole("dialog", { name: "ปิด #512?" });
    const submit = within(dlg).getByRole("button", { name: "ปิดเรื่อง" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("ผลลัพธ์ (ส่งถึงลูกค้า)"), "แก้ไฟล์ให้แล้ว");
    await userEvent.type(within(dlg).getByLabelText("สาเหตุจริง"), "แถวว่างในไฟล์");
    await userEvent.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "solve")?.body).toEqual({
        outcome: "แก้ไฟล์ให้แล้ว",
        cause: "แถวว่างในไฟล์",
        sendCsat: true,
      }),
    );
  });

  it("ผู้ตรวจดูได้อย่างเดียว ไม่มีปุ่มรับเรื่องหรือช่องตอบ", async () => {
    asRole("auditor");
    page(`ticket=${T}`);
    expect(await screen.findByText("กดนำเข้าแล้วค้าง")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "รับเรื่องนี้" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "สร้าง Ticket" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ส่ง" })).not.toBeInTheDocument();
  });

  it("O22: สถานะของฉัน · ทีมตอนนี้ · T4 ใส่ข้อความสำเร็จรูปพร้อมแทนตัวแปร", async () => {
    asRole("support");
    let presence: unknown = null;
    let used = "";
    server.use(
      http.put(`${OPS}/support/presence`, async ({ request }) => ((presence = await request.json()), HttpResponse.json({ presence: "busy", released: 0, leadsNotified: 0 }))),
      http.post(`${OPS}/support/canned-replies/:id/use`, ({ params }) => ((used = String(params.id)), HttpResponse.json({ uses: 89 }))),
    );
    page(`tab=team&ticket=${T}`);
    const strip = await screen.findByRole("region", { name: "ทีมตอนนี้" });
    expect(within(strip).getByText("8 / 8")).toBeInTheDocument();
    expect(within(strip).getByText("ประชุมถึง 11:00")).toBeInTheDocument();
    // แผง Ticket เปิดอยู่ (modal) ส่วนหน้าหลักจึงถูกซ่อนจากโปรแกรมอ่านจอชั่วคราว
    expect(screen.getByRole("link", { name: "ตั้งค่าการแจกงาน", hidden: true })).toHaveAttribute("href", "/support/settings");
    await userEvent.selectOptions(await screen.findByLabelText("สถานะของฉัน"), "busy");
    await waitFor(() => expect(presence).toEqual({ presence: "busy" }));

    await userEvent.click(await screen.findByRole("button", { name: "ข้อความสำเร็จรูป" }));
    const pop = await screen.findByRole("dialog", { name: "ข้อความสำเร็จรูป" });
    expect(within(pop).getByText("ใช้ 88")).toBeInTheDocument();
    await userEvent.type(within(pop).getByLabelText("ค้นหาข้อความ"), "requestId");
    expect(within(pop).queryByText("Webhook ล้ม: ปลายทางถูกลบ")).toBeNull();
    await userEvent.click(within(pop).getByText("ขอข้อมูลเพิ่ม"));
    expect(screen.getByPlaceholderText("ตอบลูกค้า")).toHaveValue("สวัสดีครับคุณคุณพิม ขอ requestId ของเรื่อง #512 ที่ สยามเดโม");
    await waitFor(() => expect(used).toBe("c-1"));
  });

  it("O22: สร้าง Ticket เลือกหมวดจากรายการ · ความสำคัญ \"ตามกฎ\" ไม่ส่งค่า", async () => {
    asRole("support");
    let sent: Record<string, unknown> = {};
    server.use(http.post(`${OPS}/tickets`, async ({ request }) => ((sent = (await request.json()) as Record<string, unknown>), HttpResponse.json({ ticket: { id: T, number: 600 } }, { status: 201 }))));
    page();
    await userEvent.click(await screen.findByRole("button", { name: "สร้าง Ticket" }));
    const drawer = await screen.findByRole("dialog", { name: "สร้าง Ticket" });
    await userEvent.type(within(drawer).getByLabelText("ผู้แจ้ง (อีเมล)"), "pm@siam-demo.example.com");
    await userEvent.selectOptions(within(drawer).getByLabelText("หมวด"), "bug");
    await userEvent.type(within(drawer).getByLabelText("หัวข้อ"), "Gantt ไม่ขยับ");
    await userEvent.type(within(drawer).getByLabelText("รายละเอียด"), "ลากแล้วไม่เลื่อน");
    await userEvent.click(within(drawer).getByRole("button", { name: "สร้าง" }));
    await waitFor(() => expect(sent).toMatchObject({ category: "bug", subject: "Gantt ไม่ขยับ" }));
    expect(sent).not.toHaveProperty("priority");
  });

  it("S3 ทีมตอนนี้ + คิวกลาง: เหตุที่ออฟไลน์ · คืนเข้าคิว · แจกอัตโนมัติ · รอคนออนไลน์ · S5 ข้อความตอนกลับมา", async () => {
    asRole("support");
    let presence: unknown = null;
    let seen = "";
    const me = "00000000-0000-4000-8000-000000000002";
    const extra = [
      http.get(`${OPS}/support/team`, ({ request }) => {
        seen = new URL(request.url).search;
        return HttpResponse.json({
          mode: "least",
          idleMinutes: 15,
          items: [
            { staffId: "s-1", name: "มิว ศิริ", groups: ["l1"], cap: 8, presence: "online", presenceNote: null, presenceReason: "manual", presenceAt: "2026-11-16T02:02:00.000Z", load: 6, released: 0 },
            { staffId: me, name: "นิด ใจดี", groups: ["l1"], cap: 8, presence: "offline", presenceNote: "ไม่มีการใช้งาน 15 นาที", presenceReason: "idle", presenceAt: "2026-11-16T05:40:00.000Z", load: 0, released: 3 },
            { staffId: "s-3", name: "ฟ้า พรหมมา", groups: [], cap: 8, presence: "offline", presenceNote: null, presenceReason: "logout", presenceAt: "2026-11-16T04:15:00.000Z", load: 0, released: 0 },
          ],
          me: { presence: "offline", presenceReason: "idle", presenceAt: "2026-11-16T05:40:00.000Z", released: 3 },
          queue: {
            redispatch: true,
            waiting: "all_full",
            items: [
              { id: "k-1", number: 544, subject: "ชำระแล้วแต่แพ็กเกจยังไม่เปลี่ยน", priority: "high", firstResponseDueAt: null, workspace: "Sathorn Clinic", autoAssigned: { name: "มิว ศิริ", at: "2026-11-16T05:41:00.000Z" } },
              { id: "k-2", number: 545, subject: "ส่งออก Excel ไม่ได้", priority: "normal", firstResponseDueAt: null, workspace: "Orbit Apps", autoAssigned: null },
            ],
          },
        });
      }),
      http.put(`${OPS}/support/presence`, async ({ request }) => ((presence = await request.json()), HttpResponse.json({ presence: "online", released: 0, leadsNotified: 0, redispatched: 1 }))),
    ];
    page("tab=team", extra);
    const teamCard = await screen.findByRole("region", { name: "ทีมตอนนี้" });
    expect(seen).toBe("?seen=1");
    expect(within(teamCard).getByText("ออฟไลน์ · อัตโนมัติ")).toBeInTheDocument();
    expect(within(teamCard).getByText("ไม่มีการใช้งาน 15 นาที")).toBeInTheDocument();
    expect(within(teamCard).getByText("0 · คืนเข้าคิว 3")).toBeInTheDocument();
    expect(within(teamCard).getByText("ออฟไลน์ · ออกจากระบบ")).toBeInTheDocument();
    expect(within(teamCard).getByText("6 / 8")).toBeInTheDocument();
    const queue = screen.getByRole("region", { name: "คิวกลาง" });
    expect(within(queue).getByText("เรื่องที่คืนเข้าคิวแจกใหม่อัตโนมัติทุก 1 นาที")).toBeInTheDocument();
    expect(within(queue).getByText("แจกให้ มิว ศิริ อัตโนมัติ 12:41")).toBeInTheDocument();
    expect(within(queue).getByText("รอคนออนไลน์ · ทุกคนเต็ม")).toBeInTheDocument();
    expect(within(queue).getByRole("link", { name: /#545 ส่งออก Excel ไม่ได้/ })).toHaveAttribute("href", "/support?ticket=k-2");
    // S5
    expect(screen.getByText(/ระบบเปลี่ยนคุณเป็น/)).toHaveTextContent("ระบบเปลี่ยนคุณเป็น ออฟไลน์ เมื่อ 12:40 เพราะไม่มีการใช้งาน 15 นาที · คืนเรื่อง 3 เรื่องเข้าคิวแล้ว");
    await userEvent.click(screen.getByRole("button", { name: "กลับมาออนไลน์" }));
    await waitFor(() => expect(presence).toEqual({ presence: "online" }));
  });

  it("S6 ไฟล์แนบและบริบทจากแอปลูกค้า · requestId ลิงก์ไปค้นในประวัติการส่ง · บันทึกของระบบไม่แสดงอีเมลลูกค้า", async () => {
    asRole("support");
    const extra = [
      http.get(`${OPS}/tickets/${T}`, () =>
        HttpResponse.json({
          ...detail,
          messages: [
            { ...detail.messages[0], id: "m-ctx", files: [{ index: 0, name: "ภาพหน้าจอ.png", size: 245_760, mime: "image/png" }, { index: 1, name: "export-error.xlsx", size: 18_432, mime: "application/octet-stream" }] },
            { id: "m-sys", authorKind: "staff", body: "แจกให้ มิว ศิริ อัตโนมัติจากคิวกลาง", internal: true, createdAt: "2026-11-09T02:01:00.000Z", authorName: null },
          ],
          context: { page: "บอร์ด", path: "/work/orbit-apps/p/DP/board", requestId: "req_7f3a9c2e", impact: "blocked", browser: "Chrome 131 · macOS", article: { slug: "save-failed", title: "บันทึกงานไม่ได้" } },
        }),
      ),
    ];
    page(`ticket=${T}`, extra);
    const ctx = await screen.findByRole("complementary", { name: "บริบทจากแอปลูกค้า" });
    expect(within(ctx).getByText("/work/orbit-apps/p/DP/board")).toBeInTheDocument();
    expect(within(ctx).getByRole("link", { name: "ค้นในประวัติการส่ง" })).toHaveAttribute("href", "/deliveries?q=req_7f3a9c2e");
    expect(within(ctx).getByText('อ่าน "บันทึกงานไม่ได้" ก่อนเปิด Ticket')).toBeInTheDocument();
    expect(within(ctx).getByText("Chrome 131 · macOS")).toBeInTheDocument();
    expect(within(ctx).getByText("ทำงานต่อไม่ได้")).toBeInTheDocument();
    const files = screen.getByRole("list", { name: "ไฟล์แนบ" });
    expect(within(files).getByRole("link", { name: /ภาพหน้าจอ\.png · 240 KB/ })).toHaveAttribute("href", `/ops-api/tickets/${T}/messages/m-ctx/files/0`);
    expect(within(files).getByRole("link", { name: /export-error\.xlsx · 18 KB/ })).toBeInTheDocument();
    const sys = screen.getByText("แจกให้ มิว ศิริ อัตโนมัติจากคิวกลาง").closest("li")!;
    expect(within(sys).getByText("ระบบ")).toBeInTheDocument();
  });
});
