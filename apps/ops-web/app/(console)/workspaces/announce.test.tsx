// O24 · C8 ส่งประกาศถึงลูกค้าที่เลือก (เปิดจาก Workspaces › เลือกหลายแถว) · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import type { WsRow } from "./_parts/types";
import { WorkspacesList } from "./WorkspacesList";

const WS = "10000000-0000-4000-8000-00000000000a";
const W2 = "10000000-0000-4000-8000-00000000000b";
const row = (over: Partial<WsRow>): WsRow => ({
  id: WS, slug: "siam-demo", name: "สยามเดโม", status: "active", createdAt: "2026-03-14T03:00:00.000Z", plan: "team_m", subStatus: "active", cycle: "monthly",
  trialEndsAt: null, periodEnd: null, seats: 21, seatLimit: 25, projects: 14, active30: 18, lastActiveAt: new Date().toISOString(), storageBytes: 12 * 1024 ** 3,
  integrations: [], health: 86, mrr: 300_000, paymentState: "ok", ...over,
});
const audience = { workspaces: 2, people: 5, emails: 4, suppressed: 1, noRecipients: [] };

function setup(opts: { audience?: unknown; create?: (body: Record<string, unknown>) => Response } = {}) {
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  server.use(
    http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [row({}), row({ id: W2, slug: "orbit-labs", name: "Orbit Labs" })], total: 2, limit: 50, offset: 0, sort: "recent_activity" })),
    http.post(`${OPS}/announcements/audience`, async ({ request }) => (posted.push({ path: "audience", body: (await request.json()) as Record<string, unknown> }), HttpResponse.json(opts.audience ?? audience))),
    http.post(`${OPS}/announcements/test`, async ({ request }) => (posted.push({ path: "test", body: (await request.json()) as Record<string, unknown> }), HttpResponse.json({ to: "admin@example.com" }))),
    http.post(`${OPS}/announcements`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posted.push({ path: "create", body });
      if (opts.create) return opts.create(body);
      const scheduled = !!body.scheduledAt;
      return HttpResponse.json({ id: "a1", status: scheduled ? "scheduled" : "sent", scheduledAt: body.scheduledAt ?? null, workspaces: { count: 2, names: [], ids: [] } }, { status: 201 });
    }),
  );
  navigation.pathname = "/workspaces";
  renderWithProviders(
    <AppShell>
      <WorkspacesList />
    </AppShell>,
  );
  return posted;
}
async function openDrawer() {
  await userEvent.click(await screen.findByLabelText("เลือก สยามเดโม"));
  await userEvent.click(screen.getByLabelText("เลือก Orbit Labs"));
  await userEvent.click(screen.getByRole("button", { name: "ส่งประกาศ" }));
  return screen.findByRole("dialog", { name: "ส่งประกาศถึง 2 Workspace" });
}

describe("C8 · ส่งประกาศถึงลูกค้าที่เลือก", () => {
  it("นับผู้รับ · เตือนรายชื่อไม่ส่ง · ดูตัวอย่างแทนตัวแปร · ส่งตอนนี้ทั้งสองช่องทาง", async () => {
    const posted = setup();
    const dlg = await openDrawer();
    expect(await within(dlg).findByText("Owner และ Admin รวม 5 คน")).toBeInTheDocument();
    expect(posted[0]).toEqual({ path: "audience", body: { workspaceIds: [WS, W2] } });
    expect(within(dlg).getByText("ไม่ส่งอีเมลถึง 1 คนที่อยู่ในรายชื่อไม่ส่ง (ยังเห็นแบนเนอร์ในแอป)")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "ทั้งสอง" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dlg).getByText("กรอกหัวข้อและข้อความเพื่อดูตัวอย่าง")).toBeInTheDocument();

    // ส่งโดยไม่กรอก → แจ้งช่องที่ขาด ไม่เรียก API
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งประกาศ" }));
    expect(within(dlg).getAllByText("จำเป็น")).toHaveLength(2);
    expect(posted.some((p) => p.path === "create")).toBe(false);

    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "แจ้งปิดปรับปรุงของ {{ชื่อ Workspace}");
    await userEvent.type(within(dlg).getByLabelText("ข้อความ *"), "เรียนทีม {{ชื่อ Workspace} ปิดปรับปรุงคืนวันเสาร์");
    const email = within(dlg).getByLabelText("อีเมล", { selector: "div" });
    expect(within(email).getByText("[Friday] ประกาศจากทีม Friday: แจ้งปิดปรับปรุงของ สยามเดโม")).toBeInTheDocument();
    expect(within(email).getByText(/เรียนทีม สยามเดโม ปิดปรับปรุงคืนวันเสาร์/)).toBeInTheDocument();
    const banner = within(dlg).getByLabelText("แบนเนอร์ในแอป", { selector: "div" });
    expect(within(banner).getByText("จากทีม Friday · แจ้งปิดปรับปรุงของ สยามเดโม")).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งประกาศ" }));
    await waitFor(() => expect(posted.find((p) => p.path === "create")?.body).toEqual({ workspaceIds: [WS, W2], title: "แจ้งปิดปรับปรุงของ {ชื่อ Workspace}", message: "เรียนทีม {ชื่อ Workspace} ปิดปรับปรุงคืนวันเสาร์", channels: ["email", "banner"], scheduledAt: null }));
    expect(await screen.findByText("ส่งประกาศถึง 2 Workspace แล้ว")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText("เลือก 2 Workspace")).not.toBeInTheDocument();
  });

  it("ตั้งเวลา (เวลาไทย) · แบนเนอร์อย่างเดียวไม่มีตัวอย่างอีเมล · เวลาในอดีตส่งไม่ได้", async () => {
    const posted = setup();
    const dlg = await openDrawer();
    await within(dlg).findByText("Owner และ Admin รวม 5 คน");
    await userEvent.click(within(dlg).getByRole("button", { name: "แบนเนอร์ในแอป" }));
    // แบนเนอร์อย่างเดียว: ไม่เตือนเรื่องรายชื่อไม่ส่งอีเมล
    expect(within(dlg).queryByText(/ไม่ส่งอีเมลถึง/)).not.toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "ราคารายปีใหม่");
    await userEvent.type(within(dlg).getByLabelText("ข้อความ *"), "เริ่ม 1 ม.ค. 2570");
    expect(within(dlg).queryByLabelText("อีเมล", { selector: "div" })).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ตั้งเวลา" }));
    const at = within(dlg).getByLabelText("เวลา (เวลาไทย)");
    await userEvent.type(at, "2020-01-01T10:00");
    expect(within(dlg).getByText("เวลาส่งต้องอยู่ในอนาคต")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ตั้งเวลาส่ง" }));
    expect(posted.some((p) => p.path === "create")).toBe(false);
    await userEvent.clear(at);
    await userEvent.type(at, "2099-11-15T10:00");
    await userEvent.click(within(dlg).getByRole("button", { name: "ตั้งเวลาส่ง" }));
    await waitFor(() => expect(posted.find((p) => p.path === "create")?.body).toMatchObject({ channels: ["banner"], scheduledAt: "2099-11-15T03:00:00.000Z" }));
    expect(await screen.findByText(/^ตั้งเวลาส่ง .* แล้ว · ดูหรือยกเลิกได้ที่หน้าประกาศถึงลูกค้า$/)).toBeInTheDocument();
  });

  it("ส่งทดสอบถึงฉัน · error จาก ops-api แสดงใน Drawer", async () => {
    const posted = setup({ create: () => opsError(404, "workspace_not_found", "ไม่พบ Workspace บางแห่ง (อาจถูกลบไปแล้ว)") });
    const dlg = await openDrawer();
    await within(dlg).findByText("Owner และ Admin รวม 5 คน");
    expect(within(dlg).getByRole("button", { name: "ส่งทดสอบถึงฉัน" })).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "ทดสอบ");
    await userEvent.type(within(dlg).getByLabelText("ข้อความ *"), "ข้อความทดสอบ");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งทดสอบถึงฉัน" }));
    expect(await screen.findByText("ส่งอีเมลทดสอบถึง admin@example.com แล้ว")).toBeInTheDocument();
    expect(posted.find((p) => p.path === "test")?.body).toEqual({ title: "ทดสอบ", message: "ข้อความทดสอบ", workspaceId: WS });
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งประกาศ" }));
    expect(await within(dlg).findByText(/ไม่พบ Workspace บางแห่ง/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Workspace ที่ไม่มี Owner / Admin ใช้งานอยู่ถูกเตือน", async () => {
    setup({ audience: { ...audience, suppressed: 0, noRecipients: [{ id: W2, name: "Orbit Labs" }] } });
    const dlg = await openDrawer();
    expect(await within(dlg).findByText("ไม่มี Owner / Admin ที่ใช้งานอยู่: Orbit Labs")).toBeInTheDocument();
  });

  it.each(["support", "finance"] as const)("ซ่อนปุ่มตามบทบาท: %s ไม่เห็น \"ส่งประกาศ\"", async (role) => {
    asRole(role);
    setup();
    await userEvent.click(await screen.findByLabelText("เลือก สยามเดโม"));
    expect(screen.getByText("เลือก 1 Workspace")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ส่งประกาศ" })).not.toBeInTheDocument();
  });
});
