// O24 · แบนเนอร์ประกาศจากทีม Friday ใน shell: Owner / Admin เห็น · ปิดได้ต่อคน · สมาชิกไม่เรียก API · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { server } from "@/test/server";

const A = "60000000-0000-4000-8000-0000000000a1";
const B = "60000000-0000-4000-8000-0000000000b2";
const long = `ลูกค้าที่จ่ายรายปีอยู่แล้วใช้ราคาเดิมจนครบสัญญา ${"รายละเอียดเพิ่มเติมของประกาศ ".repeat(8)}ท้ายข้อความ`;
const items = [
  { id: A, title: "ราคารายปีใหม่ เริ่ม 1 ม.ค. 2570", message: long, sentAt: "2026-11-12T03:00:00.000Z" },
  { id: B, title: "ปิดปรับปรุงคืนวันเสาร์", message: "22:00–23:00 น.", sentAt: "2026-11-11T03:00:00.000Z" },
];

const shell = (ws = "sample") =>
  renderWithProviders(
    <WorkspaceShell ws={ws}>
      <p>เนื้อหาหน้า</p>
    </WorkspaceShell>,
  );

afterEach(() => {
  navigation.pathname = "/work/sample";
});

describe("แบนเนอร์ประกาศจากทีม Friday", () => {
  it("Owner เห็นทุกประกาศ ล่าสุดก่อน · ข้อความยาวย่อไว้ กดอ่านต่อได้", async () => {
    server.use(http.get("*/api/v1/w/:ws/announcements", () => HttpResponse.json({ items })));
    shell();
    const region = await screen.findByRole("region", { name: "ประกาศจากทีม Friday" });
    const banners = within(region).getAllByRole("status");
    expect(banners).toHaveLength(2);
    expect(within(banners[0]).getByText("ราคารายปีใหม่ เริ่ม 1 ม.ค. 2570")).toBeInTheDocument();
    expect(within(banners[0]).queryByText(/ท้ายข้อความ/)).not.toBeInTheDocument();
    await userEvent.click(within(banners[0]).getByRole("button", { name: "อ่านต่อ" }));
    expect(within(banners[0]).getByText(/ท้ายข้อความ/)).toBeInTheDocument();
    expect(within(banners[0]).getByRole("button", { name: "ย่อ" })).toHaveAttribute("aria-expanded", "true");
    expect(within(banners[1]).getByText("22:00–23:00 น.")).toBeInTheDocument();
    expect(within(banners[1]).queryByRole("button", { name: "อ่านต่อ" })).not.toBeInTheDocument();
    expect(screen.getByText("เนื้อหาหน้า")).toBeInTheDocument();
  });

  it("กดปิด → เรียก dismiss ของประกาศนั้นและซ่อนทันที · ที่เหลือยังแสดง", async () => {
    const dismissed: string[] = [];
    server.use(
      http.get("*/api/v1/w/:ws/announcements", () => HttpResponse.json({ items })),
      http.post("*/api/v1/w/:ws/announcements/:id/dismiss", ({ params }) => (dismissed.push(`${params.ws}/${params.id}`), HttpResponse.json({ id: params.id, dismissed: true }))),
    );
    shell();
    await userEvent.click(await screen.findByRole("button", { name: "ปิดประกาศ ปิดปรับปรุงคืนวันเสาร์" }));
    await waitFor(() => expect(screen.queryByText("ปิดปรับปรุงคืนวันเสาร์")).not.toBeInTheDocument());
    expect(dismissed).toEqual([`sample/${B}`]);
    expect(screen.getByText("ราคารายปีใหม่ เริ่ม 1 ม.ค. 2570")).toBeInTheDocument();
  });

  it("ปิดไม่สำเร็จ → แบนเนอร์กลับมาพร้อมแจ้งเตือน", async () => {
    server.use(
      http.get("*/api/v1/w/:ws/announcements", () => HttpResponse.json({ items: [items[1]] })),
      http.post("*/api/v1/w/:ws/announcements/:id/dismiss", () => HttpResponse.json({ error: { code: "internal", message: "ผิดพลาด" } }, { status: 500 })),
    );
    shell();
    await userEvent.click(await screen.findByRole("button", { name: "ปิดประกาศ ปิดปรับปรุงคืนวันเสาร์" }));
    expect(await screen.findByText("ปิดประกาศไม่สำเร็จ ลองอีกครั้ง")).toBeInTheDocument();
    expect(await screen.findByText("ปิดปรับปรุงคืนวันเสาร์")).toBeInTheDocument();
  });

  it("สมาชิกธรรมดาไม่เรียก API และไม่เห็นแบนเนอร์", async () => {
    let called = 0;
    server.use(http.get("*/api/v1/w/:ws/announcements", () => (called++, HttpResponse.json({ items }))));
    navigation.pathname = "/work/other";
    shell("other");
    expect(await screen.findByText("เนื้อหาหน้า")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(0);
    expect(screen.queryByRole("region", { name: "ประกาศจากทีม Friday" })).not.toBeInTheDocument();
  });

  it("ภาษาอังกฤษ: ป้ายและปุ่มปิดแปลแล้ว (เนื้อหาประกาศคงตามที่ทีม Friday เขียน)", async () => {
    server.use(http.get("*/api/v1/w/:ws/announcements", () => HttpResponse.json({ items: [items[1]] })));
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>content</p>
      </WorkspaceShell>,
      { locale: "en" },
    );
    expect(await screen.findByRole("button", { name: "Dismiss announcement ปิดปรับปรุงคืนวันเสาร์" })).toBeInTheDocument();
    expect(screen.getByText("From the Friday team")).toBeInTheDocument();
  });
});
