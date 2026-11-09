import { schema as s, type Tx } from '@friday/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { type FieldMode, hiddenWrites, type Level, missingRequired, type ProfileValues, type ResolvedProfile } from '../projects/field-profile.js';

/**
 * ค่า Custom field ของงาน (ตาราง issue_custom_values) · เก็บเป็น jsonb ตามชนิด
 * text = string · number = number · date = 'YYYY-MM-DD' · select = id ของตัวเลือก · multi_select = [id] · user = user id
 * ค่าว่าง (null, '', []) = ลบแถวทิ้ง
 */
export type CustomFieldDef = {
  id: string; name: string; fieldType: 'text' | 'number' | 'select' | 'multi_select' | 'user' | 'date';
  options: { choices: { id: string; label: string }[] } | null; taskMode: FieldMode; subtaskMode: FieldMode;
};
export type CustomValues = Record<string, unknown>;

/** รับได้ทั้งการสร้างและแก้ · คีย์คือ id ของฟิลด์ */
export const CustomValuesBody = z.record(z.uuid(), z.unknown()).refine((v) => Object.keys(v).length <= 100, 'Custom field มากเกินไป');

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const isoDate = z.iso.date();
const modeOf = (f: CustomFieldDef, level: Level) => (level === 'task' ? f.taskMode : f.subtaskMode);

const invalid = (f: CustomFieldDef, message: string) =>
  new AppError(400, 'invalid_custom_field', `${f.name}: ${message}`, { fieldId: f.id, field: f.name });

/** แปลงค่าที่ส่งมาให้อยู่ในรูปที่เก็บ · null = ล้างค่า */
export function normalizeValue(f: CustomFieldDef, raw: unknown): unknown {
  if (empty(raw)) return null;
  switch (f.fieldType) {
    case 'text': {
      if (typeof raw !== 'string') throw invalid(f, 'ต้องเป็นข้อความ');
      const text = raw.trim();
      if (text.length > 5000) throw invalid(f, 'ยาวเกิน 5,000 ตัวอักษร');
      return text || null;
    }
    case 'number': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e12) throw invalid(f, 'ต้องเป็นตัวเลข');
      return n;
    }
    case 'date':
      if (typeof raw !== 'string' || !isoDate.safeParse(raw).success) throw invalid(f, 'ต้องเป็นวันที่รูปแบบ YYYY-MM-DD');
      return raw;
    case 'select': {
      if (typeof raw !== 'string' || !f.options?.choices.some((c) => c.id === raw)) throw invalid(f, 'ไม่มีตัวเลือกนี้');
      return raw;
    }
    case 'multi_select': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw invalid(f, 'ต้องเป็นรายการตัวเลือก');
      const ids = [...new Set(raw as string[])];
      if (ids.some((id) => !f.options?.choices.some((c) => c.id === id))) throw invalid(f, 'มีตัวเลือกที่ไม่มีในฟิลด์นี้');
      return ids;
    }
    case 'user':
      if (typeof raw !== 'string' || !z.uuid().safeParse(raw).success) throw invalid(f, 'ต้องเป็นสมาชิก 1 คน');
      return raw;
  }
}

/**
 * ตรวจค่า Custom field ที่ส่งมา + กติกาของชุดฟิลด์ในระดับนั้น
 * strict = คำขอจากผู้ใช้ (ไม่ใช่ Automation / ระบบ) ต้องเคารพฟิลด์ที่ซ่อน / ฟิลด์บังคับ
 * creating = ตรวจฟิลด์บังคับทุกตัว · แก้ไข = ตรวจเฉพาะตัวที่ส่งมา (ห้ามล้างฟิลด์บังคับ)
 */
export function checkCustomValues(defs: CustomFieldDef[], level: Level, input: CustomValues, opts: { strict: boolean; creating: boolean; current?: CustomValues }) {
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(input)) {
    const f = defs.find((d) => d.id === id);
    if (!f) throw new AppError(400, 'invalid_reference', 'Custom field ไม่อยู่ในโปรเจกต์นี้', { fieldIds: [id] });
    out[id] = normalizeValue(f, raw);
  }
  if (!opts.strict) return out;
  const hidden = defs.filter((f) => modeOf(f, level) === 'hidden' && f.id in out && out[f.id] !== null && JSON.stringify(out[f.id]) !== JSON.stringify(opts.current?.[f.id] ?? null));
  if (hidden.length) throw hiddenError(hidden.map((f) => f.name));
  const required = defs.filter((f) => modeOf(f, level) === 'required' && (opts.creating ? out[f.id] === undefined || out[f.id] === null : f.id in out && out[f.id] === null));
  if (required.length) throw missingError(required.map((f) => f.name));
  return out;
}

/** ชื่อฟิลด์มาตรฐานในข้อความ error (details.fields ยังเป็นคีย์ให้หน้าเว็บใช้) */
const LABEL: Record<string, string> = {
  ba: 'Business Analyst', sa: 'System Analyst', reviewer: 'QA / Reviewer', priority: 'Priority', size: 'Size',
  actual: 'Actual Start / End', progress: 'Progress', requirements: 'Requirement', screens: 'Screen', labels: 'Label', remark: 'Remark',
};
const names = (fields: string[]) => fields.map((f) => LABEL[f] ?? f).join(', ');
export const hiddenError = (fields: string[]) =>
  new AppError(422, 'field_hidden', `ฟิลด์ ${names(fields)} ถูกซ่อนในโปรเจกต์นี้ จึงแก้ค่าไม่ได้`, { fields });
export const missingError = (fields: string[]) =>
  new AppError(400, 'missing_required_fields', `กรอกฟิลด์บังคับไม่ครบ: ${names(fields)}`, { fields });

/** ฟิลด์มาตรฐาน: ฟิลด์บังคับ / ฟิลด์ที่ซ่อน ตามชุดฟิลด์ของโปรเจกต์ */
export function checkProfile(profile: ResolvedProfile, level: Level, values: ProfileValues, opts: { creating: boolean }) {
  const hidden = hiddenWrites(profile, level, values);
  if (hidden.length) throw hiddenError(hidden);
  const missing = missingRequired(profile, level, values, opts.creating ? undefined : (Object.keys(values) as (keyof ProfileValues)[]));
  if (missing.length) throw missingError(missing);
}

export async function readCustomValues(tx: Tx, issueIds: string[]) {
  const out = new Map<string, CustomValues>();
  if (!issueIds.length) return out;
  const rows = await tx.select().from(s.issueCustomValues).where(inArray(s.issueCustomValues.issueId, issueIds));
  for (const r of rows) out.set(r.issueId, { ...(out.get(r.issueId) ?? {}), [r.fieldId]: r.value });
  return out;
}

/** เขียนเฉพาะฟิลด์ที่ส่งมา · คืนรายการที่เปลี่ยนจริงสำหรับ Activity */
export async function writeCustomValues(tx: Tx, workspaceId: string, issueId: string, values: Record<string, unknown>, current: CustomValues = {}) {
  const changes: { fieldId: string; oldValue: unknown; newValue: unknown }[] = [];
  for (const [fieldId, value] of Object.entries(values)) {
    const before = current[fieldId] ?? null;
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    if (value === null) await tx.delete(s.issueCustomValues).where(and(eq(s.issueCustomValues.issueId, issueId), eq(s.issueCustomValues.fieldId, fieldId)));
    else {
      await tx.insert(s.issueCustomValues).values({ workspaceId, issueId, fieldId, value })
        .onConflictDoUpdate({ target: [s.issueCustomValues.issueId, s.issueCustomValues.fieldId], set: { value } });
    }
    changes.push({ fieldId, oldValue: before, newValue: value });
  }
  return changes;
}

/** ค่าที่อ่านได้สำหรับ Activity / Export: ตัวเลือก → ชื่อ · คนเก็บเป็น id ให้หน้าเว็บแปลงเอง */
export function displayValue(f: CustomFieldDef | undefined, value: unknown): unknown {
  if (value === null || value === undefined || !f) return value ?? null;
  const label = (cid: unknown) => f.options?.choices.find((c) => c.id === cid)?.label ?? cid;
  if (f.fieldType === 'select') return label(value);
  if (f.fieldType === 'multi_select' && Array.isArray(value)) return value.map(label);
  return value;
}
