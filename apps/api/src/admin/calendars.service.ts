import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@friday/db';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { type DomainEvent, EventBus } from '../core/events.js';
import { WorkCalendar } from '../projects/calendar.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { recalculatePlanEnds } from '../project-structure/plan-ends.js';
import { assertAdmin, audit } from './shared.js';

const s = schema;
const isoDate = z.iso.date();

export const CreateCalendarBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** คัดลอกวันหยุดจากปฏิทินที่มีอยู่ (เช่น ปฏิทิน ธปท. ของระบบ) */
  copyFromId: z.uuid().optional(),
});
export const HolidaysQuery = z.object({ calendarId: z.uuid().optional(), from: isoDate.optional(), to: isoDate.optional(), year: z.coerce.number().int().min(2000).max(2100).optional() });
export const CreateHolidayBody = z.object({
  calendarId: z.uuid().optional(),
  date: isoDate,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['bank', 'company']).default('company'),
});

export interface CalendarSnapshot {
  project: ProjectRow;
  previous: WorkCalendar;
}
export interface Recalculated {
  projects: number;
  issues: number;
}

/** ปฏิทินวันหยุด (ค่าเริ่มต้นของทุกโปรเจกต์) และการคำนวณ Plan End ใหม่เมื่อปฏิทิน / วันทำงานเปลี่ยน */
@Injectable()
export class CalendarsService {
  constructor(
    private readonly db: TenantDb,
    private readonly events: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // ใช้ร่วมกับ settings (วันทำงาน / ปฏิทินเริ่มต้นเปลี่ยน)
  // ---------------------------------------------------------------------------

  /** ปฏิทินของโปรเจกต์ที่ยังใช้งานอยู่ ก่อนแก้ · `onlyCalendarId` = เฉพาะโปรเจกต์ที่ใช้ปฏิทินนั้น (ผ่านค่าเริ่มต้นของ Workspace ก็นับ) */
  async snapshot(tx: Tx, tenant: TenantInfo, onlyCalendarId?: string): Promise<CalendarSnapshot[]> {
    // ล็อกต่อ Workspace กันการแก้ปฏิทินสองคำขอคิดแผนจากปฏิทินเก่าซ้อนกัน
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'calendar:' + tenant.workspaceId}, 0))`);
    const [ws] = await tx.select({ cal: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
    const projects = await tx.select().from(s.projects).where(and(eq(s.projects.workspaceId, tenant.workspaceId), isNull(s.projects.deletedAt), isNull(s.projects.archivedAt)));
    const mine = onlyCalendarId ? projects.filter((p) => (p.holidayCalendarId ?? ws?.cal ?? null) === onlyCalendarId) : projects;
    const out: CalendarSnapshot[] = [];
    for (const project of mine) out.push({ project, previous: await WorkCalendar.load(tx, project) });
    return out;
  }

  /** คิด Plan End ใหม่หลังแก้ปฏิทินแล้ว (เรียกในธุรกรรมเดียวกัน) · คืน events ให้ผู้เรียกส่งหลัง commit */
  async recalculate(tx: Tx, auth: AuthInfo, snap: CalendarSnapshot[]) {
    const events: DomainEvent[] = [];
    let issues = 0;
    let projects = 0;
    for (const { project, previous } of snap) {
      const r = await recalculatePlanEnds(tx, project, { previous, actorId: auth.userId });
      if (r.changes.length) projects++;
      issues += r.changes.length;
      events.push(...r.events);
    }
    return { events, recalculated: { projects, issues } satisfies Recalculated };
  }

  // ---------------------------------------------------------------------------
  // ปฏิทิน
  // ---------------------------------------------------------------------------

  async listCalendars(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const def = await this.defaultId(tx, tenant);
      const rows = await tx.select().from(s.holidayCalendars).orderBy(asc(s.holidayCalendars.name));
      const counts = rows.length
        ? await tx.select({ id: s.holidays.calendarId, n: sql<number>`count(*)::int` }).from(s.holidays).where(inArray(s.holidays.calendarId, rows.map((r) => r.id))).groupBy(s.holidays.calendarId)
        : [];
      const n = new Map(counts.map((c) => [c.id, c.n]));
      return {
        items: rows.map((r) => ({ id: r.id, name: r.name, source: r.source, holidayCount: n.get(r.id) ?? 0, isDefault: r.id === def, editable: r.workspaceId === tenant.workspaceId })),
      };
    });
  }

  async createCalendar(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateCalendarBody>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const [dup] = await tx.select({ id: s.holidayCalendars.id }).from(s.holidayCalendars).where(and(eq(s.holidayCalendars.workspaceId, tenant.workspaceId), sql`lower(${s.holidayCalendars.name}) = lower(${input.name})`));
      if (dup) throw new AppError(409, 'calendar_name_taken', 'มีปฏิทินชื่อนี้แล้ว');
      let copy: { date: string; name: string; kind: 'bank' | 'company' }[] = [];
      if (input.copyFromId) {
        const [src] = await tx.select().from(s.holidayCalendars).where(eq(s.holidayCalendars.id, input.copyFromId));
        if (!src) throw notFound('ปฏิทินต้นทาง');
        copy = await tx.select({ date: s.holidays.date, name: s.holidays.name, kind: s.holidays.kind }).from(s.holidays).where(eq(s.holidays.calendarId, src.id));
      }
      const [cal] = await tx.insert(s.holidayCalendars).values({ workspaceId: tenant.workspaceId, name: input.name, source: 'custom' }).returning();
      if (copy.length) await tx.insert(s.holidays).values(copy.map((h) => ({ ...h, calendarId: cal.id })));
      await audit(tx, auth, tenant, 'plan', 'calendar.created', `สร้างปฏิทิน ${cal.name}${copy.length ? ` (คัดลอก ${copy.length} วัน)` : ''}`, { type: 'holiday_calendar', id: cal.id });
      return { id: cal.id, name: cal.name, source: cal.source, holidayCount: copy.length, isDefault: false, editable: true };
    });
  }

  async removeCalendar(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cal = await this.ownCalendar(tx, tenant, id);
      if ((await this.defaultId(tx, tenant)) === cal.id) throw new AppError(409, 'calendar_in_use', 'ปฏิทินนี้เป็นค่าเริ่มต้นของ Workspace · เลือกปฏิทินอื่นเป็นค่าเริ่มต้นก่อน');
      const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.projects).where(eq(s.projects.holidayCalendarId, cal.id));
      if (used.n) throw new AppError(409, 'calendar_in_use', `มี ${used.n} โปรเจกต์ใช้ปฏิทินนี้อยู่`, { projects: used.n });
      await tx.delete(s.holidayCalendars).where(eq(s.holidayCalendars.id, cal.id));
      await audit(tx, auth, tenant, 'plan', 'calendar.deleted', `ลบปฏิทิน ${cal.name}`, { type: 'holiday_calendar', id: cal.id });
      return { id: cal.id, deleted: true };
    });
  }

  // ---------------------------------------------------------------------------
  // วันหยุด
  // ---------------------------------------------------------------------------

  async listHolidays(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof HolidaysQuery>) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const calendarId = q.calendarId ?? (await this.defaultId(tx, tenant));
      if (!calendarId) return { calendarId: null, items: [] };
      const [cal] = await tx.select().from(s.holidayCalendars).where(eq(s.holidayCalendars.id, calendarId));
      if (!cal) throw notFound('ปฏิทิน');
      const from = q.from ?? (q.year ? `${q.year}-01-01` : undefined);
      const to = q.to ?? (q.year ? `${q.year}-12-31` : undefined);
      const rows = await tx
        .select()
        .from(s.holidays)
        .where(and(eq(s.holidays.calendarId, calendarId), from ? gte(s.holidays.date, from) : undefined, to ? lte(s.holidays.date, to) : undefined))
        .orderBy(asc(s.holidays.date));
      return { calendarId, name: cal.name, editable: cal.workspaceId === tenant.workspaceId, items: rows.map((h) => ({ id: h.id, date: h.date, name: h.name, kind: h.kind })) };
    });
  }

  /** เพิ่มวันหยุด → คำนวณ Plan End ของโปรเจกต์ที่ใช้ปฏิทินนี้ใหม่ */
  async addHoliday(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateHolidayBody>) {
    assertAdmin(tenant);
    let events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      const calendarId = input.calendarId ?? (await this.defaultId(tx, tenant));
      if (!calendarId) throw new AppError(409, 'calendar_required', 'ยังไม่มีปฏิทินเริ่มต้น · สร้างปฏิทินก่อน');
      const cal = await this.ownCalendar(tx, tenant, calendarId);
      const snap = await this.snapshot(tx, tenant, cal.id);
      const [dup] = await tx.select({ id: s.holidays.id }).from(s.holidays).where(and(eq(s.holidays.calendarId, cal.id), eq(s.holidays.date, input.date)));
      if (dup) throw new AppError(409, 'holiday_exists', `วันที่ ${input.date} มีในปฏิทินนี้แล้ว`);
      const [row] = await tx.insert(s.holidays).values({ calendarId: cal.id, date: input.date, name: input.name, kind: input.kind }).returning();
      const r = await this.recalculate(tx, auth, snap);
      events = r.events;
      await audit(tx, auth, tenant, 'plan', 'holiday.added', `${cal.name}: เพิ่มวันหยุด ${row.date} ${row.name} · คำนวณแผนใหม่ ${r.recalculated.issues} งาน`, { type: 'holiday', id: row.id });
      return { holiday: { id: row.id, calendarId: cal.id, date: row.date, name: row.name, kind: row.kind }, recalculated: r.recalculated };
    });
    await this.events.publish(events);
    return result;
  }

  async removeHoliday(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    let events: DomainEvent[] = [];
    const result = await this.db.run(auth, tenant, async (tx) => {
      if (!z.uuid().safeParse(id).success) throw notFound('วันหยุด');
      const [row] = await tx.select().from(s.holidays).where(eq(s.holidays.id, id));
      if (!row) throw notFound('วันหยุด');
      const cal = await this.ownCalendar(tx, tenant, row.calendarId);
      const snap = await this.snapshot(tx, tenant, cal.id);
      await tx.delete(s.holidays).where(eq(s.holidays.id, row.id));
      const r = await this.recalculate(tx, auth, snap);
      events = r.events;
      await audit(tx, auth, tenant, 'plan', 'holiday.removed', `${cal.name}: ลบวันหยุด ${row.date} ${row.name} · คำนวณแผนใหม่ ${r.recalculated.issues} งาน`, { type: 'holiday', id: row.id });
      return { id: row.id, deleted: true, recalculated: r.recalculated };
    });
    await this.events.publish(events);
    return result;
  }

  // ---------------------------------------------------------------------------

  async defaultId(tx: Tx, tenant: TenantInfo) {
    const [ws] = await tx.select({ cal: s.workspaceSettings.holidayCalendarId }).from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, tenant.workspaceId));
    return ws?.cal ?? null;
  }

  /** ปฏิทินของ Workspace นี้ที่แก้ได้ · ปฏิทินของระบบ (ธปท.) แก้ไม่ได้ ให้คัดลอกเป็นของตัวเองก่อน */
  private async ownCalendar(tx: Tx, tenant: TenantInfo, id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('ปฏิทิน');
    const [cal] = await tx.select().from(s.holidayCalendars).where(eq(s.holidayCalendars.id, id));
    if (!cal) throw notFound('ปฏิทิน');
    if (cal.workspaceId !== tenant.workspaceId) throw new AppError(409, 'calendar_readonly', 'ปฏิทินของระบบแก้ไม่ได้ · คัดลอกเป็นปฏิทินของ Workspace ก่อน (POST holiday-calendars พร้อม copyFromId)');
    return cal;
  }
}
