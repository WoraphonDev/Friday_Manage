ALTER TABLE "invitations" ADD COLUMN "email_status" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "email_error" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "email_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_status" CHECK ("invitations"."email_status" IN ('sent', 'failed', 'disabled'));