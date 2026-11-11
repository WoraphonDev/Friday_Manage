import { schema } from '@friday/db';
import { inArray, notInArray, sql } from 'drizzle-orm';

/**
 * หมวดของสถานะ (ผู้ใช้ขอเพิ่ม review / blocked / cancelled เมื่อ 2026-11-11)
 * - งานค้าง = ทุกหมวดยกเว้น done / cancelled (review, blocked ยังต้องทำต่อ)
 * - cancelled = ปิดงานแต่ไม่นับว่าเสร็จ: ไม่เลยกำหนด ไม่แจ้งเตือน และไม่อยู่ในตัวหารของ % ความคืบหน้า
 */
export const STATUS_CATEGORIES = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const CLOSED_CATEGORIES = ['done', 'cancelled'] as const satisfies readonly StatusCategory[];
/** หมวดที่ยังเป็นงานค้าง (ใช้กับตัวกรองที่รับรายการหมวด) */
export const OPEN_CATEGORIES = STATUS_CATEGORIES.filter((c) => !(CLOSED_CATEGORIES as readonly string[]).includes(c));

export const isClosed = (category: string | null | undefined) => category === 'done' || category === 'cancelled';
export const isCancelled = (category: string | null | undefined) => category === 'cancelled';
/** นับในตัวหารของความคืบหน้า / งานทั้งหมด (งานที่ยกเลิกไม่นับ) */
export const countsForProgress = (category: string | null | undefined) => category !== 'cancelled';

const col = schema.workflowStatuses.category;
/** WHERE: สถานะยังเป็นงานค้าง */
export const openStatus = () => notInArray(col, [...CLOSED_CATEGORIES]);
/** WHERE: สถานะปิดงานแล้ว (เสร็จหรือยกเลิก) */
export const closedStatus = () => inArray(col, [...CLOSED_CATEGORIES]);
/** SQL ดิบ: `${s.workflowStatuses.category} not in ('done','cancelled')` */
export const openStatusSql = sql`${col} not in ('done', 'cancelled')`;
