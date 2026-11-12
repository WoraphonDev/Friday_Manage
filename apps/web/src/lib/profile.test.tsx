// W17 · Profile (I): ข้อมูลส่วนตัว, ตารางแจ้งเตือน, LINE, เวลาทำงาน / วันลา, iCal, 2FA, Session · ข้อมูลสมมติเท่านั้น
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { me as baseMe, workspaces } from "@/test/fixtures";
import { today } from "@/lib/format";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import json from "../../messages/th/profile.json";
import { ProfilePage } from "../../app/work/[ws]/profile/_components/profile-page";
import { squareAvatar } from "../../app/work/[ws]/profile/_components/avatar-image";
import { profileChanges } from "../../app/work/[ws]/profile/_components/personal-tab";
import { hoursChanges } from "../../app/work/[ws]/profile/_components/hours-tab";
import { deviceLabel } from "../../app/work/[ws]/profile/_components/security-tab";
import type { Membership, NotifySettings, PrefRow } from "../../app/work/[ws]/profile/_components/types";

// jsdom ไม่มี canvas / createImageBitmap · ทดสอบการย่อรูปแยก (ทำในเบราว์เซอร์จริง)
vi.mock("../../app/work/[ws]/profile/_components/avatar-image", async (orig) => ({ ...(await orig<object>()), squareAvatar: vi.fn() }));
const squareAvatarMock = vi.mocked(squareAvatar);
const me = { ...baseMe, emailVerified: true, firstName: "สมมติ", lastName: "ทดสอบ", phone: null, about: null, avatarUrl: null };
const membership = (over: Partial<Membership> = {}): Membership => ({
  role: "owner", jobTitle: "Project Manager", department: "Delivery", capacityHoursWeek: 40, workStart: "09:00", workEnd: "18:00", workDays: [1, 2, 3, 4, 5],
  effective: { workStart: "09:00", workEnd: "18:00", workDays: [1, 2, 3, 4, 5] }, ...over,
});
const cell = (enabled: boolean, locked = false) => ({ enabled, locked, custom: false });
const rows: PrefRow[] = [
  { eventType: "issue.assigned", group: "assigned", label: "ถูกมอบหมายงาน หรือถูกถอดออกจากงาน", hint: null, channels: { in_app: cell(true, true), email: cell(true), line: cell(true) } },
  { eventType: "issue.commented", group: "activity", label: "คอมเมนต์ใหม่ในงานที่ฉันเป็น Assignee / Watcher", hint: null, channels: { in_app: cell(true), email: cell(false), line: cell(false) } },
  { eventType: "digest.daily", group: "schedule", label: "สรุปงานประจำวัน 08:30", hint: "ใกล้ครบกำหนด · ครบกำหนดวันนี้ · เลยกำหนด · รอ Review · งานเลยกำหนดของทีม (PM) รวมเป็นฉบับเดียวต่อวัน", channels: { in_app: cell(true, true), email: cell(true), line: cell(true) } },
];
const settings = (over: Partial<NotifySettings> = {}): NotifySettings => ({ workspace: "sample", dueReminder: "1d_and_today", digest: "workdays", quietStart: "20:00", quietEnd: "08:00", quietOnHolidays: true, autoWatch: true, custom: false, ...over });
const leaves = [
  { id: "lv-1", leaveType: "vacation", startDate: "2026-12-24", endDate: "2026-12-25", halfDay: null, status: "approved", source: "manual", createdAt: "2026-11-01T00:00:00Z" },
  { id: "lv-2", leaveType: "personal", startDate: "2026-11-12", endDate: "2026-11-12", halfDay: "pm", status: "pending", source: "manual", createdAt: "2026-11-02T00:00:00Z" },
  { id: "lv-3", leaveType: "sick", startDate: "2026-10-01", endDate: "2026-10-01", halfDay: null, status: "approved", source: "hr", createdAt: "2026-10-01T00:00:00Z" },
];
const sessions = [
  { id: "s-1", deviceName: null, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", ip: null, location: "กรุงเทพฯ", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: new Date().toISOString(), current: true },
  { id: "s-2", deviceName: "Friday Manage app · iPhone", userAgent: null, ip: null, location: null, createdAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-11-05T00:00:00Z", current: false },
];

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let line: { linked: boolean; displayName: string | null; boundAt: string | null };
let mfa: { enabled: boolean; enabledAt: string | null; backupCodesLeft: number; setupPending: boolean; requiredByPolicy: boolean };
const record = async (request: Request) => {
  const text = await request.text();
  calls.push({ method: request.method, path: new URL(request.url).pathname.replace("/api/v1", ""), body: text ? JSON.parse(text) : undefined });
};
const ok = (body: object | undefined = { ok: true }, status = 200) => async ({ request }: { request: Request }) => {
  await record(request);
  return status === 204 ? new HttpResponse(null, { status }) : HttpResponse.json(body as Record<string, unknown>, { status });
};
const fail = (status: number, code = status === 403 ? "forbidden" : "internal_error") => HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", requestId: "req_w17_001", details: {} } }, { status });
const W = "*/api/v1/w/:ws";

beforeEach(() => {
  calls = [];
  line = { linked: false, displayName: null, boundAt: null };
  mfa = { enabled: false, enabledAt: null, backupCodesLeft: 0, setupPending: false, requiredByPolicy: false };
  navigation.pathname = "/work/sample/profile";
  server.use(
    http.get("*/api/v1/me", () => HttpResponse.json(me)),
    http.patch("*/api/v1/me", async ({ request }) => {
      await record(request);
      return HttpResponse.json({ ...me, ...(calls.at(-1)!.body as object) });
    }),
    http.get(`${W}/me/membership`, () => HttpResponse.json(membership())),
    http.patch(`${W}/me/membership`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(membership(calls.at(-1)!.body as Partial<Membership>));
    }),
    http.get(`${W}/my-issues`, () => HttpResponse.json({ counts: { assigned: 12 }, groups: [{ key: "late", count: 2 }, { key: "today", count: 1 }] })),
    http.get(`${W}/leaves`, () => HttpResponse.json({ items: leaves })),
    http.post(`${W}/leaves`, ok({ id: "lv-new" }, 201)),
    http.delete(`${W}/leaves/:id`, ok({ deleted: true })),
    http.get("*/api/v1/me/line", () => HttpResponse.json(line)),
    http.post("*/api/v1/me/line/link-code", ok({ code: "482913", expiresAt: new Date(Date.now() + 600_000).toISOString(), expiresInSeconds: 600 })),
    http.post("*/api/v1/me/line/test", ok({ sent: true })),
    http.delete("*/api/v1/me/line", ok({ unlinked: true })),
    http.get("*/api/v1/me/notification-prefs", () => HttpResponse.json({ workspace: "sample", channels: ["in_app", "email", "line"], rows })),
    http.put("*/api/v1/me/notification-prefs", ok({ workspace: "sample", channels: ["in_app", "email", "line"], rows })),
    http.get("*/api/v1/me/notification-settings", () => HttpResponse.json(settings())),
    http.put("*/api/v1/me/notification-settings", ok(settings({ custom: true }))),
    http.get("*/api/v1/me/calendar-feeds", () => HttpResponse.json({ items: [{ id: "f-1", projectKey: null, createdAt: "2026-11-01T00:00:00Z" }] })),
    http.post("*/api/v1/me/calendar-feeds", ok({ id: "f-2", projectKey: "DE", createdAt: "2026-11-06T00:00:00Z", url: "https://api.example.com/api/v1/ical/sample-token.ics" }, 201)),
    http.delete("*/api/v1/me/calendar-feeds/:id", ok({ revoked: true })),
    http.get("*/api/v1/me/identities", () => HttpResponse.json({ items: [{ id: "i-1", provider: "password", createdAt: "2026-01-01T00:00:00Z", passwordChangedAt: "2026-08-01T00:00:00Z", canDelete: true }, { id: "i-2", provider: "google", createdAt: "2026-02-01T00:00:00Z", canDelete: true }] })),
    http.delete("*/api/v1/me/identities/:id", ok(undefined, 204)),
    http.get("*/api/v1/me/mfa", () => HttpResponse.json(mfa)),
    http.get("*/api/v1/me/sessions", () => HttpResponse.json({ items: sessions })),
    http.delete("*/api/v1/me/sessions/:id", ok(undefined, 204)),
    http.delete("*/api/v1/me/sessions", ok({ revoked: 1 })),
    // path ที่มี ":" (Nest custom method) ใช้ RegExp เพราะ MSW อ่าน ":" เป็นพารามิเตอร์
    http.post(/\/api\/v1\/me\/password:change$/, ok({ ok: true, loggedOutSessions: 1 })),
    http.post(/\/api\/v1\/me\/email:change$/, ok({ pendingEmail: "new@example.com", retryAfter: 60 }, 202)),
    http.post(/\/api\/v1\/me\/email:confirm$/, ok({ emailVerified: true })),
    http.post(/\/api\/v1\/me\/mfa:setup$/, ok({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Friday%20Manage:lead%40example.com?secret=JBSWY3DPEHPK3PXP" })),
    http.post(/\/api\/v1\/me\/mfa:enable$/, async ({ request }) => {
      await record(request);
      mfa = { ...mfa, enabled: true, backupCodesLeft: 2 };
      return HttpResponse.json({ enabled: true, backupCodes: ["AAAA-1111", "BBBB-2222"] });
    }),
    http.post(/\/api\/v1\/me\/mfa:disable$/, ok({ enabled: false })),
    http.post(/\/api\/v1\/me\/mfa\/backup-codes:regenerate$/, ok({ backupCodes: ["CCCC-3333", "DDDD-4444"] })),
  );
});
afterEach(() => vi.useRealTimers());

const mount = (tab?: string) => {
  navigation.search = tab ? `tab=${tab}` : "";
  return renderWithProviders(<WorkspaceShell ws="sample"><ProfilePage ws="sample" /></WorkspaceShell>, { messages: { profile: json } });
};
const summary = () => screen.findByRole("complementary", { name: "สรุปโปรไฟล์" });

describe("Profile (I)", () => {
  it("การ์ดสรุป: ชื่อ, ตำแหน่ง, LINE, เวลาทำงาน, Capacity, โปรเจกต์, งานที่เปิด / เลยกำหนด · เปิดที่แท็บการแจ้งเตือน", async () => {
    mount();
    const card = await summary();
    expect(within(card).getByText("หัวหน้าทีมตัวอย่าง")).toBeInTheDocument();
    expect(await within(card).findByText("สมมติ ทดสอบ · Project Manager")).toBeInTheDocument();
    expect(within(card).getByText("lead@example.com ✓")).toBeInTheDocument();
    expect(within(card).getByText("จ.–ศ. 09:00–18:00")).toBeInTheDocument();
    expect(within(card).getByText("40 ชม./สัปดาห์")).toBeInTheDocument();
    expect(await within(card).findByText("ยังไม่เชื่อม")).toBeInTheDocument();
    expect(within(card).getByText("แผนพัฒนาผลิตภัณฑ์")).toBeInTheDocument();
    expect(await within(card).findByText("12")).toBeInTheDocument();
    expect(within(card).getByText("2")).toBeInTheDocument();
    expect(within(card).getByText(/ทำงานอยู่/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "การแจ้งเตือน" })).toHaveAttribute("aria-selected", "true");
  });

  it("เปลี่ยนรูป: เลือกไฟล์จากเครื่อง → ย่อเป็นสี่เหลี่ยม → PUT /me/avatar · ไม่ใช่รูปบอกข้อผิดพลาด · ลบรูป", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const small = new Blob(["webp-bytes"], { type: "image/webp" });
    squareAvatarMock.mockResolvedValue(small);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:avatar-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const uploads: { type: string | null; size: number }[] = [];
    let deleted = 0;
    server.use(
      http.put("*/api/v1/me/avatar", async ({ request }) => {
        uploads.push({ type: request.headers.get("content-type"), size: (await request.arrayBuffer()).byteLength });
        return HttpResponse.json({ avatarUrl: "/api/v1/avatars/u-sample/v2" });
      }),
      http.delete("*/api/v1/me/avatar", () => { deleted++; return HttpResponse.json({ avatarUrl: null }); }),
    );
    mount();
    await user.click(await screen.findByRole("button", { name: "เปลี่ยนรูป" }));
    let dialog = await screen.findByRole("dialog", { name: "เปลี่ยนรูปโปรไฟล์" });
    expect(within(dialog).queryByLabelText("ลิงก์รูปภาพ")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await user.upload(within(dialog).getByLabelText("เลือกรูปจากเครื่อง"), new File(["not an image"], "note.txt", { type: "text/plain" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("ไฟล์นี้ไม่ใช่รูปภาพ");
    const photo = new File([new Uint8Array(2048)], "me.jpg", { type: "image/jpeg" });
    await user.upload(within(dialog).getByLabelText("เลือกรูปจากเครื่อง"), photo);
    expect(squareAvatarMock).toHaveBeenCalledWith(photo);
    expect(await within(dialog).findByRole("img", { name: "ตัวอย่างรูปโปรไฟล์" })).toHaveAttribute("src", "blob:avatar-preview");
    // หลังบันทึก หน้าเว็บโหลด me ใหม่ ซึ่งมีรูปแล้ว
    server.use(http.get("*/api/v1/me", () => HttpResponse.json({ ...me, avatarUrl: "/api/v1/avatars/u-sample/v2" })));
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(uploads).toEqual([{ type: "image/webp", size: small.size }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // มีรูปแล้วลบได้
    await user.click(screen.getByRole("button", { name: "เปลี่ยนรูป" }));
    dialog = await screen.findByRole("dialog", { name: "เปลี่ยนรูปโปรไฟล์" });
    await user.click(await within(dialog).findByRole("button", { name: "ลบรูป" }));
    await waitFor(() => expect(deleted).toBe(1));
  });

  it("ตารางแจ้งเตือน: In-app ที่ล็อกปิดไม่ได้ · บันทึกส่งทั้งเมทริกซ์ + ค่าตั้ง · คืนค่าเริ่มต้น", async () => {
    const user = userEvent.setup();
    mount("notify");
    const locked = await screen.findByRole("checkbox", { name: "ถูกมอบหมายงาน หรือถูกถอดออกจากงาน ผ่าน In-app" });
    expect(locked).toBeChecked();
    expect(locked).toBeDisabled();
    expect(screen.getByText("งานที่มอบหมายให้ฉัน")).toBeInTheDocument();
    expect(screen.getByText("ใกล้ครบกำหนด · ครบกำหนดวันนี้ · เลยกำหนด · รอ Review · งานเลยกำหนดของทีม (PM) รวมเป็นฉบับเดียวต่อวัน")).toBeInTheDocument();
    // สรุปประจำวันปิดไม่ได้แล้ว (ปิดเฉพาะ Email / LINE)
    expect(screen.getByRole("checkbox", { name: "สรุปงานประจำวัน 08:30 ผ่าน In-app" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "ปิด" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "คอมเมนต์ใหม่ในงานที่ฉันเป็น Assignee / Watcher ผ่าน Email" }));
    await user.selectOptions(screen.getByLabelText("ส่งสรุปงานประจำวัน"), "daily");
    await user.selectOptions(screen.getByLabelText("งานใกล้ครบกำหนดในสรุป"), "3d");
    await user.click(screen.getByRole("switch", { name: "โหมดไม่รบกวน" }));
    await user.click(screen.getByRole("switch", { name: "Auto-watch" }));
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    const prefs = calls.find((c) => c.path === "/me/notification-prefs")!;
    expect(prefs.method).toBe("PUT");
    expect((prefs.body as { prefs: unknown[] }).prefs).toHaveLength(7);
    expect(prefs.body).toMatchObject({ workspace: "sample" });
    expect((prefs.body as { prefs: unknown[] }).prefs).toContainEqual({ eventType: "issue.commented", channel: "email", enabled: true });
    expect((prefs.body as { prefs: { eventType: string; channel: string }[] }).prefs.some((p) => p.eventType === "issue.assigned" && p.channel === "in_app")).toBe(false);
    expect(calls.find((c) => c.path === "/me/notification-settings")!.body).toEqual({ workspace: "sample", dueReminder: "3d", digest: "daily", quietStart: null, quietEnd: null, quietOnHolidays: false, autoWatch: false });
    expect(await screen.findByText("บันทึกการตั้งค่าแจ้งเตือนแล้ว")).toBeInTheDocument();

    calls = [];
    await user.click(screen.getByRole("button", { name: "คืนค่าเริ่มต้น" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.find((c) => c.path === "/me/notification-prefs")!.body).toEqual({ workspace: "sample", prefs: [], reset: true });
    expect(calls.find((c) => c.path === "/me/notification-settings")!.body).toMatchObject({ quietStart: "20:00", quietEnd: "08:00", digest: "workdays" });
  });

  it("ผูก LINE: ขอรหัส → รอผู้ใช้ส่งรหัสใน OA → เปลี่ยนเป็นผูกแล้ว · ทดสอบ · ยกเลิกการผูก", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount("notify");
    await user.click(await screen.findByRole("button", { name: "จัดการ" }));
    const panel = screen.getByRole("region", { name: "ผูกบัญชี LINE กับ Friday Manage" });
    expect(screen.getByRole("button", { name: "จัดการ" })).toHaveAttribute("aria-expanded", "true");
    await user.click(within(panel).getByRole("button", { name: "ขอรหัส" }));
    expect(await within(panel).findByText("482 913")).toBeInTheDocument();
    expect(within(panel).getByText("หมดอายุใน 10 นาที")).toBeInTheDocument();
    line = { linked: true, displayName: "ผู้ใช้ตัวอย่าง", boundAt: "2026-11-06T08:00:00Z" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    expect(await screen.findByText("ผูกบัญชี LINE แล้ว")).toBeInTheDocument();
    expect(within(panel).queryByText("482 913")).not.toBeInTheDocument();
    expect(screen.getByText('ผูกกับ "ผู้ใช้ตัวอย่าง" แล้ว')).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "ส่งข้อความทดสอบ" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", path: "/me/line/test", body: { workspace: "sample" } }));
    await user.click(within(panel).getByRole("button", { name: "ยกเลิกการผูกบัญชีปัจจุบัน" }));
    const dialog = await screen.findByRole("dialog", { name: "ยกเลิกการผูกบัญชี LINE?" });
    await user.click(within(dialog).getByRole("button", { name: "ยกเลิกการผูกบัญชีปัจจุบัน" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/me/line" }));
  });

  it("ข้อมูลส่วนตัว: ส่งเฉพาะที่เปลี่ยน (me + membership) · เปลี่ยนอีเมลต้องยืนยันรหัส", async () => {
    const user = userEvent.setup();
    mount("profile");
    const first = await screen.findByLabelText("ชื่อ");
    expect(screen.getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await user.clear(first);
    await user.type(first, "ใหม่");
    await user.clear(screen.getByLabelText("ตำแหน่ง"));
    await user.type(screen.getByLabelText("ตำแหน่ง"), "Tech Lead");
    await user.selectOptions(screen.getByLabelText("รูปแบบปี"), "CE");
    expect(screen.getByText(/วันที่จะแสดงแบบ 2 ธ\.ค\. 2026/)).toBeInTheDocument();
    const email = screen.getByLabelText("อีเมล");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({ method: "PATCH", path: "/me", body: { firstName: "ใหม่", yearFormat: "CE" } });
    expect(calls[1]).toEqual({ method: "PATCH", path: "/w/sample/me/membership", body: { jobTitle: "Tech Lead" } });
    const dialog = await screen.findByRole("dialog", { name: "เปลี่ยนอีเมล" });
    await user.type(within(dialog).getByLabelText("รหัสผ่านปัจจุบัน"), "sample-pass");
    await user.click(within(dialog).getByRole("button", { name: "ส่งรหัสยืนยัน" }));
    await waitFor(() => expect(calls[2]).toEqual({ method: "POST", path: "/me/email:change", body: { newEmail: "new@example.com", password: "sample-pass" } }));
    await user.type(await within(dialog).findByLabelText("รหัสยืนยัน 6 หลัก"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "ยืนยันอีเมลใหม่" }));
    await waitFor(() => expect(calls[3]).toEqual({ method: "POST", path: "/me/email:confirm", body: { code: "123456" } }));
    expect(await screen.findByText("เปลี่ยนอีเมลเป็น new@example.com แล้ว")).toBeInTheDocument();
  });

  it("เวลาทำงาน: Capacity / วันทำงาน · วันลา (สถานะ, HR ลบไม่ได้, ซ้อน 409, ลาครึ่งวัน, ลบ)", async () => {
    const user = userEvent.setup();
    mount("hours");
    const capacity = await screen.findByLabelText("Capacity (ชม./สัปดาห์)");
    fireEvent.change(capacity, { target: { value: "32" } });
    await user.click(screen.getByRole("button", { name: "เสาร์" }));
    expect(screen.getByRole("button", { name: "เสาร์" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "บันทึกเวลาทำงาน" }));
    await waitFor(() => expect(calls[0]).toEqual({ method: "PATCH", path: "/w/sample/me/membership", body: { capacityHoursWeek: 32, workDays: [1, 2, 3, 4, 5, 6] } }));

    const list = screen.getByRole("list", { name: "วันลา" });
    expect(within(list).getByText(/ลาพักร้อน 24 ธ\.ค\. 2569 – 25 ธ\.ค\. 2569/)).toBeInTheDocument();
    expect(within(list).getAllByText("อนุมัติแล้ว")).toHaveLength(2);
    expect(within(list).getByText("รออนุมัติ")).toBeInTheDocument();
    expect(within(list).getByText(/ลากิจ .*\(ครึ่งวันบ่าย\)/)).toBeInTheDocument();
    expect(within(list).getByText("จากระบบ HR")).toBeInTheDocument();
    expect(within(list).getAllByRole("button", { name: /^ลบ / })).toHaveLength(2);

    server.use(http.post(`${W}/leaves`, () => HttpResponse.json({ error: { code: "leave_overlap", message: "ช่วงนี้มีวันลาอยู่แล้ว", details: {} } }, { status: 409 })));
    await user.click(screen.getByRole("button", { name: "+ เพิ่มวันลา" }));
    let dialog = await screen.findByRole("dialog", { name: "เพิ่มวันลา" });
    await user.selectOptions(within(dialog).getByLabelText("ช่วงเวลา"), "pm");
    await user.click(within(dialog).getByRole("button", { name: "ส่งคำขอลา" }));
    expect(await within(dialog).findByText("ช่วงนี้มีวันลาอยู่แล้ว")).toBeInTheDocument();
    server.use(http.post(`${W}/leaves`, ok({ id: "lv-new" }, 201)));
    await user.selectOptions(within(dialog).getByLabelText("ประเภทการลา"), "sick");
    await user.click(within(dialog).getByRole("button", { name: "ส่งคำขอลา" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", path: "/w/sample/leaves", body: { leaveType: "sick", startDate: today(), endDate: today(), halfDay: "pm" } }));
    expect(await screen.findByText("ส่งคำขอลาแล้ว · รออนุมัติ")).toBeInTheDocument();

    await user.click(within(screen.getByRole("list", { name: "วันลา" })).getAllByRole("button", { name: /^ลบ / })[0]);
    dialog = await screen.findByRole("dialog", { name: "ลบวันลานี้?" });
    await user.click(within(dialog).getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/leaves/lv-1" }));
  });

  it("iCal: สร้างลิงก์แล้วแสดง URL ครั้งเดียว · ปิดแล้วไม่เห็นอีก · ยกเลิกลิงก์", async () => {
    const user = userEvent.setup();
    mount("hours");
    const list = await screen.findByRole("list", { name: "ปฏิทิน (iCal)" });
    expect(within(list).getByText(/งานของฉันทุกโปรเจกต์/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("ขอบเขต"), "DE");
    await user.click(screen.getByRole("button", { name: "สร้างลิงก์ปฏิทิน" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", path: "/me/calendar-feeds", body: { workspace: "sample", projectKey: "DE" } }));
    const dialog = await screen.findByRole("dialog", { name: "ลิงก์ปฏิทินของคุณ" });
    expect(within(dialog).getByText("https://api.example.com/api/v1/ical/sample-token.ics")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "เสร็จ" }));
    await waitFor(() => expect(screen.queryByText("https://api.example.com/api/v1/ical/sample-token.ics")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "ยกเลิกลิงก์ งานของฉันทุกโปรเจกต์" }));
    const confirm = await screen.findByRole("dialog", { name: "ยกเลิกลิงก์ปฏิทินนี้?" });
    await user.click(within(confirm).getByRole("button", { name: "ยกเลิกลิงก์" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/me/calendar-feeds/f-1" }));
  });

  it("ความปลอดภัย: Session (เครื่องนี้ / ออกจากระบบ / ทุกเครื่อง) · รหัสผ่าน · Google", async () => {
    const user = userEvent.setup();
    mount("sec");
    const devices = await screen.findByRole("list", { name: "อุปกรณ์ที่ล็อกอินอยู่" });
    expect(within(devices).getByText(/Chrome · macOS · กรุงเทพฯ/)).toBeInTheDocument();
    expect(within(devices).getByText("เครื่องนี้")).toBeInTheDocument();
    expect(within(devices).getByText("ตอนนี้")).toBeInTheDocument();
    await user.click(within(devices).getByRole("button", { name: "ออกจากระบบ Friday Manage app · iPhone" }));
    let dialog = await screen.findByRole("dialog", { name: "ออกจากระบบอุปกรณ์นี้?" });
    await user.click(within(dialog).getByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/me/sessions/s-2" }));
    await user.click(screen.getByRole("button", { name: "ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้" }));
    dialog = await screen.findByRole("dialog", { name: "ออกจากระบบอุปกรณ์อื่นทั้งหมด?" });
    await user.click(within(dialog).getByRole("button", { name: "ออกจากระบบทุกเครื่องยกเว้นเครื่องนี้" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/me/sessions" }));

    expect(screen.getByText(/รหัสผ่าน · เปลี่ยนล่าสุด/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เปลี่ยนรหัสผ่าน" }));
    dialog = await screen.findByRole("dialog", { name: "เปลี่ยนรหัสผ่าน" });
    await user.type(within(dialog).getByLabelText("รหัสผ่านปัจจุบัน"), "old-sample");
    await user.type(within(dialog).getByLabelText("รหัสผ่านใหม่"), "new-sample-123");
    await user.type(within(dialog).getByLabelText("ยืนยันรหัสผ่านใหม่"), "new-sample-12");
    expect(within(dialog).getByText("รหัสผ่านไม่ตรงกัน")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("ยืนยันรหัสผ่านใหม่"), "3");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", path: "/me/password:change", body: { currentPassword: "old-sample", newPassword: "new-sample-123", logoutOthers: true } }));
    expect(await screen.findByText("เปลี่ยนรหัสผ่านแล้ว · ออกจากระบบอุปกรณ์อื่น 1 เครื่อง")).toBeInTheDocument();

    expect(screen.getByText("เข้าสู่ระบบด้วย Google").closest("div")).toHaveTextContent("เชื่อมแล้ว");
    expect(screen.getByRole("link", { name: "เชื่อม" })).toHaveAttribute("href", "/api/v1/auth/oauth/microsoft/start?mode=link&next=%2Fwork%2Fsample%2Fprofile%3Ftab%3Dsec");
  });

  it("2FA: setup → ยืนยัน → Backup code แสดงครั้งเดียว ปิดแล้วไม่เห็นอีก · บังคับโดย Workspace ซ่อนปุ่มปิด", async () => {
    const user = userEvent.setup();
    mount("sec");
    expect(await screen.findByText("ปิดอยู่")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เปิดใช้" }));
    let dialog = await screen.findByRole("dialog", { name: "เปิด Two-factor authentication" });
    await user.click(within(dialog).getByRole("button", { name: "เริ่มตั้งค่า" }));
    expect(await within(dialog).findByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "เปิดในแอป Authenticator" })).toHaveAttribute("href", expect.stringMatching(/^otpauth:\/\//));
    await user.type(within(dialog).getByLabelText("รหัสจากแอป หรือ Backup code"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "ยืนยันและเปิดใช้" }));
    expect(await within(dialog).findByText("AAAA-1111")).toBeInTheDocument();
    expect(within(dialog).queryByText("JBSW Y3DP EHPK 3PXP")).not.toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/me/mfa:enable", body: { code: "123456" } });
    await user.click(within(dialog).getByRole("button", { name: "เก็บแล้ว" }));
    await waitFor(() => expect(screen.queryByText("AAAA-1111")).not.toBeInTheDocument());
    expect(await screen.findByText("เปิดอยู่")).toBeInTheDocument();
    expect(screen.getByText(/Backup code เหลือ 2 รหัส/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ออก Backup code ใหม่" }));
    dialog = await screen.findByRole("dialog", { name: "ออก Backup code ชุดใหม่" });
    expect(within(dialog).queryByText("AAAA-1111")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("รหัสจากแอป หรือ Backup code"), "AAAA-1111");
    await user.click(within(dialog).getByRole("button", { name: "ออกชุดใหม่" }));
    expect(await within(dialog).findByText("CCCC-3333")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("CCCC-3333")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "ปิด 2FA" }));
    dialog = await screen.findByRole("dialog", { name: "ปิด Two-factor authentication" });
    await user.type(within(dialog).getByLabelText("รหัสจากแอป หรือ Backup code"), "654321");
    await user.click(within(dialog).getByRole("button", { name: "ปิด 2FA" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", path: "/me/mfa:disable", body: { code: "654321" } }));
  });

  it("2FA ที่ Workspace บังคับ: ไม่มีปุ่มปิด", async () => {
    mfa = { enabled: true, enabledAt: "2026-01-01T00:00:00Z", backupCodesLeft: 8, setupPending: false, requiredByPolicy: true };
    mount("sec");
    expect(await screen.findByText("Workspace บังคับใช้")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ปิด 2FA" })).not.toBeInTheDocument();
  });

  it("Guest: ไม่มีปุ่มเพิ่มวันลา", async () => {
    server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role: "guest" }] })));
    mount("hours");
    expect(await screen.findByRole("list", { name: "วันลา" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ เพิ่มวันลา" })).not.toBeInTheDocument();
  });

  it("สถานะ: กำลังโหลด · Error พร้อม requestId · 403 ไม่มีสิทธิ์ · วันลาว่าง", async () => {
    server.use(http.get("*/api/v1/me/notification-prefs", () => fail(500)));
    const a = mount("notify");
    expect(await screen.findByText("รหัสอ้างอิง: req_w17_001")).toBeInTheDocument();
    a.unmount();

    server.use(http.get(`${W}/me/membership`, () => fail(403)), http.get(`${W}/leaves`, () => HttpResponse.json({ items: [] })));
    const b = mount("hours");
    expect(await screen.findAllByText("คุณยังไม่มีสิทธิ์เข้าถึง")).not.toHaveLength(0);
    b.unmount();

    server.use(http.get(`${W}/me/membership`, () => HttpResponse.json(membership())));
    const c = mount("hours");
    expect(await screen.findByText("ยังไม่มีวันลา")).toBeInTheDocument();
    c.unmount();

    server.use(http.get("*/api/v1/me/sessions", async () => {
      await delay("infinite");
      return HttpResponse.json({ items: [] });
    }));
    mount("sec");
    const panel = await screen.findByRole("tabpanel", { name: "ความปลอดภัย" });
    expect((await within(panel).findAllByLabelText("กำลังโหลด…"))[0]).toHaveAttribute("aria-busy", "true");
  });
});

describe("Profile helpers", () => {
  it("profileChanges ส่งเฉพาะที่เปลี่ยน · ช่องว่าง = null", () => {
    const base = { firstName: "ก", lastName: "", displayName: "ก", jobTitle: "", department: "ทีม", email: "a@example.com", phone: "", timezone: "Asia/Bangkok", locale: "th", yearFormat: "BE" as const, about: "" };
    expect(profileChanges(base, { ...base, firstName: " ", department: "", email: "A@example.com" })).toEqual({ me: { firstName: null }, membership: { department: null }, email: null });
  });
  it("hoursChanges ส่งเวลาเป็นคู่ · เรียงวัน", () => {
    const m = membership();
    expect(hoursChanges(m, { capacity: "40", workStart: "08:30", workEnd: "18:00", workDays: [5, 4, 3, 2, 1] })).toEqual({ workStart: "08:30", workEnd: "18:00" });
  });
  it("deviceLabel อ่านจาก User-Agent", () => {
    expect(deviceLabel({ deviceName: null, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1" })).toBe("Safari · iPhone");
    expect(deviceLabel({ deviceName: null, userAgent: null })).toBeNull();
  });
});
