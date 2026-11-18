ALTER TABLE "issues" ADD COLUMN "ba_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
-- BA เดิมคนเดียว → รายการ BA · ปิด touch ไว้ไม่ให้ version / updated_at ของทุกงานเปลี่ยน (ไม่ใช่การแก้ของผู้ใช้)
ALTER TABLE public.issues DISABLE TRIGGER touch;--> statement-breakpoint
UPDATE "issues" SET "ba_ids" = ARRAY["ba_id"] WHERE "ba_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE public.issues ENABLE TRIGGER touch;
