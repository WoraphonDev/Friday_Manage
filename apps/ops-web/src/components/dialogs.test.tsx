import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { OPS, server } from "@/test/server";
import { ApprovalFlowProvider, ConfirmDialog, ExportDialog, IrreversibleDialog, ReauthProvider, useApprovalFlow } from "./dialogs";
import { Empty, NoAccess } from "./kit";
import { useToast } from "./ui";

describe("ยืนยันพร้อมเหตุผล (G5)", () => {
  it("ต้องมี Ticket และเหตุผล · ส่งค่าให้รายการ · ติ๊กแจ้งผู้ใช้", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<ConfirmDialog open onOpenChange={() => undefined} title="ออกจากทุกอุปกรณ์?" ticket notify onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "ยืนยัน" }));
    expect(screen.getAllByText("ระบุเหตุผลอย่างน้อย 3 ตัวอักษร")).toHaveLength(2);
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Ticket ที่เกี่ยวข้อง"), "#515");
    await userEvent.type(screen.getByLabelText("เหตุผล (บันทึกใน Audit log)"), "โทรศัพท์หาย");
    await userEvent.click(screen.getByLabelText("แจ้งผู้ใช้ทางอีเมล"));
    await userEvent.click(screen.getByRole("button", { name: "ยืนยัน" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: "โทรศัพท์หาย", ticketNo: "#515", notify: false }));
  });
});

describe("ย้อนกลับไม่ได้ (G6)", () => {
  it("กดได้เมื่อพิมพ์คำยืนยันตรงและมีเหตุผล", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<IrreversibleDialog open onOpenChange={() => undefined} title="ลบ Workspace ถาวร?" word="bangsue-data" onConfirm={onConfirm} />);
    const go = screen.getByRole("button", { name: "ยืนยัน" });
    await userEvent.type(screen.getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ค้างชำระเกิน 60 วัน");
    await userEvent.type(screen.getByLabelText("พิมพ์ bangsue-data เพื่อยืนยัน"), "bangsue");
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("พิมพ์ bangsue-data เพื่อยืนยัน"), "-data");
    expect(go).toBeEnabled();
    await userEvent.click(go);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: "ค้างชำระเกิน 60 วัน", typed: "bangsue-data" }));
  });
});

function Trigger({ result }: { result: unknown }) {
  const { handle } = useApprovalFlow();
  return (
    <button type="button" onClick={() => handle(result)}>
      ทำรายการ
    </button>
  );
}
const pending = (canSelfApprove: boolean) => ({
  pendingApproval: { id: "ap-9", kind: "workspace.discount", reason: "ต่อสัญญารายปี", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), amountSatang: null, payload: { rule: "ส่วนลดเกิน 30% หรือเกิน 12 รอบ" }, canSelfApprove },
});
const flow = (result: unknown) =>
  renderWithProviders(
    <ReauthProvider>
      <ApprovalFlowProvider>
        <Trigger result={result} />
      </ApprovalFlowProvider>
    </ReauthProvider>,
  );

describe("ผลที่ต้องอนุมัติ (G7 / G12)", () => {
  it("อนุมัติตัวเองไม่ได้ → G7 แสดงเกณฑ์ · ยกเลิกคำขอได้", async () => {
    let cancelled = false;
    server.use(http.post(`${OPS}/approvals/ap-9/cancel`, () => ((cancelled = true), HttpResponse.json({ approval: {} }))));
    flow(pending(false));
    await userEvent.click(screen.getByRole("button", { name: "ทำรายการ" }));
    expect(await screen.findByText("ส่งขออนุมัติแล้ว")).toBeInTheDocument();
    expect(screen.getByText("ส่วนลดเกิน 30% หรือเกิน 12 รอบ")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ยกเลิกคำขอ" }));
    await waitFor(() => expect(cancelled).toBe(true));
  });

  it("มีผู้อนุมัติคนเดียว → G12 ต้องใส่เหตุผลแล้วอนุมัติตัวเอง", async () => {
    let note = "";
    server.use(http.post(`${OPS}/approvals/ap-9/approve`, async ({ request }) => ((note = ((await request.json()) as { note: string }).note), HttpResponse.json({ approval: {}, result: {} }))));
    flow(pending(true));
    await userEvent.click(screen.getByRole("button", { name: "ทำรายการ" }));
    expect(await screen.findByText("อนุมัติรายการของตัวเอง?")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "อนุมัติตัวเองและทำรายการ" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("เหตุผล (บังคับ)"), "ลูกค้าเซ็นสัญญา 3 ปี");
    await userEvent.click(go);
    await waitFor(() => expect(note).toBe("ลูกค้าเซ็นสัญญา 3 ปี"));
    expect(await screen.findByText("อนุมัติตัวเองและทำรายการแล้ว")).toBeInTheDocument();
  });

  it("ผลปกติ (ไม่มี pendingApproval) ไม่เปิดอะไร", async () => {
    flow({ discount: { percent: 10 } });
    await userEvent.click(screen.getByRole("button", { name: "ทำรายการ" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ส่งออก (G9)", () => {
  it("เลือกคอลัมน์ข้อมูลส่วนบุคคลต้องใส่เหตุผล", async () => {
    const onExported = vi.fn();
    function View() {
      const [open, setOpen] = useState(true);
      return <ExportDialog open={open} onOpenChange={setOpen} title="ส่งออกรายชื่อ" filename="x.csv" rows={[{ name: "ก", email: "a@example.com" }]} columns={[{ key: "name", label: "ชื่อ" }, { key: "email", label: "อีเมล Owner", pii: true }]} onExported={onExported} />;
    }
    renderWithProviders(<View />);
    expect(screen.getByText("1 แถว ตามตัวกรองปัจจุบัน")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/อีเมล Owner/));
    const go = screen.getByRole("button", { name: "ส่งออก" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("เหตุผล (บันทึกใน Audit log)"), "ส่งให้ทีมขายโทรติดตาม");
    await userEvent.click(go);
    expect(onExported).toHaveBeenCalledWith({ columns: ["name", "email"], reason: "ส่งให้ทีมขายโทรติดตาม", count: 1 });
  });
});

describe("Toast (G10) และสถานะหน้า (S5, S7)", () => {
  it("Toast ล้มค้างไว้พร้อม requestId · สำเร็จมีปุ่มย้อนกลับ", async () => {
    const undo = vi.fn();
    function View() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast({ message: "บันทึกไม่สำเร็จ", tone: "error", requestId: "req_7f2a91" })}>
            ล้ม
          </button>
          <button type="button" onClick={() => toast({ message: "ขยายทดลองใช้ 7 วันแล้ว", detail: "แจ้งลูกค้าทางอีเมลแล้ว", undo })}>
            สำเร็จ
          </button>
        </>
      );
    }
    renderWithProviders(<View />);
    await userEvent.click(screen.getByRole("button", { name: "ล้ม" }));
    expect(screen.getByRole("alert")).toHaveTextContent("req_7f2a91");
    await userEvent.click(screen.getByRole("button", { name: "สำเร็จ" }));
    await userEvent.click(screen.getByRole("button", { name: "ย้อนกลับ" }));
    expect(undo).toHaveBeenCalled();
  });

  it("ว่างเพราะตัวกรอง: ปุ่มล้างตัวกรอง · ไม่มีสิทธิ์: บอกบทบาทที่ต้องมี และปุ่มสิทธิ์ฉุกเฉินสำหรับ Owner", async () => {
    const clear = vi.fn();
    const glass = vi.fn();
    renderWithProviders(
      <>
        <Empty title="ไม่มีรายการที่ตรงกับตัวกรอง" onClearFilters={clear} />
        <NoAccess need={["engineer"]} mine={["owner"]} onBreakGlass={glass} />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "ล้างตัวกรอง" }));
    expect(clear).toHaveBeenCalled();
    expect(screen.getByText("หน้านี้เปิดให้ วิศวกร")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "เปิดสิทธิ์ฉุกเฉิน" }));
    expect(glass).toHaveBeenCalled();
  });
});
