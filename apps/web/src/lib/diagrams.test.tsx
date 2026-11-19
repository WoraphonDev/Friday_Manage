// แท็บ Diagram · หน้ารายการ, หน้าต่างสร้าง, แพ็กเกจ Free และโหมดดูเมื่อมีคนแก้อยู่ · ข้อมูลสมมติเท่านั้น
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/test/server";
import { navigation, router } from "@/test/router";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import diagrams from "../../messages/th/diagrams.json";
import { DiagramListPage } from "@/features/diagrams/diagram-list";
import { DiagramEditorPage } from "@/features/diagrams/diagram-editor";
import type { Diagram, DiagramSummary } from "@/features/diagrams/types";

const person = (id: string, displayName: string) => ({ id, displayName, initials: displayName.slice(0, 2), avatarUrl: null });
const LEAD = person("sample-lead", "หัวหน้าทีมตัวอย่าง");
const DEV = person("u2", "นักพัฒนาสอง");
const ID = "00000000-0000-4000-8000-0000000000d1";
const ISSUE = "00000000-0000-4000-8000-0000000000a1";

function summary(over: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    id: ID,
    name: "Workflow อนุมัติวงเงิน",
    description: null,
    template: "flowchart",
    issueCount: 2,
    createdBy: LEAD,
    updatedBy: LEAD,
    createdAt: "2026-11-18T03:00:00Z",
    updatedAt: "2026-11-19T03:00:00Z",
    lock: null,
    deletedAt: null,
    deletedBy: null,
    preview: { nodes: [{ id: "a", t: "process", x: 0, y: 0, w: 180, h: 60, s: "overdue" }, { id: "b", t: "decision", x: 0, y: 120, w: 150, h: 90, s: null }], edges: [["a", "b"]] },
    ...over,
  };
}
function detail(over: Partial<Diagram> = {}): Diagram {
  return {
    id: ID,
    name: "Workflow อนุมัติวงเงิน",
    description: null,
    template: "flowchart",
    content: {
      nodes: [
        { id: "a", type: "process", position: { x: 0, y: 0 }, width: 180, height: 86, data: { label: "ตรวจหลักประกัน", color: "default", issueId: ISSUE } },
        { id: "b", type: "decision", position: { x: 0, y: 140 }, data: { label: "ผ่านเกณฑ์?", color: "default", issueId: null } },
      ],
      edges: [{ id: "e1", source: "a", target: "b", label: "ต่อ" }],
    },
    revision: 3,
    createdBy: LEAD,
    updatedBy: DEV,
    createdAt: "2026-11-18T03:00:00Z",
    updatedAt: "2026-11-19T03:00:00Z",
    lock: null,
    lockMs: 300_000,
    issues: { [ISSUE]: { id: ISSUE, key: "DE-39", title: "ฟอร์มหลักประกัน", status: "In progress", category: "in_progress", tone: "overdue", dueDate: "2026-11-01", deleted: false } },
    permissions: { edit: true, takeover: true, delete: true },
    ...over,
  };
}

let listUrls: URL[];
let posts: { path: string; body: unknown }[];
let listResponse: () => Response;
let detailResponse: () => Response;

beforeEach(() => {
  listUrls = [];
  posts = [];
  router.push.mockClear();
  navigation.pathname = "/work/sample/p/DE/diagrams";
  listResponse = () => HttpResponse.json({ items: [summary(), summary({ id: "d2", name: "ER Credit Line", template: "er", issueCount: 0, lock: { user: DEV, userId: DEV.id, until: "2026-11-19T04:00:00Z" } })], permissions: { edit: true, takeover: true, delete: true, trash: true } });
  detailResponse = () => HttpResponse.json(detail());
  server.use(
    http.get("*/api/v1/w/:ws/projects/:key/diagrams", ({ request }) => {
      listUrls.push(new URL(request.url));
      return listResponse();
    }),
    http.get("*/api/v1/w/:ws/projects/:key/diagrams/:id", () => detailResponse()),
    http.post("*/api/v1/w/:ws/projects/:key/diagrams", async ({ request }) => {
      const body = await request.json();
      posts.push({ path: new URL(request.url).pathname, body });
      return HttpResponse.json(detail({ id: "new-id", name: (body as { name: string }).name, lock: { user: LEAD, userId: LEAD.id, until: "2026-11-19T04:00:00Z" } }), { status: 201 });
    }),
    http.post("*/api/v1/w/:ws/projects/:key/diagrams/:id/lock", async ({ request }) => {
      posts.push({ path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json(detail({ lock: { user: LEAD, userId: LEAD.id, until: "2026-11-19T04:00:00Z" } }));
    }),
  );
});

const mountList = () => renderWithProviders(<WorkspaceShell ws="sample"><DiagramListPage ws="sample" projectKey="DE" /></WorkspaceShell>, { messages: { diagrams } });
const mountEditor = () => renderWithProviders(<WorkspaceShell ws="sample"><DiagramEditorPage ws="sample" projectKey="DE" id={ID} /></WorkspaceShell>, { messages: { diagrams } });

describe("หน้ารายการ Diagram", () => {
  it("แสดงการ์ดพร้อมประเภท จำนวนงานที่ผูก และป้ายคนที่กำลังแก้ · กรองตามประเภทส่งไปที่ API", async () => {
    const user = userEvent.setup();
    mountList();
    const card = (await screen.findByText("Workflow อนุมัติวงเงิน")).closest("a")!;
    expect(card).toHaveAttribute("href", `/work/sample/p/DE/diagrams/${ID}`);
    expect(within(card).getByText("ผูก 2 งาน")).toBeInTheDocument();
    expect(screen.getByText("นักพัฒนาสอง กำลังแก้ไข")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("ประเภท"), "er");
    await waitFor(() => expect(listUrls.at(-1)?.searchParams.get("template")).toBe("er"));
  });

  it("สร้างจากแบบ Flowchart แล้วเปิดหน้าแก้ไขของ Diagram ใหม่", async () => {
    const user = userEvent.setup();
    mountList();
    await screen.findByText("Workflow อนุมัติวงเงิน");
    await user.click(screen.getByRole("button", { name: "Diagram ใหม่" }));
    const dialog = await screen.findByRole("dialog", { name: "Diagram ใหม่" });
    await user.click(within(dialog).getByRole("button", { name: "สร้าง" }));
    expect(within(dialog).getByText("ต้องตั้งชื่อ Diagram")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("ชื่อ"), "Flow ชำระเงิน");
    await user.click(within(dialog).getByRole("button", { name: /Flowchart/ }));
    await user.click(within(dialog).getByRole("button", { name: "สร้าง" }));
    await waitFor(() => expect(posts[0]).toMatchObject({ path: "/api/v1/w/sample/projects/DE/diagrams", body: { name: "Flow ชำระเงิน", template: "flowchart", description: null } }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/work/sample/p/DE/diagrams/new-id"));
  });

  it("แพ็กเกจ Free (402) แสดงข้อความชวนอัปเกรดในหน้าแทนรายการ", async () => {
    listResponse = () => HttpResponse.json({ error: { code: "plan_feature_unavailable", message: "Free ยังไม่มี Diagram", details: { feature: "diagrams", plan: "free" } } }, { status: 402 });
    mountList();
    expect(await screen.findByRole("heading", { name: "Diagram ใช้ได้ในแพ็กเกจ Team ขึ้นไป" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diagram ใหม่" })).not.toBeInTheDocument();
  });

  it("Viewer ไม่เห็นปุ่มสร้าง · รายการว่างบอกว่าทีมสร้างแล้วจะแสดงที่นี่", async () => {
    listResponse = () => HttpResponse.json({ items: [], permissions: { edit: false, takeover: false, delete: false, trash: false } });
    mountList();
    expect(await screen.findByText("เมื่อทีมสร้าง Diagram จะแสดงที่นี่")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diagram ใหม่" })).not.toBeInTheDocument();
  });
});

describe("หน้าแก้ไข Diagram", () => {
  it("มีคนอื่นแก้อยู่: แถบเหลืองบอกชื่อ ปุ่มแก้ไขกดไม่ได้ · Admin แก้ไขแทนได้หลังยืนยัน", async () => {
    detailResponse = () => HttpResponse.json(detail({ lock: { user: DEV, userId: DEV.id, until: "2026-11-19T04:00:00Z" } }));
    const user = userEvent.setup();
    mountEditor();
    expect(await screen.findByText(/นักพัฒนาสอง กำลังแก้ไข · คุณดูได้อย่างเดียว/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "แก้ไข" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "แก้ไขแทน" }));
    const dialog = await screen.findByRole("dialog", { name: "แก้ไขแทน นักพัฒนาสอง?" });
    await user.click(within(dialog).getByRole("button", { name: "แก้ไขแทน" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/api/v1/w/sample/projects/DE/diagrams/${ID}/lock`, body: { takeover: true } }));
    expect(await screen.findByRole("button", { name: "เสร็จสิ้น" })).toBeInTheDocument();
  });

  it("ไม่มีใครแก้: กดแก้ไขแล้วขอสิทธิ์ และเห็นแถบรูปทรงทุกหมวด", async () => {
    const user = userEvent.setup();
    mountEditor();
    await user.click(await screen.findByRole("button", { name: "แก้ไข" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/api/v1/w/sample/projects/DE/diagrams/${ID}/lock`, body: { takeover: false } }));
    expect(await screen.findByPlaceholderText("ค้นหารูปทรง")).toBeInTheDocument();
    for (const shape of ["เงื่อนไข", "ตาราง", "Database", "โน้ต"]) expect(screen.getByRole("button", { name: new RegExp(shape) })).toBeInTheDocument();
  });
});

describe("บรรทัด Diagram ในแผงรายละเอียดงาน", () => {
  it("แสดงลิงก์ Diagram ที่ผูกงานนี้ · ไม่มีก็ไม่แสดงแถว", async () => {
    const { IssueDiagrams } = await import("@/features/diagrams/issue-diagrams");
    const row = (links: React.ReactNode) => <div data-testid="row">{links}</div>;
    const { unmount } = renderWithProviders(<IssueDiagrams ws="sample" projectKey="DE" issueId={ISSUE} render={row} />);
    expect(await screen.findByRole("link", { name: "Workflow อนุมัติวงเงิน" })).toHaveAttribute("href", `/work/sample/p/DE/diagrams/${ID}`);
    await waitFor(() => expect(listUrls.at(-1)?.searchParams.get("issue")).toBe(ISSUE));
    unmount();
    listResponse = () => HttpResponse.json({ items: [], permissions: { edit: true, takeover: false, delete: false } });
    renderWithProviders(<IssueDiagrams ws="sample" projectKey="DE" issueId={ISSUE} render={row} />);
    await waitFor(() => expect(listUrls).toHaveLength(2));
    expect(screen.queryByTestId("row")).not.toBeInTheDocument();
  });
});
