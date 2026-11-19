import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { sql } from 'drizzle-orm';
import { SYSTEM_DB } from '../db/db.module.js';
import { Jobs } from '../queue/jobs.js';

const s = schema;
const MINUTE = 60_000;
const FLUSH_MS = 10_000;
const BATCH = 500;

interface Row {
  workspaceId: string;
  minute: number;
  tokenId: string;
  route: string;
  calls: number;
  rejected: number;
  limit: number | null;
}

/** "GET /api/v1/issues/:id" → "GET /issues/:id" · ไม่มี route (เช่น 404) ใช้ path จริงแต่แทน uuid / ตัวเลขด้วย :id ไม่ให้แตกเป็นหลายแถว */
export function routeLabel(method: string, routePath: string | undefined, path: string) {
  const p = (routePath ?? path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:n')).replace(/^\/api\/v1/, '') || '/';
  return `${method.toUpperCase()} ${p}`.slice(0, 200);
}

/**
 * สถิติการเรียก API ด้วย token (O51 · Rate limit ต่อลูกค้า) · รวมในหน่วยความจำต่อ Workspace + token + route + นาที แล้วเขียนเป็นชุดทุก 10 วินาที
 * ไม่เขียนทุกคำขอเพื่อไม่ให้ฐานข้อมูลรับภาระตามปริมาณ API · process ดับก่อน flush = เสียสถิติไม่เกิน 10 วินาที (ยอมรับได้ ไม่ใช่ข้อมูลเงิน)
 * เขียนด้วย SYSTEM_DB เพราะตอนตรวจ token ยังไม่ได้ตั้งบริบท Workspace ให้ RLS
 */
@Injectable()
export class ApiUsage implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ApiUsage');
  private buf = new Map<string, Row>();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    if (!process.env.VITEST) {
      this.timer = setInterval(() => void this.flush().catch((e) => this.log.error(String(e))), FLUSH_MS);
      this.timer.unref?.();
    }
    // ยุบเป็นรายชั่วโมงและลบของเก่า ทุกชั่วโมงนาทีที่ 5
    this.jobs.define('api.usage-rollup', () => this.rollup());
    await this.jobs.every('api.usage-rollup', '5 * * * *');
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => 0);
  }

  record(e: { workspaceId: string; tokenId: string; route: string; rejected: boolean; limit: number | null }, now = Date.now()) {
    const minute = now - (now % MINUTE);
    const key = `${e.workspaceId}|${minute}|${e.tokenId}|${e.route}`;
    const row = this.buf.get(key) ?? { workspaceId: e.workspaceId, minute, tokenId: e.tokenId, route: e.route, calls: 0, rejected: 0, limit: e.limit };
    row.calls++;
    if (e.rejected) row.rejected++;
    row.limit = e.limit;
    this.buf.set(key, row);
  }

  /** เขียนที่สะสมไว้ · เขียนไม่ได้ = คืนเข้าบัฟเฟอร์ให้รอบหน้า */
  async flush() {
    if (!this.buf.size) return 0;
    const rows = [...this.buf.values()];
    this.buf = new Map();
    const t = s.apiUsageMinutes;
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        await this.db
          .insert(t)
          .values(rows.slice(i, i + BATCH).map((r) => ({ workspaceId: r.workspaceId, minute: new Date(r.minute), tokenId: r.tokenId, route: r.route, calls: r.calls, rejected: r.rejected, limitRpm: r.limit })))
          .onConflictDoUpdate({
            target: [t.workspaceId, t.minute, t.tokenId, t.route],
            set: { calls: sql`${t.calls} + excluded.calls`, rejected: sql`${t.rejected} + excluded.rejected`, limitRpm: sql`excluded.limit_rpm` },
          });
      }
    } catch (e) {
      // Workspace ถูกลบระหว่างนั้น (FK) ทำให้ทั้งชุดล้ม · ทิ้งชุดนี้แทนการวนล้มซ้ำ แต่ถ้าเป็นปัญหาเชื่อมต่อให้ลองใหม่รอบหน้า
      if ((e as { code?: string }).code !== '23503') for (const r of rows) this.buf.set(`${r.workspaceId}|${r.minute}|${r.tokenId}|${r.route}`, r);
      throw e;
    }
    return rows.length;
  }

  /** ยุบ 3 ชั่วโมงล่าสุดเป็นรายชั่วโมง (คำนวณใหม่ทั้งชั่วโมง รันซ้ำได้) · ลบรายนาทีเกิน 7 วัน และรายชั่วโมงเกิน 90 วัน */
  async rollup(now = new Date()) {
    await this.flush().catch(() => 0);
    await this.db.execute(sql`
      insert into api_usage_hours (workspace_id, hour, token_id, route, calls, rejected, peak_rpm, limit_rpm)
      select workspace_id, date_trunc('hour', minute), token_id, route, sum(calls)::int, sum(rejected)::int, max(calls)::int, (array_agg(limit_rpm order by minute desc))[1]
      from api_usage_minutes where minute >= date_trunc('hour', ${now}::timestamptz) - interval '3 hours'
      group by 1, 2, 3, 4
      on conflict (workspace_id, hour, token_id, route) do update set calls = excluded.calls, rejected = excluded.rejected, peak_rpm = excluded.peak_rpm, limit_rpm = excluded.limit_rpm`);
    const m = await this.db.execute(sql`delete from api_usage_minutes where minute < ${now}::timestamptz - interval '7 days'`);
    const h = await this.db.execute(sql`delete from api_usage_hours where hour < ${now}::timestamptz - interval '90 days'`);
    return { minutesPurged: (m as unknown as { rowCount?: number }).rowCount ?? 0, hoursPurged: (h as unknown as { rowCount?: number }).rowCount ?? 0 };
  }
}
