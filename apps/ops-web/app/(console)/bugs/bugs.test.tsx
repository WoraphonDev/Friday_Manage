// O36 · ส่งบั๊กให้ทีมพัฒนา: หน้า 20 · T3 (สร้าง / ผูก / อาจซ้ำ / ยังไม่ตั้งค่า) · T7 · T8 · T9 · T10 · T11 · แท็บรอทีมพัฒนา · ซ่อนตามบทบาท
// ข้อมูลสมมติเท่านั้น
import { startAuthentication } from "@simplewebauthn/browser";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { SupportPage } from "../support/SupportPage";
import type { LinkDetail, LinkRow, Overview, Settings } from "./_components/types";
import { BugsPage } from "./BugsPage";

// เครื่องที่โหลดสูงใช้เวลานานกว่าค่าเริ่มต้น
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30000 });

const L1 = "d0000000-0000-4000-8000-000000000482";
const L2 = "d0000000-0000-4000-8000-000000000490";
const T = "70000000-0000-4000-8000-000000000512";
const today = new Date(new Date().setHours(15, 5, 0, 0)).toISOString();

const settings: Settings = {
  configured: true, apiBaseUrl: "http://api:3001", workspaceSlug: "friday-dev", projectKey: "FM", tokenHint: "…3f9a", tokenExpiresAt: "2027-01-09T00:00:00.000Z",
  hasWebhookSecret: true, webhookPath: "/ops/hooks/fm", mapping: { severityPriority: { S1: "urgent", S2: "high", S3: "medium", S4: "low" }, releasedStatus: "Released", label: "from-support", issueType: "Bug" },
  lastWebhookAt: new Date(Date.now() - 120_000).toISOString(), lastTestAt: null, lastTestOk: null, projectUrl: "http://localhost:3000/work/friday-dev/p/FM", canEdit: true,
};
const overview: Overview = {
  kpi: { openBugs: 14, bySeverity: { S1: 0, S2: 3, S3: 8, S4: 3 }, ticketsWaiting: 21, workspaces: 17, avgFixDaysS2: 2.8, toNotify: 3, linksToNotify: 1 },
  released: [{ linkId: L1, issueKey: "FM-482", releasedAt: today, tickets: 3 }],
  connection: settings,
  canNotify: true,
};
const row = (over: Partial<LinkRow>): LinkRow => ({
  id: L1, issueKey: "FM-482", title: "นำเข้าโหมดอัปเดต: Sub-task หายเมื่อ Parent Key ว่าง", severity: "S2", statusName: "Released", statusCategory: "done", resolution: null, duplicateOfKey: null,
  assigneeName: "Dev A", sprintName: "Sprint 24", dueDate: null, doneAt: today, releasedAt: today, createdAt: "2026-11-05T02:00:00.000Z", tickets: 3, unnotified: 3, workspaces: ["Orbit Apps", "TechNova"], ...over,
});
const rows: LinkRow[] = [
  row({}),
  row({ id: "l-455", issueKey: "FM-455", title: "Gantt ช้าเมื่อโปรเจกต์มีงานเกิน 500 งาน", severity: "S3", statusName: "In progress", statusCategory: "in_progress", doneAt: null, releasedAt: null, unnotified: 0, tickets: 4, dueDate: "2026-11-18" }),
  row({ id: L2, issueKey: "FM-490", title: "ไอคอนบางจุดมองไม่เห็นในโหมดมืด", severity: "S4", statusName: "Duplicate", statusCategory: "cancelled", resolution: "duplicate", duplicateOfKey: "FM-466", doneAt: null, releasedAt: null, tickets: 1, unnotified: 1, workspaces: ["Lumen Studio"] }),
];

type Call = { method: string; path: string; body: unknown };
function bridge(extra: { settings?: Settings } = {}) {
  const calls: Call[] = [];
  const rec = (method: string, path: string, body: unknown) => calls.push({ method, path, body });
  const s = extra.settings ?? settings;
  server.use(
    http.get(`${OPS}/dev-bridge/overview`, () => HttpResponse.json({ ...overview, connection: s })),
    http.get(`${OPS}/dev-bridge/settings`, () => HttpResponse.json(s)),
    http.get(`${OPS}/dev-bridge/links`, ({ request }) => {
      const f = new URL(request.url).searchParams.get("filter");
      rec("GET", `links?filter=${f}`, null);
      const items = f === "not_fixed" ? [rows[2]] : f === "to_notify" ? [rows[0]] : f === "closed30" ? [] : rows;
      return HttpResponse.json({ items, counts: { open: 14, to_notify: 2, not_fixed: 3, closed30: 22 } });
    }),
    http.get(`${OPS}/dev-bridge/links/:id/notify`, () =>
      HttpResponse.json({
        link: { id: L1, issueKey: "FM-482", title: "นำเข้าโหมดอัปเดต", doneAt: today, releasedAt: today, releaseVersion: "v1.18.2" },
        tickets: [
          { id: "t1", number: 512, subject: "นำเข้า Excel แล้ว Sub-task หาย", status: "pending_dev", workspace: "Orbit Apps", email: "ops@orbit.example", requester: "ปิยะ" },
          { id: "t2", number: 520, subject: "อัปเดตแผนแล้วงานย่อยหาย", status: "pending_dev", workspace: "TechNova", email: "pm@technova.example", requester: "สมชาย" },
        ],
        message: "สวัสดีครับ คุณ{ชื่อผู้แจ้ง}\nปัญหาที่แจ้งใน #{เลข Ticket} แก้แล้ว",
        reopenDays: 7,
      }),
    ),
    http.post(`${OPS}/dev-bridge/links/:id/notify`, async ({ request, params }) => (rec("POST", `notify/${params.id}`, await request.json()), HttpResponse.json({ notified: 2, emailed: 2, changelogId: null }))),
    http.post(`${OPS}/dev-bridge/links/:id/resolve`, async ({ request, params }) => {
      const body = (await request.json()) as { action: string };
      rec("POST", `resolve/${params.id}`, body);
      return HttpResponse.json(body.action === "link_fixed" ? { moved: 1, linkId: "x", issueKey: "FM-466" } : body.action === "return" ? { returned: 1 } : { notified: 1, emailed: 1 });
    }),
    http.post(`${OPS}/dev-bridge/settings/test`, () => (rec("POST", "test", null), HttpResponse.json({ ok: false, checks: [{ key: "token", ok: true, message: "บัญชีบอท: support-bot" }, { key: "project", ok: true, message: "FM · Friday Work Management" }, { key: "released", ok: false, message: 'ยังไม่มีสถานะ "Released" ใน workflow' }] }))),
  );
  return calls;
}
const page = () => {
  navigation.pathname = "/bugs";
  renderWithProviders(
    <AppShell>
      <BugsPage />
    </AppShell>,
  );
};

describe("หน้า 20 · ส่งบั๊กให้ทีมพัฒนา", () => {
  it("แถบขึ้น production · KPI · ตัวกรองพร้อมจำนวน · ตาราง · การเชื่อมต่อ · เมนูเปิดใช้แล้ว", async () => {
    asRole("support");
    const calls = bridge();
    page();
    expect(await screen.findByText("FM-482 ขึ้น production แล้ว · ยังไม่ได้แจ้งลูกค้า 3 รายที่รออยู่")).toBeInTheDocument();
    expect(screen.getByText("S1 0 · S2 3 · S3 8 · S4 3")).toBeInTheDocument();
    expect(screen.getByText("จาก 17 Workspace")).toBeInTheDocument();
    expect(screen.getByText("2.8 วัน")).toBeInTheDocument();
    const table = (await screen.findByText("Gantt ช้าเมื่อโปรเจกต์มีงานเกิน 500 งาน")).closest("table")!;
    const trs = within(table).getAllByRole("row").slice(1);
    expect(within(trs[0]!).getByText(/^Released · ขึ้น production/)).toBeInTheDocument();
    expect(within(trs[0]!).getByRole("button", { name: "แจ้งลูกค้า 3 ราย" })).toBeInTheDocument();
    expect(within(trs[1]!).getByText("In progress · Sprint 24")).toBeInTheDocument();
    expect(within(trs[2]!).getByText("ไม่แก้ · ซ้ำกับ FM-466")).toBeInTheDocument();
    expect(within(trs[0]!).getByText("Orbit Apps, TechNova")).toBeInTheDocument();
    const conn = screen.getByRole("complementary", { name: "การเชื่อมต่อ" });
    expect(within(conn).getByText("friday-dev")).toBeInTheDocument();
    expect(within(conn).getByText(/ใช้งาน · หมดอายุ/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "เปิดโปรเจกต์ FM ↗" })).toHaveAttribute("href", settings.projectUrl);
    expect(screen.getByRole("link", { name: "ส่งบั๊กให้ทีมพัฒนา" })).toHaveAttribute("href", "/bugs");
    await userEvent.click(screen.getByRole("button", { name: "ไม่แก้ · 3" }));
    await waitFor(() => expect(calls.some((c) => c.path === "links?filter=not_fixed")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "ปิดแล้ว 30 วัน · 22" }));
    expect(await screen.findByText("ไม่มีงานในมุมมองนี้")).toBeInTheDocument();
  });

  it("T9 · แจ้งลูกค้าว่าแก้แล้ว: ตาราง Ticket + อีเมล · ข้อความแก้ได้ · ส่งถึง N ราย", async () => {
    asRole("support");
    const calls = bridge();
    page();
    await userEvent.click(await screen.findByRole("button", { name: "แจ้งลูกค้า (T9)" }));
    const dlg = await screen.findByRole("dialog", { name: "แจ้งลูกค้าว่า FM-482 แก้แล้ว" });
    expect(within(dlg).getByText("ops@orbit.example")).toBeInTheDocument();
    expect(within(dlg).getAllByText("แก้แล้ว")).toHaveLength(2);
    const msg = within(dlg).getByLabelText(/ข้อความถึงลูกค้า/);
    expect(msg).toHaveValue("สวัสดีครับ คุณ{ชื่อผู้แจ้ง}\nปัญหาที่แจ้งใน #{เลข Ticket} แก้แล้ว");
    await userEvent.type(msg, " ขอบคุณครับ");
    await userEvent.click(within(dlg).getByLabelText('เพิ่มรายการ "แก้ไข" ใน Changelog (U4) เป็นร่าง'));
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งถึง 2 ราย" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === `notify/${L1}`)?.body).toEqual({ message: "สวัสดีครับ คุณ{ชื่อผู้แจ้ง}\nปัญหาที่แจ้งใน #{เลข Ticket} แก้แล้ว ขอบคุณครับ", solve: true, csat: true, changelog: true }),
    );
    expect(await screen.findByText("แจ้งลูกค้าแล้ว 2 ราย")).toBeInTheDocument();
  });

  it("T10 · ไม่แก้ / ซ้ำ: ผูกไปงานที่แก้แล้ว · แจ้งทางเลี่ยง · คืน Support", async () => {
    asRole("support");
    const calls = bridge();
    page();
    const open = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "แจ้งลูกค้า" }));
      return screen.findByRole("dialog", { name: 'FM-490 ถูกปิดเป็น "ซ้ำ"' });
    };
    let dlg = await open();
    expect(within(dlg).getByLabelText(/^ผูก Ticket ไปที่ FM-466 แล้วแจ้งว่าแก้แล้ว/)).toBeChecked();
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(calls.filter((c) => c.path === `resolve/${L2}`).at(-1)?.body).toEqual({ action: "link_fixed", targetKey: "FM-466" }));
    expect(await screen.findByText("ย้าย 1 Ticket ไปที่ FM-466 แล้ว · แจ้งลูกค้าต่อจากงานนั้น")).toBeInTheDocument();

    dlg = await open();
    await userEvent.click(within(dlg).getByLabelText(/^แจ้งลูกค้าว่ายังไม่แก้ พร้อมทางเลี่ยง/));
    const submit = within(dlg).getByRole("button", { name: "ยืนยัน" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("ข้อความถึงลูกค้า *"), "ลองรีเฟรชหน้าเว็บก่อนครับ");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.path === `resolve/${L2}`).at(-1)?.body).toEqual({ action: "workaround", message: "ลองรีเฟรชหน้าเว็บก่อนครับ" }));

    dlg = await open();
    await userEvent.click(within(dlg).getByLabelText(/^คืน Ticket ให้ Support ตรวจต่อ/));
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(calls.filter((c) => c.path === `resolve/${L2}`).at(-1)?.body).toEqual({ action: "return" }));
    expect(await screen.findByText("คืนให้ Support แล้ว 1 Ticket")).toBeInTheDocument();
  });

  it("T11 · เปลี่ยน token ต้องแตะกุญแจแล้วลองใหม่ · ทดสอบแสดงผลรายข้อ", async () => {
    asRole("admin");
    const calls = bridge();
    let reauthed = false;
    server.use(
      http.put(`${OPS}/dev-bridge/settings`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "แตะ Security key เพื่อยืนยันตัวตนก่อนเปลี่ยน token");
        calls.push({ method: "PUT", path: "settings", body: await request.json() });
        return HttpResponse.json(settings);
      }),
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    await userEvent.click(await screen.findByRole("button", { name: "ตั้งค่าการเชื่อมต่อ" }));
    const dlg = await screen.findByRole("dialog", { name: "ตั้งค่าการเชื่อมต่อกับ Friday Work Management" });
    await userEvent.click(within(dlg).getByRole("button", { name: "ทดสอบการเชื่อมต่อ" }));
    expect(await within(dlg).findByText("ทดสอบแล้ว: มีข้อที่ไม่ผ่าน")).toBeInTheDocument();
    expect(within(dlg).getByText(/ยังไม่มีสถานะ "Released"/)).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("API token (สิทธิ์ write) *"), "fm_tok_sample_new_token_0001");
    await userEvent.selectOptions(within(dlg).getByLabelText("ความรุนแรง S3 → Priority"), "high");
    await userEvent.click(within(dlg).getByRole("button", { name: "บันทึก" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "settings")?.body).toEqual({
        apiBaseUrl: "http://api:3001", workspaceSlug: "friday-dev", projectKey: "FM", token: "fm_tok_sample_new_token_0001", tokenExpiresAt: "2027-01-09",
        mapping: { ...settings.mapping, severityPriority: { ...settings.mapping.severityPriority, S3: "high" } },
      }),
    );
    expect(await screen.findByText("บันทึกการเชื่อมต่อแล้ว")).toBeInTheDocument();
  });

  it("วิศวกรเห็นหน้าแต่ไม่มีปุ่มแจ้งลูกค้า · Support แก้การเชื่อมต่อไม่ได้", async () => {
    asRole("engineer");
    bridge();
    page();
    expect(await screen.findByText("FM-482 ขึ้น production แล้ว · ยังไม่ได้แจ้งลูกค้า 3 รายที่รออยู่")).toBeInTheDocument();
    await screen.findByText("Gantt ช้าเมื่อโปรเจกต์มีงานเกิน 500 งาน");
    expect(screen.queryByRole("button", { name: "แจ้งลูกค้า (T9)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^แจ้งลูกค้า/ })).not.toBeInTheDocument();
  });

  it("Support เปิดการตั้งค่าได้แบบอ่านอย่างเดียว", async () => {
    asRole("support");
    bridge({ settings: { ...settings, canEdit: false } });
    page();
    await userEvent.click(await screen.findByRole("button", { name: "ตั้งค่าการเชื่อมต่อ" }));
    const dlg = await screen.findByRole("dialog", { name: "ตั้งค่าการเชื่อมต่อกับ Friday Work Management" });
    expect(within(dlg).getByText("ดูได้อย่างเดียว · Owner และวิศวกรแก้การเชื่อมต่อได้")).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "บันทึก" })).not.toBeInTheDocument();
  });

  it("การเงินไม่มีเมนูและไม่มีสิทธิ์เปิดหน้า (ไม่เรียก ops-api)", async () => {
    asRole("finance");
    let called = 0;
    server.use(http.get(`${OPS}/dev-bridge/overview`, () => (called++, HttpResponse.json(overview))));
    page();
    expect(await screen.findByText(/หน้านี้เปิดให้/)).toBeInTheDocument();
    expect(called).toBe(0);
    expect(screen.queryByRole("link", { name: "ส่งบั๊กให้ทีมพัฒนา" })).not.toBeInTheDocument();
  });
});

// ── หน้า Support: T3 · T7 · T8 · แท็บรอทีมพัฒนา ────────────────────────
const ticketRow = { id: T, number: 512, subject: "นำเข้า Excel แล้ว Sub-task หายบางส่วน", status: "open", priority: "high", channel: "in_app", requesterEmail: "ops@orbit.example", createdAt: "2026-11-05T01:20:00.000Z", firstResponseDueAt: null, assigneeId: null, assigneeName: null, workspace: { id: "w1", slug: "orbit", name: "Orbit Apps" }, slaBreached: false };
const linkDetail: LinkDetail = {
  id: L1, issueKey: "FM-482", title: "นำเข้าโหมดอัปเดต: Sub-task หายเมื่อ Parent Key ว่าง", severity: "S2", statusName: "Released", statusCategory: "done", resolution: null, duplicateOfKey: null,
  assigneeName: "Dev A", sprintName: "Sprint 24", dueDate: null, doneAt: today, releasedAt: today, releaseVersion: "v1.18.2", syncedAt: new Date(Date.now() - 120_000).toISOString(), createdAt: "2026-11-05T01:55:00.000Z",
  url: "http://localhost:3000/work/friday-dev/p/FM?issue=FM-482",
  tickets: [
    { id: T, number: 512, status: "pending_dev", workspace: "Orbit Apps", notifiedAt: null, outcome: null },
    { id: "t-520", number: 520, status: "pending_dev", workspace: "TechNova", notifiedAt: "2026-11-11T08:00:00.000Z", outcome: "fixed" },
  ],
  unnotified: 1,
};
function supportPage(opts: { status?: string; link?: LinkDetail | null; configured?: boolean } = {}) {
  const calls: Call[] = [];
  const t = { ...ticketRow, status: opts.status ?? "open" };
  server.use(
    http.get(`${OPS}/tickets`, ({ request }) => {
      calls.push({ method: "GET", path: `tickets?${new URL(request.url).searchParams}`, body: null });
      return HttpResponse.json({ items: [t], summary: { open: 18, unassigned: 2, breached: 0, firstResponseMinutes: null, csat: null } });
    }),
    http.get(`${OPS}/tickets/stats`, () => HttpResponse.json({ items: [] })),
    http.get(`${OPS}/tickets/${T}`, () => HttpResponse.json({ ticket: { ...t, cause: null, csat: null, assignee: null, category: "import", requesterName: null }, messages: [], customer: null })),
    http.get(`${OPS}/support/team`, () => HttpResponse.json({ mode: "least", items: [] })),
    http.get(`${OPS}/support/canned-replies`, () => HttpResponse.json({ items: [] })),
    http.get(`${OPS}/dev-bridge/tickets/${T}`, () => HttpResponse.json({ link: opts.link ?? null, configured: opts.configured ?? true })),
    http.get(`${OPS}/dev-bridge/settings`, () => HttpResponse.json(opts.configured === false ? { ...settings, configured: false, tokenHint: null } : settings)),
    http.get(`${OPS}/dev-bridge/issues`, ({ request }) => {
      const p = new URL(request.url).searchParams;
      calls.push({ method: "GET", path: `issues?${p}`, body: null });
      const hit = { key: "FM-482", title: "นำเข้าโหมดอัปเดต: Sub-task หายเมื่อ Parent Key ว่าง", status: { name: "In progress", category: "in_progress" }, priority: "high", linkedTickets: 2, url: null };
      if (p.get("similar") === "1") return HttpResponse.json({ items: [hit] });
      return HttpResponse.json({ items: [hit, { key: "FM-431", title: "นำเข้า: คอลัมน์ Parent Key ภาษาไทยไม่ถูกอ่าน", status: { name: "Done", category: "done" }, priority: "medium", linkedTickets: 1, url: null }] });
    }),
    http.post(`${OPS}/dev-bridge/tickets/${T}/escalate`, async ({ request }) => {
      const body = (await request.json()) as { issueKey?: string };
      calls.push({ method: "POST", path: "bridge-escalate", body });
      if (opts.configured === false) return opsError(409, "bridge_not_configured", "ยังไม่ได้ตั้งค่า");
      return HttpResponse.json({ link: { ...linkDetail, issueKey: body.issueKey ?? "FM-501" }, ticketId: T, status: "pending_dev" });
    }),
    http.post(`${OPS}/tickets/${T}/escalate`, async ({ request }) => (calls.push({ method: "POST", path: "legacy-escalate", body: await request.json() }), HttpResponse.json({ id: T, status: "pending_dev" }))),
    http.post(`${OPS}/dev-bridge/tickets/${T}/link`, async ({ request }) => (calls.push({ method: "POST", path: "relink", body: await request.json() }), HttpResponse.json({ link: linkDetail }))),
    http.delete(`${OPS}/dev-bridge/tickets/${T}/link`, () => (calls.push({ method: "DELETE", path: "unlink", body: null }), HttpResponse.json({ ticketId: T, linked: false }))),
  );
  navigation.pathname = "/support";
  navigation.search = `ticket=${T}`;
  renderWithProviders(<SupportPage />);
  return calls;
}

describe("Support · ส่งต่อทีมพัฒนา (T3 · T7 · T8)", () => {
  it("T3 สร้างงานใหม่: ค่าเริ่มต้นหัวข้อจาก Ticket · Priority ตามความรุนแรง · เตือนงานที่อาจซ้ำ", async () => {
    asRole("support");
    const calls = supportPage();
    await userEvent.click(await screen.findByRole("button", { name: "ส่งต่อระดับ 2" }));
    const dlg = await screen.findByRole("dialog", { name: "ส่งต่อ #512 ให้ทีมพัฒนา" });
    expect(within(dlg).getByText("friday-dev › FM · ประเภท Bug · ป้าย from-support")).toBeInTheDocument();
    expect(await within(dlg).findByText(/อาจซ้ำ: FM-482/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText("หัวข้อของงาน *")).toHaveValue("นำเข้า Excel แล้ว Sub-task หายบางส่วน");
    expect(within(dlg).getByRole("option", { name: "High (ตามความรุนแรง)" })).toBeInTheDocument();
    const submit = within(dlg).getByRole("button", { name: "สร้าง FM งานใหม่และส่งต่อ" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText("ขั้นตอนทำซ้ำ *"), "1. นำเข้า plan-oct.xlsx โหมดอัปเดต 2. ดู Module");
    await userEvent.type(within(dlg).getByLabelText("ผลที่ควรเป็น"), "เตือนในหน้าพรีวิว");
    await userEvent.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "bridge-escalate")?.body).toEqual({
        mode: "create", severity: "S2", steps: "1. นำเข้า plan-oct.xlsx โหมดอัปเดต 2. ดู Module", notifyCustomer: true, title: "นำเข้า Excel แล้ว Sub-task หายบางส่วน", expected: "เตือนในหน้าพรีวิว",
      }),
    );
    expect(calls.some((c) => c.path.startsWith("issues?") && c.path.includes("similar=1"))).toBe(true);
    expect(await screen.findByText("ส่งต่อทีมพัฒนาแล้ว · FM-501")).toBeInTheDocument();
  });

  it("T3 ผูกกับงานเดิม: ปุ่ม \"ผูกกับงานนี้แทน\" และค้นเลือกจากรายการ (T7)", async () => {
    asRole("support");
    const calls = supportPage();
    await userEvent.click(await screen.findByRole("button", { name: "ส่งต่อระดับ 2" }));
    const dlg = await screen.findByRole("dialog", { name: "ส่งต่อ #512 ให้ทีมพัฒนา" });
    await userEvent.click(await within(dlg).findByRole("button", { name: "ผูกกับงานนี้แทน" }));
    expect(within(dlg).getByLabelText(/^ผูกกับงานที่มีอยู่แล้ว/)).toBeChecked();
    expect(within(dlg).getByText("งานที่เลือก: FM-482")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("ค้นจากชื่อหรือเลขงาน เช่น FM-482"), "parent key");
    await userEvent.click(await within(dlg).findByRole("option", { name: /FM-431/ }));
    expect(within(dlg).getByText("งานที่เลือก: FM-431")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("ขั้นตอนทำซ้ำ *"), "นำเข้าไฟล์ที่ Parent Key ว่าง");
    await userEvent.click(within(dlg).getByRole("button", { name: "ผูกและส่งต่อ" }));
    await waitFor(() => expect(calls.find((c) => c.path === "bridge-escalate")?.body).toMatchObject({ mode: "link", issueKey: "FM-431", severity: "S2" }));
  });

  it("T3 ยังไม่ตั้งค่าการเชื่อมต่อ: ส่งต่อแบบเดิม", async () => {
    asRole("support");
    const calls = supportPage({ configured: false });
    await userEvent.click(await screen.findByRole("button", { name: "ส่งต่อระดับ 2" }));
    const dlg = await screen.findByRole("dialog", { name: "ส่งต่อ #512 ให้ทีมพัฒนา" });
    expect(await within(dlg).findByText(/ยังไม่ได้ตั้งค่าการเชื่อมต่อ · ส่งต่อแบบเดิม/)).toBeInTheDocument();
    expect(within(dlg).queryByLabelText("หัวข้อของงาน *")).not.toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("ขั้นตอนทำซ้ำ *"), "นำเข้าไฟล์ที่ Parent Key ว่าง");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งต่อ" }));
    await waitFor(() => expect(calls.find((c) => c.path === "legacy-escalate")?.body).toEqual({ severity: "S2", steps: "นำเข้าไฟล์ที่ Parent Key ว่าง", notifyCustomer: true }));
    expect(calls.some((c) => c.path === "bridge-escalate")).toBe(false);
  });

  it("T8 การ์ดงานของทีมพัฒนา: สถานะ · Ticket ที่ผูก · แจ้งลูกค้า · เปลี่ยนงาน (T7) · ยกเลิกการผูก", async () => {
    asRole("support");
    const calls = supportPage({ status: "pending_dev", link: linkDetail });
    const card = await screen.findByRole("region", { name: "งานของทีมพัฒนา" });
    expect(within(card).getByText("FM-482")).toBeInTheDocument();
    expect(within(card).getByText(/^Released · ขึ้น production/)).toBeInTheDocument();
    expect(within(card).getByText("Dev A")).toBeInTheDocument();
    expect(within(card).getByText("Ticket ที่ผูกงานนี้ (2)")).toBeInTheDocument();
    expect(within(card).getByText("รอแจ้ง")).toBeInTheDocument();
    expect(within(card).getByText("แจ้งแล้ว")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "แจ้งลูกค้าว่าแก้แล้ว (T9)" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "เปิดใน Friday Work Management ↗" })).toHaveAttribute("href", linkDetail.url);

    await userEvent.click(within(card).getByRole("button", { name: "เปลี่ยนงาน" }));
    const pick = await screen.findByRole("dialog", { name: "เปลี่ยนงานที่ผูก" });
    await userEvent.type(within(pick).getByLabelText("ค้นจากชื่อหรือเลขงาน เช่น FM-482"), "FM-431");
    await userEvent.click(await within(pick).findByRole("option", { name: /FM-431/ }));
    await userEvent.click(within(pick).getByRole("button", { name: "ผูก #512 กับ FM-431" }));
    await waitFor(() => expect(calls.find((c) => c.path === "relink")?.body).toEqual({ issueKey: "FM-431" }));

    await userEvent.click(within(card).getByRole("button", { name: "ยกเลิกการผูก" }));
    const confirm = await screen.findByRole("dialog", { name: "ยกเลิกการผูก #512 กับ FM-482?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "ยกเลิกการผูก" }));
    await waitFor(() => expect(calls.some((c) => c.path === "unlink")).toBe(true));
  });

  it("T8 ไม่แสดงเมื่อยังไม่ผูก · แท็บ \"รอทีมพัฒนา\" กรองสถานะ pending_dev", async () => {
    asRole("support");
    const calls = supportPage();
    expect(await screen.findByRole("button", { name: "ส่งต่อระดับ 2" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "งานของทีมพัฒนา" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "รอทีมพัฒนา" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("status=pending_dev"))).toBe(true));
  });

  it("Owner ที่ไม่ใช่ Support เห็นการ์ดแต่ไม่มีปุ่มจัดการ", async () => {
    server.use(http.get(`${OPS}/auth/me`, () => HttpResponse.json({ staff: { id: "o1", email: "owner@example.com", name: "เจ้าของตัวอย่าง", role: "support", roles: ["owner"], elevated: [], effectiveRoles: ["owner"], department: null, limits: {} } })));
    supportPage({ status: "pending_dev", link: linkDetail });
    const card = await screen.findByRole("region", { name: "งานของทีมพัฒนา" });
    expect(within(card).queryByRole("button", { name: "แจ้งลูกค้าว่าแก้แล้ว (T9)" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "ยกเลิกการผูก" })).not.toBeInTheDocument();
  });
});
