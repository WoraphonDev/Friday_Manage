// วันที่ที่ server render ต้องเป็นภาษาของคำขอ ให้ตรงกับ <html lang> และไม่เกิด hydration mismatch (W21)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { formatDate, formatOverdue, localeNumberFormat } from "./format";

function Dates() {
  return (
    <p>
      {formatDate("2026-12-01", "CE", true)} | {formatOverdue("2026-12-01", "2026-12-04")} | {localeNumberFormat({ maximumFractionDigits: 1 }).format(1234.56)}
    </p>
  );
}

const render = (locale: "th" | "en") =>
  renderToString(
    <NextIntlClientProvider locale={locale} messages={{}} timeZone="Asia/Bangkok">
      <Dates />
    </NextIntlClientProvider>,
  ).replace(/<!-- -->/g, "");

describe("วันที่ที่ server render", () => {
  // จำลองฝั่ง server: ไม่มี document (setup ของ test ทั้งชุดต้องใช้ jsdom)
  beforeEach(() => vi.stubGlobal("document", undefined));
  afterEach(() => vi.unstubAllGlobals());

  it("ใช้ภาษาของคำขอ", () => {
    expect(render("en")).toContain("Dec 1, 2026 | 3 days overdue | 1,234.6");
    expect(render("th")).toContain("1 ธ.ค. 2026 | เลยกำหนด 3 วัน | 1,234.6");
  });

  it("เรียกนอกการ render บน server ใช้ไทย", () => {
    expect(formatDate("2026-12-01", "BE", true)).toBe("1 ธ.ค. 2569");
  });
});
