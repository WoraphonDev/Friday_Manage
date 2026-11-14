import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { ActionSheet, Button, type ActionSheetAction } from "./index";

function Harness({ actions }: { actions: ActionSheetAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>เมนูงาน</Button>
      <ActionSheet open={open} onOpenChange={setOpen} title="จัดการงาน" actions={actions} />
    </>
  );
}

describe("ActionSheet (W27)", () => {
  it("แสดงคำสั่งเป็นปุ่ม เลือกแล้วเรียกคำสั่งเดียว ปิดแผ่น และคืน focus ให้ปุ่มที่เปิด", async () => {
    const user = userEvent.setup();
    const edit = vi.fn();
    const remove = vi.fn();
    renderWithProviders(
      <Harness
        actions={[
          { key: "edit", label: "แก้ไขงาน", onSelect: edit },
          { key: "archive", label: "เก็บถาวร", onSelect: vi.fn(), disabled: true },
          { key: "delete", label: "ลบงาน", destructive: true, hint: "ย้อนได้ 30 วัน", onSelect: remove },
        ]}
      />,
    );
    const opener = screen.getByRole("button", { name: "เมนูงาน" });
    await user.click(opener);
    const sheet = screen.getByRole("dialog", { name: "จัดการงาน" });
    expect(screen.getByRole("group", { name: "จัดการงาน" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "เก็บถาวร" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /ลบงาน/ })).toHaveAttribute("data-destructive");
    expect(sheet).toHaveTextContent("ย้อนได้ 30 วัน");

    await user.click(screen.getByRole("button", { name: /ลบงาน/ }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("ปุ่มยกเลิกปิดแผ่นโดยไม่เรียกคำสั่ง", async () => {
    const user = userEvent.setup();
    const edit = vi.fn();
    renderWithProviders(<Harness actions={[{ key: "edit", label: "แก้ไขงาน", onSelect: edit }]} />);
    await user.click(screen.getByRole("button", { name: "เมนูงาน" }));
    await user.click(screen.getByRole("button", { name: "ยกเลิก" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(edit).not.toHaveBeenCalled();
  });
});
