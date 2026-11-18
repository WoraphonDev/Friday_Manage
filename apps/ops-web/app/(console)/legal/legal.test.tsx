import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { lineDiff } from "./diff";
import { LegalPage } from "./LegalPage";

const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset * day).toISOString();
const doc = (id: string, version: string, offset: number, accepted: number, requiresAcceptance = true) => ({
  id,
  docType: "terms",
  version,
  locale: "th",
  effectiveAt: iso(offset),
  summary: `สรุป v${version} (สมมติ)`,
  requiresAcceptance,
  createdAt: iso(offset - 40),
  createdBy: "แอดมินตัวอย่าง",
  accepted,
});
const v2 = doc("d2", "2", -120, 7308);
const v3 = { ...doc("d3", "3", 35, 0), notifyAudience: "all", notifyAt: iso(-1), remindAt: iso(28), notifiedAt: iso(-0.9), remindedAt: null, noticeSent: 1272, noticeBounced: 12, noticeTotal: 1284, reminderSent: 0 };
const groups = [
  { docType: "terms", locale: "th", current: { ...v2, pendingUsers: 104 }, scheduled: [v3], history: [v2, doc("d1", "1", -400, 900)] },
  { docType: "dpa", locale: "th", current: { ...doc("p1", "1", -100, 38), docType: "dpa", pendingUsers: null }, scheduled: [], history: [] },
];
const accept = [{ id: "a1", acceptedAt: iso(-0.1), email: "ceo@robotics.example.com", displayName: "CEO", workspace: "robotics", workspaceName: "สยามโรโบติกส์", docType: "terms", version: "2", locale: "th", ip: "203.0.113.88", channel: "signup" }];

const page = () => {
  navigation.pathname = "/legal";
  navigation.search = "";
  server.use(
    http.get(`${OPS}/legal/documents`, () => HttpResponse.json({ items: groups, activeUsers: 7412 })),
    http.get(`${OPS}/legal/documents/d3`, () => HttpResponse.json({ document: { ...v3, body: "ข้อ 7\nคืนเงินได้ภายใน 14 วัน\nข้อ 8" }, previous: { id: "d2", version: "2", body: "ข้อ 7\nคืนเงินได้ภายใน 7 วัน\nข้อ 8", effectiveAt: v2.effectiveAt } })),
    http.get(`${OPS}/legal/documents/p1`, () => HttpResponse.json({ document: { body: "DPA" }, previous: null })),
    http.get(`${OPS}/legal/audience`, () => HttpResponse.json({ all: 1284, workspaces: 212, admins: 318, suppressed: 12 })),
    http.get(`${OPS}/legal/acceptances`, ({ request }) => HttpResponse.json({ items: new URL(request.url).searchParams.get("q") === "none" ? [] : accept })),
  );
  return renderWithProviders(
    <AppShell>
      <LegalPage />
    </AppShell>,
  );
};

describe("เอกสารกฎหมาย", () => {
  it("รายการเอกสาร · ฉบับที่ตั้งเวลาไว้พร้อมความต่าง · ตัวเลขการยอมรับ · ประวัติ", async () => {
    asRole("auditor");
    page();
    const panel = await screen.findByRole("region", { name: "ข้อกำหนดการใช้งาน" });
    expect(within(panel).getByText("ข้อกำหนดการใช้งาน · v3 ตั้งเวลาไว้")).toBeInTheDocument();
    expect(await within(panel).findByText("คืนเงินได้ภายใน 14 วัน")).toBeInTheDocument();
    expect(within(panel).getByText("คืนเงินได้ภายใน 7 วัน").tagName).toBe("DEL");
    // สถิติอีเมลแจ้ง (H15)
    expect(within(panel).getByText(/ส่งแล้ว 1,272 \/ 1,284 · ตีกลับ 12/)).toBeInTheDocument();
    expect(within(panel).getByText(/เตือนซ้ำ/)).toBeInTheDocument();
    expect(screen.getByText("98.6%")).toBeInTheDocument();
    expect(screen.getByText("104")).toBeInTheDocument();
    // ผู้ตรวจอ่านได้อย่างเดียว
    expect(screen.queryByRole("button", { name: "สร้างเวอร์ชันใหม่" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "ยกเลิกฉบับที่ตั้งเวลาไว้" })).not.toBeInTheDocument();
    expect(screen.getByText("สยามโรโบติกส์")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ส่งออก CSV" })).toHaveAttribute("href", "/ops-api/legal/acceptances/export?");
    await userEvent.type(screen.getByLabelText("ค้นอีเมลหรือ Workspace"), "none");
    expect(await screen.findByText("ยังไม่มีการยอมรับ")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ส่งออก CSV" })).toHaveAttribute("href", "/ops-api/legal/acceptances/export?q=none");
    await userEvent.click(screen.getByRole("button", { name: /ข้อตกลงการประมวลผลข้อมูล/ }));
    expect(await screen.findByText("ฉบับแรกของเอกสารนี้")).toBeInTheDocument();
  });

  it("A7 สร้างเวอร์ชันใหม่: ต้องยอมรับใหม่ล่วงหน้า 30 วัน · แตะกุญแจ", async () => {
    asRole("admin");
    let reauthed = false;
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/legal/documents`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ document: { id: "d4" } });
      }),
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    await userEvent.click(await screen.findByRole("button", { name: "สร้างเวอร์ชันใหม่" }));
    const drawer = await screen.findByRole("dialog", { name: "สร้างเวอร์ชันเอกสารกฎหมาย" });
    expect(within(drawer).getByLabelText("เวอร์ชัน")).toHaveValue("4");
    const effective = within(drawer).getByLabelText("มีผลวันที่") as HTMLInputElement;
    expect(Date.parse(effective.min) - Date.now()).toBeGreaterThan(29 * day);
    await userEvent.type(within(drawer).getByLabelText("เนื้อหาเอกสาร (Markdown)"), "ข้อกำหนดการใช้งานฉบับทดสอบ ข้อความสมมติที่ยาวพอสำหรับการตรวจความยาวขั้นต่ำ");
    await userEvent.type(within(drawer).getByLabelText("สรุปสิ่งที่เปลี่ยน (แสดงในอีเมลและแบนเนอร์)"), "เพิ่มเงื่อนไขการใช้ LINE OA");
    // H14 แจ้งลูกค้า: ค่าเริ่มต้นผู้ใช้ทุกคน · ทันที · เตือน 7 วันก่อน · แบนเนอร์
    expect(await within(drawer).findByText("1,284 คนใน 212 Workspace · ข้ามอีเมลที่ตีกลับ 12")).toBeInTheDocument();
    expect(within(drawer).getByLabelText(/อีเมลถึงผู้ใช้ทุกคนที่ใช้งานอยู่/)).toBeChecked();
    expect(within(drawer).getByLabelText("แบนเนอร์ในแอปตั้งแต่วันนี้ถึงวันที่มีผล")).toBeChecked();
    await userEvent.click(within(drawer).getByRole("button", { name: "ดูตัวอย่างอีเมล" }));
    const mail = await screen.findByRole("dialog", { name: "ตัวอย่างอีเมลแจ้งเอกสารใหม่" });
    expect(within(mail).getByText("เพิ่มเงื่อนไขการใช้ LINE OA")).toBeInTheDocument();
    expect(within(mail).getByText("ตั้งแต่วันที่มีผล คุณต้องกดยอมรับครั้งแรกที่เข้าใช้งาน")).toBeInTheDocument();
    await userEvent.click(within(mail).getAllByRole("button", { name: "ปิด" }).at(-1)!);
    await userEvent.click(within(drawer).getByRole("button", { name: "เผยแพร่" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(body).toMatchObject({ docType: "terms", locale: "th", version: "4", requiresAcceptance: true, summary: "เพิ่มเงื่อนไขการใช้ LINE OA", notifyAudience: "all", remind: true, notifyBanner: true }));
    expect(body.notifyAt).toBeUndefined();
    expect(Date.parse(body.effectiveAt as string) - Date.now()).toBeGreaterThan(29 * day);
  });

  it("H14 แจ้งเฉพาะ Owner / Admin · ตั้งเวลาส่ง · ไม่เตือน · ปิดแบนเนอร์ · แจ้งให้ทราบอย่างเดียว", async () => {
    asRole("admin");
    let reauthed = false;
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/legal/documents`, async ({ request }) => {
        if (!reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ document: { id: "d4" } });
      }),
      http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
      http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
    );
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    page();
    await userEvent.click(await screen.findByRole("button", { name: "สร้างเวอร์ชันใหม่" }));
    const drawer = await screen.findByRole("dialog", { name: "สร้างเวอร์ชันเอกสารกฎหมาย" });
    await userEvent.type(within(drawer).getByLabelText("เนื้อหาเอกสาร (Markdown)"), "ข้อกำหนดการใช้งานฉบับทดสอบ ข้อความสมมติที่ยาวพอสำหรับการตรวจความยาวขั้นต่ำ");
    await userEvent.type(within(drawer).getByLabelText("สรุปสิ่งที่เปลี่ยน (แสดงในอีเมลและแบนเนอร์)"), "แก้คำผิดในข้อ 3 และข้อ 5");
    await userEvent.click(within(drawer).getByRole("switch", { name: "ลูกค้าต้องกดยอมรับ" }));
    await userEvent.click(within(drawer).getByLabelText(/อีเมลเฉพาะ Owner และ Admin/));
    expect(within(drawer).getByText("318 คน")).toBeInTheDocument();
    await userEvent.selectOptions(within(drawer).getByLabelText("ส่งอีเมล"), "later");
    await userEvent.selectOptions(within(drawer).getByLabelText("เตือนอีกครั้ง"), "no");
    await userEvent.click(within(drawer).getByLabelText("แบนเนอร์ในแอปตั้งแต่วันนี้ถึงวันที่มีผล"));
    await userEvent.click(within(drawer).getByRole("button", { name: "เผยแพร่" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(body).toMatchObject({ requiresAcceptance: false, notifyAudience: "admins", remind: false, notifyBanner: false }));
    expect(Date.parse(body.notifyAt as string)).toBeGreaterThan(Date.now());
  });

  it("Owner ยกเลิกฉบับที่ตั้งเวลาไว้", async () => {
    asRole("admin");
    let deleted = false;
    server.use(http.delete(`${OPS}/legal/documents/d3`, () => ((deleted = true), HttpResponse.json({ id: "d3", cancelled: true }))));
    page();
    const panel = await screen.findByRole("region", { name: "ข้อกำหนดการใช้งาน" });
    await userEvent.click(within(panel).getByRole("button", { name: "ยกเลิกฉบับที่ตั้งเวลาไว้" }));
    const dlg = await screen.findByRole("dialog", { name: "ยกเลิก ข้อกำหนดการใช้งาน v3?" });
    await userEvent.click(within(dlg).getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it("Support ไม่มีสิทธิ์", async () => {
    asRole("support");
    page();
    expect(await screen.findByText(/ดูหน้านี้ไม่ได้/)).toBeInTheDocument();
  });
});

describe("lineDiff", () => {
  it("ย่อบรรทัดที่เหมือนเดิม และบอกบรรทัดที่เพิ่ม / ลบ", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
    expect(lineDiff(before, after, 1)).toEqual([
      { kind: "skip", count: 3 },
      { kind: "same", text: "d" },
      { kind: "del", text: "e" },
      { kind: "add", text: "E" },
      { kind: "same", text: "f" },
      { kind: "skip", count: 2 },
    ]);
  });
});
