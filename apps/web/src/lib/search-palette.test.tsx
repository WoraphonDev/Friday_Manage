// W16 · ค้นหาและ Command palette · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import type { SavedSearch, SearchHit, SearchResult, SearchType } from "@/features/command-palette/search-shared";
import sp from "../../messages/th/search-palette.json";
import { SearchPage } from "../../app/work/[ws]/search/_components/search-page";

const project = { key: "DE", name: "แผนพัฒนาผลิตภัณฑ์" };
const hits: SearchHit[] = [
  { type: "task", key: "DE-39", title: "ฟอร์มสัญญาตัวอย่าง 3 แบบ", project, status: { name: "In progress", category: "in_progress" }, priority: "high", planEnd: "2026-12-04", matchedIn: "title", snippet: null },
  { type: "sub", key: "DE-40", title: "ฟอร์มสัญญาตัวอย่าง: แบบที่หนึ่ง", project, status: { name: "Done", category: "done" }, priority: "medium", planEnd: null, matchedIn: "title", snippet: null },
  { type: "bug", key: "DE-41", title: "บันทึกฟอร์มไม่ได้", project, status: { name: "Review", category: "in_progress" }, priority: "urgent", planEnd: null, matchedIn: "description", snippet: "…กดบันทึกสัญญาตัวอย่างแล้วขึ้นข้อผิดพลาด…" },
  { type: "project", key: "DE", name: "แผนพัฒนาผลิตภัณฑ์", color: "#334155", archived: false, goliveDate: "2027-04-21" },
  { type: "comment", issueKey: "DE-39", issueTitle: "ฟอร์มสัญญาตัวอย่าง 3 แบบ", project, commentId: "c-1", snippet: "…สัญญาตัวอย่างต้องมีวันหมดอายุ…", createdAt: "2026-11-05T03:00:00Z" },
  { type: "file", id: "f-1", name: "สัญญาตัวอย่าง_v2.pdf", kind: "file", mime: "application/pdf", project },
  { type: "person", id: "u-1", displayName: "สมชาย ตัวอย่าง", initials: "สต", avatarUrl: null, email: "dev1@example.com", jobTitle: "Dev" },
];
const countsOf = (items: SearchHit[]) => Object.fromEntries((["task", "sub", "bug", "project", "comment", "file", "person"] as SearchType[]).map((t) => [t, items.filter((h) => h.type === t).length])) as Record<SearchType, number>;

let searches: URL[];
let saved: SavedSearch[];
let posted: unknown[];
let deleted: string[];
let searchResponse: (url: URL) => SearchResult | Response;
const errorBody = (status: number) => HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w16_001" } }, { status });

beforeEach(() => {
  searches = [];
  posted = [];
  deleted = [];
  localStorage.clear();
  saved = [{ id: "s-1", name: "Bug ที่ยังเปิด", query: "ฟอร์ม", filters: { types: ["bug"], open: true }, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }];
  searchResponse = (url) => {
    const q = url.searchParams.get("q") ?? "";
    const type = url.searchParams.get("type");
    let items = q.startsWith("@") ? hits.filter((h) => h.type === "person") : q.toUpperCase() === "#DE-39" || q.toUpperCase() === "DE-39" ? hits.filter((h) => h.type === "task") : q === "ไม่มีอะไร" ? [] : hits;
    if (type) items = items.filter((h) => h.type === type);
    return { q, total: items.length, counts: countsOf(items), items };
  };
  server.use(
    http.get("*/api/v1/w/:ws/search", ({ request }) => {
      const url = new URL(request.url);
      searches.push(url);
      const r = searchResponse(url);
      return r instanceof Response ? r : HttpResponse.json(r);
    }),
    http.get("*/api/v1/w/:ws/saved-searches", () => HttpResponse.json({ items: saved })),
    http.post("*/api/v1/w/:ws/saved-searches", async ({ request }) => {
      const body = (await request.json()) as { name: string; query: string; filters: Record<string, unknown> };
      posted.push(body);
      const row = { id: "s-new", ...body, createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z" };
      saved = [...saved, row];
      return HttpResponse.json(row);
    }),
    http.delete("*/api/v1/w/:ws/saved-searches/:id", ({ params }) => {
      deleted.push(String(params.id));
      saved = saved.filter((s) => s.id !== params.id);
      return HttpResponse.json({ deleted: true });
    }),
    http.get("*/api/v1/w/:ws/my-issues", () => HttpResponse.json({ groups: [{ key: "todo", items: [{ key: "DE-41" }] }] })),
  );
});

async function openPalette() {
  const user = userEvent.setup();
  renderWithProviders(<WorkspaceShell ws="sample"><p>หน้า</p></WorkspaceShell>, { messages: { "search-palette": sp } });
  await screen.findByRole("button", { name: "สลับ Workspace: ทีมตัวอย่าง" });
  await user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "ค้นหาใน Workspace" });
  return { user, dialog: within(dialog), input: within(dialog).getByRole("textbox", { name: "ค้นหา" }) };
}

describe("Command palette (Ctrl K)", () => {
  it("ยังไม่พิมพ์: เปิดล่าสุดจากเครื่อง + คำสั่งที่ใช้บ่อย · ปุ่ม ลอง: ใส่ตัวนำหน้า", async () => {
    localStorage.setItem("friday:palette-recent:sample", JSON.stringify([{ id: "x", icon: "task", text: "DE-7 งานที่เปิดล่าสุด", href: "/work/sample/p/DE?issue=DE-7" }]));
    const { user, dialog, input } = await openPalette();
    expect(dialog.getByRole("group", { name: "เปิดล่าสุด" })).toHaveTextContent("DE-7 งานที่เปิดล่าสุด");
    const frequent = dialog.getByRole("group", { name: "คำสั่งที่ใช้บ่อย" });
    expect(within(frequent).getByRole("option", { name: /ไปที่ My Tasks/ })).toBeInTheDocument();
    // ไม่ได้อยู่ในโปรเจกต์ = ไม่มีคำสั่งสร้างงาน
    expect(within(frequent).queryByRole("option", { name: /สร้างงานใหม่/ })).not.toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: /@ คน/ }));
    expect(input).toHaveValue("@");
    expect(searches).toHaveLength(0);
  });

  it("ค้นงาน / โปรเจกต์ / ไฟล์และคอมเมนต์ / คน เป็นกลุ่ม · ไฮไลต์คำค้น · ลูกศร + Enter เปิดและจำเป็นเปิดล่าสุด", async () => {
    const { user, dialog, input } = await openPalette();
    await user.type(input, "สัญญาตัวอย่าง");
    const issues = await dialog.findByRole("group", { name: "งาน · 3" });
    expect(within(issues).getAllByRole("option")).toHaveLength(3);
    expect(dialog.getByRole("group", { name: "โปรเจกต์ · 1" })).toBeInTheDocument();
    expect(dialog.getByRole("group", { name: "ไฟล์ และคอมเมนต์ · 2" })).toBeInTheDocument();
    expect(dialog.getByRole("group", { name: "คน · 1" })).toBeInTheDocument();
    expect(within(issues).getAllByText("สัญญาตัวอย่าง", { selector: "mark" }).length).toBeGreaterThan(0);
    expect(searches.at(-1)?.searchParams.get("limit")).toBe("8");
    expect(searches.at(-1)?.searchParams.get("q")).toBe("สัญญาตัวอย่าง");
    expect(dialog.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(router.push).toHaveBeenCalledWith("/work/sample/p/DE?issue=DE-40");
    expect(JSON.parse(localStorage.getItem("friday:palette-recent:sample") ?? "[]")[0]).toMatchObject({ href: "/work/sample/p/DE?issue=DE-40" });
  });

  it("#DE-39 ไปที่งานทันที (ลิงก์ ?issue=KEY) และผลที่ตรงรหัสขึ้นก่อน", async () => {
    const { user, dialog, input } = await openPalette();
    await user.type(input, "#de-39");
    expect(dialog.getAllByRole("option")[0]).toHaveTextContent(/DE-39/);
    await user.keyboard("{Enter}");
    expect(router.push).toHaveBeenCalledWith("/work/sample/p/DE?issue=DE-39");
  });

  it("@ชื่อ ค้นเฉพาะคน (type=person)", async () => {
    const { user, dialog, input } = await openPalette();
    await user.type(input, "@สมชาย");
    const people = await dialog.findByRole("group", { name: "คน · 1" });
    expect(within(people).getByRole("option", { name: /สมชาย ตัวอย่าง/ })).toBeInTheDocument();
    expect(searches.at(-1)?.searchParams.get("type")).toBe("person");
    expect(searches.at(-1)?.searchParams.get("q")).toBe("@สมชาย");
    expect(dialog.queryByRole("group", { name: /^งาน/ })).not.toBeInTheDocument();
  });

  it("> คำสั่ง ไม่เรียก API · ในโปรเจกต์มีขอบเขต + สร้างงานใหม่ตามสิทธิ์ issue.create", async () => {
    navigation.pathname = "/work/sample/p/DE/table";
    const { user, dialog, input } = await openPalette();
    expect(dialog.getByText("ใน: แผนพัฒนาผลิตภัณฑ์")).toBeInTheDocument();
    await user.type(input, "> kanban");
    const cmds = dialog.getByRole("group", { name: "คำสั่ง · 1" });
    await user.keyboard("{Enter}");
    expect(within(cmds).getByRole("option")).toHaveTextContent("เปิด Kanban ของโปรเจกต์นี้");
    expect(router.push).toHaveBeenCalledWith("/work/sample/p/DE/board");
    expect(searches).toHaveLength(0);
  });

  it("ไม่มีสิทธิ์ issue.create = ไม่มีคำสั่งสร้างงาน", async () => {
    navigation.pathname = "/work/sample/p/DE";
    server.use(http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json({ ...permissions, role: "viewer", permissions: ["project.view"] })));
    const { user, dialog, input } = await openPalette();
    await user.type(input, ">");
    expect(await dialog.findByRole("option", { name: /เปิด Kanban/ })).toBeInTheDocument();
    expect(dialog.queryByRole("option", { name: /สร้างงานใหม่/ })).not.toBeInTheDocument();
  });

  it("มีสิทธิ์ issue.create = มีคำสั่งสร้างงาน ?new=1", async () => {
    navigation.pathname = "/work/sample/p/DE";
    const { user, dialog, input } = await openPalette();
    await user.type(input, "> สร้างงาน");
    await user.click(await dialog.findByRole("option", { name: /สร้างงานใหม่/ }));
    expect(router.push).toHaveBeenCalledWith("/work/sample/p/DE?new=1");
  });

  it("ไม่พบ → ค้นแบบละเอียด · Ctrl Enter ไปหน้าผลทั้งหมด · Error มี requestId", async () => {
    const { user, dialog, input } = await openPalette();
    await user.type(input, "ไม่มีอะไร");
    expect(await dialog.findByText('ไม่พบ "ไม่มีอะไร"')).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "ค้นแบบละเอียด" }));
    expect(router.push).toHaveBeenCalledWith(`/work/sample/search?q=${encodeURIComponent("ไม่มีอะไร")}`);

    const again = await openPalette();
    await again.user.type(again.input, "สัญญา");
    await again.user.keyboard("{Control>}{Enter}{/Control}");
    expect(router.push).toHaveBeenCalledWith(`/work/sample/search?q=${encodeURIComponent("สัญญา")}`);
  });

  it("Error ของการค้นหาแสดง requestId", async () => {
    searchResponse = () => errorBody(500);
    const { user, dialog, input } = await openPalette();
    await user.type(input, "อะไรก็ได้");
    expect(await dialog.findByText(/req_w16_001/)).toBeInTheDocument();
  });
});

const mountPage = (search: string) => {
  navigation.pathname = "/work/sample/search";
  navigation.search = search;
  return renderWithProviders(<WorkspaceShell ws="sample"><SearchPage ws="sample" /></WorkspaceShell>, { messages: { "search-palette": sp } });
};

describe("หน้าผลการค้นหา", () => {
  it("กลุ่มผลลัพธ์ · จำนวนต่อประเภท · ไฮไลต์ · snippet · สถานะ · ลิงก์งาน ?issue=KEY", async () => {
    mountPage(`q=${encodeURIComponent("สัญญาตัวอย่าง")}`);
    expect(await screen.findByRole("heading", { name: 'ผลการค้นหา "สัญญาตัวอย่าง"' })).toBeInTheDocument();
    expect(screen.getByText(/7 รายการ/)).toBeInTheDocument();
    const results = screen.getByRole("region", { name: "ผลการค้นหา" });
    const issues = within(results).getByRole("group", { name: "งาน" });
    expect(within(issues).getAllByRole("link")).toHaveLength(3);
    expect(within(issues).getByRole("link", { name: /DE-39 ฟอร์มสัญญาตัวอย่าง 3 แบบ/ })).toHaveAttribute("href", "/work/sample/p/DE?issue=DE-39");
    expect(within(issues).getByText("…กดบันทึกสัญญาตัวอย่างแล้วขึ้นข้อผิดพลาด…".slice(0, 9), { exact: false })).toBeInTheDocument();
    expect(within(issues).getByText("Review")).toBeInTheDocument();
    expect(within(results).getByRole("group", { name: "ไฟล์ และคอมเมนต์" })).toBeInTheDocument();
    expect(within(within(results).getByRole("group", { name: "โปรเจกต์" })).getByRole("link")).toHaveAttribute("href", "/work/sample/p/DE");
    const filters = screen.getByRole("complementary", { name: "ตัวกรอง" });
    expect(within(filters).getByRole("checkbox", { name: /งาน \/ Story/ }).closest("label")).toHaveTextContent("งาน / Story1");
    expect(searches[0]?.searchParams.get("limit")).toBe("100");
  });

  it("ตัวกรองประเภท / โปรเจกต์ / เรียง / Archive ส่งไป API และเก็บใน URL", async () => {
    const user = userEvent.setup();
    mountPage(`q=${encodeURIComponent("สัญญาตัวอย่าง")}`);
    const filters = await screen.findByRole("complementary", { name: "ตัวกรอง" });
    await screen.findByRole("group", { name: "งาน" });
    await user.click(within(filters).getByRole("checkbox", { name: /คน/ }));
    expect(screen.queryByRole("group", { name: "คน" })).not.toBeInTheDocument();
    expect(router.replace).toHaveBeenLastCalledWith(expect.stringContaining("type=task%2Csub%2Cbug%2Cproject%2Ccomment%2Cfile"), { scroll: false });
    await user.click(within(filters).getByRole("radio", { name: "แผนพัฒนาผลิตภัณฑ์" }));
    await waitFor(() => expect(searches.at(-1)?.searchParams.get("project")).toBe("DE"));
    await user.click(within(filters).getByRole("checkbox", { name: "รวมโปรเจกต์ที่ Archive" }));
    await waitFor(() => expect(searches.at(-1)?.searchParams.get("archived")).toBe("true"));
    await user.selectOptions(screen.getByRole("combobox", { name: "เรียงลำดับ" }), "updated");
    await waitFor(() => expect(searches.at(-1)?.searchParams.get("sort")).toBe("updated"));
  });

  it("เลือกประเภทเดียวขอเฉพาะชนิดนั้น · ยังไม่เสร็จ ตัดงานที่ Done · มอบหมายให้ฉัน ใช้ my-issues", async () => {
    const user = userEvent.setup();
    mountPage(`q=${encodeURIComponent("สัญญาตัวอย่าง")}&type=task,sub`);
    const results = await screen.findByRole("region", { name: "ผลการค้นหา" });
    await within(results).findByRole("link", { name: /DE-40/ });
    const filters = screen.getByRole("complementary", { name: "ตัวกรอง" });
    await user.click(within(filters).getByRole("checkbox", { name: "ยังไม่เสร็จ" }));
    expect(within(results).queryByRole("link", { name: /DE-40/ })).not.toBeInTheDocument();
    expect(within(results).getByRole("link", { name: /DE-39/ })).toBeInTheDocument();
    await user.click(within(filters).getByRole("checkbox", { name: /Sub-task/ }));
    await waitFor(() => expect(searches.at(-1)?.searchParams.get("type")).toBe("task"));
    await user.click(within(filters).getByRole("checkbox", { name: /Bug/ }));
    await user.click(within(filters).getByRole("checkbox", { name: "มอบหมายให้ฉัน" }));
    // DE-41 เป็นงานเดียวที่มอบหมายให้ฉันใน my-issues
    expect(await within(results).findByRole("link", { name: /DE-41/ })).toBeInTheDocument();
    expect(within(results).queryByRole("link", { name: /DE-39/ })).not.toBeInTheDocument();
  });

  it("การค้นหาที่บันทึก: เปิด · บันทึก (ชื่อ + ตัวกรอง) · ลบ", async () => {
    const user = userEvent.setup();
    mountPage(`q=${encodeURIComponent("สัญญาตัวอย่าง")}&sort=due`);
    const filters = await screen.findByRole("complementary", { name: "ตัวกรอง" });
    await user.click(await within(filters).findByRole("link", { name: "Bug ที่ยังเปิด" }));
    expect(await screen.findByRole("heading", { name: 'ผลการค้นหา "ฟอร์ม"' })).toBeInTheDocument();
    await waitFor(() => expect(searches.at(-1)?.searchParams.get("type")).toBe("bug"));
    expect(within(filters).getByRole("checkbox", { name: "ยังไม่เสร็จ" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "บันทึกการค้นหานี้" }));
    const dialog = await screen.findByRole("dialog", { name: "บันทึกการค้นหา" });
    const name = within(dialog).getByRole("textbox", { name: "ชื่อการค้นหา" });
    expect(name).toHaveValue("ฟอร์ม");
    await user.clear(name);
    await user.type(name, "ฟอร์มที่ค้าง");
    await user.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ name: "ฟอร์มที่ค้าง", query: "ฟอร์ม", filters: { types: ["bug"], open: true, mine: false } });
    expect(await screen.findByText("บันทึกการค้นหาแล้ว")).toBeInTheDocument();
    expect(await within(filters).findByRole("link", { name: "ฟอร์มที่ค้าง" })).toBeInTheDocument();

    await user.click(within(filters).getByRole("button", { name: "ลบ Bug ที่ยังเปิด" }));
    const confirm = await screen.findByRole("dialog", { name: 'ลบการค้นหา "Bug ที่ยังเปิด"?' });
    await user.click(within(confirm).getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(deleted).toEqual(["s-1"]));
    await waitFor(() => expect(within(filters).queryByRole("link", { name: "Bug ที่ยังเปิด" })).not.toBeInTheDocument());
  });

  it("ยังไม่มีคำค้น · ไม่พบ · Error มี requestId · 403", async () => {
    const a = mountPage("");
    expect(await screen.findByRole("heading", { name: "พิมพ์คำค้นเพื่อเริ่มค้นหา" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "บันทึกการค้นหานี้" })).toBeDisabled();
    expect(searches).toHaveLength(0);
    a.unmount();
    const b = mountPage(`q=${encodeURIComponent("ไม่มีอะไร")}`);
    expect(await screen.findByText("ไม่พบผลลัพธ์")).toBeInTheDocument();
    b.unmount();
    searchResponse = () => errorBody(500);
    const c = mountPage("q=x");
    expect(await screen.findByText(/req_w16_001/)).toBeInTheDocument();
    c.unmount();
    searchResponse = () => errorBody(403);
    mountPage("q=x");
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });

  it("พิมพ์คำค้นใหม่แล้วกดค้นหา", async () => {
    const user = userEvent.setup();
    mountPage("");
    const box = await screen.findByRole("searchbox", { name: "คำค้น" });
    await user.type(box, "DE-39{Enter}");
    await waitFor(() => expect(searches.at(-1)?.searchParams.get("q")).toBe("DE-39"));
    expect(router.replace).toHaveBeenLastCalledWith("/work/sample/search?q=DE-39", { scroll: false });
    expect(await screen.findByRole("link", { name: /DE-39/ })).toBeInTheDocument();
  });
});
