// C6 · Workspace ถูกระงับ: แถบอ่านอย่างเดียว / หน้าติดต่อทีมตอนปิดทั้งหมด · ข้อมูลสมมติเท่านั้น
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { server } from "@/test/server";
import { isBlocked } from ".";

const shell = (ws = "sample") =>
  renderWithProviders(
    <WorkspaceShell ws={ws}>
      <p>เนื้อหาหน้า</p>
    </WorkspaceShell>,
  );
const info = (suspension: object | null) => server.use(http.get("*/api/v1/w/:ws", () => HttpResponse.json({ suspension })));

afterEach(() => {
  navigation.pathname = "/work/sample";
});

describe("Workspace ถูกระงับ", () => {
  it("อ่านอย่างเดียว: แถบเตือนพร้อมข้อความจากทีม · Owner มีลิงก์ชำระเงิน · เนื้อหายังแสดง", async () => {
    info({ mode: "read_only", message: "ค้างชำระ FRI-0001 กรุณาชำระเพื่อใช้งานต่อ" });
    shell();
    expect(await screen.findByText("Workspace ถูกระงับ · อ่านอย่างเดียว")).toBeInTheDocument();
    expect(screen.getByText("ค้างชำระ FRI-0001 กรุณาชำระเพื่อใช้งานต่อ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ไปหน้าชำระเงิน" })).toHaveAttribute("href", "/work/sample/billing");
    expect(screen.getByText("เนื้อหาหน้า")).toBeInTheDocument();
  });

  it("ปิดทั้งหมด: Owner เห็นหน้าติดต่อทีมแทนเนื้อหา · ยังไปหน้าชำระเงินได้", async () => {
    info({ mode: "full", message: "ผิดข้อตกลงการใช้งาน" });
    shell();
    expect(await screen.findByRole("heading", { name: "Workspace นี้ถูกระงับ" })).toBeInTheDocument();
    expect(screen.getByText("ผิดข้อตกลงการใช้งาน")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดูการชำระเงิน" })).toHaveAttribute("href", "/work/sample/billing");
    expect(screen.queryByText("เนื้อหาหน้า")).not.toBeInTheDocument();
  });

  it("ปิดทั้งหมด: สมาชิกได้ 403 workspace_suspended → ให้ติดต่อ Owner", async () => {
    server.use(http.get("*/api/v1/w/:ws", () => HttpResponse.json({ error: { code: "workspace_suspended", message: "ถูกระงับ", details: { mode: "full", message: null } } }, { status: 403 })));
    navigation.pathname = "/work/other";
    shell("other");
    expect(await screen.findByRole("heading", { name: "Workspace นี้ถูกระงับ" })).toBeInTheDocument();
    expect(screen.getByText("ติดต่อ Owner ของ Workspace เพื่อสอบถามรายละเอียด")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ดูการชำระเงิน" })).not.toBeInTheDocument();
  });

  it("isBlocked: Owner เปิดหน้าชำระเงินได้ · อ่านอย่างเดียวไม่บล็อก", () => {
    const full = { mode: "full" as const, message: null };
    expect(isBlocked(full, "owner", "/work/a/billing")).toBe(false);
    expect(isBlocked(full, "owner", "/work/a")).toBe(true);
    expect(isBlocked(full, "member", "/work/a/billing")).toBe(true);
    expect(isBlocked({ mode: "read_only", message: null }, "member", "/work/a")).toBe(false);
    expect(isBlocked(null, "member", "/work/a")).toBe(false);
  });
});
