/**
 * ชุดฟิลด์ของโปรเจกต์ (ผู้ใช้ตัดสิน 2026-11-09) · ตรงกับ apps/api/src/projects/field-profile.ts
 * Template กำหนดว่า Task / Sub-task แสดง / บังคับฟิลด์ไหน และ Table แสดงคอลัมน์อะไรตามลำดับไหน
 * ฟิลด์แกนกลาง (ชื่องาน, สถานะ, Developer, Plan Start / End, Man-Day, Module / กลุ่ม) ไม่อยู่ในชุดนี้ เพราะซ่อนไม่ได้
 */

export type FieldMode = "hidden" | "optional" | "required";
export type Level = "task" | "subtask";
export type ProfileField = "ba" | "sa" | "reviewer" | "priority" | "size" | "actual" | "progress" | "requirements" | "screens" | "labels" | "remark";
export const PROFILE_FIELDS: ProfileField[] = ["ba", "sa", "reviewer", "priority", "size", "actual", "progress", "requirements", "screens", "labels", "remark"];
/** ฟิลด์ที่ตั้งเป็นฟิลด์บังคับได้ (Priority มีค่าเริ่มต้นเสมอ · Actual / Progress ระบบตั้งให้) */
export const REQUIRABLE = new Set<ProfileField>(["ba", "sa", "reviewer", "size", "requirements", "screens", "labels", "remark"]);

export type FieldRule = { task: FieldMode; subtask: FieldMode };
export interface FieldProfile {
  fields: Record<ProfileField, FieldRule>;
  columns: string[];
  template?: { id: string; name: string; builtin: boolean } | null;
}
export type CustomFieldType = "text" | "number" | "select" | "multi_select" | "user" | "date";
export interface Choice { id: string; label: string; color?: string | null }
export interface CustomFieldDef {
  id: string; name: string; fieldType: CustomFieldType; options: { choices: Choice[] } | null;
  taskMode: FieldMode; subtaskMode: FieldMode; sort?: number;
}

/** คอลัมน์ Table มาตรฐาน → ฟิลด์ที่คุม (null = คอลัมน์แกนกลาง) */
export const STANDARD_COLUMNS: Record<string, ProfileField[] | null> = {
  dev: null, ba: ["ba"], sa: ["sa"], reviewer: ["reviewer"], status: null, priority: ["priority"], size: ["size"],
  start: null, end: null, actualStart: ["actual"], actualEnd: ["actual"], refs: ["requirements", "screens"],
  labels: ["labels"], progress: ["progress"], remark: ["remark"],
};
export const DEFAULT_COLUMNS = ["dev", "ba", "sa", "status", "size", "start", "end", "actualStart", "actualEnd", "progress", "remark"];

const OPTIONAL: FieldRule = { task: "optional", subtask: "optional" };
/** ค่าเริ่มต้นเมื่อยังไม่ได้โหลดชุดฟิลด์ (เหมือนโปรเจกต์ก่อนมีฟีเจอร์) */
export const DEFAULT_PROFILE: FieldProfile = {
  fields: Object.fromEntries(PROFILE_FIELDS.map((f) => [f, OPTIONAL])) as Record<ProfileField, FieldRule>,
  columns: DEFAULT_COLUMNS,
  template: null,
};

export const levelOf = (issue: { parentKey?: string | null }): Level => (issue.parentKey ? "subtask" : "task");
export const modeOf = (profile: FieldProfile | undefined, field: ProfileField, level: Level): FieldMode => profile?.fields[field]?.[level] ?? "optional";
export const shows = (profile: FieldProfile | undefined, field: ProfileField, level: Level) => modeOf(profile, field, level) !== "hidden";
export const requires = (profile: FieldProfile | undefined, field: ProfileField, level: Level) => modeOf(profile, field, level) === "required";
export const customModeOf = (f: CustomFieldDef, level: Level): FieldMode => (level === "task" ? f.taskMode : f.subtaskMode);
const hiddenEverywhere = (r: FieldRule) => r.task === "hidden" && r.subtask === "hidden";

/** คอลัมน์ที่ใช้ได้ (ฟิลด์ไม่ได้ซ่อนทั้งสองระดับ) · เรียงตามคอลัมน์ของโปรเจกต์ก่อน แล้วตามด้วยที่เหลือ */
export function availableColumns(profile: FieldProfile, customFields: CustomFieldDef[]) {
  const standard = Object.keys(STANDARD_COLUMNS).filter((c) => {
    const deps = STANDARD_COLUMNS[c];
    return !deps || deps.some((d) => !hiddenEverywhere(profile.fields[d] ?? OPTIONAL));
  });
  const custom = customFields.filter((f) => !hiddenEverywhere({ task: f.taskMode, subtask: f.subtaskMode })).map((f) => `cf:${f.id}`);
  const all = [...standard, ...custom];
  return [...profile.columns.filter((c) => all.includes(c)), ...all.filter((c) => !profile.columns.includes(c))];
}

/** คอลัมน์นี้มีค่าในแถวระดับนี้ไหม (เช่น Size ซ่อนเฉพาะ Sub-task) */
export function columnShowsAt(column: string, level: Level, profile: FieldProfile, customFields: CustomFieldDef[]) {
  if (column.startsWith("cf:")) {
    const f = customFields.find((x) => `cf:${x.id}` === column);
    return !!f && customModeOf(f, level) !== "hidden";
  }
  const deps = STANDARD_COLUMNS[column];
  return !deps || deps.some((d) => modeOf(profile, d, level) !== "hidden");
}

/** ค่า Custom field เป็นข้อความสำหรับแสดง (ตัวเลือก → ชื่อ, คน → ชื่อ) */
export function customText(f: CustomFieldDef, value: unknown, people: { id: string; displayName: string }[] = [], formatDate?: (iso: string) => string): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  const label = (id: unknown) => f.options?.choices.find((c) => c.id === id)?.label ?? String(id);
  switch (f.fieldType) {
    case "select": return label(value);
    case "multi_select": return Array.isArray(value) ? value.map(label).join(", ") : label(value);
    case "user": return people.find((p) => p.id === value)?.displayName ?? "";
    case "date": return formatDate ? formatDate(String(value)) : String(value);
    case "number": return typeof value === "number" ? value.toLocaleString("th-TH") : String(value);
    default: return String(value);
  }
}

/** ชื่อฟิลด์ที่ API ส่งมาใน details.fields ของ missing_required_fields / field_hidden */
export const API_FIELD_LABELS: Record<string, string> = {
  ba: "Business Analyst", sa: "System Analyst", reviewer: "QA / Reviewer", priority: "Priority", size: "Size",
  actual: "Actual Start / End", progress: "Progress", requirements: "Requirement", screens: "Screen", labels: "Label", remark: "Remark",
};
