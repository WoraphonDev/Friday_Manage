import { useState } from "react";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { UiGallery } from "../../../app/dev/ui/ui-gallery";
import { ApiError } from "@/lib/api";
import {
  useToast,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Forbidden,
  Button,
  DatePicker,
  Select,
  YearFormatContext,
} from "./index";

describe("UI kit", () => {
  it("Gallery มี component, status, priority, table และ error requestId", () => {
    renderWithProviders(<UiGallery />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByText("req_demo_001", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText("To do")).toBeInTheDocument();
    expect(
      screen.getByText("Urgent", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("อีเมล", {
        selector: 'input[aria-invalid="true"]',
      }),
    ).toHaveAttribute("aria-describedby");
  });

  it("Select ใช้ select ของ browser พร้อมคำนำหน้าและลูกศรที่ไม่ถูกอ่านซ้ำ", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <Select size="small" prefix="แสดง" aria-label="ระดับงาน" defaultValue="all" onChange={(e) => onChange(e.target.value)}>
        <option value="all">Task + Sub-task</option>
        <option value="task">Task เท่านั้น</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "ระดับงาน" });
    await user.selectOptions(select, "task");
    expect(onChange).toHaveBeenCalledWith("task");
    const box = select.parentElement!;
    expect(box).toHaveClass("select", "select-small", "select-prefixed");
    // คำนำหน้าและลูกศรเป็นแค่ภาพ ชื่อที่อ่านออกเสียงมาจาก aria-label
    expect(within(box).getByText("แสดง")).toHaveAttribute("aria-hidden", "true");
    expect(box.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("Combobox ค้นหาและเลือกผู้รับผิดชอบด้วย keyboard", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UiGallery />);
    await user.click(screen.getByRole("button", { name: "เลือกผู้รับผิดชอบ" }));
    await user.type(
      screen.getByRole("combobox", { name: "เลือกผู้รับผิดชอบ" }),
      "ผู้ทดสอบ",
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(
      screen.getByRole("button", { name: "เลือกผู้รับผิดชอบ" }),
    ).toHaveTextContent("ผู้ทดสอบตัวอย่าง");
    await user.keyboard("{Escape}");
  });

  it("DatePicker ใช้ปีจาก me.yearFormat และส่งวันที่ ISO เมื่อเลือก", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <YearFormatContext.Provider value="CE">
        <DatePicker
          label="วันทดสอบ"
          value="2026-12-01"
          onValueChange={change}
        />
      </YearFormatContext.Provider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("2026");
    await user.click(screen.getByRole("button"));
    const input = screen.getByLabelText("วันทดสอบ", { selector: "input" });
    await user.clear(input);
    await user.type(input, "2026-12-02");
    expect(change).toHaveBeenCalled();
  });

  it("Tabs เปลี่ยนด้วย keyboard และ dialog ปิดด้วย Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UiGallery />);
    await user.click(screen.getByRole("tab", { name: "ประวัติ" }));
    expect(screen.getByRole("tab", { name: "ประวัติ" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "เปิด Dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Drawer ซ้อนสองชั้นและย้อนกลับมางานแม่ได้", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UiGallery />);
    await user.click(screen.getByRole("button", { name: "เปิด Drawer" }));
    await user.click(screen.getByRole("button", { name: "เปิด Sub-task" }));
    expect(screen.getByRole("dialog", { name: "Sub-task" })).toHaveClass(
      "drawer-nested",
    );
    await user.click(screen.getByRole("button", { name: "Task แม่" }));
    expect(
      screen.queryByRole("dialog", { name: "Sub-task" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Task แม่" }),
    ).toBeInTheDocument();
  });

  it("ConfirmDialog รอ mutation สำเร็จแล้วมี Toast เลิกทำ", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    const undo = vi.fn();
    function Example() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          title="ยืนยัน"
          open={open}
          onOpenChange={setOpen}
          onConfirm={confirm}
          undo={undo}
          successMessage="ลบแล้ว"
        />
      );
    }
    renderWithProviders(<Example />);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "ยืนยัน",
      }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("ลบแล้ว")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "เลิกทำ" }));
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
  });

  it("mutation ล้มเหลวไม่ปิด ConfirmDialog และไม่แสดง success toast", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithProviders(
      <ConfirmDialog
        title="ยืนยัน"
        open
        onOpenChange={close}
        onConfirm={async () => {
          throw new Error("บันทึกไม่สำเร็จ");
        }}
        successMessage="สำเร็จ"
      />,
    );
    await user.click(screen.getByRole("button", { name: "ยืนยัน" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "บันทึกไม่สำเร็จ",
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("ErrorState แสดง requestId และ Forbidden แสดงเฉพาะ action ที่ให้สิทธิ์", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <ErrorState
          error={new ApiError(500, "server_error", "ผิดพลาด", {}, "req_123")}
          retry={retry}
        />
        <Forbidden />
      </>,
    );
    expect(screen.getByText("รหัสอ้างอิง: req_123")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "เข้าร่วมในฐานะ Admin" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ลองอีกครั้ง" }));
    expect(retry).toHaveBeenCalled();
  });

  it("Toast ซ้อนกันได้ (อันใหม่อยู่ท้ายใน DOM = บนสุดเพราะ column-reverse) และหายเองใน 4 วินาที · มีเลิกทำ 5 วินาที", async () => {
    vi.useFakeTimers();
    try {
      let push: ReturnType<typeof useToast> = () => undefined;
      function Example() { push = useToast(); return null; }
      renderWithProviders(<Example />);
      const { act } = await import("@testing-library/react");
      act(() => { push({ message: "อันแรก" }); push({ message: "อันที่สอง", undo: () => undefined }); });
      const items = [...document.querySelectorAll(".toast-region .toast")].map((el) => el.textContent);
      expect(items[0]).toContain("อันแรก"); expect(items[1]).toContain("อันที่สอง");
      act(() => { vi.advanceTimersByTime(4100); });
      expect(screen.queryByText("อันแรก")).not.toBeInTheDocument();
      expect(screen.getByText("อันที่สอง")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.queryByText("อันที่สอง")).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("Toast แจ้งเตือน K4 แสดงผู้กระทำ บรรทัดรอง และปุ่มลิงก์ แล้วปิดเมื่อกด", async () => {
    function Example() {
      const toast = useToast();
      return <button onClick={() => toast({ actor: { id: "u1", displayName: "ผู้ทดสอบ" }, message: "ส่งงานเข้า Review DE-2", meta: "ยังไม่อ่าน 1 รายการ", actions: [{ label: "เปิดงาน", href: "/w/sample/p/DE?issue=DE-2", primary: true }, { label: "ดูภายหลัง", href: "/w/sample/inbox" }] })}>แจ้ง</button>;
    }
    const user = userEvent.setup();
    renderWithProviders(<Example />);
    await user.click(screen.getByRole("button", { name: "แจ้ง" }));
    const toast = (await screen.findByText("ยังไม่อ่าน 1 รายการ")).closest(".toast") as HTMLElement;
    expect(toast).toHaveTextContent("ผู้ทดสอบ ส่งงานเข้า Review DE-2");
    expect(within(toast).getByText("ยังไม่อ่าน 1 รายการ")).toBeInTheDocument();
    expect(within(toast).getByRole("link", { name: "เปิดงาน" })).toHaveAttribute("href", "/w/sample/p/DE?issue=DE-2");
    await user.click(within(toast).getByRole("link", { name: "ดูภายหลัง" }));
    await waitFor(() => expect(screen.queryByText("ส่งงานเข้า Review DE-2")).not.toBeInTheDocument());
  });
});
