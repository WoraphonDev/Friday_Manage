import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSlidingIndicator } from "@/lib/motion";
import { MotionSwap, PageEnter } from "./page-enter";

describe("MotionSwap", () => {
  afterEach(() => vi.useRealTimers());

  // ขึ้นพร้อมหน้า: หน้าจางเข้าให้แล้ว ถ้าเลื่อนอีกชั้นเนื้อหาจะลอยขึ้นสองเท่า
  it("ไม่เคลื่อนซ้อนเมื่อขึ้นพร้อมหน้า แต่เคลื่อนเมื่อสลับทีหลัง", () => {
    vi.useFakeTimers();
    function Example() {
      const [section, setSection] = useState("a");
      return (
        <PageEnter>
          <button type="button" onClick={() => setSection("b")}>สลับ</button>
          <MotionSwap key={section}>
            <p>{section}</p>
          </MotionSwap>
        </PageEnter>
      );
    }
    render(<Example />);
    const first = screen.getByText("a").parentElement!;
    expect(first.className).toBe("motion-swap-static");
    expect(first).toHaveAttribute("data-entering");

    act(() => vi.advanceTimersByTime(2000));
    expect(first).not.toHaveAttribute("data-entering");
    act(() => screen.getByRole("button").click());
    const next = screen.getByText("b").parentElement!;
    expect(next.className).toBe("motion-swap");
    expect(next).toHaveAttribute("data-entering");
  });

  it("MotionSwap ซ้อนที่ขึ้นพร้อมกรอบนอกไม่เลื่อนซ้ำ", () => {
    render(
      <MotionSwap>
        <MotionSwap>
          <p>inner</p>
        </MotionSwap>
      </MotionSwap>,
    );
    const inner = screen.getByText("inner").parentElement!;
    expect(inner.className).toBe("motion-swap-static");
    expect(inner.parentElement!.className).toBe("motion-swap");
  });

  it("ส่ง className ต่อให้กรอบ", () => {
    render(<MotionSwap className="main"><p>x</p></MotionSwap>);
    expect(screen.getByText("x").parentElement!.className).toBe("motion-swap main");
  });
});

describe("useSlidingIndicator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ปุ่มสลับมุมมอง (aria-pressed) ใช้แถบเลื่อนแบบเดียวกับเมนู · jsdom ไม่วาง layout จึงจำลองว่ารายการมองเห็น
  it.each([
    ["aria-pressed", "true", "false"],
    ["aria-selected", "true", "false"],
  ])("หารายการที่เลือกจาก %s", (attr, on, off) => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(document.body);
    function Group() {
      const ref = useSlidingIndicator<HTMLDivElement>("button");
      return (
        <div ref={ref} data-testid="group">
          <button type="button" {...{ [attr]: off }}>List</button>
          <button type="button" {...{ [attr]: on }}>Grid</button>
        </div>
      );
    }
    render(<Group />);
    expect(screen.getByTestId("group")).toHaveAttribute("data-indicator", "jump");
  });

  it("ไม่ใส่ indicator เมื่อรายการที่เลือกมองไม่เห็น", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    function Group() {
      const ref = useSlidingIndicator<HTMLDivElement>("button");
      return (
        <div ref={ref} data-testid="group">
          <button type="button" aria-pressed="true">List</button>
        </div>
      );
    }
    render(<Group />);
    expect(screen.getByTestId("group")).not.toHaveAttribute("data-indicator");
  });
});
