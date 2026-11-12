// W23 · ถังขยะ (Z1–Z4) และ Workspace ที่ลบไว้ (Z5) · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { PlanLimitHost } from "@/features/plan-limits";
import adminJson from "../../../messages/th/admin-automation.json";
import settingsJson from "../../../messages/th/project-settings-new.json";
import { AdminConsole } from "../../../app/work/[ws]/admin/_components/admin-console";
import { ProjectSettings } from "../../../app/work/[ws]/p/[key]/settings/_components/project-settings";
import type { TrashList } from "./types";

const W = "*/api/v1/w/:ws";
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const pg = { id: "p-pg", key: "DP", name: "ระบบชำระเงินสมมติ" };
const om = { id: "p-om", key: "OMA", name: "แอปมือถือสมมติ" };
const danai = { id: "u-admin", displayName: "ดนัยสมมติ", initials: "ดน", avatarUrl: null, role: "admin" as const };
const piya = { id: "u-owner", displayName: "ปิยะสมมติ", initials: "ปิ", avatarUrl: null, role: "owner" as const };
const base = { deletedAt: iso(-1), purgeAt: iso(29), daysLeft: 29 };
const issues = [
  { ...base, type: "issue", id: "i-39", key: "DP-39", title: "ออกแบบหน้าชำระเงิน", project: pg, subtasks: 4, batchId: "b1", deletedBy: danai },
  { ...base, type: "issue", id: "i-40", key: "DP-40", title: "เชื่อม API ธนาคาร", project: pg, subtasks: 3, batchId: "b1", deletedBy: danai },
  { ...base, type: "issue", id: "i-41", key: "DP-41", title: "ทดสอบการคืนเงิน", project: pg, subtasks: 0, batchId: "b1", deletedBy: danai },
  { ...base, type: "issue", id: "i-77", key: "OMA-77", title: "หน้าตั้งค่าโปรไฟล์เก่า", project: om, subtasks: 0, batchId: null, deletedBy: piya, daysLeft: 2, purgeAt: iso(2) },
];
const batch = { id: "b1", ids: ["i-39", "i-40", "i-41"], keys: ["DP-39", "DP-40", "DP-41"], count: 3, subtasks: 7, deletedBy: danai, deletedAt: base.deletedAt, projects: [pg] };
const mkt = {
  ...base, type: "project", id: "p-mkt", key: "MKT", name: "เว็บการตลาดสมมติ", color: null, archived: false,
  counts: { issues: 74, files: 24, members: 6 }, keyTaken: { key: "MKT", name: "การตลาด 2027" }, deletedBy: piya,
};
const file = { ...base, type: "file", id: "f-1", name: "แบนเนอร์สมมติ.png", kind: "upload", mime: "image/png", sizeBytes: 3 * 1024 ** 2, folder: "Assets", project: pg, deletedBy: danai };

function list(type: "project" | "issue" | "file", over: Partial<TrashList> = {}): TrashList {
  const items = (type === "issue" ? issues : type === "project" ? [mkt] : [file]) as TrashList["items"];
  return {
    type, trashDays: 30, counts: { project: 1, issue: 4, file: 1 }, items, batches: type === "issue" ? [batch] : [],
    deleters: [danai, piya], projects: [pg, om], nextCursor: null, can: { restore: true, purge: true }, ...over,
  };
}

type Call = { method: string; path: string; search: string; body: unknown };
let calls: Call[];
async function record(request: Request) {
  const text = await request.text();
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname.replace("/api/v1", ""), search: url.search, body: text ? JSON.parse(text) : undefined });
}
const errorBody = (status: number, code: string, details: Record<string, unknown> = {}, message = "ข้อผิดพลาดทดสอบ") =>
  HttpResponse.json({ error: { code, message, requestId: "req_w23_001", details } }, { status });

let can = { restore: true, purge: true };
beforeEach(() => {
  calls = [];
  can = { restore: true, purge: true };
  navigation.pathname = "/work/sample/admin/trash";
  server.use(
    http.get(`${W}/admin/overview`, () => HttpResponse.json({ plan: { code: "team_s", name: "Team S", status: "active", trialEndsAt: null }, actions: [] })),
    http.get(`${W}/trash`, async ({ request }) => {
      await record(request);
      const type = (new URL(request.url).searchParams.get("type") ?? "issue") as "project" | "issue" | "file";
      return HttpResponse.json(list(type, { can }));
    }),
  );
});

const messages = { "admin-automation": adminJson, "project-settings-new": settingsJson };
const mount = (ui: React.ReactElement, ws = "sample") => renderWithProviders(<WorkspaceShell ws={ws}>{ui}</WorkspaceShell>, { messages });
const z1 = () => mount(<AdminConsole ws="sample" section="trash" />);

describe("Z1 · ถังขยะของ Workspace", () => {
  it("เมนูใหม่ในกลุ่มความปลอดภัย · แท็บพร้อมจำนวน · แถวงานพร้อม Sub-task ผู้ลบ และ ≤ 3 วันเป็นสีแดง", async () => {
    z1();
    const nav = await screen.findByRole("navigation", { name: "เมนู Admin Console" });
    expect(within(nav).getByRole("link", { name: /ถังขยะ/ })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "ถังขยะ" })).toBeInTheDocument();
    const desc = screen.getByText(/อยู่ที่นี่ 30 วัน/);
    expect(within(desc).getByRole("link", { name: "ข้อมูล & PDPA" })).toHaveAttribute("href", "/work/sample/admin/data");
    const tabs = screen.getByRole("tablist", { name: "ชนิดของสิ่งที่ลบ" });
    expect(within(tabs).getByRole("tab", { name: "งาน 4" })).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: "โปรเจกต์ 1" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "งาน" });
    const row = within(table).getByText("ออกแบบหน้าชำระเงิน").closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText("พร้อม Sub-task 4")).toBeInTheDocument();
    expect(within(row).getByText("ดนัยสมมติ (Admin)")).toBeInTheDocument();
    expect(within(row).getByText("29 วัน")).not.toHaveClass(/urgent/);
    const late = within(table).getByText("หน้าตั้งค่าโปรไฟล์เก่า").closest('[role="row"]') as HTMLElement;
    expect(within(late).getByText("2 วัน").className).toMatch(/urgent/);
    expect(calls[0]).toMatchObject({ path: "/w/sample/trash", search: "?type=issue" });
  });

  it("เลือกทั้งชุด → กู้คืนหลายงานในคำขอเดียว", async () => {
    server.use(http.post(`${W}/trash/:op`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ restored: batch.ids.map((id) => ({ id })), failed: [] });
    }));
    const user = userEvent.setup();
    z1();
    expect(await screen.findByText(/ลบ 3 งานจาก ระบบชำระเงินสมมติ พร้อมกันเมื่อ/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เลือกทั้งชุด" }));
    const bar = screen.getByRole("region", { name: "เลือก 3 งาน" });
    expect(within(bar).getByText("รวม Sub-task 7")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "กู้คืน 3 งาน" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/w/sample/trash/issue:restore", body: { ids: ["i-39", "i-40", "i-41"] } }));
    expect(await screen.findByText("กู้คืนแล้ว 3 รายการ")).toBeInTheDocument();
  });

  it("ค้นหา / กรองโปรเจกต์ / กรองผู้ลบ ส่งเป็น query · ไม่พบรายการแสดงปุ่มล้างตัวกรอง", async () => {
    const user = userEvent.setup();
    z1();
    await screen.findByRole("table", { name: "งาน" });
    await user.selectOptions(screen.getByLabelText("กรองตามโปรเจกต์"), "OMA");
    await waitFor(() => expect(calls.at(-1)!.search).toBe("?type=issue&project=OMA"));
    await user.selectOptions(screen.getByLabelText("กรองตามผู้ลบ"), "u-owner");
    await waitFor(() => expect(calls.at(-1)!.search).toBe("?type=issue&project=OMA&deletedBy=u-owner"));
    server.use(http.get(`${W}/trash`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(list("issue", { items: [], batches: [] }));
    }));
    await user.type(screen.getByRole("searchbox", { name: "ค้นชื่อหรือเลขงาน" }), "DP-9");
    expect(await screen.findByText("ไม่พบรายการที่ตรงกับตัวกรอง")).toBeInTheDocument();
    expect(calls.at(-1)!.search).toContain("q=DP-9");
    await user.click(screen.getByRole("button", { name: "ล้างตัวกรอง" }));
    await waitFor(() => expect(calls.at(-1)!.search).toBe("?type=issue"));
  });

  it("สถานะ M1: ถังขยะว่าง · Error พร้อม requestId · 403 ไม่มีสิทธิ์ · สมาชิกไม่เห็น Admin Console", async () => {
    server.use(http.get(`${W}/trash`, () => HttpResponse.json(list("issue", { items: [], batches: [] }))));
    const a = z1();
    expect(await screen.findByText("ถังขยะว่าง")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่มีสิ่งที่ลบในช่วง 30 วันที่ผ่านมา")).toBeInTheDocument();
    a.unmount();
    server.use(http.get(`${W}/trash`, () => errorBody(500, "internal_error")));
    const b = z1();
    expect(await screen.findByText(/req_w23_001/)).toBeInTheDocument();
    b.unmount();
    server.use(http.get(`${W}/trash`, () => errorBody(403, "forbidden")));
    const c = z1();
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    c.unmount();
    mount(<AdminConsole ws="other" section="trash" />, "other");
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(calls.filter((x) => x.path === "/w/other/trash")).toHaveLength(0);
  });

  it("ลบถาวร (Z3): Owner เท่านั้น · ต้องพิมพ์ \"ลบถาวร\" · ใช้ :purge หลายรายการ", async () => {
    server.use(http.post(`${W}/trash/:op`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ purged: 2, type: "issue" });
    }));
    const user = userEvent.setup();
    z1();
    const table = await screen.findByRole("table", { name: "งาน" });
    await user.click(within(table).getByRole("checkbox", { name: /ออกแบบหน้าชำระเงิน/ }));
    await user.click(within(table).getByRole("checkbox", { name: /เชื่อม API ธนาคาร/ }));
    await user.click(screen.getByRole("button", { name: "ลบถาวร" }));
    const dialog = await screen.findByRole("dialog", { name: "ลบถาวร 2 งาน?" });
    expect(within(dialog).getByText(/DP-39, DP-40 พร้อม Sub-task 7/)).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "ลบถาวร" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/พิมพ์ ลบถาวร เพื่อยืนยัน/), "ลบถาวร");
    await user.click(submit);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/w/sample/trash/issue:purge", body: { ids: ["i-39", "i-40"], confirm: "ลบถาวร" } }));
    expect(await screen.findByText("ลบถาวรแล้ว 2 รายการ")).toBeInTheDocument();
  });

  it("Admin (ไม่ใช่ Owner) ไม่เห็นปุ่มลบถาวร", async () => {
    can = { restore: true, purge: false };
    const user = userEvent.setup();
    z1();
    const table = await screen.findByRole("table", { name: "งาน" });
    await user.click(within(table).getByRole("checkbox", { name: /ออกแบบหน้าชำระเงิน/ }));
    expect(screen.getByRole("button", { name: "กู้คืน 1 งาน" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ลบถาวร" })).not.toBeInTheDocument();
  });

  it("แท็บไฟล์: ขนาดและโฟลเดอร์ · กู้คืนด้วย file:restore", async () => {
    server.use(http.post(`${W}/trash/:op`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ restored: [{ id: "f-1", name: file.name }], failed: [] });
    }));
    const user = userEvent.setup();
    z1();
    await user.click(await screen.findByRole("tab", { name: "ไฟล์ 1" }));
    const table = await screen.findByRole("table", { name: "ไฟล์" });
    expect(within(table).getByText("ใน Assets · 3 MB")).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: `กู้คืน ${file.name}` }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/w/sample/trash/file:restore", body: { ids: ["f-1"] } }));
    expect(await screen.findByText(`กู้คืน ${file.name} แล้ว`)).toBeInTheDocument();
  });
});

describe("Z2 · กู้คืนโปรเจกต์", () => {
  it("Key ซ้ำ: แจ้งโปรเจกต์ที่ใช้ Key · เสนอ Key ใหม่ · ตรวจรูปแบบ · ชนอีกครั้งใช้ Key ที่ API แนะนำ", async () => {
    let attempt = 0;
    server.use(http.post(`${W}/trash/project/:id`, async ({ request }) => {
      await record(request);
      attempt++;
      if (attempt === 1) return errorBody(409, "key_taken", { key: "MKT2", suggestedKey: "MKT3" }, "Project Key นี้มีใน Workspace แล้ว");
      return HttpResponse.json({ id: "p-mkt", key: "MKT3", oldKey: "MKT", name: mkt.name, restored: true });
    }));
    const user = userEvent.setup();
    z1();
    await user.click(await screen.findByRole("tab", { name: "โปรเจกต์ 1" }));
    const table = await screen.findByRole("table", { name: "โปรเจกต์" });
    expect(within(table).getByText(/งาน 74 · ไฟล์ 24 · สมาชิก 6 · Key ซ้ำกับโปรเจกต์ปัจจุบัน/)).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: /กู้คืน MKT/ }));
    const dialog = await screen.findByRole("dialog", { name: "กู้คืน MKT · เว็บการตลาดสมมติ?" });
    expect(within(dialog).getByText(/งาน 74 · ไฟล์ 24 · สมาชิก 6/)).toBeInTheDocument();
    expect(within(dialog).getByText('Key MKT ถูกใช้แล้ว โดยโปรเจกต์ "การตลาด 2027"')).toBeInTheDocument();
    const input = within(dialog).getByLabelText(/Key ใหม่/);
    expect(input).toHaveValue("MKT2");
    await user.clear(input);
    await user.type(input, "9x");
    expect(within(dialog).getByRole("button", { name: "กู้คืนโปรเจกต์" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "mkt2");
    await user.click(within(dialog).getByRole("button", { name: "กู้คืนโปรเจกต์" }));
    expect(await within(dialog).findByText("Project Key นี้มีใน Workspace แล้ว")).toBeInTheDocument();
    expect(input).toHaveValue("MKT3");
    await user.click(within(dialog).getByRole("button", { name: "กู้คืนโปรเจกต์" }));
    expect(await screen.findByText("กู้คืน MKT3 แล้ว")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/w/sample/trash/project/p-mkt:restore", { newKey: "MKT2" }],
      ["/w/sample/trash/project/p-mkt:restore", { newKey: "MKT3" }],
    ]);
  });

  it("เกินแพ็กเกจ (402) ปิด Dialog แล้วแสดง Q2 ของแพ็กเกจ · ไม่กู้บางส่วน", async () => {
    server.use(
      http.get(`${W}/trash`, () => HttpResponse.json(list("project", { items: [{ ...mkt, keyTaken: null }] as TrashList["items"] }))),
      http.post(`${W}/trash/project/:id`, () => errorBody(402, "plan_limit_reached", { kind: "projects", limit: 3, current: 3, plan: "free", suggestedPlan: "team_s", exits: ["archive_project", "upgrade"] })),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <WorkspaceShell ws="sample">
          <AdminConsole ws="sample" section="trash" />
        </WorkspaceShell>
        <PlanLimitHost />
      </>,
      { messages },
    );
    await user.click(await screen.findByRole("tab", { name: "โปรเจกต์ 1" }));
    await user.click(within(await screen.findByRole("table", { name: "โปรเจกต์" })).getByRole("button", { name: /กู้คืน MKT/ }));
    const dialog = await screen.findByRole("dialog", { name: /กู้คืน MKT/ });
    expect(within(dialog).queryByLabelText(/Key ใหม่/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "กู้คืนโปรเจกต์" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /กู้คืน MKT/ })).not.toBeInTheDocument());
    expect(await screen.findByRole("dialog", { name: "Free สร้างได้ 3 โปรเจกต์" })).toBeInTheDocument();
  });
});

describe("Z4 · ถังขยะของโปรเจกต์ (Project Settings)", () => {
  beforeEach(() => {
    navigation.pathname = "/work/sample/p/DE/settings/trash";
    server.use(
      http.get(`${W}/projects/:key/trash`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ...list("issue"), counts: { issue: 4, file: 1 }, project: { id: "sample-project", key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" } });
      }),
      http.get(`${W}/projects/:key/members`, () => HttpResponse.json({ items: [] })),
    );
  });

  it("แท็บถังขยะแสดงเมื่อมีสิทธิ์ project.trash · ตารางของโปรเจกต์ไม่มีคอลัมน์โปรเจกต์และไม่มีปุ่มลบถาวร · มีการ์ดสำหรับมือถือ", async () => {
    server.use(
      http.get(`${W}/projects/:key/my-permissions`, () => HttpResponse.json({ ...permissions, permissions: [...permissions.permissions, "project.trash"] })),
      http.get(`${W}/projects/:key/trash`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ ...list("issue", { can: { restore: true, purge: false } }), counts: { issue: 4, file: 1 } });
      }),
    );
    const user = userEvent.setup();
    mount(<ProjectSettings ws="sample" projectKey="DE" section="trash" />);
    expect(await screen.findByRole("link", { name: "ถังขยะ" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "ถังขยะของโปรเจกต์" })).toBeInTheDocument();
    expect(screen.getByText(/แผนพัฒนาผลิตภัณฑ์ · ลบถาวรหลัง 30 วัน/)).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "ชนิดของสิ่งที่ลบ" });
    expect(within(tabs).getAllByRole("tab").map((x) => x.textContent)).toEqual(["งาน 4", "ไฟล์ 1"]);
    const table = await screen.findByRole("table", { name: "งาน" });
    expect(within(table).queryByText("ระบบชำระเงินสมมติ")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("กรองตามโปรเจกต์")).not.toBeInTheDocument();
    expect(calls[0]).toMatchObject({ path: "/w/sample/projects/DE/trash", search: "?type=issue" });
    // การ์ดมือถือ (CSS ซ่อน / แสดงตามความกว้าง) มีปุ่มกู้คืนของตัวเอง
    expect(screen.getAllByRole("article")).toHaveLength(4);
    await user.click(within(table).getByRole("checkbox", { name: /ออกแบบหน้าชำระเงิน/ }));
    expect(screen.queryByRole("button", { name: "ลบถาวร" })).not.toBeInTheDocument();
  });

  it("ไม่มีสิทธิ์ project.trash: ไม่เห็นแท็บ และเปิดตรงได้หน้าไม่มีสิทธิ์โดยไม่เรียก API", async () => {
    mount(<ProjectSettings ws="sample" projectKey="DE" section="trash" />);
    expect(await screen.findByText("คุณยังไม่มีสิทธิ์เข้าถึง")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith("/trash"))).toHaveLength(0);
  });
});

describe("Z5 · Workspace ที่ลบไว้", () => {
  const info = {
    slug: "gone", name: "ทีมที่ลบสมมติ", deletedAt: "2026-11-03T03:00:00Z", purgeAfter: "2026-12-03T03:00:00Z", daysLeft: 21,
    deletedBy: { displayName: "ปิยะสมมติ", role: "owner" }, owners: [{ displayName: "ปิยะสมมติ", email: "owner@example.com" }],
    counts: { projects: 14, issues: 2318, storageBytes: 38 * 1024 ** 3, members: 21 }, plan: { code: "free", name: "Free", status: "canceled" },
    myRole: "owner", can: { restore: true, export: true },
  };
  beforeEach(() => {
    navigation.pathname = "/work/gone";
  });

  it("Owner: ข้อมูล วันลบถาวร กู้คืนแล้วกลับเข้า Workspace ได้ · ส่งออกข้อมูลก่อนลบ", async () => {
    let restored = false;
    let exportStatus: string | null = null;
    server.use(
      http.get("*/api/v1/workspaces/:slug/deleted", () => (restored ? errorBody(404, "not_found") : HttpResponse.json(info))),
      http.get("*/api/v1/me/workspaces", () =>
        HttpResponse.json({ items: [{ id: "sample-ws", slug: "sample", name: "ทีมตัวอย่าง", logoUrl: null, status: "active", role: "owner" }, ...(restored ? [{ id: "gone-ws", slug: "gone", name: info.name, logoUrl: null, status: "active", role: "owner" }] : [])] }),
      ),
      http.post("*/api/v1/workspaces/:slug/restore", async ({ request }) => {
        await record(request);
        restored = true;
        return HttpResponse.json({ slug: "gone", restored: true });
      }),
      http.get("*/api/v1/workspaces/:slug/deleted/exports", () => HttpResponse.json({ items: exportStatus ? [{ id: "e1", status: exportStatus, createdAt: iso(0), expiresAt: null }] : [] })),
      http.post("*/api/v1/workspaces/:slug/deleted/exports", async ({ request }) => {
        await record(request);
        exportStatus = "ready";
        return HttpResponse.json({ id: "e1", status: "queued", createdAt: iso(0), expiresAt: null }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    mount(<p>เนื้อหาของ Workspace</p>, "gone");
    expect(await screen.findByRole("heading", { name: "ทีมที่ลบสมมติ ถูกลบแล้ว" })).toBeInTheDocument();
    expect(screen.queryByText("เนื้อหาของ Workspace")).not.toBeInTheDocument();
    expect(screen.getByText(/ปิยะสมมติ \(Owner\) ลบเมื่อ/)).toBeInTheDocument();
    expect(screen.getByText(/อีก 21 วัน/)).toBeInTheDocument();
    expect(screen.getByText("14 · งาน 2,318 · ไฟล์ 38 GB")).toBeInTheDocument();
    expect(screen.getByText("21 คน (เข้าไม่ได้จนกว่าจะกู้คืน)")).toBeInTheDocument();
    expect(screen.getByText("ยกเลิกแล้ว · กู้คืนแล้วใช้แบบ Free จนกว่าจะชำระใหม่")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ส่งคำขอลบข้อมูล (PDPA)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ส่งออกข้อมูลก่อนลบ" }));
    expect(await screen.findByRole("link", { name: "ดาวน์โหลด" })).toHaveAttribute("href", "/api/v1/workspaces/gone/deleted/exports/e1/download");

    await user.click(screen.getByRole("button", { name: "กู้คืน Workspace" }));
    expect(await screen.findByText("เนื้อหาของ Workspace")).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(["/workspaces/gone/deleted/exports", "/workspaces/gone/restore"]);
  });

  it("สมาชิกที่ไม่ใช่ Owner: ติดต่อ Owner (ชื่อ + อีเมล) และไปที่ Workspace อื่น · ไม่มีปุ่มกู้คืน", async () => {
    server.use(http.get("*/api/v1/workspaces/:slug/deleted", () => HttpResponse.json({ ...info, myRole: "member", can: { restore: false, export: false } })));
    mount(<p>เนื้อหา</p>, "gone");
    expect(await screen.findByText(/ติดต่อ Owner \(ปิยะสมมติ · owner@example\.com\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ไปที่ Workspace อื่น" })).toHaveAttribute("href", "/work/sample");
    expect(screen.queryByRole("button", { name: "กู้คืน Workspace" })).not.toBeInTheDocument();
  });

  it("ไม่ใช่ Workspace ที่ลบ (404) = ไม่พบหน้าเหมือนเดิม", async () => {
    mount(<p>เนื้อหา</p>, "nope");
    expect(await screen.findByText("ไม่พบหน้านี้")).toBeInTheDocument();
  });

  it("ตัวสลับ Workspace มีส่วน \"ลบไว้ · กู้คืนได้\" พร้อมวันที่เหลือ", async () => {
    navigation.pathname = "/work/sample";
    server.use(http.get("*/api/v1/workspaces/deleted", () => HttpResponse.json({ items: [{ slug: "gone", name: "ทีมที่ลบสมมติ", deletedAt: info.deletedAt, restorableUntil: info.purgeAfter, daysLeft: 21 }] })));
    const user = userEvent.setup();
    mount(<p>หน้าหลัก</p>);
    await screen.findByText("หน้าหลัก");
    await user.click(screen.getAllByRole("button", { name: /สลับ Workspace/ })[0]!);
    const section = await screen.findByRole("navigation", { name: "ลบไว้ · กู้คืนได้" });
    const link = within(section).getByRole("link", { name: /ทีมที่ลบสมมติ/ });
    expect(link).toHaveAttribute("href", "/work/gone");
    expect(within(link).getByText("21 วัน")).toBeInTheDocument();
  });
});
