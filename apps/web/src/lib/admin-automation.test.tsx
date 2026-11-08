// W18 · Admin Console (N1), หน้าตาข้อความแจ้งเตือน (N2) และ Automation (P2) · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { router } from "@/test/router";
import { permissions, projects, workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import json from "../../messages/th/admin-automation.json";
import { AdminConsole } from "../../app/work/[ws]/admin/_components/admin-console";
import { workloadRange } from "../../app/work/[ws]/admin/_components/org-sections";
import { AutomationPage } from "../../app/work/[ws]/p/[key]/automation/_components/automation-page";
import { draftSentence } from "../../app/work/[ws]/p/[key]/automation/_components/rule-editor";
import { incomplete, toBody, type Rule } from "../../app/work/[ws]/p/[key]/automation/_components/types";

type Call = { method: string; path: string; search: string; body: unknown; ifMatch: string | null };
let calls: Call[];
const W = "*/api/v1/w/:ws";
const errorBody = (status: number, code = status === 403 ? "forbidden" : "internal_error", details: Record<string, unknown> = {}) =>
  HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", requestId: "req_w18_001", details } }, { status });
const record = async (request: Request) => {
  const text = await request.text();
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname.replace("/api/v1", ""), search: url.search, body: text ? JSON.parse(text) : undefined, ifMatch: request.headers.get("if-match") });
};
const ok = (body: JsonBodyType = { ok: true }, status = 200) => async ({ request }: { request: Request }) => {
  await record(request);
  return HttpResponse.json(body, { status });
};
const gets = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path);

const overview = (over: Record<string, unknown> = {}) => ({
  plan: { code: "team_m", name: "Team M", status: "trialing", trialEndsAt: "2026-11-20T00:00:00Z" },
  users: { active: 9, seatLimit: 25, guests: 2, activeLast7Days: 8 },
  projects: { active: 3, archived: 1, limit: null },
  storage: { usedBytes: 1.2 * 1024 ** 3, limitBytes: 50 * 1024 ** 3 },
  issues: { total: 486, open: 312 },
  weeklyActiveUsers: ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"].map((week, i) => ({ week, users: [5, 6, 7, 7, 8, 8, 9, 8][i] })),
  mfa: { enabled: 7, total: 9 },
  actions: [
    { code: "mfa_missing", count: 2, message: "มี 2 คนที่ยังไม่เปิด 2FA ทั้งที่องค์กรบังคับ" },
    { code: "over_capacity", count: 1, message: "1 คนถูกแบ่งเวลาให้โปรเจกต์เกินเวลาทั้งหมด" },
  ],
  projectList: [
    { id: "p1", key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", visibility: "private", status: "active", pm: { id: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง" }, memberCount: 14, lastActivityAt: "2026-11-05T03:00:00Z" },
    { id: "p2", key: "FN", name: "งานบัญชีตัวอย่าง", visibility: "private", status: "active", pm: { id: "u-pm", displayName: "ผู้จัดการตัวอย่าง" }, memberCount: 4, lastActivityAt: null },
  ],
  ...over,
});
const settings = () => ({
  workStart: "09:00", workEnd: "18:00", workDays: [1, 2, 3, 4, 5], sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 12 },
  allowProjectOverride: true, safeMode: true, trashDays: 30, archiveRetentionYears: null, requireConsentOnFirstLogin: true, holidayCalendarId: null, dataRegion: "th-bangkok",
});
const members = [
  { userId: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง", email: "lead@example.com", role: "owner", status: "active" },
  { userId: "u-dev", displayName: "ผู้พัฒนาหนึ่ง", email: "dev1@example.com", role: "member", status: "active" },
  { userId: "u-dev2", displayName: "ผู้พัฒนาสอง", email: "dev2@example.com", role: "member", status: "active" },
  { userId: "u-guest", displayName: "ลูกค้าตัวอย่าง", email: "client@example.com", role: "guest", status: "active" },
];
const policy = () => ({
  passwordMinLength: 10, passwordRequireSpecial: true, passwordRotationDays: 90, lockoutAttempts: 5, lockoutMinutes: 15, sessionIdleHours: 8,
  mfaEnforcement: "admin", allowedEmailDomains: ["example.com"], ipAllowlist: [],
  mfa: { enabled: 7, total: 9, missing: [{ id: "u-dev", displayName: "ผู้พัฒนาหนึ่ง" }, { id: "u-dev2", displayName: "ผู้พัฒนาสอง" }] },
});

let current: ReturnType<typeof settings>;
beforeEach(() => {
  calls = [];
  current = settings();
  server.use(
    http.get(`${W}/admin/overview`, async ({ request }) => { await record(request); return HttpResponse.json(overview()); }),
    http.get(`${W}/settings`, () => HttpResponse.json(current)),
    http.patch(`${W}/settings`, async ({ request }) => {
      await record(request);
      current = { ...current, ...(calls.at(-1)!.body as object) };
      return HttpResponse.json({ ...current, recalculated: { projects: 0, issues: 0 } });
    }),
    http.get(`${W}/members`, () => HttpResponse.json({ items: members })),
  );
});

const mount = (ui: React.ReactElement, ws = "sample") => renderWithProviders(<WorkspaceShell ws={ws}>{ui}</WorkspaceShell>, { messages: { "admin-automation": json } });
const admin = (section?: string, ws = "sample") => mount(<AdminConsole ws={ws} section={section} />, ws);

describe("Admin Console (N1) · สิทธิ์และสถานะ", () => {
  it("สมาชิกทั่วไปเห็นไม่มีสิทธิ์ และไม่เรียก API ของ Admin", async () => {
    admin(undefined, "other");
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(gets("/w/other/admin/overview")).toHaveLength(0);
  });

  it("แท็บที่ไม่รู้จัก = ไม่พบหน้า · API ตอบ 403 = ไม่มีสิทธิ์ · 500 แสดงรหัสอ้างอิง", async () => {
    const a = admin("nope");
    expect(await screen.findByText("ไม่พบหน้านี้")).toBeInTheDocument();
    a.unmount();
    server.use(http.get(`${W}/admin/overview`, () => errorBody(403)));
    const b = admin();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    b.unmount();
    server.use(http.get(`${W}/admin/overview`, () => errorBody(500)));
    admin("overview");
    expect(await screen.findByText(/req_w18_001/)).toBeInTheDocument();
  });
});

describe("Admin Console (N1) · ภาพรวมและโปรเจกต์", () => {
  it("เมนูครบตาม Canvas + ป้ายจำนวนเรื่องที่ต้องทำ · KPI · เรื่องที่ต้องดำเนินการพาไปแท็บที่แก้ได้", async () => {
    admin();
    const nav = await screen.findByRole("navigation", { name: "เมนู Admin Console" });
    expect(within(nav).getAllByRole("link")).toHaveLength(12);
    expect(within(nav).getByRole("link", { name: /แดชบอร์ด/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /สมาชิก & คำเชิญ/ })).toHaveAttribute("href", "/work/sample/members");
    expect(await within(nav).findByLabelText("ต้องดำเนินการ 2 เรื่อง")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "แดชบอร์ด" })).toBeInTheDocument();
    expect(screen.getByText("/ 25 seats")).toBeInTheDocument();
    expect(screen.getByText("Archive แล้ว 1")).toBeInTheDocument();
    expect(screen.getByText("89% ของผู้ใช้")).toBeInTheDocument();
    expect(screen.getByText("เปิดอยู่ 312")).toBeInTheDocument();
    expect(screen.getByText("มี 2 คนที่ยังไม่เปิด 2FA ทั้งที่องค์กรบังคับ")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "ดู" });
    expect(links[0]).toHaveAttribute("href", "/work/sample/admin/security");
    expect(links[1]).toHaveAttribute("href", "/work/sample/admin/load");
    expect(screen.getByRole("img", { name: "ผู้ใช้ Active รายสัปดาห์ จาก 5 เป็น 8 คน" })).toBeInTheDocument();
  });

  it("โปรเจกต์ทั้งหมด: โปรเจกต์ที่ยังไม่ได้เป็นสมาชิกต้องเข้าร่วมในฐานะ Admin", async () => {
    server.use(
      http.get(`${W}/projects`, () => HttpResponse.json({ items: [...projects, { ...projects[0], id: "p2", key: "FN", name: "งานบัญชีตัวอย่าง", joined: false, myRole: null }] })),
      http.post(`${W}/projects/:key/join-as-admin`, ok()),
    );
    const user = userEvent.setup();
    admin("projects");
    const card = await screen.findByRole("region", { name: "โปรเจกต์ทั้งหมด" });
    expect(within(card).getByText("แผนพัฒนาผลิตภัณฑ์")).toBeInTheDocument();
    expect(within(card).getByText("PM: ผู้จัดการตัวอย่าง")).toBeInTheDocument();
    expect(within(card).getByText("ยังไม่มีกิจกรรม")).toBeInTheDocument();
    await user.click(await within(card).findByRole("button", { name: "เข้าร่วมในฐานะ Admin" }));
    expect(within(card).getByRole("link", { name: "เปิด" })).toHaveAttribute("href", "/work/sample/p/DE");
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/FN/join-as-admin" }));
    expect(await screen.findByText(/เข้าร่วม FN ในฐานะ Admin แล้ว/)).toBeInTheDocument();
  });

  it("แพ็กเกจ & Billing: สรุปจาก overview และลิงก์ไปหน้าแพ็กเกจ", async () => {
    admin("bill");
    expect(await screen.findByText("Team M")).toBeInTheDocument();
    expect(screen.getByText("9 / 25")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "จัดการแพ็กเกจและการชำระเงิน" })).toHaveAttribute("href", "/work/sample/billing");
  });
});

describe("Admin Console (N1) · องค์กร", () => {
  it("ทีม: ว่าง → สร้างทีมพร้อมหัวหน้าและสมาชิก (Guest เลือกไม่ได้) · แก้ไข เพิ่ม/เอาสมาชิกออก · ลบ", async () => {
    let teams: unknown[] = [];
    const detail = { id: "t1", name: "ทีมพัฒนา", color: "#1D4ED8", lead: { id: "u-dev", displayName: "ผู้พัฒนาหนึ่ง" }, memberCount: 1, capacityMdWeek: 5, projectCount: 1, members: [{ id: "u-dev", displayName: "ผู้พัฒนาหนึ่ง", role: "member", jobTitle: "Developer", capacityHoursWeek: 40 }] };
    server.use(
      http.get(`${W}/teams`, () => HttpResponse.json({ items: teams })),
      http.post(`${W}/teams`, async ({ request }) => { await record(request); teams = [detail]; return HttpResponse.json(detail, { status: 201 }); }),
      http.get(`${W}/teams/:id`, () => HttpResponse.json(detail)),
      http.patch(`${W}/teams/:id`, ok(detail)),
      http.post(`${W}/teams/:id/members`, ok(detail)),
      http.delete(`${W}/teams/:id/members/:userId`, ok(detail)),
      http.delete(`${W}/teams/:id`, ok({ deleted: true })),
    );
    const user = userEvent.setup();
    admin("teams");
    expect(await screen.findByText("ยังไม่มีทีม")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ สร้างทีม" }));
    const dialog = await screen.findByRole("dialog", { name: "สร้างทีม" });
    await user.type(within(dialog).getByLabelText("ชื่อทีม"), "ทีมพัฒนา");
    await user.selectOptions(within(dialog).getByLabelText("หัวหน้าทีม"), "u-dev");
    expect(within(dialog).queryByRole("checkbox", { name: "ลูกค้าตัวอย่าง" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "ผู้พัฒนาสอง" }));
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/teams" }));
    expect(calls.at(-1)!.body).toMatchObject({ name: "ทีมพัฒนา", leadUserId: "u-dev", memberIds: ["u-dev2", "u-dev"] });
    expect(await screen.findByText("Capacity 5 MD/สัปดาห์")).toBeInTheDocument();
    expect(screen.getByText("หัวหน้าทีม: ผู้พัฒนาหนึ่ง")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "แก้ไข" }));
    const edit = await screen.findByRole("dialog", { name: "แก้ไขทีม ทีมพัฒนา" });
    await user.selectOptions(await within(edit).findByLabelText("เพิ่มสมาชิก"), "u-dev2");
    await user.click(within(edit).getByRole("button", { name: "เพิ่ม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/teams/t1/members", body: { userIds: ["u-dev2"] } }));
    await user.click(within(edit).getByRole("button", { name: "เอา ผู้พัฒนาหนึ่ง ออกจากทีม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/teams/t1/members/u-dev" }));
    const name = within(edit).getByLabelText("ชื่อทีม");
    await user.clear(name);
    await user.type(name, "ทีม Dev");
    await user.click(within(edit).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/teams/t1", body: { name: "ทีม Dev", leadUserId: "u-dev" }, ifMatch: null }));
    await user.click(within(edit).getByRole("button", { name: "ลบทีม" }));
    const confirm = await screen.findByRole("dialog", { name: "ลบทีม ทีมพัฒนา?" });
    await user.click(within(confirm).getByRole("button", { name: "ลบทีม" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/teams/t1" }));
  });

  it("ค่ามาตรฐาน: ส่งเฉพาะที่เปลี่ยนโดยไม่ใช้ If-Match · override · ปฏิทิน ธปท. คัดลอกแล้วตั้งเป็นค่าเริ่มต้น · เพิ่ม/ลบวันหยุดบริษัท · Template", async () => {
    let cals = [{ id: "sys", name: "ธปท. ตัวอย่าง", source: "system", holidayCount: 2, isDefault: true, editable: false }];
    server.use(
      http.get(`${W}/holiday-calendars`, () => HttpResponse.json({ items: cals })),
      http.post(`${W}/holiday-calendars`, async ({ request }) => {
        await record(request);
        cals = [{ ...cals[0], isDefault: false }, { id: "own", name: "ธปท. ตัวอย่าง (ของ Workspace)", source: "workspace", holidayCount: 2, isDefault: true, editable: true }];
        return HttpResponse.json(cals[1], { status: 201 });
      }),
      http.get(`${W}/holidays`, ({ request }) => {
        const id = new URL(request.url).searchParams.get("calendarId");
        return HttpResponse.json({ calendarId: id, editable: id === "own", items: [{ id: "h1", date: "2026-12-05", name: "วันหยุดตัวอย่าง", kind: "bank" }] });
      }),
      http.post(`${W}/holidays`, ok({ holiday: {}, recalculated: { projects: 1, issues: 4 } }, 201)),
      http.delete(`${W}/holidays/:id`, ok({ deleted: true, recalculated: { projects: 0, issues: 0 } })),
      http.get(`${W}/project-templates`, () => HttpResponse.json({ items: [{ id: "tp1", name: "Scrum ตัวอย่าง", description: "Story / Task / Bug", usageCount: 2 }] })),
      http.post(`${W}/project-templates`, ok({ id: "tp2" }, 201)),
      http.delete(`${W}/project-templates/:id`, ok({ deleted: true })),
    );
    const user = userEvent.setup();
    admin("std");
    const xl = await screen.findByLabelText("Man-Day ของ XL");
    const save = screen.getByRole("button", { name: "บันทึก" });
    expect(save).toBeDisabled();
    fireEvent.change(xl, { target: { value: "13" } });
    await user.click(screen.getByRole("button", { name: "ส." }));
    fireEvent.change(screen.getByLabelText("เวลาเลิกงาน"), { target: { value: "08:00" } });
    expect(screen.getByText("เวลาเลิกงานต้องหลังเวลาเริ่มงาน")).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("เวลาเลิกงาน"), { target: { value: "18:00" } });
    await user.click(save);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/settings", ifMatch: null }));
    expect(calls.at(-1)!.body).toEqual({ workDays: [1, 2, 3, 4, 5, 6], sizeMdMap: { XS: 1, S: 3, M: 5, L: 8, XL: 13 } });
    await user.click(await screen.findByRole("switch", { name: "อนุญาตให้โปรเจกต์ปรับค่าเองได้ (override)" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { allowProjectOverride: false } }));

    expect(await screen.findByText("วันหยุดตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ วันหยุดบริษัท" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "นำเข้าจากประกาศ ธปท." }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/w/sample/holiday-calendars")).toBe(true));
    expect(calls.find((c) => c.path === "/w/sample/holiday-calendars")!.body).toEqual({ name: "ธปท. ตัวอย่าง (ของ Workspace)", copyFromId: "sys" });
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { holidayCalendarId: "own" } }));
    const add = await screen.findByRole("button", { name: "+ วันหยุดบริษัท" });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    const dialog = await screen.findByRole("dialog", { name: "เพิ่มวันหยุดบริษัท" });
    fireEvent.change(within(dialog).getByLabelText("วันที่"), { target: { value: "2027-01-08" } });
    await user.type(within(dialog).getByLabelText("ชื่อวันหยุด"), "งานเลี้ยงตัวอย่าง");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/holidays", body: { calendarId: "own", date: "2027-01-08", name: "งานเลี้ยงตัวอย่าง", kind: "company" } }));
    expect(await screen.findByText("เพิ่มวันหยุดแล้ว · คำนวณ Plan End ใหม่ 4 งาน")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "ลบวันหยุด วันหยุดตัวอย่าง" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/holidays/h1" }));

    expect(screen.getByText("ใช้ 2 ครั้ง")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ Template" }));
    const tpl = await screen.findByRole("dialog", { name: "สร้าง Template" });
    await user.type(within(tpl).getByLabelText("ชื่อ Template"), "Kanban ตัวอย่าง");
    await user.click(within(tpl).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/project-templates", body: { name: "Kanban ตัวอย่าง", description: null } }));
  });

  it("Workload รวม: 4 สัปดาห์ · เกิน capacity มีกรอบแดง · กรองตามทีม", async () => {
    server.use(
      http.get(`${W}/teams`, () => HttpResponse.json({ items: [{ id: "t1", name: "ทีมพัฒนา", color: null, lead: null, memberCount: 2, capacityMdWeek: 10, projectCount: 1 }] })),
      http.get(`${W}/workload`, async ({ request }) => {
        await record(request);
        const buckets = [0, 1, 2, 3].map((i) => ({ start: `2026-11-${String(2 + i * 7).padStart(2, "0")}`, end: `2026-11-${String(8 + i * 7).padStart(2, "0")}` }));
        const cell = (value: number, capacity = 5) => ({ value, capacity, over: value > capacity, byProject: [{ key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", color: null, value }] });
        return HttpResponse.json({
          range: { from: buckets[0].start, to: buckets[3].end }, buckets,
          people: [
            { person: { id: "u-dev", displayName: "ผู้พัฒนาหนึ่ง" }, jobTitle: "Developer", capacityHoursWeek: 40, allocatedHoursWeek: 48, overAllocated: true, overPeriods: 2, cells: [cell(8), cell(6), cell(4), cell(3)] },
            { person: { id: "u-dev2", displayName: "ผู้พัฒนาสอง" }, jobTitle: null, capacityHoursWeek: 40, allocatedHoursWeek: 40, overAllocated: false, overPeriods: 0, cells: [cell(2), cell(2), cell(2), cell(2)] },
          ],
        });
      }),
    );
    const user = userEvent.setup();
    admin("load");
    expect(await screen.findByText("เกิน capacity 2 สัปดาห์")).toBeInTheDocument();
    expect(screen.getByText("อยู่ใน capacity")).toBeInTheDocument();
    expect(screen.getByText("แบ่งให้โปรเจกต์ 48 / 40 ชม.")).toBeInTheDocument();
    expect(screen.getByTitle("แผนพัฒนาผลิตภัณฑ์ 8 MD").className).toMatch(/wlOver/);
    const range = workloadRange();
    expect(calls[0].search).toBe(`?${new URLSearchParams({ ...range, group: "week", unit: "md" })}`);
    await user.selectOptions(screen.getByLabelText("กรองตามทีม"), "t1");
    await waitFor(() => expect(calls.at(-1)!.search).toContain("team=t1"));
  });

  it("workloadRange เริ่มวันจันทร์ ยาว 4 สัปดาห์", () => {
    expect(workloadRange("2026-11-06")).toEqual({ from: "2026-11-02", to: "2026-11-29" });
    expect(workloadRange("2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-29" });
  });
});

describe("Admin Console (N1) · ความปลอดภัยและการกำกับ", () => {
  beforeEach(() => {
    server.use(
      http.get(`${W}/security-policy`, () => HttpResponse.json(policy())),
      http.patch(`${W}/security-policy`, ok(policy())),
      http.get(`${W}/support-access`, () => HttpResponse.json({ enabled: false, expired: false, until: null, maxMode: "read", notifyAdmins: true, sessions: [{ id: "s1", ticketNo: "#4702", mode: "read", startedAt: "2026-10-28T02:05:00Z", durationMinutes: 14, staffName: "ทีมงานตัวอย่าง" }] })),
      http.put(`${W}/support-access`, ok({ enabled: true, expired: false, until: null, maxMode: "read", notifyAdmins: true, sessions: [] })),
    );
  });

  it("2FA + นโยบาย: เลือกบังคับทุกคน · ส่งเฉพาะที่เปลี่ยน · IP Allowlist ที่ล็อกตัวเองแสดงข้อความใต้ช่อง · SSO ยังไม่เปิด", async () => {
    const user = userEvent.setup();
    admin("security");
    expect(await screen.findByText("เปิดแล้ว 7 / 9 คน")).toBeInTheDocument();
    expect(screen.getByText("ผู้พัฒนาหนึ่ง, ผู้พัฒนาสอง")).toBeInTheDocument();
    expect(screen.getAllByText("ยังไม่เปิดใช้งาน").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("radio", { name: /บังคับทุกคน/ }));
    await user.selectOptions(screen.getByLabelText("Session หมดอายุเมื่อไม่ใช้งาน"), "24");
    await user.click(screen.getByRole("button", { name: "บันทึกนโยบาย" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/security-policy", ifMatch: null }));
    expect(calls.at(-1)!.body).toEqual({ sessionIdleHours: 24, mfaEnforcement: "all" });
    expect(await screen.findByText("บันทึกนโยบายความปลอดภัยแล้ว")).toBeInTheDocument();

    server.use(http.patch(`${W}/security-policy`, () => errorBody(422, "ip_allowlist_locks_you_out", { yourIp: "198.51.100.9" })));
    fireEvent.change(screen.getByLabelText("IP Allowlist (ไม่บังคับ)"), { target: { value: "203.0.113.0/24" } });
    await user.click(screen.getByRole("button", { name: "บันทึกนโยบาย" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("IP ปัจจุบันของคุณ (198.51.100.9) ไม่อยู่ในรายการ");
  });

  it("การเข้าช่วยเหลือ: Owner เปิดสิทธิ์ได้ · Admin ที่ไม่ใช่ Owner เปลี่ยนไม่ได้", async () => {
    const user = userEvent.setup();
    const a = admin("security");
    expect(await screen.findByText(/Ticket #4702 · อ่านอย่างเดียว 14 นาที/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("อนุญาตถึง"), "7d");
    await user.click(screen.getByRole("switch", { name: "อนุญาตให้ทีม Friday เข้า Workspace นี้เพื่อช่วยแก้ปัญหา" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/w/sample/support-access", body: { enabled: true, duration: "7d", maxMode: "read", notifyAdmins: true } }));
    a.unmount();
    server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role: "admin" }, workspaces[1]] })));
    admin("security");
    expect(await screen.findByText("เปิด / ปิดได้เฉพาะ Owner")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "อนุญาตให้ทีม Friday เข้า Workspace นี้เพื่อช่วยแก้ปัญหา" })).toBeDisabled();
  });

  it("Audit Log: กรองหมวด / ผู้ใช้ / ช่วงเวลา · Export CSV ใช้ตัวกรองเดียวกัน · โหลดเพิ่มด้วย cursor", async () => {
    server.use(
      http.get(`${W}/audit-log`, async ({ request }) => {
        await record(request);
        const before = new URL(request.url).searchParams.get("before");
        return HttpResponse.json(before
          ? { items: [{ id: "a3", at: "2026-11-03T09:00:00Z", actor: { id: null, kind: "system", displayName: null }, category: "secu", action: "auth.locked", summary: "ล็อกบัญชีชั่วคราว", ip: null }], nextCursor: null }
          : { items: [
              { id: "a1", at: "2026-11-05T03:20:00Z", actor: { id: "sample-lead", kind: "user", displayName: "หัวหน้าทีมตัวอย่าง" }, category: "plan", action: "plan.changed", summary: "Man-Day 12 → 15", ip: "203.0.113.24" },
              { id: "a2", at: "2026-11-05T02:58:00Z", actor: { id: "sample-lead", kind: "user", displayName: "หัวหน้าทีมตัวอย่าง" }, category: "perm", action: "member.role_changed", summary: "Member → Admin", ip: "203.0.113.24" },
            ], nextCursor: "2026-11-05T02:58:00.000Z" });
      }),
    );
    const user = userEvent.setup();
    admin("audit");
    expect(await screen.findByText("Man-Day 12 → 15")).toBeInTheDocument();
    expect(screen.getAllByText("203.0.113.24")).toHaveLength(2);
    const first = new URLSearchParams(calls[0].search);
    expect(first.get("from")).toBeTruthy();
    expect(first.get("limit")).toBe("50");
    await user.click(screen.getByRole("button", { name: "โหลดเพิ่ม" }));
    expect(await screen.findByText("ล็อกบัญชีชั่วคราว")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Audit Log" })).getByText("ระบบ")).toBeInTheDocument();
    expect(new URLSearchParams(calls.at(-1)!.search).get("before")).toBe("2026-11-05T02:58:00.000Z");

    await user.click(within(screen.getByRole("group", { name: "หมวด" })).getByRole("button", { name: "ความปลอดภัย" }));
    await user.selectOptions(screen.getByLabelText("ผู้ใช้"), "u-dev");
    await user.click(screen.getByRole("button", { name: "กำหนดเอง" }));
    fireEvent.change(screen.getByLabelText("ตั้งแต่วันที่"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(calls.at(-1)!.search).toBe("?category=secu&user=u-dev&from=2026-10-01&limit=50"));
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/v1/w/sample/audit-log.csv?category=secu&user=u-dev&from=2026-10-01");
  });

  it("ข้อมูล & PDPA: ถังขยะ / การเก็บรักษา · Export ทั้ง Workspace · คำขอลบต้องพิมพ์อีเมลยืนยัน · ลบ Workspace ต้องพิมพ์ slug", async () => {
    let exports: JsonBodyType[] = [];
    server.use(
      http.get(`${W}/exports`, () => HttpResponse.json({ items: exports })),
      http.post(`${W}/exports`, async ({ request }) => {
        await record(request);
        exports = [{ id: "e1", status: "ready", createdAt: "2026-11-06T03:00:00Z", expiresAt: "2026-11-13T03:00:00Z", sizeBytes: 5 * 1024 ** 2, downloadUrl: "/api/v1/w/sample/exports/e1/download" }];
        return HttpResponse.json(exports[0], { status: 202 });
      }),
      http.get(`${W}/data-requests`, () => HttpResponse.json({ items: [
        { id: "r1", requesterEmail: "former@example.com", requestType: "erase", status: "pending", dueDate: "2026-12-01", daysLeft: 25, overdue: false, completedAt: null, createdAt: "2026-11-01T03:00:00Z" },
        { id: "r2", requesterEmail: "copy@example.com", requestType: "export", status: "completed", dueDate: "2026-11-27", daysLeft: 0, overdue: false, completedAt: "2026-10-28T03:00:00Z", createdAt: "2026-10-27T03:00:00Z" },
      ] })),
      http.post(`${W}/data-requests/:id/complete`, ok({ id: "r1", status: "completed" })),
      http.delete("*/api/v1/w/:ws", ok({ slug: "sample", deleted: true, restorableUntil: "2026-12-06T00:00:00Z" })),
    );
    const user = userEvent.setup();
    admin("data");
    expect(await screen.findByText("ประเทศไทย (Bangkok)")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "90 วัน" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/settings", body: { trashDays: 90 } }));
    await user.click(screen.getByRole("radio", { name: "ลบหลัง 3 ปี" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { archiveRetentionYears: 3 } }));

    expect(await screen.findByText("ล่าสุด: ยังไม่เคย Export")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/exports" }));
    await waitFor(() => expect(screen.getAllByRole("link", { name: "ดาวน์โหลด" }).map((a) => a.getAttribute("href"))).toEqual(["/api/v1/w/sample/exports/e1/download", "/api/v1/w/sample/data-requests/r2/result"]));
    expect(screen.getByText(/ปิดคำขอเมื่อ/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ดำเนินการ" }));
    const dialog = await screen.findByRole("dialog", { name: "ลบข้อมูลของ former@example.com" });
    const done = within(dialog).getByRole("button", { name: "ปิดคำขอ" });
    expect(done).toBeDisabled();
    await user.type(within(dialog).getByLabelText("พิมพ์อีเมลของผู้ขอเพื่อยืนยัน"), "former@example.com");
    await user.click(done);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/data-requests/r1/complete", body: { confirmEmail: "former@example.com" } }));

    await user.click(screen.getByRole("switch", { name: "แสดงข้อความขอความยินยอมเมื่อผู้ใช้ใหม่เข้าระบบครั้งแรก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { requireConsentOnFirstLogin: false } }));

    await user.click(screen.getByRole("button", { name: "ลบ Workspace…" }));
    const del = await screen.findByRole("dialog", { name: "ลบ Workspace" });
    const go = within(del).getByRole("button", { name: "ลบ Workspace" });
    expect(go).toBeDisabled();
    await user.type(within(del).getByLabelText("พิมพ์ sample เพื่อยืนยัน"), "sample");
    await user.click(go);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample", body: { confirmSlug: "sample" } }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/"));
  });
});

describe("Admin Console (N1) · ระบบ", () => {
  beforeEach(() => {
    server.use(
      http.get(`${W}/channels/line-oa`, () => HttpResponse.json({ configured: true, webhookUrl: "https://api.example.com/api/v1/hooks/line/sample-ws", config: { channelId: "1650000000", channelSecretLast4: "ab12", accessTokenLast4: "cd34", fallbackToEmail: true, batchDigestMinutes: 5 } })),
      http.put(`${W}/channels/line-oa`, ok({ configured: true, webhookUrl: "https://api.example.com/api/v1/hooks/line/sample-ws", config: { channelId: "1650000001", channelSecretLast4: "ab12", accessTokenLast4: "cd34", fallbackToEmail: true, batchDigestMinutes: 30 } })),
      http.get(`${W}/channels/line-groups`, () => HttpResponse.json({ items: [{ id: "g1", name: "กลุ่มตัวอย่าง" }, { id: "g2", name: "กลุ่มสอง" }] })),
      http.get(`${W}/channels/email`, () => HttpResponse.json({ configured: true, mode: "friday", config: { fromName: "ทีมตัวอย่าง", fromEmail: "notify@example.com", replyTo: null, dns: { spf: true, dkim: false, dmarc: false }, verifiedAt: null } })),
      http.post(`${W}/channels/email/verify-dns`, ok({ configured: true, mode: "custom", config: { fromName: "ทีมตัวอย่าง", fromEmail: "notify@example.com", replyTo: null, dns: { spf: true, dkim: true, dmarc: true }, verifiedAt: "2026-11-06T03:00:00Z" } })),
      http.get(`${W}/channels/webhooks`, () => HttpResponse.json({ items: [{ id: "w1", name: "แจ้งเตือนทีมตัวอย่าง", format: "discord", urlLast4: "xxxx", signed: false, status: "active", consecutiveFailures: 3, usedBy: [{ projectKey: "DE", eventType: "bug.created" }] }] })),
      http.post(`${W}/channels/webhooks`, ok({ id: "w2", name: "ระบบภายในตัวอย่าง", format: "json", urlLast4: "hook", signed: true, status: "active", consecutiveFailures: 0, usedBy: [], signingSecret: "sample-signing-secret-000" }, 201)),
      http.patch(`${W}/channels/webhooks/:id`, ok()),
      http.post(`${W}/channels/webhooks/:id/test`, ok()),
    );
  });

  it("ช่องทางแจ้งเตือน: โหมดปลอดภัย · LINE ไม่ส่งช่องลับที่เว้นว่าง · DNS · Webhook แสดง signing secret ครั้งเดียว", async () => {
    const user = userEvent.setup();
    admin("notify");
    const safe = await screen.findByRole("switch", { name: "โหมดปลอดภัย (Safe mode)" });
    expect(safe).toHaveAttribute("aria-checked", "true");
    await user.click(safe);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/settings", body: { safeMode: false } }));
    expect(screen.getByRole("link", { name: "ดูตัวอย่างข้อความ" })).toHaveAttribute("href", "/work/sample/admin/notify-templates");

    const line = screen.getByRole("region", { name: "LINE Official Account" });
    expect(within(line).getByLabelText("Channel secret")).toHaveAttribute("placeholder", "•••• ab12");
    expect(await within(line).findByText("กลุ่ม LINE ที่เชิญ OA แล้ว 2 กลุ่ม")).toBeInTheDocument();
    const id = within(line).getByLabelText("Channel ID");
    await user.clear(id);
    await user.type(id, "1650000001");
    await user.selectOptions(within(line).getByLabelText(/รวมข้อความเล็กเป็นสรุป/), "30");
    await user.click(within(line).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/w/sample/channels/line-oa" }));
    expect(calls.at(-1)!.body).toEqual({ channelId: "1650000001", fallbackToEmail: true, batchDigestMinutes: 30 });

    const email = screen.getByRole("region", { name: "Email" });
    expect(within(email).getByText("รอยืนยันโดเมน")).toBeInTheDocument();
    expect(within(email).getAllByText("ยังไม่พบ")).toHaveLength(2);
    await user.click(within(email).getByRole("button", { name: "ตรวจ DNS อีกครั้ง" }));
    expect(await within(email).findByText("ยืนยันโดเมนแล้ว")).toBeInTheDocument();

    const hooks = screen.getByRole("region", { name: "Webhook ทั่วไป" });
    expect(await within(hooks).findByText("ล้มเหลว 3 ครั้ง")).toBeInTheDocument();
    await user.click(within(hooks).getByRole("button", { name: "ปิดชั่วคราว" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/channels/webhooks/w1", body: { status: "paused" } }));
    await user.click(within(hooks).getByRole("button", { name: "+ เพิ่ม Webhook" }));
    const add = await screen.findByRole("dialog", { name: "+ เพิ่ม Webhook" });
    await user.type(within(add).getByLabelText("ชื่อ"), "ระบบภายในตัวอย่าง");
    await user.selectOptions(within(add).getByLabelText("รูปแบบข้อความ"), "json");
    await user.type(within(add).getByLabelText("URL ปลายทาง"), "https://hooks.example.com/hook");
    await user.click(within(add).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/w/sample/channels/webhooks")!.body).toEqual({ name: "ระบบภายในตัวอย่าง", format: "json", url: "https://hooks.example.com/hook", generateSecret: true }));
    const secret = await screen.findByRole("dialog", { name: "Signing secret" });
    expect(within(secret).getByText("sample-signing-secret-000")).toBeInTheDocument();
    await user.click(within(secret).getByRole("button", { name: "เก็บไว้แล้ว ปิดหน้าต่าง" }));
    await waitFor(() => expect(screen.queryByText("sample-signing-secret-000")).not.toBeInTheDocument());
  });

  it("Integrations: GitHub · API token แสดงครั้งเดียวแล้วหาย · ยกเลิก token", async () => {
    server.use(
      http.get(`${W}/integrations/git`, () => HttpResponse.json({ configured: true, items: [{ id: "i1", provider: "github", accountName: "sample-org", status: "active", repositories: [{ id: "r1", fullName: "sample-org/app", projects: ["DE"] }] }] })),
      http.get(`${W}/api-tokens`, () => HttpResponse.json({ items: [{ id: "k1", name: "ระบบรายงานตัวอย่าง", scopes: ["read"], createdBy: { id: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง" }, createdAt: "2026-10-01T03:00:00Z", lastUsedAt: null, revoked: false }] })),
      http.post(`${W}/api-tokens`, ok({ id: "k2", name: "CI ตัวอย่าง", scopes: ["read", "write"], createdBy: null, createdAt: "2026-11-06T03:00:00Z", lastUsedAt: null, revoked: false, token: "fm_sample_token_value" }, 201)),
      http.delete(`${W}/api-tokens/:id`, ok({ revoked: true })),
    );
    const user = userEvent.setup();
    admin("integ");
    expect(await screen.findByText(/sample-org · 1 repos/)).toBeInTheDocument();
    expect(screen.getAllByText("เปิดให้ใช้ภายหลัง")).toHaveLength(2);
    expect(await screen.findByText("ระบบรายงานตัวอย่าง")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ สร้าง token" }));
    const dialog = await screen.findByRole("dialog", { name: "+ สร้าง token" });
    await user.type(within(dialog).getByLabelText("ชื่อ token"), "CI ตัวอย่าง");
    await user.click(within(dialog).getByRole("checkbox", { name: "อนุญาตให้เขียนข้อมูล (write)" }));
    await user.click(within(dialog).getByRole("button", { name: "สร้าง" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/api-tokens", body: { name: "CI ตัวอย่าง", scopes: ["read", "write"] } }));
    const once = await screen.findByRole("dialog", { name: "API token ใหม่" });
    expect(within(once).getByText("fm_sample_token_value")).toBeInTheDocument();
    await user.click(within(once).getByRole("button", { name: "เก็บไว้แล้ว ปิดหน้าต่าง" }));
    await waitFor(() => expect(screen.queryByText("fm_sample_token_value")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "ยกเลิก token" }));
    const confirm = await screen.findByRole("dialog", { name: "ยกเลิก token ระบบรายงานตัวอย่าง?" });
    await user.click(within(confirm).getByRole("button", { name: "ยกเลิก token" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/api-tokens/k1" }));
  });
});

describe("หน้าตาข้อความแจ้งเตือน (N2)", () => {
  const msg = (event: string, safe: boolean) => ({
    event,
    head: event === "bug.created" ? "Bug ใหม่ · Major" : "ผู้ใช้ตัวอย่าง ขอเลื่อนวันครบกำหนด",
    title: event === "bug.created" ? "DE-52 สถานะไม่กลับเป็น Draft" : "DE-30 แบบฟอร์มตัวอย่าง",
    project: "แผนพัฒนาผลิตภัณฑ์",
    rows: safe ? [] : [["ครบกำหนด", "2026-12-04"], ["เหตุผล", "รอยืนยันแบบฟอร์ม"]],
    note: "",
    buttons: [{ label: "อนุมัติ", url: "https://app.example.com/x" }, { label: "ปฏิเสธ", url: "https://app.example.com/y" }],
    color: "#B45309",
    url: "https://app.example.com/x",
    safe,
  });
  beforeEach(() => {
    server.use(
      http.get(`${W}/notification-templates/:event/preview`, async ({ request, params }) => {
        await record(request);
        const q = new URL(request.url).searchParams;
        const safe = q.has("safe") ? q.get("safe") === "true" : false;
        const m = msg(String(params.event), safe);
        const rendered = q.get("channel") === "email" ? { subject: `[Friday] ${m.head}: ${m.title}`, text: "", html: "" } : { event: m.event, workspace: "sample", title: m.title, ...(safe ? {} : { fields: Object.fromEntries(m.rows) }) };
        return HttpResponse.json({ event: m.event, channel: q.get("channel"), safeMode: safe, message: m, rendered });
      }),
    );
  });

  it("แสดง LINE / Email / Webhook ของเหตุการณ์ที่เลือก · สลับเหตุการณ์ · โหมดปลอดภัยซ่อนรายละเอียด", async () => {
    const user = userEvent.setup();
    admin("notify-templates");
    expect(await screen.findByRole("heading", { name: "หน้าตาข้อความแจ้งเตือน" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "เมนู Admin Console" })).not.toBeInTheDocument();
    const line = await screen.findByRole("figure", { name: "ตัวอย่างข้อความ LINE" });
    expect(within(line).getByText("ผู้ใช้ตัวอย่าง ขอเลื่อนวันครบกำหนด")).toBeInTheDocument();
    expect(within(line).getByText("อนุมัติ")).toBeInTheDocument();
    expect(within(line).getByText("รอยืนยันแบบฟอร์ม")).toBeInTheDocument();
    expect(within(screen.getByRole("figure", { name: "ตัวอย่างอีเมล" })).getByText("[Friday] ผู้ใช้ตัวอย่าง ขอเลื่อนวันครบกำหนด: DE-30 แบบฟอร์มตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByLabelText("Payload (รูปแบบ JSON)")).toHaveTextContent('"fields"');
    expect(calls.map((c) => c.path)).toContain("/w/sample/notification-templates/due_request.created/preview");
    expect(calls.find((c) => c.search.includes("webhook"))!.search).toBe("?channel=webhook&format=json");

    await user.click(screen.getByRole("button", { name: /Bug ใหม่/ }));
    expect(await screen.findAllByText("Bug ใหม่ · Major")).not.toHaveLength(0);

    await user.click(screen.getByRole("switch", { name: "โหมดปลอดภัย" }));
    await waitFor(() => expect(calls.at(-1)!.search).toContain("safe=true"));
    expect((await screen.findAllByText("รายละเอียดดูได้ในแอปหลังเข้าสู่ระบบ")).length).toBe(2);
    await waitFor(() => expect(screen.getByLabelText("Payload (รูปแบบ JSON)")).not.toHaveTextContent('"fields"'));
    // หน้านี้ดูอย่างเดียว ไม่บันทึกโหมดปลอดภัยของ Workspace
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Automation (P2)
// ---------------------------------------------------------------------------

const P = "*/api/v1/w/:ws/projects/:key";
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r1",
  name: "Sub-task ครบ → Review",
  trigger: "subtasks_done",
  triggerConfig: {},
  conditions: [{ field: "type", op: "eq", value: "Task", not: false }],
  actions: [{ type: "set_status", status: "Review" }],
  enabled: true,
  sentence: "เมื่อ Sub-task ทั้งหมดเสร็จ ถ้า ประเภทงาน เป็น Task ให้ เปลี่ยนสถานะเป็น Review",
  createdBy: { id: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง" },
  stats30d: { runs: 48, failed: 1, lastRunAt: "2026-11-05T03:00:00Z" },
  ...over,
});
const formOptions = {
  members: [{ id: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง", role: "admin" }, { id: "u-dev", displayName: "ผู้พัฒนาหนึ่ง", role: "member" }],
  labels: [{ id: "l1", name: "ล่าช้า" }],
  modules: [{ id: "m1", name: "Module A" }],
  issueTypes: [
    { id: "t1", name: "Task", statuses: [{ id: "s1", name: "To do" }, { id: "s2", name: "In progress" }, { id: "s3", name: "Review" }, { id: "s4", name: "Done" }] },
    { id: "t2", name: "Bug", statuses: [{ id: "b1", name: "Open" }, { id: "b2", name: "Done" }] },
  ],
};
let rules: Rule[];
const auto = () => mount(<AutomationPage ws="sample" projectKey="DE" />);

describe("Automation (P2)", () => {
  beforeEach(() => {
    rules = [rule(), rule({ id: "r2", name: "Bug Critical → Urgent", trigger: "issue_created", conditions: [], actions: [{ type: "set_priority", priority: "urgent" }], enabled: false, sentence: "เมื่อ งานถูกสร้าง ให้ ตั้ง Priority เป็น urgent", stats30d: { runs: 0, failed: 0, lastRunAt: null } })];
    server.use(
      http.get(`${P}/automations`, () => HttpResponse.json({ usage: { runsThisMonth: 312, quota: 1000 }, items: rules })),
      http.patch(`${P}/automations/:id`, async ({ request, params }) => {
        await record(request);
        const r = rules.find((x) => x.id === params.id)!;
        Object.assign(r, calls.at(-1)!.body);
        return HttpResponse.json(r);
      }),
      http.post(`${P}/automations`, async ({ request }) => {
        await record(request);
        const created = rule({ ...(calls.at(-1)!.body as object), id: "r9", sentence: "ประโยคจาก API", stats30d: { runs: 0, failed: 0, lastRunAt: null } });
        rules = [...rules, created];
        return HttpResponse.json(created, { status: 201 });
      }),
      http.delete(`${P}/automations/:id`, ok({ deleted: true })),
      http.post(`${P}/automations/:id/dry-run`, ok({ ruleId: "r1", sentence: "", checked: 12, matched: 1, items: [{ key: "DE-39", title: "ฟอร์มตัวอย่าง", status: "In progress", wouldDo: [{ action: "set_status", text: "เปลี่ยนสถานะเป็น Review" }] }], notes: ["ไม่มีการเปลี่ยนข้อมูลหรือส่งแจ้งเตือนจริง"] })),
      http.get(`${P}/automations/runs`, () => HttpResponse.json({ items: [
        { id: "x1", rule: { id: "r1", name: "Sub-task ครบ → Review" }, issueKeys: ["DE-22"], result: "success", depth: 0, detail: { steps: [{ action: "set_status", ok: true }] }, ranAt: "2026-12-01T11:05:00Z" },
        { id: "x2", rule: { id: "r1", name: "Sub-task ครบ → Review" }, issueKeys: ["DE-30"], result: "skipped", depth: 0, detail: { reason: "loop" }, ranAt: "2026-12-01T10:00:00Z" },
      ], nextCursor: null })),
      http.get("*/api/v1/w/:ws/automation-templates", () => HttpResponse.json({ items: [
        { id: "overdue-nudge", category: "ติดตาม", name: "เตือนงานเลย Due", description: "งานที่เลย Due แจ้งผู้รับผิดชอบ", rule: { name: "งานเลย Due → เตือน", trigger: "overdue", triggerConfig: {}, conditions: [], actions: [{ type: "add_label", label: "เลยกำหนด" }, { type: "notify", to: "assignees", message: "งานของคุณเลยกำหนดแล้ว" }] }, sentence: "" },
      ] })),
      http.get(`${P}/form-options`, () => HttpResponse.json(formOptions)),
    );
  });

  it("ไม่มีสิทธิ์ project.automation = ไม่มีสิทธิ์ · Error แสดงรหัสอ้างอิง", async () => {
    server.use(http.get(`${P}/my-permissions`, () => HttpResponse.json({ ...permissions, role: "member", permissions: ["project.view"] })));
    const a = auto();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    a.unmount();
    server.use(http.get(`${P}/my-permissions`, () => HttpResponse.json(permissions)), http.get(`${P}/automations`, () => errorBody(500)));
    auto();
    expect(await screen.findByText(/req_w18_001/)).toBeInTheDocument();
  });

  it("รายการกฎ: โควตาเดือนนี้ · สถิติ · เปิด/ปิดกฎ", async () => {
    const user = userEvent.setup();
    auto();
    expect(await screen.findByText("312 / 1000 ครั้ง")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "กฎของโปรเจกต์ (2)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("ผิดพลาด 1")).toBeInTheDocument();
    expect(screen.getByText(/ทำงาน 48 ครั้งใน 30 วัน/)).toBeInTheDocument();
    expect(screen.getByText(/ยังไม่เคยทำงาน/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "เปิดใช้กฎ Bug Critical → Urgent" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/automations/r2", body: { enabled: true }, ifMatch: null }));
  });

  it("แก้กฎ: เพิ่มเงื่อนไข / การกระทำ · ประโยคเปลี่ยนตาม · Dry run ต้องบันทึกก่อน · บันทึกแล้วทดสอบได้", async () => {
    const user = userEvent.setup();
    auto();
    const editor = await screen.findByRole("region", { name: "แก้ไขกฎ" });
    expect(within(editor).getByText(rule().sentence)).toBeInTheDocument();
    const dry = within(editor).getByRole("button", { name: "ทดสอบกับงานจริง" });
    expect(dry).toBeEnabled();
    await user.click(dry);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/automations/r1/dry-run", body: {} }));
    const status = await within(editor).findByRole("status");
    expect(status).toHaveTextContent("ตรงเงื่อนไข 1 จาก 12 งานที่ตรวจ");
    expect(status).toHaveTextContent("DE-39");

    await user.click(within(editor).getByRole("button", { name: "+ เพิ่มเงื่อนไข" }));
    await user.selectOptions(within(editor).getByLabelText("ฟิลด์ของเงื่อนไขที่ 2"), "priority");
    await user.selectOptions(within(editor).getByLabelText("คือ / ไม่ใช่ ของเงื่อนไขที่ 2"), "not");
    await user.selectOptions(within(editor).getByLabelText("ค่าของเงื่อนไขที่ 2"), "low");
    await user.click(within(editor).getByRole("button", { name: "+ เพิ่มการกระทำ" }));
    await user.selectOptions(within(editor).getByLabelText("ผู้รับแจ้งเตือนของการกระทำที่ 2"), "users");
    await user.selectOptions(within(editor).getByLabelText("คนที่รับแจ้งเตือนของการกระทำที่ 2"), "u-dev");
    await user.type(within(editor).getByLabelText("ค่าของการกระทำที่ 2"), "พร้อม Review แล้ว");
    expect(within(editor).getByText(/ถ้า ประเภทงาน เป็น Task และ Priority ไม่เป็น Low ให้ เปลี่ยนสถานะเป็น Review แล้ว แจ้งเตือน ผู้พัฒนาหนึ่ง/)).toBeInTheDocument();
    expect(dry).toBeDisabled();
    await user.click(within(editor).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/w/sample/projects/DE/automations/r1" }));
    expect(calls.at(-1)!.body).toEqual({
      name: "Sub-task ครบ → Review", trigger: "subtasks_done", triggerConfig: {}, enabled: true,
      conditions: [{ field: "type", op: "eq", value: "Task", not: false }, { field: "priority", op: "eq", value: "low", not: true }],
      actions: [{ type: "set_status", status: "Review" }, { type: "notify", to: "users", userIds: ["u-dev"], message: "พร้อม Review แล้ว" }],
    });
    expect(await screen.findByText("บันทึกกฎ Sub-task ครบ → Review แล้ว")).toBeInTheDocument();
  });

  it("สร้างกฎ → แม่แบบ → ฉบับร่างในตัวแก้ · บันทึกด้วย POST · ตามเวลาต้องระบุเวลา", async () => {
    const user = userEvent.setup();
    auto();
    await user.click(await screen.findByRole("button", { name: "+ สร้างกฎ" }));
    expect(screen.getByRole("tab", { name: "แม่แบบ" })).toHaveAttribute("aria-selected", "true");
    await user.click(await screen.findByRole("button", { name: "ใช้แม่แบบ เตือนงานเลย Due" }));
    const editor = await screen.findByRole("region", { name: "แก้ไขกฎ" });
    expect(within(editor).getByLabelText("ชื่อกฎ")).toHaveValue("งานเลย Due → เตือน");
    expect(within(editor).getByRole("button", { name: "ทดสอบกับงานจริง" })).toBeDisabled();
    expect(within(editor).getByText("บันทึกกฎก่อนจึงทดสอบกับงานจริงได้")).toBeInTheDocument();
    await user.selectOptions(within(editor).getByLabelText("เหตุการณ์"), "schedule");
    await user.selectOptions(within(editor).getByLabelText("ความถี่"), "weekly");
    await user.selectOptions(within(editor).getByLabelText("วัน"), "1");
    expect(within(editor).getByText(/เมื่อ ทุกวันจันทร์ เวลา 09:30/)).toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/automations" }));
    expect(calls.at(-1)!.body).toMatchObject({ name: "งานเลย Due → เตือน", trigger: "schedule", triggerConfig: { frequency: "weekly", time: "09:30", weekday: 1 }, enabled: true });
    expect(await screen.findByRole("tab", { name: "กฎของโปรเจกต์ (3)" })).toBeInTheDocument();
  });

  it("ลบกฎ · ประวัติการทำงานแสดงผลและเหตุผลที่ข้าม", async () => {
    const user = userEvent.setup();
    auto();
    const editor = await screen.findByRole("region", { name: "แก้ไขกฎ" });
    await user.click(within(editor).getByRole("button", { name: "ลบกฎ" }));
    await user.click(within(await screen.findByRole("dialog", { name: "ลบกฎ Sub-task ครบ → Review?" })).getByRole("button", { name: "ลบกฎ" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/w/sample/projects/DE/automations/r1" }));
    await user.click(screen.getByRole("tab", { name: "ประวัติการทำงาน" }));
    const table = await screen.findByRole("table", { name: "ประวัติการทำงาน" });
    expect(within(table).getByText("DE-22 · เปลี่ยนสถานะ")).toBeInTheDocument();
    expect(within(table).getByText("DE-30 · กันวนซ้ำ")).toBeInTheDocument();
    expect(within(table).getByText("ข้าม")).toBeInTheDocument();
  });

  it("toBody ตัดช่องว่าง / incomplete ปิดปุ่มบันทึก / ประโยคฉบับร่าง", () => {
    const draft = { name: " กฎ ", trigger: "status_changed" as const, triggerConfig: { from: "", to: "Done" }, conditions: [{ field: "assignee" as const, op: "empty" as const, value: "x", not: false }], actions: [{ type: "assign" as const, mode: "clear" as const, user: "" }], enabled: true };
    expect(toBody(draft)).toEqual({ name: "กฎ", trigger: "status_changed", triggerConfig: { to: "Done" }, conditions: [{ field: "assignee", op: "empty", not: false }], actions: [{ type: "assign", mode: "clear" }], enabled: true });
    expect(incomplete(draft)).toBe(false);
    expect(incomplete({ ...draft, actions: [{ type: "notify", to: "users", message: "x" }] })).toBe(true);
    expect(incomplete({ ...draft, trigger: "schedule", triggerConfig: { frequency: "daily" } })).toBe(true);
    const t = ((k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ""}`) as unknown as Parameters<typeof draftSentence>[2];
    expect(draftSentence(draft, null, t)).toContain("say_assign_clear");
  });
});
