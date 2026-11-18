import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, Query, Req } from '@nestjs/common';
import type { Db } from '@friday/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OpsRequest, Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { parse } from '../errors.js';

/**
 * กำลังดูโดย (ช่วง 2 · กันทำงานซ้ำกับเพื่อน)
 * หน้าเว็บส่งสัญญาณทุก 15 วินาทีขณะเปิดรายการ · พิมพ์ตอบ = typing · ปิดแผงส่ง leave
 * เกิน 30 วินาทีไม่มีสัญญาณ = ไม่อยู่แล้ว (ไม่ต้องรอ leave · ปิดแท็บก็หายเอง)
 */
const TYPES = ['ticket', 'payment', 'approval', 'privacy'] as const;
export const FRESH_SECONDS = 30;
export const PingBody = z.object({ type: z.enum(TYPES), id: z.uuid(), mode: z.enum(['viewing', 'typing']).default('viewing') }).strict();
export const LeaveBody = z.object({ type: z.enum(TYPES), id: z.uuid() }).strict();
export const PresenceQuery = z.object({
  type: z.enum(TYPES),
  /** รหัสคั่นด้วยจุลภาค (ไม่เกิน 200) */
  ids: z
    .string()
    .trim()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.uuid()).max(200)),
});

type Row = { id: string; staffId: string; name: string; mode: 'viewing' | 'typing'; seenAt: string };

@Injectable()
export class PresenceService {
  constructor(@Inject(OPS_DB) private readonly db: Db) {}

  private async rows<T>(q: ReturnType<typeof sql>) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  async ping(staff: Staff, input: z.infer<typeof PingBody>) {
    await this.db.execute(sql`
      insert into ops_presence (staff_id, target_type, target_id, mode, seen_at) values (${staff.id}, ${input.type}, ${input.id}, ${input.mode}, now())
      on conflict (staff_id, target_type, target_id) do update set mode = excluded.mode, seen_at = now()`);
    // เก็บกวาดแถวเก่า (ชั่วคราวล้วน ไม่ต้องมีงานเบื้องหลัง)
    await this.db.execute(sql`delete from ops_presence where seen_at < now() - interval '10 minutes'`);
    return { others: await this.of(staff, input.type, [input.id]) };
  }

  async leave(staff: Staff, input: z.infer<typeof LeaveBody>) {
    await this.db.execute(sql`delete from ops_presence where staff_id = ${staff.id} and target_type = ${input.type} and target_id = ${input.id}`);
    return { ok: true };
  }

  /** คนอื่น (ไม่รวมตัวเอง) ที่อยู่ที่รายการเหล่านี้ตอนนี้ · typing มาก่อน */
  async of(staff: Staff, type: string, ids: string[]) {
    if (!ids.length) return [];
    return this.rows<Row>(sql`
      select p.target_id as id, p.staff_id as "staffId", st.name, p.mode, p.seen_at as "seenAt"
      from ops_presence p join staff_users st on st.id = p.staff_id
      where p.target_type = ${type} and p.target_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        and p.staff_id <> ${staff.id} and p.seen_at > now() - make_interval(secs => ${FRESH_SECONDS})
      order by (p.mode = 'typing') desc, p.seen_at desc`);
  }
}

@Controller('ops/presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    const { type, ids } = parse(PresenceQuery, q);
    return this.presence.of(req.staff!, type, ids).then((items) => ({ items }));
  }
  @Post()
  @HttpCode(200)
  ping(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.presence.ping(req.staff!, parse(PingBody, body));
  }
  @Post('leave')
  @HttpCode(200)
  leave(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.presence.leave(req.staff!, parse(LeaveBody, body));
  }
}

@Module({ controllers: [PresenceController], providers: [PresenceService], exports: [PresenceService] })
export class PresenceModule {}
