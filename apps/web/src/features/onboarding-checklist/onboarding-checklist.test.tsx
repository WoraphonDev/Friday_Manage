// W25 · การ์ดเริ่มต้นใช้งานบน Home · ปุ่มท้าย Sidebar · รายการของสมาชิก · ครบแล้ว · มือถือ · ข้อมูลสมมติเท่านั้น
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import { http, HttpResponse, delay } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { workspaces } from "@/test/fixtures";
import { asMobile } from "@/test/mobile";
import { renderWithProviders } from "@/test/render";
import { router } from "@/test/router";
import { server } from "@/test/server";
import { OnboardingHomeCard } from "./home-card";
import type { Checklist, OnboardingStep } from "./use-onboarding";

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const step = (key: string, over: Partial<OnboardingStep> = {}): OnboardingStep => ({ key, title: key, done: false, doneAt: null, current: 0, target: 1, action: null, detail: null, ...over });

function ownerData(over: Partial<Checklist> = {}): Checklist {
  return {
    scope: "workspace", version: 1, eligible: true, doneCount: 3, total: 6, next: "team", completed: false, hidden: false, never: false, completionSeen: false,
    steps: [
      step("first_project", { done: true, doneAt: ago(3), current: 1, action: { kind: "new_project", path: "new-project" }, detail: { projectKey: "OMA", projectName: "Orbit Mobile App" } }),
      step("issues", { done: true, doneAt: ago(2), current: 12, target: 10, action: { kind: "import", path: "import" } }),
      step("team", { current: 1, target: 2, action: { kind: "invite", path: "members" }, detail: { pendingInvites: ["qa@orbit.example"], pendingCount: 1 } }),
      step("assign_due", { current: 2, target: 5, action: { kind: "table", path: "p/OMA/table" } }),
      step("status_update", { done: true, doneAt: ago(1), current: 3, action: { kind: "kanban", path: "p/OMA/board" } }),
      step("notifications", { action: { kind: "notify_settings", path: "profile?tab=notify" } }),
    ],
    ...over,
  };
}
function memberData(over: Partial<Checklist> = {}): Checklist {
  return {
    scope: "member", version: 1, eligible: true, doneCount: 1, total: 3, next: "open_assigned", completed: false, hidden: false, never: false, completionSeen: false, invitedBy: { name: "ปิยะ" },
    steps: [
      step("profile", { done: true, doneAt: ago(0), current: 1, action: { kind: "profile_hours", path: "profile?tab=hours" }, detail: { avatar: true, hours: true } }),
      step("open_assigned", { action: { kind: "open_issue", path: "p/OMA?issue=OMA-112" }, detail: { issueKey: "OMA-112", title: "ออกแบบหน้าชำระเงิน" } }),
      step("notify_channel", { action: { kind: "notify_settings", path: "profile?tab=notify" } }),
    ],
    ...over,
  };
}

/** ให้ API ตอบตามสถานะปัจจุบัน และบันทึกคำขอที่แก้ข้อมูล */
function serve(initial: Checklist | { scope: string; version: number; eligible: false }, opts: { status?: number; wait?: boolean } = {}) {
  const state = { data: initial, posts: [] as { path: string; body: unknown }[], gets: 0 };
  server.use(
    // แบนเนอร์แพ็กเกจ / เอกสารกฎหมายของ shell ไม่เกี่ยวกับงานนี้
    http.get("*/api/v1/w/:ws/usage", () => HttpResponse.json({ error: { code: "not_found", message: "ไม่พบ" } }, { status: 404 })),
    http.get("*/api/v1/me/legal-acceptances", () => HttpResponse.json({ items: [] })),
    http.get("*/api/v1/w/:ws/onboarding", async () => {
      state.gets++;
      if (opts.wait) await delay("infinite");
      if (opts.status) return HttpResponse.json({ error: { code: "internal_error", message: "ผิดพลาด" } }, { status: opts.status });
      return HttpResponse.json(state.data);
    }),
    http.post("*/api/v1/w/:ws/:action", async ({ request, params }) => {
      const action = String(params.action);
      state.posts.push({ path: action, body: await request.json().catch(() => null) });
      const d = state.data as Checklist;
      if (action === "onboarding:hide") state.data = { ...d, hidden: true };
      if (action === "onboarding:show") state.data = { ...d, hidden: false, never: false };
      if (action === "onboarding:never") state.data = { ...d, never: true };
      if (action === "onboarding:complete-seen") state.data = { ...d, completionSeen: true };
      const n = state.data as Checklist;
      return HttpResponse.json({ hidden: n.hidden, never: n.never, completionSeen: n.completionSeen, recorded: true });
    }),
  );
  return state;
}

const mount = (ws = "sample", role: "owner" | "member" | "guest" = "owner") =>
  renderWithProviders(
    <WorkspaceShell ws={ws}>
      <OnboardingHomeCard ws={ws} role={role} />
    </WorkspaceShell>,
  );
const card = () => screen.findByRole("region", { name: /เริ่มต้นใช้งาน ทีมตัวอย่าง|เริ่มใช้งานในทีม/ });
const sidebar = () => document.querySelector<HTMLElement>("aside.sidebar")!;

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("การ์ดบน Home (V1) · Owner / Admin", () => {
  it("6 ขั้น · ที่เสร็จขีดฆ่า · ขั้นถัดไปกรอบม่วงพร้อมปุ่มหลัก · ตัวเลขประกอบ · คำเชิญค้าง · กล่องทำไมต้องชวนทีม", async () => {
    serve(ownerData());
    mount();
    const c = await card();
    expect(within(c).getByText("3 / 6")).toBeInTheDocument();
    expect(within(c).getByRole("progressbar", { name: "ทำแล้ว 3 จาก 6 ขั้น" })).toHaveAttribute("aria-valuenow", "3");
    const rows = within(c).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveTextContent("1. สร้าง Workspace และโปรเจกต์แรก");
    expect(rows[0]).toHaveTextContent("ทำแล้ว · Orbit Mobile App");
    expect(rows[1]).toHaveTextContent("12 / 10 งาน · หรือนำเข้าแผนจาก Excel");
    expect(rows[4]).toHaveTextContent("ทำแล้วเมื่อวาน");
    // ขั้นที่เสร็จไม่มีปุ่ม · ขั้นถัดไปปุ่มหลัก · ขั้นอื่นปุ่มรอง
    expect(within(rows[0]).queryByRole("link")).toBeNull();
    expect(rows[2]).toHaveAttribute("aria-current", "step");
    expect(rows[2]).toHaveTextContent("1 / 2 คน · qa@orbit.example ยังไม่ตอบรับคำเชิญ");
    const invite = within(rows[2]).getByRole("link", { name: "เชิญสมาชิก" });
    expect(invite).toHaveAttribute("href", "/work/sample/members");
    expect(invite.className).toContain("button-primary");
    expect(within(rows[3]).getByRole("link", { name: "เปิด Table" })).toHaveAttribute("href", "/work/sample/p/OMA/table");
    expect(within(rows[3]).getByRole("link", { name: "เปิด Table" }).className).toContain("button-secondary");
    expect(within(rows[5]).getByRole("link", { name: "ตั้งค่าแจ้งเตือน" })).toHaveAttribute("href", "/work/sample/profile?tab=notify");
    const why = within(c).getByRole("complementary", { name: "ทำไมต้องชวนทีม" });
    expect(within(why).getByRole("button", { name: "ดูโปรเจกต์ตัวอย่าง" })).toBeInTheDocument();
    // คู่มือเปิดหมวดเริ่มต้นของศูนย์ช่วยเหลือ (W26) · ถาม Support ไปฟอร์มในแอปพร้อมหัวข้อ
    expect(within(why).getByRole("link", { name: "คู่มือเริ่มต้นใช้งาน" })).toHaveAttribute("href", "/work/sample/help?category=getting-started");
    const ask = new URL(within(why).getByRole("link", { name: "ถามทีม Support" }).getAttribute("href")!, "http://x");
    expect(ask.pathname).toBe("/work/sample/help/contact");
    expect(ask.searchParams.get("subject")).toBe("ขอความช่วยเหลือการเริ่มใช้งาน (sample)");
  });

  it("ดูโปรเจกต์ตัวอย่าง: ยังไม่มีก็สร้างให้แล้วเปิด", async () => {
    serve(ownerData());
    const posts: string[] = [];
    server.use(http.post("*/api/v1/w/:ws/projects/sample", () => (posts.push("sample"), HttpResponse.json({ key: "CAFE" }, { status: 201 }))));
    mount();
    await userEvent.click(within(await card()).getByRole("button", { name: "ดูโปรเจกต์ตัวอย่าง" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/work/sample/p/CAFE"));
    expect(posts).toEqual(["sample"]);
  });

  it("ซ่อนต่อคน → ปุ่มท้าย Sidebar ยังอยู่ (V2) · Popover แสดงรายการย่อและ \"แสดงบน Home อีกครั้ง\"", async () => {
    const state = serve(ownerData());
    mount();
    await userEvent.click(within(await card()).getByRole("button", { name: "ซ่อน" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /เริ่มต้นใช้งาน ทีมตัวอย่าง/ })).toBeNull());
    expect(state.posts.map((p) => p.path)).toEqual(["onboarding:hide"]);
    expect(await screen.findByText(/ซ่อนการ์ดแล้ว/)).toBeInTheDocument();
    const navButton = within(sidebar()).getByRole("button", { name: "เริ่มต้นใช้งาน 3/6" });
    await userEvent.click(navButton);
    const pop = await screen.findByRole("dialog", { name: "เริ่มต้นใช้งาน" });
    expect(within(pop).getByText("ถัดไป: ชวนทีม")).toBeInTheDocument();
    expect(within(pop).getAllByRole("listitem")).toHaveLength(6);
    await userEvent.click(within(pop).getByRole("button", { name: "แสดงบน Home อีกครั้ง" }));
    expect(await card()).toBeInTheDocument();
    expect(state.posts.map((p) => p.path)).toEqual(["onboarding:hide", "onboarding:show"]);
  });

  it("ไม่ต้องแสดงอีก → ปุ่ม Sidebar หาย · เมนูบัญชีมี \"เริ่มต้นใช้งาน 3/6\" กดแล้วเปิดกลับและไปที่ Home (V4)", async () => {
    const state = serve(ownerData());
    mount();
    await card();
    await userEvent.click(within(sidebar()).getByRole("button", { name: "เริ่มต้นใช้งาน 3/6" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "เริ่มต้นใช้งาน" })).getByRole("button", { name: "ไม่ต้องแสดงอีก" }));
    await waitFor(() => expect(within(sidebar()).queryByRole("button", { name: /เริ่มต้นใช้งาน/ })).toBeNull());
    expect(screen.queryByRole("region", { name: /เริ่มต้นใช้งาน ทีมตัวอย่าง/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "เมนูบัญชี" }));
    const item = await screen.findByRole("button", { name: /เริ่มต้นใช้งาน\s*3\/6/ });
    await userEvent.click(item);
    await waitFor(() => expect(state.posts.map((p) => p.path)).toEqual(["onboarding:never", "onboarding:show"]));
    expect(router.push).toHaveBeenCalledWith("/work/sample");
    expect(await card()).toBeInTheDocument();
  });

  it("ดึงใหม่เมื่อกลับมาที่หน้า (refetch on focus): ขั้นที่เพิ่งทำเสร็จขึ้นเอง", async () => {
    const state = serve(ownerData());
    mount();
    await card();
    state.data = ownerData({ doneCount: 4, next: "assign_due", steps: ownerData().steps.map((s) => (s.key === "team" ? { ...s, done: true, doneAt: ago(0), current: 2, detail: null } : s)) });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(await screen.findByText("4 / 6")).toBeInTheDocument();
    act(() => focusManager.setFocused(undefined));
  });
});

describe("สถานะ", () => {
  it("กำลังโหลด: ไม่แสดงอะไร (ไม่ดันเนื้อหา Home) · Error: เงียบ ซ่อนการ์ดและปุ่ม", async () => {
    const state = serve(ownerData(), { wait: true });
    const { unmount } = mount();
    await waitFor(() => expect(state.gets).toBeGreaterThan(0));
    expect(screen.queryByRole("region", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
    unmount();
    const failing = serve(ownerData(), { status: 500 });
    mount();
    await waitFor(() => expect(failing.gets).toBeGreaterThan(0));
    await waitFor(() => expect(sidebar()).toBeTruthy());
    expect(screen.queryByRole("region", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Workspace เก่าที่ใช้จริงแล้ว (eligible: false) ไม่แสดงอะไรเลย", async () => {
    const state = serve({ scope: "workspace", version: 1, eligible: false });
    mount();
    await waitFor(() => expect(state.gets).toBeGreaterThan(0));
    await waitFor(() => expect(sidebar()).toBeTruthy());
    expect(screen.queryByRole("region", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
  });

  it("Guest ไม่เห็นและไม่เรียก API", async () => {
    const state = serve(ownerData());
    server.use(http.get("*/api/v1/me/workspaces", () => HttpResponse.json({ items: [{ ...workspaces[0], role: "guest" }] })));
    mount("sample", "guest");
    await waitFor(() => expect(sidebar()).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    expect(state.gets).toBe(0);
    expect(screen.queryByRole("region", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
  });

  it("ครบ 6 ขั้น: การ์ดเขียวแสดงครั้งเดียว (บันทึกว่าเห็นแล้ว) · ปุ่ม Sidebar หาย · กดปิดแล้วหาย", async () => {
    const done = ownerData({ doneCount: 6, next: null, completed: true, steps: ownerData().steps.map((s) => ({ ...s, done: true, doneAt: ago(0) })) });
    const state = serve(done);
    mount();
    // หาจากข้อความ เพราะระหว่างโหลด ตัวโหลดก็เป็น role="status" เหมือนกัน
    const green = (await screen.findByText(/ทีมพร้อมแล้ว/)).closest<HTMLElement>('[role="status"]')!;
    expect(green).toHaveTextContent("ทีมพร้อมแล้ว ครบทั้ง 6 ขั้น");
    expect(within(green).getByRole("link", { name: "เปิด Gantt" })).toHaveAttribute("href", "/work/sample/p/DE/gantt");
    await waitFor(() => expect(state.posts.map((p) => p.path)).toEqual(["onboarding:complete-seen"]));
    expect(within(sidebar()).queryByRole("button", { name: /เริ่มต้นใช้งาน/ })).toBeNull();
    await userEvent.click(within(green).getByRole("button", { name: "ปิด" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(state.posts).toHaveLength(1);
  });
});

describe("รายการของสมาชิก (V3)", () => {
  it("3 ขั้นส่วนตัว · ผู้ชวน · ปุ่มเปิดงานบันทึกขั้นแล้วไปที่งาน · ไม่มีกล่องทำไมต้องชวนทีม", async () => {
    const state = serve(memberData());
    mount("other", "member");
    const c = await card();
    expect(within(c).getByRole("heading", { name: "เริ่มใช้งานในทีม อีกทีมตัวอย่าง" })).toBeInTheDocument();
    expect(within(c).getByText("ปิยะ ชวนคุณเข้าร่วม · 3 ขั้นสั้น ๆ ให้ทีมเห็นงานของคุณครบ")).toBeInTheDocument();
    expect(within(c).getByText("1 / 3")).toBeInTheDocument();
    expect(within(c).queryByRole("complementary")).toBeNull();
    const rows = within(c).getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("OMA-112 ออกแบบหน้าชำระเงิน");
    expect(within(rows[2]).getByRole("link", { name: "ตั้งค่า" })).toHaveAttribute("href", "/work/other/profile?tab=notify");
    const open = within(rows[1]).getByRole("link", { name: "เปิดงาน" });
    expect(open).toHaveAttribute("href", "/work/other/p/OMA?issue=OMA-112");
    await userEvent.click(open);
    await waitFor(() => expect(state.posts).toEqual([{ path: "onboarding:task-opened", body: { issueKey: "OMA-112" } }]));
    // สมาชิกก็มีปุ่มท้าย Sidebar (ไม่มีส่วน Admin)
    expect(within(sidebar()).getByRole("button", { name: "เริ่มต้นใช้งาน 1/3" })).toBeInTheDocument();
  });
});

describe("มือถือ 390", () => {
  it("การ์ดย่อแสดงเฉพาะขั้นถัดไป · \"ดูทั้งหมด\" เปิด Bottom sheet พร้อมรายการทั้งหมด", async () => {
    restore = asMobile();
    serve(ownerData());
    mount();
    const c = await screen.findByRole("region", { name: "เริ่มต้นใช้งาน" });
    expect(within(c).getByText("ชวนเพื่อนร่วมทีมอีก 1 คน")).toBeInTheDocument();
    expect(within(c).getByText("qa@orbit.example ยังไม่ตอบรับ")).toBeInTheDocument();
    expect(within(c).getByRole("link", { name: "เชิญสมาชิก" })).toHaveAttribute("href", "/work/sample/members");
    expect(within(c).queryAllByRole("listitem")).toHaveLength(0);
    await userEvent.click(within(c).getByRole("button", { name: "ดูทั้งหมด" }));
    const sheet = await screen.findByRole("dialog", { name: "เริ่มต้นใช้งาน" });
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(6);
    expect(within(sheet).getByRole("button", { name: "ไม่ต้องแสดงอีก" })).toBeInTheDocument();
  });
});
