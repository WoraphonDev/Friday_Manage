import { sql } from 'drizzle-orm';
import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/** UUID v7 (เรียงตามเวลา) สร้างโดย PostgreSQL 18 */
export const pk = () => uuid().primaryKey().default(sql`uuidv7()`);

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const deletedAt = () => timestamp({ withTimezone: true });
export const tstz = () => timestamp({ withTimezone: true });

/** Man-Day รองรับ 0.25 MD */
export const manDay = () => numeric({ precision: 6, scale: 2, mode: 'number' });
