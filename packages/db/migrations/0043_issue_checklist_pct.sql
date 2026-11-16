-- สัดส่วน Checklist ที่ติ๊กของแต่ละงาน (null = ไม่มี Checklist) · Task ที่มี Sub-task นับเป็นอีกหนึ่งส่วนเท่ากับ Sub-task หนึ่งตัว (ผู้ใช้ขอ 2026-11-16)
ALTER TABLE "issues" ADD COLUMN "checklist_pct" smallint;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_checklist_pct_range" CHECK ("issues"."checklist_pct" between 0 and 100);--> statement-breakpoint
-- ตั้งค่าให้งานที่มี Checklist อยู่แล้ว · นับเฉพาะ Checklist ไม่นับ Acceptance criteria
UPDATE "issues" AS i SET "checklist_pct" = c."pct"
FROM (
  SELECT "issue_id", round(100.0 * count(*) FILTER (WHERE "done") / count(*))::smallint AS "pct"
  FROM "checklist_items" WHERE "kind" = 'checklist' GROUP BY "issue_id"
) AS c
WHERE i."id" = c."issue_id";
