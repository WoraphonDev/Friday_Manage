import { schema, type Tx } from '@friday/db';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { addDays, WorkCalendar } from './calendar.js';

/**
 * วันครบกำหนดตามขั้นของงาน (ผู้ใช้ขอ 2026-11-13)
 * โปรเจกต์ที่แยก Dev / QA (progress_split): งานหมวด Review / QA ตัดสินด้วย QA Due ไม่ใช่ Plan End
 * เพราะ Dev ส่งงานแล้ว ถ้ายังใช้ Plan End งานจะขึ้นเลยกำหนดและโทษ Dev ทั้งที่รอ QA อยู่
 * โปรเจกต์อื่นได้ผลเหมือนเดิมทุกอย่าง (Plan End)
 */
export type DueStage = 'dev' | 'qa';

export interface DueRule {
  readonly split: boolean;
  readonly qaBufferDays: number;
  readonly cal: WorkCalendar | null;
  /** qaDueOf ถูกเรียกซ้ำกับ Plan End เดิมบ่อย (ทุกงานในโปรเจกต์) */
  readonly memo: Map<string, string>;
}

/** โปรเจกต์ที่ไม่ได้แยก Dev / QA */
export const PLAIN_DUE: DueRule = { split: false, qaBufferDays: 0, cal: null, memo: new Map() };

export interface DueProject {
  id: string;
  workspaceId: string;
  holidayCalendarId: string | null;
  progressSplit: boolean;
  qaBufferDays: number;
}

export interface DueIssue {
  planEnd: string | null;
  qaEnd?: string | null;
}

/** อ่านปฏิทินเฉพาะโปรเจกต์ที่แยก Dev / QA · โปรเจกต์อื่นไม่ต้องอ่านอะไรเพิ่ม · ส่ง cal มาได้ถ้าผู้เรียกอ่านไว้แล้ว */
export async function loadDueRule(tx: Tx, p: DueProject, loaded?: WorkCalendar): Promise<DueRule> {
  if (!p.progressSplit) return PLAIN_DUE;
  const cal = p.qaBufferDays > 0 ? (loaded ?? await WorkCalendar.load(tx, p)) : null;
  return { split: true, qaBufferDays: p.qaBufferDays, cal, memo: new Map() };
}

/** กฎของหลายโปรเจกต์ (Home, สรุปประจำวัน) · อ่าน progress_split จากตารางเมื่อผู้เรียกไม่มีค่า */
export async function loadDueRules(tx: Tx, projectIds: string[]): Promise<Map<string, DueRule>> {
  const out = new Map<string, DueRule>();
  const ids = [...new Set(projectIds)];
  if (!ids.length) return out;
  const rows = await tx
    .select({ id: schema.projects.id, workspaceId: schema.projects.workspaceId, holidayCalendarId: schema.projects.holidayCalendarId, progressSplit: schema.projects.progressSplit, qaBufferDays: schema.projects.qaBufferDays })
    .from(schema.projects)
    .where(inArray(schema.projects.id, ids));
  for (const p of rows) out.set(p.id, await loadDueRule(tx, p));
  return out;
}

/**
 * วันที่ QA ต้องทดสอบเสร็จ: ค่าที่กรอก หรือ Plan End + N วันทำการ
 * ไม่ก่อน Plan End เสมอ (Dev ถูกเลื่อน Due ไปหลัง QA Due ที่กรอกไว้ ก็ยังไม่ถือว่า QA ช้ากว่า Dev)
 */
export function qaDueOf(rule: DueRule, i: DueIssue): string | null {
  if (!rule.split) return null;
  if (!i.planEnd) return i.qaEnd ?? null;
  if (i.qaEnd) return i.qaEnd > i.planEnd ? i.qaEnd : i.planEnd;
  if (!rule.cal || rule.qaBufferDays <= 0) return i.planEnd;
  let d = rule.memo.get(i.planEnd);
  if (!d) {
    d = rule.cal.nthWorkingDay(rule.cal.onOrAfter(addDays(i.planEnd, 1)), rule.qaBufferDays);
    rule.memo.set(i.planEnd, d);
  }
  return d;
}

/** งานที่ Dev ส่งให้ QA แล้วแต่ยังไม่ Done */
export const inQaStage = (rule: DueRule, category: string) => rule.split && category === 'review';

/**
 * วันที่ใช้ตัดสินว่างานเลยกำหนดไหม และเลยในขั้นไหน
 * ผู้เรียกยังตัดงาน Done / Cancelled เองตามเดิม (ฟังก์ชันนี้ไม่เปลี่ยนเกณฑ์ "เสร็จ")
 */
export function dueOf(rule: DueRule, i: DueIssue, category: string): { date: string | null; stage: DueStage | null } {
  if (!rule.split) return { date: i.planEnd, stage: null };
  if (inQaStage(rule, category)) return { date: qaDueOf(rule, i), stage: 'qa' };
  return { date: i.planEnd, stage: 'dev' };
}

/** วันครบกำหนดที่ใช้ตัดสิน (ย่อของ dueOf().date) */
export const dueDateOf = (rule: DueRule, i: DueIssue, category: string) => dueOf(rule, i, category).date;

/**
 * Plan End ที่ช้าที่สุดซึ่ง QA Due อัตโนมัติ (Plan End + N วันทำการ) ยังก่อน now
 * ใช้ทำเงื่อนไข SQL โดยไม่ต้องคำนวณวันทำการในฐานข้อมูล: QA Due อัตโนมัติเพิ่มตาม Plan End เสมอ
 */
export function autoQaLateCutoff(rule: DueRule, now: string): string {
  if (!rule.cal || rule.qaBufferDays <= 0) return addDays(now, -1);
  // วันทำการที่ N นับถอยจากเมื่อวาน = QA Due ล่าสุดที่ยังเลยกำหนด · Plan End ต้องอยู่ก่อนวันทำการแรกของช่วงนั้น
  let d = addDays(now, -1);
  let found = 0;
  for (let i = 0; i < 400; i++, d = addDays(d, -1)) {
    if (rule.cal.isWorkingDay(d) && ++found === rule.qaBufferDays) break;
  }
  return addDays(d, -1);
}

/**
 * เงื่อนไข SQL "งานค้างที่เลยกำหนด" ตามกฎของโปรเจกต์ · ต้อง join workflow_statuses ไว้แล้ว
 * โปรเจกต์อื่นได้เงื่อนไขเดิม: plan_end < วันนี้
 */
export function lateSql(rule: DueRule, now: string): SQL {
  const { issues, workflowStatuses } = schema;
  if (!rule.split) return sql`${issues.planEnd} < ${now}`;
  const qaLate = sql`(case when ${issues.qaEnd} is not null then greatest(${issues.qaEnd}, ${issues.planEnd}) < ${now} else ${issues.planEnd} <= ${autoQaLateCutoff(rule, now)} end)`;
  return sql`(case when ${workflowStatuses.category} = 'review' then ${qaLate} else ${issues.planEnd} < ${now} end)`;
}
