import { describe, expect, it } from "vitest";
import { withoutDrawerParams } from "./url";

describe("withoutDrawerParams", () => {
  it("ล้างบริบทของฟอร์มสร้างงานและคงตัวกรองของหน้า", () => {
    const next = withoutDrawerParams("new=1&type=task&moduleId=m1&phaseId=p1&statusId=s1&parent=DE-1&q=login", "/work/sample/p/DE/table");
    expect(next.toString()).toBe("q=login");
  });

  it("คงบอร์ด Bug ของ Kanban เมื่อปิด Drawer", () => {
    expect(withoutDrawerParams("type=bug&issue=DE-9", "/work/sample/p/DE/board").toString()).toBe("type=bug");
    expect(withoutDrawerParams("type=bug&new=1&statusId=s1", "/work/sample/p/DE/board").toString()).toBe("type=bug");
  });

  it("ล้าง type ที่ใส่เพื่อสร้างงานบนบอร์ด Task และหน้าอื่น", () => {
    expect(withoutDrawerParams("type=task&new=1", "/work/sample/p/DE/board").toString()).toBe("");
    expect(withoutDrawerParams("type=bug&new=1", "/work/sample/p/DE/table").toString()).toBe("");
  });
});
