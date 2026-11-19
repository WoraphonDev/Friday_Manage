import { z } from 'zod';
import { daysBetween } from '../overview/workload.js';

const fields = {
  name: z.string().trim().min(1).max(200),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  goal: z.string().trim().max(10000).nullable().optional(),
};

export const CreateSprintBody = z.object(fields).strict().superRefine((value, ctx) => {
  if (value.endDate < value.startDate || daysBetween(value.startDate, value.endDate) > 365) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Sprint ต้องยาว 1–366 วัน และวันจบต้องไม่ก่อนวันเริ่ม' });
  }
});
export const PatchSprintBody = z.object(fields).partial().strict().refine((value) => Object.keys(value).length > 0, 'ต้องระบุค่าที่จะแก้');
export const CompleteSprintBody = z.object({
  moveIncompleteTo: z.union([z.uuid(), z.literal('backlog')]),
  retrospective: z.string().trim().max(20000).nullable().optional(),
}).strict();
export const SprintId = z.uuid();

/**
 * สร้างหลาย Sprint ต่อกัน (ผู้ใช้ขอ 2026-11-19): กำหนดวันเริ่ม จำนวน และความยาวต่อ Sprint เป็นสัปดาห์
 * ชื่อเป็น "Sprint <ลำดับ>" ตามเลข Sprint ของโปรเจกต์ แก้ทีหลังได้
 */
export const CreateSprintSeriesBody = z.object({
  startDate: z.iso.date(),
  weeks: z.number().int().min(1).max(8),
  count: z.number().int().min(1).max(26),
}).strict();

/**
 * ช่วงวันของ Sprint ที่ต่อกัน: Sprint ถัดไปเริ่มหลังจากครบจำนวนสัปดาห์
 * วันจบถอยจากเสาร์ / อาทิตย์มาเป็นศุกร์ (เริ่มวันจันทร์ 2 สัปดาห์ = จันทร์ – ศุกร์ของสัปดาห์ที่สอง)
 */
export function sprintSeries(startDate: string, weeks: number, count: number) {
  const day = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const first = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const start = first + i * weeks * 7 * day;
    let end = start + (weeks * 7 - 1) * day;
    while (end > start && [0, 6].includes(new Date(end).getUTCDay())) end -= day;
    return { startDate: iso(start), endDate: iso(end) };
  });
}
