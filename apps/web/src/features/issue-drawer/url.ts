/** query ที่ใส่เพื่อเปิด Drawer หรือฟอร์มสร้างงาน ต้องล้างเมื่อปิด ไม่งั้นฟอร์มครั้งถัดไปได้บริบทเก่า */
const DRAWER_PARAMS = ["issue", "new", "parent", "moduleId", "phaseId", "statusId"] as const;

export function withoutDrawerParams(search: URLSearchParams | string, pathname: string): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const key of DRAWER_PARAMS) next.delete(key);
  // Kanban ใช้ ?type=bug เลือกบอร์ด Bug เอง: ถ้าล้าง ปิด Drawer แล้วจะเด้งกลับบอร์ด Task
  if (!(pathname.endsWith("/board") && next.get("type") === "bug")) next.delete("type");
  return next;
}
