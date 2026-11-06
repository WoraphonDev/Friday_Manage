import { AsyncLocalStorage } from 'node:async_hooks';
import type { z } from 'zod';
import { AppError } from './errors.js';

/**
 * โหมดสำรวจสำหรับสร้าง OpenAPI (src/openapi): เรียก handler ของ controller กับ service ปลอม แล้วจด schema ที่ส่งเข้า `parse`
 * ไม่ตรวจข้อมูลจริงและไม่ throw · นอกโหมดนี้ `parse` ทำงานเหมือนเดิมทุกประการ
 */
export interface SchemaProbe {
  found: { schema: z.ZodType; kind: 'body' | 'query' | 'other' }[];
  body: object;
  query: object;
}
export const schemaProbe = new AsyncLocalStorage<SchemaProbe>();

/** ตรวจข้อมูลขาเข้า · ผิดตอบ 400 พร้อม details.fields บอกช่องที่ผิด */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const probe = schemaProbe.getStore();
  if (probe) {
    probe.found.push({ schema, kind: data === probe.body ? 'body' : data === probe.query ? 'query' : 'other' });
    return {} as z.infer<T>;
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(400, 'invalid_input', 'ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
