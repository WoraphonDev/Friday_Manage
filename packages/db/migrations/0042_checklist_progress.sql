-- Progress ของงานที่มี Checklist = สัดส่วนรายการที่ติ๊กแล้ว (ผู้ใช้ขอ 2026-11-16) · ตั้งค่าให้งานที่มี Checklist อยู่แล้ว
-- นับเฉพาะ Checklist ไม่นับ Acceptance criteria · ข้ามงานที่ลบแล้ว · รันซ้ำได้
UPDATE "issues" AS i SET "progress_pct" = c."pct"
FROM (
  SELECT "issue_id", round(100.0 * count(*) FILTER (WHERE "done") / count(*))::smallint AS "pct"
  FROM "checklist_items" WHERE "kind" = 'checklist' GROUP BY "issue_id"
) AS c
WHERE i."id" = c."issue_id" AND i."deleted_at" IS NULL AND i."progress_pct" IS DISTINCT FROM c."pct";
