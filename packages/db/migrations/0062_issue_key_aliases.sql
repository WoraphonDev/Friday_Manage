CREATE TABLE "issue_key_aliases" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_key_aliases_project_id_number_pk" PRIMARY KEY("project_id","number")
);
--> statement-breakpoint
ALTER TABLE "issue_key_aliases" ADD CONSTRAINT "issue_key_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_key_aliases" ADD CONSTRAINT "issue_key_aliases_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_key_aliases" ADD CONSTRAINT "issue_key_aliases_issue_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_key_aliases_issue_idx" ON "issue_key_aliases" USING btree ("issue_id");--> statement-breakpoint
-- RLS: แยก Workspace + ต้องเข้าถึงโปรเจกต์เดิมได้ (เหมือน project_key_aliases) · งานปลายทางมี RLS ของ issues คุมอีกชั้น
ALTER TABLE public.issue_key_aliases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.issue_key_aliases TO friday_app
  USING (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()))
  WITH CHECK (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.is_member()));
--> statement-breakpoint
CREATE POLICY project_access ON public.issue_key_aliases AS RESTRICTIVE TO friday_app
  USING (project_id IN (SELECT app.accessible_project_ids()))
  WITH CHECK (project_id IN (SELECT app.accessible_project_ids()));
--> statement-breakpoint
-- ย้ายงานข้ามโปรเจกต์: ประวัติของงานตามไปอยู่โปรเจกต์ใหม่ (ไม่งั้น RLS ซ่อนประวัติเดิมจากคนที่เข้าโปรเจกต์เดิมไม่ได้)
-- ประวัติยังแก้เนื้อหาไม่ได้: ให้เฉพาะคอลัมน์ project_id · RLS ยังบังคับให้เข้าถึงได้ทั้งโปรเจกต์เดิมและใหม่
GRANT UPDATE (project_id) ON public.activities TO friday_app;
