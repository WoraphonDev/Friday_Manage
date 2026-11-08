// W14 · Import Excel และการแก้ไขแผน · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { permissions, workspaces } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import messages from "../../messages/th/import-plan-changes.json";
import { CreateFromExcel } from "../../app/work/[ws]/new-project/excel/create-from-excel";
import { PlanIoDialog } from "@/features/plan-io/plan-io";
import type { ImportJob } from "../../app/work/[ws]/import/_components/types";
import { PlanChangesView, moduleEnds, type Baseline, type PlanChange } from "../../app/work/[ws]/p/[key]/plan-changes/_components/plan-changes-view";
import type { GanttData, GRow } from "../../app/work/[ws]/p/[key]/gantt/_components/gantt-view";

const ns = { "import-plan-changes": messages };
const errorBody = (status: number, code = status === 403 ? "forbidden" : "internal_error") =>
  HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", requestId: "req_w14_001" } }, { status });

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
const fields = { no: "ลำดับ (ใช้จับคู่ตอนอัปเดต)", module: "Module", title: "ชื่องาน", devs: "Dev (หลายคน คั่นด้วย ,)", planStart: "Plan Start" };
function job(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status: "validated",
    mode: "create",
    fileName: "แผนตัวอย่าง.xlsx",
    projectId: null,
    fields,
    project: { name: "แผนตัวอย่าง", key: "SP" },
    setBaseline: true,
    sheet: "Table",
    summary: { rows: 12, modules: 2, phases: 3, manDay: 40, devs: 2, bas: 1, planFrom: "2026-11-09", planTo: "2026-12-18", ready: 9, backlog: 2, skipped: 1 },
    findings: [
      { level: "err", no: 7, rowNo: 8, module: "โมดูลหนึ่ง", title: "งานที่ไม่มี BA", problem: "ไม่มี BA", fix: "ระบุ BA ใน Excel" },
      { level: "warn", no: 9, rowNo: 10, module: "โมดูลสอง", title: "งานที่ยังไม่ลงแผน", problem: "ไม่มี Plan Start / End", fix: "นำเข้าเป็น Backlog ยังไม่ลงแผน" },
      { level: "warn", no: null, rowNo: 0, module: null, title: null, problem: "ไม่พบ \"ผู้พัฒนาสมมติ\" ในรายชื่อสมาชิก (3 แถว)", fix: "จับคู่กับสมาชิก / เชิญด้วยอีเมล / ไม่ระบุ" },
    ],
    people: [
      { name: "ผู้พัฒนาสมมติ", roles: ["dev"], rows: 3, decided: false, target: null },
      { name: "หัวหน้าทีมตัวอย่าง", roles: ["ba"], rows: 5, decided: true, target: { userId: "sample-lead" } },
    ],
    columns: [
      { header: "No.", field: "no", sample: 1 },
      { header: "Module", field: "module", sample: "โมดูลหนึ่ง" },
      { header: "Plan Start", field: null, sample: "2026-11-09" },
    ],
    ...over,
  };
}
const updateJob = () =>
  job({
    mode: "update",
    projectId: "sample-project",
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" },
    setBaseline: false,
    findings: [],
    people: [],
    summary: { rows: 4, modules: 1, phases: 1, manDay: 10, devs: 1, bas: 1, planFrom: "2026-11-09", planTo: "2026-11-20", ready: 2, backlog: 0, skipped: 0 },
    diff: {
      changed: [{ no: 3, key: "DE-3", title: "หน้าจอสมมติ", fields: [{ field: "estimateMd", label: "Man-Day", old: 3, new: 5 }] }],
      added: [{ no: 5, number: 5, title: "งานใหม่สมมติ", module: "โมดูลหนึ่ง" }],
      missing: [{ no: 4, key: "DE-4", title: "งานที่ถูกตัดออก", status: "To do" }],
      unchanged: 1,
    },
  });

const members = [
  { userId: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง", email: "lead@example.com", role: "owner", status: "active" },
  { userId: "sample-dev", displayName: "นักพัฒนาตัวอย่าง", email: "dev@example.com", role: "member", status: "active" },
  { userId: "sample-guest", displayName: "แขกตัวอย่าง", email: "guest@example.com", role: "guest", status: "active" },
];

let uploads: { mode: string; projectKey: string | null; name: string }[];
let patches: Record<string, unknown>[];
let commits: number;
let current: ImportJob;

function importHandlers(initial: () => ImportJob) {
  server.use(
    http.post("*/api/v1/w/:ws/import-jobs", async ({ request }) => {
      const form = await request.formData();
      const file = form.get("file") as File;
      uploads.push({ mode: String(form.get("mode")), projectKey: form.get("projectKey") as string | null, name: file.name });
      current = initial();
      return HttpResponse.json(current, { status: 201 });
    }),
    http.patch("*/api/v1/w/:ws/import-jobs/:id", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      const cm = body.columnMapping as Record<string, string | null> | undefined;
      const pm = body.personMapping as Record<string, unknown> | undefined;
      current = {
        ...current,
        ...(cm ? { columns: current.columns.map((c) => (c.header in cm ? { ...c, field: cm[c.header] } : c)) } : {}),
        ...(pm ? { people: current.people.map((p) => (p.name in pm ? { ...p, decided: true, target: pm[p.name] as never } : p)) } : {}),
        ...(body.project ? { project: { ...current.project, ...(body.project as object) } } : {}),
        ...(typeof body.setBaseline === "boolean" ? { setBaseline: body.setBaseline } : {}),
        ...(body.missing ? { missingChoice: { ...current.missingChoice, ...(body.missing as Record<string, "keep" | "delete">) } } : {}),
        ...(body.missingAll ? { missingAll: body.missingAll as "keep" } : {}),
        ...(body.planChangeReason ? { planChangeReason: String(body.planChangeReason) } : {}),
      };
      return HttpResponse.json(current);
    }),
    http.post("*/api/v1/w/:ws/import-jobs/:id/commit", () => {
      commits++;
      return current.mode === "create"
        ? HttpResponse.json({ mode: "create", project: { key: current.project.key, name: current.project.name }, imported: 11, scheduled: 9, backlog: 2, skipped: 1, baseline: current.setBaseline, invitations: [{ id: "inv" }] }, { status: 201 })
        : HttpResponse.json({ mode: "update", project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" }, added: 1, changed: 1, unchanged: 1, deleted: 1, kept: 0, planChanges: 1, skipped: 0, invitations: [] }, { status: 201 });
    }),
    http.get("*/api/v1/w/:ws/members", () => HttpResponse.json({ items: members })),
  );
}
const xlsx = (name = "แผนตัวอย่าง.xlsx") => new File(["fake"], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
// ผู้ใช้ตัดสิน 2026-11-09: สร้างโปรเจกต์จาก Excel อยู่ที่ New project · อัปเดต / Export อยู่ในโปรเจกต์ (/p/{key}/import)
const mountImport = () => renderWithProviders(<WorkspaceShell ws="sample"><CreateFromExcel ws="sample" /></WorkspaceShell>, { messages: ns });
// Popup Import / Export ในแท็บ Table (ผู้ใช้ตัดสิน 2026-11-09) · เปิดด้วย ?io=
const mountProjectImport = (io = "import") => { navigation.pathname = "/work/sample/p/DE/table"; navigation.search = `io=${io}`; return renderWithProviders(<WorkspaceShell ws="sample"><PlanIoDialog ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: ns }); };

beforeEach(() => {
  uploads = [];
  patches = [];
  commits = 0;
  navigation.pathname = "/work/sample/import";
});

describe("Import Excel (L3)", () => {
  it("โหมดสร้างใหม่: อัปโหลด → จับคู่คอลัมน์ → ผลตรวจ → จับคู่คน / Baseline → นำเข้า", async () => {
    importHandlers(job);
    const user = userEvent.setup();
    mountImport();
    expect(await screen.findByRole("heading", { name: "สร้างโปรเจกต์ใหม่จาก Excel" })).toBeInTheDocument();
    // หน้าสร้างโปรเจกต์ไม่มีเมนูการแก้ไขแผน / เลือกโหมด · ขั้นถัดไปยังกดไม่ได้จนกว่าเลือกไฟล์
    expect(screen.queryByRole("link", { name: /การแก้ไขแผน/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /อัปเดตโปรเจกต์เดิม/ })).not.toBeInTheDocument();
    const next = screen.getByRole("button", { name: "ถัดไป: จับคู่คอลัมน์ →" });
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: /จับคู่คอลัมน์$/ })).toBeDisabled();

    await user.upload(screen.getByLabelText("ไฟล์ Excel (.xlsx)"), xlsx());
    expect(screen.getByText("แผนตัวอย่าง.xlsx")).toBeInTheDocument();
    await user.click(next);

    // ขั้นที่ 2
    expect(await screen.findByText("จับคู่แล้ว 2 / 3")).toBeInTheDocument();
    // ชื่อไฟล์ใน multipart หายระหว่าง jsdom → MSW (เป็น "blob") จึงตรวจเฉพาะ mode / projectKey
    expect(uploads).toMatchObject([{ mode: "create", projectKey: null }]);
    const planStart = screen.getByRole("combobox", { name: "ฟิลด์สำหรับ Plan Start" });
    // ฟิลด์ที่คอลัมน์อื่นใช้แล้วไม่อยู่ในตัวเลือก
    expect(within(planStart).queryByRole("option", { name: "Module" })).not.toBeInTheDocument();
    await user.selectOptions(planStart, "planStart");
    await waitFor(() => expect(patches).toContainEqual({ columnMapping: { "Plan Start": "planStart" } }));
    expect(await screen.findByText("จับคู่แล้ว 3 / 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป: ตรวจสอบข้อมูล →" }));

    // ขั้นที่ 3: KPI, ตัวกรอง และผลตรวจ
    const kpi = screen.getByRole("region", { name: "ตรวจสอบข้อมูล" });
    expect(within(kpi).getByText("12")).toBeInTheDocument();
    expect(within(kpi).getByText("2 / 1")).toBeInTheDocument();
    expect(screen.getAllByTestId("finding")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /มีประเด็น · 3/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /ต้องแก้ · 1/ }));
    expect(screen.getAllByTestId("finding")).toHaveLength(1);
    expect(screen.getByText("ระบุ BA ใน Excel")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ต้องแก้" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /เตือน · 2/ }));
    expect(screen.getAllByTestId("finding")).toHaveLength(2);
    expect(screen.getByText("พร้อม 11 แถว")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป: ยืนยัน →" }));

    // ขั้นที่ 4
    expect(screen.getByLabelText("ชื่อโปรเจกต์")).toHaveValue("แผนตัวอย่าง");
    expect(screen.getByText("9 งานลงแผน + 2 งานเข้า Backlog (ข้าม 1 แถวที่ยังต้องแก้)")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่ได้จับคู่ 1 คน · ถ้าไม่เลือกจะนำเข้าโดยไม่ระบุคน")).toBeInTheDocument();
    const dev = await screen.findByRole("combobox", { name: "จับคู่ ผู้พัฒนาสมมติ" });
    // Guest ไม่อยู่ในตัวเลือกสมาชิก
    expect(within(dev).queryByRole("option", { name: /แขกตัวอย่าง/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "จับคู่ หัวหน้าทีมตัวอย่าง" })).toHaveValue("u:sample-lead");
    await user.selectOptions(dev, "email");
    await user.type(screen.getByRole("textbox", { name: "อีเมลของ ผู้พัฒนาสมมติ" }), "new-dev@example.com{Enter}");
    await waitFor(() => expect(patches).toContainEqual({ personMapping: { ผู้พัฒนาสมมติ: { email: "new-dev@example.com" } } }));
    await user.selectOptions(dev, "u:sample-dev");
    await waitFor(() => expect(patches).toContainEqual({ personMapping: { ผู้พัฒนาสมมติ: { userId: "sample-dev" } } }));
    await user.click(screen.getByRole("checkbox", { name: /ตั้งแผนนี้เป็น Baseline v1/ }));
    await waitFor(() => expect(patches).toContainEqual({ setBaseline: false }));

    // แก้ Key แล้วกดนำเข้าทันที → บันทึก Key ก่อน commit
    const key = screen.getByLabelText("Project Key");
    await user.clear(key);
    await user.type(key, "np");
    expect(key).toHaveValue("NP");
    await user.click(screen.getByRole("button", { name: "นำเข้า 11 งาน" }));
    expect(await screen.findByRole("heading", { name: "นำเข้าเสร็จแล้ว" })).toBeInTheDocument();
    expect(patches).toContainEqual({ project: { key: "NP" } });
    expect(commits).toBe(1);
    expect(screen.getByText(/สร้างโปรเจกต์ แผนตัวอย่าง · 11 งาน/)).toBeInTheDocument();
    expect(screen.getByText("ส่งคำเชิญ 1 คน")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เปิด Table ของโปรเจกต์" })).toHaveAttribute("href", "/work/sample/p/NP/table");
  });

  it("รับเฉพาะ .xlsx · เปลี่ยนไฟล์หลังอัปโหลด = อัปโหลดใหม่ · Error แสดง requestId", async () => {
    importHandlers(job);
    const user = userEvent.setup({ applyAccept: false });
    mountImport();
    const input = await screen.findByLabelText("ไฟล์ Excel (.xlsx)");
    await user.upload(input, new File(["x"], "plan.csv", { type: "text/csv" }));
    expect(screen.getByRole("alert")).toHaveTextContent("รองรับเฉพาะไฟล์ .xlsx");
    await user.upload(input, xlsx());
    await user.click(screen.getByRole("button", { name: "ถัดไป: จับคู่คอลัมน์ →" }));
    await screen.findByText("จับคู่แล้ว 2 / 3");
    await user.click(screen.getByRole("button", { name: /อัปโหลดไฟล์$/ }));
    // ย้อนมาโดยไม่เปลี่ยนอะไร = ใช้ job เดิม
    expect(screen.getByText(/ชีต Table · 12 แถว · อัปโหลดแล้ว/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ถัดไป: จับคู่คอลัมน์ →" }));
    expect(uploads).toHaveLength(1);

    server.use(http.post("*/api/v1/w/:ws/import-jobs", () => errorBody(400, "no_table_sheet")));
    await user.click(screen.getByRole("button", { name: /อัปโหลดไฟล์$/ }));
    await user.upload(screen.getByLabelText("ไฟล์ Excel (.xlsx)"), xlsx("อีกไฟล์.xlsx"));
    // ไฟล์ใหม่ = ขั้นถัดไปถูกล็อกจนกว่าจะอัปโหลด
    expect(screen.getByRole("button", { name: /จับคู่คอลัมน์$/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "ถัดไป: จับคู่คอลัมน์ →" }));
    expect(await screen.findByText(/ข้อผิดพลาดทดสอบ/)).toBeInTheDocument();
    expect(screen.queryByText(/req_w14_001/)).not.toBeInTheDocument(); // 4xx ผู้ใช้แก้เองได้ ไม่แสดงรหัสอ้างอิง (ผู้ใช้ขอ 2026-11-09)
  });

  it("Popup Import / Export ใน Table: เมนูซ้าย 3 เมนู · Export แผน + Timeline ของโปรเจกต์นี้", async () => {
    const user = userEvent.setup();
    mountProjectImport("export");
    const dialog = await screen.findByRole("dialog", { name: "Import / Export" });
    const menu = within(dialog).getByRole("navigation", { name: "เมนู Import / Export" });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["อัปเดตแผนจาก Excel", "Export แผน + Timeline", "การแก้ไขแผน (Plan vs Baseline)"]);
    expect(within(menu).getByRole("button", { name: "Export แผน + Timeline" })).toHaveAttribute("aria-current", "page");
    // เปลี่ยนเมนูผ่าน ?io= ใน URL
    await user.click(within(menu).getByRole("button", { name: "การแก้ไขแผน (Plan vs Baseline)" }));
    expect(router.replace).toHaveBeenLastCalledWith("/work/sample/p/DE/table?io=changes", { scroll: false });
    // โปรเจกต์กำหนดจาก Table ไม่มีช่องเลือกโปรเจกต์ · ช่องละสัปดาห์เพิ่ม ?timeline=week
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(await within(dialog).findByRole("link", { name: /ดาวน์โหลด Excel/ })).toHaveAttribute("href", "/api/v1/w/sample/projects/DE/export.xlsx");
    await user.click(within(dialog).getByRole("radio", { name: "ช่องละสัปดาห์" }));
    expect(within(dialog).getByRole("link", { name: /ดาวน์โหลด Excel/ })).toHaveAttribute("href", "/api/v1/w/sample/projects/DE/export.xlsx?timeline=week");
    await user.click(within(dialog).getByRole("button", { name: "ปิด" }));
    expect(router.replace).toHaveBeenLastCalledWith("/work/sample/p/DE/table", { scroll: false });
  });

  it("อัปเดตแผนของโปรเจกต์: ส่ง projectKey, diff, งานที่หายจากไฟล์, เหตุผลบันทึกก่อน commit", async () => {
    importHandlers(updateJob);
    const user = userEvent.setup();
    mountProjectImport();
    expect(await screen.findByRole("button", { name: "อัปเดตแผนจาก Excel" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("radio", { name: /นำเข้าเป็นโปรเจกต์ใหม่/ })).not.toBeInTheDocument();
    await user.upload(screen.getByLabelText("ไฟล์ Excel (.xlsx)"), xlsx());
    await user.click(screen.getByRole("button", { name: "ถัดไป: จับคู่คอลัมน์ →" }));
    await screen.findByText("จับคู่แล้ว 2 / 3");
    expect(uploads).toMatchObject([{ mode: "update", projectKey: "DE" }]);
    await user.click(screen.getByRole("button", { name: "ถัดไป: ตรวจสอบข้อมูล →" }));

    const diff = screen.getByRole("region", { name: "เทียบกับแผนปัจจุบัน" });
    expect(within(diff).getByText("เปลี่ยน 1 · เพิ่ม 1 · หายจากไฟล์ 1 · ไม่เปลี่ยน 1")).toBeInTheDocument();
    expect(within(diff).getByText("3")).toHaveClass(/old/);
    expect(within(diff).getByText("5")).toHaveClass(/new/);
    expect(screen.getByText("ไม่พบประเด็น ทุกแถวพร้อมนำเข้า")).toBeInTheDocument();
    await user.selectOptions(within(diff).getByRole("combobox", { name: "จัดการ DE-4" }), "delete");
    await waitFor(() => expect(patches).toContainEqual({ missing: { "4": "delete" } }));
    await user.click(screen.getByRole("button", { name: "ถัดไป: ยืนยัน →" }));

    expect(screen.getByText("งานที่หายจากไฟล์ 1 งาน: ลบ 1 · เก็บไว้ 0")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("เหตุผลของการแก้แผน"), "ปรับตามขอบเขตใหม่");
    await user.click(screen.getByRole("button", { name: "อัปเดต 2 งาน" }));
    expect(await screen.findByRole("heading", { name: "นำเข้าเสร็จแล้ว" })).toBeInTheDocument();
    expect(patches).toContainEqual({ planChangeReason: "ปรับตามขอบเขตใหม่" });
    expect(screen.getByText(/เปลี่ยน 1 · เพิ่ม 1 · ลบ 1 · บันทึกการแก้ไขแผน 1 รายการ/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ดูการแก้ไขแผน" })).toHaveAttribute("href", "/work/sample/p/DE/table?io=changes");
  });

  it("สมาชิกทั่วไป (ไม่มีสิทธิ์ตั้ง Baseline) เห็นแค่ Export · Guest Viewer ไม่เห็น Popup", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "member", permissions: ["project.view", "issue.edit"] })));
    // ขอเมนูนำเข้า แต่ไม่มีสิทธิ์ → เปิด Export แทน
    const view = mountProjectImport("import");
    const dialog = await screen.findByRole("dialog", { name: "Import / Export" });
    expect(within(dialog).getAllByRole("button", { name: /อัปเดตแผน|Export|การแก้ไขแผน/ }).map((b) => b.textContent)).toEqual(["Export แผน + Timeline"]);
    expect(within(dialog).queryByLabelText("ไฟล์ Excel (.xlsx)")).not.toBeInTheDocument();
    expect(await within(dialog).findByRole("link", { name: /ดาวน์โหลด Excel/ })).toBeInTheDocument();
    view.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "viewer", guestViewer: true, permissions: ["project.view"] })));
    mountProjectImport("export");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import / Export" })).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// การแก้ไขแผน
// ---------------------------------------------------------------------------
const lead = { id: "sample-lead", displayName: "หัวหน้าทีมตัวอย่าง" };
const baselines: Baseline[] = [
  { id: "b2", version: 2, name: "แผนรอบสอง", source: "manual", itemCount: 3, createdAt: "2026-11-20T03:00:00Z", createdBy: lead },
  { id: "b1", version: 1, name: "Baseline v1", source: "import", itemCount: 3, createdAt: "2026-11-05T03:00:00Z", createdBy: lead },
];
const change = (id: string, over: Partial<PlanChange>): PlanChange => ({
  id, issueKey: "DE-3", title: "หน้าจอสมมติ", field: "estimateMd", fieldLabel: "Man-Day", oldValue: 3, newValue: 5,
  reason: "ขอบเขตเพิ่ม", impact: null, source: "manual", baselineVersion: 2, changedBy: lead, changedAt: "2026-11-21T03:20:00Z", ...over,
});
const page1 = [
  change("c1", {}),
  change("c2", { issueKey: "DE-4", title: "งานแบ่งคน", field: "assigneeIds", fieldLabel: "Dev", oldValue: ["sample-dev"], newValue: ["sample-dev", "sample-lead"], reason: "ลดคอขวด", source: "import" }),
];
const page2 = [change("c3", { issueKey: "DE-5", title: "งานเลื่อนวัน", field: "planEnd", fieldLabel: "Plan End", oldValue: "2026-12-01", newValue: "2026-12-04", reason: null, impact: "เพิ่ม 3 วันทำการ", source: "due_request", changedBy: null })];

const grow = (key: string, end: string, baseEnd: string | null, subtasks: GRow[] = []): GRow => ({
  key, type: "Task", title: key, status: { name: "To do", category: "todo" }, start: "2026-11-09", end, progressPct: 0, lateDays: 0, subtasks,
  baseline: baseEnd ? { start: "2026-11-09", end: baseEnd } : null,
});
function gantt(): GanttData {
  const sum = { progressPct: 0, lateDays: 0, taskCount: 2 };
  return {
    project: { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", startDate: "2026-11-05", goliveDate: "2027-04-21" },
    today: "2026-11-25", range: { from: "2026-11-09", to: "2026-12-31" }, lastEnd: "2026-12-04", sprints: [], milestones: [],
    modules: [
      { id: "m1", name: "โมดูลหนึ่ง", color: null, start: "2026-11-09", end: "2026-12-04", ...sum, groups: [{ phase: null, name: "กลุ่ม", start: "2026-11-09", end: "2026-12-04", ...sum, tasks: [grow("DE-3", "2026-11-20", "2026-11-20", [grow("DE-6", "2026-12-04", "2026-12-01")])] }] },
      { id: "m2", name: "โมดูลสอง", color: null, start: "2026-11-09", end: "2026-11-27", ...sum, groups: [{ phase: null, name: "กลุ่ม", start: "2026-11-09", end: "2026-11-27", ...sum, tasks: [grow("DE-4", "2026-11-27", "2026-11-27")] }] },
      { id: "m3", name: "โมดูลใหม่", color: null, start: "2026-11-09", end: "2026-11-27", ...sum, groups: [{ phase: null, name: "กลุ่ม", start: "2026-11-09", end: "2026-11-27", ...sum, tasks: [grow("DE-9", "2026-11-27", null)] }] },
    ],
    unscheduled: [], baselines: [], baseline: null, dependencies: [], criticalPath: { keys: [], startDate: null, endDate: null }, ignoredDependencies: 0,
  };
}

let list: Baseline[];
let changeGets: string[];
let baselinePosts: unknown[];
function changesHandlers() {
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/baselines", () => HttpResponse.json({ items: list })),
    http.post("*/api/v1/w/:ws/projects/:key/baselines", async ({ request }) => {
      const body = await request.json();
      baselinePosts.push(body);
      const created = { id: "b3", version: 3, name: "แผนรอบสาม", source: "manual", itemCount: 3, createdAt: "2026-11-25T03:00:00Z", createdBy: null };
      list = [created, ...list];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.get("*/api/v1/w/:ws/projects/:key/plan-changes", ({ request }) => {
      const q = new URL(request.url).searchParams;
      changeGets.push(`${q.get("baseline")}|${q.get("before") ?? ""}`);
      if (q.get("baseline") === "v3") return HttpResponse.json({ items: [], nextCursor: null });
      return HttpResponse.json(q.get("before") ? { items: page2, nextCursor: null } : { items: page1, nextCursor: page1[1].changedAt });
    }),
    http.get("*/api/v1/w/:ws/projects/:key/gantt", () => HttpResponse.json(gantt())),
    http.get("*/api/v1/w/:ws/members", () => HttpResponse.json({ items: members })),
  );
}
const mountChanges = () => renderWithProviders(<WorkspaceShell ws="sample"><PlanChangesView ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: ns });

describe("การแก้ไขแผน (Plan vs Baseline)", () => {
  beforeEach(() => {
    list = baselines;
    changeGets = [];
    baselinePosts = [];
    navigation.pathname = "/work/sample/p/DE/plan-changes";
    changesHandlers();
  });

  it("วันจบ Module จาก Baseline (รวม Sub-task) เทียบวันจบปัจจุบัน", () => {
    expect(moduleEnds(gantt())).toEqual([
      { name: "โมดูลหนึ่ง", plan: "2026-12-01", forecast: "2026-12-04", days: 3 },
      { name: "โมดูลสอง", plan: "2026-11-27", forecast: "2026-11-27", days: 0 },
    ]);
  });

  it("รายการแก้ไขเทียบ Baseline ล่าสุด, ชื่อ Dev, ลิงก์งาน, โหลดเพิ่ม, Export และคัดลอก", async () => {
    const user = userEvent.setup();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    mountChanges();
    expect(await screen.findByText("เทียบกับ Baseline v2")).toBeInTheDocument();
    // แท็บของตัวเอง ไม่อยู่ในเมนู Import / Export (ผู้ใช้ 2026-11-09)
    expect(screen.queryByRole("navigation", { name: "เมนู Import / Export" })).not.toBeInTheDocument();
    expect(await screen.findAllByTestId("plan-change")).toHaveLength(2);
    expect(changeGets[0]).toBe("v2|");
    expect(screen.getByText("แก้ไขแล้ว 2 งาน · กระทบวันจบ 1 Module")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "หน้าจอสมมติ" })).toHaveAttribute("href", "/work/sample/p/DE/plan-changes?issue=DE-3");
    expect(await screen.findByText("นักพัฒนาตัวอย่าง, หัวหน้าทีมตัวอย่าง")).toHaveClass(/new/);
    expect(screen.getByText("นำเข้า")).toBeInTheDocument();

    const mods = screen.getAllByTestId("module-end");
    expect(mods).toHaveLength(2);
    expect(mods[0]).toHaveTextContent("+3 วัน");
    expect(mods[1]).toHaveTextContent("ตามแผน");

    expect(screen.getByRole("link", { name: "Export Excel (ไฮไลต์จุดที่แก้)" })).toHaveAttribute("href", "/api/v1/w/sample/projects/DE/plan-changes.xlsx?baseline=v2");
    await user.click(screen.getByRole("button", { name: "โหลดเพิ่ม" }));
    expect(await screen.findAllByTestId("plan-change")).toHaveLength(3);
    expect(changeGets).toContain(`v2|${page1[1].changedAt}`);
    expect(screen.getByText("ไม่ได้ระบุเหตุผล")).toBeInTheDocument();
    expect(screen.getByText("เพิ่ม 3 วันทำการ")).toBeInTheDocument();
    expect(screen.getByText("คำขอเลื่อน Due")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "คัดลอกรายการที่แก้ไข" }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].split("\n")[0]).toBe("DE-3 · หน้าจอสมมติ · Man-Day: 3 → 5 · ขอบเขตเพิ่ม");
    expect(await screen.findByText("คัดลอก 3 รายการแล้ว")).toBeInTheDocument();

    // เปลี่ยน Baseline ที่เทียบ
    await user.selectOptions(screen.getByRole("combobox", { name: "เลือก Baseline" }), "1");
    expect(await screen.findByText("เทียบกับ Baseline v1")).toBeInTheDocument();
    await waitFor(() => expect(changeGets).toContain("v1|"));
  });

  it("ตั้งเป็น Baseline ถัดไป แล้วเทียบกับ Baseline ใหม่ · ว่าง", async () => {
    const user = userEvent.setup();
    mountChanges();
    await user.click(await screen.findByRole("button", { name: "ตั้งเป็น Baseline v3…" }));
    const dialog = await screen.findByRole("dialog", { name: "ตั้งแผนปัจจุบันเป็น Baseline v3" });
    await user.type(within(dialog).getByLabelText("ชื่อ Baseline"), "แผนรอบสาม");
    await user.click(within(dialog).getByRole("button", { name: "ตั้ง Baseline" }));
    expect(await screen.findByText("ตั้ง Baseline v3 แล้ว")).toBeInTheDocument();
    expect(baselinePosts).toEqual([{ name: "แผนรอบสาม" }]);
    expect(await screen.findByText("เทียบกับ Baseline v3")).toBeInTheDocument();
    expect(await screen.findByText("ยังไม่มีการแก้ไขแผน")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "คัดลอกรายการที่แก้ไข" })).toBeDisabled();
  });

  it("ยังไม่มี Baseline · ไม่มีสิทธิ์ตั้งจะไม่เห็นปุ่ม", async () => {
    list = [];
    const view = mountChanges();
    expect(await screen.findByRole("heading", { name: "ยังไม่มี Baseline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ตั้งเป็น Baseline v1…" })).toBeInTheDocument();
    view.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, permissions: ["project.view"] })));
    mountChanges();
    expect(await screen.findByRole("heading", { name: "ยังไม่มี Baseline" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ตั้งเป็น Baseline/ })).not.toBeInTheDocument();
  });

  it("กำลังโหลด · Error มี requestId · 403 · Guest", async () => {
    server.use(http.get("*/api/v1/w/:ws/projects/:key/baselines", () => errorBody(500)));
    const first = mountChanges();
    expect(await screen.findByText(/req_w14_001/)).toBeInTheDocument();
    first.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/baselines", () => errorBody(403)));
    const second = mountChanges();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
    second.unmount();

    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: null, guestViewer: true, permissions: ["project.view"] })));
    mountChanges();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });
});
