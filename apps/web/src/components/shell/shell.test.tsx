import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { renderWithProviders } from "@/test/render";
import { permissions, workspaces } from "@/test/fixtures";
import { WorkspaceShell, shellChrome } from "./workspace-shell";
import { ProjectShell } from "./project-shell";
import { Providers } from "../providers";
import { api } from "@/lib/api";
import mw from "../../../messages/th/members-workload.json";

function ProjectExample() {
  return (
    <WorkspaceShell ws="sample">
      <ProjectShell projectKey="DE">
        <p>หน้าโปรเจกต์</p>
      </ProjectShell>
    </WorkspaceShell>
  );
}

describe("Workspace / Project shell", () => {
  it("โหลด me, Workspace, รายชื่อโปรเจกต์ และตัวนับ Inbox", async () => {
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>หน้าหลัก</p>
      </WorkspaceShell>,
    );
    expect(
      await screen.findByRole("button", {
        name: "สลับ Workspace: ทีมตัวอย่าง",
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "แผนพัฒนาผลิตภัณฑ์" }),
    ).toHaveAttribute("href", "/w/sample/p/DE");
    expect(
      screen.getByRole("link", { name: "การแจ้งเตือน 5 รายการยังไม่อ่าน" }),
    ).toBeInTheDocument();
    const sidebar = within(screen.getByRole("complementary"));
    expect(sidebar.getByRole("link", { name: /Inbox/ })).toHaveTextContent("3");
    expect(
      sidebar.getByRole("link", { name: "Admin Console" }),
    ).toBeInTheDocument();
  });

  it("Workspace switch แสดง role/จำนวนแจ้งเตือนและเปลี่ยนไป Home ที่เลือก", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
    );
    await user.click(
      await screen.findByRole("button", {
        name: "สลับ Workspace: ทีมตัวอย่าง",
      }),
    );
    expect(
      screen.getByRole("link", { name: /อีกทีมตัวอย่าง.*Member.*2/ }),
    ).toHaveAttribute("href", "/w/other");
  });

  it("เมนู Workspace: สร้าง / ตั้งค่า Workspace · ไม่มีภาษาและออกจากระบบ (ย้ายไปเมนูบัญชี)", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
    );
    await user.click(
      await screen.findByRole("button", { name: "สลับ Workspace: ทีมตัวอย่าง" }),
    );
    expect(screen.getByRole("link", { name: "สร้าง Workspace ใหม่" })).toHaveAttribute("href", "/onboarding");
    expect(screen.getByRole("link", { name: "ตั้งค่า ทีมตัวอย่าง" })).toHaveAttribute("href", "/w/sample/admin");
    expect(screen.queryByRole("group", { name: "ภาษาของระบบ" })).not.toBeInTheDocument();
  });

  it("เมนูบัญชีที่ avatar: โปรไฟล์ / การแจ้งเตือน / Workspace · ภาษาและปี (W21) · ออกจากระบบ", async () => {
    const user = userEvent.setup();
    let loggedOut = false;
    server.use(http.post("*/api/v1/auth/logout", () => { loggedOut = true; return new HttpResponse(null, { status: 204 }); }));
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
    );
    await user.click(await screen.findByRole("button", { name: "เมนูบัญชี" }));
    const menu = within(await screen.findByRole("dialog", { name: "เมนูบัญชี" }));
    expect(menu.getByRole("link", { name: "โปรไฟล์ของฉัน" })).toHaveAttribute("href", "/w/sample/profile");
    expect(menu.getByRole("link", { name: "การแจ้งเตือน" })).toHaveAttribute("href", "/w/sample/profile?tab=notify");
    expect(menu.getByRole("link", { name: "สมาชิก & เชิญ" })).toHaveAttribute("href", "/w/sample/members");
    expect(menu.getByRole("link", { name: "Admin Console" })).toHaveAttribute("href", "/w/sample/admin");
    const language = menu.getByRole("group", { name: "ภาษาของระบบ" });
    expect(within(language).getByRole("button", { name: /English/ })).toBeInTheDocument();
    expect(menu.getByRole("group", { name: "รูปแบบปี" })).toBeInTheDocument();
    await user.click(menu.getByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(loggedOut).toBe(true));
    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  it("locale en: shell แสดงข้อความภาษาอังกฤษ (W21)", async () => {
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
      { locale: "en" },
    );
    expect(
      await screen.findByRole("button", { name: "Switch Workspace: ทีมตัวอย่าง" }),
    ).toBeInTheDocument();
  });

  it("Ctrl K เปิดช่องค้นหาและส่งคำค้นไป Workspace ปัจจุบัน", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
    );
    await screen.findByRole("button", { name: "สลับ Workspace: ทีมตัวอย่าง" });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = within(
      screen.getByRole("dialog", { name: "ค้นหาใน Workspace" }),
    );
    await user.type(dialog.getByRole("textbox", { name: "ค้นหา" }), "DE-1");
    await user.click(dialog.getByRole("button", { name: "ค้นหา" }));
    expect(router.push).toHaveBeenCalledWith("/w/sample/search?q=DE-1");
  });

  it("Admin เห็นแท็บหลัก 8 แท็บ และ Drawer เปิดตาม query โดยรักษา filter อื่นตอนปิด", async () => {
    navigation.pathname = "/w/sample/p/DE";
    navigation.search = "issue=DE-1&filter=open";
    const user = userEvent.setup();
    renderWithProviders(<ProjectExample />);
    await screen.findByRole("dialog", { name: "รายละเอียดงาน DE-1" });
    const tabs = within(screen.getByLabelText("มุมมองโปรเจกต์"));
    expect(tabs.getAllByRole("link", { hidden: true }).map((l) => l.textContent)).toEqual([
      "Overview",
      "TableList",
      "Kanban",
      "Timeline",
      "Calendar",
      "Members",
      "Files",
      "Settings",
    ]);
    expect(screen.getAllByRole("link", { name: "นำเข้าแผน", hidden: true })[0]).toHaveAttribute(
      "href",
      "/w/sample/import",
    );
    expect(
      screen.getAllByRole("link", { name: "แพ็กเกจและการชำระเงิน", hidden: true })[0],
    ).toHaveAttribute("href", "/w/sample/billing");
    expect(
      screen.getByRole("dialog", { name: "รายละเอียดงาน DE-1" }),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "ปิด" }),
    );
    expect(router.replace).toHaveBeenCalledWith("/w/sample/p/DE?filter=open", {
      scroll: false,
    });
  });

  it("หัวโปรเจกต์ตาม Canvas: Health, ทีม, Invite, เมนู ⋯ และแท็บ Members", async () => {
    navigation.pathname = "/w/sample/p/DE";
    navigation.search = "";
    server.use(
      http.get("*/api/v1/w/:ws/projects/:key/overview", () =>
        HttpResponse.json({ health: { level: "off_track" } }),
      ),
      http.get("*/api/v1/w/:ws/projects/:key/members", () =>
        HttpResponse.json({
          canInvite: true,
          items: [
            { userId: "u1", displayName: "Mick", initials: "MK", avatarUrl: null, active: true },
            { userId: "u2", displayName: "Kaijeaw", initials: "KJ", avatarUrl: null, active: true },
            { userId: "u3", displayName: "Pond", initials: "PD", avatarUrl: null, active: false },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProjectExample />, { messages: { "members-workload": mw } });
    expect(await screen.findByText("Off track")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Kaijeaw" })).toHaveTextContent("KJ");
    // สมาชิกที่ปิดบัญชีแล้วไม่แสดงใน Avatar stack
    expect(screen.queryByRole("img", { name: "Pond" })).not.toBeInTheDocument();
    expect(document.querySelector(".project-crumb")).not.toBeNull();
    // Invite เปิด Modal ทับหน้าเดิม ไม่พาไปแท็บ Members
    await user.click(screen.getByRole("button", { name: "Invite" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite members" });
    expect(within(dialog).getByLabelText("อีเมล (คั่นด้วย , ได้หลายคน)")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite members" })).not.toBeInTheDocument());
    const tabs = within(screen.getByLabelText("มุมมองโปรเจกต์"));
    expect(tabs.getByRole("link", { name: "Members", hidden: true })).toHaveAttribute(
      "href",
      "/w/sample/p/DE/members",
    );
    // เมนู ⋯ เหลือแค่ + New สำหรับมือถือ · Settings / Automation / การแก้ไขแผน ไม่ซ้ำในเมนูนี้แล้ว
    const trigger = screen.getByRole("button", { name: "เมนูโปรเจกต์" });
    expect(trigger).toHaveClass("mobile-only");
    await user.click(trigger);
    const menu = within(await screen.findByRole("navigation", { name: "เมนูโปรเจกต์" }));
    expect(menu.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/w/sample/p/DE?new=1"]);
  });

  it("Guest Viewer เห็นเฉพาะ Overview/Timeline และไม่มี New/Admin/New project", async () => {
    navigation.pathname = "/w/sample/p/DE";
    server.use(
      http.get("*/api/v1/me/workspaces", () =>
        HttpResponse.json({ items: [{ ...workspaces[0], role: "guest" }] }),
      ),
      http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () =>
        HttpResponse.json({
          role: "viewer",
          guestViewer: true,
          permissions: ["project.view"],
        }),
      ),
    );
    renderWithProviders(<ProjectExample />);
    const tabs = within(
      await screen.findByRole("navigation", { name: "มุมมองโปรเจกต์" }),
    );
    expect(tabs.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Overview",
      "Timeline",
    ]);
    expect(
      screen.queryByRole("link", { name: "+ New" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "+ New project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Admin Console" }),
    ).not.toBeInTheDocument();
  });

  it("เข้า Settings ตรงจาก URL โดยไม่มี permission ได้ Forbidden", async () => {
    navigation.pathname = "/w/sample/p/DE/settings";
    server.use(
      http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () =>
        HttpResponse.json({ ...permissions, permissions: ["project.view"] }),
      ),
    );
    renderWithProviders(<ProjectExample />);
    expect(
      await screen.findByRole("heading", { name: "คุณยังไม่มีสิทธิ์เข้าถึง" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("หน้าโปรเจกต์")).not.toBeInTheDocument();
  });

  it("โปรเจกต์ที่ Archive แล้ว: ไม่มี project.settings แต่มี project.archive เข้า Danger zone ได้", async () => {
    navigation.pathname = "/w/sample/p/DE/settings/danger";
    server.use(
      http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () =>
        HttpResponse.json({
          ...permissions,
          permissions: ["project.view", "project.archive"],
        }),
      ),
    );
    renderWithProviders(<ProjectExample />);
    expect(await screen.findByText("หน้าโปรเจกต์")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "คุณยังไม่มีสิทธิ์เข้าถึง" }),
    ).not.toBeInTheDocument();
  });

  it("API error แสดง requestId และ retry หลังโหลดไม่สำเร็จ", async () => {
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          {
            error: {
              code: "internal_error",
              message: "ระบบไม่พร้อม",
              requestId: "req_shell",
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
    );
    expect(
      await screen.findByText("รหัสอ้างอิง: req_shell"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "ลองอีกครั้ง" }),
    ).toBeInTheDocument();
  });

  it("Loading แสดง skeleton และโปรเจกต์ว่างมี Empty state", async () => {
    server.use(
      http.get("*/api/v1/w/:ws/projects", async () => {
        await delay(50);
        return HttpResponse.json({ items: [] });
      }),
    );
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Home</p>
      </WorkspaceShell>,
    );
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(await screen.findByText("ยังไม่มีโปรเจกต์")).toBeInTheDocument();
  });

  it("401 จำ URL เดิมและ 402 แสดง Dialog ของ Q2 (ชนิดทั่วไป)", async () => {
    window.history.replaceState({}, "", "/w/sample/p/DE?issue=DE-1");
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/expired", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "หมดอายุ" } },
          { status: 401 },
        ),
      ),
      http.post("*/api/v1/limit", () =>
        HttpResponse.json(
          {
            error: {
              code: "plan_limit_reached",
              message: "ถึงขีดจำกัดแล้ว",
              details: { current: 5, limit: 5 },
            },
          },
          { status: 402 },
        ),
      ),
    );
    renderWithProviders(
      <Providers>
        <button
          onClick={() => {
            void api.get("/expired").catch(() => undefined);
          }}
        >
          expire
        </button>
        <button
          onClick={() => {
            void api.post("/limit", {}).catch(() => undefined);
          }}
        >
          limit
        </button>
      </Providers>,
    );
    await user.click(screen.getByRole("button", { name: "expire" }));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        "/login?returnTo=%2Fw%2Fsample%2Fp%2FDE%3Fissue%3DDE-1",
      ),
    );
    await user.click(screen.getByRole("button", { name: "limit" }));
    expect(
      await screen.findByRole("dialog", { name: "เกินสิทธิ์ของแพ็กเกจ" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ถึงขีดจำกัดแล้ว")).toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });

  it("กรอบหน้าตามบริบทของ Canvas (VD03)", () => {
    expect(shellChrome("/w/sample")).toBe("workspace");
    expect(shellChrome("/w/sample/p/DE/table")).toBe("workspace");
    expect(shellChrome("/w/sample/p/DE/dashboard")).toBe("workspace");
    expect(shellChrome("/w/sample/p/DE/reports")).toBe("workspace");
    expect(shellChrome("/w/sample/p/DE/automation")).toBe("workspace");
    expect(shellChrome("/w/sample/search")).toBe("workspace");
    expect(shellChrome("/w/sample/import")).toBe("workspace");
    expect(shellChrome("/w/sample/admin/security")).toBe("admin");
    expect(shellChrome("/w/sample/billing")).toBe("workspace");
    expect(shellChrome("/w/sample/billing/checkout")).toBe("checkout");
  });

  it("Admin Console อยู่ล่างสุดของ Sidebar และเมนูล่างมือถือมี 5 รายการตาม M5", async () => {
    navigation.pathname = "/w/sample/inbox";
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Inbox</p>
      </WorkspaceShell>,
    );
    const sidebar = await screen.findByRole("complementary");
    const footer = sidebar.querySelector(".nav-footer");
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByRole("link", { name: "Admin Console" })).toHaveAttribute("href", "/w/sample/admin");
    const bottom = within(screen.getByRole("navigation", { name: "เมนูหลัก", hidden: true }));
    expect(
      bottom.getAllByRole("link", { hidden: true }).map((l) => l.textContent),
    ).toEqual(["Home", "My Tasks", "Inbox3", expect.stringMatching(/Profile$/)]);
    expect(bottom.getByRole("button", { name: /Projects/, hidden: true })).toBeInTheDocument();
    expect(bottom.getByRole("link", { name: /Inbox/, hidden: true })).toHaveAttribute("aria-current", "page");
  });

  it("Admin Console ไม่มี Sidebar ของ Workspace และมีลิงก์กลับ (N1)", async () => {
    navigation.pathname = "/w/sample/admin";
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Admin</p>
      </WorkspaceShell>,
    );
    expect(await screen.findByRole("link", { name: "← กลับไปที่ Workspace" })).toHaveAttribute("href", "/w/sample");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ค้นหางาน โปรเจกต์ ไฟล์" })).not.toBeInTheDocument();
  });

  it("ชำระเงินใช้หัวขาวเรียบ ไม่มีเมนูหรือกระดิ่ง (R2)", async () => {
    navigation.pathname = "/w/sample/billing/checkout";
    renderWithProviders(
      <WorkspaceShell ws="sample">
        <p>Checkout</p>
      </WorkspaceShell>,
    );
    expect(await screen.findByText("ชำระเงิน · ทีมตัวอย่าง")).toBeInTheDocument();
    expect(screen.getByText("เชื่อมต่อแบบเข้ารหัส")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "เมนูหลัก", hidden: true })).not.toBeInTheDocument();
  });

  it("Automation และภาพรวม Lead ใช้หัวและแท็บชุดเดียวกับหน้าอื่น · Automation อยู่ใต้แท็บ Settings (P2, O1)", async () => {
    navigation.pathname = "/w/sample/p/DE/automation";
    const { unmount } = renderWithProviders(<ProjectExample />);
    expect(await screen.findByText("หน้าโปรเจกต์")).toBeInTheDocument();
    const automationTabs = within(await screen.findByLabelText("มุมมองโปรเจกต์"));
    expect(automationTabs.getByRole("link", { name: "Settings", hidden: true })).toHaveAttribute("aria-current", "page");
    unmount();
    navigation.pathname = "/w/sample/p/DE";
    renderWithProviders(<ProjectExample />);
    const tabs = within(await screen.findByLabelText("มุมมองโปรเจกต์"));
    expect(document.querySelector(".project-crumb")).not.toBeNull();
    // ภาพรวม Lead รวมเข้า Overview แล้ว ไม่มีแท็บแยก
    expect(tabs.queryByRole("link", { name: "ภาพรวม Lead", hidden: true })).not.toBeInTheDocument();
  });

  it("ซ่อนแท็บเสริมของหน้าที่เปิดอยู่แล้วกลับไป Overview · ลบจาก × บนแท็บได้", async () => {
    navigation.pathname = "/w/sample/p/DE/backlog";
    const user = userEvent.setup();
    renderWithProviders(<ProjectExample />);
    const tabs = within(await screen.findByRole("navigation", { name: "มุมมองโปรเจกต์" }));
    // เข้าจากลิงก์ ไม่ได้เลือกไว้ แต่เป็นหน้าที่เปิดอยู่ จึงยังซ่อนได้จากเมนู
    await user.click(tabs.getByRole("button", { name: "เพิ่มมุมมอง", hidden: true }));
    const menu = within(await screen.findByRole("dialog", { name: "มุมมองเพิ่มเติม" }));
    await user.click(menu.getByRole("button", { name: "ซ่อนแท็บ Backlog" }));
    expect(router.push).toHaveBeenLastCalledWith("/w/sample/p/DE");
    // × บนแท็บ
    await user.click(tabs.getByRole("button", { name: "ซ่อนแท็บ Backlog", hidden: true }));
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("เลือกแสดงแท็บเสริม (ภาพรวม Lead, Reports, Backlog, Gantt) ได้ และจำค่าไว้ต่อโปรเจกต์", async () => {
    navigation.pathname = "/w/sample/p/DE";
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<ProjectExample />);
    const nav = await screen.findByRole("navigation", { name: "มุมมองโปรเจกต์" });
    const tabs = within(nav);
    expect(tabs.queryByRole("link", { name: "Backlog", hidden: true })).not.toBeInTheDocument();
    // เมนูแบบ Board views: กดมุมมองแล้วเพิ่มเป็นแท็บและเปิดหน้านั้น
    const open = async () => {
      await user.click(tabs.getByRole("button", { name: "เพิ่มมุมมอง", hidden: true }));
      return within(await screen.findByRole("dialog", { name: "มุมมองเพิ่มเติม" }));
    };
    let menu = await open();
    expect(menu.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Reports", "Backlog", "Gantt", "การแก้ไขแผน"]);
    expect(menu.getByRole("button", { name: "Backlog" })).toHaveAccessibleDescription("วางแผน Sprint จากงานที่ยังไม่ได้อยู่ใน Sprint");
    await user.click(menu.getByRole("button", { name: "Backlog" }));
    expect(router.push).toHaveBeenLastCalledWith("/w/sample/p/DE/backlog");
    menu = await open();
    await user.click(menu.getByRole("button", { name: "Gantt" }));
    // แท็บเสริมอยู่ตำแหน่งเดิมในลำดับ ไม่ต่อท้าย
    expect(tabs.getAllByRole("link", { hidden: true }).map((l) => l.textContent)).toEqual([
      "Overview",
      "Backlog",
      "TableList",
      "Kanban",
      "Timeline",
      "Gantt",
      "Calendar",
      "Members",
      "Files",
      "Settings",
    ]);
    menu = await open();
    expect(menu.getAllByLabelText("แสดงเป็นแท็บแล้ว")).toHaveLength(2);
    await user.click(menu.getByRole("button", { name: "ซ่อนแท็บ Gantt" }));
    expect(tabs.queryByRole("link", { name: "Gantt", hidden: true })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<ProjectExample />);
    const again = within(await screen.findByRole("navigation", { name: "มุมมองโปรเจกต์" }));
    expect(await again.findByRole("link", { name: "Backlog", hidden: true })).toHaveAttribute("href", "/w/sample/p/DE/backlog");
    expect(again.queryByRole("link", { name: "Gantt", hidden: true })).not.toBeInTheDocument();
  });
});
