ALTER TABLE "workspaces" ADD COLUMN "suspension_mode" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "suspension_message" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "suspension_auto_resume" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_suspension_mode_valid" CHECK ("workspaces"."suspension_mode" IS NULL OR "workspaces"."suspension_mode" IN ('read_only', 'full'));--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_expiry" CHECK ("support_sessions"."expires_at" IS NULL OR "support_sessions"."expires_at" > "support_sessions"."started_at");--> statement-breakpoint
-- Workspace ที่ถูกระงับอยู่ก่อนมีโหมด = อ่านอย่างเดียว (ใกล้พฤติกรรมเดิมที่สุดและยังส่งออกข้อมูลได้)
UPDATE "workspaces" SET "suspension_mode" = 'read_only' WHERE "status" = 'suspended' AND "suspension_mode" IS NULL;
