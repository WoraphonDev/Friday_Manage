import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { type BotHoliday, BotHolidaysClient } from './bot-holidays.js';
import { SupportSettingsService } from './settings.service.js';

const s = schema;
type Row = Record<string, unknown>;
const isoDate = z.iso.date();
const Year = z.number().int().min(2000).max(2100);
const Options = { recalc: z.boolean().default(true), sla: z.boolean().default(true) };
export const HolidaysQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
export const BotPreviewBody = z.object({ year: Year }).strict();
export const BotApplyBody = z.object({ year: Year, ...Options }).strict();
export const ImpactBody = z.object({ dates: z.array(isoDate).min(1).max(100) }).strict();
export const AddHolidayBody = z.object({ date: isoDate, name: z.string().trim().min(1, 'กรอกชื่อวันหยุด').max(120), ...Options }).strict();
export const RemoveHolidayQuery = z.object({ recalc: z.enum(['0', '1']).default('1'), sla: z.enum(['0', '1']).default('1') });

/** คิวคำนวณ Plan End ใหม่ที่ API ลูกค้ารับไปทำ (apps/api/src/help/system-calendar.ts อ่าน key เดียวกัน) */
export const HOLIDAY_RECALC_KEY = 'holiday_recalc';
const CALENDAR_NAME = 'วันหยุดสถาบันการเงิน (ธปท.)';
const SYNC_HOUR = 6;
const BKK = 7 * 3_600_000;

export interface Impact {
  projects: number;
  workspaces: number;
  issues: number;
}
type DiffKind = 'new' | 'changed' | 'removed' | 'renamed' | 'origin' | 'same';
interface DiffItem {
  kind: DiffKind;
  date: string;
  name: string;
  /** วันที่เดิมของวันหยุดที่ ธปท. เลื่อน (เช่น วันชดเชย) */
  from?: string;
}

/**
 * ปฏิทินวันหยุดของระบบ (รอบ 4 · S1–S2) = holiday_calendars ที่ workspace_id ว่าง
 * SLA ของ Support ปฏิทินโปรเจกต์ลูกค้าที่ใช้ "ปฏิทินของระบบ" และปุ่มนำเข้าของลูกค้าอ่านจากที่นี่
 * เขียนผ่าน OPS_DB (friday_worker ข้าม RLS · friday_app เขียนปฏิทินของระบบไม่ได้)
 * Plan End ของงานลูกค้าคำนวณด้วย logic ของ API ลูกค้า (recalculatePlanEnds) ซึ่ง ops-api import ไม่ได้
 * จึงเขียนวันที่เปลี่ยนเข้าคิวใน ops_settings › holiday_recalc แล้วงานทุก 1 นาทีของ API ลูกค้ารับไปคำนวณ
 */
@Injectable()
export class HolidaysService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SystemHolidays');
  private timer?: NodeJS.Timeout;
  private lastAttempt?: string;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly settings: SupportSettingsService,
    private readonly bot: BotHolidaysClient,
  ) {}

  onModuleInit() {
    // ดึงประกาศ ธปท. ทุกเช้า 06:00 (ตรวจทุก 10 นาที · รันครั้งเดียวต่อวัน) · test เรียก daily() เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.daily().catch((e) => this.log.error(String(e))), 600_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T = Row>(q: SQL, db: Db | Tx = this.db) {
    const r = await db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** ปฏิทินหลักของระบบ (ที่ ธปท. ก่อน) · ยังไม่มีก็สร้าง */
  private async calendar(db: Db | Tx = this.db) {
    const [c] = await this.rows<{ id: string; syncedAt: string | null; syncError: string | null }>(sql`
      select id, synced_at as "syncedAt", sync_error as "syncError" from holiday_calendars where workspace_id is null order by (source = 'bot') desc, created_at limit 1`, db);
    if (c) return c;
    const [n] = await db.insert(s.holidayCalendars).values({ name: CALENDAR_NAME, source: 'bot' }).returning({ id: s.holidayCalendars.id });
    return { id: n.id, syncedAt: null, syncError: null };
  }

  /** "เวลา · ข้อความ" → เวลาที่เริ่มดึงไม่สำเร็จ + สาเหตุ */
  private static failure(syncError: string | null) {
    if (!syncError) return null;
    const i = syncError.indexOf(' · ');
    const since = i > 0 ? syncError.slice(0, i) : null;
    return since && !Number.isNaN(Date.parse(since)) ? { since, message: syncError.slice(i + 3) } : { since: null, message: syncError };
  }

  /** สถานะ + วันหยุดของปี (ไม่ระบุปี = ตั้งแต่วันนี้ไปอีก 1 ปี) */
  async list(q: z.infer<typeof HolidaysQuery>) {
    const cal = await this.calendar();
    const range = q.year ? sql`h.date between ${`${q.year}-01-01`}::date and ${`${q.year}-12-31`}::date` : sql`h.date >= (now() at time zone 'Asia/Bangkok')::date and h.date <= (now() at time zone 'Asia/Bangkok')::date + 400`;
    const items = await this.rows<{ date: string; name: string; origin: string }>(sql`
      select distinct on (h.date) h.date::text as date, h.name, coalesce(h.origin, 'bot') as origin
      from holidays h join holiday_calendars c on c.id = h.calendar_id
      where c.workspace_id is null and ${range}
      order by h.date, (c.id = ${cal.id}) desc`);
    return { configured: this.bot.configured, syncedAt: cal.syncedAt, failure: HolidaysService.failure(cal.syncError), year: q.year ?? null, items };
  }

  /** โปรเจกต์ / Workspace ที่ใช้ปฏิทินของระบบ และงานค้างที่ช่วง Plan Start–End คร่อมวันที่เปลี่ยน */
  async impact(dates: string[]): Promise<Impact> {
    const list = dates.length ? sql`array[${sql.join(dates.map((d) => sql`${d}`), sql`, `)}]::date[]` : sql`array[]::date[]`;
    const [r] = await this.rows<Impact>(sql`
      with p as (
        select p.id, p.workspace_id from projects p left join workspace_settings ws on ws.workspace_id = p.workspace_id
        where p.deleted_at is null and p.archived_at is null
          and coalesce(p.holiday_calendar_id, ws.holiday_calendar_id) in (select id from holiday_calendars where workspace_id is null))
      select (select count(*)::int from p) as projects, (select count(distinct workspace_id)::int from p) as workspaces,
        (select count(*)::int from issues i join workflow_statuses st on st.id = i.status_id
          where i.project_id in (select id from p) and i.deleted_at is null and st.category not in ('done', 'cancelled')
            and i.plan_start is not null and i.plan_end is not null
            and exists (select 1 from unnest(${list}) d where d between i.plan_start and i.plan_end)) as issues`);
    return r;
  }

  // ── ดึงจาก ธปท. ─────────────────────────────────────────

  private async fetch(year: number) {
    if (!this.bot.configured) throw new AppError(409, 'bot_not_configured', 'ยังไม่ได้ตั้ง Client ID ของ API ธปท. (BOT_API_CLIENT_ID) · เพิ่มวันหยุดเองได้');
    try {
      return await this.bot.fetchYear(year);
    } catch (e) {
      const cal = await this.calendar();
      const since = HolidaysService.failure(cal.syncError)?.since ?? new Date().toISOString();
      const message = (e as Error).message.slice(0, 300);
      await this.db.update(s.holidayCalendars).set({ syncError: `${since} · ${message}` }).where(eq(s.holidayCalendars.id, cal.id));
      throw new AppError(502, 'bot_fetch_failed', `ดึงวันหยุดจาก ธปท. ไม่สำเร็จ · ${message}`, { since });
    }
  }

  /** เทียบประกาศกับปฏิทินของระบบ · วันหยุดที่เพิ่มเองไม่ถูกลบตอนดึง (ถ้า ธปท. ประกาศวันเดียวกัน ป้ายเปลี่ยนเป็น ธปท.) */
  private async diff(calendarId: string, year: number, fetched: BotHoliday[], db: Db | Tx = this.db) {
    const current = await this.rows<{ date: string; name: string; origin: string | null }>(sql`
      select date::text as date, name, origin from holidays where calendar_id = ${calendarId} and date between ${`${year}-01-01`}::date and ${`${year}-12-31`}::date`, db);
    const byDate = new Map(current.map((h) => [h.date, h]));
    const got = new Set(fetched.map((h) => h.date));
    const removed = current.filter((h) => (h.origin ?? 'bot') === 'bot' && !got.has(h.date));
    const items: DiffItem[] = [];
    for (const h of fetched) {
      const c = byDate.get(h.date);
      if (!c) {
        const moved = removed.find((r) => r.name === h.name);
        items.push(moved ? { kind: 'changed', date: h.date, name: h.name, from: moved.date } : { kind: 'new', date: h.date, name: h.name });
      } else if ((c.origin ?? 'bot') !== 'bot') items.push({ kind: 'origin', date: h.date, name: h.name });
      else items.push({ kind: c.name === h.name ? 'same' : 'renamed', date: h.date, name: h.name });
    }
    const movedFrom = new Set(items.flatMap((i) => (i.from ? [i.from] : [])));
    for (const r of removed) if (!movedFrom.has(r.date)) items.push({ kind: 'removed', date: r.date, name: r.name });
    const order: Record<DiffKind, number> = { new: 0, changed: 0, removed: 1, renamed: 2, origin: 3, same: 4 };
    items.sort((a, b) => order[a.kind] - order[b.kind] || a.date.localeCompare(b.date));
    const added = items.filter((i) => i.kind === 'new' || i.kind === 'changed').map((i) => i.date);
    const gone = removed.map((r) => r.date).sort();
    return { items, added, removed: gone, changed: items.filter((i) => i.kind !== 'same').length };
  }

  /** S2 · ดึงแล้วแสดงก่อนบันทึก (ยังไม่เขียน) */
  async botPreview(year: number) {
    const fetched = await this.fetch(year);
    const cal = await this.calendar();
    const d = await this.diff(cal.id, year, fetched);
    const dates = [...d.added, ...d.removed];
    return {
      year,
      total: fetched.length,
      items: d.items,
      counts: Object.fromEntries((['new', 'changed', 'removed', 'renamed', 'origin', 'same'] as const).map((k) => [k, d.items.filter((i) => i.kind === k).length])),
      impact: await this.impact(dates),
      changedDates: dates.length,
    };
  }

  /** บันทึกประกาศของปี · staff = null คืองานอัตโนมัติ 06:00 */
  async botApply(staff: Staff | null, input: z.infer<typeof BotApplyBody>) {
    const fetched = await this.fetch(input.year);
    const r = await this.db.transaction(async (tx) => {
      const cal = await this.calendar(tx);
      const d = await this.diff(cal.id, input.year, fetched, tx);
      for (const i of d.items) {
        if (i.kind === 'same') continue;
        if (i.kind === 'removed') {
          await tx.delete(s.holidays).where(and(eq(s.holidays.calendarId, cal.id), eq(s.holidays.date, i.date)));
          continue;
        }
        if (i.from) await tx.delete(s.holidays).where(and(eq(s.holidays.calendarId, cal.id), eq(s.holidays.date, i.from)));
        await tx
          .insert(s.holidays)
          .values({ calendarId: cal.id, date: i.date, name: i.name, kind: 'bank', origin: 'bot' })
          .onConflictDoUpdate({ target: [s.holidays.calendarId, s.holidays.date], set: { name: i.name, origin: 'bot' } });
      }
      await tx.update(s.holidayCalendars).set({ syncedAt: new Date(), syncError: null }).where(eq(s.holidayCalendars.id, cal.id));
      const changed = [...d.added, ...d.removed];
      if (changed.length && input.recalc) await this.enqueueRecalc(tx, cal.id, d.added, d.removed, staff);
      if (d.changed) {
        await staffAudit(tx, staff, 'support.holidays_synced', `ปฏิทินวันหยุดของระบบ ปี ${input.year} ตามประกาศ ธปท. · ใหม่ ${d.added.length} · ยกเลิก ${d.removed.length} · ทั้งหมด ${fetched.length} วัน${changed.length && input.recalc ? ' · คำนวณ Plan End ใหม่' : ''}`, { type: 'holiday_calendar', id: cal.id });
      }
      return { saved: fetched.length, added: d.added, removed: d.removed, changed: d.changed };
    });
    this.settings.forgetHolidays();
    const slaUpdated = input.sla && r.added.length + r.removed.length ? await this.recomputeSla() : 0;
    return { ...r, slaUpdated };
  }

  // ── เพิ่ม / ลบเอง ────────────────────────────────────────

  /** เพิ่มวันหยุดพิเศษ (เช่น มติ ครม. ที่ ธปท. ยังไม่ประกาศ) · ป้าย "เพิ่มเอง" */
  async add(staff: Staff, input: z.infer<typeof AddHolidayBody>) {
    const r = await this.db.transaction(async (tx) => {
      const cal = await this.calendar(tx);
      const [dup] = await this.rows(sql`select 1 from holidays h join holiday_calendars c on c.id = h.calendar_id where c.workspace_id is null and h.date = ${input.date}::date`, tx);
      if (dup) throw new AppError(409, 'holiday_exists', 'มีวันหยุดวันนี้ในปฏิทินของระบบแล้ว');
      await tx.insert(s.holidays).values({ calendarId: cal.id, date: input.date, name: input.name, kind: 'bank', origin: 'manual' });
      if (input.recalc) await this.enqueueRecalc(tx, cal.id, [input.date], [], staff);
      await staffAudit(tx, staff, 'support.holiday_added', `เพิ่มวันหยุดของระบบ ${input.date} ${input.name}${input.recalc ? ' · คำนวณ Plan End ใหม่' : ''}`, { type: 'holiday_calendar', id: cal.id });
      return { date: input.date, name: input.name, origin: 'manual' };
    });
    this.settings.forgetHolidays();
    return { holiday: r, slaUpdated: input.sla ? await this.recomputeSla() : 0 };
  }

  /** ลบได้เฉพาะวันที่เพิ่มเอง · วันจาก ธปท. แก้ด้วยการดึงประกาศใหม่ */
  async remove(staff: Staff, date: string, q: z.infer<typeof RemoveHolidayQuery>) {
    if (!isoDate.safeParse(date).success) throw new AppError(404, 'not_found', 'ไม่พบวันหยุด');
    const r = await this.db.transaction(async (tx) => {
      const cal = await this.calendar(tx);
      const [h] = await tx.select().from(s.holidays).where(and(eq(s.holidays.calendarId, cal.id), eq(s.holidays.date, date)));
      if (!h) throw new AppError(404, 'not_found', 'ไม่พบวันหยุด');
      if ((h.origin ?? 'bot') === 'bot') throw new AppError(409, 'holiday_from_bot', 'วันหยุดจากประกาศ ธปท. ลบเองไม่ได้ · ดึงประกาศล่าสุดแทน');
      await tx.delete(s.holidays).where(eq(s.holidays.id, h.id));
      if (q.recalc === '1') await this.enqueueRecalc(tx, cal.id, [], [date], staff);
      await staffAudit(tx, staff, 'support.holiday_removed', `ลบวันหยุดที่เพิ่มเอง ${date} ${h.name}${q.recalc === '1' ? ' · คำนวณ Plan End ใหม่' : ''}`, { type: 'holiday_calendar', id: cal.id });
      return { date, deleted: true };
    });
    this.settings.forgetHolidays();
    return { ...r, slaUpdated: q.sla === '1' ? await this.recomputeSla() : 0 };
  }

  /** ต่อท้ายคิวคำนวณ Plan End ใหม่ (API ลูกค้ารับไปทำทุก 1 นาที · ผลแจ้ง PM ผ่าน plan.changed) */
  private async enqueueRecalc(tx: Tx, calendarId: string, added: string[], removed: string[], staff: Staff | null) {
    const entry = JSON.stringify({ id: randomUUID(), calendarId, added, removed, at: new Date().toISOString(), by: staff?.name ?? null, done: [] });
    await tx.execute(sql`
      insert into ops_settings (key, value, updated_by) values (${HOLIDAY_RECALC_KEY}, jsonb_build_object('pending', jsonb_build_array(${entry}::jsonb)), ${staff?.id ?? null})
      on conflict (key) do update set value = jsonb_set(ops_settings.value, '{pending}', coalesce(ops_settings.value->'pending', '[]'::jsonb) || jsonb_build_array(${entry}::jsonb)), updated_by = excluded.updated_by`);
  }

  /** SLA ของ Ticket ที่เปิดอยู่คิดตามปฏิทินใหม่ (ด่วนนับ 24 ชม. ไม่ขึ้นกับวันหยุด จึงข้าม) */
  async recomputeSla() {
    this.settings.forgetHolidays();
    const list = await this.rows<{ id: string; priority: string; createdAt: Date; firstRespondedAt: Date | null; plan: string | null }>(sql`
      select k.id, k.priority, k.created_at as "createdAt", k.first_responded_at as "firstRespondedAt", p.code as plan
      from support_tickets k left join subscriptions sub on sub.workspace_id = k.workspace_id left join plans p on p.id = sub.plan_id
      where k.status in ('open', 'pending_customer', 'pending_dev') and k.priority <> 'urgent'`);
    let n = 0;
    for (const k of list) {
      const due = await this.settings.due(k.plan ?? 'free', k.priority, new Date(k.createdAt));
      await this.db
        .update(s.supportTickets)
        .set({ ...(k.firstRespondedAt ? {} : { firstResponseDueAt: due.first }), resolutionDueAt: due.resolve })
        .where(eq(s.supportTickets.id, k.id));
      n++;
    }
    return n;
  }

  /**
   * งานทุกเช้า 06:00 (เวลาไทย): ดึงปีนี้ · ธ.ค. ดึงปีถัดไปด้วย · ไม่ถาม (คำนวณ Plan End และ SLA ใหม่เลย)
   * มีวันเปลี่ยนแจ้งหัวหน้าทีม Support / Owner ทางอีเมล · ดึงไม่สำเร็จ = ป้ายแดงในหน้าตั้งค่า ใช้ข้อมูลเดิมต่อ
   */
  async daily(now = new Date()) {
    if (!this.bot.configured) return { ran: false };
    const local = new Date(now.getTime() + BKK);
    const today = local.toISOString().slice(0, 10);
    if (local.getUTCHours() < SYNC_HOUR || this.lastAttempt === today) return { ran: false };
    const cal = await this.calendar();
    if (cal.syncedAt && new Date(new Date(cal.syncedAt).getTime() + BKK).toISOString().slice(0, 10) === today) return { ran: false };
    this.lastAttempt = today;
    const year = local.getUTCFullYear();
    const years = local.getUTCMonth() === 11 ? [year, year + 1] : [year];
    const changes: string[] = [];
    for (const y of years) {
      try {
        const r = await this.botApply(null, { year: y, recalc: true, sla: true });
        if (r.added.length || r.removed.length) changes.push(`ปี ${y}: ใหม่ ${r.added.join(', ') || '—'} · ยกเลิก ${r.removed.join(', ') || '—'}`);
      } catch (e) {
        this.log.warn(`ดึงวันหยุด ธปท. ปี ${y} ไม่สำเร็จ: ${(e as Error).message}`);
      }
    }
    if (changes.length) await this.settings.notifyLeads('[Support] วันหยุดจาก ธปท. เปลี่ยน', `ปฏิทินวันหยุดของระบบอัปเดตตามประกาศ ธปท. แล้ว\n${changes.join('\n')}\nPlan End ของงานลูกค้าที่ใช้ปฏิทินของระบบและ SLA ของ Ticket คำนวณใหม่แล้ว`);
    return { ran: true, changes };
  }
}
