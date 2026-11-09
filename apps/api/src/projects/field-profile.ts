import { z } from 'zod';
import { AppError } from '../common/errors.js';

/**
 * ชุดฟิลด์ของโปรเจกต์ (ผู้ใช้ตัดสิน 2026-11-09): แต่ละ Template กำหนดว่า Task / Sub-task แสดง / บังคับฟิลด์ไหน
 * และ Table แสดงคอลัมน์อะไรตามลำดับไหน · ข้อมูลอยู่ในตาราง issues ชุดเดียว Template แค่เปิด / ปิดการแสดง
 * ฟิลด์แกนกลาง (ชื่องาน, สถานะ, Developer, Plan Start / End, Man-Day, Module / กลุ่ม) ปิดไม่ได้ เพราะ Gantt / Workload / Overview ใช้คำนวณ
 */

export const FIELD_MODES = ['hidden', 'optional', 'required'] as const;
export type FieldMode = (typeof FIELD_MODES)[number];
export type FieldRule = { task: FieldMode; subtask: FieldMode };

/** ฟิลด์มาตรฐานที่ Template เปิด / ปิดได้ · requirable = ตั้งเป็นฟิลด์บังคับได้ */
export const PROFILE_FIELDS = {
  ba: { requirable: true },
  sa: { requirable: true },
  reviewer: { requirable: true },
  priority: { requirable: false },
  size: { requirable: true },
  actual: { requirable: false },
  progress: { requirable: false },
  requirements: { requirable: true },
  screens: { requirable: true },
  labels: { requirable: true },
  remark: { requirable: true },
} as const;
export type ProfileField = keyof typeof PROFILE_FIELDS;
export const PROFILE_FIELD_KEYS = Object.keys(PROFILE_FIELDS) as ProfileField[];

/** คอลัมน์ Table ที่ไม่ใช่ Custom field · null = คอลัมน์แกนกลาง (ซ่อนไม่ได้ด้วยชุดฟิลด์) */
export const STANDARD_COLUMNS = {
  dev: null,
  ba: ['ba'],
  sa: ['sa'],
  reviewer: ['reviewer'],
  status: null,
  priority: ['priority'],
  size: ['size'],
  start: null,
  end: null,
  actualStart: ['actual'],
  actualEnd: ['actual'],
  refs: ['requirements', 'screens'],
  labels: ['labels'],
  progress: ['progress'],
  remark: ['remark'],
} as const satisfies Record<string, readonly ProfileField[] | null>;
export type StandardColumn = keyof typeof STANDARD_COLUMNS;
const STANDARD_COLUMN_KEYS = Object.keys(STANDARD_COLUMNS) as StandardColumn[];

/** คอลัมน์ Table เริ่มต้น = ชุดของ Development Plan (Task v2) · FR / Screen เปิดเองได้จากเมนู Columns */
export const DEFAULT_COLUMNS: string[] = ['dev', 'ba', 'sa', 'status', 'size', 'start', 'end', 'actualStart', 'actualEnd', 'progress', 'remark'];

const mode = z.enum(FIELD_MODES);
const rule = z.object({ task: mode.optional(), subtask: mode.optional() }).strict();
const columnId = z.string().trim().min(1).max(80);

/** ชุดฟิลด์ใน Template และในคำขอแก้ · คีย์ที่ไม่ส่ง = ค่าเริ่มต้น (optional) */
export const FieldsSpec = z.partialRecord(z.enum(PROFILE_FIELD_KEYS as [ProfileField, ...ProfileField[]]), rule);
export const ColumnsSpec = z.array(columnId).max(60);
export const FieldProfileBody = z.object({ fields: FieldsSpec.optional(), columns: ColumnsSpec.optional() }).strict()
  .refine((v) => v.fields !== undefined || v.columns !== undefined, 'ต้องระบุค่าที่จะแก้');

export type StoredProfile = { fields?: Partial<Record<ProfileField, Partial<FieldRule>>>; columns?: string[] };
export type ResolvedProfile = { fields: Record<ProfileField, FieldRule>; columns: string[] };
export type ProfileCustomField = { id: string; taskMode: FieldMode; subtaskMode: FieldMode };

const DEFAULT_RULE: FieldRule = { task: 'optional', subtask: 'optional' };

/** ฟิลด์ที่ซ่อนทั้งสองระดับ = ไม่มีที่ให้แสดง จึงไม่ต้องมีคอลัมน์ */
const hiddenEverywhere = (r: FieldRule) => r.task === 'hidden' && r.subtask === 'hidden';

/** ค่าที่เก็บ (อาจไม่ครบ / มีคีย์เก่า) → ค่าครบทุกฟิลด์ · ตัดคอลัมน์ที่ไม่รู้จักหรือฟิลด์ถูกซ่อนทิ้ง */
export function resolveProfile(stored: unknown, customFields: ProfileCustomField[] = []): ResolvedProfile {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as StoredProfile;
  const fields = {} as Record<ProfileField, FieldRule>;
  for (const key of PROFILE_FIELD_KEYS) {
    const given = raw.fields?.[key] ?? {};
    const pick = (m: unknown): FieldMode | undefined => (FIELD_MODES as readonly unknown[]).includes(m) ? (m as FieldMode) : undefined;
    let task = pick(given.task) ?? DEFAULT_RULE.task;
    let subtask = pick(given.subtask) ?? DEFAULT_RULE.subtask;
    // ข้อมูลเก่าที่ตั้ง required ให้ฟิลด์ที่บังคับไม่ได้ ถือเป็น optional
    if (!PROFILE_FIELDS[key].requirable) {
      if (task === 'required') task = 'optional';
      if (subtask === 'required') subtask = 'optional';
    }
    fields[key] = { task, subtask };
  }
  const columns = Array.isArray(raw.columns) ? raw.columns.filter((c): c is string => typeof c === 'string') : DEFAULT_COLUMNS;
  return { fields, columns: normalizeColumns(columns, fields, customFields) };
}

/** คอลัมน์ที่ใช้ได้จริง ไม่ซ้ำ · Custom field ต้องมีอยู่ในโปรเจกต์และไม่ถูกซ่อนทั้งสองระดับ */
export function normalizeColumns(columns: string[], fields: Record<ProfileField, FieldRule>, customFields: ProfileCustomField[]) {
  const seen = new Set<string>();
  return columns.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    if (c.startsWith('cf:')) {
      const f = customFields.find((x) => `cf:${x.id}` === c);
      return !!f && !hiddenEverywhere({ task: f.taskMode, subtask: f.subtaskMode });
    }
    if (!(STANDARD_COLUMN_KEYS as string[]).includes(c)) return false;
    const deps = STANDARD_COLUMNS[c as StandardColumn];
    return !deps || deps.some((d) => !hiddenEverywhere(fields[d]));
  });
}

/** รวมค่าที่แก้เข้ากับค่าเดิม แล้วตรวจ: ฟิลด์ที่บังคับไม่ได้ส่ง required มา = 400 */
export function mergeProfile(current: ResolvedProfile, input: { fields?: z.infer<typeof FieldsSpec>; columns?: string[] }, customFields: ProfileCustomField[]): ResolvedProfile {
  const fields = { ...current.fields };
  for (const [key, value] of Object.entries(input.fields ?? {}) as [ProfileField, Partial<FieldRule>][]) {
    const next = { ...fields[key], ...value };
    if (!PROFILE_FIELDS[key].requirable && (next.task === 'required' || next.subtask === 'required')) {
      throw new AppError(400, 'field_not_requirable', `ฟิลด์ ${key} ตั้งเป็นฟิลด์บังคับไม่ได้`, { fields: [key] });
    }
    fields[key] = next;
  }
  return { fields, columns: normalizeColumns(input.columns ?? current.columns, fields, customFields) };
}

/** ค่าที่เก็บลงฐานข้อมูล (เก็บครบทุกคีย์ เพื่อไม่ให้ค่าเริ่มต้นที่เปลี่ยนภายหลังกระทบโปรเจกต์เดิม) */
export const storeProfile = (p: ResolvedProfile): StoredProfile => ({ fields: p.fields, columns: p.columns });

// ---------------------------------------------------------------------------
// การตรวจตอนสร้าง / แก้งาน
// ---------------------------------------------------------------------------

/** ค่าของฟิลด์ในชุดฟิลด์จากข้อมูลงาน · ใช้ทั้งตรวจฟิลด์บังคับและฟิลด์ที่ซ่อน */
export type ProfileValues = Partial<Record<ProfileField, unknown>>;
const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

export type Level = 'task' | 'subtask';

/** ฟิลด์บังคับที่ยังว่าง (เฉพาะฟิลด์ที่ส่งมาตรวจ) */
export function missingRequired(profile: ResolvedProfile, level: Level, values: ProfileValues, only?: ProfileField[]) {
  return (only ?? PROFILE_FIELD_KEYS).filter((k) => profile.fields[k][level] === 'required' && !filled(values[k]));
}

/** ฟิลด์ที่ซ่อนในระดับนี้แต่ส่งค่าใหม่มา (ค่าเดิมเก็บไว้ได้ แต่ไม่รับค่าใหม่) */
export function hiddenWrites(profile: ResolvedProfile, level: Level, values: ProfileValues) {
  return PROFILE_FIELD_KEYS.filter((k) => profile.fields[k][level] === 'hidden' && values[k] !== undefined && filled(values[k]));
}

// ---------------------------------------------------------------------------
// Template ในตัว (ระบบมีให้) · Admin คัดลอกไปเป็น Template ขององค์กรแล้วปรับต่อได้
// ---------------------------------------------------------------------------

/** หมวดของ Template (ตามรายการที่ผู้ใช้ให้ 2026-11-09) · ตอนนี้มี Template เฉพาะ Software development */
export const TEMPLATE_CATEGORIES = [
  'software', 'service', 'work', 'product', 'marketing', 'customer_service', 'hr',
  'finance', 'design', 'personal', 'operations', 'legal', 'sales', 'analytics',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

const STANDARD_FLOW = ['To do', 'In progress', 'Review', 'Done'];
const ALL_OPTIONAL = Object.fromEntries(PROFILE_FIELD_KEYS.map((k) => [k, { task: 'optional', subtask: 'optional' }])) as Record<ProfileField, FieldRule>;

export const BUILTIN_TEMPLATE_IDS = ['development', 'scrum', 'kanban', 'waterfall', 'blank'] as const;
export type BuiltinTemplateId = (typeof BUILTIN_TEMPLATE_IDS)[number];

/**
 * config ใช้รูปแบบเดียวกับ project_templates.config · ค่าที่ผู้สร้างส่งมาใน POST w/projects ชนะเสมอ
 * Development = ชุดของแผน Development Plan (Module → กลุ่ม → Task → Sub-task, BA / SA / Dev / QA, Size → Man-Day, Plan / Actual)
 * Scrum / Kanban / Waterfall / Blank ใช้ชุดฟิลด์เดียวกันไปก่อน (ยังไม่มีคำตัดสินให้ต่างกัน)
 */
export const BUILTIN_TEMPLATES: { id: BuiltinTemplateId; category: TemplateCategory; name: string; description: string; config: Record<string, unknown> }[] = [
  {
    id: 'development', category: 'software', name: 'Development',
    description: 'แผนพัฒนาระบบ แบ่งงานเป็น Module → กลุ่ม → Task → Sub-task',
    config: { category: 'software', workflow: STANDARD_FLOW, sprintLengthWeeks: 2, estimateUnit: 'man_day', progressMethod: 'weighted', fields: ALL_OPTIONAL, columns: DEFAULT_COLUMNS },
  },
  {
    id: 'scrum', category: 'software', name: 'Scrum', description: 'ทำงานเป็นรอบ Sprint ดึงงานจาก Backlog เข้ารอบ',
    config: { category: 'software', workflow: STANDARD_FLOW, sprintLengthWeeks: 2, fields: ALL_OPTIONAL, columns: DEFAULT_COLUMNS },
  },
  {
    id: 'kanban', category: 'software', name: 'Kanban', description: 'งานไหลต่อเนื่อง ไม่แบ่งรอบ Sprint',
    config: { category: 'software', workflow: [{ name: 'To do' }, { name: 'In progress', wipLimit: 5 }, { name: 'Review', wipLimit: 3 }, { name: 'Done' }], sprintLengthWeeks: null, fields: ALL_OPTIONAL, columns: DEFAULT_COLUMNS },
  },
  {
    id: 'waterfall', category: 'software', name: 'Waterfall', description: 'ทำทีละเฟสตามลำดับ ไม่แบ่งรอบ Sprint',
    config: { category: 'software', workflow: STANDARD_FLOW, sprintLengthWeeks: null, modules: ['Requirement', 'Design', 'Development', 'Testing', 'Deploy'], fields: ALL_OPTIONAL, columns: DEFAULT_COLUMNS },
  },
  {
    id: 'blank', category: 'software', name: 'Blank', description: 'เริ่มจากโครงเปล่า แล้วตั้งค่าเองภายหลัง',
    config: { category: 'software', workflow: ['To do', 'Done'], sprintLengthWeeks: null, fields: ALL_OPTIONAL, columns: DEFAULT_COLUMNS },
  },
];

export const builtinTemplate = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id);

/** column ใน Template อ้าง Custom field ด้วยชื่อ (`cf:<ชื่อ>`) เพราะยังไม่มี id ตอนเขียน Template */
export function templateColumns(columns: string[] | undefined, created: { id: string; name: string }[]) {
  if (!columns) return undefined;
  return columns.map((c) => {
    if (!c.startsWith('cf:')) return c;
    const name = c.slice(3).trim().toLowerCase();
    const hit = created.find((f) => f.name.toLowerCase() === name || f.id === c.slice(3));
    return hit ? `cf:${hit.id}` : c;
  });
}
