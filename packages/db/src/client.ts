import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** สร้างการเชื่อมต่อ · API ใช้บัญชีที่เป็นสมาชิกของ friday_app (DATABASE_APP_URL) เท่านั้น */
export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}

export interface TenantContext {
  userId: string;
  /** null สำหรับคำขอที่ไม่ผูก Workspace เช่น GET /me/workspaces */
  workspaceId: string | null;
}

/**
 * รันงานในธุรกรรมที่ตั้ง app.user_id / app.workspace_id ให้ RLS
 * ค่าอยู่แค่ในธุรกรรมนี้ (set_config แบบ local) จึงไม่รั่วไปคำขออื่นที่ใช้ connection เดียวกันใน pool
 * API ต้องตรวจว่าผู้ใช้เป็นสมาชิก Workspace ก่อนเรียก (RLS ตรวจซ้ำอีกชั้น)
 */
export function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.workspace_id', ${ctx.workspaceId ?? ''}, true)`,
    );
    return fn(tx);
  });
}
