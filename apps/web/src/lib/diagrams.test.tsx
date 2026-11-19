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
        { id: "a", type: "process", position: { x: 0, y: 0 }, width: 180, height: 86, data: { label: "ตรวจหลักประกัน", color: "default", issueIds: [ISSUE] } },
        { id: "b", type: "decision", position: { x: 0, y: 140 }, data: { label: "ผ่านเกณฑ์?", color: "default", issueIds: [] } },
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
    expect(await screen.findByPlaceholderText(/ค้นหารูปทรง/)).toBeInTheDocument();
    for (const shape of ["เงื่อนไข", "Lane แนวนอน", "Database", "สามเหลี่ยม"]) expect(screen.getByRole("button", { name: shape })).toBeInTheDocument();
    // หมวด UML / ER พับไว้ก่อน กดหัวหมวดเพื่อเปิด
    await user.click(screen.getByRole("button", { name: /^ER/ }));
    expect(screen.getByRole("button", { name: "ตาราง" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "เครื่องมือ" })).toBeInTheDocument();
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

describe("ฟังก์ชันของ editor", () => {
  it("แปลงข้อมูลเดิม issueId เป็น issueIds และเก็บกลับโดยไม่มีค่าว่าง", async () => {
    const { toContent, toFlowNode } = await import("@/features/diagrams/ops");
    const n = toFlowNode({ id: "a", type: "process", position: { x: 1.4, y: 2.6 }, data: { label: "x", color: "default", issueIds: [], issueId: ISSUE } });
    expect(n.data.issueIds).toEqual([ISSUE]);
    const c = toContent([n], []);
    expect(c.nodes[0]).toEqual({ id: "a", type: "process", position: { x: 1, y: 3 }, width: 180, height: 60, data: { label: "x", color: "default", issueIds: [ISSUE] } });
  });

  it("จัดชิดซ้าย · เว้นระยะเท่ากัน · กล่องในกรอบ", async () => {
    const { align, childrenOf, distribute, toFlowNode } = await import("@/features/diagrams/ops");
    const box = (id: string, x: number, y: number) => toFlowNode({ id, type: "process", position: { x, y }, width: 100, height: 50, data: { label: id, color: "default", issueIds: [] } });
    const nodes = [box("a", 0, 0), box("b", 40, 100), box("c", 500, 200)];
    const ids = new Set(["a", "b", "c"]);
    expect(align(nodes, ids, "left").map((n) => n.position.x)).toEqual([0, 0, 0]);
    expect(distribute(nodes, ids).map((n) => n.position.x)).toEqual([0, 250, 500]);
    const frame = toFlowNode({ id: "f", type: "frame", position: { x: -10, y: -10 }, width: 200, height: 200, data: { label: "f", color: "default", issueIds: [] } });
    expect(childrenOf([...nodes, frame], frame)).toEqual(["a", "b"]);
  });
});

describe("หน้าต่างผูกงาน", () => {
  it("เปิดมาเห็นงานพร้อมกลุ่ม · พิมพ์ค้นแล้วส่ง q · เลือกหลายงานแล้วผูก", async () => {
    const { LinkDialog } = await import("@/features/diagrams/link-dialog");
    const urls: URL[] = [];
    const item = (n: number, over = {}) => ({ id: `00000000-0000-4000-8000-00000000010${n}`, key: `DE-${n}`, title: `หลักประกันงาน ${n}`, parentKey: null, level: "task", module: { id: "m1", name: "Credit Line" }, phase: { id: "p1", name: "หลักประกัน" }, status: "To do", category: "todo", tone: "todo", dueDate: "2026-12-01", assignee: DEV, ...over });
    server.use(
      http.get("*/api/v1/w/:ws/projects/:key/diagram-issues", ({ request }) => {
        urls.push(new URL(request.url));
        return HttpResponse.json({ items: [item(1), item(2, { level: "subtask", parentKey: "DE-1" })], total: 2, page: 1, hasMore: false });
      }),
      http.get("*/api/v1/w/:ws/projects/:key/diagram-issue-filters", () => HttpResponse.json({ modules: [{ id: "m1", name: "Credit Line" }], phases: [{ id: "p1", name: "หลักประกัน", moduleId: "m1" }], sprints: [], people: [DEV] })),
    );
    const saved: string[][] = [];
    const user = userEvent.setup();
    renderWithProviders(<LinkDialog open onOpenChange={() => {}} base="/w/sample/projects/DE" boxLabel="กรอกหลักประกัน" linked={[]} issues={{}} onSave={(ids) => saved.push(ids)} />, { messages: { diagrams } });
    const dialog = await screen.findByRole("dialog", { name: 'ผูกงานกับกล่อง "กรอกหลักประกัน"' });
    expect(await within(dialog).findByRole("group", { name: "Credit Line › หลักประกัน" })).toBeInTheDocument();
    expect(urls[0].searchParams.get("status")).toBe("todo,in_progress,review,blocked");
    await user.type(within(dialog).getByLabelText(/ค้นด้วยเลขงาน/), "หลักประกัน");
    await waitFor(() => expect(urls.at(-1)?.searchParams.get("q")).toBe("หลักประกัน"));
    await user.click(within(dialog).getByRole("option", { name: /^DE-1/ }));
    await user.click(within(dialog).getByRole("option", { name: /^DE-2/ }));
    await user.click(within(dialog).getByRole("button", { name: "ผูก 2 งาน" }));
    expect(saved).toEqual([[item(1).id, item(2).id]]);
  });
});
