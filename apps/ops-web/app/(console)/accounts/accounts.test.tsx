// ช่วง 3 · บัญชีลูกค้าระดับบริษัท · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation, router } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { RenewalsPage } from "../renewals/RenewalsPage";
import { AccountDetail } from "./[id]/AccountDetail";
import { AccountsPage } from "./AccountsPage";
import type { Account } from "./_parts/types";

const A = "20000000-0000-4000-8000-00000000000a";
const account = (over: Partial<Account> = {}): Account => ({
  id: A, name: "บจก. สยามสมมติ", taxIds: ["0105500000017", "0105500000025"], kind: "enterprise", managerId: "s-1", managerName: "มิว ศิริ", contacts: [{ name: "คุณเอ", email: "a@siam.example.com", role: "signer" }], notes: "ต่อสัญญาปีละครั้ง",
  contractStart: "2026-04-01", contractEnd: "2027-03-31", contractValue: 21_600_000, contractSeats: 125, contractSla: { first: { n: 1, unit: "h" }, resolve: { n: 1, unit: "d" } }, lastContactAt: null, file: null,
  numbers: { workspaces: 3, seats: 86, seatLimit: 100, mrr: 1_800_000, minHealth: { score: 41, workspace: { id: "w-2", name: "สยาม · การตลาด" } }, openTickets: 3, overdue: 0, overdueAny: false, active30: 70 },
  can: { edit: true, contract: true, remove: true }, daysLeft: 45, ...over,
});
const shell = (ui: React.ReactElement, path: string, search = "") => {
  navigation.pathname = path;
  navigation.search = search;
  return renderWithProviders(<AppShell>{ui}</AppShell>);
};

describe("บัญชีลูกค้า", () => {
  it("รายการ · ระบบเสนอจากเลขภาษีเดียวกัน · Support สร้างบัญชีจากข้อเสนอ (ไม่เห็นยอดเงิน)", async () => {
    asRole("support");
    const posted: unknown[] = [];
    server.use(
      http.get(`${OPS}/accounts`, () => HttpResponse.json({ items: [account({ contractValue: null, numbers: { ...account().numbers, mrr: null, overdue: null } })], total: 1, limit: 50, offset: 0 })),
      http.get(`${OPS}/accounts/suggestions`, () => HttpResponse.json({ items: [{ key: "t:0105500000033", taxId: "0105500000033", name: "บจก. ออร์บิทสมมติ", count: 2, workspaces: [{ id: "w-a", name: "ออร์บิท · แอป", slug: "orbit-app" }, { id: "w-b", name: "ออร์บิท · ขาย", slug: "orbit-sales" }] }] })),
      http.post(`${OPS}/accounts`, async ({ request }) => (posted.push(await request.json()), HttpResponse.json(account({ id: "new-1", name: "บจก. ออร์บิทสมมติ" }), { status: 201 }))),
    );
    shell(<AccountsPage />, "/accounts");
    const table = (await screen.findByText("บจก. สยามสมมติ")).closest("table")!;
    expect(within(table).queryByRole("columnheader", { name: "MRR รวม" })).not.toBeInTheDocument();
    expect(within(table).getByText("สยาม · การตลาด")).toBeInTheDocument();
    expect(screen.getByText("ระบบเสนอให้รวมเป็นบัญชี 1 ราย")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "สร้างบัญชี" }));
    const dialog = await screen.findByRole("dialog", { name: "สร้างบัญชีลูกค้า" });
    expect(within(dialog).getByLabelText("ชื่อบัญชี")).toHaveValue("บจก. ออร์บิทสมมติ");
    await userEvent.click(within(dialog).getByRole("button", { name: "สร้างบัญชี" }));
    await waitFor(() => expect(posted).toEqual([{ name: "บจก. ออร์บิทสมมติ", taxIds: ["0105500000033"], kind: "standard", workspaceIds: ["w-a", "w-b"] }]));
    expect(router.push).toHaveBeenCalledWith("/accounts/new-1");
  });

  it("หน้าบัญชี: ตัวเลขรวม · สุขภาพต่ำสุดบอก Workspace · การเงินแก้สัญญาและ SLA ตามสัญญา", async () => {
    asRole("finance");
    const put: unknown[] = [];
    server.use(
      http.get(`${OPS}/accounts/${A}`, () => HttpResponse.json(account({ can: { edit: false, contract: true, remove: false } }))),
      http.get(`${OPS}/workspaces`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("account")).toBe(A);
        return HttpResponse.json({ items: [{ id: "w-2", name: "สยาม · การตลาด", slug: "siam-mkt", plan: "team_l", seats: 40, seatLimit: 50, health: 41, mrr: 550_000, openTickets: 2 }], total: 1 });
      }),
      http.put(`${OPS}/accounts/${A}/contract`, async ({ request }) => (put.push(await request.json()), HttpResponse.json(account()))),
    );
    shell(<AccountDetail id={A} />, `/accounts/${A}`);
    expect(await screen.findByRole("heading", { name: "บจก. สยามสมมติ" })).toBeInTheDocument();
    const stats = screen.getByRole("region", { name: "ตัวเลขรวมของบัญชี" });
    expect(within(stats).getByText("86 / 125")).toBeInTheDocument();
    expect(within(stats).getByRole("link", { name: "สยาม · การตลาด" })).toHaveAttribute("href", "/workspaces/w-2");
    expect(await screen.findByText("siam-mkt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "แก้บัญชี" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "สัญญา" }));
    const dialog = await screen.findByRole("dialog", { name: "สัญญาของบัญชี" });
    const value = within(dialog).getByLabelText("มูลค่าต่อปี (บาท)");
    await userEvent.clear(value);
    await userEvent.type(value, "240000");
    await userEvent.click(within(dialog).getByRole("button", { name: "บันทึก" }));
    await waitFor(() => expect(put).toEqual([{ start: "2026-04-01", end: "2027-03-31", value: 24_000_000, seats: 125, sla: { first: { n: 1, unit: "h" }, resolve: { n: 1, unit: "d" } } }]));
  });

  it("วันต่อสัญญา: ใกล้หมดก่อน · บอกเหลือกี่วัน · เปลี่ยนช่วงส่งไป ops-api", async () => {
    asRole("finance");
    const asked: string[] = [];
    server.use(
      http.get(`${OPS}/renewals`, ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("within")!);
        return HttpResponse.json({ items: [account({ daysLeft: 25 })], total: 1, limit: 50, offset: 0 });
      }),
    );
    shell(<RenewalsPage />, "/renewals");
    expect(await screen.findByText("อีก 25 วัน")).toBeInTheDocument();
    expect(screen.getByText("฿216,000")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("หมดภายใน"), "180");
    await waitFor(() => expect(asked.at(-1)).toBe("180"));
  });
});
