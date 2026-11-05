import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { WorkCalendar } from '../projects/calendar.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { audit, type Context, loadContext, name } from './context.js';
import { recalculatePlanEnds } from './plan-ends.js';

const isoDate = z.iso.date();
export const HolidayQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'to ต้องไม่ก่อน from' });
export const CreateHolidayBody = z.object({ date: isoDate, name }).strict();

type Warning = { code: string; message: string };

/**
 * วันหยุดเฉพาะโปรเจกต์ (เช่น Company outing) · ใช้ร่วมกับปฏิทินหลักของ Workspace / โปรเจกต์
 * เพิ่ม / ลบแล้วคำนวณ Plan End ใหม่ในธุรกรรมเดียวกัน (รอบแรกทำแบบ synchronous เพราะแผนหนึ่งโปรเจกต์มีหลักร้อยงาน)
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
    private readonly events: EventBus,
  ) {}

  async list(auth: AuthInfo, tenant: TenantInfo, key: string, q: z.infer<typeof HolidayQuery>) {
    return this.db.run(auth, tenant, async (tx) => {
      const { project } = await loadContext(tx, this.projects, auth, tenant, key, 'read');
      const from = q.from ?? project.startDate;
      const to = q.to ?? project.goliveDate;
      const items = await tx.select().from(s.projectHolidays).where(eq(s.projectHolidays.projectId, project.id)).orderBy(asc(s.projectHolidays.date));
      const calendar = await this.calendar(tx, project);
      const calendarHolidays = calendar
        ? await tx.select({ date: s.holidays.date, name: s.holidays.name, kind: s.holidays.kind }).from(s.holidays)
          .where(and(eq(s.holidays.calendarId, calendar.id), gte(s.holidays.date, from), lte(s.holidays.date, to))).orderBy(asc(s.holidays.date))
        : [];
      return { range: { from, to }, calendar, items: items.map(holidayDto), calendarHolidays };
    });
  }

  async create(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateHolidayBody>) {
    return this.change(auth, tenant, key, async (tx, { project }) => {
      const [dup] = await tx.select({ id: s.projectHolidays.id }).from(s.projectHolidays).where(and(eq(s.projectHolidays.projectId, project.id), eq(s.projectHolidays.date, input.date)));
      if (dup) throw new AppError(409, 'holiday_exists', `วันที่ ${input.date} เป็นวันหยุดของโปรเจกต์อยู่แล้ว`, { holidayId: dup.id });
      const previous = await WorkCalendar.load(tx, project);
      const warnings: Warning[] = [];
      if (!previous.isWorkingDay(input.date)) warnings.push({ code: 'already_non_working', message: `วันที่ ${input.date} เป็นวันหยุดอยู่แล้ว แผนงานไม่เปลี่ยน` });
      const [row] = await tx.insert(s.projectHolidays).values({ workspaceId: tenant.workspaceId, projectId: project.id, date: input.date, name: input.name }).returning();
      await audit(tx, auth, tenant, project, 'project.holiday_added', `เพิ่มวันหยุด ${row.date} ${row.name}`, 'plan');
      return { holiday: holidayDto(row), previous, warnings };
    });
  }

  async remove(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    return this.change(auth, tenant, key, async (tx, { project }) => {
      const [row] = await tx.select().from(s.projectHolidays).where(and(eq(s.projectHolidays.projectId, project.id), eq(s.projectHolidays.id, id)));
      if (!row) throw notFound('วันหยุด');
      const previous = await WorkCalendar.load(tx, project);
      await tx.delete(s.projectHolidays).where(eq(s.projectHolidays.id, id));
      await audit(tx, auth, tenant, project, 'project.holiday_removed', `ลบวันหยุด ${row.date} ${row.name}`, 'plan');
      return { holiday: holidayDto(row), previous, warnings: [] as Warning[] };
    });
  }

  /** แก้วันหยุดแล้วคำนวณแผนใหม่ในธุรกรรมเดียว · ส่ง Event หลัง commit */
  private async change(
    auth: AuthInfo, tenant: TenantInfo, key: string,
    fn: (tx: Tx, ctx: Context) => Promise<{ holiday: ReturnType<typeof holidayDto>; previous: WorkCalendar; warnings: Warning[] }>,
  ) {
    let events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const ctx = await loadContext(tx, this.projects, auth, tenant, key, 'write');
      // ล็อกโปรเจกต์ไว้ เพื่อไม่ให้การแก้วันหยุดสองคำขอคิดแผนจากปฏิทินเก่าซ้อนกัน
      await tx.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.id, ctx.project.id)).for('update');
      const { holiday, previous, warnings } = await fn(tx, ctx);
      const recalc = await recalculatePlanEnds(tx, ctx.project, { previous, actorId: auth.userId });
      events = recalc.events;
      return { holiday, recalculated: recalc.changes, warnings };
    });
    await this.events.publish(events);
    return result;
  }

  private async calendar(tx: Tx, project: ProjectRow) {
    let id = project.holidayCalendarId;
    if (!id) {
      const [ws] = await tx.select({ id: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, project.workspaceId));
      id = ws?.id ?? null;
    }
    if (!id) return null;
    const [row] = await tx.select({ id: s.holidayCalendars.id, name: s.holidayCalendars.name, source: s.holidayCalendars.source }).from(s.holidayCalendars).where(eq(s.holidayCalendars.id, id));
    return row ?? null;
  }
}

function holidayDto(h: typeof s.projectHolidays.$inferSelect) {
  return { id: h.id, date: h.date, name: h.name };
}
