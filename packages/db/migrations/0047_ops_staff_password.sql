ALTER TABLE "staff_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "locked_until" timestamp with time zone;