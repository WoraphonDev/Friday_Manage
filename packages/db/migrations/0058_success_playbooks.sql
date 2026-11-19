CREATE TABLE "health_daily" (
	"workspace_id" uuid NOT NULL,
	"date" date NOT NULL,
	"score" smallint NOT NULL,
	"usage" smallint NOT NULL,
	"payment" smallint NOT NULL,
	"support" smallint NOT NULL,
	"growth" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_daily_workspace_id_date_pk" PRIMARY KEY("workspace_id","date")
);
--> statement-breakpoint
CREATE TABLE "playbook_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"assignee_id" uuid,
	"due_on" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"note" text,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_run_steps_kind_valid" CHECK ("playbook_run_steps"."kind" IN ('email', 'task', 'wait')),
	CONSTRAINT "playbook_run_steps_status_valid" CHECK ("playbook_run_steps"."status" IN ('pending', 'done', 'skipped')),
	CONSTRAINT "playbook_run_steps_outcome_valid" CHECK ("playbook_run_steps"."outcome" IS NULL OR "playbook_run_steps"."outcome" IN ('reached', 'no_answer', 'will_cancel', 'sent', 'recovered', 'waited'))
);
--> statement-breakpoint
CREATE TABLE "playbook_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_id" uuid,
	"step_index" integer DEFAULT 0 NOT NULL,
	"score_at_start" smallint,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_runs_status_valid" CHECK ("playbook_runs"."status" IN ('active', 'recovered', 'churned', 'closed')),
	CONSTRAINT "playbook_runs_closed" CHECK (("playbook_runs"."status" = 'active') = ("playbook_runs"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbooks_key_unique" UNIQUE("key"),
	CONSTRAINT "playbooks_trigger_valid" CHECK ("playbooks"."trigger"->>'kind' IN ('usage_drop', 'overdue', 'team_shrink', 'tickets_backlog', 'renewal_low_health'))
);
--> statement-breakpoint
ALTER TABLE "health_daily" ADD CONSTRAINT "health_daily_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD CONSTRAINT "playbook_run_steps_run_id_playbook_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."playbook_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD CONSTRAINT "playbook_run_steps_assignee_id_staff_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_run_steps" ADD CONSTRAINT "playbook_run_steps_done_by_staff_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_owner_id_staff_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_daily_date_idx" ON "health_daily" USING btree ("date");--> statement-breakpoint
CREATE INDEX "playbook_run_steps_run_idx" ON "playbook_run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "playbook_run_steps_due_idx" ON "playbook_run_steps" USING btree ("status","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_runs_active_key" ON "playbook_runs" USING btree ("playbook_id","workspace_id") WHERE "playbook_runs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "playbook_runs_status_idx" ON "playbook_runs" USING btree ("status","closed_at");--> statement-breakpoint
CREATE INDEX "playbook_runs_workspace_idx" ON "playbook_runs" USING btree ("workspace_id");--> statement-breakpoint
-- ใช้เฉพาะทีม Friday (ops-api) · ลูกค้าไม่เห็นคะแนนสุขภาพและ Playbook · ปิด friday_app แบบ 0051
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['health_daily', 'playbooks', 'playbook_runs', 'playbook_run_steps'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.playbooks FOR EACH ROW EXECUTE FUNCTION app.touch();
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.playbook_runs FOR EACH ROW EXECUTE FUNCTION app.touch();
