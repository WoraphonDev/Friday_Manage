ALTER TABLE "staff_elevations" DROP CONSTRAINT "staff_elevations_window";--> statement-breakpoint
ALTER TABLE "staff_audit_logs" ADD COLUMN "elevation_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD COLUMN "kind" text DEFAULT 'break_glass' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD COLUMN "ticket_ref" text;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD COLUMN "warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD CONSTRAINT "staff_elevations_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_audit_logs_elevation_idx" ON "staff_audit_logs" USING btree ("elevation_id") WHERE "staff_audit_logs"."elevation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD CONSTRAINT "staff_elevations_kind_valid" CHECK ("staff_elevations"."kind" IN ('break_glass', 'approved'));--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD CONSTRAINT "staff_elevations_approved" CHECK ("staff_elevations"."kind" <> 'approved' OR ("staff_elevations"."approval_request_id" IS NOT NULL AND "staff_elevations"."role" <> 'owner'));--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD CONSTRAINT "staff_elevations_window" CHECK ("staff_elevations"."ends_at" > "staff_elevations"."started_at" AND "staff_elevations"."ends_at" <= "staff_elevations"."started_at" + CASE WHEN "staff_elevations"."kind" = 'approved' THEN interval '8 hours' ELSE interval '1 hour' END);