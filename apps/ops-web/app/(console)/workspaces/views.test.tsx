// ช่วง 3 · มุมมองที่บันทึก · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { OPS, server } from "@/test/server";
import type { SavedView } from "@/lib/views";
import { WorkspacesList } from "./WorkspacesList";

const view = (over: Partial<SavedView>): SavedView => ({
  id: "v1", page: "workspaces", name: "Team M ทดลอง", filters: { plan: "team_m", status: "trialing" }, roles: [], ownerId: "me", ownerName: "ฉัน",
  pinned: false, hidden: false, position: 0, isDefault: false, team: false, mine: true, canEdit: true, ...over,
});
const setup = (items: SavedView[], search = "", canManageTeam = false) => {
  const asked: URLSearchParams[] = [];
  const posted: unknown[] = [];
  server.use(
    http.get(`${OPS}/views`, () => HttpResponse.json({ items, canManageTeam, maxPinned: 5 })),
    http.get(`${OPS}/views/counts`, () => HttpResponse.json({ items: items.filter((v) => v.pinned).map((v) => ({ id: v.id, count: 12 })) })),
    http.post(`${OPS}/views`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posted.push(body);
      return HttpResponse.json(view({ id: "v-new", name: body.name as string, filters: body.filters as Record<string, string> }), { status: 201 });
    }),
    http.get(`${OPS}/workspaces`, ({ request }) => {
      asked.push(new URL(request.url).searchParams);
      return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0, sort: "recent_activity" });
    }),
  );
  navigation.pathname = "/workspaces";
  navigation.search = search;
  renderWithProviders(<AppShell><WorkspacesList /></AppShell>);
  return { asked, posted };
};

describe("มุมมองที่บันทึก", () => {
  it("มุมมองเริ่มต้นใส่ให้เองเมื่อเข้าหน้าโดยไม่มีตัวกรอง · กดทั้งหมดล้าง", async () => {
    const { asked } = setup([view({ isDefault: true })]);
    await waitFor(() => expect(asked.at(-1)?.get("plan")).toBe("team_m"));
    expect(asked.at(-1)?.get("status")).toBe("trialing");
    const bar = screen.getByRole("toolbar", { name: "มุมมอง" });
    expect(within(bar).getByRole("button", { name: /Team M ทดลอง/, pressed: true })).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("button", { name: "ทั้งหมด" }));
    await waitFor(() => expect(asked.at(-1)?.get("plan")).toBeNull());
  });

  it("มีตัวกรองอยู่แล้ว = ไม่ทับด้วยมุมมองเริ่มต้น · ?view= จากเมนูซ้ายใส่ให้", async () => {
    const { asked } = setup([view({ isDefault: true }), view({ id: "v2", name: "เสี่ยงหลุด", filters: { health: "low" } })], "view=v2");
    await waitFor(() => expect(asked.at(-1)?.get("health")).toBe("low"));
    expect(asked.at(-1)?.get("plan")).toBeNull();
    // ?view= ใช้ครั้งเดียว ไม่ค้างใน URL
    expect(router.replace).toHaveBeenLastCalledWith("/workspaces?health=low", { scroll: false });
  });

  it("กรองแล้วบันทึกเป็นมุมมองของฉัน · ไม่มีสิทธิ์ทีมเห็นคำอธิบายแทนตัวเลือกทีม", async () => {
    const { posted } = setup([]);
    await userEvent.click(await screen.findByRole("button", { name: /^ตัวกรอง/ }));
    await userEvent.click(screen.getByRole("button", { name: "ต่ำ (<40)" }));
    await userEvent.click(screen.getByRole("button", { name: "บันทึกมุมมอง" }));
    const dialog = await screen.findByRole("dialog", { name: "บันทึกมุมมอง" });
    expect(within(dialog).queryByText("ทั้งทีม (ตามบทบาท)")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/สร้างได้เฉพาะ Owner และหัวหน้าทีม Support/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("ชื่อมุมมอง"), "สุขภาพต่ำ");
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(posted).toEqual([{ page: "workspaces", name: "สุขภาพต่ำ", filters: { health: "low" }, roles: [] }]));
  });

  it("หัวหน้าทีมบันทึกเป็นของทีมต้องเลือกบทบาท · มุมมองที่ปักขึ้นเมนูซ้ายพร้อมจำนวน", async () => {
    const { posted } = setup([view({ id: "v3", name: "ใกล้หมดทดลอง", filters: { trialEnds: "7" }, pinned: true })], "health=low", true);
    const nav = await screen.findByRole("group", { name: "มุมมองที่ปัก" });
    expect(await within(nav).findByRole("link", { name: /ใกล้หมดทดลอง/ })).toHaveAttribute("href", "/workspaces?view=v3");
    expect(await within(nav).findByLabelText("12 รายการ")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "บันทึกมุมมอง" }));
    const dialog = await screen.findByRole("dialog", { name: "บันทึกมุมมอง" });
    await userEvent.type(within(dialog).getByLabelText("ชื่อมุมมอง"), "เสี่ยงหลุดของทีม");
    await userEvent.click(within(dialog).getByLabelText("ทั้งทีม (ตามบทบาท)"));
    expect(within(dialog).getByRole("button", { name: "บันทึก" })).toBeDisabled();
    await userEvent.click(within(dialog).getByLabelText("Support"));
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(posted).toEqual([{ page: "workspaces", name: "เสี่ยงหลุดของทีม", filters: { health: "low" }, roles: ["support"] }]));
  });
});
