import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { matches, useStableRows } from "./shortcuts";

const ids = (r: { id: string }[]) => r.map((x) => x.id);

describe("แถวไม่กระโดดเมื่อรีเฟรช (ช่วง 2)", () => {
  it("แถวใหม่รอกดแสดง · แถวที่หายไปเอาออก · เปลี่ยนตัวกรองเริ่มใหม่", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const { result, rerender } = renderHook(({ items, k }) => useStableRows(items, k), { initialProps: { items: [a, b], k: "f1" } });
    expect(ids(result.current.rows)).toEqual(["a", "b"]);
    rerender({ items: [c, a, b], k: "f1" });
    expect(ids(result.current.rows)).toEqual(["a", "b"]);
    expect(result.current.fresh).toBe(1);
    act(() => result.current.reveal());
    expect(ids(result.current.rows)).toEqual(["c", "a", "b"]);
    rerender({ items: [c, a], k: "f1" });
    expect(ids(result.current.rows)).toEqual(["c", "a"]);
    rerender({ items: [b], k: "f2" });
    expect(ids(result.current.rows)).toEqual(["b"]);
    expect(result.current.fresh).toBe(0);
  });
});

describe("จับคู่ปุ่มลัด", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  it("mod = ⌘ หรือ Ctrl · ? ไม่ตรวจ Shift · ตัวอักษรต้องไม่มี mod", () => {
    expect(matches("mod+enter", key({ key: "Enter", metaKey: true }))).toBe(true);
    expect(matches("mod+enter", key({ key: "Enter", ctrlKey: true }))).toBe(true);
    expect(matches("shift+mod+enter", key({ key: "Enter", metaKey: true }))).toBe(false);
    expect(matches("?", key({ key: "?", shiftKey: true }))).toBe(true);
    expect(matches("j", key({ key: "j", metaKey: true }))).toBe(false);
    expect(matches("a", key({ key: "A", shiftKey: true }))).toBe(false);
  });
});
