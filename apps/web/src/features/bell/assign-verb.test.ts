import { describe, expect, it } from "vitest";
import th from "../../../messages/th/inbox-bell.json";
import { assignVerb } from "./assign-verb";

// แปลแบบเดียวกับ next-intl พอให้ตรวจคีย์และค่า {role}
const t = ((key: string, values?: Record<string, string>) => {
  const raw = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], th.inbox) as string;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? "");
}) as never;

describe("assignVerb", () => {
  it("บอกบทบาทเมื่อถูกตั้งเป็น BA / SA / QA และบอกว่าถูกถอดออก", () => {
    expect(assignVerb(t, { eventType: "issue.assigned", payload: { role: "sa" } })).toBe("มอบหมายให้คุณเป็น SA ใน");
    expect(assignVerb(t, { eventType: "issue.assigned", payload: { role: "qa", removed: true } })).toBe("ถอดคุณออกจาก QA / Reviewer ใน");
    expect(assignVerb(t, { eventType: "issue.assigned", payload: { removed: true } })).toBe("ถอดคุณออกจากงาน");
  });

  it("Dev และเหตุการณ์อื่นใช้คำเดิม", () => {
    expect(assignVerb(t, { eventType: "issue.assigned", payload: {} })).toBeNull();
    expect(assignVerb(t, { eventType: "issue.mentioned", payload: { role: "sa" } })).toBeNull();
  });
});
