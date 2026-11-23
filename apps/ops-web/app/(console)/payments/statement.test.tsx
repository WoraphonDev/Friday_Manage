// O03 เฟส 2 · นำเข้า statement ธนาคาร · ข้อมูลสมมติเท่านั้น
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import { renderWithProviders } from "@/test/render";
import { navigation } from "@/test/router";
import { asRole, OPS, server } from "@/test/server";
import { BillingPage } from "./BillingPage";

const account = { bank: "กสิกรไทย", accountNo: "xxx-x-x1234", accountName: "บริษัทสมมติ จำกัด" };
const preview = {
  account, periodFrom: "2026-11-16", periodTo: "2026-11-22", deposits: 4, withdrawals: 2, skipped: 1, duplicates: 0, matched: 2, reconciled: 0, review: 1, ignored: 1,
  lines: [
    { txnAt: "2026-11-17T02:12:00.000Z", amount: 321_000, description: "Bill FRI-2611-0007", kind: "invoice", reason: null, invoice: { number: "FRI-2611-0007" } },
    { txnAt: "2026-11-18T07:40:00.000Z", amount: 160_500, description: "จาก บจก. ตัวอย่างดี", kind: "slip", reason: null, invoice: { number: "FRI-2611-0005" } },
    { txnAt: "2026-11-19T03:03:00.000Z", amount: 300_000, description: "จาก นาย ก.", kind: "review", reason: "many_candidates", invoice: null },
    { txnAt: "2026-11-20T17:01:00.000Z", amount: 1_240, description: "ดอกเบี้ยเงินฝาก", kind: "ignored", reason: "not_customer", invoice: null },
  ],
};
const page = (search: string) => {
  navigation.pathname = "/payments";
  navigation.search = search;
  return renderWithProviders(
    <AppShell>
      <BillingPage />
    </AppShell>,
  );
};
const empties = () =>
  server.use(
    http.get(`${OPS}/payments/incoming`, () => HttpResponse.json({ date: "2026-11-23", items: [], totalSatang: 0 })),
    http.get(`${OPS}/payments/exceptions`, () => HttpResponse.json({ items: [], payments30d: 0, total: 0 })),
    http.get(`${OPS}/payments`, () => HttpResponse.json({ items: [], total: 0 })),
    http.get(`${OPS}/bank-statements`, () => HttpResponse.json({ account, imports: [] })),
  );

describe("นำเข้า statement ธนาคาร", () => {
  it("การเงิน: ปุ่มในแท็บประวัติเงินเข้า → วางไฟล์ → ดูผลจับคู่ → บันทึก (ส่งไฟล์ตรง ๆ พร้อมชื่อไฟล์)", async () => {
    asRole("finance");
    empties();
    const sent: { path: string; type: string | null; name: string | null; size: number }[] = [];
    server.use(
      http.post(`${OPS}/bank-statements/preview`, async ({ request }) => {
        sent.push({ path: "preview", type: request.headers.get("content-type"), name: request.headers.get("x-file-name"), size: (await request.arrayBuffer()).byteLength });
        return HttpResponse.json(preview);
      }),
      http.post(`${OPS}/bank-statements`, async ({ request }) => {
        sent.push({ path: "commit", type: request.headers.get("content-type"), name: request.headers.get("x-file-name"), size: (await request.arrayBuffer()).byteLength });
        return HttpResponse.json({ ...preview, id: "imp1" }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    page("tab=incoming");
    await user.click(await screen.findByRole("button", { name: "นำเข้า statement" }));
    const dialog = await screen.findByRole("dialog", { name: "นำเข้า statement ธนาคาร" });
    expect(within(dialog).getByText("บัญชีรับเงิน กสิกรไทย · xxx-x-x1234 · บริษัทสมมติ จำกัด")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "ตรวจไฟล์" })).toBeDisabled();

    await user.upload(within(dialog).getByLabelText("เลือกไฟล์"), new File(["วันที่,ฝากเงิน\n17/11/2026,3210"], "K-BIZ พ.ย.csv", { type: "text/csv" }));
    expect(await within(dialog).findByText("ตรงใบแจ้งหนี้ 2")).toBeInTheDocument();
    expect(within(dialog).getByText("ต้องตรวจ 1")).toBeInTheDocument();
    expect(within(dialog).getByText("ไม่เกี่ยวกับลูกค้า 3")).toBeInTheDocument();
    const table = within(dialog).getByRole("table", { name: "ผลจับคู่" });
    expect(within(table).getByText("ยอดตรงหลายใบ")).toBeInTheDocument();
    expect(within(table).getByText("ตรง · ยืนยันสลิป")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "บันทึก 2 รายการ · ส่ง 1 เข้าคิวต้องตรวจ" }));
    expect(await screen.findByText("นำเข้า statement แล้ว · ตรง 2 · ต้องตรวจ 1")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "นำเข้า statement ธนาคาร" })).not.toBeInTheDocument());
    expect(sent.map((x) => x.path)).toEqual(["preview", "commit"]);
    for (const x of sent) expect(x).toMatchObject({ type: "application/octet-stream", name: encodeURIComponent("K-BIZ พ.ย.csv") });
    expect(sent[1].size).toBeGreaterThan(0);
  });

  it("ผู้ตรวจ (auditor) ไม่เห็นปุ่มนำเข้า", async () => {
    asRole("auditor");
    empties();
    page("tab=incoming");
    expect(await screen.findByText("ไม่มีเงินเข้าในวันนี้")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "นำเข้า statement" })).not.toBeInTheDocument();
  });

  it("แท็บต้องตรวจ: การ์ดเงินเข้าที่จับคู่ไม่ได้ · ผูกกับใบที่ยอดตรง · ไม่เกี่ยวกับลูกค้า", async () => {
    asRole("finance");
    empties();
    const posts: { path: string; body: unknown }[] = [];
    server.use(
      http.get(`${OPS}/bank-statement-lines`, () =>
        HttpResponse.json({
          total: 2,
          items: [
            { id: "l1", txnAt: "2026-11-19T03:03:00.000Z", amount: 300_000, description: "จาก นาย ก.", reason: "many_candidates", candidates: [{ id: "i1", number: "FRI-2611-0011", amountDue: 300_000, dueDate: "2026-11-25", workspace: { name: "Orbit Apps" } }, { id: "i2", number: "FRI-2611-0012", amountDue: 300_000, dueDate: "2026-11-26", workspace: { name: "Kanit Labs" } }] },
            { id: "l2", txnAt: "2026-11-20T03:03:00.000Z", amount: 80_000, description: "โอนระหว่างบัญชี", reason: "unmatched", candidates: [] },
          ],
        }),
      ),
      http.post(`${OPS}/bank-statement-lines/:id/match`, async ({ request, params }) => (posts.push({ path: `match:${params.id}`, body: await request.json() }), HttpResponse.json({ id: params.id, invoice: "FRI-2611-0012", settled: true, creditSatang: 0, remainingSatang: 0 }))),
      http.post(`${OPS}/bank-statement-lines/:id/ignore`, async ({ request, params }) => (posts.push({ path: `ignore:${params.id}`, body: await request.json() }), HttpResponse.json({ id: params.id, status: "ignored" }))),
    );
    const user = userEvent.setup();
    page("tab=verify");
    const card = await screen.findByRole("region", { name: "เงินเข้าจาก statement ที่ยังจับคู่ไม่ได้" });
    expect(within(card).getByText("ยอดตรงหลายใบ")).toBeInTheDocument();
    expect(screen.queryByText("ไม่มีกรณีผิดปกติ")).not.toBeInTheDocument();

    await user.click(within(card).getAllByRole("button", { name: "ผูกใบแจ้งหนี้" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("ยอดตรง")).toHaveLength(2);
    await user.click(within(dialog).getByRole("radio", { name: /FRI-2611-0012/ }));
    await user.type(within(dialog).getByLabelText(/^เหตุผล/), "ลูกค้าโทรแจ้งชื่อผู้โอน (สมมติ)");
    await user.click(within(dialog).getByRole("button", { name: "ผูกและยืนยันเงินเข้า" }));
    expect(await screen.findByText("ยืนยันเงินเข้าให้ FRI-2611-0012 แล้ว")).toBeInTheDocument();

    await user.click(within(card).getAllByRole("button", { name: "ไม่เกี่ยวกับลูกค้า" })[1]);
    const ig = await screen.findByRole("dialog");
    await user.type(within(ig).getByLabelText(/^เหตุผล/), "โอนระหว่างบัญชีของบริษัท");
    await user.click(within(ig).getByRole("button", { name: "ไม่เกี่ยวกับลูกค้า" }));
    expect(await screen.findByText("บันทึกว่าไม่เกี่ยวกับลูกค้าแล้ว")).toBeInTheDocument();
    expect(posts).toEqual([
      { path: "match:l1", body: { invoiceId: "i2", reason: "ลูกค้าโทรแจ้งชื่อผู้โอน (สมมติ)" } },
      { path: "ignore:l2", body: { reason: "โอนระหว่างบัญชีของบริษัท" } },
    ]);
  });
});
