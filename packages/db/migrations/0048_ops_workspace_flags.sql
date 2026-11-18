CREATE TABLE "ops_workspace_flags" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"test_flag" text NOT NULL,
	"reason" text NOT NULL,
	"flagged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_workspace_flags_valid" CHECK ("ops_workspace_flags"."test_flag" IN ('test', 'not_test'))
);
--> statement-breakpoint
ALTER TABLE "ops_workspace_flags" ADD CONSTRAINT "ops_workspace_flags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_workspace_flags" ADD CONSTRAINT "ops_workspace_flags_flagged_by_staff_users_id_fk" FOREIGN KEY ("flagged_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_workspace_flags_flag_idx" ON "ops_workspace_flags" USING btree ("test_flag");--> statement-breakpoint
-- ป้ายทดสอบใช้เฉพาะทีม Friday (ops-api) · ลูกค้าไม่เห็น · ปิด friday_app แบบ 0025 / 0045
ALTER TABLE public.ops_workspace_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.ops_workspace_flags FROM friday_app;
--> statement-breakpoint
CREATE POLICY ops_only ON public.ops_workspace_flags TO friday_app USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE TRIGGER touch BEFORE UPDATE ON public.ops_workspace_flags FOR EACH ROW EXECUTE FUNCTION app.touch();
