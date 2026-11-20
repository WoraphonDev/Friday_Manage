// นับวันตามปฏิทินไทย · ข้อมูลสมมติเท่านั้น
import { describe, expect, it } from "vitest";
import { bangkokToday, calendarDaysUntil } from "./format";

describe("วันตามเวลาไทย", () => {
  it("วันนี้เปลี่ยนตอนเที่ยงคืนไทย (17:00 UTC)", () => {
    expect(bangkokToday(Date.parse("2026-11-19T16:59:00Z"))).toBe("2026-11-19");
    expect(bangkokToday(Date.parse("2026-11-19T17:00:00Z"))).toBe("2026-11-20");
  });

  it("เหลือกี่วันนับตามปฏิทิน ไม่ปัดตามชั่วโมง · เช้าและค่ำของวันเดียวกันได้เท่ากัน", () => {
    // 10:40 น. ไทย (เวลาที่ CI เคยล้ม) และ 23:30 น. ไทย
    for (const now of ["2026-11-20T03:40:00Z", "2026-11-20T16:30:00Z"]) {
      expect(calendarDaysUntil("2026-11-22", Date.parse(now))).toBe(2);
      expect(calendarDaysUntil("2026-11-20", Date.parse(now))).toBe(0);
      expect(calendarDaysUntil("2026-11-19", Date.parse(now))).toBe(-1);
    }
  });
});
