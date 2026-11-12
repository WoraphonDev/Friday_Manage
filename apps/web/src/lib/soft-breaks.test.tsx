// คำอธิบาย / คอมเมนต์หลายบรรทัด: Enter ครั้งเดียวต้องขึ้นบรรทัดใหม่ตามที่พิมพ์ · ข้อมูลสมมติเท่านั้น
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BodyText } from "@/features/issue-drawer/shared";

describe("BodyText ขึ้นบรรทัดใหม่ตามที่พิมพ์", () => {
  it("บรรทัดที่ติดกันแยกด้วย <br> ไม่รวมเป็นบรรทัดเดียว", () => {
    const { container } = render(<BodyText>{"บรรทัดแรก\nบรรทัดสอง\r\nบรรทัดสาม"}</BodyText>);
    const paragraph = container.querySelector("p")!;
    expect(paragraph.querySelectorAll("br")).toHaveLength(2);
    expect(paragraph.innerHTML).toContain("บรรทัดแรก<br>");
    expect(paragraph.textContent).toBe("บรรทัดแรก\nบรรทัดสอง\nบรรทัดสาม");
  });

  it("ย่อหน้า, รายการ, โค้ดบล็อก และ mention ยังแสดงเหมือนเดิม", () => {
    const { container } = render(<BodyText>{"ย่อหน้าหนึ่ง\n\n- ข้อแรก\n- ข้อสอง\n\n```\nconst a = 1;\nconst b = 2;\n```\n\nแจ้ง @[ผู้ทดสอบ](00000000-0000-0000-0000-000000000001)\nบรรทัดถัดไป"}</BodyText>);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    const code = container.querySelector("pre code")!;
    expect(code.querySelector("br")).toBeNull();
    expect(code.textContent).toBe("const a = 1;\nconst b = 2;\n");
    const last = Array.from(container.querySelectorAll("p")).at(-1)!;
    expect(last.querySelector("br")).not.toBeNull();
  });
});
