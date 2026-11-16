// O42 · H16–H17 แจ้งเอกสารกฎหมายฉบับใหม่ในแอป · ข้อมูลสมมติ
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { WorkspaceBanners } from "@/features/plan-limits";
import sp from "../../../messages/th/saas-pages.json";
import { LegalNotices, summaryPoints } from "./LegalNotices";

const messages = { "saas-pages": sp };
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

function mockLegal(body: Record<string, unknown>, posts: unknown[] = []) {
  server.use(
    http.get("*/api/v1/me/legal-acceptances", () => HttpResponse.json(body as never)),
    http.post("*/api/v1/me/legal-acceptances", async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({ alreadyAccepted: false }, { status: 201 });
    }),
    // แบนเนอร์อื่นของ WorkspaceBanners
    http.get("*/api/v1/w/:ws/usage", () => HttpResponse.json({ error: { code: "forbidden", message: "-" } }, { status: 403 })),
  );
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom มี localStorage เสมอ */
  }
});

describe("แบนเนอร์ก่อนวันมีผล (H16)", () => {
  it("ผู้ใช้ทุกบทบาทเห็น · สรุปข้อแรกและจำนวนที่เหลือ · ปิดแล้วจำไว้ในเบราว์เซอร์", async () => {
    mockLegal({
      items: [],
      upcoming: [{ id: "next-terms", type: "terms", version: "2.2", effectiveAt: iso(30), summary: "เพิ่มข้อกำหนดการใช้ AI ช่วยสรุปงาน · ปรับระยะเก็บ Log ระบบเป็น 30 วัน", requiresAcceptance: true }],
    });
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<WorkspaceBanners ws="sample" role="guest" />, { messages });
    expect(await screen.findByText(/^ข้อกำหนดการใช้งานฉบับใหม่มีผล /)).toBeInTheDocument();
    expect(screen.getByText("เพิ่มข้อกำหนดการใช้ AI ช่วยสรุปงาน และอีก 1 เรื่อง")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดูสิ่งที่เปลี่ยน" })).toHaveAttribute("href", "/legal/terms");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ปิด" }));
    expect(screen.queryByText(/ฉบับใหม่มีผล/)).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<LegalNotices ws="sample" />, { messages });
    await waitFor(() => expect(screen.queryByText(/ฉบับใหม่มีผล/)).not.toBeInTheDocument());
  });
});

describe("ฉบับแจ้งให้ทราบ", () => {
  it("แสดงแบนเนอร์ถึง noticeUntil (14 วันหลังมีผล) ไม่มีปุ่มยอมรับ · พ้นแล้วไม่แสดง", async () => {
    mockLegal({
      items: [
        { id: "cookie-2", type: "cookie", version: "2.0", effectiveAt: iso(-3), noticeUntil: iso(11), summary: "เพิ่มคุกกี้วัดผลแบบไม่ระบุตัวตน", requiresAcceptance: false, accepted: false },
        { id: "privacy-old", type: "privacy", version: "1.4", effectiveAt: iso(-20), noticeUntil: iso(-6), summary: "แก้คำผิด", requiresAcceptance: false, accepted: false },
      ],
      upcoming: [],
    });
    renderWithProviders(<LegalNotices ws="sample" />, { messages });
    expect(await screen.findByText(/^นโยบายคุกกี้ฉบับใหม่มีผลแล้วตั้งแต่ /)).toBeInTheDocument();
    expect(screen.getByText("เพิ่มคุกกี้วัดผลแบบไม่ระบุตัวตน")).toBeInTheDocument();
    expect(screen.queryByText(/นโยบายความเป็นส่วนตัว/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ยอมรับและใช้งานต่อ" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("หน้าต่างยอมรับ (H17)", () => {
  it("สมาชิกทั่วไปก็ต้องยอมรับ · ปิดด้วย Esc ไม่ได้ · กดยอมรับบันทึกในนาม Workspace", async () => {
    const posts: unknown[] = [];
    let accepted = false;
    server.use(
      http.get("*/api/v1/me/legal-acceptances", () =>
        HttpResponse.json({ items: [{ id: "terms-22", type: "terms", version: "2.2", effectiveAt: iso(0), summary: "เพิ่มข้อกำหนดการใช้ AI ช่วยสรุปงาน\nปรับระยะเก็บ Log ระบบเป็น 30 วัน", requiresAcceptance: true, accepted, noticeUntil: null }], upcoming: [] }),
      ),
      http.post("*/api/v1/me/legal-acceptances", async ({ request }) => {
        posts.push(await request.json());
        accepted = true;
        return HttpResponse.json({ alreadyAccepted: false }, { status: 201 });
      }),
      http.get("*/api/v1/w/:ws/usage", () => HttpResponse.json({ error: { code: "forbidden", message: "-" } }, { status: 403 })),
    );
    const user = userEvent.setup();
    renderWithProviders(<WorkspaceBanners ws="sample" role="member" />, { messages });
    const dialog = await screen.findByRole("dialog", { name: "ยอมรับข้อกำหนดการใช้งานฉบับ 2.2" });
    expect(dialog).toHaveTextContent(/มีผลแล้ววันนี้/);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["เพิ่มข้อกำหนดการใช้ AI ช่วยสรุปงาน", "ปรับระยะเก็บ Log ระบบเป็น 30 วัน"]);
    expect(screen.getByText("ไม่ยอมรับ: ติดต่อ Owner ของ Workspace หรือยกเลิกบัญชีได้ที่โปรไฟล์")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ยอมรับและใช้งานต่อ" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posts).toEqual([{ documentId: "terms-22", workspace: "sample" }]);
  });

  it("แยกสรุปเป็นรายข้อ", () => {
    expect(summaryPoints("ก · ข\nค")).toEqual(["ก", "ข", "ค"]);
    expect(summaryPoints(null)).toEqual([]);
  });
});
