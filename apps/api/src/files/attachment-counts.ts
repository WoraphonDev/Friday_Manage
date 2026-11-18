import { schema as s, type Tx } from '@friday/db';
import { and, inArray, isNull, sql } from 'drizzle-orm';

/**
 * จำนวนไฟล์ของงานสำหรับไอคอนคลิปบนการ์ด / รายการ (ผู้ใช้ตกลง 2026-11-18)
 * นับ: ไฟล์แนบของงาน + รายงาน Unit test + หลักฐานผล QA · ไม่นับไฟล์ในคอมเมนต์, ไฟล์ของ Sub-task และ Requirement ที่อ้างถึง
 * ไฟล์ที่อยู่ในถังขยะไม่นับ
 */
export interface AttachmentCount {
  total: number;
  files: number;
  unit: number;
  qa: number;
}

/** งานที่ไม่มีไฟล์จะไม่อยู่ใน Map · Guest Viewer เปิดไฟล์ไม่ได้ ผู้เรียกจึงไม่ควรเรียกให้ Guest Viewer */
export async function attachmentCounts(tx: Tx, issueIds: string[]): Promise<Map<string, AttachmentCount>> {
  const out = new Map<string, AttachmentCount>();
  if (!issueIds.length) return out;
  const [direct, runs] = await Promise.all([
    tx.select({ issueId: s.fileAttachments.targetId, n: sql<number>`count(*)::int` })
      .from(s.fileAttachments).innerJoin(s.files, sql`${s.files.id} = ${s.fileAttachments.fileId}`)
      .where(and(sql`${s.fileAttachments.targetType} = 'issue'`, inArray(s.fileAttachments.targetId, issueIds), isNull(s.files.deletedAt)))
      .groupBy(s.fileAttachments.targetId),
    tx.select({ issueId: s.testRuns.issueId, kind: s.testRuns.kind, n: sql<number>`count(*)::int` })
      .from(s.fileAttachments)
      .innerJoin(s.files, sql`${s.files.id} = ${s.fileAttachments.fileId}`)
      .innerJoin(s.testRuns, sql`${s.testRuns.id} = ${s.fileAttachments.targetId}`)
      .where(and(sql`${s.fileAttachments.targetType} = 'test_run'`, inArray(s.testRuns.issueId, issueIds), isNull(s.files.deletedAt)))
      .groupBy(s.testRuns.issueId, s.testRuns.kind),
  ]);
  const of = (id: string) => {
    let c = out.get(id);
    if (!c) out.set(id, (c = { total: 0, files: 0, unit: 0, qa: 0 }));
    return c;
  };
  for (const r of direct) { const c = of(r.issueId); c.files += r.n; c.total += r.n; }
  for (const r of runs) { const c = of(r.issueId); if (r.kind === 'unit') c.unit += r.n; else c.qa += r.n; c.total += r.n; }
  return out;
}

/** ค่าที่ส่งให้หน้าเว็บ · ไม่มีไฟล์ = null เพื่อให้ payload เล็ก */
export const attachmentsOf = (counts: Map<string, AttachmentCount>, issueId: string) => counts.get(issueId) ?? null;
