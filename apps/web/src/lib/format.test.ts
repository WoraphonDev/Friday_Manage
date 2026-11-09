import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateRange,
  formatManDay,
  formatOverdue,
  intlLocale,
  localeDateFormat,
  localeNumberFormat,
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
  it("หน้าภาษาอังกฤษ (html lang=en) แสดงวันที่และข้อความแบบอังกฤษ ตามรูปแบบปีของผู้ใช้", () => {
    document.documentElement.lang = "en";
    try {
      expect(formatDate("2026-12-01", "CE")).toBe("Dec 1, 26");
      expect(formatDate("2026-12-01", "CE", true)).toBe("Dec 1, 2026");
      expect(formatDate(null)).toBe("No date set");
      expect(formatOverdue("2026-12-01", "2026-12-02")).toBe("1 day overdue");
      expect(formatOverdue("2026-12-01", "2026-12-04")).toBe("3 days overdue");
      expect(formatOverdue("2026-12-04", "2026-12-04")).toBe("Today");
    } finally {
      document.documentElement.lang = "th";
    }
  });
  it("ตัวจัดรูปแบบที่ประกาศไว้ก่อนเลือกภาษาตอนเรียก format (สลับภาษาแล้วไม่ต้องโหลดโมดูลใหม่)", () => {
    const num = localeNumberFormat({ maximumFractionDigits: 1 });
    const month = localeDateFormat({ month: "long", timeZone: "UTC" });
    const withYear = localeDateFormat({ month: "short", year: "numeric", timeZone: "UTC" }, "BE");
    const date = new Date("2026-12-01T00:00:00Z");
    expect(month.format(date)).toBe("ธันวาคม");
    expect(withYear.format(date)).toBe("ธ.ค. 2569");
    document.documentElement.lang = "en";
    try {
      expect(num.format(1234.56)).toBe("1,234.6");
      expect(month.format(date)).toBe("December");
      expect(withYear.format(date)).toBe("Dec 2569 BE");
      expect(intlLocale("CE")).toBe("en-US-u-ca-gregory");
    } finally {
      document.documentElement.lang = "th";
    }
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
