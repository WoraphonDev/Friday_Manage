import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { IncidentsPage } from "./IncidentsPage";

const incident = {
  id: "i1",
  title: "แจ้งเตือน LINE ล่าช้า",
  impact: "partial",
  status: "investigating",
  services: ["notifications_line"],
  internal: false,
  startedAt: "2026-11-09T02:00:00.000Z",
  resolvedAt: null,
  updates: [
    {
      id: "u1",
      status: "investigating",
      message: "กำลังตรวจสอบ",
      createdAt: "2026-11-09T02:00:00.000Z",
      notifySubscribers: true,
      showBanner: false,
    },
  ],
};
const jobs = [
  {
    id: "41",
    name: "notify.line",
    reason: "LINE API 500",
    attempts: 5,
    failedAt: new Date(Date.now() - 600_000).toISOString(),
    workspaceId: "10000000-0000-4000-8000-00000000000a",
  },
];
const page = (search = "") => {
  navigation.pathname = "/incidents";
  navigation.search = search;
  server.use(
    http.get(`${OPS}/incidents`, () => HttpResponse.json({ items: [incident], subscribers: 37 })),
    http.get(`${OPS}/maintenance`, () =>
      HttpResponse.json({
        items: [
          {
            id: "m1",
            scope: "read_only",
            message: "ย้ายฐานข้อมูล",
            startsAt: "2026-11-15T15:00:00.000Z",
            endsAt: "2026-11-15T17:00:00.000Z",
            status: "scheduled",
          },
        ],
        active: null,
      }),
    ),
    http.get(`${OPS}/jobs/failed`, () => HttpResponse.json({ configured: true, items: jobs })),
  );
  return renderWithProviders(
    <AppShell>
      <IncidentsPage />
    </AppShell>,
  );
};
const posts = () => {
  const calls: { path: string; body: unknown }[] = [];
  const rec = (path: string, res: () => Response = () => HttpResponse.json({ ok: true, notified: 37, items: [{ retried: true }] })) =>
    http.post(`${OPS}/${path}`, async ({ request }) => (calls.push({ path, body: await request.json().catch(() => null) }), res()));
  return { calls, rec };
};

describe("เหตุขัดข้องและปิดปรับปรุง", () => {
  it("อัปเดตเหตุขัดข้อง · ตัวอย่างหน้าสถานะสาธารณะ", async () => {
    asRole("support");
    const { calls, rec } = posts();
    server.use(rec("incidents/i1/updates"));
    page();
    const card = await screen.findByRole("article", {
      name: "แจ้งเตือน LINE ล่าช้า",
    });
    expect(screen.getByText("ผู้ติดตาม 37 คน", { exact: false })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "ตัวอย่างหน้าสถานะสาธารณะ" })).getByText("บางบริการใช้ไม่ได้")).toBeInTheDocument();
    // Support ไม่เห็นปิดปรับปรุงและงานที่ล้ม (วิศวกร)
    expect(screen.queryByText("งานเบื้องหลังที่ล้ม")).not.toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText("ข้อความอัปเดตถึงลูกค้า"), "พบสาเหตุที่ผู้ให้บริการ");
    await userEvent.click(within(card).getByRole("button", { name: "เผยแพร่อัปเดต" }));
    await waitFor(() =>
      expect(calls[0]?.body).toEqual({
        status: "identified",
        message: "พบสาเหตุที่ผู้ให้บริการ",
        notifySubscribers: true,
        showBanner: false,
      }),
    );
    expect(await screen.findByText("เผยแพร่อัปเดตแล้ว · อีเมล 37 คน")).toBeInTheDocument();
  });

  it("เปิดเหตุขัดข้องใหม่ (Y3) จากลิงก์ ?new=1", async () => {
    asRole("engineer");
    const { calls, rec } = posts();
    server.use(rec("incidents"));
    page("new=1");
    const drawer = await screen.findByRole("dialog", {
      name: "เปิดเหตุขัดข้อง",
    });
    const submit = within(drawer).getByRole("button", {
      name: "เปิดเหตุขัดข้อง",
    });
    await userEvent.type(within(drawer).getByLabelText("หัวข้อ (ลูกค้าเห็น)"), "อัปโหลดไฟล์ช้า");
    await userEvent.click(within(drawer).getByRole("button", { name: "ไฟล์แนบ" }));
    await userEvent.type(within(drawer).getByLabelText("ข้อความแรก"), "กำลังตรวจสอบ");
    await userEvent.click(within(drawer).getByLabelText("ภายในทีมเท่านั้น (ไม่ขึ้นหน้าสถานะ)"));
    await userEvent.click(submit);
    await waitFor(() =>
      expect(calls[0]?.body).toEqual({
        title: "อัปโหลดไฟล์ช้า",
        impact: "minor",
        services: ["files"],
        message: "กำลังตรวจสอบ",
        internal: true,
        notifySubscribers: true,
        showBanner: false,
      }),
    );
  });

  it("ปิดปรับปรุง (Y5) ส่งขออนุมัติ · ยกเลิกที่ตั้งเวลาไว้", async () => {
    asRole("engineer");
    const { calls, rec } = posts();
    server.use(
      rec("maintenance", () =>
        HttpResponse.json(
          {
            pendingApproval: {
              id: "ap-9",
              kind: "system.maintenance",
              reason: "x",
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              amountSatang: null,
              payload: { rule: "ปิดปรับปรุงต้องอนุมัติทุกครั้ง" },
              canSelfApprove: false,
            },
          },
          { status: 202 },
        ),
      ),
      rec("maintenance/m1/end"),
    );
    page();
    expect(await screen.findByText(/ย้ายฐานข้อมูล/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ขอปิดปรับปรุง" }));
    const drawer = await screen.findByRole("dialog", { name: "ปิดปรับปรุง" });
    await userEvent.click(within(drawer).getByRole("button", { name: "เปิดทันที" }));
    await userEvent.type(within(drawer).getByLabelText("สิ้นสุด (ประมาณ)"), "2026-11-20T02:00");
    await userEvent.type(within(drawer).getByLabelText("ข้อความที่ลูกค้าเห็น"), "ปรับปรุงระบบฉุกเฉิน");
    await userEvent.type(within(drawer).getByLabelText("เหตุผล (ผู้อนุมัติเห็น)"), "แก้ช่องโหว่");
    await userEvent.click(within(drawer).getByRole("button", { name: "ส่งขออนุมัติ" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(calls[0]?.body).toMatchObject({
      scope: "read_only",
      message: "ปรับปรุงระบบฉุกเฉิน",
      notifyPlan: "3d_and_1h",
      reason: "แก้ช่องโหว่",
    });
    expect(calls[0]?.body).not.toHaveProperty("startsAt");
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
    const dlg = await screen.findByRole("dialog", {
      name: /ยกเลิก · อ่านอย่างเดียว/,
    });
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("maintenance/m1/end"));
  });

  it("งานที่ล้ม: ลองใหม่ที่เลือก · ทิ้งต้องมีเหตุผล", async () => {
    asRole("engineer");
    const { calls, rec } = posts();
    server.use(rec("jobs/retry"), rec("jobs/41/discard"));
    page();
    expect(await screen.findByText("LINE API 500")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "งาน notify.line 41" }));
    await userEvent.click(screen.getByRole("button", { name: "ลองใหม่ทั้งหมดที่เลือก" }));
    await waitFor(() => expect(calls[0]).toEqual({ path: "jobs/retry", body: { ids: ["41"] } }));
    expect(await screen.findByText("ส่งกลับเข้าคิวแล้ว 1 งาน")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "ทิ้ง" }));
    const dlg = await screen.findByRole("dialog", {
      name: "ทิ้งงาน notify.line?",
    });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ลูกค้ายกเลิก LINE แล้ว");
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() =>
      expect(calls[1]).toEqual({
        path: "jobs/41/discard",
        body: { reason: "ลูกค้ายกเลิก LINE แล้ว" },
      }),
    );
  });
});
