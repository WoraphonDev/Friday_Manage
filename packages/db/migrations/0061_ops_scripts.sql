CREATE TABLE "script_run_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"workspace_id" uuid,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"script_key" text NOT NULL,
	"workspace_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'dry_run' NOT NULL,
	"dry_result" jsonb,
	"reason" text,
	"ticket_ref" text,
	"requested_by" uuid NOT NULL,
	"approval_request_id" uuid,
	"approved_by" uuid,
	"undo_of" uuid,
	"total" integer,
	"progress" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "script_runs_status_valid" CHECK ("script_runs"."status" IN ('dry_run', 'pending_approval', 'running', 'stopping', 'done', 'failed', 'stopped', 'undone'))
);
--> statement-breakpoint
ALTER TABLE "script_run_changes" ADD CONSTRAINT "script_run_changes_run_id_script_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."script_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_runs" ADD CONSTRAINT "script_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_runs" ADD CONSTRAINT "script_runs_requested_by_staff_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_runs" ADD CONSTRAINT "script_runs_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_runs" ADD CONSTRAINT "script_runs_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_runs" ADD CONSTRAINT "script_runs_undo_of_script_runs_id_fk" FOREIGN KEY ("undo_of") REFERENCES "public"."script_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "script_run_changes_run_idx" ON "script_run_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "script_run_changes_created_idx" ON "script_run_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "script_runs_status_idx" ON "script_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "script_runs_workspace_idx" ON "script_runs" USING btree ("workspace_id");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · ปิด friday_app แบบ 0051
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['script_runs', 'script_run_changes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.script_runs FOR EACH ROW EXECUTE FUNCTION app.touch();
