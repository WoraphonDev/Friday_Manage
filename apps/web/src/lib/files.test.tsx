// W11 · Files · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation } from "@/test/router";
import { permissions } from "@/test/fixtures";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import files from "../../messages/th/files.json";
import { FilesPage, extOf, flattenFolders, formatBytes, uploadUrl } from "../../app/w/[ws]/p/[key]/files/_components/files-page";
import type { FileDetail, FileItem, Folder } from "../../app/w/[ws]/p/[key]/files/_components/types";

const person = (id: string, displayName: string) => ({ id, displayName, initials: displayName.slice(0, 2), avatarUrl: null });
const A = person("u1", "ผู้พัฒนาหนึ่ง");
const B = person("u2", "ผู้ทดสอบสอง");
const F1 = "00000000-0000-4000-8000-000000000001";
const F2 = "00000000-0000-4000-8000-000000000002";
const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
function file(id: string, name: string, over: Partial<FileItem> = {}): FileItem {
  return { id, name, kind: "upload", mime: "application/pdf", linkUrl: null, linkProvider: null, size: 3_250_000, versionNo: 2, versionCount: 2, folderId: null, uploader: A, createdAt: "2026-11-05T03:00:00Z", updatedAt: "2026-11-05T03:00:00Z", attachments: 1, evidence: false, deletedAt: null, ...over };
}
const folders: Folder[] = [
  { id: D1, name: "เอกสารสัญญา", parentId: null, fileCount: 1, createdAt: "2026-11-01T00:00:00Z" },
  { id: D2, name: "ฉบับร่าง", parentId: D1, fileCount: 0, createdAt: "2026-11-01T00:00:00Z" },
];

let root: FileItem[];
let trashed: FileItem[];
let urls: URL[];
let posts: { path: string; body: unknown }[];
let deletes: { path: string; body: unknown }[];
let patches: { path: string; body: unknown }[];
let puts: number;
let perm: typeof permissions;
const errorBody = (status: number, code = status === 403 ? "guest_view_limited" : "internal_error", details: Record<string, unknown> = {}) =>
  HttpResponse.json({ error: { code, message: "ข้อผิดพลาดทดสอบ", details, requestId: "req_w11_001" } }, { status });
const detail = (f: FileItem): FileDetail => ({
  ...f,
  versions: f.kind === "link" ? [] : [
    { versionNo: 2, size: 3_250_000, note: "แก้ตามความเห็นผู้ใช้", uploader: A, createdAt: "2026-11-05T03:00:00Z", current: true },
    { versionNo: 1, size: 3_000_000, note: null, uploader: B, createdAt: "2026-10-05T03:00:00Z", current: false },
  ],
  attachmentList: [{ id: "at1", targetType: "issue", target: "DE-39", createdAt: "2026-11-05T03:00:00Z" }],
});

beforeEach(() => {
  root = [file(F1, "ข้อกำหนดระบบ.pdf"), file(F2, "ตารางทดสอบ.xlsx", { uploader: B, size: 48_000, versionNo: 1, versionCount: 1, attachments: 0, evidence: true })];
  trashed = [file("00000000-0000-4000-8000-0000000000aa", "ไฟล์เก่า.png", { deletedAt: "2026-11-04T03:00:00Z" })];
  urls = []; posts = []; deletes = []; patches = []; puts = 0;
  perm = { ...permissions, permissions: [...permissions.permissions, "file.upload", "file.delete", "project.trash"] };
  navigation.pathname = "/w/sample/p/DE/files";
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/my-permissions", () => HttpResponse.json(perm)),
    http.get("*/api/v1/w/:ws/projects/:key/folders", () => HttpResponse.json({ rootFileCount: root.length, items: folders })),
    http.get("*/api/v1/w/:ws/projects/:key/files", ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      if (url.searchParams.get("trashed") === "true") return HttpResponse.json({ items: trashed, breadcrumb: [], totalBytes: 0 });
      const folder = url.searchParams.get("folder");
      if (folder === D1) return HttpResponse.json({ items: [file("00000000-0000-4000-8000-0000000000f3", "สัญญาฉบับจริง.pdf", { folderId: D1 })], breadcrumb: [{ id: D1, name: "เอกสารสัญญา" }], totalBytes: 3_250_000 });
      const q = url.searchParams.get("q");
      const items = q ? root.filter((f) => f.name.includes(q)) : root;
      return HttpResponse.json({ items, breadcrumb: [], totalBytes: items.reduce((n, f) => n + (f.size ?? 0), 0) });
    }),
    http.get("*/api/v1/w/:ws/projects/:key/files/:id", ({ params }) => {
      const f = [...root, ...trashed].find((x) => x.id === params.id);
      return f ? HttpResponse.json(detail(f)) : errorBody(404, "not_found");
    }),
    http.post("*/api/v1/w/:ws/projects/:key/files/upload-url", async ({ request }) => {
      const body = await request.json();
      posts.push({ path: "upload-url", body });
      return HttpResponse.json({ method: "PUT", url: "http://localhost:3001/api/v1/storage/upload/tok-1", headers: { "content-type": "application/octet-stream" }, uploadToken: "upload-token-1", expiresAt: "2026-11-06T00:00:00Z", maxBytes: 104857600, storage: "local" });
    }),
    http.put("*/api/v1/storage/upload/:token", () => { puts++; return new HttpResponse(null, { status: 204 }); }),
    http.post("*/api/v1/w/:ws/projects/:key/files", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push({ path: "files", body });
      const created = file("00000000-0000-4000-8000-0000000000f9", body.linkUrl ? "ลิงก์ออกแบบ" : "บันทึกการประชุม.docx", body.linkUrl ? { kind: "link", linkUrl: String(body.linkUrl), linkProvider: "figma", size: null, versionNo: null } : {});
      root = [created, ...root];
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post("*/api/v1/w/:ws/projects/:key/files/:id/versions", async ({ request, params }) => { posts.push({ path: `versions:${params.id}`, body: await request.json() }); return HttpResponse.json(root[0], { status: 201 }); }),
    http.post("*/api/v1/w/:ws/projects/:key/files/:id/attachments", async ({ request, params }) => { posts.push({ path: `attach:${params.id}`, body: await request.json() }); return HttpResponse.json({ attached: true, file: root[0] }); }),
    http.delete("*/api/v1/w/:ws/projects/:key/files/:id/attachments", async ({ request, params }) => { deletes.push({ path: `attach:${params.id}`, body: await request.json() }); return HttpResponse.json({ detached: true }); }),
    http.post("*/api/v1/w/:ws/projects/:key/files/:id/restore", ({ params }) => { posts.push({ path: `restore:${params.id}`, body: null }); return HttpResponse.json(trashed[0]); }),
    http.patch("*/api/v1/w/:ws/projects/:key/files/:id", async ({ request, params }) => { patches.push({ path: `file:${params.id}`, body: await request.json() }); return HttpResponse.json(root[0]); }),
    http.delete("*/api/v1/w/:ws/projects/:key/files/:id", async ({ request, params }) => {
      const body = (await request.json()) as { confirm?: boolean };
      deletes.push({ path: `file:${params.id}`, body });
      const f = root.find((x) => x.id === params.id);
      if (f?.evidence && !body.confirm) return errorBody(409, "file_is_evidence", { evidence: [{ targetType: "bug", ref: "DE-525" }], requiresConfirm: true });
      root = root.filter((x) => x.id !== params.id);
      return HttpResponse.json({ deleted: true, restorableUntil: "2026-12-06T03:00:00Z", evidence: [] });
    }),
    http.post("*/api/v1/w/:ws/projects/:key/folders", async ({ request }) => { const body = (await request.json()) as { name: string }; posts.push({ path: "folders", body }); return HttpResponse.json({ id: D2, name: body.name, parentId: null, fileCount: 0, createdAt: "2026-11-06T00:00:00Z" }, { status: 201 }); }),
    http.delete("*/api/v1/w/:ws/projects/:key/folders/:id", () => errorBody(409, "folder_not_empty")),
  );
});
const mount = () => renderWithProviders(<WorkspaceShell ws="sample"><FilesPage ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { files } });

describe("helpers", () => {
  it("ขนาดไฟล์, ป้ายนามสกุล และต้นไม้โฟลเดอร์", () => {
    expect(formatBytes(3_250_000)).toBe("3.1 MB");
    expect(formatBytes(48_000)).toBe("47 KB");
    expect(formatBytes(null)).toBe("—");
    expect(extOf({ name: "a.xlsx", kind: "upload", linkProvider: null })).toEqual({ label: "XLSX", tone: "xlsx" });
    expect(extOf({ name: "ออกแบบ", kind: "link", linkProvider: "figma" })).toEqual({ label: "FIG", tone: "fig" });
    expect(uploadUrl({ url: "http://localhost:3001/api/v1/storage/upload/tok?x=1", storage: "local" })).toBe("/api/v1/storage/upload/tok?x=1");
    expect(uploadUrl({ url: "https://bucket.example.com/key?sig=1", storage: "s3" })).toBe("https://bucket.example.com/key?sig=1");
    expect(flattenFolders(folders).map((f) => [f.name, f.depth])).toEqual([["เอกสารสัญญา", 0], ["ฉบับร่าง", 1]]);
  });
});

describe("Files (8)", () => {
  it("แสดงโฟลเดอร์, รายการไฟล์, รายละเอียด + เวอร์ชัน + งานที่ผูก · Grid · ค้นหา / เรียงส่ง query", async () => {
    const user = userEvent.setup();
    mount();
    const row = await screen.findByTestId("file-ข้อกำหนดระบบ.pdf");
    expect(within(row).getByText("PDF")).toBeInTheDocument();
    expect(within(row).getByText("3.1 MB")).toBeInTheDocument();
    expect(within(row).getByText("v2")).toBeInTheDocument();
    expect(within(row).getByText("ผูกกับ 1 รายการ")).toBeInTheDocument();
    expect(within(screen.getByTestId("file-ตารางทดสอบ.xlsx")).getByText("หลักฐาน")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "โฟลเดอร์ไฟล์" });
    // Canvas: เริ่มที่ All files (รวมทุกโฟลเดอร์) · มีเมนู Recent / From tasks / ตามประเภท
    expect(within(nav).getByRole("button", { name: /^All files/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(nav).getByRole("button", { name: /^From tasks\d+$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /^Spreadsheets\d+$/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /ไฟล์ของโปรเจกต์2/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(nav).getByRole("button", { name: /ฉบับร่าง0/ })).toBeInTheDocument();
    expect(await within(nav).findByRole("button", { name: /Trash\s*1 · กู้คืนได้ใน 30 วัน/ })).toBeInTheDocument();
    expect(urls[0].searchParams.get("folder")).toBe("root");

    const panel = screen.getByRole("region", { name: "รายละเอียดไฟล์" });
    expect(await within(panel).findByText("แก้ตามความเห็นผู้ใช้ (ปัจจุบัน)")).toBeInTheDocument();
    expect(within(panel).getByText("อัปโหลดครั้งแรก")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "DE-39" })).toHaveAttribute("href", "/w/sample/p/DE/files?issue=DE-39");
    expect(within(panel).getAllByRole("link", { name: "Download" })[0]).toHaveAttribute("href", `/api/v1/w/sample/projects/DE/files/${F1}/download`);
    expect(within(panel).getAllByRole("link", { name: "Download" })[1]).toHaveAttribute("href", `/api/v1/w/sample/projects/DE/files/${F1}/download?version=1`);

    await user.click(screen.getByRole("button", { name: "ตารางทดสอบ.xlsx" }));
    expect(await within(panel).findByRole("heading", { name: "ตารางทดสอบ.xlsx" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Grid" }));
    expect(screen.getByRole("button", { name: /ตารางทดสอบ.xlsx/, pressed: true })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("เรียง"), "name");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("sort")).toBe("name"));
    await user.selectOptions(screen.getByLabelText("ผู้อัปโหลด"), "u2");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("uploader")).toBe("u2"));
    await user.selectOptions(screen.getByLabelText("ผู้อัปโหลด"), "");
    await user.type(screen.getByRole("searchbox", { name: "ค้นหาชื่อไฟล์" }), "ตาราง");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("q")).toBe("ตาราง"));
    expect(urls.at(-1)?.searchParams.has("folder")).toBe(false);
    expect(await screen.findByRole("heading", { name: /ผลการค้นหา “ตาราง”/ })).toBeInTheDocument();
  });

  it("?file= จากลิงก์หลักฐานผลทดสอบเลือกไฟล์นั้นทันที", async () => {
    navigation.search = `file=${F2}`;
    mount();
    const row = await screen.findByTestId("file-ตารางทดสอบ.xlsx");
    await waitFor(() => expect(within(row).getByRole("button", { name: "ตารางทดสอบ.xlsx" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(screen.getByTestId("file-ข้อกำหนดระบบ.pdf")).getByRole("button", { name: "ข้อกำหนดระบบ.pdf" })).toHaveAttribute("aria-pressed", "false");
  });

  it("อัปโหลด 3 ขั้น (upload-url → PUT → ยืนยัน) จากปุ่มและการลากวาง · ไฟล์ใหญ่เกิน 100 MB ไม่ส่ง", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("file-ข้อกำหนดระบบ.pdf");
    await user.upload(screen.getByLabelText("เลือกไฟล์ที่จะอัปโหลด"), new File(["เนื้อหาตัวอย่าง"], "บันทึกการประชุม.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    expect(await screen.findByText("อัปโหลด บันทึกการประชุม.docx แล้ว")).toBeInTheDocument();
    expect(posts[0]).toMatchObject({ path: "upload-url", body: { name: "บันทึกการประชุม.docx", folderId: null } });
    expect(puts).toBe(1);
    expect(posts[1]).toEqual({ path: "files", body: { uploadToken: "upload-token-1" } });
    expect(await screen.findByTestId("file-บันทึกการประชุม.docx")).toBeInTheDocument();

    const big = new File(["x"], "วิดีโอใหญ่.mp4");
    Object.defineProperty(big, "size", { value: 101 * 1024 * 1024 });
    fireEvent.drop(screen.getByTestId("dropzone"), { dataTransfer: { files: [big] } });
    expect(await screen.findByText("วิดีโอใหญ่.mp4 ใหญ่เกิน 100 MB")).toBeInTheDocument();
    expect(posts).toHaveLength(2);

    fireEvent.drop(screen.getByTestId("dropzone"), { dataTransfer: { files: [new File(["ข้อมูล"], "รูปหน้าจอ.png", { type: "image/png" })] } });
    expect(await screen.findByText("อัปโหลด รูปหน้าจอ.png แล้ว")).toBeInTheDocument();
    expect(puts).toBe(2);
  });

  it("อัปโหลดล้มเหลวแสดงข้อความในแถบความคืบหน้า", async () => {
    server.use(http.put("*/api/v1/storage/upload/:token", () => new HttpResponse(null, { status: 500 })));
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("file-ข้อกำหนดระบบ.pdf");
    await user.upload(screen.getByLabelText("เลือกไฟล์ที่จะอัปโหลด"), new File(["x"], "เสีย.pdf"));
    const job = await screen.findByRole("status", { name: "กำลังอัปโหลด เสีย.pdf" });
    expect(await within(job).findByText("อัปโหลดไม่สำเร็จ กรุณาลองอีกครั้ง")).toBeInTheDocument();
    await user.click(within(job).getByRole("button", { name: "ปิด" }));
    expect(screen.queryByRole("status", { name: "กำลังอัปโหลด เสีย.pdf" })).not.toBeInTheDocument();
  });

  it("อัปโหลดเวอร์ชันใหม่ส่ง fileId และยืนยันที่ versions", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("แก้ตามความเห็นผู้ใช้ (ปัจจุบัน)");
    expect(screen.getByRole("button", { name: "Upload new version" })).toBeInTheDocument();
    await user.upload(screen.getByLabelText("เลือกไฟล์เวอร์ชันใหม่"), new File(["v3"], "ข้อกำหนดระบบ-แก้.pdf"));
    expect(await screen.findByText("อัปโหลดเวอร์ชันใหม่ของ ข้อกำหนดระบบ.pdf แล้ว")).toBeInTheDocument();
    expect(posts[0].body).toMatchObject({ fileId: F1 });
    expect(posts[1]).toEqual({ path: `versions:${F1}`, body: { uploadToken: "upload-token-1" } });
  });

  it("แนบลิงก์ (https เท่านั้น) · สร้างโฟลเดอร์ · เข้าโฟลเดอร์มี breadcrumb · ลบโฟลเดอร์ไม่ว่างแสดงข้อความ", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId("file-ข้อกำหนดระบบ.pdf");
    await user.click(screen.getByRole("button", { name: "+ แนบลิงก์ (Figma, Google Drive, Notion)" }));
    const dialog = await screen.findByRole("dialog", { name: "แนบลิงก์" });
    await user.type(within(dialog).getByLabelText("ลิงก์ (https)"), "http://example.com/x");
    await user.click(within(dialog).getByRole("button", { name: "แนบลิงก์" }));
    expect(within(dialog).getByText("รองรับเฉพาะลิงก์ https")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("ลิงก์ (https)"));
    await user.type(within(dialog).getByLabelText("ลิงก์ (https)"), "https://www.figma.com/file/sample");
    await user.click(within(dialog).getByRole("button", { name: "แนบลิงก์" }));
    expect(await screen.findByText("แนบลิงก์แล้ว")).toBeInTheDocument();
    expect(posts.at(-1)).toEqual({ path: "files", body: { linkUrl: "https://www.figma.com/file/sample", folderId: null } });
    const linkRow = await screen.findByTestId("file-ลิงก์ออกแบบ");
    expect(within(linkRow).getByText("FIG")).toBeInTheDocument();
    expect(within(linkRow).getByText("Design · ลิงก์ Figma")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ New folder" }));
    const fd = await screen.findByRole("dialog", { name: "สร้างโฟลเดอร์" });
    await user.type(within(fd).getByLabelText("ชื่อโฟลเดอร์"), "บันทึกประชุม");
    await user.click(within(fd).getByRole("button", { name: "สร้าง" }));
    expect(await screen.findByText("สร้างโฟลเดอร์ บันทึกประชุม แล้ว")).toBeInTheDocument();
    expect(posts.at(-1)).toEqual({ path: "folders", body: { name: "บันทึกประชุม", parentId: null } });

    await user.click(within(screen.getByRole("navigation", { name: "โฟลเดอร์ไฟล์" })).getByRole("button", { name: /เอกสารสัญญา/ }));
    expect(await screen.findByTestId("file-สัญญาฉบับจริง.pdf")).toBeInTheDocument();
    expect(urls.at(-1)?.searchParams.get("folder")).toBe(D1);
    const crumbs = screen.getByRole("navigation", { name: "ตำแหน่งโฟลเดอร์" });
    expect(within(crumbs).getByText("เอกสารสัญญา")).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "ลบโฟลเดอร์" }));
    expect((await screen.findAllByText("ข้อผิดพลาดทดสอบ")).length).toBeGreaterThan(0);
  });

  it("ผูกกับงาน / เลิกผูก · เปลี่ยนชื่อ · ย้ายโฟลเดอร์", async () => {
    const user = userEvent.setup();
    mount();
    const panel = await screen.findByRole("region", { name: "รายละเอียดไฟล์" });
    await within(panel).findByRole("link", { name: "DE-39" });
    await user.click(within(panel).getByRole("button", { name: "+ ผูกกับ Task" }));
    const ad = await screen.findByRole("dialog", { name: "ผูกไฟล์กับงาน" });
    await user.type(within(ad).getByLabelText("รหัสงาน"), "de-40");
    await user.click(within(ad).getByRole("button", { name: "ผูก" }));
    expect(await screen.findByText("ผูกกับ DE-40 แล้ว")).toBeInTheDocument();
    expect(posts.at(-1)).toEqual({ path: `attach:${F1}`, body: { targetType: "issue", target: "DE-40" } });

    await user.click(within(panel).getByRole("button", { name: "เลิกผูกกับ DE-39" }));
    await waitFor(() => expect(deletes.at(-1)).toEqual({ path: `attach:${F1}`, body: { targetType: "issue", target: "DE-39" } }));

    await user.click(within(panel).getByRole("button", { name: "Rename" }));
    const rd = await screen.findByRole("dialog", { name: "เปลี่ยนชื่อไฟล์" });
    await user.clear(within(rd).getByLabelText("ชื่อไฟล์"));
    await user.type(within(rd).getByLabelText("ชื่อไฟล์"), "ข้อกำหนดระบบ-ฉบับสุดท้าย.pdf");
    await user.click(within(rd).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(patches.at(-1)).toEqual({ path: `file:${F1}`, body: { name: "ข้อกำหนดระบบ-ฉบับสุดท้าย.pdf" } }));

    await user.click(within(panel).getByRole("button", { name: "Move" }));
    const md = await screen.findByRole("dialog", { name: /ย้าย/ });
    await user.selectOptions(within(md).getByLabelText("ย้ายไปที่"), D2);
    await user.click(within(md).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(patches.at(-1)).toEqual({ path: `file:${F1}`, body: { folderId: D2 } }));
    expect(await screen.findByText("ย้าย ข้อกำหนดระบบ.pdf ไป ฉบับร่าง แล้ว")).toBeInTheDocument();
  });

  it("ลบหลักฐานต้องยืนยันอีกครั้ง · ลบแล้วเลิกทำ (กู้คืน) · ถังขยะกู้คืนได้", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "ตารางทดสอบ.xlsx" }));
    const panel = screen.getByRole("region", { name: "รายละเอียดไฟล์" });
    await within(panel).findByRole("heading", { name: "ตารางทดสอบ.xlsx" });
    await user.click(within(panel).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "ไฟล์นี้เป็นหลักฐาน" });
    expect(dialog).toHaveTextContent("Bug DE-525");
    expect(deletes[0]).toEqual({ path: `file:${F2}`, body: { confirm: false } });
    await user.click(within(dialog).getByRole("button", { name: "ลบต่อ" }));
    await waitFor(() => expect(deletes.at(-1)).toEqual({ path: `file:${F2}`, body: { confirm: true } }));
    expect(await screen.findByText(/ย้าย ตารางทดสอบ.xlsx ไปถังขยะแล้ว · กู้คืนได้ถึง/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เลิกทำ" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: `restore:${F2}`, body: null }));

    await user.click(within(screen.getByRole("navigation", { name: "โฟลเดอร์ไฟล์" })).getByRole("button", { name: /Trash/ }));
    const row = await screen.findByTestId("file-ไฟล์เก่า.png");
    expect(screen.getByRole("columnheader", { name: "ลบเมื่อ" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "รายละเอียดไฟล์" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("dropzone")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "กู้คืน" }));
    expect(await screen.findByText("กู้คืน ไฟล์เก่า.png แล้ว")).toBeInTheDocument();
  });

  it("ไม่มี file.upload / file.delete / project.trash: ซ่อนปุ่มอัปโหลด แก้ไข ลบ และถังขยะ", async () => {
    perm = { ...permissions, role: "viewer" };
    mount();
    const panel = await screen.findByRole("region", { name: "รายละเอียดไฟล์" });
    await within(panel).findByText("แก้ตามความเห็นผู้ใช้ (ปัจจุบัน)");
    expect(screen.queryByTestId("dropzone")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Trash/ })).not.toBeInTheDocument();
    for (const name of ["Upload new version", "Rename", "Move", "Delete", "+ ผูกกับ Task", "เลิกผูกกับ DE-39"]) expect(within(panel).queryByRole("button", { name })).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(urls.every((u) => u.searchParams.get("trashed") !== "true")).toBe(true);
  });

  it("ว่าง · Error มี requestId · Guest / 403", async () => {
    root = [];
    const a = mount();
    expect(await screen.findByRole("heading", { name: "ยังไม่มีไฟล์ในที่นี้" })).toBeInTheDocument();
    a.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/files", () => errorBody(500)));
    const b = mount();
    expect(await screen.findByText(/req_w11_001/)).toBeInTheDocument();
    b.unmount();
    server.use(http.get("*/api/v1/w/:ws/projects/:key/files", () => errorBody(403)));
    const c = mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
    c.unmount();
    perm = { ...permissions, role: null, guestViewer: true };
    mount();
    expect(await screen.findByRole("heading", { name: /ไม่มีสิทธิ์/ })).toBeInTheDocument();
  });
});
