import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { annId, announcements, flagId, flags, workspaceRows, wsA, wsB } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { OPS, opsError, server } from "@/test/server";
import { Shell } from "../shell/Shell";
import { FlagsPage } from "./Flags";

const calls: { method: string; path: string; body?: unknown }[] = [];
function handlers(opts: { flags?: typeof flags; announcements?: typeof announcements } = {}) {
  calls.length = 0;
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined });
  };
  server.use(
    http.get(`${OPS}/feature-flags`, () => HttpResponse.json({ items: opts.flags ?? flags })),
    http.get(`${OPS}/announcements`, () => HttpResponse.json({ items: opts.announcements ?? announcements })),
    http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: workspaceRows })),
    http.all(`${OPS}/feature-flags*`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({});
    }),
    http.all(`${OPS}/announcements*`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({});
    }),
  );
}
const view = () => {
  navigation.pathname = "/flags";
  return renderWithProviders(
    <Shell>
      <FlagsPage />
    </Shell>,
  );
};

describe("Feature flags", () => {
  it("รายการ flag พร้อมสถานะการเปิด", async () => {
    handlers();
    view();
    expect(await screen.findByText("automation_v2")).toBeInTheDocument();
    expect(screen.getByText("1 Workspace")).toBeInTheDocument();
    expect(screen.getByText("ทุกคน")).toBeInTheDocument();
  });

  it("สร้าง flag ส่ง key, description, defaultOn · error ของ ops-api แสดงใน Dialog", async () => {
    handlers();
    server.use(http.post(`${OPS}/feature-flags`, () => opsError(400, "validation_failed", "ข้อมูลไม่ถูกต้อง", [{ path: "key", message: "key ใช้ตัวพิมพ์เล็ก" }])));
    view();
    await userEvent.click(await screen.findByRole("button", { name: "สร้าง flag" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Key"), "Bad Key");
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    expect(await within(dialog).findByText("ข้อมูลไม่ถูกต้อง")).toBeInTheDocument();

    let body: unknown;
    server.use(
      http.post(`${OPS}/feature-flags`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    await userEvent.clear(within(dialog).getByLabelText("Key"));
    await userEvent.type(within(dialog).getByLabelText("Key"), "gantt_critical_path");
    await userEvent.type(within(dialog).getByLabelText("คำอธิบาย"), "เส้นทางวิกฤต");
    await userEvent.click(within(dialog).getByLabelText("เปิดให้ทุก Workspace โดยค่าเริ่มต้น"));
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(body).toEqual({ key: "gantt_critical_path", description: "เส้นทางวิกฤต", defaultOn: true }));
    expect(await screen.findByText("สร้าง flag แล้ว")).toBeInTheDocument();
  });

  it("แก้ไข flag: PATCH, เพิ่ม / ลบ override ราย Workspace และลบ flag (กดยืนยัน 2 ครั้ง)", async () => {
    handlers();
    view();
    await userEvent.click(await screen.findByRole("button", { name: "แก้ไข automation_v2" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "ลบการกำหนด ทีมตัวอย่าง" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: `/ops-api/feature-flags/${flagId}/overrides/${wsA}`, body: undefined }));

    await within(dialog).findByRole("option", { name: "ทีมทดลอง (trial-team)" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Workspace"), wsB);
    await userEvent.selectOptions(within(dialog).getByLabelText("ค่า"), "false");
    await userEvent.click(within(dialog).getByRole("button", { name: "เพิ่มการกำหนด" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", path: `/ops-api/feature-flags/${flagId}/overrides/${wsB}`, body: { enabled: false } }));

    await userEvent.clear(within(dialog).getByLabelText("คำอธิบาย"));
    await userEvent.type(within(dialog).getByLabelText("คำอธิบาย"), "ตัวสร้างกฎ v2");
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "PATCH", path: `/ops-api/feature-flags/${flagId}`, body: { key: "automation_v2", description: "ตัวสร้างกฎ v2", defaultOn: false } }));

    await userEvent.click(await screen.findByRole("button", { name: "แก้ไข automation_v2" }));
    const again = await screen.findByRole("dialog");
    await userEvent.click(within(again).getByRole("button", { name: "ลบ flag" }));
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/ops-api/feature-flags/${flagId}`)).toBe(false);
    await userEvent.click(within(again).getByRole("button", { name: "ยืนยันลบ flag" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: `/ops-api/feature-flags/${flagId}`, body: undefined }));
  });

  it("ไม่มี flag / ประกาศ: สถานะว่าง", async () => {
    handlers({ flags: [], announcements: [] });
    view();
    expect(await screen.findByText("ยังไม่มี flag")).toBeInTheDocument();
    expect(await screen.findByText("ยังไม่มีประกาศ")).toBeInTheDocument();
  });

  it("Error ของรายการ flag พร้อมรหัสอ้างอิง", async () => {
    handlers();
    server.use(http.get(`${OPS}/feature-flags`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req-flags")));
    view();
    expect(await screen.findByText("รหัสอ้างอิง: req-flags")).toBeInTheDocument();
  });
});

describe("ประกาศถึงลูกค้า", () => {
  it("สร้างประกาศ (ตั้งเวลา) ส่ง message, audience, channels, scheduledAt", async () => {
    handlers();
    view();
    const message = await screen.findByLabelText("ข้อความ");
    await userEvent.click(screen.getByRole("button", { name: "บันทึกร่าง" }));
    expect(screen.getByText("กรอกข้อความประกาศ")).toBeInTheDocument();
    await userEvent.type(message, "ปิดปรับปรุงระบบชั่วคราว");
    await userEvent.selectOptions(screen.getByLabelText("ส่งถึง"), "owners_admins");
    await userEvent.selectOptions(screen.getByLabelText("ช่องทาง"), "email");
    await userEvent.type(screen.getByLabelText("เวลาส่ง (เว้นว่าง = ร่าง)"), "2026-11-14T02:00");
    await userEvent.click(screen.getByRole("button", { name: "ตั้งเวลาส่ง" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/ops-api/announcements")?.body).toEqual({ message: "ปิดปรับปรุงระบบชั่วคราว", audience: "owners_admins", channels: ["email"], scheduledAt: new Date("2026-11-14T02:00").toISOString() }));
    expect(await screen.findByText("บันทึกประกาศแล้ว")).toBeInTheDocument();
  });

  it("ประกาศที่ยังไม่ส่ง: ส่งทันที / แก้ไข / ลบ · ที่ส่งแล้วแก้ไม่ได้", async () => {
    handlers();
    view();
    expect(await screen.findByText("ปิดปรับปรุงระบบตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByText(/^ส่งแล้ว /)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "ส่งทันที" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "ส่งทันที" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: `/ops-api/announcements/${annId}/publish`, body: {} }));

    await userEvent.click(screen.getByRole("button", { name: "แก้ไข" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("ข้อความ");
    expect(input).toHaveValue("ปิดปรับปรุงระบบตัวอย่าง");
    await userEvent.type(input, " (เลื่อน)");
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "PATCH", path: `/ops-api/announcements/${annId}`, body: { message: "ปิดปรับปรุงระบบตัวอย่าง (เลื่อน)", audience: "all", channels: ["banner", "email"], scheduledAt: null } }));

    await userEvent.click(screen.getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", path: `/ops-api/announcements/${annId}`, body: undefined }));
  });
});
