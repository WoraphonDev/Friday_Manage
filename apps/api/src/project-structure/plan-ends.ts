import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { TenantInfo } from '../common/request.js';
import type { DomainEvent } from '../core/events.js';
import { addDays, planEndFor, WorkCalendar } from '../projects/calendar.js';
import type { ProjectRow } from '../projects/projects.service.js';
import { issueEvent } from './context.js';

export const HOLIDAY_CHANGE_REASON = 'วันหยุดเปลี่ยน';

export interface PlanEndChange {
  issueId: string;
  key: string;
  planStart: { from: string; to: string } | null;
  planEnd: { from: string; to: string };
}

interface RecalcOptions {
  /**
   * ปฏิทินก่อนแก้วันหยุด (โหลดด้วย WorkCalendar.load ก่อนเพิ่ม / ลบ) · ใช้รักษาจำนวนวันทำการของแต่ละงานไว้
   * ไม่ส่ง = คิดใหม่จาก Man-Day ตามสูตร WORKDAY เฉพาะงานที่ไม่มี Sub-task และมี Man-Day
   */
  previous?: WorkCalendar;
  /** ผู้แก้ (null = ระบบ เช่น Job ที่ A18 เรียกเมื่อวันหยุดของ Workspace เปลี่ยน) */
  actorId?: string | null;
  reason?: string;
}

/**
 * คำนวณ Plan End ใหม่ของงานที่ยังไม่เสร็จหลังวันหยุดเปลี่ยน · เรียกในธุรกรรมเดียวกับที่แก้วันหยุด
 * - งานที่ช่วง Plan Start–End คร่อมวันที่เปลี่ยนเท่านั้น: จำนวนวันทำการเท่าเดิม แต่นับบนปฏิทินใหม่ (จำนวน Dev ไม่มีผล)
 * - Plan Start ที่กลายเป็นวันหยุด เลื่อนไปวันทำงานถัดไป (กติกาข้อมูลข้อ 4)
 * - หลังมี Baseline เขียน plan_changes เหตุผล "วันหยุดเปลี่ยน" ทุกฟิลด์ที่เปลี่ยน
 * คืน events ให้ผู้เรียกส่งด้วย EventBus.publish หลัง commit
 */
export async function recalculatePlanEnds(tx: Tx, project: ProjectRow, opts: RecalcOptions = {}) {
  const reason = opts.reason ?? HOLIDAY_CHANGE_REASON;
  const actorId = opts.actorId ?? null;
  const cal = await WorkCalendar.load(tx, project);

  // ล็อกแถวไว้กันการแก้ชนกับคำขอ PATCH ที่เข้ามาพร้อมกัน
  const rows = await tx
    .select({ issue: s.issues })
    .from(s.issues)
    .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
    .where(and(
      eq(s.issues.projectId, project.id),
      isNull(s.issues.deletedAt),
      ne(s.workflowStatuses.category, 'done'),
      isNotNull(s.issues.planStart),
      isNotNull(s.issues.planEnd),
    ))
    .orderBy(asc(s.issues.number))
    .for('update', { of: s.issues });
  const issues = rows.map((r) => r.issue);

  let parents = new Set<string>();
  if (!opts.previous && issues.length) {
    const children = await tx
      .selectDistinct({ parentId: s.issues.parentId })
      .from(s.issues)
      .where(and(inArray(s.issues.parentId, issues.map((i) => i.id)), isNull(s.issues.deletedAt)));
    parents = new Set(children.map((c) => c.parentId!));
  }

  const changes: PlanEndChange[] = [];
  const updated: (typeof issues)[number][] = [];
  for (const issue of issues) {
    const start = issue.planStart!;
    const end = issue.planEnd!;
    let nextStart = start;
    let nextEnd = end;
    if (opts.previous) {
      const old = opts.previous;
      if (!rangeChanged(old, cal, start, end)) continue;
      if (old.isWorkingDay(start) && !cal.isWorkingDay(start)) nextStart = cal.onOrAfter(start);
      const days = Math.max(1, old.workingDaysIn(start, end));
      nextEnd = cal.nthWorkingDay(cal.onOrAfter(nextStart), days);
    } else {
      // Task ที่มี Sub-task มีช่วงตามลูก สูตร Man-Day ใช้ไม่ได้
      if (issue.estimateMd === null || parents.has(issue.id)) continue;
      nextStart = cal.onOrAfter(start);
      nextEnd = planEndFor(cal, nextStart, issue.estimateMd);
    }
    if (nextStart === start && nextEnd === end) continue;
    changes.push({
      issueId: issue.id,
      key: `${project.key}-${issue.number}`,
      planStart: nextStart !== start ? { from: start, to: nextStart } : null,
      planEnd: { from: end, to: nextEnd },
    });
    updated.push(issue);
  }
  if (!changes.length) return { changes, events: [] as DomainEvent[] };

  const [baseline] = await tx
    .select({ id: s.planBaselines.id })
    .from(s.planBaselines)
    .where(eq(s.planBaselines.projectId, project.id))
    .orderBy(sql`${s.planBaselines.version} desc`)
    .limit(1);

  const events: DomainEvent[] = [];
  const tenant = { workspaceId: project.workspaceId } as TenantInfo;
  for (const [i, c] of changes.entries()) {
    const issue = updated[i];
    await tx
      .update(s.issues)
      .set({ planEnd: c.planEnd.to, ...(c.planStart ? { planStart: c.planStart.to } : {}) })
      .where(eq(s.issues.id, c.issueId));
    const fields = [...(c.planStart ? [{ field: 'planStart', oldValue: c.planStart.from, newValue: c.planStart.to }] : []), { field: 'planEnd', oldValue: c.planEnd.from, newValue: c.planEnd.to }];
    const base = { workspaceId: project.workspaceId, projectId: project.id, issueId: c.issueId };
    await tx.insert(s.activities).values(fields.map((f) => ({ ...base, actorId, actorKind: actorId ? ('user' as const) : ('system' as const), verb: 'updated', ...f })));
    if (baseline) {
      await tx.insert(s.planChanges).values(fields.map((f) => ({ ...base, baselineId: baseline.id, ...f, reason, changedBy: actorId })));
    }
    const ev = issueEvent(tenant, project, actorId, issue);
    const data = { fields: fields.map((f) => f.field), reason, source: 'holiday', planStart: c.planStart, planEnd: c.planEnd };
    events.push(ev('issue.updated', data));
    if (baseline) events.push(ev('plan.changed', data));
  }
  return { changes, events };
}

/** มีวันใดในช่วงที่สถานะวันทำการต่างกันระหว่างปฏิทินเก่ากับใหม่ */
function rangeChanged(old: WorkCalendar, next: WorkCalendar, start: string, end: string) {
  for (let d = start; d <= end; d = addDays(d, 1)) if (old.isWorkingDay(d) !== next.isWorkingDay(d)) return true;
  return false;
}
