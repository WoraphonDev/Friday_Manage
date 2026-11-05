import type { z } from 'zod';
import { AppError } from './errors.js';

/** ตรวจข้อมูลขาเข้า · ผิดตอบ 400 พร้อม details.fields บอกช่องที่ผิด */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(400, 'invalid_input', 'ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
