import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { asRole, OPS, server } from "@/test/server";
import { SlipRun } from "./_parts/SlipRun";

// ช่วง 2 · ตรวจสลิปต่อเนื่อง · ข้อมูลสมมติ
const slip = (n: number, amount: number, due = 160_500) => ({
  id: `90000000-0000-4000-8000-00000000000${n}`,
  method: "transfer",
  amount,
  createdAt: "2026-11-18T02:00:00.000Z",
  invoice: { id: `inv-${n}`, number: `FRI-2611-000${n}`, amountDue: due },
  workspace: { id: `w-${n}`, name: `ลูกค้า ${n}` },
});
const S1 = slip(1, 160_500);
const S2 = slip(2, 160_500);
const S3 = slip(3, 150_000);

describe("ตรวจสลิปต่อเนื่อง (ช่วง 2)", () => {
  it("A ผ่านแล้วไปใบถัดไป (ส่งจริงหลัง 10 วินาที) · ข้ามใบที่เพื่อนเปิด · X เลือกเหตุผลด้วยเลข · สรุปตอนจบ", async () => {
    asRole("finance");
    const calls: { path: string; body: unknown }[] = [];
    server.use(
      http.get(`${OPS}/payments`, () => HttpResponse.json({ items: [S1, S2, S3], total: 3 })),
      http.get(`${OPS}/payments/:id/slip`, () => new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })),
      http.get(`${OPS}/presence`, () => HttpResponse.json({ items: [{ id: S2.id, staffId: "s-9", name: "ฟ้า พรหมมา", mode: "viewing" }] })),
      http.post(`${OPS}/payments/:id/:action`, async ({ params, request }) => (calls.push({ path: `${params.action}:${params.id}`, body: await request.json() }), HttpResponse.json({ ok: true }))),
    );
    renderWithProviders(<SlipRun onClose={() => undefined} />);
    const dlg = await screen.findByRole("dialog", { name: "ตรวจสลิป" });
    expect(await within(dlg).findByText("ใบที่ 1 จาก 3")).toBeInTheDocument();
    expect(within(dlg).getByText("ตรง")).toBeInTheDocument();
    await userEvent.keyboard("a");
    expect(await screen.findByText(/ผ่านแล้ว · FRI-2611-0001/)).toBeInTheDocument();
    // ใบที่ 2 มีเพื่อนเปิดอยู่ จึงข้ามไปใบที่ 3
    expect(await within(dlg).findByText("ใบที่ 3 จาก 3")).toBeInTheDocument();
    expect(within(dlg).getByText(/ข้าม FRI-2611-0002 เพราะ ฟ้า พรหมมา กำลังเปิดอยู่/)).toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(within(dlg).getByText(/ขาด/)).toBeInTheDocument();
    await userEvent.keyboard("x");
    await userEvent.keyboard("2");
    expect(within(dlg).getByLabelText("ข้อความถึงลูกค้า (แก้ได้)")).toHaveValue("บัญชีปลายทางในสลิปไม่ใช่บัญชีของ Friday · ตรวจเลขบัญชีในใบแจ้งหนี้ FRI-2611-0003 แล้วแนบสลิปใหม่");
    await userEvent.click(within(dlg).getByRole("button", { name: "แจ้งลูกค้า · ใบถัดไป" }));
    await waitFor(() => expect(calls).toContainEqual({ path: `reject:${S3.id}`, body: { reason: "บัญชีปลายทางผิด", message: expect.stringContaining("FRI-2611-0003") } }));
    expect(await within(dlg).findByText("ตรวจครบ 3 ใบแล้ว")).toBeInTheDocument();
    const stat = (label: string) => within(dlg).getByText(label).parentElement!;
    expect(stat("ผ่าน")).toHaveTextContent("1");
    expect(stat("ไม่ผ่าน")).toHaveTextContent("1");
    expect(stat("ข้าม")).toHaveTextContent("1");
    // ย้อนกลับ = ยกเลิกการผ่านก่อนส่งจริง
    await userEvent.setup({ pointerEventsCheck: 0 }).click(screen.getByRole("button", { name: "ย้อนกลับ", hidden: true }));
    expect(await within(dlg).findByText("ใบที่ 1 จาก 3")).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("confirm"))).toBe(false);
  });
});
