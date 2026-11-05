import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateRange,
  formatManDay,
  formatOverdue,
  today,
} from "./format";
import { safeReturnTo } from "./utils";

describe("วันที่และหน่วยงาน", () => {
  it("วันที่แบบ BE / CE แสดงปีตามค่าของผู้ใช้", () => {
    expect(formatDate("2026-12-01", "BE")).toBe("1 ธ.ค. 69");
    expect(formatDate("2026-12-01", "CE")).toBe("1 ธ.ค. 26");
    expect(formatDate("2026-12-01", "BE", true)).toBe("1 ธ.ค. 2569");
    expect(formatDate("invalid")).toBe("ยังไม่กำหนดวันที่");
    expect(formatDateRange("2026-12-01", "2026-12-02")).toBe(
      "1 ธ.ค. 69 – 2 ธ.ค. 69",
    );
  });
  it("ใช้วันของกรุงเทพฯ แม้ UTC ยังเป็นวันก่อนหน้า", () => {
    expect(today(new Date("2026-11-05T18:00:00Z"))).toBe("2026-11-06");
    expect(formatOverdue("2026-12-01", "2026-12-04")).toBe("เลยกำหนด 3 วัน");
    expect(formatManDay(0.25)).toBe("0.25 MD");
  });
  it("returnTo รับเฉพาะ path ภายใน", () => {
    expect(safeReturnTo("/w/sample?issue=DE-1")).toBe("/w/sample?issue=DE-1");
    for (const value of [
      "https://example.com",
      "//example.com",
      "/\\example.com",
      "/\nexample.com",
    ])
      expect(safeReturnTo(value)).toBe("/");
  });
});
