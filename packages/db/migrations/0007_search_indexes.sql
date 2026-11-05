-- pg_trgm เป็น extension แบบ trusted เจ้าของฐานข้อมูลติดตั้งได้โดยไม่ต้องเป็น superuser
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "comments_body_trgm_idx" ON "comments" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_title_trgm_idx" ON "issues" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "issues_description_trgm_idx" ON "issues" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "files_name_trgm_idx" ON "files" USING gin ("name" gin_trgm_ops);
