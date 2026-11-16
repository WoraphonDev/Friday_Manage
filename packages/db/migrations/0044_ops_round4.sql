CREATE TABLE "legal_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_notices_once_key" UNIQUE("document_id","user_id","kind"),
	CONSTRAINT "legal_notices_kind_valid" CHECK ("legal_notices"."kind" IN ('notice', 'reminder')),
	CONSTRAINT "legal_notices_status_valid" CHECK ("legal_notices"."status" IN ('sent', 'failed', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"user_ids" uuid[] DEFAULT '{}' NOT NULL,
	"reason" text NOT NULL,
	"reference" text NOT NULL,
	"review_on" date,
	"notify_customer" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"release_reason" text,
	CONSTRAINT "legal_holds_scope_valid" CHECK ("legal_holds"."scope" IN ('workspace', 'users')),
	CONSTRAINT "legal_holds_users_when_scoped" CHECK ("legal_holds"."scope" = 'workspace' OR cardinality("legal_holds"."user_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "ops_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_alerts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_notified_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_alerts_kind_valid" CHECK ("system_alerts"."kind" IN ('error_rate'))
);
--> statement-breakpoint
CREATE TABLE "etax_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"doc_kind" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"note" text,
	"by_staff" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "etax_jobs_doc_action_key" UNIQUE("doc_kind","doc_id","action"),
	CONSTRAINT "etax_jobs_doc_kind_valid" CHECK ("etax_jobs"."doc_kind" IN ('tax_document', 'credit_note', 'debit_note')),
	CONSTRAINT "etax_jobs_action_valid" CHECK ("etax_jobs"."action" IN ('issue', 'cancel')),
	CONSTRAINT "etax_jobs_status_valid" CHECK ("etax_jobs"."status" IN ('pending', 'submitted', 'done', 'failed', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "wht_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipients" text[] DEFAULT '{}' NOT NULL,
	"message" text,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_requests_kind_valid" CHECK ("wht_requests"."kind" IN ('auto_7', 'auto_30', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "workspace_credits" DROP CONSTRAINT "workspace_credits_source_valid";--> statement-breakpoint
ALTER TABLE "workspace_credits" DROP CONSTRAINT "workspace_credits_applied_negative";--> statement-breakpoint
ALTER TABLE "wht_certificates" ALTER COLUMN "file_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wht_certificates" ALTER COLUMN "uploaded_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "holiday_calendars" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "holidays" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credit_applied" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "notify_audience" text;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "notify_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "notify_banner" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "wht_certificates" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "wht_certificates" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "wht_certificates" ADD COLUMN "ewht_ref" text;--> statement-breakpoint
ALTER TABLE "wht_certificates" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "target_mode" text DEFAULT 'selected' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "target_filter" jsonb;--> statement-breakpoint
ALTER TABLE "staff_push_subscriptions" ADD COLUMN "last_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_push_subscriptions" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "staff_push_subscriptions" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "personal_email" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "personal_email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "personal_email_pending" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "personal_email_code_hash" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "personal_email_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_agents" ADD COLUMN "presence_reason" text;--> statement-breakpoint
ALTER TABLE "support_agents" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_staff_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_settings" ADD CONSTRAINT "ops_settings_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD CONSTRAINT "system_alerts_acknowledged_by_staff_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_alerts" ADD CONSTRAINT "system_alerts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etax_jobs" ADD CONSTRAINT "etax_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etax_jobs" ADD CONSTRAINT "etax_jobs_by_staff_staff_users_id_fk" FOREIGN KEY ("by_staff") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_requests" ADD CONSTRAINT "wht_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_requests" ADD CONSTRAINT "wht_requests_sent_by_staff_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_requests" ADD CONSTRAINT "wht_requests_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" USING btree ("workspace_id") WHERE "legal_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "system_alerts_open_idx" ON "system_alerts" USING btree ("kind") WHERE "system_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "etax_jobs_open_idx" ON "etax_jobs" USING btree ("status","next_attempt_at") WHERE "etax_jobs"."status" IN ('pending', 'submitted', 'failed');--> statement-breakpoint
CREATE INDEX "wht_requests_invoice_idx" ON "wht_requests" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_request_idx" ON "notifications" USING btree ("request_id") WHERE "notifications"."request_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_applied_nonnegative" CHECK ("invoices"."credit_applied" >= 0);--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_notify_audience_valid" CHECK ("legal_documents"."notify_audience" IS NULL OR "legal_documents"."notify_audience" IN ('all', 'admins'));--> statement-breakpoint
ALTER TABLE "wht_certificates" ADD CONSTRAINT "wht_certificates_source_valid" CHECK ("wht_certificates"."source" IN ('upload', 'ewht', 'ops'));--> statement-breakpoint
ALTER TABLE "wht_certificates" ADD CONSTRAINT "wht_certificates_file_when_upload" CHECK ("wht_certificates"."source" <> 'upload' OR "wht_certificates"."file_key" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_target_mode_valid" CHECK ("announcements"."target_mode" IN ('selected', 'filter', 'all'));--> statement-breakpoint
ALTER TABLE "support_agents" ADD CONSTRAINT "support_agents_presence_reason_valid" CHECK ("support_agents"."presence_reason" IS NULL OR "support_agents"."presence_reason" IN ('manual', 'logout', 'idle', 'session'));--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_source_valid" CHECK ("workspace_credits"."source" IN ('credit_note', 'overpayment', 'goodwill', 'applied', 'refunded', 'reversal'));--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_applied_negative" CHECK (("workspace_credits"."source" IN ('applied', 'refunded')) = ("workspace_credits"."amount_satang" < 0));