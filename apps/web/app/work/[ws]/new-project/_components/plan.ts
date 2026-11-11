/** คำนวณของ Wizard ที่ไม่ต้องเรียก API (ทดสอบแยกได้) */

/** Template ในตัว (ตรงกับ BUILTIN_TEMPLATES ของ API) · Development = ชุดฟิลด์ของแผน Development Plan (ผู้ใช้ตัดสิน 2026-11-09) */
export type BuiltinTemplate = "development" | "development_qa" | "scrum" | "kanban" | "waterfall" | "blank";
export const BUILTIN_TEMPLATES: BuiltinTemplate[] = ["development", "development_qa", "scrum", "kanban", "waterfall", "blank"];
export interface WorkflowStep {
  name: string;
  wipLimit?: number;
  /** หมวดของสถานะ · ไม่ระบุ = API เดาจากตำแหน่ง (แรก = To do, สุดท้าย = Done) */
  category?: "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled";
}
/** Template ในตัว: กำหนดค่าที่ส่งใน POST w/projects (ค่าใน body ชนะ Template ของ Workspace เสมอ) */
export const TEMPLATE_PRESETS: Record<BuiltinTemplate, { workflow: WorkflowStep[]; sprint: boolean; modules?: string[]; progressMethod?: "count" | "weighted" }> = {
  development: { workflow: [{ name: "To do" }, { name: "In progress" }, { name: "Review" }, { name: "Done" }], sprint: true, progressMethod: "weighted" },
  // Development + QA (ผู้ใช้ขอ 2026-11-11): แยกช่วง Dev / QA · ชื่อชุดนี้ใช้เฉพาะ Template นี้
  development_qa: {
    workflow: [
      { name: "To do", category: "todo" },
      { name: "In progress", category: "in_progress" },
      { name: "Rework", category: "in_progress" },
      { name: "Ready for QA", category: "review" },
      { name: "Testing", category: "review" },
      { name: "Done", category: "done" },
      { name: "Rejected", category: "cancelled" },
    ],
    sprint: true,
    progressMethod: "weighted",
  },
  scrum: { workflow: [{ name: "To do" }, { name: "In progress" }, { name: "Review" }, { name: "Done" }], sprint: true },
  kanban: { workflow: [{ name: "To do" }, { name: "In progress", wipLimit: 5 }, { name: "Review", wipLimit: 3 }, { name: "Done" }], sprint: false },
  // Waterfall: เฟสเป็น Module เรียงตามลำดับ เพราะ API ยังไม่มีเฟสระดับโปรเจกต์
  waterfall: { workflow: [{ name: "To do" }, { name: "In progress" }, { name: "Review" }, { name: "Done" }], sprint: false, modules: ["Requirement", "Design", "Development", "Testing", "Deploy"] },
  blank: { workflow: [{ name: "To do" }, { name: "Done" }], sprint: false },
};

/** ตำแหน่งที่แทรกสถานะใหม่: ก่อนสถานะปิดงานตัวแรก (Done / Rejected) · ไม่มีหมวด = ก่อนตัวสุดท้าย */
export function insertAt(steps: WorkflowStep[]) {
  const i = steps.findIndex((s) => s.category === "done" || s.category === "cancelled");
  return i >= 0 ? i : Math.max(0, steps.length - 1);
}

/** สถานะใน body ของ POST w/projects: ชื่ออย่างเดียว หรือ object เมื่อมี WIP / หมวด */
export function workflowBody(steps: WorkflowStep[]) {
  return steps.map((s) => (s.wipLimit || s.category ? { name: s.name, ...(s.category ? { category: s.category } : {}), ...(s.wipLimit ? { wipLimit: s.wipLimit } : {}) } : s.name));
}

export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
/** Key จากชื่อ: อักษรแรกของคำภาษาอังกฤษ (Development Plan → DP) · ชื่อภาษาไทยล้วนให้ผู้ใช้ตั้งเอง */
export function suggestKey(name: string) {
  const words = name.toUpperCase().match(/[A-Z][A-Z0-9]*/g) ?? [];
  const key = words.length >= 2 ? words.slice(0, 4).map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  return key.length >= 2 ? key : "";
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (value: string, n: number) => {
  const d = day(value);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
export const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(day(v).getTime());

/** ระยะเวลา (นับรวมวันแรกและวันสุดท้าย) และวันทำการ จ.–ศ. · ไม่หักวันหยุดเพราะปฏิทินอยู่ฝั่ง API */
export function spanDays(start: string, end: string) {
  if (!validDate(start) || !validDate(end) || end < start) return null;
  let working = 0;
  let calendar = 0;
  for (let d = start; d <= end && calendar < 3660; d = addDays(d, 1)) {
    calendar++;
    const w = day(d).getUTCDay();
    if (w !== 0 && w !== 6) working++;
  }
  return { calendar, working };
}

/** จำนวน Sprint แบบเดียวกับ sprintPlan ของ API: เริ่มวันจันทร์แรก ทุก n สัปดาห์จนถึง Go-live */
export function sprintCount(start: string, end: string, weeks: number | null) {
  if (!weeks || !validDate(start) || !validDate(end)) return 0;
  let d = start;
  while (day(d).getUTCDay() !== 1) d = addDays(d, 1);
  let n = 0;
  for (; d <= end && n < 200; n++) d = addDays(d, weeks * 7);
  return n;
}
export function firstMonday(start: string) {
  if (!validDate(start)) return null;
  let d = start;
  while (day(d).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

/** ข้อความหลายบรรทัด → รายการ (ตัดบรรทัดว่าง) */
export const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
