import { schema, type Tx } from '@friday/db';
import { eq, gte, inArray, and } from 'drizzle-orm';

const { holidays, projectHolidays, workspaceSettings } = schema;

/**
 * ปฏิทินวันทำการของโปรเจกต์ (docs/decisions.md › ธรรมเนียมการวางแผน)
 * วันทำงานตาม Workspace (ค่าเริ่มต้น จ.–ศ.) ไม่รวมวันหยุดในปฏิทินหลัก (ธปท.) และวันหยุดเฉพาะโปรเจกต์
 */
export class WorkCalendar {
  constructor(
    private readonly workDays: Set<number>,
    private readonly off: Set<string>,
  ) {}

  static async load(tx: Tx, p: { id: string; workspaceId: string; holidayCalendarId: string | null }, from = '2000-01-01') {
    const [ws] = await tx
      .select({ workDays: workspaceSettings.workDays, calendarId: workspaceSettings.holidayCalendarId })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, p.workspaceId));
    const calendarIds = [p.holidayCalendarId ?? ws?.calendarId].filter((x): x is string => !!x);
    const off = new Set<string>();
    if (calendarIds.length) {
      const rows = await tx.select({ date: holidays.date }).from(holidays).where(and(inArray(holidays.calendarId, calendarIds), gte(holidays.date, from)));
      rows.forEach((r) => off.add(r.date));
    }
    const own = await tx.select({ date: projectHolidays.date }).from(projectHolidays).where(eq(projectHolidays.projectId, p.id));
    own.forEach((r) => off.add(r.date));
    return new WorkCalendar(new Set(ws?.workDays ?? [1, 2, 3, 4, 5]), off);
  }

  isWorkingDay(date: string) {
    const d = new Date(`${date}T00:00:00Z`);
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    return this.workDays.has(iso) && !this.off.has(date);
  }

  /** วันนี้ถ้าเป็นวันทำการ ไม่อย่างนั้นวันทำการถัดไป */
  onOrAfter(date: string) {
    let d = date;
    for (let i = 0; i < 366 && !this.isWorkingDay(d); i++) d = addDays(d, 1);
    return d;
  }

  /** วันทำการที่ n โดยนับ start เป็นวันที่ 1 (start ต้องเป็นวันทำการ) */
  nthWorkingDay(start: string, n: number) {
    let d = start;
    let count = 1;
    while (count < n) {
      d = addDays(d, 1);
      if (this.isWorkingDay(d)) count++;
    }
    return d;
  }
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Plan End = วันทำการที่ (Man-Day) นับ Plan Start เป็นวันแรก · ตรงกับสูตรในไฟล์แผนขององค์กร
 * WORKDAY(Plan Start - 1, Man-Day, Holidays) · จำนวน Dev ไม่ทำให้วันจบเปลี่ยน
 * (Man-Day ของทั้งทีมแบ่งเท่ากันต่อคนเฉพาะตอนคิด Workload) · Man-Day เศษปัดขึ้นเป็นวันเต็ม
 */
export function planEndFor(cal: WorkCalendar, planStart: string, estimateMd: number) {
  return cal.nthWorkingDay(planStart, Math.max(1, Math.ceil(estimateMd)));
}
