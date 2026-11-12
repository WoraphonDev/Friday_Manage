// ช่องเลือกคนของงานกรองตามตำแหน่ง (ผู้ใช้ขอ 2026-11-13) · ข้อมูลสมมติ
import { describe, expect, it } from "vitest";
import { peopleForRole, positionCodes } from "./positions";

const people = [
  { id: "a", displayName: "เอ", positions: ["SA", "DEV"] },
  { id: "b", displayName: "บี", positions: ["BA", "QA"] },
  { id: "c", displayName: "ซี", positions: ["DevOps"] },
  { id: "d", displayName: "ดี", position: "Business Analyst" },
  { id: "e", displayName: "อี" },
];

describe("peopleForRole", () => {
  it("กรองตามตำแหน่ง · คนหนึ่งอยู่ได้หลายช่อง · Dev รวม DevOps", () => {
    expect(peopleForRole("sa", people).map((p) => p.id)).toEqual(["a"]);
    expect(peopleForRole("qa", people).map((p) => p.id)).toEqual(["b"]);
    expect(peopleForRole("dev", people).map((p) => p.id)).toEqual(["a", "c"]);
    // ตำแหน่งเดิมแบบข้อความเดียวยังใช้ได้
    expect(peopleForRole("ba", people).map((p) => p.id)).toEqual(["b", "d"]);
  });

  it("คนที่เลือกไว้แล้วยังอยู่ · ยังไม่มีใครมีตำแหน่งนั้น = ทุกคน", () => {
    expect(peopleForRole("qa", people, ["e"]).map((p) => p.id)).toEqual(["b", "e"]);
    const none = people.map(({ id, displayName }) => ({ id, displayName }));
    expect(peopleForRole("qa", none)).toHaveLength(5);
  });

  it("positionCodes ใช้ positions ก่อน แล้วค่อย position เดิม", () => {
    expect(positionCodes({ positions: ["devops", "QA Engineer"] })).toEqual(["DEVOPS", "QA"]);
    expect(positionCodes({ position: "SA, Developer" })).toEqual(["SA", "DEV"]);
  });
});
