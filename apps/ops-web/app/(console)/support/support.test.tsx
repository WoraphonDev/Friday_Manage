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
  ticket: { ...row, cause: null, csat: null, assignee: null },
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
    sla: { first: 4 },
  },
};
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
});
