// O51 · Rate limit ต่อลูกค้า · ข้อมูลสมมติเท่านั้น
import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { RateLimitPage } from "./RateLimitPage";

const min = 60_000;
const row = (over: object) => ({ id: "w1", name: "Pixel Forge", slug: "pixel-forge", plan: "team_m", base: 120, limit: 120, peak: 1870, calls: 74_000, rejected: 9012, usagePct: 1558, maxStreak: 40, curStreak: 40, curSince: new Date(Date.now() - 40 * min).toISOString(), override: null, topToken: "ci-bot", ...over });
const pixel = row({});
const harbor = row({ id: "w2", name: "Harbor Logistics", slug: "harbor", plan: "team_l", base: 300, limit: 300, peak: 412, rejected: 2305, usagePct: 137, curStreak: 0, maxStreak: 6, override: { value: 300, expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString() }, topToken: "erp-sync" });
const summary = { limited24h: 37, rejected24h: 18_402, tabs: { limited: 37, near: 112, overrides: 9 }, todo: [pixel], streakAlert: 15 };
const series = Array.from({ length: 40 }, (_, i) => ({ minute: new Date(Date.now() - (40 - i) * min).toISOString(), calls: 1832, rejected: 1670, limit: 120 }));
const detail = {
  id: "w1", name: "Pixel Forge", slug: "pixel-forge", stats: pixel, override: null, series, lastNotifiedAt: null, headroom: 3,
  breakdown: [
    { tokenId: "t1", token: "ci-bot", revoked: false, route: "GET /w/:ws/issues", calls: 71_600, rejected: 9012, peak: 1790 },
    { tokenId: "t2", token: "web-hook-relay", revoked: false, route: "POST /w/:ws/issues/:key/comments", calls: 1680, rejected: 0, peak: 42 },
  ],
};

function reauthFlow() {
  const state = { reauthed: false };
  server.use(
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((state.reauthed = true), HttpResponse.json({ reauthed: true }))),
  );
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  return state;
}

function page() {
  navigation.pathname = "/ratelimit";
  navigation.search = "";
  server.use(
    http.get(`${OPS}/ratelimit/summary`, () => HttpResponse.json(summary)),
    http.get(`${OPS}/ratelimit/workspaces`, ({ request }) => {
      const tab = new URL(request.url).searchParams.get("tab");
      const items = tab === "overrides" ? [harbor] : tab === "near" ? [] : [pixel, harbor];
      return HttpResponse.json({ items, total: items.length });
    }),
    http.get(`${OPS}/ratelimit/workspaces/w1`, () => HttpResponse.json(detail)),
  );
  return renderWithProviders(
    <AppShell>
      <RateLimitPage />
    </AppShell>,
  );
}

describe("Rate limit ต่อลูกค้า", () => {
  it("ขั้น 1: ตัวเลขหัวหน้า · ชนเพดานติดกันเกิน 15 นาทีอยู่บนสุด · แท็บพร้อมจำนวน · ตาราง", async () => {
    asRole("engineer");
    page();
    expect(await screen.findByText("ชนเพดานใน 24 ชม. 37 Workspace · ถูกปฏิเสธ (429) 18,402 ครั้ง · ปรับเฉพาะรายอยู่ 9")).toBeInTheDocument();
    const todo = await screen.findByRole("region", { name: "ต้องทำตอนนี้" });
    const r = within(todo).getByRole("article", { name: "Pixel Forge" });
    expect(within(r).getByText('Team M · 120/นาที · token "ci-bot"')).toBeInTheDocument();
    expect(within(r).getByText("40 นาที")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ใกล้เพดาน \(>80%\)\s*112/ })).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row").map((x) => x.textContent)).toEqual([
      "Workspaceแพ็กเกจเพดาน/นาทีสูงสุด 24 ชม.ถูกปฏิเสธtoken ที่เรียกมากสุด",
      "Pixel Forgepixel-forgeTeam M1201,8701,558%9,012ci-bot",
      "Harbor LogisticsharborTeam L300 ปรับ412137%2,305erp-sync",
    ]);
    await userEvent.click(screen.getByRole("tab", { name: /ใกล้เพดาน/ }));
    expect(await screen.findByText("ไม่มีลูกค้าที่ใกล้เพดาน")).toBeInTheDocument();
  });

  it("Support ไม่มีสิทธิ์", async () => {
    asRole("support");
    page();
    expect(await screen.findByText(/หน้านี้เปิดให้ Owner · วิศวกร/)).toBeInTheDocument();
  });

  it("แจ้ง Owner จากแถบต้องทำ", async () => {
    asRole("engineer");
    let body: unknown = null;
    server.use(http.post(`${OPS}/ratelimit/workspaces/w1/notify`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ sent: 2, recipients: 2 }))));
    page();
    const r = await screen.findByRole("article", { name: "Pixel Forge" });
    await userEvent.click(within(r).getByRole("button", { name: "แจ้ง Owner" }));
    const dlg = await screen.findByRole("dialog", { name: "แจ้ง Owner ของ Pixel Forge" });
    await userEvent.type(within(dlg).getByLabelText("หมายเหตุถึงลูกค้า (ไม่บังคับ)"), "CI วนเรียกซ้ำ");
    await userEvent.click(within(dlg).getByRole("button", { name: "แจ้ง Owner" }));
    await waitFor(() => expect(body).toEqual({ note: "CI วนเรียกซ้ำ" }));
    expect(await screen.findByText("ส่งอีเมลแล้ว 2/2")).toBeInTheDocument();
  });

  it("ขั้น 2: กราฟ 24 ชม. + แยกตาม token · ระงับ token (แตะกุญแจ) · ปรับเพดานชั่วคราวเกิน 3 เท่าบอกว่าต้องอนุมัติ", async () => {
    asRole("engineer");
    const auth = reauthFlow();
    const sent: Record<string, unknown>[] = [];
    server.use(
      http.post(`${OPS}/abuse/blocks`, async ({ request }) => {
        if (!auth.reauthed) return opsError(401, "reauth_required", "ต้องแตะกุญแจอีกครั้ง");
        sent.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: "b1" });
      }),
      http.post(`${OPS}/ratelimit/workspaces/w1/limit`, async ({ request }) => (sent.push((await request.json()) as Record<string, unknown>), HttpResponse.json({ id: "o1" }))),
    );
    page();
    await userEvent.click(within(await screen.findByRole("article", { name: "Pixel Forge" })).getByRole("button", { name: "ดู" }));
    const drawer = await screen.findByRole("dialog", { name: "Pixel Forge · Team M" });
    expect(within(drawer).getByText("เพดาน 120 ครั้ง/นาที ตามแพ็กเกจ · ชนเพดานติดกัน 40 นาที")).toBeInTheDocument();
    expect(within(drawer).getByRole("img", { name: "กราฟคำขอต่อนาที 24 ชม. สูงสุด 1,832 ครั้ง/นาที เพดาน 120 ถูกปฏิเสธ 66,800 ครั้ง" })).toBeInTheDocument();
    expect(within(drawer).getByText("POST /w/:ws/issues/:key/comments")).toBeInTheDocument();

    await userEvent.click(within(drawer).getAllByRole("button", { name: "ระงับ token" })[0]);
    const block = await screen.findByRole("dialog", { name: 'ระงับ token "ci-bot"' });
    await userEvent.type(within(block).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "วนเรียกซ้ำ");
    await userEvent.click(within(block).getByRole("button", { name: "ระงับ token" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะ Passkey" }));
    await waitFor(() => expect(sent[0]).toEqual({ kind: "api_token", value: "t1", reason: "วนเรียกซ้ำ" }));

    await userEvent.click(within(drawer).getByRole("button", { name: "ปรับเพดานชั่วคราว" }));
    const dlg = await screen.findByRole("dialog", { name: "ปรับเพดานชั่วคราว · Pixel Forge" });
    const value = within(dlg).getByLabelText("เพดานใหม่ (ครั้ง/นาที)");
    await userEvent.clear(value);
    await userEvent.type(value, "500");
    expect(within(dlg).getByText("เกิน 3 เท่าของแพ็กเกจ (360/นาที) ต้องให้ Owner อนุมัติ")).toBeInTheDocument();
    await userEvent.clear(value);
    await userEvent.type(value, "300");
    expect(within(dlg).getByText("ไม่เกิน 3 เท่าของแพ็กเกจ (360/นาที) มีผลทันที")).toBeInTheDocument();
    await userEvent.selectOptions(within(dlg).getByLabelText("นานเท่าไร"), "3");
    await userEvent.type(within(dlg).getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ย้ายข้อมูลครั้งเดียว");
    await userEvent.click(within(dlg).getByRole("button", { name: "ปรับเพดานชั่วคราว" }));
    await waitFor(() => expect(sent[1]).toEqual({ value: 300, days: 3, reason: "ย้ายข้อมูลครั้งเดียว" }));
    expect(await screen.findByText("ปรับเพดานแล้ว")).toBeInTheDocument();
  });
});
