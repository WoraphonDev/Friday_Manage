ALTER TYPE "public"."delivery_status" ADD VALUE 'suppressed';--> statement-breakpoint
CREATE TABLE "email_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"detail" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_feedback_events_kind_valid" CHECK ("email_feedback_events"."kind" IN ('bounce_permanent', 'bounce_transient', 'complaint'))
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"workspace_id" uuid,
	"source" text DEFAULT 'ses' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"remove_reason" text,
	CONSTRAINT "email_suppressions_reason_valid" CHECK ("email_suppressions"."reason" IN ('hard_bounce', 'complaint', 'soft_bounce_repeated', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "target_label" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "response" jsonb;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "resend_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_feedback_events_email_idx" ON "email_feedback_events" USING btree (lower("email"),"created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_active_key" ON "email_suppressions" USING btree (lower("email")) WHERE "email_suppressions"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries" USING btree ("created_at");--> statement-breakpoint

-- O23: รายชื่อไม่ส่งอีเมลและเหตุการณ์ bounce ใช้เฉพาะทีม Friday (ops-api) และงานเบื้องหลังของ API ผ่าน SYSTEM_DB
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_suppressions', 'email_feedback_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- เอาออกจากรายการ = ตั้ง removed_at (เก็บประวัติไว้) · ลบแถวไม่ได้
REVOKE DELETE, TRUNCATE ON public.email_suppressions FROM friday_system;
