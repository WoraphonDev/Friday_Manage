import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema as s } from '@friday/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { recalculatePlanEnds } from '../project-structure/plan-ends.js';
import { WorkCalendar } from '../projects/calendar.js';
import { Jobs } from '../queue/jobs.js';

/** key เดียวกับ apps/ops-api/src/support/holidays.service.ts (HOLIDAY_RECALC_KEY) */
export const HOLIDAY_RECALC_KEY = 'holiday_recalc';
const JOB = 'help.system-holidays';

interface Pending {
  id: string;
  calendarId: string;
  added: string[];
  removed: string[];
  /** โปรเจกต์ที่คำนวณแล้ว · รันซ้ำหลังล้มกลางทางไม่คำนวณซ้ำ (ช่วงงานเลื่อนไปแล้วจะเลื่อนซ้ำ) */
  done: string[];
}

/**
 * คำนวณ Plan End ใหม่เมื่อทีม Friday แก้ปฏิทินวันหยุดของระบบ (Friday Ops รอบ 4 · S2)
 * ops-api เป็นอีกโปรเซสที่เรียก recalculatePlanEnds ไม่ได้ จึงเขียนวันที่เปลี่ยนไว้ใน ops_settings › holiday_recalc
 * งานนี้รับไปทำทุก 1 นาที (แบบเดียวกับ SupportRepliesJob) และส่ง Event หลัง commit → plan.changed แจ้ง PM
 * ปฏิทินก่อนแก้ = ปฏิทินตอนนี้ที่ถอยวันที่เพิ่ม / คืนวันที่ลบ ของทุกคิวที่ค้าง จึงรักษาจำนวนวันทำการของงานไว้ได้
 * ปฏิทินที่ลูกค้าคัดลอกไปเป็นของตัวเองแล้วไม่เปลี่ยน (คิดเฉพาะโปรเจกต์ที่ใช้ปฏิทินของระบบ)
 */
@Injectable()
export class SystemHolidaysJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SystemHolidays');
  private timer?: NodeJS.Timeout;

  constructor(
    // ops_settings เป็นตาราง ops_only และโปรเจกต์ที่กระทบอยู่หลาย Workspace จึงใช้ SYSTEM_DB
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly events: EventBus,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    this.jobs.define(JOB, () => this.run());
    await this.jobs.every(JOB, '* * * * *');
    // โหมด inline (Docker บนเครื่อง) ไม่รันงานตามเวลา จึงตั้งเวลาเองในโปรเซส · test เรียก run() เอง
    if (this.jobs.mode === 'inline' && !process.env.VITEST) {
      this.timer = setInterval(() => void this.run().catch((e) => this.log.error(String(e))), 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async pending(): Promise<Pending[]> {
    const [row] = await this.db.select({ value: s.opsSettings.value }).from(s.opsSettings).where(eq(s.opsSettings.key, HOLIDAY_RECALC_KEY));
    const list = (row?.value as { pending?: Pending[] } | undefined)?.pending;
    return Array.isArray(list) ? list.map((p) => ({ ...p, done: p.done ?? [] })) : [];
  }

  /** เขียนผลกลับเฉพาะคิวที่ทำ (ops-api อาจต่อท้ายคิวใหม่ระหว่างนี้) · done = บันทึกความคืบหน้าไว้ที่รายการแรกของกลุ่ม */
  private async update(ids: string[], patch: { done?: string[]; remove?: boolean }) {
    await this.db.transaction(async (tx) => {
      const r = await tx.execute(sql`select value from ops_settings where key = ${HOLIDAY_RECALC_KEY} for update`);
      const value = (((r as unknown as { rows?: { value: { pending?: Pending[] } }[] }).rows ?? [])[0]?.value ?? {}) as { pending?: Pending[] };
      const pending = (value.pending ?? []).flatMap((p) => (!ids.includes(p.id) ? [p] : patch.remove ? [] : [{ ...p, done: p.id === ids[0] ? (patch.done ?? p.done) : p.done }]));
      await tx.execute(sql`update ops_settings set value = jsonb_set(value, '{pending}', ${JSON.stringify(pending)}::jsonb) where key = ${HOLIDAY_RECALC_KEY}`);
    });
  }

  /**
   * ทำคิวที่ค้างทีละปฏิทิน · หลายรายการของปฏิทินเดียวกันคิดรวมครั้งเดียว:
   * ปฏิทินก่อน = ปฏิทินตอนนี้ที่ถอยทุกรายการ (ล่าสุดก่อน) · ปฏิทินหลัง = ตอนนี้ (recalculatePlanEnds โหลดเอง)
   */
  async run() {
    const queue = await this.pending();
    let projects = 0;
    let issues = 0;
    for (const calendarId of [...new Set(queue.map((p) => p.calendarId))]) {
      const group = queue.filter((p) => p.calendarId === calendarId);
      const ids = group.map((p) => p.id);
      const done = new Set(group.flatMap((p) => p.done));
      const rows = await this.db
        .select({ project: s.projects })
        .from(s.projects)
        .leftJoin(s.workspaceSettings, eq(s.workspaceSettings.workspaceId, s.projects.workspaceId))
        .where(and(isNull(s.projects.deletedAt), isNull(s.projects.archivedAt), or(eq(s.projects.holidayCalendarId, calendarId), and(isNull(s.projects.holidayCalendarId), eq(s.workspaceSettings.holidayCalendarId, calendarId)))));
      for (const { project } of rows) {
        if (done.has(project.id)) continue;
        const r = await this.db.transaction(async (tx) => {
          const now = await WorkCalendar.load(tx, project);
          // วันหยุดเฉพาะโปรเจกต์ยังเป็นวันหยุดอยู่เสมอ ไม่ว่าปฏิทินของระบบจะเปลี่ยนอย่างไร
          const own = new Set((await tx.select({ date: s.projectHolidays.date }).from(s.projectHolidays).where(eq(s.projectHolidays.projectId, project.id))).map((x) => x.date));
          const off = new Set(now.holidaysIn('0000-01-01', '9999-12-31'));
          for (const p of [...group].reverse()) {
            for (const d of p.added) if (!own.has(d)) off.delete(d);
            for (const d of p.removed) off.add(d);
          }
          return recalculatePlanEnds(tx, project, { previous: new WorkCalendar(new Set(now.workDayList), off), actorId: null });
        });
        done.add(project.id);
        await this.update(ids, { done: [...done] });
        await this.events.publish(r.events);
        if (r.changes.length) projects++;
        issues += r.changes.length;
      }
      await this.update(ids, { remove: true });
    }
    return { entries: queue.length, projects, issues };
  }
}
