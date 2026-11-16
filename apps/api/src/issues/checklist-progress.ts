import { schema as s, type Tx } from '@friday/db';
import { and, inArray, sql } from 'drizzle-orm';

/**
 * งานที่มี Checklist: Progress = สัดส่วนรายการที่ติ๊กแล้ว (ผู้ใช้ขอ 2026-11-16)
 * นับเฉพาะ Checklist (ขั้นตอนของผู้ทำงาน) ไม่นับ Acceptance criteria เพราะเป็นเกณฑ์ที่ QA ตรวจ
 * - checklist_pct: สัดส่วนที่ติ๊ก (null = ไม่มี Checklist) · Task ที่มี Sub-task นับเป็นอีกหนึ่งส่วนตอนเฉลี่ย (issueProgress)
 * - progress_pct: ตั้งเท่ากัน เพื่อให้หน้าที่อ่านค่านี้ตรง ๆ (Overview, รายงาน) เห็นค่าเดียวกับงานที่ไม่มีลูก
 * ลบ Checklist หมด: checklist_pct กลับเป็น null แต่ progress_pct ค่าล่าสุดยังอยู่และกลับมากรอกเองได้
 * คืน id ของงานที่ค่าเปลี่ยน
 */
export async function syncChecklistProgress(tx: Tx, issueIds: string[]): Promise<string[]> {
  if (!issueIds.length) return [];
  const pct = sql`(select round(100.0 * count(*) filter (where ${s.checklistItems.done}) / nullif(count(*), 0))::smallint
    from ${s.checklistItems} where ${s.checklistItems.issueId} = ${s.issues.id} and ${s.checklistItems.kind} = 'checklist')`;
  const rows = await tx
    .update(s.issues)
    .set({ checklistPct: pct, progressPct: sql`coalesce(${pct}, ${s.issues.progressPct})` })
    .where(and(inArray(s.issues.id, issueIds), sql`(${s.issues.checklistPct} is distinct from ${pct} or (${pct} is not null and ${s.issues.progressPct} is distinct from ${pct}))`))
    .returning({ id: s.issues.id });
  return rows.map((r) => r.id);
}

/** งานนี้มี Checklist (Progress จึงคำนวณให้ ไม่รับค่าที่กรอก) */
export const hasChecklist = (issue: { checklistPct: number | null }) => issue.checklistPct !== null;
