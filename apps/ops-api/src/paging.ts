import { z } from 'zod';

/**
 * แบ่งหน้ามาตรฐานของรายการใน Ops (ช่วง 1 · ออกแบบสำหรับข้อมูลเยอะ)
 * ทุกรายการส่ง `total` กลับไปด้วย หน้าเว็บจึงบอก "แสดง x–y จาก n" ได้เสมอ ไม่ตัดเงียบ
 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type Page = z.infer<typeof PageQuery>;
