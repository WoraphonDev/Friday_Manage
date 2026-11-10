import type { CustomFieldDef } from '../issues/custom-values.js';
import { normalizeValue } from '../issues/custom-values.js';
import { type Cell, toIsoDate } from './excel.js';

/**
 * ค่าในเซลล์ของคอลัมน์ Custom field → ค่าที่เก็บ (รูปแบบเดียวกับไฟล์ส่งออก):
 * ตัวเลือกใช้ชื่อ (หลายค่าคั่นด้วย ,) · วันที่เป็นวันที่ของ Excel หรือ YYYY-MM-DD · คนเป็นชื่อ (แปลงเป็น userId ตอนเขียนด้วยการจับคู่คน)
 * เซลล์ว่าง = ล้างค่า (null)
 */
export type ParsedCustom = { ok: true; value: unknown } | { ok: false; problem: string };

export function parseCustomCell(def: CustomFieldDef, cell: Cell): ParsedCustom {
  const text = cell === null || cell === undefined ? '' : cell instanceof Date ? '' : String(cell).trim();
  if (cell === null || (!(cell instanceof Date) && !text)) return { ok: true, value: null };
  const choice = (label: string) => def.options?.choices.find((c) => c.label.toLowerCase() === label.toLowerCase() || c.id === label)?.id;
  try {
    switch (def.fieldType) {
      case 'text':
        return { ok: true, value: normalizeValue(def, cell instanceof Date ? toIsoDate(cell) : text) };
      case 'number':
        return { ok: true, value: normalizeValue(def, typeof cell === 'number' ? cell : text.replace(/,/g, '')) };
      case 'date': {
        const iso = toIsoDate(cell);
        return iso ? { ok: true, value: normalizeValue(def, iso) } : { ok: false, problem: `"${text}" ไม่ใช่วันที่` };
      }
      case 'select': {
        const id = choice(text);
        return id ? { ok: true, value: id } : { ok: false, problem: `ไม่มีตัวเลือก "${text}"` };
      }
      case 'multi_select': {
        const labels = text.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
        const missing = labels.filter((l) => !choice(l));
        if (missing.length) return { ok: false, problem: `ไม่มีตัวเลือก ${missing.map((m) => `"${m}"`).join(', ')}` };
        return { ok: true, value: [...new Set(labels.map((l) => choice(l)!))] };
      }
      case 'user':
        return { ok: true, value: text };
    }
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
}
