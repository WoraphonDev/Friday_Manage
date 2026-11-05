import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { renderWithProviders } from "@/test/render";
import { permissions, workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "./workspace-shell";
import { ProjectShell } from "./project-shell";
import { Providers } from "../providers";
import { api } from "@/lib/api";

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

  it("Admin เห็น 11 project tabs และ Drawer เปิดตาม query โดยรักษา filter อื่นตอนปิด", async () => {
    navigation.pathname = "/w/sample/p/DE";
    navigation.search = "issue=DE-1&filter=open";
    const user = userEvent.setup();
    renderWithProviders(<ProjectExample />);
    await screen.findByRole("dialog", { name: "รายละเอียดงาน DE-1" });
    const tabs = within(screen.getByLabelText("มุมมองโปรเจกต์"));
    expect(tabs.getAllByRole("link", { hidden: true })).toHaveLength(11);
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

  it("401 จำ URL เดิมและ 402 แสดง Dialog ทั่วไป", async () => {
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
      await screen.findByRole("dialog", { name: "ถึงขีดจำกัดของแพ็กเกจแล้ว" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ใช้อยู่ 5 / 5")).toBeInTheDocument();
    window.history.replaceState({}, "", "/");
  });
});
