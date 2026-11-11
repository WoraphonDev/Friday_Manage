ALTER TYPE "public"."status_category" ADD VALUE 'review' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."status_category" ADD VALUE 'blocked' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."status_category" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "workflow_statuses" ADD COLUMN "color" text;