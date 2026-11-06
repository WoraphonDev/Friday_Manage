// W10 · Members + Workload และสมาชิก Workspace · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions, workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import mw from "../../messages/th/members-workload.json";
import { MembersView } from "../../app/w/[ws]/p/[key]/members/_components/members-view";
import { WorkspaceMembers } from "../../app/w/[ws]/members/_components/workspace-members";
import { workloadRange } from "../../app/w/[ws]/p/[key]/members/_components/shared";
import type { Invitation, ProjectMember, Workload, WorkspaceMember } from "../../app/w/[ws]/p/[key]/members/_components/types";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const LEAD = "sample-lead";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Workload ตามช่วงที่ขอ · คนแรกเกิน capacity ทุกช่วง คนที่สองใช้ 60% */
function workload(url: URL): Workload {
  const from = url.searchParams.get("from")!;
  const to = url.searchParams.get("to")!;
  const unit = (url.searchParams.get("unit") ?? "md") as Workload["unit"];
  const group = (url.searchParams.get("group") ?? "week") as Workload["group"];
  const buckets: Workload["buckets"] = [];
  for (let s = from; s <= to; s = addDays(s, 7)) buckets.push({ start: s, end: addDays(s, 6) < to ? addDays(s, 6) : to });
  const k = unit === "hour" ? 8 : 1;
  const cell = (md: number) => ({ value: md * k, capacity: unit === "count" ? null : 5 * k, utilizationPct: Math.round((md / 5) * 100), over: md > 5, leaveDays: 0, issues: [{ key: "DE-7", title: "หน้าจอวงเงินตัวอย่าง", value: md * k }] });
  return {
    range: { from, to }, unit, group, hoursPerMd: 8, buckets,
    people: [
      { person: { id: U1, displayName: "ผู้พัฒนาหนึ่ง", initials: "ผ" }, position: "Frontend", projectRole: "member", capacityHoursWeek: 40, cells: buckets.map(() => cell(8)), total: { value: 8 * buckets.length * k, capacity: 5 * buckets.length * k, utilizationPct: 160, leaveDays: 0 } },
      { person: { id: U2, displayName: "ผู้พัฒนาสอง", initials: "ผ" }, position: "Backend", projectRole: "member", capacityHoursWeek: 40, cells: buckets.map(() => cell(3)), total: { value: 3 * buckets.length * k, capacity: 5 * buckets.length * k, utilizationPct: 60, leaveDays: 0 } },
    ],
    team: buckets.map(() => ({ value: 11 * k, capacity: 10 * k, utilizationPct: 110 })),
    thisWeek: { from, to: addDays(from, 6), people: 2, capacityMd: 10, assignedMd: 11, utilizationPct: 110, overloaded: [{ person: { id: U1, displayName: "ผู้พัฒนาหนึ่ง" }, utilizationPct: 160 }] },
    withoutBa: 4,
    unscheduled: { count: 3, noDates: 2, noEstimate: 1 },
  };
}
const member = (userId: string, displayName: string, over: Partial<ProjectMember> = {}): ProjectMember => ({
  userId, displayName, initials: displayName.slice(0, 1), avatarUrl: null, email: `${userId.slice(0, 4)}@example.com`, role: "member", isOwner: false, isGuest: false, active: true,
  position: "Developer", capacityHoursWeek: 40, capacityMdWeek: 5, openIssues: 3, overdueIssues: 1, openMd: 6, joinedAt: "2026-11-05T03:00:00Z", ...over,
});
const wsMember = (userId: string, displayName: string, over: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  userId, displayName, email: `${displayName === "หัวหน้าทีมตัวอย่าง" ? "lead" : userId.slice(0, 4)}@example.com`, role: "member", status: "active", jobTitle: "Developer", capacityHoursWeek: 40, lastActiveAt: "2026-11-01T03:00:00Z", ...over,
});
const invitation = (id: string, email: string, over: Partial<Invitation> = {}): Invitation => ({
  id, email, workspaceRole: "member", projectId: "sample-project", projectRole: "member", invitedBy: LEAD, expiresAt: "2026-12-30T00:00:00Z", createdAt: "2026-11-20T03:00:00Z", ...over,
});
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w10_001" } }, { status });

let urls: URL[];
let calls: { method: string; path: string; body: unknown; ifMatch: string | null }[];
let projectMembers: ProjectMember[];
let canManage: boolean;
let directory: WorkspaceMember[];
let invites: Invitation[];

const record = async (request: Request) => {
  const url = new URL(request.url);
  const text = await request.text();
  calls.push({ method: request.method, path: url.pathname.replace("/api/v1", ""), body: text ? JSON.parse(text) : undefined, ifMatch: request.headers.get("if-match") });
};

beforeEach(() => {
  urls = [];
  calls = [];
  canManage = true;
  projectMembers = [member(LEAD, "หัวหน้าทีมตัวอย่าง", { role: "admin", isOwner: true, openIssues: 0, overdueIssues: 0 }), member(U1, "ผู้พัฒนาหนึ่ง"), member(U2, "ผู้พัฒนาสอง", { overdueIssues: 0 })];
  directory = [wsMember(LEAD, "หัวหน้าทีมตัวอย่าง", { role: "owner" }), wsMember(U1, "ผู้พัฒนาหนึ่ง"), wsMember(U2, "ผู้พัฒนาสอง"), wsMember(U3, "ผู้ทดสอบสาม", { status: "deactivated", role: "guest", jobTitle: null, lastActiveAt: null })];
  invites = [invitation("inv-1", "pending-one@example.com"), invitation("inv-2", "client@example.com", { workspaceRole: "guest", projectRole: "viewer", projectId: null })];
  navigation.pathname = "/w/sample/p/DE/members";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/workload", ({ request }) => { const url = new URL(request.url); urls.push(url); return HttpResponse.json(workload(url)); }),
    http.get("*/api/v1/w/:ws/projects/:key/form-options", () => HttpResponse.json({ modules: [{ id: "m-a", name: "Module A" }] })),
    http.get("*/api/v1/w/:ws/projects/:key/members", () => HttpResponse.json({ items: projectMembers, canInvite: true, canManage })),
    http.patch("*/api/v1/w/:ws/projects/:key/members/:userId", async ({ request }) => { await record(request); return HttpResponse.json(projectMembers[1]); }),
    http.post("*/api/v1/w/:ws/projects/:key/members", async ({ request }) => { await record(request); return HttpResponse.json(projectMembers[1], { status: 201 }); }),
    http.delete("*/api/v1/w/:ws/projects/:key/members/:userId", async ({ request }) => { await record(request); return HttpResponse.json({ removed: true, reassigned: 3 }); }),
    http.get("*/api/v1/w/:ws/members", () => HttpResponse.json({ items: directory })),
    http.patch("*/api/v1/w/:ws/members/:userId", async ({ request }) => { await record(request); return HttpResponse.json({ ok: true }); }),
    http.get("*/api/v1/w/:ws/members/:userId/handover", () => HttpResponse.json({ member: { userId: U1, displayName: "ผู้พัฒนาหนึ่ง", role: "member" }, assignedIssues: { total: 2, items: [{ key: "DE-7", title: "หน้าจอวงเงินตัวอย่าง", project: "DE", planEnd: "2026-12-01" }, { key: "DE-8", title: "รายงานตัวอย่าง", project: "DE", planEnd: null }] }, ownedProjects: [] })),
    http.post("*/api/v1/w/:ws/members/:userId/:action", async ({ request, params }) => { await record(request); return HttpResponse.json({ userId: params.userId, status: params.action === "deactivate" ? "deactivated" : "active" }); }),
    http.get("*/api/v1/w/:ws/invitations", () => HttpResponse.json({ items: invites })),
    http.post("*/api/v1/w/:ws/invitations", async ({ request }) => {
      await record(request);
      const body = calls.at(-1)!.body as { emails: string[] };
      return HttpResponse.json({ items: body.emails.map((email, i) => ({ email, status: "invited", invitationId: `new-${i}`, inviteUrl: `http://localhost:3000/join/tok-${i}`, expiresAt: "2026-12-30T00:00:00Z" })) });
    }),
    http.post("*/api/v1/w/:ws/invitations/:id/:action", async ({ request, params }) => { await record(request); return HttpResponse.json(params.action === "resend" ? { id: params.id, inviteUrl: "http://localhost:3000/join/tok-new" } : { id: params.id, status: "revoked" }); }),
    http.post("*/api/v1/w/:ws/invite-links", async ({ request }) => { await record(request); return HttpResponse.json({ id: "lnk-1", role: "member", url: "http://localhost:3000/join/lnk_sample" }, { status: 201 }); }),
    http.get("*/api/v1/w/:ws/usage", () => HttpResponse.json({ seats: { used: 3, limit: 10 } })),
    http.get("*/api/v1/w/:ws/issues/:key", ({ params }) => HttpResponse.json({ key: params.key, assigneeIds: [U1, U2], version: 4 }, { headers: { ETag: '"4"' } })),
    http.put("*/api/v1/w/:ws/issues/:key/assignees", async ({ request }) => { await record(request); return HttpResponse.json({ ok: true }); }),
  );
});
const mount = (ui: React.ReactElement) => renderWithProviders(<WorkspaceShell ws="sample">{ui}</WorkspaceShell>, { messages: { "members-workload": mw } });
const asRole = (role: "owner" | "admin" | "member" | "guest") =>
  server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role }, workspaces[1]] })));

describe("Workload รายสัปดาห์ (หน้า 7)", () => {
  it("ค่าเริ่มต้น 8 สัปดาห์เป็น MD · KPI · เกิน capacity · กดแท่งเพื่อดูงาน", async () => {
    const user = userEvent.setup();
    mount(<MembersView ws="sample" projectKey="DE" />);
    const bar = (await screen.findAllByRole("button", { name: /^ผู้พัฒนาหนึ่ง .* 8 จาก 5$/ }))[0];
    const first = urls[0];
    expect(Object.fromEntries(first.searchParams)).toMatchObject({ group: "week", unit: "md", ...workloadRange("week", first.searchParams.get("from")!, 0) });
    expect(screen.getByText("10 MD")).toBeInTheDocument();
    expect(screen.getByText("Utilization 110%")).toBeInTheDocument();
    expect(screen.getByText("1 คน")).toBeInTheDocument();
    expect(screen.getByText("ผู้พัฒนาหนึ่ง 160%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ยังไม่มี BA · ระบุ BA →" })).toHaveAttribute("href", "/w/sample/p/DE/table");
    expect(screen.getByText("ไม่มีวันในแผน 2 · ไม่มี Man-Day 1")).toBeInTheDocument();
    expect(screen.getByText("เฉลี่ย 160%")).toHaveClass(/up/);
    expect(bar.className).toMatch(/over/);
    expect(screen.getAllByRole("button", { name: /^ผู้พัฒนาสอง .* 3 จาก 5$/ })[0].className).toMatch(/low/);

    await user.click(bar);
    const detail = screen.getByRole("complementary", { name: "รายละเอียดช่วงที่เลือก" });
    expect(within(detail).getByRole("link", { name: "หน้าจอวงเงินตัวอย่าง" })).toHaveAttribute("href", "/w/sample/p/DE/members?issue=DE-7");
    expect(within(detail).getByText("8 / 5 MD (160%)")).toBeInTheDocument();
  });

  it("เปลี่ยนหน่วยเป็นชั่วโมง, รายเดือน, ตำแหน่ง, Module และเลื่อนช่วง", async () => {
    const user = userEvent.setup();
    mount(<MembersView ws="sample" projectKey="DE" />);
    await screen.findAllByRole("button", { name: /8 จาก 5$/ });
    await user.selectOptions(screen.getByLabelText("หน่วย Workload"), "hour");
    await screen.findAllByRole("button", { name: /64 จาก 40$/ });
    expect(urls.at(-1)!.searchParams.get("unit")).toBe("hour");
    await user.selectOptions(screen.getByLabelText("ตำแหน่ง"), "Backend");
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("position")).toBe("Backend"));
    await user.selectOptions(screen.getByLabelText("Module"), "m-a");
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("moduleId")).toBe("m-a"));
    await user.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("group")).toBe("month"));
    expect(urls.at(-1)!.searchParams.get("from")!.endsWith("-01")).toBe(true);
    const before = urls.at(-1)!.searchParams.get("from")!;
    await user.click(screen.getByRole("button", { name: "ช่วงถัดไป" }));
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("from")! > before).toBe(true));
  });

  it("ย้ายงานให้คนอื่นจากรายละเอียดช่วง: ใช้ assignees ล่าสุด + If-Match", async () => {
    const user = userEvent.setup();
    mount(<MembersView ws="sample" projectKey="DE" />);
    await user.click((await screen.findAllByRole("button", { name: /^ผู้พัฒนาหนึ่ง .* 8 จาก 5$/ }))[0]);
    await user.selectOptions(screen.getByLabelText("เปลี่ยนผู้รับผิดชอบ หน้าจอวงเงินตัวอย่าง"), LEAD);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/w/sample/issues/DE-7/assignees", ifMatch: '"4"', body: { assigneeIds: [U2, LEAD] } });
    expect(await screen.findByText("ย้าย DE-7 ให้ หัวหน้าทีมตัวอย่าง แล้ว")).toBeInTheDocument();
  });

  it("ไม่มีสมาชิกที่นับได้ = ว่าง · Error มี requestId · 403", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/workload", ({ request }) => HttpResponse.json({ ...workload(new URL(request.url)), people: [] })));
    const view = mount(<MembersView ws="sample" projectKey="DE" />);
    expect(await screen.findByText("ยังไม่มีสมาชิกที่นับ Workload ได้")).toBeInTheDocument();
    view.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/members", () => errorBody(500)));
    const failed = mount(<MembersView ws="sample" projectKey="DE" />);
    expect(await screen.findByText("รหัสอ้างอิง: req_w10_001")).toBeInTheDocument();
    failed.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/members", () => errorBody(403)));
    mount(<MembersView ws="sample" projectKey="DE" />);
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
  });

  it("กำลังโหลด · Guest ที่เป็น Viewer = 403 โดยไม่เรียก API สมาชิก", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "viewer", guestViewer: true, permissions: ["project.view"] })));
    mount(<MembersView ws="sample" projectKey="DE" />);
    expect(screen.getAllByLabelText("กำลังโหลด…").length).toBeGreaterThan(0);
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(urls).toHaveLength(0);
  });
});

describe("Members ของโปรเจกต์", () => {
  it("ตาราง: Owner, Capacity, Open/Overdue, สัปดาห์นี้ · เปลี่ยน Role", async () => {
    const user = userEvent.setup();
    mount(<MembersView ws="sample" projectKey="DE" />);
    const row = await screen.findByTestId(`member-${U1}`);
    expect(within(screen.getByTestId(`member-${LEAD}`)).getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByLabelText("Project role ของ หัวหน้าทีมตัวอย่าง")).not.toBeInTheDocument();
    expect(within(row).getByText("40 ชม. · 5 MD/สัปดาห์")).toBeInTheDocument();
    expect(await within(row).findByText("8/5 MD")).toHaveClass(/up/);
    expect(screen.getByRole("link", { name: "Members (3)" })).toBeInTheDocument();
    await user.selectOptions(within(row).getByLabelText("Project role ของ ผู้พัฒนาหนึ่ง"), "viewer");
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", path: `/w/sample/projects/DE/members/${U1}`, body: { role: "viewer" } }));
    expect(await screen.findByText("เปลี่ยน Role ของ ผู้พัฒนาหนึ่ง เป็น Viewer แล้ว")).toBeInTheDocument();
  });

  it("แก้ Capacity และนำออกพร้อมโอนงาน (P3)", async () => {
    const user = userEvent.setup();
    mount(<MembersView ws="sample" projectKey="DE" />);
    await user.click(await screen.findByRole("button", { name: "ตัวเลือกของ ผู้พัฒนาหนึ่ง" }));
    const dialog = screen.getByRole("dialog", { name: "จัดการ ผู้พัฒนาหนึ่ง" });
    await user.clear(within(dialog).getByLabelText("Capacity (ชม./สัปดาห์)"));
    await user.type(within(dialog).getByLabelText("Capacity (ชม./สัปดาห์)"), "24");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", body: { position: "Developer", capacityHoursWeek: 24 } }));

    await user.click(screen.getByRole("button", { name: "ตัวเลือกของ ผู้พัฒนาหนึ่ง" }));
    const again = screen.getByRole("dialog", { name: "จัดการ ผู้พัฒนาหนึ่ง" });
    expect(within(again).getByText("งานค้าง 3 งาน · 6 MD")).toBeInTheDocument();
    await user.selectOptions(within(again).getByLabelText("โอนงานให้"), U2);
    await user.click(within(again).getByRole("button", { name: "นำออกจากโปรเจกต์" }));
    await waitFor(() => expect(calls[1]).toMatchObject({ method: "DELETE", path: `/w/sample/projects/DE/members/${U1}`, body: { reassignTo: U2 } }));
    expect(await screen.findByText("นำ ผู้พัฒนาหนึ่ง ออกจากโปรเจกต์แล้ว · โอน 3 งาน")).toBeInTheDocument();
  });

  it("ไม่มีสิทธิ์ตั้งค่า = ไม่มีช่องเปลี่ยน Role และปุ่ม ⋯", async () => {
    canManage = false;
    mount(<MembersView ws="sample" projectKey="DE" />);
    await screen.findByTestId(`member-${U1}`);
    expect(screen.queryByLabelText("Project role ของ ผู้พัฒนาหนึ่ง")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ตัวเลือกของ ผู้พัฒนาหนึ่ง" })).not.toBeInTheDocument();
  });

  it("เชิญหลายอีเมล: คนใน Workspace เพิ่มตรง คนนอกได้คำเชิญพร้อมลิงก์ · อีเมลผิดรูปแบบ", async () => {
    const user = userEvent.setup();
    mount(<MembersView ws="sample" projectKey="DE" />);
    const field = await screen.findByLabelText("อีเมล (คั่นด้วย , ได้หลายคน)");
    await user.type(field, "bad-email, new@example.com");
    await user.click(screen.getByRole("button", { name: "ส่งคำเชิญ (2)" }));
    expect(screen.getByText("bad-email รูปแบบอีเมลไม่ถูกต้อง")).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await user.clear(field);
    await user.type(field, `new@example.com, ${U2.slice(0, 4)}@example.com, other@example.com`);
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(screen.getByRole("button", { name: "ส่งคำเชิญ (3)" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({ method: "POST", path: "/w/sample/projects/DE/members", body: { userId: U2, role: "viewer", capacityHoursWeek: 40 } });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/w/sample/invitations", body: { emails: ["new@example.com", "other@example.com"], projectKey: "DE", projectRole: "viewer", workspaceRole: "member" } });
    expect(await screen.findByText("http://localhost:3000/join/tok-0")).toBeInTheDocument();
    expect(screen.getByText("ส่งคำเชิญ 2 อีเมลแล้ว · เพิ่มสมาชิก Workspace เข้าโปรเจกต์ 1 คน")).toBeInTheDocument();
  });

  it("คำเชิญที่รอของโปรเจกต์นี้: Resend / Cancel · Member ของ Workspace ไม่เห็นรายการ", async () => {
    const user = userEvent.setup();
    const view = mount(<MembersView ws="sample" projectKey="DE" />);
    const row = await screen.findByTestId("invite-inv-1");
    expect(screen.queryByTestId("invite-inv-2")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invitations (1)" })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "POST", path: "/w/sample/invitations/inv-1/resend" }));
    expect(await screen.findByText("http://localhost:3000/join/tok-new")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("invite-inv-1")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls[1]).toMatchObject({ path: "/w/sample/invitations/inv-1/revoke" }));
    view.unmount();

    asRole("member");
    mount(<MembersView ws="sample" projectKey="DE" />);
    expect(await screen.findByText("เฉพาะ Owner / Admin ของ Workspace ที่เห็นรายการคำเชิญ")).toBeInTheDocument();
  });
});

describe("สมาชิก Workspace (หน้า H)", () => {
  beforeEach(() => {
    navigation.pathname = "/w/sample/members";
  });

  it("KPI, แท็บสถานะ, โปรเจกต์ของแต่ละคน, ตัวกรอง และคำเชิญที่รอ", async () => {
    const user = userEvent.setup();
    mount(<WorkspaceMembers ws="sample" />);
    expect(await screen.findByText("Workspace members")).toBeInTheDocument();
    expect(await screen.findByText("3 / 10")).toBeInTheDocument();
    const tabs = screen.getByRole("group", { name: "สถานะสมาชิก" });
    expect(within(tabs).getByRole("button", { name: "ทั้งหมด 6" })).toHaveAttribute("aria-pressed", "true");
    expect(await within(await screen.findByTestId(`row-${U1}`)).findByText("แผนพัฒนาผลิตภัณฑ์")).toBeInTheDocument();
    expect(within(screen.getByTestId("row-inv-2")).getByText("รอตอบรับ")).toBeInTheDocument();

    await user.click(within(tabs).getByRole("button", { name: "ปิดการใช้งาน 1" }));
    expect(screen.getByTestId(`row-${U3}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`row-${U1}`)).not.toBeInTheDocument();
    await user.click(within(tabs).getByRole("button", { name: "ทั้งหมด 6" }));
    await user.type(screen.getByLabelText("ค้นหาสมาชิก"), "client");
    expect(screen.getByTestId("row-inv-2")).toBeInTheDocument();
    expect(screen.queryByTestId("row-inv-1")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("ค้นหาสมาชิก"));
    await user.selectOptions(screen.getByLabelText("Role"), "guest");
    expect(screen.queryByTestId(`row-${U1}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`row-${U3}`)).toBeInTheDocument();
  });

  it("เปลี่ยน Workspace role · Owner ของตัวเองแก้ไม่ได้ · Resend คำเชิญ", async () => {
    const user = userEvent.setup();
    mount(<WorkspaceMembers ws="sample" />);
    await screen.findByTestId(`row-${U1}`);
    expect(screen.queryByLabelText("Workspace role ของ หัวหน้าทีมตัวอย่าง")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Workspace role ของ ผู้พัฒนาหนึ่ง"), "admin");
    await waitFor(() => expect(calls[0]).toMatchObject({ method: "PATCH", path: `/w/sample/members/${U1}`, body: { role: "admin" } }));
    expect(await screen.findByText("เปลี่ยน Role ของ ผู้พัฒนาหนึ่ง เป็น Admin แล้ว")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("row-inv-1")).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(calls[1]).toMatchObject({ path: "/w/sample/invitations/inv-1/resend" }));
  });

  it("เชิญหลายอีเมล (chip) + Role + เพิ่มเข้าโปรเจกต์ + ลิงก์เชิญ", async () => {
    const user = userEvent.setup();
    mount(<WorkspaceMembers ws="sample" />);
    await user.click(await screen.findByRole("button", { name: "+ เชิญสมาชิก" }));
    const dialog = screen.getByRole("dialog", { name: "เชิญสมาชิกเข้า Workspace" });
    const input = within(dialog).getByLabelText("เพิ่มอีเมล");
    await user.type(input, "oat@example.com{Enter}pim@example.com,kan@examplecom ");
    expect(within(dialog).getByText("kan@examplecom รูปแบบอีเมลไม่ถูกต้อง")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "ลบ kan@examplecom" }));
    await user.click(within(dialog).getByRole("button", { name: /^Guest/ }));
    await user.selectOptions(within(dialog).getByLabelText("เพิ่มเข้าโปรเจกต์ (ไม่บังคับ)"), "DE");
    expect(within(dialog).getByLabelText("Project role")).toBeDisabled();
    await user.type(within(dialog).getByLabelText("ข้อความถึงผู้ได้รับเชิญ"), "ยินดีต้อนรับ");
    await user.click(within(dialog).getByRole("button", { name: "สร้างลิงก์" }));
    expect(await within(dialog).findByText("http://localhost:3000/join/lnk_sample")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ path: "/w/sample/invite-links", body: { role: "guest", expiresInDays: 7 } });
    await user.click(within(dialog).getByRole("button", { name: "ส่งคำเชิญ (2)" }));
    await waitFor(() => expect(calls[1]).toMatchObject({
      path: "/w/sample/invitations",
      body: { emails: ["oat@example.com", "pim@example.com"], workspaceRole: "guest", projectKey: "DE", projectRole: "viewer", capacityHoursWeek: 40, message: "ยินดีต้อนรับ", expiresInDays: 7 },
    }));
    expect(await within(dialog).findByText("http://localhost:3000/join/tok-1")).toBeInTheDocument();
  });

  it("ปิดการใช้งานพร้อมโอนงาน (P3) แล้วเปิดใช้งานอีกครั้ง", async () => {
    const user = userEvent.setup();
    mount(<WorkspaceMembers ws="sample" />);
    await user.click(await screen.findByRole("button", { name: "ตัวเลือกของ ผู้พัฒนาหนึ่ง" }));
    const dialog = screen.getByRole("dialog", { name: "ปิดการใช้งาน ผู้พัฒนาหนึ่ง" });
    expect(await within(dialog).findByText("โอนงานที่ยังไม่เสร็จ (2 งาน)")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("โอนงานให้"), U2);
    await user.click(within(dialog).getByRole("button", { name: "ปิดการใช้งาน" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/w/sample/issues/DE-7/assignees", ifMatch: '"4"', body: { assigneeIds: [U2] } });
    expect(calls[1]).toMatchObject({ path: "/w/sample/issues/DE-8/assignees" });
    expect(calls[2]).toMatchObject({ method: "POST", path: `/w/sample/members/${U1}/deactivate` });
    expect(await screen.findByText("ปิดการใช้งาน ผู้พัฒนาหนึ่ง แล้ว")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ตัวเลือกของ ผู้ทดสอบสาม" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "เปิดใช้งานอีกครั้ง" }));
    await waitFor(() => expect(calls[3]).toMatchObject({ path: `/w/sample/members/${U3}/reactivate` }));
  });

  it("Member เห็นรายชื่อแต่จัดการไม่ได้ · Guest = 403 · Error มี requestId", async () => {
    asRole("member");
    const view = mount(<WorkspaceMembers ws="sample" />);
    await screen.findByTestId(`row-${U1}`);
    expect(screen.queryByRole("button", { name: "+ เชิญสมาชิก" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace role ของ ผู้พัฒนาหนึ่ง")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ตัวเลือกของ ผู้พัฒนาหนึ่ง" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-inv-1")).not.toBeInTheDocument();
    view.unmount();

    asRole("guest");
    const guest = mount(<WorkspaceMembers ws="sample" />);
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    guest.unmount();

    asRole("owner");
    server.use(http.get("*/api/v1/w/:ws/members", () => errorBody(500)));
    mount(<WorkspaceMembers ws="sample" />);
    expect(await screen.findByText("รหัสอ้างอิง: req_w10_001")).toBeInTheDocument();
  });
});
