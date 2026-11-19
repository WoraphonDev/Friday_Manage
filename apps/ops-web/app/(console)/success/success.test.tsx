// O53 · สุขภาพและ Playbook · ข้อมูลสมมติเท่านั้น
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { SuccessPage } from "./SuccessPage";

const today = new Date().toISOString().slice(0, 10);
const steps = [
  { kind: "email", title: "เคล็ดลับให้ทีมกลับมาใช้", days: 0 },
  { kind: "task", title: "โทรหา Owner ถามว่าติดอะไร", days: 2, branches: { reached: 2, no_answer: 4, will_cancel: 3 } },
  { kind: "task", title: "นัดสอนใช้งาน 30 นาที", days: 5 },
  { kind: "task", title: "เสนอส่วนลด 1 เดือน", days: 2, branches: { will_cancel: "close" } },
  { kind: "wait", title: "รอ 14 วัน แล้วดูคะแนนอีกครั้ง", days: 14 },
];
const summary = {
  paying: 1126, low: 58, mrrAtRisk: 21_430_000, recoveredPct: 61,
  todo: { mine: 1, overdue: 1, items: [{ id: "st1", title: "โทรหา Owner ถามว่าติดอะไร", dueOn: today, assigneeId: "00000000-0000-4000-8000-000000000003", assignee: "สมหญิง", runId: "r1", playbook: "ใช้งานลดลง", step: 2, steps: 5, workspaceId: "w1", workspace: "Nordlight", score: 31, overdue: true }] },
  tabs: { active: 58, dropped: 7, recovered: 94, churned: 11 },
};
const row = { runId: "r1", workspaceId: "w1", name: "Nordlight", slug: "nordlight", plan: "team_m", score: 31, score7: 45, usage: 22, payment: 100, support: 60, growth: 40, playbook: "ใช้งานลดลง", status: "active", closedAt: null, closeReason: null, owner: "สมหญิง", mrr: 640_000, next: { id: "st1", title: "โทรหา Owner ถามว่าติดอะไร", kind: "task", dueOn: today } };
const detail = {
  id: "r1", status: "active", closeReason: null, startedAt: today, owner: "สมหญิง",
  workspace: { id: "w1", name: "Nordlight", slug: "nordlight", plan: "team_m", createdAt: new Date(Date.now() - 430 * 86_400_000).toISOString(), seats: 24, ownerEmail: "owner@nordlight.example.com", mrr: 640_000 },
  health: { score: 31, usage: 22, payment: 100, support: 60, growth: 40 },
  playbook: { id: "p1", key: "usage_drop", name: "ใช้งานลดลง", steps },
  steps: [
    { id: "s0", stepIndex: 0, kind: "email", title: "เคล็ดลับให้ทีมกลับมาใช้", status: "done", outcome: "sent", note: "ส่ง 1 อีเมล", dueOn: null, doneAt: new Date().toISOString(), assignee: null },
    { id: "st1", stepIndex: 1, kind: "task", title: "โทรหา Owner ถามว่าติดอะไร", status: "pending", outcome: null, note: null, dueOn: today, doneAt: null, assignee: "สมหญิง" },
  ],
};

function page() {
  navigation.pathname = "/success";
  navigation.search = "";
  server.use(
    http.get(`${OPS}/success/summary`, () => HttpResponse.json(summary)),
    http.get(`${OPS}/success/runs`, () => HttpResponse.json({ items: [row], total: 1 })),
    http.get(`${OPS}/success/runs/r1`, () => HttpResponse.json(detail)),
    http.get(`${OPS}/success/playbooks`, () => HttpResponse.json({ items: [{ id: "p1", key: "usage_drop", name: "ใช้งานลดลง", enabled: true, trigger: { kind: "usage_drop", threshold: 40, days: 3 }, steps, matching: 23, active: 18 }] })),
  );
  return renderWithProviders(
    <AppShell>
      <SuccessPage />
    </AppShell>,
  );
}

describe("สุขภาพและ Playbook", () => {
  it("ขั้น 1: ตัวเลขหัวหน้า · งานครบกำหนดวันนี้ · ตารางพร้อมส่วนที่ต่ำและคะแนนที่ลด", async () => {
    asRole("support");
    page();
    expect(await screen.findByText("จ่ายเงิน 1,126 ราย · สุขภาพต่ำกว่า 40: 58 · MRR ที่เสี่ยง ฿214,300 · ฟื้นใน 30 วัน 61%")).toBeInTheDocument();
    const todo = await screen.findByRole("region", { name: "ต้องทำวันนี้" });
    expect(within(todo).getByText("ของฉัน 1 · เลยกำหนด 1")).toBeInTheDocument();
    expect(within(todo).getByText("ใช้งานลดลง · ขั้น 2/5 โทรหา Owner ถามว่าติดอะไร")).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("↓14")).toBeInTheDocument();
    expect(within(table).getByText("การใช้งาน 22%")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ฟื้นแล้ว\s*94/ })).toBeInTheDocument();
  });

  it("ขั้น 2: แผงขวาแสดงคะแนนแยกส่วน · checklist · บันทึกผลการโทรแล้วไปขั้นถัดไป", async () => {
    asRole("support");
    let body: unknown = null;
    server.use(http.post(`${OPS}/success/steps/st1/outcome`, async ({ request }) => ((body = await request.json()), HttpResponse.json(detail))));
    page();
    await userEvent.click(within(await screen.findByRole("region", { name: "ต้องทำวันนี้" })).getByRole("button", { name: "บันทึกผล" }));
    const drawer = await screen.findByRole("dialog", { name: "Nordlight · Team M" });
    expect(within(drawer).getByText("Owner: owner@nordlight.example.com · 24 ที่นั่ง · ลูกค้า 14 เดือน")).toBeInTheDocument();
    expect(within(drawer).getByRole("list", { name: "สุขภาพ 31" })).toHaveTextContent("การใช้งาน22%");
    expect(within(drawer).getByText(/ถ้าติดต่อได้ → ขั้น 3 · ถ้าไม่รับสาย → ขั้น 5 · ถ้าจะยกเลิก → ขั้น 4/)).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "ไม่รับสาย" }));
    await userEvent.type(within(drawer).getByLabelText("บันทึกการคุย"), "โทร 2 ครั้งไม่รับ");
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึก · ไปขั้นถัดไป" }));
    await waitFor(() => expect(body).toEqual({ outcome: "no_answer", note: "โทร 2 ครั้งไม่รับ" }));
  });

  it("ขั้น 3 ปุ่มเฟือง: Owner แก้ Playbook ได้ · Support อ่านอย่างเดียว", async () => {
    asRole("admin");
    let body: Record<string, unknown> = {};
    server.use(http.put(`${OPS}/success/playbooks/p1`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ id: "p1" }))));
    page();
    await userEvent.click(await screen.findByRole("button", { name: "Playbook" }));
    const drawer = await screen.findByRole("dialog", { name: "Playbook" });
    expect(await within(drawer).findByText("ลูกค้าที่จ่ายเงิน และคะแนนการใช้งานต่ำกว่า 40% ติดกัน 3 วัน")).toBeInTheDocument();
    expect(within(drawer).getByText("มีลูกค้าตรงเงื่อนไขตอนนี้ 23 ราย · อยู่ใน Playbook 18")).toBeInTheDocument();
    const days = within(drawer).getByLabelText("ติดกัน (วัน)");
    fireEvent.change(days, { target: { value: "5" } });
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(body).toMatchObject({ enabled: true, trigger: { kind: "usage_drop", threshold: 40, days: 5 }, steps }));
  });
});
