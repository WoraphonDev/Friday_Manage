CREATE TYPE "public"."field_mode" AS ENUM('hidden', 'optional', 'required');--> statement-breakpoint
ALTER TABLE "custom_fields" ADD COLUMN "task_mode" "field_mode" DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD COLUMN "subtask_mode" "field_mode" DEFAULT 'optional' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "field_profile" jsonb DEFAULT '{}'::jsonb NOT NULL;