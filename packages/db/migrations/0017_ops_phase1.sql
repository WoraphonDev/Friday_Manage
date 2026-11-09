CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" uuid,
	"target_type" text,
	"target_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount_satang" bigint,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"self_approved" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_status_valid" CHECK ("approval_requests"."status" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "approval_requests_decision" CHECK (("approval_requests"."status" IN ('pending', 'expired', 'cancelled')) = ("approval_requests"."decided_by" IS NULL)),
	CONSTRAINT "approval_requests_self" CHECK ("approval_requests"."decided_by" IS NULL OR "approval_requests"."decided_by" <> "approval_requests"."requested_by" OR "approval_requests"."self_approved")
);
--> statement-breakpoint
CREATE TABLE "incident_updates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"notify_subscribers" boolean DEFAULT false NOT NULL,
	"show_banner" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_updates_status_valid" CHECK ("incident_updates"."status" IN ('investigating', 'identified', 'monitoring', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"title" text NOT NULL,
	"impact" text DEFAULT 'minor' NOT NULL,
	"status" text DEFAULT 'investigating' NOT NULL,
	"services" text[] DEFAULT '{}' NOT NULL,
	"owner_id" uuid,
	"internal" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_impact_valid" CHECK ("incidents"."impact" IN ('minor', 'partial', 'major')),
	CONSTRAINT "incidents_status_valid" CHECK ("incidents"."status" IN ('investigating', 'identified', 'monitoring', 'resolved')),
	CONSTRAINT "incidents_resolved" CHECK (("incidents"."status" = 'resolved') = ("incidents"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text DEFAULT 'read_only' NOT NULL,
	"message" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"notify_plan" text DEFAULT '3d_and_1h' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" uuid,
	"approval_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_windows_scope_valid" CHECK ("maintenance_windows"."scope" IN ('read_only', 'full', 'import_export')),
	CONSTRAINT "maintenance_windows_status_valid" CHECK ("maintenance_windows"."status" IN ('scheduled', 'active', 'done', 'cancelled')),
	CONSTRAINT "maintenance_windows_dates" CHECK ("maintenance_windows"."ends_at" > "maintenance_windows"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "staff_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"staff_id" uuid,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"workspace_id" uuid,
	"reason" text,
	"approved_by" uuid,
	"self_approved" boolean DEFAULT false NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_elevations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"staff_id" uuid NOT NULL,
	"role" text NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_elevations_role_valid" CHECK ("staff_elevations"."role" IN ('owner', 'finance', 'support', 'engineer', 'auditor')),
	CONSTRAINT "staff_elevations_window" CHECK ("staff_elevations"."ends_at" > "staff_elevations"."started_at" AND "staff_elevations"."ends_at" <= "staff_elevations"."started_at" + interval '1 hour')
);
--> statement-breakpoint
CREATE TABLE "status_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"confirm_token_hash" text,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"author_user_id" uuid,
	"author_staff_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_ticket_messages_author_valid" CHECK ("support_ticket_messages"."author_kind" IN ('customer', 'staff', 'system')),
	CONSTRAINT "support_ticket_messages_internal" CHECK (NOT "support_ticket_messages"."internal" OR "support_ticket_messages"."author_kind" = 'staff')
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "support_tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"workspace_id" uuid,
	"requester_user_id" uuid,
	"requester_email" text,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"category" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"first_response_due_at" timestamp with time zone,
	"resolution_due_at" timestamp with time zone,
	"first_responded_at" timestamp with time zone,
	"solved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cause" text,
	"csat" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_number_unique" UNIQUE("number"),
	CONSTRAINT "support_tickets_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "support_tickets_status_valid" CHECK ("support_tickets"."status" IN ('open', 'pending_customer', 'pending_dev', 'solved', 'closed')),
	CONSTRAINT "support_tickets_channel_valid" CHECK ("support_tickets"."channel" IN ('in_app', 'email', 'phone', 'line')),
	CONSTRAINT "support_tickets_priority_valid" CHECK ("support_tickets"."priority" IN ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "support_tickets_requester" CHECK ("support_tickets"."requester_user_id" IS NOT NULL OR "support_tickets"."requester_email" IS NOT NULL),
	CONSTRAINT "support_tickets_csat" CHECK ("support_tickets"."csat" IS NULL OR "support_tickets"."csat" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"vat_satang" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"refund_method" text,
	"provider_ref" text,
	"created_by_staff" uuid,
	"approval_request_id" uuid,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_number_unique" UNIQUE("number"),
	CONSTRAINT "credit_notes_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_notes_kind_valid" CHECK ("credit_notes"."kind" IN ('refund', 'credit', 'void')),
	CONSTRAINT "credit_notes_status_valid" CHECK ("credit_notes"."status" IN ('draft', 'issued', 'sent')),
	CONSTRAINT "credit_notes_refund_method_valid" CHECK ("credit_notes"."refund_method" IS NULL OR "credit_notes"."refund_method" IN ('original', 'bank_transfer')),
	CONSTRAINT "credit_notes_amounts" CHECK ("credit_notes"."amount_satang" > 0 AND "credit_notes"."vat_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dunning_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"step" text NOT NULL,
	"channel" text NOT NULL,
	"result" text,
	"by_staff" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dunning_events_step_valid" CHECK ("dunning_events"."step" IN ('invoice_sent', 'reminder', 'final_notice', 'call', 'extended', 'suspended', 'delete_notice')),
	CONSTRAINT "dunning_events_channel_valid" CHECK ("dunning_events"."channel" IN ('email', 'line', 'phone', 'banner', 'system'))
);
--> statement-breakpoint
CREATE TABLE "workspace_credits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"amount_satang" bigint NOT NULL,
	"source" text NOT NULL,
	"credit_note_id" uuid,
	"invoice_id" uuid,
	"note" text,
	"created_by_staff" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_credits_source_valid" CHECK ("workspace_credits"."source" IN ('credit_note', 'overpayment', 'goodwill', 'applied')),
	CONSTRAINT "workspace_credits_nonzero" CHECK ("workspace_credits"."amount_satang" <> 0),
	CONSTRAINT "workspace_credits_applied_negative" CHECK (("workspace_credits"."source" = 'applied') = ("workspace_credits"."amount_satang" < 0))
);
--> statement-breakpoint
CREATE TABLE "cancellation_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" text NOT NULL,
	"missing_feature" text,
	"switched_to" text,
	"detail" text,
	"offer_shown" text DEFAULT 'none' NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellation_responses_reason_valid" CHECK ("cancellation_responses"."reason" IN ('too_expensive', 'missing_feature', 'switched_tool', 'project_ended', 'hard_to_use', 'company_closed', 'other')),
	CONSTRAINT "cancellation_responses_offer_valid" CHECK ("cancellation_responses"."offer_shown" IN ('none', 'discount', 'pause')),
	CONSTRAINT "cancellation_responses_outcome_valid" CHECK ("cancellation_responses"."outcome" IN ('canceled', 'kept'))
);
--> statement-breakpoint
CREATE TABLE "cost_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"resource" text NOT NULL,
	"unit_cost_satang" numeric(12, 4),
	"pct" numeric(6, 3),
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_rates_resource_valid" CHECK ("cost_rates"."resource" IN ('line_message', 'email', 'storage_gb_month', 'payment_fee_card', 'payment_fee_promptpay', 'etax_doc', 'slip_check')),
	CONSTRAINT "cost_rates_one_value" CHECK (("cost_rates"."unit_cost_satang" IS NULL) <> ("cost_rates"."pct" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "daily_usages" (
	"workspace_id" uuid NOT NULL,
	"date" date NOT NULL,
	"line_messages" integer DEFAULT 0 NOT NULL,
	"emails" integer DEFAULT 0 NOT NULL,
	"webhook_calls" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"automation_runs" integer DEFAULT 0 NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_usages_workspace_id_date_pk" PRIMARY KEY("workspace_id","date")
);
--> statement-breakpoint
CREATE TABLE "infra_costs" (
	"month" date NOT NULL,
	"category" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_costs_month_category_pk" PRIMARY KEY("month","category"),
	CONSTRAINT "infra_costs_category_valid" CHECK ("infra_costs"."category" IN ('aws', 'tools', 'other')),
	CONSTRAINT "infra_costs_first_day" CHECK (extract(day from "infra_costs"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "marketing_costs" (
	"month" date NOT NULL,
	"source" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_costs_month_source_pk" PRIMARY KEY("month","source"),
	CONSTRAINT "marketing_costs_first_day" CHECK (extract(day from "marketing_costs"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_attributions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"referrer_host" text,
	"landing_path" text,
	"via" text DEFAULT 'direct' NOT NULL,
	"invited_by_user_id" uuid,
	"invited_workspace_id" uuid,
	"first_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_attributions_via_valid" CHECK ("signup_attributions"."via" IN ('direct', 'invited', 'ops_created'))
);
--> statement-breakpoint
CREATE TABLE "subscription_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"plan_from" text,
	"plan_to" text,
	"seats_from" integer,
	"seats_to" integer,
	"mrr_before_satang" bigint NOT NULL,
	"mrr_after_satang" bigint NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_changes_kind_valid" CHECK ("subscription_changes"."kind" IN ('new', 'upgrade', 'downgrade', 'seats_up', 'seats_down', 'cycle_change', 'cancel', 'reactivate', 'churn_payment')),
	CONSTRAINT "subscription_changes_actor_valid" CHECK ("subscription_changes"."actor_kind" IN ('user', 'system', 'staff')),
	CONSTRAINT "subscription_changes_mrr_nonnegative" CHECK ("subscription_changes"."mrr_before_satang" >= 0 AND "subscription_changes"."mrr_after_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_acquisitions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"source" text,
	"medium" text,
	"campaign" text,
	"referrer_host" text,
	"via" text DEFAULT 'signup' NOT NULL,
	"referring_workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_acquisitions_via_valid" CHECK ("workspace_acquisitions"."via" IN ('signup', 'invited_user', 'sales', 'ops_created'))
);
--> statement-breakpoint
ALTER TABLE "staff_users" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "exception_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "matched_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "roles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "limits" jsonb;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_staff_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_staff_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_owner_id_staff_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD CONSTRAINT "staff_elevations_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_elevations" ADD CONSTRAINT "staff_elevations_ended_by_staff_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_staff_id_staff_users_id_fk" FOREIGN KEY ("author_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_staff_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_staff_staff_users_id_fk" FOREIGN KEY ("created_by_staff") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_by_staff_staff_users_id_fk" FOREIGN KEY ("by_staff") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_events" ADD CONSTRAINT "dunning_events_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_created_by_staff_staff_users_id_fk" FOREIGN KEY ("created_by_staff") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_credit_note_fk" FOREIGN KEY ("workspace_id","credit_note_id") REFERENCES "public"."credit_notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_invoice_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_responses" ADD CONSTRAINT "cancellation_responses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_rates" ADD CONSTRAINT "cost_rates_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_usages" ADD CONSTRAINT "daily_usages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD CONSTRAINT "signup_attributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_acquisitions" ADD CONSTRAINT "workspace_acquisitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "approval_requests_workspace_idx" ON "approval_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "incident_updates_incident_idx" ON "incident_updates" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "maintenance_windows_time_idx" ON "maintenance_windows" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "staff_audit_logs_created_idx" ON "staff_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "staff_audit_logs_staff_idx" ON "staff_audit_logs" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE INDEX "staff_elevations_staff_idx" ON "staff_elevations" USING btree ("staff_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscribers_email_key" ON "status_subscribers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "support_ticket_messages_ticket_idx" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_queue_idx" ON "support_tickets" USING btree ("status","assignee_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_workspace_idx" ON "support_tickets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "dunning_events_invoice_idx" ON "dunning_events" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_credits_workspace_idx" ON "workspace_credits" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "cancellation_responses_created_idx" ON "cancellation_responses" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_rates_resource_from_key" ON "cost_rates" USING btree ("resource","effective_from");--> statement-breakpoint
CREATE INDEX "product_events_workspace_idx" ON "product_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "product_events_name_idx" ON "product_events" USING btree ("name","occurred_at");--> statement-breakpoint
CREATE INDEX "subscription_changes_workspace_idx" ON "subscription_changes" USING btree ("workspace_id","effective_at");--> statement-breakpoint
CREATE INDEX "subscription_changes_kind_idx" ON "subscription_changes" USING btree ("kind","effective_at");--> statement-breakpoint
CREATE INDEX "workspace_acquisitions_source_idx" ON "workspace_acquisitions" USING btree ("source");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_matched_invoice_fk" FOREIGN KEY ("workspace_id","matched_invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_ticket_fk" FOREIGN KEY ("workspace_id","ticket_id") REFERENCES "public"."support_tickets"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_exception_idx" ON "payments" USING btree ("exception_reason") WHERE "payments"."exception_reason" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_valid" CHECK ("payments"."verified_by" IS NULL OR "payments"."verified_by" IN ('webhook', 'bank', 'slip_api', 'staff'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_exception_reason_valid" CHECK ("payments"."exception_reason" IS NULL OR "payments"."exception_reason" IN ('amount_mismatch', 'wht_not_declared', 'duplicate_slip', 'payer_name_mismatch', 'unmatched', 'double_payment', 'wht_certificate', 'unreadable_slip'));--> statement-breakpoint
-- ย้ายบทบาทเดิมก่อนบังคับ constraint (06-ops-roles › 6): admin → owner
UPDATE "staff_users" SET "roles" = CASE "role" WHEN 'admin' THEN ARRAY['owner'] WHEN 'finance' THEN ARRAY['finance'] ELSE ARRAY['support'] END
  WHERE cardinality("roles") = 0;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_roles_valid" CHECK (cardinality("staff_users"."roles") >= 1 AND "staff_users"."roles" <@ ARRAY['owner', 'finance', 'support', 'engineer', 'auditor']::text[]);--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_status_valid" CHECK ("staff_users"."status" IN ('invited', 'active', 'suspended', 'disabled'));