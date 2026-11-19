// O50 · ตรวจจับการใช้ผิด · ข้อมูลสมมติเท่านั้น
import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { AbusePage } from "./AbusePage";

const hour = 3_600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const sig = (rule: string, points: number, detail: string) => ({ rule, points, detail });
const spam = {
  id: "c1", number: 12, kind: "invite_spam", label: "promo-deal-88", score: 94, status: "auto_suspended", outcome: null, reason: null, ip: null,
  signals: [sig("temp_email", 30, "อีเมลผู้สมัครเป็นโดเมนชั่วคราว (tempmail.example)"), sig("invite_burst", 40, "เชิญอีเมลภายนอกเกิน 50 รายการใน 1 ชม. (480)"), sig("invite_links", 24, "ข้อความเชิญมีลิงก์ภายนอก (3 โดเมน)")],
  createdAt: iso(-3 * hour), autoSuspendedAt: iso(-3 * hour), confirmBy: iso(21 * hour + 60_000), decidedAt: null, decidedBy: null, workspaces: 1, users: 1,
};
const fake = {
  ...spam, id: "c2", number: 13, kind: "fake_signup", label: "14 บัญชีจาก IP เดียว", score: 76, status: "open", ip: "203.0.113.24", autoSuspendedAt: null, confirmBy: null,
  signals: [sig("ip_burst", 35, "สมัคร 14 บัญชีจาก IP 203.0.113.24 ใน 1 ชม. (เกณฑ์ 5)"), sig("unverified_heavy", 20, "ไม่มีบัญชีไหนยืนยันอีเมล (14 บัญชี)"), sig("temp_email", 21, "8/14 บัญชีใช้โดเมนชั่วคราว")],
  workspaces: 2, users: 14,
};
const ws = (over: object = {}) => ({ id: "w1", name: "promo-deal-88", slug: "promo-deal-88", status: "suspended", createdAt: iso(-3 * hour), deleted: false, plan: "free", subStatus: null, paying: false, paidEver: false, members: 1, pendingInvites: 480, projects: 0, ip: "203.0.113.24", ownerEmail: "deal@tempmail.example", ...over });
const detail = (c: typeof spam, over: object = {}) => ({ ...c, workspaces: [ws()], workspaceTotal: 1, users: [], userTotal: 1, blockable: { ip: null, domains: ["tempmail.example"] }, ...over });
const summary = { deciders: [{ id: "s1", name: "วิศวกร A" }], signups7d: 1284, autoSuspended7d: 96, falsePositivePct: 3, todo: { open: 1, autoSuspended: 1, oldestAt: iso(-5 * hour) }, tabs: { history: 212, blocks: 1047 } };
const history = [{ ...fake, id: "h1", number: 3, label: "Nordlight · token sync", kind: "api_abuse", score: 72, status: "closed", outcome: "dismissed", reason: "ลูกค้าย้ายระบบ", decidedAt: iso(-24 * hour), decidedBy: "วิศวกร A" }];
const rules = {
  review: 70, autoSuspend: 90,
  rules: [
    { key: "temp_email", points: 30, on: true, waiting: null, hits7d: 41, falsePositivePct: 2 },
    { key: "geo_mismatch", points: 15, on: false, waiting: "geoip", hits7d: 0, falsePositivePct: null },
    { key: "unverified_heavy", points: 20, on: true, waiting: null, hits7d: 9, falsePositivePct: 42 },
  ],
};

/** แตะกุญแจครั้งแรกที่ ops-api ตอบ reauth_required */
function reauthFlow() {
  const state = { reauthed: false };
  server.use(
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((state.reauthed = true), HttpResponse.json({ reauthed: true }))),
  );
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  return state;
}

function page(opts: { todo?: object[]; details?: Record<string, object> } = {}) {
  navigation.pathname = "/abuse";
  navigation.search = "";
  const todo = opts.todo ?? [spam, fake];
  const details = opts.details ?? { c1: detail(spam), c2: detail(fake as never, { workspaces: [ws({ id: "w2", name: "test-01", slug: "test-01", status: "trial", pendingInvites: 0 })], workspaceTotal: 2, userTotal: 14, users: [{ id: "u1", email: "test-01@tempmail.example", verified: false, createdAt: iso(-hour) }], blockable: { ip: "203.0.113.24", domains: ["tempmail.example"] } }) };
  server.use(
    http.get(`${OPS}/abuse/summary`, () => HttpResponse.json(summary)),
    http.get(`${OPS}/abuse/cases`, ({ request }) => {
      const u = new URL(request.url);
      if (u.searchParams.get("tab") === "todo") return HttpResponse.json({ items: todo, total: todo.length });
      const items = u.searchParams.get("outcome") === "blocked" ? [] : history;
      return HttpResponse.json({ items, total: items.length });
    }),
    http.get(`${OPS}/abuse/cases/:id`, ({ params }) => HttpResponse.json(details[params.id as string])),
    http.get(`${OPS}/abuse/rules`, () => HttpResponse.json(rules)),
    http.get(`${OPS}/abuse/blocks`, () => HttpResponse.json({ items: [{ id: "b1", kind: "email_domain", value: "mailinator.example", label: null, reason: "โดเมนชั่วคราว", expiresAt: null, createdAt: iso(-48 * hour), createdBy: "ระบบ", caseNumber: 9 }], total: 1 })),
  );
  return renderWithProviders(
    <AppShell>
      <AbusePage />
    </AppShell>,
  );
}

describe("ตรวจจับการใช้ผิด", () => {
  it("ขั้น 1: ตัวเลขหัวหน้า · เคสรอตรวจเรียงตามคะแนน · ระงับอัตโนมัติบอกเวลาที่เหลือ · แท็บประวัติ", async () => {
    asRole("engineer");
    page();
    expect(await screen.findByText("สมัครใหม่ 7 วัน 1,284 · ระงับอัตโนมัติ 7 วัน 96 · แจ้งผิด (false positive) 3% ใน 90 วัน")).toBeInTheDocument();
    const todo = await screen.findByRole("region", { name: "ต้องทำตอนนี้" });
    expect(within(todo).getByText("รอตรวจ 1 · ระงับอัตโนมัติรอยืนยัน 1 · เก่าสุด 5 ชม.")).toBeInTheDocument();
    const rows = within(todo).getAllByRole("article");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["promo-deal-88", "14 บัญชีจาก IP เดียว"]);
    expect(within(rows[0]).getByText("ระงับแล้ว · เหลือ 21 ชม.")).toBeInTheDocument();
    // สัญญาณหลัก = คะแนนมากสุด
    expect(within(rows[0]).getByText("เชิญอีเมลภายนอกเกิน 50 รายการใน 1 ชม. (480)")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ตัดสินแล้ว 30 วัน\s*212/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Nordlight · token sync")).toBeInTheDocument();
    expect(screen.getByText("ไม่ใช่การใช้ผิด", { selector: ".pill" })).toBeInTheDocument();
  });

  it("Support ไม่มีสิทธิ์", async () => {
    asRole("support");
    page();
    expect(await screen.findByText(/ดูหน้านี้ไม่ได้/)).toBeInTheDocument();
    expect(screen.getByText(/หน้านี้เปิดให้ Owner · วิศวกร/)).toBeInTheDocument();
  });

  it("ขั้น 2: แผงขวาบอกที่มาของคะแนน · ปุ่มหลักตามประเภท · ต้องมีเหตุผล + แตะกุญแจ · แล้วไปเคสถัดไป", async () => {
    asRole("engineer");
    const auth = reauthFlow();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/abuse/cases/decide`, async ({ request }) => {
        if (!auth.reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ decided: 1, outcome: "suspended", blocks: [], next: "c2" });
      }),
    );
    page();
    await userEvent.click(within(await screen.findByRole("article", { name: "promo-deal-88" })).getByRole("button", { name: /promo-deal-88/ }));
    const drawer = await screen.findByRole("dialog", { name: "promo-deal-88" });
    const signals = await within(drawer).findByRole("region", { name: "ที่มาของคะแนน" });
    expect(within(signals).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["อีเมลผู้สมัครเป็นโดเมนชั่วคราว (tempmail.example)+30", "เชิญอีเมลภายนอกเกิน 50 รายการใน 1 ชม. (480)+40", "ข้อความเชิญมีลิงก์ภายนอก (3 โดเมน)+24"]);
    expect(within(drawer).getByText("Free · ยังไม่เคยจ่าย")).toBeInTheDocument();
    expect(within(drawer).getByText("สมาชิก 1 คน · คำเชิญค้าง 480 · โปรเจกต์ 0")).toBeInTheDocument();
    const primary = within(drawer).getByRole("button", { name: "ระงับและลบคำเชิญ" });
    expect(primary).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "สแปมคำเชิญชัดเจน");
    await userEvent.click(primary);
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(body).toEqual({ ids: ["c1"], action: "suspend", reason: "สแปมคำเชิญชัดเจน" }));
    // พาไปเคสถัดไปเอง: สมัครปลอม → ปุ่มหลัก "ลบและบล็อก" บอกสิ่งที่จะบล็อก
    const next = await screen.findByRole("dialog", { name: "14 บัญชีจาก IP เดียว" });
    expect(await within(next).findByText("จะบล็อก: IP 203.0.113.24 90 วัน · โดเมน tempmail.example ถาวร")).toBeInTheDocument();
    expect(within(next).getByRole("button", { name: "ลบและบล็อก" })).toBeInTheDocument();
    expect(within(next).getByText("test-01@tempmail.example")).toBeInTheDocument();
    expect(within(next).getByText("และอีก 1")).toBeInTheDocument();
  });

  it("Workspace ที่จ่ายเงินอยู่: ปิดปุ่มระงับ / ลบ และบอกให้ไปหน้า Workspace", async () => {
    asRole("engineer");
    page({ todo: [spam], details: { c1: detail(spam, { workspaces: [ws({ plan: "team_m", paying: true, paidEver: true, status: "active" })] }) } });
    await userEvent.click(within(await screen.findByRole("article", { name: "promo-deal-88" })).getByRole("button", { name: /promo-deal-88/ }));
    const drawer = await screen.findByRole("dialog", { name: "promo-deal-88" });
    expect(await within(drawer).findByText(/จ่ายเงินอยู่ · ระงับได้จากหน้า Workspace/)).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ตรวจแล้ว");
    expect(within(drawer).getByRole("button", { name: "ระงับและลบคำเชิญ" })).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: "ไม่ใช่การใช้ผิด" })).toBeEnabled();
  });

  it("ไม่ใช่การใช้ผิดจากแถว · เลือกหลายเคสแล้วลบและบล็อกครั้งเดียว", async () => {
    asRole("engineer");
    const sent: unknown[] = [];
    server.use(
      http.post(`${OPS}/abuse/cases/decide`, async ({ request }) => {
        const b = (await request.json()) as { action: string; ids: string[] };
        sent.push(b);
        return HttpResponse.json({ decided: b.ids.length, outcome: b.action === "dismiss" ? "dismissed" : "blocked", blocks: [{ kind: "ip", value: "203.0.113.24" }], next: null });
      }),
    );
    page();
    const row = await screen.findByRole("article", { name: "promo-deal-88" });
    await userEvent.click(within(row).getByRole("button", { name: "ไม่ใช่การใช้ผิด" }));
    const dlg = await screen.findByRole("dialog", { name: "ไม่ใช่การใช้ผิด" });
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ลูกค้าจริง");
    await userEvent.click(within(dlg).getByRole("button", { name: "ไม่ใช่การใช้ผิด" }));
    await waitFor(() => expect(sent).toEqual([{ ids: ["c1"], action: "dismiss", reason: "ลูกค้าจริง" }]));
    expect(await screen.findByText("ปลดแล้ว · ไม่เปิดเคสเรื่องนี้ซ้ำ 30 วัน")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("เลือกทั้งหมดในหน้านี้"));
    const bulk = screen.getByRole("group", { name: "ตัดสิน 2 เคสพร้อมกัน" });
    await userEvent.click(within(bulk).getByRole("button", { name: "ลบและบล็อก" }));
    const dlg2 = await screen.findByRole("dialog", { name: "ลบและบล็อก · ตัดสิน 2 เคสพร้อมกัน" });
    await userEvent.type(within(dlg2).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "สมัครปลอมเป็นชุด");
    await userEvent.click(within(dlg2).getByRole("button", { name: "ลบและบล็อก" }));
    await waitFor(() => expect(sent[1]).toEqual({ ids: ["c1", "c2"], action: "block", reason: "สมัครปลอมเป็นชุด" }));
    expect(await screen.findByText("ลบ Workspace แล้ว (กู้คืนได้ 30 วัน) · บล็อก 1 รายการ")).toBeInTheDocument();
  });

  it("แท็บรายชื่อที่ถูกบล็อก: เพิ่มโดเมน · ต้องแตะกุญแจ", async () => {
    asRole("engineer");
    const auth = reauthFlow();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/abuse/blocks`, async ({ request }) => {
        if (!auth.reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "b2" });
      }),
    );
    page();
    await userEvent.click(await screen.findByRole("tab", { name: /รายชื่อที่ถูกบล็อก/ }));
    expect(await screen.findByText("mailinator.example")).toBeInTheDocument();
    expect(screen.getByText("จากเคส #9")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "เพิ่มรายชื่อ" }));
    const dlg = await screen.findByRole("dialog", { name: "บล็อกเพิ่ม" });
    await userEvent.type(within(dlg).getByLabelText("ค่า"), "spam.example");
    await userEvent.selectOptions(within(dlg).getByLabelText("นานเท่าไร"), "30");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "สแปมชุดใหม่");
    await userEvent.click(within(dlg).getByRole("button", { name: "เพิ่มรายชื่อ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(body).toMatchObject({ kind: "email_domain", value: "spam.example", reason: "สแปมชุดใหม่", expiresAt: expect.any(String) }));
  });

  it("ขั้น 3 ปุ่มเฟือง: กฎที่จับผิดบ่อยเด่น · กฎที่ยังไม่มีข้อมูลเปิดไม่ได้ · บันทึกส่งค่าทั้งหมด", async () => {
    asRole("engineer");
    let body: Record<string, unknown> = {};
    server.use(http.put(`${OPS}/abuse/rules`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ ...rules, review: 65, saved: true }))));
    page();
    await userEvent.click(await screen.findByRole("button", { name: "กฎตรวจจับ" }));
    const drawer = await screen.findByRole("dialog", { name: "กฎตรวจจับ" });
    expect(await within(drawer).findByText("42%")).toHaveAttribute("title", "จับผิดบ่อย ควรลดคะแนน");
    expect(within(drawer).getByText("รอฐานข้อมูล GeoIP")).toBeInTheDocument();
    expect(within(drawer).getByRole("switch", { name: "เปิด ประเทศของ IP ไม่ตรงที่อยู่ออกใบกำกับ" })).toBeDisabled();
    const pts = within(drawer).getByLabelText("คะแนน ไม่ยืนยันอีเมลใน 24 ชม. แต่ใช้งานหนัก");
    await userEvent.clear(pts);
    await userEvent.type(pts, "10");
    const review = within(drawer).getByLabelText("เกณฑ์รอตรวจ");
    await userEvent.clear(review);
    await userEvent.type(review, "65");
    await userEvent.click(within(drawer).getByRole("button", { name: "บันทึก" }));
    await waitFor(() =>
      expect(body).toEqual({ review: 65, autoSuspend: 90, rules: { temp_email: { points: 30, on: true }, geo_mismatch: { points: 15, on: false }, unverified_heavy: { points: 10, on: true } } }),
    );
    expect(await screen.findByText("บันทึกกฎแล้ว")).toBeInTheDocument();
  });
});
