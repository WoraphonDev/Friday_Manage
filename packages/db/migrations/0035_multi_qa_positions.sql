ALTER TABLE "project_members" ADD COLUMN "positions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "reviewer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
-- QA เดิมคนเดียว → รายการ QA · ปิด touch ไว้ไม่ให้ version / updated_at ของทุกงานเปลี่ยน (ไม่ใช่การแก้ของผู้ใช้)
ALTER TABLE public.issues DISABLE TRIGGER touch;--> statement-breakpoint
UPDATE "issues" SET "reviewer_ids" = ARRAY["reviewer_id"] WHERE "reviewer_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE public.issues ENABLE TRIGGER touch;--> statement-breakpoint
-- ตำแหน่งเดิม (ข้อความเดียว) → ตัวย่อตามชุดใน apps/web/src/lib/positions.ts · ค่าที่ไม่รู้จักเก็บตามเดิม
UPDATE "project_members" SET "positions" = ARRAY[CASE lower(trim("position"))
  WHEN 'pm' THEN 'PM' WHEN 'project manager' THEN 'PM'
  WHEN 'ba' THEN 'BA' WHEN 'business analyst' THEN 'BA'
  WHEN 'sa' THEN 'SA' WHEN 'system analyst' THEN 'SA'
  WHEN 'ux' THEN 'UX' WHEN 'ux/ui' THEN 'UX' WHEN 'ux/ui designer' THEN 'UX'
  WHEN 'fe' THEN 'FE' WHEN 'frontend' THEN 'FE' WHEN 'frontend dev' THEN 'FE' WHEN 'frontend developer' THEN 'FE'
  WHEN 'be' THEN 'BE' WHEN 'backend' THEN 'BE' WHEN 'backend dev' THEN 'BE' WHEN 'backend developer' THEN 'BE'
  WHEN 'dev' THEN 'DEV' WHEN 'developer' THEN 'DEV'
  WHEN 'qa' THEN 'QA' WHEN 'qa engineer' THEN 'QA'
  WHEN 'devops' THEN 'DEVOPS' WHEN 'dev ops' THEN 'DEVOPS' WHEN 'devops engineer' THEN 'DEVOPS'
  ELSE trim("position") END]
WHERE coalesce(trim("position"), '') <> '';
