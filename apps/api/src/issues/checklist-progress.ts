import { schema as s, type Tx } from '@friday/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * งานที่มี Checklist: Progress = สัดส่วนรายการที่ติ๊กแล้ว (ผู้ใช้ขอ 2026-11-16)
 * นับเฉพาะ Checklist (ขั้นตอนของผู้ทำงาน) ไม่นับ Acceptance criteria เพราะเป็นเกณฑ์ที่ QA ตรวจ
 * เก็บลง issues.progress_pct เพื่อให้ทุกหน้าที่อ่านค่านี้ (ตาราง, Timeline, Overview, รายงาน) เห็นค่าเดียวกัน
 * งานที่มี Sub-task ยังคำนวณจาก Sub-task ตอนอ่านเหมือนเดิม · ลบ Checklist หมดแล้วค่าล่าสุดยังอยู่และกลับมากรอกเองได้
 * คืน id ของงานที่ค่าเปลี่ยน
 */
export async function syncChecklistProgress(tx: Tx, issueIds: string[]): Promise<string[]> {
  if (!issueIds.length) return [];
  const pct = tx
    .select({
      issueId: s.checklistItems.issueId,
      pct: sql<number>`round(100.0 * count(*) filter (where ${s.checklistItems.done}) / count(*))::smallint`.as('pct'),
    })
    .from(s.checklistItems)
    .where(and(inArray(s.checklistItems.issueId, issueIds), eq(s.checklistItems.kind, 'checklist')))
    .groupBy(s.checklistItems.issueId)
    .as('c');
  const rows = await tx
    .update(s.issues)
    .set({ progressPct: sql`${pct.pct}` })
    .from(pct)
    .where(and(eq(s.issues.id, pct.issueId), sql`${s.issues.progressPct} is distinct from ${pct.pct}`))
    .returning({ id: s.issues.id });
  return rows.map((r) => r.id);
}

/** งานนี้มี Checklist อย่างน้อยหนึ่งรายการ (Progress จึงคำนวณให้ ไม่รับค่าที่กรอก) */
export async function hasChecklist(tx: Tx, issueId: string) {
  const [r] = await tx.select({ id: s.checklistItems.id }).from(s.checklistItems)
    .where(and(eq(s.checklistItems.issueId, issueId), eq(s.checklistItems.kind, 'checklist'))).limit(1);
  return !!r;
}
