// W24 · ปุ่มมีอะไรใหม่ (U1) และ Spotlight (U2) ใน WorkspaceShell · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { renderWithProviders } from "@/test/render";
import { asMobile } from "@/test/mobile";
import { navigation, router } from "@/test/router";
import { server } from "@/test/server";
import { workspaces } from "@/test/fixtures";
import type { WhatsNewItem } from "./api";
import { EngagementPrompts } from "./index";

const A = "70000000-0000-4000-8000-0000000000a1";
const B = "70000000-0000-4000-8000-0000000000b2";
const C = "70000000-0000-4000-8000-0000000000c3";
const item = (over: Partial<WhatsNewItem>): WhatsNewItem => ({
  id: A, kind: "new", title: "ขอเลื่อน Due ผ่าน LINE ได้แล้ว", summary: "หัวหน้าทีมกดอนุมัติหรือปฏิเสธจากข้อความใน LINE ได้ทันที", body: "- หัวหน้าทีมได้ข้อความพร้อมปุ่มอนุมัติ / ปฏิเสธ\n- ทุกการกดบันทึกใน Audit log ของ Workspace",
  titleEn: "Approve due-date requests in LINE", summaryEn: null, bodyEn: null,
  media: { url: "https://cdn.example.com/changelog/line.png", kind: "image", alt: "ข้อความ LINE พร้อมปุ่มอนุมัติ" },
  cta: { label: "ผูก LINE", labelEn: "Link LINE", path: "/profile?tab=notify" }, date: "2026-11-10", publishedAt: "2026-11-10T02:00:00.000Z", spotlight: false, unseen: true, ...over,
});
const items = [
  item({}),
  item({ id: B, title: "สรุปงานประจำวันทางอีเมล", titleEn: null, summary: "รวมงานในอีเมลเดียวตอน 08:30", media: null, cta: { label: "ตั้งค่าอีเมล", labelEn: null, path: "/profile?tab=notify" }, date: "2026-11-06" }),
  item({ id: C, kind: "fixed", title: "นำเข้า Excel เตือนเมื่อ Parent Key ว่าง", titleEn: null, media: null, cta: null, date: "2026-11-04", unseen: false }),
];

function list(data: { items: WhatsNewItem[]; unseen: number; hidden?: boolean }) {
  const calls: { path: string; body?: unknown }[] = [];
  server.use(
    http.get("*/api/v1/me/whats-new", () => HttpResponse.json({ seenAt: null, hidden: false, ...data })),
    http.post("*/api/v1/me/whats-new/seen", async ({ request }) => (calls.push({ path: "seen", body: await request.json() }), HttpResponse.json({ seenAt: "2026-11-12T03:00:00.000Z", counted: 2 }))),
    http.post("*/api/v1/me/whats-new/:id/click", ({ params }) => (calls.push({ path: `click/${params.id}` }), HttpResponse.json({ id: params.id, clicked: true }))),
  );
  return calls;
}
const shell = (ws = "sample") =>
  renderWithProviders(
    <WorkspaceShell ws={ws}>
      <p>เนื้อหาหน้า</p>
    </WorkspaceShell>,
  );

describe("แผงมีอะไรใหม่ (U1)", () => {
  it("ปุ่มของขวัญอยู่ซ้ายของกระดิ่ง มีจุดเหลืองเมื่อมีรายการใหม่ · เปิดแผง = เห็นแล้ว (จุดหาย) · รายการเก่าจาง", async () => {
    const calls = list({ items, unseen: 2 });
    shell();
    const gift = await screen.findByRole("button", { name: "มีอะไรใหม่ (มีรายการที่ยังไม่เห็น)" });
    expect(screen.getByTestId("whats-new-dot")).toBeInTheDocument();
    const bell = screen.getByRole("link", { name: /แจ้งเตือน/ });
    expect(gift.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(gift);
    const pop = await screen.findByRole("dialog", { name: "มีอะไรใหม่" });
    expect(within(pop).getByText("ใหม่ 2")).toBeInTheDocument();
    const cards = within(pop).getAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByRole("img", { name: "ข้อความ LINE พร้อมปุ่มอนุมัติ" })).toHaveAttribute("src", "https://cdn.example.com/changelog/line.png");
    expect(within(cards[0]).getByText("ใหม่")).toBeInTheDocument();
    expect(within(cards[2]).getByText("แก้ไข")).toBeInTheDocument();
    expect(cards[2].className).toMatch(/read/);
    expect(cards[0].className).not.toMatch(/read/);
    expect(within(pop).getByText("รายการเก่ากว่า 90 วันไม่แสดง")).toBeInTheDocument();
    // ลิงก์หน้าสาธารณะซ่อนไว้ก่อน (คำตัดสิน W24)
    expect(within(pop).queryByText(/fridaymanage.com\/changelog/)).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toEqual([{ path: "seen", body: { workspace: "sample" } }]));
    await waitFor(() => expect(screen.queryByTestId("whats-new-dot")).not.toBeInTheDocument());
    // "อ่านทั้งหมดแล้ว" ทำให้ทุกรายการจาง
    await userEvent.click(within(pop).getByRole("button", { name: "อ่านทั้งหมดแล้ว" }));
    expect(within(pop).getAllByRole("article").every((a) => /read/.test(a.className))).toBe(true);
    expect(within(pop).queryByText("ใหม่ 2")).not.toBeInTheDocument();
  });

  it("ปุ่ม \"ลองใช้\" พาไปหน้าใน Workspace ปัจจุบันและนับคลิก", async () => {
    const calls = list({ items, unseen: 0 });
    shell();
    await userEvent.click(await screen.findByRole("button", { name: "มีอะไรใหม่" }));
    const pop = await screen.findByRole("dialog", { name: "มีอะไรใหม่" });
    const cta = within(pop).getByRole("link", { name: "ผูก LINE" });
    expect(cta).toHaveAttribute("href", "/work/sample/profile?tab=notify");
    await userEvent.click(cta);
    await waitFor(() => expect(calls).toContainEqual({ path: `click/${A}` }));
    // ไม่มีรายการใหม่ = ไม่ต้องบอก API ว่าเห็นแล้ว
    expect(calls.filter((c) => c.path === "seen")).toEqual([]);
  });

  it("ว่าง · โหลดไม่สำเร็จ (ไม่บังงาน ลองใหม่ได้)", async () => {
    list({ items: [], unseen: 0 });
    shell();
    await userEvent.click(await screen.findByRole("button", { name: "มีอะไรใหม่" }));
    expect(await screen.findByText("ยังไม่มีอะไรใหม่ในช่วงนี้")).toBeInTheDocument();
  });

  it("โหลดไม่สำเร็จ: ปุ่มยังอยู่ (ไม่มีจุด) · แผงบอกสั้น ๆ พร้อมลองใหม่ · เนื้อหาหน้ายังใช้ได้", async () => {
    let fail = true;
    server.use(http.get("*/api/v1/me/whats-new", () => (fail ? HttpResponse.json({ error: { code: "internal_error", message: "ผิดพลาด" } }, { status: 500 }) : HttpResponse.json({ items, unseen: 0, seenAt: null, hidden: false }))));
    shell();
    expect(await screen.findByText("เนื้อหาหน้า")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "มีอะไรใหม่" }));
    const pop = await screen.findByRole("dialog", { name: "มีอะไรใหม่" });
    expect(within(pop).getByRole("alert")).toHaveTextContent("โหลดรายการไม่สำเร็จ");
    fail = false;
    await userEvent.click(within(pop).getByRole("button", { name: "ลองใหม่" }));
    expect(await within(pop).findAllByRole("article")).toHaveLength(3);
  });

  it("Guest ไม่เห็นปุ่มและไม่เรียก API · Workspace ที่ถูกระงับ (hidden) ไม่แสดงปุ่ม", async () => {
    let called = 0;
    server.use(
      http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role: "guest" }] })),
      http.get("*/api/v1/me/whats-new", () => (called++, HttpResponse.json({ items, unseen: 2, seenAt: null, hidden: false }))),
      http.get("*/api/v1/me/spotlight", () => (called++, HttpResponse.json({ item: null }))),
    );
    shell();
    expect(await screen.findByText("เนื้อหาหน้า")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /มีอะไรใหม่/ })).not.toBeInTheDocument();
    expect(called).toBe(0);
  });

  it("Workspace ที่ถูกระงับ: API ตอบ hidden → ไม่มีปุ่ม", async () => {
    list({ items: [], unseen: 0, hidden: true });
    shell();
    expect(await screen.findByText("เนื้อหาหน้า")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: /มีอะไรใหม่/ })).not.toBeInTheDocument();
  });

  it("ภาษาอังกฤษ: ใช้ฉบับอังกฤษเมื่อมี ไม่มีใช้ฉบับไทย", async () => {
    list({ items, unseen: 1 });
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>content</p>
      </WorkspaceShell>,
      { locale: "en" },
    );
    await userEvent.click(await screen.findByRole("button", { name: "What's new (unseen updates)" }));
    const pop = await screen.findByRole("dialog", { name: "What's new" });
    expect(within(pop).getByText("Approve due-date requests in LINE")).toBeInTheDocument();
    expect(within(pop).getByRole("link", { name: "Link LINE" })).toBeInTheDocument();
    expect(within(pop).getByText("สรุปงานประจำวันทางอีเมล")).toBeInTheDocument();
  });

  it("มือถือ: อยู่ในเมนู ☰ เปิดเป็นหน้าเต็มจอ มีปุ่มกลับ", async () => {
    const restore = asMobile();
    try {
      list({ items, unseen: 2 });
      shell();
      await userEvent.click(await screen.findByRole("button", { name: "เมนู" }));
      const item = await screen.findByRole("button", { name: /มีอะไรใหม่/ });
      expect(within(item).getByRole("img", { name: "มีอะไรใหม่ (มีรายการที่ยังไม่เห็น)" })).toBeInTheDocument();
      await userEvent.click(item);
      const full = await screen.findByRole("dialog", { name: "มีอะไรใหม่" });
      expect(within(full).getAllByRole("article")).toHaveLength(3);
      await userEvent.click(within(full).getByRole("button", { name: "กลับ" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "มีอะไรใหม่" })).not.toBeInTheDocument());
    } finally {
      restore();
    }
  });
});

describe("Spotlight (U2)", () => {
  const spotlight = item({ spotlight: true });
  function spot(data: WhatsNewItem | null) {
    const calls: string[] = [];
    server.use(
      http.get("*/api/v1/me/spotlight", () => HttpResponse.json({ item: data })),
      http.post("*/api/v1/me/spotlight/:id/dismiss", ({ params }) => (calls.push(`dismiss/${params.id}`), HttpResponse.json({ id: params.id, dismissed: true }))),
      http.post("*/api/v1/me/whats-new/:id/click", ({ params }) => (calls.push(`click/${params.id}`), HttpResponse.json({ id: params.id, clicked: true }))),
      http.get("*/api/v1/me/nps-prompt", () => (calls.push("nps-prompt"), HttpResponse.json({ ask: false, reason: "not_sampled" }))),
    );
    return calls;
  }

  it("แสดงหลังรอ · ข้อในรายละเอียดเป็นขั้น · ไว้ทีหลัง = เห็นแล้ว · ไม่ถาม NPS ในครั้งเดียวกัน", async () => {
    const calls = spot(spotlight);
    renderWithProviders(<EngagementPrompts ws="sample" role="owner" delayMs={10} />);
    const dlg = await screen.findByRole("dialog", { name: "ขอเลื่อน Due ผ่าน LINE ได้แล้ว" });
    expect(within(dlg).getByText("หัวหน้าทีมได้ข้อความพร้อมปุ่มอนุมัติ / ปฏิเสธ")).toBeInTheDocument();
    expect(within(dlg).getByText('แสดงครั้งเดียว · ดูอีกได้ในแผง "มีอะไรใหม่"')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ไว้ทีหลัง" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls).toEqual([`dismiss/${A}`]);
  });

  it("ปุ่มหลักพาไปหน้าที่ตั้งไว้ + นับคลิก · Esc ก็นับว่าเห็นแล้ว", async () => {
    const calls = spot(spotlight);
    renderWithProviders(<EngagementPrompts ws="sample" role="admin" delayMs={10} />);
    await userEvent.click(await screen.findByRole("button", { name: "ผูก LINE" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/work/sample/profile?tab=notify"));
    expect(calls).toEqual([`dismiss/${A}`, `click/${A}`]);
  });

  it("ไม่แสดงขณะพิมพ์หรือเปิด Drawer งาน · แสดงเมื่อว่างแล้ว", async () => {
    spot(spotlight);
    navigation.search = "issue=DE-12";
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      const view = renderWithProviders(<EngagementPrompts ws="sample" role="member" delayMs={10} />);
      await new Promise((r) => setTimeout(r, 80));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      view.unmount();
      navigation.search = "";
      input.focus();
      renderWithProviders(<EngagementPrompts ws="sample" role="member" delayMs={10} />);
      await new Promise((r) => setTimeout(r, 80));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      input.blur();
      expect(await screen.findByRole("dialog", { name: "ขอเลื่อน Due ผ่าน LINE ได้แล้ว" }, { timeout: 4000 })).toBeInTheDocument();
    } finally {
      input.remove();
    }
  });

  it("ไม่มี Spotlight → ไปถาม NPS ต่อ · Guest ไม่เรียกอะไรเลย", async () => {
    const calls = spot(null);
    renderWithProviders(<EngagementPrompts ws="sample" role="owner" delayMs={10} />);
    await waitFor(() => expect(calls).toEqual(["nps-prompt"]));
    const guestCalls = spot(spotlight);
    renderWithProviders(<EngagementPrompts ws="sample" role="guest" delayMs={10} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(guestCalls).toEqual([]);
  });
});
