// O42 · H8 · ตารางการเข้าช่วยเหลือ: เวลาหมด / จบ และเวลาที่ใช้ · ข้อมูลสมมติ
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { staff } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { OPS, server } from "@/test/server";
import { Sessions } from "./SessionsTable";

const MIN = 60_000;
const at = (offsetMin: number) => new Date(Date.now() + offsetMin * MIN).toISOString();
const base = { workspaceId: "ws-1", ticketId: null, reason: "ตรวจสิทธิ์โปรเจกต์", secondApproverId: null, staffId: staff.support.id, staffName: "มิว", staffRoles: ["support"] };

describe("ตารางการเข้าช่วยเหลือ (H8)", () => {
  it("คอลัมน์หมดเวลา / จบ และใช้ไป · สถานะเปิดอยู่ / จบแล้ว / หมดเวลา · จบเฉพาะที่เปิดอยู่", async () => {
    let asked = "";
    let ended = "";
    server.use(
      http.get(`${OPS}/support-sessions`, ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({
          serverTime: new Date().toISOString(),
          items: [
            { ...base, id: "s-open", ticketNo: "#530", mode: "read", startedAt: at(-41), expiresAt: at(18.5), endedAt: null, endReason: null, usedMinutes: 41, workspace: { name: "Orbit Apps", slug: "orbit-apps" } },
            { ...base, id: "s-manual", ticketNo: "#528", mode: "read", startedAt: at(-1500), expiresAt: at(-1440), endedAt: at(-1488), endReason: "manual", usedMinutes: 12, workspace: { name: "TechNova", slug: "technova" } },
            { ...base, id: "s-exp", ticketNo: "#521", mode: "read", staffName: "ฟ้า", staffRoles: ["owner"], startedAt: at(-3000), expiresAt: at(-2940), endedAt: at(-2940), endReason: "expired", usedMinutes: 60, workspace: { name: "Lumen Studio", slug: "lumen" } },
          ],
        });
      }),
      http.post(`${OPS}/support-sessions/:id/end`, ({ params }) => ((ended = String(params.id)), HttpResponse.json({ session: {} }))),
    );
    renderWithProviders(<Sessions />);
    const table = (await screen.findByText("Orbit Apps")).closest("table")!;
    expect(asked).toBe("?scope=recent");
    for (const h of ["ผู้เข้า", "ลูกค้า", "Ticket", "โหมด", "เริ่ม", "หมดเวลา / จบ", "ใช้ไป", "สถานะ"]) expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
    const open = within(table).getByText("Orbit Apps").closest("tr")!;
    expect(within(open).getByText("มิว (Support)")).toBeInTheDocument();
    expect(within(open).getByText("41 นาที")).toBeInTheDocument();
    expect(within(open).getByText(/^เปิดอยู่ · เหลือ (18|19) นาที$/)).toBeInTheDocument();
    const manual = within(table).getByText("TechNova").closest("tr")!;
    expect(within(manual).getByText(/ · ออกเอง$/)).toBeInTheDocument();
    expect(within(manual).getByText("จบแล้ว")).toBeInTheDocument();
    expect(within(manual).queryByRole("button", { name: "จบ" })).not.toBeInTheDocument();
    const expired = within(table).getByText("Lumen Studio").closest("tr")!;
    expect(within(expired).getByText("ฟ้า (Owner)")).toBeInTheDocument();
    expect(within(expired).getByText(/ · หมดเวลา$/)).toBeInTheDocument();
    expect(within(expired).getByText("60 นาที")).toBeInTheDocument();
    expect(screen.getByText("เปิดอยู่ 1 · 30 วันล่าสุด 3 ครั้ง")).toBeInTheDocument();
    await userEvent.click(within(open).getByRole("button", { name: "จบ" }));
    await waitFor(() => expect(ended).toBe("s-open"));
  });
});
