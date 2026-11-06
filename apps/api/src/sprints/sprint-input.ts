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
