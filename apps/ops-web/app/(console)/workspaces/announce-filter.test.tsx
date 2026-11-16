// O43 · S8 ประกาศถึงทุก Workspace ตามตัวกรอง / ลูกค้าทุกราย · ข้อมูลสมมติเท่านั้น
import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ReauthProvider } from "@/components/dialogs";
import { renderWithProviders } from "@/test/render";
import { OPS, opsError, server } from "@/test/server";
import { AnnounceDrawer } from "./_parts/Announce";

const counts = { filter: { workspaces: 214, people: 590, emails: 588, suppressed: 0, noRecipients: [], minutes: 12, needsReauth: false }, all: { workspaces: 1108, people: 3020, emails: 3000, suppressed: 2, noRecipients: [], minutes: 60, needsReauth: true }, selected: { workspaces: 3, people: 7, emails: 7, suppressed: 0, noRecipients: [], minutes: 1, needsReauth: false } };

function setup(opts: { reauthFirst?: boolean } = {}) {
  const posted: Record<string, unknown>[] = [];
  let reauthed = false;
  server.use(
    http.post(`${OPS}/announcements/audience`, async ({ request }) => {
      const b = (await request.json()) as { targetMode?: "filter" | "all" };
      return HttpResponse.json(counts[b.targetMode ?? "selected"]);
    }),
    http.post(`${OPS}/auth/reauth/options`, () => HttpResponse.json({ options: { challenge: "c" }, challengeToken: "re" })),
    http.post(`${OPS}/auth/reauth/verify`, () => ((reauthed = true), HttpResponse.json({ reauthed: true }))),
    http.post(`${OPS}/announcements`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (opts.reauthFirst && !reauthed) return opsError(401, "reauth_required", "แตะ Security key");
      posted.push(body);
      return HttpResponse.json({ id: "a1", status: "sent", scheduledAt: null, workspaces: { count: body.targetMode === "all" ? 1108 : 214, names: [], ids: [] } }, { status: 201 });
    }),
  );
  vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
  const done = vi.fn();
  renderWithProviders(
    <ReauthProvider>
      <AnnounceDrawer workspaceIds={["w-1", "w-2", "w-3"]} filter={{ plan: "team_s", status: "trial" }} onClose={() => {}} onDone={done} />
    </ReauthProvider>,
  );
  return { posted, done };
}

describe("S8 · ผู้รับตามตัวกรอง / ทุกราย", () => {
  it("แสดงสามทางเลือกพร้อมจำนวน · ตามตัวกรองส่งตัวกรองไปให้ ops-api หาตอนส่ง · ประมาณเวลาส่ง", async () => {
    const { posted, done } = setup();
    const dlg = await screen.findByRole("dialog", { name: "ส่งประกาศถึงลูกค้า" });
    expect(within(dlg).getByText("3 Workspace")).toBeInTheDocument();
    expect(await within(dlg).findByText("Team S, ทดลองใช้ · ตอนนี้ 214 ราย · นับใหม่ตอนส่ง")).toBeInTheDocument();
    expect(await within(dlg).findByText("1,108 Workspace ที่ใช้งานอยู่")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByLabelText(/ทุก Workspace ตามตัวกรอง/));
    expect(await within(dlg).findByText("ผู้รับ 214 Workspace ≈ 590 คน · ส่งชุดละ 50 ใช้เวลาประมาณ 12 นาที")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "ปรับปรุงระบบคืนวันเสาร์");
    await userEvent.type(within(dlg).getByLabelText("ข้อความ *"), "ระหว่างนี้เข้าใช้งานไม่ได้ประมาณ 2 ชั่วโมง");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งประกาศ" }));
    await waitFor(() => expect(posted[0]).toMatchObject({ targetMode: "filter", filter: { plan: "team_s", status: "trial" }, title: "ปรับปรุงระบบคืนวันเสาร์" }));
    expect(posted[0]).not.toHaveProperty("workspaceIds");
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("ลูกค้าทุกรายเกิน 1,000: บอกว่าต้องแตะกุญแจ · ส่งแล้วเปิด G4 แล้วส่งซ้ำ", async () => {
    const { posted } = setup({ reauthFirst: true });
    const dlg = await screen.findByRole("dialog", { name: "ส่งประกาศถึงลูกค้า" });
    await userEvent.click(within(dlg).getByLabelText(/ลูกค้าทุกราย/));
    expect(await within(dlg).findByText("Owner · เกิน 1,000 รายต้องแตะกุญแจ")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("หัวข้อ *"), "ประกาศถึงทุกคน");
    await userEvent.type(within(dlg).getByLabelText("ข้อความ *"), "ข้อความสมมติ");
    await userEvent.click(within(dlg).getByRole("button", { name: "ส่งประกาศ" }));
    await userEvent.click(await screen.findByRole("button", { name: "แตะกุญแจ" }));
    await waitFor(() => expect(posted[0]).toMatchObject({ targetMode: "all" }));
  });
});
