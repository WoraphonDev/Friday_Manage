CREATE TABLE "api_usage_hours" (
	"workspace_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"token_id" uuid NOT NULL,
	"route" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"peak_rpm" integer DEFAULT 0 NOT NULL,
	"limit_rpm" integer,
	CONSTRAINT "api_usage_hours_workspace_id_hour_token_id_route_pk" PRIMARY KEY("workspace_id","hour","token_id","route")
);
--> statement-breakpoint
CREATE TABLE "api_usage_minutes" (
	"workspace_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"token_id" uuid NOT NULL,
	"route" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"limit_rpm" integer,
	CONSTRAINT "api_usage_minutes_workspace_id_minute_token_id_route_pk" PRIMARY KEY("workspace_id","minute","token_id","route")
);
--> statement-breakpoint
ALTER TABLE "api_usage_hours" ADD CONSTRAINT "api_usage_hours_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_usage_minutes" ADD CONSTRAINT "api_usage_minutes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_usage_hours_hour_idx" ON "api_usage_hours" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "api_usage_minutes_minute_idx" ON "api_usage_minutes" USING btree ("minute");--> statement-breakpoint
-- เขียนโดย API ลูกค้าผ่าน SYSTEM_DB (ตอนตรวจ API token ยังไม่ได้ตั้งบริบท Workspace) · อ่านโดย ops-api · ลูกค้ายังไม่ได้ดู จึงปิด friday_app แบบ 0051
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_usage_minutes', 'api_usage_hours'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM friday_app', t);
    EXECUTE format('CREATE POLICY ops_only ON public.%I TO friday_app USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
