import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client.ts';

const OWNER_URL = process.env.DATABASE_OWNER_URL ?? 'postgres://friday_owner:friday_owner_dev@localhost:54329/friday';

describe('createDb · ฐานข้อมูลตัด connection ที่ว่างอยู่', () => {
  const db = createDb(OWNER_URL, 1);
  afterAll(() => db.$client.end());

  // เหตุ 2026-11-16: อัปเดต postgres บน VPS แล้ว API กับ worker ล้มทั้ง process เพราะ pool ไม่ได้ดัก 'error'
  it('ไม่ล้ม และ query ถัดไปเปิด connection ใหม่ได้', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    const pid = first.rows[0]!.pid;

    // ตัด connection แบบเดียวกับตอน PostgreSQL ปิดตัว (administrator command) จาก connection อื่น
    const admin = new pg.Client({ connectionString: OWNER_URL });
    await admin.connect();
    await admin.query('select pg_terminate_backend($1)', [pid]);
    await admin.end();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('[db] connection ที่ว่างอยู่ถูกตัด')));

    const next = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    expect(next.rows[0]!.pid).not.toBe(pid);
    warn.mockRestore();
  });
});
