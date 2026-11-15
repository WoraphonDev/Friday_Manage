import { afterEach, describe, expect, it } from "vitest";
import { motionMs } from "./motion";

describe("motionMs", () => {
  afterEach(() => document.documentElement.style.removeProperty("--motion-test"));

  // ตัวย่อ CSS ตอน build เขียน 550ms เป็น .55s · เคยอ่านได้ 0.55 จน Drawer ปิดก่อน animation เล่นจบ
  it.each([
    ["550ms", 550],
    [".55s", 550],
    ["1.5s", 1500],
    ["", 0],
  ])("%s → %d ms", (value, expected) => {
    if (value) document.documentElement.style.setProperty("--motion-test", value);
    expect(motionMs("--motion-test")).toBe(expected);
  });
});
