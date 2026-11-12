// ตำแหน่งในโปรเจกต์ (project_members.position) · บันทึกเป็นตัวย่อ แสดงในรายการเลือกเป็น "ตัวย่อ - ชื่อเต็ม"
// ชุดนี้รวมจากสเปก (PM · UX/UI · Frontend · Backend · QA · BA) และช่อง SA / Developer ใน docs/decisions.md
export const POSITIONS = [
  { code: "PM", name: "Project Manager" },
  { code: "BA", name: "Business Analyst" },
  { code: "SA", name: "System Analyst" },
  { code: "UX", name: "UX/UI Designer" },
  { code: "FE", name: "Frontend Developer" },
  { code: "BE", name: "Backend Developer" },
  { code: "DEV", name: "Developer" },
  { code: "QA", name: "QA Engineer" },
  // CI/CD และ infra (ผู้ใช้ขอ 2026-11-13)
  { code: "DEVOPS", name: "DevOps Engineer" },
] as const;

// ค่าที่เคยพิมพ์เองหรือมาจากหน้าสร้างโปรเจกต์รุ่นก่อน → ตัวย่อ
const ALIASES: Record<string, string> = {
  "ux/ui": "UX",
  frontend: "FE",
  "frontend dev": "FE",
  backend: "BE",
  "backend dev": "BE",
  "dev ops": "DEVOPS",
};

export const positionLabel = (code: string) => {
  const p = POSITIONS.find((x) => x.code === code);
  return p ? `${p.code} - ${p.name}` : code;
};

/** ตัวย่อของค่าที่รู้จัก (ตัวย่อ, ชื่อเต็ม หรือชื่อเดิม) · ค่าที่ไม่รู้จักคืนตามเดิมเพื่อไม่ให้ข้อมูลหาย */
export function toPositionCode(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  const k = v.toLowerCase();
  if (!k) return "";
  const p = POSITIONS.find((x) => x.code.toLowerCase() === k || x.name.toLowerCase() === k);
  return p?.code ?? ALIASES[k] ?? v;
}

/** ตัวเลือกทั้งหมด · ค่าปัจจุบันที่ไม่อยู่ในชุดแสดงไว้ก่อนเพื่อให้เลือกค้างไว้ได้ */
export function positionOptions(current: string): { value: string; label: string }[] {
  const known = POSITIONS.map((p) => ({ value: p.code, label: positionLabel(p.code) }));
  return current && !known.some((o) => o.value === current) ? [{ value: current, label: current }, ...known] : known;
}

/** ตำแหน่งที่ทำงานในช่องคนของงานได้ · Dev รวม Frontend / Backend / DevOps (คนลงมือทำงาน CI/CD, infra) */
export type PickRole = "ba" | "sa" | "dev" | "qa";
export const ROLE_POSITIONS: Record<PickRole, string[]> = { ba: ["BA"], sa: ["SA"], dev: ["DEV", "FE", "BE", "DEVOPS"], qa: ["QA"] };

/** ตัวย่อทั้งหมดของสมาชิก (positions ใหม่ หรือ position เดิมข้อความเดียว) */
export function positionCodes(p: { positions?: string[] | null; position?: string | null }): string[] {
  const raw = p.positions?.length ? p.positions : (p.position ?? "").split(",");
  return [...new Set(raw.map(toPositionCode).filter(Boolean))];
}

/**
 * รายชื่อในช่องเลือกคนของงานกรองตามตำแหน่ง (ผู้ใช้ขอ 2026-11-13) · คนที่เลือกไว้แล้วยังอยู่ในรายการเสมอ
 * ยังไม่มีสมาชิกคนไหนตั้งตำแหน่งนี้ = แสดงทุกคน (โปรเจกต์ที่ยังไม่ได้ตั้งตำแหน่งใช้ได้เหมือนเดิม)
 */
export function peopleForRole<T extends { id: string; positions?: string[] | null; position?: string | null }>(role: PickRole, people: T[], selected: readonly (string | null | undefined)[] = []): T[] {
  const codes = ROLE_POSITIONS[role];
  const match = people.filter((p) => positionCodes(p).some((c) => codes.includes(c)));
  if (!match.length) return people;
  return people.filter((p) => match.includes(p) || selected.includes(p.id));
}
