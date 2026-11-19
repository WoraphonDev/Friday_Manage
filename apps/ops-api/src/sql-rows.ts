import type { Db, Tx } from '@friday/db';
import type { SQL } from 'drizzle-orm';

/** "2026-11-19 19:17:46.102+00" (timestamptz ที่ drizzle คืนเป็นข้อความเมื่อใช้ SQL ดิบ) */
const PG_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?)$/;

/**
 * แถวจาก `db.execute(sql…)` · แปลงเวลารูปแบบ Postgres เป็น ISO ให้ทุกเบราว์เซอร์อ่านได้ (Safari อ่าน "…+00" ไม่ได้)
 * วันที่ล้วน (YYYY-MM-DD) คงเดิม
 */
export async function sqlRows<T>(db: Db | Tx, q: SQL): Promise<T[]> {
  const r = await db.execute(q);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as Record<string, unknown>[];
  for (const row of rows) for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && PG_TS.test(v)) row[k] = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString();
  return rows as T[];
}
