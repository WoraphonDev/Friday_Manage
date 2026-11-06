import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { detailA, detailB, workspaceRows, wsA, wsB } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, opsError, server } from "@/test/server";
import { Shell } from "../shell/Shell";
import { Workspaces } from "./Workspaces";

const lists: string[] = [];
function workspaceHandlers(over: { a?: Partial<typeof detailA>; b?: Partial<typeof detailB> } = {}) {
  lists.length = 0;
  server.use(
    http.get(`${OPS}/workspaces`, ({ request }) => {
      lists.push(new URL(request.url).search);
      return HttpResponse.json({ items: workspaceRows, limit: 50, offset: 0 });
    }),
    http.get(`${OPS}/workspaces/${wsA}`, () => HttpResponse.json({ ...detailA, ...over.a })),
    http.get(`${OPS}/workspaces/${wsB}`, () => HttpResponse.json({ ...detailB, ...over.b })),
  );
}
const view = () => {
  navigation.pathname = "/workspaces";
  return renderWithProviders(
    <Shell>
      <Workspaces />
    </Shell>,
  );
};
const detail = () => within(screen.getByRole("region", { name: "รายละเอียดลูกค้า" }));
async function pick(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
}

describe("ลูกค้า (Workspace)", () => {
  it("รายการ + ตัวกรองส่งเป็น query ของ ops/workspaces", async () => {
    workspaceHandlers();
    view();
    expect(await screen.findByRole("button", { name: /ทีมตัวอย่าง/ })).toBeInTheDocument();
    expect(screen.getByText("ทดลอง เหลือ 3 วัน")).toBeInTheDocument();
    expect(screen.getByText("เลือก Workspace เพื่อดูรายละเอียด")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("แพ็กเกจ"), "team_m");
    await userEvent.selectOptions(screen.getByLabelText("สถานะ"), "trialing");
    await userEvent.type(screen.getByLabelText("ค้นหาลูกค้า"), "trial");
    await waitFor(() => expect(lists.at(-1)).toBe("?q=trial&plan=team_m&status=trialing"));
  });

  it("ตัวกรองเริ่มจาก ?status= (ลิงก์จากหน้าภาพรวม)", async () => {
    workspaceHandlers();
    navigation.search = "status=past_due";
    view();
    await screen.findByRole("button", { name: /ทีมตัวอย่าง/ });
    expect(lists[0]).toBe("?status=past_due");
  });

  it("ไม่พบ Workspace: สถานะว่าง", async () => {
    server.use(http.get(`${OPS}/workspaces`, () => HttpResponse.json({ items: [] })));
    view();
    expect(await screen.findByText("ไม่พบ Workspace")).toBeInTheDocument();
  });

  it("รายละเอียด: แพ็กเกจ, สมาชิก, Owner และใบแจ้งหนี้", async () => {
    workspaceHandlers();
    view();
    await pick("ทีมตัวอย่าง");
    expect(await detail().findByText("Team L · รายปี")).toBeInTheDocument();
    expect(detail().getByText("41 · Guest 3")).toBeInTheDocument();
    expect(detail().getByText("owner@example.com")).toBeInTheDocument();
    expect(detail().getByText("บัตรเครดิต")).toBeInTheDocument();
    expect(detail().getByText("INV-2569-0001")).toBeInTheDocument();
  });

  it("เริ่ม support session โหมดอ่านอย่างเดียว: ส่ง Ticket + เหตุผล", async () => {
    workspaceHandlers();
    let body: unknown;
    server.use(
      http.post(`${OPS}/workspaces/${wsA}/support-sessions`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ session: {}, notified: 1 }, { status: 201 });
      }),
    );
    view();
    await pick("ทีมตัวอย่าง");
    const start = await detail().findByRole("button", { name: "เริ่มเข้าใช้ในฐานะทีมช่วยเหลือ" });
    expect(start).toBeDisabled();
    await userEvent.type(detail().getByLabelText("เลข Ticket"), "#1001");
    await userEvent.type(detail().getByLabelText("เหตุผล"), "สั้น");
    await userEvent.click(start);
    expect(detail().getByText("ระบุเหตุผลอย่างน้อย 10 ตัวอักษร")).toBeInTheDocument();
    await userEvent.type(detail().getByLabelText("เหตุผล"), "ไป ลูกค้าแจ้งนำเข้าค้าง");
    await userEvent.click(start);
    expect(await screen.findByText("เริ่มเข้าช่วยเหลือแล้ว · แจ้งลูกค้าทางอีเมล 1 คน")).toBeInTheDocument();
    expect(body).toEqual({ ticketNo: "#1001", reason: "สั้นไป ลูกค้าแจ้งนำเข้าค้าง", mode: "read" });
  });

  it("โหมดแก้ไขต้องมีผู้อนุมัติคนที่ 2 · error ของ ops-api แสดงในฟอร์ม", async () => {
    workspaceHandlers();
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/workspaces/${wsA}/support-sessions`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return opsError(422, "second_approver_must_differ", "ผู้อนุมัติคนที่ 2 ต้องเป็นคนละคนกับผู้เข้า");
      }),
    );
    view();
    await pick("ทีมตัวอย่าง");
    await userEvent.type(await detail().findByLabelText("เลข Ticket"), "#1002");
    await userEvent.type(detail().getByLabelText("เหตุผล"), "กู้คืนโปรเจกต์ที่ลบผิดตามคำขอ");
    await userEvent.selectOptions(detail().getByLabelText("สิทธิ์ในครั้งนี้"), "write");
    const start = detail().getByRole("button", { name: "เริ่มเข้าใช้ในฐานะทีมช่วยเหลือ" });
    expect(start).toBeDisabled();
    await userEvent.type(detail().getByLabelText("รหัสพนักงานผู้อนุมัติคนที่ 2"), "00000000-0000-4000-8000-000000000001");
    await userEvent.click(start);
    expect(await detail().findByText("ผู้อนุมัติคนที่ 2 ต้องเป็นคนละคนกับผู้เข้า")).toBeInTheDocument();
    expect(body).toMatchObject({ mode: "write", secondApproverId: "00000000-0000-4000-8000-000000000001" });
  });

  it("ลูกค้าอนุญาตเฉพาะอ่าน: ตัวเลือกแก้ไขถูกปิด · ไม่เปิดสิทธิ์: ไม่มีฟอร์ม", async () => {
    workspaceHandlers({ a: { supportAccess: { until: "2099-01-01T00:00:00.000Z", maxMode: "read", notifyAdmins: true, active: true } } });
    view();
    await pick("ทีมตัวอย่าง");
    expect(await detail().findByRole("option", { name: "แก้ไขได้ (ต้องมีผู้อนุมัติคนที่ 2)" })).toBeDisabled();
    await pick("ทีมทดลอง");
    expect(await detail().findByText("ลูกค้ายังไม่เปิดสิทธิ์")).toBeInTheDocument();
    expect(detail().queryByLabelText("เลข Ticket")).not.toBeInTheDocument();
  });

  it("Admin: ขยายช่วงทดลอง (เฉพาะที่กำลังทดลอง) ส่ง days + reason", async () => {
    workspaceHandlers();
    let body: unknown;
    server.use(
      http.post(`${OPS}/workspaces/${wsB}/extend-trial`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ trialEndsAt: "2026-12-01T00:00:00.000Z" });
      }),
    );
    view();
    await pick("ทีมทดลอง");
    await userEvent.click(await detail().findByRole("button", { name: "ขยายช่วงทดลอง" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("จำนวนวัน (1–60)"));
    await userEvent.type(within(dialog).getByLabelText("จำนวนวัน (1–60)"), "7");
    await userEvent.click(within(dialog).getByRole("button", { name: "ขยายช่วงทดลอง" }));
    expect(within(dialog).getByText("ระบุเหตุผลอย่างน้อย 3 ตัวอักษร")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("เหตุผล"), "ลูกค้าขอเวลาทดลองเพิ่ม");
    await userEvent.click(within(dialog).getByRole("button", { name: "ขยายช่วงทดลอง" }));
    expect(await screen.findByText(/ขยายช่วงทดลองถึง .* แล้ว/)).toBeInTheDocument();
    expect(body).toEqual({ days: 7, reason: "ลูกค้าขอเวลาทดลองเพิ่ม" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Admin: ส่วนลด, เปลี่ยนแพ็กเกจ และระงับ · error 409 แสดงใน Dialog พร้อมรหัสอ้างอิง", async () => {
    workspaceHandlers();
    const bodies: Record<string, unknown> = {};
    server.use(
      http.post(`${OPS}/workspaces/${wsA}/:action`, async ({ request, params }) => {
        bodies[String(params.action)] = await request.json();
        if (params.action === "suspend") return opsError(409, "no_change", "Workspace ถูกระงับอยู่แล้ว", undefined, "req-409");
        return HttpResponse.json({});
      }),
    );
    view();
    await pick("ทีมตัวอย่าง");
    expect(await detail().findByRole("button", { name: "ให้ส่วนลด" })).toBeInTheDocument();
    expect(detail().queryByRole("button", { name: "ขยายช่วงทดลอง" })).not.toBeInTheDocument();

    await userEvent.click(detail().getByRole("button", { name: "ให้ส่วนลด" }));
    let dialog = await screen.findByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("ส่วนลด % (1–100)"));
    await userEvent.type(within(dialog).getByLabelText("ส่วนลด % (1–100)"), "20");
    await userEvent.type(within(dialog).getByLabelText("จำนวนรอบบิล (เว้นว่าง = ทุกรอบ)"), "3");
    await userEvent.type(within(dialog).getByLabelText("เหตุผล"), "ลูกค้ารายใหญ่");
    await userEvent.click(within(dialog).getByRole("button", { name: "ให้ส่วนลด" }));
    await waitFor(() => expect(bodies.discount).toEqual({ percent: 20, months: 3, reason: "ลูกค้ารายใหญ่" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await userEvent.click(detail().getByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("แพ็กเกจใหม่"), "enterprise");
    await userEvent.type(within(dialog).getByLabelText("เหตุผล"), "ย้ายตามสัญญา");
    await userEvent.click(within(dialog).getByRole("button", { name: "เปลี่ยนแพ็กเกจ" }));
    await waitFor(() => expect(bodies["change-plan"]).toEqual({ plan: "enterprise", reason: "ย้ายตามสัญญา" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await userEvent.click(detail().getByRole("button", { name: "ระงับ Workspace" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("เหตุผล"), "ละเมิดข้อตกลง");
    await userEvent.click(within(dialog).getByRole("button", { name: "ระงับ Workspace" }));
    expect(await within(dialog).findByText("Workspace ถูกระงับอยู่แล้ว")).toBeInTheDocument();
    expect(within(dialog).getByText("รหัสอ้างอิง: req-409")).toBeInTheDocument();
    expect(bodies.suspend).toEqual({ reason: "ละเมิดข้อตกลง" });
  });

  it("Workspace ที่ระงับอยู่: Admin เห็นปุ่มเปิดใช้งานอีกครั้ง", async () => {
    workspaceHandlers({ a: { status: "suspended" } });
    view();
    await pick("ทีมตัวอย่าง");
    expect(await detail().findByRole("button", { name: "เปิดใช้งานอีกครั้ง" })).toBeInTheDocument();
    expect(detail().queryByRole("button", { name: "ระงับ Workspace" })).not.toBeInTheDocument();
  });

  it("Support: เห็นเข้าช่วยเหลือ + ขยายทดลอง แต่ไม่เห็นส่วนลด / แพ็กเกจ / ระงับ", async () => {
    asRole("support");
    workspaceHandlers();
    view();
    await pick("ทีมทดลอง");
    expect(await detail().findByRole("button", { name: "ขยายช่วงทดลอง" })).toBeInTheDocument();
    for (const name of ["ให้ส่วนลด", "เปลี่ยนแพ็กเกจ", "ระงับ Workspace"]) expect(detail().queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("Finance: เห็นส่วนลด / แพ็กเกจ แต่ไม่เห็นฟอร์มเข้าช่วยเหลือและระงับ", async () => {
    asRole("finance");
    workspaceHandlers();
    view();
    await pick("ทีมตัวอย่าง");
    expect(await detail().findByRole("button", { name: "ให้ส่วนลด" })).toBeInTheDocument();
    expect(detail().queryByText("เข้าบัญชีเพื่อช่วยเหลือ")).not.toBeInTheDocument();
    expect(detail().queryByRole("button", { name: "ระงับ Workspace" })).not.toBeInTheDocument();
  });

  it("โหลดรายละเอียดไม่ได้: Error พร้อมรหัสอ้างอิง", async () => {
    workspaceHandlers();
    server.use(http.get(`${OPS}/workspaces/${wsA}`, () => opsError(500, "internal_error", "เกิดข้อผิดพลาดภายในระบบ", undefined, "req-ws-500")));
    view();
    await pick("ทีมตัวอย่าง");
    expect(await detail().findByText("รหัสอ้างอิง: req-ws-500")).toBeInTheDocument();
  });
});
