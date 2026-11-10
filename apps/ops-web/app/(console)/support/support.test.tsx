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
const page = (search = "") => {
  navigation.pathname = "/support";
  navigation.search = search;
  server.use(
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
  it("คิว Ticket · สรุป · กรองคิวกลาง · กดเปิดรายละเอียด", async () => {
    asRole("support");
    page();
    expect(await screen.findByText("นำเข้า Excel ไม่ได้")).toBeInTheDocument();
    expect(screen.getByText(/เปิดอยู่ 4 · ยังไม่มีคนรับ 2 · เกิน SLA 1 · ตอบครั้งแรกเฉลี่ย 42 นาที · ความพึงพอใจ 4.6\/5/)).toBeInTheDocument();
    expect(screen.getByText("ซัพพอร์ตตัวอย่าง")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /#512/ }));
    expect(router.replace).toHaveBeenCalledWith(`/support?ticket=${T}`);
    await userEvent.click(screen.getByRole("button", { name: "คิวกลาง" }));
    expect(await screen.findByText("คิวกลางว่าง")).toBeInTheDocument();
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
    page(`ticket=${T}`);
    const strip = await screen.findByRole("region", { name: "ทีมตอนนี้" });
    expect(within(strip).getByText("งานเปิด 8/8")).toBeInTheDocument();
    expect(within(strip).getByText(/ไม่ว่าง · ประชุมถึง 11:00/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ตั้งค่าการแจกงาน" })).toHaveAttribute("href", "/support/settings");
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
});
