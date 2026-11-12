// W24 · แบบสำรวจ NPS ในแอป (U3): การ์ดมุมขวาล่าง 3 ขั้น · Bottom sheet บนมือถือ · ปิดโดยไม่ตอบ · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { EngagementPrompts } from "@/features/whats-new";
import { renderWithProviders } from "@/test/render";
import { asMobile } from "@/test/mobile";
import { server } from "@/test/server";
import { type NpsAsk, NpsPrompt } from "./NpsPrompt";

const prompt: NpsAsk = {
  ask: true,
  question: "คุณจะแนะนำ Friday Manage ให้เพื่อนหรือเพื่อนร่วมงานไหม",
  questionEn: "How likely are you to recommend Friday Manage to a friend or colleague?",
  followUps: { detractor: "อะไรที่เราควรปรับให้ดีขึ้นที่สุด", passive: "อะไรที่จะทำให้ให้ 10 คะแนน", promoter: "ชอบอะไรที่สุด" },
  followUpsEn: null,
  topics: ["speed", "usability", "missing_feature", "price", "mobile"],
  excludeShortMobile: true,
};
function api(over: { fail?: boolean } = {}) {
  const calls: { path: string; body: unknown }[] = [];
  server.use(
    http.post("*/api/v1/me/nps", async ({ request }) => {
      calls.push({ path: "nps", body: await request.json() });
      return over.fail ? HttpResponse.json({ error: { code: "internal_error", message: "ผิดพลาด" } }, { status: 500 }) : HttpResponse.json({ id: "n-1", score: 3, group: "detractor" }, { status: 201 });
    }),
    http.post("*/api/v1/me/nps/dismiss", async ({ request }) => (calls.push({ path: "dismiss", body: await request.json() }), HttpResponse.json({ dismissed: true }))),
  );
  return calls;
}

describe("แบบสำรวจ NPS (U3)", () => {
  it("การ์ดมุมขวาล่าง ไม่มีพื้นหลังมืด · 0–10 · ปิดก่อนให้คะแนน = ปิดโดยไม่ตอบ", async () => {
    const calls = api();
    const onClose = vi.fn();
    renderWithProviders(<NpsPrompt ws="sample" prompt={prompt} onClose={onClose} />);
    const card = screen.getByRole("dialog", { name: "แบบสำรวจความพึงพอใจ" });
    expect(card).toHaveAttribute("aria-modal", "false");
    expect(within(card).getByText(prompt.question)).toBeInTheDocument();
    expect(within(card).getAllByRole("button", { name: /คะแนน$/ })).toHaveLength(11);
    expect(within(card).getByText("ไม่แนะนำเลย")).toBeInTheDocument();
    expect(within(card).getByText("แนะนำแน่นอน")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "ปิดแบบสำรวจ" }));
    await waitFor(() => expect(calls).toEqual([{ path: "dismiss", body: { workspace: "sample" } }]));
    expect(onClose).toHaveBeenCalled();
  });

  it("คะแนน 0–6 → คำถามต่อของกลุ่มไม่พอใจ · เลือกหัวข้อ + ความเห็น → ส่ง → ขอบคุณ", async () => {
    const calls = api();
    const onClose = vi.fn();
    renderWithProviders(<NpsPrompt ws="sample" prompt={prompt} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "3 คะแนน" }));
    const card = screen.getByRole("dialog", { name: "แบบสำรวจความพึงพอใจ" });
    expect(within(card).getByText("ขอบคุณครับ อะไรที่เราควรปรับให้ดีขึ้นที่สุด")).toBeInTheDocument();
    expect(within(card).getByText("ไม่ต้องใส่ชื่อ · ทีมงานเห็นคะแนนพร้อมชื่อ Workspace")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "ความเร็ว" }));
    expect(within(card).getByRole("button", { name: "ความเร็ว" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(within(card).getByLabelText("ความเห็น (ไม่บังคับ)"), "Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน");
    await userEvent.click(within(card).getByRole("button", { name: "ส่ง" }));
    await waitFor(() => expect(calls).toEqual([{ path: "nps", body: { workspace: "sample", score: 3, comment: "Gantt ช้ามากเมื่อโปรเจกต์มีงานเกิน 500 งาน", topics: ["speed"] } }]));
    expect(await within(card).findByText("ขอบคุณสำหรับความเห็น")).toBeInTheDocument();
    expect(within(card).getByText("ทีมอ่านทุกความเห็น ถ้าอยากให้ติดต่อกลับเรื่องนี้")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "ปิด" }));
    expect(onClose).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("คะแนน 9–10 → คำถามของกลุ่มแนะนำต่อ · ปิดหลังให้คะแนน = ส่งคะแนนอย่างเดียว", async () => {
    const calls = api();
    renderWithProviders(<NpsPrompt ws="sample" prompt={prompt} onClose={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "9 คะแนน" }));
    expect(screen.getByText("ขอบคุณครับ ชอบอะไรที่สุด")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ปิดแบบสำรวจ" }));
    await waitFor(() => expect(calls).toEqual([{ path: "nps", body: { workspace: "sample", score: 9 } }]));
  });

  it("คะแนน 7–8 → คำถามของกลุ่มเฉย ๆ · ส่งไม่สำเร็จแจ้งสั้น ๆ และยังอยู่ขั้นเดิม", async () => {
    api({ fail: true });
    renderWithProviders(<NpsPrompt ws="sample" prompt={prompt} onClose={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "7 คะแนน" }));
    expect(screen.getByText("ขอบคุณครับ อะไรที่จะทำให้ให้ 10 คะแนน")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ส่งคำตอบไม่สำเร็จ ลองอีกครั้ง");
    expect(screen.getByRole("button", { name: "ส่ง" })).toBeInTheDocument();
  });

  it("มือถือ: Bottom sheet พร้อมพื้นหลังมืด · ปุ่ม 6 คอลัมน์ · ไม่ตอบตอนนี้ = ปิดโดยไม่ตอบ", async () => {
    const restore = asMobile();
    try {
      const calls = api();
      renderWithProviders(<NpsPrompt ws="sample" prompt={prompt} onClose={() => undefined} />);
      const sheet = screen.getByRole("dialog", { name: "แบบสำรวจความพึงพอใจ" });
      expect(sheet.className).toMatch(/sheet/);
      expect(within(sheet).getByText("0 = ไม่แนะนำเลย")).toBeInTheDocument();
      expect(within(sheet).getByText("10 = แนะนำแน่นอน")).toBeInTheDocument();
      expect(within(sheet).getByRole("group", { name: prompt.question }).className).toMatch(/scoresGrid/);
      await userEvent.click(within(sheet).getByRole("button", { name: "ไม่ตอบตอนนี้" }));
      await waitFor(() => expect(calls).toEqual([{ path: "dismiss", body: { workspace: "sample" } }]));
    } finally {
      restore();
    }
  });

  it("ภาษาอังกฤษ: ใช้คำถามฉบับอังกฤษเมื่อมี · คำถามต่อที่ยังไม่แปลใช้ฉบับไทย", async () => {
    api();
    renderWithProviders(<NpsPrompt ws="sample" prompt={prompt} onClose={() => undefined} />, { locale: "en" });
    expect(screen.getByText(prompt.questionEn!)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "2 points" }));
    expect(screen.getByText("Thank you. อะไรที่เราควรปรับให้ดีขึ้นที่สุด")).toBeInTheDocument();
  });
});

describe("ตัวจัดคิว (EngagementPrompts)", () => {
  it("ไม่มี Spotlight → ถาม NPS (ส่งว่าเป็นมือถือและใช้งานมากี่วินาที) → แสดงการ์ด", async () => {
    const restore = asMobile();
    const queries: string[] = [];
    try {
      server.use(http.get("*/api/v1/me/nps-prompt", ({ request }) => (queries.push(new URL(request.url).search), HttpResponse.json(prompt))));
      renderWithProviders(<EngagementPrompts ws="sample" role="owner" delayMs={10} />);
      expect(await screen.findByRole("dialog", { name: "แบบสำรวจความพึงพอใจ" })).toBeInTheDocument();
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatch(/^\?workspace=sample&mobile=true&sessionSeconds=\d+$/);
    } finally {
      restore();
    }
  });

  it("ไม่ถาม → ไม่มีอะไรแสดง · จอใหญ่ไม่ส่งค่ามือถือ", async () => {
    const queries: string[] = [];
    server.use(http.get("*/api/v1/me/nps-prompt", ({ request }) => (queries.push(new URL(request.url).search), HttpResponse.json({ ask: false, reason: "answered_recently" }))));
    renderWithProviders(<EngagementPrompts ws="sample" role="member" delayMs={10} />);
    await waitFor(() => expect(queries).toEqual(["?workspace=sample"]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
