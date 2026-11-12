// O24 · หน้า "ประกาศถึงลูกค้า": ประวัติ · ยกเลิกก่อนส่ง · หยุดแบนเนอร์ · ซ่อนตามบทบาท · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import type { AnnouncementItem } from "../workspaces/_parts/Announce";
import { AnnouncementsPage } from "./AnnouncementsPage";

const base: AnnouncementItem = {
  id: "a-sent", title: "ปิดปรับปรุงคืนวันเสาร์", message: "22:00–23:00 น.", channels: ["email", "banner"], status: "sent",
  scheduledAt: null, sentAt: "2026-11-12T03:00:00.000Z", cancelledAt: null, createdAt: "2026-11-12T03:00:00.000Z", createdBy: "แอดมินตัวอย่าง",
  workspaces: { count: 5, names: ["Orbit Labs", "สยามเดโม", "ทีมตัวอย่าง"], ids: [] }, recipients: 9,
  email: { total: 9, sent: 7, suppressed: 1, failed: 0, waiting: 1 }, canCancel: true,
};
const items: AnnouncementItem[] = [
  { ...base, id: "a-sched", title: "ราคารายปีใหม่", status: "scheduled", sentAt: null, scheduledAt: "2026-12-01T03:00:00.000Z", recipients: null, email: null, workspaces: { count: 1, names: ["สยามเดโม"], ids: [] } },
  base,
  { ...base, id: "a-mail", title: "ใบกำกับภาษีพร้อมแล้ว", channels: ["email"], canCancel: false, workspaces: { count: 1, names: ["Orbit Labs"], ids: [] } },
];

function view(list: { items: AnnouncementItem[]; bannerDays: number } = { items, bannerDays: 30 }) {
  const cancels: { id: string; body: unknown }[] = [];
  server.use(
    http.get(`${OPS}/announcements`, () => HttpResponse.json(list)),
    http.post(`${OPS}/announcements/:id/cancel`, async ({ params, request }) => (cancels.push({ id: String(params.id), body: await request.json() }), HttpResponse.json({ ...base, id: params.id, status: "cancelled" }))),
  );
  navigation.pathname = "/announcements";
  renderWithProviders(
    <AppShell>
      <AnnouncementsPage />
    </AppShell>,
  );
  return cancels;
}

describe("ประกาศถึงลูกค้า", () => {
  it("ตาราง: ผู้รับ ช่องทาง ผลการส่งอีเมล สถานะ · ปุ่มยกเลิกเฉพาะที่ยกเลิกได้ · เมนูเปิดใช้แล้ว", async () => {
    view();
    const table = (await screen.findByText("ปิดปรับปรุงคืนวันเสาร์")).closest("table")!;
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("ตั้งเวลาไว้")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("button", { name: "ยกเลิกการส่ง" })).toBeInTheDocument();
    expect(within(rows[1]).getByText("Orbit Labs, สยามเดโม, ทีมตัวอย่าง และอีก 2 แห่ง")).toBeInTheDocument();
    expect(within(rows[1]).getByText("9 คน")).toBeInTheDocument();
    expect(within(rows[1]).getByText("ส่งถึง 7 · รอ 1 · ไม่ส่ง 1 · ล้ม 0")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("button", { name: "หยุดแบนเนอร์" })).toBeInTheDocument();
    expect(within(rows[2]).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ส่งประกาศใหม่" })).toHaveAttribute("href", "/workspaces");
    expect(screen.getByRole("link", { name: "ประกาศถึงลูกค้า" })).toHaveAttribute("href", "/announcements");
  });

  it("ยกเลิกที่ตั้งเวลาไว้พร้อมเหตุผล → เรียก cancel แล้วแจ้งผล", async () => {
    const cancels = view();
    await userEvent.click(await screen.findByRole("button", { name: "ยกเลิกการส่ง" }));
    const dlg = await screen.findByRole("dialog", { name: 'ยกเลิกประกาศ "ราคารายปีใหม่"?' });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (ไม่บังคับ)"), "ข้อความยังไม่ถูก");
    await userEvent.click(within(dlg).getByRole("button", { name: "ยกเลิกการส่ง" }));
    await waitFor(() => expect(cancels).toEqual([{ id: "a-sched", body: { reason: "ข้อความยังไม่ถูก" } }]));
    expect(await screen.findByText("ยกเลิกประกาศแล้ว")).toBeInTheDocument();
  });

  it("หยุดแบนเนอร์หลังส่ง (ไม่กรอกเหตุผลได้)", async () => {
    const cancels = view();
    await userEvent.click(await screen.findByRole("button", { name: "หยุดแบนเนอร์" }));
    const dlg = await screen.findByRole("dialog", { name: 'หยุดแสดงแบนเนอร์ "ปิดปรับปรุงคืนวันเสาร์"?' });
    expect(within(dlg).getByText("แบนเนอร์หายจากแอปของลูกค้าทันที · อีเมลที่ส่งไปแล้วเรียกคืนไม่ได้")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "หยุดแบนเนอร์" }));
    await waitFor(() => expect(cancels).toEqual([{ id: "a-sent", body: {} }]));
    expect(await screen.findByText("หยุดแสดงแบนเนอร์แล้ว")).toBeInTheDocument();
  });

  it("ว่าง: บอกวิธีส่งประกาศ · error แสดง requestId", async () => {
    view({ items: [], bannerDays: 30 });
    expect(await screen.findByText("ยังไม่มีประกาศ")).toBeInTheDocument();
    expect(screen.getByText('เลือก Workspace ในหน้า Workspaces แล้วกด "ส่งประกาศ"')).toBeInTheDocument();
  });

  it("ops-api ล้ม: แสดงรหัสอ้างอิง", async () => {
    view();
    server.use(http.get(`${OPS}/announcements`, () => opsError(500, "internal_error", "ระบบขัดข้อง", undefined, "req-ann-500")));
    expect(await screen.findByText(/req-ann-500/)).toBeInTheDocument();
  });

  it("ไม่ใช่ Owner: หน้าไม่มีสิทธิ์และไม่เรียก ops-api · ไม่เห็นเมนู", async () => {
    asRole("support");
    let called = 0;
    server.use(http.get(`${OPS}/announcements`, () => (called++, HttpResponse.json({ items }))));
    navigation.pathname = "/announcements";
    renderWithProviders(
      <AppShell>
        <AnnouncementsPage />
      </AppShell>,
    );
    expect(await screen.findByText("หน้านี้เปิดให้ Owner")).toBeInTheDocument();
    expect(called).toBe(0);
    expect(screen.queryByRole("link", { name: "ประกาศถึงลูกค้า" })).not.toBeInTheDocument();
  });
});
